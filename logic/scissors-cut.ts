// SCISSORS' ARITHMETIC (Ron, 2026-10-30: "slicer has the scisor effect. no heuristic needed. It's essentially a prism
// boolean on the label selected. Applied twice or three times in sequence it can do a lot. an intuitive UI is critical").
// An outline drawn on a view is extended through the whole scan along that view's direction -- straight along a slice's
// normal, along the camera's rays in 3D -- and the structure's voxels inside it are cut away, or everything of the
// structure outside it (keep only). Other structures are never touched. Pure functions: the tool is
// render/demos/seg-tools/scissors.ts.
import { pieceAt } from "./threshold-tool.ts";

export type Vec3 = [number, number, number];

/** An outline (2D points) rasterized once onto a grid over its bounding box, so a point's test is one lookup. */
export interface Outline { inside(x: number, y: number): boolean }

/** Scanline fill of a closed polygon on a grid of n x n cells over its bounding box (even-odd rule). */
export function outlineOf(points: [number, number][], n = 1024): Outline {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = (x1 - x0) || 1e-9, h = (y1 - y0) || 1e-9;
  const grid = new Uint8Array(n * n);
  for (let row = 0; row < n; row++) {
    const y = y0 + (row + 0.5) / n * h, xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - x0) / w * n - 0.5)), c1 = Math.min(n - 1, Math.floor((xs[k + 1] - x0) / w * n - 0.5));
      for (let c = c0; c <= c1; c++) grid[row * n + c] = 1;
    }
  }
  return {
    inside(x, y) {
      if (x < x0 || x > x1 || y < y0 || y > y1 || points.length < 3) return false;
      const c = Math.min(n - 1, Math.floor((x - x0) / w * n)), r = Math.min(n - 1, Math.floor((y - y0) / h * n));
      return grid[r * n + c] === 1;
    },
  };
}

/** Where a point lands on a slice drawn on: its coordinates in the slice's own plane (the normal dropped). */
export function sliceProjection(normal: Vec3): (p: Vec3) => [number, number] {
  const L = Math.hypot(...normal) || 1, n: Vec3 = [normal[0] / L, normal[1] / L, normal[2] / L];
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
  let e1: Vec3 = [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
  const l1 = Math.hypot(...e1); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2: Vec3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return (p) => [p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]];
}

/** Where a point lands on the 3D view, as fractions (u right, v down), with the view's world-to-clip matrix (column-major);
 *  null behind the eye. */
export function viewProjection(vp: ArrayLike<number>): (p: Vec3) => [number, number] | null {
  const m = vp;
  return (p) => {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (!(w > 0)) return null;
    return [(x / w + 1) / 2, (1 - y / w) / 2];
  };
}

/**
 * THE CUT. Every voxel of `segment` (C order, dims [nx, ny, nz], its center through ijkToRAS, row-major 4 x 4) is
 * projected onto the view; inside the outline it is cleared ("cut away"), or with `keepOnly` everything of the segment
 * outside it is. Returns the new labels and how many voxels were cleared.
 */
export function cutByOutline(labels: Uint8Array, dims: Vec3, ijkToRAS: ArrayLike<number>, segment: number,
  project: (p: Vec3) => [number, number] | null, outline: Outline, keepOnly: boolean): { labels: Uint8Array; cleared: number } {
  const [nx, ny, nz] = dims, m = ijkToRAS, out = labels.slice();
  let cleared = 0;
  const p: Vec3 = [0, 0, 0];
  for (let k = 0, idx = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++, idx++) {
      if (out[idx] !== segment) continue;
      p[0] = m[0] * i + m[1] * j + m[2] * k + m[3]; p[1] = m[4] * i + m[5] * j + m[6] * k + m[7]; p[2] = m[8] * i + m[9] * j + m[10] * k + m[11];
      const q = project(p), inside = !!q && outline.inside(q[0], q[1]);
      if (inside !== keepOnly) { out[idx] = 0; cleared++; }
    }
  }
  return { labels: out, cleared };
}

/**
 * ON A SLICE, WHAT IS OUTLINED GOES (Ron, 2026-10-30, of C1 under the skull: "its not connected to the skull in 2d on the
 * axial. In this scenario what is outlined goes and what is not stays"). The voxels of `segment` inside the outline on
 * the slice it was drawn on, and whatever continues from them through the slices inside the outline (6-neighbors), up
 * to the first gap -- not the whole column through the scan, which would also take the skull's vault far above C1.
 * `plane`: a point on the slice and its normal; a voxel is on the slice when its center lies within half a voxel of it
 * along the normal. With `keepOnly`, that part is kept and the rest of the segment cleared.
 */
