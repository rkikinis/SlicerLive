// A LABELMAP AS SURFACES, without VTK and without resampling.
//
// Ron, on the SDF surface at 5.54 mm: "the surfaces are too coarse and the boundaries are too jagged,
// perhaps because of the coarse elements." They were: an SDF costs 64 bytes a voxel, so a 500 x 500 x
// 1418 mm series has to be capped to a 256-per-axis grid to fit in memory at all. A mesh costs by
// surface AREA, so it can stay at native resolution.
//
// Ron: "check how andras did it when you push the 3d button in the slicer segmentation module." That
// button is `vtkBinaryLabelmapToClosedSurfaceConversionRule`, and its own parameter descriptions name
// the pipeline: vtkDiscreteFlyingEdges3D or `vtkSurfaceNets3D (more performant than flying edges)`,
// then a smoothing factor, a decimation factor ("0.8 typically reduces data set size by 80% without
// losing too much details"), joint smoothing, and computed surface normals.
//
// SURFACE NETS, for the reason that matters here rather than for speed. Slicer needs a separate
// "joint smoothing" option because it extracts each segment on its own and then has to stop the
// surfaces cracking apart where they touch. Surface nets places ONE vertex per cell, shared by every
// label meeting in that cell -- so 95 parcels that border each other cannot separate, because they
// are the same vertices. The problem is designed out instead of corrected afterwards.
//
// Smoothing is Taubin's: a Laplacian pass with lambda > 0 followed by one with mu < 0, which is what
// keeps the surface from shrinking the way repeated Laplacian smoothing does. That is the same family
// as the vtkWindowedSincPolyDataFilter Slicer's rule uses.
//
// Decimation is deliberately NOT here. It is an optimization, and the honest order is to extract,
// measure, and only write it if the triangle count demands it.
import type { Vec3 } from "../render/mat4.ts";

// ── PORTING THIS TO THE GPU ──────────────────────────────────────────────────────────────────────
//
// Written for whoever does that, because the comments below explain the algorithm to a reader and
// this is the part a porter needs. Full brief, including why: docs/GREASED-LIGHTNING.md.
//
// WHAT IS GENUINELY PARALLEL, phase by phase:
//
//   1. Vertex per cell -- fully independent. Each cell reads its 8 corners and writes one vertex.
//      No cell looks at another. The only coupling is WHERE the vertex lands in the output array.
//   2. Quads -- fully independent per voxel. Each voxel tests three faces (+x, +y, +z) and appends
//      up to three quads. The append is the only contention; on the GPU that is an atomic bump, or
//      a count pass followed by a prefix sum and a fill pass, which is what phase 4 already does on
//      the CPU and is usually faster than atomics here.
//   3. Taubin smoothing -- independent per VERTEX within a pass, with a global barrier between
//      passes. One dispatch per pass over ping-ponged buffers, 48 of them at the current default.
//      Gathers over a CSR adjacency; building that adjacency is itself a count-then-fill.
//   4. Per-label meshes -- independent per label, and already count-then-fill.
//
// WHAT IS NOT A REAL DEPENDENCY, though the code makes it look like one:
//
// * VERTEX NUMBERING IS SCAN ORDER ONLY BECAUSE A SEQUENTIAL LOOP PRODUCES IT. Nothing depends on
//   the numbering; only the cell -> vertex MAPPING has to be consistent between phases 1 and 2. A
//   prefix sum over the "this cell has a vertex" mask gives a different numbering and an identical
//   mesh, up to a permutation of the vertex array. Do that.
// * THE TWO RESIDENT CELL PLANES (prev/cur) are a memory optimization for the CPU, not an ordering
//   constraint -- see the comment at the top of phase 1. A GPU has the whole cell-vertex index
//   buffer addressable at once and does not need the window. It DOES still need the buffer to be
//   sized by cells-with-vertices rather than by cells, for the same reason the window exists here.
// * QUAD ORDER, and therefore triangle order within a label, affects nothing but reproducibility.
//
// WHAT IS ESSENTIAL AND MUST SURVIVE:
//
// * ONE VERTEX PER CELL, SHARED BY EVERY LABEL MEETING IN IT. This is the whole reason for choosing
//   surface nets, not an implementation detail -- see the note above. A per-label extraction that
//   cracks at shared boundaries is a regression however fast it is.
// * NATIVE RESOLUTION. Every earlier attempt was rejected on appearance for being coarse.
// * MEMORY FOLLOWS THE SURFACE, NEVER THE GRID. A cell-indexed array over this study is 1.67 GB and
//   was silently OOM-killed. `surface-nets.test.ts` pins this; keep that test passing.
// * The winding rule at the end of phase 4: a face is emitted into BOTH neighboring labels with
//   opposite winding. Get it wrong and every second parcel renders inside-out.
//
// HOW TO KNOW YOU DID IT RIGHT: 12,121,372 triangles on the NEPHROGENIC ts:total checkpoint at the
// current defaults, and the seven tests in surface-nets.test.ts. Details in the brief.


