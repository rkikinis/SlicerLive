// Cropping is a DATA operation, so it is the kind that has to be exactly right: a segmentation made
// on a cropped volume gets measured. Ron: "people want to use parcellations for quantifications, and
// for that purpose, precision beats everything else."
//
//   deno test -A --no-check logic/crop.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { type Box, boundingBoxOf, boxAroundData, boxAxis, boxCorners, boxPlanePolygon, cropVolume, cutBox, cutBoxAtPlane, invertAffine, voxelRangeFor, volumeAlignedBox } from "./crop.ts";

/** A 4x4 with 1 mm spacing and the origin at the RAS point given. */
const identityAt = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const make = (n: number) => new Int16Array(n) as unknown as { length: number; [i: number]: number };

/** data[i + nx*(j + ny*k)] = a value that identifies the voxel, so a wrong index shows up. */
function ramp(nx: number, ny: number, nz: number) {
  const d = new Int16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    d[i + nx * (j + ny * k)] = i + 10 * j + 100 * k;
  }
  return d as unknown as { length: number; [i: number]: number };
}

Deno.test("invertAffine round-trips an oblique matrix", () => {
  const m = [0.9, 0.1, 0.05, 12, -0.1, 0.88, 0.2, -7, 0.03, -0.2, 0.95, 33, 0, 0, 0, 1];
  const inv = invertAffine(m);
  const p = [3, -5, 11];
  const fwd = [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
  const back = [
    inv[0] * fwd[0] + inv[1] * fwd[1] + inv[2] * fwd[2] + inv[3],
    inv[4] * fwd[0] + inv[5] * fwd[1] + inv[6] * fwd[2] + inv[7],
    inv[8] * fwd[0] + inv[9] * fwd[1] + inv[10] * fwd[2] + inv[11],
  ];
  for (let i = 0; i < 3; i++) assert(Math.abs(back[i] - p[i]) < 1e-9, `${back[i]} != ${p[i]}`);
});

// THE VOXELS OUT ARE THE VOXELS IN. Nothing is resampled, so every value must be findable at its
// new index, unchanged.
Deno.test("the cropped voxels are the source voxels, unaltered", () => {
  const [nx, ny, nz] = [8, 8, 8];
  const src = ramp(nx, ny, nz);
  const r = cropVolume(src, [nx, ny, nz], identityAt(0, 0, 0), { center: [3.5, 3.5, 3.5], size: [2, 2, 2] }, make)!;
  assert(r, "the box is inside the volume");
  const [w, h] = r.dims;
  for (let k = 0; k < r.dims[2]; k++) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const si = r.origin[0] + i, sj = r.origin[1] + j, sk = r.origin[2] + k;
    assertEquals(r.data[i + w * (j + h * k)], src[si + nx * (sj + ny * sk)], `voxel ${i},${j},${k}`);
  }
});

// ONLY THE ORIGIN MOVES. If the direction cosines or the spacing changed, a segmentation made on the
// crop would no longer sit on the original.
Deno.test("the crop keeps the source's spacing and orientation, and moves only the origin", () => {
  const m = [0.7, 0, 0, 100, 0, 0.7, 0, -50, 0, 0, 0.7, 20, 0, 0, 0, 1];
  const r = cropVolume(ramp(8, 8, 8), [8, 8, 8], m, { center: [102.8, -47.2, 22.8], size: [2, 2, 2] }, make)!;
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) assertEquals(r.ijkToRAS[i], m[i], `element ${i} must not change`);
  // the new origin is the source mapping of the crop's first voxel
  assertEquals(r.ijkToRAS[3], m[0] * r.origin[0] + m[3]);
  assertEquals(r.ijkToRAS[7], m[5] * r.origin[1] + m[7]);
  assertEquals(r.ijkToRAS[11], m[10] * r.origin[2] + m[11]);
});

