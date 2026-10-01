// A client for haversack's job server, from the page's side of the proxy.
//
// haversack (Michael Halle, github.com/mhalle/haversack) runs nnU-Net-family segmentation models --
// TotalSegmentator, MOOSE, MRSegmentator, stock nnU-Net, FastSurfer, SynthStrip -- behind one API,
// on Apple Silicon, CUDA or CPU, locally or on Modal. This talks to it through `/_haversack/*` on
// our own server rather than to port 8790 directly: haversack sends no CORS header, and its compute
// endpoints need a bearer token that a page must not hold. See desktop/haversack-proxy.ts.
//
// EVERY REQUEST GOES THROUGH `fetchJson`, which turns "not running" into a value rather than an
// exception. That is not defensiveness -- it is the expected state. Ron: "in general lets assume
// that people will do it at runtime." A panel that can say "haversack is not running, here is the
// line to paste" is more useful than one that throws.
//
// RESULTS ARE ADDRESSED BY WHAT WAS SEGMENTED, not by job. For a hosted series the labels live at
// `/v1/<source>/<ident>/<task>/labels.seg.nrrd`, and the server's own guide puts it plainly: "Ask
// twice, compute once." An upload has no public identity by design, so its result comes back
// through the job's own link.

/** What the server says about itself. `running: false` is a normal answer, not a failure. */
export interface HaversackHealth {
  running: boolean;
  version?: string;
  device?: string;
  taskCount?: number;
  sources?: string[];
  /** When it is not running: the command that starts it. */
  start?: string;
  detail?: string;
}

/** One task in the catalog. `installed` means its weights are already on disk. */
export interface HaversackTask {
  name: string;
  ecosystem: string;
  engine?: string;
  modality?: string;
  installed?: boolean;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface HaversackJob {
  id: string;
  state: JobState;
  /** 0..1 when the server reports it. */
  progress?: number;
  stage?: string;
  /** Free-text detail under the stage, e.g. "to input orientation". */
  detail?: string;
  /** For a task that runs several checkpoints (ts:total ensembles 5): which one, out of how many. */
  part?: number;
  nParts?: number;
  /**
   * The server had this result already and did no work.
   *
   * WHY THIS IS WORTH CARRYING. Ron: "total sometimes takes 27sec and sometime takes 10m. How do I
   * know ahead of time which it is? It's important for demos." It is the cache, and the server says
   * so plainly -- in his own job history, seven of eleven ts:total runs came back with
   * `finished == started` and `cached: true`, while the four real ones took 79, 216, 271 and 601
   * seconds. Nothing on screen distinguished the two, so the same button was sometimes instant and
   * sometimes ten minutes with no way to tell which.
   */
  cached?: boolean;
  error?: string;
  /**
   * WHAT RAN, as the server records it in the job's `result.provenance`: task, engine (`lineage`),
   * device, dtype, haversack version, and per model the weights folder, version and folds. Plus
   * the input's content hash (`input_identity`) and the phase timings. Mike Halle, 2026-09-12:
   * "that metadata, the hardware that runs the pipeline, and the input data all need to be tied
   * together with provenance." The server already ties them; this carries the knot into Albula.
   */
  provenance?: Record<string, unknown>;
  inputIdentity?: string[];
  timings?: Record<string, number>;
}

/** Injected so tests need no server, and so the base path is stated once. */
export interface HaversackTransport {
  fetch: typeof fetch;
  base?: string;
}

const BASE = "/_haversack/";

async function fetchJson<T>(t: HaversackTransport, path: string, init?: RequestInit): Promise<{ ok: true; value: T } | { ok: false; status: number; body: unknown }> {
  const url = (t.base ?? BASE) + path;
  try {
    const res = await t.fetch(url, init);
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) return { ok: false, status: res.status, body };
    return { ok: true, value: body as T };
  } catch (e) {
    // The proxy itself is unreachable, which is different from haversack being down: our own server
    // is the page's origin, so this means the app is in a state where nothing will work.
    return { ok: false, status: 0, body: { error: String(e) } };
  }
}

/**
 * Server AND credential state together, from our own `_status` route.
 *
 * These two facts have to arrive together or the failure is unreadable. `/v1/health` needs no token
 * and so answers happily when the token is unusable; the first thing a user then sees is a compute
 * request refused with "this server requires a bearer token", having been told nothing about
 * whether a server was even found. Ron hit exactly that.
 */
