// Albula's own SQLite (desktop/sqlite.ts): the cases the critic found on 2026-10-13
// (Contents/docs/qa/2026-10-13-sqlite-in-server.md in the workspace), each as a test.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { DatabaseSync } from "node:sqlite";
import { realDbPath, runScript, splitScript, sqliteScript, writeUnderWay } from "./sqlite.ts";

const tmpDb = async () => join(await Deno.makeTempDir(), "t.sqlite");

Deno.test("sqlite: comments and empty statements are skipped, as the program skips them (finding 5)", () => {
  assertEquals(runScript(":memory:", "select 1; -- done"), "1\n");
  assertEquals(runScript(":memory:", "select 1;\n/* end */"), "1\n");
  assertEquals(runScript(":memory:", "-- only a comment"), "");
  assertEquals(runScript(":memory:", "select 1;; select 2;"), "1\n2\n");
  assertEquals(runScript(":memory:", "-- note\n.mode json\nselect 1 as a;"), '[{"a":1}]\n');
  assertEquals(runScript(":memory:", "select 1; -- c\n.mode json\nselect 2 as b;"), '1\n[{"b":2}]\n');
});

Deno.test("sqlite: CASE … END inside a trigger does not end the trigger (finding 5)", () => {
  const out = runScript(":memory:", `
    CREATE TABLE t(x INTEGER, y TEXT);
    CREATE TRIGGER tr AFTER INSERT ON t BEGIN
      UPDATE t SET y = CASE WHEN NEW.x > 1 THEN 'big' ELSE 'small' END WHERE rowid = NEW.rowid;
    END;
    INSERT INTO t(x) VALUES (2);
    SELECT y FROM t;`);
  assertEquals(out, "big\n");
  assertEquals(splitScript("CREATE TABLE end2(x); SELECT x AS begin1 FROM end2;").length, 2);
});

Deno.test("sqlite: exact big integers; binary values and same-named json columns refuse (finding 4)", () => {
  assertEquals(runScript(":memory:", "select 9007199254740993;"), "9007199254740993\n");
  assertEquals(runScript(":memory:", ".mode json\nselect 9007199254740993 as n;"), '[{"n":9007199254740993}]\n');
  assertThrows(() => runScript(":memory:", "select x'00ff41';"), Error, "binary");
  assertEquals(runScript(":memory:", "select 1 as a, 2 as a;"), "1|2\n");
  assertThrows(() => runScript(":memory:", ".mode json\nselect 1 as a, 2 as a;"), Error, "share a name");
  assertEquals(runScript(":memory:", ".mode json\nselect 1 as a union all select 2;"), '[{"a":1},\n{"a":2}]\n');
});

Deno.test("sqlite: foreign keys off and double-quoted strings accepted, as in the program (finding 4)", () => {
  assertEquals(runScript(":memory:", "PRAGMA foreign_keys;"), "0\n");
  assertEquals(runScript(":memory:", 'select "abc";'), "abc\n");
});

Deno.test("sqlite: an unknown dot-command and a failed open both say Error (finding 11)", async () => {
  assertThrows(() => runScript(":memory:", ".mode tabs\nselect 1;"), Error, "not supported");
  await assertRejects(() => sqliteScript("/nonexistent-folder-xyz/t.sqlite", "select 1;", true), Error, "Error: ");
});

Deno.test("sqlite: a file locked by another connection is waited for in a SQLite thread, WITHOUT stopping the event loop (finding 1)", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE t(x); INSERT INTO t VALUES (1);");
  const holder = new DatabaseSync(f);
  holder.exec("BEGIN EXCLUSIVE");
  let ticks = 0, longest = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; ticks++; }, 10);
  setTimeout(() => { holder.exec("COMMIT"); holder.close(); }, 600);
  const t0 = performance.now();
  const out = await sqliteScript(f, ".timeout 5000\nSELECT COUNT(*) FROM t;", true);
  clearInterval(timer);
  assertEquals(out, "1\n");
  assert(performance.now() - t0 >= 550, "it waited for the lock");
  assert(longest < 300, `the event loop paused for ${longest.toFixed(0)} ms`);
  assert(ticks > 20);
});

