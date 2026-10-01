// SURFACE NETS ON THE GRAPHICS CARD — the experiment, not the shipping path.
//
// Ron, 2026-09-22: "run the WGSL extraction experiment on the checkpoint labelmaps." The question
// behind it is whether the load can end on the card instead of crossing back to the processor:
// extraction is 15.0 s of his measured ~21 s, and the labelmap is ALREADY on the card as the
// r8uint texture the colorize baker uploaded.
//
// This is phases 1 and 2 of `surface-nets.ts` — the vertices and the quads — done in compute
// shaders, reading that same texture. Smoothing (phase 3), the per-label split and the normals
// (phase 4) are NOT here; the bench says plainly what share of the time that leaves on the table.
//
// WHAT IT KEEPS, because the porting brief in surface-nets.ts says these are not negotiable:
//
//  * ONE VERTEX PER CELL, shared by every label meeting in it. Not a per-label extraction.
//  * Native resolution.
//  * MEMORY FOLLOWS THE SURFACE, NEVER THE GRID. A cell-indexed u32 array over the test study is
//    1.67 GB and was OOM-killed once already. Here the per-cell state is ONE BIT (52 MB for 416
//    million cells) plus a per-block count (6.5 MB), and a cell's vertex number is recomputed from
//    those two by a prefix sum plus a popcount — never stored per cell.
//  * The winding rule: a face is emitted into both neighboring labels, reversed for the b side.
//    (Winding is carried in the quad record; the per-label split that uses it is phase 4.)
//
// WHAT IT DELIBERATELY CHANGES, per the same brief: vertex numbering is the prefix-sum order rather
// than scan order, and quads land in whatever order the atomics hand out. Neither changes the mesh.
//
// The shape of it, four dispatches over 416 million cells and 418 million voxels:
//
//   A  per cell: are the 8 corners all the same label? -> one bit, and a count per 256-cell block
//   B  exclusive prefix sum over those block counts (three levels, all on the card)
//   C  per cell: if active, its vertex number is blockOffset + popcount(bits before it), and its
//      position is the average of the midpoints of the edges whose two ends disagree
//   D  per voxel: three faces (+x, +y, +z); where the labels differ and all four surrounding cells
//      have a vertex, append a quad. Counted in one pass, written in a second, so the quad buffer
//      is exactly the right size rather than a guess.
import { initDevice } from "../render/device.ts";

export interface GpuNetsResult {
  vertices: number;
  quads: number;
  /** Triangles per label, as phase 4 would produce them: 2 per quad on each side that has a label. */
  trianglesByLabel: Map<number, number>;
  /** Vertex positions in IJK, 3 floats each — after smoothing when it ran. */
  positions?: Float32Array;
  /** The same vertices before smoothing, and the quads, for a bench that wants to check the maths. */
  positionsRaw?: Float32Array;
  quadsData?: Uint32Array;
  /** One mesh per label, as phase 4 produces them: positions in RAS, normals, local indices. */
  meshes?: { label: number; positions: Float32Array; normals: Float32Array; indices: Uint32Array }[];
  ms: {
    upload: number;
    active: number;
    scan: number;
    vertices: number;
    countQuads: number;
    writeQuads: number;
    adjacency: number;
    smooth: number;
    split: number;
    normals: number;
    total: number;
    readback: number;
  };
  bytes: { mask: number; blockCounts: number; vertices: number; quads: number };
}

const WG = 256;

