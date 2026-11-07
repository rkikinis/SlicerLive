// Grow from seeds (logic/grow-from-seeds.ts) on the graphics card: a bright "tumor" off center in a larger noisy
// volume, a stroke inside it and a few around it; the tumor must come back, and nothing outside the box may change.
//
//   deno test -A --no-check logic/grow-from-seeds.gpu.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { initDevice } from "../render/device.ts";
import { growDevice, growFromSeeds, growInPlace, seedBox } from "./grow-from-seeds.ts";
import { growByPath } from "../algorithms/effects/grow-by-path.ts";
import type { Vec3 } from "../algorithms/geom.ts";

Deno.test("the box is the strokes' extent plus a margin, inside the grid", () => {
  const dims: Vec3 = [40, 30, 20];
  const s = new Uint8Array(40 * 30 * 20);
  s[(10 * 30 + 10) * 40 + 10] = 1; s[(12 * 30 + 20) * 40 + 30] = 2;
  const b = seedBox(s, dims, 6);
  assertEquals(b.lo, [3, 4, 4]);     // x: a third of the 21-voxel extent (7) beats the minimum (6)
  assertEquals(b.hi, [38, 27, 19]);   // z: 12 + 1 + 6 = 19, inside the 20-slice grid
  assertEquals([...b.labels].sort(), [1, 2]);
});

const gpu = await initDevice().catch(() => null);

Deno.test({ name: "a tumor grows back from a stroke inside and strokes around it; outside the box stays empty", ignore: !gpu, fn: async () => {
  const dims: Vec3 = [160, 140, 120], [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  const img = new Float32Array(N), truth = new Uint8Array(N), seeds = new Uint8Array(N);
  let rng = 7;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const c = [100, 60, 70], r = 18;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = (z * ny + y) * nx + x;
    const inside = (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r * r;
    truth[i] = inside ? 1 : 0;
    img[i] = (inside ? 800 : 300) + (rand() - 0.5) * 80;
  }
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  for (let d = -6; d <= 6; d++) seeds[at(c[0] + d, c[1], c[2])] = 1;                 // a stroke through the middle
  for (let d = -10; d <= 10; d++) {                                                   // a ring of strokes around it
    seeds[at(c[0] + d, c[1] - 28, c[2])] = 2; seeds[at(c[0] + d, c[1] + 28, c[2])] = 2;
    seeds[at(c[0] - 28, c[1] + d, c[2])] = 2; seeds[at(c[0] + 28, c[1] + d, c[2])] = 2;
    seeds[at(c[0], c[1] + d, c[2] - 28)] = 2; seeds[at(c[0], c[1] + d, c[2] + 28)] = 2;
  }
  const r1 = await growFromSeeds(gpu!.device, seeds, img, dims);
  let inter = 0, a = 0, b = 0, outside = 0;
  for (let i = 0; i < N; i++) {
    const g = r1.labels[i] === 1 ? 1 : 0;
    inter += g & truth[i]; a += g; b += truth[i];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    const inBox = x >= r1.box.lo[0] && x < r1.box.hi[0] && y >= r1.box.lo[1] && y < r1.box.hi[1] && z >= r1.box.lo[2] && z < r1.box.hi[2];
    if (!inBox && r1.labels[i]) outside++;
  }
  const dice = 2 * inter / (a + b);
  console.log(`grow from seeds: box ${r1.box.hi.map((h, k) => h - r1.box.lo[k]).join("x")} of ${dims.join("x")}, ${r1.iterations} iterations, ${r1.ms} ms, Dice ${dice.toFixed(4)}`);
  assert(dice > 0.97, `Dice ${dice}`);
  assertEquals(outside, 0);
}});

Deno.test({ name: "one kind of stroke is not enough, and says so", ignore: !gpu, fn: async () => {
  const dims: Vec3 = [8, 8, 8];
  const s = new Uint8Array(512); s[100] = 1;
  await assertRejects(() => growFromSeeds(gpu!.device, s, new Float32Array(512), dims), Error, "two places");
  await assertRejects(() => growFromSeeds(gpu!.device, new Uint8Array(512), new Float32Array(512), dims), Error, "strokes first");
}});

Deno.test({ name: "in place: a hidden, finished segment is neither a stroke nor overwritten, and the box stays around the strokes (critic, finding 7)", ignore: !gpu, fn: async () => {
  const dims: Vec3 = [120, 100, 90], [nx, ny, nz] = dims, N = nx * ny * nz;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const img = new Float32Array(N), lab = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = at(x, y, z);
    img[i] = (x - 80) ** 2 + (y - 60) ** 2 + (z - 50) ** 2 <= 144 ? 800 : 300;
    if ((x - 15) ** 2 + (y - 15) ** 2 + (z - 15) ** 2 <= 64) lab[i] = 3;                // a finished structure, far away
  }
  for (let d = -4; d <= 4; d++) lab[at(80 + d, 60, 50)] = 1;
  for (let d = -6; d <= 6; d++) { lab[at(80 + d, 60 - 20, 50)] = 2; lab[at(80 + d, 60 + 20, 50)] = 2; lab[at(80 - 20, 60 + d, 50)] = 2; lab[at(80 + 20, 60 + d, 50)] = 2; }
  const before3 = lab.reduce((n, v) => n + (v === 3 ? 1 : 0), 0);
  const r = await growInPlace(gpu!.device, lab, img, dims, new Set([3]));
  assertEquals(r.out.reduce((n, v) => n + (v === 3 ? 1 : 0), 0), before3, "the hidden segment is unchanged");
  assert(r.box.lo[0] > 30 && r.box.lo[1] > 20, `the box stays near the strokes: ${JSON.stringify(r.box)}`);
  let outside = 0;
  for (let i = 0; i < N; i++) { const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    const inBox = x >= r.box.lo[0] && x < r.box.hi[0] && y >= r.box.lo[1] && y < r.box.hi[1] && z >= r.box.lo[2] && z < r.box.hi[2];
    if (!inBox && r.out[i] !== lab[i]) outside++; }
  assertEquals(outside, 0);
  let tumor = 0; for (let i = 0; i < N; i++) if (r.out[i] === 1) tumor++;
  assert(tumor > 5000, `the bright sphere grew (${tumor} voxels)`);
}});

