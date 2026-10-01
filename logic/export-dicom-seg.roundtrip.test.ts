// THE CASE LIBRARY, headless: write a SEG, read it back, and require it to be the same segmentation.
//
// This exists because every earlier test of the DICOM export was a toy driven through a browser by
// hand, and the shapes they covered (172 frames, then 430) were exactly the shapes where the code
// worked. A 2^31 overflow that corrupts any export past ~8,000 frames at 512x512 reached real data
// before anything here noticed. Rule 1: you make it, I break it — so the breaking belongs here.
//
//   deno test -A --no-check logic/export-dicom-seg.roundtrip.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "./dcmjs.ts";
import { setDcmjs } from "./readers/dicom-series.ts";
setDcmjs(dcmjs);                                   // the whole path now runs without a browser

import { dciodvfy, dcmtkReads, HAS_DCIODVFY, HAS_DCMTK, HAS_PYDICOM, makeCtSeries } from "./test-dicom.ts";
import { segmentationToDicomSeg } from "./export-dicom-seg.ts";
import { decodeSegmentation } from "./readers/dicom-seg.ts";

/** Voxel count per label — the thing that has to survive the round trip exactly. */
function histogram(lab: ArrayLike<number>): Record<number, number> {
  const h: Record<number, number> = {};
  for (let i = 0; i < lab.length; i++) { const v = lab[i]; if (v) h[v] = (h[v] ?? 0) + 1; }
  return h;
}

/**
 * A labelmap of `nSeg` structures, each a slab of slices, over the given grid.
 *
 * Slabs rather than a threshold: the test needs to know the answer independently of the image, and a
 * slab's extent is exactly predictable — which is what lets the plausibility check below mean
 * something.
 */
function slabLabels(nx: number, ny: number, nz: number, nSeg: number): Uint8Array {
  const lab = new Uint8Array(nx * ny * nz);
  const per = Math.max(1, Math.floor(nz / nSeg));
  for (let s = 0; s < nSeg; s++) {
    const k0 = s * per, k1 = Math.min(nz, k0 + per);
    // an inset box, so no segment ever legitimately touches the edge of the field of view
    const i0 = 2 + (s % 3), i1 = nx - 3, j0 = 2 + (s % 2), j1 = ny - 3;
    for (let k = k0; k < k1; k++) {
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) lab[k * nx * ny + j * nx + i] = s + 1;
      }
    }
  }
  return lab;
}

async function roundTrip(nx: number, ny: number, nz: number, nSeg: number) {
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, nSeg);
  const segments = Array.from({ length: nSeg }, (_, i) => ({ labelValue: i + 1, name: `S${i + 1}` }));
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], segments, series.instances);
  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS },
  );
  return { out, labels, back, series };
}

/** No segment may span the whole field of view: the invariant that made the overflow obvious. */
function assertNoSegmentSpansTheImage(lab: ArrayLike<number>, nx: number, ny: number, nz: number) {
  const box: Record<number, { i0: number; i1: number; j0: number; j1: number }> = {};
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = lab[k * nx * ny + j * nx + i];
        if (!v) continue;
        const b = box[v] ??= { i0: nx, i1: -1, j0: ny, j1: -1 };
        if (i < b.i0) b.i0 = i;
        if (i > b.i1) b.i1 = i;
        if (j < b.j0) b.j0 = j;
        if (j > b.j1) b.j1 = j;
      }
    }
  }
  for (const [v, b] of Object.entries(box)) {
    assert(
      !(b.i0 === 0 && b.i1 === nx - 1 && b.j0 === 0 && b.j1 === ny - 1),
      `segment ${v} spans the entire ${nx}x${ny} field of view — the signature of misplaced voxels`,
    );
  }
}

Deno.test("round trip: a handful of segments on a small grid", async () => {
  const { out, labels, back } = await roundTrip(32, 32, 12, 3);
  assertEquals(out.segments, 3);
  assertEquals(histogram(back.lab), histogram(labels));
  assertNoSegmentSpansTheImage(back.lab, 32, 32, 12);
});

Deno.test("round trip: many segments, so frames are grouped per segment", async () => {
  const { out, labels, back } = await roundTrip(24, 24, 40, 20);
  assertEquals(out.segments, 20);
  assertEquals(out.frames, 40, "one frame per (segment, slice) it occupies");
  assertEquals(histogram(back.lab), histogram(labels));
  assertNoSegmentSpansTheImage(back.lab, 24, 24, 40);
});

Deno.test("round trip: a NON-SQUARE matrix, where frames need not be byte aligned", async () => {
  const { labels, back } = await roundTrip(21, 13, 9, 3);   // 273 voxels a frame: not a byte multiple
  assertEquals(histogram(back.lab), histogram(labels));
  assertNoSegmentSpansTheImage(back.lab, 21, 13, 9);
});

