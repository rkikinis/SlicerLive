// GROW BY THE CHEAPEST PATH: each voxel goes to the seed it reaches with the smallest sum of brightness steps along
// the way. The rule is Slicer's Grow from seeds, with Seed locality at 0 (SegmentEditorGrowFromSeedsEffect.py:112 calls
// vtkITK.vtkITKGrowCut, Libs/vtkITK/vtkITKGrowCut.cxx:105,143-144 runs ITK's FastGrowCut, itkFastGrowCut.hxx:270 sums the
// steps) over all 26 neighbors of a voxel (itkFastGrowCut.hxx:93-106). THE NEIGHBORS COUNT: with 6 (the first version,
// 2026-11-01, rule 2 of GROW_RULE_VERSION) the same box and seeds on the Prisma T1 differed from Slicer's by 16,728
// voxels, Dice 0.804 (qa/2026-11-06-editor-and-load-save.md, finding 7). Ron, 2026-11-06: "26 is the way to go" (rule 3). Slicer
// finds the paths with a heap (Dijkstra); here every voxel takes the cheapest of its neighbors' offers, over and over
// on the graphics card, until nothing changes.
//
// Why it replaces Steve's GrowCut (growcut.ts) for the editor (2026-11-01, Ron's ventricles on the Prisma T1 did not
// fill): GrowCut stops at an edge only where ONE step between neighbors exceeds a share of the image's range (15 %,
// from the box's brightest voxel). On that T1 the box's range was 1305, so the share was 196, and every step across the
// ventricle wall was below it (median 47, 90th percentile 82: the wall is spread over two or three voxels). Nothing
// damped the grow, and inside and outside split the box by distance alone. Summing the steps counts a soft wall as
// fully as a sharp one. Measured in numpy on that T1 with FastSurfer's ventricles as the reference and seeds like
// Ron's: GrowCut covered 25 % of the ventricles, the summed steps 84 % (scratch script grow-vent/sim.py; the record in
// Contents/docs/SEGMENT-EDITOR.md).
//
// Buffers, not textures: the image (f32), and the state (cost, label) twice, ping-ponged; a counter of changed voxels
// is read every `checkEvery` passes to stop.

const PASS_WGSL = /* wgsl */ `
struct U { dims : vec4<u32>, stride : u32, n : u32, pad0 : u32, pad1 : u32 };
@group(0) @binding(0) var<storage, read> img : array<f32>;
@group(0) @binding(1) var<storage, read> src : array<vec2<f32>>;      // (cost, label)
@group(0) @binding(2) var<storage, read_write> dst : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> changed : atomic<u32>;
@group(0) @binding(4) var<uniform> u : U;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.y * u.stride + gid.x;
  if (i >= u.n) { return; }
  let nx = u.dims.x; let ny = u.dims.y; let nz = u.dims.z;
  let x = i % nx; let y = (i / nx) % ny; let z = i / (nx * ny);
  let me = img[i];
  var best = src[i];
  let was = best.x;
  if (x > 0u)      { let j = i - 1u;       let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  if (x + 1u < nx) { let j = i + 1u;       let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  if (y > 0u)      { let j = i - nx;       let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  if (y + 1u < ny) { let j = i + nx;       let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  if (z > 0u)      { let j = i - nx * ny;  let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  if (z + 1u < nz) { let j = i + nx * ny;  let c = src[j].x + abs(me - img[j]); if (c < best.x) { best = vec2<f32>(c, src[j].y); } }
  dst[i] = best;
  if (best.x < was) { atomicAdd(&changed, 1u); }
}`;

/** The same pass over all 26 neighbors (Slicer's). */
const PASS26_WGSL = /* wgsl */ `
struct U { dims : vec4<u32>, stride : u32, n : u32, pad0 : u32, pad1 : u32 };
@group(0) @binding(0) var<storage, read> img : array<f32>;
@group(0) @binding(1) var<storage, read> src : array<vec2<f32>>;      // (cost, label)
@group(0) @binding(2) var<storage, read_write> dst : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> changed : atomic<u32>;
@group(0) @binding(4) var<uniform> u : U;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.y * u.stride + gid.x;
  if (i >= u.n) { return; }
  let nx = i32(u.dims.x); let ny = i32(u.dims.y); let nz = i32(u.dims.z);
  let ii = i32(i);
  let x = ii % nx; let y = (ii / nx) % ny; let z = ii / (nx * ny);
  let me = img[i];
  var best = src[i];
  let was = best.x;
  let z0 = max(z - 1, 0); let z1 = min(z + 1, nz - 1);
  let y0 = max(y - 1, 0); let y1 = min(y + 1, ny - 1);
  let x0 = max(x - 1, 0); let x1 = min(x + 1, nx - 1);
  for (var c = z0; c <= z1; c = c + 1) {
    for (var b = y0; b <= y1; b = b + 1) {
      let row = (c * ny + b) * nx;
      for (var a = x0; a <= x1; a = a + 1) {
        let j = row + a;
        if (j == ii) { continue; }
        let o = src[j];
        let d = o.x + abs(me - img[j]);
        if (d < best.x) { best = vec2<f32>(d, o.y); }
      }
    }
  }
  dst[i] = best;
  if (best.x < was) { atomicAdd(&changed, 1u); }
}`;

