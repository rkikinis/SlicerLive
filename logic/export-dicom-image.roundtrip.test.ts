// A CROPPED VOLUME, INTO DICOM AND BACK OUT, headless.
//
// Ron: "how do I know as a naive user that the cropped volume lives in the scene only and I have to
// save it to the dicom db if I want it to be more permanent? That should be an option offered." The
// option is only worth offering if what it writes can be READ -- by this application's own reader
// first of all, since the whole point is that the crop survives a restart. So the test is the round
// trip and not the file: DICOM in, crop, DICOM out, and the same voxels in the same place.
//
//   deno test -A --no-check logic/export-dicom-image.roundtrip.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import dcmjs from "./dcmjs.ts";
import { parseInstances, reconstructSeries, setDcmjs } from "./readers/dicom-series.ts";
setDcmjs(dcmjs);

import { dciodvfy, dcmtkReads, HAS_DCIODVFY, HAS_DCMTK, makeCtSeries } from "./test-dicom.ts";
import { cropVolume, invertAffine } from "./crop.ts";
import { dicomGeometryFor, toStoredPixels, volumeToDicomSeries } from "./export-dicom-image.ts";

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const apply = (m: readonly number[], v: readonly number[]) =>
  [0, 1, 2].map((r) => m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + m[r * 4 + 3]);

/**
 * The same volume in patient space -- which is the property that matters, and is not the same as
 * "the same array".
 *
 * A DICOM series has no k axis of its own: a reader establishes one by sorting the slices along the
 * plane normal (readers/dicom-series.ts, and Slicer's own plugin). So a volume whose k step runs
 * against that normal comes back with its slice order reversed and an ijkToRAS that says so. Nothing
 * is lost -- every voxel is at the same millimetre -- so the check is voxel by voxel THROUGH RAS
 * rather than index by index.
 */
function sameVolumeInSpace(
  a: { dims: readonly number[]; ijkToRAS: readonly number[]; data: ArrayLike<number> },
  b: { dims: readonly number[]; ijkToRAS: readonly number[]; data: ArrayLike<number> },
): void {
  assertEquals([...b.dims].sort(), [...a.dims].sort(), "a different number of voxels came back");
  const toA = invertAffine(a.ijkToRAS);
  const [ax, ay] = a.dims, [bx, by] = b.dims;
  let checked = 0;
  for (let k = 0; k < b.dims[2]; k++) {
    for (let j = 0; j < by; j++) {
      for (let i = 0; i < bx; i++) {
        const ijk = apply(toA, apply(b.ijkToRAS, [i, j, k]));
        const r = ijk.map((v) => Math.round(v));
        for (let c = 0; c < 3; c++) {
          assert(Math.abs(ijk[c] - r[c]) < 1e-3, `voxel ${i},${j},${k} lands off the original grid at ${ijk.join(",")}`);
          assert(r[c] >= 0 && r[c] < a.dims[c], `voxel ${i},${j},${k} lands outside the original at ${r.join(",")}`);
        }
        const va = a.data[(r[2] * ay + r[1]) * ax + r[0]], vb = b.data[(k * by + j) * bx + i];
        assertEquals(vb, va, `voxel ${i},${j},${k} (original ${r.join(",")}): ${vb} instead of ${va}`);
        checked++;
      }
    }
  }
  assertEquals(checked, b.dims[0] * b.dims[1] * b.dims[2]);
}

/** DICOM in -> scene volume -> crop -> DICOM out -> scene volume. */
async function roundTrip(box: { center: [number, number, number]; size: [number, number, number] }) {
  const series = await makeCtSeries(16, 14, 10, {
    // The attribution a public data set arrives with. It is not the writer's to re-invent and not
    // the writer's to drop: Ron asked for "proper acknowlegement and URL stashed away in the proper
    // DICOM location", and a derived series that loses it has laundered the provenance.
    extra: { ClinicalTrialSponsorName: "OpenNeuro", ClinicalTrialProtocolID: "ds000001", InstitutionName: "SOMEWHERE" },
  });
  const original = reconstructSeries(await parseInstances(series.instances));
  const cropped = cropVolume(
    original.data as unknown as { length: number; [i: number]: number },
    original.dims as [number, number, number],
    original.ijkToRAS,
    box,
    (n) => new Int16Array(n) as unknown as { length: number; [i: number]: number },
  );
  assert(cropped, "the box missed the volume");
  const out = await volumeToDicomSeries(
    cropped.data as unknown as ArrayLike<number>,
    cropped.dims as [number, number, number],
    cropped.ijkToRAS,
    series.instances,
    { seriesDescription: "CT (cropped)", derivation: "Cropped: a sub-box of the original voxel grid, no resampling." },
  );
  const back = reconstructSeries(await parseInstances(out.instances.map((i) => ab(i.bytes))));
  return { series, original, cropped, out, back };
}

