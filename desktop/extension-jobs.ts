// THE EXTENSIONS' JOBS AT IMPORT (Ron, 2026-10-05: "automatic import"; 2026-10-14: "Implementing the 10-5 decision is
// high priority … just do it with the option in mind to switch later"). An extension may name a `job` entry in its
// manifest (extension.json): a program that works over a whole database and makes only what is missing -- the diffusion
// extension's fiber tracts and maps (its import-job-main.ts; the workspace's Contents/docs/DMRI-AT-IMPORT.md). The server
// runs it:
//   - a little while after series were added to a database (`databaseChanged`, called by the routes that index), and
//   - once at startup over every registered database whose MR series changed since the last finished run.
// One run at a time, across all databases and extensions; a change during a run asks for one more run afterwards.
//
// HOW IT RUNS, FOR NOW: as its own process, with the Deno this Mac has (the job is a TypeScript program; extension code
// cannot be loaded into the compiled server). Without Deno, or without the workspace (an app copied to another Mac),
// there is no job, `/_jobs` says why, and the extension does the work itself when asked, as before. THE SWITCH LATER:
// the same job compiled into the app; only `command()` changes.
// WHERE THE WORKSPACE IS: from the gallery the server serves (Contents/src/live) -- never from import.meta.url, which in
// the compiled app points inside the binary (critic 2026-10-14, import-time jobs, finding 1: the app never ran a job).
// WHICH CODE RUNS: the extension's folder must be at the commit the app was built from (Contents/extensions/
// extensions.json "pinned") and clean, or no job runs (finding 6: the job ran the working tree). The same for the
// core's own job, whose pin is the commit in the app's build stamp (critic 2026-10-20, finding 2).
//
// WHAT IT SAYS: `--counts-only`, always -- states and counts, no names, no identifiers, no paths (the job's own privacy
// mode, critic 2026-10-05): what reaches the session log and the page's status line cannot carry a patient's data.
//   GET  /_jobs   { available, why?, running?: { extension, db, cases, made, … }, last?, queued }
//   POST /_jobs/hold  the page is about to do heavy work on the graphics card: no job STARTS for two minutes (finding 3),
//                     and a job that checks `held` in GET /_jobs starts no next case meanwhile (critic 2026-10-20, 13)
// `--only-missing`, always (Ron, 2026-10-14, on reproducibility: "You need to rethink that concept of stale"): a job
// makes only what is not there; what an earlier version made is kept. Versions and provenance: VERSIONS-AND-PROVENANCE.md.
// Core names no extension: the list is data, read at run time (extension-hooks.ts's rule).
import { restartNotice } from "./haversack-proxy.ts";
import { readMarker, updateMarker } from "./job-marker.ts";
import { BRAIN_JOB_KEY, BRAIN_JOB_VERSION } from "../logic/import-jobs/brain-structures-rule.ts";
import { write as appendSessionLog } from "./session-log.ts";
import { sqliteScript } from "./sqlite.ts";

const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");

export interface JobEntry {
  extension: string; dir: string; file: string; pinned?: string;
  /** Why the commit to check against is not known (the core's job: no build stamp, or one built from changes): no run. */
  unpinnable?: string;
  /** The version the marker file records (`.albula-jobs.json`): the pin for an extension, the rules' number for the core. */
  version?: string;
  /** What the person reads while it runs ("Preparing fiber tracts"). */ label: string;
}
/** The `job` entries of the extensions that are on, from a list (the workspace's extensions.json). */
export function jobEntries(list = Deno.env.get("ALBULA_EXTENSIONS") ?? ""): JobEntry[] {
  if (!list || list === "none") return [];
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(list)) as { extensions?: { name: string; path: string; on: boolean; pinned?: string }[] };
    const out: JobEntry[] = [];
    for (const e of parsed.extensions ?? []) {
      if (!e.on) continue;
      const dir = join(dirname(list), e.path);
      const m = JSON.parse(Deno.readTextFileSync(join(dir, "extension.json"))) as { entries?: { job?: string }; jobLabel?: string };
      if (m.entries?.job) out.push({ extension: e.name, dir, file: join(dir, m.entries.job), pinned: e.pinned, version: e.pinned, label: m.jobLabel ?? `Preparing ${e.name}` });
    }
    return out;
  } catch { return []; }
}

