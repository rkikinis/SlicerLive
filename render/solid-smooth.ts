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
// (From solid-label-versions.ts v2 the position comes from the blurred copy too, and from v3 each field chooses how
// wide the blur is from its voxels' anisotropy: solidBlurPasses.)
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
export const smoothPasses: [number, number, number] = [3, 3, 1];   // v1 and v2; v3 chooses per field (solidBlurPasses)
/**
 * THE "NOTHING HERE" CUT-OFF of the smoothed copy: half of what a lone labeled voxel reaches under the
 * passes above (0.011 for [3,3,1]), and never above 0.02. A fixed 0.02 sat one byte under the lone
 * voxel's 0.0235 and the next widening of the blur would have dropped single voxels silently (critic,
 * 2026-09-23, finding 12). Baked into the shaders when they are made; the live tuning hook
 * __smoothPasses does not move it.
 */
export const EMPTY_CUTOFF = emptyCutoff(smoothPasses);
/** The "nothing here" cut-off for a smoothed copy made with these passes (above). From solid-label-versions.ts v3 each
 *  field chooses its own passes, so each has its own cut-off; the block map and the field's shader take it from here. */
export function emptyCutoff(passes: readonly [number, number, number]): number { return Math.min(0.02, lonePeak(passes) / 2); }

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

/**
 * LABELS THAT AGREE WITH THE SMOOTHED COPY (solid-label-versions.ts, v2): inside it (the copy at one half or more) a
 * voxel draws as the visible structure painted there, or the nearest visible one within 2 voxels (a blur of 3 passes
 * reaches about that far; at 16 passes it reaches further, so a few voxels get no label: critic 2026-11-06, finding 6); outside it, as nothing. M.x = 0 writes the labels as painted instead (the share lost was too large). Every
 * run also counts the visible painted voxels and those outside the smoothed copy (counts[0], counts[1]), one global add
 * per workgroup. Writes packed bytes for a copy to an r8uint texture, as the mask pass does.
 */
