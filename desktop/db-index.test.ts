// Indexing writes into the index of a database holding ~18 GB of patient imaging, so its guards are
// pinned here rather than trusted. Every test builds its own throwaway database; none of them can
// see a real one.
//
//   deno test -A --no-check desktop/db-index.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  auditDatabase,
  deleteSeriesFromDatabase,
  indexFileIntoDatabase,
  indexFilesIntoDatabase,
  provenanceEdges,
  provenancePathFor,
  recordProvenanceEdge,
} from "./db-index.ts";

const SQLITE = "/usr/bin/sqlite3";
const run = async (db: string, sql: string) => {
  const p = new Deno.Command(SQLITE, { args: [db], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(sql)); await w.close();
  const { code, stderr } = await p.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
};

/** A database with the four ctkDICOMDatabase tables and one study already in it. */
async function makeDb(): Promise<string> {
  // The database is a DIRECTORY INSIDE the temp root, not the root itself, because provenance.sqlite
  // is written beside the database directory. A bare temp dir would put it in the shared temp root,
  // where concurrent tests would read each other's edges.
  const root = await Deno.makeTempDir({ prefix: "albula-db-" });
  const dir = `${root}/SlicerDICOMDatabase`;
  await Deno.mkdir(dir);
  await run(`${dir}/ctkDICOM.sql`, `
    CREATE TABLE Patients (UID INTEGER PRIMARY KEY AUTOINCREMENT, PatientsName TEXT, PatientID TEXT, PatientsBirthDate TEXT, PatientsBirthTime TEXT, PatientsSex TEXT, PatientsAge TEXT, PatientsComments TEXT, InsertTimestamp TEXT, DisplayedPatientsName TEXT, DisplayedNumberOfStudies INT, DisplayedLastStudyDate TEXT, DisplayedFieldsUpdatedTimestamp TEXT);
    CREATE TABLE Studies (StudyInstanceUID TEXT PRIMARY KEY, PatientsUID INTEGER, StudyID TEXT, StudyDate TEXT, StudyTime TEXT, StudyDescription TEXT, AccessionNumber TEXT, ModalitiesInStudy TEXT, InstitutionName TEXT, ReferringPhysician TEXT, PerformingPhysiciansName TEXT, InsertTimestamp TEXT, DisplayedNumberOfSeries INT, DisplayedFieldsUpdatedTimestamp TEXT);
    CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY, StudyInstanceUID TEXT, SeriesNumber TEXT,
      SeriesDate TEXT, SeriesTime TEXT, SeriesDescription TEXT, Modality TEXT, AcquisitionNumber TEXT,
      EchoNumber TEXT, TemporalPosition TEXT, FrameOfReferenceUID TEXT, InsertTimestamp TEXT,
      DisplayedCount TEXT, DisplayedSize TEXT, DisplayedNumberOfFrames TEXT);
    CREATE TABLE Images (SOPInstanceUID TEXT PRIMARY KEY, Filename TEXT, URL TEXT, SeriesInstanceUID TEXT, InsertTimestamp TEXT);
    INSERT INTO Patients (UID, PatientsName, PatientID) VALUES (1, 'TEST^ONE', 'T1');
    INSERT INTO Studies (StudyInstanceUID, PatientsUID, StudyDate, StudyDescription) VALUES ('1.2.3', 1, '20260905', 'a study');
  `);
  return dir;
}

const meta = {
  sopInstanceUID: "1.2.3.4.5", seriesInstanceUID: "1.2.3.4", studyInstanceUID: "1.2.3",
  modality: "SEG", seriesDescription: "ts:total of NEPHROGENIC", displayedSize: "768x768", numberOfFrames: 13167,
};

/** A file that looks like DICOM to the orphan scan: "DICM" at byte 128. */
async function writeDicom(path: string) {
  const b = new Uint8Array(200);
  b.set(new TextEncoder().encode("DICM"), 128);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(path, b);
}

Deno.test("indexes a written file, and the audit comes back clean", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  const r = await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta);
  assertEquals(r.indexed, true);
  assertEquals(r.audit.ok, true, JSON.stringify(r.audit));
  assertEquals(r.audit.zombies, []);
  assertEquals(r.audit.orphans, []);
  // and the backup is gone, because the operation was verified
  assertEquals(r.backup, undefined);
  const left = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.includes("backup"));
  assertEquals(left, []);
});

