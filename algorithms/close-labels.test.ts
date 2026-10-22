// Caps where the scan cuts a structure off (algorithms/close-labels.ts v2): after padding, a structure touching the
// edge of the scan has a closed surface; no voxel changes; every structure stays where it was in millimeters.
//
//   deno test -A --no-check algorithms/close-labels.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { surfaceNets } from "./surface-nets.ts";
import { padLabels, paddedGrid } from "./close-labels.ts";

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const N = 20;
function grid(fill: (i: number, j: number, k: number) => number) {
  const lab = new Uint8Array(N * N * N);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) lab[(k * N + j) * N + i] = fill(i, j, k);
  return lab;
}
const openEdges = (idx: Uint32Array, nv: number) => {
  const m = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) for (let c = 0; c < 3; c++) { const a = idx[t + c], b = idx[t + (c + 1) % 3]; const k = a < b ? a * nv + b : b * nv + a; m.set(k, (m.get(k) ?? 0) + 1); }
  let open = 0; for (const v of m.values()) if (v === 1) open++;
  return open;
};

for (const [name, fill] of [
  ["cut off by one side of the scan", (i: number, j: number, k: number) => i < 10 && j > 3 && j < 15 && k > 3 && k < 15 ? 1 : 0],
  ["a whole slab, cut by four sides", (_i: number, _j: number, k: number) => k < 6 ? 1 : 0],
  ["filling the whole scan", () => 1],
] as const) {
  Deno.test(`capped: ${name}`, () => {
    const lab = grid(fill);
    const before = surfaceNets(lab, [N, N, N], ID);
    assert(!before.length || before.some((m) => openEdges(m.indices, m.positions.length / 3) > 0), "open (or no surface at all) before padding");
    const p = padLabels(lab, [N, N, N], ID);
    const after = surfaceNets(p.lab, p.dims, p.ijkToRAS);
    assert(after.length > 0, "a surface after padding");
    for (const m of after) assertEquals(openEdges(m.indices, m.positions.length / 3), 0, `label ${m.label}`);
  });
}

Deno.test("padding changes no voxel and moves nothing", () => {
  const lab = grid((i, j, k) => (i * 7 + j * 3 + k) % 5);
  const m = [0.7, 0, 0, -10, 0, -0.7, 0, 5, 0, 0, 2.5, -40, 0, 0, 0, 1];
  const p = padLabels(lab, [N, N, N], m);
  assertEquals(p.dims, [N + 2, N + 2, N + 2]);
  assertEquals(paddedGrid([N, N, N], m), { dims: p.dims, ijkToRAS: p.ijkToRAS });
  const at = (M: number[], i: number, j: number, k: number) => [0, 1, 2].map((r) => +(M[4 * r] * i + M[4 * r + 1] * j + M[4 * r + 2] * k + M[4 * r + 3]).toFixed(6));
  assertEquals(at(p.ijkToRAS, 4, 5, 6), at(m, 3, 4, 5));
  let border = 0;
  for (let k = 0; k < N + 2; k++) for (let j = 0; j < N + 2; j++) for (let i = 0; i < N + 2; i++) {
    const v = p.lab[(k * (N + 2) + j) * (N + 2) + i];
    if (i === 0 || j === 0 || k === 0 || i === N + 1 || j === N + 1 || k === N + 1) border += v;
    else assert(v === lab[((k - 1) * N + j - 1) * N + i - 1]);
  }
  assertEquals(border, 0, "the frame is background");
});
