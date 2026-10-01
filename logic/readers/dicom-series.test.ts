// T1: DICOM series reconstruction geometry (no dcmjs — synthetic instances). Mirrors Slicer's
// DICOMScalarVolumePlugin: sort by IPP·normal, ijkToRAS from IOP/IPP/PixelSpacing (LPS->RAS), subseries split.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type DicomInstance, groupSeries, reconstructSeries, tmToSeconds } from "./dicom-series.ts";

function axialSlice(k: number, o: Partial<DicomInstance> = {}): DicomInstance {
  const nx = 4, ny = 3;
  const pixels = new Int16Array(nx * ny);
  for (let p = 0; p < nx * ny; p++) pixels[p] = k * 1000 + p;               // distinct per (slice, pixel)
  return {
    seriesInstanceUID: "1.2.3", rows: ny, columns: nx, pixelSpacing: [0.8, 0.5],   // [rowSpacing y, colSpacing x]
    imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [-10, -20, 5 + k * 2],   // LPS, 2 mm spacing
    rescaleSlope: 1, rescaleIntercept: 0, pixelRepresentation: 1, modality: "CT", pixels, ...o,
  };
}

Deno.test("reconstructSeries: LPS->RAS ijkToRAS from IOP/IPP/PixelSpacing", () => {
  const v = reconstructSeries([axialSlice(0), axialSlice(1), axialSlice(2)]);
  assertEquals(v.dims, [4, 3, 3]);
  // i (columns/x) uses COLUMN spacing 0.5, negated x (LPS->RAS): -0.5; j (rows/y) uses ROW spacing 0.8, negated: -0.8
  assertEquals(v.ijkToRAS, [-0.5, 0, 0, 10, 0, -0.8, 0, 20, 0, 0, 2, 5, 0, 0, 0, 1]);
  assertEquals(v.dtype, "<i2");
});

Deno.test("reconstructSeries: shuffled slices sort by IPP·normal, voxel order preserved", () => {
  const v = reconstructSeries([axialSlice(2), axialSlice(0), axialSlice(1)]);
  // slice 0 lands first (smallest z), value at voxel 0 of slice 0 = 0
  assertEquals(v.data[0], 0);
  assertEquals(v.data[4 * 3], 1000);      // start of slice 1
  assertEquals(v.data[4 * 3 * 2], 2000);  // start of slice 2
});

Deno.test("reconstructSeries: per-slice rescale slope/intercept", () => {
  const v = reconstructSeries([axialSlice(0, { rescaleSlope: 2, rescaleIntercept: -1000 }), axialSlice(1, { rescaleSlope: 2, rescaleIntercept: -1000 })]);
  assertEquals(v.data[0], -1000);            // 0*2 - 1000
  assertEquals(v.data[1], -998);             // 1*2 - 1000
  assertEquals(v.data[4 * 3], 1000 * 2 - 1000);   // slice 1 pixel 0
});

Deno.test("reconstructSeries: single slice uses SliceThickness for k spacing", () => {
  const v = reconstructSeries([axialSlice(0, { sliceThickness: 3 })]);
  assertEquals(v.dims, [4, 3, 1]);
  assertEquals(v.ijkToRAS[10], 3);           // c2 z = normal.z * sliceThickness
});

Deno.test("groupSeries: split one series into subseries by orientation", () => {
  const axial = [axialSlice(0), axialSlice(1)];
  const sag: DicomInstance = axialSlice(0, { imageOrientationPatient: [0, 1, 0, 0, 0, -1], imagePositionPatient: [3, -20, 5] });
  const groups = groupSeries([...axial, sag]);
  assertEquals(groups.length, 2);
  assert(groups.every((g) => g.seriesInstanceUID.startsWith("1.2.3")));
  assertEquals(groups.map((g) => g.instances.length).sort(), [1, 2]);
});

Deno.test("groupSeries: distinct SeriesInstanceUIDs stay separate", () => {
  const a = axialSlice(0), b = axialSlice(0, { seriesInstanceUID: "9.9.9" });
  assertEquals(groupSeries([a, b]).length, 2);
});