const SHADER = /* wgsl */ `
struct Dims {
  nx: u32, ny: u32, nz: u32,
  cx: u32, cy: u32, cz: u32,
  cells: u32, voxels: u32,
  maskWords: u32, blocks: u32,
  quadCap: u32, pad: u32,
};
@group(0) @binding(0) var lab: texture_3d<u32>;
@group(0) @binding(1) var<uniform> d: Dims;
@group(0) @binding(2) var<storage, read_write> mask: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> blockCount: array<u32>;
@group(0) @binding(4) var<storage, read_write> verts: array<f32>;
@group(0) @binding(5) var<storage, read_write> quads: array<u32>;
@group(0) @binding(6) var<storage, read_write> counters: array<atomic<u32>>;   // 0: quads, 1..256: per label

fn labelAt(i: i32, j: i32, k: i32) -> u32 {
  return textureLoad(lab, vec3<i32>(i, j, k), 0).r;
}

/** A global index from a 2D workgroup grid: one dispatch can exceed 65535 workgroups in x. */
fn gindex(wid: vec3<u32>, nwg: vec3<u32>, lid: u32) -> u32 {
  return (wid.y * nwg.x + wid.x) * ${WG}u + lid;
}

var<workgroup> wgOn: atomic<u32>;

// ── A. which cells the surface passes through ────────────────────────────────────────────────────
@compute @workgroup_size(${WG})
fn markCells(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
          @builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid = lid3.x;
  if (lid == 0u) { atomicStore(&wgOn, 0u); }
  workgroupBarrier();
  let ci = gindex(wid, nwg, lid);
  var on = false;
  if (ci < d.cells) {
    let i = i32(ci % d.cx);
    let j = i32((ci / d.cx) % d.cy);
    let k = i32(ci / (d.cx * d.cy));
    let c0 = labelAt(i, j, k);
    on = labelAt(i + 1, j, k) != c0 || labelAt(i, j + 1, k) != c0 || labelAt(i + 1, j + 1, k) != c0
      || labelAt(i, j, k + 1) != c0 || labelAt(i + 1, j, k + 1) != c0
      || labelAt(i, j + 1, k + 1) != c0 || labelAt(i + 1, j + 1, k + 1) != c0;
    if (on) {
      atomicOr(&mask[ci >> 5u], 1u << (ci & 31u));
      atomicAdd(&wgOn, 1u);
    }
  }
  workgroupBarrier();
  // One block is one workgroup, so this count is exact and costs no global atomic.
  if (lid == 0u) { blockCount[wid.y * nwg.x + wid.x] = atomicLoad(&wgOn); }
}

// ── B. exclusive prefix sum, three levels ────────────────────────────────────────────────────────
@group(1) @binding(0) var<storage, read_write> src: array<u32>;
@group(1) @binding(1) var<storage, read_write> sums: array<u32>;
@group(1) @binding(2) var<uniform> n: vec4<u32>;                 // x = element count

var<workgroup> tile: array<u32, ${WG}>;

@compute @workgroup_size(${WG})
fn scanBlocks(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
              @builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid = lid3.x;
  let block = wid.y * nwg.x + wid.x;
  let idx = block * ${WG}u + lid;
  tile[lid] = select(0u, src[idx], idx < n.x);
  workgroupBarrier();
  // Hillis-Steele inclusive scan, then shifted to exclusive on write.
  var off = 1u;
  loop {
    if (off >= ${WG}u) { break; }
    var v = 0u;
    if (lid >= off) { v = tile[lid - off]; }
    workgroupBarrier();
    if (lid >= off) { tile[lid] = tile[lid] + v; }
    workgroupBarrier();
    off = off << 1u;
  }
  let inclusive = tile[lid];
  let exclusive = select(tile[lid - 1u], 0u, lid == 0u);
  if (idx < n.x) { src[idx] = exclusive; }
  if (lid == ${WG}u - 1u) { sums[block] = inclusive; }
}

/** Add each block's offset back into its elements. */
@compute @workgroup_size(${WG})
fn addOffsets(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
              @builtin(local_invocation_id) lid3: vec3<u32>) {
  let block = wid.y * nwg.x + wid.x;
  let idx = block * ${WG}u + lid3.x;
  if (idx < n.x) { src[idx] = src[idx] + sums[block]; }
}

// ── C. one vertex per active cell ────────────────────────────────────────────────────────────────
/** Where this cell's vertex sits in the output: its block's offset plus the active cells before it. */
fn vertexOf(ci: u32) -> u32 {
  let block = ci / ${WG}u;
  let w0 = block * (${WG}u / 32u);
  let word = ci >> 5u;
  var v = blockCount[block];
  var w = w0;
  loop {
    if (w >= word) { break; }
    v = v + countOneBits(atomicLoad(&mask[w]));
    w = w + 1u;
  }
  let bit = ci & 31u;
  let below = select((1u << bit) - 1u, 0u, bit == 0u);
  return v + countOneBits(atomicLoad(&mask[word]) & below);
}

fn hasVertex(ci: u32) -> bool {
  return (atomicLoad(&mask[ci >> 5u]) & (1u << (ci & 31u))) != 0u;
}

@compute @workgroup_size(${WG})
fn placeVertices(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
                 @builtin(local_invocation_id) lid3: vec3<u32>) {
  let ci = gindex(wid, nwg, lid3.x);
  if (ci >= d.cells) { return; }
  if (!hasVertex(ci)) { return; }
  let i = i32(ci % d.cx);
  let j = i32((ci / d.cx) % d.cy);
  let k = i32(ci / (d.cx * d.cy));
  var c: array<u32, 8>;
  c[0] = labelAt(i, j, k);           c[1] = labelAt(i + 1, j, k);
  c[2] = labelAt(i, j + 1, k);       c[3] = labelAt(i + 1, j + 1, k);
  c[4] = labelAt(i, j, k + 1);       c[5] = labelAt(i + 1, j, k + 1);
  c[6] = labelAt(i, j + 1, k + 1);   c[7] = labelAt(i + 1, j + 1, k + 1);
  // A label boundary is categorical -- nothing to interpolate -- so a crossing is the edge midpoint,
  // and the vertex is the average of the crossings. Same twelve edges, same order, as the CPU.
  var s = vec3<f32>(0.0, 0.0, 0.0);
  var cnt = 0.0;
  // along x: (0,1) (2,3) (4,5) (6,7)
  if (c[0] != c[1]) { s = s + vec3<f32>(0.5, 0.0, 0.0); cnt = cnt + 1.0; }
  if (c[2] != c[3]) { s = s + vec3<f32>(0.5, 1.0, 0.0); cnt = cnt + 1.0; }
  if (c[4] != c[5]) { s = s + vec3<f32>(0.5, 0.0, 1.0); cnt = cnt + 1.0; }
  if (c[6] != c[7]) { s = s + vec3<f32>(0.5, 1.0, 1.0); cnt = cnt + 1.0; }
  // along y: (0,2) (1,3) (4,6) (5,7)
  if (c[0] != c[2]) { s = s + vec3<f32>(0.0, 0.5, 0.0); cnt = cnt + 1.0; }
  if (c[1] != c[3]) { s = s + vec3<f32>(1.0, 0.5, 0.0); cnt = cnt + 1.0; }
  if (c[4] != c[6]) { s = s + vec3<f32>(0.0, 0.5, 1.0); cnt = cnt + 1.0; }
  if (c[5] != c[7]) { s = s + vec3<f32>(1.0, 0.5, 1.0); cnt = cnt + 1.0; }
  // along z: (0,4) (1,5) (2,6) (3,7)
  if (c[0] != c[4]) { s = s + vec3<f32>(0.0, 0.0, 0.5); cnt = cnt + 1.0; }
  if (c[1] != c[5]) { s = s + vec3<f32>(1.0, 0.0, 0.5); cnt = cnt + 1.0; }
  if (c[2] != c[6]) { s = s + vec3<f32>(0.0, 1.0, 0.5); cnt = cnt + 1.0; }
  if (c[3] != c[7]) { s = s + vec3<f32>(1.0, 1.0, 0.5); cnt = cnt + 1.0; }
  let p = vec3<f32>(f32(i), f32(j), f32(k)) + s / cnt;
  let o = vertexOf(ci) * 3u;
  verts[o] = p.x; verts[o + 1u] = p.y; verts[o + 2u] = p.z;
}

// ── D. quads ─────────────────────────────────────────────────────────────────────────────────────
/** The cell's vertex, or "none". Outside the cell grid is none, exactly as the CPU's cvAt. */
fn cellVertex(i: i32, j: i32, k: i32) -> u32 {
  if (i < 0 || j < 0 || k < 0 || i >= i32(d.cx) || j >= i32(d.cy) || k >= i32(d.cz)) { return 0xffffffffu; }
  let ci = (u32(k) * d.cy + u32(j)) * d.cx + u32(i);
  if (!hasVertex(ci)) { return 0xffffffffu; }
  return vertexOf(ci);
}

fn emit(write: bool, a: u32, b: u32, v0: u32, v1: u32, v2: u32, v3: u32) {
  if (v0 == 0xffffffffu || v1 == 0xffffffffu || v2 == 0xffffffffu || v3 == 0xffffffffu) { return; }
  let slot = atomicAdd(&counters[0], 1u);
  // Per-label counts are the comparison against the CPU: two triangles per quad on each side that
  // has a label of its own (background gets no mesh).
  if (a > 0u && a < 256u) { atomicAdd(&counters[a], 1u); }
  if (b > 0u && b < 256u) { atomicAdd(&counters[b], 1u); }
  if (!write || slot >= d.quadCap) { return; }
  let o = slot * 6u;
  quads[o] = a; quads[o + 1u] = b;
  quads[o + 2u] = v0; quads[o + 3u] = v1; quads[o + 4u] = v2; quads[o + 5u] = v3;
}

fn faces(write: bool, gid: u32) {
  if (gid >= d.voxels) { return; }
  let i = i32(gid % d.nx);
  let j = i32((gid / d.nx) % d.ny);
  let k = i32(gid / (d.nx * d.ny));
  let a = labelAt(i, j, k);
  if (i + 1 < i32(d.nx)) {
    let b = labelAt(i + 1, j, k);
    if (a != b) {
      emit(write, a, b, cellVertex(i, j - 1, k - 1), cellVertex(i, j, k - 1), cellVertex(i, j, k), cellVertex(i, j - 1, k));
    }
  }
  if (j + 1 < i32(d.ny)) {
    let b = labelAt(i, j + 1, k);
    if (a != b) {
      emit(write, a, b, cellVertex(i - 1, j, k - 1), cellVertex(i - 1, j, k), cellVertex(i, j, k), cellVertex(i, j, k - 1));
    }
  }
  if (k + 1 < i32(d.nz)) {
    let b = labelAt(i, j, k + 1);
    if (a != b) {
      emit(write, a, b, cellVertex(i - 1, j - 1, k), cellVertex(i, j - 1, k), cellVertex(i, j, k), cellVertex(i - 1, j, k));
    }
  }
}

@compute @workgroup_size(${WG})
fn countQuads(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
              @builtin(local_invocation_id) lid3: vec3<u32>) {
  faces(false, gindex(wid, nwg, lid3.x));
}

@compute @workgroup_size(${WG})
fn writeQuads(@builtin(workgroup_id) wid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>,
              @builtin(local_invocation_id) lid3: vec3<u32>) {
  faces(true, gindex(wid, nwg, lid3.x));
}
`;


