import { assert, assertEquals } from "jsr:@std/assert@1";
import { drawPlaneOf, fillPolygon, insidePolygon, planeChange } from "./fill-polygon.ts";
import { invertRowMajor } from "./transforms.ts";

const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

Deno.test("insidePolygon: a square and a concave L", () => {
  const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assertEquals(insidePolygon(5, 5, sq), true);
  assertEquals(insidePolygon(11, 5, sq), false);
  const L: [number, number][] = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]];
  assertEquals(insidePolygon(1, 8, L), true);
  assertEquals(insidePolygon(8, 8, L), false);   // in the notch
});

Deno.test("fillPolygon: a square drawn on a coronal slice fills one voxel layer inside it", () => {
  const dims: [number, number, number] = [20, 20, 20];
  const lab = new Uint8Array(20 * 20 * 20);
  // Coronal: the plane y = 7 (normal along A), a 6 x 4 rectangle from x 2..8, z 3..7, voxel centers on integers.
  const pts: [number, number, number][] = [[1.5, 7, 2.5], [7.5, 7, 2.5], [7.5, 7, 6.5], [1.5, 7, 6.5]];
  const n = fillPolygon(lab, dims, ident, invertRowMajor(ident), pts, [0, 1, 0], 3);
  assertEquals(n, 6 * 4);
  let onPlane = 0, off = 0;
  for (let k = 0; k < 20; k++) for (let j = 0; j < 20; j++) for (let i = 0; i < 20; i++) {
    if (lab[k * 400 + j * 20 + i] !== 3) continue;
    if (j === 7 && i >= 2 && i <= 7 && k >= 3 && k <= 6) onPlane++; else off++;
  }
  assertEquals([onPlane, off], [24, 0]);
});

Deno.test("fillPolygon: anisotropic voxels -- the layer is one voxel of the grid, not one millimeter", () => {
  // 1 x 1 x 3 mm voxels, axial slice at z = 6 mm (k = 2): exactly one k layer.
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1];
  const lab = new Uint8Array(10 * 10 * 5);
  const pts: [number, number, number][] = [[0.5, 0.5, 6], [4.5, 0.5, 6], [4.5, 4.5, 6], [0.5, 4.5, 6]];
  const n = fillPolygon(lab, [10, 10, 5], m, invertRowMajor(m), pts, [0, 0, 1], 1);
  assertEquals(n, 16);
  for (let i = 0; i < lab.length; i++) if (lab[i]) assertEquals(Math.floor(i / 100), 2);
});

Deno.test("fillPolygon: fewer than three points fills nothing", () => {
  const lab = new Uint8Array(1000);
  assertEquals(fillPolygon(lab, [10, 10, 10], ident, invertRowMajor(ident), [[1, 1, 1], [5, 5, 1]], [0, 0, 1], 1), 0);
});

Deno.test("planeChange: an outline belongs to one slice -- a slice step or a new orientation is a change, a pan is not", () => {
  const ax10 = drawPlaneOf({ orient: "axial", posMm: 10 });
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "axial", posMm: 10 }), 0.01), null);
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "axial", posMm: 10.000001 }), 0.01), null);   // a round trip, not a move
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "axial", posMm: 11 }), 0.01), "moved");         // one wheel step
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "coronal", posMm: 10 }), 0.01), "turned");
  // A reformat: the same plane as the axial preset seen from below is the same plane; tilted by a degree it is not.
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "axial", posMm: -10, basis: { nDir: [0, 0, -1] } }), 0.01), null);
  const t = Math.PI / 180;
  assertEquals(planeChange(ax10, drawPlaneOf({ orient: "axial", posMm: 10, basis: { nDir: [0, Math.sin(t), Math.cos(t)] } }), 0.01), "turned");
  // At a microscope's scale the tolerance is the caller's (a hundredth of a voxel): a 1 um step on a 1 um grid moves.
  const um = drawPlaneOf({ orient: "axial", posMm: 0.005 });
  assertEquals(planeChange(um, drawPlaneOf({ orient: "axial", posMm: 0.006 }), 0.00001), "moved");
});

Deno.test("fillPolygon: a plane exactly between two voxel layers fills one of them, the same on any grid (critic 2026-10-20, section 11)", () => {
  // The plane j + k = c + 0.5 (45 degrees to the grid), between the layers j + k = c and c + 1. It filled scattered
  // voxels of both, or of neither, as rounding fell; it fills the layer behind the plane, whole, once per column.
  const N = 40, s = 1 / Math.SQRT2;
  const grids: number[][] = [ident, [0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1], [0.7, 0, 0, -120.3, 0, 0.7, 0, -88.1, 0, 0, 0.7, 13.7, 0, 0, 0, 1]];
  for (const m of grids) for (const c of [20, 25, 31]) {
    const at = (i: number, j: number, k: number): [number, number, number] => [m[0] * i + m[3], m[5] * j + m[7], m[10] * k + m[11]];
    const t = c + 0.5;
    const pts = [at(2, t - 2, 2), at(30, t - 2, 2), at(30, 2, t - 2), at(2, 2, t - 2)];
    const lab = new Uint8Array(N ** 3);
    const n = fillPolygon(lab, [N, N, N], m, invertRowMajor(m), pts, [0, s, s], 1);
    const layers = new Set<number>();
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (lab[k * N * N + j * N + i]) layers.add(j + k);
    assertEquals([...layers], [c], `grid ${m[0]} at ${m[3]}, plane j + k = ${t}`);
    assert(n > 400, `${n} voxels`);
  }
});
