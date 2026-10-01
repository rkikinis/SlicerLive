// A DICOM HEADER AS THE DUCKN COPY HOLDS IT. Ron, 2026-09-25: "Zarr for all work, DICOM kept as cold storage";
// "Eventually we will need to fix the Zarr headers in a way that they contain all the information in the parent
// dicom"; and "Remember, the ultimate arbiter is the DICOM standard. Private fields are very important as vendors often
// use them to store real information. For instance, Philips had an identical DMRI header, and the actual orientation,
// and etc of the acquisitions were stored in private fields without documentation." (DUCKN-WORKING-COPY.md, step 5.)
//
// TWO FORMS, ONE SOURCE:
//  - THE RECORD, in the standard's own form: the DICOM JSON Model (PS3.18 Annex F). Every attribute by its tag with
//    its value representation, private ones included; a binary value (OB, OW, UN, ...) as InlineBinary (base64). Only
//    the pixel data is left out -- it is the Zarr array. A header rebuilt from it is the file's header, attribute for
//    attribute. This is what a writer uses.
//  - A VIEW, Michael Halle's (duckn's dicom_to_zarr, dicom-spec §4): keyword -> plain value, a private attribute by its
//    hex tag, binary values left out. What his tools read. Made from the same parse, never the record.
// Attributes the same for every slice of a volume are kept once, the rest per slice (splitShared).
//
// Versioned: DICOM_HEADER_LAYOUT names what these functions write; a change is a new version, and the copy's code
// fingerprint (desktop/make-copy-code.ts) retires the copies made by the old one.
// 2: string padding removed, empty values null, AT as "GGGGEEEE" -- as the standard and DCMTK's dcm2json write them.
// 3: no group lengths (gggg,0000); a person name of only spaces is empty.
// 4: the file's text where dcmjs changes it (DS, IS, UI, LT/ST/UT), US-or-SS by PixelRepresentation in implicit VR, icons
//    in sequences kept, trailing carets in names trimmed (critic, 2026-09-25).
export const DICOM_HEADER_LAYOUT = "albula-dicom-header-4: DICOM JSON Model (PS3.18 Annex F), shared + per slice";

type Obj = Record<string, unknown>;
/** One attribute in the DICOM JSON Model. */
export interface JsonAttr { vr: string; Value?: unknown[]; InlineBinary?: string }
export type DicomJson = Record<string, JsonAttr>;
/** dcmjs's raw dictionary: the same, with binary values as ArrayBuffers, and `_rawValue` -- the file's text before dcmjs
 *  turned it into numbers or trimmed it. */
type RawDict = Record<string, { vr: string; Value?: unknown[]; _rawValue?: unknown[] }>;

const BINARY_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "UN"]);
/** Pixel data (7FE0,0010), float and double-float pixel data: the Zarr array itself. */
const PIXEL_TAGS = new Set(["7FE00010", "7FE00008", "7FE00009"]);
const isBuf = (v: unknown) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

