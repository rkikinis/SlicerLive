// THE EXTENSIONS' IMPORT-TIME JOBS (extension-jobs.ts): read from the list, run one at a time, counted from their
// --counts-only lines; nothing runs before the server turns them on.
//   deno test -A --no-check desktop/extension-jobs.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { databaseChanged, jobEntries, jobsStatus, mrStamp, startExtensionJobs, workspaceOf } from "./extension-jobs.ts";

Deno.test("an extension's job: listed, run over a database at startup and after a change, counted, one at a time", async () => {
  const dir = await Deno.makeTempDir({ prefix: "albula-jobs-" });
  await Deno.mkdir(`${dir}/ext`);
  // A stand-in job: it says what the diffusion job says in --counts-only mode, and records its arguments and its start.
  await Deno.writeTextFile(`${dir}/ext/job.ts`, `
const a = Deno.args, db = a[a.indexOf("--db") + 1];
await Deno.writeTextFile(${JSON.stringify(`${dir}/runs.txt`)}, db + (a.includes("--counts-only") ? " quiet" : " LOUD") + "\\n", { append: true });
const say = (o: unknown) => console.log(JSON.stringify(o));
say({ event: "plan", studies: 2 });
say({ event: "case", case: 1, state: "made" });
say({ event: "case", case: 2, state: "current" });
await new Promise((r) => setTimeout(r, 300));
say({ event: "done", made: 1, current: 1 });`);
  await Deno.writeTextFile(`${dir}/ext/extension.json`, JSON.stringify({ name: "stand-in", entries: { job: "job.ts" } }));
  await Deno.writeTextFile(`${dir}/extensions.json`, JSON.stringify({ version: 1, extensions: [{ name: "stand-in", path: "ext", on: true }, { name: "off", path: "ext", on: false }] }));
  Deno.env.set("ALBULA_EXTENSIONS", `${dir}/extensions.json`);
  Deno.env.set("ALBULA_CORE_CONFIG", new URL("../deno.jsonc", import.meta.url).pathname);
  try {
    assertEquals(jobEntries().map((j) => j.extension), ["stand-in"]);
    // Before the server turns them on, a change starts nothing (the routes' tests call databaseChanged).
    databaseChanged("early", 1);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(jobsStatus().available, false);
    // A real index with one MR series: the startup marker is a stamp of the MR series (finding 12).
    await Deno.mkdir(`${dir}/a`);
    const ix = new DatabaseSync(`${dir}/a/ctkDICOM.sql`);
    ix.exec("CREATE TABLE Series (SeriesInstanceUID TEXT, Modality TEXT); INSERT INTO Series VALUES ('1.2.3', 'MR'), ('1.2.4', 'SEG');");
    ix.close();
    const before = await mrStamp(`${dir}/a`);
    assert(before.length === 16, "a stamp of the MR series");
    const dbs = () => Promise.resolve([{ id: "a", path: `${dir}/a`, exists: true }, { id: "gone", path: `${dir}/gone`, exists: false }, { id: "b", path: `${dir}/b`, exists: true }].filter((d) => d.id !== "b"));
    startExtensionJobs({ port: 1, databases: dbs, sweepAfterMs: 10 });
    assert(jobsStatus().available, jobsStatus().why);
    databaseChanged("b", 20);
    // The startup sweep over "a" (not the missing one), then "b"; never two at once.
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      const runs = await Deno.readTextFile(`${dir}/runs.txt`).catch(() => "");
      if (runs.split("\n").filter(Boolean).length >= 2 && !jobsStatus().running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const runs = (await Deno.readTextFile(`${dir}/runs.txt`)).split("\n").filter(Boolean);
    assertEquals(runs.sort(), ["a quiet", "b quiet"]);
    const last = jobsStatus().last!;
    assertEquals([last.studies, last.cases, last.made, last.current, last.exit], [2, 2, 1, 1, 0]);
    // A SECOND STARTUP with "a"'s MR series as they were -- a segmentation saved meanwhile does not count: skipped.
    const ix2 = new DatabaseSync(`${dir}/a/ctkDICOM.sql`); ix2.exec("INSERT INTO Series VALUES ('1.2.5', 'SEG');"); ix2.close();
    assertEquals(await mrStamp(`${dir}/a`), before);
    startExtensionJobs({ port: 1, databases: dbs, sweepAfterMs: 10 });
    await new Promise((r) => setTimeout(r, 1500));
    assertEquals((await Deno.readTextFile(`${dir}/runs.txt`)).split("\n").filter(Boolean).length, 2);
    databaseChanged("a", 10);
    const t1 = Date.now();
    while (Date.now() - t1 < 20_000 && (await Deno.readTextFile(`${dir}/runs.txt`)).split("\n").filter(Boolean).length < 3) await new Promise((r) => setTimeout(r, 100));
    while (jobsStatus().running) await new Promise((r) => setTimeout(r, 100));
    assertEquals((await Deno.readTextFile(`${dir}/runs.txt`)).split("\n").filter(Boolean).length, 3);
  } finally {
    Deno.env.delete("ALBULA_EXTENSIONS"); Deno.env.delete("ALBULA_CORE_CONFIG");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the workspace is found from the gallery the server serves, not from where the code is (the compiled app)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "albula-ws-" });
  try {
    assertEquals(workspaceOf(`${dir}/Contents/src/live`), undefined);
    await Deno.mkdir(`${dir}/Contents/extensions`, { recursive: true }); await Deno.mkdir(`${dir}/Contents/src/SlicerLive`, { recursive: true });
    await Deno.writeTextFile(`${dir}/Contents/extensions/extensions.json`, "{}"); await Deno.writeTextFile(`${dir}/Contents/src/SlicerLive/deno.jsonc`, "{}");
    assertEquals(workspaceOf(`${dir}/Contents/src/live`), { list: `${dir}/Contents/extensions/extensions.json`, config: `${dir}/Contents/src/SlicerLive/deno.jsonc` });
    assertEquals(jobEntries("none"), []);
  } finally { await Deno.remove(dir, { recursive: true }); }
});


