// DICOM RLE Lossless (transfer syntax 1.2.840.10008.1.2.5), PS3.5 Annex G.
//
// Our own, because it is a page and the standard does not change it (Ron, 2026-09-19: "DICOM
// doesn't break upgrade paths but adds as needed"): a decoder written once against the standard
// and checked against an independent one (pydicom's, in Contents/data/codecs/make-truths.py) stays
// correct. Every frame is one fragment: a 64-byte header -- the number of segments, then up to 15
// segment offsets -- and the segments, each a PackBits byte stream. A segment is one BYTE PLANE of
// one sample: for 16-bit data the first segment holds every pixel's high byte and the second its
// low byte; for RGB 8-bit, one segment per color; for 32-bit, four per sample.

/** Decode one RLE frame into interleaved samples of `bytesPerSample` bytes, little-endian. */
export function decodeRleFrame(fragment: Uint8Array, rows: number, columns: number, samplesPerPixel: number, bytesPerSample: number): Uint8Array {
  const dv = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  if (fragment.byteLength < 64) throw new Error("RLE: fragment shorter than its 64-byte header");
  const nseg = dv.getUint32(0, true);
  const expected = samplesPerPixel * bytesPerSample;
  if (nseg !== expected) throw new Error(`RLE: ${nseg} segments for ${samplesPerPixel} sample(s) of ${bytesPerSample} byte(s); expected ${expected}`);
  if (nseg > 15) throw new Error(`RLE: ${nseg} segments; the header holds at most 15`);
  const offsets: number[] = [];
  for (let i = 0; i < nseg; i++) offsets.push(dv.getUint32(4 + 4 * i, true));
  const npix = rows * columns;
  const out = new Uint8Array(npix * expected);
  const plane = new Uint8Array(npix);
  for (let s = 0; s < nseg; s++) {
    const start = offsets[s], end = s + 1 < nseg ? offsets[s + 1] : fragment.byteLength;
    unpackBits(fragment, start, end, plane);
    // Segment s belongs to sample (s / bytesPerSample) and is byte (s % bytesPerSample) of it,
    // MOST significant first; the output is little-endian, so byte b of a sample lands at
    // position (bytesPerSample - 1 - b).
    const sample = Math.floor(s / bytesPerSample), byte = s % bytesPerSample;
    const dst = sample * bytesPerSample + (bytesPerSample - 1 - byte);
    for (let p = 0, o = dst; p < npix; p++, o += expected) out[o] = plane[p];
  }
  return out;
}

/** PackBits: n in 0..127 copies the next n+1 bytes; n in 129..255 repeats the next byte 257-n times; 128 is a no-op. */
function unpackBits(src: Uint8Array, start: number, end: number, dst: Uint8Array): void {
  let i = start, o = 0;
  const n = dst.length;
  while (i < end && o < n) {
    const h = src[i++];
    if (h < 128) {
      const len = Math.min(h + 1, n - o, end - i);
      dst.set(src.subarray(i, i + len), o); i += len; o += len;
    } else if (h > 128) {
      const len = Math.min(257 - h, n - o);
      if (i >= end) break;
      dst.fill(src[i++], o, o + len); o += len;
    }
  }
  // A short segment (some writers omit trailing zeros) is padded; a long one is simply cut.
  if (o < n) dst.fill(0, o);
}
