// Enhanced multi-frame images (one file, many frames; geometry per frame in the functional groups) -- the form
// Siemens' XA software writes every MR series in. Built here with dcmjs, read back by the reader the page and the
// duckn copy share. Ron, 2026-09-25: "So how do we handle multiframe? Siemens stores for instance fmri in
// multiframe, I think that dmri acquisitions are increasingly stored in multiframe as well."
import { assert, assertEquals } from "jsr:@std/assert@1";
import dcmjs from "../dcmjs.ts";
import { lastSkipped, lastSkipReasons, parseInstances, setDcmjs, volumesOfSeries } from "./dicom-series.ts";
import { registerVolumeInterpreter, unregisterVolumeInterpreter } from "./volume-interpreters.ts";
setDcmjs(dcmjs);

const ENHANCED_MR = "1.2.840.10008.5.1.4.1.1.4.1";
const SEG = "1.2.840.10008.5.1.4.1.1.66.4";
const uid = () => `2.25.${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e15)}`;

interface Frame { z: number; value: number; t?: number; te?: number; b?: number; dir?: [number, number, number] }

/** One Enhanced MR file: nx x ny frames, each filled with its `value`, at (0, 0, z) mm, axial, 0.5 x 0.8 mm pixels. */
function enhancedMr(frames: Frame[], opts: { nx?: number; ny?: number; sopClass?: string; slope?: number } = {}): ArrayBuffer {
  const nx = opts.nx ?? 4, ny = opts.ny ?? 3;
  const px = new Uint16Array(nx * ny * frames.length);
  frames.forEach((f, i) => px.fill(f.value, i * nx * ny, (i + 1) * nx * ny));
  const sop = uid(), sopClass = opts.sopClass ?? ENHANCED_MR;
  const ds: Record<string, unknown> = {
    SOPClassUID: sopClass, SOPInstanceUID: sop, StudyInstanceUID: uid(), SeriesInstanceUID: uid(), FrameOfReferenceUID: uid(),
    Modality: "MR", PatientName: "TEST^MULTIFRAME", PatientID: "TEST-MF", SeriesDescription: "synthetic", InstanceNumber: 1,
    Rows: ny, Columns: nx, NumberOfFrames: frames.length, BitsAllocated: 16, BitsStored: 12, HighBit: 11, PixelRepresentation: 0,
    SamplesPerPixel: 1, PhotometricInterpretation: "MONOCHROME2",
    SharedFunctionalGroupsSequence: [{
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      PixelMeasuresSequence: [{ PixelSpacing: [0.8, 0.5], SliceThickness: 2 }],
      ...(opts.slope ? { PixelValueTransformationSequence: [{ RescaleSlope: opts.slope, RescaleIntercept: 0, RescaleType: "US" }] } : {}),
    }],
    PerFrameFunctionalGroupsSequence: frames.map((f) => ({
      PlanePositionSequence: [{ ImagePositionPatient: [0, 0, f.z] }],
      FrameContentSequence: [{ ...(f.t !== undefined ? { TemporalPositionIndex: f.t } : {}), FrameAcquisitionDateTime: `20260925${String(120000 + (f.t ?? 0) * 2).padStart(6, "0")}.000000` }],
      ...(f.te !== undefined ? { MREchoSequence: [{ EffectiveEchoTime: f.te }] } : {}),
      ...(f.b !== undefined ? { MRDiffusionSequence: [{
        DiffusionBValue: f.b, DiffusionDirectionality: f.dir ? "DIRECTIONAL" : "NONE",
        ...(f.dir ? { DiffusionGradientDirectionSequence: [{ DiffusionGradientOrientation: f.dir }] } : {}),
      }] } : {}),
    })),
    PixelData: [px.buffer],
    _meta: {
      MediaStorageSOPClassUID: { Value: [sopClass], vr: "UI" },
      MediaStorageSOPInstanceUID: { Value: [sop], vr: "UI" },
      TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" },
    },
  };
  return (dcmjs.data as unknown as { datasetToDict(d: unknown): { write(): ArrayBuffer } }).datasetToDict(ds).write();
}