const AGREE_WGSL = /* wgsl */ `
@group(0) @binding(0) var smoothT : texture_3d<f32>;
@group(0) @binding(1) var labs : texture_3d<u32>;
@group(0) @binding(2) var lut : texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> dst : array<u32>;
@group(0) @binding(4) var<uniform> P : vec4<u32>;     // nx, ny, nz, words per row
@group(0) @binding(5) var<storage, read_write> counts : array<atomic<u32>, 2>;
@group(0) @binding(6) var<uniform> M : vec4<u32>;     // x: 1 = agreeing labels, 0 = the labels as painted
var<workgroup> wPainted : atomic<u32>;
var<workgroup> wOutside : atomic<u32>;
fn vis(l : u32) -> bool { return l != 0u && textureLoad(lut, vec2<i32>(i32(l), 1), 0).a > 0.001; }
fn inside(q : vec3<i32>) -> bool { return textureLoad(smoothT, q, 0).r >= 0.5; }
fn agree(x : i32, y : i32, z : i32, l : u32) -> u32 {
  if (!inside(vec3<i32>(x, y, z))) { return 0u; }
  if (vis(l)) { return l; }
  var best = 0u; var bd = 1000;
  for (var dz = -2; dz <= 2; dz = dz + 1) {
    for (var dy = -2; dy <= 2; dy = dy + 1) {
      for (var dx = -2; dx <= 2; dx = dx + 1) {
        let q = vec3<i32>(x + dx, y + dy, z + dz);
        if (any(q < vec3<i32>(0)) || q.x >= i32(P.x) || q.y >= i32(P.y) || q.z >= i32(P.z)) { continue; }
        let d = dx * dx + dy * dy + dz * dz;
        if (d >= bd) { continue; }
        let lq = textureLoad(labs, q, 0).r;
        if (vis(lq)) { bd = d; best = lq; }
      }
    }
  }
  return best;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>, @builtin(local_invocation_index) li : u32) {
  let valid = id.x < P.w && id.y < P.y && id.z < P.z;
  var painted = 0u; var outside = 0u;
  if (valid) {
    var word = 0u;
    for (var b = 0u; b < 4u; b = b + 1u) {
      let x = id.x * 4u + b;
      if (x >= P.x) { continue; }
      let l = textureLoad(labs, vec3<i32>(i32(x), i32(id.y), i32(id.z)), 0).r;
      if (vis(l)) { painted = painted + 1u; if (!inside(vec3<i32>(i32(x), i32(id.y), i32(id.z)))) { outside = outside + 1u; } }
      let v = select(l, agree(i32(x), i32(id.y), i32(id.z), l), M.x == 1u);
      word = word | ((v & 255u) << (8u * b));
    }
    dst[(id.z * P.y + id.y) * P.w + id.x] = word;
  }
  if (painted > 0u) { atomicAdd(&wPainted, painted); }
  if (outside > 0u) { atomicAdd(&wOutside, outside); }
  workgroupBarrier();
  if (li == 0u) {
    let a = atomicLoad(&wPainted); let o = atomicLoad(&wOutside);
    if (a > 0u) { atomicAdd(&counts[0], a); }
    if (o > 0u) { atomicAdd(&counts[1], o); }
  }
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
@group(0) @binding(5) var<uniform> C : vec4<f32>;     // x: the field's "nothing here" cut-off (emptyCutoff)
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
  if (mx < C.x && !thin) { r = 0u; }   // a lone labeled voxel is never "empty" (critic, finding 12)
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

interface Pipes { mask: GPUComputePipeline; blur: GPUComputePipeline; agree: GPUComputePipeline; drawn: GPUComputePipeline; brick: GPUComputePipeline; brick2: GPUComputePipeline }
const pipes = new WeakMap<GPUDevice, Pipes>();
function pipesFor(dev: GPUDevice): Pipes {
  let p = pipes.get(dev);
  if (!p) {
    p = {
      mask: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: MASK_X_WGSL }), entryPoint: "main" } }),
      blur: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BLUR_WGSL }), entryPoint: "main" } }),
      agree: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: AGREE_WGSL }), entryPoint: "main" } }),
      drawn: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: DRAWN_WGSL }), entryPoint: "main" } }),
      brick: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BRICK_WGSL }), entryPoint: "main" } }),
      brick2: dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BRICK2_WGSL }), entryPoint: "main" } }),
    };
    pipes.set(dev, p);
  }
  return p;
}

/** The block map's cut-off as a uniform; the caller destroys it after submitting (the card frees it once run). */
function cutoffUniform(dev: GPUDevice, cutoff: number): GPUBuffer {
  const u = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(u, 0, new Float32Array([cutoff, 0, 0, 0]));
  return u;
}

/** An r8uint 3D texture of these dims for the labels that agree with the smoothed copy (`buildSmoothSolid`'s `agree`). */
export function makeAgreeLabelsTexture(dev: GPUDevice, dims: readonly [number, number, number]): GPUTexture {
  return dev.createTexture({
    label: "solid labels, agreeing", size: dims as [number, number, number], dimension: "3d", format: "r8uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
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
  const C = cutoffUniform(dev, emptyCutoff(passes));
  if (bricks) {
    const bp = enc.beginComputePass();
    const { brick } = pipesFor(dev);
    bp.setPipeline(brick);
    bp.setBindGroup(0, dev.createBindGroup({ layout: brick.getBindGroupLayout(0), entries: [
      { binding: 0, resource: target.createView() }, { binding: 1, resource: labels.createView() },
      { binding: 2, resource: lut.createView() }, { binding: 3, resource: bricks.createView() },
      { binding: 4, resource: { buffer: P } }, { binding: 5, resource: { buffer: C } },
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
  for (const buf of [P, C, ...ax]) buf.destroy();
  releaseSolidScratch(dev);
}

/**
 * THE LABELS THE SOLID LOOK DRAWS WITH (solid-label-versions.ts v2), from a smoothed copy already made: "agree" writes
 * labels that agree with it into `out` (r8uint, the field's dims), "painted" the labels as painted, "count" nothing.
 * Resolves to the visible painted voxels and those of them outside the smoothed copy: count first, choose, then write
 * once, so the view never shows the copy that was not chosen.
 */
export async function buildAgreeLabels(dev: GPUDevice, smooth: GPUTexture, labels: GPUTexture, lut: GPUTexture, dims: readonly [number, number, number], out: GPUTexture, mode: "count" | "agree" | "painted"): Promise<{ painted: number; outside: number }> {
  const agree = mode === "agree";
  const [nx, ny, nz] = dims;
  const rowBytes = Math.ceil(nx / 256) * 256, words = rowBytes / 4;
  // THE SMOOTHING'S SCRATCH AGAIN, not a third buffer (critic 2026-11-06, finding 7: 1.25 GB at the peak on 768x768x709,
  // the figure solid-scratch.ts records as having reset Ron's window). Work runs in order on one queue.
  const buf = solidScratch(dev, "a", rowBytes * ny * nz);
  const counts = dev.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const read = dev.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const P = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const M = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(P, 0, new Uint32Array([nx, ny, nz, words]));
  dev.queue.writeBuffer(M, 0, new Uint32Array([agree ? 1 : 0, 0, 0, 0]));
  dev.queue.writeBuffer(counts, 0, new Uint32Array([0, 0]));
  const { agree: ag } = pipesFor(dev);
  const enc = dev.createCommandEncoder({ label: "solid labels" });
  const pass = enc.beginComputePass();
  pass.setPipeline(ag);
  pass.setBindGroup(0, dev.createBindGroup({ layout: ag.getBindGroupLayout(0), entries: [
    { binding: 0, resource: smooth.createView() }, { binding: 1, resource: labels.createView() }, { binding: 2, resource: lut.createView() },
    { binding: 3, resource: { buffer: buf } }, { binding: 4, resource: { buffer: P } }, { binding: 5, resource: { buffer: counts } },
    { binding: 6, resource: { buffer: M } },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(words / 64), ny, nz);
  pass.end();
  if (mode !== "count") enc.copyBufferToTexture({ buffer: buf, bytesPerRow: rowBytes, rowsPerImage: ny }, { texture: out }, [nx, ny, nz]);
  enc.copyBufferToBuffer(counts, 0, read, 0, 8);
  dev.queue.submit([enc.finish()]);
  for (const b of [counts, P, M]) b.destroy();   // freed once the work above has run
  releaseSolidScratch(dev);
  await read.mapAsync(GPUMapMode.READ);
  const c = new Uint32Array(read.getMappedRange().slice(0));
  read.unmap(); read.destroy();
  return { painted: c[0], outside: c[1] };
}

/** Per structure, its visible painted voxels and those of them drawn: the labels the solid look draws with hold it there. */
const DRAWN_WGSL = /* wgsl */ `
@group(0) @binding(0) var labs : texture_3d<u32>;
@group(0) @binding(1) var drawnT : texture_3d<u32>;
@group(0) @binding(2) var lut : texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> counts : array<atomic<u32>, 512>;   // l: painted; 256 + l: drawn
@group(0) @binding(4) var<uniform> P : vec4<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= P.x || id.y >= P.y || id.z >= P.z) { return; }
  let q = vec3<i32>(id);
  let l = textureLoad(labs, q, 0).r;
  if (l == 0u || textureLoad(lut, vec2<i32>(i32(l), 1), 0).a <= 0.001) { return; }
  atomicAdd(&counts[l], 1u);
  if (textureLoad(drawnT, q, 0).r == l) { atomicAdd(&counts[256u + l], 1u); }
}`;

/** WHAT THE SOLID LOOK LEAVES OUT, PER STRUCTURE (critic 2026-11-06, finding 3): `painted[l]` and `drawn[l]`, for the line that says so. */
export async function countDrawn(dev: GPUDevice, labels: GPUTexture, drawn: GPUTexture, lut: GPUTexture, dims: readonly [number, number, number]): Promise<{ painted: Uint32Array; drawn: Uint32Array }> {
  const [nx, ny, nz] = dims;
  const counts = dev.createBuffer({ size: 2048, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = dev.createBuffer({ size: 2048, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const P = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(P, 0, new Uint32Array([nx, ny, nz, 0]));
  const pipe = pipesFor(dev).drawn;
  const enc = dev.createCommandEncoder({ label: "solid labels drawn, per structure" });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: labels.createView() }, { binding: 1, resource: drawn.createView() }, { binding: 2, resource: lut.createView() },
    { binding: 3, resource: { buffer: counts } }, { binding: 4, resource: { buffer: P } },
  ] }));
  pass.dispatchWorkgroups(Math.ceil(nx / 64), ny, nz);
  pass.end();
  enc.copyBufferToBuffer(counts, 0, read, 0, 2048);
  dev.queue.submit([enc.finish()]);
  counts.destroy(); P.destroy();
  await read.mapAsync(GPUMapMode.READ);
  const c = new Uint32Array(read.getMappedRange().slice(0));
  read.unmap(); read.destroy();
  return { painted: c.slice(0, 256), drawn: c.slice(256, 512) };
}

/** The block maps (BRICK_WGSL, BRICK2_WGSL) from a smoothed copy and the labels the solid look draws with. */
export function buildBricks(dev: GPUDevice, smooth: GPUTexture, labels: GPUTexture, lut: GPUTexture, dims: readonly [number, number, number], bricks: GPUTexture, bricks2: GPUTexture, cutoff = EMPTY_CUTOFF): void {
  const [nx, ny, nz] = dims;
  const P = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(P, 0, new Uint32Array([nx, ny, nz, Math.ceil(nx / 256) * 64]));
  const C = cutoffUniform(dev, cutoff);
  const enc = dev.createCommandEncoder({ label: "solid block maps" });
  const { brick, brick2 } = pipesFor(dev);
  const bp = enc.beginComputePass();
  bp.setPipeline(brick);
  bp.setBindGroup(0, dev.createBindGroup({ layout: brick.getBindGroupLayout(0), entries: [
    { binding: 0, resource: smooth.createView() }, { binding: 1, resource: labels.createView() },
    { binding: 2, resource: lut.createView() }, { binding: 3, resource: bricks.createView() },
    { binding: 4, resource: { buffer: P } }, { binding: 5, resource: { buffer: C } },
  ] }));
  bp.dispatchWorkgroups(Math.ceil(bricks.width / 4), Math.ceil(bricks.height / 4), Math.ceil(bricks.depthOrArrayLayers / 4));
  bp.end();
  const cp = enc.beginComputePass();
  cp.setPipeline(brick2);
  cp.setBindGroup(0, dev.createBindGroup({ layout: brick2.getBindGroupLayout(0), entries: [
    { binding: 0, resource: bricks.createView() }, { binding: 1, resource: bricks2.createView() },
  ] }));
  cp.dispatchWorkgroups(Math.ceil(bricks2.width / 4), Math.ceil(bricks2.height / 4), Math.ceil(bricks2.depthOrArrayLayers / 4));
  cp.end();
  dev.queue.submit([enc.finish()]);
  P.destroy(); C.destroy();
}
