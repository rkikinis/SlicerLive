// A new database, its description, and adding DICOM files from disk to it (desktop/db-create.ts, db-import.ts).
//
//   deno test -A --no-check desktop/db-import.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import dcmjs from "../logic/dcmjs.ts";
import { setDcmjs } from "../logic/readers/dicom-series.ts";
import { makeCtSeries } from "../logic/test-dicom.ts";
import { createDatabase, cleanDescription, CTK_SCHEMA_VERSION, idFor, readDescription, writeDescription } from "./db-create.ts";
import { filesUnder, importFiles } from "./db-import.ts";
import { auditDatabase } from "./db-index.ts";
import { ctkInstancePath, md5Hex } from "./md5.ts";

setDcmjs(dcmjs);

const made: string[] = [];
globalThis.addEventListener("unload", () => { for (const d of made) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });
const tmp = async (prefix: string) => { const d = await Deno.makeTempDir({ prefix }); made.push(d); return d; };

async function sql(db: string, text: string): Promise<string> {
  const { stdout, code, stderr } = await new Deno.Command("/usr/bin/sqlite3", { args: ["-readonly", db, text] }).output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).trim();
}

Deno.test("md5 agrees with macOS's md5 on DICOM identifiers and edge lengths", async () => {
  for (const s of ["", "a", "1.2.840.10008.5.1.4.1.1.2", "x".repeat(55), "x".repeat(56), "x".repeat(64), "2.25.123456789012345678901234567890"]) {
    const { stdout } = await new Deno.Command("/sbin/md5", { args: ["-q", "-s", s] }).output();
    assertEquals(md5Hex(s), new TextDecoder().decode(stdout).trim(), JSON.stringify(s));
  }
  assertEquals(ctkInstancePath("1.2", "1.2.3", "1.2.3.4"), `dicom/${md5Hex("1.2").slice(0, 8)}/${md5Hex("1.2.3").slice(0, 8)}/${md5Hex("1.2.3.4")}.dcm`);
});

