// The vendored WebAssembly codecs against the independent truths (pydicom through libjpeg,
// CharLS, OpenJPEG): every sample in Contents/data/codecs that a codec here covers must decode
// to the same samples. Lossy files (JPEG baseline/extended, JPEG 2000 lossy, HTJ2K lossy) are
// compared to the same reference decoder's output, which for the lossy DCT codecs may differ by
// rounding between libjpeg builds -- a tolerance of 1 is allowed there and reported.
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "../dcmjs.ts";
import { CODEC_FILES, type CodecName, decodeWith, instantiateCodec } from "./wasm.ts";
import { framesOf } from "./encapsulated.ts";
import { ABSENT, testData } from "../../test/test-data.ts";

const BASE = testData("codecs") ?? ABSENT;
const VENDOR = new URL("../../render/vendor/codecs/", import.meta.url).pathname;
const have = (p: string) => { try { Deno.statSync(p); return true; } catch { return false; } };

async function codec(name: CodecName) {
  const f = CODEC_FILES[name];
  return await instantiateCodec(Deno.readTextFileSync(VENDOR + f.js), Deno.readFileSync(VENDOR + f.wasm));
}
function parse(path: string) {
  const buf = Deno.readFileSync(path);
  const p = dcmjs.data.DicomMessage.readFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(p.dict) as Record<string, unknown>;
  const pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
  return { ds, frags: (Array.isArray(pd) ? pd : [pd]).map((b) => new Uint8Array(b)), frames: Number(ds.NumberOfFrames ?? 1), rows: Number(ds.Rows), cols: Number(ds.Columns), spp: Number(ds.SamplesPerPixel ?? 1), signed: ds.PixelRepresentation === 1, photometric: String(ds.PhotometricInterpretation ?? ""), bitsStored: Number(ds.BitsStored ?? 16) };
}
function truth(path: string): { dtype: string; data: ArrayLike<number> } | null {
  if (!have(path + ".truth.json")) return null;
  const t = JSON.parse(Deno.readTextFileSync(path + ".truth.json")) as { dtype: string };
  const raw = Deno.readFileSync(path + ".truth.raw");
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return { dtype: t.dtype, data: t.dtype === "uint8" ? new Uint8Array(buf) : t.dtype === "int16" ? new Int16Array(buf) : new Uint16Array(buf) };
}