Deno.test("an Enhanced MR file is one volume: every frame read, placed by its own position, whatever the frame order", async () => {
  // frames stored out of order: z = 4, 0, 6, 2 mm
  const buf = enhancedMr([{ z: 4, value: 30 }, { z: 0, value: 10 }, { z: 6, value: 40 }, { z: 2, value: 20 }]);
  const inst = await parseInstances([buf]);
  assertEquals(inst.length, 4, [...lastSkipReasons].join("; "));
  const { frames, leftOut } = volumesOfSeries(inst);
  assertEquals(frames.length, 1);
  assertEquals(leftOut, []);
  const v = frames[0];
  assertEquals(v.dims, [4, 3, 4]);
  // LPS -> RAS: x and y flip; columns 0.5 mm, rows 0.8 mm, slices 2 mm apart (from the positions, not SliceThickness)
  assertEquals(v.ijkToRAS, [-0.5, -0, -0, -0, -0, -0.8, -0, -0, 0, 0, 2, 0, 0, 0, 0, 1]);
  assertEquals([0, 1, 2, 3].map((k) => v.data[k * 12]), [10, 20, 30, 40]);
  // the slices name their frame of the one file, in slice order
  assertEquals(v.meta?.frameNumbers, [2, 4, 1, 3]);
  assertEquals(new Set(v.meta?.sopInstanceUIDs as string[]).size, 1);
});

Deno.test("a time series in one file (fMRI): one volume per time point, in time order, with its time", async () => {
  const frames: Frame[] = [];
  // interleaved: for each position, every time point -- the reader must not rely on the order
  for (const z of [0, 3, 6]) for (const t of [2, 1, 4, 3]) frames.push({ z, t, value: 100 * t + z });
  const inst = await parseInstances([enhancedMr(frames)]);
  const { frames: vols, timing } = volumesOfSeries(inst);
  assertEquals(vols.length, 4);
  vols.forEach((v, j) => {
    assertEquals(v.dims, [4, 3, 3]);
    assertEquals([0, 1, 2].map((k) => v.data[k * 12]), [0, 3, 6].map((z) => 100 * (j + 1) + z));
  });
  assertEquals(timing.map((t) => t.label), ["1 of 4", "2 of 4", "3 of 4", "4 of 4"]);
  // per-frame acquisition time survives, so the sequence can play at the scanner's rate
  assertEquals(timing.map((t) => t.timeSec), [1, 2, 3, 4].map((t) => 12 * 3600 + 2 * t));
});

Deno.test("a registered volume interpreter separates volumes, names them, and its values travel with each volume", async () => {
  // A stand-in interpreter (core reads no diffusion values; the diffusion extension registers the real one): it keys
  // frames by the MR Diffusion macro's b-value and direction, as an extension would.
  registerVolumeInterpreter({
    name: "test-key",
    frame(group) {
      const d = group("MRDiffusionSequence");
      if (d?.DiffusionBValue == null) return undefined;
      const g = ((d.DiffusionGradientDirectionSequence as Record<string, unknown>[] | undefined)?.[0]?.DiffusionGradientOrientation as number[] | undefined)?.map(Number);
      return { key: `${d.DiffusionBValue}|${g ?? ""}`, label: `k ${d.DiffusionBValue}`, meta: { value: Number(d.DiffusionBValue), ...(g ? { g } : {}) } };
    },
  });
  try {
    const kinds: { b: number; dir?: [number, number, number] }[] = [{ b: 0 }, { b: 1000, dir: [1, 0, 0] }, { b: 1000, dir: [0, 0.6, 0.8] }];
    const frames: Frame[] = [];
    kinds.forEach((kd, i) => { for (const z of [0, 2]) frames.push({ z, value: 10 * (i + 1), ...kd }); });
    const { frames: vols, timing } = volumesOfSeries(await parseInstances([enhancedMr(frames)]));
    assertEquals(vols.length, 3);
    assertEquals(vols.map((v) => v.data[0]), [10, 20, 30]);
    assertEquals(timing.map((t) => t.label), ["k 0", "k 1000", "k 1000"]);
    assertEquals(vols[1].meta?.["test-key"], { value: 1000, g: [1, 0, 0] });
    assertEquals(timing[2].keys?.["test-key"], { value: 1000, g: [0, 0.6, 0.8] });
  } finally { unregisterVolumeInterpreter("test-key"); }
});

Deno.test("the value scaling in the functional groups is applied", async () => {
  const inst = await parseInstances([enhancedMr([{ z: 0, value: 7 }, { z: 1, value: 9 }], { slope: 2 })]);
  const v = volumesOfSeries(inst).frames[0];
  assertEquals([v.data[0], v.data[12]], [14, 18]);
});

Deno.test("a segmentation is multi-frame too, and is not read as an image", async () => {
  const inst = await parseInstances([enhancedMr([{ z: 0, value: 1 }, { z: 1, value: 1 }], { sopClass: SEG })]);
  assertEquals(inst.length, 0);
  assert([...lastSkipReasons.keys()].some((k) => /a segmentation, not an image/.test(k)));
});