Deno.test("empty segments are dropped, and the ones that remain keep their identity", async () => {
  const nx = 16, ny = 16, nz = 8;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < nx * ny; i++) labels[i] = 2;            // only label 2 is present
  const segments = [
    { labelValue: 1, name: "empty one" },
    { labelValue: 2, name: "the real one" },
    { labelValue: 3, name: "empty two" },
  ];
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], segments, series.instances);
  assertEquals(out.segments, 1, "only the occupied segment is written");
  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS },
  );
  // `names` is keyed by SEGMENT NUMBER. In the LABEL MAP form (the default since 2026-09-18) the
  // segment number IS the label value, so the survivor keeps its 2; the BINARY form renumbers what
  // it keeps from 1 (C.8.20.2.4 requires it), so there the same segment comes back as 1. The name is
  // what carries the identity across either way.
  assertEquals(back.names[2], "the real one");
  assertEquals(histogram(back.lab), { 2: nx * ny });
  const bin = await segmentationToDicomSeg(labels, [nx, ny, nz], segments, series.instances, { form: "binary" });
  const backBin = await decodeSegmentation(bin.bytes.buffer.slice(bin.bytes.byteOffset, bin.bytes.byteOffset + bin.bytes.byteLength) as ArrayBuffer, { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS });
  assertEquals(backBin.names[1], "the real one");
  assertEquals(histogram(backBin.lab), { 1: nx * ny });
});

/**
 * THE SHAPE THAT BROKE ON REAL DATA, end to end.
 *
 * The overflow needs the bit stream to pass 2^31 — 8,192 frames at 512x512, which a full-body
 * ts:total run reaches easily (110 segments over ~100 slices is 11,000). Crossing it here without a
 * gigabyte of memory is a matter of shape: MANY SEGMENTS over FEW SLICES gives the frame count
 * without the volume, so 130 stripes over 64 slices is 8,320 frames — past the threshold — while the
 * labelmap itself is only 16 MB.
 *
 * The work is irreducible: any end-to-end test that crosses 2^31 bits must touch 2^31 voxels, so
 * this one is slow by construction. It is the single test that would have caught the bug.
 */
Deno.test("scale: past 2^31 bits, where 32-bit index arithmetic wraps", async () => {
  const nx = 512, ny = 512, nz = 64, nSeg = 130;
  const frames = nSeg * nz;
  assert(frames * nx * ny > 2 ** 31, `this test must cross 2^31 bits (got ${frames * nx * ny})`);

  const series = await makeCtSeries(nx, ny, nz);
  // Disjoint vertical stripes: every segment appears on every slice, which is what multiplies the
  // frame count, and no two segments share a voxel, which keeps the expected counts exact.
  const lab = new Uint8Array(nx * ny * nz);
  const stripe = Math.floor(nx / nSeg);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = k * nx * ny + j * nx;
      for (let s = 0; s < nSeg; s++) {
        for (let i = s * stripe; i < (s + 1) * stripe; i++) lab[row + i] = s + 1;
      }
    }
  }
  const segments = Array.from({ length: nSeg }, (_, i) => ({ labelValue: i + 1, name: `stripe ${i + 1}` }));
  const out = await segmentationToDicomSeg(lab, [nx, ny, nz], segments, series.instances, { form: "binary" });   // the bit-plane form is what crosses 2^31
  assertEquals(out.segments, nSeg);
  assertEquals(out.frames, frames);

  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS },
  );
  const expected = histogram(lab), got = histogram(back.lab);
  assertEquals(Object.keys(got).length, nSeg, "every segment survived the round trip");
  assertEquals(got, expected, "voxel counts are exact past the 2^31 mark");

  // AND ON THE SLOW PATHS. The check above runs the fastest path (same grid, byte-aligned, origin
  // 0). Opened against a reference one voxel wider, the reader takes the general path, whose bit
  // index passed 2^31 into negative numbers and read every later frame as empty (second critic,
  // 2026-09-17, finding 2). Each stripe's count must be the same as on the fast path.
  const wider = await makeCtSeries(nx + 1, ny, nz);
  const slow = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx + 1, ny, nz], ijkToRAS: wider.ijkToRAS },
  );
  assertEquals(histogram(slow.lab), expected, "the general path keeps every frame past the 2^31 mark");
});

// ── THE FRAME IS NOT NECESSARILY THE REFERENCE VOLUME'S SIZE ─────────────────────────────────────
//
// Ron, on a FastSurfer brain SEG: "I tried the brainsurfer data set and got bad results" -- thin
// diagonal streaks in axial, colored horizontal bands in coronal and sagittal. The decoder took the
// frame size to be `(nx * ny) >> 3` from the REFERENCE volume and decomposed each frame's pixels with
// `row = pp / nx`, so a SEG whose Rows/Columns differ from the volume it is opened against sheared:
// every row shifted by the difference and the frame smeared across slices. Rows and Columns belong to
// the SEG, and nothing requires them to match.
//
// Silent, too: the histogram was wrong and nothing said so. These two cases make it say so.

