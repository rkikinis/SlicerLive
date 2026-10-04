// ADD DICOM FILES FROM DISK TO A DATABASE -- the import Albula did not have.
//
// Ron, 2026-10-01: the resident's scans "sit somewhere on the disk" (copied from the scanner, a CD, a USB stick), and
// Load / Save should offer "load to database with an option to create your own ... exposed when someone clicks on load
// from disk". Until now Albula wrote only its own results into a database; a folder of DICOM could be viewed and that
// was all, so a patient's scans could not be kept without Slicer. "Albula has to be selfcontained."
//
// What it does, given a list of files (a folder the person chose, or files a page uploaded to the staging folder):
//   1. reads each file's header (logic/readers/dicom-head.ts -- the first megabyte, more only when the identifiers
//      lie past it) and keeps the DICOM ones that name an instance, a series and a study; a DICOMDIR (a disc's table
//      of contents) is not an image; a file in a form the header reader does not read (big endian, deflated) is said
//      to be that, not "not an image";
//   2. leaves out instances the database already holds (by SOPInstanceUID), and repeats within the batch;
//   3. copies the new files to where Slicer's own import puts them (desktop/md5.ts) -- a file already at its place is
//      left as it is -- and indexes the series (desktop/db-index.ts, indexImportedSeries: one backup, one audit, a
//      transaction per series, patients by ID and name, the columns Slicer fills);
//   4. a series that does not go in has the copies THIS import made taken back out, and only those: another import of
//      the same files may have put them there and indexed them (critic, 2026-10-01, finding 1).
// Imports into one database run one at a time (desktop/db-serve.ts), so "already there" is always current.
// The originals are never touched (the staging folder's uploads are moved, then the folder removed). Copying, not
// linking (Ron: the patient stays after the stick is gone; IRB data in one known place).
import { readDicomHead } from "../logic/readers/dicom-head.ts";
import { DEFLATED_EXPLICIT_VR_LE, datasetOffset } from "../logic/dicom-deflate.ts";
import { IMPORT_FOLDER, indexImportedSeries, knownInstances, type AuditResult, type ImportSeries } from "./db-index.ts";
import { ctkInstancePath } from "./md5.ts";

export { IMPORT_FOLDER };

const UID = /^[0-9][0-9.]{0,63}$/;
const DICOMDIR_CLASS = "1.2.840.10008.1.3.10";
const NOT_READ_YET: Record<string, string> = { "1.2.840.10008.1.2.2": "big endian" };
const HEAD_BYTES = 1 << 20, HEAD_MAX = 64 << 20;

export interface ImportProgress { phase: "reading" | "adding" | "done"; files: number; read: number; dicom: number; series: number; seriesDone: number }

export interface ImportedSeries { uid: string; studyUID: string; patientID: string; patientName: string; modality: string; description: string; instances: number }

export interface ImportResult {
  /** Series added, each with the images this import added to it. */
  series: ImportedSeries[];
  patients: number;
  studies: number;
  instances: number;
  /** FILES whose image the database already held (one image in two files counts twice), left alone. */
  already: number;
  /** Files and folders not added, with the reason; at most 200 named (the count is `skippedCount`). */
  skipped: { file: string; reason: string }[];
  skippedCount: number;
  /** Series that could not be added, with the reason; the copies this import made for them were taken back. */
  failed: { uid: string; description: string; error: string }[];
  /** Things the person should know that are not failures (a series whose files named different studies, say). */
  notes: string[];
  audit?: AuditResult;
  ms: number;
}

/**
 * Every regular file under `folder`. Hidden entries are left out; symbolic links and folders that cannot be read are
 * left out AND listed (critic, 2026-10-01, findings 12 and 20), so one protected subfolder does not stop the import.
 * Folders in `exclude` (the databases themselves) are not entered (finding 11).
 */
export async function filesUnder(folder: string, exclude: string[] = []): Promise<{ files: string[]; left: { file: string; reason: string }[] }> {
  const files: string[] = [], left: { file: string; reason: string }[] = [];
  const skip = new Set(exclude.map((p) => p.replace(/\/+$/, "")));
  const walk = async (dir: string) => {
    if (skip.has(dir)) { left.push({ file: dir, reason: "a DICOM database's own folder; not added to itself or to another" }); return; }
    let entries: Deno.DirEntry[];
    try { entries = await Array.fromAsync(Deno.readDir(dir)); }
    catch (e) { left.push({ file: dir, reason: `a folder that could not be read (${(e as Error).name})` }); return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isSymlink) left.push({ file: p, reason: "a link to somewhere else; choose the folder it points to instead" });
      else if (e.isDirectory) await walk(p);
      else if (e.isFile) files.push(p);
    }
  };
  await walk(folder.replace(/\/+$/, ""));
  return { files, left };
}

