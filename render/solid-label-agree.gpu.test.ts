// The labels the solid look draws with from v2 (solid-label-versions.ts): they agree with the smoothed copy. Inside it
// (one half or more) every voxel carries a visible structure, outside it none; a lone painted voxel, which the blur
// keeps under one half, is not drawn; a hidden structure is not drawn.
//
//   deno test -A --no-check render/solid-label-agree.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "./device.ts";
import { buildAgreeLabels, buildSmoothSolid, countDrawn, smoothPasses } from "./solid-smooth.ts";
import { ColorizeField } from "./colorize-field.ts";
import { MAX_LOST, setSolidLabelsVersion, solidBlurPasses, solidLabelsVersion } from "./solid-label-versions.ts";

const gpu = await initDevice().catch(() => null);

async function read3d(dev: GPUDevice, tex: GPUTexture, dims: [number, number, number]): Promise<Uint8Array> {
  const [nx, ny, nz] = dims, bpr = Math.ceil(nx / 256) * 256;
  const buf = dev.createBuffer({ size: bpr * ny * nz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: ny }, dims);
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(nx * ny * nz);
  for (let r = 0; r < ny * nz; r++) out.set(raw.subarray(r * bpr, r * bpr + nx), r * nx);
  buf.unmap(); buf.destroy();
  return out;
}

Deno.test({ name: "labels agreeing with the smoothed copy: inside it a visible structure, outside none; a lone voxel and a hidden structure are not drawn", ignore: !gpu, fn: async () => {
  const dev = gpu!.device, dims: [number, number, number] = [40, 36, 32], [nx, ny, nz] = dims;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const lab = new Uint8Array(nx * ny * nz);
  for (let z = 8; z < 20; z++) for (let y = 8; y < 20; y++) for (let x = 8; x < 20; x++) lab[at(x, y, z)] = 1;   // a block
  lab[at(14, 14, 14)] = 0;                                     // a hole in it: inside the blur, unlabeled
  lab[at(32, 28, 24)] = 1;                                     // a lone voxel, far away
  for (let z = 8; z < 20; z++) for (let y = 24; y < 32; y++) for (let x = 24; x < 34; x++) lab[at(x, y, z)] = 2;  // hidden
  const labTex = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const bpr = Math.ceil(nx / 256) * 256, staged = new Uint8Array(bpr * ny * nz);
  for (let r = 0; r < ny * nz; r++) staged.set(lab.subarray(r * nx, r * nx + nx), r * bpr);
  dev.queue.writeTexture({ texture: labTex }, staged, { bytesPerRow: bpr, rowsPerImage: ny }, dims);
  const lut = dev.createTexture({ size: [256, 4], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const pal = new Uint8Array(256 * 4 * 4); pal.set([255, 255, 255, 255], (256 + 1) * 4);   // row 1: label 1 shown, label 2 hidden
  dev.queue.writeTexture({ texture: lut }, pal, { bytesPerRow: 256 * 4 }, [256, 4]);
  // The app's own formats (makeSmoothSolidTexture, makeAgreeLabelsTexture), here readable back.
  const readable = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
  const smooth = dev.createTexture({ size: dims, dimension: "3d", format: "r8unorm", usage: readable });
  const agree = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: readable });
  buildSmoothSolid(dev, labTex, lut, dims, smooth, smoothPasses);
  const c = await buildAgreeLabels(dev, smooth, labTex, lut, dims, agree, "agree");
  const S = await read3d(dev, smooth, dims), A = await read3d(dev, agree, dims);
  let painted = 0, outside = 0;
  for (let i = 0; i < lab.length; i++) if (lab[i] === 1) { painted++; if (S[i] < 128) outside++; }
  assertEquals(c, { painted, outside }, "the counts that decide are the visible painted voxels and those outside the smoothed copy");
  let inside = 0, mismatch = 0;
  for (let i = 0; i < A.length; i++) {
    if (S[i] >= 128) { inside++; if (A[i] !== 1) mismatch++; } else if (A[i] !== 0) mismatch++;
  }
  assert(inside > 1000, `the block is inside the smoothed copy (${inside} voxels)`);
  assertEquals(mismatch, 0, "inside the smoothed copy every voxel draws as the structure, outside none");
  assertEquals(A[at(14, 14, 14)], 1, "the unlabeled hole inside the block draws as the block");
  assertEquals(A[at(32, 28, 24)], 0, "the lone voxel, under one half in the smoothed copy, is not drawn");
  assertEquals(A[at(28, 28, 14)], 0, "the hidden structure is not drawn");
  for (const t of [labTex, lut, smooth, agree]) t.destroy();
}});