/** Decode a SEG written on one grid against a reference of a DIFFERENT in-plane size. */
Deno.test("a SEG opened against a differently-sized volume still lands where it belongs", async () => {
  const [nx, ny, nz] = [32, 24, 8];
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 3);
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], [
    { labelValue: 1, name: "S1" },
    { labelValue: 2, name: "S2" },
    { labelValue: 3, name: "S3" },
  ], series.instances);
  const bytes = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer;

  // A LARGER grid with the SAME origin and spacing: ijkToRAS does not mention dims, so every voxel
  // must land at the same (i,j,k), merely inside a bigger array.
  const [bx, by] = [40, 30];
  const back = await decodeSegmentation(bytes, { dims: [bx, by, nz], ijkToRAS: series.ijkToRAS });

  assertEquals(histogram(back.lab), histogram(labels), "voxel counts changed on the larger grid");
  assertNoSegmentSpansTheImage(back.lab, bx, by, nz);
  // And in the same places, not merely in the same quantity.
  let moved = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (labels[k * nx * ny + j * nx + i] !== back.lab[k * bx * by + j * bx + i]) moved++;
      }
    }
  }
  assertEquals(moved, 0, `${moved} voxels landed somewhere else`);
});

/** A frame whose pixel count is not a multiple of 8, so frames straddle byte boundaries. */
Deno.test("a SEG whose frames are not a whole number of bytes round-trips", async () => {
  // 21 x 11 = 231 pixels a frame. The writer packs these CONTINUOUSLY (setFrameBits' general path),
  // so a decoder that indexes by `f * (frameBits >> 3)` drifts seven bits per frame -- correct for
  // frame 0 and wrong for every one after it.
  const [nx, ny, nz] = [21, 11, 6];
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 2);
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], [
    { labelValue: 1, name: "S1" },
    { labelValue: 2, name: "S2" },
  ], series.instances);
  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS },
  );
  assertEquals((nx * ny) % 8 !== 0, true, "this case is pointless if the frame IS byte-aligned");
  assertEquals(histogram(back.lab), histogram(labels));
  let moved = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] !== back.lab[i]) moved++;
  assertEquals(moved, 0, `${moved} voxels landed somewhere else`);
});


// A NON-ASCII DESCRIPTION MUST SURVIVE, which needs SpecificCharacterSet to be written.
//
// A subject hierarchy read "<series> (cropped) Â· <date> <time>". Nothing was
// corrupt: the file held the correct UTF-8 bytes C2 B7 for a middle dot and simply never declared a
// character set, and absent (0008,0005) a conforming reader MUST decode those two bytes as two
// characters. So the writer was non-conformant and every correct reader -- real Slicer, any PACS --
// showed the mojibake. Verified on the file on disk before this was written.
//
// The interface joins names with a middle dot, so this is not an exotic case, it is the usual one.
Deno.test("a non-ASCII series description round-trips, because the character set is declared", async () => {
  const description = "T1w 3D TFE 0.67 mm (cropped) · 2026-09-07 10:28";
  const series = await makeCtSeries(8, 8, 4);
  const labels = slabLabels(8, 8, 4, 2);
  const out = await segmentationToDicomSeg(
    labels,
    [8, 8, 4],
    [{ labelValue: 1, name: "Ünïcode · name" }, { labelValue: 2, name: "S2" }],
    series.instances,
    { seriesDescription: description },
  );
  const ab = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer;
  const dict = dcmjs.data.DicomMessage.readFile(ab);
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dict.dict);
  assertEquals(
    String(ds.SpecificCharacterSet ?? ""),
    "ISO_IR 192",
    "without this tag a middle dot is not legal, and reads back as two characters",
  );
  assertEquals(String(ds.SeriesDescription), description, "the description must come back unmangled");
  // AND A SEGMENT'S NAME, which sits inside a sequence item, where dcmjs decodes as Latin-1
  // whatever the character set says (critic, 2026-09-17, finding 6). The reader re-reads it.
  const back = await decodeSegmentation(ab, { dims: [8, 8, 4], ijkToRAS: series.ijkToRAS });
  assertEquals(back.names[1], "Ünïcode · name", "a segment name inside a sequence must come back unmangled too");
});

