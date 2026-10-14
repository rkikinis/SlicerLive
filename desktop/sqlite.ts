// SQLITE INSIDE THE SERVER, instead of the `sqlite3` command-line program (Ron, 2026-10-13: "why not do the deno move
// tonight?"; the cross-platform plan, Contents/docs/CROSS-PLATFORM-2026-10-13.md, step 1: Windows has no sqlite3, so
// without this no database can be made or filled there). Deno's built-in SQLite (`node:sqlite`; SQLite 3.53.4).
//
// THE SAME SCRIPTS. Every caller wrote a script for the program -- plain SQL plus a few of its own commands -- and read
// its printed output. `sqliteScript` takes those scripts unchanged:
//   .timeout N      how long to wait when another program holds the file, as the program waits
//   .mode json      each SELECT's rows as one JSON array, a row a line, as the program prints it
//   .mode list      (the default) values joined by "|", one row a line; NULL as nothing
//   .bail on        accepted; EVERY script stops at its first error here, and an open transaction is rolled back
// Any other dot-command is refused loudly rather than ignored.
//
// WHERE THE OUTPUT DIFFERS FROM THE PROGRAM'S (critic, 2026-10-13, finding 4), so no new caller relies on the program's
// exact form: JSON reads back as the same data but is not byte-identical (real numbers are printed by JavaScript:
// 1.0 as 1, 2.5e-07 as 2.5e-7). Integers of any size are exact. What would LOSE data is refused with an error instead:
// a binary (BLOB) value, and two result columns with the same name in json mode. Foreign keys are off and
// double-quoted strings are accepted, as in the program.
//
// IN A THREAD OF ITS OWN (critic, 2026-10-13, round 1 finding 1 and round 2 findings 1-2). SQLite waits for another
// program's lock by sleeping inside the call. On the server's own thread that froze the page's files, DICOM loads and
// the glasses' head poses for up to five seconds (round 1). Not letting SQLite wait, and trying again from the event
// loop, was worse (round 2): a write whose script began with `CREATE … IF NOT EXISTS` failed at once, and giving up the
// claim on the file let a program that keeps reading starve every write. So `sqliteScript` sends the script to a small
// pool of worker threads (below), and there SQLite waits exactly as the program did -- holding its place in line, so a
// writer gets its turn -- while the server's thread goes on serving. A write that reads first must say so at its start
// (BEGIN IMMEDIATE): SQLite will not wait for a transaction that began as a read and then wants to write (round 3,
// finding 1). A thread does not keep a program alive (tools end normally).
//
// AN INTERRUPTED WRITE (critic, round 1 finding 8). A writer that dies mid-transaction leaves a "hot" journal beside
// the file. SQLite puts the file back from it the next time someone opens it for writing; a read-only open cannot, and
// answers "attempt to write a readonly database" for ever. So a read-only script that meets one opens the file once
// for writing, which lets SQLite restore the last committed state, and runs again.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

type Mode = "list" | "json";
type Piece = { kind: "sql" | "dot"; text: string };

/** Split a script into SQL statements and dot-command lines, honoring quotes, comments and CREATE TRIGGER bodies.
 *  Pieces holding only comments are dropped, as the program drops them. */
