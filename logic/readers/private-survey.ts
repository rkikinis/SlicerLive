// WHICH VENDOR PRIVATE FIELDS A SERIES HOLDS, AND WHICH OF THEM ALBULA READS (Ron, 2026-10-29: "yes", to "an import check
// that lists, per series, the vendor private groups present that no reader interprets ... so a gap is visible rather than
// silent"). Vendors keep real information in private elements (Ron, 2026-09-25: Philips kept a diffusion scan's
// orientation there, undocumented). Albula reads a few of them -- the diffusion values, the Siemens mosaic layout --
// and keeps everything else untouched in the archive's original files (CLAUDE.md, the private-fields rule, refined
// 2026-10-29). Without this check, a scan whose essential fact sits in a private element no reader knows loads without
// it, and nothing says so.
//
// Two halves, kept apart on purpose:
//   1. WHAT THE FILES HOLD (privateBlocksOf): every private block -- a group and the creator string that reserved it
//      (PS3.5 §7.8.1) -- and the elements present in it, at any depth (an enhanced file's per-frame items included).
//      A fact about the files; it does not change when a reader does. Versioned by PRIVATE_SURVEY_VERSION.
//   2. WHAT THE READERS READ (registerPrivateReads): each reader declares the elements it reads -- core's Siemens mosaic
//      reader and the scene block here, an extension in a data file its manifest names (desktop/private-fields.ts).
//      Compared with (1) when asked (privateFieldsSummary), so a new or changed reader needs no new survey of the files.
// What is recorded: each block's creator string (which names the maker or program, sometimes an institution) and the
// element numbers present in it. No element's value.

// ── 2. What the readers read ──────────────────────────────────────────────────────────────────────────────────────

/** Elements of one private block that a reader reads. `elements`: the last two hex digits ("10" for (0029,xx10)). */
export interface PrivateRead {
  group: string; creator: string; elements: string[];
  /** What it is read for, in words. */
  what: string;
  /** Only some of what these elements hold is read (a few named values of Siemens' CSA header): the block counts as read in
   *  part, never as read. */
  part?: boolean;
}

import { MRCOM_CREATOR, MRCOM_GROUP, MRCOM_BLOB_TAGS, MRCOM_TAGS } from "../mrcom/format.ts";

const KEY = "__albulaPrivateReads";
const registry = (): Map<string, PrivateRead[]> => ((globalThis as Record<string, unknown>)[KEY] ??= new Map()) as Map<string, PrivateRead[]>;

/** A reader declares what it reads; declaring under the same name again replaces it. */
export function registerPrivateReads(reader: string, reads: PrivateRead[]): void {
  registry().set(reader, reads.map((r) => ({ ...r, group: r.group.toUpperCase(), creator: r.creator.trim(), elements: r.elements.map((e) => e.toUpperCase()) })));
}
/** What core's Siemens mosaic reader (siemens-mosaic.ts) reads. Kept here, not beside it: the working copy's code
 *  fingerprint covers siemens-mosaic.ts (desktop/make-copy-code.ts), and a declaration there would make every copy stale
 *  for a change that reads nothing differently. private-survey.test.ts checks it against every lookup in that file. */
export const MOSAIC_PRIVATE_READS: PrivateRead[] = [
  { group: "0029", creator: "SIEMENS CSA HEADER", elements: ["10"], what: "a mosaic's slice count and slice direction (the CSA image header)", part: true },
  { group: "0019", creator: "SIEMENS MR HEADER", elements: ["0A"], what: "a mosaic's slice count, when the CSA header has none" },
];
// Core's own readers: the Siemens mosaic, and the saved scene (Steve's MRCOM block, logic/mrcom/: every element of it).
registerPrivateReads("Siemens mosaic", MOSAIC_PRIVATE_READS);
registerPrivateReads("scenes", [{
  group: MRCOM_GROUP.toString(16).toUpperCase().padStart(4, "0"), creator: MRCOM_CREATOR, what: "a saved scene (its MRCOM block)",
  elements: [...new Set([...Object.values(MRCOM_TAGS), ...Object.values(MRCOM_BLOB_TAGS)].map((t) => t.offset.toString(16).toUpperCase().padStart(2, "0")))],
}]);
/** Take a reader's declaration out again (an extension turned off). */
export function unregisterPrivateReads(reader: string): void { registry().delete(reader); }
/** Every declaration, by reader. */
export const privateReads = (): ReadonlyMap<string, readonly PrivateRead[]> => registry();