const CASES: { ts: string; file: string; codec: CodecName; tolerance?: number }[] = [
  { ts: "1.2.840.10008.1.2.4.50", file: "SC_rgb_jpeg_dcmtk.dcm", codec: "jpeg8", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.50", file: "examples_ybr_color.dcm", codec: "jpeg8", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.80", file: "emri_small_jpeg_ls_lossless.dcm", codec: "jpegls" },
  { ts: "1.2.840.10008.1.2.4.80", file: "JLSL_16_15_1_1F.dcm", codec: "jpegls" },
  { ts: "1.2.840.10008.1.2.4.81", file: "JPEGLSNearLossless_16.dcm", codec: "jpegls" },
  { ts: "1.2.840.10008.1.2.4.90", file: "693_J2KR.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.90", file: "MR2_J2KR.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.90", file: "RG3_J2KR.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.90", file: "US1_J2KR.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.90", file: "emri_small_jpeg_2k_lossless.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.90", file: "J2K_pixelrep_mismatch.dcm", codec: "j2k" },
  { ts: "1.2.840.10008.1.2.4.91", file: "693_J2KI.dcm", codec: "j2k", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.91", file: "MR2_J2KI.dcm", codec: "j2k", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.91", file: "US1_J2KI.dcm", codec: "j2k", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.91", file: "JPEG2000.dcm", codec: "j2k", tolerance: 1 },
  { ts: "1.2.840.10008.1.2.4.201", file: "HTJ2KLossless_08_RGB.dcm", codec: "htj2k" },
  { ts: "1.2.840.10008.1.2.4.203", file: "HTJ2K_08_RGB.dcm", codec: "htj2k", tolerance: 1 },
];

Deno.test("the vendored codecs decode every sample to the independent decoder's samples", async () => {
  const mods = new Map<CodecName, Awaited<ReturnType<typeof codec>>>();
  const lines: string[] = [];
  let n = 0;
  for (const c of CASES) {
    const path = `${BASE}${c.ts}/${c.file}`;
    const t = truth(path); if (!t) continue;
    if (!mods.has(c.codec)) mods.set(c.codec, await codec(c.codec));
    let parsed: ReturnType<typeof parse>;
    try { parsed = parse(path); } catch (e) { lines.push(`  ${c.codec.padEnd(6)} ${c.file.padEnd(34)} SKIPPED: dcmjs cannot parse it (${(e as Error).message.slice(0, 70)})`); continue; }
    const { frags, frames, rows, cols, spp, signed, photometric, bitsStored } = parsed;
    const out: number[] = [];
    let info = { width: 0, height: 0, bitsPerSample: 0, componentCount: 0, isSigned: false };
    const t0 = performance.now();
    for (const fr of framesOf(frags, frames, "jpeg")) {
      const r = decodeWith(mods.get(c.codec)!, CODEC_FILES[c.codec].cls, fr);
      info = r.info;
      // Signed samples are two's complement in BitsStored bits (a 15-bit signed file: bit 14 is
      // the sign), not in 16: JLSL_16_15_1_1F was 13,451 samples off by 32768 until this.
      const half = 1 << (bitsStored - 1), full = 1 << bitsStored;
      // And masked to BitsStored first: OpenJPEG's 14-bit signed output carried a set bit 15
      // above the 14 two's-complement bits (693_J2KI: 47136 for -2016).
      for (let i = 0; i < r.samples.length; i++) { const v = info.bitsPerSample > 8 ? r.samples[i] & (full - 1) : r.samples[i]; out.push(signed && info.bitsPerSample > 8 && v >= half ? v - full : v); }
    }
    const ms = performance.now() - t0;
    assertEquals([info.height, info.width, info.componentCount], [rows, cols, spp], `${c.file}: geometry`);
    assertEquals(out.length, t.data.length, `${c.file}: sample count`);
    let bad = 0, maxDiff = 0, first = -1;
    for (let i = 0; i < out.length; i++) { const d = Math.abs(out[i] - t.data[i]); if (d > (c.tolerance ?? 0)) { if (first < 0) first = i; bad++; } if (d > maxDiff) maxDiff = d; }
    assertEquals(bad, 0, `${c.file} (${photometric}): ${bad} of ${out.length} samples differ by more than ${c.tolerance ?? 0}, first at ${first}: ${out[first]} vs ${t.data[first]}, max diff ${maxDiff}`);
    lines.push(`  ${c.codec.padEnd(6)} ${c.file.padEnd(34)} ${rows}x${cols}x${frames} ${info.bitsPerSample}-bit ${photometric.padEnd(12)} max diff ${maxDiff}  ${ms.toFixed(1)} ms`);
    n++;
  }
  console.log(lines.join("\n"));
  assert(n > 0 || !have(BASE), "samples present but no truths");
});

Deno.test("JPEG extended 12-bit: NLST's lossy CT slices decode to the reference (libjpeg)", async () => {
  const dir = testData("idc", "nlst") ?? ABSENT;
  if (!have(dir)) return;
  const files: string[] = [];
  const walk = (d: string) => { for (const e of Deno.readDirSync(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) walk(p); else if (e.name.endsWith(".dcm")) files.push(p); } };
  walk(dir); files.sort();
  const mod = await codec("jpeg12");
  let n = 0;
  for (const path of files) {
    const t = truth(path); if (!t) continue;
    const { frags, frames, rows, cols } = parse(path);
    const t0 = performance.now();
    const r = decodeWith(mod, CODEC_FILES.jpeg12.cls, framesOf(frags, frames, "jpeg")[0]);
    const ms = performance.now() - t0;
    assertEquals([r.info.height, r.info.width, r.info.bitsPerSample], [rows, cols, 12]);
    // Two libjpeg builds (libjpeg-turbo here, pylibjpeg's libjpeg there) round the inverse DCT
    // differently: a handful of samples differ by 2 on 12-bit data. That is the codec's own
    // noise floor, far below the quantization the file was written with; more than 2 is a bug.
    let bad = 0, off = 0, maxDiff = 0;
    for (let i = 0; i < r.samples.length; i++) { const d = Math.abs(r.samples[i] - t.data[i]); if (d > 2) bad++; if (d > 0) off++; if (d > maxDiff) maxDiff = d; }
    assertEquals(bad, 0, `${path.split("/").pop()}: ${bad} samples differ by more than 2 (max ${maxDiff})`);
    console.log(`  jpeg12 NLST ${path.split("/").pop()!.slice(0, 8)} ${rows}x${cols} 12-bit: ${off} of ${r.samples.length} samples differ from libjpeg by up to ${maxDiff}  ${ms.toFixed(1)} ms`);
    n++;
  }
  assert(n > 0 || files.length === 0, "NLST fetched but no truths");
});

Deno.test("the series reader reconstructs NLST's lossy-JPEG CT (147 slices) through the codec", async () => {
  const dir = testData("idc", "nlst") ?? ABSENT;
  if (!have(dir)) return;
  const { loadDicomSeries, setDcmjs, lastSkipReasons } = await import("../readers/dicom-series.ts");
  setDcmjs(dcmjs);
  const files: string[] = [];
  const walk = (d: string) => { for (const e of Deno.readDirSync(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) walk(p); else if (e.name.endsWith(".dcm")) files.push(p); } };
  walk(dir);
  const bufs = files.map((f) => { const b = Deno.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
  const t0 = performance.now();
  const out = await loadDicomSeries(bufs);
  const ms = performance.now() - t0;
  const placed = out.reduce((n, o) => n + o.volume.dims[2], 0);
  assertEquals(placed, files.length, `every slice decoded and placed (${out.map((o) => o.volume.dims.join("×")).join(" + ")}); skipped: ${[...lastSkipReasons.entries()].join(", ")}`);
  console.log(`  NLST: ${files.length} slices → ${out.map((o) => o.volume.dims.join("×")).join(" and ")} in ${(ms / 1000).toFixed(2)} s (${(ms / files.length).toFixed(1)} ms per slice, parse + decode)`);
});
