// THE SURFACE HAS TO BE CLOSED, FACING OUTWARD, AND WELDED WHERE LABELS MEET.
//
// Ron asked for Slicer's "Show 3D" behavior without VTK. Three things go silently wrong in a
// surface extractor and none of them is obvious from a picture at the angle you happen to be looking
// from: a hole (an edge used by one triangle instead of two), inverted winding on some labels (which
// renders inside-out and only shows as odd lighting), and a crack between two labels that touch.
//
//   deno test -A --no-check algorithms/surface-nets.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { surfaceNets } from "./surface-nets.ts";
import type { Vec3 } from "../render/mat4.ts";

/** Every edge must be used exactly twice — the definition of a closed surface. */
function openEdges(indices: Uint32Array): number {
  const seen = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [a, b] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const n of seen.values()) if (n !== 2) open++;
  return open;
}

/** Signed volume from the divergence theorem: positive when the winding faces outward. */
function signedVolume(pos: Float32Array, idx: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += (
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])
    ) / 6;
  }
  return v;
}

const D = 40;
const ijk = [1, 0, 0, -D / 2, 0, 1, 0, -D / 2, 0, 0, 1, -D / 2, 0, 0, 0, 1];
const dims: Vec3 = [D, D, D];

Deno.test("a sphere comes out closed, outward-facing, and the right size", () => {
  const R = 12;
  const lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
    if (Math.hypot(i - D / 2, j - D / 2, k - D / 2) <= R) lab[(k * D + j) * D + i] = 1;
  }
  const [m] = surfaceNets(lab, dims, ijk);
  assertEquals(m.label, 1);
  assertEquals(openEdges(m.indices), 0, "the surface has holes");
  const vol = signedVolume(m.positions, m.indices);
  assert(vol > 0, `winding is inverted (signed volume ${vol.toFixed(0)})`);
  // Taubin is shrink-compensated, so the volume must stay near the sphere's rather than deflate.
  const truth = 4 / 3 * Math.PI * R ** 3;
  const err = Math.abs(vol - truth) / truth;
  console.log(`sphere r=${R}: ${m.indices.length / 3} triangles, volume ${vol.toFixed(0)} vs ${truth.toFixed(0)} (${(err * 100).toFixed(1)}%)`);
  assert(err < 0.10, `volume off by ${(err * 100).toFixed(1)}% — smoothing is shrinking the surface`);
});

Deno.test("smoothing does not deflate the surface as iterations grow", () => {
  const R = 12;
  const lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
    if (Math.hypot(i - D / 2, j - D / 2, k - D / 2) <= R) lab[(k * D + j) * D + i] = 1;
  }
  const vol = (n: number) => { const [m] = surfaceNets(lab, dims, ijk, { smoothIters: n }); return signedVolume(m.positions, m.indices); };
  const v0 = vol(0), v12 = vol(12), v40 = vol(40);
  console.log(`volume: raw ${v0.toFixed(0)}  12 iters ${v12.toFixed(0)}  40 iters ${v40.toFixed(0)}`);
  // A plain Laplacian would fall away steadily; Taubin's second pass is what stops it.
  assert(Math.abs(v40 - v12) / v12 < 0.05, "the surface keeps shrinking as smoothing continues");
});

Deno.test("two labels that touch share their vertices — no crack, and each faces outward", () => {
  // Two boxes meeting on a plane, so the shared face is interior to neither and belongs to both.
  const lab = new Uint8Array(D * D * D);
  for (let k = 8; k < 32; k++) for (let j = 8; j < 32; j++) for (let i = 8; i < 32; i++) {
    lab[(k * D + j) * D + i] = i < 20 ? 1 : 2;
  }
  const ms = surfaceNets(lab, dims, ijk);
  assertEquals(ms.map((m) => m.label), [1, 2]);
  for (const m of ms) {
    assertEquals(openEdges(m.indices), 0, `label ${m.label} has holes`);
    assert(signedVolume(m.positions, m.indices) > 0, `label ${m.label} is wound inside-out`);
  }
  // WELDED: every vertex on the shared plane must appear in BOTH meshes at the same place. Extracting
  // each label separately and smoothing it on its own is exactly what opens a gap here.
  const key = (p: Float32Array, i: number) => `${p[i * 3].toFixed(4)}_${p[i * 3 + 1].toFixed(4)}_${p[i * 3 + 2].toFixed(4)}`;
  const setOf = (m: typeof ms[0]) => new Set(Array.from({ length: m.positions.length / 3 }, (_, i) => key(m.positions, i)));
  const s1 = setOf(ms[0]), s2 = setOf(ms[1]);
  let shared = 0;
  for (const k of s1) if (s2.has(k)) shared++;
  console.log(`two boxes: ${ms[0].indices.length / 3} + ${ms[1].indices.length / 3} triangles, ${shared} shared vertices`);
  assert(shared > 100, `only ${shared} shared vertices — the labels are not welded`);
});

