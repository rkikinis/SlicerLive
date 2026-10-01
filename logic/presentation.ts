// How a segmentation result should LOOK the first time it is shown.
//
// Ron, on the first FastSurfer result: "this is the standard appearance of freesurfer like packages.
// Can you make fast surfer like appearance at inital presentation? This means that unlabeled body
// should be off." And, in the same breath, the instruction that shapes this file rather than the one
// entry in it: "do not think of this as a one-off but as the beginning of a library of special
// cases. Set up the capability accordingly. We have been bitten by one off's."
//
// So this is a table, not a branch. A network's result arrives with conventions attached -- what its
// community expects to see, what its colors mean, whether the surrounding tissue is context or
// clutter -- and those conventions belong somewhere a person can read and edit, next to the reason
// they hold. Same shape as logic/anatomy/overrides.ts: the entry carries `why`, and `by` when a
// person decided it rather than a project publishing it.
//
// WHAT A PRESET MAY SET is deliberately narrow. These are the colorize renderer's own parameters,
// the ones the Volume Rendering module already exposes, so a preset can never express something the
// user cannot then see and change by hand. A preset is a starting point, not a mode.

/** The `by` line when the appearance is what the originating project itself shows. */
export const BY_CONVENTION = "the project's own convention";

export interface Presentation {
  /** Stable id, and what a saved choice refers to. */
  id: string;
  /** What it is called where a person picks it. Short enough to sit in a dropdown. */
  name: string;
  /**
   * Is the UNLABELED body shown at all?
   *
   * The colorize rendering draws the labeled voxels over a faint rendering of everything else --
   * skin, fat, the tissue no network claimed. On a CT of the abdomen that is orientation: it tells
   * you where the organs sit. On a brain parcellation it is the haze in front of the answer.
   */
  contextOn: boolean;
  /** Where the unlabeled body sits WHEN SHOWN. The colorize page's own value is 0.12; at 1.0 the
   *  skin alone hides everything behind it. */
  context: number;
  /**
   * How much the underlying image intensity varies a segment's brightness, 0..1.
   *
   * At 0.55 (the default) organs look like tissue rather than flat paint, because the HU underneath
   * still shows through. FreeSurfer-style parcellation maps are flat by convention -- the color IS
   * the label and nothing else -- so a low value is what makes one recognisable.
   */
  modulation: number;
  /** A multiplier over every segment's own opacity. 1 unless a result is meant to be seen through. */
  segmentOpacity: number;
  /**
   * Lighting: [ambient, diffuse, specular, shininess], or absent for the renderer's default.
   *
   * IN A PRESET BECAUSE IT IS PART OF THE LOOK, not a global constant -- Slicer's own presets differ
   * (CT-Soft-Tissue is matte, CT-AAA is glossy), and the reason it is here at all is that Ron liked
   * the bone in Steve's roi.html demo and asked for those parameters on the FastSurfer results.
   *
   * What makes that bone read as bone turned out NOT to be transplantable: its transfer function is
   * keyed to Hounsfield units and its crispness comes from the CT's own intensity gradient. And once
   * Ron said "the skin/skull should be unlabeled after fastsurfer results. so we can ignore it when
   * visualizing the parcellations", the intensity ramp stopped mattering altogether -- only labeled
   * voxels are drawn, a label is binary so the edge is already hard, and the color is the label's.
   * The one ingredient left was the lighting.
   */
  shade?: [number, number, number, number];
  /** Why it is shown this way. Shown to the user; a preset with no reason should not be here. */
  why: string;
  by?: string;
}

/**
 * The colorize page's own settings, and what anything unrecognized gets.
 *
 * Modulation 0.55 lets the tissue underneath show through, which is what keeps a whole-body CT
 * segmentation looking like tissue rather than a solid block of paint. The unlabeled body starts
 * OFF -- see contextOn below for why -- and 0.12 is what it returns to when switched on.
 */
