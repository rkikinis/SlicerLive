// THE PRIVATE-FIELDS CHECK OF A DATABASE, on disk (logic/readers/private-survey.ts says what it is and why): one small
// file per series, SlicerAlbula-Cache/private-fields-<uid>.json -- derived from the series' files alone, made again when
// missing, of another version, or of another list of files, and removed with the series like every cache file named
// with its UID (db-index.ts deleteSeriesFromDatabase).
//
// Made at import (db-import.ts, after the index takes a series, from the files the index then lists for it) and, for
// series a database already held or whose files changed since, by a check the Databases section starts when asked
// (db-serve.ts, /_db/<id>/_private-fields?check=1).
// A long series is SAMPLED: SAMPLE of its files, spread evenly over its list sorted by name. The names in a database are
// hashes, so this is in effect a random sample of its images, not its first and last acquired; a block held by one image
// in 300 is missed most of the time. Measured on Ron's six databases (critic 2026-10-29, every file of every series
// walked against each record): nothing missed. Said in each record ("looked: 8 of 300") and in the window.
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import { DEFAULT_LIST } from "./extension-hooks.ts";
import { indexSeries } from "./series-files.ts";
import { sqliteScript } from "./sqlite.ts";
import {
  compareWithReaders, mergeBlocks, PRIVATE_SURVEY_VERSION, privateBlocksOf, privateReads, registerPrivateReads, spreadSample,
  unregisterPrivateReads, type BlockRow, type FileBlocks, type PrivateRead, type SeriesPrivateSurvey,
} from "../logic/readers/private-survey.ts";

/**
 * THE PRIVATE ELEMENTS EACH EXTENSION READS: data its manifest names under "privateReads" ({version, reads: [{group,
 * creator, elements, what, part?}]}), registered under the extension's name. Data and not code, and read here rather
 * than in extension-hooks.ts: the working copy's fingerprint covers that file and the tracts' fingerprint the
 * extension's hooks, so declaring what is read changes no copy and no stored result. Read again on every call (two small
 * files): an extension turned off, or an updated list, counts at once. `list` undefined: no extension list was found
 * (the app outside the workspace), said in the summary rather than passed over.
 */
let extensionReaders: string[] = [];
export function registerExtensionPrivateReads(list: string | undefined = Deno.env.get("ALBULA_EXTENSIONS") ?? DEFAULT_LIST): { found: boolean; readers: string[] } {
  for (const r of extensionReaders) unregisterPrivateReads(r);
  extensionReaders = [];
  if (list === "none") return { found: true, readers: [] };
  const dirname = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
  const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
  let parsed: { extensions?: { name?: string; path: string; on: boolean }[] };
  try { parsed = JSON.parse(Deno.readTextFileSync(list!)); } catch { return { found: false, readers: [] }; }
  for (const e of parsed.extensions ?? []) {
    if (!e.on) continue;
    const dir = join(dirname(list!), e.path);
    try {
      const m = JSON.parse(Deno.readTextFileSync(join(dir, "extension.json"))) as { name?: string; privateReads?: string };
      if (!m.privateReads) continue;
      const d = JSON.parse(Deno.readTextFileSync(join(dir, m.privateReads))) as { reads?: PrivateRead[] };
      if (Array.isArray(d.reads)) { const name = e.name ?? m.name ?? e.path; registerPrivateReads(name, d.reads); extensionReaders.push(name); }
    } catch (err) { console.warn(`${e.path}: its private reads could not be read (${(err as Error).message})`); }
  }
  return { found: true, readers: [...extensionReaders] };
}

export const SAMPLE = 8;
const CACHE = "SlicerAlbula-Cache";
const UID = /^[0-9][0-9.]{0,63}$/;
export const surveyPath = (dbDir: string, uid: string) => `${dbDir}/${CACHE}/private-fields-${uid}.json`;

/** One file's blocks, read from disk as the walk needs them (a value it does not walk into is skipped, not read). A
 *  deflated file (Albula writes its segmentations so) is inflated and walked again. `why`: set when the file was not
 *  read in full, in words. */
