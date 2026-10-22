// Every reader in this directory faces a format that offers more than one way to say where a voxel
// is, and picking between them is a decision made on the caller's behalf. Until now none of them
// recorded which. These tests are about the record, not the arithmetic — the arithmetic was already
// right, which is why the absence of the record was easy to miss.
//
//   deno test -A --no-check logic/readers/geometry-source.test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { parseNifti } from "./nifti.ts";
import { makeNifti } from "./synthetic.ts";
import { reconstructSeries } from "./dicom-series.ts";

/** Set `xyzt_units` (NIfTI-1 offset 123), which `makeNifti` has no option for. */
function withUnits(bytes: Uint8Array, xyzt: number): Uint8Array {
  const out = bytes.slice();
  out[123] = xyzt;
  return out;
}

// --- NIfTI: which of the three methods, and did the other one agree? ----------------------------

Deno.test("nifti: sform is used, and is recorded as the mechanism", async () => {
  const v = await parseNifti(makeNifti({ sform: [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5] }));
  assertEquals(v.geometry?.mechanism, "sform");
  assertEquals(v.geometry?.origin, "acquired");
  // NIfTI mandates RAS+ — unlike NRRD, the format gives no way to declare a non-anatomical frame.
  assertEquals(v.geometry?.anatomical, true);
  // Only one mechanism was present, so there is nothing to agree or disagree with.
  assertEquals(v.geometry?.qformAgreesWithSform, undefined);
});

// The case the format permits and does not adjudicate: both codes non-zero, carrying different
// transforms. Convention prefers sform; convention is not a specification. The file is ambiguous
// about where its own voxels are, and a caller should be able to find that out.
Deno.test("nifti: a qform that DISAGREES with the sform is reported, not silently discarded", async () => {
  const v = await parseNifti(makeNifti({
    sform: [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5],
    qform: { b: 0, c: 0, d: 0, qfac: 1, off: [99, 99, 99] },   // a different origin entirely
  }));
  assertEquals(v.geometry?.mechanism, "sform", "sform still wins");
  assertEquals(v.geometry?.qformAgreesWithSform, false, "and the disagreement is on the record");
  assertEquals(v.ijkToRAS[3], -10, "the sform's translation, not the qform's 99");
});

Deno.test("nifti: a qform that agrees is reported as agreeing", async () => {
  // pixdim 2,2,3 with an identity quaternion and offset (-10,-20,5) reproduces the sform exactly.
  const v = await parseNifti(makeNifti({
    sform: [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5],
    qform: { b: 0, c: 0, d: 0, qfac: 1, off: [-10, -20, 5] },
    pixdim: [1, 2, 2, 3],
  }));
  assertEquals(v.geometry?.qformAgreesWithSform, true);
});

Deno.test("nifti: qform alone is recorded as the mechanism", async () => {
  const v = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [1, 2, 3] }, pixdim: [1, 0.5, 0.75, 2] }));
  assertEquals(v.geometry?.mechanism, "qform");
  assertEquals(v.geometry?.origin, "acquired");
  assertEquals(v.geometry?.qformAgreesWithSform, undefined);
});

// Method 1 — ANALYZE 7.5. Spacing only, no orientation stated anywhere in the file. The reader has
// always produced an axis-aligned matrix here; what is new is that it says so.
Deno.test("nifti: pixdim-only geometry is an assumption, and says so", async () => {
  const v = await parseNifti(makeNifti({ pixdim: [1, 1.5, 1.5, 3] }));
  assertEquals(v.geometry?.origin, "assumed");
  assertEquals(v.geometry?.mechanism, "pixdim (no orientation in the file)");
});

// xyzt_units was not read at all, so a volume in micrometres loaded as millimetres.
Deno.test("nifti: xyzt_units gives the spatial and temporal units", async () => {
  const base = makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
  assertEquals((await parseNifti(withUnits(base, 2))).geometry?.spaceUnit, "mm");   // NIFTI_UNITS_MM
  assertEquals((await parseNifti(withUnits(base, 3))).geometry?.spaceUnit, "um");   // NIFTI_UNITS_MICRON
  assertEquals((await parseNifti(withUnits(base, 1))).geometry?.spaceUnit, "m");    // NIFTI_UNITS_METER
  // Spatial in bits 0-2, temporal in bits 3-5, in one byte for all axes.
  const both = await parseNifti(withUnits(base, 2 | 16));
  assertEquals(both.geometry?.spaceUnit, "mm");
  assertEquals(both.geometry?.timeUnit, "ms");
  // A file that says nothing says nothing — not "mm".
  assertEquals((await parseNifti(withUnits(base, 0))).geometry?.spaceUnit, undefined);
});

// THE UNIT IS HONORED, not only recorded (Ron, 2026-10-20: "did you forget about scales? from astrophysics to electron
// microscope"): the scene is in mm, so a file in micrometers or meters is converted -- spacing and position alike.
Deno.test("nifti: a file in micrometers or meters lands in the scene's mm", async () => {
  const base = makeNifti({ sform: [0.5, 0, 0, 10, 0, 0.5, 0, -20, 0, 0, 2, 30] });
  const um = await parseNifti(withUnits(base, 3));                 // NIFTI_UNITS_MICRON
  assertEquals(um.geometry?.spaceUnit, "um", "the file's own unit stays on the record");
  [5e-4, 0, 0, 0.01, 0, 5e-4, 0, -0.02, 0, 0, 2e-3, 0.03].forEach((x, i) => assertAlmostEquals(um.ijkToRAS[i], x, 1e-12));
  const m = await parseNifti(withUnits(base, 1));                  // NIFTI_UNITS_METER
  [500, 0, 0, 1e4, 0, 500, 0, -2e4, 0, 0, 2000, 3e4].forEach((x, i) => assertAlmostEquals(m.ijkToRAS[i], x, 1e-6));
  // mm, and a file that says nothing (taken as mm), are as they were.
  for (const u of [2, 0]) assertEquals((await parseNifti(withUnits(base, u))).ijkToRAS.slice(0, 4), [0.5, 0, 0, 10]);
  // The qform, and the pixdim-only map, are scaled the same way.
  const q = await parseNifti(withUnits(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [1, 2, 3] }, pixdim: [1, 4, 4, 4] }), 3));
  [4e-3, 0, 0, 1e-3].forEach((x, i) => assertAlmostEquals(q.ijkToRAS[i], x, 1e-12));
  const p = await parseNifti(withUnits(makeNifti({ pixdim: [1, 4, 4, 4] }), 1));
  assertEquals(p.ijkToRAS[0], 4000);
});

