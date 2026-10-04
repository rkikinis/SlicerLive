// Transfer between databases (desktop/db-transfer.ts): copy, check, carry, record; a move's removal; the shared store.
// The second half pins the critic's findings of 2026-10-02 (Contents/docs/qa/2026-10-02-database-transfer.md).
//
//   deno test -A --no-check desktop/db-transfer.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import dcmjs from "../logic/dcmjs.ts";
import { setDcmjs } from "../logic/readers/dicom-series.ts";
import { makeCtSeries } from "../logic/test-dicom.ts";
import { PROFILE_ID } from "../logic/scene/profile.ts";
import { createDatabase } from "./db-create.ts";
import { importFiles } from "./db-import.ts";
import { auditDatabase, heldBySibling, provenanceEdges, provenancePathFor, recordProvenanceEdge, setSeriesAttribute } from "./db-index.ts";
import { deleteScene, listScenes, putScene } from "./scenes.ts";
import { readRecord, removeTransferred, sameBytes, transferSeries, type TransferSide } from "./db-transfer.ts";

setDcmjs(dcmjs);

const made: string[] = [];
globalThis.addEventListener("unload", () => { for (const d of made) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });
const tmp = async (prefix: string) => { const d = await Deno.realPath(await Deno.makeTempDir({ prefix })); made.push(d); return d; };

async function sql(db: string, text: string): Promise<string> {
  const { stdout, code, stderr } = await new Deno.Command("/usr/bin/sqlite3", { args: ["-readonly", db, text] }).output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).trim();
}
const images = (dir: string, where = "1") => sql(`${dir}/ctkDICOM.sql`, `SELECT COUNT(*) FROM Images WHERE ${where}`).then(Number);

/** A database holding one patient: a scan and a "segmentation" made from it (an edge), in one study. */
async function project(dir: string, name: string, n = 4) {
  await createDatabase(dir, { name, patientData: true });
  const ct = await makeCtSeries(8, 8, n, { extra: { SeriesDescription: "T1 with contrast", PatientName: "TEST^TRANSFER", PatientID: "TR-1" } });
  const seg = await makeCtSeries(8, 8, 2, { extra: { SeriesDescription: "Tumor outline", PatientName: "TEST^TRANSFER", PatientID: "TR-1", StudyInstanceUID: ct.studyInstanceUID } });
  const stick = await tmp("albula-stick-");
  const files: string[] = [];
  for (const [k, s] of [ct, seg].entries()) for (const [i, x] of s.instances.entries()) { const f = `${stick}/${k}-${i}.dcm`; await Deno.writeFile(f, new Uint8Array(x)); files.push(f); }
  const r = await importFiles(dir, files);
  assertEquals(r.series.length, 2);
  await recordProvenanceEdge(dir, seg.seriesInstanceUID, { parentSeriesUID: ct.seriesInstanceUID, kind: "algorithm", label: "tumor" });
  await setSeriesAttribute(provenancePathFor(dir), ct.seriesInstanceUID, "collection", "Test collection");
  return { ct, seg };
}
const side = (id: string, path: string): TransferSide => ({ id, path, name: id });
const scene = (study: string, series: string, name = "planning") => ({
  mrson: 0, extensionsUsed: [PROFILE_ID], v: 1, name,
  source: { producer: "test", producedAt: "2026-10-02T09:00:00Z", origin: "w1" },
  study: { studyInstanceUID: study },
  nodes: { n2: { id: "n2", type: "image", dims: [2, 2, 2], ijkToRAS: Array(16).fill(0), dicom: { seriesInstanceUID: series, studyInstanceUID: study, sopInstanceUIDs: ["1.2.3.9.1"], instanceCount: 4 } } },
});

