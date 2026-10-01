// THE DRAWING COPY: fewer triangles on the GPU, the full mesh kept as the data.
//
// A whole-body result is 12 million triangles and a brain 5 million, and every frame draws all of
// them. Ron, 2026-09-18, after a study on real files (docs/decimation-study-2026-09-18.md in the
// workspace): "0.2 it is" -- an error limit of 0.2 VOXEL, the smallest voxel edge, never a
// millimeter ("would not be the right thing when we have astrodata or microct data"). Measured:
// 29% of the triangles left on pulmonary vessels, 12% on a vertebra, 4.5% on a femur, 17% on a
// FastSurfer brain, within about half a voxel of the original on those surfaces -- and on whole
// vessel structures NOT, until the locks below (the critic's finding 2 of 2026-09-18).
//
// TWO FACTS THAT DECIDE THE DESIGN. meshoptimizer's simplifier removes vertices and moves none, so
// (1) the copy is only a shorter INDEX LIST into the same vertices, and (2) every remaining vertex
// keeps its STORED normal -- and must: normals recomputed from the coarse mesh differ from the
// stored ones by 22 degrees on average, up to 90, and show as patchy shading. Ron: "The stored are
// way better!" So nothing here touches positions or normals; `drawIndices` is the whole output.
//
// "Leave the data, modulate the appearance": `indices` is what is saved and measured;
// `drawIndices` is what is drawn.
import { MeshoptSimplifier } from "../render/vendor/meshoptimizer/meshopt_simplifier.module.js";

/** The error limit for the drawing copy, in voxels (the smallest voxel edge). Decided 2026-09-18. */
export const DRAW_ERROR_VOXELS = 0.2;

/** A structure too small to be worth the work: drawn as it is. */
const MIN_TRIANGLES = 200;

export interface DecimateResult {
  drawIndices: Uint32Array;
  /** The simplifier's own error figure for this mesh, in the mesh's units (approximate). */
  error: number;
  /** Vertices held in place: where the surface is thinner than a voxel, and every small piece. */
  locked: number;
}

let ready: Promise<void> | undefined;
export function decimatorReady(): Promise<void> {
  return (ready ??= MeshoptSimplifier.ready);
}

/** A piece with fewer triangles than this is kept whole: a speck or a short branch is the thing a
 *  quadric collapses to nothing "within the limit". */
const SMALL_PIECE_TRIANGLES = 300;
/** Two vertices closer than this many voxels are the two sides of a wall thinner than a voxel: a
 *  1-voxel vessel, a bronchial tip, a plate. Surface nets puts one vertex per cell, so vertices of
 *  ONE side are about a voxel apart; only a collapsing wall brings two within this. Held in place. */
const THIN_VOXELS = 0.3;

/**
 * WHAT THE QUADRIC CANNOT SEE, AND IS TOLD (critic, 2026-09-18, finding 2). The simplifier's error
 * is a distance to planes; sliding a vertex along a tube's axis costs nothing by that measure, so a
 * one-voxel-wide vessel (a sliver 0.06 voxel thick after surface nets and smoothing) collapsed to
 * nothing at "0.045 error", a tapering vessel lost its one-voxel tail, and on Ron's lung vessels
 * 29 of 52 pieces of the airways vanished. So the vertices a quadric would mistreat are locked
 * before it runs: every vertex of a small piece, and every vertex with another vertex within
 * THIN_VOXELS -- the two sides of a wall thinner than a voxel. (Normals cannot tell: on a collapsed
 * one-voxel tube the smoothed normals point along the tube's axis.) Thin things keep their
 * triangles; everything else decimates as before.
 */
