// WHAT KIND OF SCAN A SERIES IS, from its header first and its name second (Ron, 2026-10-31, for the tumor's parts:
// "enhancing versus non enhancing only makes sense when there is a post gad scan available"; the mockup
// docs/mockups/segment-editor-scans-2026-10-31.html, answered "1 yes 2 same day 3 guided 4 align automatically").
//
// The header facts: the contrast agent field (0018,0010), repetition, echo and inversion time (0018,0080/0081/0082),
// the modality. The agent field alone misleads: a FLAIR acquired after the injection carries it too (UPENN-GBM-00020's
// t2_Flair_axial says OMNISCAN). So the rule is the combination: a long inversion time with a long echo is FLAIR; a
// long repetition and echo without inversion is T2; a short echo is T1-weighted, and with an agent T1 post-contrast. A
// scan the header does not decide falls back to its series name; one neither decides is "other". Robust for an
// unknown scanner (no vendor tables).
//
// Versioned (SCAN_KIND_VERSION): a change to a rule is a new version. Planned (the mockup): the answer written once at
// import into Albula's working copy, correctable by a person; today it is read when the Segment Editor asks.

/** 1: 2026-10-31, the first. 2: the same evening, after the critic (qa/2026-10-31-evening-editor-3d.md, finding 4): a name's
 *  words split at underscores too ("3D_AX_T1_postcontrast" was "other"); an EMPTY agent field is unknown, not "no agent",
 *  so a name that says post-contrast decides (anonymizers blank the field); "No contrast" and the like are no agent; scans
 *  that are not an image of the anatomy -- susceptibility, localizers, perfusion, angiography, maps -- are "other", though
 *  taken after the injection (an SWI and a localizer came out "T1 post-contrast"). Version 1 stays as scanKindV1. */
export const SCAN_KIND_VERSION = 2;

export type ScanKind = "T1 post-contrast" | "T1" | "T2" | "FLAIR" | "CT post-contrast" | "CT" | "other";

export interface ScanFacts {
  modality?: string;
  /** Contrast/Bolus Agent (0018,0010), as written. */
  agent?: string;
  /** ms. */
  repetitionTime?: number; echoTime?: number; inversionTime?: number;
  /** Series Description (0008,103E). */
  description?: string;
  /** Sequence Name (0018,0024): "ep2d_diff" and the like say a diffusion scan. */
  sequenceName?: string;
}

/** The kind, and how it was decided, in words a person reads (version 2). */
export function scanKind(f: ScanFacts): { kind: ScanKind; how: string } {
  const mod = (f.modality ?? "").toUpperCase();
  const agent = (f.agent ?? "").trim();
  const noAgent = /^(none|no|n\/a|na|nil|-|0)$|^(no|without|w\/o)\b/i.test(agent);
  const named = !!agent && !noAgent;
  // The name's words, split at underscores, dashes and dots as well as spaces ("\b" does not split "AX_T1").
  const words = ` ${`${f.description ?? ""} ${f.sequenceName ?? ""}`.toLowerCase().replace(/[_\-.,/()]+/g, " ")} `;
  const says = (re: RegExp) => re.test(words);
  const namePost = says(/ (post|postcontrast|post contrast|gad|gado|gd|c\+|\+c|t1c|t1ce|t1gd|ce|contrast|enhanced) /) && !says(/ (pre|precontrast|no contrast|non contrast|without) /);
  const notAnatomy = says(/ (swi|swan|susc|suscept|loc|localizer|localiser|scout|survey|3 plane|tri plane|perf|perfusion|dsc|dce|pwi|asl|tof|mra|angio|adc|trace|fa|map|t2\*|t2star|hemo) /);
  if (mod === "CT") return named || (!agent && namePost) ? { kind: "CT post-contrast", how: named ? `from the header: contrast agent ${agent}` : "from the series name" } : { kind: "CT", how: agent ? "from the header: no contrast agent" : "no contrast agent in the header or the name" };
  if (mod && mod !== "MR") return { kind: "other", how: `modality ${mod}` };
  if (says(/ (diff|dti|dwi|dsi|hardi|ep2d diff) /) || /diff|dti|dwi|dsi|hardi/i.test(f.sequenceName ?? "")) return { kind: "other", how: "a diffusion scan" };
  if (notAnatomy) return { kind: "other", how: "the series name says it is not an image of the anatomy (susceptibility, localizer, perfusion, angiography or a map)" };
  const post = named || (!agent && namePost);
  const postHow = named ? `contrast agent ${agent}` : "the series name says post-contrast";
  const tr = f.repetitionTime, te = f.echoTime, ti = f.inversionTime;
  if (ti !== undefined && ti >= 1500 && te !== undefined && te >= 70) return { kind: "FLAIR", how: `from the header: inversion time ${ti} ms, echo time ${te} ms` };
  if (te !== undefined && te >= 60 && tr !== undefined && tr >= 2000 && !(ti !== undefined && ti > 0)) return { kind: "T2", how: `from the header: repetition time ${tr} ms, echo time ${te} ms` };
  if (te !== undefined && te < 30 && tr !== undefined && tr < 3000) {
    return post ? { kind: "T1 post-contrast", how: `from the header: echo time ${te} ms; ${postHow}` } : { kind: "T1", how: `from the header: echo time ${te} ms, no contrast agent` };
  }
  if (says(/ (flair|t2 flair|dark fluid) /)) return { kind: "FLAIR", how: "from the series name" };
  if (says(/ t1\w* /) || says(/ (mprage|spgr|bravo|tfl|vibe|space t1) /)) return post || namePost ? { kind: "T1 post-contrast", how: "from the series name" } : { kind: "T1", how: "from the series name" };
  if (says(/ t2\w* /)) return { kind: "T2", how: "from the series name" };
  return { kind: "other", how: "neither the header nor the name says" };
}