export async function fileBlocks(path: string): Promise<FileBlocks & { why?: string }> {
  const f = Deno.openSync(path, { read: true });
  let r: FileBlocks;
  try {
    const size = f.statSync().size;
    r = privateBlocksOf({
      size,
      read(pos, len) {
        const buf = new Uint8Array(Math.max(0, Math.min(len, size - pos)));
        f.seekSync(pos, Deno.SeekMode.Start);
        let got = 0;
        while (got < buf.length) { const k = f.readSync(buf.subarray(got)); if (k === null) break; got += k; }
        return buf.subarray(0, got);
      },
    });
  } finally { f.close(); }
  if (r.deflated === undefined) return { ...r, ...whyOf(r) };
  return await deflatedBlocks(path, r.deflated);
}

/**
 * A DEFLATED FILE (Albula writes its segmentations so): inflated as a stream with Node's zlib -- which, unlike the web's
 * DecompressionStream, also takes a file with a byte after its compressed data (one segmentation in Ron's main database;
 * pydicom reads it whole, and so does this) -- and walked in two parts: the data set up to its pixels, then, the pixels'
 * bytes passed over without being kept, whatever follows them (critic 2026-10-29, finding 8). Memory: the part before the
 * pixels and the part after, each up to PART_MAX.
 */
