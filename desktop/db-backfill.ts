// Recover the derivation tree from the files that already carry it.
//
// Indexing records a segmentation's parent from now on (db-index.ts), but the archive predates that:
// 140 segmentations, one edge, so the DICOM browser drew every derived series as a top-level row.
// Ron, on the one I corrected by hand: "nephrogenic is just an example for many more to come." A
// hand-repair of one row leaves the rest broken and guarantees the same report next week, so the
// sweep is a function with tests rather than a script that ran once.
//
// The truth is already on disk. A SEG names the series it was drawn on in ReferencedSeriesSequence
// (0008,1115) -> SeriesInstanceUID (0020,000E). Nothing here guesses: a series whose file does not
// say what it came from stays unlinked and is reported, because a plausible-looking wrong parent is
// worse than a flat row.
//
// WHY A PARSER AND NOT dcmjs: these files run to 933 MB and dcmjs reads the whole thing to hand back
// one UID. The tag we want sits in the first few KB, before PixelData, so this reads a bounded prefix
// and walks elements until it finds it. A full-archive sweep is then seconds rather than minutes of
// disk churn -- and it never has to hold a 933 MB buffer to answer a question about 64 bytes.
import { provenancePathFor, recordProvenanceEdge } from "./db-index.ts";

const SQLITE = "/usr/bin/sqlite3";
/** Explicit-VR value representations whose length is 4 bytes after 2 reserved, not 2. */
const LONG_VR = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "SQ", "UT", "UN", "OB "]);
const TAG_REF_SERIES = 0x00081115;
const TAG_SERIES_UID = 0x0020000e;
const TAG_PIXEL_DATA = 0x7fe00010;
const TAG_ITEM = 0xfffee000;
const TAG_ITEM_DELIM = 0xfffee00d;
const TAG_SEQ_DELIM = 0xfffee0dd;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
/** DICOM pads values to even length with NUL or space; UIDs must come back exactly. */
const clean = (s: string) => s.replace(/[\0 ]+$/, "").trim();

interface Walk {
  b: Uint8Array;
  v: DataView;
  end: number;
  explicit: boolean;
}

/**
 * One element header at `pos`. Returns where the value starts, its length and the next element,
 * or null when the buffer runs out mid-header (a prefix that was read too short).
 */
function element(w: Walk, pos: number): { tag: number; start: number; len: number; next: number } | null {
  if (pos + 8 > w.end) return null;
  const group = w.v.getUint16(pos, true), elem = w.v.getUint16(pos + 2, true);
  const tag = ((group << 16) >>> 0) + elem;
  // Item and delimiter tags never carry a VR, in either encoding.
  if (group === 0xfffe) {
    const len = w.v.getUint32(pos + 4, true);
    return { tag, start: pos + 8, len, next: len === 0xffffffff ? pos + 8 : pos + 8 + len };
  }
  if (!w.explicit) {
    const len = w.v.getUint32(pos + 4, true);
    return { tag, start: pos + 8, len, next: len === 0xffffffff ? pos + 8 : pos + 8 + len };
  }
  const vr = ascii(w.b, pos + 4, 2);
  if (LONG_VR.has(vr)) {
    if (pos + 12 > w.end) return null;
    const len = w.v.getUint32(pos + 8, true);
    return { tag, start: pos + 12, len, next: len === 0xffffffff ? pos + 12 : pos + 12 + len };
  }
  const len = w.v.getUint16(pos + 6, true);
  return { tag, start: pos + 8, len, next: pos + 8 + len };
}

/**
 * Where an undefined-length sequence ends: its own delimiter, counting nested ones.
 *
 * This is the whole reason the walk has to understand nesting. ReferencedSeriesSequence's item holds
 * ReferencedInstanceSequence -- one entry per referenced slice, so 1,300+ items -- and it comes
 * BEFORE SeriesInstanceUID in tag order. A flat scan meets that inner sequence's delimiter first and
 * concludes the outer one ended, which is exactly how this returned "no parent" for a file that
 * plainly states its parent.
 */