// ── 1. What the files hold ────────────────────────────────────────────────────────────────────────────────────────

/** Version 2 (2026-10-29, after the critic, qa/2026-10-29-private-fields.md): a value inside that cannot be read is
 *  skipped and counted rather than ending the walk; an image whose pixels never come is "cut"; elements in a block no
 *  creator reserved are kept with their block number. Version 1 (the same day): blocks and the elements present, at
 *  every depth, in explicit and implicit VR little endian. Records of another version are made again. */
export const PRIVATE_SURVEY_VERSION = 2;

/** How far a walk of one file got. "pixels": to its end, past the pixels (which are skipped, not read); "end": to its end,
 *  a file without pixels and without the image attributes that announce them; "cut": the bytes ended inside an element,
 *  or an image's pixels never came; "form": big endian, or deflated (fileBlocks inflates that and walks again);
 *  "broken": the bytes stopped making sense where the walk could not step over them. */
export type WalkEnd = "pixels" | "end" | "cut" | "form" | "broken";

/** One file's private blocks: "GGGG|creator" -> the element numbers present ("10", "1C"), and how far the walk got. */
export interface FileBlocks {
  blocks: Map<string, Set<string>>; ended: WalkEnd;
  /** Values of known length that looked like sequences and could not be read as one: stepped over, their contents not seen. */
  skipped?: number;
  /** The deflated transfer syntax: where its data set begins, to inflate and walk again. */
  deflated?: number;
  /** With `stopAtPixels`: where the pixels' value begins in the bytes, and its length (0xFFFFFFFF: encapsulated). */
  pixelsAt?: { value: number; len: number };
}

/** Bytes by position, read as they are needed: a value that is not walked into is never read (a tracts object's points,
 *  hundreds of MB, before its private block). `size` is the whole length; `read` may return fewer bytes at the end. */
export interface ByteSource { size: number; read(pos: number, len: number): Uint8Array }

/** An element in a group with no creator at all (an anonymizer that removed the creators and kept the elements). Its
 *  element numbers keep the block ("100C"), since a reader looking for a creator that is not there falls back to block
 *  0x10 (private-tags.ts privateTag), and so can still read it. */
export const NO_CREATOR = "(no creator)";
/** An element whose block no creator reserved, in a group where other blocks have one: no reader finds it. */
export const NO_CREATOR_FOR_BLOCK = "(no creator for its block)";

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const h4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
/** Private groups: odd, except the four the standard reserves (PS3.5 §7.1) and the delimiters' FFFF. */
const isPrivateGroup = (g: number) => (g & 1) === 1 && g > 0x0008 && g !== 0xffff;
const WINDOW = 1 << 20;

/** A whole file, or a prefix of one, as a source (a prefix walks to "cut" where its bytes end). */
export const bytesSource = (b: Uint8Array): ByteSource => ({ size: b.length, read: (pos, len) => b.subarray(pos, pos + len) });

/**
 * The private blocks of a DICOM file. Creators are scoped to the data set they sit in -- the top level or one item -- as
 * the standard scopes them. `opts.dataSet`: the bytes are a bare data set in explicit VR (a deflated file, inflated),
 * without preamble or file meta group; `opts.stopAtPixels`: done at the pixels, saying where they are (`pixelsAt`), for
 * a prefix that may end inside them.
 */