// THE C3L-03960 CASE. Every reformatted series carries the axial picture it was planned on as
// instance 1. Building a volume from all of it placed that picture as a coronal plane and, worse,
// stretched the volume: the derived spacing took the stray position in. The reconstruction now
// refuses a mixed series outright, so a caller that forgets to split cannot get a wrong volume.
Deno.test("reconstructSeries: refuses a slice of another orientation, size or spacing", () => {
  const coronal = [0, 1, 2].map((k) => axialSlice(k, { imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [-10, -20 + k * 3, 5] }));
  const reference = axialSlice(9, { imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: [-10, -193, -284] });
  let msg = "";
  try { reconstructSeries([...coronal, reference]); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("different orientation"), msg);
  const wrongSize = axialSlice(3, { imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [-10, -11, 5], rows: 2, columns: 2, pixels: new Int16Array(4) });
  msg = ""; try { reconstructSeries([...coronal, wrongSize]); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("2×2"), msg);
  const wrongSpacing = axialSlice(3, { imageOrientationPatient: [1, 0, 0, 0, 0, -1], imagePositionPatient: [-10, -11, 5], pixelSpacing: [0.9, 0.5] });
  msg = ""; try { reconstructSeries([...coronal, wrongSpacing]); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes("mm pixels"), msg);
  // and the split-then-reconstruct path gives the right spacing: 3 mm, not stretched
  const groups = groupSeries([...coronal, reference]).sort((a, b) => b.instances.length - a.instances.length);
  const vol = reconstructSeries(groups[0].instances);
  assertEquals(vol.dims, [4, 3, 3]);
  const kLen = Math.hypot(vol.ijkToRAS[2], vol.ijkToRAS[6], vol.ijkToRAS[10]);
  assert(Math.abs(kLen - 3) < 1e-9, `slice spacing ${kLen}`);
});

// A GATED CORONARY CASE, in miniature: every position written once per cardiac phase, instances
// numbered phase-major, the phase in ImageComments as the R-wave delay -- and one phase assembled
// from several passes with delays a few ms apart (208/212/213/217 for a nominal 200).
Deno.test("groupSeries: a gated series splits into its phases by repeated position and instance order", () => {
  const nz = 4, phases = [[208, 212, 213, 217], [250, 250, 250, 250], [300, 300, 300, 300]];
  const inst: DicomInstance[] = [];
  let n = 1;
  for (const delays of phases) for (let k = 0; k < nz; k++) {
    inst.push(axialSlice(k, { instanceNumber: n++, imageComments: `\r\n86bpm, ${delays[k]}ms, 66ms, TS, ME_67keV` }));
  }
  // shuffled, as a database hands them back
  inst.sort(() => Math.random() - 0.5);
  const groups = groupSeries(inst);
  assertEquals(groups.length, 3);
  assertEquals(groups.map((g) => g.temporal?.label), ["213 ms", "250 ms", "300 ms"]);   // the upper median of 208/212/213/217
  assertEquals(groups.map((g) => g.temporal?.index), [0, 1, 2]);
  // and WHEN each frame is: the delay as a number and the heart rate, for playing at the true rate
  assertEquals(groups.map((g) => g.temporal?.delayMs), [213, 250, 300]);
  assertEquals(groups.map((g) => g.temporal?.bpm), [86, 86, 86]);
  assertEquals(groups.map((g) => g.seriesInstanceUID), ["1.2.3#t0", "1.2.3#t1", "1.2.3#t2"]);
  for (const g of groups) {
    assertEquals(g.instances.length, nz);
    assertEquals(g.temporal?.count, 3);
    const vol = reconstructSeries(g.instances);                  // each frame is a clean stack
    assertEquals(vol.dims, [4, 3, nz]);
  }
  // frame 1 holds exactly the instances 5..8
  assertEquals(groups[1].instances.map((i) => i.instanceNumber).sort((a, b) => a! - b!), [5, 6, 7, 8]);
});

Deno.test("groupSeries: one position many times is a sequence of single slices (bolus monitoring); uneven repeats are not a sequence", () => {
  const mon = Array.from({ length: 10 }, (_, j) => axialSlice(0, { instanceNumber: j + 1, acquisitionTime: `1200${(j * 0.9 + 1.5).toFixed(3).padStart(6, "0")}` }));
  const g = groupSeries(mon);
  assertEquals(g.length, 10);
  // no R-wave delay: the ordinal names it, and the acquisition time (seconds of the day) says when
  assertEquals(g[3].temporal, { index: 3, count: 10, label: "4 of 10", timeSec: 12 * 3600 + 4.2 });
  // a series where one position repeats and the others do not is a stack with a duplicate, left whole
  const odd = [axialSlice(0, { instanceNumber: 1 }), axialSlice(1, { instanceNumber: 2 }), axialSlice(1, { instanceNumber: 3 })];
  assertEquals(groupSeries(odd).length, 1);
  assertEquals(groupSeries(odd)[0].temporal, undefined);
});