Deno.test("normals point outward", () => {
  const R = 12;
  const lab = new Uint8Array(D * D * D);
  for (let k = 0; k < D; k++) for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
    if (Math.hypot(i - D / 2, j - D / 2, k - D / 2) <= R) lab[(k * D + j) * D + i] = 1;
  }
  const [m] = surfaceNets(lab, dims, ijk);
  let worst = 1;
  for (let i = 0; i < m.positions.length; i += 3) {
    const L = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]) || 1;
    const dot = (m.positions[i] * m.normals[i] + m.positions[i + 1] * m.normals[i + 1] + m.positions[i + 2] * m.normals[i + 2]) / L;
    worst = Math.min(worst, dot);
  }
  console.log(`worst normal-vs-radial agreement: ${worst.toFixed(2)} (1 = perfectly outward)`);
  assert(worst > 0.5, `some normals face inward (worst ${worst.toFixed(2)})`);
});

// Ron: "how is the quality of the surface normals?" The MEAN was never the problem -- the tail is,
// because a handful of bad normals read as speckle on a surface that is otherwise smooth. Measured
// against an exact sphere: raw 4.20 deg mean / 28.10 worst, smoothed four times 1.71 / 7.22. Angle
// weighting instead of area weighting changes nothing (4.23 mean), so the fix is not the weighting.
Deno.test("normals are accurate, and the tail is bounded", () => {
  const R = 34, N = 96;
  const d3: Vec3 = [N, N, N];
  const ijk3 = [1, 0, 0, -N / 2, 0, 1, 0, -N / 2, 0, 0, 1, -N / 2, 0, 0, 0, 1];
  const lab = new Uint8Array(N * N * N);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (Math.hypot(i - N / 2, j - N / 2, k - N / 2) <= R) lab[(k * N + j) * N + i] = 1;
  }
  const [m] = surfaceNets(lab, d3, ijk3);
  const errs: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const L = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]) || 1;
    const dot = (m.positions[i] * m.normals[i] + m.positions[i + 1] * m.normals[i + 1] + m.positions[i + 2] * m.normals[i + 2]) / L;
    errs.push(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const p95 = errs[Math.floor(errs.length * 0.95)], max = errs[errs.length - 1];
  console.log(`normal error vs an exact sphere: mean ${mean.toFixed(2)}°  p95 ${p95.toFixed(2)}°  max ${max.toFixed(2)}°`);
  assert(mean < 2.5, `mean normal error ${mean.toFixed(2)}° is too high`);
  assert(max < 12, `worst normal error ${max.toFixed(2)}° — the tail is what shows as speckle`);
});

// The bug that kept the surfaces off Ron's screen for two sessions: peak memory scaled with the CELL
// COUNT, not with the surface. A cell->vertex Int32Array over NEPHROGENIC's 768 x 768 x 709 is 1.67 GB,
// so the worker died silently and the coarse SDF stayed up with nothing to say why.
//
// This asserts the shape of the cost rather than a number of bytes: a big grid holding a SMALL surface
// must cost about what the small surface costs. Under the old code the 64M-cell grid alone was 256 MB.
Deno.test("cost follows the surface, not the size of the grid", () => {
  const sphereIn = (n: number) => {
    const lab = new Uint8Array(n * n * n);
    const c = n / 2, r = 8;   // the SAME small sphere however big the grid is
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const dx = i - c, dy = j - c, dz = k - c;
          if (dx * dx + dy * dy + dz * dz < r * r) lab[(k * n + j) * n + i] = 1;
        }
      }
    }
    return lab;
  };
  const eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const peakFor = (n: number) => {
    const lab = sphereIn(n);
    const before = Deno.memoryUsage().heapUsed;
    let peak = 0;
    const meshes = surfaceNets(lab, [n, n, n], eye, {
      onProgress: () => { peak = Math.max(peak, Deno.memoryUsage().heapUsed - before); },
    });
    return { peak, tris: meshes[0].indices.length / 3 };
  };

  const small = peakFor(64);    //   250 thousand cells
  const big = peakFor(400);     // 63.5 million cells, 254x more

  // Same sphere, so the same surface either way -- that is what makes the comparison fair.
  assertEquals(small.tris, big.tris);
  const growth = big.peak / Math.max(small.peak, 1 << 20);
  console.log(
    `same sphere in 64^3 vs 400^3: ${small.tris} triangles both, peak ${(small.peak / 1e6).toFixed(1)} MB` +
    ` vs ${(big.peak / 1e6).toFixed(1)} MB (${growth.toFixed(1)}x for 254x the cells)`,
  );
  // Two resident cell planes grow as n^2, not n^3, and the sphere's own arrays do not grow at all.
  // Old code: 254x. Ten leaves room for the planes and for GC timing without admitting a third plane.
  assert(growth < 10, `peak memory grew ${growth.toFixed(1)}x with the grid; it must follow the surface`);
});

