// Opening a packaged scene in one step, and taking in a whole database (desktop/package-open.ts, the routes in
// db-serve.ts; Ron, 2026-10-13, mockups/albula-import-2026-10-13.html). A real package is made the way Albula makes one
// (a database, two series, a scene, packageScene), then opened on "another machine": a fresh home folder.
//
//   deno test -A --no-check desktop/package-open.test.ts
import { DatabaseSync } from "node:sqlite";
import { runScript } from "./sqlite.ts";
import { assert, assertEquals } from "jsr:@std/assert";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
// Put back by the last test: the test runner runs every file in one process (db-create-routes.test.ts says why).
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const dcmjs = (await import("../logic/dcmjs.ts")).default;
(await import("../logic/readers/dicom-series.ts")).setDcmjs(dcmjs);
const { makeCtSeries } = await import("../logic/test-dicom.ts");
const { handleDbRequest } = await import("./db-serve.ts");
const { resolveSettingsPath, writeSettings } = await import("./settings-file.ts");
const { remember } = await import("./choose-folder.ts");
const { createDatabase } = await import("./db-create.ts");
const { filesUnder, importFiles } = await import("./db-import.ts");
const { packageScene, putScene, mergeProvenance } = await import("./scenes.ts");
const { provenancePathFor } = await import("./db-index.ts");
const { PROFILE_ID } = await import("../logic/scene/profile.ts");

const gallery = `${home}/app/src/live`;
await Deno.mkdir(gallery, { recursive: true });
await writeSettings(resolveSettingsPath(gallery), "[Database]\n");
const call = async (method: string, path: string, body?: unknown) => {
  const r = await handleDbRequest(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), gallery);
  return { status: r!.status, j: await r!.json().catch(() => ({})) as Record<string, unknown> };
};
const sql = async (file: string, q: string) => runScript(file, q, { readonly: true }).trim();
const waitImport = async (job: string) => {
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", `/_db/_import/${job}`);
    if (r.j.error) throw new Error(String(r.j.error));
    if (r.j.result) return r.j.result as { series: unknown[]; failed: unknown[] };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("the import did not finish");
};

/** The machine the package is made on: a database (outside "SlicerAlbulaDatabases"), two series, a scene naming both. */
async function makePackage(): Promise<{ pkg: string; sceneUid: string; series: string[] }> {
  const src = await Deno.makeTempDir({ prefix: "albula-origin-" });
  const db = `${src}/Origin DB`;
  await createDatabase(db, { name: "Origin" });
  const a = await makeCtSeries(6, 6, 4, { extra: { PatientID: "PUB-1", PatientName: "PUBLIC^ONE", SeriesDescription: "CT" } });
  const b = await makeCtSeries(6, 6, 3, { extra: { PatientID: "PUB-1", PatientName: "PUBLIC^ONE", SeriesDescription: "CT 2", StudyInstanceUID: a.studyInstanceUID } });
  const stick = `${src}/stick`;
  await Deno.mkdir(stick);
  for (const [i, x] of [...a.instances, ...b.instances].entries()) await Deno.writeFile(`${stick}/IM${i}`, new Uint8Array(x));
  const r = await importFiles(db, (await filesUnder(stick)).files);
  assertEquals(r.series.length, 2);
  const node = (id: string, s: { seriesInstanceUID: string; studyInstanceUID: string }) =>
    ({ id, type: "image", dims: [6, 6, 4], ijkToRAS: Array(16).fill(0), dicom: { seriesInstanceUID: s.seriesInstanceUID, studyInstanceUID: s.studyInstanceUID, sopInstanceUIDs: [`${s.seriesInstanceUID}.1`], instanceCount: 1 } });
  const put = await putScene(db, "new", {
    mrson: 0, extensionsUsed: [PROFILE_ID], v: 1, name: "Two CTs",
    source: { producer: "test", producedAt: "2026-10-13T10:00:00Z", origin: "w1" },
    study: { studyInstanceUID: a.studyInstanceUID },
    nodes: { n1: node("n1", a), n2: node("n2", { ...b, studyInstanceUID: a.studyInstanceUID }) },
  });
  assert(!("error" in put), JSON.stringify(put));
  // Public, as a collection from IDC is: its collection and license are on record.
  await mergeProvenance(provenancePathFor(db), { attributes: [
    { uid: a.seriesInstanceUID, key: "collection", value: "test_collection", source: "idc" },
    { uid: a.seriesInstanceUID, key: "license", value: "CC BY 4.0", source: "idc" },
  ] });
  const out = await Deno.makeTempDir({ prefix: "albula-out-" });
  const pk = await packageScene(db, put.uid, out) as { path: string };
  return { pkg: pk.path, sceneUid: put.uid, series: [a.seriesInstanceUID, b.seriesInstanceUID] };
}