export function cutOutlinedPart(labels: Uint8Array, dims: Vec3, ijkToRAS: ArrayLike<number>, segment: number,
  project: (p: Vec3) => [number, number] | null, outline: Outline, plane: { point: Vec3; normal: Vec3 }, keepOnly: boolean): { labels: Uint8Array; cleared: number } {
  const [nx, ny, nz] = dims, m = ijkToRAS, n = plane.normal, L = Math.hypot(...n) || 1;
  const nn: Vec3 = [n[0] / L, n[1] / L, n[2] / L];
  // Half a voxel along the normal: the largest step a voxel makes along it.
  let half = 0;
  for (let a = 0; a < 3; a++) half = Math.max(half, Math.abs(m[a] * nn[0] + m[4 + a] * nn[1] + m[8 + a] * nn[2]));
  half *= 0.5;
  const inside = new Uint8Array(labels.length), queue = new Int32Array(labels.length);
  let tail = 0;
  const p: Vec3 = [0, 0, 0];
  for (let k = 0, idx = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, idx++) {
    if (labels[idx] !== segment) continue;
    p[0] = m[0] * i + m[1] * j + m[2] * k + m[3]; p[1] = m[4] * i + m[5] * j + m[6] * k + m[7]; p[2] = m[8] * i + m[9] * j + m[10] * k + m[11];
    const q = project(p);
    if (!q || !outline.inside(q[0], q[1])) continue;
    inside[idx] = 1;
    const d = (p[0] - plane.point[0]) * nn[0] + (p[1] - plane.point[1]) * nn[1] + (p[2] - plane.point[2]) * nn[2];
    if (Math.abs(d) <= half + 1e-9) { inside[idx] = 2; queue[tail++] = idx; }   // on the slice drawn on: where the cut starts
  }
  // From the slice, through the outline's column, as far as the structure continues.
  const nxy = nx * ny;
  for (let head = 0; head < tail; head++) {
    const idx = queue[head], i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / nxy);
    const step = (to: number) => { if (inside[to] === 1) { inside[to] = 2; queue[tail++] = to; } };
    if (i > 0) step(idx - 1); if (i < nx - 1) step(idx + 1);
    if (j > 0) step(idx - nx); if (j < ny - 1) step(idx + nx);
    if (k > 0) step(idx - nxy); if (k < nz - 1) step(idx + nxy);
  }
  const out = labels.slice();
  let cleared = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== segment) continue;
    if ((inside[i] === 2) !== keepOnly) { out[i] = 0; cleared++; }
  }
  return { labels: out, cleared };
}

/**
 * A CLICK KEEPS THE PIECE UNDER IT (Ron, 2026-10-30: "build the click to keep"; "so click means keep in all effects").
 * The 6-connected piece of `segment` at each voxel in `seeds` -- or at the nearest voxel of it within two voxels, since a
 * click on the 3D surface can land just outside -- is kept and every other voxel of the segment cleared. Several seeds
 * keep several pieces (Shift-click: "this one too", as in the Threshold tool). null when no seed finds the segment.
 */
export function keepPiecesAt(labels: Uint8Array, dims: Vec3, segment: number, seeds: Vec3[]): { labels: Uint8Array; cleared: number; kept: number } | null {
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] === segment) mask[i] = 1;
  const keep = new Uint8Array(labels.length);
  let found = false;
  for (const ijk of seeds) {
    const [ci, cj, ck] = ijk.map(Math.round);
    let seed = -1, best = Infinity;
    for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const i = ci + di, j = cj + dj, k = ck + dk;
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
      const idx = (k * ny + j) * nx + i, d = di * di + dj * dj + dk * dk;
      if (mask[idx] && d < best) { best = d; seed = idx; }
    }
    if (seed < 0 || keep[seed]) continue;
    found = true;
    const piece = pieceAt(mask, dims, seed, 0)!;
    for (let i = 0; i < piece.length; i++) if (piece[i]) keep[i] = 1;
  }
  if (!found) return null;
  const out = labels.slice();
  let cleared = 0, kept = 0;
  for (let i = 0; i < out.length; i++) { if (!mask[i]) continue; if (keep[i]) kept++; else { out[i] = 0; cleared++; } }
  return { labels: out, cleared, kept };
}

/** OPTION-CLICK REMOVES THE PIECE UNDER IT (Ron, 2026-10-30: "yes, option-click removes"): the 6-connected piece of
 *  `segment` at voxel (i, j, k), or at the nearest voxel of it within two voxels, is cleared; the rest stays. null when no
 *  voxel of the segment is near. */
export function removePieceAt(labels: Uint8Array, dims: Vec3, segment: number, ijk: Vec3): { labels: Uint8Array; cleared: number } | null {
  const mask = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] === segment) mask[i] = 1;
  const seed = nearestIn(mask, dims, ijk); if (seed < 0) return null;
  const piece = pieceAt(mask, dims, seed, 0)!;
  const out = labels.slice();
  let cleared = 0;
  for (let i = 0; i < out.length; i++) if (piece[i]) { out[i] = 0; cleared++; }
  return { labels: out, cleared };
}

/** The voxel of `mask` at (i, j, k), or the nearest one within two voxels; -1 when none. */
export function nearestIn(mask: Uint8Array, dims: Vec3, ijk: Vec3): number {
  const [nx, ny, nz] = dims, [ci, cj, ck] = ijk.map(Math.round);
  let seed = -1, best = Infinity;
  for (let dk = -2; dk <= 2; dk++) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const i = ci + di, j = cj + dj, k = ck + dk;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    const idx = (k * ny + j) * nx + i, d = di * di + dj * dj + dk * dk;
    if (mask[idx] && d < best) { best = d; seed = idx; }
  }
  return seed;
}

