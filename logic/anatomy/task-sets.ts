// THE SEGMENT EDITOR'S TASKS (Ron, 2026-10-31): "the user gets to choose a task from a collapsible area at the top: Tumor,
// with a choice of regions … General anatomic parcellation with a choice of regions. And finally, 'build my own'." His
// answers: the General Anatomy list is the default ("It was defined by Mike and myself"); a tumor set is "tumor, necrosis,
// edema", and in the brain DICOM's four (below); region words "clinical"; colors "Mike's current tissue palette, v2", and "the colors
// from the general anatomy for things that do not exist in v2"; Tumor "a light green as the only greenish structure in
// the body is the gall bladder". And above all: "keep the initial selection simple … select smart defaults".
//
// What a task gives is a list of structures -- name, code, side, color -- that the editor offers as its picker. Versioned
// (TASK_SETS_VERSION): a change to what a task holds, or to how its colors are chosen, is a new version.
//
// THE NAMES AND CODES are the "3D Slicer General Anatomy list" (general-anatomy.term.json, copied unchanged from
// Slicer/Slicer `Modules/Loadable/Terminologies/Resources/SegmentationCategoryTypeModifier-SlicerGeneralAnatomy.json`,
// last changed in commit 51b7c91, 2024-03-20; Slicer's license), read by the same parser as any terminology file.
// THE REGIONS are Albula's curated region of each SNOMED concept (regions.ts, concept-regions.csv): 46 of the list's 199
// types have one (2026-10-31); a structure with none is not offered under a region, only by search.
// THE COLORS: the palette version in use (by default v4: Mike's tissue palette v2 with the CSF in light blue), found through the TotalSegmentator
// label the harmonized table gives the concept (and side); else the list's own recommended color.
import ga from "./general-anatomy.term.json" with { type: "json" };
import harmonized from "./harmonized.json" with { type: "json" };
import { parseTermJson, type TerminologyEntry } from "./terminology.ts";
import { regionsOfCode, regionsOfStructure, type Region } from "./regions.ts";
import { paletteRgb } from "./palettes.ts";

/** 1: 2026-10-31, the first. 2: the same day, the tumor sets coded from DICOM, and the brain's its own (below). 3: the
 *  same evening, Ron's correction: Tumor in green with Enhancing and Non-enhancing as its parts, in any region, offered
 *  only with a post-contrast scan of the same day; Necrosis and Edema findings of their own. */
export const TASK_SETS_VERSION = 3;
export const GENERAL_ANATOMY_SOURCE = {
  repo: "Slicer/Slicer", path: "Modules/Loadable/Terminologies/Resources/SegmentationCategoryTypeModifier-SlicerGeneralAnatomy.json",
  commit: "51b7c91ad56c", committed: "2024-03-20", copied: "2026-10-31",
};

export type Task = "tumor" | "anatomy" | "own";
export const TASK_WORDS: Record<Task, string> = { tumor: "Tumor", anatomy: "General anatomy", own: "My own" };
/** The region words a person chooses from (Ron: "clinical"). */
export const CLINICAL_REGIONS = ["Brain", "Head and neck", "Chest", "Abdomen", "Pelvis", "Spine", "Extremities"] as const;
export type ClinicalRegion = typeof CLINICAL_REGIONS[number];
/** Each clinical word's region in Albula's curated table. Brain and the rest of the head are one region there ("Head");
 *  splitting it is curation still to do. */
const TO_REGION: Record<ClinicalRegion, Region> = {
  "Brain": "Head", "Head and neck": "Neck", "Chest": "Thorax", "Abdomen": "Abdomen", "Pelvis": "Pelvis", "Spine": "Spine", "Extremities": "Limbs",
};
const FROM_REGION = new Map<Region, ClinicalRegion>(Object.entries(TO_REGION).map(([c, r]) => [r, c as ClinicalRegion]));