const FAR = 1e30;
const WG = 256;

/**
 * Grow `seeds` (a label per voxel, 0 = none) over `image` on the grid `dims` (x fastest). Returns the label per voxel
 * and the passes run. Every voxel connected to a seed gets a label.
 */
export async function growByPath(device: GPUDevice, seeds: ArrayLike<number>, image: ArrayLike<number>, dims: [number, number, number], opts: { checkEvery?: number; maxPasses?: number; neighbors?: 6 | 26 } = {}): Promise<{ labels: Uint8Array; passes: number }> {
  const [nx, ny, nz] = dims, n = nx * ny * nz;
  // A batch of passes is one submit: on a large box 32 passes of 26 reads a voxel held the card for 0.94 s (46 M voxels, under load),
  // beside a 3D view that must keep drawing. Fewer passes a submit there, the same work.
  const checkEvery = opts.checkEvery ?? Math.max(4, Math.min(32, Math.floor(3.2e8 / n)));
  const maxPasses = opts.maxPasses ?? 40 * (nx + ny + nz);   // a safety stop; the counter stops it long before
  const img = Float32Array.from(image as ArrayLike<number>);
  const state = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { const s = seeds[i]; state[2 * i] = s ? 0 : FAR; state[2 * i + 1] = s; }

  const S = GPUBufferUsage.STORAGE;
  const imgBuf = device.createBuffer({ size: img.byteLength, usage: S | GPUBufferUsage.COPY_DST });
  const a = device.createBuffer({ size: state.byteLength, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const b = device.createBuffer({ size: state.byteLength, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const counter = device.createBuffer({ size: 4, usage: S | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const counterRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const uni = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const groups = Math.ceil(n / WG), gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
  device.queue.writeBuffer(imgBuf, 0, img);
  device.queue.writeBuffer(a, 0, state);
  device.queue.writeBuffer(b, 0, state);
  device.queue.writeBuffer(uni, 0, new Uint32Array([nx, ny, nz, 0, gx * WG, n, 0, 0]));
  const pipe = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: opts.neighbors === 6 ? PASS_WGSL : PASS26_WGSL }), entryPoint: "main" } });
  const bind = (src: GPUBuffer, dst: GPUBuffer) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: imgBuf } }, { binding: 1, resource: { buffer: src } }, { binding: 2, resource: { buffer: dst } },
    { binding: 3, resource: { buffer: counter } }, { binding: 4, resource: { buffer: uni } }] });
  const ab = bind(a, b), ba = bind(b, a);
  try {
    let passes = 0, inA = true;
    while (passes < maxPasses) {
      device.queue.writeBuffer(counter, 0, new Uint32Array([0]));
      const enc = device.createCommandEncoder();
      for (let k = 0; k < checkEvery; k++) {
        const p = enc.beginComputePass();
        p.setPipeline(pipe); p.setBindGroup(0, inA ? ab : ba); p.dispatchWorkgroups(gx, gy); p.end();
        inA = !inA; passes++;
      }
      enc.copyBufferToBuffer(counter, 0, counterRead, 0, 4);
      device.queue.submit([enc.finish()]);
      await counterRead.mapAsync(GPUMapMode.READ);
      const changed = new Uint32Array(counterRead.getMappedRange())[0];
      counterRead.unmap();
      if (changed === 0) break;
    }
    const out = inA ? a : b;
    const read = device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(out, 0, read, 0, state.byteLength);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(read.getMappedRange());
    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) labels[i] = f[2 * i + 1];
    read.unmap(); read.destroy();
    return { labels, passes };
  } finally {
    imgBuf.destroy(); a.destroy(); b.destroy(); counter.destroy(); counterRead.destroy(); uni.destroy();
  }
}
