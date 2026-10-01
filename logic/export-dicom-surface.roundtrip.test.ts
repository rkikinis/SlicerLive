// WRITE THE SURFACES, READ THEM BACK, AND REQUIRE THE SAME GEOMETRY.
//
// Ron: "66.5 sounds better to me." So this writes DICOM Surface Segmentation Storage, which nothing
// else here can check for us -- Slicer cannot read the SOP class (verified against 5.13: it appears
// only in bundled libraries' UID tables, in none of its DICOM plugins). A format nobody else reads
// yet is exactly the one whose round trip has to be asserted rather than eyeballed.
//
// The trap this exists to catch: (0066,0041) is VR OL in the standard, dcmjs 0.41.0 does not
// implement OL and silently degrades it to UN. Points and normals are OF and pass through as buffers;
// the index list does not, and a writer that did not check would produce a file whose triangles are
// gone while every count still reads correctly.
//
//   deno test -A --no-check logic/export-dicom-surface.roundtrip.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "./dcmjs.ts";
import { setDcmjs } from "./readers/dicom-series.ts";
setDcmjs(dcmjs);

import { dciodvfy, dcmtkReads, HAS_DCIODVFY, HAS_DCMTK, makeCtSeries } from "./test-dicom.ts";
import { surfacesToDicomSurface } from "./export-dicom-surface.ts";
import { decodeSurfaces, meshesFromStoredSeries, surfacesToMeshes } from "./readers/dicom-surface.ts";
import { surfaceNets } from "../algorithms/surface-nets.ts";
import type { Vec3 } from "../render/mat4.ts";

const read = (bytes: Uint8Array) =>
  dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).dict,
  ) as Record<string, never>;

/** Bulk elements come back as a buffer, or a one-element array holding one. */
const buf = (v: unknown): ArrayBuffer =>
  v instanceof ArrayBuffer ? v : Array.isArray(v) && v[0] instanceof ArrayBuffer ? v[0] as ArrayBuffer
  : ArrayBuffer.isView(v) ? (v as Uint8Array).buffer as ArrayBuffer : new ArrayBuffer(0);

async function build() {
  const D = 24;
  const dims: Vec3 = [D, D, D];
  const series = await makeCtSeries(D, D, D);
  const lab = new Uint8Array(D * D * D);
  // Two touching boxes, so there are two surfaces and a shared boundary.
  for (let k = 6; k < 18; k++) for (let j = 6; j < 18; j++) for (let i = 6; i < 18; i++) {
    lab[(k * D + j) * D + i] = i < 12 ? 1 : 2;
  }
  const meshes = surfaceNets(lab, dims, series.ijkToRAS);
  const out = await surfacesToDicomSurface(meshes, [
    { labelValue: 1, name: "Left thing", color: [0.9, 0.2, 0.2] },
    { labelValue: 2, name: "Right thing", color: [0.2, 0.4, 0.9] },
  ], series.instances, {
    seriesDescription: "surfaces of test",
    derivedFrom: { sopClassUID: "1.2.840.10008.5.1.4.1.1.66.4", sopInstanceUID: "1.2.3.4.5.6", seriesInstanceUID: "1.2.3.4.5" },
  });
  return { meshes, out, series };
}