for (const [what, v, unit, code, inUnit] of [
  ["1 nm", 1e-6, "um", 3, 1e-3], ["0.7 mm", 0.7, "mm", 2, 0.7], ["1 parsec", 3.086e19, "m", 1, 3.086e16],
] as const) {
  Deno.test(`nifti: ${what} voxels written in ${unit} read as ${v} mm`, async () => {
    const vol = await parseNifti(withUnits(makeNifti({ sform: [inUnit, 0, 0, 0, 0, inUnit, 0, 0, 0, 0, inUnit, 0] }), code));
    assert(Math.abs(vol.ijkToRAS[0] - v) <= v * 1e-6, `${vol.ijkToRAS[0]} mm`);
  });
}

// "Absent means unknown": a spacing of 0 is read as 1 (the reference library's rule) and SAID to be a guess.
Deno.test("nifti: a spacing the file left at 0 is read as 1 and recorded as not declared", async () => {
  const p = await parseNifti(makeNifti({ pixdim: [1, 0, 1.5, 3] }));
  assertEquals(p.ijkToRAS[0], 1);
  assertEquals(p.ijkToRAS[5], 1.5);
  assertEquals(p.geometry?.spacingNotDeclared, [0]);
  const q = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [0, 0, 0] }, pixdim: [1, 0.5, 0.5, 0] }));
  assertEquals(q.ijkToRAS[10], 1, "not a flat axis");
  assertEquals(q.geometry?.origin, "assumed");
  assertEquals(q.geometry?.spacingNotDeclared, [2]);
  // Declared: nothing on the record.
  assertEquals((await parseNifti(makeNifti({ pixdim: [1, 1.5, 1.5, 3] }))).geometry?.spacingNotDeclared, undefined);
  assertEquals((await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [0, 0, 0] }, pixdim: [1, 2, 2, 2] }))).geometry?.origin, "acquired");
});

// The sform/qform agreement holds at any scale: within a share of a voxel, not a fixed 1e-4 mm.
Deno.test("nifti: sform and qform agree on a micrometer grid, and disagree by a voxel", async () => {
  const s = 1e-5;                                                   // 10 nm voxels, written in mm
  const same = await parseNifti(makeNifti({ sform: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0], qform: { b: 0, c: 0, d: 0, qfac: 1, off: [0, 0, 0] }, pixdim: [1, s, s, s] }));
  assertEquals(same.geometry?.qformAgreesWithSform, true);
  const off = await parseNifti(makeNifti({ sform: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0], qform: { b: 0, c: 0, d: 0, qfac: 1, off: [s, 0, 0] }, pixdim: [1, s, s, s] }));
  assertEquals(off.geometry?.qformAgreesWithSform, false, "a whole voxel apart");
});

// --- DICOM: through-plane spacing is derived, not stated -----------------------------------------

const slice = (k: number, extra: Record<string, unknown> = {}) => ({
  seriesInstanceUID: "1.2.3",
  imageOrientationPatient: [1, 0, 0, 0, 1, 0],
  imagePositionPatient: [-10, -20, 5 + k * 2] as [number, number, number],
  pixelSpacing: [0.8, 0.8] as [number, number],
  rows: 2,
  columns: 2,
  pixels: new Int16Array([k, k, k, k]),
  modality: "CT",
  ...extra,
  // deno-lint-ignore no-explicit-any
}) as any;

// The important one. `SliceThickness` is a different, acquired number — the slab each slice
// integrates over — and using it as the spacing distorts a volume wherever there is a gap or an
// overlap. The reader differences the slice positions instead, and now records that it did.
Deno.test("dicom: through-plane spacing is derived from slice positions", () => {
  const v = reconstructSeries([slice(0, { sliceThickness: 5 }), slice(1, { sliceThickness: 5 }), slice(2, { sliceThickness: 5 })]);
  assertEquals(v.geometry?.origin, "derived");
  assertEquals(v.geometry?.mechanism, "slice positions");
  assertEquals(v.geometry?.spaceUnit, "mm");        // mm by definition in DICOM, not an assumption
  // 2 mm apart from the positions, NOT the 5 mm SliceThickness those slices also carry.
  assertEquals(v.ijkToRAS[10], 2);
});

Deno.test("dicom: a single slice falls back to SliceThickness, and says so", () => {
  const v = reconstructSeries([slice(0, { sliceThickness: 5 })]);
  assertEquals(v.geometry?.origin, "acquired");
  assertEquals(v.geometry?.mechanism.startsWith("SliceThickness"), true);
  assertEquals(v.ijkToRAS[10], 5);
});

Deno.test("dicom: one slice with no thickness at all is an assumption", () => {
  const v = reconstructSeries([slice(0)]);
  assertEquals(v.geometry?.origin, "assumed");
  assertEquals(v.geometry?.mechanism.startsWith("1 mm"), true);
  assertEquals(v.ijkToRAS[10], 1);
});