/** THE CORE'S OWN JOBS (2026-10-20, Ron: FastSurfer when a T1 is added): run like an extension's, from the core's folder
 *  (beside the import map the server already hands every job), with `deno run` -- so from whatever that folder holds
 *  when the run starts, NOT from the app's build (critic 2026-10-20, finding 2: a half-made edit, or a commit after the
 *  last rebuild, would write SEGs that are kept for good). So it is pinned like an extension: to the commit the app was
 *  built from, read from the build stamp, and the folder must be clean (`notPinned`). Before the extensions' jobs, so a
 *  case's brain is there before its tracts are made. */
export function coreJobs(coreConfig = config, gallery = galleryRoot): JobEntry[] {
  if (!coreConfig) return [];
  const dir = dirname(coreConfig);
  const file = join(dir, "desktop", "brain-structures-job-main.ts");
  try { Deno.statSync(file); } catch { return []; }
  const build = gallery ? appBuild(gallery) : undefined;
  const pin = !build ? { unpinnable: "the app's build stamp could not be read, so which version of the code it was built from is not known" }
    : build.changes ? { unpinnable: "the app was built from changes that were never committed; rebuild it from a committed version" }
    : { pinned: build.commit };
  return [{ extension: BRAIN_JOB_KEY, dir, file, ...pin, version: `brain-structures v${BRAIN_JOB_VERSION}`, label: "Finding the brain's structures" }];
}

/** THE COMMIT THE APP WAS BUILT FROM: the build stamp the rebuild compiles into the page's bundle (Contents/tools/Rebuild
 *  SlicerAlbula App.command, `--define:__BUILD_ID__`): "v0.1.0 Oct 20 15:29 dab8042", with a "+" after the commit when
 *  the folder had changes. Read from the bundle the server serves -- the build, not the disk's source. */
export function appBuild(gallery: string): { commit: string; changes: boolean } | undefined {
  try {
    const js = Deno.readTextFileSync(join(gallery, "webgpu", "slicer-app.js"));
    const m = /"v\d+\.\d+\.\d+ [A-Z][a-z]{2} [ \d]\d \d\d:\d\d ([0-9a-f]{7,40})(\+?)/.exec(js);
    return m ? { commit: m[1], changes: m[2] === "+" } : undefined;
  } catch { return undefined; }
}

/** Deno on this Mac: where Homebrew and the installer put it (a program started from the Dock has a short PATH).
 *  Executable, not only a file (finding 2: a text file was taken and its start took the server down). */
export function findDeno(): string | undefined {
  const home = Deno.env.get("HOME") ?? "";
  const tries = [Deno.env.get("ALBULA_DENO") ?? "", "/opt/homebrew/bin/deno", "/usr/local/bin/deno", `${home}/.deno/bin/deno`,
    ...(Deno.env.get("PATH") ?? "").split(":").map((d) => `${d}/deno`)];
  for (const t of tries) { if (!t) continue; try { const s = Deno.statSync(t); if (s.isFile && ((s.mode ?? 0o755) & 0o111)) return t; } catch { /* next */ } }
  return undefined;
}

/** The workspace's paths from the gallery the server serves (…/Contents/src/live): the extension list and the core's
 *  import map (Contents/src/SlicerLive/deno.jsonc). Undefined when the gallery is not inside a workspace. */
export function workspaceOf(galleryRoot: string): { list: string; config: string } | undefined {
  const contents = dirname(dirname(galleryRoot.replace(/\/+$/, "")));
  const list = join(contents, "extensions", "extensions.json"), config = join(contents, "src", "SlicerLive", "deno.jsonc");
  try { Deno.statSync(list); Deno.statSync(config); return { list, config }; } catch { return undefined; }
}

/** A git folder's commit, "+changes" when it differs from it; "unknown" without git. Handed to the job for its record:
 *  the core's version is the server's to say (an extension does not reach into core's folders). */
async function gitState(dir: string): Promise<string> {
  const g = async (...a: string[]) => { try { const o = await new Deno.Command("git", { args: ["-C", dir, ...a], stdout: "piped", stderr: "null" }).output(); return o.success ? new TextDecoder().decode(o.stdout).trim() : undefined; } catch { return undefined; } };
  const head = await g("rev-parse", "--short=12", "HEAD");
  if (!head) return "unknown";
  return (await g("status", "--porcelain", "--untracked-files=no")) ? `${head}+changes` : head;
}