Deno.test("the surfaces survive the round trip, geometry included", async () => {
  const { meshes, out } = await build();
  const ds = read(out.bytes);
  assertEquals(ds.SOPClassUID, "1.2.840.10008.5.1.4.1.1.66.5");
  assertEquals(ds.Modality, "SEG");
  assertEquals(Number(ds.NumberOfSurfaces), meshes.length);

  const surfs = ds.SurfaceSequence as never as Record<string, never>[];
  assertEquals(surfs.length, meshes.length);
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i], s = surfs[i];
    const pts = new Float32Array(buf((s.SurfacePointsSequence as never as Record<string, never>[])[0].PointCoordinatesData));
    const nrm = new Float32Array(buf((s.SurfacePointsNormalsSequence as never as Record<string, never>[])[0].VectorCoordinateData));
    const idx = new Uint32Array(buf((s.SurfaceMeshPrimitivesSequence as never as Record<string, never>[])[0].LongTrianglePointIndexList));
    assertEquals(pts.length, m.positions.length, `surface ${i + 1}: point count`);
    assertEquals(nrm.length, m.normals.length, `surface ${i + 1}: normal count`);
    assertEquals(idx.length, m.indices.length, `surface ${i + 1}: index count`);
    // Every value, not a sample: a truncation or a byte-order slip shows in one place and not another.
    // Compared THROUGH THE READER: the file is LPS and 1-based (the test below pins that), the scene
    // is RAS and 0-based. Until 2026-09-17 this compared the file's bytes with the scene's and so
    // enshrined the wrong frame in the file (critic, finding 1).
    const back = decodeSurfaces(ds as never).surfaces[i];
    for (let v = 0; v < pts.length; v++) assert(Math.abs(back.positions[v] - m.positions[v]) < 1e-4, `surface ${i + 1}: point ${v} moved`);
    for (let v = 0; v < idx.length; v++) assertEquals(back.indices[v], m.indices[v], `surface ${i + 1}: index ${v} changed`);
    let worst = 0;
    for (let v = 0; v < nrm.length; v++) worst = Math.max(worst, Math.abs(back.normals[v] - m.normals[v]));
    assert(worst < 1e-4, `surface ${i + 1}: normals changed by ${worst}`);
    assertEquals(Number((s.SurfacePointsSequence as never as Record<string, never>[])[0].NumberOfSurfacePoints), m.positions.length / 3);
  }
});

Deno.test("each segment names its surface, its anatomy and what it was derived from", async () => {
  const { out } = await build();
  const ds = read(out.bytes);
  const segs = ds.SegmentSequence as never as Record<string, never>[];
  assertEquals(segs.length, 2);
  assertEquals(segs.map((s) => String(s.SegmentLabel)), ["Left thing", "Right thing"]);
  for (let i = 0; i < segs.length; i++) {
    assertEquals(Number(segs[i].SegmentNumber), i + 1);
    const ref = (segs[i].ReferencedSurfaceSequence as never as Record<string, never>[])[0];
    assertEquals(Number(ref.ReferencedSurfaceNumber), i + 1, "a segment must point at its own surface");
    // THE PARENT IS THE SEG, not the images: re-run the segmentation and this surface is stale.
    const from = (ref.SegmentSurfaceSourceInstanceSequence as never as Record<string, never>[])[0];
    assertEquals(String(from.ReferencedSOPInstanceUID), "1.2.3.4.5.6");
    assertEquals(String(from.ReferencedSOPClassUID), "1.2.840.10008.5.1.4.1.1.66.4", "derived from a SEG");
    assert(String((segs[i].SegmentedPropertyCategoryCodeSequence as never as Record<string, never>[])[0].CodeValue).length > 0);
  }
});

Deno.test("patient, study and frame of reference come from the images", async () => {
  const { out, series } = await build();
  const ds = read(out.bytes);
  const src = read(new Uint8Array(series.instances[0]));
  assertEquals(ds.StudyInstanceUID, src.StudyInstanceUID);
  assertEquals(ds.PatientID, src.PatientID);
  // A surface in a different frame of reference from its volume is in the wrong place by definition.
  assertEquals(ds.FrameOfReferenceUID, src.FrameOfReferenceUID);
  assert(String(ds.SeriesInstanceUID) !== String(src.SeriesInstanceUID), "the surfaces are their own series");
});

