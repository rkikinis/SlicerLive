// Tested against a fake transport, so no server and no weights are needed. The shapes asserted here
// are the ones the real server returned when the contract was read off its OpenAPI document and its
// own guide -- not invented.
//
//   deno test -A --no-check logic/haversack.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { acceptedParameters, describeStatus, health, isFinished, job, keepAcceptedOptions, missingWeightIds, result, serverStatus, submitError, submitVolume, tasks } from "./haversack.ts";

/** A transport that answers from a table, and records what was asked. */
function fake(routes: Record<string, { status?: number; body?: unknown; bytes?: Uint8Array }>) {
  const seen: { url: string; method: string; body?: unknown }[] = [];
  const t = {
    base: "/_haversack/",
    // deno-lint-ignore no-explicit-any
    fetch: ((url: any, init?: any) => {
      const path = String(url).replace("/_haversack/", "");
      seen.push({ url: path, method: init?.method ?? "GET", body: init?.body });
      const r = routes[path];
      if (!r) return Promise.resolve(new Response("no route", { status: 404 }));
      if (r.bytes) return Promise.resolve(new Response(r.bytes, { status: r.status ?? 200 }));
      return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      }));
    }) as unknown as typeof fetch,
  };
  return { t, seen };
}

// --- health -------------------------------------------------------------------------------------

// The real /v1/health, as observed: it needs no token and reports the catalog size and sources.
Deno.test("health: reports version, device and sources when it is up", async () => {
  const { t } = fake({ health: { body: { name: "haversack", version: "0.4.0", device: "auto", n_tasks: 74, accepting: true, sources: ["upload", "idc", "tcia"] } } });
  const h = await health(t);
  assertEquals(h.running, true);
  assertEquals(h.version, "0.4.0");
  assertEquals(h.taskCount, 74);
  assertEquals(h.sources, ["upload", "idc", "tcia"]);
});

// Not running is the EXPECTED state, and the proxy turns it into a 503 carrying the command to fix
// it. This must be a value the panel can render, never a thrown error.
Deno.test("health: not running is a value, and carries the command to start it", async () => {
  const { t } = fake({ health: { status: 503, body: { error: "haversack is not answering", start: "uvx ... haversack serve --port 8790" } } });
  const h = await health(t);
  assertEquals(h.running, false);
  assertEquals(h.start?.includes("haversack serve"), true);
});

