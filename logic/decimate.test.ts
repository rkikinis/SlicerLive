// The drawing copy: fewer triangles, the same vertices, the same normals, within the limit.
import { assert, assertEquals } from "jsr:@std/assert";
import { decimateForDrawing, decimatorReady, DRAW_ERROR_VOXELS, smallestVoxelEdge } from "./decimate.ts";
import { surfaceNets } from "../algorithms/surface-nets.ts";

Deno.test("the drawing copy is an index list into the same vertices, much shorter, within the limit", async () => {
  await decimatorReady();
  // A sphere of radius 12 voxels on a 32^3 grid: surface nets at voxel scale, then the copy.
  const D = 32, dims: [number, number, number] = [D, D, D];
  const lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
    if ((i - 16) ** 2 + (j - 16) ** 2 + (k - 16) ** 2 < 144) lab[(k * D + j) * D + i] = 1;
  }
  const ijkToRAS = [0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1];
  const [mesh] = surfaceNets(lab, dims, ijkToRAS);
  const voxel = smallestVoxelEdge(ijkToRAS);
  assertEquals(voxel, 0.7);
  const { drawIndices, error } = decimateForDrawing(mesh.positions, mesh.normals, mesh.indices, DRAW_ERROR_VOXELS * voxel, voxel);
  assert(drawIndices.length < mesh.indices.length * 0.5, `far fewer triangles: ${drawIndices.length / 3} of ${mesh.indices.length / 3}`);
  assert(drawIndices.length % 3 === 0);
  const nv = mesh.positions.length / 3;
  for (const v of drawIndices) assert(v < nv, "every index points at an original vertex");
  assert(error <= DRAW_ERROR_VOXELS * voxel + 1e-6, `the simplifier's error ${error} is within the limit`);
  // The positions and normals are untouched objects: the drawing copy shares them.
  assert(mesh.positions.length === nv * 3 && mesh.normals.length === nv * 3);
});

Deno.test("a tiny mesh is drawn as it is", async () => {
  await decimatorReady();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
  const r = decimateForDrawing(pos, new Float32Array(12), idx, 0.2, 1);
  assertEquals(r.drawIndices, idx);
});

// THE WORKER, END TO END: the same protocol the scene uses (copies in, index lists out).
Deno.test("the decimation worker answers with a drawing copy per structure and its build", async () => {
  const D = 24, dims: [number, number, number] = [D, D, D];
  const lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
    const r2 = (i - 12) ** 2 + (j - 12) ** 2 + (k - 12) ** 2;
    if (r2 < 64) lab[(k * D + j) * D + i] = 1; else if (r2 < 100) lab[(k * D + j) * D + i] = 2;
  }
  const meshes = surfaceNets(lab, dims, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const worker = new Worker(new URL("../algorithms/decimate-worker.ts", import.meta.url), { type: "module" });
  const reply = await new Promise<{ results: { label: number; drawIndices: ArrayBuffer; error: number }[]; ms: number; build: string }>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
    const payload = meshes.map((m) => ({ label: m.label, positions: m.positions.slice().buffer as ArrayBuffer, normals: m.normals.slice().buffer as ArrayBuffer, indices: m.indices.slice().buffer as ArrayBuffer }));
    worker.postMessage({ id: 1, errorLimit: DRAW_ERROR_VOXELS * 1, voxel: 1, meshes: payload }, payload.flatMap((p) => [p.positions, p.normals, p.indices]));
  });
  worker.terminate();
  assertEquals(reply.results.map((r) => r.label).sort(), meshes.map((m) => m.label).sort());
  for (const r of reply.results) {
    const m = meshes.find((x) => x.label === r.label)!;
    const d = new Uint32Array(r.drawIndices);
    assert(d.length > 0 && d.length <= m.indices.length && d.length % 3 === 0);
    for (const v of d) assert(v < m.positions.length / 3);
  }
  assert(typeof reply.build === "string");
});

// THIN THINGS SURVIVE (critic, 2026-09-18, finding 2): a one-voxel rod, a tapering vessel's
// one-voxel tail, and a cloud of single-voxel specks all vanished at "0.045 error"; now they are
// held in place. Measured on the whole structure, not on the simplifier's word.
function extentAlong(positions: Float32Array, indices: Uint32Array, axis: number): number {
  let lo = Infinity, hi = -Infinity;
  for (const v of indices) { const x = positions[v * 3 + axis]; if (x < lo) lo = x; if (x > hi) hi = x; }
  return indices.length ? hi - lo : 0;
}
Deno.test("a one-voxel rod, a tapering tail and specks are kept in the drawing copy", async () => {
  await decimatorReady();
  const D = 40, dims: [number, number, number] = [D, D, D];
  const at = (i: number, j: number, k: number) => (k * D + j) * D + i;
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // 1. a 1x1 rod, 32 voxels long
  let lab = new Uint8Array(D * D * D);
  for (let i = 4; i < 36; i++) lab[at(i, 20, 20)] = 1;
  let [m] = surfaceNets(lab, dims, id);
  let r = decimateForDrawing(m.positions, m.normals, m.indices, DRAW_ERROR_VOXELS, 1);
  assert(r.drawIndices.length > 0, "the rod is drawn at all");
  assert(extentAlong(m.positions, r.drawIndices, 0) > extentAlong(m.positions, m.indices, 0) - 1, "the rod keeps its length");
  // 2. a tapering vessel: 3 wide, then 2, then 1, twelve voxels each
  lab = new Uint8Array(D * D * D);
  for (let i = 2; i < 38; i++) { const w = i < 14 ? 3 : i < 26 ? 2 : 1; for (let j = 20; j < 20 + w; j++) for (let k = 20; k < 20 + w; k++) lab[at(i, j, k)] = 1; }
  [m] = surfaceNets(lab, dims, id);
  r = decimateForDrawing(m.positions, m.normals, m.indices, DRAW_ERROR_VOXELS, 1);
  assert(extentAlong(m.positions, r.drawIndices, 0) > extentAlong(m.positions, m.indices, 0) - 1, `the one-voxel tail is kept: ${extentAlong(m.positions, r.drawIndices, 0)} of ${extentAlong(m.positions, m.indices, 0)}`);
  // 3. sixty single-voxel specks in one label
  lab = new Uint8Array(D * D * D);
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 60; n++) lab[at(2 + (rnd() * 36) | 0, 2 + (rnd() * 36) | 0, 2 + (rnd() * 36) | 0)] = 1;
  [m] = surfaceNets(lab, dims, id);
  r = decimateForDrawing(m.positions, m.normals, m.indices, DRAW_ERROR_VOXELS, 1);
  assertEquals(r.drawIndices.length, m.indices.length, "specks are drawn as they are");
  // And a big smooth thing still decimates hard.
  lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) if ((i - 20) ** 2 + (j - 20) ** 2 + (k - 20) ** 2 < 225) lab[at(i, j, k)] = 1;
  [m] = surfaceNets(lab, dims, id);
  r = decimateForDrawing(m.positions, m.normals, m.indices, DRAW_ERROR_VOXELS, 1);
  assert(r.drawIndices.length < m.indices.length * 0.4, `a sphere still loses most of its triangles: ${r.drawIndices.length / 3} of ${m.indices.length / 3}`);
});