Deno.test("a copy into a database with its own store: every image identical, the edge and attribute carried, both records written; again adds nothing", async () => {
  const a = `${await tmp("albula-p-")}/Project`, b = `${await tmp("albula-w-")}/My work`;
  const { ct, seg } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const uids = [ct.seriesInstanceUID, seg.seriesInstanceUID];
  const r = await transferSeries(side("project", a), side("work", b), uids, { by: "test" });
  assertEquals(r.added, 2);
  assertEquals(r.instances, 6);
  assertEquals(r.identical.sort(), [...uids].sort());
  assertEquals(r.differ, []);
  assertEquals(r.failed, []);
  assertEquals(r.edges, 1, "the outline's edge to its scan");
  assertEquals(r.attributes, 1);
  assertEquals(await images(b), 6);
  assert((await auditDatabase(b)).ok);
  assertEquals(await images(a), 6, "a copy leaves the first database as it was");
  const edges = await provenanceEdges(provenancePathFor(b));
  assertEquals(edges.map((e) => [e.child, e.parent, e.kind]), [[seg.seriesInstanceUID, ct.seriesInstanceUID, "algorithm"]]);
  const inB = await readRecord(b), inA = await readRecord(a);
  assertEquals(inB.map((e) => e.what), ["copied in"]); assertEquals(inA.map((e) => e.what), ["copied out"]);
  assertEquals(inB[0].patients, [{ id: "TR-1", name: "TEST^TRANSFER" }]);
  assertEquals(inB[0].series.length, 2);
  assertEquals(inB[0].checked, "all 2 scans arrived whole and identical");
  assertEquals(inB[0].from.path, a);

  const again = await transferSeries(side("project", a), side("work", b), uids);
  assertEquals(again.added, 0, "nothing is held twice");
  assertEquals(again.already, 6);
  assertEquals(again.identical.length, 2);
  assertEquals(again.edges, 0);
  assertEquals(await images(b), 6);
  await assertRejects(() => transferSeries(side("project", a), side("project", a), uids), Error, "the same database");
});

Deno.test("a move between two databases in one folder: removed from the first only after the check, the shared edges survive; the records say copied, then moved", async () => {
  const parent = await tmp("albula-dbs-");
  const a = `${parent}/Project`, b = `${parent}/My work`;
  const { ct, seg } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const uids = [ct.seriesInstanceUID, seg.seriesInstanceUID];
  const r = await transferSeries(side("project", a), side("work", b), uids, { move: true });
  assertEquals(r.identical.length, 2);
  assertEquals(r.edges, 0, "one store: nothing to carry");
  assertEquals(await images(a), 6, "nothing leaves before the second step");
  assertEquals((await readRecord(a)).map((e) => e.what), ["copied out"], "finding 5: not 'moved' before anything moved");
  assert((await readRecord(a))[0].waiting);
  const filesA = (await sql(`${a}/ctkDICOM.sql`, "SELECT Filename FROM Images")).split("\n").map((f) => `${a}/${f}`);
  const gone = await removeTransferred(side("project", a), side("work", b), r);
  assertEquals([gone.series, gone.files, gone.kept, gone.outside], [2, 6, [], []]);
  assertEquals(await images(a), 0);
  for (const f of filesA) assert(!(await Deno.stat(f).then(() => true, () => false)), f);
  assertEquals(await images(b), 6);
  assert((await auditDatabase(a)).ok); assert((await auditDatabase(b)).ok);
  assertEquals((await provenanceEdges(provenancePathFor(b))).length, 1, "My work still knows the outline was made from the scan");
  assertEquals((await readRecord(a)).map((e) => e.what), ["moved out", "copied out"]);
  assertEquals((await readRecord(b)).map((e) => e.what), ["move finished", "copied in"], "one arrival, then its completion: not two moves");
});

