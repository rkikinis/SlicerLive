// THE EXPERIMENT RON ASKED FOR: surface nets on the graphics card, on a real checkpoint labelmap,
// compared triangle for triangle and second for second with the code that ships.
//
//   deno run -A --unstable-webgpu --v8-flags=--max-old-space-size=12000 \
//     algorithms/surface-nets.gpu-bench.ts [labelmap.nrrd] [--gpu-only]
//
// Defaults to the whole-body abdominal-muscles checkpoint. `--gpu-only` skips the CPU run (which
// costs ~10 s and most of the memory) when only the GPU numbers are wanted.
//
// WHAT IS COMPARED: the number of triangles each label gets. That is the whole mesh up to vertex
// numbering and quad order, both of which the porting brief in surface-nets.ts says are free to
// differ. What is NOT compared is smoothing, the per-label split and the normals -- phases 3 and 4,
// which the GPU version does not do yet. The bench prints what share of the CPU's time those are,
// so the result cannot be read as more than it is.
import { parseNrrd } from "../render/nrrd.ts";
import { surfaceNets } from "./surface-nets.ts";
import { surfaceNetsGpu } from "./surface-nets-gpu.ts";

const DEFAULT_CASE = new URL(
  "../../../Slicer/SlicerDICOMDatabase/SlicerAlbula-Checkpoints/2026-09-22T11-35-23-792Z-ts.v2_abdominal_muscles.seg.nrrd",
  import.meta.url,
).pathname;

const args = Deno.args.filter((a) => !a.startsWith("--"));
const gpuOnly = Deno.args.includes("--gpu-only");
const file = args[0] ?? DEFAULT_CASE;

let raw: Uint8Array;
try {
  raw = await Deno.readFile(file);
} catch {
  console.error(`no labelmap at ${file} — pass one, or use a checkpoint from SlicerAlbula-Checkpoints/`);
  Deno.exit(1);
}
const n = await parseNrrd(raw);
const dims = n.dims as [number, number, number];
// parseNrrd hands back whatever the file's type says -- Float32Array for these checkpoints -- and
// the CPU extractor takes any ArrayLike. The card needs actual bytes. The APPLICATION never pays
// this: its labelmap is a Uint8Array from the SEG decode and is already on the card as r8uint.
const src = n.data as unknown as ArrayLike<number>;
const tConv = performance.now();
let lab: Uint8Array;
if (src instanceof Uint8Array) lab = src;
else {
  lab = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) lab[i] = src[i];
}
const msConvert = performance.now() - tConv;
const m = n.ijkToRAS as number[];
const sp = [0, 1, 2].map((c) => Math.hypot(m[c], m[4 + c], m[8 + c]));

console.log(file.split("/").pop());
console.log(`  ${dims.join(" x ")} = ${(dims[0] * dims[1] * dims[2] / 1e6).toFixed(0)}M voxels, ` +
  `${sp.map((v) => v.toFixed(2)).join(" x ")} mm`);
if (msConvert > 1) console.log(`  (the file's samples are ${(n.data as unknown as { constructor: { name: string } }).constructor.name}; ` +
  `${(msConvert / 1000).toFixed(2)}s to make bytes of them, which the app never pays)`);
console.log("");

// ── the graphics card ──
// Smoothing on the card too (phase 3), and the pieces the check below needs.
const check = !Deno.args.includes("--no-check");
const g = await surfaceNetsGpu(lab, dims, {
  smoothIters: 24, labelMeshes: true, keepMeshes: check, ijkToRAS: m, normalSmooth: 16,
  keepPositions: check, keepQuads: check,
});
const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const gpuTris = [...g.trianglesByLabel.values()].reduce((a, b) => a + b, 0);

console.log("GPU (WGSL compute, phases 1-4 — the whole extraction)");
console.log(`  upload the labelmap to the card   ${s(g.ms.upload)}   (already paid in the app: the`);
console.log(`                                              colorize baker put it there)`);
console.log(`  A  which cells the surface crosses ${s(g.ms.active)}`);
console.log(`  B  prefix sum over the block counts ${s(g.ms.scan)}`);
console.log(`  C  place one vertex per active cell ${s(g.ms.vertices)}`);
console.log(`  D  count the quads                 ${s(g.ms.countQuads)}`);
console.log(`     write the quads                 ${s(g.ms.writeQuads)}`);
console.log(`  E  build the vertex adjacency      ${s(g.ms.adjacency)}`);
console.log(`  F  Taubin smoothing, 24 iterations ${s(g.ms.smooth)}`);
console.log(`  G  split into one mesh per label   ${s(g.ms.split)}`);
console.log(`  H  normals, and 16 smoothing passes ${s(g.ms.normals)}`);
console.log(`  TOTAL, phases 1-4                  ${s(g.ms.total)}`);
console.log(`  vertices ${g.vertices.toLocaleString()}, quads ${g.quads.toLocaleString()}, ` +
  `triangles ${gpuTris.toLocaleString()}, labels ${g.trianglesByLabel.size}`);