Deno.test("health: a transport that throws is still a value", async () => {
  const t = { fetch: (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch };
  const h = await health(t);
  assertEquals(h.running, false);
  assertEquals(h.detail?.includes("boom"), true);
});

// --- tasks --------------------------------------------------------------------------------------

// The live server returns bare strings; the CLI's --json returns records. Both are accepted, and the
// ecosystem is derived from the name either way because that is what looks a paper up.
Deno.test("tasks: bare names are accepted, and the ecosystem is derived", async () => {
  const { t } = fake({ tasks: { body: ["ts:total_fast", "moose:clin_ct_muscles", "mrsegmentator:base"] } });
  const list = await tasks(t);
  assertEquals(list.map((x) => x.ecosystem), ["ts", "moose", "mrsegmentator"]);
  assertEquals(list[0].name, "ts:total_fast");
});

Deno.test("tasks: records are accepted too, with installed carried through", async () => {
  const { t } = fake({ tasks: { body: [{ name: "ts:lung_vessels", ecosystem: "ts", engine: "nnunetv2", modality: "CT", installed: true }] } });
  const list = await tasks(t);
  assertEquals(list[0].installed, true);
  assertEquals(list[0].modality, "CT");
});

Deno.test("tasks: a down server yields an empty catalog, not an exception", async () => {
  const { t } = fake({});
  assertEquals(await tasks(t), []);
});

// --- submit -------------------------------------------------------------------------------------

// POST /v1/jobs is multipart with `task` and a `file` part -- the shape read off the server's own
// OpenAPI document (Body_submit_v1_jobs_post: file, task, options, source; task required).
Deno.test("submit: posts multipart with the task and the file", async () => {
  const { t, seen } = fake({ jobs: { body: { id: "job-123" } } });
  const r = await submitVolume(t, { task: "ts:total_fast", bytes: new Uint8Array([1, 2, 3]), filename: "cropped.nrrd" });
  assertEquals(r.ok && r.jobId, "job-123");
  assertEquals(seen[0].method, "POST");
  const form = seen[0].body as FormData;
  assertEquals(form.get("task"), "ts:total_fast");
  assertEquals((form.get("file") as File).name, "cropped.nrrd");
});

Deno.test("submit: options are sent as a JSON string", async () => {
  const { t, seen } = fake({ jobs: { body: { id: "j" } } });
  await submitVolume(t, { task: "ts:total", bytes: new Uint8Array([0]), options: { interp: "nearest" } });
  assertEquals(JSON.parse((seen[0].body as FormData).get("options") as string), { interp: "nearest" });
});

// A refusal must reach the user as its message, and carry the start command when that is the cause.
Deno.test("submit: a refusal reports the server's own message", async () => {
  const { t } = fake({ jobs: { status: 503, body: { error: "haversack is not answering", start: "uvx ..." } } });
  const r = await submitVolume(t, { task: "ts:total_fast", bytes: new Uint8Array([1]) });
  assertEquals(r.ok, false);
  assertEquals(r.ok === false && r.message, "haversack is not answering");
  assertEquals(r.ok === false && r.start, "uvx ...");
});

Deno.test("submit: accepted but with no id is a failure, not a silent success", async () => {
  const { t } = fake({ jobs: { body: { queued: true } } });
  const r = await submitVolume(t, { task: "ts:total_fast", bytes: new Uint8Array([1]) });
  assertEquals(r.ok, false);
});

// --- polling and the result ---------------------------------------------------------------------

Deno.test("job: the state names servers actually use all map", async () => {
  for (const [raw, want] of [["queued", "queued"], ["pending", "queued"], ["running", "running"],
    ["started", "running"], ["succeeded", "succeeded"], ["done", "succeeded"], ["completed", "succeeded"],
    ["failed", "failed"], ["error", "failed"], ["cancelled", "cancelled"]] as const) {
    const { t } = fake({ "jobs/j": { body: { state: raw } } });
    assertEquals((await job(t, "j")).state, want, raw);
  }
});

// An unrecognized state is "unknown" and NOT "failed": a poll loop must keep waiting rather than
// declare a running job dead because a server version renamed a state.
Deno.test("job: an unrecognised state is unknown, not failed", async () => {
  const { t } = fake({ "jobs/j": { body: { state: "materialising" } } });
  assertEquals((await job(t, "j")).state, "unknown");
  assertEquals(isFinished("unknown"), false);
});

// The real shape, from a live haversack 0.4.0 job: progress is an object, not a bare number.
Deno.test("job: progress, stage, detail and part come through nested", async () => {
  const { t } = fake({
    "jobs/j": {
      body: {
        state: "running",
        progress: { stage: "network", detail: "to input orientation", part: 1, n_parts: 5, fraction: 0.42 },
      },
    },
  });
  const j = await job(t, "j");
  assertEquals(j.progress, 0.42);
  assertEquals(j.stage, "network");
  assertEquals(j.detail, "to input orientation");
  assertEquals(j.part, 1);
  assertEquals(j.nParts, 5);
});

// Tolerated too, in case a simpler job type ever reports these flat instead of nested.
Deno.test("job: a flat progress number and stage are tolerated too", async () => {
  const { t } = fake({ "jobs/j": { body: { state: "running", progress: 0.42, stage: "network" } } });
  const j = await job(t, "j");
  assertEquals(j.progress, 0.42);
  assertEquals(j.stage, "network");
});

Deno.test("result: the labels come back as bytes", async () => {
  const { t } = fake({ "jobs/j/result": { bytes: new Uint8Array([78, 82, 82, 68]) } });   // "NRRD"
  assertEquals(Array.from((await result(t, "j"))!), [78, 82, 82, 68]);
});

Deno.test("result: a missing result is null, not an exception", async () => {
  const { t } = fake({});
  assertEquals(await result(t, "j"), null);
});

Deno.test("isFinished: only the terminal states", () => {
  assertEquals(["succeeded", "failed", "cancelled"].every(isFinished), true);
  assertEquals(["queued", "running", "unknown"].some(isFinished), false);
});

// --- server AND credential state, together -------------------------------------------------------

// Ron: "I am getting the message: this server requires a bearer token for anything beyond cached
// reads. There is no indication whether something is running." Both halves of that are bugs. The
// token was being sent unparsed, and the panel could not report the problem because /v1/health
// needs no token and answers happily regardless. These pin the second half.

Deno.test("status: a healthy authenticated server says so in one line", async () => {
  const { t } = fake({ _status: { body: { reachable: true, port: 8790, token: "ok", hasToken: true, health: { version: "0.4.0", device: "auto", n_tasks: 74 } } } });
  const s = await serverStatus(t);
  assertEquals(s.reachable, true);
  assertEquals(s.token, "ok");
  assertEquals(describeStatus(s).includes("authenticated"), true);
  assertEquals(describeStatus(s).includes("74 networks"), true);
});

// The exact case Ron hit: reachable, but the credential is unusable. The line must name it, because
// the alternative is discovering it when a segmentation is refused minutes later.
Deno.test("status: reachable with an unreadable token names the credential problem", async () => {
  const { t } = fake({ _status: { body: { reachable: true, port: 8790, token: "unreadable", hasToken: false, health: { version: "0.4.0" } } } });
  const line = describeStatus(await serverStatus(t));
  assertEquals(line.includes("haversack 0.4.0"), true, "still says a server was found");
  assertEquals(line.includes("token"), true, "and names the token as the problem");
  assertEquals(line.includes("refused"), true, "and says what will happen");
});

// A token file from a server that has since moved is worse than none: it produces the same opaque
// rejection, so it gets its own message.
Deno.test("status: a token file for another port is called out", async () => {
  const { t } = fake({ _status: { body: { reachable: true, port: 8790, token: "wrong-port", hasToken: false, health: {} } } });
  assertEquals(describeStatus(await serverStatus(t)).includes("another port"), true);
});

// --no-token is a legitimate way to run it, so a missing file must not be described as broken.
Deno.test("status: no token file is not called an error", async () => {
  const { t } = fake({ _status: { body: { reachable: true, port: 8790, token: "missing", hasToken: false, health: {} } } });
  const line = describeStatus(await serverStatus(t));
  assertEquals(line.includes("--no-token"), true, "names the legitimate reason");
});

Deno.test("status: no server is stated first, before anything about tokens", async () => {
  const { t } = fake({ _status: { body: { reachable: false, port: 8790, token: "missing", hasToken: false, start: "uvx ..." } } });
  const s = await serverStatus(t);
  assertEquals(describeStatus(s), "No segmentation server on port 8790.");
  assertEquals(s.start, "uvx ...");
});

Deno.test("status: an unreachable proxy is still a value", async () => {
  const { t } = fake({});
  assertEquals((await serverStatus(t)).reachable, false);
});

// The weights contract changed under us. 0.6.1 lists only the checkpoints that ARE present and
// sends no `installed` flag; the old shape listed all of them and flagged each. Reading the new
// shape with the old test ("!x.installed") reported everything missing, so the panel waited ten
// minutes for a download that had already finished. Both shapes must read the same way.
Deno.test("weights: an entry with no `installed` flag is present (haversack 0.6.1)", () => {
  assertEquals(missingWeightIds([{ id: "fastsurfer", version: "vinn-v2" }]), []);
});

Deno.test("weights: an explicit false is the only thing that means missing", () => {
  assertEquals(missingWeightIds([{ id: "a", installed: true }, { id: "b", installed: false }]), ["b"]);
});

Deno.test("weights: no list at all is not a claim that anything is missing", () => {
  assertEquals(missingWeightIds(undefined), []);
  assertEquals(missingWeightIds([]), []);
});

// FastSurfer publishes NoParams and rejects a submit that carries any option at all, so sending
// TotalSegmentator's `interp` to it killed every run with a 422 the panel then hid.
const FASTSURFER = { parameters: { algorithm: { properties: {} }, processing: { properties: {} } } };
const TOTALSEG = { parameters: { algorithm: { properties: { folds: {} } }, processing: { properties: { interp: {} } } } };

Deno.test("options: a task that declares none gets none", () => {
  assertEquals(keepAcceptedOptions({ interp: "linear" }, acceptedParameters(FASTSURFER)), {});
});

Deno.test("options: a declared parameter is sent, across both schemas", () => {
  const a = acceptedParameters(TOTALSEG);
  assertEquals(keepAcceptedOptions({ interp: "linear", folds: [0], bogus: 1 }, a), { interp: "linear", folds: [0] });
});

// The two empty answers are different: "takes none" drops, "could not tell" sends.
Deno.test("options: an unreadable task record sends the options unchanged", () => {
  assertEquals(acceptedParameters(null), undefined);
  assertEquals(keepAcceptedOptions({ interp: "linear" }, acceptedParameters(null)), { interp: "linear" });
});

Deno.test("submitError: the server's object-shaped detail reaches the user", () => {
  assertEquals(
    submitError({ detail: { code: "unknown_parameter", message: "unknown parameter 'interp'" } }),
    "unknown parameter 'interp'",
  );
});

Deno.test("submitError: FastAPI's list-shaped detail reaches the user too", () => {
  assertEquals(submitError({ detail: [{ msg: "field required" }, { msg: "not a file" }] }), "field required; not a file");
});

Deno.test("submitError: nothing recognisable is undefined, so the caller can say HTTP <code>", () => {
  assertEquals(submitError({}), undefined);
});

// THE RUNNING SERVER IS NOT THE PINNED ONE (critic, 2026-09-28, finding 4): a server left running from before an update
// keeps answering, and its results may differ. The line says so; the matching case says nothing extra.
Deno.test("status: a server of another version than the pinned one is named", async () => {
  const { t } = fake({ _status: { body: { reachable: true, port: 8790, token: "ok", hasToken: true, expected: "0.15.0", health: { version: "0.12.0", n_tasks: 95 } } } });
  const line = describeStatus(await serverStatus(t));
  assertEquals(line.includes("haversack 0.12.0"), true);
  assertEquals(line.includes("not the version Albula was tested with (0.15.0)"), true);
  const { t: t2 } = fake({ _status: { body: { reachable: true, port: 8790, token: "ok", hasToken: true, expected: "0.15.0", health: { version: "0.15.0", n_tasks: 99 } } } });
  assertEquals(describeStatus(await serverStatus(t2)).includes("not the version"), false);
});