Deno.test("a cropped volume goes out as DICOM and comes back the same volume", async () => {
  const { cropped, out, back } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
  assertEquals(out.slices, cropped.dims[2], "one instance per slice");
  assertEquals(out.instances.length, cropped.dims[2]);
  sameVolumeInSpace(
    { dims: cropped.dims, ijkToRAS: cropped.ijkToRAS, data: cropped.data as unknown as ArrayLike<number> },
    { dims: back.dims, ijkToRAS: back.ijkToRAS, data: back.data },
  );
});

Deno.test("the whole volume round trips, so the writer is not only right on small boxes", async () => {
  const { original, cropped, back } = await roundTrip({ center: [-8, -7, 5], size: [40, 40, 40] });
  assertEquals([...cropped.dims], [...original.dims], "the box should have kept everything");
  sameVolumeInSpace(
    { dims: original.dims, ijkToRAS: original.ijkToRAS, data: original.data },
    { dims: back.dims, ijkToRAS: back.ijkToRAS, data: back.data },
  );
});

Deno.test("the patient, the study and the acknowledgement come with it", async () => {
  const { series, out } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(ab(out.instances[0].bytes)).dict,
  ) as Record<string, unknown>;
  assertEquals(ds.StudyInstanceUID, series.studyInstanceUID, "a derived series belongs to the SAME study");
  assertEquals((ds.PatientName as { Alphabetic?: string })?.Alphabetic ?? ds.PatientName, "TEST^SYNTHETIC");
  assertEquals(ds.PatientID, "TEST-1");
  assertEquals(ds.ClinicalTrialSponsorName, "OpenNeuro", "the attribution was dropped");
  assertEquals(ds.ClinicalTrialProtocolID, "ds000001");
  assertEquals(ds.InstitutionName, "SOMEWHERE");
  assertEquals(ds.Modality, "CT");
  // ITS OWN identity, though, and honest about being made rather than acquired.
  assert(ds.SeriesInstanceUID !== series.seriesInstanceUID, "it reused the source's series UID");
  assertEquals(ds.SeriesInstanceUID, out.seriesInstanceUID);
  assertEquals([...(ds.ImageType as string[])], ["DERIVED", "SECONDARY"]);
  assert(String(ds.DerivationDescription).includes("no resampling"));
  assertEquals(ds.FrameOfReferenceUID, dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(series.instances[0]).dict,
  ).FrameOfReferenceUID, "the voxels did not move, so the frame of reference is the same one");
});

Deno.test("each slice names the source slice it was made from", async () => {
  const { series, out } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
  const sourceSops = new Set((await parseInstances(series.instances)).map((i) => i.sopInstanceUID));
  const sops = new Set<string>();
  for (const inst of out.instances) {
    const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
      dcmjs.data.DicomMessage.readFile(ab(inst.bytes)).dict,
    ) as Record<string, unknown>;
    const src = ds.SourceImageSequence as { ReferencedSOPInstanceUID: string }[] | { ReferencedSOPInstanceUID: string };
    const ref = Array.isArray(src) ? src[0] : src;
    assert(ref, "no SourceImageSequence: the derivation is unrecorded");
    assert(sourceSops.has(ref.ReferencedSOPInstanceUID), "it references an instance that is not in the source series");
    sops.add(ref.ReferencedSOPInstanceUID);
  }
  assertEquals(sops.size, out.instances.length, "two slices claim the same source slice");
});

