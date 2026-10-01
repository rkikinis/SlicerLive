// Slice-view geometry math ported from vtkMRMLSliceLogic (pure TS, RAS internal). Two functions W2 needs:
//   fitFovToVolume  — vtkMRMLSliceLogic::FitSliceToVolumes: the field of view that frames a volume in a
//                     viewport, covering BOTH in-plane extents and letterboxing the slack (the axis
//                     with the larger extent-to-viewport ratio decides the scale; the other gains
//                     margin). Validated against the live-Slicer fixture (harness/fixtures/slicer-startup)
//                     and against the out-of-proportion cases the fixture does not reach.
//   offsetRangeResolution — vtkMRMLSliceLogic::GetSliceOffsetRangeResolution: the slider [min,max] + step,
//                     in Slicer's signed slice-offset convention (bounds along the normal, step = spacing).
import type { Orientation } from "../render/slice-renderer.ts";
import { sliceBoundsFor, sliceSpacingFor } from "../render/slice-interactor.ts";
import type { Vec3 } from "../render/mat4.ts";

// The two in-plane RAS axes (row, col) for each orientation — Slicer's slice-view axes.
const IN_PLANE: Record<Orientation, [0 | 1 | 2, 0 | 1 | 2]> = {
  axial: [0, 1],     // R (horizontal), A (vertical)
  coronal: [0, 2],   // R, S
  sagittal: [1, 2],  // A, S
};

/** Fitted [fovX, fovY, slabZ] mm for `orient` framing the RAS box [rasLo,rasHi] in a viewport of viewW×viewH px. */
export function fitFovToVolume(orient: Orientation, rasLo: Vec3, rasHi: Vec3, ijkToRAS: ArrayLike<number>, viewW: number, viewH: number): [number, number, number] {
  const [rx, cy] = IN_PLANE[orient];
  const ex = Math.abs(rasHi[rx] - rasLo[rx]);          // volume extent along the slice row axis
  const ey = Math.abs(rasHi[cy] - rasLo[cy]);          // along the slice col axis
  const slab = sliceSpacingFor(orient, ijkToRAS);
  // FIT BOTH AXES, not whichever one the VIEWPORT happens to make smaller.
  //
  // This branched on the viewport's aspect alone (viewH > viewW ? fit width : fit height) and never
  // consulted the volume's, so it framed one axis exactly and let the other fall where it may. When
  // the volume is proportionally wider (or taller) than the cell, "where it may" is off-screen: a
  // 350 x 100 mm extent in a 270 x 180 px cell took the height branch and produced a 150 mm wide
  // field of view for a 350 mm volume -- more than half of it cut off, in every view at once. Ron:
  // "The autozoom is not good. All the views do not show the entire extent."
  //
  // Scaling by the LARGER of the two ratios makes the field of view cover both extents and letterbox
  // the slack, which is what "fit" has to mean. On the live-Slicer fixture (MRHead, all three
  // orientations) this is identical to the old expression to within 0.01 mm -- there the height
  // ratio dominates, which is why the parity test never caught the missing case.
  const scale = Math.max(ex / Math.max(viewW, 1), ey / Math.max(viewH, 1));
  return [scale * viewW, scale * viewH, slab];
}

export interface OffsetRange { min: number; max: number; step: number }

/** Slider range + step for a slice, Slicer's signed offset convention (mm along the normal). */
export function offsetRangeResolution(orient: Orientation, ijkToRAS: ArrayLike<number>, rasLo: Vec3, rasHi: Vec3): OffsetRange {
  const [lo, hi] = sliceBoundsFor(orient, rasLo, rasHi);
  const step = sliceSpacingFor(orient, ijkToRAS) || 1;
  if (hi - lo < step) { const c = (lo + hi) / 2; return { min: c - step, max: c + step, step }; }  // single-slice
  return { min: lo, max: hi, step };
}

/** Canonical SliceToRAS (row-major 16) for an orientation, passing through `center` (RAS). This is what
 *  Slicer's vtkMRMLSliceNode::SetOrientation builds: the standard slice axes (col2 = plane normal) with the
 *  origin kept at the current point. Used by the orientation combo (Reformat). Bases match the Red/Yellow/Green
 *  native slice planes: Axial normal +S, Sagittal normal +R, Coronal normal +A; radiological in-plane axes. */
export function reformatSliceToRAS(orient: Orientation, center: Vec3): number[] {
  const [cx, cy, cz] = center;
  switch (orient) {
    case "axial": return [1, 0, 0, cx, 0, 1, 0, cy, 0, 0, 1, cz, 0, 0, 0, 1];
    case "sagittal": return [0, 0, 1, cx, 1, 0, 0, cy, 0, 1, 0, cz, 0, 0, 0, 1];
    case "coronal": return [1, 0, 0, cx, 0, 0, 1, cy, 0, 1, 0, cz, 0, 0, 0, 1];
  }
}