// ── THE OTHER DIRECTION: read it back ──
//
// Ron: "Is there a meaningful way to round trip the surfaces through the dicom data base, so I don't
// need to recreate everytime I am starting a new version." The writer existed and the reader did not,
// so the feature was one-directional and the 15 s extraction was paid on every load.
//
// The tests above prove the BYTES survive dcmjs. These prove the reader reconstructs the meshes the
// renderer consumes -- which is a different claim, and the one that matters to the caller.
Deno.test("surfaces read back as meshes, matched to their segments by name", async () => {
  const { meshes, out } = await build();
  const ds = read(out.bytes);
  const decoded = decodeSurfaces(ds as unknown as Record<string, unknown>);
  assertEquals(decoded.surfaces.length, meshes.length);

  // Names come from the SEGMENT sequence, joined by Referenced Surface Number rather than position.
  assertEquals(decoded.surfaces.map((s) => s.name).sort(), ["Left thing", "Right thing"]);

  // Color survives the trip through CIELab. That encoding is lossy, so this is a tolerance and not
  // an equality -- 0.02 is well inside "the same color" and well outside a channel swap.
  const left = decoded.surfaces.find((s) => s.name === "Left thing")!;
  assert(left.color, "a stored colour came back");
  const want = [0.9, 0.2, 0.2];
  for (let c = 0; c < 3; c++) {
    assert(Math.abs(left.color![c] - want[c]) < 0.02, `channel ${c}: ${left.color![c]} vs ${want[c]}`);
  }

  // And the geometry, reconstructed as the typed arrays the renderer takes.
  const asMeshes = surfacesToMeshes(decoded.surfaces, [
    { labelValue: 1, name: "Left thing" },
    { labelValue: 2, name: "Right thing" },
  ]);
  assertEquals(asMeshes.length, meshes.length);
  for (const original of meshes) {
    const back = asMeshes.find((m) => m.label === original.label)!;
    assert(back, `label ${original.label} came back`);
    assertEquals(back.indices.length, original.indices.length, `label ${original.label}: index count`);
    assertEquals(back.positions.length, original.positions.length, `label ${original.label}: point count`);
    for (let v = 0; v < back.indices.length; v++) assertEquals(back.indices[v], original.indices[v]);
    let worst = 0;
    for (let v = 0; v < back.positions.length; v++) worst = Math.max(worst, Math.abs(back.positions[v] - original.positions[v]));
    assert(worst < 1e-4, `label ${original.label}: points moved by ${worst}`);
  }
});

Deno.test("a surface whose name matches no segment is dropped, not guessed at", async () => {
  // A mesh drawn under the wrong label takes that label's color AND its visibility, which is a
  // silent wrong answer rather than a visible failure. Better to be short one surface.
  const { out } = await build();
  const decoded = decodeSurfaces(read(out.bytes) as unknown as Record<string, unknown>);
  const partial = surfacesToMeshes(decoded.surfaces, [{ labelValue: 7, name: "Left thing" }]);
  assertEquals(partial.length, 1);
  assertEquals(partial[0].label, 7, "the label comes from the SEGMENT, not from the surface number");
});

// ── AND THE DECISIONS THE LOAD PATH MAKES with what it finds ──
//
// `meshesFromStoredSeries` is what the application calls when a segmentation is first shown in 3D:
// it is handed whatever series a provenance edge pointed at and decides whether those really are
// this segmentation's surfaces. Every rejection below is a way to draw the WRONG geometry, which is
// worse than the 15 s of extraction that rejecting it costs.
const SEGMENTS = [{ labelValue: 1, name: "Left thing" }, { labelValue: 2, name: "Right thing" }];

Deno.test("stored surfaces load when the object agrees it came from this segmentation", async () => {
  const { meshes, out } = await build();
  const ds = read(out.bytes) as unknown as Record<string, unknown>;
  assertEquals(meshesFromStoredSeries([ds], SEGMENTS, "1.2.3.4.5").length, meshes.length);
  // No parent asserted -- a caller that has none still gets the meshes; there is nothing to disagree.
  assertEquals(meshesFromStoredSeries([ds], SEGMENTS).length, meshes.length);
});

Deno.test("surfaces of a DIFFERENT segmentation are refused", async () => {
  // The provenance edge is our own bookkeeping; the object's ReferencedSeriesInstanceUID is its own
  // claim about itself. When they disagree -- a copied database, a hand-edited edge, a reused UID --
  // the object wins and the caller extracts instead.
  const { out } = await build();
  const ds = read(out.bytes) as unknown as Record<string, unknown>;
  assertEquals(meshesFromStoredSeries([ds], SEGMENTS, "9.9.9.9.9").length, 0);
});

Deno.test("an object that is not a Surface Segmentation is skipped, not decoded", async () => {
  // An edge says a series was derived as "surface". It does not say the file IS one, and decoding a
  // SEG or a crop as geometry it does not contain would throw somewhere less obvious than here.
  const { out } = await build();
  const ds = read(out.bytes) as unknown as Record<string, unknown>;
  const notASurface = { ...ds, SOPClassUID: "1.2.840.10008.5.1.4.1.1.66.4" };
  assertEquals(meshesFromStoredSeries([notASurface], SEGMENTS, "1.2.3.4.5").length, 0);
  // ...and one bad object in the series does not cost the good ones.
  assertEquals(meshesFromStoredSeries([notASurface, ds], SEGMENTS, "1.2.3.4.5").length, 2);
});

