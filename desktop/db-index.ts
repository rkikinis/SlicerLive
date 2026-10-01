// Put a file Albula just wrote INTO the DICOM index, and check the result.
//
// The "safe route" wrote the file and left the index alone, so a saved segmentation sat in the
// database directory invisible to everything that reads ctkDICOM.sql -- which is every browser,
// including Albula's own. Ron, three times: "The segmentation still does not show up." The manual
// alternative (import it in Slicer) is "a manual step and clicking around. A mistake waiting to
// happen." So Albula indexes it itself.
//
// The whole reason that was avoided is still true -- this writes the index of a database holding
// ~18 GB of patient imaging -- so the write is wrapped in the workflow the audit script already
// defines:
//
//   1. refuse if another process is mid-transaction (a -wal or -journal beside the index)
//   2. back up the index to ctkDICOM.sql.backup-<stamp>
//   3. insert inside ONE transaction, so a failure leaves nothing behind
//   4. audit for zombies and orphans
//   5. delete the backup only if the audit is clean; keep it, and say so, if it is not
//
// Step 5 is Ron's own retention rule from 2026-09-03: a pre-operation backup lives until the
// operation is verified, and verification is the trigger, not a calendar.
import { COPY_FOLDER } from "./duckn-copy-code.ts";
export { seriesFilePaths, seriesFileStamp } from "./series-files.ts";

const SQLITE = "/usr/bin/sqlite3";

/** Where a page's uploads wait inside a database folder until desktop/db-import.ts adds them; the audit does not count them. */
export const IMPORT_FOLDER = "SlicerAlbula-Import";

/** DICOM UIDs are digits and dots and nothing else; anything else never reaches the SQL. */
const UID = /^[0-9][0-9.]{0,63}$/;
/** SQLite string literal: the only escape it has is a doubled single quote. */
const q = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

/**
 * ctkDICOM's own format for `Series.SeriesDate`, which is NOT DICOM's.
 *
 * The index stores series dates as `2026-09-07` (261 of the 267 dated rows in Ron's database) while
 * DICOM writes `20260907` -- and `Studies.StudyDate` uses the DICOM form for every row. So the
 * convention is per COLUMN, not per database, and writing DICOM's form into the series column made
 * our rows sort apart from everyone else's: SQLite gives an integer-looking string numeric affinity,
 * so ours ordered before every ctk row regardless of date. It was invisible until a query went
 * looking for the newest segmentation and found one from five days ago.
 */
const ctkSeriesDate = (d: string | undefined): string | undefined =>
  d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

export interface IndexMeta {
  sopInstanceUID: string;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  modality: string;
  seriesNumber?: number | string;
  seriesDate?: string;
  seriesTime?: string;
  seriesDescription?: string;
  frameOfReferenceUID?: string;
  /** "768x768", shown in the browser's size column. */
  displayedSize?: string;
  numberOfFrames?: number;
  /**
   * The series this one was MADE FROM, so the browser can indent it under its parent.
   *
   * Ron, twice: "the indentation is wrong", and before that "nnInteractive segmentation is still not
   * indented relative to its parent". Both times the row was built correctly and the tree had nothing
   * to indent BY: `provenanceEdges()` could read the derivation, but nothing ever wrote it, so the
   * table held only the three edges someone entered by hand. A SEG knows its parent for certain --
   * it is the series it was drawn on -- and this is the one moment that knowledge passes through, so
   * it is recorded here rather than recovered later by opening every file in the database.
   */
  derivedFrom?: { parentSeriesUID: string; kind?: string; label?: string };
  /**
   * THE ONE CASE A PATIENT AND A STUDY ARE MADE HERE: a volume that came from a file, a sample,
   * a download -- nothing in the database to attach it to -- being saved so it can be worked on
   * again (Ron, 2026-09-20). The exporter names them; the patient row is reused when one with
   * this PatientID exists. Everything else keeps the rule below: no invented rows.
   */
  newStudy?: { patientName: string; patientID: string; patientComments?: string; studyDescription?: string; studyDate?: string; studyTime?: string;
    /** As the source states them (DICOM forms: M/F/O, "039Y"), for the patient row the browser shows. */
    patientSex?: string; patientAge?: string };
}

export interface AuditResult {
  indexRows: number;
  /** Index rows whose file is not on disk. */
  zombies: string[];
  /** DICOM files under the directory that no index row references. */
  orphans: string[];
  /** Rows whose file lives outside this directory: macOS privacy blocks checking them. */
  unverifiable: number;
  scope: "written-folder" | "whole-database";
  ok: boolean;
  /** `ctkDICOM.sql.backup-*` files a previous write kept; absent when there are none. */
  backups?: string[];
}