Deno.test("every instance carries the index row and the parent series", async () => {
  const { series, out } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
  for (const inst of out.instances) {
    assertEquals(inst.index.seriesInstanceUID, out.seriesInstanceUID);
    assertEquals(inst.index.studyInstanceUID, series.studyInstanceUID);
    assertEquals(inst.index.derivedFrom?.parentSeriesUID, series.seriesInstanceUID, "nothing to indent it under");
    assertEquals(inst.index.modality, "CT");
    assert(inst.filename.endsWith(".dcm"));
  }
  assertEquals(new Set(out.instances.map((i) => i.index.sopInstanceUID)).size, out.instances.length, "duplicate SOP UIDs");
});

// ── the refusals ────────────────────────────────────────────────────────────────────────────────
//
// Writing a volume DICOM cannot describe, or values it cannot hold, would put different numbers in
// the archive than the ones on the screen. Ron's rule -- "we leave the data as is, but modulate the
// appearance as needed" -- makes that the one thing a save must never do quietly.
Deno.test("a grid DICOM cannot describe is refused, and says why", () => {
  const sheared = [1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const r = dicomGeometryFor([4, 4, 4], sheared);
  assertEquals(r.ok, false);
  assert(!r.ok && r.reason.includes("sheared"), r.ok ? "" : r.reason);
  // A k step 30 degrees off the normal: writable, and it would come back a different shape.
  const tilted = [1, 0, 0, 0, 0, 1, 0.5, 0, 0, 0, 0.866, 0, 0, 0, 0, 1];
  const t = dicomGeometryFor([4, 4, 4], tilted);
  assertEquals(t.ok, false);
  assert(!t.ok && t.reason.includes("through-plane"), t.ok ? "" : t.reason);
  // and the ordinary case is fine, with the two spacings the right way round
  const g = dicomGeometryFor([4, 4, 4], [-0.5, 0, 0, 10, 0, -0.7, 0, 20, 0, 0, 3, 30, 0, 0, 0, 1]);
  assert(g.ok);
  assertEquals(g.geom.pixelSpacing, [0.7, 0.5], "PixelSpacing is [between rows, between columns]");
  assertEquals(g.geom.sliceSpacing, 3);
  assertEquals(g.geom.positionOf(0), [-10, -20, 30], "the origin, in LPS");
  assertEquals(g.geom.positionOf(2), [-10, -20, 36]);
});

Deno.test("values DICOM cannot hold are refused, and whole ones are kept exactly", () => {
  const f = toStoredPixels(new Float32Array([1, 2.5, 3]));
  assert(!f.ok && f.reason.includes("fractional"), f.ok ? "" : f.reason);
  const big = toStoredPixels(new Int32Array([0, 70000]));
  assert(!big.ok && big.reason.includes("16-bit"), big.ok ? "" : big.reason);
  const nan = toStoredPixels(new Float64Array([1, NaN]));
  assert(!nan.ok);
  // Float-typed but whole: a NIfTI often is, and there is nothing lossy about writing it.
  const whole = toStoredPixels(new Float32Array([0, 1, 4095]));
  assert(whole.ok && whole.pixels instanceof Uint16Array && !whole.signed);
  assertEquals([...(whole as { pixels: Uint16Array }).pixels], [0, 1, 4095]);
  const signed = toStoredPixels(new Int16Array([-1000, 0, 3000]));
  assert(signed.ok && signed.pixels instanceof Int16Array && signed.signed);
});

Deno.test("a fractional rescale (Philips MR) is read exactly, and goes back out as the scanner's own numbers", async () => {
  // Found 2026-09-25 on Philips' public fMRI and diffusion: slope 0.7038 was applied into 16-bit integers, which cut
  // off the fraction -- up to 1 in every voxel. Now the volume is float32, and the writer undoes the one rescale.
  const slope = 0.7037851037851;
  const series = await makeCtSeries(12, 10, 6, { extra: { RescaleSlope: slope, RescaleIntercept: 0 } });
  const stored = reconstructSeries(await parseInstances((await makeCtSeries(12, 10, 6)).instances)).data;
  const v = reconstructSeries(await parseInstances(series.instances));
  assert(v.data instanceof Float32Array, "a fractional rescale gives a float volume");
  for (let i = 0; i < v.data.length; i++) assertEquals(v.data[i], Math.fround(stored[i] * slope));
  const out = await volumeToDicomSeries(v.data, v.dims as [number, number, number], v.ijkToRAS, series.instances, { seriesDescription: "MR (saved)" });
  const back = reconstructSeries(await parseInstances(out.instances.map((i) => ab(i.bytes))));
  assert(back.data instanceof Float32Array);
  assertEquals([...back.data], [...v.data], "the same values after the round trip");
});

Deno.test("with no source series there is nothing to copy the patient from", async () => {
  await assertRejects(
    () => volumeToDicomSeries(new Int16Array(8), [2, 2, 2], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], []),
    Error,
    "no source DICOM instances",
  );
});