Deno.test("a renumbered labelmap still lands on the right segments", async () => {
  // The reason the join is by NAME. Segment the same study again and the label values can change;
  // the names do not. This is what makes a stored surface survive a re-run of the segmenter.
  const { out } = await build();
  const ds = read(out.bytes) as unknown as Record<string, unknown>;
  const renumbered = meshesFromStoredSeries([ds], [
    { labelValue: 41, name: "Left thing" },
    { labelValue: 42, name: "Right thing" },
  ], "1.2.3.4.5");
  assertEquals(renumbered.map((m) => m.label).sort((a, b) => a - b), [41, 42]);
});

Deno.test("a segmentation that no longer has the structure keeps the ones it does", async () => {
  // Not an error: the segmentation changed underneath, and the surfaces that still match are still
  // right. Half a picture beats none, and the missing half is visibly missing.
  const { out } = await build();
  const ds = read(out.bytes) as unknown as Record<string, unknown>;
  const kept = meshesFromStoredSeries([ds], [{ labelValue: 3, name: "Right thing" }], "1.2.3.4.5");
  assertEquals(kept.length, 1);
  assertEquals(kept[0].label, 3);
});

Deno.test("the export hands back the uids the database index requires", async () => {
  // WHY THIS IS A TEST AND NOT A GLANCE. The save filled studyInstanceUID and frameOfReferenceUID
  // with "" because the export did not return them, and `indexInstances` validates every uid it is
  // given and refuses a non-uid -- so every surface save threw on the index step, fell back to
  // writing a bare file, and left nothing for the database to find. Ron, having done exactly that:
  // "No surface mesh listed in the dicom db, none loaded." The dataset had the right values all
  // along; only the return value was short.
  const { out, series } = await build();
  const UID = /^\d+(\.\d+)*$/;
  for (const [what, uid] of [
    ["sopInstanceUID", out.sopInstanceUID], ["seriesInstanceUID", out.seriesInstanceUID],
    ["studyInstanceUID", out.studyInstanceUID], ["frameOfReferenceUID", out.frameOfReferenceUID],
  ] as [string, string][]) {
    assert(UID.test(uid), `${what} is not a DICOM uid: ${JSON.stringify(uid)}`);
  }
  // And they are the SOURCE's, not new ones: a surface belongs in the study its images are in, or
  // the index has nothing to attach it to ("the study this belongs to is not in this database").
  const src = read(new Uint8Array(series.instances[0])) as unknown as { StudyInstanceUID?: string; FrameOfReferenceUID?: string };
  assertEquals(out.studyInstanceUID, src.StudyInstanceUID);
  assertEquals(out.frameOfReferenceUID, src.FrameOfReferenceUID);
});

// PATIENT SPACE ON DISK, SCENE SPACE IN MEMORY (critic, 2026-09-17, finding 1). The file's points
// must be LPS -- x and y the negative of the scene's RAS -- and its indices 1-based, as C.27.2.1
// asks; the reader must give back exactly what was written to it. And a file of the old kind (RAS,
// 0-based, everything written before 2026-09-17) must still come back right.
Deno.test("the file is in patient space with 1-based indices, and the read is the inverse", async () => {
  const { meshes, out } = await build();
  const ds = read(out.bytes);
  const items = ds.SurfaceSequence as Record<string, unknown>[];
  for (let s = 0; s < meshes.length; s++) {
    const pts = new Float32Array(buf((items[s].SurfacePointsSequence as Record<string, unknown>[])[0].PointCoordinatesData));
    const idx = new Uint32Array(buf((items[s].SurfaceMeshPrimitivesSequence as Record<string, unknown>[])[0].LongTrianglePointIndexList));
    assertEquals(pts.length, meshes[s].positions.length);
    for (let i = 0; i < pts.length; i += 3) {
      assertEquals(pts[i], -meshes[s].positions[i]);
      assertEquals(pts[i + 1], -meshes[s].positions[i + 1]);
      assertEquals(pts[i + 2], meshes[s].positions[i + 2]);
    }
    let min = Infinity;
    for (const v of idx) min = Math.min(min, v);
    assertEquals(min, 1, "1-based: the smallest index in the file is 1");
    assertEquals(idx.length, meshes[s].indices.length);
    for (let i = 0; i < idx.length; i++) assertEquals(idx[i], meshes[s].indices[i] + 1);
  }
  const { surfaces } = decodeSurfaces(ds as never);
  for (let s = 0; s < meshes.length; s++) {
    assertEquals(surfaces[s].positions, meshes[s].positions, "positions back in RAS");
    assertEquals(surfaces[s].normals, meshes[s].normals, "normals back in RAS");
    assertEquals(surfaces[s].indices, meshes[s].indices, "indices back 0-based");
  }
});

