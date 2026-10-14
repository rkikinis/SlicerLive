// The database routes the page calls (desktop/db-serve.ts): create, register, describe, view a chosen folder.
// Each test pins one of the critic's findings of 2026-10-01 (Contents/docs/qa/2026-10-01-database-import.md).
//
//   deno test -A --no-check desktop/db-create-routes.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { testData } from "../test/test-data.ts";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
// The process's own values, put back by the last test below: the test runner runs every file in ONE process, and a HOME
// left pointing at a temporary folder sent later tests' `deno info` to an empty cache there (2026-10-12: the duckn
// copy-code test, run after this file, computed another fingerprint and the rebuild refused to build).
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const { handleDbRequest } = await import("./db-serve.ts");
const { resolveSettingsPath, writeSettings } = await import("./settings-file.ts");
const { remember } = await import("./choose-folder.ts");
const { createDatabase, icloudWarning } = await import("./db-create.ts");

const gallery = `${home}/app/src/live`;
await Deno.mkdir(gallery, { recursive: true });
await writeSettings(resolveSettingsPath(gallery), "[Database]\n");

const call = async (method: string, path: string, body?: unknown) => {
  const r = await handleDbRequest(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), gallery);
  return { status: r!.status, j: await r!.json().catch(() => ({})) as Record<string, unknown> };
};

Deno.test("a new database goes to SlicerAlbulaDatabases in the home folder, registered and described", async () => {
  const r = await call("POST", "/_db/_create", { name: "Teaching cases", holds: "public", patientData: false });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(r.j.path, `${home}/SlicerAlbulaDatabases/Teaching cases`);
  const list = (await call("GET", "/_db")).j.databases as { id: string; description?: { name: string } }[];
  assert(list.some((d) => d.id === "teaching-cases" && d.description?.name === "Teaching cases"));
});

// WHAT THE PAGE ASKS INSTEAD OF DOWNLOADING THE INDEX (desktop/db-listing.ts; critic 2026-10-14, page asks the server).
Deno.test("the listing routes: a list never cached, a clear answer for an unknown, a missing or a bad request", async () => {
  const r = await handleDbRequest(new Request("http://x/_db/teaching-cases/_series"), gallery);
  assertEquals(r!.status, 200);
  assertEquals(r!.headers.get("cache-control"), "no-store");
  assertEquals(await r!.json(), { series: [], patients: 0, studies: 0 });
  assertEquals((await call("GET", "/_db/no-such-database/_series")).status, 404);
  assertEquals((await call("GET", "/_db/teaching-cases/_files")).status, 400);
  assertEquals((await call("GET", "/_db/teaching-cases/_files?series=1.2.3")).j, { files: [] });
  assertEquals((await call("PUT", "/_db", { id: "gone", path: `${home}/not-there-any-more` })).status, 200);
  const gone = await call("GET", "/_db/gone/_series");
  assertEquals(gone.status, 404);
  assert(String(gone.j.error).includes("not where it was registered"), String(gone.j.error));
});

Deno.test("an unknown database is refused as the current one, not replaced by another (critic 2026-10-14)", async () => {
  const before = ((await call("GET", "/_db")).j.databases as { id: string; current?: boolean }[]).find((d) => d.current)?.id;
  const r = await call("PUT", "/_db", { current: "no-such-database" });
  assertEquals(r.status, 404);
  const after = ((await call("GET", "/_db")).j.databases as { id: string; current?: boolean }[]).find((d) => d.current)?.id;
  assertEquals(after, before);
});