/** One label's surface. Positions are RAS; indices are triangles. */
export interface LabelMesh {
  label: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /**
   * THE DRAWING COPY: a shorter index list into the same positions and normals, within 0.2 voxel of
   * the full mesh (logic/decimate.ts). Absent until made; the renderer draws it when present. The
   * full `indices` remain the data -- what is saved, measured and picked against.
   */
  drawIndices?: Uint32Array;
}

export interface SurfaceNetsOpts {
  /** Taubin iterations. Slicer's smoothing factor maps onto this; 0 leaves the raw net. */
  smoothIters?: number;   // default DEFAULT_SMOOTH_ITERS
  lambda?: number;
  mu?: number;
  /** Labels to extract; omit for every non-zero label present. */
  only?: Set<number>;
  /** Passes of normal smoothing. Geometry is untouched; this only affects shading. */
  normalSmooth?: number;   // default DEFAULT_NORMAL_SMOOTH
  /**
   * Called once per z-plane. A whole-body extraction takes tens of seconds, and twice now Ron has
   * watched one with nothing on screen to say it was running: "There is no indication that something
   * is happening." The caller turns this into a status line.
   */
  onProgress?: (done: number, total: number) => void;
}

// DEFAULTS, MEASURED ON ANISOTROPIC VOXELS RATHER THAN CHOSEN.
//
// Ron, on a whole-body CT whose surfaces had finally built: "still ugly" -- the ribs terraced. The
// geometry was not the problem: measured against an exact oblique cylinder on 0.7 x 0.7 x 2.0 mm
// voxels it was already accurate to 0.6 mm, and more Taubin iterations barely moved it. The SHADING
// was. Terracing you can see is a discontinuous normal field, not a displaced surface.
//
// Normal error (p95) against that cylinder, by normal-smoothing passes:
//
//        passes    0     4     8    12    16    24
//        p95    38.7  16.9  11.1   8.1   7.1   7.6 degrees
//
// The old default of 4 sat almost at the top of that curve, and it turns over past 16 -- more passes
// start flattening real detail without buying accuracy. 16 is the measured floor, not a round number.
//
// The isotropic sphere test never caught this because on isotropic voxels the same setting gives 4
// degrees, well inside what looks smooth. Anisotropy is the case that matters and it was untested.
//
// Taubin iterations went 12 -> 24 for the geometry alone: p95 0.54 -> 0.49 mm against the cylinder.
// It contributes little to the normals (7.9 -> 7.5 degrees at 12 passes) and is not the fix.
export const DEFAULT_SMOOTH_ITERS = 24;
export const DEFAULT_NORMAL_SMOOTH = 16;