const SMOOTH_SHADER = /* wgsl */ `
struct P { nv: u32, nq: u32, pad0: u32, pad1: u32, factor: f32, pad2: f32, pad3: f32, pad4: f32 };
@group(0) @binding(0) var<storage, read_write> deg: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read> quads: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var<storage, read_write> adj: array<u32>;
@group(0) @binding(4) var<storage, read> off: array<u32>;
@group(0) @binding(5) var<storage, read> degCopy: array<u32>;
@group(0) @binding(6) var<storage, read> posIn: array<f32>;
@group(0) @binding(7) var<storage, read_write> posOut: array<f32>;

fn gid(wid: vec3<u32>, nwg: vec3<u32>, lid: u32) -> u32 {
  return (wid.y * nwg.x + wid.x) * 256u + lid;
}

@compute @workgroup_size(256)
fn clearDeg(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gid(w, n, l.x);
  if (i < p.nv) { atomicStore(&deg[i], 0u); }
}

// THE SAME ADJACENCY THE CPU BUILDS, multiplicities included: every quad edge counts BOTH of its
// ends, so a neighbor reached by two edges is listed twice and the average weights it twice. That
// is not a quirk to clean up -- it is what the shipping smoothing does, and the comparison is only
// worth anything if both do the same thing.
@compute @workgroup_size(256)
fn countDeg(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let q = gid(w, n, l.x);
  if (q >= p.nq) { return; }
  let o = q * 6u + 2u;
  for (var e = 0u; e < 4u; e = e + 1u) {
    atomicAdd(&deg[quads[o + e]], 1u);
    atomicAdd(&deg[quads[o + ((e + 1u) & 3u)]], 1u);
  }
}

@compute @workgroup_size(256)
fn initCursor(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gid(w, n, l.x);
  if (i < p.nv) { atomicStore(&deg[i], off[i]); }      // deg is reused as the fill cursor
}

@compute @workgroup_size(256)
fn fillAdj(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let q = gid(w, n, l.x);
  if (q >= p.nq) { return; }
  let o = q * 6u + 2u;
  for (var e = 0u; e < 4u; e = e + 1u) {
    let u = quads[o + e];
    let v = quads[o + ((e + 1u) & 3u)];
    adj[atomicAdd(&deg[u], 1u)] = v;
    adj[atomicAdd(&deg[v], 1u)] = u;
  }
}

// One Taubin pass: move each vertex a fraction of the way to the average of its neighbors. Positive
// factor smooths and shrinks; the negative one that follows pushes back slightly harder, which is
// what keeps a structure from deflating.
@compute @workgroup_size(256)
fn taubin(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gid(w, n, l.x);
  if (i >= p.nv) { return; }
  let s = off[i];
  let d = degCopy[i];
  let px = posIn[i * 3u]; let py = posIn[i * 3u + 1u]; let pz = posIn[i * 3u + 2u];
  if (d == 0u) { posOut[i * 3u] = px; posOut[i * 3u + 1u] = py; posOut[i * 3u + 2u] = pz; return; }
  var a = vec3<f32>(0.0, 0.0, 0.0);
  for (var t = 0u; t < d; t = t + 1u) {
    let m = adj[s + t] * 3u;
    a = a + vec3<f32>(posIn[m], posIn[m + 1u], posIn[m + 2u]);
  }
  let avg = a / f32(d);
  let q = vec3<f32>(px, py, pz) + p.factor * (avg - vec3<f32>(px, py, pz));
  posOut[i * 3u] = q.x; posOut[i * 3u + 1u] = q.y; posOut[i * 3u + 2u] = q.z;
}
`;