async function head(path: string): Promise<{ h: Map<string, string>; size: number }> {
  using f = await Deno.open(path, { read: true });
  const size = (await f.stat()).size;
  const read = async (n: number) => {
    const buf = new Uint8Array(Math.min(size, n));
    await f.seek(0, Deno.SeekMode.Start);
    let got = 0;
    while (got < buf.length) { const k = await f.read(buf.subarray(got)); if (!k) break; got += k; }
    return readDicomHead(buf.buffer.slice(0, got));
  };
  let h = await read(HEAD_BYTES);
  // A large private element before the identifiers (finding 18): read further, up to 64 MB, before giving up.
  if (!h.get("0020000E") && size > HEAD_BYTES && h.get("00020010") !== DEFLATED_EXPLICIT_VR_LE) h = await read(HEAD_MAX);
  // DEFLATED (2026-10-02): the form Albula itself saves label-map segmentations in (logic/dicom-deflate.ts). Importing
  // one -- a tumor outline from the test cases into the working database -- skipped it as "a form Albula cannot read
  // yet". The meta group is plain; the dataset after it is one deflate stream: the beginning of it is inflated (enough
  // for the identifiers) and read. The file is copied as it is; the loader reads the deflated form.
  if (h.get("00020010") === DEFLATED_EXPLICIT_VR_LE && !h.get("0020000E")) {
    await f.seek(0, Deno.SeekMode.Start);
    const all = new Uint8Array(Math.min(size, HEAD_MAX));
    let got = 0;
    while (got < all.length) { const k = await f.read(all.subarray(got)); if (!k) break; got += k; }
    const body = await inflatePrefix(all.subarray(datasetOffset(all), got), HEAD_BYTES);
    for (const [k, v] of readDicomHead(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)) if (!h.has(k)) h.set(k, v);
  }
  return { h, size };
}