Deno.test({ name: "the rejection class (Outside): it competes, what it wins is left empty, its strokes stay (Ron, 2026-11-01)", ignore: !gpu, fn: async () => {
  const dims: Vec3 = [100, 100, 80], [nx, ny, nz] = dims, N = nx * ny * nz;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const img = new Float32Array(N), lab = new Uint8Array(N), truth = new Uint8Array(N);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const inside = (x - 50) ** 2 + (y - 50) ** 2 + (z - 40) ** 2 <= 144;
    truth[at(x, y, z)] = inside ? 1 : 0; img[at(x, y, z)] = inside ? 800 : 300;
  }
  for (let d = -4; d <= 4; d++) lab[at(50 + d, 50, 40)] = 1;                                     // inside: segment 1
  for (let d = -6; d <= 6; d++) { lab[at(50 + d, 30, 40)] = 7; lab[at(50 + d, 70, 40)] = 7; lab[at(30, 50 + d, 40)] = 7; lab[at(70, 50 + d, 40)] = 7; }   // Outside: 7
  const strokes7 = lab.reduce((n, v) => n + (v === 7 ? 1 : 0), 0);
  const r = await growInPlace(gpu!.device, lab, img, dims, new Set(), new Set([7]));
  let left7 = 0, inter = 0, a = 0, b = 0;
  for (let i = 0; i < N; i++) { if (r.out[i] === 7) left7++; const g = r.out[i] === 1 ? 1 : 0; inter += g & truth[i]; a += g; b += truth[i]; }
  assertEquals(left7, strokes7, "Outside keeps its strokes and nothing more");
  assert(2 * inter / (a + b) > 0.95, `the structure grew: Dice ${(2 * inter / (a + b)).toFixed(3)}`);
  const lo = r.box.lo, hi = r.box.hi; let empty = 0, inBox = 0;
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) { inBox++; if (!r.out[at(x, y, z)]) empty++; }
  assert(empty > inBox / 2, `the box around the structure is empty, not a second segment: ${empty} of ${inBox}`);
}});