/** The 12 edges of a cell, as pairs of corner indices in the 0..7 corner numbering below. */
const CELL_EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],   // along x
  [0, 2], [1, 3], [4, 6], [5, 7],   // along y
  [0, 4], [1, 5], [2, 6], [3, 7],   // along z
];
/** Corner c of a cell, as (dx,dy,dz) with bit 0 = x, bit 1 = y, bit 2 = z. */
const CORNER: Vec3[] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

/**
 * Extract one closed surface per label.
 *
 * `lab` is indexed (k * ny + j) * nx + i, matching every other labelmap here.
 */
export function surfaceNets(
  lab: ArrayLike<number>,
  dims: Vec3,
  ijkToRAS: ArrayLike<number>,
  opts: SurfaceNetsOpts = {},
): LabelMesh[] {
  const [nx, ny, nz] = dims;
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  if (cx < 1 || cy < 1 || cz < 1) return [];
  const at = (i: number, j: number, k: number) => lab[(k * ny + j) * nx + i];
  const onProgress = opts.onProgress;

  // ── FLAT LOOKUP TABLES, for the sake of the engine the application actually runs ──
  //
  // The readable CORNER / CELL_EDGES tables above are arrays of arrays, and the hot loop below used
  // to walk them with `CORNER[c][0]` and `for (const [a, b] of CELL_EDGES)`, calling the `at` closure
  // eight times per cell -- 3.3 BILLION closure calls on a whole-body study.
  //
  // V8 optimizes that away. JavaScriptCore, which is what the webview runs, does not: measured on
  // identical code and input, JSC took 3.09 s against V8's 0.45 s for these phases, 6.9x, while
  // phases 3-4 were the same speed in both. That ratio is the whole of the application's 118 s.
  //
  // So: corner offsets precomputed as LINEAR indices (one array read per corner instead of a
  // multiply-add chain and two indirections), edge endpoints and their midpoints -- which are
  // constants -- in flat typed arrays, and no iterator or destructuring in the inner loop.
  const nxny = nx * ny;
  const CORNER_OFF = new Int32Array(8);
  for (let c = 0; c < 8; c++) CORNER_OFF[c] = CORNER[c][2] * nxny + CORNER[c][1] * nx + CORNER[c][0];
  const EDGE_A = new Int32Array(12), EDGE_B = new Int32Array(12);
  const EDGE_MX = new Float64Array(12), EDGE_MY = new Float64Array(12), EDGE_MZ = new Float64Array(12);
  for (let e = 0; e < 12; e++) {
    const a = CELL_EDGES[e][0], b = CELL_EDGES[e][1];
    EDGE_A[e] = a; EDGE_B[e] = b;
    EDGE_MX[e] = (CORNER[a][0] + CORNER[b][0]) / 2;
    EDGE_MY[e] = (CORNER[a][1] + CORNER[b][1]) / 2;
    EDGE_MZ[e] = (CORNER[a][2] + CORNER[b][2]) / 2;
  }

  // ── 1 & 2, INTERLEAVED: vertices and quads, one z-plane at a time ──
  //
  // TWO CELL-PLANES RESIDENT, NEVER THE WHOLE GRID. The first version kept a cell->vertex index for
  // every cell: an Int32Array over 768 x 768 x 709 is 417 million entries, 1.67 GB, on top of the
  // labelmap and the growing output. It measured fine under a raised heap limit and died silently in
  // a browser worker, leaving the coarse SDF on screen with nothing to say why -- Ron: "Nothing seems
  // to happen after loading nephrogenic."
  //
  // Every quad a voxel emits references cells in planes k-1 and k only -- check the three faces below
  // and none reaches further. So two planes suffice: 767 x 767 x 4 bytes x 2 is under 5 MB, against
  // 1.67 GB, and nothing about the result changes.
  //
  // Vertex indices stay GLOBAL, because they index the output arrays rather than the window.
  let vcap = 1 << 16, vn = 0;
  let vx = new Float32Array(vcap), vy = new Float32Array(vcap), vz = new Float32Array(vcap);
  const growV = () => {
    vcap *= 2;
    const nx2 = new Float32Array(vcap); nx2.set(vx); vx = nx2;
    const ny2 = new Float32Array(vcap); ny2.set(vy); vy = ny2;
    const nz2 = new Float32Array(vcap); nz2.set(vz); vz = nz2;
  };
  // Six numbers a quad in one flat array -- label a, label b, and its four vertices -- rather than an
  // object apiece, which is what buried the heap before this.
  let qcap = 1 << 16, qn = 0;
  let qa = new Int32Array(qcap), qb = new Int32Array(qcap), qv = new Uint32Array(qcap * 4);
  const growQ = () => {
    qcap *= 2;
    const a2 = new Int32Array(qcap); a2.set(qa); qa = a2;
    const b2 = new Int32Array(qcap); b2.set(qb); qb = b2;
    const v2 = new Uint32Array(qcap * 4); v2.set(qv); qv = v2;
  };
  const addQuad = (a: number, b: number, v0: number, v1: number, v2: number, v3: number) => {
    if (qn === qcap) growQ();
    qa[qn] = a; qb[qn] = b;
    qv[qn * 4] = v0; qv[qn * 4 + 1] = v1; qv[qn * 4 + 2] = v2; qv[qn * 4 + 3] = v3;
    qn++;
  };

  let prev = new Int32Array(cx * cy).fill(-1);   // cell plane k-1
  let cur = new Int32Array(cx * cy).fill(-1);    // cell plane k
  const corners = new Int32Array(8);
  /** A cell's vertex, from whichever of the two resident planes it is in; -1 outside the window. */
  const cvAt = (i: number, j: number, plane: Int32Array) =>
    (i < 0 || j < 0 || i >= cx || j >= cy) ? -1 : plane[j * cx + i];

  for (let k = 0; k < nz; k++) {
    // Build cell plane k.
    if (k < cz) {
      for (let j = 0; j < cy; j++) {
        let base = k * nxny + j * nx;
        for (let i = 0; i < cx; i++, base++) {
          let same = true;
          const c0 = lab[base];
          for (let c = 0; c < 8; c++) {
            const v = lab[base + CORNER_OFF[c]];
            corners[c] = v;
            if (v !== c0) same = false;
          }
          if (same) continue;
          // The vertex sits at the average of the crossings on the cell's edges. A label boundary is
          // categorical -- there is no value to interpolate, unlike an isosurface -- so each crossing
          // is the edge's midpoint. Averaging them still pulls the vertex toward the true surface: a
          // cell cut across one corner gets a vertex near that corner, not at the cell center.
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (let e = 0; e < 12; e++) {
            if (corners[EDGE_A[e]] === corners[EDGE_B[e]]) continue;
            sx += EDGE_MX[e]; sy += EDGE_MY[e]; sz += EDGE_MZ[e];
            n++;
          }
          if (vn === vcap) growV();
          cur[j * cx + i] = vn;
          vx[vn] = i + sx / n; vy[vn] = j + sy / n; vz[vn] = k + sz / n;
          vn++;
        }
      }
    }
    // Quads for voxel plane k. A face between voxel A and voxel B belongs to BOTH: it is the outside
    // of A and the outside of B, so it is emitted into each one's mesh with opposite winding, and
    // background (0) simply gets no mesh of its own.
    for (let j = 0; j < ny; j++) {
      let base = k * nxny + j * nx;
      for (let i = 0; i < nx; i++, base++) {
        const a = lab[base];
        if (i + 1 < nx) {
          const b = lab[base + 1];
          if (a !== b) {
            const c0 = cvAt(i, j - 1, prev), c1 = cvAt(i, j, prev), c2 = cvAt(i, j, cur), c3 = cvAt(i, j - 1, cur);
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) addQuad(a, b, c0, c1, c2, c3);
          }
        }
        if (j + 1 < ny) {
          const b = lab[base + nx];
          if (a !== b) {
            const c0 = cvAt(i - 1, j, prev), c1 = cvAt(i - 1, j, cur), c2 = cvAt(i, j, cur), c3 = cvAt(i, j, prev);
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) addQuad(a, b, c0, c1, c2, c3);
          }
        }
        if (k + 1 < nz) {
          const b = lab[base + nxny];
          if (a !== b) {
            const c0 = cvAt(i - 1, j - 1, cur), c1 = cvAt(i, j - 1, cur), c2 = cvAt(i, j, cur), c3 = cvAt(i - 1, j, cur);
            if (c0 >= 0 && c1 >= 0 && c2 >= 0 && c3 >= 0) addQuad(a, b, c0, c1, c2, c3);
          }
        }
      }
    }
    onProgress?.(k + 1, nz);
    const t = prev; prev = cur; cur = t; cur.fill(-1);
  }
  if (!vn) return [];

  // ── 3. Taubin smoothing on the SHARED vertices ──
  // Shared is the point: every label meeting in a cell uses that cell's one vertex, so smoothing moves
  // them together and no seam can open. This is what Slicer's "joint smoothing" option buys, obtained
  // here from the representation rather than from a second pass.
  const iters = opts.smoothIters ?? DEFAULT_SMOOTH_ITERS;
  if (iters > 0) {
    const nv = vn;
    // Neighbors from quad edges, as a CSR-style adjacency: counted, then filled.
    const deg = new Uint32Array(nv);
    for (let t = 0; t < qn; t++) {
      for (let e = 0; e < 4; e++) { deg[qv[t * 4 + e]]++; deg[qv[t * 4 + ((e + 1) & 3)]]++; }
    }
    const off = new Uint32Array(nv + 1);
    for (let n = 0; n < nv; n++) off[n + 1] = off[n] + deg[n];
    const adj = new Uint32Array(off[nv]);
    const cur = off.slice(0, nv);
    for (let t = 0; t < qn; t++) {
      for (let e = 0; e < 4; e++) {
        const u = qv[t * 4 + e], v = qv[t * 4 + ((e + 1) & 3)];
        adj[cur[u]++] = v; adj[cur[v]++] = u;
      }
    }
    const lam = opts.lambda ?? 0.6, mu = opts.mu ?? -0.62;   // mu slightly under -lambda: Taubin's pass-band
    let px = Float64Array.from(vx.subarray(0, nv)), py = Float64Array.from(vy.subarray(0, nv)), pz = Float64Array.from(vz.subarray(0, nv));
    let qx = new Float64Array(nv), qy = new Float64Array(nv), qz = new Float64Array(nv);
    const step = (f: number) => {
      for (let n = 0; n < nv; n++) {
        const s = off[n], e = off[n + 1], d = e - s;
        if (!d) { qx[n] = px[n]; qy[n] = py[n]; qz[n] = pz[n]; continue; }
        let ax = 0, ay = 0, az = 0;
        for (let t = s; t < e; t++) { const m = adj[t]; ax += px[m]; ay += py[m]; az += pz[m]; }
        qx[n] = px[n] + f * (ax / d - px[n]);
        qy[n] = py[n] + f * (ay / d - py[n]);
        qz[n] = pz[n] + f * (az / d - pz[n]);
      }
      [px, qx] = [qx, px]; [py, qy] = [qy, py]; [pz, qz] = [qz, pz];
    };
    // TWO PASSES PER ITERATION, the second with a negative factor. A Laplacian pass alone shrinks the
    // surface a little every time -- run it enough to look smooth and a structure visibly deflates.
    // Taubin's second pass pushes back at slightly more than it pulled, which cancels the shrinkage
    // while leaving the smoothing.
    for (let t = 0; t < iters; t++) { step(lam); step(mu); }
    for (let n = 0; n < nv; n++) { vx[n] = px[n]; vy[n] = py[n]; vz[n] = pz[n]; }
  }

  // ── 4. one mesh per label, in RAS ──
  const m = ijkToRAS;
  // COUNT, THEN FILL, so a label's quads live in one exactly-sized index array rather than in a
  // growing list of references. Two linear passes over the quads instead of one, and no per-label
  // array of objects -- which on a whole-body segmentation is the difference between working and not.
  // FLAT ARRAYS INDEXED BY LABEL, not Maps keyed by it. Both passes below touch every quad twice, so
  // a Map cost ~24 million get/set calls on this study, and `[qa[t], qb[t]]` allocated a two-element
  // array per quad on top. Labels are small integers, so a dense array indexed by label is a direct
  // load -- the same reasoning as the flat corner tables in phase 1, applied here.
  let maxLab = 0;
  for (let t = 0; t < qn; t++) {
    if (qa[t] > maxLab) maxLab = qa[t];
    if (qb[t] > maxLab) maxLab = qb[t];
  }
  const wanted = new Uint8Array(maxLab + 1);
  for (let l = 1; l <= maxLab; l++) wanted[l] = (!opts.only || opts.only.has(l)) ? 1 : 0;
  const counts = new Uint32Array(maxLab + 1);
  for (let t = 0; t < qn; t++) {
    const a = qa[t], b = qb[t];
    if (wanted[a]) counts[a]++;
    if (wanted[b]) counts[b]++;
  }
  const buckets: (Uint32Array | undefined)[] = new Array(maxLab + 1);
  const fills = new Uint32Array(maxLab + 1);
  for (let l = 1; l <= maxLab; l++) if (counts[l]) buckets[l] = new Uint32Array(counts[l]);
  for (let t = 0; t < qn; t++) {
    const a = qa[t], b = qb[t];
    if (wanted[a]) { buckets[a]![fills[a]++] = t; }
    if (wanted[b]) { buckets[b]![fills[b]++] = t; }
  }
  const out: LabelMesh[] = [];
  // ONE REMAP TABLE FOR EVERY LABEL, not a Map per label. A Map keyed on millions of vertex indices
  // is what made a whole-body study take minutes: measured on a single label with 12.4M vertices, the
  // per-label build alone was 6.4s against 1.4s for the extraction that produced it. Hashing and
  // number[] growth, not geometry.
  //
  // `gen` records which label last claimed a global vertex and `loc` its index within that label, so
  // a label is entered by writing two array slots and left by simply moving on -- no clearing pass,
  // because the generation number no longer matches.
  const gen = new Int32Array(vn).fill(-1);
  const loc = new Uint32Array(vn);
  let li = 0;
  const labelList: number[] = [];
  for (let l = 1; l <= maxLab; l++) if (buckets[l]) labelList.push(l);
  for (const label of labelList) {                      // ascending, as the sorted Map was
    const qs = buckets[label]!;
    const indices = new Uint32Array(qs.length * 6);
    // A closed surface has roughly as many vertices as quads; start there and double. The 4-per-quad
    // upper bound would be 288 MB for a label this size, allocated and then mostly thrown away.
    let pcap = Math.max(qs.length + 16, 1 << 12), pn = 0;
    let pos = new Float32Array(pcap * 3);
    const local = (g: number) => {
      if (gen[g] === li) return loc[g];
      if (pn === pcap) { pcap *= 2; const b = new Float32Array(pcap * 3); b.set(pos); pos = b; }
      gen[g] = li; loc[g] = pn;
      pos[pn * 3] = vx[g]; pos[pn * 3 + 1] = vy[g]; pos[pn * 3 + 2] = vz[g];
      return pn++;
    };
    let w = 0;
    for (const t of qs) {
      // Wind so the face points AWAY from this label: the quad's own order faces from a to b, so the
      // label on the b side takes it reversed. Without this every second parcel renders inside-out.
      const o = t * 4;
      const fwd = qa[t] === label;
      const l0 = local(qv[o + (fwd ? 0 : 3)]), l1 = local(qv[o + (fwd ? 1 : 2)]);
      const l2 = local(qv[o + (fwd ? 2 : 1)]), l3 = local(qv[o + (fwd ? 3 : 0)]);
      indices[w++] = l0; indices[w++] = l1; indices[w++] = l2;
      indices[w++] = l0; indices[w++] = l2; indices[w++] = l3;
    }
    li++;
    // IJK -> RAS once per vertex, in place, rather than inside the remap.
    const positions = pos.slice(0, pn * 3);
    for (let n = 0; n < positions.length; n += 3) {
      const i = positions[n], j = positions[n + 1], k = positions[n + 2];
      positions[n] = m[0] * i + m[1] * j + m[2] * k + m[3];
      positions[n + 1] = m[4] * i + m[5] * j + m[6] * k + m[7];
      positions[n + 2] = m[8] * i + m[9] * j + m[10] * k + m[11];
    }
    const raw = vertexNormals(positions, indices);
    out.push({ label, positions, normals: smoothNormals(positions, indices, raw, opts.normalSmooth ?? DEFAULT_NORMAL_SMOOTH), indices });
  }
  return out;
}

