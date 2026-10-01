// JPEG Lossless (ITU-T T.81 process 14, SOF3): transfer syntaxes 1.2.840.10008.1.2.4.57 and .70
// (.70 restricts the predictor to selection value 1; this decodes all seven).
//
// Our own, for the same reason as rle.ts: the process is fixed since 1992, DICOM adds transfer
// syntaxes and never changes one, and it is a few hundred lines -- a Huffman decoder and seven
// predictors -- checked against an independent decoder (libjpeg through pydicom, the truths in
// Contents/data/codecs). In IDC it is the compression that matters: NLST, MIDRC and TCGA series
// are stored this way (2026-09-19 survey). Not here: the lossy DCT processes (baseline, extended),
// JPEG-LS, JPEG 2000 -- real codecs, another decision.
//
// What is supported: 2-16 bit precision, 1 component or several with no subsampling (H=V=1,
// sample-interleaved as DICOM RGB is), point transform, restart intervals, byte stuffing. A frame
// is one scan; multi-scan (one scan per component) files are refused with a message.

interface Huff { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; vals: Uint8Array; lookup: Int16Array }

/** Build a decoding table from BITS (16 counts) and HUFFVAL, per T.81 F.2.2.3, plus an 8-bit lookup. */
function buildHuffman(bits: Uint8Array, vals: Uint8Array): Huff {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k; mincode[l] = code;
    code += bits[l - 1]; k += bits[l - 1];
    maxcode[l] = bits[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  // 8-bit lookup: for every code of length <= 8, (length << 8 | value); -1 = longer than 8 bits.
  const lookup = new Int16Array(256).fill(-1);
  let c = 0, idx = 0;
  for (let l = 1; l <= 8; l++) {
    for (let i = 0; i < bits[l - 1]; i++, idx++, c++) {
      const shift = 8 - l;
      for (let j = 0; j < 1 << shift; j++) lookup[(c << shift) | j] = (l << 8) | vals[idx];
    }
    c <<= 1;
  }
  return { maxcode, valptr, mincode, vals, lookup };
}

class BitReader {
  private bits = 0; private nbits = 0;
  pos: number;
  constructor(private d: Uint8Array, start: number, private end: number) { this.pos = start; }
  /** Fill so that at least n (<= 24) bits are available; past a marker, feed zeros. */
  private fill(n: number): void {
    while (this.nbits < n) {
      let b = 0;
      if (this.pos < this.end) {
        b = this.d[this.pos];
        if (b === 0xff) {
          const next = this.d[this.pos + 1];
          if (next === 0x00) { this.pos += 2; }                 // stuffed byte
          else { b = 0; }                                        // a marker: stop consuming, feed zeros
        } else this.pos++;
      }
      this.bits = ((this.bits << 8) | b) >>> 0; this.nbits += 8;
    }
  }
  peek(n: number): number { this.fill(n); return (this.bits >>> (this.nbits - n)) & ((1 << n) - 1); }
  skip(n: number): void { this.nbits -= n; this.bits &= (1 << this.nbits) - 1; }
  read(n: number): number { if (n === 0) return 0; const v = this.peek(n); this.skip(n); return v; }
  /** Drop buffered bits and step over an RSTn marker at the current position. */
  restart(): void {
    this.bits = 0; this.nbits = 0;
    if (this.d[this.pos] === 0xff && this.d[this.pos + 1] >= 0xd0 && this.d[this.pos + 1] <= 0xd7) this.pos += 2;
  }
  decode(h: Huff): number {
    const look = h.lookup[this.peek(8)];
    if (look >= 0) { this.skip(look >> 8); return look & 0xff; }
    let code = this.read(8), l = 8;
    while (l < 16 && code > h.maxcode[l]) { code = (code << 1) | this.read(1); l++; }
    if (code > h.maxcode[l]) throw new Error("JPEG lossless: bad Huffman code");
    return h.vals[h.valptr[l] + code - h.mincode[l]];
  }
}

export interface LosslessJpeg {
  width: number; height: number; components: number; precision: number;
  /** Interleaved samples, row-major; Uint16 for precision > 8, else Uint8. */
  pixels: Uint16Array | Uint8Array;
}

/** Decode one JPEG lossless codestream (SOI … EOI). */
export function decodeJpegLossless(data: Uint8Array): LosslessJpeg {
  let p = 0;
  const u16 = (i: number) => (data[i] << 8) | data[i + 1];
  if (u16(0) !== 0xffd8) throw new Error("JPEG lossless: no SOI marker");
  p = 2;
  const dc: (Huff | undefined)[] = [];
  let frame: { precision: number; height: number; width: number; comps: { id: number; h: number; v: number; td: number }[] } | null = null;
  let restartInterval = 0;
  let out: LosslessJpeg | null = null;
  while (p < data.length) {
    if (data[p] !== 0xff) { p++; continue; }
    const marker = data[p + 1];
    if (marker === 0xff) { p++; continue; }
    p += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;                                            // EOI
    const len = u16(p);
    const seg = p + 2, segEnd = p + len;
    if (marker === 0xc3) {                                                 // SOF3: lossless, Huffman
      const precision = data[seg], height = u16(seg + 1), width = u16(seg + 3), n = data[seg + 5];
      const comps = [];
      for (let i = 0; i < n; i++) { const q = seg + 6 + 3 * i; comps.push({ id: data[q], h: data[q + 1] >> 4, v: data[q + 1] & 15, td: 0 }); }
      frame = { precision, height, width, comps };
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc9 || marker === 0xca || marker === 0xcb || marker === 0xcf || marker === 0xc7) {
      throw new Error(`JPEG: SOF${marker - 0xc0} is not the lossless process (14); this decoder reads SOF3 only`);
    } else if (marker === 0xc4) {                                          // DHT
      let q = seg;
      while (q < segEnd) {
        const tc = data[q] >> 4, th = data[q] & 15; q++;
        const bits = data.subarray(q, q + 16); q += 16;
        let total = 0; for (let i = 0; i < 16; i++) total += bits[i];
        const vals = data.subarray(q, q + total); q += total;
        if (tc === 0) dc[th] = buildHuffman(bits, vals);                  // lossless uses DC tables only
      }
    } else if (marker === 0xdd) {                                          // DRI
      restartInterval = u16(seg);
    } else if (marker === 0xda) {                                          // SOS
      if (!frame) throw new Error("JPEG lossless: scan before frame header");
      const ns = data[seg];
      const scomps: { c: number; td: number }[] = [];
      for (let i = 0; i < ns; i++) {
        const id = data[seg + 1 + 2 * i], td = data[seg + 2 + 2 * i] >> 4;
        const c = frame.comps.findIndex((x) => x.id === id);
        if (c < 0) throw new Error("JPEG lossless: scan names a component the frame does not have");
        scomps.push({ c, td });
      }
      const q = seg + 1 + 2 * ns;
      const predictor = data[q], pt = data[q + 2] & 15;                   // Ss = predictor, Al = point transform
      if (ns !== frame.comps.length) throw new Error(`JPEG lossless: ${ns} of ${frame.comps.length} components in one scan (non-interleaved scans are not supported)`);
      for (const c of frame.comps) if (c.h !== 1 || c.v !== 1) throw new Error("JPEG lossless: subsampled components are not supported");
      out = decodeScan(data, segEnd, frame, scomps.map((s) => { const t = dc[s.td]; if (!t) throw new Error("JPEG lossless: scan uses a Huffman table that was not defined"); return t; }), predictor, pt, restartInterval);
      break;
    }
    p = segEnd;
  }
  if (!out) throw new Error("JPEG lossless: no scan found");
  return out;
}

function decodeScan(data: Uint8Array, start: number, frame: { precision: number; height: number; width: number; comps: unknown[] }, tables: Huff[], predictor: number, pt: number, restartInterval: number): LosslessJpeg {
  const { width, height, precision } = frame;
  const nc = tables.length;
  const npix = width * height;
  const pixels = precision > 8 ? new Uint16Array(npix * nc) : new Uint8Array(npix * nc);
  const mask = 0xffff;                                                     // reconstruction is modulo 2^16 (T.81 H.1.2.1)
  const initial = 1 << (precision - pt - 1);
  const br = new BitReader(data, start, data.length);
  let mcusLeft = restartInterval || Infinity;
  let restarted = true;                                                    // the first line after a restart predicts as the first line
  let rowOfRestart = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mcusLeft === 0) { br.restart(); mcusLeft = restartInterval; restarted = true; rowOfRestart = y; }
      for (let c = 0; c < nc; c++) {
        const i = (y * width + x) * nc + c;
        // The prediction (H.1.2.1): the first sample after a restart from 2^(P-Pt-1); the rest of
        // that line from the left neighbor; the first column from the sample above; elsewhere the
        // selected predictor over a (left), b (above), c (above-left).
        let pred: number;
        const firstLine = y === rowOfRestart && restarted;
        if (firstLine && x === 0) pred = initial;
        else if (firstLine) pred = pixels[i - nc];
        else if (x === 0) pred = pixels[i - width * nc];
        else {
          const a = pixels[i - nc], b = pixels[i - width * nc], cc = pixels[i - width * nc - nc];
          switch (predictor) {
            case 1: pred = a; break;
            case 2: pred = b; break;
            case 3: pred = cc; break;
            case 4: pred = a + b - cc; break;
            case 5: pred = a + ((b - cc) >> 1); break;
            case 6: pred = b + ((a - cc) >> 1); break;
            case 7: pred = (a + b) >> 1; break;
            default: throw new Error(`JPEG lossless: predictor ${predictor}`);
          }
        }
        const ssss = br.decode(tables[c]);
        let diff: number;
        if (ssss === 0) diff = 0;
        else if (ssss === 16) diff = 32768;
        else {
          const v = br.read(ssss);
          diff = v < (1 << (ssss - 1)) ? v - (1 << ssss) + 1 : v;         // EXTEND (F.2.2.1)
        }
        pixels[i] = ((pred + diff) & mask) << pt;
      }
      if (restartInterval) mcusLeft--;
    }
    if (restarted && y > rowOfRestart) restarted = false;
  }
  return { width, height, components: nc, precision, pixels };
}