/** The first `max` bytes (or all, if fewer) of a raw deflate stream; the rest is not inflated. */
async function inflatePrefix(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = []; let n = 0;
  try {
    while (n < max) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

interface Found { path: string; sop: string; study: string; series: string; h: Map<string, string> }

const val = (h: Map<string, string>, t: string) => { const v = h.get(t); return v === undefined || v === "" ? undefined : v; };

/** What the index records for a series, from its first file's header. */
function rowsFor(first: Found, files: { file: string; sop: string }[]): ImportSeries {
  const g = (t: string) => val(first.h, t);
  const rows = g("00280010"), cols = g("00280011");
  return {
    seriesUID: first.series, studyUID: first.study, files,
    // No patient ID: the study's UID stands in, as Slicer's indexer does (critic, 2026-10-01, finding 5), so the same
    // disc read by either program gives the same patient.
    patient: { name: g("00100010") ?? "", id: g("00100020") ?? first.study, birthDate: g("00100030"), sex: g("00100040"), age: g("00101010") },
    study: { date: g("00080020"), time: g("00080030"), description: g("00081030"), id: g("00200010"), accession: g("00080050"),
      institution: g("00080080"), referring: g("00080090"), performing: g("00081050") },
    series: { modality: g("00080060") ?? "OT", number: g("00200011"), date: g("00080021"), time: g("00080031"), description: g("0008103E"),
      bodyPart: g("00180015"), frameOfReference: g("00200052"), acquisitionNumber: g("00200012"), contrastAgent: g("00180010"),
      scanningSequence: g("00180020"), echoNumber: g("00180086"), temporalPosition: g("00200100"),
      displayedSize: rows && cols ? `${cols}x${rows}` : undefined, numberOfFrames: g("00280008") },
  };
}

const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

/**
 * Add `files` (absolute paths) to the database in `dbDir`. `move` is for the staging folder's uploads only: they are
 * renamed into place instead of copied. `left` are entries the folder walk left out, reported with the rest. Never
 * throws for one bad file or one bad series; says what happened to each.
 */
export async function importFiles(dbDir: string, files: string[], opts: { move?: boolean; left?: { file: string; reason: string }[]; onProgress?: (p: ImportProgress) => void } = {}): Promise<ImportResult> {
  const t0 = performance.now();
  const prog: ImportProgress = { phase: "reading", files: files.length, read: 0, dicom: 0, series: 0, seriesDone: 0 };
  const skipped: { file: string; reason: string }[] = [];
  let skippedCount = 0;
  const skip = (file: string, reason: string) => { skippedCount++; if (skipped.length < 200) skipped.push({ file, reason }); };
  for (const l of opts.left ?? []) skip(l.file, l.reason);
  const notes: string[] = [];

  // 1. READ THE HEADERS.
  const found: Found[] = [];
  for (const path of files) {
    prog.read++;
    if (prog.read % 50 === 0) opts.onProgress?.({ ...prog });
    let h: Map<string, string>, size: number;
    try { ({ h, size } = await head(path)); } catch (e) { skip(path, `could not be read (${(e as Error).message})`); continue; }
    if (size < 132) { skip(path, "too small to be a DICOM file"); continue; }
    if (h.get("00020002") === DICOMDIR_CLASS || h.get("00080016") === DICOMDIR_CLASS) { skip(path, "a DICOMDIR (a disc's table of contents), not an image"); continue; }
    const sop = h.get("00080018") ?? "", study = h.get("0020000D") ?? "", series = h.get("0020000E") ?? "";
    if (!UID.test(sop) || !UID.test(study) || !UID.test(series)) {
      const form = NOT_READ_YET[h.get("00020010") ?? ""];
      skip(path, form ? `a DICOM file in a form Albula cannot read yet (${form})` : "not a DICOM image (no instance, series and study identifiers)");
      continue;
    }
    found.push({ path, sop, study, series, h });
    prog.dicom++;
  }

  // 2. WHAT THE DATABASE ALREADY HOLDS, and repeats within the batch (the same image twice on a disc).
  const known = await knownInstances(dbDir, found.map((f) => f.sop));
  const seen = new Set<string>();
  let already = 0;
  const bySeries = new Map<string, Found[]>();
  for (const f of found) {
    if (known.has(f.sop)) { already++; continue; }
    if (seen.has(f.sop)) { skip(f.path, "the same image is in two files; added once"); continue; }
    seen.add(f.sop);
    const list = bySeries.get(f.series) ?? [];
    list.push(f);
    bySeries.set(f.series, list);
  }

  // 3. COPY. A series is filed under ONE study, its first file's: some anonymizers give each file of a series its own
  // study identifier, and keeping only the files that agree thinned the scan out (finding 9). Said, not hidden.
  prog.phase = "adding"; prog.series = bySeries.size;
  opts.onProgress?.({ ...prog });
  const created = new Map<string, string[]>();     // series -> files THIS import put in place
  const batch: ImportSeries[] = [];
  const failed: ImportResult["failed"] = [];
  const description = (list: Found[]) => list[0].h.get("0008103E") ?? "";
  for (const [uid, list] of bySeries) {
    const first = list[0];
    if (list.some((f) => f.study !== first.study)) notes.push(`The images of “${description(list) || "a scan"}” named ${new Set(list.map((f) => f.study)).size} different studies; all were filed under the first.`);
    const mine: string[] = [], placed: { file: string; sop: string }[] = [];
    try {
      for (const f of list) {
        const rel = ctkInstancePath(first.study, f.series, f.sop);
        const dest = `${dbDir}/${rel}`;
        if (!(await exists(dest))) {
          await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
          if (opts.move) await Deno.rename(f.path, dest); else await Deno.copyFile(f.path, dest);
          mine.push(rel);
        }
        placed.push({ file: rel, sop: f.sop });
      }
      created.set(uid, mine);
      batch.push(rowsFor(first, placed));
    } catch (e) {
      for (const rel of mine) await Deno.remove(`${dbDir}/${rel}`).catch(() => {});
      failed.push({ uid, description: description(list), error: `could not be copied: ${(e as Error).message}` });
      prog.seriesDone++;
    }
  }

  // 4. INDEX, all series under one lock, one backup and one audit.
  const series: ImportedSeries[] = [];
  let audit: AuditResult | undefined;
  if (batch.length) {
    let r: Awaited<ReturnType<typeof indexImportedSeries>> | undefined;
    try {
      r = await indexImportedSeries(dbDir, batch, () => { prog.seriesDone++; opts.onProgress?.({ ...prog }); });
      audit = r.audit;
    } catch (e) {
      r = { results: batch.map((b) => ({ seriesUID: b.seriesUID, error: (e as Error).message })), audit: undefined as unknown as AuditResult };
    }
    for (const res of r.results) {
      const list = bySeries.get(res.seriesUID)!, first = list[0];
      if (res.error) {
        for (const rel of created.get(res.seriesUID) ?? []) await Deno.remove(`${dbDir}/${rel}`).catch(() => {});
        failed.push({ uid: res.seriesUID, description: description(list), error: res.error });
        continue;
      }
      series.push({ uid: res.seriesUID, studyUID: first.study, patientID: first.h.get("00100020") ?? "", patientName: first.h.get("00100010") ?? "",
        modality: first.h.get("00080060") ?? "OT", description: description(list), instances: list.length });
    }
  }

  prog.phase = "done";
  opts.onProgress?.({ ...prog });
  return {
    series, failed, already, skipped, skippedCount, notes, audit,
    patients: new Set(series.map((s) => `${s.patientID || s.studyUID}\u0000${s.patientName}`)).size,
    studies: new Set(series.map((s) => s.studyUID)).size,
    instances: series.reduce((n, s) => n + s.instances, 0),
    ms: Math.round(performance.now() - t0),
  };
}