Deno.test({
  name: "DCMTK reads every instance of the volume we write (dcmdump)",
  ignore: !HAS_DCMTK,
  fn: async () => {
    const { out } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
    for (const i of out.instances) assertEquals(dcmtkReads(i.bytes), true);
  },
});

// Critic, 2026-09-25, finding 10: a series with a rescale per slice (as PET is written) saves, each slice with its own.
Deno.test("a rescale per slice (PET) is undone per slice, and read back exactly", async () => {
  const series = await makeCtSeries(10, 8, 5);
  const D = dcmjs.data as unknown as { DicomMessage: { readFile(b: ArrayBuffer): { dict: Record<string, { vr: string; Value: unknown[] }>; meta: unknown } }; DicomDict: new (m: unknown) => { dict: unknown; write(): ArrayBuffer } };
  const pet = series.instances.map((b, k) => {
    const p = D.DicomMessage.readFile(b);
    p.dict["00281053"] = { vr: "DS", Value: [0.25 + 0.137 * k] };          // RescaleSlope, a different one per slice
    p.dict["00281052"] = { vr: "DS", Value: [0] };
    const o = new D.DicomDict(p.meta); o.dict = p.dict; return o.write();
  });
  const v = reconstructSeries(await parseInstances(pet));
  assert(v.data instanceof Float32Array);
  const out = await volumeToDicomSeries(v.data, v.dims as [number, number, number], v.ijkToRAS, pet, { seriesDescription: "PET (saved)" });
  const back = reconstructSeries(await parseInstances(out.instances.map((i) => ab(i.bytes))));
  assertEquals([...back.data], [...v.data], "every slice exact after the round trip");
});

// Critic, 2026-09-25, finding 9: a volume from a multi-frame source is refused in plain words, as the SEG writer refuses it.
Deno.test("a volume from a multi-frame source is refused, not written without its per-frame attributes", async () => {
  const series = await makeCtSeries(6, 5, 3);
  const D = dcmjs.data as unknown as { DicomMessage: { readFile(b: ArrayBuffer): { dict: Record<string, { vr: string; Value: unknown[] }>; meta: unknown } }; DicomDict: new (m: unknown) => { dict: unknown; write(): ArrayBuffer } };
  const p = D.DicomMessage.readFile(series.instances[0]);
  p.dict["00280008"] = { vr: "IS", Value: [3] };
  p.dict["52009230"] = { vr: "SQ", Value: [{}, {}, {}] };
  const o = new D.DicomDict(p.meta); o.dict = p.dict;
  const v = reconstructSeries(await parseInstances(series.instances));
  await assertRejects(() => volumeToDicomSeries(v.data, v.dims as [number, number, number], v.ijkToRAS, [o.write()], {}), Error, "multi-frame");
});

// DAVID CLUNIE'S dciodvfy (dicom3tools): the writer adds no conformance error the source did not already have
// (DICOM parity plan, step 1). The test series lacks some Type 2 attributes; the writer now writes them present and
// empty, so the output has fewer errors than the source, never more.
Deno.test({
  name: "dciodvfy: the volume we write adds no conformance error to its source's",
  ignore: !HAS_DCIODVFY,
  fn: async () => {
    const { series, out } = await roundTrip({ center: [-4, -5, 4], size: [8, 6, 6] });
    const before = new Set(dciodvfy(series.instances[0])!.errors);
    for (const i of out.instances) assertEquals(dciodvfy(i.bytes)!.errors.filter((e) => !before.has(e)), [], "errors the writer added");
  },
});