Deno.test("an image the target holds with other bytes: that scan is not called identical, and a move does not remove it", async () => {
  const a = `${await tmp("albula-p-")}/Project`, b = `${await tmp("albula-w-")}/My work`;
  const { ct, seg } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const one = (await sql(`${a}/ctkDICOM.sql`, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' LIMIT 1`));
  const bytes = await Deno.readFile(`${a}/${one}`);
  const changed = bytes.slice(); changed[changed.length - 1] ^= 0xff;    // one pixel byte
  const f = `${await tmp("albula-x-")}/x.dcm`; await Deno.writeFile(f, changed);
  assertEquals((await importFiles(b, [f])).series.length, 1);
  assert(!(await sameBytes(`${a}/${one}`, f)));
  const r = await transferSeries(side("project", a), side("work", b), [ct.seriesInstanceUID, seg.seriesInstanceUID], { move: true });
  assertEquals(r.identical, [seg.seriesInstanceUID]);
  assertEquals(r.differ.length, 1);
  assertEquals(r.differ[0].uid, ct.seriesInstanceUID);
  assertEquals(r.differ[0].different, 1);
  assertEquals((await readRecord(b))[0].checked, "1 of 2 scans arrived whole and identical; 1 did not");
  const gone = await removeTransferred(side("project", a), side("work", b), r);
  assertEquals(gone.series, 1, "the outline only");
  assertEquals(await images(a, `SeriesInstanceUID='${ct.seriesInstanceUID}'`), 4, "the scan stays in Project");
});

// ---- the critic's findings, 2026-10-02 ----

Deno.test("finding 1: one folder under two names is one database: refused, and a move never deletes the only copy", async () => {
  const root = await tmp("albula-f1-");
  const a = `${root}/real/Project`;
  const { ct, seg } = await project(a, "Project");
  await Deno.symlink(`${root}/real`, `${root}/link`);
  const alias = `${root}/link/Project`;
  await assertRejects(() => transferSeries(side("p", a), side("p-2", alias), [ct.seriesInstanceUID, seg.seriesInstanceUID], { move: true }), Error, "the same database");
  // Even handed a result that claims identity, the removal refuses the same folder.
  const gone = await removeTransferred(side("p", a), side("p-2", alias), { identical: [ct.seriesInstanceUID], series: [{ uid: ct.seriesInstanceUID, description: "T1", study: "", patientID: "", patientName: "", modality: "CT", instances: 4 }] } as never);
  assertEquals(gone.series, 0);
  assertEquals(await images(a), 6);
});

Deno.test("finding 2: databases in one folder keep their own scenes; a transferred scene is a scene of its own", async () => {
  const parent = await tmp("albula-f2-");
  const a = `${parent}/Archive`, b = `${parent}/Fresh`;
  const { ct } = await project(a, "Archive");
  await createDatabase(b, { name: "Fresh" });
  const put = await putScene(a, "new", scene(ct.studyInstanceUID, ct.seriesInstanceUID));
  assert(!("error" in put), JSON.stringify(put));
  assertEquals((await listScenes(b)).length, 0, "the empty database beside it lists none of the archive's scenes");
  assertEquals(await deleteScene(b, put.uid), false, "and cannot delete them");
  assertEquals((await listScenes(a)).length, 1);
  const r = await transferSeries(side("a", a), side("b", b), [ct.seriesInstanceUID], { scenes: true });
  assertEquals(r.scenes, 1);
  const inB = await listScenes(b);
  assertEquals(inB.length, 1);
  assert(inB[0].uid !== put.uid, "its own uid in the shared store");
  assert(await deleteScene(b, inB[0].uid));
  assertEquals((await listScenes(a)).length, 1, "deleting the copy leaves the original");
});

Deno.test("finding 3: a moved scan takes the results made from it along; the link survives", async () => {
  const a = `${await tmp("albula-f3a-")}/Project`, b = `${await tmp("albula-f3b-")}/My work`;
  const { ct, seg } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const r = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID], { move: true });
  assertEquals(r.withTheirScans, 1);
  assertEquals(r.identical.sort(), [ct.seriesInstanceUID, seg.seriesInstanceUID].sort());
  await removeTransferred(side("p", a), side("w", b), r);
  assertEquals(await images(a), 0);
  assertEquals((await provenanceEdges(provenancePathFor(b))).map((e) => [e.child, e.parent]), [[seg.seriesInstanceUID, ct.seriesInstanceUID]]);
});

Deno.test("finding 6: a store that cannot be written is said; the images are in and both records written", async () => {
  const root = await tmp("albula-f6-");
  const a = `${root}/a/Project`, b = `${root}/b/My work`;
  const { ct } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  await Deno.writeTextFile(`${root}/b/provenance.sqlite`, "not a database");
  const r = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID]);
  assertEquals(r.identical, [ct.seriesInstanceUID]);
  assert(r.notes.some((n) => n.includes("could not be written")), JSON.stringify(r.notes));
  assertEquals((await readRecord(b)).length, 1); assertEquals((await readRecord(a)).length, 1);
});

Deno.test("finding 7: a scan that arrived in part is completed by transferring it again", async () => {
  const a = `${await tmp("albula-f7a-")}/Project`, b = `${await tmp("albula-f7b-")}/My work`;
  const { ct } = await project(a, "Project", 6);
  await createDatabase(b, { name: "My work" });
  const one = await sql(`${a}/ctkDICOM.sql`, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' LIMIT 1`);
  await Deno.chmod(`${a}/${one}`, 0o000);
  const r1 = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID]);
  assertEquals(r1.differ[0]?.missing, 1);
  assertEquals(await images(b), 5);
  await Deno.chmod(`${a}/${one}`, 0o644);
  const r2 = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID]);
  assertEquals(r2.identical, [ct.seriesInstanceUID]);
  assertEquals(await images(b), 6);
});