Deno.test("a new database has Slicer's tables and version, and its description", async () => {
  const dir = `${await tmp("albula-newdb-")}/Teaching cases`;
  await createDatabase(dir, { name: "Teaching cases", holds: "Public brain tumor scans", patientData: false, source: "OpenNeuro" });
  const db = `${dir}/ctkDICOM.sql`;
  assertEquals(await sql(db, "SELECT Version FROM SchemaInfo"), CTK_SCHEMA_VERSION);
  const tables = (await sql(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).split("\n");
  for (const t of ["Images", "Patients", "Series", "Studies", "SchemaInfo", "Directories", "ColumnDisplayProperties", "DisplayedFieldGeneratorRules"]) assert(tables.includes(t), t);
  assertEquals((await readDescription(dir))?.name, "Teaching cases");
  assertEquals((await readDescription(dir))?.patientData, false);
  await assertRejects(() => createDatabase(dir, { name: "again" }), Error, "already holds");
  await writeDescription(dir, { name: "Teaching cases", approval: "none needed" });
  assertEquals((await readDescription(dir))?.approval, "none needed");
});

Deno.test("descriptions are checked; ids are unique and never 'current'", () => {
  assertEquals(cleanDescription({ name: " A ", holds: "", patientData: "true", other: 1 }), { name: "A", patientData: true });
  let threw = false; try { cleanDescription({ holds: "x" }); } catch { threw = true; }
  assert(threw, "a description without a name is refused");
  assertEquals(idFor("Neurosurgery research", []), "neurosurgery-research");
  assertEquals(idFor("Neurosurgery research", ["neurosurgery-research"]), "neurosurgery-research-2");
  assertEquals(idFor("Current", []), "current-2");
  assertEquals(idFor("§§§", []), "database");
});

Deno.test("a folder of DICOM is added: copied to Slicer's layout, indexed, the originals untouched; a second time adds nothing", async () => {
  const src = await tmp("albula-stick-");
  const a = await makeCtSeries(8, 8, 5, { extra: { SeriesDescription: "T1 with contrast", PatientName: "TEST^ONE", PatientID: "T-1" } });
  const b = await makeCtSeries(8, 8, 3, { extra: { SeriesDescription: "Diffusion", PatientName: "TEST^ONE", PatientID: "T-1" } });
  await Deno.mkdir(`${src}/DICOM/a`, { recursive: true });
  await Deno.mkdir(`${src}/DICOM/b`, { recursive: true });
  for (const [i, x] of a.instances.entries()) await Deno.writeFile(`${src}/DICOM/a/IM${i}`, new Uint8Array(x));
  for (const [i, x] of b.instances.entries()) await Deno.writeFile(`${src}/DICOM/b/IM${i}`, new Uint8Array(x));
  await Deno.writeFile(`${src}/DICOM/b/IM0 copy`, new Uint8Array(b.instances[0]));   // the same image twice
  await Deno.writeTextFile(`${src}/README.txt`, "Patient disc. Viewer on the disc.");
  await Deno.writeTextFile(`${src}/.hidden-file`, "hidden");   // a hidden file, as macOS leaves in folders

  const dir = `${await tmp("albula-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  const { files } = await filesUnder(src);
  assertEquals(files.length, 10, "hidden files are left out");
  const before = await Promise.all(files.map((f) => Deno.readFile(f)));

  const r = await importFiles(dir, files);
  assertEquals(r.series.length, 2);
  assertEquals(r.instances, 8);
  assertEquals(r.patients, 1);
  assertEquals(r.studies, 2, "the fixture makes one study per series");
  assertEquals(r.failed, []);
  assertEquals(r.skippedCount, 2, "the text file, and the repeat");
  assertEquals(r.notes, []);
  assert(r.skipped.some((s) => s.file.endsWith("README.txt")));
  assert(r.audit?.ok, JSON.stringify(r.audit));

  const db = `${dir}/ctkDICOM.sql`;
  assertEquals(await sql(db, "SELECT COUNT(*) FROM Images"), "8");
  assertEquals(await sql(db, "SELECT COUNT(*) FROM Patients"), "1", "both studies under one patient, found by ID");
  assertEquals(await sql(db, "SELECT COUNT(*) FROM Studies"), "2");
  assertEquals(await sql(db, `SELECT SeriesDescription FROM Series WHERE SeriesInstanceUID='${a.seriesInstanceUID}'`), "T1 with contrast");
  const rel = await sql(db, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${a.seriesInstanceUID}' LIMIT 1`);
  assert(rel.startsWith(`dicom/${md5Hex(a.studyInstanceUID).slice(0, 8)}/${md5Hex(a.seriesInstanceUID).slice(0, 8)}/`), rel);
  // the originals: all there, byte for byte
  for (const [i, f] of files.entries()) assertEquals(await Deno.readFile(f), before[i]);

  const again = await importFiles(dir, files);
  assertEquals(again.series.length, 0);
  assertEquals(again.already, 9, "8 images, one of them in two files");
  assertEquals(await sql(db, "SELECT COUNT(*) FROM Images"), "8");
  assert((await auditDatabase(dir)).ok);
});