export interface TaskStructure {
  key: string; name: string; code?: string; type?: string; mod?: string;
  /** The SNOMED category when not "Anatomical Structure" (the tumor's parts: "Morphologically Abnormal Structure"). */
  category?: string;
  /** The category's code, "SCT:49755003", where it is known. */
  categoryCode?: string;
  /** 0-255. */
  rgb: [number, number, number];
  /** Where the color came from: the palette in use (v2 by default), the General Anatomy list, Ron's choice, or the
   *  radiologist-corrected brain tumor segmentations in the main database (written by QIICR's dcmqi). */
  colorFrom: "palette" | "general-anatomy" | "ron" | "radiologists";
  /** The key of the structure this one is a part of (Enhancing is a part of Tumor): the list shows it under that one. */
  partOf?: string;
}

const GA = parseTermJson(JSON.stringify(ga), "general-anatomy", "3D Slicer General Anatomy list");

/** The TotalSegmentator labels (the palette's keys) of each concept, with their side. */
const LABELS_OF = new Map<string, { label: string; mod?: string }[]>();
for (const [label, s] of Object.entries((harmonized as { structures: Record<string, { code?: string; mod?: string }> }).structures)) {
  if (!s.code) continue;
  (LABELS_OF.get(s.code) ?? LABELS_OF.set(s.code, []).get(s.code)!).push({ label, mod: s.mod });
}

/** The palette's color for a concept on a side, when the palette has it. */
function paletteOf(code: string | undefined, mod: string | undefined): [number, number, number] | undefined {
  if (!code) return undefined;
  const labels = LABELS_OF.get(code) ?? [];
  const sided = mod ? labels.filter((l) => (l.mod ?? "").toLowerCase() === mod.toLowerCase()) : labels.filter((l) => !l.mod);
  for (const l of [...sided, ...labels]) { const c = paletteRgb(l.label); if (c) return c; }
  return undefined;
}

function toStructure(e: TerminologyEntry): TaskStructure {
  const p = paletteOf(e.code, e.mod);
  return { key: e.key, name: e.name, code: e.code, type: e.type, mod: e.mod, ...(e.category ? { category: e.category } : {}), ...(e.categoryCode ? { categoryCode: e.categoryCode } : {}), rgb: p ?? (e.rgb as [number, number, number] | undefined) ?? [200, 200, 200], colorFrom: p ? "palette" : "general-anatomy" };
}
const byName = (n: string) => { const k = GA.byName[n.toLowerCase()]; return k ? GA.entries[k] : undefined; };

/** The list's entries a person would pick: a structure that comes in a left and a right is offered as the two sides only. */
function pickable(): TerminologyEntry[] {
  const all = Object.values(GA.entries);
  const sided = new Set(all.filter((e) => e.mod).map((e) => `${e.code}|${e.type}`));
  return all.filter((e) => e.mod || !sided.has(`${e.code}|${e.type}`));
}

// THE TUMOR CODES ARE DICOM'S (Ron, 2026-10-31: "TA2 has nothing by design. Snowmed/Dicom is the way to go with all
// pathology"; then "Neoplasm for tumor; use DICOM's four for the brain"). PS3.16, current edition, read 2026-10-31:
// CID 7159 "Lesion Segmentation Type" holds Neoplasm (SCT 108369006), Necrosis and Edema; it includes CID 7168, the brain
// lesion's parts with necrosis, which is CID 7169 (Enhancing Lesion NCIt C113842, Non-Enhancing Lesion NCIt C81175, Edema)
// plus Necrosis. The category of every one is CID 7150's Morphologically Abnormal Structure (SCT 49755003). Neoplasm is
// also what Albula's tumor-mask import writes (logic/import/bids.ts, through the catalog's "neoplasm"), so a Tumor drawn
// here and one imported carry the same code. The radiologist-corrected brain tumor segmentations in the main database
// (AIMI, 8 files) carry three of the brain's four (Enhancing Lesion, Necrosis, Edema; no Non-enhancing lesion), and file
// their Enhancing Lesion under the category NCIt C35869 Radiologic Finding rather than DICOM's 49755003 (critic
// 2026-10-31, finding 12); the type codes match theirs.
const ABNORMAL = { category: "Morphologically Abnormal Structure", categoryCode: "SCT:49755003" };
/** THE TUMOR STRUCTURE, for every path that makes one (the task list, Click to outline): Neoplasm, Ron's light green. */
export const TUMOR: TaskStructure = { key: "tumor", name: "Tumor", code: "SCT:108369006", type: "Neoplasm", ...ABNORMAL, rgb: [144, 238, 144], colorFrom: "ron" };