Deno.test("the core's job runs only from the commit the app was built from, with nothing changed (critic 2026-10-20, finding 2)", async () => {
  const { appBuild, coreJobs, notPinned } = await import("./extension-jobs.ts");
  const dir = await Deno.makeTempDir({ prefix: "albula-core-pin-" });
  const git = async (...a: string[]) => new TextDecoder().decode((await new Deno.Command("git", { args: ["-C", `${dir}/SlicerLive`, ...a], stdout: "piped", stderr: "null" }).output()).stdout).trim();
  try {
    await Deno.mkdir(`${dir}/SlicerLive/desktop`, { recursive: true }); await Deno.mkdir(`${dir}/live/webgpu`, { recursive: true });
    await Deno.writeTextFile(`${dir}/SlicerLive/deno.jsonc`, "{}"); await Deno.writeTextFile(`${dir}/SlicerLive/desktop/brain-structures-job-main.ts`, "// job\n");
    await git("init", "-q"); await git("add", "deno.jsonc", "desktop/brain-structures-job-main.ts");
    await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "one");
    const head = await git("rev-parse", "--short", "HEAD");
    const stamp = (s: string) => Deno.writeTextFile(`${dir}/live/webgpu/slicer-app.js`, `var a=1;const B="v0.1.0 Oct 20 15:29 ${s} \\xB7 diffusion@0.2.0 cbc0c17";`);
    const job = () => coreJobs(`${dir}/SlicerLive/deno.jsonc`, `${dir}/live`)[0];
    // No bundle: which code the app was built from is not known -- not run.
    assertEquals(appBuild(`${dir}/live`), undefined);
    assert((await notPinned(job()))?.includes("build stamp"));
    // Built from this commit, folder clean: runs.
    await stamp(head);
    assertEquals(appBuild(`${dir}/live`), { commit: head, changes: false });
    assertEquals(await notPinned(job()), undefined);
    assertEquals(job().version?.startsWith("brain-structures v"), true);
    // An edit not committed: not run.
    await Deno.writeTextFile(`${dir}/SlicerLive/desktop/brain-structures-job-main.ts`, "// half-made edit\n");
    assertEquals(await notPinned(job()), "its folder has changes the app was not built from");
    // Committed after the build: not run either.
    await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-am", "two");
    assertEquals(await notPinned(job()), "its folder is not at the version the app was built from");
    // An app built from uncommitted changes ("+" after the commit): not run.
    await stamp(`${await git("rev-parse", "--short", "HEAD")}+`);
    assert((await notPinned(job()))?.includes("never committed"));
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("GET /_jobs says while the page holds the graphics card, so a running job starts no next case (critic 2026-10-20, finding 13)", async () => {
  const { handleJobsRequest } = await import("./extension-jobs.ts");
  const held = async () => ((await handleJobsRequest(new Request("http://x/_jobs"))!.json()) as { held: boolean }).held;
  const before = await held();
  handleJobsRequest(new Request("http://x/_jobs/hold", { method: "POST" }));
  assertEquals(await held(), true);
  assertEquals(typeof before, "boolean");
});

Deno.test("POST /_jobs/run: a module asks for its database's work; an unknown database is not queued (2026-10-26, Ron: 'wait for the import')", async () => {
  const { handleJobsRunRequest } = await import("./extension-jobs.ts");
  assertEquals(await handleJobsRunRequest(new Request("http://x/_jobs")), null, "another path is not this route's");
  assertEquals((await handleJobsRunRequest(new Request("http://x/_jobs/run")))!.status, 405);
  const r = await handleJobsRunRequest(new Request("http://x/_jobs/run", { method: "POST", body: JSON.stringify({ db: "no-such-database" }) }));
  const body = await r!.json() as { queued: boolean; why?: string };
  assertEquals(body.queued, false);
  assert(body.why, "it says why");
  assert(!jobsStatus().queued.includes("no-such-database"));
});
