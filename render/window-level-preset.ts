// A volume-rendering transfer function derived from a volume's OWN window/level, for data whose
// intensities are not Hounsfield units.
//
// Every preset in ct-vr-presets.ts is stated in absolute HU -- CT-Soft-Tissue's first stop is at
// -3024 and its tissue ramp sits between -160 and 240. MR intensities are arbitrary and
// non-negative, so those stops fall entirely outside the data: every voxel lands below the first
// stop, gets opacity 0, and the 3D view shows nothing. Ron, on the studyforrest T1: "when I loaded
// the forrest data I had a black cube in the 3D viewer." The repository already knew this failure --
// tf-editor.ts records "an MR head under the CT preset the CT was using came out a solid black box"
// -- but only as a reason to give each volume its own transfer function, not as a reason to pick a
// different one.
//
// Ron: "w/L settings are a good start point. Use the LUT that the data comes with. then we need to
// experiment for improving the heuristics." The window/level is already computed at ingest
// (percentileWindowLevel) and already drives the slice views, which is why those looked right while
// the 3D did not. This turns that same pair into a ramp.
//
// AND WHY A HEURISTIC RATHER THAN AN MR PRESET LIST. Slicer ships some MR presets, and copying them
// was the obvious move. Ron: "Slicer had some, but an heuristic is better as MRI signal intensities
// are not standardized. There is no Hounsfield units equivalent in mri." That is the whole argument.
// A CT preset can name absolute stops because -1000 is air on every scanner ever built; an MR preset
// cannot, because the same tissue on the same scanner an hour later is a different number. Fixed
// stops for MR are a guess that happens to work on the series they were tuned against. Deriving the
// stops from THIS volume's own distribution is the only form that transfers.
//
// THE SHAPE IS A FIRST CUT AND IS MEANT TO BE TUNED. The constants below are named and gathered
// here for that reason.

import type { CtVrPreset } from "./ct-vr-presets.ts";

/** Where the ramp starts inside the window, as a fraction of it. Below this the volume is fully
 *  transparent: a ramp that starts at the window's own floor renders the noise outside the head as
 *  a fog and the result reads as a gray block rather than as anatomy. */
export const RAMP_START = 0.25;
/** Opacity at the top of the window. Deliberately short of 1: at full opacity the outermost surface
 *  hides everything behind it, which is the same complaint ("dark and solid") the CT path had. */
export const RAMP_PEAK = 0.85;
/** Opacity at mid-window, which is what gives the interior any presence at all. */
export const RAMP_MID = 0.15;

/** Matte. Not a considered lighting choice for MR yet -- it is CT-Soft-Tissue's, chosen so this
 *  changes the transfer function and nothing else while the shape is being tuned. */
export const WL_LIGHT: [number, number, number, number] = [0.2, 1.0, 0.0, 1.0];

/**
 * A grayscale ramp across [level - window/2, level + window/2].
 *
 * Grayscale because that is what the data comes with: an MR series carries no color table, and
 * inventing a palette would be asserting something about the tissue that nothing in the file says.
 * When a volume DOES carry its own LUT, that is what should be used instead -- see `dataLut` below.
 */
export function windowLevelPreset(window: number, level: number): CtVrPreset {
  const w = Math.max(1e-6, window);
  const lo = level - w / 2, hi = level + w / 2;
  const start = lo + w * RAMP_START;
  return {
    name: "Data window",
    label: "From the data's window/level",
    shade: true,
    light: [...WL_LIGHT] as [number, number, number, number],
    colorTF: [[lo, 0, 0, 0], [hi, 1, 1, 1]],
    opacityTF: [[lo, 0], [start, 0], [level, RAMP_MID], [hi, RAMP_PEAK]],
  };
}

/**
 * Does this volume's intensity scale look like Hounsfield units?
 *
 * The discriminator is air. A CT of anything includes it, at about -1000 HU, so a CT volume's range
 * reaches well below zero; MR magnitude images are non-negative. That is a property of the data
 * rather than of a header, so it still answers for a volume whose modality was never recorded --
 * and `modality` is used first when it IS recorded, because a stated fact beats an inferred one.
 *
 * A first cut, and the place to start when the heuristics are revisited.
 */
export function looksLikeHounsfield(range: readonly [number, number] | undefined, modality?: string): boolean {
  if (modality) return modality.toUpperCase() === "CT";
  if (!range) return false;
  return range[0] < -200;
}