// THE DIFFUSION SAMPLE (Sample Data › Brain with DTI; 2026-10-14), from the local copy of the dataset laid out as the
// bucket (ALBULA_TEST_CASES_SOURCE), into a database of its own made the first time; pressed again, found there.
const localDs001226 = testData("openneuro-ds001226");
Deno.test({ name: "the diffusion sample: its own database, three series, and no download the second time", ignore: !localDs001226 || !(() => { try { return Deno.statSync(`${localDs001226}/sub-CON03`).isDirectory; } catch { return false; } })(), fn: async () => {
  const was = Deno.env.get("ALBULA_TEST_CASES_SOURCE");
  Deno.env.set("ALBULA_TEST_CASES_SOURCE", localDs001226!);
  try {
    const press = async () => {
      const r = await call("POST", "/_db/_dti-sample", {});
      assertEquals(r.status, 200, JSON.stringify(r.j));
      for (let i = 0; i < 300; i++) {
        const j = (await call("GET", `/_db/_dti-sample/${r.j.job}`)).j as { done?: boolean; error?: string; result?: { series: { role: string }[] } };
        if (j.done) return { id: r.j.id as string, j };
        await new Promise((ok) => setTimeout(ok, 100));
      }
      throw new Error("the sample never finished");
    };
    const first = await press();
    assertEquals(first.j.error, undefined);
    assertEquals(first.j.result?.series.map((x) => x.role).sort(), ["T1w", "dwi-AP", "dwi-PA"]);
    const list = (await call("GET", "/_db")).j.databases as { id: string; path: string; description?: { name?: string; patientData?: boolean } }[];
    const db = list.find((d) => d.id === first.id)!;
    assertEquals(db.path, `${home}/SlicerAlbulaDatabases/Sample data`);
    assertEquals(db.description?.patientData, false);
    const t = performance.now();
    const second = await press();
    assertEquals(second.id, first.id, "the same database");
    assertEquals(second.j.result?.series.length, 3);
    assert(performance.now() - t < 2000, "found there, not fetched again");
  } finally { was === undefined ? Deno.env.delete("ALBULA_TEST_CASES_SOURCE") : Deno.env.set("ALBULA_TEST_CASES_SOURCE", was); }
} });

Deno.test("finding 6: patient data that is not a clear yes or no is refused, not stored as no", async () => {
  for (const v of ["yes", 1, "on", "TRUE"]) {
    const r = await call("POST", "/_db/_create", { name: `PD ${String(v)}`, patientData: v });
    assertEquals(r.status, 400, String(v));
  }
});

Deno.test("finding 3: registering keeps an existing description file, even one the checker rejects", async () => {
  const dir = `${home}/elsewhere/Research`;
  await createDatabase(dir, { name: "Research" });
  const original = JSON.stringify({ name: "Research", approval: "IRB 2026-123", contact: "the office", holds: "x".repeat(1200) });
  await Deno.writeTextFile(`${dir}/albula-database.json`, original);
  const r = await call("POST", "/_db/_register", { token: remember(dir).token });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(await Deno.readTextFile(`${dir}/albula-database.json`), original);
  assert(String(r.j.warning).includes("left as it is"));
  const again = await call("POST", "/_db/_register", { token: remember(dir).token });
  assertEquals(again.status, 409);
  assertEquals(await Deno.readTextFile(`${dir}/albula-database.json`), original);
});

Deno.test("finding 10: no new database inside a folder that holds one, or inside a registered one", async () => {
  const outer = `${home}/SlicerAlbulaDatabases/Teaching cases`;   // made and registered above
  const r = await call("POST", "/_db/_create", { name: "Inner", token: remember(outer).token });
  assertEquals(r.status, 400);
  await Deno.mkdir(`${outer}/sub`, { recursive: true });
  const r2 = await call("POST", "/_db/_create", { name: "Inner", token: remember(`${outer}/sub`).token });
  assertEquals(r2.status, 400);
});

Deno.test("finding 13: the folder viewer does not follow a link out of the chosen folder", async () => {
  const chosen = `${home}/stick`, outside = `${home}/private`;
  await Deno.mkdir(chosen, { recursive: true }); await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(`${outside}/secret.txt`, "no");
  await Deno.writeTextFile(`${chosen}/a.txt`, "yes");
  await Deno.symlink(outside, `${chosen}/link`);
  const t = remember(chosen).token;
  assertEquals((await call("GET", `/_db/_folder/${t}/a.txt`)).status, 200);
  assertEquals((await call("GET", `/_db/_folder/${t}/link/secret.txt`)).status, 403);
  assertEquals((await call("GET", `/_db/_folder/${t}/%E0%A4%A`)).status, 400, "a malformed escape is a 400, not a crash");
  const list = (await call("GET", `/_db/_folder/${t}/_list`)).j as { files: string[]; left: { reason: string }[] };
  assertEquals(list.files, ["a.txt"]);
  assert(list.left.some((l) => /link/.test(l.reason)));
});

