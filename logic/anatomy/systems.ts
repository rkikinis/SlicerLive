// The anatomical SYSTEMS a structure is filed under, and the rules that file it.
//
// Shared by the two catalog generators -- build-totalsegmentator.ts (the TotalSegmentator table
// shipped with the Slicer extension) and build-harmonized.ts (the six-model mapping from the IDC
// segmentation-comparison work) -- so that a label name lands in the same group whichever
// catalog it came from. The rules read the LABEL NAME; the SNOMED meaning beside it is an
// independent signal the generators cross-check against, not something these rules see.
//
// The systems are the standard anatomical ones, named in plain English. Ron asked first for TA2
// and then withdrew it -- "FIPAT is in a decades long civil war. Let's go with snowmed for now" --
// so nothing here claims to be TA2, and the per-structure identifier is SNOMED CT, copied from the
// segmenter's own assertion rather than translated into a vocabulary we would have to guess at.
//
// Two groups name things no anatomical vocabulary does: `Findings` (pleural effusion, hemorrhage,
// lesions -- pathology) and `Devices` (a dental crown or implant). `Body regions` is a third: it
// holds composites of several systems at once, which is not a system.
export const SYSTEMS = [
  "Skeletal system",
  "Muscular system",
  "Cardiovascular system",
  "Respiratory system",
  "Alimentary system",
  "Urinary system",
  "Genital system",
  "Endocrine glands",
  "Nervous system",
  "Sense organs",
  "Lymphoid system",
  "Integument",
  "Body regions",
  "Findings",
  "Devices",
] as const;
export type System = typeof SYSTEMS[number];