Deno.test("finding 10: a move takes the scenes of its scans out of the first database too", async () => {
  const a = `${await tmp("albula-f10a-")}/Project`, b = `${await tmp("albula-f10b-")}/My work`;
  const { ct, seg } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const put = await putScene(a, "new", scene(ct.studyInstanceUID, ct.seriesInstanceUID));
  assert(!("error" in put));
  const r = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID, seg.seriesInstanceUID], { move: true, scenes: true });
  assertEquals(r.scenes, 1);
  const gone = await removeTransferred(side("p", a), side("w", b), r);
  assertEquals(gone.scenes, 1);
  assertEquals((await listScenes(a)).length, 0);
  assertEquals((await listScenes(b)).length, 1);
});

Deno.test("finding 11: the second press removes 100 scans in one delete, well inside the time budget", async () => {
  const a = `${await tmp("albula-f11a-")}/Project`, b = `${await tmp("albula-f11b-")}/My work`;
  await createDatabase(a, { name: "Project" }); await createDatabase(b, { name: "My work" });
  const stick = await tmp("albula-f11s-");
  const files: string[] = [];
  for (let k = 0; k < 100; k++) {
    const s = await makeCtSeries(4, 4, 2, { extra: { PatientName: "TEST^MANY", PatientID: "TM-1" } });
    for (const [i, x] of s.instances.entries()) { const f = `${stick}/${k}-${i}.dcm`; await Deno.writeFile(f, new Uint8Array(x)); files.push(f); }
  }
  await importFiles(a, files);
  const uids = (await sql(`${a}/ctkDICOM.sql`, "SELECT SeriesInstanceUID FROM Series")).split("\n");
  const r = await transferSeries(side("p", a), side("w", b), uids, { move: true });
  assertEquals(r.identical.length, 100);
  const t0 = performance.now();
  const gone = await removeTransferred(side("p", a), side("w", b), r);
  const s = (performance.now() - t0) / 1000;
  assertEquals(gone.series, 100);
  assert(s < 15, `${s.toFixed(1)} s`);
  console.log(`removing 100 scans: ${s.toFixed(1)} s`);
});

Deno.test("finding 12: a scan whose files lie outside the first database is reported as removed, its files left where they are", async () => {
  const a = `${await tmp("albula-f12a-")}/Project`, b = `${await tmp("albula-f12b-")}/My work`;
  const { ct } = await project(a, "Project");
  await createDatabase(b, { name: "My work" });
  const outside = await tmp("albula-f12o-");
  const rows = (await sql(`${a}/ctkDICOM.sql`, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}'`)).split("\n");
  const upd: string[] = [];
  for (const [i, f] of rows.entries()) { await Deno.rename(`${a}/${f}`, `${outside}/${i}.dcm`); upd.push(`UPDATE Images SET Filename='${outside}/${i}.dcm' WHERE Filename='${f}';`); }
  await new Deno.Command("/usr/bin/sqlite3", { args: [`${a}/ctkDICOM.sql`, upd.join("\n")] }).output();
  const r = await transferSeries(side("p", a), side("w", b), [ct.seriesInstanceUID], { move: true });
  const gone = await removeTransferred(side("p", a), side("w", b), r);
  assertEquals(gone.series, 2, "the scan, and the outline made from it (finding 3)");
  assertEquals(gone.kept, []);
  assertEquals(gone.outside, [{ description: "T1 with contrast", files: 4 }]);
  assert(await Deno.stat(`${outside}/0.dcm`).then(() => true, () => false), "the person's own files stay");
});

Deno.test("finding 16: a folder beside the database whose index cannot be read holds nothing", async () => {
  const parent = await tmp("albula-f16-");
  const { ct } = await project(`${parent}/Project`, "Project");
  await Deno.mkdir(`${parent}/Broken`);
  await Deno.writeTextFile(`${parent}/Broken/ctkDICOM.sql`, "x");
  await Deno.chmod(`${parent}/Broken/ctkDICOM.sql`, 0o000);
  assertEquals(await heldBySibling(`${parent}/Project`, ct.seriesInstanceUID), false);
  await Deno.chmod(`${parent}/Broken/ctkDICOM.sql`, 0o644);
});