export interface HaversackStatus {
  reachable: boolean;
  port: number;
  /** How the token file read: `ok`, `missing` (perhaps --no-token), `unreadable`, `wrong-port`. */
  token: "ok" | "missing" | "unreadable" | "wrong-port";
  hasToken: boolean;
  version?: string;
  /** The haversack version this build pins and was tested with (`HAVERSACK_VERSION`, without the "v"). */
  expectedVersion?: string;
  device?: string;
  taskCount?: number;
  /** The command to start one, when there is none. */
  start?: string;
}

/** One line a panel can render, and the state behind it. */
export async function serverStatus(t: HaversackTransport): Promise<HaversackStatus> {
  const r = await fetchJson<Record<string, unknown>>(t, "_status");
  if (!r.ok) {
    return { reachable: false, port: 0, token: "missing", hasToken: false, start: undefined };
  }
  const v = r.value;
  const h = (v.health ?? {}) as Record<string, unknown>;
  const tok = String(v.token ?? "missing");
  return {
    reachable: v.reachable === true,
    port: typeof v.port === "number" ? v.port : 0,
    token: tok === "ok" || tok === "unreadable" || tok === "wrong-port" ? tok : "missing",
    hasToken: v.hasToken === true,
    version: typeof h.version === "string" ? h.version : undefined,
    expectedVersion: typeof v.expected === "string" ? v.expected : undefined,
    device: typeof h.device === "string" ? h.device : undefined,
    taskCount: typeof h.n_tasks === "number" ? h.n_tasks : undefined,
    start: typeof v.start === "string" ? v.start : undefined,
  };
}

/**
 * One sentence describing that state, for the panel's header.
 *
 * Says whether a server was found FIRST, because that is the question, and names a credential
 * problem explicitly rather than letting it surface later as an opaque refusal.
 */
export function describeStatus(s: HaversackStatus): string {
  if (!s.reachable) return `No segmentation server on port ${s.port || "?"}.`;
  // THE WRONG VERSION IS SAID FIRST after "found": results from a server this build was not tested with may differ
  // (critic, 2026-09-28, finding 4). A server left running from before an update keeps answering.
  const other = s.version && s.expectedVersion && s.version !== s.expectedVersion
    ? ` · this is not the version Albula was tested with (${s.expectedVersion}); results may differ — quit that server and start this one`
    : "";
  const who = `haversack ${s.version ?? "?"} on port ${s.port}${other} · ${s.device ?? "auto"} · ${s.taskCount ?? "?"} networks`;
  if (s.token === "ok") return `${who} · authenticated`;
  if (s.token === "missing") {
    return `${who} · no token file — reads will work and segmenting may be refused (fine if the server was started with --no-token)`;
  }
  if (s.token === "wrong-port") return `${who} · the token file on disk belongs to a server on another port; segmenting will be refused`;
  return `${who} · the token file could not be read; segmenting will be refused`;
}

/** Is it up, and what is it? */
export async function health(t: HaversackTransport): Promise<HaversackHealth> {
  const r = await fetchJson<Record<string, unknown>>(t, "health");
  if (!r.ok) {
    const b = (r.body ?? {}) as Record<string, unknown>;
    return {
      running: false,
      start: typeof b.start === "string" ? b.start : undefined,
      detail: typeof b.detail === "string" ? b.detail : typeof b.error === "string" ? b.error : `HTTP ${r.status}`,
    };
  }
  const v = r.value;
  return {
    running: v.accepting !== false,
    version: typeof v.version === "string" ? v.version : undefined,
    device: typeof v.device === "string" ? v.device : undefined,
    taskCount: typeof v.n_tasks === "number" ? v.n_tasks : undefined,
    sources: Array.isArray(v.sources) ? v.sources.filter((s): s is string => typeof s === "string") : undefined,
  };
}

/**
 * The catalog.
 *
 * `/v1/tasks` returns bare names; the `--json` form of the CLI returns records. Both shapes are
 * accepted because which one a given server version sends is not worth depending on, and the
 * ecosystem is derivable from the name either way -- it is the part before the colon, which is how
 * a paper is looked up (logic/anatomy/model-papers.ts).
 */