/** Version 1 (2026-10-31), kept so a recorded answer can be reproduced. */
export function scanKindV1(f: ScanFacts): { kind: ScanKind; how: string } {
  const mod = (f.modality ?? "").toUpperCase();
  const agent = (f.agent ?? "").trim();
  const named = agent && !/^(none|no|n\/a|-)$/i.test(agent);
  if (mod === "CT") return named ? { kind: "CT post-contrast", how: `from the header: contrast agent ${agent}` } : { kind: "CT", how: "from the header: no contrast agent" };
  if (mod && mod !== "MR") return { kind: "other", how: `modality ${mod}` };
  // A DIFFUSION SCAN has a T2's timing (UPENN-GBM-00020's ep2d_DTI_30dir: 5000 / 86 ms) and is not one.
  if (/diff|dti|dwi|dsi|hardi/i.test(`${f.sequenceName ?? ""} ${f.description ?? ""}`)) return { kind: "other", how: "a diffusion scan" };
  const tr = f.repetitionTime, te = f.echoTime, ti = f.inversionTime;
  if (ti !== undefined && ti >= 1500 && te !== undefined && te >= 70) return { kind: "FLAIR", how: `from the header: inversion time ${ti} ms, echo time ${te} ms` };
  if (te !== undefined && te >= 60 && tr !== undefined && tr >= 2000 && !(ti !== undefined && ti > 0)) return { kind: "T2", how: `from the header: repetition time ${tr} ms, echo time ${te} ms` };
  if (te !== undefined && te < 30 && tr !== undefined && tr < 3000) {
    return named ? { kind: "T1 post-contrast", how: `from the header: echo time ${te} ms, contrast agent ${agent}` } : { kind: "T1", how: `from the header: echo time ${te} ms, no contrast agent` };
  }
  const d = f.description ?? "";
  if (/flair/i.test(d)) return { kind: "FLAIR", how: "from the series name" };
  if (/\bt1/i.test(d) || /mprage|spgr|bravo/i.test(d)) {
    return /post|gad|\bgd\b|\+c\b|t1c|t1ce|contrast|\bce\b/i.test(d) ? { kind: "T1 post-contrast", how: "from the series name" } : { kind: "T1", how: "from the series name" };
  }
  if (/\bt2/i.test(d)) return { kind: "T2", how: "from the series name" };
  return { kind: "other", how: "neither the header nor the name says" };
}

export const isPostContrast = (k: ScanKind) => k === "T1 post-contrast" || k === "CT post-contrast";