export function splitScript(script: string): Piece[] {
  const out: Piece[] = [];
  let i = 0, start = 0, depth = 0, caseDepth = 0, meaningful = false, trigger = false;
  const n = script.length;
  const atLineStart = (k: number) => { let j = k - 1; while (j >= 0 && (script[j] === " " || script[j] === "\t")) j--; return j < 0 || script[j] === "\n"; };
  const flush = (end: number) => { const t = script.slice(start, end).trim(); if (t && meaningful) out.push({ kind: "sql", text: t }); meaningful = false; trigger = false; };
  while (i < n) {
    const c = script[i];
    // A dot-command: a line that begins with "." when no statement is under way (comments before it do not count).
    if (c === "." && !meaningful && atLineStart(i)) {
      let e = script.indexOf("\n", i); if (e < 0) e = n;
      out.push({ kind: "dot", text: script.slice(i, e).trim() });
      i = start = e + 1; continue;
    }
    if (c === "-" && script[i + 1] === "-") { while (i < n && script[i] !== "\n") i++; continue; }
    if (c === "/" && script[i + 1] === "*") { const e = script.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (!/\s/.test(c) && c !== ";") meaningful = true;
    if (c === "'" || c === '"' || c === "`") { const q = c; i++; while (i < n) { if (script[i] === q) { if (script[i + 1] === q) { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === "[") { while (i < n && script[i] !== "]") i++; i++; continue; }
    // CREATE TRIGGER … BEGIN … END; holds semicolons inside it, and CASE … END inside it closes a CASE, not the trigger.
    // The word TRIGGER counts only as a word of the statement, not inside a comment or a string (round 2, finding 6).
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_$]/.test(script[i - 1]))) {
      const w = /^[A-Za-z0-9_$]+/.exec(script.slice(i))![0];
      const u = w.toUpperCase();
      if (u === "TRIGGER") trigger = true;
      else if (u === "BEGIN" && trigger) depth++;
      else if (u === "CASE" && depth > 0) caseDepth++;
      else if (u === "END" && caseDepth > 0) caseDepth--;
      else if (u === "END" && depth > 0) depth--;
      i += w.length; continue;
    }
    if (c === ";" && depth === 0) { flush(i + 1); i = start = i + 1; continue; }
    i++;
  }
  flush(n);
  return out;
}

/** True when `s` holds nothing but whitespace, semicolons and comments. */
function onlyComments(s: string): boolean {
  return splitScript(s).length === 0;
}

function render(st: StatementSync, mode: Mode, rows: unknown[][]): string[] {
  const names = st.columns().map((c) => c.name);
  const value = (v: unknown, i: number): unknown => {
    if (v instanceof Uint8Array) throw new Error(`column "${names[i]}" holds a binary (BLOB) value, which Albula's SQLite does not print (desktop/sqlite.ts)`);
    return v;
  };
  if (mode === "json") {
    if (new Set(names).size !== names.length) throw new Error(`two result columns share a name (${names.join(", ")}); json mode would lose one -- give each its own AS name`);
    const cell = (v: unknown, i: number): string => {
      const x = value(v, i);
      if (x === null || x === undefined) return "null";
      if (typeof x === "bigint") return x.toString();
      return JSON.stringify(x);
    };
    return ["[" + rows.map((r) => "{" + r.map((v, i) => JSON.stringify(names[i]) + ":" + cell(v, i)).join(",") + "}").join(",\n") + "]"];
  }
  return rows.map((r) => r.map((v, i) => { const x = value(v, i); return x === null || x === undefined ? "" : String(x); }).join("|"));
}

/**
 * The file's real path, with every symbolic link resolved. Deno 2.9.7 opens SQLite files with SQLITE_OPEN_NOFOLLOW
 * (denoland/deno#36357) and refuses a path that goes through a link anywhere -- a database on another disk reached
 * through a link, say. The person chose that folder, so the link is followed here, once, before SQLite sees the path.
 * A file not made yet resolves through its folder. A file named in an ATTACH statement must be passed through this too:
 * Deno resolves macOS's own /var and /tmp links only for the file it opens, so `ATTACH '/var/…'` fails under 2.9.7.
 */
export function realDbPath(dbPath: string): string {
  if (dbPath === ":memory:" || dbPath === "") return dbPath;
  try { return Deno.realPathSync(dbPath); } catch { /* not made yet */ }
  const cut = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
  if (cut < 0) return dbPath;
  // A file at a drive's top level: "D:" alone means the current folder on drive D, so the folder is "D:\" (round 2, 4).
  let dir = dbPath.slice(0, cut);
  if (dir === "" || /^[A-Za-z]:$/.test(dir)) dir += dbPath[cut];
  try {
    const real = Deno.realPathSync(dir);
    return /[\\/]$/.test(real) ? real + dbPath.slice(cut + 1) : real + dbPath.slice(cut);
  } catch { return dbPath; }
}

/** One run of a script, on this thread, with SQLite's own wait for a busy file (the script's `.timeout`, as the program). */
function run(dbPath: string, script: string, readonly: boolean): string {
  let mode: Mode = "list";
  const printed: string[] = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(realDbPath(dbPath), { readOnly: readonly, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true });
    for (const part of splitScript(script)) {
      if (part.kind === "dot") {
        const [cmd, arg = ""] = part.text.split(/\s+/, 2);
        if (cmd === ".timeout") db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(arg) || 0))}`);
        else if (cmd === ".mode" && (arg === "json" || arg === "list")) mode = arg;
        else if (cmd === ".bail") { /* always on here */ }
        else throw new Error(`the sqlite3 command "${part.text}" is not supported by Albula's own SQLite (desktop/sqlite.ts)`);
        continue;
      }
      const st = db.prepare(part.text);
      // One piece, one statement: prepare() compiles the first and silently ignores the rest (round 1, finding 5).
      if (!onlyComments(part.text.slice(st.sourceSQL.length))) throw new Error(`more than one statement in one piece of the script: ${part.text.slice(0, 80)}`);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      const rows = st.all() as unknown as unknown[][];
      if (rows.length) printed.push(...render(st, mode, rows));
    }
  } catch (e) {
    try { if (db?.isTransaction) db.exec("ROLLBACK"); } catch { /* already gone */ }
    const msg = (e as Error).message;
    throw new Error(msg.startsWith("Error: ") ? msg : `Error: ${msg}`);
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
  return printed.length ? printed.join("\n") + "\n" : "";
}