export async function tasks(t: HaversackTransport): Promise<HaversackTask[]> {
  const r = await fetchJson<unknown>(t, "tasks");
  if (!r.ok) return [];
  const raw = Array.isArray(r.value) ? r.value : (r.value as { tasks?: unknown[] })?.tasks ?? [];
  return raw.map((x): HaversackTask => {
    if (typeof x === "string") return { name: x, ecosystem: x.includes(":") ? x.split(":", 1)[0] : "" };
    const o = x as Record<string, unknown>;
    const name = String(o.name ?? "");
    return {
      name,
      ecosystem: typeof o.ecosystem === "string" ? o.ecosystem : name.includes(":") ? name.split(":", 1)[0] : "",
      engine: typeof o.engine === "string" ? o.engine : undefined,
      modality: typeof o.modality === "string" ? o.modality : undefined,
      installed: typeof o.installed === "boolean" ? o.installed : undefined,
    };
  }).filter((x) => x.name);
}

/**
 * Submit one volume as an upload.
 *
 * `POST /v1/jobs` is multipart: `task`, an optional `options` JSON object, and either a `file` part
 * or a `source` list. A file part is used here because the input is a volume this application
 * already holds and no hosted identifier names it -- the cropped series was made locally, so
 * neither `idc` nor `tcia` can fetch it.
 */
/**
 * The server's own words for a rejected submit.
 *
 * haversack answers a bad submit with `detail` as an OBJECT -- {code, message, parameter, known} --
 * and FastAPI's own validation errors put a LIST there. Reading it only when it was a string threw
 * both away and left the user with a bare status code: "submit failed (HTTP 422)" for what the
 * server had already explained as "unknown parameter 'interp'".
 */
