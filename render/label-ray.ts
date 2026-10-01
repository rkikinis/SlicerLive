// WHAT STRUCTURE IS THIS RAY POINTING AT — asked of the segmentations, not of the transfer function.
//
// Ron pointed the 3D probe at the gluteus medius and it answered "Iliopsoas muscle, right". That was
// honest: `SceneRenderer.pick` returns where front-to-back opacity crosses 50%, accumulated over
// everything the renderer composites, and with a step transfer function the soft tissue the ray meets
// FIRST passes 50% long before it reaches the muscle you are looking at. A true answer to a different
// question.
//
// Ron, on the three ways out: "1: agree" -- ask the segmentations. Two properties follow, and they are
// the reason to prefer it:
//
//   * the answer does not change when you drag an opacity slider. Which structure is under the cursor
//     is a fact about the data; making it depend on the appearance settings would be the probe
//     contradicting Ron's standing rule from the other side ("leave the data, modulate the
//     appearance");
//   * it needs no threshold, so there is no number to defend.
//
// A COMPUTE PASS, because a fragment shader can return four floats and this has to walk a ray and
// stop. Feasibility was measured before it was written: textureLoad on an r8uint 3D texture works in
// compute, a read_write storage buffer is writable there, and one ray of 256 samples costs the same
// ~16 ms as the existing single-point pick -- which is the CPU<->GPU readback round trip, not the
// march. So this is not slower than what it replaces.
//
// EACH LABELMAP THROUGH ITS OWN MATRIX, and the t-range comes from a unit-box slab test in each
// labelmap's OWN texture space. A specialised network covers a sub-volume, so the ray is inside one
// labelmap over one interval and inside another over a different one; marching a shared scene box
// instead would waste most of the samples and still need the per-slot test.
import type { Gpu } from "./device.ts";
import type { Mat4, Vec3 } from "./mat4.ts";

/** One labelmap the ray should ask. */
export interface LabelRayTarget {
  labels: GPUTexture;
  /** RAS -> that labelmap's texture [0,1]. */
  p2t: Mat4;
  /**
   * Which of the 256 label values are DRAWN, as a 256-bit mask (8 x u32, label L is bit L). Omit and
   * every non-zero label counts.
   *
   * WHY VISIBILITY BUT NOT OPACITY. The note at the top of this file argues the answer should not
   * change when an opacity slider moves, and that still holds: a structure at 30% is on screen and
   * is what the cursor is over. But a structure switched OFF is not drawn at all, and the ray was
   * still reporting it -- Ron, with the neocortex hidden and a deeper structure exposed: "the probe
   * shows the superior fronal gyrus", and with two segmentations loaded: "I had nephrogenic up and
   * switched from total to lungvessels. The probe still gave me sternum."
   *
   * You cannot point at something that is not in the picture. So the rule is "skip what is not
   * drawn", which is alpha 0 in the palette -- the same test `pushSurfaces` uses to decide whether a
   * segment gets a mesh -- and not "weight by how opaque it is".
   */
  visible?: Uint32Array;
}

export interface LabelRayHit {
  /** Index into the targets array. */
  slot: number;
  /** The label value found there (never 0). */
  label: number;
  /** Distance along the ray in mm, and the RAS point. */
  tMm: number;
  ras: Vec3;
}

/** How many labelmaps one pass can ask. Matches the slice shader's overlay slots. */
export const LABEL_RAY_SLOTS = 2;