/**
 * Let SQLite put back the last committed state after a writer died mid-transaction: open the file for writing once
 * and read from it. False when the file cannot be opened for writing (a read-only disk) or is held by a writer.
 */
export function recoverInterruptedWrite(dbPath: string): boolean {
  try { run(dbPath, "SELECT COUNT(*) FROM sqlite_master;", false); return true; } catch { return false; }
}

/** A rollback journal in use has a header (its first 28 bytes) that is not all zeros: a random number and sizes from the
 *  start of the write, the marker added when it commits. A journal kept between writes has that header zeroed (PERSIST)
 *  or is empty (TRUNCATE); a finished DELETE-mode write leaves none. */
function liveJournal(dbPath: string): boolean {
  let f: Deno.FsFile | undefined;
  try {
    f = Deno.openSync(dbPath + "-journal", { read: true });
    const b = new Uint8Array(28);
    return f.readSync(b) === 28 && b.some((x) => x !== 0);
  } catch { return false; } finally { try { f?.close(); } catch { /* closed */ } }
}

/**
 * Whether a write is under way on the file: a journal in use lies beside it. A writer that DIED leaves one too, so SQLite
 * is first given the chance to put the file back (a read on a write-capable open, without waiting; when it does
 * put a dead writer's state back, SQLite takes the file for that moment), and only a journal still in use afterwards
 * counts. It does not take the write lock to ask: a probe that did made another program's write fail now and then
 * (round 3, finding 4). What it cannot see -- a writer that has not written a page yet, or one in WAL or EXCLUSIVE mode
 * -- the write itself meets, waits for, and reports (round 4, finding 2). A missing file is not busy and is not made.
 */
export function writeUnderWay(dbPath: string): boolean {
  try { Deno.statSync(dbPath); } catch { return false; }
  const real = realDbPath(dbPath);                                 // the journal lies beside the real file (round 4)
  if (!liveJournal(real)) return false;
  recoverInterruptedWrite(real);
  return liveJournal(real);
}

/** A run that puts back a dead writer's state first when a read-only open meets it. Used by the worker and the fallback. */
export function runRecovering(dbPath: string, script: string, readonly: boolean): string {
  try { return run(dbPath, script, readonly); }
  catch (e) {
    if (readonly && /attempt to write a readonly database/i.test((e as Error).message) && recoverInterruptedWrite(dbPath)) return run(dbPath, script, readonly);
    throw e;
  }
}

/**
 * Run a script written for the `sqlite3` program against `dbPath`, here and now, synchronously, waiting for a busy file
 * as the program did. For places where holding this thread is harmless: a file this process has just made, tools,
 * tests. The server uses `sqliteScript`.
 */
export function runScript(dbPath: string, script: string, opts: { readonly?: boolean } = {}): string {
  return run(dbPath, script, !!opts.readonly);
}