Deno.test("sqlite: a lock that outlasts the timeout fails with 'database is locked'", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE t(x);");
  const holder = new DatabaseSync(f);
  holder.exec("BEGIN EXCLUSIVE");
  try { await assertRejects(() => sqliteScript(f, ".timeout 200\nSELECT COUNT(*) FROM t;", true), Error, "locked"); }
  finally { holder.exec("COMMIT"); holder.close(); }
});

Deno.test("sqlite: a write inside a transaction that meets a lock waits for it and lands once", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE t(x);");
  const holder = new DatabaseSync(f);
  holder.exec("BEGIN EXCLUSIVE");
  setTimeout(() => { holder.exec("COMMIT"); holder.close(); }, 300);
  await sqliteScript(f, ".timeout 5000\nBEGIN;\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);\nCOMMIT;", false);
  assertEquals(runScript(f, "SELECT COUNT(*) FROM t;"), "2\n");
});

Deno.test("sqlite: a database reached through a symbolic link opens, and a new one is made through it (Deno 2.9.7 refuses links)", async () => {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "real"));
  await Deno.symlink(join(root, "real"), join(root, "linked"));
  const viaLink = join(root, "linked", "t.sqlite");
  runScript(viaLink, "CREATE TABLE t(x); INSERT INTO t VALUES (7);");          // made through the link
  assert(await Deno.stat(join(root, "real", "t.sqlite")).then(() => true, () => false), "the file is in the real folder");
  assertEquals(await sqliteScript(viaLink, "SELECT x FROM t;", true), "7\n");     // read through the link
});

Deno.test("sqlite: a file ATTACHed through a link is reached by its real path (Deno 2.9.7 refuses /var/… in ATTACH)", async () => {
  const root = await Deno.makeTempDir();        // under /var/folders on macOS: itself a link to /private/var
  const other = join(root, "other.sqlite");
  runScript(other, "CREATE TABLE t(x); INSERT INTO t VALUES (3);");
  assertEquals(runScript(join(root, "main.sqlite"), `ATTACH '${realDbPath(other)}' AS o; SELECT x FROM o.t;`), "3\n");
});

Deno.test("sqlite: a writer that died mid-transaction is recovered by the next read (finding 8)", async () => {
  const f = await tmpDb();
  runScript(f, "PRAGMA journal_mode=DELETE; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
  // A separate process opens a write transaction, writes, and exits without committing: a hot journal stays.
  const code = `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(${JSON.stringify(f)}); d.exec("PRAGMA cache_size=1; BEGIN; INSERT INTO t SELECT x+1 FROM t;"); for (let i = 0; i < 2000; i++) d.exec("INSERT INTO t VALUES (randomblob(2000))"); Deno.exit(0);`;
  const p = await new Deno.Command(Deno.execPath(), { args: ["eval", code], stdout: "null", stderr: "piped" }).output();
  assert(p.success, new TextDecoder().decode(p.stderr));
  const journal = await Deno.stat(f + "-journal").then((s) => s.size).catch(() => 0);
  assert(journal > 0, "the dead writer left its journal");
  assertEquals(await sqliteScript(f, "SELECT COUNT(*) FROM t;", true), "1\n");
  assertEquals(await Deno.stat(f + "-journal").then(() => true).catch(() => false), false, "the journal was rolled back");
});

// ---- round 2 (qa/2026-10-13-sqlite-in-server-round2.md): another PROGRAM holding the file ---------------------------------

/** Another process: holds a write lock for `ms`, or reads in a loop for `ms` (each read held `readMs`). Resolves when it ends. */
function otherProgram(file: string, kind: "write" | "read", ms: number, readMs = 0): { started: Promise<void>; done: Promise<void> } {
  const code = kind === "write"
    ? `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(${JSON.stringify(file)}); d.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (99)"); console.log("ready"); const t = Date.now() + ${ms}; while (Date.now() < t) {} d.exec("ROLLBACK"); d.close();`
    : `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(${JSON.stringify(file)}); d.exec("PRAGMA busy_timeout = 5000"); console.log("ready"); const sab = new Int32Array(new SharedArrayBuffer(4)); const end = Date.now() + ${ms}; while (Date.now() < end) { d.exec("BEGIN"); d.prepare("SELECT COUNT(*) FROM t").get(); Atomics.wait(sab, 0, 0, ${readMs}); d.exec("COMMIT"); Atomics.wait(sab, 0, 0, 2); } d.close();`;
  const child = new Deno.Command(Deno.execPath(), { args: ["eval", code], stdout: "piped", stderr: "inherit" }).spawn();
  const reader = child.stdout.getReader();
  const started = reader.read().then(() => { reader.releaseLock(); });
  return { started, done: child.status.then(() => { child.stdout.cancel().catch(() => {}); }) };
}

Deno.test("round 2, 1: a write that starts with CREATE … IF NOT EXISTS waits for another program's lock, then lands", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE t(x);");
  const other = otherProgram(f, "write", 800);
  await other.started;
  const t0 = performance.now();
  await sqliteScript(f, ".timeout 5000\nCREATE TABLE IF NOT EXISTS u(y);\nINSERT INTO t VALUES (1);\nINSERT INTO t VALUES (2);", false);
  await other.done;
  assert(performance.now() - t0 > 300, "it waited");
  assertEquals(runScript(f, "SELECT COUNT(*) FROM t;"), "2\n");
});