// It errs by keeping too much, never by cutting: on an OBLIQUE volume the box is tilted in voxel
// space, so the whole-voxel range that holds it is larger than the box.
Deno.test("an oblique volume keeps everything the box asked for", () => {
  const c = Math.cos(0.4), s = Math.sin(0.4);
  const m = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const box = { center: [4, 4, 4] as [number, number, number], size: [3, 3, 3] as [number, number, number] };
  const r = voxelRangeFor([16, 16, 16], m, box)!;
  const inv = invertAffine(m);
  for (let n = 0; n < 8; n++) {
    const p = [
      box.center[0] + (n & 1 ? 1.5 : -1.5),
      box.center[1] + (n & 2 ? 1.5 : -1.5),
      box.center[2] + (n & 4 ? 1.5 : -1.5),
    ];
    const v = [
      inv[0] * p[0] + inv[1] * p[1] + inv[2] * p[2] + inv[3],
      inv[4] * p[0] + inv[5] * p[1] + inv[6] * p[2] + inv[7],
      inv[8] * p[0] + inv[9] * p[1] + inv[10] * p[2] + inv[11],
    ];
    for (let k = 0; k < 3; k++) assert(v[k] >= r.lo[k] - 1e-9 && v[k] <= r.hi[k] + 1e-9, `corner ${n} axis ${k} outside`);
  }
});

Deno.test("a box hanging over the edge crops to what exists; one that misses is reported", () => {
  const r = voxelRangeFor([8, 8, 8], identityAt(0, 0, 0), { center: [0, 0, 0], size: [10, 10, 10] })!;
  assertEquals(r.lo, [0, 0, 0]);
  assertEquals(voxelRangeFor([8, 8, 8], identityAt(0, 0, 0), { center: [900, 900, 900], size: [2, 2, 2] }), null);
});

// The red-slice cut: keep what is above the line.
Deno.test("cutBox keeps the side asked for and leaves the other axes alone", () => {
  const whole = { center: [0, 0, 0] as [number, number, number], size: [100, 200, 300] as [number, number, number] };
  const above = cutBox(whole, 2, -50, "above")!;
  assertEquals(above.size[2], 200);            // from -50 to +150
  assertEquals(above.center[2], 50);
  assertEquals(above.size[0], 100, "other axes untouched");
  assertEquals(above.size[1], 200, "other axes untouched");
  const below = cutBox(whole, 2, -50, "below")!;
  assertEquals(below.size[2], 100);            // from -150 to -50
});

Deno.test("cutBox reports a cut that would leave nothing", () => {
  const whole = { center: [0, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number] };
  assertEquals(cutBox(whole, 2, 999, "above"), null);
});

Deno.test("boundingBoxOf covers every corner of an oblique volume", () => {
  const c = Math.cos(0.3), s = Math.sin(0.3);
  const m = [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const b = boundingBoxOf([10, 10, 10], m);
  assert(b.size[0] > 9 && b.size[1] > 9, "a rotated volume's RAS box is wider than its grid");
  assertEquals(b.size[2], 9);
});

Deno.test("boxAroundData finds the object and pads it, and says so when there is none", () => {
  const d = new Int16Array(8 * 8 * 8);
  d[3 + 8 * (3 + 8 * 3)] = 1000;
  const b = boxAroundData(d as unknown as { length: number; [i: number]: number }, [8, 8, 8], identityAt(0, 0, 0), { padMm: 2 })!;
  assertEquals(b.center, [3, 3, 3]);
  assertEquals(b.size, [4, 4, 4]);
  assertEquals(boxAroundData(new Int16Array(8) as unknown as { length: number; [i: number]: number }, [2, 2, 2], identityAt(0, 0, 0)), null);
});

// THE BOX IN THE SLICE VIEWS. Ron: "When you look at slicers cropping tool, it lives in all viewers,
// 2D and 3D." Slicer draws the box's INTERSECTION with each slice (vtkSlicerROIRepresentation2D),
// not a projection of its wireframe — the intersection says where the cut falls on the slice you are
// looking at; a projection says the same thing on every slice, which is nothing.
Deno.test("a box cut by an axial plane through its middle is its rectangle", () => {
  const box = { center: [0, 0, 0] as [number, number, number], size: [10, 20, 30] as [number, number, number] };
  const poly = boxPlanePolygon(box, [0, 0, 0], [0, 0, 1])!;
  assertEquals(poly.length, 4);
  for (const p of poly) assertEquals(Math.abs(p[2]) < 1e-9, true, "every point lies in the plane");
  const xs = poly.map((p) => p[0]).sort((a, b) => a - b);
  const ys = poly.map((p) => p[1]).sort((a, b) => a - b);
  assertEquals([xs[0], xs[3]], [-5, 5]);
  assertEquals([ys[0], ys[3]], [-10, 10]);
});

Deno.test("the polygon is in order, so drawing it closed traces the outline once", () => {
  const box = { center: [0, 0, 0] as [number, number, number], size: [10, 20, 30] as [number, number, number] };
  const poly = boxPlanePolygon(box, [0, 0, 5], [0, 0, 1])!;
  // consecutive points share an edge of the rectangle: exactly one coordinate changes
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const changed = [0, 1].filter((k) => Math.abs(a[k] - b[k]) > 1e-9).length;
    assertEquals(changed, 1, `points ${i} and ${i + 1} are not adjacent corners`);
  }
});

