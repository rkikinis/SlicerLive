// Encapsulated pixel data (PS3.5 A.4): the fragments dcmjs hands back (it drops the basic offset
// table) regrouped into frames. One fragment per frame is the common case; a frame may also be
// split over several fragments (JPEG-LL.dcm: two for one frame), and then the codestreams are
// found by their markers.

/** The fragments of each frame, concatenated. */
export function framesOf(fragments: Uint8Array[], numberOfFrames: number, kind: "jpeg" | "rle"): Uint8Array[] {
  if (fragments.length === numberOfFrames) return fragments;
  if (numberOfFrames === 1) return [concat(fragments)];
  if (kind === "rle") throw new Error(`RLE: ${fragments.length} fragments for ${numberOfFrames} frames; RLE has exactly one per frame`);
  // JPEG: join everything and split at SOI markers.
  const all = concat(fragments);
  const starts: number[] = [];
  for (let i = 0; i + 1 < all.length; i++) if (all[i] === 0xff && all[i + 1] === 0xd8) { starts.push(i); i++; }
  if (starts.length !== numberOfFrames) throw new Error(`JPEG: ${starts.length} codestreams for ${numberOfFrames} frames`);
  return starts.map((s, k) => all.subarray(s, k + 1 < starts.length ? starts[k + 1] : all.length));
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0; for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

export const RLE = "1.2.840.10008.1.2.5";
export const JPEG_LOSSLESS = new Set(["1.2.840.10008.1.2.4.57", "1.2.840.10008.1.2.4.70"]);

/** Plain names for the compressed transfer syntaxes, for a message a person can act on. */
export const CODEC_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2.4.50": "JPEG baseline (lossy, 8-bit)",
  "1.2.840.10008.1.2.4.51": "JPEG extended (lossy, 12-bit)",
  "1.2.840.10008.1.2.4.57": "JPEG lossless",
  "1.2.840.10008.1.2.4.70": "JPEG lossless",
  "1.2.840.10008.1.2.4.80": "JPEG-LS lossless",
  "1.2.840.10008.1.2.4.81": "JPEG-LS near-lossless",
  "1.2.840.10008.1.2.4.90": "JPEG 2000 lossless",
  "1.2.840.10008.1.2.4.91": "JPEG 2000 (lossy)",
  "1.2.840.10008.1.2.4.201": "HTJ2K lossless",
  "1.2.840.10008.1.2.4.202": "HTJ2K lossless (RPCL)",
  "1.2.840.10008.1.2.4.203": "HTJ2K (lossy)",
  "1.2.840.10008.1.2.5": "RLE lossless",
  "1.2.840.10008.1.2.4.100": "MPEG-2 video",
  "1.2.840.10008.1.2.4.102": "MPEG-4 video",
};
export const codecName = (uid: string): string => CODEC_NAMES[uid] ?? uid;