// ── PHASE 4 ON THE CARD: one mesh per label, and its normals ────────────────────────────────────
//
// The quads are shared -- a face between two structures belongs to both -- so this splits them into
// one mesh per label, renumbers each label's vertices from zero, winds each face away from the label
// it is being given to, turns IJK into RAS, and computes the normals.
//
// THE RENUMBERING IS THE INTERESTING PART. The CPU walks the quads in order and hands out local
// numbers on first use, which is inherently sequential. Here every (label, vertex) pair gets one bit
// in a mask, and a single prefix sum over the whole mask gives every label's vertex count AND every
// vertex's local number at once: local = rank(label, vertex) - base(label). The mask is one bit per
// pair, so 22 structures over 2 million vertices cost 5 MB rather than a table per label.
//
// The normals need each vertex's triangles. One adjacency serves both steps: the raw normal is the
// sum of the cross products of the incident triangles, and a smoothing pass adds the OTHER TWO
// corners of each incident triangle -- which is exactly the neighbor multiset, multiplicities and
// all, that the CPU builds from triangle edges.
const MESH_SHADER = /* wgsl */ `
struct M {
  labels: u32, nv: u32, strideWords: u32, blocksPerLabel: u32,
  nq: u32, verts: u32, tris: u32, phase: u32,
  cursorBase: u32, adjBase: u32, nrmA: u32, nrmB: u32,
  ras0: vec4<f32>, ras1: vec4<f32>, ras2: vec4<f32>,
};
// EIGHT STORAGE BUFFERS, NOT FIFTEEN. WebGPU promises only eight per stage; Deno's implementation
// offers 31 and Chrome's 10, so the first version ran in the bench and refused to run in the
// application (2026-09-23). Everything that can share a buffer now does, addressed by offsets that
// come in with the rest of the parameters: the metadata in one, the counters in one, the bitmask
// and the triangle adjacency in one, and the positions and both normal buffers in one.
@group(0) @binding(0) var<uniform> m: M;
@group(0) @binding(1) var<storage, read> quads: array<u32>;
@group(0) @binding(2) var<storage, read> tbl: array<u32>;         // [0,256) label -> dense+1; then baseV, then baseI
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;   // block counts, then the cursors
@group(0) @binding(4) var<storage, read_write> scratch: array<atomic<u32>>;  // the used-vertex bitmask, then the adjacency
@group(0) @binding(5) var<storage, read> posIn: array<f32>;        // the shared, smoothed vertices (IJK)
@group(0) @binding(6) var<storage, read_write> mesh: array<f32>;    // positions in RAS, then normals A, then normals B
@group(0) @binding(7) var<storage, read_write> idxOut: array<u32>; // absolute vertex slots
@group(0) @binding(8) var<storage, read> triOff: array<u32>;       // V+1 entries: a vertex's triangles are [off[v], off[v+1])

fn gi(w: vec3<u32>, n: vec3<u32>, l: u32) -> u32 { return (w.y * n.x + w.x) * 256u + l; }
fn baseV(l: u32) -> u32 { return tbl[256u + l]; }
fn baseI(l: u32) -> u32 { return tbl[256u + m.labels + 1u + l]; }

@compute @workgroup_size(256)
fn markUsed(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let q = gi(w, n, l.x);
  if (q >= m.nq) { return; }
  let o = q * 6u;
  for (var side = 0u; side < 2u; side = side + 1u) {
    let lv = quads[o + side];
    if (lv == 0u) { continue; }
    let d = tbl[lv];
    if (d == 0u) { continue; }
    let seg = (d - 1u) * m.strideWords;
    for (var e = 0u; e < 4u; e = e + 1u) {
      let gv = quads[o + 2u + e];
      atomicOr(&scratch[seg + (gv >> 5u)], 1u << (gv & 31u));
    }
  }
}

@compute @workgroup_size(256)
fn countUsed(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let b = gi(w, n, l.x);
  if (b >= (m.labels + 1u) * m.blocksPerLabel) { return; }
  var c = 0u;
  for (var i = 0u; i < 8u; i = i + 1u) { c = c + countOneBits(atomicLoad(&scratch[b * 8u + i])); }
  atomicStore(&counts[b], c);
}

/** This (label, vertex) pair's number within its label: the prefix sum, minus the label's own base. */
fn localOf(dl: u32, gv: u32) -> u32 {
  let block = dl * m.blocksPerLabel + (gv >> 8u);
  let word = dl * m.strideWords + (gv >> 5u);
  var v = atomicLoad(&counts[block]);
  var wd = dl * m.strideWords + ((gv >> 8u) << 3u);
  loop {
    if (wd >= word) { break; }
    v = v + countOneBits(atomicLoad(&scratch[wd]));
    wd = wd + 1u;
  }
  let bit = gv & 31u;
  let below = select((1u << bit) - 1u, 0u, bit == 0u);
  return v + countOneBits(atomicLoad(&scratch[word]) & below) - atomicLoad(&counts[dl * m.blocksPerLabel]);
}

@compute @workgroup_size(256)
fn writePositions(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let t = gi(w, n, l.x);
  if (t >= m.labels * m.nv) { return; }
  let dl = t / m.nv;
  let gv = t % m.nv;
  if ((atomicLoad(&scratch[dl * m.strideWords + (gv >> 5u)]) & (1u << (gv & 31u))) == 0u) { return; }
  let slot = baseV(dl) + localOf(dl, gv);
  let q = vec4<f32>(posIn[gv * 3u], posIn[gv * 3u + 1u], posIn[gv * 3u + 2u], 1.0);
  mesh[slot * 3u] = dot(m.ras0, q);
  mesh[slot * 3u + 1u] = dot(m.ras1, q);
  mesh[slot * 3u + 2u] = dot(m.ras2, q);
}

@compute @workgroup_size(256)
fn writeIndices(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let q = gi(w, n, l.x);
  if (q >= m.nq) { return; }
  let o = q * 6u;
  for (var side = 0u; side < 2u; side = side + 1u) {
    let lv = quads[o + side];
    if (lv == 0u) { continue; }
    let d = tbl[lv];
    if (d == 0u) { continue; }
    let dl = d - 1u;
    // Wound so the face points AWAY from this label: the quad's own order faces from a to b, so the
    // b side takes it reversed. Get this wrong and every second structure renders inside-out.
    var v0 = quads[o + 2u]; var v1 = quads[o + 3u]; var v2 = quads[o + 4u]; var v3 = quads[o + 5u];
    if (side != 0u) { let t0 = v0; let t1 = v1; v0 = v3; v1 = v2; v2 = t1; v3 = t0; }
    let b = baseV(dl);
    let a0 = b + localOf(dl, v0); let a1 = b + localOf(dl, v1);
    let a2 = b + localOf(dl, v2); let a3 = b + localOf(dl, v3);
    let slot = baseI(dl) + atomicAdd(&counts[m.cursorBase + dl], 1u) * 6u;
    idxOut[slot] = a0; idxOut[slot + 1u] = a1; idxOut[slot + 2u] = a2;
    idxOut[slot + 3u] = a0; idxOut[slot + 4u] = a2; idxOut[slot + 5u] = a3;
  }
}

@compute @workgroup_size(256)
fn clearCursor(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gi(w, n, l.x);
  if (i <= m.verts) { atomicStore(&counts[m.cursorBase + i], 0u); }
}

@compute @workgroup_size(256)
fn countTri(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let t = gi(w, n, l.x);
  if (t >= m.tris) { return; }
  for (var c = 0u; c < 3u; c = c + 1u) { atomicAdd(&counts[m.cursorBase + idxOut[t * 3u + c]], 1u); }
}

@compute @workgroup_size(256)
fn initTriCursor(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let i = gi(w, n, l.x);
  if (i < m.verts) { atomicStore(&counts[m.cursorBase + i], triOff[i]); }
}

@compute @workgroup_size(256)
fn fillTri(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let t = gi(w, n, l.x);
  if (t >= m.tris) { return; }
  for (var c = 0u; c < 3u; c = c + 1u) {
    let slot = atomicAdd(&counts[m.cursorBase + idxOut[t * 3u + c]], 1u);
    atomicStore(&scratch[m.adjBase + slot], t);
  }
}

fn corner(t: u32, c: u32) -> vec3<f32> {
  let v = idxOut[t * 3u + c] * 3u;
  return vec3<f32>(mesh[v], mesh[v + 1u], mesh[v + 2u]);
}

// Area-weighted, like the CPU: the cross product of a triangle's edges is already proportional to
// its area, so summing them unnormalized weights the big triangles more.
@compute @workgroup_size(256)
fn rawNormals(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let v = gi(w, n, l.x);
  if (v >= m.verts) { return; }
  var acc = vec3<f32>(0.0, 0.0, 0.0);
  let s = triOff[v];
  let e = triOff[v + 1u];
  for (var i = s; i < e; i = i + 1u) {
    let t = atomicLoad(&scratch[m.adjBase + i]);
    let a = corner(t, 0u);
    acc = acc + cross(corner(t, 1u) - a, corner(t, 2u) - a);
  }
  let L = length(acc);
  let nrm = select(acc / L, acc, L == 0.0);
  mesh[m.nrmA + v * 3u] = nrm.x; mesh[m.nrmA + v * 3u + 1u] = nrm.y; mesh[m.nrmA + v * 3u + 2u] = nrm.z;
}

/** One pass of normal smoothing: this normal plus its neighbors', renormalized. The neighbors are
 *  the other two corners of every incident triangle -- the same multiset, multiplicities included,
 *  that the CPU builds from the triangle edges. The geometry is not touched. */
@compute @workgroup_size(256)
fn smoothNormals(@builtin(workgroup_id) w: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let v = gi(w, n, l.x);
  if (v >= m.verts) { return; }
  let src = select(m.nrmB, m.nrmA, m.phase == 0u);
  let dst = select(m.nrmA, m.nrmB, m.phase == 0u);
  var acc = vec3<f32>(mesh[src + v * 3u], mesh[src + v * 3u + 1u], mesh[src + v * 3u + 2u]);
  let s = triOff[v];
  let e = triOff[v + 1u];
  for (var i = s; i < e; i = i + 1u) {
    let t = atomicLoad(&scratch[m.adjBase + i]);
    for (var c = 0u; c < 3u; c = c + 1u) {
      let o = idxOut[t * 3u + c];
      if (o == v) { continue; }
      acc = acc + vec3<f32>(mesh[src + o * 3u], mesh[src + o * 3u + 1u], mesh[src + o * 3u + 2u]);
    }
  }
  let L = length(acc);
  let nrm = select(acc / L, acc, L == 0.0);
  mesh[dst + v * 3u] = nrm.x; mesh[dst + v * 3u + 1u] = nrm.y; mesh[dst + v * 3u + 2u] = nrm.z;
}
`;

