// A SEGMENTATION ON A MULTI-FRAME IMAGE (Enhanced MR: one file, many frames, as Siemens' XA scanners write every MR
// series). Until 2026-10-21 the writer refused it; Steve's Prisma T1 was the first real case (FastSurfer ran, the save
// failed). Each SEG frame must name its source by the file AND the frame in it, and the frames must be the volume's:
// a file holding two echoes holds two volumes.
//
//   deno test -A --no-check logic/export-dicom-seg.multiframe.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import dcmjs from "./dcmjs.ts";
import { parseInstances, setDcmjs, volumesOfSeries } from "./readers/dicom-series.ts";
import { segmentationToDicomSeg } from "./export-dicom-seg.ts";
import { decodeSegmentation } from "./readers/dicom-seg.ts";
import { dciodvfy } from "./test-dicom.ts";
setDcmjs(dcmjs);

const ENHANCED_MR = "1.2.840.10008.5.1.4.1.1.4.1";
const uid = () => `2.25.${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e15)}`;
const NX = 6, NY = 5;

/** One Enhanced MR file; each frame filled with its value, at (0, 0, z), axial; `te` gives each frame an echo. */
function enhancedMr(frames: { z: number; value: number; te?: number }[], series = { study: uid(), series: uid(), frame: uid() }): ArrayBuffer {
  const px = new Uint16Array(NX * NY * frames.length);
  frames.forEach((f, i) => px.fill(f.value, i * NX * NY, (i + 1) * NX * NY));
  const sop = uid();
  const ds: Record<string, unknown> = {
    SOPClassUID: ENHANCED_MR, SOPInstanceUID: sop, StudyInstanceUID: series.study, SeriesInstanceUID: series.series, FrameOfReferenceUID: series.frame,
    Modality: "MR", PatientName: "TEST^MULTIFRAME", PatientID: "TEST-MF", SeriesDescription: "synthetic", InstanceNumber: 1,
    Rows: NY, Columns: NX, NumberOfFrames: frames.length, BitsAllocated: 16, BitsStored: 12, HighBit: 11, PixelRepresentation: 0,
    SamplesPerPixel: 1, PhotometricInterpretation: "MONOCHROME2",
    SharedFunctionalGroupsSequence: [{
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      PixelMeasuresSequence: [{ PixelSpacing: [0.8, 0.5], SliceThickness: 2 }],
      MRTimingAndRelatedParametersSequence: [{ RepetitionTime: 2500, FlipAngle: 8 }],
    }],
    PerFrameFunctionalGroupsSequence: frames.map((f) => ({
      PlanePositionSequence: [{ ImagePositionPatient: [0, 0, f.z] }],
      FrameContentSequence: [{ FrameAcquisitionDateTime: "20260101120000.000000" }],
      ...(f.te !== undefined ? { MREchoSequence: [{ EffectiveEchoTime: f.te }] } : {}),
    })),
    PixelData: [px.buffer],
    _meta: {
      MediaStorageSOPClassUID: { Value: [ENHANCED_MR], vr: "UI" },
      MediaStorageSOPInstanceUID: { Value: [sop], vr: "UI" },
      TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" },
    },
  };
  return (dcmjs.data as unknown as { datasetToDict(d: unknown): { write(): ArrayBuffer } }).datasetToDict(ds).write();
}

const naturalize = (b: Uint8Array) => {
  const d = dcmjs.data as unknown as { DicomMessage: { readFile(b: ArrayBuffer): { dict: unknown } }; DicomMetaDictionary: { naturalizeDataset(d: unknown): Record<string, unknown> } };
  return d.DicomMetaDictionary.naturalizeDataset(d.DicomMessage.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer).dict);
};
const arr = <T>(v: T | T[]) => (Array.isArray(v) ? v : [v]);

/** Each slice k of the volume labeled k+1 inside an inset box: a label in the wrong slice shows at once. */
function sliceLabels(nz: number): Uint8Array {
  const lab = new Uint8Array(NX * NY * nz);
  for (let k = 0; k < nz; k++) for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) lab[k * NX * NY + j * NX + i] = k + 1;
  return lab;
}

