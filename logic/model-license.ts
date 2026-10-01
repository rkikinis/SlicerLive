// What you are agreeing to when you run someone else's trained network.
//
// Ron, 2026-09-05: "The license conditions should jump up when someone clicks the segment button
// after selecting one of the networks that has a non commercial license. There should be a link to
// the page that you sent me to."
//
// The point is not paperwork. These networks are free for academic use and NOT free for anything
// else, and the moment that matters is the click that produces a result — not a footnote in a README
// somebody read once. A person running a segmentation on a Tuesday should be told, by the tool, that
// the output they are about to make carries conditions.
//
// WHAT IS ASSERTED HERE, AND FROM WHERE. Two different restrictions, often confused:
//
//   the WEIGHTS   TotalSegmentator's license is academic and non-commercial. Some subtasks are not
//                 in the public release at all and are served from a licensed backend; haversack
//                 refuses those until a license key is set. Terms verbatim from the registration
//                 form at backend.totalsegmentator.com/license-academic.
//   the RESULTS   totalsegmentator.com states: "The results of the models appendicular bones, tissue
//                 types, heartchambers highres and face may not be used commercially. All other
//                 results are open for any usage." So four tasks restrict the OUTPUT as well, which
//                 outlives the session that made it and is the one worth saying twice.

import { parseTask } from "./task-name.ts";
export interface ModelLicense {
  /** The project whose terms these are. */
  project: string;
  /** Where to get a license, or read the terms. */
  url: string;
  /** The clauses, as the licensor words them. */
  terms: { title: string; text: string }[];
  /** True when the RESULT, not only the software, may not be used commercially. */
  restrictedOutput: boolean;
}

/**
 * The four whose OUTPUT is restricted, named on totalsegmentator.com.
 *
 * Task names as haversack reports them, without the `ts:` prefix. `heartchambers_highres` is written
 * "heartchambers highres" on the page; the underscore form is what the API uses.
 */
const RESTRICTED_OUTPUT = new Set([
  "appendicular_bones",
  "appendicular_bones_mr",
  "tissue_types",
  "tissue_types_mr",
  "tissue_4_types",
  "heartchambers_highres",
  "face",
  "face_mr",
]);

/**
 * The tasks that actually need a license key — TotalSegmentator's own list, not ours.
 *
 * Ron: "it also pops up for networks that dont require the license, such as lung vessels." He is
 * right, and the first version deserved it: it gated on ECOSYSTEM, so every `ts:` task raised the
 * dialog. Most of them are in the public release and need nothing.
 *
 * Derived rather than compiled by hand: TotalSegmentator's `python_api.py` calls
 * `show_license_info()` inside exactly the task branches that require a key, so this is the tool's
 * own answer to the question. Fourteen of its forty-four tasks; `total`, `lung_vessels`,
 * `liver_segments`, `ventricle_parts` and the rest are free.
 *
 * Re-derive after a TotalSegmentator upgrade with:
 *   grep -B20 'show_license_info()' python_api.py | grep 'task =='
 */
const REQUIRES_KEY = new Set([
  "aortic_sinuses",
  "appendicular_bones",
  "appendicular_bones_mr",
  "brain_structures",
  "coronary_arteries",
  "face",
  "face_mr",
  "heartchambers_highres",
  "thigh_shoulder_muscles",
  "thigh_shoulder_muscles_mr",
  "tissue_4_types",
  "tissue_types",
  "tissue_types_mr",
  "vertebrae_body",
]);

const TOTALSEGMENTATOR_TERMS: { title: string; text: string }[] = [
  {
    title: "Academic, non-commercial use",
    text:
      "The license granted is for academic, non-commercial purposes only — scholarly research that is " +
      "not undertaken for any direct or indirect for-profit purpose, and is not intended to produce " +
      "works, services or data for commercial use.",
  },
  {
    title: "Internal use",
    text:
      "For your own internal use only. You may not sublicense, distribute, transfer, disclose or " +
      "make the software available, in whole or in part, to another research group in your " +
      "institution or to any third party.",
  },
  {
    title: "Regulated uses",
    text:
      "The software has not been cleared, approved, registered or otherwise qualified with any " +
      "regulatory agency for use in diagnostic or therapeutic procedures, or for any other use " +
      "requiring compliance with law regulating diagnostic or therapeutic products or medical devices.",
  },
  {
    title: "No warranty",
    text:
      "Provided \"as is\", with all express and implied warranties disclaimed. Use of the software, " +
      "including with or on human subjects, is at your sole risk.",
  },
];

/**
 * The license a task runs under, or null when we make no claim about it.
 *
 * Keyed by ECOSYSTEM rather than by task, because the license belongs to the project: every
 * TotalSegmentator task is academic and non-commercial, whether or not its particular weights happen
 * to be in the public release. Returning null for MOOSE and the rest is deliberate — saying nothing
 * is honest, and inventing terms for a project whose license has not been read would not be.
 */
export function licenseFor(task: string): ModelLicense | null {
  const { ecosystem, name } = parseTask(task);   // `ts.v2:total` is TotalSegmentator's as much as `ts:total`
  // Only where there is something to agree TO: a key is required, or the result carries a
  // restriction. A dialog in front of `ts:total`, which is free, is a dialog that teaches people to
  // dismiss dialogs — and the next one it teaches them to dismiss is the one that mattered.
  if (ecosystem !== "ts" || !(REQUIRES_KEY.has(name) || RESTRICTED_OUTPUT.has(name))) return null;
  return {
    project: "TotalSegmentator",
    url: "https://backend.totalsegmentator.com/license-academic",
    terms: TOTALSEGMENTATOR_TERMS,
    restrictedOutput: RESTRICTED_OUTPUT.has(name),
  };
}

/** The extra sentence for the four whose results are restricted, or "" when there is none. */
export function outputRestriction(task: string): string {
  return licenseFor(task)?.restrictedOutput
    ? "The RESULTS of this particular network may not be used commercially — a restriction on the " +
      "segmentation you are about to make, not only on the software that makes it."
    : "";
}