async function sqlite(dbPath: string, sql: string, readonly = true): Promise<string> {
  const cmd = new Deno.Command(SQLITE, {
    args: readonly ? ["-readonly", dbPath] : [dbPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const p = cmd.spawn();
  const w = p.stdin.getWriter();
  // WAIT WHEN THE FILE IS BUSY, up to five seconds. The sqlite3 program otherwise answers "database is
  // locked" at once, and provenance.sqlite has no writer lock of ours (the index has withIndexLock): a
  // segmentation saved while a scene was being saved lost its parent link silently (code review, A8).
  await w.write(new TextEncoder().encode(".timeout 5000\n" + sql));
  await w.close();
  const { code, stdout, stderr } = await p.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr).trim() || `sqlite3 exited ${code}`);
  return out;
}

/**
 * ONE WRITER AT A TIME, per database, inside this process. Two saves that index at once (the job
 * paradigm lands several results with their own Save buttons; on 2026-09-18 21:13 two indexed
 * 35 ms apart in the app) raced the SQLite lock: the loser's rollback copied ITS backup -- taken
 * before the winner's commit -- over the index and erased the winner's rows after "indexed" had
 * been reported (critic, 2026-09-18 evening, finding 1; reproduced 3 of 12 runs). The index and
 * the delete now queue behind each other here, and a failed transaction no longer copies a
 * snapshot back: SQLite's own rollback has already left the file as it was.
 */
const writers = new Map<string, Promise<unknown>>();
async function withIndexLock<T>(dbDir: string, fn: () => Promise<T>): Promise<T> {
  const key = dbDir.replace(/\/+$/, "");
  const prev = writers.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  writers.set(key, run);
  try { return await run; } finally { if (writers.get(key) === run) writers.delete(key); }
}

/** Another writer mid-transaction leaves one of these beside the index; we do not race it. */
async function busy(dbPath: string): Promise<boolean> {
  for (const suffix of ["-wal", "-journal"]) {
    try { await Deno.stat(dbPath + suffix); return true; } catch { /* absent is what we want */ }
  }
  return false;
}

/**
 * Zombies and orphans, the two failure modes Ron's audit script names.
 *
 * `scope` matters for cost: the zombie check is a stat per row and is always complete, but hunting
 * orphans means walking the directory and reading the first 132 bytes of every file to see whether
 * it is DICOM. Over 67,000 files that is not something to do on every startup, so the default looks
 * only in the folder Albula itself writes to -- the only place it can create one.
 */
export async function auditDatabase(
  dbDir: string,
  opts: { scope?: "written-folder" | "whole-database"; writtenFolder?: string } = {},
): Promise<AuditResult> {
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  // WHOLE DATABASE BY DEFAULT. This defaulted to the written folder because a full sweep sounded
  // expensive: tens of thousands of files, each needing its first 132 bytes read. Measured on the
  // real database it is 0.69 s for 22,985 rows -- cheap enough that scoping it narrowly bought
  // nothing and gave a weaker guarantee. The narrow scope stays available for a caller that wants it.
  const scope = opts.scope ?? "whole-database";
  const folder = opts.writtenFolder ?? "SlicerAlbula-SEG";

  // JSON out of sqlite3 rather than a delimiter: a Filename is arbitrary text, and every separator
  // cheap enough to type is one a path could contain.
  const raw = (await sqlite(dbPath, ".mode json\nSELECT SOPInstanceUID AS sop, COALESCE(Filename,'') AS file FROM Images;")).trim();
  const rows: { sop: string; file: string }[] = raw ? JSON.parse(raw) : [];

  const zombies: string[] = [];
  let unverifiable = 0;
  const referenced = new Set<string>();
  for (const r of rows) {
    if (!r.file) { zombies.push(r.sop); continue; }
    if (r.file.startsWith("/")) { unverifiable++; continue; }     // outside the folder: cannot be checked here
    const abs = `${dbDir}/${r.file}`;
    referenced.add(abs);
    try { await Deno.stat(abs); } catch { zombies.push(r.sop); }
  }

  // THE SERIES IN THE INDEX, for the derived folders below (the duckn copies): a copy whose series
  // is gone is an orphan the same as an unindexed DICOM file. Ron: "No orphans, no zombies."
  const seriesUids = new Set<string>();
  try {
    const sraw = (await sqlite(dbPath, ".mode json\nSELECT SeriesInstanceUID AS uid FROM Series;")).trim();
    for (const r of (sraw ? JSON.parse(sraw) as { uid: string }[] : [])) seriesUids.add(r.uid);
  } catch { /* no Series table: every duckn copy is then an orphan, which is the truth */ }
  const orphans: string[] = [];
  const walk = async (dir: string) => {
    // readDir does not throw until it is ITERATED, so the guard has to wrap the loop. Before the
    // first save the folder does not exist at all, and an audit on startup must report "clean"
    // rather than fail.
    try {
      await walkInner(dir);
    } catch { /* missing or unreadable: nothing here to call an orphan */ }
  };
  const walkInner = async (dir: string) => {
    const entries = Deno.readDir(dir);
    for await (const e of entries) {
      const p = `${dir}/${e.name}`;
      // THE DUCKN COPIES are judged as whole folders, never walked into: a copy is hundreds of
      // pieces, none of them DICOM, and opening each looking for "DICM" (60,000 opens for the whole
      // database) found nothing. An orphan here is a copy whose series is gone, one without its
      // description, or a `.part-`/`.old-` folder a killed converter left (critic, 2026-09-23, finding 12).
      if (dir === `${dbDir}/${COPY_FOLDER}`) {
        if (e.isFile && /^sweep-report\.json(\.tmp)?$/.test(e.name)) continue;   // the sweep's own report, and its write-aside (desktop/duckn-sweep.ts)
        const m = /^([0-9.]+)\.zarr$/.exec(e.name);
        const ok = !!m && e.isDirectory && seriesUids.has(m[1]) && await Deno.stat(`${p}/zarr.json`).then(() => true, () => false);
        if (!ok) orphans.push(p);
        continue;
      }
      if (e.isDirectory && p === `${dbDir}/${IMPORT_FOLDER}`) continue;   // uploads waiting to be imported, not the database's yet
      if (e.isDirectory) { await walk(p); continue; }
      if (!e.isFile || referenced.has(p)) continue;
      // DICOM files carry "DICM" at byte 128; anything else here is support material.
      try {
        using f = await Deno.open(p, { read: true });
        const head = new Uint8Array(132);
        await f.seek(0, Deno.SeekMode.Start);
        const n = await f.read(head);
        if (n === 132 && new TextDecoder().decode(head.subarray(128, 132)) === "DICM") orphans.push(p);
      } catch { /* unreadable: not something we can call an orphan */ }
    }
  };

  await walk(scope === "whole-database" ? dbDir : `${dbDir}/${folder}`);

  // Index backups a previous write kept because ITS audit was unhappy: said here, so they are not
  // forever (three sat unmentioned beside Ron's index from 2026-09-18 21:13).
  const backups: string[] = [];
  try {
    for await (const e of Deno.readDir(dbDir)) if (e.isFile && e.name.startsWith("ctkDICOM.sql.backup-")) backups.push(`${dbDir}/${e.name}`);
  } catch { /* unreadable folder: reported elsewhere */ }
  backups.sort();

  return { indexRows: rows.length, zombies, orphans, unverifiable, scope, ok: zombies.length === 0 && orphans.length === 0, ...(backups.length ? { backups } : {}) };
}

/** Which of these instances the database already holds (by SOPInstanceUID). */
export async function knownInstances(dbDir: string, sops: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const valid = [...new Set(sops)].filter((u) => UID.test(u));
  for (let i = 0; i < valid.length; i += 500) {
    const part = valid.slice(i, i + 500);
    const raw = await sqlite(`${dbDir}/ctkDICOM.sql`, `SELECT SOPInstanceUID FROM Images WHERE SOPInstanceUID IN (${part.map(q).join(",")});`);
    for (const line of raw.split("\n")) if (line.trim()) out.add(line.trim());
  }
  return out;
}

/** One series an import adds (desktop/db-import.ts): its files, and what its header says, column by column. */
export interface ImportSeries {
  seriesUID: string;
  studyUID: string;
  files: { file: string; sop: string }[];
  patient: { name: string; id: string; birthDate?: string; sex?: string; age?: string };
  study: { date?: string; time?: string; description?: string; id?: string; accession?: string; institution?: string; referring?: string; performing?: string };
  series: { modality: string; number?: string; date?: string; time?: string; description?: string; bodyPart?: string; frameOfReference?: string;
    acquisitionNumber?: string; contrastAgent?: string; scanningSequence?: string; echoNumber?: string; temporalPosition?: string; displayedSize?: string; numberOfFrames?: string };
}

/** DICOM's 20260907 as ctkDICOM writes a birth date, 2026-09-07 (critic, 2026-10-01, finding 5: Slicer's own row). */
const dashedDate = (d: string | undefined) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;

/**
 * ADD AN IMPORT'S SERIES TO THE INDEX: one lock, one backup and one audit for the whole import, one transaction per
 * series (so one bad series does not take the disc's others with it). Returns, per series, whether it went in.
 *
 * Unlike the save path above, the inputs come from OUTSIDE, so (critic, 2026-10-01, findings 2, 4, 5, 16):
 * - a patient is the same patient when ID AND name agree, as Slicer's indexer decides: anonymized discs give every
 *   patient the same ID ("ANON", "0"), and filing one person's scans under another's name is the worst error here;
 * - the columns are the ones Slicer's indexer fills from the header, and only from the header (no invented Study ID,
 *   no study date standing in for a series date);
 * - a series already in the index keeps its row, and its image count is recounted rather than replaced;
 * - the backup and the whole-database audit are paid once, not per series: 160 series took 46 s that way.
 */
export function indexImportedSeries(dbDir: string, list: ImportSeries[], onSeries?: () => void): Promise<{ results: { seriesUID: string; error?: string }[]; audit: AuditResult; backup?: string }> {
  return withIndexLock(dbDir, async () => {
    const dbPath = `${dbDir}/ctkDICOM.sql`;
    if (await busy(dbPath)) throw new Error("the DICOM index is open by another program (a -wal/-journal file is present); close it and try again");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${dbPath}.backup-${stamp}`;
    await Deno.copyFile(dbPath, backup);
    const s = (v: string | undefined) => `'${String(v ?? "").replace(/'/g, "''")}'`;   // always a string, '' for none (for matching)
    const results: { seriesUID: string; error?: string }[] = [];
    for (const it of list) {
      try {
        for (const u of [it.seriesUID, it.studyUID, ...it.files.map((f) => f.sop)]) if (!UID.test(u)) throw new Error(`not a DICOM UID: ${u}`);
        for (const f of it.files) if (!insideDatabase(f.file)) throw new Error(`not a path inside the database: ${f.file}`);
        const now = new Date().toISOString().slice(0, 23);
        const p = it.patient, st = it.study, se = it.series;
        const patientMatch = `PatientID=${s(p.id)} AND COALESCE(PatientsName,'')=${s(p.name)}`;
        const studyThere = (await sqlite(dbPath, `SELECT COUNT(*) FROM Studies WHERE StudyInstanceUID=${q(it.studyUID)};`)).trim() !== "0";
        // .bail on: the sqlite3 program otherwise carries on past a failed statement to the COMMIT, and half a series
        // would be in; stopped there, the open transaction is rolled back when it exits.
        const sql = `.bail on
BEGIN IMMEDIATE;
${studyThere ? "" : `INSERT INTO Patients (PatientsName, PatientID, PatientsBirthDate, PatientsBirthTime, PatientsSex, PatientsAge, PatientsComments, InsertTimestamp, DisplayedPatientsName, DisplayedNumberOfStudies, DisplayedLastStudyDate, DisplayedFieldsUpdatedTimestamp)
 SELECT ${q(p.name)}, ${s(p.id)}, ${q(dashedDate(p.birthDate))}, NULL, ${q(p.sex)}, ${q(p.age)}, NULL, ${q(now)}, ${q(p.name)}, 1, ${q(st.date)}, ${q(now)}
 WHERE NOT EXISTS (SELECT 1 FROM Patients WHERE ${patientMatch});
INSERT INTO Studies (StudyInstanceUID, PatientsUID, StudyID, StudyDate, StudyTime, StudyDescription, AccessionNumber, ModalitiesInStudy, InstitutionName, ReferringPhysician, PerformingPhysiciansName, InsertTimestamp, DisplayedNumberOfSeries, DisplayedFieldsUpdatedTimestamp)
 VALUES (${q(it.studyUID)}, (SELECT UID FROM Patients WHERE ${patientMatch} ORDER BY UID LIMIT 1), ${q(st.id)}, ${q(st.date)}, ${q(st.time)}, ${q(st.description)}, ${q(st.accession)}, ${q(se.modality)}, ${q(st.institution)}, ${q(st.referring)}, ${q(st.performing)}, ${q(now)}, 1, ${q(now)});`}
INSERT OR IGNORE INTO Series (SeriesInstanceUID, StudyInstanceUID, SeriesNumber, SeriesDate, SeriesTime, SeriesDescription, Modality, BodyPartExamined, FrameOfReferenceUID,
  AcquisitionNumber, ContrastAgent, ScanningSequence, EchoNumber, TemporalPosition, InsertTimestamp, DisplayedCount, DisplayedSize, DisplayedNumberOfFrames)
 VALUES (${q(it.seriesUID)}, ${q(it.studyUID)}, ${q(se.number)}, ${q(ctkSeriesDate(se.date))}, ${q(se.time)}, ${q(se.description)}, ${q(se.modality)}, ${q(se.bodyPart)}, ${q(se.frameOfReference)},
  ${q(se.acquisitionNumber)}, ${q(se.contrastAgent)}, ${q(se.scanningSequence)}, ${q(se.echoNumber)}, ${q(se.temporalPosition)}, ${q(now)}, 0, ${q(se.displayedSize)}, ${q(se.numberOfFrames)});
${it.files.map((f) => `INSERT OR IGNORE INTO Images (SOPInstanceUID, Filename, URL, SeriesInstanceUID, InsertTimestamp) VALUES (${q(f.sop)}, ${q(f.file)}, '', ${q(it.seriesUID)}, ${q(now)});`).join("\n")}
UPDATE Series SET DisplayedCount = (SELECT COUNT(*) FROM Images WHERE SeriesInstanceUID=${q(it.seriesUID)}) WHERE SeriesInstanceUID=${q(it.seriesUID)};
COMMIT;
`;
        await sqlite(dbPath, sql, false);
        results.push({ seriesUID: it.seriesUID });
      } catch (e) {
        results.push({ seriesUID: it.seriesUID, error: `not indexed: ${(e as Error).message}` });
      }
      onSeries?.();
    }
    const audit = await auditDatabase(dbDir);
    if (audit.zombies.length === 0) { await Deno.remove(backup).catch(() => {}); return { results, audit }; }
    return { results, audit, backup };
  });
}