/** A field over these labels with the solid look on, once its choice of labels has come back. */
async function solidField(dev: GPUDevice, lab: Uint8Array, dims: [number, number, number]) {
  const f = new ColorizeField(dev, null, lab, dims, new Uint8Array(256 * 4), { clim: [-1000, 1600], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], contextOpacity: 0 });
  f.setSegmentColor(1, [1, 1, 1]); f.setSegmentOpacity(1, 1); f.flushPalette();
  let changed = 0; f.onChanged = () => { changed++; };
  f.setSolid(true);
  for (let i = 0; i < 50 && f.solidLabels.lost === 0 && f.solidLabels.version === 1; i++) { await new Promise((r) => setTimeout(r, 20)); await dev.queue.onSubmittedWorkDone(); }
  await new Promise((r) => setTimeout(r, 50)); await dev.queue.onSubmittedWorkDone();
  return { f, changed };
}

function blockAndPlate() {
  const N = 40 * 40 * 40, block = new Uint8Array(N), plate = new Uint8Array(N);
  for (let z = 8; z < 30; z++) for (let y = 8; y < 30; y++) for (let x = 8; x < 30; x++) block[(z * 40 + y) * 40 + x] = 1;
  for (let z = 5; z < 35; z++) for (let x = 5; x < 35; x++) plate[(z * 40 + 20) * 40 + x] = 1;   // one voxel thick
  return { block, plate };
}

Deno.test({ name: "v2, only where little is lost: a thick block draws with agreeing labels, a plate one voxel thick keeps its labels as painted", ignore: !gpu, fn: async () => {
  const dev = gpu!.device, dims: [number, number, number] = [40, 40, 40];
  const { block, plate } = blockAndPlate();
  const was = solidLabelsVersion(); setSolidLabelsVersion(2);
  const b = await solidField(dev, block, dims), p = await solidField(dev, plate, dims);
  setSolidLabelsVersion(was);
  assertEquals(b.f.solidLabels.version, 2, `the block: ${(b.f.solidLabels.lost * 100).toFixed(1)} % outside`);
  assert(b.f.solidLabels.lost <= MAX_LOST);
  assertEquals(b.changed, 1, "the block switched once, from the labels as painted to the agreeing copy");
  assertEquals(p.f.solidLabels.version, 1, `the plate: ${(p.f.solidLabels.lost * 100).toFixed(1)} % outside`);
  assertEquals(p.changed, 0, "the plate never switched: no flicker");
  b.f.destroy(); p.f.destroy();
}});

Deno.test({ name: "v3, one rule: every field draws with agreeing labels from the start, with no switch (no flicker)", ignore: !gpu, fn: async () => {
  const dev = gpu!.device, dims: [number, number, number] = [40, 40, 40];
  const { block, plate } = blockAndPlate();
  const was = solidLabelsVersion(); setSolidLabelsVersion(3);
  const b = await solidField(dev, block, dims), p = await solidField(dev, plate, dims);
  setSolidLabelsVersion(was);
  assertEquals([b.f.solidLabels.version, p.f.solidLabels.version], [3, 3]);
  assertEquals([b.changed, p.changed], [0, 0], "written agreeing at once, never rewritten");
  assertEquals(b.f.blurPasses, [1, 1, 1], "cubic voxels: one pass along each axis");
  b.f.destroy(); p.f.destroy();
}});

