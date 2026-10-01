// The RLE and JPEG lossless decoders against an INDEPENDENT decoder's output: pydicom through
// libjpeg and its own RLE, stored beside each sample by Contents/data/codecs/make-truths.py.
// The samples are fetched, not committed (Contents/data/codecs/fetch-codecs.py); without them
// the tests are skipped and say so.
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "../dcmjs.ts";
import { decodeRleFrame } from "./rle.ts";
import { decodeJpegLossless } from "./jpeg-lossless.ts";
import { framesOf } from "./encapsulated.ts";
import { ABSENT, testData } from "../../test/test-data.ts";

const BASE = testData("codecs") ?? ABSENT;
const have = (p: string) => { try { Deno.statSync(p); return true; } catch { return false; } };

interface Truth { shape: number[]; dtype: string; min: number; max: number }
function readTruth(path: string): { t: Truth; data: Uint8Array | Uint16Array | Int16Array | Uint32Array } | null {
  if (!have(path + ".truth.json")) return null;
  const t = JSON.parse(Deno.readTextFileSync(path + ".truth.json")) as Truth;
  const raw = Deno.readFileSync(path + ".truth.raw");
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const data = t.dtype === "uint8" ? new Uint8Array(buf) : t.dtype === "int16" ? new Int16Array(buf) : t.dtype === "uint32" ? new Uint32Array(buf) : new Uint16Array(buf);
  return { t, data };
}

function parse(path: string) {
  const buf = Deno.readFileSync(path);
  const p = dcmjs.data.DicomMessage.readFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(p.dict) as Record<string, unknown>;
  const pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
  const frags = (Array.isArray(pd) ? pd : [pd]).map((b) => new Uint8Array(b));
  return { ds, frags, frames: Number(ds.NumberOfFrames ?? 1), rows: Number(ds.Rows), cols: Number(ds.Columns), spp: Number(ds.SamplesPerPixel ?? 1), bits: Number(ds.BitsAllocated), signed: ds.PixelRepresentation === 1 };
}

const compare = (got: ArrayLike<number>, truth: ArrayLike<number>, name: string) => {
  assertEquals(got.length, truth.length, `${name}: ${got.length} samples, truth has ${truth.length}`);
  let bad = 0, first = -1;
  for (let i = 0; i < got.length; i++) if (got[i] !== truth[i]) { if (first < 0) first = i; bad++; }
  assertEquals(bad, 0, `${name}: ${bad} of ${got.length} samples differ, first at ${first}: ${got[first]} vs ${truth[first]}`);
};

const RLE_FILES = ["MR_small_RLE.dcm", "emri_small_RLE.dcm", "SC_rgb_rle_16bit.dcm", "rtdose_rle.dcm", "OBXXXX1A_rle.dcm"];
Deno.test("RLE: every sample decodes to the independent decoder's pixels", () => {
  let n = 0;
  for (const f of RLE_FILES) {
    const path = `${BASE}1.2.840.10008.1.2.5/${f}`;
    const truth = readTruth(path); if (!truth) continue;
    const { frags, frames, rows, cols, spp, bits, signed } = parse(path);
    const bps = bits / 8;
    const out: number[] = [];
    for (const fr of framesOf(frags, frames, "rle")) {
      const bytes = decodeRleFrame(fr, rows, cols, spp, bps);
      const view = bps === 1 ? bytes : bps === 2 ? (signed ? new Int16Array(bytes.buffer) : new Uint16Array(bytes.buffer)) : new Uint32Array(bytes.buffer);
      for (let i = 0; i < view.length; i++) out.push(view[i]);
    }
    compare(out, truth.data, f); n++;
  }
  if (!n) console.log("  (no codec samples fetched; see Contents/data/codecs/fetch-codecs.py)");
  else console.log(`  ${n} RLE files exact`);
});

