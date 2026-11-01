// THE BRUSH'S ARITHMETIC (Paint and Erase in the Segment Editor), on a labelmap held in memory: a disk on the slice or a
// sphere, swept along the stroke. Moved out of logic/segment-tools.ts paintStroke on 2026-10-31 for Ron's answers on Paint:
//   * "paint X over Y" applies to the brush as to every tool (logic/segment-effects.ts canWrite): over anything, empty
//     voxels only, the visible structures, or one named structure;
//   * Erase takes away ONLY the structure chosen (as Slicer and ITK-SNAP do); it took every structure under the brush;
//   * the brush may be held to a brightness range, by default the Threshold tool's, or made ADAPTIVE (Ron: "make threshold
//     range default adaptiv a slider to toggle"): only the voxels joined to the brush's center, inside the brush, whose
//     brightness is within a tolerance of the center's -- the idea of ITK-SNAP's adaptive brush, by a simpler rule.
// The range and the adaptive rule hold for Paint only (Ron, 2026-10-31, asked whether Erase should obey them: "yes, but
// we need an intuitive way to inform our distracted user" -- the eraser always erases): Erase takes away the chosen
// structure under the brush, whatever its brightness. The person is told before a stroke, not after: brushPreview (below)
// gives the voxels a stroke at the mouse would paint, which the slice view fills in the structure's color, so what the
// limit holds back shows as holes in the brush.
import { applyRowMajor, type Vec3 } from "../render/mat4.ts";
import { finest, tuned, voxelOrUnit } from "../render/scene-scale.ts";
import { canWrite, type OverwriteMode } from "./segment-effects.ts";

export interface BrushGrid { labelmap: Uint8Array; dims: [number, number, number]; ijkToRAS: number[]; invIjk: number[]; spacing: Vec3; }
export interface BrushParams { segment: number; radiusMm: number; mode: "add" | "remove"; sphere?: boolean; normal?: Vec3; }
export interface BrushLimits {
  overwrite?: OverwriteMode; visibleSegments?: number[]; overSegment?: number;
  /** The scan the brightness is read from; `segToSource` maps a segmentation voxel to the scan's voxel (row-major), null
   *  when both are on one grid. */
  source?: { data: ArrayLike<number>; dims: [number, number, number]; segToSource: number[] | null };
  /** Only voxels whose brightness is in [lo, hi]. */
  range?: [number, number];
  /** Adaptive: only voxels joined to the center whose brightness is within this of the center's. Replaces `range`. */
  adaptive?: number;
  /** PER SCAN SHOWN (2026-10-31, three scans side by side): the brightness limit of each scan by its image id -- its
   *  source, range or adaptive -- used when the stroke is painted in a view showing that scan (limitsFor). */
  byImage?: Record<string, Pick<BrushLimits, "source" | "range" | "adaptive">>;
  /** The scan the segmentation was made on (its own limit is the one above), so a view showing another scan whose limit
   *  is not known yet can be told apart from one showing this. */
  ownImage?: string;
  /** Paint nothing yet: the view's scan is still being read (limitsFor). */
  waiting?: boolean;
}
/** The limits for a stroke in a view showing `viewImage`: that scan's brightness limit, the rest ("over") as set. */
export function limitsFor(l: BrushLimits, viewImage?: string): BrushLimits {
  const v = viewImage ? l.byImage?.[viewImage] : undefined;
  if (v) return { ...l, source: v.source, range: v.range, adaptive: v.adaptive };
  // A VIEW SHOWING ANOTHER SCAN, NOT READ YET (critic 2026-10-31 evening, finding 8): with a brightness limit on, the
  // stroke waits for that scan's limit -- it was held to the outlined scan's range meanwhile. Without a limit it paints.
  if (viewImage && l.ownImage && viewImage !== l.ownImage && (l.range || l.adaptive !== undefined)) return { ...l, waiting: true };
  return l;
}
/** What a stroke wrote, and what it left because of the limits (voxel indices, so a stroke counts each once). */
/** heldDarker: those of heldBrightness below the range (the rest are above it, or unlike the center in Adaptive), so the
 *  note beside the brush can say "darker" or "brighter". */
export interface BrushTally { written: number; heldBrightness: Set<number>; heldDarker: Set<number>; heldOver: Set<number>; mode?: "add" | "remove"; }
export const newTally = (): BrushTally => ({ written: 0, heldBrightness: new Set(), heldDarker: new Set(), heldOver: new Set() });

/**
 * THE STAMP SPACING ALONG A STROKE, from the grid (Ron, 2026-10-20: "did you forget about scales? from astrophysics to
 * electron microscope"). It was max(0.5 mm, half the smaller of the radius and the voxel): 0.5 mm on every clinical
 * grid, and at a microscope's 1 nm voxels a stamp every half a million voxels -- isolated dabs. Now the 0.5 mm as it was
 * tuned (0.71 voxels on a 0.7 mm grid, half a voxel on grids coarser than 1 mm), held to between half a voxel and one
 * voxel at any other scale: each stamp lands on its nearest voxel center, so a step of at most a voxel leaves no gap,
 * and at least half a voxel keeps the number of stamps bounded.
 */