/** Ordered rules: first match wins, so a specific pattern must precede a general one. */
export const SYSTEM_RULES: [RegExp, System][] = [
  // Pathology and hardware first. "liver_lesion" is a finding, not the alimentary system, and a
  // dental "crown" or "implant" is not a tooth -- both would be caught by the rules further down.
  [/lesion|effusion|h(a)?emorrhage|tumor|tumour|cyst|infarct|aneurysm|nodule|fracture/, "Findings"],
  [/^(bridge|crown|implant)$/, "Devices"],

  // Dentition groups with the alimentary system, as anatomical convention places it, rather than in a
  // dental category of our own -- but they are matched before the skeletal rule, which would
  // otherwise claim the jaw-bearing names.
  // A canal coded as a nerve is a nerve. TotalSegmentator codes the inferior alveolar and mandibular
  // incisive canals as "Inferior alveolar nerve", and the dentition rule below was claiming them on
  // the word "canal" before the nervous rule could. Ahead of dentition for that reason.
  [/alveolar_canal|incisive_canal/, "Nervous system"],
  [/fdi\d+|incisor|canine|premolar|molar|teeth|pulp|lingual_canal/, "Alimentary system"],

  // MUSCLE BEFORE BONE, because a muscle is routinely named after the bone it attaches to and the
  // skeletal rule would take it first. The segmenter's own codes are what caught this:
  // subscapularis is "Subscapularis muscle" and was filed as skeletal on "scapula", thyrohyoid is
  // "Thyrohyoid muscle" and was filed as skeletal on "hyoid", and sterno_thyroid is
  // "Sternothyroid muscle" and was filed under the ENDOCRINE glands on "thyroid".
  [/gluteus|iliopsoas|autochthon|quadriceps|sartorius|pterygoid|masseter|temporalis|muscle|compartment|deltoid|pectoralis|trapezius|latissimus|digastric|sternocleidomastoid|constrictor|platysma|scalene|thyrohyoid|prevertebral|supraspinatus|infraspinatus|coracobrachial|serratus|teres_|triceps|oblique|erector_spinae|transversospinalis|psoas|quadratus_lumborum|levator_|rectus|subscapularis|sterno_thyroid/, "Muscular system"],
  [/vertebra|rib_|ribs|costal|sternum|clavic|scapula|humerus|ulna|radius|carpal|phalanges|femur|patella|tibia|fibula|tarsal|metatarsal|hip|sacrum|skull|intervertebral_disc|sacroiliac|hyoid|cricoid|zygomatic|styloid|mandible|jawbone|maxilla/, "Skeletal system"],
  // `vessel` belongs here and the segmenter says so: it codes both lung_vessels and liver_vessels
  // as SCT:59820001 "Blood vessel". Without it, `lung_vessels` fell through to the respiratory rule
  // on the word "lung" and `liver_vessels` to the alimentary one on "liver" -- each filed under the
  // organ it runs through rather than the system it is part of. Found because Ron asked whether the
  // lung-vessel network was available, not by any check here: the generator proves COVERAGE (413
  // classified, 0 unclassified) and coverage says nothing about correctness.
  // `venous` is here for exactly one structure and it is the same trap a second time. The DURAL
  // VENOUS SINUSES are veins; the word "sinus" also names the PARANASAL sinuses, which are
  // respiratory. `venous_sinuses` matched neither "vein" nor "vena", fell through to the respiratory
  // rule on "sinus", and arrived in ts:brain_structures filed under the Respiratory system -- a vein
  // in the lungs' branch, on a brain segmentation. Caught by rendering the tree for a task before
  // running it, which is the same way the lung_vessels/liver_vessels bug below was caught: not by
  // any check here. The generator proves COVERAGE, and coverage says nothing about correctness.
  [/heart|atrial|ventricular_outflow|myocardium|aorta|artery|arteries|vein|venous|vena|vessel|brachiocephalic|coronary/, "Cardiovascular system"],
  [/lung|trachea|bronch|pleura|larynx|nasal|paranasal|sinus/, "Respiratory system"],
  // The pharynx and the salivary glands are alimentary, and the naso-/oro-/hypopharynx names
  // would otherwise fall to the respiratory rule above by way of "nasal".
  [/liver|stomach|duodenum|small_bowel|colon|rectum|esophagus|gallbladder|pancreas|bowel|intestine|appendix|cecum|sigmoid|pharyn|palate|tongue|parotid|submandibular|salivary/, "Alimentary system"],
  [/kidney|urinary|bladder|ureter|urethra/, "Urinary system"],
  [/prostate|uterus|ovary|testi|seminal|vagina/, "Genital system"],
  [/thyroid|adrenal|parathyroid|pituitary|thymus/, "Endocrine glands"],
  // "ventricle" is ambiguous and the order resolves it: the cardiac ones are heart_ventricle_left
  // and _right, which the cardiovascular rule above claims by "heart", so every remaining ventricle
  // is a brain ventricle. This also rescues ventricle_body_left/right, which were falling all the
  // way through to "Body regions" on the body_ pattern.
  [/brain|spinal_cord|spinal_chord|nerve|cerebell|white_matter|gr(e|a)y_matter|thalamus|caudate|lentiform|internal_capsule|insular|sulcus|_lobe|septum_pellucidum|subarachnoid|ventricle/, "Nervous system"],
  [/eye|lens|auditory|cochlea|vestibul|olfactory|retina/, "Sense organs"],
  [/spleen|lymph|tonsil/, "Lymphoid system"],
  [/breast|mamma|skin/, "Integument"],
  // Spaces and composites: several systems at once, or none. Last, so nothing specific reaches it.
  // MOOSE's `fingers_left` and `toes_left` are the digits whole -- bone, skin and all -- which is a
  // part of the body, not a bone; SNOMED agrees ("Fingers", "Toes of left foot" are body parts).
  [/body_|torso|subcutaneous|face|neck|head|extremities|cavity|mediastinum|pericardium|fat\b|^fingers|^toes|^legs$|^arms$|^body$/, "Body regions"],
];

/** `vertebrae_L5` → `Vertebra L5`, `kidney_right` → `Kidney, right`. */
export function displayName(label: string, typeMeaning: string, modifier: string): string {
  if (typeMeaning) return modifier ? `${typeMeaning}, ${modifier.toLowerCase()}` : typeMeaning;
  const words = label.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The system a label name files under, or null when no rule claims it. */
export function systemOf(label: string): System | null {
  // MOOSE's clin_ct_body writes `Face`, `Legs` and `arms`; the rules are lower-case.
  const rule = SYSTEM_RULES.find(([re]) => re.test(label.toLowerCase()));
  return rule ? rule[1] : null;
}