/** Two bright spheres A and B (radius 12) on a noisy dark field; strokes inside a sphere and a ring of Outside around it. */
function twoSpheres() {
  const dims: Vec3 = [140, 100, 80], [nx, ny, nz] = dims, N = nx * ny * nz;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const img = new Float32Array(N), inA = new Uint8Array(N);
  let rng = 3; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const A = [35, 50, 40], B = [105, 50, 40];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = (x - A[0]) ** 2 + (y - A[1]) ** 2 + (z - A[2]) ** 2 <= 144, b = (x - B[0]) ** 2 + (y - B[1]) ** 2 + (z - B[2]) ** 2 <= 144;
    inA[at(x, y, z)] = a ? 1 : 0; img[at(x, y, z)] = (a || b ? 800 : 300) + (rand() - 0.5) * 60;
  }
  const strokes = (lab: Uint8Array, c: number[], inside: number, outside: number) => {
    for (let d = -4; d <= 4; d++) lab[at(c[0] + d, c[1], c[2])] = inside;
    for (let d = -6; d <= 6; d++) { lab[at(c[0] + d, c[1] - 20, c[2])] = outside; lab[at(c[0] + d, c[1] + 20, c[2])] = outside; lab[at(c[0] - 20, c[1] + d, c[2])] = outside; lab[at(c[0] + 20, c[1] + d, c[2])] = outside; lab[at(c[0], c[1] + d, c[2] - 20)] = outside; lab[at(c[0], c[1] + d, c[2] + 20)] = outside; }
  };
  return { dims, N, img, inA, A, B, strokes };
}

Deno.test({ name: "a second round grows only the structure on the button; the first stays exactly as it was (critic 2026-11-01, finding 1)", ignore: !gpu, fn: async () => {
  const { dims, N, img, A, B, strokes } = twoSpheres();
  const lab = new Uint8Array(N);
  strokes(lab, A, 1, 9);
  const r1 = await growInPlace(gpu!.device, lab, img, dims, new Set(), new Set([9]), 1);
  const a1 = r1.out.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
  strokes(r1.out, B, 2, 9);
  const outside2 = r1.out.reduce((n, v) => n + (v === 9 ? 1 : 0), 0);
  const r2 = await growInPlace(gpu!.device, r1.out, img, dims, new Set(), new Set([9]), 2);
  const a2 = r2.out.reduce((n, v) => n + (v === 1 ? 1 : 0), 0), b2 = r2.out.reduce((n, v) => n + (v === 2 ? 1 : 0), 0);
  console.log(`round 1: A ${a1} voxels; round 2: A ${a2}, B ${b2}`);
  assertEquals(a2, a1, "A is not touched by B's round");
  assert(b2 > 0.8 * 7153 && b2 < 2 * 7153, `B grew to about its sphere: ${b2}`);
  assertEquals(r2.out.reduce((n, v) => n + (v === 9 ? 1 : 0), 0), outside2, "Outside is its strokes, both rounds' ");
}});

Deno.test({ name: "Outside hidden at the grow still takes part and keeps its strokes; a structure far away does not widen the box", ignore: !gpu, fn: async () => {
  const { dims, N, img, A, B, strokes } = twoSpheres();
  const lab = new Uint8Array(N);
  lab[(10 * 100 + 5) * 140 + 5] = 3;                                                          // a loaded structure in a far corner
  strokes(lab, B, 2, 9);
  const strokes9 = lab.reduce((n, v) => n + (v === 9 ? 1 : 0), 0);
  const r = await growInPlace(gpu!.device, lab, img, dims, new Set([9]), new Set([9]), 2);
  assertEquals(r.out.reduce((n, v) => n + (v === 9 ? 1 : 0), 0), strokes9, "hidden Outside's strokes stay, nothing more");
  assert(r.box.lo[0] > A[0], `the box is around B's strokes, not the far structure: ${JSON.stringify(r.box)}`);
  assertEquals(r.out[(10 * 100 + 5) * 140 + 5], 3, "the far structure is unchanged");
}});

Deno.test({ name: "the app's grow device has the adapter's size limits, not WebGPU's 128 MiB default (critic 2026-11-01, finding 4)", ignore: !gpu, fn: async () => {
  const d = await growDevice();
  const a = await (navigator as unknown as { gpu: GPU }).gpu.requestAdapter({ powerPreference: "high-performance" });
  assertEquals(d.limits.maxStorageBufferBindingSize, a!.limits.maxStorageBufferBindingSize);
  assert(d.limits.maxStorageBufferBindingSize > 128 * 1024 * 1024 || a!.limits.maxStorageBufferBindingSize <= 128 * 1024 * 1024);
}});

/**
 * A dark ball (40) in brighter tissue (150) whose wall is spread over three voxels, as the lateral ventricles on the Prisma
 * T1 (steps across the wall: median 47), and one bright voxel (1300) that sets the box's range, as a vessel does there.
 * Strokes as Ron drew them: a small blob inside, a ring of Outside on two planes only.
 */
