// MD5 of a string, as hex -- for ONE purpose: the file names Slicer's DICOM database gives what it imports.
//
// ctkDICOMDatabase stores an imported instance as dicom/<md5(study)[:8]>/<md5(series)[:8]>/<md5(sop)>.dcm
// (the same path Slicer 5.13 chose for the same file, critic 2026-10-01; tested against macOS's md5 in db-import.test.ts). Albula's import uses the same layout so a
// database it fills reads in Slicer and looks the same on disk. Web Crypto has no MD5 and nothing else here
// needs it, so this is the textbook algorithm (RFC 1321), not a dependency. Not for anything secret.

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const n = (((msg.length + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(n);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n - 8, (msg.length * 8) >>> 0, true);
  dv.setUint32(n - 4, Math.floor((msg.length * 8) / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < n; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = S[(i >>> 4) * 4 + (i & 3)];
      const x = (a + f + K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Where Slicer's database keeps an imported instance, relative to the database folder. */
export const ctkInstancePath = (study: string, series: string, sop: string): string =>
  `dicom/${md5Hex(study).slice(0, 8)}/${md5Hex(series).slice(0, 8)}/${md5Hex(sop)}.dcm`;