// ---- the worker threads ---------------------------------------------------------------------------------------------
//
// A small pool, started as needed: each script goes to a thread that is free, or waits for one. Scripts to different
// files run side by side; SQLite's own locking keeps Albula's threads and other programs apart, and
// Albula's own writes to an index already go one at a time (withIndexLock). ONE SCRIPT AT A TIME PER FILE, in the
// order they were sent: two writes to one file must land in that order (a scene renamed twice, a member added then
// removed; round 4, finding 1), and a file another program has locked holds up one thread, not all four (round 3,
// finding 3; two locked files hold two). A pool rather than a thread per file: starting a thread costs about 20 ms, and
// the delete's sibling check reads every database beside this one -- in the tests, hundreds (a thread per file made one
// delete take 5.6 s).

type Job = { id: number; dbPath: string; key: string; script: string; readonly: boolean; resolve: (s: string) => void; reject: (e: Error) => void };
type Slot = { w: Worker; job?: Job; answered: boolean };
const POOL = 4;
const slots: Slot[] = [];
const queue: Job[] = [];
let nextId = 1, workersFailed = false;

/** Run a job here, on this thread: when no thread can be started or the worker file is missing from a build. */
function runHere(job: Job) {
  try { job.resolve(runRecovering(job.dbPath, job.script, job.readonly)); } catch (e) { job.reject(e as Error); }
}

function lose(slot: Slot, why: string) {
  const k = slots.indexOf(slot);
  if (k < 0) return;
  slots.splice(k, 1);
  const job = slot.job;
  slot.job = undefined;
  if (!slot.answered) {
    // It never answered anything: the thread could not start (a build without sqlite-worker.ts, say), so its job never
    // ran. From now on scripts run on this thread (round 3, finding 5). Threads already at work are NOT stopped -- their
    // scripts are running and finish by themselves; stopping them and running their jobs again here wrote twice
    // (round 4, finding 3).
    if (!workersFailed) console.warn(`Albula's SQLite thread could not start (${why}); queries run on the server's own thread`);
    workersFailed = true;
    if (job) queue.unshift(job);
    dispatch();
    return;
  }
  job?.reject(new Error(`Error: Albula's SQLite thread stopped (${why})`));
  dispatch();
}

function startSlot(): Slot {
  const w = new Worker(new URL("./sqlite-worker.ts", import.meta.url));
  const slot: Slot = { w, answered: false };
  w.on("message", (m: { id: number; out?: string; error?: string }) => {
    slot.answered = true;
    const job = slot.job;
    slot.job = undefined;
    if (job && job.id === m.id) m.error !== undefined ? job.reject(new Error(m.error)) : job.resolve(m.out ?? "");
    dispatch();
  });
  w.on("error", (e: Error) => lose(slot, e.message));
  // A thread that ends without an error must not leave its request waiting for ever (round 3, finding 6).
  w.on("exit", (code: number) => lose(slot, `it ended, code ${code}`));
  w.unref();
  slots.push(slot);
  return slot;
}

function dispatch() {
  const busyKeys = new Set(slots.filter((s) => s.job).map((s) => s.job!.key));
  for (let k = 0; k < queue.length;) {
    const job = queue[k];
    // One at a time per file, in order: a later script for this file waits for the earlier one.
    if (busyKeys.has(job.key)) { k++; continue; }
    if (workersFailed) { queue.splice(k, 1); runHere(job); continue; }
    let slot = slots.find((s) => !s.job);
    if (!slot && slots.length < POOL) slot = startSlot();
    if (!slot) break;
    queue.splice(k, 1);
    slot.job = job;
    busyKeys.add(job.key);
    slot.w.postMessage({ id: job.id, dbPath: job.dbPath, script: job.script, readonly: job.readonly });
  }
  // A thread with nothing to do does not keep a program alive; one with work does.
  for (const s of slots) s.job ? s.w.ref() : s.w.unref();
}

/**
 * Run a script against `dbPath` in one of the SQLite threads, so a wait for another program's lock never holds the
 * server's thread. If no thread can be started, the script runs here, as before.
 */
export function sqliteScript(dbPath: string, script: string, readonly = true): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const job: Job = { id: nextId++, dbPath, key: realDbPath(dbPath), script, readonly, resolve, reject };
    if (dbPath === ":memory:") { runHere(job); return; }
    queue.push(job);
    try { dispatch(); }
    catch (e) {
      if (!workersFailed) console.warn(`Albula's SQLite thread could not start (${(e as Error).message}); queries run on the server's own thread`);
      workersFailed = true;
      dispatch();
    }
  });
}