Deno.test("a segment's codes land where DICOM puts them: type, laterality as the modifier, category", async () => {
  const series = await makeCtSeries(8, 8, 4);
  const labels = slabLabels(8, 8, 4, 3);
  const out = await segmentationToDicomSeg(
    labels,
    [8, 8, 4],
    [
      { labelValue: 1, name: "Kidney, right", code: "SCT:64033007", type: "Kidney", mod: "Right" },
      { labelValue: 2, name: "Cyst", code: "SCT:367643001", type: "Cyst", category: "Morphologically Altered Structure" },
      { labelValue: 3, name: "drawn by hand" },
    ],
    series.instances,
  );
  const ab = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer;
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(ab).dict);
  // The label map's first item is the background (segment 0); the structures follow it.
  const segs = (ds.SegmentSequence as Record<string, Record<string, string>>[]).filter((x) => Number(x.SegmentNumber) !== 0);
  const one = (s: Record<string, unknown>, seq: string) => s[seq] as Record<string, unknown> | undefined;
  const type = (s: Record<string, unknown>) => one(s, "SegmentedPropertyTypeCodeSequence");
  // the modifier sits INSIDE the type item, where DICOM (0062,0011) puts it
  const modifier = (s: Record<string, unknown>) => type(s)?.SegmentedPropertyTypeModifierCodeSequence as Record<string, string> | undefined;
  // kidney: the concept is Kidney and the side is a modifier, not baked into the meaning
  assertEquals(type(segs[0])?.CodeValue, "64033007");
  assertEquals(type(segs[0])?.CodeMeaning, "Kidney");
  assertEquals(modifier(segs[0])?.CodeValue, "24028007");
  assertEquals(modifier(segs[0])?.CodeMeaning, "Right");
  assertEquals(one(segs[0], "SegmentedPropertyCategoryCodeSequence")?.CodeValue, "91723000");   // CID 7150, not 123037004
  // a cyst is a morphologically altered structure, not an anatomical one
  assertEquals(one(segs[1], "SegmentedPropertyCategoryCodeSequence")?.CodeValue, "49755003");
  assertEquals(modifier(segs[1]), undefined);
  // no code: the generic type and no modifier, whatever the label says
  assertEquals(type(segs[2])?.CodeValue, "91723000");
  assertEquals(modifier(segs[2]), undefined);
});

Deno.test("a SEG says which mapping coded it, with and without a run", async () => {
  const series = await makeCtSeries(8, 8, 4);
  const labels = slabLabels(8, 8, 4, 1);
  const segs = [{ labelValue: 1, name: "Liver", code: "SCT:10200004", type: "Liver" }];
  const read = (bytes: Uint8Array) => {
    const dict = dcmjs.data.DicomMessage.readFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).dict as Record<string, { Value?: unknown[] }>;
    const nat = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dict) as { SoftwareVersions: string | string[]; ContentDescription: string };
    // Albula's private block: its creator and the whole provenance line (Ron, 2026-09-26: standards compliance)
    return { ...nat, creator: String(dict["00770010"]?.Value?.[0] ?? ""), line: String(dict["00771001"]?.Value?.[0] ?? "") };
  };
  const plain = read((await segmentationToDicomSeg(labels, [8, 8, 4], segs, series.instances)).bytes);
  const withRun = read((await segmentationToDicomSeg(labels, [8, 8, 4], segs, series.instances, {
    run: { task: "ts.v2:total", server: "haversack", haversack: "0.6.1" },
  })).bytes);
  const versions = (v: string | string[]) => Array.isArray(v) ? v : [v];
  // the mapping's repository and commit, as the catalog's header has them
  assert(versions(plain.SoftwareVersions).some((v) => /^segmentation-comparison [0-9a-f]{8}$/.test(v)), String(plain.SoftwareVersions));
  assert(versions(plain.SoftwareVersions).some((v) => /^MOOSE [0-9a-f]{8}$/.test(v)));
  assert(/codes segmentation-comparison [0-9a-f]{8}, MOOSE [0-9a-f]{8}/.test(plain.line), plain.line);
  assertEquals(plain.creator, "SlicerAlbula provenance 1");
  assert(plain.ContentDescription.length <= 64 && plain.line.startsWith(plain.ContentDescription.replace(/\.\.\.$/, "")), plain.ContentDescription);
  // with a run, the server comes first and the mapping still follows
  assertEquals(versions(withRun.SoftwareVersions)[0], "haversack 0.6.1");
  assert(versions(withRun.SoftwareVersions).some((v) => v.startsWith("segmentation-comparison ")));
  // ContentDescription is LO: 64 characters, the line's start; the whole line in the private block
  assert(withRun.ContentDescription.length <= 64, withRun.ContentDescription);
  assert(withRun.ContentDescription.startsWith("task ts.v2:total;"), withRun.ContentDescription);
  assert(withRun.line.startsWith("task ts.v2:total;") && /; codes segmentation-comparison/.test(withRun.line), withRun.line);
  for (const v of versions(withRun.SoftwareVersions)) assert(v.length <= 64, v);   // LO
});