Deno.test("v3, the blur from the voxels' anisotropy: one pass across the slices, (anisotropy / 2)^2 along the finer axes", () => {
  const fixed: [number, number, number] = [3, 3, 1];
  assertEquals(solidBlurPasses([0.25, 0.25, 0.25], fixed, 3), [1, 1, 1], "the CBCT");
  assertEquals(solidBlurPasses([0.651, 0.651, 1.0], fixed, 3), [1, 1, 1], "C3N-01524, anisotropy 1.5");
  assertEquals(solidBlurPasses([1, 0.973, 0.973], fixed, 3), [1, 1, 1], "ds001226 PAT29, nearly cubic");
  assertEquals(solidBlurPasses([0.2, 0.2, 0.7], fixed, 3), [3, 3, 1], "anisotropy 3.5: today's 3-3-1");
  assertEquals(solidBlurPasses([0.68, 0.68, 3.0], fixed, 3), [5, 5, 1], "the lymph-node case_0795, anisotropy 4.4");
  assertEquals(solidBlurPasses([3.0, 0.68, 0.68], fixed, 3), [1, 5, 5], "the coarse axis need not be the last");
  assertEquals(solidBlurPasses([0.5, 0.5, 10], fixed, 3), [16, 16, 1], "capped at MAX_PASSES");
  assertEquals(solidBlurPasses([0.68, 0.68, 3.0], fixed, 2), [3, 3, 1], "v2 keeps the fixed blur");
});

Deno.test({ name: "what is left out is counted per structure: a stroke one slice deep is painted and not drawn, a block is drawn (critic 2026-11-06, findings 1, 3)", ignore: !gpu, fn: async () => {
  const dev = gpu!.device, dims: [number, number, number] = [64, 64, 32], [nx, ny, nz] = dims;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const lab = new Uint8Array(nx * ny * nz);
  for (let z = 8; z < 24; z++) for (let y = 8; y < 28; y++) for (let x = 8; x < 28; x++) lab[at(x, y, z)] = 1;   // a block
  for (let y = 36; y < 60; y++) for (let x = 36; x < 60; x++) lab[at(x, y, 16)] = 2;                             // a flat stroke
  for (let z = 8; z < 24; z++) for (let y = 36; y < 40; y++) for (let x = 8; x < 12; x++) lab[at(x, y, z)] = 3;   // hidden
  const labTex = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const bpr = Math.ceil(nx / 256) * 256, staged = new Uint8Array(bpr * ny * nz);
  for (let r = 0; r < ny * nz; r++) staged.set(lab.subarray(r * nx, r * nx + nx), r * bpr);
  dev.queue.writeTexture({ texture: labTex }, staged, { bytesPerRow: bpr, rowsPerImage: ny }, dims);
  const lut = dev.createTexture({ size: [256, 4], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const pal = new Uint8Array(256 * 4 * 4);
  pal.set([255, 255, 255, 255], (256 + 1) * 4); pal.set([255, 255, 255, 255], (256 + 2) * 4);   // row 1: labels 1 and 2 shown, 3 hidden
  dev.queue.writeTexture({ texture: lut }, pal, { bytesPerRow: 256 * 4 }, [256, 4]);
  const smooth = dev.createTexture({ size: dims, dimension: "3d", format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const agree = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  buildSmoothSolid(dev, labTex, lut, dims, smooth, [1, 1, 1]);
  await buildAgreeLabels(dev, smooth, labTex, lut, dims, agree, "agree");
  const d = await countDrawn(dev, labTex, agree, lut, dims);
  assertEquals(d.painted[1], 16 * 20 * 20, "the block's voxels");
  assert(d.drawn[1] > 0.8 * d.painted[1], `the block is drawn: ${d.drawn[1]} of ${d.painted[1]}`);
  assertEquals(d.painted[2], 24 * 24, "the stroke's voxels");
  assertEquals(d.drawn[2], 0, "the stroke one slice deep is not drawn, and the count says so");
  assertEquals(d.painted[3], 0, "a hidden structure is not counted");
  for (const t of [labTex, lut, smooth, agree]) t.destroy();
}});

Deno.test("a spacing that is no spacing takes the fixed blur (critic 2026-11-06, finding 11)", () => {
  const fixed: [number, number, number] = [3, 3, 1];
  assertEquals(solidBlurPasses([NaN, 1, 1], fixed, 3), fixed);
  assertEquals(solidBlurPasses([0, 1, 1], fixed, 3), fixed);
  assertEquals(solidBlurPasses([-1, 1, 1], fixed, 3), fixed);
  assertEquals(solidBlurPasses([0.68, 0.68, 3], fixed, 3), [5, 5, 1]);
});
