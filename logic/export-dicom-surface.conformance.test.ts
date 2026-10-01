// THE IOD'S REQUIRED ELEMENTS, PINNED WITHOUT THE EXTERNAL TOOL.
//
// `validate_iods` (dicom-validator, DICOM 2026c) found four real faults in what this writer emitted,
// none of which any test here noticed and none of which reading the file would have shown:
//
//   Surface Mesh          (0062,000C) Recommended Display Grayscale Value missing   type 1
//   Surface Mesh          the six sibling primitive containers in C.27-4 missing    type 2
//   Surface Segmentation  (0066,002A) Surface Count missing                         type 1
//   Surface Segmentation  (0062,0009) Segment Algorithm Name present, not in module
//
// Installing a validator to run the suite is not a dependency worth taking, so the findings are
// asserted directly. If the standard's requirements are ever revisited, re-run the real thing:
//
//   python3 -m pip install --user dicom-validator
//   ~/.local/bin/validate_iods <a file this writer produced>
import { assert, assertEquals } from "jsr:@std/assert@1";
import dcmjs from "./dcmjs.ts";
import { setDcmjs } from "./readers/dicom-series.ts";
setDcmjs(dcmjs);
import { surfaceNets } from "../algorithms/surface-nets.ts";
import { surfacesToDicomSurface } from "./export-dicom-surface.ts";
import { makeCtSeries } from "./test-dicom.ts";
import type { Vec3 } from "../render/types.ts";

// deno-lint-ignore no-explicit-any
const read = (bytes: Uint8Array): any =>
  dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ).dict,
  );

// deno-lint-ignore no-explicit-any
const raw = (bytes: Uint8Array): any =>
  dcmjs.data.DicomMessage.readFile(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  ).dict;

async function build(derived: boolean) {
  const D = 24;
  const series = await makeCtSeries(D, D, D);
  const lab = new Uint8Array(D * D * D);
  for (let k = 6; k < 18; k++) for (let j = 6; j < 18; j++) for (let i = 6; i < 18; i++) {
    lab[(k * D + j) * D + i] = i < 12 ? 1 : 2;
  }
  const meshes = surfaceNets(lab, [D, D, D] as Vec3, series.ijkToRAS);
  return await surfacesToDicomSurface(meshes, [
    { labelValue: 1, name: "Left thing", color: [0.9, 0.2, 0.2] },
    { labelValue: 2, name: "Right thing", color: [0.2, 0.4, 0.9] },
  ], series.instances, {
    seriesDescription: "surfaces of test",
    ...(derived
      ? { derivedFrom: { sopClassUID: "1.2.840.10008.5.1.4.1.1.66.4", sopInstanceUID: "1.2.3.4.5.6", seriesInstanceUID: "1.2.3.4.5" } }
      : {}),
  });
}

const seq = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

Deno.test("every surface carries a display grayscale value as well as CIELab", () => {
  // Type 1 in C.27.1, and it was absent: a grayscale-only reader had nothing to show.
  return build(true).then(({ bytes }) => {
    const ds = read(bytes);
    const surfaces = seq(ds.SurfaceSequence);
    assert(surfaces.length > 0, "there are surfaces");
    for (const s of surfaces) {
      assert(s.RecommendedDisplayCIELabValue, "CIELab present");
      const g = Number(s.RecommendedDisplayGrayscaleValue);
      assert(Number.isFinite(g) && g >= 0 && g <= 65535, `grayscale value out of range: ${s.RecommendedDisplayGrayscaleValue}`);
    }
    // The two segments are a strong red and a strong blue, so their luminances must differ.
    const gs = surfaces.map((s: { RecommendedDisplayGrayscaleValue?: number }) => Number(s.RecommendedDisplayGrayscaleValue));
    assert(Math.abs(gs[0] - gs[1]) > 1000, `red and blue should not share a P-Value: ${gs.join(", ")}`);
  });
});

Deno.test("every primitive container is present, the unused ones empty", async () => {
  // All type 2 in C.27-4: present, possibly zero-length. Only the triangle list was written, so a
  // reader could not tell "no strips" from "this writer does not know about strips".
  const { bytes } = await build(true);
  const d = raw(bytes);
  const surfSeq = d["00660002"].Value as Record<string, { vr: string; Value: unknown[] }>[];
  for (const s of surfSeq) {
    const prim = (s["00660013"].Value as Record<string, { vr: string; Value: unknown[] }>[])[0];
    const tri = prim["00660041"];
    assert(tri && (tri.Value[0] as ArrayBuffer)?.byteLength > 0, "the triangle index list carries data");
    for (const [tag, name] of [
      ["00660026", "Triangle Strip Sequence"], ["00660027", "Triangle Fan Sequence"],
      ["00660028", "Line Sequence"], ["00660034", "Facet Sequence"],
      ["00660042", "Long Edge Point Index List"], ["00660043", "Long Vertex Point Index List"],
    ]) {
      assert(prim[tag] !== undefined, `${name} (${tag}) must be present, even empty`);
      // "Empty" reads back differently by VR: a zero-item SQ comes back as [], while a zero-length
      // OB comes back as ONE ArrayBuffer of zero bytes. Both are a zero-length element on disk,
      // which is what type 2 asks for.
      const vals = prim[tag].Value ?? [];
      const bytesIn = vals.reduce((n: number, v: unknown) => n + (v instanceof ArrayBuffer ? v.byteLength : 1), 0);
      assertEquals(bytesIn, 0, `${name} should be empty, got ${vals.length} value(s)`);
    }
  }
});

Deno.test("each segment states its surface count and does not carry a segment algorithm name", async () => {
  const { bytes } = await build(true);
  const ds = read(bytes);
  for (const s of seq(ds.SegmentSequence)) {
    assertEquals(Number(s.SurfaceCount), 1, "one surface per segment, and it must say so (type 1)");
    // C.8.23.1 does not define (0062,0009) here; the algorithm belongs in the generation sequence.
    assertEquals(s.SegmentAlgorithmName, undefined, "Segment Algorithm Name is not in this module");
    const gen = seq(seq(s.ReferencedSurfaceSequence)[0]?.SegmentSurfaceGenerationAlgorithmIdentificationSequence)[0];
    assert(gen?.AlgorithmName, "the algorithm IS named, in the sequence the module defines for it");
  }
});

Deno.test("the source instance sequence is present even when nothing was derived from", async () => {
  // Type 2: empty rather than absent when there is no stored segmentation behind these surfaces.
  const { bytes } = await build(false);
  const ds = read(bytes);
  for (const s of seq(ds.SegmentSequence)) {
    const refSurf = seq(s.ReferencedSurfaceSequence)[0];
    assert("SegmentSurfaceSourceInstanceSequence" in refSurf, "must be present");
    assertEquals(seq(refSurf.SegmentSurfaceSourceInstanceSequence).length, 0, "and empty");
  }
});

Deno.test("the triangle index list is written as OB, because OL loses the data", async () => {
  // Measured: asking dcmjs 0.41 for OL writes UN and reads back zero values. See the note at the top
  // of export-dicom-surface.ts. This pins the deviation so it is a decision, not a drift.
  const { bytes } = await build(true);
  const d = raw(bytes);
  const surfSeq = d["00660002"].Value as Record<string, { vr: string; Value: unknown[] }>[];
  const prim = (surfSeq[0]["00660013"].Value as Record<string, { vr: string; Value: unknown[] }>[])[0];
  assertEquals(prim["00660041"].vr, "OB", "OL degrades to UN in this dcmjs and the indices are lost");
});
