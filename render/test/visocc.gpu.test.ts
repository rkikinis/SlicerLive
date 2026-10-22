// THE SOLID LOOK'S EIGHT-NEIGHBOR READ, BIT FOR BIT (render/colorize-field.ts, visocc). Written out without arrays on
// 2026-10-16 for Safari's speed (C3N-01524, a third faster); the critic's comparison then found 7 of 655,360 points where a
// tie went the other way (a long sum the compiler could reorder). This test keeps the loop version as it was (35d6705) and
// runs it beside the function the app generates, over label grids with ties, hidden labels, high label values and points
// outside the scan, and compares the output bits. The critic's script (scratchpad, critic/visocc-equiv3.ts) is its origin.
//
//   deno test -A --no-check --unstable-webgpu render/test/visocc.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ColorizeField } from "../colorize-field.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

const OLD = `
fn visocc_clz0(wp : vec3<f32>) -> vec2<f32> {
  // OUTSIDE THE SCAN THERE IS NOTHING. The voxel reads below clamp to the edge, so without this the
  // last slice repeated outward and the femurs ran on as tubes past the end of the scan (Ron,
  // 2026-09-23: "There is an artifact at the bottom end of the rendering"). With it, a structure
  // cut by the edge is closed there by a flat end, as a surface model is.
  let t0 = tex_clz0(wp);
  if (any(t0 < vec3<f32>(0.0)) || any(t0 > vec3<f32>(1.0))) { return vec2<f32>(0.0); }
  let d = u_material.clz0_dims.xyz;
  let p = t0 * d - vec3<f32>(0.5);
  let b = floor(p);
  let f = p - b;
  var labs : array<i32, 8>;
  var ws : array<f32, 8>;
  var n = 0;
  var occ = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let c = vec3<f32>(f32(i & 1), f32((i >> 1) & 1), f32((i >> 2) & 1));
    let w = ((1.0 - c.x) + (2.0 * c.x - 1.0) * f.x)
          * ((1.0 - c.y) + (2.0 * c.y - 1.0) * f.y)
          * ((1.0 - c.z) + (2.0 * c.z - 1.0) * f.z);
    let vi = vec3<i32>(clamp(b + c, vec3<f32>(0.0), d - vec3<f32>(1.0)));
    let lab = i32(textureLoad(t_lab_clz0, vi, 0).r);
    if (lab <= 0) { continue; }
    if (u_material.clz0_params.w < 1.5 && textureLoad(t_lut_clz0, vec2<i32>(lab, 1), 0).a <= 0.001) { continue; }
    occ = occ + w;
    var found = false;
    for (var j = 0; j < n; j = j + 1) { if (labs[j] == lab) { ws[j] = ws[j] + w; found = true; break; } }
    if (!found) { labs[n] = lab; ws[n] = w; n = n + 1; }
  }
  var best = 0; var bw = -1.0;
  for (var j = 0; j < n; j = j + 1) { if (ws[j] > bw) { bw = ws[j]; best = labs[j]; } }
  return vec2<f32>(occ, f32(best));
}
`.replace("fn visocc_clz0(", "fn visocc_old(");

function appVisocc(): string {
  const w = (ColorizeField.prototype as unknown as { samplingWGSL(s: number): string }).samplingWGSL.call({}, 0);
  const i = w.indexOf("fn visocc_clz0(");
  const j = w.indexOf("\n/**", i);
  return w.slice(i, j).replace("fn visocc_clz0(", "fn visocc_new(");
}