/**
 * Index one already-written file, then verify.
 *
 * Patient and Study rows are NOT created: a segmentation derives from a series already in this
 * database, so its study is already here, and inventing a second Patients row for the same person is
 * precisely the kind of duplicate the "no zombies, no orphans" standard exists to prevent. If the
 * study is missing the file is refused rather than guessed at.
 */
export function indexFileIntoDatabase(
  dbDir: string,
  relPath: string,
  m: IndexMeta,
): Promise<{ indexed: boolean; audit: AuditResult; backup?: string; error?: string }> {
  return indexFilesIntoDatabase(dbDir, [{ file: relPath, meta: m }]);
}

/**
 * Index a whole SERIES of already-written files as ONE operation.
 *
 * A derived image series is a few hundred single-frame instances (logic/export-dicom-image.ts), and
 * indexing them one at a time would mean a few hundred backups of a 240 MB index, a few hundred
 * transactions and a few hundred full audits -- for one save. Worse, a failure halfway would leave
 * half a series in the index, which is exactly the half-state the whole backup-and-audit workflow
 * exists to prevent.
 *
 * So: one backup, ONE transaction over every row, one audit. Either the series is in the index or
 * none of it is. Every instance must belong to the same series -- a batch that mixed series would
 * need a Series row each and there is no caller for that.
 */