// PRIVATE ATTRIBUTES ARE CARRIED, SLICE BY SLICE (Ron, 2026-09-26, "agree", on qa/2026-09-26-dcmjs-pr-tests.md finding 3;
// logic/private-attributes.ts): each output slice gets the private elements of ITS source slice, as they were, and a
// vendor's private image data (group 7F01-7FFF, e.g. GE's "GEIIS" thumbnail in 7FD1) is left out.
Deno.test("the source's private attributes are carried slice by slice; private image data is left out", async () => {
  const dcm = await (await import("./dicom-io.ts")).dicomIO();
  const series = await makeCtSeries(16, 14, 10);
  // Add a vendor block to every source slice: a creator, a text value naming the slice, a binary value, and a
  // thumbnail in the private pixel-data range.
  const sources = series.instances.map((b, k) => {
    const parsed = dcm.readFile(b);
    const f = dcm.fileWithMeta(parsed.meta);
    f.dict = {
      ...parsed.dict,
      "00290010": { vr: "LO", Value: ["TEST VENDOR"] },
      "00291010": { vr: "LO", Value: [`slice ${k}`] },
      "00291020": { vr: "OB", Value: [new Uint8Array([k, 1, 2, 3]).buffer] },
      "7FD10010": { vr: "LO", Value: ["GEIIS"] },
      "7FD11010": { vr: "OB", Value: [new Uint8Array(64).buffer] },
    };
    return f.write();
  });
  const original = reconstructSeries(await parseInstances(sources));
  const cropped = cropVolume(
    original.data as unknown as { length: number; [i: number]: number }, original.dims as [number, number, number], original.ijkToRAS,
    { center: [-4, -5, 4], size: [8, 6, 6] }, (n) => new Int16Array(n) as unknown as { length: number; [i: number]: number },
  );
  assert(cropped, "the box missed the volume");
  const out = await volumeToDicomSeries(cropped.data as unknown as ArrayLike<number>, cropped.dims as [number, number, number], cropped.ijkToRAS, sources, { seriesDescription: "CT (cropped)" });
  assertEquals(out.privateLeftOut, ["7FD10010", "7FD11010"], "the private image data is named as left out");
  assertEquals(out.privateCarried, out.slices * 3, "three private elements per slice");
  // Each output slice carries the value of the source slice on its own plane.
  const sopToK = new Map(sources.map((b, k) => [String(dcm.naturalize(dcm.readFile(b).dict).SOPInstanceUID), k]));
  for (const inst of out.instances) {
    const raw = dcm.readFile(ab(inst.bytes)).dict;
    const ds = dcm.naturalize(raw);
    const fromSop = String(((ds.SourceImageSequence as Record<string, unknown>[] | Record<string, unknown>) as Record<string, unknown>[])?.[0]?.ReferencedSOPInstanceUID ?? (ds.SourceImageSequence as Record<string, unknown>)?.ReferencedSOPInstanceUID);
    const k = sopToK.get(fromSop);
    assert(k !== undefined, "each slice names its source");
    assertEquals(raw["00290010"]?.Value, ["TEST VENDOR"]);
    assertEquals(raw["00291010"]?.Value, [`slice ${k}`], "the source slice's own value");
    assertEquals([...new Uint8Array(raw["00291020"]!.Value![0] as ArrayBuffer)], [k!, 1, 2, 3], "binary values byte for byte");
    assertEquals(raw["7FD10010"], undefined, "the private thumbnail block is not carried");
    assertEquals(raw["7FD11010"], undefined);
  }
});

// Two conformance faults a public TCGA-UCEC CT showed and the synthetic series did not (dciodvfy, 2026-09-28): the CT
// Image module wants ImageType value 3 and AcquisitionNumber present (Type 2).
Deno.test("a derived CT keeps ImageType's third value and writes AcquisitionNumber present", async () => {
  const dcm = await (await import("./dicom-io.ts")).dicomIO();
  const series = await makeCtSeries(16, 14, 10, { extra: { ImageType: ["ORIGINAL", "PRIMARY", "AXIAL"], AcquisitionNumber: 3 } });
  const v = reconstructSeries(await parseInstances(series.instances));
  const out = await volumeToDicomSeries(v.data as unknown as ArrayLike<number>, v.dims as [number, number, number], v.ijkToRAS, series.instances, { seriesDescription: "CT (saved)" });
  const raw = dcm.readFile(ab(out.instances[0].bytes)).dict;
  assertEquals(raw["00080008"]?.Value, ["DERIVED", "SECONDARY", "AXIAL"]);
  assert("00200012" in raw, "AcquisitionNumber is present");
  // Empty (zero length; DCMTK: "no value available"). dcmjs reads an empty IS back as [null].
  assertEquals((raw["00200012"]?.Value ?? []).filter((x) => x !== null && x !== ""), [], "and empty: a derived image is not that acquisition");
});