export function submitError(body: Record<string, unknown>): string | undefined {
  if (typeof body.error === "string") return body.error;
  const d = body.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const m = (d as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (Array.isArray(d)) {
    const msgs = d.map((e) => (e as Record<string, unknown>)?.msg).filter((m) => typeof m === "string");
    if (msgs.length) return msgs.join("; ");
  }
  return undefined;
}

export async function submitVolume(
  t: HaversackTransport,
  args: { task: string; bytes: Uint8Array; filename?: string; options?: Record<string, unknown> },
): Promise<{ ok: true; jobId: string } | { ok: false; message: string; start?: string }> {
  const form = new FormData();
  form.set("task", args.task);
  if (args.options) form.set("options", JSON.stringify(args.options));
  form.set("file", new Blob([args.bytes as unknown as BlobPart], { type: "application/octet-stream" }), args.filename ?? "input.nrrd");

  const r = await fetchJson<Record<string, unknown>>(t, "jobs", { method: "POST", body: form });
  if (!r.ok) {
    const b = (r.body ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      message: submitError(b) ?? `submit failed (HTTP ${r.status})`,
      start: typeof b.start === "string" ? b.start : undefined,
    };
  }
  const id = r.value.id ?? r.value.job_id ?? r.value.jid;
  return typeof id === "string" ? { ok: true, jobId: id } : { ok: false, message: "the server accepted the job but returned no id" };
}

/** One poll. State names vary a little between versions, so unknown maps to "unknown", not to failure. */
export async function job(t: HaversackTransport, id: string): Promise<HaversackJob> {
  const r = await fetchJson<Record<string, unknown>>(t, `jobs/${encodeURIComponent(id)}`);
  if (!r.ok) return { id, state: "unknown", error: `HTTP ${r.status}` };
  const v = r.value;
  const raw = String(v.state ?? v.status ?? "").toLowerCase();
  const state: JobState = raw === "queued" || raw === "pending"
    ? "queued"
    : raw === "running" || raw === "started"
    ? "running"
    : raw === "succeeded" || raw === "success" || raw === "done" || raw === "completed"
    ? "succeeded"
    : raw === "failed" || raw === "error"
    ? "failed"
    : raw === "cancelled" || raw === "canceled"
    ? "cancelled"
    : "unknown";
  // The running server nests all of this in `progress` -- {stage, detail, part, n_parts, fraction,
  // elapsed} -- verified against a live haversack 0.4.0 job. A flat `progress` number/`stage`
  // string is read too, in case a simpler job type ever reports one directly instead.
  const p = v.progress;
  const nested = p && typeof p === "object" ? p as Record<string, unknown> : undefined;
  return {
    id,
    state,
    progress: typeof nested?.fraction === "number" ? nested.fraction : typeof p === "number" ? p : undefined,
    stage: typeof nested?.stage === "string" ? nested.stage : typeof v.stage === "string" ? v.stage : undefined,
    detail: typeof nested?.detail === "string" ? nested.detail : undefined,
    part: typeof nested?.part === "number" ? nested.part : undefined,
    nParts: typeof nested?.n_parts === "number" ? nested.n_parts : undefined,
    cached: v.cached === true,
    error: typeof v.error === "string" ? v.error : undefined,
    provenance: (v.result as { provenance?: Record<string, unknown> } | undefined)?.provenance,
    inputIdentity: Array.isArray(v.input_identity) ? (v.input_identity as string[]) : typeof v.input_identity === "string" ? [v.input_identity] : undefined,
    timings: (v.result as { timings?: Record<string, number> } | undefined)?.timings,
  };
}

/** The finished labels, as bytes. An upload's result is only reachable through its job. */
export async function result(t: HaversackTransport, id: string): Promise<Uint8Array | null> {
  try {
    const res = await t.fetch((t.base ?? BASE) + `jobs/${encodeURIComponent(id)}/result`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * One checkpoint a task needs, as `/v1/tasks/<task>` reports it.
 *
 * `installed` is OPTIONAL, and that is the whole point. Older haversack listed every checkpoint a
 * task could want and marked each `installed: true|false`. 0.6.1 lists only the ones that are
 * actually on the machine and sends no flag at all -- presence in the list IS the answer.
 * A caller that tests `!x.installed` reads the new shape as "nothing is installed" and waits
 * forever. Ron, eight minutes into a download that had finished in six microseconds:
 * "It should say downloading xxx. Instead this poor update information."
 */
export interface WeightEntry {
  id: string;
  version?: string;
  installed?: boolean;
}

/** Is this checkpoint on the machine? True under BOTH contracts: an explicit `installed: true`,
 *  or an entry that carries no flag because merely being listed means it is here. Only an
 *  explicit `false` counts as missing. */
export function weightPresent(w: WeightEntry): boolean {
  return w.installed !== false;
}

/** The ids a task still needs. Empty means it can run now. */
export function missingWeightIds(list: readonly WeightEntry[] | undefined): string[] {
  return (list ?? []).filter((w) => !weightPresent(w)).map((w) => w.id);
}

/**
 * The parameter names a task will actually accept, from its own `/v1/tasks/<task>` record.
 *
 * haversack publishes `parameters` as two JSON schemas -- `algorithm` and `processing` -- and both
 * are `additionalProperties: false`. An engine that takes no knobs publishes `NoParams`, with an
 * empty `properties`, and that is a positive statement rather than a gap: send it anything and the
 * submit is rejected 422 before the upload is stored.
 *
 * Albula sent `interp` on every submit because TotalSegmentator takes it. FastSurfer does not, so
 * every FastSurfer run died with "unknown parameter 'interp'" -- and the reason never reached the
 * screen, because the panel read `detail` only when it was a string and this one is an object.
 * Ron: "did. getting submit failed (HTTP 422)". Ask the task what it takes; send only that.
 */
export function acceptedParameters(taskDetail: unknown): Set<string> | undefined {
  const params = (taskDetail as { parameters?: Record<string, unknown> } | null)?.parameters;
  if (!params || typeof params !== "object") return undefined;   // no record: we do not know
  const out = new Set<string>();
  for (const schema of Object.values(params)) {
    const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
    if (props && typeof props === "object") for (const k of Object.keys(props)) out.add(k);
  }
  return out;                                                    // possibly empty: takes none
}

/**
 * Drop any option this task does not declare.
 *
 * The two empty answers are NOT the same and the difference decides a user's result. An empty SET
 * is the task saying it takes no parameters, so every option is dropped. `undefined` is us failing
 * to read the record at all, and then the options go as they are -- silently dropping `interp`
 * because a status fetch hiccuped would hand Ron back the 3 mm stepping he had already told us
 * about ("Looks ok. But very rough.") with nothing on screen to say why. When we do not know, we
 * send, and let the server be the one to object.
 */
export function keepAcceptedOptions(
  options: Record<string, unknown>,
  accepted: Set<string> | undefined,
): Record<string, unknown> {
  if (!accepted) return { ...options };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) if (accepted.has(k)) out[k] = v;
  return out;
}

/** Terminal states, so a caller's poll loop has one definition of "stop". */
export function isFinished(s: JobState): boolean {
  return s === "succeeded" || s === "failed" || s === "cancelled";
}
