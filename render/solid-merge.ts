// SEVERAL SEGMENTATIONS AS ONE LABEL IMAGE, on the graphics card, for the solid look.
//
// Why merge. The solid look (colorize-field.ts, setSolid) reads five or six images per set of
// structures, and the card in the application's window lets one drawing step read sixteen -- so one
// solid set per segmentation stopped at two or three segmentations, and Ron's scenes carry four
// (total, lung vessels, liver vessels, muscles). One merged image per VOXEL GRID is one set whatever
// the number of segmentations on that grid, and it needs no CT: a segmentation alone is drawn solid too.
// Ron, 2026-09-23: "1 then 2 then 3" -- the first being every segmentation solid, and label maps alone.
//
// Where two overlap, the one later in the inputs wins; the caller orders them by
// SegmentationDisplayableManager.drawOrder (livescene.ts), the same order the slice views draw in. A
// structure hidden in its segmentation is not written at all, so what is behind it shows.
//
// Each input is remapped from its own label numbers to one shared numbering (1..255) by a table; 0 in
// the table means "not written". The inputs must share the output's voxel grid -- the caller groups
// segmentations by grid.

import { releaseSolidScratch, solidScratch } from "./solid-scratch.ts";

const MERGE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src : texture_3d<u32>;
@group(0) @binding(1) var<storage, read> remap : array<u32, 256>;
@group(0) @binding(2) var<storage, read_write> dst : array<u32>;
@group(0) @binding(3) var<uniform> P : vec4<u32>;     // nx, ny, nz, words per row
@group(0) @binding(4) var<uniform> F : vec4<u32>;     // first input (1: start from nothing)
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= P.w || id.y >= P.y || id.z >= P.z) { return; }
  let wi = (id.z * P.y + id.y) * P.w + id.x;
  var word = select(dst[wi], 0u, F.x == 1u);
  for (var b = 0u; b < 4u; b = b + 1u) {
    let x = id.x * 4u + b;
    if (x >= P.x) { continue; }
    let g = remap[textureLoad(src, vec3<i32>(i32(x), i32(id.y), i32(id.z)), 0).r & 255u];
    if (g != 0u) { word = (word & ~(255u << (8u * b))) | (g << (8u * b)); }
  }
  dst[wi] = word;
}`;

const pipes = new WeakMap<GPUDevice, GPUComputePipeline>();

/** An r8uint 3D texture the merge writes and a ColorizeField adopts. The caller owns it. */
export function makeMergedLabelTexture(dev: GPUDevice, dims: readonly [number, number, number]): GPUTexture {
  return dev.createTexture({
    label: "merged labels (solid look)", size: dims as [number, number, number], dimension: "3d", format: "r8uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
}

/**
 * Write `inputs` into `out` in order, each over the ones before it, through its remap table (256
 * entries: its label -> the shared number, 0 = leave what is there). Submits its own work.
 */
export function mergeLabels(dev: GPUDevice, inputs: { labels: GPUTexture; remap: Uint32Array }[], dims: readonly [number, number, number], out: GPUTexture): void {
  let pipe = pipes.get(dev);
  if (!pipe) {
    pipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: MERGE_WGSL }), entryPoint: "main" } });
    pipes.set(dev, pipe);
  }
  const [nx, ny, nz] = dims;
  const rowBytes = Math.ceil(nx / 256) * 256;               // copyBufferToTexture wants rows of 256 bytes
  const words = rowBytes / 4;
  const buf = solidScratch(dev, "a", rowBytes * ny * nz);   // shared with the smoothing that follows (solid-scratch.ts)
  const P = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  dev.queue.writeBuffer(P, 0, new Uint32Array([nx, ny, nz, words]));
  const temps: GPUBuffer[] = [P];
  const enc = dev.createCommandEncoder({ label: "merge labels" });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  inputs.forEach((inp, i) => {
    const r = dev.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(r, 0, inp.remap);
    const f = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(f, 0, new Uint32Array([i === 0 ? 1 : 0, 0, 0, 0]));
    temps.push(r, f);
    pass.setBindGroup(0, dev.createBindGroup({ layout: pipe!.getBindGroupLayout(0), entries: [
      { binding: 0, resource: inp.labels.createView() }, { binding: 1, resource: { buffer: r } },
      { binding: 2, resource: { buffer: buf } }, { binding: 3, resource: { buffer: P } }, { binding: 4, resource: { buffer: f } },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(words / 64), ny, nz);
  });
  pass.end();
  enc.copyBufferToTexture({ buffer: buf, bytesPerRow: rowBytes, rowsPerImage: ny }, { texture: out }, [nx, ny, nz]);
  dev.queue.submit([enc.finish()]);
  for (const t of temps) t.destroy();
  releaseSolidScratch(dev);
}