// THE FRAMES OF A SEQUENCE share one series: Ron's gated CTA writes five phases of 533 slices as
// 2,665 instances. A SEG drawn on one phase references that phase's images only, named by their
// InstanceNumbers; without them the writer sees 2,665 frames for 533 slices and refuses.
Deno.test("a SEG on one frame of a series that holds several references that frame's instances only", async () => {
  const nx = 8, ny = 6, nz = 5;
  const a = await makeCtSeries(nx, ny, nz);
  const b = await makeCtSeries(nx, ny, nz);
  // the second phase: the same positions again, numbered after the first, in ONE series
  const renumber = async (bytes: ArrayBuffer, add: number) => {
    const dcmjs = (await import("./dcmjs.ts")).default;
    const parsed = dcmjs.data.DicomMessage.readFile(bytes);
    const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(parsed.dict);
    ds.InstanceNumber = Number(ds.InstanceNumber) + add;
    ds.SeriesInstanceUID = "1.2.3.4.5";
    ds.SOPInstanceUID = dcmjs.data.DicomMetaDictionary.uid();
    ds._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(parsed.meta);
    return dcmjs.data.datasetToDict(ds).write() as ArrayBuffer;
  };
  const phase1 = await Promise.all(a.instances.map((x) => renumber(x, 0)));
  const phase2 = await Promise.all(b.instances.map((x) => renumber(x, nz)));
  const uidsOf = (bufs: ArrayBuffer[]) => bufs.map((buf) => String(dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(buf).dict).SOPInstanceUID));
  const both = [...phase1, ...phase2];
  const labels = slabLabels(nx, ny, nz, 2);
  const segments = [{ labelValue: 1, name: "S1" }, { labelValue: 2, name: "S2" }];
  let msg = "";
  try { await segmentationToDicomSeg(labels, [nx, ny, nz], segments, both); } catch (e) { msg = (e as Error).message; }
  assert(msg.includes(`${2 * nz} frames`), msg);
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], segments, both, { instanceNumbers: [nz + 1, nz + 2, nz + 3, nz + 4, nz + 5] });
  assertEquals(out.frames > 0, true);
  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: a.ijkToRAS },
  );
  assertEquals(histogram(back.lab), histogram(labels));
  // The SEG names the second phase's instances and none of the first's: that is how a loaded SEG
  // finds its frame in a sequence, since both phases share the series.
  const named = new Set(back.referencedSOPInstanceUIDs ?? []);
  assertEquals(named.size, nz);
  assert(uidsOf(phase2).every((u) => named.has(u)), "the second phase's instances are referenced");
  assert(!uidsOf(phase1).some((u) => named.has(u)), "the first phase's are not");
});

// OVERLAPS ARE COUNTED, NOT SWALLOWED (critic, 2026-09-17, finding 3). A SEG whose segments claim
// the same voxels (Slicer's nnInteractive writes them as layers) becomes a labelmap where the later
// frame wins; the reader must say how many voxels changed hands. Built by moving segment 2's frames
// onto segment 1's slices in a written file, so both claim those slices.
Deno.test("voxels claimed by two segments are counted, and the later segment keeps them", async () => {
  const nx = 16, ny = 16, nz = 8;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 2);            // segment 1 on slices 0-3, segment 2 on 4-7
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], [
    { labelValue: 1, name: "S1" }, { labelValue: 2, name: "S2" },
  ], series.instances, { form: "binary" });          // overlap can only be built in the bit-plane form
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dcmjs.data.DicomMessage.readFile(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer).dict,
  ) as Record<string, unknown>;
  const frames = ds.PerFrameFunctionalGroupsSequence as Record<string, unknown>[];
  const segOf = (f: Record<string, unknown>) => Number(((f.SegmentIdentificationSequence as Record<string, unknown>[])[0]).ReferencedSegmentNumber);
  const posOf = (f: Record<string, unknown>) => (f.PlanePositionSequence as Record<string, unknown>[])[0];
  const first = frames.filter((f) => segOf(f) === 1), second = frames.filter((f) => segOf(f) === 2);
  assertEquals(first.length, second.length);
  for (let i = 0; i < second.length; i++) posOf(second[i]).ImagePositionPatient = posOf(first[i]).ImagePositionPatient;
  const parsed = dcmjs.data.DicomMessage.readFile(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer);
  (ds as { _meta?: unknown })._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(parsed.meta);
  const bytes = dcmjs.data.datasetToDict(ds).write() as ArrayBuffer;
  const back = await decodeSegmentation(bytes, { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS });
  // Segment 1's voxels on slices 0-3 were all taken by segment 2's moved frames (same inset box,
  // shifted by one column: the box for s=1 starts one column later and one row later).
  const box1 = histogram(labels)[1], box2 = histogram(labels)[2];
  const overlapped = back.overlapVoxels;
  assert(overlapped > 0, "an overlap must be counted");
  assert(overlapped <= Math.min(box1, box2), `at most the smaller box: ${overlapped} of ${Math.min(box1, box2)}`);
  const h = histogram(back.lab);
  assertEquals(h[2], box2, "the later segment keeps every voxel it claimed");
  assertEquals(h[1] ?? 0, box1 - overlapped, "the earlier segment lost exactly the counted voxels");
});