// CRITIC, 2026-09-25, findings 1 and 2: frames with the same key that repeat a position are more than one volume; a
// volume missing a slice is left out and named, and the rest load.
Deno.test("two b=0 volumes and a repeated direction are separate volumes, not one merged stack", async () => {
  const frames: Frame[] = [];
  const order: { b: number; dir?: [number, number, number]; v: number }[] = [{ b: 0, v: 10 }, { b: 1000, dir: [1, 0, 0], v: 20 }, { b: 0, v: 30 }, { b: 1000, dir: [1, 0, 0], v: 40 }];
  for (const o of order) for (const z of [0, 2, 4]) frames.push({ z, value: o.v, b: o.b, ...(o.dir ? { dir: o.dir } : {}) });
  const r = volumesOfSeries(await parseInstances([enhancedMr(frames)]));
  assertEquals(r.frames.length, 4);
  for (const v of r.frames) assertEquals(v.dims, [4, 3, 3]);
  assertEquals(r.frames.map((v) => v.data[0]).sort((a, b) => a - b), [10, 20, 30, 40]);
  for (const v of r.frames) assertEquals(v.meta?.irregularSpacing, undefined);
});

Deno.test("a time point with a damaged frame is left out and named; the other time points load", async () => {
  const frames: Frame[] = [];
  for (const t of [1, 2, 3, 4]) for (const z of [0, 3, 6]) frames.push({ z, t, value: 100 * t + z });
  const buf = enhancedMr(frames);
  // drop the position of one frame of time point 2 (frame index 3 = t 2, z 0)
  const p = dcmjs.data.DicomMessage.readFile(buf);
  const pf = (p.dict["52009230"] as { Value: Record<string, unknown>[] }).Value;
  delete pf[3]["00209113"];
  const out = new (dcmjs.data as unknown as { DicomDict: new (m: unknown) => { dict: unknown; write(): ArrayBuffer } }).DicomDict(p.meta); out.dict = p.dict;
  const inst = await parseInstances([out.write()]);
  // WHICH frame the reader could not use, by file and frame number (finding 7)
  assertEquals(lastSkipped.map((x) => [x.frameNumber, /no position/.test(x.why)]), [[4, true]]);
  assert(lastSkipped[0].sopInstanceUID, "the skipped frame names its file");
  const r = volumesOfSeries(inst);
  assertEquals(r.frames.length, 3);
  assertEquals(r.frames.map((v) => v.data[0]), [100, 300, 400]);
  assertEquals(r.labels, ["t 1", "t 3", "t 4"]);        // the gap shows (night finding 10)
  assertEquals(r.leftOut.length, 1);
  assert(/2 of 3 slices/.test(r.leftOut[0]), r.leftOut[0]);
  // ...and which frames went with the incomplete time point: its other two, frames 5 and 6
  assertEquals(r.leftOutImages.map((x) => x.frameNumber).sort(), [5, 6]);
  assertEquals(new Set(r.leftOutImages.map((x) => x.sopInstanceUID)).size, 1);
});

Deno.test("multi-echo with time points: one volume per time point and echo", async () => {
  const frames: Frame[] = [];
  for (const t of [1, 2]) for (const te of [10, 30]) for (const z of [0, 2]) frames.push({ z, t, te, value: 100 * t + te });
  const r = volumesOfSeries(await parseInstances([enhancedMr(frames)]));
  assertEquals(r.frames.length, 4);
  assertEquals(r.frames.map((v) => v.data[0]), [110, 130, 210, 230]);
  assertEquals(r.labels, ["t 1 · TE 10 ms", "t 1 · TE 30 ms", "t 2 · TE 10 ms", "t 2 · TE 30 ms"]);
});

/** An Enhanced MR with the positions of the given frames (0-based) removed. */
function withoutPositions(frames: Frame[], drop: number[]): ArrayBuffer {
  const p = dcmjs.data.DicomMessage.readFile(enhancedMr(frames));
  const pf = (p.dict["52009230"] as { Value: Record<string, unknown>[] }).Value;
  for (const i of drop) delete pf[i]["00209113"];
  const out = new (dcmjs.data as unknown as { DicomDict: new (m: unknown) => { dict: unknown; write(): ArrayBuffer } }).DicomDict(p.meta); out.dict = p.dict;
  return out.write();
}