Deno.test("a plane outside the box gives nothing to draw", () => {
  const box = { center: [0, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number] };
  assertEquals(boxPlanePolygon(box, [0, 0, 500], [0, 0, 1]), null);
});

// An oblique cut through a cuboid is a hexagon, not a rectangle — the general case has to work or
// the outline is wrong exactly when the slice is not anatomical.
Deno.test("an oblique plane gives the true section, not a rectangle", () => {
  const box = { center: [0, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number] };
  const poly = boxPlanePolygon(box, [0, 0, 0], [1, 1, 1])!;
  assertEquals(poly.length, 6);
  for (const p of poly) assert(Math.abs(p[0] + p[1] + p[2]) < 1e-9, "on the plane");
});

Deno.test("a plane through a corner does not produce a doubled-back outline", () => {
  const box = { center: [0, 0, 0] as [number, number, number], size: [10, 10, 10] as [number, number, number] };
  const poly = boxPlanePolygon(box, [5, 5, 5], [1, 1, 1]);
  if (poly) for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    assert(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-6, "duplicate points");
  }
});

// THE BUG RON FOUND. "The cropped volume is not cropped."
//
// This is the studyforrest T1's real affine: 0.667 mm in plane, 0.70 mm through, and oblique enough
// that an axis-aligned box is useless. The tightest RAS-ALIGNED box around a head-sized region maps
// back onto this tilted grid as the whole volume, so the crop kept 274x366x384 of 274x384x384 --
// eighteen voxels on one axis. A box on the VOLUME's axes has no such slack.
const FORREST = [
  -0.693, 0.045, 0.080, 72.916,
  0.032, 0.656, -0.115, -76.532,
  0.091, 0.111, 0.652, -186.828,
  0, 0, 0, 1,
];
const FORREST_DIMS: [number, number, number] = [274, 384, 384];

Deno.test("an oblique volume: a RAS-aligned box barely crops, a volume-aligned one does", () => {
  const whole = volumeAlignedBox(FORREST_DIMS, FORREST);
  // Half the size on every axis, centered: an unambiguous request to keep an eighth of the volume.
  const half: Box = { ...whole, size: [whole.size[0] / 2, whole.size[1] / 2, whole.size[2] / 2] };
  const aligned = voxelRangeFor(FORREST_DIMS, FORREST, half)!;
  const alignedVox = (aligned.hi[0] - aligned.lo[0] + 1) * (aligned.hi[1] - aligned.lo[1] + 1) * (aligned.hi[2] - aligned.lo[2] + 1);

  const rasBox: Box = { center: half.center, size: half.size };   // same box, no axes
  const ras = voxelRangeFor(FORREST_DIMS, FORREST, rasBox)!;
  const rasVox = (ras.hi[0] - ras.lo[0] + 1) * (ras.hi[1] - ras.lo[1] + 1) * (ras.hi[2] - ras.lo[2] + 1);

  const all = FORREST_DIMS[0] * FORREST_DIMS[1] * FORREST_DIMS[2];
  // Measured on this affine: volume-aligned keeps 12.9% (an eighth is 12.5%, so it is tight);
  // the same box without axes keeps 23.4% -- 1.8x as much, for the same request.
  assert(alignedVox < all * 0.15, `volume-aligned should keep about an eighth, kept ${alignedVox / all}`);
  assert(rasVox > alignedVox * 1.5, `the RAS-aligned box is looser on an oblique grid: ${rasVox / alignedVox}x`);
});

