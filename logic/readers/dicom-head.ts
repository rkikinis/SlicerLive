// THE HEADER OF A DICOM FILE FROM ITS FIRST BYTES, for a question that needs the header only.
//
// The DICOM browser reads the first 64 KB of a series' first file (DicomDatabase.readSeriesFileHead)
// to say what the series is (logic/series-explain.ts). dcmjs wants a whole file; this reads a TRUNCATED
// one and returns the top-level elements it reached, stopping at the pixel data. Explicit and implicit
// VR little endian, which is every file in Ron's database; big endian and deflated data sets give what
// the file meta group holds and stop. Tolerant by design: a short or odd file gives fewer elements, never
// an exception.

/** Top-level elements by tag, "ggggeeee" upper-case hex, as strings (numbers written out; multi-values
 *  joined with "\\"). */
export type DicomHead = Map<string, string>;

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const TEXT_VR = new Set(["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT"]);
// Implicit VR carries no type: the numeric tags this file is asked for, by tag. Everything else is text.
const IMPLICIT_US = new Set(["00280002", "00280010", "00280011", "00280100", "00280101", "00280102", "00280103"]);
const IMPLICIT_FD = new Set(["00189345"]);
const hex = (g: number, e: number) => (g.toString(16).padStart(4, "0") + e.toString(16).padStart(4, "0")).toUpperCase();

export function readDicomHead(buf: ArrayBuffer): DicomHead {
  const out: DicomHead = new Map();
  const dv = new DataView(buf);
  const n = buf.byteLength;
  const bytes = new Uint8Array(buf);
  const text = (off: number, len: number) => {
    let s = "";
    for (let i = off; i < off + len && i < n; i++) s += String.fromCharCode(bytes[i]);
    try { s = decodeURIComponent(escape(s)); } catch { /* latin-1 as it is */ }
    return s.replace(/\0/g, "").trim();
  };
  let pos = 0;
  if (n >= 132 && text(128, 4) === "DICM") pos = 132;

  // Skip an element of undefined length (a sequence, or encapsulated data): items until the sequence
  // delimiter, each item either of its stated length or until its own delimiter. Returns the position after.
  const skipUndefined = (p: number, explicit: boolean): number => {
    while (p + 8 <= n) {
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), len = dv.getUint32(p + 4, true);
      p += 8;
      if (g === 0xfffe && e === 0xe0dd) return p;                          // sequence delimiter
      if (g === 0xfffe && e === 0xe000) {                                   // item
        if (len !== 0xffffffff) { p += len; continue; }
        p = walk(p, explicit, true);                                         // until the item delimiter
        continue;
      }
      return n;                                                              // not a sequence: give up
    }
    return n;
  };
  // Walk elements from p. `inItem`: stop after an item delimiter and do not record (nested).
  const walk = (p: number, explicit: boolean, inItem: boolean): number => {
    while (p + 8 <= n) {
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true);
      if (g === 0xfffe && e === 0xe00d) return p + 8;                        // item delimiter
      if (!inItem && g === 0x7fe0 && e === 0x0010) return n;                // the pixels: done
      let vr = "", len: number, hdr: number;
      const meta = g === 0x0002;
      if (explicit || meta) {
        vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
        if (!/^[A-Z]{2}$/.test(vr)) return n;
        if (LONG_VR.has(vr)) { if (p + 12 > n) return n; len = dv.getUint32(p + 8, true); hdr = 12; }
        else { len = dv.getUint16(p + 6, true); hdr = 8; }
      } else { len = dv.getUint32(p + 4, true); hdr = 8; }
      p += hdr;
      if (len === 0xffffffff) { p = skipUndefined(p, explicit); continue; }
      if (!inItem && vr !== "SQ" && vr !== "OB" && vr !== "OW" && vr !== "UN" && p + len <= n) {
        const tag = hex(g, e);
        let v: string | undefined;
        if (!vr) vr = IMPLICIT_US.has(tag) ? "US" : IMPLICIT_FD.has(tag) ? "FD" : "";
        if (vr === "US") v = len >= 2 ? String(dv.getUint16(p, true)) : "";
        else if (vr === "UL") v = len >= 4 ? String(dv.getUint32(p, true)) : "";
        else if (vr === "SS") v = len >= 2 ? String(dv.getInt16(p, true)) : "";
        else if (vr === "FD") v = Array.from({ length: Math.floor(len / 8) }, (_, i) => dv.getFloat64(p + 8 * i, true)).join("\\");
        else if (vr === "FL") v = Array.from({ length: Math.floor(len / 4) }, (_, i) => dv.getFloat32(p + 4 * i, true)).join("\\");
        else if (TEXT_VR.has(vr) || !vr) v = text(p, len);
        if (v !== undefined) out.set(tag, v);
      }
      p += len;
      // After the meta group: the transfer syntax decides how the rest is written.
      if (meta && p + 2 <= n && dv.getUint16(p, true) !== 0x0002) {
        const ts = out.get("00020010") ?? "";
        if (ts === "1.2.840.10008.1.2") explicit = false;
        else if (ts === "1.2.840.10008.1.2.2" || ts === "1.2.840.10008.1.2.1.99") return n;   // big endian, deflated
        else explicit = true;
      }
    }
    return n;
  };
  // Without a preamble, guess the encoding from the first element's VR bytes.
  const explicit0 = pos === 132 || (n >= 6 && /^[A-Z]{2}$/.test(String.fromCharCode(bytes[4], bytes[5])));
  walk(pos, explicit0, false);
  return out;
}

/** The tags the explanation reads, by name. */
export const HEAD_TAGS = {
  ImageType: "00080008", SOPClassUID: "00080016", SeriesTime: "00080031", Modality: "00080060",
  Manufacturer: "00080070", SeriesDescription: "0008103E", ManufacturerModelName: "00081090",
  DerivationDescription: "00082111", ContrastBolusAgent: "00180010", BodyPartExamined: "00180015",
  ScanningSequence: "00180020", SequenceName: "00180024", SliceThickness: "00180050", KVP: "00180060",
  RepetitionTime: "00180080", EchoTime: "00180081", MagneticFieldStrength: "00180087",
  SpacingBetweenSlices: "00180088", ProtocolName: "00181030", ConvolutionKernel: "00181210",
  PatientPosition: "00185100", CTDIvol: "00189345", ImageOrientationPatient: "00200037",
  NumberOfFrames: "00280008", Rows: "00280010", Columns: "00280011", PixelSpacing: "00280030",
} as const;
export type HeadTag = keyof typeof HEAD_TAGS;
export const headValue = (h: DicomHead, k: HeadTag): string | undefined => {
  const v = h.get(HEAD_TAGS[k]);
  return v === undefined || v === "" ? undefined : v;
};
