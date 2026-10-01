// Grow from seeds (logic/grow-from-seeds.ts) on the graphics card: a bright "tumor" off center in a larger noisy
// volume, a stroke inside it and a few around it; the tumor must come back, and nothing outside the box may change.
//
//   deno test -A --no-check logic/grow-from-seeds.gpu.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { initDevice } from "../render/device.ts";
import { growFromSeeds, growInPlace, seedBox } from "./grow-from-seeds.ts";
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
