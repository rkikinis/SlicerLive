// Scissors' arithmetic (logic/scissors-cut.ts): the outline's fill, the slice and view projections, and the cut through
// the whole scan, cutting away or keeping only, never touching another structure.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cutByOutline, cutOutlinedPart, keepPiecesAt, removePieceAt, outlineOf, sliceProjection, viewProjection, type Vec3 } from "./scissors-cut.ts";

Deno.test("outline: inside a square, outside it, and the even-odd rule for a hole drawn around twice", () => {
  const o = outlineOf([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert(o.inside(5, 5)); assert(o.inside(0.2, 9.8)); assert(!o.inside(11, 5)); assert(!o.inside(-1, -1));
  const tri = outlineOf([[0, 0], [10, 0], [0, 10]]);
  assert(tri.inside(2, 2)); assert(!tri.inside(8, 8));
});

Deno.test("slice projection drops the normal: two points on one line along it land on the same spot", () => {
  const pr = sliceProjection([0, 0, 1]);
  assertEquals(pr([3, 4, 0]), pr([3, 4, 50]));
  const a = pr([0, 0, 0]), b = pr([1, 0, 0]);
  assert(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 1) < 1e-9, "lengths in the plane are kept");
});

Deno.test("view projection: the identity matrix maps x and y to the view's fractions, v downward", () => {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assertEquals(viewProjection(id)([0, 0, 0]), [0.5, 0.5]);
  assertEquals(viewProjection(id)([1, 1, 0]), [1, 0]);
  const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0];   // w = -z: points with z > 0 are behind
  assertEquals(viewProjection(behind)([0, 0, 1]), null);
});

// A 10 x 10 x 10 block of structure 1, a voxel of structure 2 inside it; 1 mm voxels, the identity grid.
function block(): { labels: Uint8Array; dims: Vec3; ijk: number[] } {
  const dims: Vec3 = [10, 10, 10], labels = new Uint8Array(1000).fill(1);
  labels[5 * 100 + 5 * 10 + 5] = 2;
  return { labels, dims, ijk: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
}

Deno.test("cut away: an outline on an axial slice goes through every slice; the other structure stays", () => {
  const { labels, dims, ijk } = block();
  const outline = outlineOf([[-0.5, -0.5], [4.5, -0.5], [4.5, 9.5], [-0.5, 9.5]]);   // x 0..4, all y
  const pr = sliceProjection([0, 0, 1]);
  // the slice's own plane coordinates: map the outline drawn in RAS (x, y) through the same projection
  const toPlane = (x: number, y: number) => pr([x, y, 0]);
  const drawn = outlineOf([[-0.5, -0.5], [4.5, -0.5], [4.5, 9.5], [-0.5, 9.5]].map(([x, y]) => toPlane(x, y)));
  const r = cutByOutline(labels, dims, ijk, 1, pr, drawn, false);
  assertEquals(r.cleared, 500);                                   // x 0..4 of every slice
  assertEquals(r.labels[5 * 100 + 5 * 10 + 5], 2, "structure 2 is not touched");
  assertEquals(r.labels[0], 0); assertEquals(r.labels[9], 1);
  assert(outline.inside(2, 2));
});

Deno.test("keep only: everything of the structure outside the outline is cleared", () => {
  const { labels, dims, ijk } = block();
  const pr = sliceProjection([0, 0, 1]);
  const drawn = outlineOf([[-0.5, -0.5], [4.5, -0.5], [4.5, 9.5], [-0.5, 9.5]].map(([x, y]) => pr([x, y, 0])));
  const r = cutByOutline(labels, dims, ijk, 1, pr, drawn, true);
  assertEquals(r.cleared, 499);                                   // x 5..9 of every slice, less structure 2's voxel
  assertEquals(r.labels[0], 1); assertEquals(r.labels[9], 0);
});

Deno.test("click: keeps the piece under it and drops the other pieces of the structure; two clicks keep two", () => {
  // three blocks of structure 1 (x 0..2, 4..6, 8..10) and a voxel of structure 2 between two of them
  const dims: Vec3 = [11, 4, 4], at = (i: number, j: number, k: number) => (k * 4 + j) * 11 + i;
  const labels = new Uint8Array(176);
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 11; i++) if (i !== 3 && i !== 7) labels[at(i, j, k)] = 1;
  labels[at(3, 0, 0)] = 2;
  const one = keepPiecesAt(labels, dims, 1, [[1, 1, 1]])!;
  assertEquals([one.kept, one.cleared], [48, 96]);
  assertEquals(one.labels[at(5, 1, 1)], 0); assertEquals(one.labels[at(1, 1, 1)], 1); assertEquals(one.labels[at(3, 0, 0)], 2, "another structure stays");
  const two = keepPiecesAt(labels, dims, 1, [[1, 1, 1], [9, 2, 2]])!;
  assertEquals([two.kept, two.cleared], [96, 48]); assertEquals(two.labels[at(5, 1, 1)], 0); assertEquals(two.labels[at(9, 1, 1)], 1);
  // a click just outside a block (x 3.4 rounds to 3, one voxel from x 2) still finds it; nothing near finds nothing
  assertEquals(keepPiecesAt(labels, dims, 1, [[3.4, 1, 1]])!.kept, 48);
  assertEquals(keepPiecesAt(new Uint8Array(176), dims, 1, [[1, 1, 1]]), null);
});