console.log(`  held on the card: mask ${mb(g.bytes.mask)} + block counts ${mb(g.bytes.blockCounts)} + ` +
  `vertices ${mb(g.bytes.vertices)} + quads ${mb(g.bytes.quads)}`);

// ── is the smoothing right? The same maths on the processor, over the GPU's own vertices and
// adjacency, in double precision — so this compares the arithmetic and nothing else.
if (check && g.positionsRaw && g.quadsData && g.vertices) {
  const nv = g.vertices, qd = g.quadsData;
  const deg = new Uint32Array(nv);
  for (let t = 0; t < g.quads; t++) {
    const o = t * 6 + 2;
    for (let e = 0; e < 4; e++) { deg[qd[o + e]]++; deg[qd[o + ((e + 1) & 3)]]++; }
  }
  const off = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[nv]);
  const cur = off.slice(0, nv);
  for (let t = 0; t < g.quads; t++) {
    const o = t * 6 + 2;
    for (let e = 0; e < 4; e++) {
      const u = qd[o + e], v = qd[o + ((e + 1) & 3)];
      adj[cur[u]++] = v; adj[cur[v]++] = u;
    }
  }
  let px = Float64Array.from(g.positionsRaw);
  let qx = new Float64Array(px.length);
  const step = (f: number) => {
    for (let i = 0; i < nv; i++) {
      const s0 = off[i], e0 = off[i + 1], d = e0 - s0;
      if (!d) { qx[i * 3] = px[i * 3]; qx[i * 3 + 1] = px[i * 3 + 1]; qx[i * 3 + 2] = px[i * 3 + 2]; continue; }
      let ax = 0, ay = 0, az = 0;
      for (let t = s0; t < e0; t++) { const m2 = adj[t] * 3; ax += px[m2]; ay += px[m2 + 1]; az += px[m2 + 2]; }
      qx[i * 3] = px[i * 3] + f * (ax / d - px[i * 3]);
      qx[i * 3 + 1] = px[i * 3 + 1] + f * (ay / d - px[i * 3 + 1]);
      qx[i * 3 + 2] = px[i * 3 + 2] + f * (az / d - px[i * 3 + 2]);
    }
    [px, qx] = [qx, px];
  };
  for (let t = 0; t < 24; t++) { step(0.6); step(-0.62); }
  let worst = 0, sum = 0;
  for (let i = 0; i < px.length; i++) { const dlt = Math.abs(px[i] - g.positions![i]); sum += dlt; if (dlt > worst) worst = dlt; }
  const vox = Math.min(...sp);
  console.log(`\nsmoothing checked against the same maths in double precision on the processor:`);
  console.log(`  worst vertex moved ${(worst * vox * 1000).toFixed(3)} micrometers, mean ${(sum / px.length * vox * 1000).toFixed(4)} — f32 against f64`);
}

if (gpuOnly) Deno.exit(0);

// ── the code that ships ──
const t0 = performance.now();
let tExtract = 0;
const meshes = surfaceNets(lab, dims, m, {
  onProgress: (done, total) => { if (done === total) tExtract = performance.now() - t0; },
});
const total = performance.now() - t0;
const cpuTris = meshes.reduce((a, x) => a + x.indices.length / 3, 0);

// The same run again with the Taubin smoothing turned off, so the comparison can be like for like:
// what it costs is the difference, and everything else is identical work.
const t1 = performance.now();
let tExtract2 = 0;
surfaceNets(lab, dims, m, { smoothIters: 0, onProgress: (done, tot) => { if (done === tot) tExtract2 = performance.now() - t1; } });
const restNoSmooth = performance.now() - t1 - tExtract2;
const cpuTaubin = (total - tExtract) - restNoSmooth;

console.log("\nCPU (the shipping code, this engine)");
console.log(`  phases 1-2  extraction             ${s(tExtract)}`);
console.log(`  phase 3     Taubin smoothing       ${s(cpuTaubin)}`);
console.log(`  phase 4     per-label split + normals ${s(restNoSmooth)}`);
console.log(`  TOTAL                              ${s(total)}`);
console.log(`  triangles ${cpuTris.toLocaleString()}, labels ${meshes.length}`);