const WGSL = /* wgsl */ `
struct U {
  p2t0 : mat4x4<f32>,
  p2t1 : mat4x4<f32>,
  ro : vec4<f32>,
  rd : vec4<f32>,
  params : vec4<f32>,       // step mm, slot count, _, _
  // Which labels are drawn, per slot: 256 bits as 2 x vec4<u32>, label L is bit L. All zero means
  // "no mask supplied", which is treated as everything visible.
  vis0 : array<vec4<u32>, 2>,
  vis1 : array<vec4<u32>, 2>,
};
struct Out { hit : u32, slot : u32, label : u32, pad : u32, t : f32 };
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var t_lab0 : texture_3d<u32>;
@group(0) @binding(2) var t_lab1 : texture_3d<u32>;
@group(0) @binding(3) var<storage, read_write> out : Out;

/** The t interval over which the ray is inside this labelmap's unit texture box; t1 < t0 = misses. */
fn interval(m : mat4x4<f32>) -> vec2<f32> {
  let o = (m * vec4<f32>(u.ro.xyz, 1.0)).xyz;
  let d = (m * vec4<f32>(u.rd.xyz, 0.0)).xyz;     // a direction carries no translation
  var t0 = -1e30;
  var t1 = 1e30;
  for (var i = 0; i < 3; i = i + 1) {
    if (abs(d[i]) < 1e-9) {
      // Parallel to this pair of faces: either always inside them or never.
      if (o[i] < 0.0 || o[i] > 1.0) { return vec2<f32>(1.0, -1.0); }
      continue;
    }
    let a = (0.0 - o[i]) / d[i];
    let b = (1.0 - o[i]) / d[i];
    t0 = max(t0, min(a, b));
    t1 = min(t1, max(a, b));
  }
  return vec2<f32>(t0, t1);
}

/**
 * The label at distance t in slot 'which', or 0 for outside/background.
 *
 * The matrix is chosen by BRANCHING, not by select(): WGSL's select does not take a mat4x4, and
 * passing one in is rejected at shader-creation time -- "unexpected argument type for select call"
 * -- which invalidates the pipeline and every bind group after it. (Note for the next person: a
 * backtick anywhere in this WGSL would end the JavaScript template literal holding it, which is the
 * other way this shader failed to build.)
 *
 * floor(tc * dims) is the same texel the slice shader and the 2D probe pick, and it is NEAREST,
 * never interpolated: label 40 does not lie between 39 and 41.
 */
fn labelAt(which : i32, t : f32) -> u32 {
  let ras = u.ro.xyz + u.rd.xyz * t;
  if (which == 0) {
    let tc = (u.p2t0 * vec4<f32>(ras, 1.0)).xyz;
    if (any(tc < vec3<f32>(0.0)) || any(tc > vec3<f32>(1.0))) { return 0u; }
    let dm = vec3<f32>(textureDimensions(t_lab0));
    let vi = vec3<i32>(clamp(floor(tc * dm), vec3<f32>(0.0), dm - vec3<f32>(1.0)));
    return textureLoad(t_lab0, vi, 0).r;
  }
  let tc = (u.p2t1 * vec4<f32>(ras, 1.0)).xyz;
  if (any(tc < vec3<f32>(0.0)) || any(tc > vec3<f32>(1.0))) { return 0u; }
  let dm = vec3<f32>(textureDimensions(t_lab1));
  let vi = vec3<i32>(clamp(floor(tc * dm), vec3<f32>(0.0), dm - vec3<f32>(1.0)));
  return textureLoad(t_lab1, vi, 0).r;
}

// Is label v drawn in slot s? An all-zero mask means nothing was supplied, so everything counts.
// (NO BACKTICKS ANYWHERE IN THIS STRING -- it is a JS template literal and a backtick ends it. This
//  is the third time; see the trap in docs/CONSTRAINTS.md.)
fn drawn(s : i32, v : u32) -> bool {
  var m = u.vis0;
  if (s == 1) { m = u.vis1; }
  // BIT 0 SAYS A MASK WAS SUPPLIED. Label 0 is background and is never reported, so its bit is free
  // to carry that. Testing "are any bits set" instead cannot tell "no mask" from "nothing visible",
  // and the second of those must return no hit rather than every hit.
  if ((m[0].x & 1u) == 0u) { return true; }
  let w = v >> 5u;            // which of the 8 u32
  let b = v & 31u;            // which bit in it
  var word = 0u;
  switch (w) {
    case 0u: { word = m[0].x; }
    case 1u: { word = m[0].y; }
    case 2u: { word = m[0].z; }
    case 3u: { word = m[0].w; }
    case 4u: { word = m[1].x; }
    case 5u: { word = m[1].y; }
    case 6u: { word = m[1].z; }
    default: { word = m[1].w; }
  }
  return (word & (1u << b)) != 0u;
}

@compute @workgroup_size(1)
fn main() {
  out.hit = 0u;
  let n = i32(u.params.y);
  let i0 = interval(u.p2t0);
  var i1 = vec2<f32>(1.0, -1.0);
  if (n > 1) { i1 = interval(u.p2t1); }
  // The union, clipped to in front of the camera. Nothing to march if both miss.
  var lo = 1e30;
  var hi = -1e30;
  if (i0.y >= i0.x) { lo = min(lo, i0.x); hi = max(hi, i0.y); }
  if (i1.y >= i1.x) { lo = min(lo, i1.x); hi = max(hi, i1.y); }
  if (hi < lo) { return; }
  lo = max(lo, 0.0);
  let step = max(u.params.x, 1e-3);
  var t = lo;
  var guard = 0;
  loop {
    if (t > hi || guard >= 20000) { break; }
    // Slot order IS priority: the overlay list is back to front, so the LAST slot is what is drawn
    // on top and is what the person is looking at where two labelmaps overlap.
    var found = 0u;
    var fslot = 0u;
    for (var s = n - 1; s >= 0; s = s - 1) {
      let v = labelAt(s, t);
      // A hidden label is passed THROUGH, not stopped at: the ray keeps going and reports whatever
      // is exposed behind it, which is what the person is actually looking at.
      if (v != 0u && drawn(s, v)) { found = v; fslot = u32(s); break; }
    }
    if (found != 0u) {
      out.hit = 1u;
      out.slot = fslot;
      out.label = found;
      out.t = t;
      return;
    }
    t = t + step;
    guard = guard + 1;
  }
}
`;