// Critic, 2026-09-25 night, finding 3: b0 (10), a direction (20), a second b0 (40); the first b0 lost frame 3's
// position. Occurrence had made a "b 0" volume of [10, 10, 40] from both acquisitions. The complete ones load; the
// incomplete first b0 is left out, and it is ITS frames that are named.
Deno.test("two b=0 acquisitions, the first missing a frame: the second loads whole, the first is left out and named", async () => {
  const frames: Frame[] = [];
  for (const o of [{ b: 0, v: 10 }, { b: 1000, dir: [1, 0, 0] as [number, number, number], v: 20 }, { b: 0, v: 40 }]) {
    for (const z of [0, 2, 4]) frames.push({ z, value: o.v, b: o.b, ...(o.dir ? { dir: o.dir } : {}) });
  }
  const r = volumesOfSeries(await parseInstances([withoutPositions(frames, [2])]));
  assertEquals(r.frames.map((v) => [...new Set(v.data)].sort((a, b) => a - b)), [[20], [40]]);
  assertEquals(r.leftOutImages.map((x) => x.frameNumber).sort(), [1, 2]);
});

// Critic, 2026-09-25 night, finding 4: every volume incomplete crashed on an empty list. Now it says so.
Deno.test("every volume of a file incomplete: said in plain words, not a crash", async () => {
  const frames: Frame[] = [];
  for (const t of [1, 2]) for (const z of [0, 3, 6]) frames.push({ z, t, value: 100 * t + z });
  const inst = await parseInstances([withoutPositions(frames, [0, 4])]);
  let msg = "";
  try { volumesOfSeries(inst); } catch (e) { msg = (e as Error).message; }
  assert(/none of the volumes in this series is complete/.test(msg), msg || "no error");
});

// Critic, 2026-09-25 night, finding 5: a multi-frame file WITHOUT functional groups (legacy multi-frame MR, NM, multi-frame
// secondary capture) lost frames 2-N silently, or crashed. It is refused with its frame count, and named.
Deno.test("a multi-frame file without per-frame positions is refused with its frame count, not read as frame 1", async () => {
  const nx = 4, ny = 4, n = 3, sop = uid();
  const ds: Record<string, unknown> = {
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.4", SOPInstanceUID: sop, StudyInstanceUID: uid(), SeriesInstanceUID: uid(), Modality: "MR",
    Rows: ny, Columns: nx, NumberOfFrames: n, BitsAllocated: 16, BitsStored: 16, HighBit: 15, PixelRepresentation: 0,
    SamplesPerPixel: 1, PhotometricInterpretation: "MONOCHROME2",
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0], ImagePositionPatient: [0, 0, 0], PixelSpacing: [1, 1],
    PixelData: [new Uint16Array(nx * ny * n).fill(7).buffer],
    _meta: { MediaStorageSOPClassUID: { Value: ["1.2.840.10008.5.1.4.1.1.4"], vr: "UI" }, MediaStorageSOPInstanceUID: { Value: [sop], vr: "UI" }, TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" } },
  };
  const buf = (dcmjs.data as unknown as { datasetToDict(d: unknown): { write(): ArrayBuffer } }).datasetToDict(ds).write();
  const inst = await parseInstances([buf], { names: ["files/classic.dcm"] });
  assertEquals(inst.length, 0);
  assertEquals(lastSkipped.map((x) => [x.frames, x.file, /without per-frame positions/.test(x.why)]), [[3, "files/classic.dcm", true]]);
});

// Finding 6: a file that cannot be read at all is named by its path.
Deno.test("a file that cannot be read is named by its path", async () => {
  await parseInstances([new Uint8Array(300).fill(7).buffer], { names: ["files/garbage.dcm"] });
  assertEquals(lastSkipped.map((x) => x.file), ["files/garbage.dcm"]);
});

// Finding 8: "1,5" is not 15 mm in a multi-frame file either (the shared PixelMeasures item's own text decides).
Deno.test("a multi-frame slice thickness of \"1,5\" is unknown, not 15 mm; \"2\" is 2", async () => {
  const thickness = async (text: string) => {
    const p = dcmjs.data.DicomMessage.readFile(enhancedMr([{ z: 0, value: 1 }]));
    const shared = (p.dict["52009229"] as { Value: Record<string, { Value: Record<string, { vr: string; Value: unknown[] }>[] }>[] }).Value[0];
    shared["00289110"].Value[0]["00180050"] = { vr: "DS", Value: [text] };
    const out = new (dcmjs.data as unknown as { DicomDict: new (m: unknown) => { dict: unknown; write(): ArrayBuffer } }).DicomDict(p.meta); out.dict = p.dict;
    return (await parseInstances([out.write()]))[0].sliceThickness;
  };
  assertEquals(await thickness("1,5"), undefined);
  assertEquals(await thickness("2"), 2);
});