// ── triangle for triangle ──
let same = 0;
const diffs: string[] = [];
for (const mesh of meshes) {
  const gpu = g.trianglesByLabel.get(mesh.label) ?? 0;
  const cpu = mesh.indices.length / 3;
  if (gpu === cpu) same++;
  else diffs.push(`    label ${mesh.label}: CPU ${cpu.toLocaleString()} vs GPU ${gpu.toLocaleString()}`);
}
for (const [l, t] of g.trianglesByLabel) {
  if (!meshes.some((x) => x.label === l)) diffs.push(`    label ${l}: only on the GPU (${t.toLocaleString()})`);
}

console.log(`\nTRIANGLE FOR TRIANGLE: ${same} of ${meshes.length} labels identical` +
  (diffs.length ? `, ${diffs.length} not:\n${diffs.join("\n")}` : ""));
console.log(`total ${cpuTris === gpuTris ? "IDENTICAL" : `DIFFERENT: CPU ${cpuTris.toLocaleString()} vs GPU ${gpuTris.toLocaleString()}`}`);

// ── the meshes themselves: area, extent and shading, which do not depend on vertex numbering ──
//
// Vertex ORDER differs by construction (the CPU numbers on first use, the card by a prefix sum), so
// comparing vertex n with vertex n means nothing. What does mean something: how much surface each
// label has, where it is, and whether the normals point the same way and are as smooth.
if (g.meshes) {
  const area = (mesh: { positions: Float32Array; indices: Uint32Array }) => {
    let a = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const i0 = mesh.indices[t] * 3, i1 = mesh.indices[t + 1] * 3, i2 = mesh.indices[t + 2] * 3;
      const ux = mesh.positions[i1] - mesh.positions[i0], uy = mesh.positions[i1 + 1] - mesh.positions[i0 + 1], uz = mesh.positions[i1 + 2] - mesh.positions[i0 + 2];
      const wx = mesh.positions[i2] - mesh.positions[i0], wy = mesh.positions[i2 + 1] - mesh.positions[i0 + 1], wz = mesh.positions[i2 + 2] - mesh.positions[i0 + 2];
      a += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    }
    return a;
  };
  /** Mean angle between a face's own normal and its corners' — catches a flipped or wrong normal. */
  const facing = (mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) => {
    let acc = 0, cnt = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const i0 = mesh.indices[t] * 3, i1 = mesh.indices[t + 1] * 3, i2 = mesh.indices[t + 2] * 3;
      const ux = mesh.positions[i1] - mesh.positions[i0], uy = mesh.positions[i1 + 1] - mesh.positions[i0 + 1], uz = mesh.positions[i1 + 2] - mesh.positions[i0 + 2];
      const wx = mesh.positions[i2] - mesh.positions[i0], wy = mesh.positions[i2 + 1] - mesh.positions[i0 + 1], wz = mesh.positions[i2 + 2] - mesh.positions[i0 + 2];
      const px = uy * wz - uz * wy, py = uz * wx - ux * wz, pz = ux * wy - uy * wx;
      const L = Math.hypot(px, py, pz) || 1;
      acc += (px / L) * mesh.normals[i0] + (py / L) * mesh.normals[i0 + 1] + (pz / L) * mesh.normals[i0 + 2];
      cnt++;
    }
    return acc / cnt;
  };
  let worstArea = 0, worstFace = 0, vertsSame = 0;
  for (const c of meshes) {
    const gm = g.meshes.find((x) => x.label === c.label);
    if (!gm) { console.log(`  label ${c.label}: missing from the GPU meshes`); continue; }
    if (gm.positions.length === c.positions.length) vertsSame++;
    const ac = area(c), ag = area(gm);
    worstArea = Math.max(worstArea, Math.abs(ac - ag) / (ac || 1));
    worstFace = Math.max(worstFace, Math.abs(facing(c) - facing(gm)));
  }
  console.log(`\nTHE MESHES: ${vertsSame} of ${meshes.length} labels have the same vertex count; ` +
    `worst surface-area difference ${(worstArea * 100).toFixed(4)}%; ` +
    `worst difference in how the normals face ${worstFace.toFixed(5)}`);
}

void cpuTaubin; void restNoSmooth;
console.log(`\nTHE WHOLE EXTRACTION, END TO END:`);
console.log(`  processor ${s(total)}   card ${s(g.ms.total)}   ${(total / g.ms.total).toFixed(1)}x`);
console.log(`With the upload counted (the app does not pay it: the labelmap is already on the card): ${s(g.ms.total + g.ms.upload)}`);