Deno.test("round 2, 2: a program that keeps reading does not starve a write", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE t(x); INSERT INTO t VALUES (0);");
  const other = otherProgram(f, "read", 3000, 300);
  await other.started;
  const t0 = performance.now();
  await sqliteScript(f, ".timeout 5000\nBEGIN IMMEDIATE;\nINSERT INTO t VALUES (1);\nCOMMIT;", false);
  const took = performance.now() - t0;
  await other.done;
  assert(took < 2000, `the write took ${took.toFixed(0)} ms`);
  assertEquals(runScript(f, "SELECT COUNT(*) FROM t;"), "2\n");
});

Deno.test("round 2, 5 and round 3, 4: busy means a write is under way -- not a leftover journal; a missing file is not made", async () => {
  const f = await tmpDb();
  assertEquals(writeUnderWay(f), false);
  assertEquals(await Deno.stat(f).then(() => true, () => false), false, "no empty database was made");
  runScript(f, "CREATE TABLE t(x);");
  await Deno.writeFile(f + "-journal", new Uint8Array(0));        // what TRUNCATE leaves between writes
  assertEquals(writeUnderWay(f), false);
  await Deno.writeFile(f + "-journal", new Uint8Array(4096));     // what PERSIST leaves: the header zeroed
  assertEquals(writeUnderWay(f), false);
  await Deno.remove(f + "-journal");
  const other = otherProgram(f, "write", 600);
  await other.started;
  assertEquals(writeUnderWay(f), true);
  await other.done;
  assertEquals(writeUnderWay(f), false);
});

Deno.test("round 2, 6: a comment that says 'trigger' does not make a BEGIN look like a trigger's", () => {
  assertEquals(splitScript("-- the trigger for this is the import\nBEGIN;\nSELECT 1;\nCOMMIT;").map((p) => p.text.replace(/^--.*\n/, "")), ["BEGIN;", "SELECT 1;", "COMMIT;"]);
});

Deno.test("round 4, 1: writes to one file land in the order they were sent", async () => {
  const f = await tmpDb();
  runScript(f, "CREATE TABLE kv(k TEXT PRIMARY KEY, v INTEGER);");
  const sends: Promise<string>[] = [];
  for (let i = 0; i < 100; i++) {
    sends.push(sqliteScript(f, `.timeout 5000\nINSERT OR REPLACE INTO kv VALUES ('a${i}', 1);`, false));
    sends.push(sqliteScript(f, `.timeout 5000\nINSERT OR REPLACE INTO kv VALUES ('a${i}', 2);`, false));
  }
  await Promise.all(sends);
  assertEquals(runScript(f, "SELECT COUNT(*) FROM kv WHERE v = 2;"), "100\n", "every second write is the one that stuck");
});
