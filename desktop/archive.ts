// THE ARCHIVE'S GUARD AND THE TRASH (Ron, 2026-10-28: "park the original data in an archive and then be aggressive about
// the working db"; the plan: Contents/docs/ARCHIVE-AND-REBUILD-PLAN-2026-10-29.md, Plan 1, part 1, written after its
// critic found that the first plan listed archive files but nothing stopped the app from deleting them).
//
// Two rules, for every file the app removes from a database folder:
//   1. A file the database's archive lists is never removed by the app's ordinary paths (Delete, the editor's removal of
//      an earlier copy, a move between databases, the BIDS tool's replace): they all end in `deleteSeriesLocked`
//      (db-index.ts), which asks `refuseArchived` first and changes nothing when it refuses.
//   2. What is removed goes to the Trash, so a mistake can be put back (Put Back in the Finder): macOS's own
//      `/usr/bin/trash`, 0.41 s for 700 files (measured 2026-10-29; a 2,665-file series in 2.1 s, the critic). Where
//      there is none (another system), and for a database in the system's temporary folder (the tests', so a test run
//      never fills the person's Trash), into a folder `.SlicerAlbula-Trash/<date> <database>/` BESIDE the database
//      folder -- not inside it, where the audit would count its DICOM files as orphans. Nothing empties that folder:
//      on another system it is the person's to empty, like a Trash (DATABASE-LAYOUT.md).
//      Putting files back does not put a series back in the index: they are then added again like any files.
//
// THE ARCHIVE'S LIST: `SlicerAlbula-Archive/manifest.jsonl` in the database folder, one JSON entry per line, only ever
// added to. An entry `{op: "add", path, ...}` lists a file (its path as the index writes it, relative to the database);
// a later `{op: "remove", path, ...}` takes it off (the explicit "Remove from the archive" step, built later). Nothing
// What fills it today: the records below (RECORD_FILES), listed at the server's start and at their first save; the
// scene objects a scene's own save replaces. The rest (received scans, edited segmentations) is a later step of the plan.
import { dirname, basename } from "jsr:@std/path@1";

export const ARCHIVE_FOLDER = "SlicerAlbula-Archive";
export const MANIFEST = "manifest.jsonl";
/** Beside the database folder (the fallback Trash): `<parent>/.SlicerAlbula-Trash/`. */
export const FALLBACK_TRASH = ".SlicerAlbula-Trash";

export interface ArchiveEntry {
  op: "add" | "remove";
  /** As the index's Filename column writes it: relative to the database folder. */
  path: string;
  sha256?: string; bytes?: number;
  /** received, person, run-log, kept-ai, scene */
  kind?: string; source?: string; added?: string; note?: string;
}

export const manifestPath = (dbDir: string) => `${dbDir}/${ARCHIVE_FOLDER}/${MANIFEST}`;

/** A path as the list and the guard compare it: relative to the database, with no "./", no doubled or trailing "/";
 *  an absolute path under the database folder made relative. Anything else (a file outside the folder) as it is. */
export function normalizePath(dbDir: string, path: string): string {
  let p = path.replace(/\\/g, "/");
  if (p.startsWith(dbDir + "/")) p = p.slice(dbDir.length + 1);
  if (p.startsWith("/")) return p.replace(/\/{2,}/g, "/");
  return p.split("/").filter((x) => x && x !== ".").join("/");
}

/** The paths the archive lists now: the manifest replayed, adds then removes, in order. A missing list is an empty one.
 *  A line that is not an entry (not JSON, an `op` other than "add" or "remove", no text `path`) is an error: a list read
 *  wrongly would let the guard pass what it should stop (the critic, 2026-10-29, finding 10). */