export function lockedVertices(positions: Float32Array, normals: Float32Array, indices: Uint32Array, voxel: number): Uint8Array {
  const nv = positions.length / 3;
  const lock = new Uint8Array(nv);
  // 1. Small pieces, by union-find over the triangle graph.
  const parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = find(indices[t]), b = find(indices[t + 1]), c = find(indices[t + 2]);
    if (b !== a) parent[b] = a;
    if (c !== a) parent[find(c)] = a;
  }
  const triCount = new Int32Array(nv);
  for (let t = 0; t < indices.length; t += 3) triCount[find(indices[t])]++;
  for (let i = 0; i < nv; i++) if (triCount[find(i)] > 0 && triCount[find(i)] < SMALL_PIECE_TRIANGLES) lock[i] = 1;
  // 2. Thin walls: a SPARSE grid of cells THIN_VOXELS wide -- a dense grid over a whole-body box at
  //    0.2 mm is 640 million cells. Occupied cells get compact ids through an open-addressing hash
  //    on typed arrays; vertices are counting-sorted by cell; each vertex looks at the 27 cells
  //    around it. Six million vertices in a few seconds, in the worker.
  void normals;
  if (nv > 0) {
    const cell = THIN_VOXELS * voxel, r2 = cell * cell;
    let minx = Infinity, miny = Infinity, minz = Infinity;
    for (let i = 0; i < nv; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
    }
    // Cell coordinates up to 2^21 per axis packed into one double: exact below 2^53.
    const cellKey = (x: number, y: number, z: number) => (x * 2097152 + y) * 2097152 + z;
    let cap = 1; while (cap < nv * 2) cap <<= 1;
    const hkeys = new Float64Array(cap), hvals = new Int32Array(cap).fill(-1);
    const hash = (k: number) => { const lo = k >>> 0, hi = Math.floor(k / 4294967296) >>> 0; return (Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b) >>> 0) & (cap - 1); };
    const lookup = (k: number): number => { let h = hash(k); for (;;) { const v = hvals[h]; if (v < 0) return -1; if (hkeys[h] === k) return v; h = (h + 1) & (cap - 1); } };
    let ncell = 0;
    const cellOf = new Int32Array(nv), cx = new Int32Array(nv), cy = new Int32Array(nv), cz = new Int32Array(nv);
    for (let i = 0; i < nv; i++) {
      cx[i] = Math.floor((positions[i * 3] - minx) / cell); cy[i] = Math.floor((positions[i * 3 + 1] - miny) / cell); cz[i] = Math.floor((positions[i * 3 + 2] - minz) / cell);
      const k = cellKey(cx[i], cy[i], cz[i]);
      let h = hash(k);
      for (;;) { const v = hvals[h]; if (v < 0) { hkeys[h] = k; hvals[h] = ncell; cellOf[i] = ncell++; break; } if (hkeys[h] === k) { cellOf[i] = v; break; } h = (h + 1) & (cap - 1); }
    }
    const starts = new Int32Array(ncell + 1);
    for (let i = 0; i < nv; i++) starts[cellOf[i] + 1]++;
    for (let c = 0; c < ncell; c++) starts[c + 1] += starts[c];
    const order = new Int32Array(nv); const fill = starts.slice(0, ncell);
    for (let i = 0; i < nv; i++) order[fill[cellOf[i]]++] = i;
    for (let i = 0; i < nv; i++) {
      if (lock[i]) continue;
      const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
      let thin = false;
      for (let dx = -1; dx <= 1 && !thin; dx++) for (let dy = -1; dy <= 1 && !thin; dy++) for (let dz = -1; dz <= 1 && !thin; dz++) {
        const x = cx[i] + dx, y = cy[i] + dy, z = cz[i] + dz;
        if (x < 0 || y < 0 || z < 0) continue;
        const cc = lookup(cellKey(x, y, z)); if (cc < 0) continue;
        for (let q = starts[cc]; q < starts[cc + 1]; q++) {
          const j = order[q]; if (j === i) continue;
          const ddx = positions[j * 3] - px, ddy = positions[j * 3 + 1] - py, ddz = positions[j * 3 + 2] - pz;
          if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) { thin = true; break; }
        }
      }
      if (thin) lock[i] = 1;
    }
  }
  return lock;
}

/**
 * The drawing copy of one mesh: an index list into the SAME positions with at most `errorLimit`
 * (mesh units) of deviation, thin parts and small pieces held in place. `voxel` is the smallest
 * voxel edge in mesh units (the thinness test is in voxels). Synchronous once `decimatorReady()`
 * has resolved.
 */
/** A few hundred milliseconds per large structure (measured 200-360 ms on the lung vessels' pieces
 *  under V8); a whole-body result about three seconds in the worker. */
export function decimateForDrawing(positions: Float32Array, normals: Float32Array, indices: Uint32Array, errorLimit: number, voxel: number): DecimateResult {
  if (indices.length / 3 < MIN_TRIANGLES) return { drawIndices: indices, error: 0, locked: 0 };
  const lock = lockedVertices(positions, normals, indices, voxel);
  let locked = 0; for (let i = 0; i < lock.length; i++) locked += lock[i];
  // No attributes weighed (an empty weight list); the positions stand in as the attribute stream
  // because the wrapper asserts a stride of at least the weights' count and a length divisible by it.
  const [out, err] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, positions, 3, [], lock, 0, errorLimit, ["ErrorAbsolute"]);
  return { drawIndices: out, error: err, locked };
}

/** The smallest voxel edge of an ijk->RAS matrix (row-major 4x4): the unit the limit is in. */
export function smallestVoxelEdge(ijkToRAS: ArrayLike<number>): number {
  const m = ijkToRAS;
  const col = (c: number) => Math.hypot(m[c], m[4 + c], m[8 + c]);
  return Math.min(col(0), col(1), col(2)) || 1;
}
