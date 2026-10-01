// WHEN TWO LABELS WEAR ONE NAME: the curation queue, and what was decided about each entry.
//
// Ron, having seen ts:total's `pulmonary_vein` beside ts:lung_vessels' `lung_veins`: "in some
// networks a particular structure is rudimentary. And in a different network it is explored in more
// detail ... There will be more of this. We will need to develop a curation approach."
//
// This is that approach, and it has three parts:
//
//   1. `collisions()` (collisions.ts) finds every pair of labels that would draw the same row. It is
//      computed from the catalogs, so it cannot go stale.
//   2. Every collision needs an entry HERE, saying which of five things is going on.
//   3. relations.test.ts fails when a collision has no entry -- so a new network cannot be added
//      without someone looking at what it collides with. That is the part that means nobody has to
//      remember to do this.
//
// THE FIVE KINDS, which is the whole vocabulary:
//
//   same        Two keys, one concept. One row; whichever label is present fills it.
//               `mandible` | `lower_jawbone` -- one bone, two tasks.
//
//   covers      A coarse label IS the union of finer ones. The coarse label sits ON the structure
//               node and the fine ones become its children -- one row with its own eye, the parts
//               beneath. `femur` | `femur_left` + `femur_right`.
//               Measurement: the parent is NOT the sum of its children; it is the same voxels.
//
//   extent      One continuous structure, cut at different levels by different networks. Neither
//               contains the other and neither is wrong. Two rows, each qualified by the part it
//               actually covers. `pulmonary_vein` (mediastinal) | `lung_veins` (intrapulmonary).
//               Measurement: they abut. Adding them double-counts nothing, but neither is the whole.
//
//   distinct    Different structures wearing one generic name. Rename so the rows differ.
//               `lung_vessels` | `liver_vessels`, both "Blood vessel".
//
//   unpaired    A real left/right pair the source table never marked, though the key says the side.
//               `parotid_gland_left` | `parotid_gland_right`.
//
//   catalogs  The same name in TWO catalogs (TotalSegmentator and FreeSurfer). Already handled:
//               a segment carries its catalog key, so the two resolve apart. Listed so the queue
//               is complete rather than silently filtered.
//
//   todo        Nobody has decided yet. Allowed, and visible.
//
// Generated once from `collisions()` and edited by hand since. Regenerate the list, never the notes.

export type RelationKind = "same" | "covers" | "extent" | "distinct" | "unpaired" | "catalogues" | "todo";

export interface Relation {
  /** The display name they share, as the catalogs spell it. */
  name: string;
  /** The colliding catalog keys. */
  keys: string[];
  kind: RelationKind;
  note?: string;
}