export function privateBlocksOf(input: Uint8Array | ByteSource, opts: { dataSet?: boolean; stopAtPixels?: boolean } = {}): FileBlocks {
  const src = input instanceof Uint8Array ? bytesSource(input) : input;
  const blocks = new Map<string, Set<string>>();
  const n = src.size;
  // One window of bytes at a time; a value that is skipped is never read.
  let wStart = 0, w = new Uint8Array(0);
  const need = (p: number, len: number) => {
    if (p >= wStart && p + len <= wStart + w.length) return;
    wStart = p; w = src.read(p, Math.max(WINDOW, len));
  };
  const u8 = (p: number) => { need(p, 1); return w[p - wStart]; };
  const u16 = (p: number) => { need(p, 2); return w[p - wStart] | (w[p - wStart + 1] << 8); };
  const u32 = (p: number) => { need(p, 4); return (w[p - wStart] | (w[p - wStart + 1] << 8) | (w[p - wStart + 2] << 16) | (w[p - wStart + 3] << 24)) >>> 0; };
  const latin1 = (p: number, len: number) => {
    const l = Math.min(len, n - p);
    if (l <= 0) return "";
    need(p, l);
    let s = "";
    for (let i = 0; i < l; i++) s += String.fromCharCode(w[p - wStart + i]);
    return s.replace(/\0/g, "").trim();
  };
  let ended: WalkEnd | undefined;
  let deflated: number | undefined;
  let skipped = 0;
  let pixelsAt: FileBlocks["pixelsAt"];
  const stop = (why: WalkEnd) => { ended ??= why; return n; };
  const startsItem = (p: number, end: number) => p + 8 <= end && u16(p) === 0xfffe && u16(p + 2) === 0xe000;

  // A sequence's items, from p to `end` (a defined length) or to its delimiter (`undefinedLength`: then the bytes ending
  // first means the file was cut). Returns the position after it.
  const sequence = (p: number, end: number, explicit: boolean, undefinedLength = false): number => {
    while (p + 8 <= end && ended === undefined) {
      const g = u16(p), e = u16(p + 2), len = u32(p + 4);
      p += 8;
      if (g === 0xfffe && e === 0xe0dd) return p;                               // the sequence's delimiter
      if (g !== 0xfffe || e !== 0xe000) return stop("broken");                 // not an item
      if (len === 0xffffffff) p = dataset(p, end, explicit, false);            // until the item's delimiter
      else { if (p + len > end) return stop("cut"); dataset(p, p + len, explicit, false); p += len; }
    }
    return undefinedLength && ended === undefined ? stop("cut") : p;
  };
  // Encapsulated pixel data: fragments, each an item of defined length; skipped (never walked, never read).
  const fragments = (p: number, end: number): number => {
    while (p + 8 <= end) {
      const g = u16(p), e = u16(p + 2), len = u32(p + 4);
      p += 8;
      if (g === 0xfffe && e === 0xe0dd) return p;
      if (g !== 0xfffe || e !== 0xe000 || len === 0xffffffff) return stop("broken");
      p += len;
    }
    return stop("cut");
  };

  // One data set (the top level, or an item) from p to `end` or to an item delimiter.
  const dataset = (p: number, end: number, explicit: boolean, top: boolean): number => {
    const creators = new Map<number, string>();                                 // (group << 8) | block -> creator
    const groupsWithCreators = new Set<number>();
    while (p + 8 <= end && ended === undefined) {
      const g = u16(p), e = u16(p + 2);
      if (g === 0xfffe && e === 0xe00d) return p + 8;                          // the item's delimiter
      const isPixels = top && g === 0x7fe0 && (e === 0x0010 || e === 0x0008 || e === 0x0009);   // pixels, float, double
      if (isPixels) pixels = true;
      if (top && g === 0x0028 && e === 0x0010) rows = true;                    // Rows: the image's pixels are to come
      const meta = g === 0x0002;
      let vr = "", len: number, hdr: number;
      if (explicit || meta) {
        vr = String.fromCharCode(u8(p + 4), u8(p + 5));
        if (!/^[A-Z]{2}$/.test(vr)) return stop("broken");
        if (LONG_VR.has(vr)) { if (p + 12 > end) return stop("cut"); len = u32(p + 8); hdr = 12; }
        else { len = u16(p + 6); hdr = 8; }
      } else { len = u32(p + 4); hdr = 8; }
      const v = p + hdr;
      if (isPixels && opts.stopAtPixels) { pixelsAt = { value: v, len }; return stop("pixels"); }
      if (isPrivateGroup(g)) {
        if (e >= 0x0010 && e <= 0x00ff) {
          if (len !== 0xffffffff && v + len <= end) { creators.set((g << 8) | e, latin1(v, Math.min(len, 64))); groupsWithCreators.add(g); }
        } else if (e >= 0x1000) {
          const creator = creators.get((g << 8) | (e >> 8));
          const key = `${h4(g)}|${creator || (groupsWithCreators.has(g) ? NO_CREATOR_FOR_BLOCK : NO_CREATOR)}`;
          let set = blocks.get(key);
          if (!set) blocks.set(key, set = new Set());
          set.add(creator ? h2(e & 0xff) : h2(e >> 8) + h2(e & 0xff));
        }
      }
      // A NESTED DATA SET: an explicit SQ (its items in the file's encoding), or an element whose type the file does not
      // state (implicit VR) or calls UN, whose items are implicit VR by the standard (PS3.5 §6.2.2) -- told by its first
      // bytes being an item.
      const nestedExplicit = vr === "SQ" ? explicit : false;
      if (len === 0xffffffff) {
        if (isPixels) { p = fragments(v, end); continue; }
        if (vr === "SQ" || vr === "UN" || vr === "") { p = sequence(v, end, nestedExplicit, true); continue; }
        if (vr === "OB" || vr === "OW") { p = fragments(v, end); continue; }   // encapsulated data elsewhere (an icon)
        return stop("broken");
      }
      if (v + len > end) return stop("cut");
      // A value of KNOWN length that does not read as items is stepped over, and counted: the walk goes on after it.
      if (!isPixels && (vr === "SQ" || ((vr === "UN" || vr === "") && len >= 8 && startsItem(v, v + len)))) {
        sequence(v, v + len, nestedExplicit);
        if (ended !== undefined) { ended = undefined; skipped++; }
      }
      p = v + len;
      if (meta && e === 0x0010) transferSyntax = latin1(v, len);
      // After the file meta group, the transfer syntax decides how the rest is written.
      if (meta && p + 2 <= end && u16(p) !== 0x0002) {
        const ts = transferSyntax;
        if (ts === "1.2.840.10008.1.2") explicit = false;
        else if (ts === "1.2.840.10008.1.2.1.99") { deflated = p; return stop("form"); }
        else if (ts === "1.2.840.10008.1.2.2") return stop("form");
        else explicit = true;
      }
    }
    if (top && ended === undefined) stop(p >= n ? (pixels ? "pixels" : rows ? "cut" : "end") : "cut");
    return p;
  };
  let transferSyntax = "", pixels = false, rows = false;
  if (opts.dataSet) dataset(0, n, true, true);
  else {
    const preamble = n >= 132 && latin1(128, 4) === "DICM";
    const start = preamble ? 132 : 0;
    // The encoding of the first element: told by its VR bytes (a file with the preamble and no file meta group exists).
    const explicit0 = (n >= start + 6 && /^[A-Z]{2}$/.test(String.fromCharCode(u8(start + 4), u8(start + 5)))) || (preamble && n >= 134 && u16(132) === 0x0002);
    dataset(start, n, explicit0, true);
  }
  return { blocks, ended: ended ?? "end", ...(skipped ? { skipped } : {}), ...(deflated !== undefined ? { deflated } : {}), ...(pixelsAt ? { pixelsAt } : {}) };
}

