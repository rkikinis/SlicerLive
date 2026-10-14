// ONE OF ALBULA'S SQLITE THREADS (desktop/sqlite.ts, "In a thread of its own" and the pool). Scripts arrive one at a
// time, for any database file, and run here with SQLite's own wait for a busy file, so the wait never holds the
// server's thread.
import { parentPort } from "node:worker_threads";
import { runRecovering } from "./sqlite.ts";

parentPort!.on("message", (m: { id: number; dbPath: string; script: string; readonly: boolean }) => {
  try { parentPort!.postMessage({ id: m.id, out: runRecovering(m.dbPath, m.script, m.readonly) }); }
  catch (e) { parentPort!.postMessage({ id: m.id, error: (e as Error).message }); }
});