export function paintStepMm(voxel: number): number { return tuned(0.5, voxel, 0.5, 1); }

/** Sweep the brush along `points` (scanner coordinates) into `c.labelmap`, in place. Consecutive points are joined (a step
 *  of at most a voxel, paintStepMm) so a fast drag leaves a continuous stroke. */
export function paintStamps(c: BrushGrid, points: Vec3[], params: BrushParams, limits: BrushLimits = {}, tally: BrushTally = newTally(), dry?: number[]): BrushTally {
  const [nx, ny, nz] = c.dims;
  const [sx, sy, sz] = c.spacing;
  const r = params.radiusMm, r2 = r * r;
  const add = params.mode === "add", seg = params.segment;
  const ri = Math.ceil(r / (sx || 1)), rj = Math.ceil(r / (sy || 1)), rk = Math.ceil(r / (sz || 1));
  const bx = 2 * ri + 1, by = 2 * rj + 1, bz = 2 * rk + 1;
  const n = params.normal;
  const m = c.ijkToRAS;   // direction cosines: a voxel step (di,dj,dk) maps to a RAS offset via the 3x3 linear part
  // THE FLAT BRUSH PAINTS THE VOXELS THE SLICE SHOWS (critic 2026-10-31 evening, finding 2): those whose box the slice's
  // plane passes through -- the slice view draws the nearest voxel at every point of its plane, so these and only these are
  // on screen. It was a slab one voxel deep around the voxel nearest the stroke, measured along the scan's axis most like
  // the normal: right on a scan lined up with the view, and on a tilted one (1-4 degrees for most brain MRs here, 25-30 for
  // ReMIND) a part of every stroke went into voxels the slice does not show (79 % shown at 1.1 degrees, 54 % at 4.4, worst
  // case). The box's half-depth along the normal is half the sum of its three edges projected on it.
  const w: Vec3 = [0, 0, 0];
  if (n) for (let a = 0; a < 3; a++) w[a] = m[a] * n[0] + m[4 + a] * n[1] + m[8 + a] * n[2];
  const halfBox = 0.5 * (Math.abs(w[0]) + Math.abs(w[1]) + Math.abs(w[2]));
  const onPlane = !params.sphere && !!n;
  // The brush's shape, once: which offsets of the box are inside it.
  const shape = new Uint8Array(bx * by * bz);
  for (let dk = -rk; dk <= rk; dk++) for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) {
    const rx = m[0] * di + m[1] * dj + m[2] * dk, ry = m[4] * di + m[5] * dj + m[6] * dk, rz = m[8] * di + m[9] * dj + m[10] * dk;
    if (rx * rx + ry * ry + rz * rz > r2) continue;                                                // sphere/disk radius (mm)
    // a slab around the plane, from the voxel nearest the stroke: the plane is at most a box's half-depth from its center,
    // so a voxel it passes through is within two (the exact test is per stamp, below)
    if (onPlane && Math.abs(di * w[0] + dj * w[1] + dk * w[2]) > 2 * halfBox) continue;
    shape[((dk + rk) * by + (dj + rj)) * bx + (di + ri)] = 1;
  }

  if (limits.waiting && add) return tally;   // the view's scan is still being read (limitsFor)
  const src = limits.source, ov = { segment: seg, overwrite: limits.overwrite, visibleSegments: limits.visibleSegments, overSegment: limits.overSegment };
  const limited = !!src && (limits.adaptive !== undefined || !!limits.range);
  /** The scan's brightness at a segmentation voxel (NaN outside the scan). */
  const bright = (i: number, j: number, k: number): number => {
    if (!src) return NaN;
    if (!src.segToSource) return src.data[(k * ny + j) * nx + i];
    const p = applyRowMajor(src.segToSource, [i, j, k]);
    const a = Math.round(p[0]), b = Math.round(p[1]), d = Math.round(p[2]), [mx, my, mz] = src.dims;
    return a < 0 || a >= mx || b < 0 || b >= my || d < 0 || d >= mz ? NaN : src.data[(d * my + b) * mx + a];
  };
  const reach = limits.adaptive !== undefined ? new Uint8Array(shape.length) : null;
  const queue = reach ? new Int32Array(shape.length) : null;

  const stamp = (p: Vec3) => {
    const ijk = applyRowMajor(c.invIjk, p);
    const ci = Math.round(ijk[0]), cj = Math.round(ijk[1]), ck = Math.round(ijk[2]);
    // ADAPTIVE: the voxels of the brush joined to its center (6 neighbors) through brightness within the tolerance.
    if (reach && queue) {
      reach.fill(0);
      const cv = ci >= 0 && ci < nx && cj >= 0 && cj < ny && ck >= 0 && ck < nz ? bright(ci, cj, ck) : NaN;
      const at0 = (rk * by + rj) * bx + ri;
      if (Number.isFinite(cv)) {
        const tol = limits.adaptive!;
        let head = 0, tail = 0; reach[at0] = 1; queue[tail++] = at0;
        while (head < tail) {
          const b = queue[head++], di = b % bx - ri, dj = Math.floor(b / bx) % by - rj, dk = Math.floor(b / (bx * by)) - rk;
          for (const [ei, ej, ek] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const oi = di + ei, oj = dj + ej, ok = dk + ek;
            if (oi < -ri || oi > ri || oj < -rj || oj > rj || ok < -rk || ok > rk) continue;
            const ob = ((ok + rk) * by + (oj + rj)) * bx + (oi + ri);
            if (reach[ob] || !shape[ob]) continue;
            const i = ci + oi, j = cj + oj, k = ck + ok;
            if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
            const v = bright(i, j, k);
            if (!(Math.abs(v - cv) <= tol)) continue;
            reach[ob] = 1; queue[tail++] = ob;
          }
        }
      }
    }
    for (let dk = -rk; dk <= rk; dk++) for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) {
      const b = ((dk + rk) * by + (dj + rj)) * bx + (di + ri);
      if (!shape[b]) continue;
      const i = ci + di, j = cj + dj, k = ck + dk;
      if (onPlane && Math.abs((i - ijk[0]) * w[0] + (j - ijk[1]) * w[1] + (k - ijk[2]) * w[2]) > halfBox) continue;   // not on the slice
      if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
      const at = k * nx * ny + j * nx + i, cur = c.labelmap[at];
      // Erase takes away only the structure chosen; Paint writes where "over" allows.
      if (add ? cur === seg : cur !== seg) { if (dry && add) dry.push(at); continue; }
      if (add && !canWrite(cur, ov)) { tally.heldOver.add(at); continue; }
      if (limited && add) {
        let ok: boolean;
        if (reach) ok = reach[b] === 1;
        else { const v = bright(i, j, k); ok = v >= limits.range![0] && v <= limits.range![1]; if (v < limits.range![0]) tally.heldDarker.add(at); }
        if (!ok) { tally.heldBrightness.add(at); continue; }
      }
      if (dry) { dry.push(at); continue; }
      c.labelmap[at] = add ? seg : 0;
      tally.written++;
      tally.heldBrightness.delete(at); tally.heldDarker.delete(at); tally.heldOver.delete(at);
    }
  };

  const stepMm = paintStepMm(voxelOrUnit(finest(sx, sy, sz)));   // dense enough to reach every voxel along the stroke
  let prev: Vec3 | null = null;
  for (const p of points) {
    if (prev) {
      const d: Vec3 = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]];
      const steps = Math.max(1, Math.ceil(Math.hypot(d[0], d[1], d[2]) / stepMm));
      for (let s = 1; s <= steps; s++) { const t = s / steps; stamp([prev[0] + d[0] * t, prev[1] + d[1] * t, prev[2] + d[2] * t]); }
    } else stamp(p);
    prev = p;
  }
  return tally;
}