function toBase64(parts: unknown[]): string {
  const bufs = parts.map((p) => p instanceof ArrayBuffer ? new Uint8Array(p) : new Uint8Array((p as ArrayBufferView).buffer, (p as ArrayBufferView).byteOffset, (p as ArrayBufferView).byteLength));
  const n = bufs.reduce((s, b) => s + b.byteLength, 0);
  const all = new Uint8Array(n);
  let o = 0; for (const b of bufs) { all.set(b, o); o += b.byteLength; }
  let s = "";
  for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Value representations whose leading spaces are not significant (PS3.5 §6.2); every string's trailing padding is
 *  not, nor a UI's trailing NUL. */
const TRIM_BOTH = new Set(["AE", "CS", "DS", "IS", "DA", "DT", "TM", "LO", "SH", "PN", "UI"]);
const STRING_VR = new Set([...TRIM_BOTH, "LT", "ST", "UT", "UC", "UR", "AS"]);
const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** "US or SS" attributes: their VR is not in an Implicit VR file, and dcmjs's dictionary always says US. As DCMTK does,
 *  PixelRepresentation decides (critic, 2026-09-25, finding 3: SmallestImagePixelValue -1024 had become US 64512). */
// The "US or SS" attributes of the data dictionary (pydicom's, which follows PS3.6; critic, 2026-09-25 night, finding 9:
// the histogram bin values were missing), resolved by PixelRepresentation as DCMTK does. Not the seven LUT descriptors
// (0028,1100-1113, 0028,3002): their first value is always unsigned and DCMTK reads them as US, checked with dcm2json.
const US_OR_SS = new Set([
  "00189810", "00221452", "00280071", "00280104", "00280105", "00280106", "00280107", "00280108", "00280109", "00280110",
  "00280111", "00280120", "00280121", "00409211", "00409216", "00603004", "00603006",
]);
/** "US or OW" / "US or SS or OW" (LUT Data, Gray LUT Data): in implicit VR, dcmjs has no VR for them (UN); DCMTK writes OW. */
const US_OR_OW = new Set(["00283006", "00281200"]);
const SINGLE_TEXT = new Set(["LT", "ST", "UT"]);
const DS_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const IS_RE = /^[+-]?\d+$/;

/**
 * One attribute's values as the DICOM JSON Model writes them (PS3.18 §F.2), from what the FILE says -- dcmjs's
 * `_rawValue` where its reading changes the value (critic, 2026-09-25, findings 4, 5, 12, 14). Checked against DCMTK's
 * dcm2json:
 *  - text: padding removed (trailing spaces; leading ones too where they are not significant; a UI's trailing NUL);
 *    an empty value is null, and a field of only empty values has no Value;
 *  - LT, ST, UT: ONE value, as the file holds it -- dcmjs splits ST and UT at backslashes (in them a backslash is text),
 *    so the pieces are joined back, and a text's line breaks stay;
 *  - DS, IS: a number when the file's text is a valid one, else the file's text ("1,5" stays "1,5"; dcmjs had read 15);
 *  - UI: the file's string (dcmjs drops every character that is not a digit or a dot);
 *  - AT: "GGGGEEEE" (dcmjs gives a number); PN: components trimmed, trailing carets too (equivalent, PS3.5 §6.2.1.1).
 * UPSTREAM, drafted, not filed yet (Contents/docs/upstream-issues-dcmjs.md in the workspace, new issues 1-3: ST/UT split
 * at backslashes, citing #46; an invalid DS/IS becoming another number, citing #287; UI characters dropped). Each
 * correction here goes when a dcmjs release fixes its case; the DCMTK comparison test says when.
 */
function jsonValues(vr: string, v: unknown[], raw: unknown[] | undefined): unknown[] | undefined {
  const rawStr = Array.isArray(raw) && raw.length && raw.every((x) => typeof x === "string") ? raw as string[] : undefined;
  let out: unknown[] = v;
  if (vr === "AT") out = v.map((x) => typeof x === "number" ? hex8(x) : x);
  else if (vr === "PN") {
    out = v.map((x) => {
      if (!x || typeof x !== "object") return typeof x === "string" && x.trim() === "" ? null : x;
      const o: Record<string, string> = {};
      for (const [k, s] of Object.entries(x as Record<string, string>)) { const t = String(s).trim().replace(/\^+$/, ""); if (t) o[k] = t; }
      return Object.keys(o).length ? o : null;
    });
  } else if (SINGLE_TEXT.has(vr) && rawStr) {
    const t = rawStr.join("\\").replace(/[ \u0000]+$/, "");
    out = t === "" ? [null] : [t];
  } else if ((vr === "DS" || vr === "IS") && rawStr) {
    out = rawStr.map((x) => {
      const t = x.replace(/^[ \u0000]+|[ \u0000]+$/g, "");
      if (t === "") return null;
      return (vr === "DS" ? DS_RE : IS_RE).test(t) ? Number(t) : t;
    });
  } else if (vr === "UI" && rawStr) {
    out = rawStr.map((x) => { const t = x.replace(/^[ \u0000]+|[ \u0000]+$/g, ""); return t === "" ? null : t; });
  } else if (STRING_VR.has(vr)) {
    out = v.map((x) => {
      if (typeof x !== "string") return x;
      const t = x.replace(/[ \u0000]+$/, "");
      const s = TRIM_BOTH.has(vr) ? t.replace(/^ +/, "") : t;
      return s === "" ? null : s;
    });
  }
  return out.every((x) => x === null || x === undefined) ? undefined : out;
}

/** dcmjs's raw dictionary (and, merged in, its file meta) in the DICOM JSON Model, without the pixel data. */
export function toDicomJson(dict: RawDict, meta?: RawDict): DicomJson {
  const implicit = String(meta?.["00020010"]?.Value?.[0] ?? "") === "1.2.840.10008.1.2";
  const signedPixels = Number(dict["00280103"]?.Value?.[0]) === 1;
  const conv = (d: RawDict, depth: number): DicomJson => {
    const out: DicomJson = {};
    for (const [tag, e] of Object.entries(d)) {
      // The top level's pixel data is the Zarr array; pixel data inside a sequence (an icon) is kept (finding 14).
      if (depth === 0 && PIXEL_TAGS.has(tag.toUpperCase())) continue;
      // Group lengths (gggg,0000) are not in the JSON Model -- DCMTK's dcm2json leaves every one out, the file meta's
      // included (found on Slicer's RIDER test files, 2026-09-25); a writer computes its own.
      if (tag.endsWith("0000")) continue;
      // Data Set Trailing Padding (FFFC,FFFC) is filler with no meaning; DCMTK's dcm2json leaves it out too.
      if (tag.toUpperCase() === "FFFCFFFC") continue;
      const vr = e.vr;
      const v = e.Value ?? [];
      if (vr === "SQ") out[tag] = v.length ? { vr, Value: v.map((it) => conv(it as RawDict, depth + 1)) } : { vr };
      else if (BINARY_VR.has(vr) || v.some(isBuf)) {
        const bvr = implicit && vr === "UN" && US_OR_OW.has(tag.toUpperCase()) ? "OW" : vr;
        out[tag] = v.length && v.some((x) => isBuf(x) && (x as ArrayBuffer).byteLength > 0) ? { vr: bvr, InlineBinary: toBase64(v) } : { vr: bvr };
      }
      else if (implicit && vr === "US" && US_OR_SS.has(tag.toUpperCase()) && signedPixels) {
        const sv = v.map((x) => typeof x === "number" && x > 32767 ? x - 65536 : x);
        out[tag] = sv.length ? { vr: "SS", Value: sv } : { vr: "SS" };
      } else { const jv = jsonValues(vr, v, e._rawValue); out[tag] = jv ? { vr, Value: jv } : { vr }; }
    }
    return out;
  };
  return { ...(meta ? conv(meta, 0) : {}), ...conv(dict, 0) };
}

/** The DICOM JSON Model back into dcmjs's raw dictionary (InlineBinary as an ArrayBuffer), for a writer. */
export function fromDicomJson(j: DicomJson): RawDict {
  const out: RawDict = {};
  for (const [tag, a] of Object.entries(j)) {
    if (a.vr === "SQ") out[tag] = { vr: "SQ", Value: (a.Value ?? []).map((it) => fromDicomJson(it as DicomJson)) };
    else if (a.InlineBinary !== undefined) out[tag] = { vr: a.vr, Value: [fromBase64(a.InlineBinary)] };
    // dcmjs's own forms: an attribute tag as a number, an empty value as "".
    else if (a.vr === "AT") out[tag] = { vr: a.vr, Value: (a.Value ?? []).map((x) => typeof x === "string" ? parseInt(x, 16) : x) };
    else out[tag] = { vr: a.vr, Value: (a.Value ?? []).map((x) => x === null ? "" : x) };
  }
  return out;
}

/** dcmjs's person name ([{Alphabetic, Ideographic, Phonetic}, ...]) as a string, as Mike's view writes it. */
function personName(v: unknown[]): string | undefined {
  const s = v.map((p) => {
    if (typeof p === "string") return p;
    const o = p as { Alphabetic?: string; Ideographic?: string; Phonetic?: string };
    return [o.Alphabetic ?? "", o.Ideographic ?? "", o.Phonetic ?? ""].join("=").replace(/=+$/, "");
  }).join("\\");
  return s || undefined;
}
const PN_KEYS = new Set(["Alphabetic", "Ideographic", "Phonetic"]);
const looksLikePN = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((p) => p && typeof p === "object" && Object.keys(p as object).length > 0 && Object.keys(p as object).every((k) => PN_KEYS.has(k)));

/**
 * Michael Halle's view of a dcmjs-naturalized dataset (and its file meta): keyword -> plain value, a person name as a
 * string, a sequence as a list of objects in the same form, a private attribute by its hex tag. Binary values, the
 * pixel data and dcmjs's own bookkeeping (keys starting "_") are left out, as his converter leaves them out.
 */
export function toDucknTags(ds: Obj, meta?: Obj): Obj {
  const conv = (o: Obj): Obj => {
    const out: Obj = {};
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_") || k === "PixelData" || v === undefined || isBuf(v) || (Array.isArray(v) && v.some(isBuf))) continue;
      if (looksLikePN(v)) { const s = personName(v as unknown[]); if (s !== undefined) out[k] = s; continue; }
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) { out[k] = v.map((it) => conv(it as Obj)); continue; }
      out[k] = v;
    }
    return out;
  };
  return { ...(meta ? conv(meta) : {}), ...conv(ds) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The headers of a volume's slices, in slice order, split as the copy stores them: what every slice has with the same
 * value (`shared`), and per slice what is left (`perSlice[i]`). mergeSlice(shared, perSlice[i]) is slice i's header.
 */
export function splitShared<T extends Obj>(headers: T[]): { shared: Partial<T>; perSlice: Partial<T>[] } {
  if (!headers.length) return { shared: {}, perSlice: [] };
  const shared: Obj = {};
  for (const [k, v] of Object.entries(headers[0])) if (headers.every((h) => k in h && same(h[k], v))) shared[k] = v;
  const perSlice = headers.map((h) => Object.fromEntries(Object.entries(h).filter(([k]) => !(k in shared))));
  return { shared: shared as Partial<T>, perSlice: perSlice as Partial<T>[] };
}

/** Slice i's header from the copy: the shared attributes and its own. */
export function mergeSlice<T extends Obj>(shared: Partial<T>, own: Partial<T> | undefined): T { return { ...shared, ...(own ?? {}) } as T; }

/** The same header, compared: attribute order does not matter, everything else does. */
export function sameHeader(a: Obj, b: Obj): boolean {
  const sorted = (o: Obj) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  return sorted(a) === sorted(b);
}
