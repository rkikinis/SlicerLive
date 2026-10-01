// Which part of the body a network is about, read off the structures it produces.
//
// haversack's task descriptions carry no body region (checked on all 75 tasks on 2026-09-11:
// modality, structures, weights, engine -- nothing about where). Ron wants to narrow the list by
// region -- "so I can select head, mr or such" -- and said not to wait for an upstream field. Mike
// Halle, 2026-09-12, agreed that a region is not haversack's to assert: it is a property of the
// structure, not of the tool. So the region is looked up here, in two layers:
//
//   1. BY CONCEPT. `concept-regions.csv` gives a region for each SNOMED CT concept in the harmonized
//      mapping (harmonized.json), keyed by code so it holds whichever model wrote the label. Ron
//      curates that file -- "happy to do the curation" -- and it is the one that counts.
//   2. BY NAME. The rules below read the label name, for a structure no concept covers (a
//      FastSurfer label, a hand-drawn segment, a model the mapping does not know).
//
// The regions are coarse on purpose: the ones a person uses to say where a scan is. Each is anchored
// to the part of the body TA2 names (REGION_TA2), so the words here are ours and the concept behind
// each is not. Ron asked whether TA2 could give the region itself; it cannot: TA2 is organized by
// system, not by region, and only 4 of the 215 SNOMED concepts are linked to a TA2 entry on Wikidata
// (P5806 -> P7173, checked 2026-09-12), so the concept -> region step has to be curated.
//
// A structure that runs through several regions (aorta, spine, esophagus) is listed under each;
// a network covering five or more regions is called "Whole body" rather than listing all of them.
import harmonized from "./harmonized.json" with { type: "json" };
import curated from "./concept-regions.json" with { type: "json" };

export const REGIONS = ["Head", "Neck", "Thorax", "Abdomen", "Pelvis", "Spine", "Limbs", "Whole body"] as const;
export type Region = typeof REGIONS[number];

/** The TA2 entry each region word stands for: "Partes corporis humani", TA2 ids from FIPAT. */
export const REGION_TA2: Record<Region, { id: number; term: string }[]> = {
  "Head": [{ id: 98, term: "Caput" }],
  "Neck": [{ id: 123, term: "Collum" }],
  "Thorax": [{ id: 125, term: "Thorax" }],
  "Abdomen": [{ id: 127, term: "Abdomen" }],
  "Pelvis": [{ id: 129, term: "Pelvis" }],
  "Spine": [{ id: 135, term: "Dorsum" }],
  "Limbs": [{ id: 138, term: "Membrum superius" }, { id: 156, term: "Membrum inferius" }],
  "Whole body": [{ id: 96, term: "Corpus humanum" }],
};

/** Rules, in order; the FIRST matching rule wins, so the specific ones come first. */
const RULES: [RegExp, Region[]][] = [
  // whole-body classes first: body_trunc / body_extremities are the body, not the limbs
  // anchored: "body of lateral ventricle" is not the body
  [/^body|torso|subcutaneous|skeletal_muscle|intermuscular|^fat|tissue|skin/i, ["Whole body"]],
  // the spine is a region of its own to a radiologist, whichever level
  [/vertebra|^spine$|spinal_cord|intervertebral|sacrum|autochthon|erector_spinae|transversospinalis/i, ["Spine"]],
  // the heart before the brain: heart_ventricle_left is not a cerebral ventricle
  [/heart|atri|myocard|coronary|cusp|outflow|pericard/i, ["Thorax"]],
  // "bladder" must not claim the gallbladder: that seeded it as Pelvis (Ron: "gallbladder abdomen").
  [/hip_implant|^hip|pelvis|prostate|(?<!gall)bladder|iliac|gluteus|testi/i, ["Pelvis"]],
  // head
  [/brain|cereb|ctx-|ventricle|-vent$|thalam|caudate(?!_lobe)|putamen|pallidum|amygdala|hippocamp|accumbens|ventraldc|choroid|csf|wm-hypo|septum|insul|_lobe$|sulcus|internal_capsule|lentiform|subarachnoid|venous_sinus|hemorrhage|aneurysm/i, ["Head"]],
  [/skull|face|eye|optic|orbit|rectus_muscle|oblique_muscle|levator_palpebrae|jaw|mandib|maxill|teeth|tooth|fdi\d|crown|bridge|implant$|alveolar|lingual_canal|palate|tongue|nasal|sinus|zygomatic|auditory|masseter|pterygoid|temporalis|parotid|submandibular|digastric|styloid|^head$|nasopharynx/i, ["Head"]],
  [/oropharynx|hypopharynx|pharyn|larynx|hyoid|cricoid|thyroid|carotid|jugular|brachiocephalic|subclavian|scalen|sternocleidomastoid|platysma|prevertebral|longus_colli/i, ["Neck"]],
  // thorax
  [/heart|atri|myocard|ventricle_|coronary|cusp|outflow|pericard|pulmonary|lung|pleura|trachea|bronch|airway|mediastin|rib|costal|sternum|thoracic|esophag|breast|pectoralis|serratus|clavic|scapula|trapezius|superior_vena_cava|aorta$|aortic/i, ["Thorax"]],
  // abdomen
  [/liver|kidney|spleen|pancreas|gallbladder|adrenal|stomach|duoden|small_bowel|colon|portal|splenic|inferior_vena_cava|abdominal|psoas|quadratus_lumborum|oblique_left|oblique_right|rectus_abdominis|iliopsoas|latissimus/i, ["Abdomen"]],
  // limbs
  [/femur|tibia|fibula|patella|humerus|radius|ulna|carpal|tarsal|metacarp|metatars|phalang|finger|toes|^legs$|^arms$|lower_limb|upper_limb|thigh|quadriceps|sartorius|deltoid|triceps|biceps|supraspinatus|infraspinatus|subscapularis|teres|coracobrachial/i, ["Limbs"]],
];