function softBall() {
  const dims: Vec3 = [90, 80, 70], [nx, ny, nz] = dims, N = nx * ny * nz, c = [45, 40, 35], R = 16;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const img = new Float32Array(N), truth = new Uint8Array(N), lab = new Uint8Array(N);
  let rng = 11; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const r = Math.hypot(x - c[0], y - c[1], z - c[2]), t = Math.min(1, Math.max(0, (r - (R - 1.5)) / 3));
    img[at(x, y, z)] = 40 + 110 * t + (rand() - 0.5) * 16; truth[at(x, y, z)] = r <= R ? 1 : 0;
  }
  img[at(10, 10, 10)] = 1300;
  for (let z = -2; z <= 2; z++) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) lab[at(c[0] + x, c[1] + y, c[2] + z)] = 1;
  for (let k = 0; k < 360; k += 2) { const a = k * Math.PI / 180, rr = R + 7;
    lab[at(Math.round(c[0] + rr * Math.cos(a)), Math.round(c[1] + rr * Math.sin(a)), c[2])] = 9;
    lab[at(c[0], Math.round(c[1] + rr * Math.cos(a)), Math.round(c[2] + rr * Math.sin(a)))] = 9; }
  const dice = (out: Uint8Array) => { let i2 = 0, a = 0, b = 0; for (let i = 0; i < N; i++) { const g = out[i] === 1 ? 1 : 0; i2 += g & truth[i]; a += g; b += truth[i]; } return 2 * i2 / (a + b); };
  return { dims, N, img, lab, truth, dice, at, c, R };
}

Deno.test({ name: "a soft wall: the cheapest path fills the ball, GrowCut's threshold does not see the wall (Prisma ventricles, 2026-11-01)", ignore: !gpu, fn: async () => {
  const { dims, img, lab, dice } = softBall();
  const v1 = await growFromSeeds(gpu!.device, lab, img, dims, { rule: 1 }), v2 = await growFromSeeds(gpu!.device, lab, img, dims, { rule: 2 });
  const d1 = dice(v1.labels), d2 = dice(v2.labels);
  console.log(`soft wall: GrowCut Dice ${d1.toFixed(3)} (${v1.ms} ms), cheapest path Dice ${d2.toFixed(3)} (${v2.iterations} passes, ${v2.ms} ms)`);
  assert(d2 > 0.9, `cheapest path Dice ${d2}`);
  assert(d1 < d2, `GrowCut ${d1} against ${d2}`);
}});

Deno.test({ name: "with the strokes known, a press grows from them and not from the last result: no box (Ron's second ventricle trial)", ignore: !gpu, fn: async () => {
  const { dims, img, lab, dice, at, c } = softBall();
  const r1 = await growInPlace(gpu!.device, lab, img, dims, new Set(), new Set([9]), 1);
  const n1 = r1.out.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
  const strokes = [...r1.seeds!];
  for (let d = -6; d <= 6; d++) { const i = at(c[0] + d, c[1], c[2] + 8); r1.out[i] = 1; strokes.push(i); }   // a few more strokes inside
  const r2 = await growInPlace(gpu!.device, r1.out, img, dims, new Set(), new Set([9]), 1, { strokes });
  const n2 = r2.out.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
  console.log(`second press: ${n1} -> ${n2} voxels, Dice ${dice(r1.out).toFixed(3)} -> ${dice(r2.out).toFixed(3)}`);
  assert(n2 < 1.2 * n1, `the second press did not fill the box: ${n1} -> ${n2}`);
  assert(dice(r2.out) > 0.9);
  // Without the strokes, the first result is a stroke and fills what Outside does not hold.
  const r3 = await growInPlace(gpu!.device, r1.out, img, dims, new Set(), new Set([9]), 1);
  assert(r3.out.reduce((n, v) => n + (v === 1 ? 1 : 0), 0) >= n2);
}});

Deno.test({ name: "the cheapest path on its own: a brightness step parts two seeds where the step is", ignore: !gpu, fn: async () => {
  const s = new Uint8Array(21), img = new Float32Array(21); s[0] = 1; s[20] = 2; img.fill(5); img[15] = 50;   // a step at 15
  const r = await growByPath(gpu!.device, s, img, [21, 1, 1]);
  assertEquals([...r.labels].join(""), "111111111111111222222");
}});
