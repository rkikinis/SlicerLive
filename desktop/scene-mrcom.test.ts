// A scene's DICOM object kept in step with its file (desktop/scene-mrcom.ts through desktop/scenes.ts): one object per
// scene, replaced by every save and rename, removed with the scene, tied to it by the series fact `sceneUID`, and left
// out of the copy sweep. A real database, a real CT imported the way Albula imports one.
//
//   deno test -A --no-check desktop/scene-mrcom.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { runScript } from "./sqlite.ts";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const dcmjs = (await import("../logic/dcmjs.ts")).default;
(await import("../logic/readers/dicom-series.ts")).setDcmjs(dcmjs);
const { makeCtSeries } = await import("../logic/test-dicom.ts");
const { createDatabase } = await import("./db-create.ts");
const { filesUnder, importFiles } = await import("./db-import.ts");
const { putScene, renameScene, deleteScene } = await import("./scenes.ts");
const { auditDatabase, provenancePathFor } = await import("./db-index.ts");
const { sweep } = await import("./duckn-sweep.ts");
const { mrcomToScene } = await import("../logic/scene/mrcom-scene.ts");
const { PROFILE_ID } = await import("../logic/scene/profile.ts");
const { dciodvfy } = await import("../logic/test-dicom.ts");
/** dciodvfy's errors that come from Steve's writer itself (upstream-issues-mrcom.md, 1); anything else is ours. */
const STEVES = [/Laterality/, /PatientOrientation/, /ReferencedSeriesSequence present but Instance does not reference/];

const sql = (file: string, q: string) => runScript(file, q, { readonly: true }).trim();

const src = await Deno.makeTempDir({ prefix: "albula-scene-mrcom-" });
const db = `${src}/Scene DB`;
await createDatabase(db, { name: "Scenes" });
const ct = await makeCtSeries(6, 6, 4, { extra: { PatientID: "PUB-1", PatientName: "PUBLIC^ONE", SeriesDescription: "CT" } });
await Deno.mkdir(`${src}/stick`);
for (const [i, x] of ct.instances.entries()) await Deno.writeFile(`${src}/stick/IM${i}`, new Uint8Array(x));
assertEquals((await importFiles(db, (await filesUnder(`${src}/stick`)).files)).series.length, 1);
const index = `${db}/ctkDICOM.sql`;
const sops = sql(index, `SELECT SOPInstanceUID FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' ORDER BY SOPInstanceUID;`).split("\n");

const doc = (v: number, name: string) => ({
  mrson: 0, extensionsUsed: [PROFILE_ID], source: { producer: "SlicerAlbula v0.1.0 Oct 29 08:55 da3b19b · diffusion@0.2.0 71374b7 and a little more", producedAt: "2026-10-29T12:00:00Z", origin: "w1" }, v, name,
  study: { studyInstanceUID: ct.studyInstanceUID }, studies: [ct.studyInstanceUID],
  nodes: { n1: { id: "n1", type: "image", dims: [6, 6, 4], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], dicom: { kind: "dicom-series", seriesInstanceUID: ct.seriesInstanceUID, studyInstanceUID: ct.studyInstanceUID, instances: sops, instanceCount: sops.length } } },
});
const objects = () => sql(index, "SELECT SeriesInstanceUID || '|' || COALESCE(SeriesDescription,'') FROM Series WHERE Modality='OT';").split("\n").filter(Boolean);
const tied = () => sql(provenancePathFor(db), "SELECT SeriesInstanceUID || '|' || Value FROM SeriesAttributes WHERE Key='sceneUID';").split("\n").filter(Boolean);

