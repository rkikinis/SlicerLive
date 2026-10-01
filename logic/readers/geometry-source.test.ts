// Every reader in this directory faces a format that offers more than one way to say where a voxel
// is, and picking between them is a decision made on the caller's behalf. Until now none of them
// recorded which. These tests are about the record, not the arithmetic — the arithmetic was already
// right, which is why the absence of the record was easy to miss.
//
//   deno test -A --no-check logic/readers/geometry-source.test.ts
import { assertEquals } from "jsr:@std/assert@1";
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