Deno.test("an unindexed DICOM file in the written folder is reported as an orphan", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/stray.dcm`);
  const a = await auditDatabase(dir);
  assertEquals(a.ok, false);
  assertEquals(a.orphans.length, 1);
  assert(a.orphans[0].endsWith("stray.dcm"));
});

Deno.test("an index row whose file is gone is reported as a zombie", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta);
  await Deno.remove(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  const a = await auditDatabase(dir);
  assertEquals(a.ok, false);
  assertEquals(a.zombies, ["1.2.3.4.5"]);
});

Deno.test("a segmentation whose study is not in the database is refused, not guessed at", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await assertRejects(
    () => indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", { ...meta, studyInstanceUID: "9.9.9" }),
    Error,
    "not in this database",
  );
});

Deno.test("a non-UID is refused before any SQL is built", async () => {
  const dir = await makeDb();
  await assertRejects(
    () => indexFileIntoDatabase(dir, "x.dcm", { ...meta, seriesInstanceUID: "1.2.3'); DROP TABLE Images;--" }),
    Error,
    "not a DICOM UID",
  );
  // and the table is still there
  const a = await auditDatabase(dir);
  assertEquals(a.indexRows, 0);
});

Deno.test("refuses to write while another program holds the index", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await Deno.writeTextFile(`${dir}/ctkDICOM.sql-wal`, "");     // what an open transaction leaves behind
  await assertRejects(
    () => indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta),
    Error,
    "open by another program",
  );
});

// ---- provenance: what the browser indents by ----------------------------------------------------
//
// Ron: "It is now visible in the db viewer, but the indentation is wrong." The row was right and the
// tree had nothing to indent by, because indexing never recorded the parent. These pin the edge to
// the indexing call, so a saved segmentation cannot go back to being a top-level row.

const PARENT = "1.3.6.1.4.1.14519.5.2.1.2932.1975.255072988367557196694880426160";

Deno.test("indexing a segmentation records the series it was derived from", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  const r = await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", {
    ...meta,
    derivedFrom: { parentSeriesUID: PARENT, kind: "algorithm", label: "ts:total of NEPHROGENIC (111 segments)" },
  });
  assertEquals(r.indexed, true);
  const edges = await provenanceEdges(provenancePathFor(dir));
  assertEquals(edges.length, 1);
  assertEquals(edges[0].child, meta.seriesInstanceUID);
  assertEquals(edges[0].parent, PARENT);
  assertEquals(edges[0].label, "ts:total of NEPHROGENIC (111 segments)");
});

Deno.test("a segmentation with no known parent indexes anyway, and writes no edge", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  const r = await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta);
  assertEquals(r.indexed, true);
  // no provenance store is created just to hold nothing
  await assertRejects(() => Deno.stat(provenancePathFor(dir)), Deno.errors.NotFound);
});

Deno.test("re-saving replaces the edge instead of adding a second parent", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  const from = { parentSeriesUID: PARENT, kind: "algorithm", label: "first" };
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", { ...meta, derivedFrom: from });
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", {
    ...meta,
    derivedFrom: { ...from, label: "second" },
  });
  const edges = await provenanceEdges(provenancePathFor(dir));
  assertEquals(edges.length, 1);
  assertEquals(edges[0].label, "second");
});

Deno.test("a note edge survives re-saving the segmentation it is attached to", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await recordProvenanceEdge(dir, meta.seriesInstanceUID, { parentSeriesUID: PARENT, kind: "algorithm", label: "x" });
  await run(provenancePathFor(dir), `
    INSERT INTO ProvenanceEdges (child_series_uid, parent_series_uid, kind, label, created_at)
    VALUES ('${meta.seriesInstanceUID}', '${PARENT}', 'note', 'NOTE: needs review', '2026-09-05');`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", {
    ...meta,
    derivedFrom: { parentSeriesUID: PARENT, kind: "algorithm", label: "again" },
  });
  const kinds = (await provenanceEdges(provenancePathFor(dir))).map((e) => e.kind).sort();
  assertEquals(kinds, ["algorithm", "note"]);
});

Deno.test("a non-UID parent never reaches the SQL", async () => {
  const dir = await makeDb();
  await assertRejects(
    () => recordProvenanceEdge(dir, meta.seriesInstanceUID, { parentSeriesUID: "1.2.3'); DROP TABLE ProvenanceEdges;--" }),
    Error,
    "not a DICOM UID",
  );
});

// ---- deleting from the ARCHIVE, which is not the same as deleting from the scene ----------------
//
// Ron: "I deleted the lungvessel from the data module, but is still there when I bring up the dicom
// db." The Data module owns the scene; nothing owned the archive.

Deno.test("deleting a series removes its rows, its file and its edge", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", {
    ...meta,
    derivedFrom: { parentSeriesUID: PARENT, kind: "algorithm", label: "x" },
  });
  const r = await deleteSeriesFromDatabase(dir, meta.seriesInstanceUID);
  assertEquals(r.series, 1);
  assertEquals(r.images, 1);
  assertEquals(r.files, ["SlicerAlbula-SEG/seg.dcm"]);
  assertEquals(r.edges, 1, "the derivation edge goes with it, or it dangles");
  assertEquals(r.audit.ok, true, JSON.stringify(r.audit));
  assertEquals(await Deno.stat(`${dir}/SlicerAlbula-SEG/seg.dcm`).catch(() => null), null);
  assertEquals(r.backup, undefined, "verified, so the backup has done its job");
});

Deno.test("deleting a series removes its cache files, and only its own (critic 2026-10-06, R2-7)", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta);
  const uid = meta.seriesInstanceUID, cache = `${dir}/SlicerAlbula-Cache`;
  await Deno.mkdir(cache, { recursive: true });
  const mine = [`${uid}.albmesh`, `colorfa-${uid}.nrrd`], others = [`${uid}4.albmesh`, `colorfa-9${uid}.nrrd`, "notes.txt"];
  for (const f of [...mine, ...others]) await Deno.writeTextFile(`${cache}/${f}`, "x");
  await deleteSeriesFromDatabase(dir, uid);
  for (const f of mine) assertEquals(await Deno.stat(`${cache}/${f}`).catch(() => null), null, `${f} removed`);
  for (const f of others) assert(await Deno.stat(`${cache}/${f}`).catch(() => null), `${f} kept`);
});

Deno.test("the study and its other series are not touched", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/a.dcm`);
  await writeDicom(`${dir}/SlicerAlbula-SEG/b.dcm`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/a.dcm", meta);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/b.dcm", {
    ...meta,
    sopInstanceUID: "1.2.3.4.6",
    seriesInstanceUID: "1.2.3.9",
  });
  await deleteSeriesFromDatabase(dir, meta.seriesInstanceUID);
  const a = await auditDatabase(dir);
  assertEquals(a.indexRows, 1, "the other series survives");
  assertEquals(a.ok, true);
  // the study row stays even though it could now be empty — deleting it is not what was asked
  assert(await Deno.stat(`${dir}/SlicerAlbula-SEG/b.dcm`).then(() => true));
});