export const RELATIONS: Relation[] = [

  { name: "Dental pulp", keys: ["upper_right_central_incisor_pulp_fdi111", "upper_right_lateral_incisor_pulp_fdi112", "upper_right_canine_pulp_fdi113", "upper_right_first_premolar_pulp_fdi114", "upper_right_second_premolar_pulp_fdi115", "upper_right_first_molar_pulp_fdi116", "upper_right_second_molar_pulp_fdi117", "upper_right_third_molar_pulp_fdi118", "upper_left_central_incisor_pulp_fdi121", "upper_left_lateral_incisor_pulp_fdi122", "upper_left_canine_pulp_fdi123", "upper_left_first_premolar_pulp_fdi124", "upper_left_second_premolar_pulp_fdi125", "upper_left_first_molar_pulp_fdi126", "upper_left_second_molar_pulp_fdi127", "upper_left_third_molar_pulp_fdi128", "lower_left_central_incisor_pulp_fdi131", "lower_left_lateral_incisor_pulp_fdi132", "lower_left_canine_pulp_fdi133", "lower_left_first_premolar_pulp_fdi134", "lower_left_second_premolar_pulp_fdi135", "lower_left_first_molar_pulp_fdi136", "lower_left_second_molar_pulp_fdi137", "lower_left_third_molar_pulp_fdi138", "lower_right_central_incisor_pulp_fdi141", "lower_right_lateral_incisor_pulp_fdi142", "lower_right_canine_pulp_fdi143", "lower_right_first_premolar_pulp_fdi144", "lower_right_second_premolar_pulp_fdi145", "lower_right_first_molar_pulp_fdi146", "lower_right_second_molar_pulp_fdi147", "lower_right_third_molar_pulp_fdi148"], kind: "distinct", note: "32 different teeth, all named 'Dental pulp' \u2014 the tooth is in the FDI number in the key and not in the name" },
  { name: "Blood vessel", keys: ["lung_vessels", "liver_vessels"], kind: "distinct", note: "lung_vessels and liver_vessels are different vessels wearing one generic name" },
  { name: "Brainstem", keys: ["brainstem", "Brain-Stem"], kind: "catalogues", note: "TotalSegmentator's and FreeSurfer's own entries; the catalogue key keeps them apart" },
  { name: "Canine tooth, left", keys: ["upper_left_canine_fdi23", "lower_left_canine_fdi33"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Canine tooth, right", keys: ["upper_right_canine_fdi13", "lower_right_canine_fdi43"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Central incisor tooth, left", keys: ["upper_left_central_incisor_fdi21", "lower_left_central_incisor_fdi31"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Central incisor tooth, right", keys: ["upper_right_central_incisor_fdi11", "lower_right_central_incisor_fdi41"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Cyst", keys: ["kidney_cyst_left", "kidney_cyst_right"], kind: "unpaired", note: "kidney_cyst_left/right: a real pair the source never marked" },
  {
    name: "Effusion",
    keys: ["pleural_effusion", "pericardial_effusion"],
    kind: "distinct",
    // Told apart by the SPACE each is in rather than by a longer name: a finding hangs under its
    // container, so one reads "Pleural cavity / Findings / Effusion" and the other "Pericardium /
    // Pericardial cavity / Findings / Effusion". Ron: "Effusion: handle like a kidney cyst
    // conceptually", and the containers are the serous spaces -- "Pericard, l/r pleura, peritonal
    // cavity" -- each a potential space whose film of fluid lets the organ move without friction.
    note: "pleural and pericardial; each sits under its own serous space, which is what distinguishes them",
  },
  { name: "Fat", keys: ["torso_fat", "intermuscular_fat"], kind: "distinct", note: "torso_fat and intermuscular_fat are different compartments" },
  { name: "First molar tooth, left", keys: ["upper_left_first_molar_fdi26", "lower_left_first_molar_fdi36"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "First molar tooth, right", keys: ["upper_right_first_molar_fdi16", "lower_right_first_molar_fdi46"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "First premolar tooth, left", keys: ["upper_left_first_premolar_fdi24", "lower_left_first_premolar_fdi34"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "First premolar tooth, right", keys: ["upper_right_first_premolar_fdi14", "lower_right_first_premolar_fdi44"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Fourth ventricle", keys: ["fourth_ventricle", "4th-Ventricle"], kind: "catalogues", note: "same" },
  { name: "Implant", keys: ["hip_implant", "implant"], kind: "todo", note: "hip_implant and a generic implant \u2014 same thing at two specificities, or two devices?" },
  { name: "Inferior alveolar nerve, left", keys: ["left_inferior_alveolar_canal", "left_mandibular_incisive_canal_fdi103"], kind: "distinct", note: "the inferior alveolar canal and the mandibular incisive canal are different canals" },
  { name: "Inferior alveolar nerve, right", keys: ["right_inferior_alveolar_canal", "right_mandibular_incisive_canal_fdi104"], kind: "distinct", note: "the inferior alveolar canal and the mandibular incisive canal are different canals" },
  { name: "Lateral incisor tooth, left", keys: ["upper_left_lateral_incisor_fdi22", "lower_left_lateral_incisor_fdi32"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Lateral incisor tooth, right", keys: ["upper_right_lateral_incisor_fdi12", "lower_right_lateral_incisor_fdi42"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Mandible", keys: ["mandible", "lower_jawbone"], kind: "same", note: "mandible and lower_jawbone are one bone from two tasks" },
  { name: "Parotid gland", keys: ["parotid_gland_right", "parotid_gland_left"], kind: "unpaired", note: "the source table gave no laterality; the key does" },
  { name: "Phalanx structure", keys: ["phalanges_feet", "phalanges_hand"], kind: "distinct", note: "hand and foot" },
  { name: "Pulmonary artery", keys: ["pulmonary_artery", "lung_arteries"], kind: "extent", note: "pulmonary_artery is mediastinal, lung_arteries the intrapulmonary tree \u2014 continuous, different extents" },
  { name: "Pulmonary vein", keys: ["pulmonary_vein", "lung_veins"], kind: "extent", note: "pulmonary_vein is mediastinal, lung_veins the intrapulmonary tree" },
  { name: "Quadriceps femoris muscle", keys: ["quadriceps_femoris_left", "quadriceps_femoris_right"], kind: "unpaired", note: "the source table gave no laterality; the key does" },
  { name: "Second molar tooth, left", keys: ["upper_left_second_molar_fdi27", "lower_left_second_molar_fdi37"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Second molar tooth, right", keys: ["upper_right_second_molar_fdi17", "lower_right_second_molar_fdi47"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Second premolar tooth, left", keys: ["upper_left_second_premolar_fdi25", "lower_left_second_premolar_fdi35"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Second premolar tooth, right", keys: ["upper_right_second_premolar_fdi15", "lower_right_second_premolar_fdi45"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Third molar tooth, left", keys: ["upper_left_third_molar_fdi28", "lower_left_third_molar_fdi38"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Third molar tooth, right", keys: ["upper_right_third_molar_fdi18", "lower_right_third_molar_fdi48"], kind: "distinct", note: "upper and lower arch; the name drops which" },
  { name: "Third ventricle", keys: ["third_ventricle", "3rd-Ventricle"], kind: "catalogues", note: "same" },
  { name: "Trachea and bronchus", keys: ["lung_trachea_bronchia", "lung_airways"], kind: "extent", note: "lung_trachea_bronchia and lung_airways cut the same airway at different levels" },
];

/** The recorded verdict for a colliding display name, if there is one. */
export const relationFor = (name: string): Relation | undefined =>
  RELATIONS.find((r) => r.name.toLowerCase() === name.toLowerCase());