Deno.test("finding 14: a description is written only where a database is", async () => {
  await call("PUT", "/_db", { id: "nowhere", path: `${home}/empty` });
  await Deno.mkdir(`${home}/empty`, { recursive: true });
  const r = await call("PUT", "/_db/nowhere/_description", { name: "x" });
  assertEquals(r.status, 404);
  assert(!(await Deno.stat(`${home}/empty/albula-database.json`).then(() => true, () => false)));
});

Deno.test("finding 7: folders that cloud services copy off the Mac are warned about", () => {
  for (const p of [`${home}/Desktop/db`, `${home}/Documents/db`, `${home}/Library/Mobile Documents/com~apple~CloudDocs/db`,
    `${home}/Library/CloudStorage/Dropbox/db`, `${home}/Library/CloudStorage/OneDrive-Personal/db`, `/System/Volumes/Data${home}/Desktop/db`]) {
    assert(icloudWarning(p), p);
  }
  assertEquals(icloudWarning(`${home}/SlicerAlbulaDatabases/db`), undefined);
});

Deno.test("start fresh (transfer window): the old database keeps its folder under an archive name; the new one of the same name gets its own folder and opens by default", async () => {
  const a = await call("POST", "/_db/_create", { name: "Working", holds: "where I work" });
  assertEquals(a.status, 200, JSON.stringify(a.j));
  // The window's order (transfer-window.ts startFresh): the new one first, then the old one renamed (critic, finding 19).
  const b = await call("POST", "/_db/_create", { name: "Working", holds: "where I work" });
  assertEquals(b.status, 200, JSON.stringify(b.j));
  const renamed = await call("PUT", `/_db/${a.j.id}/_description`, { name: "Working, archive 2026-10-02", holds: "where I work" });
  assertEquals(renamed.status, 200, JSON.stringify(renamed.j));
  assertEquals(b.j.path, `${home}/SlicerAlbulaDatabases/Working 2`, "a folder of that name is there already");
  assert(b.j.id !== a.j.id);
  await call("PUT", "/_db", { current: b.j.id });
  const list = (await call("GET", "/_db")).j.databases as { id: string; current: boolean; path: string; description?: { name: string } }[];
  assertEquals(list.find((d) => d.id === a.j.id)?.description?.name, "Working, archive 2026-10-02");
  assertEquals(list.find((d) => d.id === a.j.id)?.path, `${home}/SlicerAlbulaDatabases/Working`);
  assert(list.find((d) => d.id === b.j.id)?.current);
});

Deno.test("transfer route: two different databases and something chosen, or a plain refusal", async () => {
  const x = await call("POST", "/_db/_create", { name: "Transfer A" }), y = await call("POST", "/_db/_create", { name: "Transfer B" });
  assertEquals((await call("POST", "/_db/_transfer", { from: x.j.id, to: x.j.id, series: ["1.2.3"] })).status, 400, "the same database");
  assertEquals((await call("POST", "/_db/_transfer", { from: x.j.id, to: y.j.id, series: [] })).status, 400, "nothing chosen");
  assertEquals((await call("POST", "/_db/_transfer", { from: x.j.id, to: "no-such", series: ["1.2.3"] })).status, 404);
  assertEquals((await call("GET", `/_db/${x.j.id}/_record`)).j.entries, []);
  assertEquals((await call("POST", "/_db/_transfer/00000000-0000-0000-0000-000000000000/_remove")).status, 404);
});

Deno.test("transfer finding 1: one database folder is not registered a second time under another name", async () => {
  const made = await call("POST", "/_db/_create", { name: "Linked once" });
  assertEquals(made.status, 200);
  const link = `${home}/a link to the databases`;
  await Deno.symlink(`${home}/SlicerAlbulaDatabases`, link);
  const { token } = remember(`${link}/Linked once`);
  assertEquals((await call("POST", "/_db/_register", { token })).status, 409);
  assertEquals((await call("PUT", "/_db", { id: "other-name", path: `${link}/Linked once` })).status, 409);
  const w = await call("GET", "/_db/_transfer");
  assertEquals(w.j.waiting, [], "no move waiting");
});

Deno.test("(the process's HOME and settings folder put back for the files after this one)", () => {
  for (const [k, v] of Object.entries(before)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  assertEquals(Deno.env.get("HOME"), before.HOME);
});
