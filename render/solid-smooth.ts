// THE SMOOTHED SOLID: a blurred copy of "is this voxel inside a visible structure", made on the
// graphics card, for the colored volume's solid look (colorize-field.ts, setSolid).
//
// Why. The solid look finds each structure where the indicator of its labels crosses one half. A
// labelmap is a staircase -- worst between slices, which are usually the coarsest spacing -- and a
// surface lit by the gradient of a staircase shows every step as a contour line, like wood grain
// (first render, 2026-09-23). Surface nets smooths the steps away as it builds the mesh; this does
// the same for the ray cast: the LIGHTING direction is taken from this blurred copy, read with the
// card's own trilinear filter, while the position still comes from the labels themselves so a
// vessel one or two voxels wide is not blurred out of existence.
//
// How. Passes of a five-tap Gaussian (sigma about one voxel each), several per axis, over a packed byte
// buffer -- a storage texture of single bytes is not in core WebGPU -- then one copy into an r8unorm
// 3D texture. The mask pass reads the palette, so a structure that is hidden is not in the solid.
// Rebuilt when visibility changes. One byte per voxel kept; two more transiently during the build.

import { releaseSolidScratch, solidScratch } from "./solid-scratch.ts";

const W = [0.054, 0.244, 0.403, 0.244, 0.054];

/** What ONE labeled voxel reaches in the smoothed copy after `passes`: the product over the axes of the
 *  peak of the kernel applied that many times. */
export function lonePeak(passes: readonly [number, number, number]): number {
  const conv = (a: number[], b: number[]) => {
    const r = new Array(a.length + b.length - 1).fill(0);
    a.forEach((x, i) => b.forEach((y, j) => { r[i + j] += x * y; }));
    return r;
  };
  let p = 1;
  for (const n of passes) { let k = [1]; for (let i = 0; i < n; i++) k = conv(k, W); p *= Math.max(...k); }
  return p;
}

/**
 * How many five-tap passes along x, y and z. Repeated passes widen the blur (sigma grows as the
 * square root of the count). Wider WITHIN the slice than across it, deliberately: where a surface
 * slopes gently against the slices its steps are several voxels wide in-plane, and only a blur as
 * wide as a step can interpolate across it (the stomach and heart still showed broad contour lines
 * at one pass, 2026-09-23).
 */
export const smoothPasses: [number, number, number] = [3, 3, 1];
/**
 * THE "NOTHING HERE" CUT-OFF of the smoothed copy: half of what a lone labeled voxel reaches under the
 * passes above (0.011 for [3,3,1]), and never above 0.02. A fixed 0.02 sat one byte under the lone
 * voxel's 0.0235 and the next widening of the blur would have dropped single voxels silently (critic,
 * 2026-09-23, finding 12). Baked into the shaders when they are made; the live tuning hook
 * __smoothPasses does not move it.
 */
export const EMPTY_CUTOFF = Math.min(0.02, lonePeak(smoothPasses) / 2);

const MASK_X_WGSL = /* wgsl */ `
@group(0) @binding(0) var labs : texture_3d<u32>;
@group(0) @binding(1) var lut : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> dst : array<u32>;
@group(0) @binding(3) var<uniform> P : vec4<u32>;     // nx, ny, nz, words per row
const W = array<f32, 5>(${W.join(", ")});
fn m(x : i32, y : i32, z : i32) -> f32 {
  if (x < 0 || x >= i32(P.x)) { return 0.0; }
  let l = textureLoad(labs, vec3<i32>(x, y, z), 0).r;
  if (l == 0u) { return 0.0; }
  return select(0.0, 1.0, textureLoad(lut, vec2<i32>(i32(l), 1), 0).a > 0.001);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= P.w || id.y >= P.y || id.z >= P.z) { return; }
  var word = 0u;
  for (var b = 0u; b < 4u; b = b + 1u) {
    let x = i32(id.x * 4u + b);
    if (x >= i32(P.x)) { continue; }
    var s = 0.0;
    for (var k = 0; k < 5; k = k + 1) { s = s + W[k] * m(x + k - 2, i32(id.y), i32(id.z)); }
    word = word | (u32(round(clamp(s, 0.0, 1.0) * 255.0)) << (8u * b));
  }
  dst[(id.z * P.y + id.y) * P.w + id.x] = word;
}`;