export async function archivedPaths(dbDir: string): Promise<Set<string>> {
  let text: string;
  try { text = await Deno.readTextFile(manifestPath(dbDir)); } catch (e) { if (e instanceof Deno.errors.NotFound) return new Set(); throw e; }
  const out = new Set<string>();
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    const bad = () => new Error(`the archive's list (${manifestPath(dbDir)}) cannot be read at line ${i + 1}; nothing was removed`);
    let e: ArchiveEntry;
    try { e = JSON.parse(line); } catch { throw bad(); }
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.path !== "string" || !e.path || (e.op !== "add" && e.op !== "remove")) throw bad();
    const p = normalizePath(dbDir, e.path);
    if (e.op === "add") out.add(p); else out.delete(p);
  }
  return out;
}

/** Add entries to the list (the only writer of it: appended, never rewritten). */
export async function appendManifest(dbDir: string, entries: ArchiveEntry[]): Promise<void> {
  if (!entries.length) return;
  await Deno.mkdir(`${dbDir}/${ARCHIVE_FOLDER}`, { recursive: true });
  await Deno.writeTextFile(manifestPath(dbDir), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { append: true });
}

/** Which of these paths the archive lists (normalized, as the index writes them). */
export async function archivedAmong(dbDir: string, paths: string[]): Promise<string[]> {
  const listed = await archivedPaths(dbDir);
  if (!listed.size) return [];
  return paths.filter((p) => listed.has(normalizePath(dbDir, p)));
}

/** The error a refused removal raises: the caller shows its message as it is. */
export class ArchiveRefusal extends Error {
  constructor(readonly paths: string[], what?: string) {
    super(`${what ? `${what[0].toUpperCase()}${what.slice(1)} is` : "This is"} in the database's archive (original data, or what a person made), so it is kept: ${paths.length === 1 ? "one file" : `${paths.length} files`} of it ${paths.length === 1 ? "is" : "are"} listed there. Nothing was removed.`);
    this.name = "ArchiveRefusal";
  }
}

/** Throws `ArchiveRefusal` when any of these index paths is in the archive; returns quietly otherwise. `what` names the
 *  thing for the message ("the series CT ABDOMEN", "the scene Prisma brain"). */
export async function refuseArchived(dbDir: string, paths: string[], what?: string): Promise<void> {
  const hit = await archivedAmong(dbDir, paths);
  if (hit.length) throw new ArchiveRefusal(hit, what);
}

const SYSTEM_TRASH = "/usr/bin/trash";
/** Under the system's temporary folder (where tests make their databases)? */
function inTemp(path: string): boolean {
  const roots = [Deno.env.get("TMPDIR"), "/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"].filter(Boolean) as string[];
  return roots.some((r) => path.startsWith(r.endsWith("/") ? r : r + "/"));
}
async function systemTrash(): Promise<boolean> {
  if (Deno.build.os !== "darwin" || Deno.env.get("ALBULA_TRASH") === "folder") return false;
  return await Deno.stat(SYSTEM_TRASH).then((s) => s.isFile, () => false);
}

export interface TrashResult { trashed: string[]; failed: string[]; where: "system" | "folder" }

/**
 * Move these files (absolute paths) to the Trash. Returns which went and which did not; a path that is still there
 * afterwards counts as failed, whatever the command said. `dbDir` names the database, for the fallback folder.
 */