// A LABEL THE LIST DOES NOT NAME IS COUNTED (critic, 2026-09-17, finding 15): 64 voxels of label 9
// with a list naming only label 1 must be reported as not written, not lost in silence.
Deno.test("voxels of a label no segment names are counted as unlisted", async () => {
  const nx = 8, ny = 8, nz = 4;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < 64; i++) labels[i] = 1;             // slice 0: label 1
  for (let i = 64; i < 128; i++) labels[i] = 9;           // slice 1: label 9, unlisted
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], [{ labelValue: 1, name: "S1" }], series.instances);
  assertEquals(out.segments, 1);
  assertEquals(out.unlistedVoxels, 64);
  const listedToo = await segmentationToDicomSeg(labels, [nx, ny, nz], [{ labelValue: 1, name: "S1" }, { labelValue: 9, name: "S9" }], series.instances);
  assertEquals(listedToo.unlistedVoxels, 0);
});

// A MERGED SEGMENTATION SAVES (second critic, 2026-09-17, finding 1): with the networks named it is
// SEMIAUTOMATIC; with none — hand-drawn inputs — it is MANUAL, because C.8.20.2 requires a name
// for anything else and dcmjs enforces that. The first version asked for SEMIAUTOMATIC with no
// name and every merged save failed.
Deno.test("a merge writes SEMIAUTOMATIC with its networks, MANUAL without any", async () => {
  const nx = 8, ny = 8, nz = 4;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 2);
  const segs = [{ labelValue: 1, name: "S1" }, { labelValue: 2, name: "S2" }];
  const named = await segmentationToDicomSeg(labels, [nx, ny, nz], segs, series.instances, { merged: true, algorithmName: "ts:total + moose:organs" });
  const ds1 = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(named.bytes.buffer.slice(named.bytes.byteOffset, named.bytes.byteOffset + named.bytes.byteLength) as ArrayBuffer).dict) as Record<string, Record<string, string>[]>;
  const first = (d: Record<string, Record<string, string>[]>) => d.SegmentSequence.find((x) => Number(x.SegmentNumber) !== 0)!;   // past the label map's background item
  assertEquals(first(ds1).SegmentAlgorithmType, "SEMIAUTOMATIC");
  assertEquals(first(ds1).SegmentAlgorithmName, "ts:total + moose:organs");
  const unnamed = await segmentationToDicomSeg(labels, [nx, ny, nz], segs, series.instances, { merged: true });
  const ds2 = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(unnamed.bytes.buffer.slice(unnamed.bytes.byteOffset, unnamed.bytes.byteOffset + unnamed.bytes.byteLength) as ArrayBuffer).dict) as Record<string, Record<string, string>[]>;
  assertEquals(first(ds2).SegmentAlgorithmType, "MANUAL");
});