// ── One series ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A series' private blocks as stored (SlicerAlbula-Cache/private-fields-<uid>.json; desktop/private-fields.ts). */
export interface SeriesPrivateSurvey {
  survey: number;
  series: string;
  /** The files looked at, of how many the index lists (a spread sample of a long series). */
  files: { looked: number; of: number };
  /** Files not read in full: missing, cut short, in a form not read (big endian), a value inside stepped over, or a
   *  deflated file not walked past its pixels. Shown in the window: such a series is not a clean result. */
  notWhole?: { file: string; why: string }[];
  /** The index's files when it was made (their count and a hash of their names): another list makes it again. */
  stamp?: string;
  blocks: { group: string; creator: string; elements: string[] }[];
  made: string;
}

/** Many files' blocks as one list, sorted by group and creator. */
export function mergeBlocks(files: FileBlocks[]): SeriesPrivateSurvey["blocks"] {
  const all = new Map<string, Set<string>>();
  for (const f of files) for (const [k, s] of f.blocks) { let t = all.get(k); if (!t) all.set(k, t = new Set()); for (const e of s) t.add(e); }
  return [...all].map(([k, s]) => { const i = k.indexOf("|"); return { group: k.slice(0, i), creator: k.slice(i + 1), elements: [...s].sort() }; })
    .sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : a.creator < b.creator ? -1 : a.creator > b.creator ? 1 : 0);
}