Deno.test("a series that is not there is refused, not silently a no-op", async () => {
  const dir = await makeDb();
  await assertRejects(() => deleteSeriesFromDatabase(dir, "1.2.3.4.5.6.7"), Error, "no such series");
});

Deno.test("a non-UID never reaches the SQL", async () => {
  const dir = await makeDb();
  await assertRejects(
    () => deleteSeriesFromDatabase(dir, "1.2.3'); DROP TABLE Series;--"),
    Error,
    "not a DICOM UID",
  );
});

Deno.test("it refuses while another program holds the index", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-SEG/seg.dcm`);
  await indexFileIntoDatabase(dir, "SlicerAlbula-SEG/seg.dcm", meta);
  await Deno.writeTextFile(`${dir}/ctkDICOM.sql-wal`, "");
  await assertRejects(() => deleteSeriesFromDatabase(dir, meta.seriesInstanceUID), Error, "open by another program");
});

// ── A WHOLE DERIVED SERIES, in one operation ────────────────────────────────────────────────────
//
// A cropped volume saved as DICOM is a few hundred single-frame instances. One at a time that would
// be a few hundred backups of a 240 MB index, a few hundred transactions and a few hundred full
// audits for ONE save -- and a failure halfway would leave half a series indexed, the exact
// half-state the backup-and-audit workflow exists to prevent.
Deno.test("a series of instances is indexed in one transaction, with one Series row", async () => {
  const dir = await makeDb();
  const files = [];
  for (let k = 0; k < 4; k++) {
    await writeDicom(`${dir}/SlicerAlbula-Volumes/i${k}.dcm`);
    files.push({
      file: `SlicerAlbula-Volumes/i${k}.dcm`,
      meta: { ...meta, sopInstanceUID: `1.2.3.4.${100 + k}`, modality: "MR", numberOfFrames: 1 },
    });
  }
  const r = await indexFilesIntoDatabase(dir, files);
  assertEquals(r.indexed, true);
  assertEquals(r.instances, 4);
  assertEquals(r.audit.ok, true, JSON.stringify(r.audit));
  const rows = await query(dir, "SELECT COUNT(*) FROM Images WHERE SeriesInstanceUID='1.2.3.4';");
  assertEquals(rows, "4");
  assertEquals(await query(dir, "SELECT COUNT(*) FROM Series;"), "1", "one series, not one per instance");
  // DisplayedCount is what the browser shows as the series' size, so it counts the instances.
  assertEquals(await query(dir, "SELECT DisplayedCount FROM Series;"), "4");
});

Deno.test("a batch naming two series is refused rather than half-indexed", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-Volumes/a.dcm`);
  await assertRejects(
    () =>
      indexFilesIntoDatabase(dir, [
        { file: "SlicerAlbula-Volumes/a.dcm", meta },
        { file: "SlicerAlbula-Volumes/b.dcm", meta: { ...meta, seriesInstanceUID: "1.2.3.9", sopInstanceUID: "1.2.3.9.1" } },
      ]),
    Error,
    "one series",
  );
  assertEquals(await query(dir, "SELECT COUNT(*) FROM Images;"), "0", "it wrote something before refusing");
});