// NORMALS ON ANISOTROPIC VOXELS -- the case the sphere tests above do not cover, and the reason Ron's
// ribs looked terraced after the extraction was finally running: "still ugly".
//
// Every other test here samples an isotropic grid, where the shipped settings give ~4 degrees and the
// surface looks smooth. On 0.7 x 0.7 x 2.0 mm voxels the same settings gave 16 degrees, which reads as
// banding under a directional light. The geometry was fine throughout -- 0.6 mm against an exact
// cylinder -- so this bounds the SHADING, which is what was actually wrong.
Deno.test("normals stay accurate when the voxels are anisotropic", () => {
  const R = 6, sx = 0.7, sy = 0.7, sz = 2.0;        // a plausible whole-body CT
  const L = Math.hypot(1, 0.15, 0.30);
  const d = [1 / L, 0.15 / L, 0.30 / L];            // oblique, so the structure crosses slices
  const nx = Math.round(112 / sx), ny = Math.round(77 / sy), nz = Math.round(80 / sz);
  const cx = nx / 2, cy = ny / 2, cz = nz / 2;
  const lab = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = (i - cx) * sx, y = (j - cy) * sy, z = (k - cz) * sz;
        const t = x * d[0] + y * d[1] + z * d[2];
        const r = Math.hypot(x - t * d[0], y - t * d[1], z - t * d[2]);
        if (Math.abs(t) < 40 && r < R) lab[(k * ny + j) * nx + i] = 1;
      }
    }
  }
  const m = [sx, 0, 0, -cx * sx, 0, sy, 0, -cy * sy, 0, 0, sz, -cz * sz, 0, 0, 0, 1];
  const mesh = surfaceNets(lab, [nx, ny, nz], m)[0];

  const ang: number[] = [], rad: number[] = [];
  for (let n = 0; n < mesh.positions.length; n += 3) {
    const x = mesh.positions[n], y = mesh.positions[n + 1], z = mesh.positions[n + 2];
    const t = x * d[0] + y * d[1] + z * d[2];
    if (Math.abs(t) > 34) continue;                 // the end caps are not cylinder
    const rx = x - t * d[0], ry = y - t * d[1], rz = z - t * d[2];
    const rl = Math.hypot(rx, ry, rz) || 1;
    const dot = (mesh.normals[n] * rx + mesh.normals[n + 1] * ry + mesh.normals[n + 2] * rz) / rl;
    ang.push(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI);
    rad.push(Math.abs(rl - R));
  }
  ang.sort((a, b) => a - b); rad.sort((a, b) => a - b);
  const p95 = ang[Math.floor(ang.length * 0.95)];
  console.log(
    `oblique cylinder on 0.7 x 0.7 x 2.0 mm voxels: normals p95 ${p95.toFixed(1)}° max ${ang[ang.length - 1].toFixed(1)}°` +
    `, radius p95 ${rad[Math.floor(rad.length * 0.95)].toFixed(2)} mm`,
  );
  // 16.1 degrees with the old normalSmooth of 4; 7.0 at the measured optimum. 9 leaves room for the
  // tail without letting it drift back to where the terracing was visible.
  assert(p95 < 9, `normal p95 ${p95.toFixed(1)}° -- anisotropic voxels are shading as terraces`);
  // Geometry was never the problem here; this pins it so a future smoothing change cannot trade the
  // shape away for the shading.
  assert(rad[Math.floor(rad.length * 0.95)] < sz / 2, "radius error exceeds half a slice");
});