Deno.test("tmToSeconds: DICOM TM in its three lengths, and not-a-time", () => {
  assertEquals(tmToSeconds("101530.250000"), 10 * 3600 + 15 * 60 + 30.25);
  assertEquals(tmToSeconds("1200"), 12 * 3600);
  assertEquals(tmToSeconds("09"), 9 * 3600);
  assertEquals(tmToSeconds(""), undefined);
  assertEquals(tmToSeconds(undefined), undefined);
});

// A GAP IN THE SLICE POSITIONS IS SAID, NOT SMOOTHED OVER (critic, 2026-09-17, finding 10): the
// spacing comes from first-to-last, so a series with a gap reconstructs on a grid its middle slices
// are not on. The reader records the worst deviation; a regular series records nothing.
Deno.test("reconstructSeries: irregular slice spacing is recorded, regular spacing is not", () => {
  const regular = reconstructSeries([axialSlice(0), axialSlice(1), axialSlice(2), axialSlice(3)]);
  assertEquals((regular.meta as { irregularSpacing?: unknown }).irregularSpacing, undefined);
  // positions 5, 7, 9, 11, 25, 27, 29 mm: a 14 mm jump in a 2 mm series
  const gap = reconstructSeries([0, 1, 2, 3, 10, 11, 12].map((k) => axialSlice(k)));
  const irr = (gap.meta as { irregularSpacing?: { worstMm: number; atSlice: number } }).irregularSpacing;
  assert(irr, "a gap must be recorded");
  assert(irr.worstMm > 2, `the worst deviation is well past one slice: ${irr.worstMm} mm`);
});

// Critic, 2026-09-25, finding 11: a whole-number rescale past 16 bits no longer wraps.
Deno.test("reconstructSeries: values past 16 bits get a type that holds them (no wraparound)", () => {
  const mk = (px: number[], o: Partial<DicomInstance>, z: number): DicomInstance => ({
    seriesInstanceUID: "1.2.3", rows: 1, columns: 2, pixelSpacing: [1, 1], imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    imagePositionPatient: [0, 0, z], pixels: Uint16Array.from(px), ...o,
  });
  const mr = reconstructSeries([mk([40000, 10], { modality: "MR", rescaleSlope: 2, rescaleIntercept: 0 }, 0), mk([1, 2], { modality: "MR", rescaleSlope: 2, rescaleIntercept: 0 }, 1)]);
  assertEquals(mr.data[0], 80000);
  const ct = reconstructSeries([mk([65535, 0], { modality: "CT", rescaleSlope: 1, rescaleIntercept: -1024 }, 0), mk([1000, 2000], { modality: "CT", rescaleSlope: 1, rescaleIntercept: -1024 }, 1)]);
  assertEquals([ct.data[0], ct.data[1]], [64511, -1024]);
  const plain = reconstructSeries([mk([100, 200], { modality: "CT", rescaleIntercept: -1024 }, 0), mk([300, 400], { modality: "CT", rescaleIntercept: -1024 }, 1)]);
  assert(plain.data instanceof Int16Array, "an ordinary CT stays 16-bit");
});

// A VALUE LONGER THAN THE FILE (2026-09-25, dcmjs 0.52 on a damaged RT dose file): 0.52 reads on past a garbled value
// type inside a sequence and returns a 775 MB value from a 6.8 KB file. The reader refuses such a file as damaged.
Deno.test("valueLongerThan: finds a binary value longer than the file, at any depth; none in a sound file", async () => {
  const { valueLongerThan } = await import("./dicom-series.ts");
  const huge = new Uint8Array(new ArrayBuffer(10_000));          // a view claiming 10,000 bytes, in a "file" of 7,000
  const dict = { "00080016": { vr: "UI", Value: ["1.2"] }, "00081115": { vr: "SQ", Value: [{ "00081150": { vr: "UN", Value: [huge] } }] } };
  assertEquals(valueLongerThan(dict, 7000), "00081150");
  assertEquals(valueLongerThan(dict, 20_000), undefined);
  assertEquals(valueLongerThan({ "7FE00010": { vr: "OW", Value: [new ArrayBuffer(512)] } }, 6816), undefined);
});