/** WHAT ONE STAMP AT `center` WOULD DO, writing nothing: the voxels it would paint (for Paint, those already of the
 *  structure too, so the brush looks full over what is painted) and those the limits would hold back. The slice view
 *  fills the first in the structure's color under the brush; the holes are the second. */
export function brushPreview(c: BrushGrid, center: Vec3, params: BrushParams, limits: BrushLimits = {}): { will: number[]; held: number[] } {
  const will: number[] = [], t = paintStamps(c, [center], params, limits, newTally(), will);
  // A SPHERE'S PREVIEW IS ITS CUT THROUGH THE SLICE SHOWN (critic 2026-10-31 evening, finding 3): the voxels above and
  // below, drawn onto the slice, covered the holes the stroke leaves on it. Only the voxels whose box the plane passes
  // through, as the flat brush paints them.
  const n = params.normal;
  if (params.sphere && n) {
    const m = c.ijkToRAS, [nx, ny] = c.dims, p = applyRowMajor(c.invIjk, center);
    const w = [0, 1, 2].map((a) => m[a] * n[0] + m[4 + a] * n[1] + m[8 + a] * n[2]);
    const half = 0.5 * (Math.abs(w[0]) + Math.abs(w[1]) + Math.abs(w[2]));
    const on = (at: number) => Math.abs((at % nx - p[0]) * w[0] + (Math.floor(at / nx) % ny - p[1]) * w[1] + (Math.floor(at / (nx * ny)) - p[2]) * w[2]) <= half;
    return { will: will.filter(on), held: [...t.heldBrightness, ...t.heldOver].filter(on) };
  }
  return { will, held: [...t.heldBrightness, ...t.heldOver] };
}

/** The map from a segmentation's voxels to its scan's (row-major), or null when both are on one grid. */
export function segToSourceOf(segIjkToRAS: number[], segDims: [number, number, number], srcInvIjk: number[], srcDims: [number, number, number]): number[] | null {
  const same = segDims.every((d, a) => d === srcDims[a]);
  const mm = mul(srcInvIjk, segIjkToRAS);
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return same && mm.every((v, i) => Math.abs(v - id[i]) < 1e-6) ? null : mm;
}
function mul(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}