Deno.test("a package is described before anything is added: its series, files, public record, and that no database holds it", async () => {
  const { pkg, sceneUid } = await makePackage();
  const r = await call("POST", "/_db/_package/inspect", { token: remember(pkg).token });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(r.j.kind, "package");
  assertEquals(r.j.sceneUid, sceneUid);
  assertEquals(r.j.sceneSeries, 2);
  assertEquals(r.j.files, 7);
  assertEquals(r.j.patientID, "PUB-1");
  assertEquals(r.j.public, true);
  assertEquals(r.j.license, "CC BY 4.0");
  assertEquals(r.j.missingSeries, []);
  assertEquals(r.j.databases, []);
});

Deno.test("one step: a new database in SlicerAlbulaDatabases, the scans MOVED in from the package's dicom/, the scene imported", async () => {
  const { pkg, sceneUid, series } = await makePackage();
  const token = remember(pkg).token;
  const c = await call("POST", "/_db/_create", { name: "Test Data", patientData: false, source: "test_collection, CC BY 4.0" });
  assertEquals(c.status, 200, JSON.stringify(c.j));
  assertEquals(c.j.path, `${home}/SlicerAlbulaDatabases/Test Data`);
  const id = String(c.j.id);
  const s = await call("POST", `/_db/${id}/_import`, { token, sub: "dicom", move: true });
  assertEquals(s.status, 200, JSON.stringify(s.j));
  const res = await waitImport(String(s.j.job));
  assertEquals(res.series.length, 2);
  assertEquals((await filesUnder(`${pkg}/dicom`)).files.length, 0, "moved, not copied");
  const scene = JSON.parse(await Deno.readTextFile(`${pkg}/scene.mrson.json`));
  const provenance = JSON.parse(await Deno.readTextFile(`${pkg}/provenance.json`));
  const si = await call("POST", `/_db/${id}/_scene/_import`, { scene, provenance });
  assertEquals(si.status, 200, JSON.stringify(si.j));
  assertEquals(si.j.uid, sceneUid);
  // The database now holds both series and the scene, and says so to a second look.
  const again = await call("POST", "/_db/_package/inspect", { scene, provenance });
  const here = (again.j.databases as { id: string; series: number; sceneV: number | null }[]).find((d) => d.id === id)!;
  assertEquals(here.series, 2); assertEquals(here.sceneV, 1);
  assertEquals(await sql(`${home}/SlicerAlbulaDatabases/Test Data/ctkDICOM.sql`, `select count(*) from Series where SeriesInstanceUID in ('${series.join("','")}');`), "2");
});

Deno.test("a package lying inside the database's folder is added (it was refused on 2026-10-13); the database's own files are not", async () => {
  const { pkg } = await makePackage();
  const c = await call("POST", "/_db/_create", { name: "Inside" });
  const dbPath = String(c.j.path), id = String(c.j.id);
  const moved = `${dbPath}/incoming/${pkg.split("/").pop()}`;
  await Deno.mkdir(`${dbPath}/incoming`, { recursive: true });
  await Deno.rename(pkg, moved);
  const s = await call("POST", `/_db/${id}/_import`, { token: remember(moved).token, sub: "dicom" });
  assertEquals(s.status, 200, JSON.stringify(s.j));
  assertEquals((await waitImport(String(s.j.job))).series.length, 2);
  for (const own of [dbPath, `${dbPath}/dicom`]) {
    const r = await call("POST", `/_db/${id}/_import`, { token: remember(own).token });
    assertEquals(r.status, 400, own);
  }
});