function afterSequence(w: Walk, start: number): number {
  let p = start, depth = 1;
  while (p < w.end && depth > 0) {
    const e = element(w, p);
    if (!e) return w.end;
    if (e.tag === TAG_SEQ_DELIM) { depth--; p = e.next; continue; }
    if (e.tag === TAG_ITEM || e.tag === TAG_ITEM_DELIM) {
      p = e.len === 0xffffffff ? e.start : e.next;
      continue;
    }
    if (e.len === 0xffffffff) { depth++; p = e.start; continue; }         // a nested sequence
    p = e.next;
  }
  return p;
}

/** SeriesInstanceUID directly inside one sequence item, stepping OVER any sequence nested in it. */
function uidInItem(w: Walk, from: number, to: number): string | null {
  let p = from;
  while (p < to) {
    const e = element(w, p);
    if (!e) return null;
    if (e.tag === TAG_ITEM_DELIM || e.tag === TAG_SEQ_DELIM) return null; // this item is over
    if (e.tag === TAG_SERIES_UID && e.len !== 0xffffffff) return clean(ascii(w.b, e.start, e.len));
    p = e.len === 0xffffffff ? afterSequence(w, e.start) : e.next;
    if (p <= from) return null;                                           // no forward progress
  }
  return null;
}

/** The referenced series named by a sequence's items. */
function seriesUidWithin(w: Walk, from: number, to: number): string | null {
  let p = from;
  while (p < to) {
    const e = element(w, p);
    if (!e) return null;
    if (e.tag === TAG_SEQ_DELIM) return null;
    if (e.tag === TAG_ITEM) {
      const end = e.len === 0xffffffff ? to : Math.min(e.start + e.len, to);
      const uid = uidInItem(w, e.start, end);
      if (uid) return uid;
      p = e.len === 0xffffffff ? afterSequence(w, e.start) : e.next;
      continue;
    }
    p = e.next;
  }
  return null;
}

/**
 * The series a file says it was derived from, or null if it does not say.
 *
 * Reads only what it needs: `prefix` bytes, and never the pixel data.
 */
export function referencedSeriesUidOf(bytes: Uint8Array): string | null {
  if (bytes.length < 132 || ascii(bytes, 128, 4) !== "DICM") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The file meta group is ALWAYS explicit VR little endian, whatever the dataset uses.
  const meta: Walk = { b: bytes, v, end: bytes.length, explicit: true };
  let pos = 132, syntax = "1.2.840.10008.1.2.1", metaEnd = bytes.length;
  for (;;) {
    const e = element(meta, pos);
    if (!e || (e.tag >>> 16) !== 0x0002) break;
    if (e.tag === 0x00020000) metaEnd = e.next + v.getUint32(e.start, true);
    if (e.tag === 0x00020010) syntax = clean(ascii(bytes, e.start, e.len));
    pos = e.next;
    if (pos >= metaEnd) break;
  }
  if (syntax === "1.2.840.10008.1.2.2") return null;                      // big endian: not produced here
  const w: Walk = { b: bytes, v, end: bytes.length, explicit: syntax !== "1.2.840.10008.1.2" };

  for (let p = Math.min(pos, metaEnd); p < w.end;) {
    const e = element(w, p);
    if (!e) return null;
    if (e.tag === TAG_PIXEL_DATA) return null;                            // gone past it; it is not here
    if (e.tag === TAG_REF_SERIES) {
      const to = e.len === 0xffffffff ? w.end : Math.min(e.start + e.len, w.end);
      return seriesUidWithin(w, e.start, to);
    }
    p = e.next;
  }
  return null;
}

/** Read a bounded prefix of a file — never the whole 933 MB of it. */
async function prefixOf(path: string, n: number): Promise<Uint8Array> {
  using f = await Deno.open(path, { read: true });
  const buf = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const r = await f.read(buf.subarray(got));
    if (r === null) break;
    got += r;
  }
  return buf.subarray(0, got);
}