/** The list's own entry (its code and color), with DICOM's category. */
const listed = (n: string): TaskStructure[] => { const e = byName(n); return e ? [{ ...toStructure(e), ...ABNORMAL }] : []; };

/** TUMOR (Ron, 2026-10-31: "tumor is green and has two components: enhancing and non enhancing. Necrosis is dead
 *  tissue, whether inside tumor or not. Edema is increased fluid content whether associated with tumor or with other
 *  things like after a mechanical trauma"; and on whether every tumor has the two: "not every tumor is like that. E.G. GBM
 *  are low grade gliomas are not. same in other body regions"). So Tumor is always offered and painted directly; its two
 *  parts are offered under it, in any region, when the patient has a post-contrast scan of the same day ("enhancing
 *  versus non enhancing only makes sense when there is a post gad scan available"); a tumor that does not enhance leaves
 *  them empty and Save leaves them out. Codes: DICOM's (above). Colors: Tumor Ron's light green; Enhancing a strong green
 *  and Non-enhancing a pale green, so together they read as the tumor (mockups/segment-editor-tumor-brush-2026-10-31.html,
 *  Ron: "as drawn"); Necrosis and Edema the General Anatomy list's (the radiologists' files' too). Enhancing differs from
 *  the radiologists' red-pink (219, 39, 99); the codes match, so comparisons still pair them. */
function tumorSet(withParts: boolean): TaskStructure[] {
  return [
    TUMOR,
    ...(withParts ? [
      { key: "enhancing-lesion", name: "Enhancing", code: "NCIt:C113842", type: "Enhancing Lesion", ...ABNORMAL, rgb: [40, 160, 70], colorFrom: "ron", partOf: "tumor" },
      { key: "non-enhancing-lesion", name: "Non-enhancing", code: "NCIt:C81175", type: "Non-Enhancing Lesion", ...ABNORMAL, rgb: [200, 245, 185], colorFrom: "ron", partOf: "tumor" },
    ] as TaskStructure[] : []),
    ...listed("Necrosis"), ...listed("Edema"),
  ];
}

/** The structures a task offers, in the list's order. My own: none (the person names them). `postContrast`: the patient
 *  has a post-contrast scan of the same day (logic/scan-kind.ts), which brings the tumor's two parts. */
export function taskStructures(task: Task, region: ClinicalRegion | null, opts: { postContrast?: boolean } = {}): TaskStructure[] {
  if (task === "tumor") return tumorSet(!!opts.postContrast);
  if (task !== "anatomy" || !region) return [];
  const r = TO_REGION[region];
  return pickable().filter((e) => regionsOfCode(e.code).includes(r)).map(toStructure);
}

/** Every structure of the General Anatomy list, for a search when no region is chosen. */
export function allStructures(): TaskStructure[] { return pickable().map(toStructure); }

/** A STRUCTURE'S OWN NAME FROM THE LIST, for a segment typed or found by search. */
export function structureNamed(name: string): TaskStructure | undefined { const e = byName(name); return e ? toStructure(e) : undefined; }

/**
 * THE REGION FROM THE SCAN'S BODY PART (DICOM Body Part Examined, 0018,0015; the defined terms of PS3.16 CID 4031 and
 * what scanners write), or null when it does not say or says something else. A combined part (CHESTABDPELVIS) gives
 * its first region.
 */
