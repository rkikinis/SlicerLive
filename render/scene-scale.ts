// THE SCENE'S SCALE: how big a voxel is, for every size, step, tolerance and default an interaction uses. One place, so
// no code holds a length of its own (Ron, 2026-10-20: "did you forget about scales? from astrophysics to electron
// microscope"; MODULE-DESIGN-RULES "Any scale"; data-model-design-2026-09-03.md, Addendum 5). Albula's scene is in the
// data's own units -- a CT's mm, a microscope's 1e-6 mm voxels, a parsec cube's 3e19 mm -- so a fixed number of mm is
// right at one scale and wrong at every other. Sizes are stated in VOXELS here and turned into the scene's units.
//
// Two kinds of value:
//   - voxels(n, v): an interaction stated in voxels (a brush of 5 voxels, a pick tolerance of half a voxel);
//   - tuned(mm, v, lo, hi): a value tuned by eye in mm on clinical grids (the volume rendering's opacity unit, which Ron
//     approved at 1 mm: "the 1mm did the trick"), kept exactly as it is while it lies between `lo` and `hi` voxels, and
//     held to that range outside it -- so a clinical scan looks as it did and a microscope's or a telescope's scales.
import { spacingFromIjkToRAS } from "./mat4.ts";

/** The three voxel sizes of a grid, from its ijk -> world matrix (row-major 4x4). */
export function voxelSizes(ijkToRAS: ArrayLike<number> | undefined): [number, number, number] | undefined {
  if (!ijkToRAS || ijkToRAS.length < 12) return undefined;
  const s = spacingFromIjkToRAS(ijkToRAS);
  return s.every((x) => Number.isFinite(x) && x > 0) ? [s[0], s[1], s[2]] : undefined;
}

/** A node's finest voxel size, or undefined when it has no grid (a markup, a model). */
export function nodeVoxel(n: { ijkToRAS?: unknown } | undefined): number | undefined {
  const s = voxelSizes(n?.ijkToRAS as ArrayLike<number> | undefined);
  return s ? Math.min(s[0], s[1], s[2]) : undefined;
}

/**
 * THE SCENE'S VOXEL: the finest voxel of the volumes and segmentations in the scene (visible ones first; every one when
 * none is visible), or undefined when the scene has none. The finest, so nothing the person can see is smaller than a
 * step or a tolerance made from it.
 */
export function sceneVoxel(nodes: Iterable<{ type?: unknown; visible?: unknown; hidden?: unknown; ijkToRAS?: unknown }>): number | undefined {
  let shown = Infinity, any = Infinity;
  for (const n of nodes) {
    if (n.type !== "image" && n.type !== "segmentation") continue;
    const v = nodeVoxel(n); if (v === undefined) continue;
    any = Math.min(any, v);
    if (n.visible !== false && n.hidden !== true) shown = Math.min(shown, v);
  }
  return Number.isFinite(shown) ? shown : Number.isFinite(any) ? any : undefined;
}

/** When no grid is known: a voxel taken as a 256th of what is in view (its extent), so sizes still scale with it. */
export function voxelFromExtent(extent: number): number | undefined {
  return Number.isFinite(extent) && extent > 0 ? extent / 256 : undefined;
}

/** `n` voxels in the scene's units. */
export const voxels = (n: number, voxel: number): number => n * voxel;

/** A value tuned in mm on clinical grids, unchanged between `lo` and `hi` voxels, held to that range outside it. */
export function tuned(mm: number, voxel: number | undefined, lo: number, hi: number): number {
  if (voxel === undefined || !(voxel > 0)) return mm;
  return Math.min(Math.max(mm, lo * voxel), hi * voxel);
}

/** The finest of the voxel sizes given, skipping unknown and non-positive ones; undefined when none is known. */
export function finest(...vs: (number | null | undefined)[]): number | undefined {
  let f = Infinity;
  for (const v of vs) if (v !== undefined && v !== null && Number.isFinite(v) && v > 0 && v < f) f = v;
  return Number.isFinite(f) ? f : undefined;
}

/**
 * The first voxel size that is known, in the order given (the grid being worked on, then the scene's, then one taken
 * from what is in view), else 1. THE 1 IS THE VERY LAST RESORT: a length with no data behind it, reached only when
 * there is no grid and nothing in view at all -- an empty scene, where no size can be wrong.
 */
export function voxelOrUnit(...candidates: (number | null | undefined)[]): number {
  for (const v of candidates) if (v !== undefined && v !== null && Number.isFinite(v) && v > 0) return v;
  return 1;
}

/** The radius that frames a box (half its diagonal, as Slicer's ResetCamera), never less than one voxel. */
export function boxRadius(lo: ArrayLike<number>, hi: ArrayLike<number>, voxel?: number): number {
  const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  return Math.max(Number.isFinite(r) ? r : 0, voxelOrUnit(voxel, voxelFromExtent(2 * r)));
}

/** Texels across a length at one per voxel, held to [min, max] texels (so a huge field of view cannot allocate
 *  without bound, and a tiny one still has a picture). */
export function texelsAcross(length: number, voxel: number, min: number, max: number): number {
  const n = Math.ceil(length / voxel);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

// ── THE VIEWS' SIZES, IN VOXELS. Each is chosen so a ~1 mm clinical grid behaves as it did when it was a length; the
//    translation is in the comment, with the grid named. ──

/** A markup within this many voxels of a slice is ON it (drawn full, pickable): 1.5 mm on a 1 mm grid, 1.05 mm on a
 *  0.7 mm one. Never less than half a slice step, so a pin on a 5 mm series is on the slice the wheel reaches. */
export const ON_SLICE_VOXELS = 1.5;
export const onSliceDistance = (voxel: number, sliceStep = 0): number =>
  Math.max(voxels(ON_SLICE_VOXELS, voxel), (Number.isFinite(sliceStep) ? sliceStep : 0) / 2);

/** The paint brush when the Segment Editor has not set one: 5 voxels across (5 mm on a 1 mm grid). */
export const BRUSH_DEFAULT_VOXELS = 5;

/** Draw's traced outline keeps a point only when it is this far from the last: a tenth of a voxel (0.1 mm on a 1 mm
 *  grid), so a slow drag does not pile up points and a fast one keeps its shape. */
export const DRAW_SPACING_VOXELS = 0.1;

/** The 3D view in the glasses comes no closer than this when zoomed: 20 voxels (20 mm on a 1 mm grid). */
export const STEREO_NEAREST_VOXELS = 20;

// LENGTHS AS A PERSON READS THEM (lengthText, rulerLength) are in render/length-text.ts: display only, kept out of this
// module because the DICOM reader imports it (readers/nifti.ts), and every change here retires every duckn copy
// (desktop/make-copy-code.ts) -- a ruler's label must not.