/** Why a job's folder may not run: not at the commit the app was built from, or changed since (git; no git: no check).
 *  The pin may be a short commit (the build stamp's); one plain line goes to the session log (drain). */
export async function notPinned(j: JobEntry): Promise<string | undefined> {
  if (j.unpinnable) return j.unpinnable;
  if (!j.pinned) return undefined;
  const git = async (...a: string[]) => {
    try { const o = await new Deno.Command("git", { args: ["-C", j.dir, ...a], stdout: "piped", stderr: "null" }).output(); return o.success ? new TextDecoder().decode(o.stdout).trim() : undefined; }
    catch { return undefined; }
  };
  const head = await git("rev-parse", "HEAD");
  if (head === undefined) return undefined;
  if (!head.startsWith(j.pinned)) return "its folder is not at the version the app was built from";
  if ((await git("status", "--porcelain", "--untracked-files=no")) !== "") return "its folder has changes the app was not built from";
  return undefined;
}

export interface RunState { extension: string; label: string; db: string; studies?: number; cases: number; made: number; current: number; waiting: number; cannot: number; failed: number; startedAt: number }
interface Status { available: boolean; why?: string; running?: RunState; last?: RunState & { endedAt: number; exit: number; said?: string }; queued: string[] }

let origin = "";            // http://127.0.0.1:<port>, set by startExtensionJobs; empty: jobs are off (tests, tools)
let config = "";            // the core's deno.jsonc
let galleryRoot = "";       // the gallery the server serves: where the app's build stamp is read (coreJobs)
type Db = { id: string; path: string; exists: boolean };
let listDatabases: () => Promise<Db[]> = () => Promise.resolve([]);
const sweepOnly = new Set<string>();   // queued by the startup sweep: skipped when the MR series are as at the last finished run
const status: Status = { available: false, queued: [] };
const pending = new Map<string, ReturnType<typeof setTimeout>>();   // db id -> its debounce timer
const queue: string[] = [];                                          // db ids waiting for a run
const again = new Set<string>();                                     // changed while running: one more run after
let running = false;
let heldUntil = 0;                                                   // POST /_jobs/hold: no job starts before this time
let child: Deno.ChildProcess | undefined;
/** A run's upper limit: a job stuck (behind haversack's queue, say) gives the slot back (finding 10). */
const RUN_LIMIT_MS = 6 * 3600_000;

/** Turn the jobs on (server-worker.ts, once the server listens). `sweepAfterMs`: the startup run over every database. */
export function startExtensionJobs(opts: { port: number; databases: () => Promise<Db[]>; galleryRoot?: string; sweepAfterMs?: number }): void {
  if (Deno.env.get("ALBULA_JOBS") === "off") { status.why = "turned off for this server (ALBULA_JOBS=off)"; return; }
  listDatabases = opts.databases;
  const ws = opts.galleryRoot ? workspaceOf(opts.galleryRoot) : undefined;
  const list = Deno.env.get("ALBULA_EXTENSIONS") ?? ws?.list;
  config = Deno.env.get("ALBULA_CORE_CONFIG") ?? ws?.config ?? "";
  galleryRoot = opts.galleryRoot ?? "";
  if (!list || !config) { status.why = "this app is not running from its source folders, so there is no import-time work"; return; }
  Deno.env.set("ALBULA_EXTENSIONS", list);
  const jobs = [...coreJobs(), ...jobEntries(list)];
  if (!jobs.length) { status.why = "no import-time work is installed here"; return; }
  if (!findDeno()) { status.why = "Deno is not on this Mac, so the import-time work runs when a module asks for it"; return; }
  origin = `http://127.0.0.1:${opts.port}`;
  status.available = true; status.why = undefined;
  // ALBULA_JOBS_SWEEP=off: only changes start a job (a test server on the real databases must not do their catch-up).
  if (Deno.env.get("ALBULA_JOBS_SWEEP") !== "off") {
    setTimeout(() => {
      listDatabases().then((dbs) => { for (const d of dbs) if (d.exists) { sweepOnly.add(d.id); enqueue(d.id); } })
        .catch((e) => appendSessionLog(`import-time work: the startup sweep could not list the databases (${(e as Error).name})`));
    }, opts.sweepAfterMs ?? 60_000);
  }
}