const PART_MAX = 64 << 20;
async function deflatedBlocks(path: string, at: number): Promise<FileBlocks & { why?: string }> {
  const stream = createReadStream(path, { start: at }).pipe(createInflateRaw());
  const it = (stream as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let done = false, failed = false, consumed = 0;
  const next = async (): Promise<Uint8Array | undefined> => {
    try { const x = await it.next(); if (x.done) { done = true; return undefined; } consumed += x.value.length; return x.value; }
    catch { failed = true; done = true; return undefined; }
  };
  try {
    const head: Uint8Array[] = [];
    while (consumed < PART_MAX && !done) { const c = await next(); if (c) head.push(c); }
    if (!consumed) return { blocks: new Map(), ended: "broken", why: "deflated, and nothing could be inflated" };
    const first = privateBlocksOf(concat(head), { dataSet: true, stopAtPixels: true });
    if (first.ended === "cut" && !done) return { ...first, why: `deflated, with more than ${PART_MAX >> 20} MB before its pixels: not walked to its end` };
    if (first.ended !== "pixels" || !first.pixelsAt) return { ...first, ...whyOf(first, failed) };
    if (first.pixelsAt.len === 0xffffffff) return { ...first, why: "deflated with its pixels in fragments: not walked past them" };
    // Past the pixels: the bytes from `after` on, as they come.
    const after = first.pixelsAt.value + first.pixelsAt.len;
    const headBytes = consumed;
    const tail: Uint8Array[] = [];
    if (after < headBytes) tail.push(concat(head).subarray(after));
    head.length = 0;
    let tailBytes = tail[0]?.length ?? 0;
    while (!done && tailBytes < PART_MAX) {
      const start = consumed, c = await next();
      if (!c || consumed <= after) continue;
      const from = Math.max(0, after - start);
      tail.push(c.subarray(from)); tailBytes += c.length - from;
    }
    if (consumed < after) return { ...first, ended: "cut", why: failed ? "deflated, and could not be inflated in full" : "cut short, or its pixels never come" };
    if (!done) return { ...first, why: `deflated, with more than ${PART_MAX >> 20} MB after its pixels: not walked to its end` };
    const rest = privateBlocksOf(concat(tail), { dataSet: true });
    const blocks = first.blocks;
    for (const [k, v] of rest.blocks) { const t = blocks.get(k); if (t) for (const e of v) t.add(e); else blocks.set(k, v); }
    const skipped = (first.skipped ?? 0) + (rest.skipped ?? 0);
    const out: FileBlocks = { blocks, ended: rest.ended === "end" ? "pixels" : rest.ended, ...(skipped ? { skipped } : {}) };
    return { ...out, ...whyOf(out, failed) };
  } catch { return { blocks: new Map(), ended: "broken", why: "deflated, and could not be inflated" }; }
  finally { stream.destroy(); }
}
const concat = (parts: Uint8Array[]) => {
  if (parts.length === 1) return parts[0];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
};
const whyOf = (r: FileBlocks, inflateFailed = false): { why?: string } =>
  inflateFailed ? { why: "deflated, and could not be inflated in full" }
  : r.ended === "cut" ? { why: "cut short, or its pixels never come" }
  : r.ended === "form" ? { why: "big endian, which this check does not read" }
  : r.ended === "broken" ? { why: "its bytes stop making sense" }
  : r.skipped ? { why: `${r.skipped} value${r.skipped === 1 ? "" : "s"} inside could not be read and ${r.skipped === 1 ? "was" : "were"} stepped over` } : {};

/** The index's files of every series, sorted, in one query: what a record is stamped with and made from. */
export async function indexFiles(dbDir: string): Promise<Map<string, string[]>> {
  const root = dbDir.replace(/\/+$/, "");
  const raw = (await sqliteScript(`${root}/ctkDICOM.sql`, ".timeout 5000\n.mode json\nSELECT SeriesInstanceUID AS s, Filename AS f FROM Images;", true).catch(() => "")).trim();
  const out = new Map<string, string[]>();
  for (const r of raw ? JSON.parse(raw) as { s: string; f: string }[] : []) {
    const l = out.get(r.s) ?? [];
    l.push(r.f.startsWith("/") ? r.f : `${root}/${r.f}`);
    out.set(r.s, l);
  }
  for (const l of out.values()) l.sort();
  return out;
}
/** A list of files as a short stamp: its count and an FNV-1a hash of the names. */
export function stampOf(files: string[]): string {
  let h = 0x811c9dc5;
  for (const f of files) for (let i = 0; i <= f.length; i++) { h ^= i < f.length ? f.charCodeAt(i) : 10; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${files.length}-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Survey one series and write its record: from the files the index lists for it now (`files`, when the caller has just
 * read them), never from one import's copies alone (critic 2026-10-29, finding 1: a second import of more images of a
 * series replaced the record with one of the new images only). A missing file is a file not read, said in the record.
 * The cache folder is made only inside a database folder that is there (finding 6: a check part-way through a series
 * whose database went to the Trash made the folder again).
 */
export async function surveySeries(dbDir: string, uid: string, files?: string[]): Promise<SeriesPrivateSurvey | undefined> {
  if (!UID.test(uid)) return undefined;
  const all = (files ?? (await indexFiles(dbDir)).get(uid) ?? []).slice().sort();
  if (!all.length) return undefined;
  const looked = spreadSample(all, SAMPLE);
  const results: FileBlocks[] = [];
  const notWhole: NonNullable<SeriesPrivateSurvey["notWhole"]> = [];
  const rel = (p: string) => p.startsWith(dbDir + "/") ? p.slice(dbDir.length + 1) : p;
  for (const p of looked) {
    try {
      const r = await fileBlocks(p);
      results.push(r);
      if (r.why) notWhole.push({ file: rel(p), why: r.why });
    } catch (e) { notWhole.push({ file: rel(p), why: e instanceof Deno.errors.NotFound ? "missing" : `could not be read (${(e as Error).message})` }); }
  }
  const s: SeriesPrivateSurvey = { survey: PRIVATE_SURVEY_VERSION, series: uid, files: { looked: looked.length, of: all.length }, stamp: stampOf(all),
    ...(notWhole.length ? { notWhole } : {}), blocks: mergeBlocks(results), made: new Date().toISOString() };
  try { await Deno.mkdir(`${dbDir}/${CACHE}`); } catch (e) { if (!(e instanceof Deno.errors.AlreadyExists)) return undefined; }
  // The temporary name keeps the UID as a whole name part, so the removal with the series takes a leftover one too.
  const tmp = `${dbDir}/${CACHE}/private-fields-${uid}.t${crypto.randomUUID().slice(0, 8)}.json`;
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(s, null, 1));
    await Deno.rename(tmp, surveyPath(dbDir, uid));
  } catch { await Deno.remove(tmp).catch(() => {}); return undefined; }
  return s;
}

/** A series' record as stored, when it is of the current version and (given `stamp`) of the same files. */
export async function readSurvey(dbDir: string, uid: string, stamp?: string): Promise<SeriesPrivateSurvey | undefined> {
  try {
    const s = JSON.parse(await Deno.readTextFile(surveyPath(dbDir, uid))) as SeriesPrivateSurvey;
    return s.survey === PRIVATE_SURVEY_VERSION && s.series === uid && (stamp === undefined || s.stamp === stamp) ? s : undefined;
  } catch { return undefined; }
}

/** What the Databases section shows for one database. "Series" counts every series of the index: images, segmentations,
 *  saved scenes. */