const JLL_FILES = ["JPEG-LL.dcm", "JPGLosslessP14SV1_1s_1f_8b.dcm", "bad_sequence.dcm"];
Deno.test("JPEG lossless: every sample decodes to the independent decoder's pixels", () => {
  let n = 0;
  for (const f of JLL_FILES) {
    const path = `${BASE}1.2.840.10008.1.2.4.70/${f}`;
    const truth = readTruth(path); if (!truth) continue;
    const { frags, frames, rows, cols, spp, signed } = parse(path);
    const out: number[] = [];
    for (const fr of framesOf(frags, frames, "jpeg")) {
      const j = decodeJpegLossless(fr);
      assertEquals([j.height, j.width, j.components], [rows, cols, spp], `${f}: geometry`);
      // The truth is what pydicom returns: signed values when PixelRepresentation says so.
      for (let i = 0; i < j.pixels.length; i++) { const v = j.pixels[i]; out.push(signed && v > 32767 ? v - 65536 : v); }
    }
    compare(out, truth.data, f); n++;
  }
  if (n) console.log(`  ${n} JPEG lossless files exact`);
});

Deno.test("JPEG lossless: a real CT slice from IDC (MIDRC, 16-bit) decodes to the reference", () => {
  const dir = testData("idc", "midrc_ricord_1a") ?? ABSENT;
  if (!have(dir)) return;
  const files: string[] = [];
  const walk = (d: string) => { for (const e of Deno.readDirSync(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) walk(p); else if (e.name.endsWith(".dcm")) files.push(p); } };
  walk(dir);
  files.sort();
  let n = 0;
  for (const path of files) {
    const truth = readTruth(path); if (!truth) continue;
    const { frags, frames, rows, cols, signed } = parse(path);
    const j = decodeJpegLossless(framesOf(frags, frames, "jpeg")[0]);
    assertEquals([j.height, j.width], [rows, cols]);
    const out = new Int32Array(j.pixels.length);
    for (let i = 0; i < out.length; i++) { const v = j.pixels[i]; out[i] = signed && v > 32767 ? v - 65536 : v; }
    compare(out, truth.data, path.split("/").pop()!); n++;
  }
  assert(n > 0 || files.length === 0, "the MIDRC series is fetched but no truths were made for it");
  if (n) console.log(`  ${n} MIDRC slices exact`);
});

Deno.test("the series reader reconstructs a JPEG-lossless CT (MIDRC, 66 slices) and a coronal one (TCGA-UCEC)", async () => {
  const { loadDicomSeries, setDcmjs } = await import("../readers/dicom-series.ts");
  setDcmjs(dcmjs);   // Deno has no document to load dcmjs into; the test injects the same module
  for (const [name, sub] of [["MIDRC", "midrc_ricord_1a"], ["TCGA-UCEC", "tcga_ucec"]]) {
    const dir = testData("idc", sub) ?? ABSENT;
    if (!have(dir)) continue;
    const files: string[] = [];
    const walk = (d: string) => { for (const e of Deno.readDirSync(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) walk(p); else if (e.name.endsWith(".dcm")) files.push(p); } };
    walk(dir);
    const bufs = files.map((f) => { const b = Deno.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
    const t0 = performance.now();
    const out = await loadDicomSeries(bufs);
    const ms = performance.now() - t0;
    // The reader splits a series by orientation (a localizer rides along in some), so take the
    // largest and require that nearly every file landed in it.
    out.sort((a, b) => b.volume.dims[2] - a.volume.dims[2]);
    const v = out[0].volume;
    const placed = out.reduce((n, o) => n + o.volume.dims[2], 0);
    assertEquals(placed, files.length, `${name}: every slice decoded and placed (${out.map((o) => o.volume.dims[2]).join(" + ")})`);
    assert(v.dims[0] >= 512 && v.dims[1] >= 512, `${name}: ${v.dims}`);
    console.log(`  ${name}: ${files.length} slices → ${out.map((o) => o.volume.dims.join("×")).join(" and ")} in ${(ms / 1000).toFixed(2)} s (${(ms / files.length).toFixed(1)} ms per slice, parse + decode)`);
  }
});