/** Series were added to a database: run its jobs in a little while (several imports in a row make one run). */
export function databaseChanged(dbId: string, delayMs = 15_000): void {
  if (!origin || !dbId) return;
  sweepOnly.delete(dbId);   // a real change: run, whatever the last run's marker says
  if (status.running?.db === dbId) again.add(dbId);   // and the marker of the run under way is not written (finding 11)
  clearTimeout(pending.get(dbId));
  pending.set(dbId, setTimeout(() => { pending.delete(dbId); enqueue(dbId); }, delayMs));
}

function enqueue(dbId: string): void {
  if (status.running?.db === dbId) { again.add(dbId); return; }
  if (!queue.includes(dbId)) queue.push(dbId);
  status.queued = [...queue];
  void drain();
}

// THE STARTUP SWEEP SKIPS AN UNCHANGED DATABASE: a job reads every MR study's headers to find what it works on (82 s and
// about 3 GB on the test cases database, critic 2026-10-14), so a database whose MR series are the same as when the last
// finished run BEGAN is not looked at again (findings 11 and 12: the index file's time changed with every segmentation
// saved, and was read at the end of the run). The marker: `.albula-jobs.json` beside the index, per extension.
// The file is read and written by desktop/job-marker.ts only.
export async function mrStamp(path: string): Promise<string> {
  try {
    const out = await sqliteScript(join(path, "ctkDICOM.sql"), ".timeout 5000\nSELECT SeriesInstanceUID FROM Series WHERE Modality = 'MR' ORDER BY 1;", true);
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(out)));
    return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}
// AND THE EXTENSION'S VERSION (2026-10-15): a new version may make something the old one did not (the diffusion job's
// MD/AD/RD maps), so a database is looked at again when the pinned commit changed, even with the same MR series.
// (The core's job records its rules' number, not a commit: a rebuild alone does not make it look at every MR study again.)
async function unchangedSince(path: string, j: JobEntry): Promise<boolean> {
  const e = (await readMarker(path))[j.extension];
  if (!e) return false;
  const now = await mrStamp(path);
  return !!now && e.mr === now && (e.pinned ?? "") === (j.version ?? "");
}
async function remember(path: string, j: JobEntry, stamp: string): Promise<void> {
  if (!stamp) return;
  // What else the entry holds (the scans that failed, written by the job) is kept.
  await updateMarker(path, j.extension, (e) => ({ ...e, mr: stamp, pinned: j.version ?? "", at: new Date().toISOString() }));
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // HELD BY THE PAGE (finding 3): a window about to track on the card; wait, then go on.
      while (Date.now() < heldUntil) await new Promise((r) => setTimeout(r, 2000));
      const db = queue.shift()!;
      status.queued = [...queue];
      // NOTHING HERE MAY TAKE THE SERVER DOWN (finding 2): a job that cannot start is said in the log and skipped.
      try {
        const path = (await listDatabases()).find((d) => d.id === db)?.path;
        const onlySweep = sweepOnly.has(db);
        sweepOnly.delete(db);
        for (const j of [...coreJobs(), ...jobEntries()]) {
          if (onlySweep && path && await unchangedSince(path, j)) continue;
          const why = await notPinned(j);
          if (why) { if (status.why !== `${j.extension}: ${why}`) appendSessionLog(`import-time work (${j.extension}) not run: ${why}`); status.why = `${j.extension}: ${why}`; continue; }
          const stamp = path ? await mrStamp(path) : "";   // AS THE RUN BEGINS (finding 11)
          again.delete(db);
          const ok = await runOne(j, db);
          if (ok && path && !again.has(db)) await remember(path, j, stamp);
        }
      } catch (e) {
        appendSessionLog(`import-time work on database ${db} did not run (${(e as Error).name})`);
      }
      if (again.has(db)) { again.delete(db); queue.push(db); status.queued = [...queue]; }
    }
  } finally { running = false; }
}

/** The command line of one run (the one thing that changes when the job moves into the app). `--parent`: the job stops
 *  when this server's process is gone (finding 10: it ran on after a quit, holding the lock). */