export interface PrivateFieldsSummary {
  survey: number;
  series: number;
  checked: number;
  /** Series holding at least one private element of a maker or program that no reader reads (a block no reader reads,
   *  or an element of a block read in part). Albula's own record is never counted. */
  withUnread: number;
  /** Series whose files were not all read in full (the record's notWhole): not a clean result. */
  notWhole: number;
  /** Series that cannot be checked: no files in the index, or an identifier that is not a DICOM UID. */
  cannot: number;
  /** Up to SAMPLE files of each series are looked at. */
  sample: number;
  blocks: (BlockRow & { seriesNames: string[] })[];
  readers: string[];
  /** False when no extension list was found: an extension's fields would show as not read. */
  extensionsFound: boolean;
  /** The check of the series not yet looked at, while it runs. */
  checking?: { done: number; of: number };
}

const running = new Map<string, { done: number; of: number }>();

/** Survey the given series one after the other; one run per database at a time. */
export function checkSeries(dbDir: string, todo: { uid: string; files: string[] }[]): { done: number; of: number } {
  const now = running.get(dbDir);
  if (now) return now;
  const state = { done: 0, of: todo.length };
  running.set(dbDir, state);
  (async () => {
    try { for (const t of todo) { await surveySeries(dbDir, t.uid, t.files).catch(() => undefined); state.done++; } }
    finally { running.delete(dbDir); }
  })();
  return state;
}

/** The summary: every series' stored record compared with what the readers (core's and the extensions') declare now.
 *  `startCheck`: series without a current record (none, another version, other files) are checked in the background. */
export async function privateFieldsSummary(dbDir: string, opts: { startCheck?: boolean; extensionList?: string } = {}): Promise<PrivateFieldsSummary> {
  const ext = registerExtensionPrivateReads(opts.extensionList ?? Deno.env.get("ALBULA_EXTENSIONS") ?? DEFAULT_LIST);
  const [index, files, patients] = await Promise.all([indexSeries(dbDir), indexFiles(dbDir), patientNames(dbDir)]);
  const surveys: SeriesPrivateSurvey[] = [];
  const name = new Map<string, string>();
  const todo: { uid: string; files: string[] }[] = [];
  let cannot = 0;
  for (const s of index) {
    const who = patients.get(String(s.patientUID));   // a number at run time, whatever the type says
    name.set(s.seriesUID, [who, [s.modality, s.seriesNumber && `#${s.seriesNumber}`, s.description].filter(Boolean).join(" ")].filter(Boolean).join(" · "));
    const f = files.get(s.seriesUID) ?? [];
    if (!UID.test(s.seriesUID) || !f.length) { cannot++; continue; }
    const v = await readSurvey(dbDir, s.seriesUID, stampOf(f));
    if (v) surveys.push(v); else todo.push({ uid: s.seriesUID, files: f });
  }
  const blocks = compareWithReaders(surveys).map((b) => ({ ...b, seriesNames: b.series.map((u) => name.get(u) || u) }));
  const unread = new Set(blocks.filter((b) => b.state === "not read" || (b.state === "partly read" && b.unread.length)).flatMap((b) => b.series));
  const out: PrivateFieldsSummary = {
    survey: PRIVATE_SURVEY_VERSION, series: index.length, checked: surveys.length, withUnread: unread.size,
    notWhole: surveys.filter((s) => s.notWhole?.length).length, cannot, sample: SAMPLE, blocks,
    readers: [...privateReads().keys()], extensionsFound: ext.found,
  };
  const checking = running.get(dbDir) ?? (opts.startCheck && todo.length ? checkSeries(dbDir, todo) : undefined);
  if (checking) out.checking = { ...checking };
  return out;
}

/** Patients by the index's key: name and ID, as the DICOM browser shows them. */
async function patientNames(dbDir: string): Promise<Map<string, string>> {
  const raw = (await sqliteScript(`${dbDir.replace(/\/+$/, "")}/ctkDICOM.sql`, ".timeout 5000\n.mode json\nSELECT UID AS u, COALESCE(PatientsName,'') AS n, COALESCE(PatientID,'') AS i FROM Patients;", true).catch(() => "")).trim();
  const out = new Map<string, string>();
  for (const r of raw ? JSON.parse(raw) as { u: string | number; n: string; i: string }[] : []) {
    const n = r.n.replace(/\^+/g, " ").trim();
    out.set(String(r.u), [n, r.i && r.i !== n && `(${r.i})`].filter(Boolean).join(" "));
  }
  return out;
}