// THE LABEL MAP OBJECT ITSELF (Supplement 243), the default form since 2026-09-18: its SOP class,
// its pixel module, the background segment, one frame per slice, segment numbers equal to label
// values, the deflated transfer syntax -- and the size that is the reason for all of it.
Deno.test("the label map form: SOP class, pixel module, background, one frame per slice, deflated", async () => {
  const nx = 32, ny = 32, nz = 12;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 3);
  const segs = [{ labelValue: 1, name: "S1" }, { labelValue: 2, name: "S2" }, { labelValue: 3, name: "S3" }];
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], segs, series.instances);
  // The header says deflated; dcmjs inflates on read.
  const meta = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer).meta) as Record<string, string>;
  assertEquals(meta.TransferSyntaxUID, "1.2.840.10008.1.2.1.99");
  assertEquals(meta.MediaStorageSOPClassUID, "1.2.840.10008.5.1.4.1.1.66.7");
  const ds = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer).dict) as Record<string, unknown>;
  assertEquals(ds.SOPClassUID, "1.2.840.10008.5.1.4.1.1.66.7");
  assertEquals(ds.SegmentationType, "LABELMAP");
  assertEquals(ds.SegmentsOverlap, "NO");
  assertEquals([Number(ds.BitsAllocated), Number(ds.BitsStored), Number(ds.HighBit), Number(ds.PixelRepresentation)], [8, 8, 7, 0]);
  assertEquals(Number(ds.PixelPaddingValue), 0);
  assertEquals(Number(ds.NumberOfFrames), nz, "one frame per slice");
  const items = ds.SegmentSequence as Record<string, unknown>[];
  assertEquals(items.map((i) => Number(i.SegmentNumber)), [0, 1, 2, 3], "background 0, then the label values");
  assertEquals(String(items[0].SegmentLabel), "Background");
  const pf = ds.PerFrameFunctionalGroupsSequence as Record<string, unknown>[];
  assertEquals(pf.length, nz);
  assert(pf.every((f) => !f.SegmentIdentificationSequence), "no segment identification per frame in a label map");
  assertEquals(ds.DimensionIndexSequence && (ds.DimensionIndexSequence as unknown[]).length, 1, "one dimension: the plane position");
  // The bytes: a byte per voxel, in slice order, exactly the labelmap.
  const back = await decodeSegmentation(out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer, { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS });
  assertEquals(histogram(back.lab), histogram(labels));
  let moved = 0; for (let i = 0; i < labels.length; i++) if (labels[i] !== back.lab[i]) moved++;
  assertEquals(moved, 0, "every voxel where it was");
  assertEquals(back.names, { 1: "S1", 2: "S2", 3: "S3" }, "the background is not a structure");
  // The size: the deflated label map is far smaller than the bit planes of the binary form.
  const bin = await segmentationToDicomSeg(labels, [nx, ny, nz], segs, series.instances, { form: "binary" });
  assert(out.bytes.length < bin.bytes.length / 2, `label map ${out.bytes.length} B against binary ${bin.bytes.length} B`);
  // Uncompressed on request.
  const plain = await segmentationToDicomSeg(labels, [nx, ny, nz], segs, series.instances, { compress: false });
  const metaPlain = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dcmjs.data.DicomMessage.readFile(plain.bytes.buffer.slice(plain.bytes.byteOffset, plain.bytes.byteOffset + plain.bytes.byteLength) as ArrayBuffer).meta) as Record<string, string>;
  assertEquals(metaPlain.TransferSyntaxUID, "1.2.840.10008.1.2.1");
  // And read by a tool that is not ours -- when python3 with pydicom and numpy is here (test-dicom.ts, HAS_PYDICOM).
  if (!HAS_PYDICOM) { console.warn("pydicom (python3 with pydicom and numpy) not found: the external-reader check was skipped"); return; }
  const tmp = await Deno.makeTempFile({ suffix: ".dcm" });
  await Deno.writeFile(tmp, out.bytes);
  const py = await new Deno.Command("python3", { args: ["-c", `
import pydicom, numpy as np, sys
ds = pydicom.dcmread(sys.argv[1])
assert ds.file_meta.TransferSyntaxUID == "1.2.840.10008.1.2.1.99", ds.file_meta.TransferSyntaxUID
assert ds.SOPClassUID == "1.2.840.10008.5.1.4.1.1.66.7"
assert ds.SegmentationType == "LABELMAP" and int(ds.NumberOfFrames) == ${nz}
px = ds.pixel_array
assert px.shape == (${nz}, ${ny}, ${nx}), px.shape
vals, counts = np.unique(px, return_counts=True)
import json; print(json.dumps({str(v): c for v, c in zip(vals.tolist(), counts.tolist())}))
`, tmp], stdout: "piped", stderr: "piped" }).output();
  await Deno.remove(tmp);
  assert(py.success, `pydicom check failed: ${new TextDecoder().decode(py.stderr)} ${new TextDecoder().decode(py.stdout)} (code ${py.code})`);
  const h = JSON.parse(new TextDecoder().decode(py.stdout)) as Record<string, number>;
  const expected = histogram(labels);
  for (const [v, n] of Object.entries(expected)) assertEquals(h[v], n, `pydicom counts label ${v}`);
});

Deno.test("the codes a SEG carries are read back: category, type and its modifier", async () => {
  const nx = 12, ny = 10, nz = 6;
  const series = await makeCtSeries(nx, ny, nz);
  const labels = slabLabels(nx, ny, nz, 2);
  const segments = [
    { labelValue: 1, name: "Kidney, right", code: "SCT:64033007", type: "Kidney", mod: "Right" },
    { labelValue: 2, name: "no such structure" },                       // the writer's generic code
  ];
  const out = await segmentationToDicomSeg(labels, [nx, ny, nz], segments, series.instances);
  const back = await decodeSegmentation(
    out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer,
    { dims: [nx, ny, nz], ijkToRAS: series.ijkToRAS },
  );
  const k = back.fileCodes[1];
  assert(k, "the coded segment comes back with its codes");
  assertEquals(k.type, { scheme: "SCT", value: "64033007", meaning: "Kidney" });
  assertEquals(k.modifier?.value, "24028007");
  assertEquals(k.modifier?.meaning, "Right");
  assertEquals(k.category?.scheme, "SCT");
  const g = back.fileCodes[2];
  assert(g?.type, "the generic code is a code too, and is read back as what the file said");
  assertEquals(g.type.meaning, "Anatomical structure");
});