/**
 * Average each normal with its neighbors', a few times. THE GEOMETRY IS NOT TOUCHED.
 *
 * Ron: "how is the quality of the surface normals? In my experience those are two features worth
 * paying attention to." Measured against an exact sphere, the raw area-weighted normals come out at
 * mean 4.20 deg, p95 9.34, worst 28.10 -- and the tail is what shows, as speckle on an otherwise
 * smooth surface. Angle weighting (Thurmer & Wuthrich) does not help: 4.23 deg mean, so the weighting
 * is not what is wrong. The discretisation is, and averaging over the neighborhood is what answers
 * it: at four passes, mean 1.71, p95 4.26, worst 7.22 -- the worst case improves fourfold.
 *
 * Cheap, and safe in a way position smoothing is not: nothing moves, so no volume is lost and no thin
 * structure thins further. It changes only how the surface is lit.
 */
export function smoothNormals(pos: Float32Array, idx: Uint32Array, nrm: Float32Array, iters: number): Float32Array {
  if (iters <= 0) return nrm;
  const nv = pos.length / 3;
  const deg = new Uint32Array(nv);
  for (let t = 0; t < idx.length; t += 3) for (let c = 0; c < 3; c++) deg[idx[t + c]] += 2;
  const off = new Uint32Array(nv + 1);
  for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[nv]);
  const cur = off.slice(0, nv);
  for (let t = 0; t < idx.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = idx[t + c], b = idx[t + (c + 1) % 3];
      adj[cur[a]++] = b; adj[cur[b]++] = a;
    }
  }
  let n = nrm;
  for (let it = 0; it < iters; it++) {
    const o = new Float32Array(n.length);
    for (let v = 0; v < nv; v++) {
      let x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2];
      for (let t = off[v]; t < off[v + 1]; t++) { const w = adj[t] * 3; x += n[w]; y += n[w + 1]; z += n[w + 2]; }
      const L = Math.hypot(x, y, z) || 1;
      o[v * 3] = x / L; o[v * 3 + 1] = y / L; o[v * 3 + 2] = z / L;
    }
    n = o;
  }
  return n;
}

/** Area-weighted vertex normals: the cross product of each triangle's edges is already proportional
 *  to its area, so summing them unnormalized weights big triangles more, which is what you want. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const px = uy * wz - uz * wy, py = uz * wx - ux * wz, pz = ux * wy - uy * wx;
    // UNROLLED. This was `for (const o of [a, b, c])`, which allocated a three-element array per
    // TRIANGLE -- 12.1 million allocations on this study, all of them garbage.
    n[a] += px; n[a + 1] += py; n[a + 2] += pz;
    n[b] += px; n[b + 1] += py; n[b + 2] += pz;
    n[c] += px; n[c + 1] += py; n[c + 2] += pz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const L = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= L; n[i + 1] /= L; n[i + 2] /= L;
  }
  return n;
}