export function indexFilesIntoDatabase(
  dbDir: string,
  files: { file: string; meta: IndexMeta }[],
): Promise<{ indexed: boolean; instances: number; audit: AuditResult; backup?: string; error?: string; warning?: string }> {
  return withIndexLock(dbDir, () => indexFilesLocked(dbDir, files));
}

async function indexFilesLocked(
  dbDir: string,
  files: { file: string; meta: IndexMeta }[],
): Promise<{ indexed: boolean; instances: number; audit: AuditResult; backup?: string; error?: string; warning?: string }> {
  if (!files.length) throw new Error("nothing to index");
  const m = files[0].meta;
  for (const f of files) {
    for (const uid of [f.meta.sopInstanceUID, f.meta.seriesInstanceUID, f.meta.studyInstanceUID]) {
      if (!UID.test(uid)) throw new Error(`not a DICOM UID: ${uid}`);
    }
    if (f.meta.seriesInstanceUID !== m.seriesInstanceUID) {
      throw new Error("one call indexes one series; these instances name more than one");
    }
    if (!f.file) throw new Error("an instance with no file");
  }
  // ONLY FILES THAT ARE THERE, INSIDE THE DATABASE FOLDER: the route accepted any path, so a row could name
  // a file outside, which a later delete of that series would then have removed (code review 2026-09-24, A9).
  // Inside is decided on the path as written (insideDatabase), not by following links: a folder of the
  // database that the person moved to another disk and linked back is still the database's.
  for (const f of files) {
    if (!insideDatabase(f.file)) throw new Error(`not a path inside the database: ${f.file}`);
    if (!(await Deno.lstat(`${dbDir}/${f.file}`).then(() => true).catch(() => false))) throw new Error(`no such file in the database folder: ${f.file}`);
  }
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  if (await busy(dbPath)) {
    throw new Error("the DICOM index is open by another program (a -wal/-journal file is present); close it and try again");
  }

  const study = (await sqlite(dbPath, `SELECT COUNT(*) FROM Studies WHERE StudyInstanceUID=${q(m.studyInstanceUID)};`)).trim();
  let makeStudy = "";
  if (study === "0") {
    if (!m.newStudy) throw new Error("the study this belongs to is not in this database, so there is nothing to attach it to");
    const ns = m.newStudy;
    // The patient by ID (the name is not unique: four patients-of-record here share one). A new
    // one gets the columns ctkDICOM's own importer fills, so Slicer's browser lists it the same.
    const pid = (await sqlite(dbPath, `SELECT UID FROM Patients WHERE PatientID=${q(ns.patientID)} LIMIT 1;`)).trim();
    const nowTs = new Date().toISOString().slice(0, 23);
    const date = ns.studyDate ?? "";                      // Studies.StudyDate keeps the DICOM form (see above); Series is the dashed one
    makeStudy = (pid ? "" : `INSERT INTO Patients (PatientsName, PatientID, PatientsBirthDate, PatientsBirthTime, PatientsSex, PatientsAge, PatientsComments, InsertTimestamp, DisplayedPatientsName, DisplayedNumberOfStudies, DisplayedLastStudyDate, DisplayedFieldsUpdatedTimestamp)
 VALUES (${q(ns.patientName)}, ${q(ns.patientID)}, '', '', ${q(ns.patientSex ?? "")}, ${q(ns.patientAge ?? "")}, ${q(ns.patientComments ?? "")}, ${q(nowTs)}, ${q(ns.patientName)}, 1, ${q(date)}, ${q(nowTs)});\n`) +
      `INSERT INTO Studies (StudyInstanceUID, PatientsUID, StudyID, StudyDate, StudyTime, StudyDescription, AccessionNumber, ModalitiesInStudy, InstitutionName, ReferringPhysician, PerformingPhysiciansName, InsertTimestamp, DisplayedNumberOfSeries, DisplayedFieldsUpdatedTimestamp)
 VALUES (${q(m.studyInstanceUID)}, ${pid ? Number(pid) : "(SELECT UID FROM Patients WHERE PatientID=" + q(ns.patientID) + " ORDER BY UID DESC LIMIT 1)"}, '1', ${q(date)}, ${q(ns.studyTime ?? "")}, ${q(ns.studyDescription ?? "")}, '', ${q(m.modality)}, '', '', '', ${q(nowTs)}, 1, ${q(nowTs)});\n`;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.backup-${stamp}`;
  await Deno.copyFile(dbPath, backup);

  const now = new Date().toISOString().slice(0, 23);
  // .bail on: without it the sqlite3 program carries on past a failed statement to the COMMIT (found 2026-10-01 with
  // the import's critic round), so "one transaction, a failure leaves nothing behind" held only with it.
  const sql = `.bail on
BEGIN IMMEDIATE;
${makeStudy}INSERT OR REPLACE INTO Series (SeriesInstanceUID, StudyInstanceUID, SeriesNumber, SeriesDate, SeriesTime,
  SeriesDescription, Modality, AcquisitionNumber, EchoNumber, TemporalPosition, FrameOfReferenceUID,
  InsertTimestamp, DisplayedCount, DisplayedSize, DisplayedNumberOfFrames)
 VALUES (${q(m.seriesInstanceUID)}, ${q(m.studyInstanceUID)}, ${q(m.seriesNumber ?? 0)}, ${q(ctkSeriesDate(m.seriesDate))}, ${q(m.seriesTime)},
  ${q(m.seriesDescription)}, ${q(m.modality)}, 0, 0, 0, ${q(m.frameOfReferenceUID)},
  ${q(now)}, ${files.length}, ${q(m.displayedSize)}, ${q(m.numberOfFrames)});
${
    files.map((f) =>
      `INSERT OR REPLACE INTO Images (SOPInstanceUID, Filename, URL, SeriesInstanceUID, InsertTimestamp)
 VALUES (${q(f.meta.sopInstanceUID)}, ${q(f.file)}, '', ${q(m.seriesInstanceUID)}, ${q(now)});`
    ).join("\n")
  }
COMMIT;
`;
  try {
    await sqlite(dbPath, sql, false);
  } catch (e) {
    // NOT copied back. A transaction that failed changed nothing -- SQLite rolled it back -- and
    // copying a snapshot over the file erased whatever another writer committed in between.
    await Deno.remove(backup).catch(() => {});
    throw new Error(`index write failed and was rolled back: ${(e as Error).message}`);
  }

  // The derivation edge, once the rows it describes are actually in the index.
  //
  // Deliberately NOT fatal and deliberately outside the transaction above: provenance.sqlite is a
  // separate file, it is where the tree gets its shape and not where the data lives, and a database
  // that has never had one is the normal case rather than an error. A segmentation that indexes but
  // fails to record its parent is a flat row -- the state we were already in -- not a lost save.
  // Not fatal, but SAID: a lost link used to vanish without a word and the series showed as a top-level row.
  let warning: string | undefined;
  if (m.derivedFrom?.parentSeriesUID) {
    await recordProvenanceEdge(dbDir, m.seriesInstanceUID, m.derivedFrom).catch((e) => {
      warning = `its link to the series it was made from was not recorded (${(e as Error)?.message ?? e}), so it shows as a top-level row`;
      console.warn(`provenance edge not written for ${m.seriesInstanceUID}: ${warning}`);
    });
  }

  const audit = await auditDatabase(dbDir);
  // THE BACKUP IS KEPT FOR ZOMBIES ONLY -- rows whose file is missing, the one harm an index write
  // can do. An orphan is a file nobody has indexed YET: with two saves in flight the second's
  // file is on disk while the first is being indexed, and keeping a backup for that is how three
  // sat beside Ron's index from 21:13 (critic, 2026-09-18 evening). Orphans are still reported.
  if (audit.zombies.length === 0) {
    await Deno.remove(backup).catch(() => {});                 // verified, so the backup has done its job
    return { indexed: true, instances: files.length, audit, ...(warning ? { warning } : {}) };
  }
  return { indexed: true, instances: files.length, audit, backup, error: "the audit found rows without files; the pre-write backup has been kept", ...(warning ? { warning } : {}) };
}

/** provenance.sqlite is the database directory's SIBLING (see the _provenance route in db-serve.ts). */
export const provenancePathFor = (dbDir: string): string =>
  `${dbDir.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/provenance.sqlite`;

/**
 * Record "this series was made from that one", creating the store if this database has never had one.
 *
 * Re-saving a segmentation replaces its edge rather than adding a second: the table is append-only
 * as a record of what happened, but a child has exactly one parent to be drawn under, and two rows
 * would make the tree's shape depend on which came back first.
 */
export async function recordProvenanceEdge(
  dbDir: string,
  childSeriesUID: string,
  from: { parentSeriesUID: string; kind?: string; label?: string },
): Promise<void> {
  for (const uid of [childSeriesUID, from.parentSeriesUID]) {
    if (!UID.test(uid)) throw new Error(`not a DICOM UID: ${uid}`);
  }
  const path = provenancePathFor(dbDir);
  await sqlite(path, `
CREATE TABLE IF NOT EXISTS ProvenanceEdges (
  id INTEGER PRIMARY KEY,
  child_series_uid  TEXT NOT NULL,
  parent_series_uid TEXT,
  kind   TEXT NOT NULL,
  label  TEXT NOT NULL,
  detail TEXT,
  author TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prov_parent ON ProvenanceEdges(parent_series_uid);
CREATE INDEX IF NOT EXISTS idx_prov_child  ON ProvenanceEdges(child_series_uid);
BEGIN IMMEDIATE;
DELETE FROM ProvenanceEdges WHERE child_series_uid=${q(childSeriesUID)} AND kind<>'note';
INSERT INTO ProvenanceEdges (child_series_uid, parent_series_uid, kind, label, created_at)
VALUES (${q(childSeriesUID)}, ${q(from.parentSeriesUID)}, ${q(from.kind ?? "algorithm")},
        ${q(from.label ?? "derived")}, ${q(new Date().toISOString())});
COMMIT;
`, false);
}

export interface ProvenanceEdge {
  child: string;
  parent: string;
  kind: string;
  label: string;
  /** ISO time the edge was recorded; the route returns edges newest first. */
  createdAt?: string;
  /** Free text and who, when the writer said (a crop's parameters; null otherwise). */
  detail?: string | null;
  author?: string | null;
}

/**
 * The derivation chain: which series was made from which.
 *
 * `Slicer/DICOMProvenance` records this as append-only edges — a cropped volume names the series it
 * was cropped from, a segmentation names the volume it was drawn on. DICOM itself only carries half
 * of it (a SEG references its source series; a derived CT does not reliably say what it came from),
 * and reading it out of the files would mean opening every one. The edges are already here.
 *
 * Read-only, and never given a path from a caller: the filename is fixed and sits beside a database
 * the user registered.
 */
export async function provenanceEdges(path: string): Promise<ProvenanceEdge[]> {
  const raw = (await sqlite(
    path,
    // created_at travels with the edge and the newest comes first, so a loader picking among
    // several children of one parent has a tie-break that is right even when the series rows are
    // undated (critic, 2026-09-17, finding 4: the surface series were, and "newest wins" took the
    // oldest -- the insertion order of an unordered SELECT).
    ".mode json\nSELECT child_series_uid AS child, parent_series_uid AS parent, kind, COALESCE(label,'') AS label, detail, author, created_at AS createdAt FROM ProvenanceEdges ORDER BY created_at DESC;",
  )).trim();
  return raw ? JSON.parse(raw) as ProvenanceEdge[] : [];
}

/**
 * WHAT ELSE IS KNOWN ABOUT A SERIES, beyond DICOM. Today: which IDC collection it came from and
 * under which license -- neither is in the files (TCIA's de-identified headers carry no
 * ClinicalTrialProtocolID, InstitutionName is blank) and the ctkDICOM index has no column for them.
 * So they live in the provenance store, Albula's own database beside the DICOM one, as rows of
 * (series, key, value, source). `source` is the point: "idc" was looked up, "fetch" was recorded as
 * the series was downloaded, "user" was typed by a person and outranks both.
 */
export interface SeriesAttribute { uid: string; key: string; value: string; source: string }

export async function seriesAttributes(path: string): Promise<SeriesAttribute[]> {
  // The table may not exist yet: a provenance.sqlite older than this feature holds only edges.
  const has = (await sqlite(path, "SELECT name FROM sqlite_master WHERE type='table' AND name='SeriesAttributes';")).trim();
  if (!has) return [];
  const raw = (await sqlite(path, ".mode json\nSELECT SeriesInstanceUID AS uid, Key AS key, Value AS value, Source AS source FROM SeriesAttributes;")).trim();
  return raw ? JSON.parse(raw) as SeriesAttribute[] : [];
}

/** A person's answer. Written with source "user", which the lookups never overwrite. */
export async function setSeriesAttribute(path: string, uid: string, key: string, value: string, source: "user" | "haversack" = "user"): Promise<void> {
  const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) throw new Error("bad attribute key");
  await sqlite(path,
    "CREATE TABLE IF NOT EXISTS SeriesAttributes (SeriesInstanceUID TEXT NOT NULL, Key TEXT NOT NULL, Value TEXT NOT NULL, " +
    "Source TEXT NOT NULL, Recorded TEXT NOT NULL, PRIMARY KEY (SeriesInstanceUID, Key));\n" +
    (value.trim()
      ? `INSERT OR REPLACE INTO SeriesAttributes VALUES (${q(uid)}, ${q(key)}, ${q(value.trim())}, ${q(source)}, ${q(new Date().toISOString().slice(0, 19))});`
      : `DELETE FROM SeriesAttributes WHERE SeriesInstanceUID=${q(uid)} AND Key=${q(key)};`),
    false);
}

// ---------------------------------------------------------------------------------------------
// COHORTS. Ron, 2026-09-22: "The dicom db is a mess ... I will need the capability to define a
// cohort and add and remove data sets from a cohort." A cohort is a name and a set of data sets --
// patients (by PatientID) and studies (by StudyInstanceUID), not series (Ron: "no series") -- kept
// in the provenance store beside the collection attribute. Nothing in Slicer's index changes;
// deleting a cohort deletes the name and the membership, no file.
// ---------------------------------------------------------------------------------------------
export interface Cohort { name: string; created: string; patients: string[]; studies: string[] }
export type CohortLevel = "patient" | "study";

const COHORT_SCHEMA =
  "CREATE TABLE IF NOT EXISTS Cohorts (Name TEXT NOT NULL PRIMARY KEY, Created TEXT NOT NULL);\n" +
  "CREATE TABLE IF NOT EXISTS CohortMembers (Cohort TEXT NOT NULL, Level TEXT NOT NULL, Uid TEXT NOT NULL, Added TEXT NOT NULL, PRIMARY KEY (Cohort, Level, Uid));\n";
const qs = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const now = () => new Date().toISOString().slice(0, 19);

export async function cohorts(path: string): Promise<Cohort[]> {
  const has = (await sqlite(path, "SELECT name FROM sqlite_master WHERE type='table' AND name='Cohorts';")).trim();
  if (!has) return [];
  const raw = (await sqlite(path, ".mode json\nSELECT Name AS name, Created AS created FROM Cohorts ORDER BY Name;")).trim();
  const list = raw ? JSON.parse(raw) as { name: string; created: string }[] : [];
  const mraw = (await sqlite(path, ".mode json\nSELECT Cohort AS cohort, Level AS level, Uid AS uid FROM CohortMembers;")).trim();
  const members = mraw ? JSON.parse(mraw) as { cohort: string; level: CohortLevel; uid: string }[] : [];
  return list.map((c) => ({
    ...c,
    patients: members.filter((m) => m.cohort === c.name && m.level === "patient").map((m) => m.uid),
    studies: members.filter((m) => m.cohort === c.name && m.level === "study").map((m) => m.uid),
  }));
}

/** Make a cohort (no members) if it is not there. The name is trimmed; empty is refused. */
export async function createCohort(path: string, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error("a cohort needs a name");
  await sqlite(path, COHORT_SCHEMA + `INSERT OR IGNORE INTO Cohorts VALUES (${qs(n)}, ${qs(now())});`, false);
}

/** Add and remove members in one call; the cohort is created if it is new. */
export async function setCohortMembers(path: string, name: string, add: { level: CohortLevel; uid: string }[], remove: { level: CohortLevel; uid: string }[]): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error("a cohort needs a name");
  const ok = (m: { level: CohortLevel; uid: string }) => (m.level === "patient" || m.level === "study") && !!m.uid;
  const sql = COHORT_SCHEMA +
    `INSERT OR IGNORE INTO Cohorts VALUES (${qs(n)}, ${qs(now())});\n` +
    add.filter(ok).map((m) => `INSERT OR IGNORE INTO CohortMembers VALUES (${qs(n)}, ${qs(m.level)}, ${qs(m.uid)}, ${qs(now())});`).join("\n") + "\n" +
    remove.filter(ok).map((m) => `DELETE FROM CohortMembers WHERE Cohort=${qs(n)} AND Level=${qs(m.level)} AND Uid=${qs(m.uid)};`).join("\n");
  await sqlite(path, sql, false);
}

/** The name and its membership go; nothing else. */
export async function deleteCohort(path: string, name: string): Promise<void> {
  const n = name.trim();
  await sqlite(path, COHORT_SCHEMA + `DELETE FROM CohortMembers WHERE Cohort=${qs(n)}; DELETE FROM Cohorts WHERE Name=${qs(n)};`, false);
}

/**
 * BYTES PER SERIES, from the files the index names. The index has no size column (its
 * DisplayedSize is 512x512, the image dimensions), so this stats every file once and caches the
 * answer against the index's own mtime -- a database of 66,000 instances is a second or two of
 * stat, which is fine once and not fine on every browse.
 */
const sizeCache = new Map<string, { mtime: number; sizes: Record<string, number> }>();
export async function seriesSizes(dbPath: string): Promise<Record<string, number>> {
  const index = `${dbPath.replace(/\/+$/, "")}/ctkDICOM.sql`;
  const mtime = (await Deno.stat(index)).mtime?.getTime() ?? 0;
  const hit = sizeCache.get(dbPath);
  if (hit && hit.mtime === mtime) return hit.sizes;
  const raw = (await sqlite(index, ".mode json\nSELECT SeriesInstanceUID AS uid, Filename AS f FROM Images;")).trim();
  const rows = raw ? JSON.parse(raw) as { uid: string; f: string }[] : [];
  const sizes: Record<string, number> = {};
  // BOUNDED, not Promise.all over everything. The first version fired 66,000 stats at once; nearly
  // all failed with "too many open files", the catch below read each failure as an external file,
  // and a 709-slice CT reported 1.2 MB -- one surviving stat. A swallowed error that looks like a
  // legitimate absence is exactly the failure CONSTRAINTS.md keeps naming.
  let missing = 0;
  const root = dbPath.replace(/\/+$/, "");
  for (let i = 0; i < rows.length; i += 64) {
    await Promise.all(rows.slice(i, i + 64).map(async (r) => {
      const p = r.f.startsWith("/") ? r.f : `${root}/${r.f}`;
      // STAT FIRST, THEN ADD. `sizes[uid] = (sizes[uid] ?? 0) + (await stat).size` reads the old
      // total BEFORE the await, so every task in the batch read 0 and only the last write survived:
      // 709 files summed to 15 MB. The read-modify-write has to happen after the await, in one go.
      let size: number;
      try { size = (await Deno.stat(p)).size; }
      catch (e) { if (e instanceof Deno.errors.NotFound) { missing++; return; } throw e; }
      sizes[r.uid] = (sizes[r.uid] ?? 0) + size;
    }));
  }
  if (missing) console.log(`seriesSizes: ${missing} of ${rows.length} files not on disk (external or gone)`);
  sizeCache.set(dbPath, { mtime, sizes });
  return sizes;
}

// seriesFileStamp and seriesFilePaths live in ./series-files.ts (re-exported at the top of this file).

/**
 * A series' duckn working copy removed (desktop/duckn-copy.ts), with any half-written ones a killed
 * converter left beside it. True when something was removed.
 */
export async function removeDucknCopy(dbDir: string, seriesUID: string): Promise<boolean> {
  if (!UID.test(seriesUID)) return false;
  const dir = `${dbDir.replace(/\/+$/, "")}/${COPY_FOLDER}`;
  let removed = false;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === `${seriesUID}.zarr` || e.name.startsWith(`${seriesUID}.zarr.part-`) || e.name.startsWith(`${seriesUID}.zarr.old-`)) {
        await Deno.remove(`${dir}/${e.name}`, { recursive: true });
        removed = true;
      }
    }
  } catch { /* no copies folder: nothing to remove */ }
  return removed;
}

export interface DeleteResult {
  /** Index rows removed. */
  series: number;
  images: number;
  /** Files removed from disk. */
  files: string[];
  /** Provenance edges removed with it. */
  edges: number;
  /** Whether its duckn working copy was removed with it. */
  copyRemoved?: boolean;
  /** Files its rows named outside the database folder: the person's own, left in place. */
  leftInPlace?: string[];
  audit: AuditResult;
  backup?: string;
  error?: string;
}

/**
 * Remove one series from the DICOM database: its rows, its files, and its derivation edge.
 *
 * Ron, 2026-09-05, having deleted a segmentation in the Data module and found it still in the
 * archive: "I deleted the lungvessel from the data module, but is still there when I bring up the
 * dicom db." Two different places, and until now only one of them had a delete. The Data module owns
 * the SCENE — unloading is the right thing for it to do — and nothing owned the archive.
 *
 * Same discipline as indexFileIntoDatabase, for the same reason: this writes the index of a database
 * holding ~18 GB of patient imaging.
 *
 *   1. refuse if another process is mid-transaction
 *   2. back up the index
 *   3. delete the rows in ONE transaction
 *   4. delete the files, and only files no surviving row still references
 *   5. audit, and keep the backup if the audit is unhappy
 *
 * STUDY AND PATIENT ROWS ARE LEFT ALONE even when this empties them. A study with no series is
 * visible and harmless; a study row deleted out from under another series would not be, and the
 * caller asked to remove a series.
 */
/**
 * Is this index path inside the database folder, as written? Relative, with no ".." part. Decided on the text,
 * not by following links, and with either separator, so it reads the same on every system (critic,
 * review-bugfixes findings 8 and 12).
 */
export function insideDatabase(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split(/[\\/]/).includes("..");
}

export async function deleteSeriesFromDatabase(dbDir: string, seriesUID: string): Promise<DeleteResult> {
  if (!UID.test(seriesUID)) throw new Error(`not a DICOM UID: ${seriesUID}`);
  return await withIndexLock(dbDir, () => deleteSeriesLocked(dbDir, seriesUID));
}

async function deleteSeriesLocked(dbDir: string, seriesUID: string): Promise<DeleteResult> {
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  if (await busy(dbPath)) {
    throw new Error("the DICOM index is open by another program (a -wal/-journal file is present); close it and try again");
  }

  // JSON, not tabs: sqlite3 3.54 (macOS's) QUOTES a value with a space in `.mode tabs`, so a file named
  // "slice 1.dcm" came back as "\"slice 1.dcm\"", matched no row, and was left on disk while its series was
  // reported deleted -- 11,611 such files in Ron's index (critic, 2026-09-23, O1). Every other reader
  // of the index already used JSON.
  const raw = (await sqlite(dbPath, `.mode json\nSELECT Filename AS f FROM Images WHERE SeriesInstanceUID=${q(seriesUID)};`)).trim();
  const rows = (raw ? JSON.parse(raw) as { f: string | null }[] : []).map((r) => r.f ?? "").filter(Boolean);
  if (!rows.length) {
    const present = (await sqlite(dbPath, `SELECT COUNT(*) FROM Series WHERE SeriesInstanceUID=${q(seriesUID)};`)).trim();
    if (present === "0") throw new Error("no such series in this database");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${dbPath}.backup-${stamp}`;
  await Deno.copyFile(dbPath, backup);

  let images = 0, series = 0;
  try {
    const out = await sqlite(
      dbPath,
      `BEGIN IMMEDIATE;
DELETE FROM Images WHERE SeriesInstanceUID=${q(seriesUID)};
SELECT changes();
DELETE FROM Series WHERE SeriesInstanceUID=${q(seriesUID)};
SELECT changes();
COMMIT;`,
      false,
    );
    const counts = out.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
    images = counts[0] ?? 0;
    series = counts[1] ?? 0;
  } catch (e) {
    await Deno.remove(backup).catch(() => {});               // SQLite rolled back; nothing to put back
    throw new Error(`delete failed and was rolled back: ${(e as Error).message}`);
  }

  // Files last, and only those NO surviving row references — a file shared with another series is
  // not this series' to delete, and the rows are already gone so the check is against what remains.
  // ONE QUERY per 500 names, not one sqlite3 process per file: that was ~27 ms a file, 70 s for the heart
  // series' 2,665 (code review 2026-09-24, A3).
  const still = new Set<string>();
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const got = (await sqlite(dbPath, `.mode json\nSELECT DISTINCT Filename AS f FROM Images WHERE Filename IN (${part.map(q).join(",")});`)).trim();
    for (const r of (got ? JSON.parse(got) as { f: string }[] : [])) still.add(r.f);
  }
  // AND ONLY FILES INSIDE THE DATABASE FOLDER. A row can name a file indexed where it lay (an absolute path,
  // or one with ".."): that file is the person's own, not the database's, and is left in place (A9). What is
  // removed is THE PATH THE ROW NAMES, never what a link there points at: resolving links first removed another
  // series' file through a link (critic, 2026-09-24, review-bugfixes finding 2).
  const files: string[] = [];
  const leftInPlace: string[] = [];
  for (const rel of rows) {
    if (still.has(rel)) continue;
    // An absolute row under the database folder itself is the database's too.
    const abs = rel.startsWith(dbDir + "/") && !rel.split("/").includes("..");
    if (!abs && !insideDatabase(rel)) { leftInPlace.push(rel); continue; }
    if (await Deno.remove(abs ? rel : `${dbDir}/${rel}`).then(() => true).catch(() => false)) files.push(rel);
  }
  if (leftInPlace.length) console.warn(`delete ${seriesUID}: ${leftInPlace.length} file(s) outside the database folder left in place, e.g. ${leftInPlace[0]}`);

  // The derivation edge goes with it. A dangling edge would keep drawing the deleted series as a
  // parent of something, which is the "zombie" the audit exists to catch, one level up.
  // Its duckn working copy too: derived from this series alone, it would be the orphan the audit
  // below then reports (critic, 2026-09-23, finding 12).
  const copyRemoved = await removeDucknCopy(dbDir, seriesUID);

  let edges = 0;
  const provPath = provenancePathFor(dbDir);
  try {
    await Deno.stat(provPath);
    const before = Number((await sqlite(provPath, "SELECT COUNT(*) FROM ProvenanceEdges;")).trim());
    await sqlite(
      provPath,
      `DELETE FROM ProvenanceEdges WHERE child_series_uid=${q(seriesUID)} OR parent_series_uid=${q(seriesUID)};`,
      false,
    );
    edges = before - Number((await sqlite(provPath, "SELECT COUNT(*) FROM ProvenanceEdges;")).trim());
  } catch { /* no provenance store: nothing to unlink */ }

  const audit = await auditDatabase(dbDir);
  // THE BACKUP IS KEPT FOR ZOMBIES ONLY (rows whose file is missing), the rule the index path has had since
  // 09-18: any standing orphan kept a 14 MB copy of the index after every delete (code review, LS 5).
  const extra = leftInPlace.length ? { leftInPlace } : {};
  if (audit.zombies.length === 0) {
    await Deno.remove(backup).catch(() => {});
    return { series, images, files, edges, copyRemoved, audit, ...extra };
  }
  return { series, images, files, edges, copyRemoved, audit, backup, error: "the audit found rows without files; the pre-delete backup has been kept", ...extra };
}