Deno.test("slice: what is outlined goes, up to the first gap; the part beyond the gap stays (C1 under the skull)", () => {
  // a column of structure 1 at x 2..4, y 2..4: z 0..3 ("C1"), a gap at z 4, z 5..9 ("skull"); 1 mm voxels
  const dims: Vec3 = [8, 8, 10], at = (i: number, j: number, k: number) => (k * 8 + j) * 8 + i;
  const labels = new Uint8Array(640);
  for (let k = 0; k < 10; k++) if (k !== 4) for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) labels[at(i, j, k)] = 1;
  const ijk = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const pr = sliceProjection([0, 0, 1]);
  const outline = outlineOf([[1.5, 1.5], [4.5, 1.5], [4.5, 4.5], [1.5, 4.5]].map(([x, y]) => pr([x, y, 2])));
  const r = cutOutlinedPart(labels, dims, ijk, 1, pr, outline, { point: [3, 3, 2], normal: [0, 0, 1] }, false);
  assertEquals(r.cleared, 36, "z 0..3 of the column: 4 slices of 9");
  assertEquals(r.labels[at(3, 3, 7)], 1, "beyond the gap it stays");
  assertEquals(r.labels[at(3, 3, 0)], 0);
  // the whole column through the scan, as the 3D view's cut does, would have taken both parts
  assertEquals(cutByOutline(labels, dims, ijk, 1, pr, outline, false).cleared, 81);
  // keep only: that part stays, the rest goes
  const k = cutOutlinedPart(labels, dims, ijk, 1, pr, outline, { point: [3, 3, 2], normal: [0, 0, 1] }, true);
  assertEquals(k.cleared, 45); assertEquals(k.labels[at(3, 3, 2)], 1);
});

Deno.test("option-click: removes the piece under it, the rest stays", () => {
  const dims: Vec3 = [11, 4, 4], at = (i: number, j: number, k: number) => (k * 4 + j) * 11 + i;
  const labels = new Uint8Array(176);
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 11; i++) if (i !== 3 && i !== 7) labels[at(i, j, k)] = 1;
  const r = removePieceAt(labels, dims, 1, [5, 1, 1])!;
  assertEquals(r.cleared, 48);
  assertEquals(r.labels[at(5, 1, 1)], 0); assertEquals(r.labels[at(1, 1, 1)], 1); assertEquals(r.labels[at(9, 1, 1)], 1);
  assertEquals(removePieceAt(new Uint8Array(176), dims, 1, [5, 1, 1]), null);
});