/** A 2D workgroup grid, because one dispatch may not exceed 65535 workgroups in a dimension. */
function grid(items: number, limit: number): [number, number] {
  const wgs = Math.ceil(items / WG);
  if (wgs <= limit) return [wgs, 1];
  const x = limit;
  return [x, Math.ceil(wgs / x)];
}

export async function surfaceNetsGpu(
  /** The labelmap as bytes — or an empty array when `opts.texture` supplies it on the card already. */
  lab: Uint8Array,
  dims: [number, number, number],
  opts: {
    keepPositions?: boolean;
    keepQuads?: boolean;
    device?: GPUDevice;
    /** Phase 3 on the card as well: Taubin smoothing over the shared vertices. 0 leaves the raw net. */
    smoothIters?: number;
    lambda?: number;
    mu?: number;
    /** Phase 4 as well: split into one mesh per label, wind, put into RAS, and compute the normals. */
    labelMeshes?: boolean;
    ijkToRAS?: ArrayLike<number>;
    normalSmooth?: number;
    /** Bring the meshes back to the processor. In the application nothing would come back. */
    keepMeshes?: boolean;
    /** The labelmap's r8uint texture, when the caller already has one (the colorize baker's). */
    texture?: GPUTexture;
  } = {},
): Promise<GpuNetsResult> {
  const t00 = performance.now();
  const device = opts.device ?? (await initDevice()).device;
  const [nx, ny, nz] = dims;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cells = cx * cy * cz, voxels = nx * ny * nz;
  const maskWords = Math.ceil(cells / 32);
  const blocks = Math.ceil(cells / WG);
  const wgLimit = device.limits.maxComputeWorkgroupsPerDimension;

  // ── the labelmap as an r8uint 3D texture — the one the application already has, when it has one ──
  const ownTexture = !opts.texture;
  const tex = opts.texture ?? device.createTexture({
    size: [nx, ny, nz], dimension: "3d", format: "r8uint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const tUp = performance.now();
  if (ownTexture) {
  // In slabs: one 418 MB write can exceed what the driver will stage at once.
  const SLAB = Math.max(1, Math.floor(64 * 1024 * 1024 / (nx * ny)));
  for (let z = 0; z < nz; z += SLAB) {
    const depth = Math.min(SLAB, nz - z);
    device.queue.writeTexture(
      { texture: tex, origin: [0, 0, z] },
      lab.subarray(z * nx * ny, (z + depth) * nx * ny) as unknown as BufferSource,
      { bytesPerRow: nx, rowsPerImage: ny },
      [nx, ny, depth],
    );
  }
  await device.queue.onSubmittedWorkDone();
  }
  const msUpload = ownTexture ? performance.now() - tUp : 0;

  const module = device.createShaderModule({ code: SHADER });
  // SAY WHAT IS WRONG WITH THE SHADER. Without this a compile error surfaces later as "pipeline is
  // invalid" on every dispatch and a result of zero, which looks like a bug in the algorithm.
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((x) => x.type === "error");
  if (errs.length) throw new Error("WGSL:\n" + errs.map((x) => `  line ${x.lineNum}: ${x.message}`).join("\n"));
  const buf = (size: number, usage: number) => device.createBuffer({ size: Math.max(4, size), usage });
  const ST = GPUBufferUsage.STORAGE;
  const mask = buf(maskWords * 4, ST | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
  const blockCount = buf(blocks * 4, ST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const counters = buf(257 * 4, ST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const dimsBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const writeDims = (quadCap: number) =>
    device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([nx, ny, nz, cx, cy, cz, cells, voxels, maskWords, blocks, quadCap, 0]));
  writeDims(0);

  const layout0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "3d" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const layout1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout0, layout1] });
  const pipe = (entryPoint: string) => device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });

  // Phase B's bindings are only used by the scan kernels, but every pipeline shares one layout, so
  // group 1 always has something bound. Small dummies cost nothing.
  // TWO dummies, not one bound twice. WebGPU forbids two WRITABLE storage bindings that alias the
  // same memory, and the scan group's two slots are both writable: Deno's implementation let it
  // pass and Chrome refused it outright ("Writable storage buffer binding aliasing found"), which
  // is how it was found -- in the application, not in the bench (2026-09-23).
  const dummy = buf(4, ST), dummy2 = buf(4, ST);
  // AND A GROUP 0 THE SCAN CAN BIND WITHOUT ALIASING ANYTHING. The scan kernels use group 1 only,
  // but the pipeline layout still requires group 0 -- and binding the real buffers there while the
  // scan writes one of them in group 1 is two writable bindings over the same memory, which WebGPU
  // forbids. Separate placeholders, one per binding, so nothing overlaps.
  const scanDummies = [0, 1, 2, 3, 4].map(() => buf(4, ST));
  const scanN = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bind1 = (src: GPUBuffer, sums: GPUBuffer) =>
    device.createBindGroup({ layout: layout1, entries: [{ binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: sums } }, { binding: 2, resource: { buffer: scanN } }] });

  const run = async (label: string, fn: (enc: GPUComputePassEncoder) => void) => {
    const t = performance.now();
    const enc = device.createCommandEncoder({ label });
    const pass = enc.beginComputePass();
    fn(pass);
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t;
  };

  const readF32 = async (src: GPUBuffer, bytes: number): Promise<Float32Array> => {
    const dst = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, dst, 0, bytes);
    device.queue.submit([enc.finish()]);
    await dst.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(dst.getMappedRange().slice(0));
    dst.unmap(); dst.destroy();
    return out;
  };

  const readU32 = async (src: GPUBuffer, bytes: number): Promise<Uint32Array> => {
    const dst = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, dst, 0, bytes);
    device.queue.submit([enc.finish()]);
    await dst.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(dst.getMappedRange().slice(0));
    dst.unmap();
    dst.destroy();
    return out;
  };

  // ── A ──
  let vertsBuf = buf(4, ST);
  let quadsBuf = buf(4, ST);
  const group0 = () => device.createBindGroup({
    layout: layout0,
    entries: [
      { binding: 0, resource: tex.createView() },
      { binding: 1, resource: { buffer: dimsBuf } },
      { binding: 2, resource: { buffer: mask } },
      { binding: 3, resource: { buffer: blockCount } },
      { binding: 4, resource: { buffer: vertsBuf } },
      { binding: 5, resource: { buffer: quadsBuf } },
      { binding: 6, resource: { buffer: counters } },
    ],
  });
  const emptyScan = bind1(dummy, dummy2);
  const group0Scan = () => device.createBindGroup({
    layout: layout0,
    entries: [
      { binding: 0, resource: tex.createView() },
      { binding: 1, resource: { buffer: dimsBuf } },
      ...scanDummies.map((b, i) => ({ binding: i + 2, resource: { buffer: b } })),
    ],
  });
  const pActive = pipe("markCells");
  const [ax, ay] = grid(cells, wgLimit);
  const msActive = await run("active cells", (p) => {
    p.setPipeline(pActive); p.setBindGroup(0, group0()); p.setBindGroup(1, emptyScan);
    p.dispatchWorkgroups(ax, ay);
  });

  // ── B: scan the block counts, three levels, on the card ──
  const tScan = performance.now();
  const pScan = pipe("scanBlocks"), pAdd = pipe("addOffsets");
  const scanOnce = async (src: GPUBuffer, sums: GPUBuffer, count: number) => {
    device.queue.writeBuffer(scanN, 0, new Uint32Array([count, 0, 0, 0]));
    const [gx, gy] = grid(count, wgLimit);
    await run("scan", (p) => {
      p.setPipeline(pScan); p.setBindGroup(0, group0Scan()); p.setBindGroup(1, bind1(src, sums));
      p.dispatchWorkgroups(gx, gy);
    });
  };
  const addOnce = async (src: GPUBuffer, sums: GPUBuffer, count: number) => {
    device.queue.writeBuffer(scanN, 0, new Uint32Array([count, 0, 0, 0]));
    const [gx, gy] = grid(count, wgLimit);
    await run("add offsets", (p) => {
      p.setPipeline(pAdd); p.setBindGroup(0, group0Scan()); p.setBindGroup(1, bind1(src, sums));
      p.dispatchWorkgroups(gx, gy);
    });
  };
  /** An exclusive prefix sum over `count` elements of `src`, in place, three levels, on the card. */
  const prefixSum = async (src: GPUBuffer, count: number) => {
    const b0 = Math.ceil(count / WG), b1 = Math.ceil(b0 / WG), b2 = Math.ceil(b1 / WG);
    const s1 = buf(b0 * 4, ST), s2 = buf(b1 * 4, ST), s3 = buf(b2 * 4, ST);
    await scanOnce(src, s1, count);
    await scanOnce(s1, s2, b0);
    await scanOnce(s2, s3, b1);
    await addOnce(s1, s2, b0);
    await addOnce(src, s1, count);
    s1.destroy(); s2.destroy(); s3.destroy();
  };
  await prefixSum(blockCount, blocks);
  const msScan = performance.now() - tScan;

  // How many vertices: the last block's offset plus what it holds. One 8-byte read, not a pass.
  const tail = await readU32(blockCount, blocks * 4);
  const lastBlockCells = cells - (blocks - 1) * WG;
  const maskTail = await readU32(mask, maskWords * 4);
  let lastBlockActive = 0;
  for (let c = (blocks - 1) * WG; c < cells; c++) if (maskTail[c >> 5] & (1 << (c & 31))) lastBlockActive++;
  const vertices = tail[blocks - 1] + lastBlockActive;
  void lastBlockCells;

  // ── C ──
  vertsBuf.destroy();
  vertsBuf = buf(Math.max(4, vertices * 12), ST | GPUBufferUsage.COPY_SRC);
  const pVerts = pipe("placeVertices");
  const msVerts = await run("place vertices", (p) => {
    p.setPipeline(pVerts); p.setBindGroup(0, group0()); p.setBindGroup(1, emptyScan);
    p.dispatchWorkgroups(ax, ay);
  });

  // ── D: count, size the buffer, write ──
  device.queue.writeBuffer(counters, 0, new Uint32Array(257));
  const pCount = pipe("countQuads"), pWrite = pipe("writeQuads");
  const [vx, vy] = grid(voxels, wgLimit);
  const msCount = await run("count quads", (p) => {
    p.setPipeline(pCount); p.setBindGroup(0, group0()); p.setBindGroup(1, emptyScan);
    p.dispatchWorkgroups(vx, vy);
  });
  const counted = await readU32(counters, 257 * 4);
  const quads = counted[0];
  const trianglesByLabel = new Map<number, number>();
  for (let l = 1; l < 256; l++) if (counted[l]) trianglesByLabel.set(l, counted[l] * 2);

  quadsBuf.destroy();
  quadsBuf = buf(Math.max(4, quads * 24), ST | GPUBufferUsage.COPY_SRC);
  writeDims(quads);
  device.queue.writeBuffer(counters, 0, new Uint32Array(257));
  const msWrite = await run("write quads", (p) => {
    p.setPipeline(pWrite); p.setBindGroup(0, group0()); p.setBindGroup(1, emptyScan);
    p.dispatchWorkgroups(vx, vy);
  });

  // ── E & F: the adjacency, then Taubin smoothing — phase 3, on the card ──
  //
  // The vertices are SHARED between labels, so smoothing them here is what keeps parcels that touch
  // from cracking apart. The adjacency comes out of the quads: count each edge's two ends, prefix
  // sum, fill. Then 24 iterations of two passes each, ping-ponging between two position buffers,
  // all 48 in one submission -- the only thing between passes is a barrier the driver inserts.
  let msAdj = 0, msSmooth = 0;
  let posB: GPUBuffer | undefined;
  const iters = opts.smoothIters ?? 0;
  let rawPositions: Float32Array | undefined;
  if (opts.keepPositions && iters > 0) rawPositions = await readF32(vertsBuf, vertices * 12);
  if (iters > 0 && quads > 0) {
    const tAdj = performance.now();
    const sm = device.createShaderModule({ code: SMOOTH_SHADER });
    const smInfo = await sm.getCompilationInfo();
    const smErr = smInfo.messages.filter((x) => x.type === "error");
    if (smErr.length) throw new Error("WGSL (smoothing):\n" + smErr.map((x) => `  line ${x.lineNum}: ${x.message}`).join("\n"));
    const rw = { type: "storage" as const }, ro = { type: "read-only-storage" as const };
    const smLayout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, 4, 5, 6, 7].map((binding) => ({
        binding, visibility: GPUShaderStage.COMPUTE,
        buffer: binding === 2 ? { type: "uniform" as const } : ([1, 4, 5, 6].includes(binding) ? ro : rw),
      })),
    });
    const smPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [smLayout] });
    const smPipe = (entryPoint: string) => device.createComputePipeline({ layout: smPipeLayout, compute: { module: sm, entryPoint } });

    const deg = buf(vertices * 4, ST | GPUBufferUsage.COPY_SRC);
    const degCopy = buf(vertices * 4, ST | GPUBufferUsage.COPY_DST);
    const off = buf(vertices * 4, ST | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const adj = buf(quads * 8 * 4, ST);
    posB = buf(vertices * 12, ST | GPUBufferUsage.COPY_SRC);
    const par = (factor: number) => {
      const b = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, new Uint32Array([vertices, quads, 0, 0]));
      device.queue.writeBuffer(b, 16, new Float32Array([factor, 0, 0, 0]));
      return b;
    };
    const pZero = par(0);
    const bind = (p0: GPUBuffer, inPos: GPUBuffer, outPos: GPUBuffer) => device.createBindGroup({
      layout: smLayout,
      entries: [
        { binding: 0, resource: { buffer: deg } }, { binding: 1, resource: { buffer: quadsBuf } },
        { binding: 2, resource: { buffer: p0 } }, { binding: 3, resource: { buffer: adj } },
        { binding: 4, resource: { buffer: off } }, { binding: 5, resource: { buffer: degCopy } },
        { binding: 6, resource: { buffer: inPos } }, { binding: 7, resource: { buffer: outPos } },
      ],
    });
    const build = bind(pZero, vertsBuf, posB);
    const [nvx, nvy] = grid(vertices, wgLimit);
    const [nqx, nqy] = grid(quads, wgLimit);
    const pClear = smPipe("clearDeg"), pCount2 = smPipe("countDeg"), pInit = smPipe("initCursor"), pFill = smPipe("fillAdj");
    await run("degrees", (p) => {
      p.setPipeline(pClear); p.setBindGroup(0, build); p.dispatchWorkgroups(nvx, nvy);
      p.setPipeline(pCount2); p.dispatchWorkgroups(nqx, nqy);
    });
    {                                                   // degrees are needed twice: as list lengths, and scanned into offsets
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(deg, 0, degCopy, 0, vertices * 4);
      enc.copyBufferToBuffer(deg, 0, off, 0, vertices * 4);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    await prefixSum(off, vertices);
    await run("fill adjacency", (p) => {
      p.setPipeline(pInit); p.setBindGroup(0, build); p.dispatchWorkgroups(nvx, nvy);
      p.setPipeline(pFill); p.dispatchWorkgroups(nqx, nqy);
    });
    msAdj = performance.now() - tAdj;

    const lam = opts.lambda ?? 0.6, mu = opts.mu ?? -0.62;
    const pLam = par(lam), pMu = par(mu);
    const bgLam = bind(pLam, vertsBuf, posB), bgMu = bind(pMu, posB, vertsBuf);
    const pTaubin = smPipe("taubin");
    msSmooth = await run("taubin", (p) => {
      p.setPipeline(pTaubin);
      for (let t = 0; t < iters; t++) {
        p.setBindGroup(0, bgLam); p.dispatchWorkgroups(nvx, nvy);
        p.setBindGroup(0, bgMu); p.dispatchWorkgroups(nvx, nvy);
      }
    });
    deg.destroy(); degCopy.destroy(); off.destroy(); adj.destroy();
  }

  // ── G & H: one mesh per label, and the normals — phase 4, on the card ──
  let msSplit = 0, msNormals = 0;
  let meshes: { label: number; positions: Float32Array; normals: Float32Array; indices: Uint32Array }[] | undefined;
  if (opts.labelMeshes && quads > 0 && vertices > 0) {
    const tSplit = performance.now();
    const labels = [...trianglesByLabel.keys()].sort((a, b) => a - b);
    const L = labels.length;
    const blocksPerLabel = Math.ceil(vertices / WG);
    const strideWords = blocksPerLabel * 8;
    const segments = L + 1;                            // one empty segment at the end holds the total
    const mm = device.createShaderModule({ code: MESH_SHADER });
    const mInfo = await mm.getCompilationInfo();
    const mErr = mInfo.messages.filter((x) => x.type === "error");
    if (mErr.length) throw new Error("WGSL (meshes):\n" + mErr.map((x) => `  line ${x.lineNum}: ${x.message}`).join("\n"));
    // EIGHT STORAGE BUFFERS is what WebGPU promises; this phase uses exactly eight. (Deno's
    // implementation offers 31 and Chrome's 10, which is how a fifteen-buffer first version passed
    // the bench and refused to run in the application.)
    if (device.limits.maxStorageBuffersPerShaderStage < 8) {
      throw new Error(`the per-label meshes need 8 storage buffers per stage; this device allows ${device.limits.maxStorageBuffersPerShaderStage}`);
    }

    const quadsPerLabel = labels.map((lv) => (trianglesByLabel.get(lv) ?? 0) / 2);
    const baseI = new Uint32Array(L + 1);
    for (let i = 0; i < L; i++) baseI[i + 1] = baseI[i] + quadsPerLabel[i] * 6;
    const tris = baseI[L] / 3;

    const blockTotal = segments * blocksPerLabel;
    const adjBase = segments * strideWords;
    const scratch = buf((adjBase + tris * 3) * 4, ST);              // the bitmask, then the adjacency
    const meta = buf((256 + 2 * (L + 1)) * 4, ST | GPUBufferUsage.COPY_DST);
    const idxOut = buf(Math.max(4, tris * 12), ST | GPUBufferUsage.COPY_SRC);
    let counts = buf((blockTotal + L + 1) * 4, ST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    let outBuf = buf(4, ST | GPUBufferUsage.COPY_SRC);
    let triOff = buf(4, ST | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const metaArr = new Uint32Array(256 + 2 * (L + 1));
    labels.forEach((lv, i) => { metaArr[lv] = i + 1; });
    metaArr.set(baseI, 256 + (L + 1));
    device.queue.writeBuffer(meta, 0, metaArr);

    const uni = (phase: number, verts: number, cursorBase: number) => {
      const b = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const r = opts.ijkToRAS ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      device.queue.writeBuffer(b, 0, new Uint32Array([
        L, vertices, strideWords, blocksPerLabel, quads, verts, tris, phase,
        cursorBase, adjBase, verts * 3, verts * 6,
      ]));
      device.queue.writeBuffer(b, 48, new Float32Array([
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
      ]));
      return b;
    };
    const mLayout = device.createBindGroupLayout({
      entries: Array.from({ length: 9 }, (_, binding) => ({
        binding, visibility: GPUShaderStage.COMPUTE,
        buffer: binding === 0
          ? { type: "uniform" as const }
          : ([1, 2, 5, 8].includes(binding) ? { type: "read-only-storage" as const } : { type: "storage" as const }),
      })),
    });
    const mPipeLayout = device.createPipelineLayout({ bindGroupLayouts: [mLayout] });
    const mPipe = (entryPoint: string) => device.createComputePipeline({ layout: mPipeLayout, compute: { module: mm, entryPoint } });
    const mBind = (u: GPUBuffer) => device.createBindGroup({
      layout: mLayout,
      entries: [
        { binding: 0, resource: { buffer: u } }, { binding: 1, resource: { buffer: quadsBuf } },
        { binding: 2, resource: { buffer: meta } }, { binding: 3, resource: { buffer: counts } },
        { binding: 4, resource: { buffer: scratch } }, { binding: 5, resource: { buffer: vertsBuf } },
        { binding: 6, resource: { buffer: outBuf } }, { binding: 7, resource: { buffer: idxOut } },
        { binding: 8, resource: { buffer: triOff } },
      ],
    });

    // ── which vertices each label uses, and how they are numbered within it ──
    let u0 = uni(0, 0, blockTotal);
    const [qx2, qy2] = grid(quads, wgLimit);
    const pMark = mPipe("markUsed"), pCountUsed = mPipe("countUsed");
    await run("mark used vertices", (p) => {
      p.setPipeline(pMark); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(qx2, qy2);
    });
    const [bx, by] = grid(blockTotal, wgLimit);
    await run("count used", (p) => {
      p.setPipeline(pCountUsed); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(bx, by);
    });
    await prefixSum(counts, blockTotal);
    const scanned = await readU32(counts, blockTotal * 4);
    const baseV = new Uint32Array(L + 1);
    for (let i = 0; i <= L; i++) baseV[i] = scanned[i * blocksPerLabel];
    const verts = baseV[L];
    metaArr.set(baseV, 256);
    device.queue.writeBuffer(meta, 0, metaArr);

    // Now that the vertex count is known, the buffers that depend on it — and the counters grow to
    // hold one cursor per vertex, with the scanned block counts copied into their old place.
    const cursorBase = blockTotal;
    const grown = buf((blockTotal + verts + 2) * 4, ST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    {
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(counts, 0, grown, 0, blockTotal * 4);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    counts.destroy(); counts = grown;
    outBuf.destroy(); outBuf = buf(verts * 36, ST | GPUBufferUsage.COPY_SRC);   // positions + normals A + normals B
    triOff.destroy(); triOff = buf((verts + 1) * 4, ST | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    u0 = uni(0, verts, cursorBase);
    const u1 = uni(1, verts, cursorBase);

    const pPos = mPipe("writePositions"), pIdx = mPipe("writeIndices");
    const [px2, py2] = grid(L * vertices, wgLimit);
    await run("per-label positions", (p) => {
      p.setPipeline(pPos); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(px2, py2);
    });
    await run("per-label indices", (p) => {
      p.setPipeline(pIdx); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(qx2, qy2);
    });
    msSplit = performance.now() - tSplit;

    // ── the normals ──
    const tNorm = performance.now();
    const pClearC = mPipe("clearCursor"), pCountTri = mPipe("countTri"), pInitTri = mPipe("initTriCursor");
    const pFillTri = mPipe("fillTri"), pRaw = mPipe("rawNormals"), pSmooth = mPipe("smoothNormals");
    const [vx2, vy2] = grid(verts + 1, wgLimit);
    const [tx2, ty2] = grid(tris, wgLimit);
    await run("count triangles per vertex", (p) => {
      p.setPipeline(pClearC); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(vx2, vy2);
      p.setPipeline(pCountTri); p.dispatchWorkgroups(tx2, ty2);
    });
    {
      // The degrees become offsets: copied in, then prefix-summed over V+1 entries, so the extra
      // entry (zero) ends up holding the total and every vertex's list is [off[v], off[v+1]).
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(counts, cursorBase * 4, triOff, 0, verts * 4);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    await prefixSum(triOff, verts + 1);
    await run("fill the triangle adjacency", (p) => {
      p.setPipeline(pInitTri); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(vx2, vy2);
      p.setPipeline(pFillTri); p.dispatchWorkgroups(tx2, ty2);
    });
    const smoothPasses = opts.normalSmooth ?? 16;
    await run("normals", (p) => {
      p.setPipeline(pRaw); p.setBindGroup(0, mBind(u0)); p.dispatchWorkgroups(vx2, vy2);
      p.setPipeline(pSmooth);
      for (let i = 0; i < smoothPasses; i++) {
        p.setBindGroup(0, mBind(i % 2 === 0 ? u0 : u1));
        p.dispatchWorkgroups(vx2, vy2);
      }
    });
    msNormals = performance.now() - tNorm;

    if (opts.keepMeshes) {
      const all = await readF32(outBuf, verts * 36);
      const allIdx = await readU32(idxOut, tris * 12);
      const nrmAt = smoothPasses % 2 === 0 ? verts * 3 : verts * 6;   // which half the last pass wrote
      meshes = labels.map((lv, i) => {
        const v0 = baseV[i], v1 = baseV[i + 1];
        const i0 = baseI[i], i1 = baseI[i + 1];
        const idx = new Uint32Array(i1 - i0);
        for (let k = 0; k < idx.length; k++) idx[k] = allIdx[i0 + k] - v0;   // absolute slots -> local
        return {
          label: lv,
          positions: all.slice(v0 * 3, v1 * 3),
          normals: all.slice(nrmAt + v0 * 3, nrmAt + v1 * 3),
          indices: idx,
        };
      });
    }
    scratch.destroy(); meta.destroy(); idxOut.destroy(); counts.destroy(); outBuf.destroy(); triOff.destroy();
  }

  // ── back to the processor, only if asked: in the application nothing would come back at all ──
  const tRead = performance.now();
  let positions: Float32Array | undefined;
  if (opts.keepPositions && vertices) positions = await readF32(vertsBuf, vertices * 12);
  let quadsData: Uint32Array | undefined;
  if (opts.keepQuads && quads) quadsData = await readU32(quadsBuf, quads * 24);
  const msRead = performance.now() - tRead;

  const result: GpuNetsResult = {
    vertices, quads, trianglesByLabel, positions, positionsRaw: rawPositions, quadsData, meshes,
    ms: {
      upload: msUpload, active: msActive, scan: msScan, vertices: msVerts,
      countQuads: msCount, writeQuads: msWrite, readback: msRead,
      adjacency: msAdj, smooth: msSmooth, split: msSplit, normals: msNormals,
      total: msActive + msScan + msVerts + msCount + msWrite + msAdj + msSmooth + msSplit + msNormals,
    },
    bytes: { mask: maskWords * 4, blockCounts: blocks * 4, vertices: vertices * 12, quads: quads * 24 },
  };
  void t00;
  if (ownTexture) tex.destroy();
  mask.destroy(); blockCount.destroy(); counters.destroy();
  vertsBuf.destroy(); quadsBuf.destroy(); posB?.destroy();
  dummy.destroy(); dummy2.destroy(); for (const b of scanDummies) b.destroy();
  return result;
}