Deno.test({
  name: "the solid look's eight-neighbor read gives the same bits as the loop it replaced",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const WGSL = `
struct M { clz0_params : vec4<f32>, clz0_dims : vec4<f32> };
@group(0) @binding(0) var<uniform> u_material : M;
@group(0) @binding(1) var t_lab_clz0 : texture_3d<u32>;
@group(0) @binding(2) var t_lut_clz0 : texture_2d<f32>;
@group(0) @binding(3) var<storage, read> pts : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outv : array<vec4<u32>>;
fn tex_clz0(wp : vec3<f32>) -> vec3<f32> { return wp; }
${OLD}
${appVisocc()}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g : vec3<u32>) {
  let i = g.x; if (i >= arrayLength(&pts)) { return; }
  let a = visocc_old(pts[i].xyz); let b = visocc_new(pts[i].xyz);
  outv[i] = vec4<u32>(bitcast<u32>(a.x), bitcast<u32>(a.y), bitcast<u32>(b.x), bitcast<u32>(b.y));
}`;
    const adapter = await navigator.gpu.requestAdapter();
    const dev = await adapter!.requestDevice();
    dev.pushErrorScope("validation");
    const pipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: WGSL }), entryPoint: "main" } });
    let rng = 12345; const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const dims = [7, 5, 6];
    const LABS = [0, 0, 1, 2, 3, 127, 128, 129, 200, 254, 255];
    let total = 0, diffs = 0;
    for (const pw of [1.0, 2.0]) for (let trial = 0; trial < 40; trial++) {
      const nvox = dims[0] * dims[1] * dims[2];
      const lab = new Uint8Array(nvox); for (let k = 0; k < nvox; k++) lab[k] = LABS[Math.floor(rnd() * LABS.length)];
      const lut = new Uint8Array(256 * 4 * 4); for (let k = 0; k < 256 * 4; k++) lut[k * 4 + 3] = 255;
      for (const h of [2, 128, 255]) lut[(1 * 256 + h) * 4 + 3] = rnd() < 0.5 ? 0 : 255;   // some labels hidden
      const labTex = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      const bpr = 256; const up = new Uint8Array(bpr * dims[1] * dims[2]);
      for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) up[(z * dims[1] + y) * bpr + x] = lab[(z * dims[1] + y) * dims[0] + x];
      dev.queue.writeTexture({ texture: labTex }, up, { bytesPerRow: bpr, rowsPerImage: dims[1] }, dims);
      const lutTex = dev.createTexture({ size: [256, 4], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      dev.queue.writeTexture({ texture: lutTex }, lut, { bytesPerRow: 256 * 4 }, [256, 4]);
      const N = 8192; const pts = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) for (let c = 0; c < 3; c++) {
        const r = rnd();
        // voxel centers and half-way points (exact ties), the scan's edges, just outside it, and anywhere
        pts[k * 4 + c] = r < 0.25 ? (Math.floor(rnd() * dims[c]) + 0.5) / dims[c] : r < 0.5 ? Math.floor(rnd() * (dims[c] + 1)) / dims[c]
          : r < 0.55 ? (rnd() < 0.5 ? 0 : 1) : r < 0.6 ? -0.02 + rnd() * 0.02 + (rnd() < 0.5 ? 0 : 1.02) : rnd();
      }
      const pb = dev.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(pb, 0, pts);
      const ob = dev.createBuffer({ size: N * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const rb = dev.createBuffer({ size: N * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const ub = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ub, 0, new Float32Array([10, 0, 0.55, pw, dims[0], dims[1], dims[2], 1]));   // params.w 1 reads the palette, 2 not
      const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: labTex.createView() }, { binding: 2, resource: lutTex.createView() },
        { binding: 3, resource: { buffer: pb } }, { binding: 4, resource: { buffer: ob } }] });
      const enc = dev.createCommandEncoder(); const cp = enc.beginComputePass(); cp.setPipeline(pipe); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(N / 64); cp.end();
      enc.copyBufferToBuffer(ob, 0, rb, 0, N * 16); dev.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ); const o = new Uint32Array(rb.getMappedRange().slice(0)); rb.unmap();
      for (let k = 0; k < N; k++) { total++; if (o[k * 4] !== o[k * 4 + 2] || o[k * 4 + 1] !== o[k * 4 + 3]) diffs++; }
      for (const b of [pb, ob, rb, ub]) b.destroy(); labTex.destroy(); lutTex.destroy();
    }
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? "", "", "the card refused the comparison");
    assertEquals(diffs, 0, `${diffs} of ${total} points differ between the loop and the written-out read`);
  },
});
