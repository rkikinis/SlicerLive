// THE DRAW TOOL'S FILL (Slicer's Draw effect): the voxels inside a polygon drawn on a slice, one voxel thick, written
// into a label map. Ron, 2026-10-20, on the cingulum bundle in a coronal Color FA: "What I would like to do is draw a
// polygon to capture each cingulum bundle."
//
// A voxel is inside when its CENTER lies inside the polygon (even-odd rule) once projected onto the slice plane, and
// within half a voxel of that plane along the axis of the grid most aligned with the plane's normal -- the same
// thickness the 2D brush paints (segment-tools.ts paintStroke), so a drawn region and a painted one on the same
// slice cover the same layer of voxels, whatever the slice's tilt against the grid. The window is HALF-OPEN, so a plane
// exactly between two layers fills one of them, the one behind it (critic 2026-10-20, section 11: such a tie filled
// scattered voxels of both layers, or of neither, as the floating-point rounding fell).
import { applyRowMajor, type Vec3 } from "../render/mat4.ts";

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A slice plane as the Draw tool keeps it: its unit normal and its signed distance from the origin along it (mm). */
export interface DrawPlane { normal: Vec3; offsetMm: number }

/** The plane of a slice view (live-views' SlicePlane: an anatomical preset, or a reformat basis with `posMm` along its
 *  normal). */
export function drawPlaneOf(pl: { orient: "axial" | "coronal" | "sagittal"; posMm: number; basis?: { nDir: Vec3 } }): DrawPlane {
  const normal: Vec3 = pl.basis ? unit(pl.basis.nDir) : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
  return { normal, offsetMm: pl.posMm };
}

/**
 * AN OUTLINE BELONGS TO ONE SLICE (critic 2026-10-20, finding 2: corners placed on slice 10, the wheel turned to slice
 * 20, three more corners, and the fill wrote all of them into slice 10, where nobody was looking). How the plane `now`
 * differs from the plane `then` the outline was drawn on: null when it is the same plane (the same normal, either way
 * round, and an offset within `tolMm`), "moved" when only the offset changed, "turned" when the normal did (a new
 * orientation or a reformat). Panning and zooming within the plane are not a change.
 */
export function planeChange(then: DrawPlane, now: DrawPlane, tolMm: number): null | "moved" | "turned" {
  const c = dot(then.normal, now.normal);
  if (Math.abs(c) < 1 - 1e-6) return "turned";
  const offset = c < 0 ? -now.offsetMm : now.offsetMm;   // the same plane seen from its other side
  return Math.abs(offset - then.offsetMm) > tolMm ? "moved" : null;
}

/** Even-odd point-in-polygon, in the plane's own 2D coordinates. */
export function insidePolygon(x: number, y: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Write `value` into every voxel of `labelmap` inside `points` (RAS, on one slice plane with unit `normal`). Returns
 * the number of voxels written. `ijkToRAS` is the label map's row-major 4x4 and `invIjk` its inverse.
 */
export function fillPolygon(labelmap: Uint8Array, dims: readonly [number, number, number], ijkToRAS: readonly number[], invIjk: readonly number[], points: readonly Vec3[], normal: Vec3, value: number, may?: (cur: number) => boolean): number {
  if (points.length < 3) return 0;
  const [nx, ny, nz] = dims;
  const m = ijkToRAS, n = unit(normal);
  // The plane's own axes: any unit vector across the normal, and the one across both.
  const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(n, seed)), e2 = cross(n, e1);
  const p0 = points[0], d0 = dot(p0, n);
  const poly = points.map((p) => [dot(p, e1), dot(p, e2)] as [number, number]);
  // Half a voxel along the grid axis most aligned with the normal (paintStroke's halfThick).
  let halfThick = 0;
  for (let a = 0; a < 3; a++) halfThick = Math.max(halfThick, Math.abs(m[a] * n[0] + m[4 + a] * n[1] + m[8 + a] * n[2]));
  halfThick *= 0.5;
  // [-half, +half) in layers, shifted by a millionth of a layer so the tie is decided before rounding can decide it.
  const layer = 2 * halfThick, TIE = 1e-6;
  const inLayer = (dist: number) => { const s = dist / layer + TIE; return s >= -0.5 && s < 0.5; };
  // Only the voxels in the polygon's box (in voxel indices, one voxel of margin) are looked at.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) { const q = applyRowMajor(invIjk as number[], p); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); } }
  const i0 = Math.max(0, Math.floor(lo[0]) - 1), i1 = Math.min(nx - 1, Math.ceil(hi[0]) + 1);
  const j0 = Math.max(0, Math.floor(lo[1]) - 1), j1 = Math.min(ny - 1, Math.ceil(hi[1]) + 1);
  const k0 = Math.max(0, Math.floor(lo[2]) - 1), k1 = Math.min(nz - 1, Math.ceil(hi[2]) + 1);
  let written = 0;
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const p: Vec3 = [m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]];
    if (!inLayer(dot(p, n) - d0)) continue;
    if (!insidePolygon(dot(p, e1), dot(p, e2), poly)) continue;
    const at = k * nx * ny + j * nx + i;
    if (may && !may(labelmap[at])) continue;     // the editor's "over" rule (logic/segment-effects.ts canWrite)
    labelmap[at] = value;
    written++;
  }
  return written;
}