/** What the NAME rules alone say; empty when the name says nothing this table knows. */
export function regionsByNameRules(name: string): Region[] {
  for (const [re, r] of RULES) if (re.test(name)) return r;
  return [];
}

const CODE_OF_LABEL = harmonized.structures as Record<string, { code?: string }>;
const REGION_OF_CODE = curated as Record<string, Region[]>;

/** The curated region of the SNOMED concept behind a label, when the label is one the mapping knows. */
export function regionsOfCode(code: string | undefined): Region[] {
  return (code ? REGION_OF_CODE[code] : undefined) ?? [];
}

/** The regions one structure belongs to: by its concept when the mapping knows it, else by its name. */
export function regionsOfStructure(name: string): Region[] {
  const key = name.trim();
  const code = CODE_OF_LABEL[key]?.code ?? CODE_OF_LABEL[key.toLowerCase().replace(/[\s-]+/g, "_")]?.code;
  const byCode = regionsOfCode(code);
  return byCode.length ? byCode : regionsByNameRules(key);
}

/**
 * The regions a network covers, from its structure list. Five or more distinct regions read as
 * "Whole body". `unknown` counts the structures the table could not place, so a caller can say
 * how much of the answer is grounded.
 */
export function regionsOfStructures(structures: readonly string[]): { regions: Region[]; unknown: number } {
  const set = new Set<Region>();
  let unknown = 0;
  for (const s of structures) {
    const r = regionsOfStructure(s);
    if (!r.length) unknown++;
    for (const x of r) set.add(x);
  }
  const bodyOnly = set.size === 1 && set.has("Whole body");
  const named = [...set].filter((r) => r !== "Whole body");
  if (named.length >= 5 || bodyOnly) return { regions: ["Whole body"], unknown };
  return { regions: REGIONS.filter((r) => set.has(r) && r !== "Whole body"), unknown };
}

/** Words that appear in task NAMES and not in structure names. */
const NAME_WORDS: Record<string, Region[]> = {
  dental: ["Head"], digestive: ["Abdomen"], cardiac: ["Thorax"], legs: ["Limbs"], peripheral: ["Limbs"],
  muscles: ["Whole body"], composition: ["Whole body"],
  // FastSurfer's brain task is named as FastSurfer names it -- Mike, 2026-09-12: "fastsurfer:brain
  // is now fastsurfer:asegdkt ... My policy is no aliases." aseg = FreeSurfer's subcortical
  // segmentation, DKT = the Desikan-Killiany-Tourville cortical parcellation; both are the head.
  asegdkt: ["Head"], aseg: ["Head"], dkt: ["Head"],
};

/**
 * For a network with no structure list (MOOSE, MRSegmentator and FastSurfer tasks report none):
 * what its NAME says, and only that. `moose:clin_ct_lungs` is about the lungs; `mrsegmentator:base`
 * says nothing and gets nothing.
 */
export function regionsOfTaskName(task: string): Region[] {
  const tail = task.includes(":") ? task.slice(task.indexOf(":") + 1) : task;
  const words = tail.replace(/^(clin|preclin)_(ct|mr|pt|fdg)_?/, "").replace(/_fdg_|_v\d+$|_old$|_fast$/g, "_");
  const r = new Set<Region>();
  for (const w of words.split(/[_-]+/).filter(Boolean)) {
    for (const x of regionsOfStructure(w)) r.add(x);
    for (const x of NAME_WORDS[w] ?? []) r.add(x);
  }
  if (/\ball\b|body|_all$|total|base$|organs$/.test(words)) r.add("Whole body");
  return REGIONS.filter((x) => r.has(x));
}