// Ron's lung_vessels on R_180, 2026-09-23: the source CT was Implicit VR, the segmentation was written
// Implicit and labeled Deflated Explicit, and neither dcmjs nor Albula could read it back.
Deno.test("a segmentation made on an Implicit VR series is written Explicit, as its header says, and reads back", async () => {
  const series = await makeCtSeries(8, 8, 4);
  const implicit = series.instances.map((ab) => {
    const d = dcmjs.data.DicomMessage.readFile(ab);
    (d.meta as Record<string, { Value: string[] }>)["00020010"].Value = ["1.2.840.10008.1.2"];
    return d.write() as ArrayBuffer;
  });
  assertEquals((dcmjs.data.DicomMessage.readFile(implicit[0]).meta as Record<string, { Value: string[] }>)["00020010"].Value[0], "1.2.840.10008.1.2", "the fixture is Implicit VR");
  const labels = slabLabels(8, 8, 4, 2);
  const out = await segmentationToDicomSeg(labels, [8, 8, 4], [{ labelValue: 1, name: "S1" }, { labelValue: 2, name: "S2" }], implicit, {});
  const ab = out.bytes.buffer.slice(out.bytes.byteOffset, out.bytes.byteOffset + out.bytes.byteLength) as ArrayBuffer;
  dcmjs.data.DicomMessage.readFile(ab);                      // threw "coding.replace is not a function"
  const back = await decodeSegmentation(ab, { dims: [8, 8, 4], ijkToRAS: series.ijkToRAS });
  assertEquals(back.names[1], "S1");
  let same = 0;
  for (let i = 0; i < labels.length; i++) if (back.lab[i] === labels[i]) same++;
  assertEquals(same, labels.length, "every voxel's label comes back");
});


Deno.test({
  name: "DCMTK reads the segmentation we write (dcmdump)",
  ignore: !HAS_DCMTK,
  fn: async () => {
    const { out } = await roundTrip(12, 10, 6, 3);
    assertEquals(dcmtkReads(out.bytes), true);
  },
});

// dciodvfy (dicom3tools) on the segmentation we write, inflated first (DICOM parity plan, step 1). One message is
// known and not ours: dicom3tools' PatientOrientationRequired exempts Segmentation Storage but not Label Map
// Segmentation Storage, whose orientation is in the functional groups the same way (the Plane Orientation item is in
// the shared group); drafted in Contents/docs/upstream-issues-dicom3tools.md. Anything else fails.
Deno.test({
  name: "dciodvfy: the segmentation we write has no conformance errors beyond the one known upstream",
  ignore: !HAS_DCIODVFY,
  fn: async () => {
    const { out } = await roundTrip(12, 10, 6, 3);
    const known = /PatientOrientation\(0020,0020\)> - Missing attribute for Type 2C Conditional - Module=<GeneralImage>/;
    assertEquals(dciodvfy(out.bytes)!.errors.filter((e) => !known.test(e)), []);
  },
});

// dciodvfy on a segmentation WITH a network run: its provenance line is longer than ContentDescription's 64 characters,
// which the plain SEG above never was (DICOM parity step 1; Ron, 2026-09-26: "Standards compliance").
Deno.test({
  name: "dciodvfy: a segmentation with a long provenance line has no conformance errors beyond the one known upstream",
  ignore: !HAS_DCIODVFY,
  fn: async () => {
    const series = await makeCtSeries(8, 8, 4);
    const out = await segmentationToDicomSeg(slabLabels(8, 8, 4, 1), [8, 8, 4], [{ labelValue: 1, name: "Liver", code: "SCT:10200004", type: "Liver" }], series.instances, {
      run: { task: "ts.v2:total", server: "haversack", haversack: "0.12.0", engine: "nnU-Net v2", device: "mps", dtype: "float16",
        models: [{ folder: "Dataset291_TotalSegmentator_part1_organs_1559subj", version: "2.6", folds: ["0"] }], timings: { total: 41.3 }, at: "2026-09-26T09:00:00" },
    });
    const known = /PatientOrientation\(0020,0020\)> - Missing attribute for Type 2C Conditional - Module=<GeneralImage>/;
    assertEquals(dciodvfy(out.bytes)!.errors.filter((e) => !known.test(e)), []);
  },
});