/** The referenced series of a file on disk, growing the read once if the tag sits unusually deep. */
export async function referencedSeriesOfFile(path: string): Promise<string | null> {
  for (const n of [256 * 1024, 8 * 1024 * 1024]) {
    const bytes = await prefixOf(path, n);
    const uid = referencedSeriesUidOf(bytes);
    if (uid) return uid;
    if (bytes.length < n) return null;                                     // whole file read; it is not there
  }
  return null;
}

async function sqlite(dbPath: string, sql: string): Promise<string> {
  const p = new Deno.Command(SQLITE, {
    args: ["-readonly", dbPath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(sql));
  await w.close();
  const { code, stdout, stderr } = await p.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr).trim() || `sqlite3 exited ${code}`);
  return new TextDecoder().decode(stdout);
}

export interface BackfillResult {
  /** Series considered: derived modalities with no derivation edge yet. */
  scanned: number;
  /** Edges written. */
  linked: number;
  /** Their file names its parent, but that series is not in this database. */
  parentMissing: string[];
  /** The file does not say what it was derived from; left flat rather than guessed at. */
  unstated: string[];
  /** The file could not be read at all. */
  unreadable: string[];
}

/**
 * Give every derived series in a database the parent its own file names.
 *
 * Idempotent: a series that already has a derivation edge is skipped, so this can be re-run after
 * an import without disturbing what is already there. Notes are never touched.
 */
export async function backfillProvenance(
  dbDir: string,
  opts: { modalities?: string[]; onProgress?: (done: number, total: number, what: string) => void } = {},
): Promise<BackfillResult> {
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  const mods = opts.modalities ?? ["SEG"];
  const inList = mods.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");

  // JSON throughout: `.mode tabs` quotes values with spaces in sqlite3 3.54 (critic, 2026-09-23, O1), and
  // a description or a file name with a space is the ordinary case.
  const json = async <T>(path: string, sql: string): Promise<T[]> => {
    const raw = (await sqlite(path, `.mode json\n${sql}`)).trim();
    return raw ? JSON.parse(raw) as T[] : [];
  };
  const rows = (await json<{ uid: string; desc: string; file: string | null }>(
    dbPath,
    `SELECT s.SeriesInstanceUID AS uid, COALESCE(s.SeriesDescription,'') AS desc,
       (SELECT i.Filename FROM Images i WHERE i.SeriesInstanceUID = s.SeriesInstanceUID LIMIT 1) AS file
     FROM Series s WHERE s.Modality IN (${inList});`,
  )).map((r) => [r.uid, r.desc, r.file ?? ""] as const);

  const known = new Set((await json<{ uid: string }>(dbPath, "SELECT SeriesInstanceUID AS uid FROM Series;")).map((r) => r.uid));

  // Which already have a derivation edge. Absent store = nothing has one yet.
  const provPath = provenancePathFor(dbDir);
  let linkedAlready = new Set<string>();
  try {
    await Deno.stat(provPath);
    linkedAlready = new Set(
      (await json<{ uid: string }>(provPath, "SELECT child_series_uid AS uid FROM ProvenanceEdges WHERE kind<>'note';")).map((r) => r.uid),
    );
  } catch { /* no provenance store yet: everything is a candidate */ }

  const todo = rows.filter(([uid]) => !linkedAlready.has(uid));
  const out: BackfillResult = { scanned: todo.length, linked: 0, parentMissing: [], unstated: [], unreadable: [] };

  let done = 0;
  for (const [uid, desc, file] of todo) {
    opts.onProgress?.(++done, todo.length, desc || uid);
    if (!file) { out.unreadable.push(desc || uid); continue; }
    const path = file.startsWith("/") ? file : `${dbDir}/${file}`;
    let parent: string | null = null;
    try {
      parent = await referencedSeriesOfFile(path);
    } catch {
      out.unreadable.push(desc || uid);
      continue;
    }
    if (!parent) { out.unstated.push(desc || uid); continue; }
    if (!known.has(parent)) { out.parentMissing.push(desc || uid); continue; }
    await recordProvenanceEdge(dbDir, uid, {
      parentSeriesUID: parent,
      kind: "algorithm",
      label: desc || "derived series",
    });
    out.linked++;
  }
  return out;
}