Deno.test("a save writes the scene's one DICOM object, a second save replaces it, a rename renames it, a delete removes it", async () => {
  const first = await putScene(db, "new", doc(1, "First name · with a dot that is two bytes, and long enough to pass sixty-four"));
  assert(!("error" in first), JSON.stringify(first));
  const uid = (first as { uid: string }).uid;
  assertEquals((first as { dicom?: { error?: string } }).dicom?.error, undefined);
  assertEquals(objects().length, 1);
  const [obj1] = objects()[0].split("|");
  assertEquals(tied(), [`${obj1}|${uid}`]);
  // The object is the scene: read back from the database's own file.
  const rel = sql(index, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${obj1}';`);
  const back = await mrcomToScene(await Deno.readFile(rel.startsWith("/") ? rel : `${db}/${rel}`));
  assertEquals(back?.name, "First name · with a dot that is two bytes, and long enough to pass sixty-four");
  assertEquals((back?.nodes as Record<string, { dicom: { instances: string[] } }>).n1.dicom.instances, sops);
  // The standard's own checker, when this Mac has it: no error of ours (a 67-character build stamp was, 2026-10-29).
  const v = dciodvfy(await Deno.readFile(rel.startsWith("/") ? rel : `${db}/${rel}`));
  if (v) assertEquals(v.errors.filter((e) => !STEVES.some((r) => r.test(e))), [], "dciodvfy: no error of ours");

  const second = await putScene(db, uid, doc(2, "First name · with a dot that is two bytes, and long enough to pass sixty-four"));
  assert(!("error" in second));
  assertEquals(objects().length, 1, "one object per scene: the old one went");
  const [obj2] = objects()[0].split("|");
  assert(obj2 !== obj1);
  assertEquals(tied(), [`${obj2}|${uid}`], "the old object's fact went with it");
  assertEquals((await Deno.stat(`${db}/${rel}`).then(() => true, () => false)), false, "the old file is gone");

  await renameScene(db, uid, "Second name");
  assertEquals(objects().length, 1);
  assert(objects()[0].endsWith("|Scene: Second name"), objects()[0]);

  assert(await deleteScene(db, uid));
  assertEquals(objects(), [], "deleted with its scene");
  assertEquals(tied(), []);
  const a = await auditDatabase(db);
  assert(a.ok, `no zombies, no orphans: ${JSON.stringify({ z: a.zombies, o: a.orphans })}`);
});

Deno.test("a series the extensions' state names (a tract set) is referenced by the scene's object", async () => {
  const t = await makeCtSeries(6, 6, 2, { extra: { PatientID: "PUB-1", PatientName: "PUBLIC^ONE", SeriesDescription: "named by an extension", StudyInstanceUID: ct.studyInstanceUID } });
  await Deno.mkdir(`${src}/stick2`);
  for (const [i, x] of t.instances.entries()) await Deno.writeFile(`${src}/stick2/IM${i}`, new Uint8Array(x));
  await importFiles(db, (await filesUnder(`${src}/stick2`)).files);
  const d = { ...doc(1, "With an extension"), extensionsUsed: [PROFILE_ID, "albula-diffusion/1"], extensions: { "albula-diffusion": { v: 1, state: { scans: [{ series: ct.seriesInstanceUID, tracts: t.seriesInstanceUID }] } } } };
  const r = await putScene(db, "new", d);
  assert(!("error" in r));
  const obj = objects().find((o) => o.endsWith("|Scene: With an extension"))!.split("|")[0];
  const rel = sql(index, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${obj}';`);
  // In the object's own DICOM references (ReferencedSeriesSequence): the scene inside is deflated, so a UID readable in the
  // raw bytes is in an attribute, not in the scene.
  const raw = new TextDecoder("latin1").decode(await Deno.readFile(rel.startsWith("/") ? rel : `${db}/${rel}`));
  assert(raw.includes(t.seriesInstanceUID), "the extension's series is among the object's references");
  for (const sop of sql(index, `SELECT SOPInstanceUID FROM Images WHERE SeriesInstanceUID='${t.seriesInstanceUID}';`).split("\n")) assert(raw.includes(sop), `its instance ${sop}`);
  await deleteScene(db, (r as { uid: string }).uid);
});

Deno.test("a version 1 scene gets no object (it names no instances); the copy sweep skips a scene object", async () => {
  const v1 = { ...doc(1, "Old form"), extensionsUsed: ["albula-scene/1"] };
  (v1.nodes.n1.dicom as Record<string, unknown>) = { seriesInstanceUID: ct.seriesInstanceUID, studyInstanceUID: ct.studyInstanceUID, sopInstanceUIDs: [sops[0]], instanceCount: sops.length };
  const r = await putScene(db, "new", v1);
  assert(!("error" in r));
  assertEquals(objects(), []);
  assert(/older scene form/.test((r as { dicom?: { error?: string } }).dicom?.error ?? ""), "said, not silent");
  const s = await putScene(db, "new", doc(1, "For the sweep"));
  assert(!("error" in s));
  assertEquals(objects().length, 1);
  const [obj] = objects()[0].split("|");
  const report = await sweep(db, { dryRun: true });
  const ids = (report as unknown as { entries: { seriesInstanceUID: string }[] }).entries.map((e) => e.seriesInstanceUID);
  assert(ids.includes(ct.seriesInstanceUID), "the CT is considered");
  assert(!ids.includes(obj), "the scene object is not");
  Deno.env.set("HOME", before.HOME ?? ""); if (before.SLICERLIVE_CONFIG_DIR) Deno.env.set("SLICERLIVE_CONFIG_DIR", before.SLICERLIVE_CONFIG_DIR); else Deno.env.delete("SLICERLIVE_CONFIG_DIR");
});