for (const form of ["labelmap", "binary"] as const) {
  Deno.test(`multi-frame source (${form}): frames stored out of order, each SEG frame names its file and its frame`, async () => {
    // z = 4, 0, 6, 2 mm: frame 2 is the lowest slice, frame 3 the highest.
    const buf = enhancedMr([{ z: 4, value: 30 }, { z: 0, value: 10 }, { z: 6, value: 40 }, { z: 2, value: 20 }]);
    const { frames } = volumesOfSeries(await parseInstances([buf]));
    const v = frames[0];
    assertEquals(v.dims, [NX, NY, 4]);
    const labels = sliceLabels(4);
    const segments = [1, 2, 3, 4].map((n) => ({ labelValue: n, name: `Slice ${n}` }));
    const out = await segmentationToDicomSeg(labels, v.dims, segments, [buf], {
      form, sopInstanceUIDs: v.meta?.sopInstanceUIDs as string[], frameNumbers: v.meta?.frameNumbers as number[],
    });
    const ds = naturalize(out.bytes);
    const src = naturalize(new Uint8Array(buf));
    // The series named once, its one file once.
    const ref = arr(ds.ReferencedSeriesSequence as Record<string, unknown>)[0];
    assertEquals(ref.SeriesInstanceUID, src.SeriesInstanceUID);
    assertEquals(arr(ref.ReferencedInstanceSequence as Record<string, unknown>[]).map((r) => r.ReferencedSOPInstanceUID), [src.SOPInstanceUID]);
    // Every SEG frame: the source frame at its own position.
    const zOfSourceFrame = [4, 0, 6, 2];
    for (const g of arr(ds.PerFrameFunctionalGroupsSequence as Record<string, unknown>[])) {
      const z = Number((arr(g.PlanePositionSequence as Record<string, unknown>)[0].ImagePositionPatient as number[])[2]);
      const si = arr((arr(g.DerivationImageSequence as Record<string, unknown>)[0]).SourceImageSequence as Record<string, unknown>)[0];
      assertEquals(si.ReferencedSOPInstanceUID, src.SOPInstanceUID);
      assertEquals(zOfSourceFrame[Number(si.ReferencedFrameNumber) - 1], z, `a SEG frame at z = ${z} names source frame ${si.ReferencedFrameNumber}`);
    }
    // Only geometry in the shared groups: the MR timing macro does not belong in a SEG.
    const shared = arr(ds.SharedFunctionalGroupsSequence as Record<string, unknown>)[0];
    assert(!("MRTimingAndRelatedParametersSequence" in shared));
    assertEquals(Number(arr(shared.PixelMeasuresSequence as Record<string, unknown>)[0].SpacingBetweenSlices), 2);
    // And it reads back into the same voxels.
    const back = await decodeSegmentation(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer, { dims: v.dims, ijkToRAS: v.ijkToRAS });
    assertEquals(Array.from(back.lab), Array.from(labels));
    // dciodvfy, the one message known upstream aside (export-dicom-seg.roundtrip.test.ts; upstream-issues-dicom3tools.md).
    const known = /PatientOrientation\(0020,0020\)> - Missing attribute for Type 2C Conditional - Module=<GeneralImage>/;
    const check = dciodvfy(out.bytes);
    if (check) assertEquals(check.errors.filter((e) => !known.test(e)), []);
  });
}

Deno.test("multi-frame source with two echoes in one file: the SEG references the frames of the echo it was drawn on", async () => {
  // Frames interleaved: echo 1 at z 0, 2, 4; echo 2 at the same positions.
  const buf = enhancedMr([0, 2, 4].flatMap((z) => [{ z, value: 10 + z, te: 2 }, { z, value: 50 + z, te: 4 }]));
  const { frames } = volumesOfSeries(await parseInstances([buf]));
  assertEquals(frames.length, 2, "two echoes are two volumes");
  const v = frames[1];
  const fn = v.meta?.frameNumbers as number[];
  const out = await segmentationToDicomSeg(sliceLabels(3), v.dims, [1, 2, 3].map((n) => ({ labelValue: n, name: `S${n}` })), [buf], {
    sopInstanceUIDs: v.meta?.sopInstanceUIDs as string[], frameNumbers: fn,
  });
  const ds = naturalize(out.bytes);
  const named = arr(ds.PerFrameFunctionalGroupsSequence as Record<string, unknown>[]).map((g) =>
    Number(arr((arr(g.DerivationImageSequence as Record<string, unknown>)[0]).SourceImageSequence as Record<string, unknown>)[0].ReferencedFrameNumber));
  assertEquals([...named].sort((a, b) => a - b), [...fn].sort((a, b) => a - b));
  assertEquals(Number(ds.NumberOfFrames), 3);
});

Deno.test("multi-frame source across two files: each file named once, each frame by its own file", async () => {
  const ids = { study: uid(), series: uid(), frame: uid() };
  const a = enhancedMr([{ z: 0, value: 10 }, { z: 2, value: 20 }], ids), b = enhancedMr([{ z: 4, value: 30 }, { z: 6, value: 40 }], ids);
  const { frames } = volumesOfSeries(await parseInstances([a, b]));
  const v = frames[0];
  assertEquals(v.dims, [NX, NY, 4]);
  const out = await segmentationToDicomSeg(sliceLabels(4), v.dims, [1, 2, 3, 4].map((n) => ({ labelValue: n, name: `S${n}` })), [a, b], {
    sopInstanceUIDs: v.meta?.sopInstanceUIDs as string[], frameNumbers: v.meta?.frameNumbers as number[],
  });
  const ds = naturalize(out.bytes);
  const uA = naturalize(new Uint8Array(a)).SOPInstanceUID, uB = naturalize(new Uint8Array(b)).SOPInstanceUID;
  assertEquals(arr(arr(ds.ReferencedSeriesSequence as Record<string, unknown>)[0].ReferencedInstanceSequence as Record<string, unknown>[]).map((r) => r.ReferencedSOPInstanceUID).sort(), [uA, uB].sort());
  for (const g of arr(ds.PerFrameFunctionalGroupsSequence as Record<string, unknown>[])) {
    const z = Number((arr(g.PlanePositionSequence as Record<string, unknown>)[0].ImagePositionPatient as number[])[2]);
    const si = arr((arr(g.DerivationImageSequence as Record<string, unknown>)[0]).SourceImageSequence as Record<string, unknown>)[0];
    assertEquals(si.ReferencedSOPInstanceUID, z < 3 ? uA : uB);
    assertEquals(Number(si.ReferencedFrameNumber), z < 3 ? z / 2 + 1 : (z - 4) / 2 + 1);
  }
});