Deno.test("a whole database is moved into SlicerAlbulaDatabases with its scene and records, and listed", async () => {
  const { pkg } = await makePackage();
  // An existing database elsewhere, with a scene and a record in the store beside it.
  const old = `${home}/elsewhere/My Cases`;
  await createDatabase(old, { name: "My Cases" });
  const scene = JSON.parse(await Deno.readTextFile(`${pkg}/scene.mrson.json`));
  const r = await importFiles(old, (await filesUnder(`${pkg}/dicom`)).files);
  assertEquals(r.series.length, 2);
  const put = await putScene(old, "new", { ...scene, uid: undefined, v: 1 });
  assert(!("error" in put), JSON.stringify(put));
  await mergeProvenance(provenancePathFor(old), JSON.parse(await Deno.readTextFile(`${pkg}/provenance.json`)));
  const look = await call("POST", "/_db/_package/inspect", { token: remember(old).token });
  assertEquals(look.j.kind, "database");
  assertEquals(look.j.inParent, false);
  const a = await call("POST", "/_db/_adopt", { token: remember(old).token, move: true });
  assertEquals(a.status, 200, JSON.stringify(a.j));
  const now = String(a.j.path);
  assertEquals(now, `${home}/SlicerAlbulaDatabases/My Cases`);
  assert(!(await Deno.stat(old).then(() => true, () => false)), "moved away");
  const prov = provenancePathFor(now);
  assertEquals(await sql(prov, `select count(*) from Scenes where uid = '${put.uid}';`), "1", "the scene's row follows");
  assert(await Deno.stat(`${now}/${await sql(prov, `select path from Scenes where uid = '${put.uid}';`)}`).then(() => true, () => false), "and names its file there");
  assertEquals(await sql(prov, "select value from SeriesAttributes where key = 'license' limit 1;"), "CC BY 4.0");
  const list = (await call("GET", "/_db")).j.databases as { id: string; path: string }[];
  assert(list.some((d) => d.path === now));
  // Asked again: it is in the list already.
  const twice = await call("POST", "/_db/_package/inspect", { token: remember(now).token });
  assertEquals(twice.j.registeredAs, "My Cases");
});

Deno.test("a copy leaves the original where it was", async () => {
  const old = `${home}/elsewhere/Copy Me`;
  await createDatabase(old, { name: "Copy Me" });
  const a = await call("POST", "/_db/_adopt", { token: remember(old).token, move: false });
  assertEquals(a.status, 200, JSON.stringify(a.j));
  assert(await Deno.stat(`${old}/ctkDICOM.sql`).then(() => true, () => false));
  assert(await Deno.stat(`${String(a.j.path)}/ctkDICOM.sql`).then(() => true, () => false));
});

Deno.test("critic A1: a move the database refuses leaves the originals where they were, and nothing half-added", async () => {
  const { pkg } = await makePackage();
  const db = `${home}/elsewhere/Busy`;
  await createDatabase(db, { name: "Busy" });
  // Another program in the middle of a write: it holds the write lock and its journal lies beside the index.
  const writer = new DatabaseSync(`${db}/ctkDICOM.sql`);
  writer.exec("BEGIN IMMEDIATE; CREATE TABLE another_programs_work (x);");
  const files = (await filesUnder(`${pkg}/dicom`)).files;
  // Refused -- as a failed series, or before anything is touched with the indexer's own words.
  let refusedWith = "";
  try { const r = await importFiles(db, files, { move: true }); assertEquals(r.series.length, 0); refusedWith = r.failed[0]?.error ?? ""; }
  catch (e) { refusedWith = (e as Error).message; }
  assert(/open by another program/.test(refusedWith), refusedWith);
  assertEquals((await filesUnder(`${pkg}/dicom`)).files.length, files.length, "every original still in the package");
  writer.exec("ROLLBACK"); writer.close();
  const again = await importFiles(db, files, { move: true });
  assertEquals(again.series.length, 2, "and a second try, with the database free, takes them");
  assertEquals((await filesUnder(`${pkg}/dicom`)).files.length, 0, "moved: the originals go once the database has them");
  // The process's own values back, for the files that run after this one.
  for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
});