export const DEFAULT_PRESENTATION: Presentation = {
  id: "context",
  // ONE NAME FOR ONE THING. The 3D view's Look button calls this "Colorized volume"; this panel
  // called it "Anatomy in context", and Ron, 2026-09-22: "what does anatomy in context mean?"
  name: "Colorized volume",
  // OFF BY DEFAULT, kept at 0.12 for when it is switched back on. Ron, while working on the 3D
  // surfaces: "Please turn the nonlabeled voxel opacity off by default next time you compile. For
  // this work it is in the way."
  //
  // The argument below for showing it -- that on a whole-body CT the unlabeled body tells you where
  // the organs sit -- still holds for reading a result. It does not hold while judging the surfaces
  // themselves, which is the haze sitting in front of the thing being judged. Off is the recoverable
  // direction: the toggle is in the segmentation panel and the slider in the transfer function
  // editor, and both start from the 0.12 kept here.
  contextOn: false,
  context: 0.12,
  modulation: 0.55,
  segmentOpacity: 1,
  // PLAIN WORDS. This read: "the unlabeled body gives a whole-body result its orientation, and the
  // intensity underneath keeps organs looking like tissue rather than flat paint." Ron: "The
  // messages are cryptic and not understandable by a new user." True -- it describes the reasoning
  // behind the settings rather than what the person is looking at.
  why: "Shows only the segmented structures, and lets the scan show through the colors so organs " +
    "still look like tissue. Turn on the unlabeled body to see where the structures sit.",
};

/**
 * The special cases, most specific key first.
 *
 * A key is either a whole task name (`ts:lung_vessels`) or an ECOSYSTEM -- the part before the colon
 * -- which covers every task that package publishes, now and later. Prefer the ecosystem key: it is
 * what makes this a library rather than a list. Ron's words were "the standard appearance of
 * freesurfer LIKE packages", which is a statement about a family, so that is the level it is written
 * at, and a FastSurfer task added tomorrow inherits it without an edit here.
 */
/**
 * THE PRESETS THEMSELVES, by id.
 *
 * Separate from which network defaults to which (DEFAULT_PRESET below), and the separation is the
 * point rather than tidiness. Ron: "interface wise it is a preset and pops up in vicinity of the
 * segment button populated with the appropriate default. Down the road we will need to give users
 * the ability to create their own." A user-made preset is a new entry here and changes nothing about
 * the defaults; a network changing its default is one line there and invents no preset. Merging the
 * two would have made either of those edit the other.
 */
export const PRESETS: Record<string, Presentation> = {
  [DEFAULT_PRESENTATION.id]: DEFAULT_PRESENTATION,
  parcellation: {
    id: "parcellation",
    name: "Flat parcellation",
    contextOn: false,
    context: 0.12,
    // FLAT. Zero is not "less modulation", it is a different picture: the colorize field's own
    // contract is "0 = flat segment color (surface look)". At 0.2 the T1 underneath still varies
    // each parcel's brightness, so gray- and white-matter noise comes through as speckle -- worst on
    // the pale parcels, because a brightness wobble shows more against a light color than a dark
    // one. Ron: "Look at all the texture in the superior frontal gyrus. It's everywhere but most
    // prominent with lighter colors." The published FreeSurfer figures are flat paint: the color is
    // the label and nothing else is being said.
    modulation: 0,
    segmentOpacity: 1,
    why: "Hides everything that was not labeled and paints each structure in one flat color — " +
      "the way FreeSurfer and FastSurfer show a brain.",
    by: BY_CONVENTION,
  },
  /**
   * THE SAME FLAT PARCELS, LIT.
   *
   * Ron: "I like the look of the bone in https://pieper.github.io/live/webgpu/roi.html . Could you
   * look up the parameters that Steve is using and apply them to the fastsurfer results?"
   *
   * Those parameters are Slicer's CT-Chest-Contrast-Enhanced volume property, carried inside
   * CTACardio.json: opacity flat zero to 67 HU, hard onset at 251, near-white by 439, and shading on.
   * Only the last of those transfers. The breakpoints are Hounsfield units and a T1 has none of them
   * -- and, more to the point, Ron: "the skin/skull should be unlabeled after fastsurfer results. so
   * we can ignore it when visualizing the parcellations, which are the only structures that we are
   * interested in." With context off, an intensity ramp has nothing to act on: the parcels are the
   * picture, a label is binary so its edge is already hard, and the color is the label's own.
   *
   * So what is left of the bone look is the LIGHTING, and this is it: Slicer's own volume-rendering
   * shade -- ambient 0.1, diffuse 0.9, specular 0.2, shininess 10 -- the same tuple the roi.html
   * scene renders with.
   *
   * Kept SEPARATE from `parcellation` rather than replacing it, because flat was a considered choice
   * and its reason still stands (Ron on modulation: "Look at all the texture in the superior frontal
   * gyrus"). Shading is not modulation -- it varies with the surface, not with the T1 underneath --
   * but whether it reads as form or as noise is a matter of looking, so both are one click apart in
   * the AI panel's preset list.
   */
  "parcellation-lit": {
    id: "parcellation-lit",
    name: "Lit parcellation",
    contextOn: false,
    context: 0.12,
    modulation: 0,
    segmentOpacity: 1,
    shade: [0.1, 0.9, 0.2, 10],
    why: "Each structure in one flat color, lit the way Slicer lights a volume rendering \u2014 " +
      "diffuse with a specular highlight, so a parcel reads as a surface with form rather than as a " +
      "flat patch. The lighting is the one part of the bone look in Steve's roi.html demo that " +
      "carries over: its transfer function is in Hounsfield units, and with the skull unlabeled " +
      "there is no intensity ramp left to apply.",
    by: BY_CONVENTION,
  },
};