/** One value out of the index, for the assertions above. */
async function query(dir: string, sql: string): Promise<string> {
  const p = new Deno.Command(SQLITE, { args: ["-readonly", `${dir}/ctkDICOM.sql`], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(sql)); await w.close();
  const { stdout } = await p.output();
  return new TextDecoder().decode(stdout).trim();
}

// TWO SAVES INDEXING AT ONCE queue behind each other and both land (critic, 2026-09-18 evening,
// finding 1: without the lock the loser's rollback erased the winner's rows in 3 of 12 runs).
Deno.test("two series indexed at the same moment both land, every time", async () => {
  const dir = await makeDb();
  const one = (n: number) => ({ file: `SlicerAlbula-SEG/s${n}.dcm`, meta: { ...meta, sopInstanceUID: `1.2.3.4.${n}.1`, seriesInstanceUID: `1.2.3.4.${n}`, seriesDescription: `s${n}` } });
  for (let round = 0; round < 6; round++) {
    const a = round * 2 + 10, b = round * 2 + 11;
    await writeDicom(`${dir}/SlicerAlbula-SEG/s${a}.dcm`); await writeDicom(`${dir}/SlicerAlbula-SEG/s${b}.dcm`);
    const [ra, rb] = await Promise.all([indexFilesIntoDatabase(dir, [one(a)]), indexFilesIntoDatabase(dir, [one(b)])]);
    assert(ra.indexed && rb.indexed, `round ${round}: both indexed`);
    assert(rb.audit.ok, `round ${round}: the second's audit is clean: ${JSON.stringify(rb.audit)}`);
    const q = new Deno.Command(SQLITE, { args: ["-readonly", `${dir}/ctkDICOM.sql`, `SELECT COUNT(*) FROM Series WHERE SeriesInstanceUID IN ('1.2.3.4.${a}','1.2.3.4.${b}');`], stdout: "piped" });
    assertEquals(new TextDecoder().decode((await q.output()).stdout).trim(), "2", `round ${round}: both rows present`);
  }
  const backups = [...Deno.readDirSync(dir)].filter((e) => e.name.startsWith("ctkDICOM.sql.backup-"));
  assertEquals(backups.length, 0, "no backup kept: every audit was clean");
});

Deno.test("a volume from a file gets its own patient and study when the record says so (Ron, 2026-09-20); the patient is reused by ID", async () => {
  const dir = await makeDb();
  await writeDicom(`${dir}/SlicerAlbula-Volumes/a.dcm`);
  const newStudy = { patientName: "MRHead", patientID: "MRHead", patientComments: "Loaded from MRHead.nrrd", studyDescription: "Loaded from MRHead.nrrd", studyDate: "20260920", studyTime: "193000" };
  const r = await indexFileIntoDatabase(dir, "SlicerAlbula-Volumes/a.dcm", { ...meta, sopInstanceUID: "5.5.5.1", seriesInstanceUID: "5.5.5", studyInstanceUID: "5.5", modality: "MR", newStudy });
  assert(r.indexed, r.error);
  const q = async (sql: string) => (await new Deno.Command("sqlite3", { args: ["-readonly", `${dir}/ctkDICOM.sql`, sql], stdout: "piped" }).output()).stdout;
  const dec = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  assertEquals(dec(await q("SELECT PatientsName, PatientID, PatientsComments, DisplayedNumberOfStudies FROM Patients WHERE PatientID='MRHead';")), "MRHead|MRHead|Loaded from MRHead.nrrd|1");
  assertEquals(dec(await q("SELECT StudyDate, StudyDescription, ModalitiesInStudy, PatientsUID = (SELECT UID FROM Patients WHERE PatientID='MRHead') FROM Studies WHERE StudyInstanceUID='5.5';")), "20260920|Loaded from MRHead.nrrd|MR|1");
  // a second study of the same subject reuses the patient row
  await writeDicom(`${dir}/SlicerAlbula-Volumes/b.dcm`);
  const r2 = await indexFileIntoDatabase(dir, "SlicerAlbula-Volumes/b.dcm", { ...meta, sopInstanceUID: "6.6.6.1", seriesInstanceUID: "6.6.6", studyInstanceUID: "6.6", modality: "MR", newStudy });
  assert(r2.indexed, r2.error);
  assertEquals(dec(await q("SELECT COUNT(*) FROM Patients WHERE PatientID='MRHead';")), "1");
  assertEquals(dec(await q("SELECT COUNT(*) FROM Studies WHERE PatientsUID = (SELECT UID FROM Patients WHERE PatientID='MRHead');")), "2");
  // without the record, the old rule holds
  await writeDicom(`${dir}/SlicerAlbula-Volumes/c.dcm`);
  await assertRejects(() => indexFileIntoDatabase(dir, "SlicerAlbula-Volumes/c.dcm", { ...meta, sopInstanceUID: "7.7.7.1", seriesInstanceUID: "7.7.7", studyInstanceUID: "7.7", modality: "MR" }), Error, "not in this database");
});