// Ron, 2026-10-07 (ds004910's resampled float T1): "Following established practice and remaining standards compliant".
Deno.test("truly fractional values: refused unless asked; asked, rounded to 16 bits with one Rescale Slope, the rounding stated", async () => {
  const dims: [number, number, number] = [6, 5, 4], I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const data = Float32Array.from({ length: 120 }, (_, i) => (i === 7 ? -14.236359 : i * 24.31 + Math.sin(i) * 0.37));
  // ImageType from the sidecar, as the BIDS import gives it (MR requires value 3).
  const subject = { patientName: "T", patientID: "T", modality: "MR" as const, studyDate: "", studyTime: "", extra: { ImageType: ["ORIGINAL", "PRIMARY", "M", "FFE"] } };
  await assertRejects(() => volumeToDicomSeries(data, dims, I, [], { subject }), Error, "fractional");
  const out = await volumeToDicomSeries(data, dims, I, [], { subject, quantize: true, derivation: "Imported from a NIfTI" });
  const first = dcmjs.data.DicomMessage.readFile(ab(out.instances[0].bytes));
  const d = dcmjs.data.DicomMetaDictionary.naturalizeDataset(first.dict) as Record<string, unknown>;
  const slope = Number(d.RescaleSlope);
  assert(slope > 0 && Number(d.RescaleIntercept) === 0, `slope ${d.RescaleSlope}, intercept ${d.RescaleIntercept}`);
  assert(String(d.DerivationDescription).startsWith("Imported from a NIfTI; values rounded to 16-bit stored numbers"), String(d.DerivationDescription));
  assertEquals((d.ImageType as string[]).slice(0, 2), ["DERIVED", "SECONDARY"]);
  assertEquals(d.PixelRepresentation, 1, "a negative value makes the pixels signed");
  const back = reconstructSeries(await parseInstances(out.instances.map((i) => ab(i.bytes))));
  sameVolumeInSpaceWithin(back, { dims, ijkToRAS: I, data }, slope / 2 + 1e-4);
  // The rounding's attributes conform (the minimal subject's own gaps, e.g. Laterality, are another test's business).
  const r = dciodvfy(out.instances[0].bytes);
  if (r) { const mine = [...r.errors.filter((e) => /Rescale|Pixel|Bits|HighBit|Derivation|ImageType/.test(e)), ...r.warnings.filter((e) => /Rescale|Pixel|Bits|HighBit|Derivation/.test(e) && !/not expected to be present in standard MR IOD|Attribute is not present in standard DICOM IOD/.test(e))];
    // The one warning kept: Rescale Slope in a classic MR image is not in the MR IOD's modules -- a standard extended SOP
    // class (PS3.4 B.1.3), as Philips writes every MR image; the strict alternative is the Enhanced MR object's Pixel
    // Value Transformation (the diffusion writer's form).
    assert(mine.length === 0, mine.join("\n")); }
});

/** As sameVolumeInSpace, within a tolerance (the rounding). */
function sameVolumeInSpaceWithin(b: { dims: readonly number[]; ijkToRAS: readonly number[]; data: ArrayLike<number> }, a: { dims: readonly number[]; ijkToRAS: readonly number[]; data: ArrayLike<number> }, tol: number) {
  const toA = invertAffine(a.ijkToRAS), [ax, ay] = a.dims, [bx, by] = b.dims;
  for (let k = 0; k < b.dims[2]; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    const r = apply(toA, apply(b.ijkToRAS, [i, j, k])).map((v) => Math.round(v));
    const va = a.data[(r[2] * ay + r[1]) * ax + r[0]], vb = b.data[(k * by + j) * bx + i];
    assert(Math.abs(va - vb) <= tol, `voxel ${i},${j},${k}: ${vb} against ${va} (tolerance ${tol})`);
  }
}