/** At most `max` of a list, spread evenly over it from its first to its last (the same choice every time for the same
 *  list). Over a series' files sorted by name -- names that are hashes in a database -- that is in effect a random sample
 *  of its images, not the first and last acquired. */
export function spreadSample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * (list.length - 1) / (max - 1))]);
  return out;
}

// ── The comparison ────────────────────────────────────────────────────────────────────────────────────────────────

/** Albula's own blocks (its provenance record in derived objects): read by Albula, never a vendor's gap. */
export const isAlbulaCreator = (creator: string) => creator.startsWith("SlicerAlbula");

/** One block across a database: in how many series, which of its elements are read, by whom. */
export interface BlockRow {
  group: string; creator: string;
  /** "not read": no reader reads any of its elements; "partly read": some; "read": every element present; "Albula's
   *  own": Albula's provenance block, which it writes and reads itself. */
  state: "not read" | "partly read" | "read" | "Albula's own";
  series: string[];
  elements: string[];
  /** Elements no reader reads at all. */
  unread: string[];
  read: { reader: string; elements: string[]; what: string; part?: boolean }[];
}

/** Every block of the given series, compared with what the readers declare now. */
export function compareWithReaders(surveys: SeriesPrivateSurvey[], reads: ReadonlyMap<string, readonly PrivateRead[]> = privateReads()): BlockRow[] {
  const rows = new Map<string, BlockRow>();
  for (const s of surveys) for (const b of s.blocks) {
    const k = `${b.group}|${b.creator}`;
    let r = rows.get(k);
    if (!r) rows.set(k, r = { group: b.group, creator: b.creator, state: "not read", series: [], elements: [], unread: [], read: [] });
    r.series.push(s.series);
    r.elements = [...new Set([...r.elements, ...b.elements])].sort();
  }
  for (const r of rows.values()) {
    for (const [reader, list] of reads) for (const x of list) {
      if (x.group !== r.group) continue;
      // A group with no creator at all: a reader falls back to block 0x10 for its creator (privateTag), so it reads
      // (gggg,10xx) there whatever creator it looks for.
      const wanted = r.creator === NO_CREATOR ? x.elements.map((e) => `10${e}`) : x.creator === r.creator ? x.elements : [];
      const hit = wanted.filter((e) => r.elements.includes(e));
      if (hit.length) r.read.push({ reader, elements: hit, what: x.what, ...(x.part ? { part: true } : {}) });
    }
    const readEls = new Set(r.read.filter((x) => !x.part).flatMap((x) => x.elements));
    const anyEls = new Set(r.read.flatMap((x) => x.elements));
    r.unread = r.elements.filter((e) => !anyEls.has(e));
    r.state = isAlbulaCreator(r.creator) ? "Albula's own" : !anyEls.size ? "not read" : r.elements.every((e) => readEls.has(e)) ? "read" : "partly read";
  }
  // What is not read first, Albula's own record last; within each, the block held by the most series first.
  const rank = { "not read": 0, "partly read": 1, "read": 2, "Albula's own": 3 } as const;
  return [...rows.values()].sort((a, b) => rank[a.state] - rank[b.state] || b.series.length - a.series.length || (a.group < b.group ? -1 : 1));
}