Deno.test("a file written before 2026-09-17 (RAS, 0-based) is read as it is", async () => {
  const { meshes, out } = await build();
  const ds = read(out.bytes) as Record<string, unknown>;
  // Turn the conformant file back into the old kind by hand: RAS points, 0-based indices.
  const items = ds.SurfaceSequence as Record<string, unknown>[];
  for (let s = 0; s < meshes.length; s++) {
    (items[s].SurfacePointsSequence as Record<string, unknown>[])[0].PointCoordinatesData = meshes[s].positions.slice().buffer;
    (items[s].SurfacePointsNormalsSequence as Record<string, unknown>[])[0].VectorCoordinateData = meshes[s].normals.slice().buffer;
    (items[s].SurfaceMeshPrimitivesSequence as Record<string, unknown>[])[0].LongTrianglePointIndexList = meshes[s].indices.slice().buffer;
  }
  const { surfaces } = decodeSurfaces(ds as never);
  for (let s = 0; s < meshes.length; s++) {
    assertEquals(surfaces[s].positions, meshes[s].positions);
    assertEquals(surfaces[s].indices, meshes[s].indices);
  }
});

// TWO SEGMENTS WITH ONE NAME (critic, 2026-09-17, finding 5): a merge keeps its inputs' names, so
// "aorta" can occur twice. Each stored surface must land on its own segment, in order; a third
// "aorta" surface with only two "aorta" segments is dropped, not guessed at.
Deno.test("surfaces sharing a name land on their own segments, in order", () => {
  const mesh = (n: number) => ({ positions: new Float32Array([n, 0, 0]), normals: new Float32Array(0), indices: new Uint32Array([0, 0, 0]) });
  const stored = [
    { number: 1, name: "aorta", color: [1, 0, 0] as [number, number, number], ...mesh(1) },
    { number: 2, name: "Aorta", color: [0, 1, 0] as [number, number, number], ...mesh(2) },
    { number: 3, name: "liver", color: [0, 0, 1] as [number, number, number], ...mesh(3) },
    { number: 4, name: "aorta", color: [0, 0, 0] as [number, number, number], ...mesh(4) },
  ];
  const meshes = surfacesToMeshes(stored, [
    { labelValue: 5, name: "liver" },
    { labelValue: 2, name: "aorta" },
    { labelValue: 3, name: "aorta" },
  ]);
  assertEquals(meshes.map((m) => [m.label, m.positions[0]]), [[2, 1], [3, 2], [5, 3]], "first aorta → label 2, second → 3, the third dropped");
});


Deno.test({
  name: "DCMTK reads the surfaces we write (dcmdump)",
  ignore: !HAS_DCMTK,
  fn: async () => {
    const { out } = await build();
    assertEquals(dcmtkReads(out.bytes), true);
  },
});

// dciodvfy (dicom3tools) on the surfaces we write (DICOM parity plan, step 1). Three messages are known and not ours to
// fix here, each drafted upstream: dicom3tools' condition for SurfaceProcessingRatio and the processing algorithm can
// never be true (condn.tpl: StringValue="StringValue="YES"), so a file that says YES is flagged
// (Contents/docs/upstream-issues-dicom3tools.md); and dcmjs cannot write OL (asked for OL it writes UN), so the index
// lists are OB (Contents/docs/upstream-issues-dcmjs.md, item 8). Anything else fails.
Deno.test({
  name: "dciodvfy: the surfaces we write have no conformance errors beyond the three known upstream ones",
  ignore: !HAS_DCIODVFY,
  fn: async () => {
    const { out } = await build();
    const known = [
      /SurfaceProcessingRatio\(0066,000a\)> - Attribute present when condition unsatisfied/,
      /SurfaceProcessingAlgorithmIdentificationSequence\(0066,0035\)> - Attribute present when condition unsatisfied/,
      /LongTrianglePointIndexList\(0066,0041\)> - Invalid Value Representation (OB \(OL Required\)|for Type 2 Required)/,
    ];
    assertEquals(dciodvfy(out.bytes)!.errors.filter((e) => !known.some((k) => k.test(e))), []);
  },
});
