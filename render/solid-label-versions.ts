// WHICH LABELS THE SOLID LOOK DRAWS WITH, BY VERSION. Ron, 2026-09-25: "Please make sure that this and everything else
// is as modular as possible and also versioned." Like the shading (shading-versions.ts): each version is a number, the
// old ones stay, the newest is the default.
//
//   v1  the labels as painted, 2026-09-23. The solid look finds a structure where the blurred copy of its labels crosses
//       one half, but near an edge it also reads the labels themselves (a structure too thin for the blur, the structure
//       under or just ahead); where the two disagree the edge shows short dark dashes and slivers ("ants").
//   v2  labels that agree with the blurred copy, 2026-11-01: inside the blurred surface each voxel draws as the
//       structure painted there, or the nearest painted one within 2 voxels; outside it, as nothing
//       (solid-smooth.ts AGREE_WGSL). The labels themselves are not changed; the 3D view draws from a copy. Ron, on the
//       three columns (3d-ants-plan-2026-10-31.md): "Middle column". Bone thinner than the blur keeps is not drawn: on the
//       0.25 mm CBCT 2.0 % of the labeled bone, on the 0.977 mm Prisma CT 7.6 % (about a quarter in the orbits).
//       SO ONLY WHERE LITTLE IS LOST (Ron, 2026-11-01: "For now your recommendation"): each field counts the visible
//       painted voxels outside its smoothed copy, and above MAX_LOST of them draws the labels as painted (v1) instead.
//       The share is over the whole segmentation: a mostly thick skull could pass while its thinnest walls still go.
//   v3  ONE RULE FOR EVERYTHING, 2026-11-01 (Ron: "If possible I would like to have one rule set for everything"; on the
//       blur's width, "Blurr 1-1-1 looks best"; "3.5 pixel size is anisotropy"; "Yes"): agreeing labels for every field,
//       no 5 % switch, and the blur chosen from the voxels' anisotropy (slice spacing over pixel spacing): one five-tap
//       pass across the slices and (anisotropy / 2)^2 passes, rounded, at least one, along each finer axis. Near-cubic
//       voxels get 1-1-1 (the CBCT, the Prisma CT, FastSurfer, C3N-01524), anisotropy 3.5 today's 3-3-1, 4.4 5-5-1. What
//       the wide blur dropped (C3N-01524's airways and lung vessels alone 16.5 %, 7.0 % with 1-1-1; the Prisma orbits 25
//       %, 8.4 %) mostly comes back. WHAT GOES IS MORE THAN "ONE VOXEL THICK" (critic 2026-11-06, findings 1, 2; the table in
//       Contents/docs/SOLID-LOOK.md): anything one slice deep, however wide; a 2 x 2 rod on cubic voxels; a ball of radius 3 mm on
//       0.68 / 3 mm voxels, of 5 mm on 0.625 / 5 mm. Said per structure on the status line (livescene.ts sayNotDrawn).

export interface SolidLabelsVersion { version: number; date: string; label: string; what: string }
export const SOLID_LABELS: readonly SolidLabelsVersion[] = [
  { version: 1, date: "2026-09-23", label: "As painted", what: "As painted: every painted voxel can show, thin bone included, with dashes along some edges." },
  { version: 2, date: "2026-11-01", label: "Clean edges where little is lost", what: "Clean edges where they cost little of the structure; as painted elsewhere." },
  { version: 3, date: "2026-11-01", label: "Clean edges", what: "Clean edges everywhere: no dashes along the edges. What is thin or small against the voxels is not drawn, more on thick slices." },
];
export const LATEST_SOLID_LABELS = SOLID_LABELS[SOLID_LABELS.length - 1].version;

let current = LATEST_SOLID_LABELS;
/** The version a field reads when it makes its solid-look textures. */
export function solidLabelsVersion(): number { return current; }
/** Takes effect for fields made after the change. */
export function setSolidLabelsVersion(v: number): void {
  current = SOLID_LABELS.some((s) => s.version === v) ? v : LATEST_SOLID_LABELS;
}

/** v2 is used for a field only when at most this share of its visible painted voxels lies outside the smoothed copy. */
export const MAX_LOST = 0.05;
/** Whether a field with these counts draws with agreeing labels or the labels as painted: v2 by MAX_LOST, v3 always. */
export function agreeKept(painted: number, outside: number, version = current): boolean {
  if (version >= 3) return true;
  return painted > 0 && outside / painted <= MAX_LOST;
}

/** v3: no more than this many passes along one axis (anisotropy about 8, e.g. 5 mm slices of 0.6 mm pixels). */
export const MAX_PASSES = 16;
/**
 * How many five-tap passes the smoothed copy takes along each of the field's axes (i, j, k), for this version and these
 * voxel spacings. v1 and v2: `fixed` (solid-smooth.ts smoothPasses, 3-3-1). v3: one along the coarsest axis; along each
 * other, (coarsest / its spacing / 2)^2, rounded, at least one.
 */
export function solidBlurPasses(spacing: readonly [number, number, number], fixed: readonly [number, number, number], version = current): [number, number, number] {
  if (version < 3 || !spacing.every((sp) => sp > 0 && Number.isFinite(sp))) return [fixed[0], fixed[1], fixed[2]];   // a spacing that is no spacing: the fixed blur (critic 2026-11-06, finding 11)
  const big = Math.max(...spacing);
  return spacing.map((sp) => sp >= big * 0.99 ? 1 : Math.min(MAX_PASSES, Math.max(1, Math.round((big / sp / 2) ** 2)))) as [number, number, number];
}
