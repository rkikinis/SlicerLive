// T1 unit (W5): binary morphology + median on 3D phantoms. Uses a 7x7x3 volume with the 2D pattern
// replicated across all k-slices (a prism), so the 3D ball has real neighbours in k and the middle slice
// behaves like the intended 2D operation (erosion border_value=0, matching scipy).
import { assertEquals } from "jsr:@std/assert@1";
import { ballOffsets, binaryClose, binaryDilate, binaryErode, binaryOpen, median3d } from "./morph.ts";

const dims: [number, number, number] = [7, 7, 3];
const idx = (i: number, j: number, k: number) => k * 49 + j * 7 + i;
const sum = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
// fill a 2D (i,j) predicate across all 3 k-slices
function prism(on: (i: number, j: number) => boolean): Uint8Array {
  const m = new Uint8Array(147);
  for (let k = 0; k < 3; k++) for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) if (on(i, j)) m[idx(i, j, k)] = 1;
  return m;
}

Deno.test("ballOffsets: r=1 is the 3D 6-neighborhood + center (7)", () => {
  assertEquals(ballOffsets(1).length, 7);
});

Deno.test("dilate grows a single voxel to its full 3D plus-neighborhood (7)", () => {
  const m = new Uint8Array(147); m[idx(3, 3, 1)] = 1;
  assertEquals(sum(binaryDilate(m, dims, 1)), 7, "center + 6 face neighbours");
});

Deno.test("opening removes a small isolated blob, keeps a solid block core", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);   // 5x5x3 solid block
  m[idx(0, 0, 1)] = 1;                                                // an isolated speck away from the block
  const o = binaryOpen(m, dims, 1);
  assertEquals(o[idx(0, 0, 1)], 0, "isolated speck removed by opening");
  assertEquals(o[idx(3, 3, 1)], 1, "block core kept");
});

Deno.test("closing fills a small hole (middle slice)", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);   // 5x5x3 block
  for (let k = 0; k < 3; k++) m[idx(3, 3, k)] = 0;                    // hole column
  assertEquals(binaryClose(m, dims, 1)[idx(3, 3, 1)], 1, "hole filled");
});

Deno.test("median removes salt and keeps a solid core", () => {
  const salt = new Uint8Array(147); salt[idx(3, 3, 1)] = 1;
  assertEquals(median3d(salt, dims, 1)[idx(3, 3, 1)], 0, "isolated voxel removed");
  const solid = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);
  assertEquals(median3d(solid, dims, 1)[idx(3, 3, 1)], 1, "solid core kept");
});

Deno.test("erode then the block shrinks by one shell", () => {
  const m = prism((i, j) => i >= 1 && i <= 5 && j >= 1 && j <= 5);
  const e = binaryErode(m, dims, 1);
  assertEquals(e[idx(1, 3, 1)], 0, "edge eroded");
  assertEquals(e[idx(3, 3, 1)], 1, "core kept");
});

// THE DISTANCE MAP GIVES THE SAME VOXELS AS THE BALL'S OFFSETS (SPEED-2026-10-28.md in the workspace, A6): random masks of
// several densities, odd grid sizes, radii 1 to 6 and 2.5, grow and shrink -- every voxel compared.
Deno.test("grow and shrink by the exact distance map equal the ball-offset version, voxel for voxel", async () => {
  const { morphByOffsets, binaryDilate, binaryErode } = await import("./morph.ts");
  let seed = 7; const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const [dims, density] of [[[23, 17, 11], 0.02], [[31, 9, 14], 0.3], [[12, 12, 12], 0.85], [[40, 1, 7], 0.1]] as [[number, number, number], number][]) {
    const n = dims[0] * dims[1] * dims[2], m = new Uint8Array(n);
    for (let v = 0; v < n; v++) m[v] = rand() < density ? 1 : 0;
    for (const r of [1, 2, 2.5, 3, 4, 6]) {
      const a = binaryDilate(m, dims, r), b = morphByOffsets(m, dims, r, "dilate");
      const c = binaryErode(m, dims, r), e = morphByOffsets(m, dims, r, "erode");
      let bad = 0; for (let v = 0; v < n; v++) { if (a[v] !== b[v]) bad++; if (c[v] !== e[v]) bad++; }
      if (bad) throw new Error(`dims ${dims} density ${density} r ${r}: ${bad} voxels differ`);
    }
  }
  // An empty mask grows to nothing; a full one shrinks only at the faces.
  const z = new Uint8Array(1000), f = new Uint8Array(1000).fill(1), d: [number, number, number] = [10, 10, 10];
  if (binaryDilate(z, d, 3).some((x) => x)) throw new Error("an empty mask grew");
  const fe = binaryErode(f, d, 3), fo = morphByOffsets(f, d, 3, "erode");
  if (fe.some((x, v) => x !== fo[v])) throw new Error("a full mask shrank differently at the faces");
});