function command(j: JobEntry, db: string, core: string): Deno.Command | undefined {
  const deno = findDeno();
  if (!deno) return undefined;
  return new Deno.Command(deno, {
    args: ["run", "-A", "--unstable-webgpu", "--config", config, j.file, "--server", origin, "--db", db, "--counts-only", "--only-missing", "--parent", String(Deno.pid), "--core-version", core],
    stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" },
  });
}

/** One run: true when it ended with nothing left to do that a later start could do -- exit 0 and no case waiting. A case
 *  "waiting" may wait for a T1 (whose import starts a run) or for a segmentation server that was stuck (which no import
 *  fixes): such a database is looked at again at the next start (2026-10-14 night: the first catch-up met a stuck
 *  haversack, and the main database would have been remembered with all five scans waiting). */
async function runOne(j: JobEntry, db: string): Promise<boolean> {
  const cmd = command(j, db, await gitState(dirname(config)));
  if (!cmd) { status.available = false; status.why = "Deno is no longer on this Mac"; return false; }
  const st: RunState = { extension: j.extension, label: j.label, db, cases: 0, made: 0, current: 0, waiting: 0, cannot: 0, failed: 0, startedAt: Date.now() };
  status.running = st;
  let reason = "";
  let code = -1;
  try {
    child = cmd.spawn();
    const ch = child;
    const limit = setTimeout(() => { try { ch.kill("SIGTERM"); } catch { /* ended */ } reason = "stopped after six hours"; }, RUN_LIMIT_MS);
    // stderr is drained so the child never blocks on it; it is not logged (it may name files).
    void ch.stderr.pipeTo(new WritableStream()).catch(() => {});
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of ch.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === "plan" && typeof ev.studies === "number") st.studies = ev.studies;
        // A REASON IN ONE FIXED WORD (finding 14): the job's counts-only "stopped" event names the step, never a value.
        if (ev.event === "error" && typeof ev.stopped === "string") reason = ev.stopped;
        if (ev.event === "case") {
          st.cases++;
          const s = String(ev.state ?? "");
          if (s === "made") st.made++; else if (s === "current" || s === "kept") st.current++; else if (s === "waiting") st.waiting++;
          else if (s === "cannot") st.cannot++; else if (s === "failed") st.failed++;
        }
      }
    }
    code = (await ch.status).code;
    clearTimeout(limit);
  } catch (e) {
    reason = `it could not be started (${(e as Error).name})`;
  } finally {
    child = undefined;
    status.running = undefined;
  }
  if (code === 3) reason ||= "another run held this database";
  const secs = Math.round((Date.now() - st.startedAt) / 1000);
  const said = st.cases || !reason
    ? `${st.made} made, ${st.current} already there, ${st.waiting} waiting, ${st.cannot} cannot be made here, ${st.failed} failed, in ${secs} s${code > 0 ? ` (exit ${code}${reason ? `: ${reason}` : ""})` : ""}`
    : `stopped before any case: ${reason}${code >= 0 ? ` (exit ${code})` : ""}, after ${secs} s`;
  status.last = { ...st, endedAt: Date.now(), exit: code, said };
  // ONE LINE A RUN, and only when it did something or did not end well: a sweep that found everything there says nothing.
  if (st.made || st.failed || st.waiting || code !== 0) appendSessionLog(`import-time work (${j.extension}) on database ${db}: ${said}`);
  return code === 0 && !st.waiting;
}

/** Stop a run under way (the server is going). */
export function stopJobs(): void { try { child?.kill("SIGTERM"); } catch { /* ended */ } }

export function handleJobsRequest(req: Request): Response | null {
  const url = new URL(req.url);
  if (url.pathname === "/_jobs/hold" && req.method === "POST") {
    heldUntil = Math.max(heldUntil, Date.now() + 120_000);
    return Response.json({ heldUntil, running: !!status.running }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname !== "/_jobs") return null;
  // A segmentation-server restart that stopped someone's work rides along, so the top bar can say so (haversack-proxy.ts).
  // `held`: the page asked for the graphics card; a job running then starts no next case until it is false.
  const restarted = restartNotice();
  const body = { ...status, held: Date.now() < heldUntil };
  return Response.json(restarted ? { ...body, serverRestart: restarted } : body, { headers: { "cache-control": "no-store" } });
}

/** For tests: the state, read only. */
export const jobsStatus = (): Readonly<Status> => status;