export async function toTrash(dbDir: string, paths: string[]): Promise<TrashResult> {
  const trashed: string[] = [], failed: string[] = [];
  if (!paths.length) return { trashed, failed, where: "system" };
  const useSystem = !inTemp(dbDir) && await systemTrash();
  if (useSystem) {
    for (let i = 0; i < paths.length; i += 200) {          // well under the command line's length limit
      const part = paths.slice(i, i + 200);
      // A time limit: the caller may hold the database's index lock (the critic, finding 13). 200 files take well under
      // a second; a minute means something is wrong, and what did not go is reported as failed below.
      await new Deno.Command(SYSTEM_TRASH, { args: part, stdout: "null", stderr: "piped", signal: AbortSignal.timeout(60_000) }).output().catch(() => null);
      for (const p of part) (await Deno.lstat(p).then(() => true, () => false) ? failed : trashed).push(p);
    }
    return { trashed, failed, where: "system" };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const into = `${dirname(dbDir)}/${FALLBACK_TRASH}/${stamp} ${basename(dbDir)}`;
  for (const p of paths) {
    const rel = p.startsWith(dbDir + "/") ? p.slice(dbDir.length + 1) : basename(p);
    const dest = `${into}/${rel}`;
    try { await Deno.mkdir(dirname(dest), { recursive: true }); await Deno.rename(p, dest); trashed.push(p); }
    catch { failed.push(p); }
  }
  return { trashed, failed, where: "folder" };
}

// THE RECORDS A PERSON MADE, AND THE RUN LOGS, kept where their writers put them and listed (the plan, Plan 1, part 3:
// "the tract review's borders go in first among the records", the only person-made data lost so far, on 2026-10-26).
// Their own writer updates them in place: through the write route, the version replaced goes to the Trash first, so a
// wrong save can be put back (Ron, 2026-10-29: "only the final version"; the Trash: "the empty button, which does
// everything"). The logs are appended to by the server itself. Nothing else may remove them.
export const RECORD_FILES = [
  "SlicerAlbula-SEG/tract-review.json",       // the tract review: borders, levels, verdicts (albula-diffusion, review.ts)
  "albula-database.json",                     // the database's description (Describe…)
  "albula-record.jsonl",                      // what came in and went out (transfers)
  "SlicerAlbula-Logs/diffusion-runs.jsonl",   // the run log of the diffusion jobs
] as const;
export const isRecordFile = (dbDir: string, path: string) => (RECORD_FILES as readonly string[]).includes(normalizePath(dbDir, path));

/** List the record files this database has and the archive does not list yet. Returns what it added. Off with
 *  ALBULA_ARCHIVE_LISTING=off (Contents/tools/headless-server.ts: a server for checks writes nothing into a database). */
export async function listRecordFiles(dbDir: string): Promise<string[]> {
  if (Deno.env.get("ALBULA_ARCHIVE_LISTING") === "off") return [];
  const listed = await archivedPaths(dbDir);
  const add: ArchiveEntry[] = [];
  const at = new Date().toISOString();
  for (const rel of RECORD_FILES) {
    if (listed.has(rel)) continue;
    if (!(await Deno.stat(`${dbDir}/${rel}`).then((x) => x.isFile, () => false))) continue;
    add.push({ op: "add", path: rel, kind: rel.endsWith("diffusion-runs.jsonl") ? "run-log" : rel === "albula-record.jsonl" ? "record" : "person", added: at, note: "a record, kept where its writer puts it" });
  }
  await appendManifest(dbDir, add);
  return add.map((e) => e.path);
}

/** Before a record's writer replaces it: a dated copy of the version replaced goes to the Trash (listed or not yet:
 *  the critic, 2026-10-29, records finding 5). Its name carries the time and a few random letters, so two saves in one
 *  millisecond do not collide (finding 1). Put Back returns it under that name. */
export async function trashPreviousVersion(dbDir: string, rel: string): Promise<void> {
  const abs = `${dbDir}/${normalizePath(dbDir, rel)}`;
  if (!(await Deno.stat(abs).then((x) => x.isFile, () => false))) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-") + " " + crypto.randomUUID().slice(0, 6);
  const copy = `${abs.replace(/(\.[^./]+)$/, "")} (replaced ${stamp})${/(\.[^./]+)$/.exec(abs)?.[1] ?? ""}`;
  await Deno.copyFile(abs, copy);
  const r = await toTrash(dbDir, [copy]);
  if (r.failed.length) { await Deno.remove(copy).catch(() => {}); throw new Error(`the version of ${rel} being replaced could not be put in the Trash; nothing was written`); }
}

/** One writer at a time per record file in this server (two windows, or a paired Mac's requests, reach the same server):
 *  the Trash copy, the write and the listing of one save finish before the next save of that file starts. */
const recordLocks = new Map<string, Promise<unknown>>();
export async function withRecordLock<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const before = recordLocks.get(abs) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = before.then(() => mine);
  recordLocks.set(abs, chain);
  await before.catch(() => {});
  try { return await fn(); }
  finally { release(); if (recordLocks.get(abs) === chain) recordLocks.delete(abs); }
}