export function regionFromBodyPart(bodyPart: string | undefined | null): ClinicalRegion | null {
  const b = (bodyPart ?? "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (!b) return null;
  if (/^(BRAIN|HEAD$|SKULL|NEURO|CEREBR)/.test(b)) return "Brain";
  if (/^(HEADNECK|HEADANDNECK|NECK|FACE|SINUS|ORBIT|EAR|JAW|TMJ|LARYNX|PHARYNX|THYROID|ORAL|MOUTH|NASOPHAR|PAROTID)/.test(b)) return "Head and neck";
  if (/^(CHEST|THORAX|LUNG|HEART|BREAST|MEDIASTIN|CARDIAC|CORONARY|RIB)/.test(b)) return "Chest";
  if (/^(ABDOMEN|ABD|LIVER|KIDNEY|PANCREA|COLON|STOMACH|SPLEEN|GALLBLADDER|BOWEL|RENAL)/.test(b)) return "Abdomen";
  if (/^(PELVIS|PROSTATE|BLADDER|UTERUS|OVARY|RECTUM|HIP)/.test(b)) return "Pelvis";
  if (/^(SPINE|CSPINE|TSPINE|LSPINE|SSPINE|COCCYX|SACRUM|CERVICALSPINE|THORACICSPINE|LUMBARSPINE|WHOLESPINE)/.test(b)) return "Spine";
  if (/^(EXTREMITY|ARM|LEG|KNEE|SHOULDER|ELBOW|WRIST|HAND|FOOT|ANKLE|FEMUR|TIBIA|HUMERUS|UPPEREXM|LOWEREXM|UPPERLIMB|LOWERLIMB|FINGER|TOE)/.test(b)) return "Extremities";
  return null;
}

/** Whole words of a study description that name a body part (DICOM CID 4031's terms and what scanners write); a
 *  description is free text, so a word must be one of these whole, never a prefix ("EARLY" is not EAR). */
const BODY_WORDS = new Set(["BRAIN", "HEAD", "HEADNECK", "NECK", "SKULL", "ORBIT", "SINUS", "CHEST", "THORAX", "LUNG", "LUNGS", "HEART",
  "CARDIAC", "BREAST", "ABDOMEN", "ABD", "LIVER", "KIDNEY", "KIDNEYS", "PANCREAS", "PELVIS", "PROSTATE", "SPINE", "CSPINE", "TSPINE",
  "LSPINE", "KNEE", "SHOULDER", "HIP", "ANKLE", "WRIST", "ELBOW", "HAND", "FOOT", "EXTREMITY"]);
/** THE BODY PART A SCAN SAYS, for regionFromBodyPart, and where it was found: its own Body Part field; else that of
 *  another series of its study (a case's MR scans often leave it empty while its segmentations fill it in:
 *  UPENN-GBM-00020's scans have none, its radiologists' segmentations say BRAIN); else the first whole word of the study's
 *  description that names a body part ("BRAIN^ROUTINE", "CT ABDOMEN AND PELVIS"); else none. */
export function bodyPartOfScan(own: string | null | undefined, ofStudy: readonly (string | null | undefined)[], studyDescription: string | null | undefined): { part: string; from: "scan" | "study" | null } {
  if (own?.trim()) return { part: own.trim(), from: "scan" };
  const kin = ofStudy.find((b) => regionFromBodyPart(b));
  if (kin) return { part: kin.trim(), from: "study" };
  const word = (studyDescription ?? "").toUpperCase().split(/[^A-Z]+/).find((w) => BODY_WORDS.has(w) && regionFromBodyPart(w));
  return word ? { part: word, from: "study" } : { part: "", from: null };
}

/** THE REGION OF THE STRUCTURES ALREADY IN A CASE (a TotalSegmentator result says Chest): the region most of them have,
 *  or null when none has one. */
export function regionFromStructures(names: readonly string[]): ClinicalRegion | null {
  const n = new Map<ClinicalRegion, number>();
  for (const name of names) for (const r of regionsOfStructure(name)) { const c = FROM_REGION.get(r); if (c) n.set(c, (n.get(c) ?? 0) + 1); }
  let best: ClinicalRegion | null = null, most = 0;
  for (const [c, k] of n) if (k > most) { best = c; most = k; }
  return best;
}