const BLUR_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> src : array<u32>;
@group(0) @binding(1) var<storage, read_write> dst : array<u32>;
@group(0) @binding(2) var<uniform> P : vec4<u32>;     // nx, ny, nz, words per row
@group(0) @binding(3) var<uniform> A : vec4<u32>;     // axis (0 = x, 1 = y, 2 = z)
const W = array<f32, 5>(${W.join(", ")});
fn at(xi : i32, y : i32, z : i32) -> f32 {
  if (xi < 0 || xi >= i32(P.x) || y < 0 || y >= i32(P.y) || z < 0 || z >= i32(P.z)) { return 0.0; }
  let x = u32(xi);
  let w = src[(u32(z) * P.y + u32(y)) * P.w + x / 4u];
  return f32((w >> (8u * (x % 4u))) & 255u) / 255.0;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= P.w || id.y >= P.y || id.z >= P.z) { return; }
  var word = 0u;
  for (var b = 0u; b < 4u; b = b + 1u) {
    let x = id.x * 4u + b;
    if (x >= P.x) { continue; }
    var s = 0.0;
    for (var k = 0; k < 5; k = k + 1) {
      let o = k - 2;
      if (A.x == 0u) { s = s + W[k] * at(i32(x) + o, i32(id.y), i32(id.z)); }
      else if (A.x == 1u) { s = s + W[k] * at(i32(x), i32(id.y) + o, i32(id.z)); }
      else { s = s + W[k] * at(i32(x), i32(id.y), i32(id.z) + o); }
    }
    word = word | (u32(round(clamp(s, 0.0, 1.0) * 255.0)) << (8u * b));
  }
  dst[(id.z * P.y + id.y) * P.w + id.x] = word;
}`;

/**
 * THE BLOCK MAP: one value per 8x8x8 voxels, so a ray can leap over what cannot hold a wall.
 * 0 = empty (the smoothed copy under EMPTY_CUTOFF throughout -- where the solid look's classifier says
 * "outside" without reading a label), L = entirely inside structure L (the smoothed copy at one half
 * or more throughout and no other visible label), 65535 = mixed. One voxel of apron on each side,
 * because a filtered read inside a block touches its neighbors. Built right after the smoothed copy,
 * from it and the labels, so the two always agree. Ron, 2026-09-23: "fix the dotted pattern and the
 * speed first" -- most of a ray's steps were in empty space or inside a see-through lung.
 */
export const BRICK = 8;
export const BRICK_MIXED = 65535;
/** Mixed, and holding a visible labeled voxel whose smoothed value is under one half: a structure the
 *  blur thinned, where the classifier must still read the labels. */
export const BRICK_THIN = 65534;
const BRICK_WGSL = /* wgsl */ `
@group(0) @binding(0) var sm : texture_3d<f32>;
@group(0) @binding(1) var labs : texture_3d<u32>;
@group(0) @binding(2) var lut : texture_2d<f32>;
@group(0) @binding(3) var out : texture_storage_3d<r32uint, write>;
@group(0) @binding(4) var<uniform> P : vec4<u32>;     // nx, ny, nz, _
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let bd = textureDimensions(out);
  if (id.x >= bd.x || id.y >= bd.y || id.z >= bd.z) { return; }
  let n = vec3<i32>(i32(P.x), i32(P.y), i32(P.z));
  let lo = vec3<i32>(id) * ${BRICK} - vec3<i32>(1);
  let hi = vec3<i32>(id) * ${BRICK} + vec3<i32>(${BRICK});
  var mx = 0.0; var mn = 1.0; var lab = 0u; var mixed = false; var outside = false; var thin = false;
  for (var z = lo.z; z <= hi.z; z = z + 1) {
    for (var y = lo.y; y <= hi.y; y = y + 1) {
      for (var x = lo.x; x <= hi.x; x = x + 1) {
        if (x < 0 || y < 0 || z < 0 || x >= n.x || y >= n.y || z >= n.z) { outside = true; mn = 0.0; continue; }
        let v = textureLoad(sm, vec3<i32>(x, y, z), 0).r;
        mx = max(mx, v); mn = min(mn, v);
        var l = textureLoad(labs, vec3<i32>(x, y, z), 0).r;
        if (l != 0u && textureLoad(lut, vec2<i32>(i32(l), 1), 0).a <= 0.001) { l = 0u; }
        if (l != 0u) {
          if (lab == 0u) { lab = l; } else if (lab != l) { mixed = true; }
          if (v < 0.5) { thin = true; }
        }
      }
    }
  }
  var r = ${BRICK_MIXED}u;
  if (thin) { r = ${BRICK_THIN}u; }
  if (mx < ${EMPTY_CUTOFF.toFixed(5)} && !thin) { r = 0u; }   // a lone labeled voxel is never "empty" (critic, finding 12)
  else if (!mixed && !outside && lab != 0u && mn >= 0.5) { r = lab; }
  textureStore(out, vec3<i32>(id), vec4<u32>(r, 0u, 0u, 0u));
}`;

/** THE COARSE BLOCK MAP: the same three answers for 64x64x64 voxels (8x8x8 blocks), so a ray
 *  crosses the air around the body in a few leaps rather than one per 8-voxel block. */
export const BRICK2 = 8;   // fine blocks per coarse block, per axis
const BRICK2_WGSL = /* wgsl */ `
@group(0) @binding(0) var fine : texture_3d<u32>;
@group(0) @binding(1) var out : texture_storage_3d<r32uint, write>;
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let bd = textureDimensions(out);
  if (id.x >= bd.x || id.y >= bd.y || id.z >= bd.z) { return; }
  let fd = vec3<i32>(textureDimensions(fine));
  let lo = vec3<i32>(id) * ${BRICK2};
  var first = 0u; var seen = false; var r = 0u;
  for (var z = lo.z; z < min(lo.z + ${BRICK2}, fd.z); z = z + 1) {
    for (var y = lo.y; y < min(lo.y + ${BRICK2}, fd.y); y = y + 1) {
      for (var x = lo.x; x < min(lo.x + ${BRICK2}, fd.x); x = x + 1) {
        let v = textureLoad(fine, vec3<i32>(x, y, z), 0).r;
        if (!seen) { first = v; seen = true; } else if (v != first) { r = ${BRICK_MIXED}u; }
      }
    }
  }
  if (r != ${BRICK_MIXED}u) { r = first; }
  textureStore(out, vec3<i32>(id), vec4<u32>(r, 0u, 0u, 0u));
}`;

/** The coarse block map's texture for these voxel dims. The caller owns it. */
export function makeBrick2Texture(dev: GPUDevice, dims: readonly [number, number, number]): GPUTexture {
  const b = dims.map((n) => Math.max(1, Math.ceil(n / (BRICK * BRICK2)))) as [number, number, number];
  return dev.createTexture({
    label: "solid coarse block map", size: b, dimension: "3d", format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
}

/** The block map's texture for these voxel dims (r32uint, one texel per 8x8x8). The caller owns it. */
export function makeBrickTexture(dev: GPUDevice, dims: readonly [number, number, number]): GPUTexture {
  const b = dims.map((n) => Math.max(1, Math.ceil(n / BRICK))) as [number, number, number];
  return dev.createTexture({
    label: "solid block map", size: b, dimension: "3d", format: "r32uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });
}

interface Pipes { mask: GPUComputePipeline; blur: GPUComputePipeline; brick: GPUComputePipeline; brick2: GPUComputePipeline }
const pipes = new WeakMap<GPUDevice, Pipes>();
function pipesFor(dev: GPUDevice): Pipes {
  let p = pipes.get(dev);
  if (!p) {
    p = {
      mask: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: MASK_X_WGSL }), entryPoint: "main" } }),
      blur: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BLUR_WGSL }), entryPoint: "main" } }),
      brick: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BRICK_WGSL }), entryPoint: "main" } }),
      brick2: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BRICK2_WGSL }), entryPoint: "main" } }),
    };
    pipes.set(dev, p);
  }
  return p;
}

/** An r8unorm 3D texture of these dims, the target `buildSmoothSolid` writes. The caller owns it. */
export function makeSmoothSolidTexture(dev: GPUDevice, dims: readonly [number, number, number]): GPUTexture {
  return dev.createTexture({
    label: "smoothed solid", size: dims as [number, number, number], dimension: "3d", format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

(globalThis as unknown as { __smoothPasses?: number[] }).__smoothPasses = smoothPasses;   // for tuning in a live page

/**
 * Fill `target` with the blurred indicator of the labels whose palette opacity is above zero.
 * Submits its own work; the temporary buffers are released once it has run.
 */
export function buildSmoothSolid(dev: GPUDevice, labels: GPUTexture, lut: GPUTexture, dims: readonly [number, number, number], target: GPUTexture, passes: readonly [number, number, number] = smoothPasses, bricks?: GPUTexture, bricks2?: GPUTexture): void {
  const [nx, ny, nz] = dims;
  // Rows padded to 256 bytes: copyBufferToTexture requires it.
  const rowBytes = Math.ceil(nx / 256) * 256;
  const words = rowBytes / 4;
  const size = rowBytes * ny * nz;
  const { mask, blur } = pipesFor(dev);
  // Scratch shared with the merge just before (solid-scratch.ts): 836 MB at the peak, not 1.25 GB.
  const a = solidScratch(dev, "a", size);
  const b = solidScratch(dev, "b", size);
  const P = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(P, 0, new Uint32Array([nx, ny, nz, words]));
  const axis = (n: number) => { const u = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(u, 0, new Uint32Array([n, 0, 0, 0])); return u; };
  const ax = [axis(0), axis(1), axis(2)];
  const groups: [number, number, number] = [Math.ceil(words / 64), ny, nz];
  const enc = dev.createCommandEncoder({ label: "smoothed solid" });
  const pass = enc.beginComputePass();
  pass.setPipeline(mask);
  pass.setBindGroup(0, dev.createBindGroup({ layout: mask.getBindGroupLayout(0), entries: [
    { binding: 0, resource: labels.createView() }, { binding: 1, resource: lut.createView() },
    { binding: 2, resource: { buffer: a } }, { binding: 3, resource: { buffer: P } },
  ] }));
  pass.dispatchWorkgroups(...groups);
  // The mask pass was the first blur along x; the rest ping-pong between the two buffers.
  const order: number[] = [];
  for (let i = 1; i < passes[0]; i++) order.push(0);
  for (let i = 0; i < passes[1]; i++) order.push(1);
  for (let i = 0; i < passes[2]; i++) order.push(2);
  let src = a, dst = b;
  pass.setPipeline(blur);
  for (const ai of order) {
    pass.setBindGroup(0, dev.createBindGroup({ layout: blur.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } },
      { binding: 2, resource: { buffer: P } }, { binding: 3, resource: { buffer: ax[ai] } },
    ] }));
    pass.dispatchWorkgroups(...groups);
    [src, dst] = [dst, src];
  }
  pass.end();
  enc.copyBufferToTexture({ buffer: src, bytesPerRow: rowBytes, rowsPerImage: ny }, { texture: target }, [nx, ny, nz]);
  if (bricks) {
    const bp = enc.beginComputePass();
    const { brick } = pipesFor(dev);
    bp.setPipeline(brick);
    bp.setBindGroup(0, dev.createBindGroup({ layout: brick.getBindGroupLayout(0), entries: [
      { binding: 0, resource: target.createView() }, { binding: 1, resource: labels.createView() },
      { binding: 2, resource: lut.createView() }, { binding: 3, resource: bricks.createView() },
      { binding: 4, resource: { buffer: P } },
    ] }));
    bp.dispatchWorkgroups(Math.ceil(bricks.width / 4), Math.ceil(bricks.height / 4), Math.ceil(bricks.depthOrArrayLayers / 4));
    bp.end();
    if (bricks2) {
      const cp = enc.beginComputePass();
      const { brick2 } = pipesFor(dev);
      cp.setPipeline(brick2);
      cp.setBindGroup(0, dev.createBindGroup({ layout: brick2.getBindGroupLayout(0), entries: [
        { binding: 0, resource: bricks.createView() }, { binding: 1, resource: bricks2.createView() },
      ] }));
      cp.dispatchWorkgroups(Math.ceil(bricks2.width / 4), Math.ceil(bricks2.height / 4), Math.ceil(bricks2.depthOrArrayLayers / 4));
      cp.end();
    }
  }
  dev.queue.submit([enc.finish()]);
  // Destroying after submit is allowed: the card frees them once the work above has run.
  for (const buf of [P, ...ax]) buf.destroy();
  releaseSolidScratch(dev);
}