Deno.test("uploads in the staging folder are moved in, and the audit does not count waiting uploads as orphans", async () => {
  const dir = `${await tmp("albula-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  const s = await makeCtSeries(4, 4, 2);
  await Deno.mkdir(`${dir}/SlicerAlbula-Import/job1`, { recursive: true });
  const staged = [`${dir}/SlicerAlbula-Import/job1/0`, `${dir}/SlicerAlbula-Import/job1/1`];
  for (const [i, x] of s.instances.entries()) await Deno.writeFile(staged[i], new Uint8Array(x));
  await Deno.writeFile(`${dir}/SlicerAlbula-Import/job1/waiting`, new Uint8Array(s.instances[0]));
  assert((await auditDatabase(dir)).ok, "waiting uploads are not orphans");
  const r = await importFiles(dir, staged, { move: true });
  assertEquals(r.instances, 2);
  for (const f of staged) assert(!(await Deno.stat(f).then(() => true, () => false)), "moved, not copied");
});

// ---- the critic's round, 2026-10-01 (Contents/docs/qa/2026-10-01-database-import.md) ----

async function seriesFolder(extra: Record<string, unknown>, n = 3) {
  const src = await tmp("albula-src-");
  const sr = await makeCtSeries(4, 4, n, { extra });
  for (const [i, x] of sr.instances.entries()) await Deno.writeFile(`${src}/IM${i}`, new Uint8Array(x));
  return { src, sr, files: (await filesUnder(src)).files };
}
async function freshDb() { const dir = `${await tmp("albula-db-")}/db`; await createDatabase(dir, { name: "Test" }); return dir; }

Deno.test("finding 1: a series that fails to index takes back only the copies THIS import made", async () => {
  const dir = await freshDb();
  const { sr, files } = await seriesFolder({});
  // Another import's copy, already at its place (as two imports of the same disc leave it).
  const sop0 = (await import("../logic/readers/dicom-head.ts")).readDicomHead(new Uint8Array(sr.instances[0]).buffer).get("00080018")!;
  const theirs = `${dir}/${ctkInstancePath(sr.studyInstanceUID, sr.seriesInstanceUID, sop0)}`;
  await Deno.mkdir(theirs.slice(0, theirs.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(theirs, new Uint8Array(sr.instances[0]));
  await Deno.writeTextFile(`${dir}/ctkDICOM.sql-journal`, "");   // another program mid-write: the index refuses
  const r = await importFiles(dir, files);
  await Deno.remove(`${dir}/ctkDICOM.sql-journal`);
  assertEquals(r.series.length, 0);
  assertEquals(r.failed.length, 1);
  assert(await Deno.stat(theirs).then(() => true, () => false), "the other import's file is still there");
  const left = (await filesUnder(`${dir}/dicom`)).files;
  assertEquals(left, [theirs], "this import's own copies were taken back");
});

Deno.test("finding 2: the same patient ID with different names is two patients, as in Slicer", async () => {
  const dir = await freshDb();
  const a = await seriesFolder({ PatientID: "ANON", PatientName: "ALPHA^ONE" });
  const b = await seriesFolder({ PatientID: "ANON", PatientName: "BETA^TWO" });
  const r = await importFiles(dir, [...a.files, ...b.files]);
  assertEquals(r.patients, 2);
  assertEquals(await sql(`${dir}/ctkDICOM.sql`, "SELECT COUNT(*) FROM Patients"), "2");
  assertEquals(await sql(`${dir}/ctkDICOM.sql`, `SELECT p.PatientsName FROM Studies s JOIN Patients p ON p.UID=s.PatientsUID WHERE s.StudyInstanceUID='${b.sr.studyInstanceUID}'`), "BETA^TWO");
  const c = await seriesFolder({ PatientID: "ANON", PatientName: "ALPHA^ONE" });
  await importFiles(dir, c.files);
  assertEquals(await sql(`${dir}/ctkDICOM.sql`, "SELECT COUNT(*) FROM Patients"), "2", "the same ID and name is the same patient");
});

Deno.test("finding 5: the columns are filled from the header as Slicer fills them, and nothing is invented", async () => {
  const dir = await freshDb();
  const { sr, files } = await seriesFolder({ PatientBirthDate: "19600101", AccessionNumber: "ACC7", StudyID: "77", InstitutionName: "Somewhere",
    ReferringPhysicianName: "DOC^REF", BodyPartExamined: "HEAD", AcquisitionNumber: 3, EchoNumbers: 2, TemporalPositionIdentifier: 4, ScanningSequence: "GR", ContrastBolusAgent: "GAD" });
  await importFiles(dir, files);
  const db = `${dir}/ctkDICOM.sql`;
  assertEquals(await sql(db, "SELECT PatientsBirthDate FROM Patients"), "1960-01-01");
  assertEquals(await sql(db, "SELECT StudyID||'|'||AccessionNumber||'|'||InstitutionName||'|'||ReferringPhysician FROM Studies"), "77|ACC7|Somewhere|DOC^REF");
  assertEquals(await sql(db, `SELECT BodyPartExamined||'|'||AcquisitionNumber||'|'||EchoNumber||'|'||TemporalPosition||'|'||ScanningSequence||'|'||ContrastAgent||'|'||COALESCE(SeriesDate,'none') FROM Series WHERE SeriesInstanceUID='${sr.seriesInstanceUID}'`), "HEAD|3|2|4|GR|GAD|none");
});

Deno.test("finding 5: a file without a patient ID is filed under its study's UID, as Slicer does", async () => {
  const dir = await freshDb();
  const { sr, files } = await seriesFolder({ PatientID: "" });
  await importFiles(dir, files);
  assertEquals(await sql(`${dir}/ctkDICOM.sql`, "SELECT PatientID FROM Patients"), sr.studyInstanceUID);
});

Deno.test("finding 9: a series whose files name different studies is filed whole, under the first, and said", async () => {
  const dir = await freshDb();
  const src = await tmp("albula-src-");
  for (let i = 0; i < 3; i++) {   // each makeCtSeries is its own study; the series identifier is shared
    const one = await makeCtSeries(4, 4, 1, { extra: { SeriesInstanceUID: "2.25.777000111" } });
    await Deno.writeFile(`${src}/IM${i}`, new Uint8Array(one.instances[0]));
  }
  const r = await importFiles(dir, (await filesUnder(src)).files);
  assertEquals(r.instances, 3);
  assertEquals(r.series.length, 1);
  assertEquals(r.notes.length, 1);
  assertEquals(await sql(`${dir}/ctkDICOM.sql`, "SELECT COUNT(*) FROM Images"), "3");
});

Deno.test("finding 12 and 11: an unreadable folder and a database's own folder are left out and said; the rest goes in", async () => {
  const dir = await freshDb();
  const { src } = await seriesFolder({});
  await Deno.mkdir(`${src}/locked`); await Deno.chmod(`${src}/locked`, 0o000);
  await Deno.mkdir(`${src}/otherdb`);
  try {
    const { files, left } = await filesUnder(src, [`${src}/otherdb`]);
    assertEquals(files.length, 3);
    assert(left.some((l) => l.file.endsWith("/locked") && /could not be read/.test(l.reason)));
    assert(left.some((l) => l.file.endsWith("/otherdb") && /database/.test(l.reason)));
    const r = await importFiles(dir, files, { left });
    assertEquals(r.instances, 3);
    assertEquals(r.skippedCount, 2);
  } finally { await Deno.chmod(`${src}/locked`, 0o755); }
});

Deno.test("finding 8: a big endian file is called what it is, not 'not an image'", async () => {
  const dir = await freshDb();
  const src = await tmp("albula-src-");
  // A preamble and a file meta group naming explicit VR big endian: the header reader stops there for that form.
  const ts = "1.2.840.10008.1.2.2\0";
  const el = new Uint8Array(8 + ts.length);
  const dv = new DataView(el.buffer);
  dv.setUint16(0, 2, true); dv.setUint16(2, 0x10, true); el.set([0x55, 0x49], 4); dv.setUint16(6, ts.length, true);
  el.set(new TextEncoder().encode(ts), 8);
  const len = new Uint8Array(12); const lv = new DataView(len.buffer);
  lv.setUint16(0, 2, true); lv.setUint16(2, 0, true); len.set([0x55, 0x4c], 4); lv.setUint16(6, 4, true); lv.setUint32(8, el.length, true);
  const file = new Uint8Array(132 + len.length + el.length + 64);
  file.set(new TextEncoder().encode("DICM"), 128); file.set(len, 132); file.set(el, 144);
  await Deno.writeFile(`${src}/BE`, file);
  const r = await importFiles(dir, (await filesUnder(src)).files);
  assertEquals(r.skippedCount, 1);
  assert(/big endian/.test(r.skipped[0].reason), r.skipped[0].reason);
});
