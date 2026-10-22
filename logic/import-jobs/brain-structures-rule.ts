// WHICH SEGMENTATION IS "THE BRAIN'S STRUCTURES" of a T1: the one rule the import-time job (brain-structures.ts) and the
// page (render/after-load.ts, load-panel.ts) both use -- pure, with nothing of the server in it, so the page can import it.
export const BRAIN_TASK = "fastsurfer:asegdkt";
/** THE IMPORT-TIME JOB'S RULES, numbered (CLAUDE.md, "modular and versioned"): recorded in every SEG it writes, and the
 *  key under which a failure is remembered (a new version tries a failed scan again). Here, not in the job's library, so
 *  the server (desktop/extension-jobs.ts) can name it without loading the readers. Version 2 (critic 2026-10-20): the
 *  conform modeled as haversack 0.15.0 does it, more names for a head study, codes by the structure's key. */
export const BRAIN_JOB_VERSION = 2;
/** The job's name where the server and the job keep its state (the marker file, `/_jobs`): an extension's name for the
 *  extensions' jobs, this for the core's. */
export const BRAIN_JOB_KEY = "core-brain";
/** What the AI panel and the job name the result: "<task> of <series>". */
export const brainDescription = (seriesDescription: string) => `${BRAIN_TASK} of ${seriesDescription}`.slice(0, 64);
/** The same network under its earlier name in haversack (fastsurfer:brain until 0.13; DEPENDING-ON-OTHER-PEOPLE.md):
 *  a result saved then is the brain's structures too (CONSTRAINTS: the studyforrest crop of 2026-09-10). */
const EARLIER_NAMES = ["fastsurfer:brain"];
export const isBrainResult = (description: string | undefined | null) =>
  !!description && [BRAIN_TASK, ...EARLIER_NAMES].some((t) => description.startsWith(`${t} of`));

/** A series named as a T1-weighted scan (the diffusion extension's rule for "the MRI of the anatomy", import-job.ts). */
export const T1_NAME = /(^|[^a-z0-9])t1([^0-9]|$)|mprage|mp-rage|bravo|spgr|tfl3d|t1w/i;

/** NAMED WITH T1 BUT NOT A T1-WEIGHTED IMAGE (critic 2026-10-20, finding 16): a quantitative map ("T1map", "T1 map",
 *  "T1rho": the numbers are times, not an image FastSurfer was trained on) and a T1 FLAIR. */
export const NOT_T1_IMAGE = /t1[\s_-]*(map|rho)|t1[\s_-]*flair/i;

/** The MR series the job looks at: named as a T1, not a series Albula made ("… of …", fiber tracts, a crop). */
export function t1Candidates<T extends { modality: string; description: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.modality === "MR" && T1_NAME.test(r.description) && !NOT_T1_IMAGE.test(r.description) && !/ of |fiber tracts|crop/i.test(r.description));
}

/** ONE BRAIN PER STUDY, from the scan most like a plain 3D T1 (ds004910 sub-01 has 20 T1 variants in one study): first
 *  those not after contrast and not a subtraction, then the one with the most images. The rest of the study is left. */
export function studyOrder<T extends { seriesUID: string; description: string }>(cands: T[], images: Map<string, number>): T[] {
  // After contrast: "post", "+C", "C+", "Gd", "gad…", "contrast"; a subtraction (critic 2026-10-20, finding 16: "C+" and "GD").
  const after = (r: T) => /post|\+c\b|(^|[^a-z])c\+|(^|[^a-z])gd([^a-z]|$)|gad|contrast|_sub\b|subtract/i.test(r.description) ? 1 : 0;
  return [...cands].sort((a, b) => after(a) - after(b) || (images.get(b.seriesUID) ?? 0) - (images.get(a.seriesUID) ?? 0));
}