// The case that actually bit. A box the size of the tissue, out where the volume is, clamps to
// everything once it is RAS-aligned -- which is why the crop returned 274x366x384 of 274x384x384.
Deno.test("a tissue-sized RAS-aligned box degenerates to the whole volume; aligned does not", () => {
  const whole = volumeAlignedBox(FORREST_DIMS, FORREST);
  const most: Box = { ...whole, size: [whole.size[0], whole.size[1] * 0.8, whole.size[2] * 0.95] };
  const aligned = voxelRangeFor(FORREST_DIMS, FORREST, most)!;
  const ras = voxelRangeFor(FORREST_DIMS, FORREST, { center: most.center, size: most.size })!;
  const span = (r: typeof aligned, k: number) => r.hi[k] - r.lo[k] + 1;
  // Measured: aligned keeps [274, 308, 366]; the same box without axes keeps [274, 382, 384] --
  // 99.5% of every axis, which is what "the cropped volume is not cropped" looked like.
  assert(span(aligned, 1) < FORREST_DIMS[1] * 0.85, `the aligned box crops: ${span(aligned, 1)}`);
  assert(span(aligned, 2) < FORREST_DIMS[2] * 0.98, `the aligned box crops: ${span(aligned, 2)}`);
  assert(
    [0, 1, 2].every((k) => span(ras, k) >= FORREST_DIMS[k] * 0.99),
    `the RAS-aligned box keeps essentially everything — the defect Ron reported: ${[0, 1, 2].map((k) => span(ras, k))}`,
  );
});

Deno.test("volumeAlignedBox spans the volume and no more", () => {
  const b = volumeAlignedBox(FORREST_DIMS, FORREST);
  const r = voxelRangeFor(FORREST_DIMS, FORREST, b)!;
  assertEquals(r.lo, [0, 0, 0]);
  assertEquals(r.hi, [273, 383, 383]);
});

// Cutting at the axial line, on an oblique volume: it cuts along the volume axis nearest the slice
// normal, and says how far off that is rather than pretending it is exact.
Deno.test("cutBoxAtPlane cuts along the nearest box axis and reports the tilt", () => {
  const whole = volumeAlignedBox(FORREST_DIMS, FORREST);
  const cut = cutBoxAtPlane(whole, [0, 0, -20], [0, 0, 1], "above")!;
  assert(cut, "the plane crosses the volume");
  assert(cut.tiltDeg < 20, `the volume's axes are near-anatomical here, got ${cut.tiltDeg}`);
  assert(cut.box.size[cut.axis] < whole.size[cut.axis], "the box got shorter on that axis");
  const before = voxelRangeFor(FORREST_DIMS, FORREST, whole)!;
  const after = voxelRangeFor(FORREST_DIMS, FORREST, cut.box)!;
  const vox = (r: typeof before) => (r.hi[0] - r.lo[0] + 1) * (r.hi[1] - r.lo[1] + 1) * (r.hi[2] - r.lo[2] + 1);
  assert(vox(after) < vox(before) * 0.8, "cutting the neck removes a real fraction of the volume");
});

Deno.test("an axis-aligned box still behaves as before", () => {
  const b: Box = { center: [0, 0, 0], size: [10, 20, 30] };
  assertEquals(boxAxis(b, 0), [1, 0, 0]);
  assertEquals(boxCorners(b).length, 8);
  const r = voxelRangeFor([40, 40, 40], [1, 0, 0, -20, 0, 1, 0, -20, 0, 0, 1, -20, 0, 0, 0, 1], b)!;
  assertEquals([r.lo[0], r.hi[0]], [15, 25]);
});
