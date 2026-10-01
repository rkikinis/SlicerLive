// NRRD reading, with the emphasis on what the format DECLARES and this reader used to discard.
//
// NRRD is the one common imaging format that states its coordinate space instead of assuming one, and
// it states per-axis units too. The reader used to collapse `space` to a prefix test and ignore
// `space units` entirely, which silently mirrored every non-anatomical volume and read micrometers as
// millimeters. Those are the first two groups below.
//
//   deno test -A --no-check render/nrrd.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { packLabelsToByte, parseNrrd, parseNrrdSeg } from "./nrrd.ts";
import { writeNrrd } from "../logic/writers/nrrd.ts";

/** Build a minimal NRRD by hand, so a header field can be varied in isolation. */
function nrrd(fields: string[], data: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(["NRRD0004", ...fields].join("\n") + "\n\n");
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

const BASE = [
  "type: uchar",
  "dimension: 3",
  "sizes: 2 2 2",
  "space directions: (1,0,0) (0,1,0) (0,0,1)",
  "kinds: domain domain domain",
  "encoding: raw",
  "space origin: (10,20,30)",
];
const EIGHT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// The x and y diagonal entries carry the LPS->RAS sign flip; reading them is reading the decision.
const xySigns = (m: number[]) => [Math.sign(m[0]), Math.sign(m[5])];

Deno.test("space: an anatomical LPS volume is flipped to RAS", async () => {
  const n = await parseNrrd(nrrd([...BASE, "space: left-posterior-superior"], EIGHT));
  assertEquals(xySigns(n.ijkToRAS), [-1, -1]);
  assertEquals(n.anatomical, true);
  assertEquals(n.ijkToRAS.slice(3, 4), [-10]);
});

Deno.test("space: an anatomical RAS volume is left alone", async () => {
  const n = await parseNrrd(nrrd([...BASE, "space: right-anterior-superior"], EIGHT));
  assertEquals(xySigns(n.ijkToRAS), [1, 1]);
  assertEquals(n.anatomical, true);
});

// The bug this file exists for. "3d-right-handed" does not start with "right", so the old prefix test
// treated a microscopy stack or a phantom as LPS and negated X and Y — a mirrored volume, no error.
Deno.test("space: a NON-anatomical volume is NOT flipped, and says it is not anatomical", async () => {
  for (const space of ["3D-right-handed", "3D-left-handed", "scanner-xyz"]) {
    const n = await parseNrrd(nrrd([...BASE, `space: ${space}`], EIGHT));
    assertEquals(xySigns(n.ijkToRAS), [1, 1], `${space} must not be mirrored`);
    assertEquals(n.anatomical, false, `${space} is not anatomical`);
    // The origin must come through unnegated too, or the volume is translated as well as mirrored.
    assertEquals(n.ijkToRAS[3], 10, `${space} origin must not be negated`);
  }
});

// A file with no `space` says nothing about orientation. Inventing anatomy for it is the same bug in
// a different coat, so it reads as a bare right-handed world.
Deno.test("space: an absent space is a bare world frame, not assumed anatomy", async () => {
  const n = await parseNrrd(nrrd(BASE, EIGHT));
  assertEquals(n.anatomical, false);
  assertEquals(xySigns(n.ijkToRAS), [1, 1]);
});

Deno.test("space: an unrecognised space throws rather than defaulting", async () => {
  await assertRejects(
    () => parseNrrd(nrrd([...BASE, "space: galactic"], EIGHT)),
    Error,
    "refusing to guess an orientation",
  );
});

// `space units` is per axis and routinely not millimeters. Carried rather than applied: rescaling
// here would hide the unit from the caller, which is the mistake being fixed.
Deno.test("space units: carried per axis, verbatim", async () => {
  const n = await parseNrrd(
    nrrd([...BASE, "space: 3D-right-handed", 'space units: "um" "um" "um"'], EIGHT),
  );
  assertEquals(n.spaceUnits, ["um", "um", "um"]);
  const plain = await parseNrrd(nrrd([...BASE, "space: 3D-right-handed"], EIGHT));
  assertEquals(plain.spaceUnits, []);
});

Deno.test("scalar path: a 4-D file is refused, and says where to go", async () => {
  await assertRejects(
    () => parseNrrd(nrrd([
      "type: uchar", "dimension: 4", "sizes: 2 2 2 2", "kinds: list domain domain domain",
      "space: right-anterior-superior", "space directions: none (1,0,0) (0,1,0) (0,0,1)",
      "encoding: raw", "space origin: (0,0,0)",
    ], new Uint8Array(16))),
    Error,
    "parseNrrdSeg",
  );
});

// --- segmentations -------------------------------------------------------------------------------

Deno.test("seg: labels stay integers and are not widened", async () => {
  const seg = await parseNrrdSeg(nrrd([...BASE, "space: right-anterior-superior"], EIGHT));
  assertEquals(seg.layers.length, 1);
  assertEquals(seg.layers[0].constructor.name, "Uint8Array");
  assertEquals([...seg.layers[0]], [1, 2, 3, 4, 5, 6, 7, 8]);
});

// A labelmap of floats is a category error: label values are identities, not measurements.
Deno.test("seg: a float type is refused", async () => {
  await assertRejects(
    () => parseNrrdSeg(nrrd([
      "type: float", "dimension: 3", "sizes: 2 2 2", "space: right-anterior-superior",
      "space directions: (1,0,0) (0,1,0) (0,0,1)", "encoding: raw", "space origin: (0,0,0)",
    ], new Uint8Array(32))),
    Error,
    "must have an integer type",
  );
});

// The form that overlapping segments require: one independent labelmap per layer, because a single
// labelmap cannot hold two labels in one voxel.
Deno.test("seg: the 4-D multi-layer form is read, one labelmap per layer", async () => {
  const bytes = new Uint8Array([
    1, 1, 0, 0, 0, 0, 0, 0, // layer 0
    0, 0, 2, 2, 0, 0, 0, 0, // layer 1
  ]);
  const seg = await parseNrrdSeg(nrrd([
    "type: uchar", "dimension: 4", "sizes: 2 2 2 2", "kinds: list domain domain domain",
    "space: right-anterior-superior", "space directions: none (1,0,0) (0,1,0) (0,0,1)",
    "encoding: raw", "space origin: (0,0,0)",
    "Segment0_Name:=liver", "Segment0_LabelValue:=1", "Segment0_Layer:=0",
    "Segment0_Color:=0.8 0.2 0.2", "Segment0_ID:=Segment_1",
    "Segment1_Name:=tumour", "Segment1_LabelValue:=2", "Segment1_Layer:=1",
    "Segment1_Color:=0.2 0.8 0.2", "Segment1_ID:=Segment_2",
  ], bytes));

  assertEquals(seg.dims, [2, 2, 2]);
  assertEquals(seg.layers.length, 2);
  assertEquals([...seg.layers[0]], [1, 1, 0, 0, 0, 0, 0, 0]);
  assertEquals([...seg.layers[1]], [0, 0, 2, 2, 0, 0, 0, 0]);
  assertEquals(seg.segments.map((s) => [s.name, s.labelValue, s.layer]), [["liver", 1, 0], ["tumour", 2, 1]]);
  assertEquals(seg.segments[0].color, [0.8, 0.2, 0.2]);
});

// The other half of a writer that already emits Slicer's Segment* keys: our own output, read back.
Deno.test("seg: writeNrrd -> parseNrrdSeg preserves segment identity and colour", async () => {
  const vol = {
    dims: [2, 2, 2] as [number, number, number],
    dtype: "|u1",
    data: new Uint8Array([1, 1, 2, 2, 0, 0, 0, 0]),
    ijkToRAS: [0.5, 0, 0, -1, 0, 0.5, 0, -2, 0, 0, 0.5, -3, 0, 0, 0, 1],
  };
  const segments = [
    { labelValue: 1, name: "kidney-left", color: [0.9, 0.4, 0.3] },
    { labelValue: 2, name: "kidney-right", color: [0.3, 0.4, 0.9] },
  ];
  // deno-lint-ignore no-explicit-any
  const bytes = await writeNrrd(vol as any, { segmentation: { segments } });
  const seg = await parseNrrdSeg(bytes);

  assertEquals(seg.dims, [2, 2, 2]);
  assertEquals(seg.anatomical, true);
  assertEquals([...seg.layers[0]], [1, 1, 2, 2, 0, 0, 0, 0]);
  assertEquals(seg.segments.map((s) => s.name), ["kidney-left", "kidney-right"]);
  assertEquals(seg.segments.map((s) => s.labelValue), [1, 2]);
  assertEquals(seg.segments[1].color.map((c) => Number(c.toFixed(1))), [0.3, 0.4, 0.9]);
  // The writer emits RAS, so the reader must not flip it back.
  assertEquals(seg.ijkToRAS[0], 0.5);
  assertEquals(seg.ijkToRAS[3], -1);
});

// FastSurfer emits FreeSurfer's numbering: 17 is the left hippocampus, 1000-1035 and 2000-2035 are
// the cortical parcellations. Requiring every VALUE to be under 256 turned away a result with well
// under a hundred structures in it. Ron: "this result uses label values up to 2035; the scene's
// labelmap holds 255". Renumber; do not truncate.
Deno.test("packLabels: FreeSurfer's sparse numbering renumbers densely", () => {
  const r = packLabelsToByte(new Int32Array([0, 17, 1000, 2035, 17, 0]));
  assert(r.ok);
  assertEquals([...r.labels], [0, 1, 2, 3, 1, 0]);
  assertEquals(r.remap.get(17), 1);
  assertEquals(r.remap.get(1000), 2);
  assertEquals(r.remap.get(2035), 3);
});

Deno.test("packLabels: background stays background and gets no number", () => {
  const r = packLabelsToByte(new Uint16Array([0, 0, 300]));
  assert(r.ok);
  assertEquals([...r.labels], [0, 0, 1]);
  assertEquals(r.remap.has(0), false);
});

// The renumbering is not a truncation: two values that would collide under a byte cast must stay
// apart. 300 & 0xFF is 44, so a cast would have merged it with a real 44.
Deno.test("packLabels: values that a byte cast would merge stay distinct", () => {
  const r = packLabelsToByte(new Uint16Array([44, 300]));
  assert(r.ok);
  assertEquals(r.labels[0] === r.labels[1], false);
});

// 0 is background, so all 255 remaining codes are usable -- exactly 255 structures must fit.
Deno.test("packLabels: 255 distinct structures fit, 256 do not", () => {
  const fits = new Uint16Array(255);
  for (let i = 0; i < 255; i++) fits[i] = (i + 1) * 10;
  const a = packLabelsToByte(fits);
  assert(a.ok);
  assertEquals(a.remap.size, 255);

  const over = new Uint16Array(256);
  for (let i = 0; i < 256; i++) over[i] = (i + 1) * 10;
  const b = packLabelsToByte(over);
  assertEquals(b.ok, false);
  if (!b.ok && b.reason === "too-many") assertEquals(b.distinct, 256);
});

// A negative value is not a label. Mapping it to background would delete voxels silently, which is
// the whole failure this function exists to prevent.
Deno.test("packLabels: a negative value is reported, not quietly dropped", () => {
  const r = packLabelsToByte(new Int16Array([0, 5, -3]));
  assertEquals(r.ok, false);
  if (!r.ok && r.reason === "negative") assertEquals(r.min, -3);
});

// A byte labelmap already numbered 1..N is the common case and must not cost a 418 MB copy.
Deno.test("packLabels: an already-dense byte labelmap is handed back unchanged", () => {
  const src = new Uint8Array([0, 1, 2, 3, 2]);
  const r = packLabelsToByte(src);
  assert(r.ok);
  assertEquals(r.labels === src, true);
});

// A byte labelmap with GAPS still renumbers -- otherwise a palette of 256 entries is indexed by
// values that skip, which is exactly the sparse case one size down.
Deno.test("packLabels: a byte labelmap with gaps is renumbered too", () => {
  const r = packLabelsToByte(new Uint8Array([0, 10, 200]));
  assert(r.ok);
  assertEquals([...r.labels], [0, 1, 2]);
});