/**
 * Ask a set of labelmaps what the first structure along a ray is.
 *
 * Resources are resident and reused: one pipeline, one uniform, one output buffer, one staging
 * buffer. Calls are serialised, because they share those and a concurrent pair would overwrite each
 * other's ray and double-map the readback -- the same trap `SceneRenderer.pick` documents.
 */
export class LabelRay {
  private dev: GPUDevice;
  private pipeline: GPUComputePipeline;
  private uni: GPUBuffer;
  private out: GPUBuffer;
  private read: GPUBuffer;
  private empty?: GPUTexture;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(gpu: Gpu) {
    this.dev = gpu.device;
    const module = this.dev.createShaderModule({ code: WGSL });
    this.pipeline = this.dev.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    // 44 floats: p2t0(16) p2t1(16) ro(4) rd(4) params(4).
    this.uni = this.dev.createBuffer({ size: 60 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.out = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.read = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** A 1x1x1 stand-in, so slot 1 always has something to bind when only one labelmap is asked. */
  private noLabels(): GPUTexture {
    if (!this.empty) {
      this.empty = this.dev.createTexture({
        size: [1, 1, 1], dimension: "3d", format: "r8uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.dev.queue.writeTexture({ texture: this.empty }, new Uint8Array(1), { bytesPerRow: 1, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.empty;
  }

  /**
   * The first non-zero label along the ray, or null if it meets none.
   *
   * `stepMm` should be at or below the finest voxel spacing of the labelmaps asked: a step coarser
   * than a voxel can step over a thin structure, and a rib is thin.
   */
  async first(targets: readonly LabelRayTarget[], origin: Vec3, dir: Vec3, stepMm: number): Promise<LabelRayHit | null> {
    // MORE THAN TWO: the shader takes a pair, so the pairs are walked one after another and the
    // nearest hit wins. `slot` in the answer is the index into `targets`, not into the pair.
    if (targets.length > LABEL_RAY_SLOTS) {
      let best: LabelRayHit | null = null;
      for (let i = 0; i < targets.length; i += LABEL_RAY_SLOTS) {
        const hit = await this.first(targets.slice(i, i + LABEL_RAY_SLOTS), origin, dir, stepMm);
        if (hit && (!best || hit.tMm < best.tMm)) best = { ...hit, slot: hit.slot + i };
      }
      return best;
    }
    const use = targets.slice(0, LABEL_RAY_SLOTS);
    if (!use.length) return null;
    return await this.serialise(async () => {
      const u = new Float32Array(60);   // 44 floats + 2 x 8 u32 visibility masks
      u.set(use[0].p2t as unknown as Float32Array, 0);
      u.set((use[1] ?? use[0]).p2t as unknown as Float32Array, 16);
      const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      u[32] = origin[0]; u[33] = origin[1]; u[34] = origin[2]; u[35] = 1;
      u[36] = dir[0] / L; u[37] = dir[1] / L; u[38] = dir[2] / L; u[39] = 0;
      u[40] = Math.max(stepMm, 0.01); u[41] = use.length;
      // The visibility masks: 8 u32 per slot at 44 and 52. Written through a Uint32Array view of the
      // same buffer, because these are bit patterns and must not go through float conversion.
      const bits = new Uint32Array(u.buffer, u.byteOffset, u.length);
      bits.fill(0, 44, 60);
      use.forEach((tgt, i) => {
        if (!tgt.visible) return;                     // no mask at all: leave zero, meaning all visible
        const base = 44 + i * 8;
        for (let w = 0; w < 8 && w < tgt.visible.length; w++) bits[base + w] = tgt.visible[w];
        bits[base] |= 1;                              // bit 0: "a mask was supplied", set here so no caller has to remember
      });
      this.dev.queue.writeBuffer(this.uni, 0, u);
      // Clear the hit flag: the shader only ever writes it on a hit, so a stale 1 from the previous
      // ray would be read back as this ray's answer.
      this.dev.queue.writeBuffer(this.out, 0, new Uint32Array([0, 0, 0, 0, 0, 0, 0, 0]));

      const bind = this.dev.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uni } },
          { binding: 1, resource: use[0].labels.createView() },
          { binding: 2, resource: (use[1]?.labels ?? this.noLabels()).createView() },
          { binding: 3, resource: { buffer: this.out } },
        ],
      });
      const enc = this.dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end();
      enc.copyBufferToBuffer(this.out, 0, this.read, 0, 32);
      this.dev.queue.submit([enc.finish()]);
      await this.read.mapAsync(GPUMapMode.READ);
      const raw = this.read.getMappedRange().slice(0);
      this.read.unmap();
      const iv = new Uint32Array(raw), fv = new Float32Array(raw);
      if (!iv[0]) return null;
      const t = fv[4];
      return {
        slot: iv[1],
        label: iv[2],
        tMm: t,
        ras: [origin[0] + (dir[0] / L) * t, origin[1] + (dir[1] / L) * t, origin[2] + (dir[2] / L) * t] as Vec3,
      };
    });
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  destroy() {
    this.uni.destroy(); this.out.destroy(); this.read.destroy(); this.empty?.destroy();
  }
}