/**
 * Which preset a network starts in, keyed by whole task name OR by ECOSYSTEM.
 *
 * Prefer the ecosystem key: Ron's words were "the standard appearance of freesurfer LIKE packages",
 * a statement about a family, so a FastSurfer task published tomorrow inherits it without an edit
 * here. A whole-task key is for the one that departs from its package's house style.
 */
export const DEFAULT_PRESET: Record<string, string> = {
  fastsurfer: "parcellation-lit",
};

/** The ecosystem part of a task name -- `ts` for `ts:total` and for `ts.v2:total` alike (logic/task-name.ts). */
import { ecosystemOf } from "./task-name.ts";
export { ecosystemOf };

/**
 * How this task's result should first appear.
 *
 * Precedence, and it is worth stating because a library without one becomes a pile: an entry for the
 * WHOLE TASK NAME wins, then the ecosystem, then the default. So a package can have a house style
 * and one of its tasks can still depart from it.
 */
export function presentationFor(task: string): Presentation {
  return PRESETS[presetIdFor(task)] ?? DEFAULT_PRESENTATION;
}

/** The preset id this task starts in: whole task name, then ecosystem, then the default. */
export function presetIdFor(task: string): string {
  return DEFAULT_PRESET[task] ?? DEFAULT_PRESET[ecosystemOf(task)] ?? DEFAULT_PRESENTATION.id;
}

/** Every preset a person can choose, in a stable order with the default first. */
export function allPresets(): Presentation[] {
  const first = DEFAULT_PRESENTATION;
  return [first, ...Object.values(PRESETS).filter((p) => p.id !== first.id)];
}

/** Does this task have a presentation of its own, or is it taking the default? Lets the panel say so
 *  rather than claiming a considered appearance it did not apply. */
export function hasPresentation(task: string): boolean {
  return task in DEFAULT_PRESET || ecosystemOf(task) in DEFAULT_PRESET;
}

/**
 * The preset as the transferFunction node's own fields.
 *
 * `contextOpacity` folds `contextOn` and `context` together, because the renderer has one number: an
 * unlabeled body that is off is one at opacity zero. The toggle needs them apart, which is why the
 * preset keeps them apart and only this collapses them.
 */
export function presentationParams(p: Presentation): Record<string, number | number[]> {
  return {
    contextOpacity: p.contextOn ? p.context : 0,
    ctModulation: p.modulation,
    segmentOpacity: p.segmentOpacity,
    // Absent means "leave the renderer's default", which is not the same as flat: sending
    // UNSHADED would make every preset without an opinion matte.
    ...(p.shade ? { shade: p.shade } : {}),
  };
}
