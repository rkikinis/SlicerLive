// The anatomical TREE a segmentation is shown as — TA2's containment, over SNOMED's identity.
//
// Ron, 2026-09-05: "I would like use Albula as the oportunity to do a clean restructuring ...
// The selection and visibility will be in the columns. If I toggle visibility of a parent, it
// affects all children. Branches are collapsible." The model is Mike Halle's Open Anatomy browser:
// a containment tree with columns, not Slicer's flat table.
//
// TWO VOCABULARIES, TWO JOBS, AND THEY DO NOT COMPETE. SNOMED says what a segment IS, taken from the
// segmenter's own assertion (totalsegmentator.json `code`) -- Ron, earlier: "FIPAT is in a decades
// long civil war. Let's go with snowmed for now." TA2 says what CONTAINS what, which SNOMED does not
// give us. So nothing here replaces the SNOMED identifier; this is a layer above it, and TA2 is used
// for its tree SHAPE rather than as an identifier vocabulary we would have to keep in step.
//
// MOST OF THE TREE IS DERIVED, NOT TYPED. Of ts:total's 117 structures, 63 fall into 32 pairs and 2
// are findings, all computed from the segmenter's own coded fields:
//
//   pair     two labels, same type code, differing only in Left/Right   -> one row, two children
//   finding  Category "Morphologically Altered Structure" + a Region     -> hangs under that organ
//
// Only the grouping nodes below are declared by hand, and each one names its TA2 path so the claim
// can be checked rather than trusted.
//
// ONLY WHAT WAS PRODUCED. Ron: "the tree contains only what was produced. We can always add later if
// needed." An empty group is dropped, so a task that segments six structures shows six, not a whole
// atlas with six leaves lit up. Grouping nodes are the exception he confirmed: `Thoracic cage` is a
// container no segmenter emits, and containers are what make the tree worth having.
import { SEGMENTER_STRUCTURES } from "./catalogue.ts";
import { lookupTerm } from "./terminology.ts";
import freesurferTable from "./freesurfer.json" with { type: "json" };
import { OVERRIDES } from "./overrides.ts";

export interface Structure {
  name: string;
  system: string;
  code?: string;
  rgb?: [number, number, number];
  type?: string;
  mod?: string;
  region?: string;
  regionMod?: string;
}

// A JSON import types `rgb` as `number[]` rather than the 3-tuple it is, and a plain cast cannot
// narrow it. Same double cast, and same reason, as segment-naming.ts: the generator is what
// guarantees the shape, and it writes an rgb only when all three channels parsed.
/**
 * Both catalogs, because the tree has to place both.
 *
 * FreeSurfer's structures come from a different vocabulary than TotalSegmentator's, and without them
 * every one of the 95 in a FastSurfer result falls to Unclassified -- which is what "the organization
 * as presented by the freesurfer people" is meant to prevent.
 *
 * The segmenter's own entries come LAST and win, so where the two catalogs use the same key the
 * behavior for an existing result is unchanged. The three DISPLAY names they share -- Brainstem,
 * Third ventricle, Fourth ventricle -- resolve to TotalSegmentator's, which is right for a body
 * result; a brain result reaches the tree already carrying FreeSurfer's own name for everything
 * else, and those are unambiguous.
 */
const RAW = {
  ...((freesurferTable as { structures: unknown }).structures as Record<string, Structure>),
  ...(SEGMENTER_STRUCTURES as Record<string, Structure>),
};

/**
 * The generated table with our corrections applied, so the tree shows what the rest of the
 * application shows.
 *
 * The tree read the RAW table and therefore disagreed with itself: `autochthon_left` came out as
 * "Deep muscle of back" here while every other panel already said "Erector spinae", because that
 * correction lives in overrides.ts and nothing routed through it. Two names for one structure in
 * one application is exactly the confusion this module exists to remove.
 *
 * Corrections are held separately rather than patched into the table because the table is
 * REGENERATED from the segmenter's CSV; a fix made there is undone by the next release.
 */
const VENDORED: Record<string, Structure> = Object.fromEntries(
  Object.entries(RAW).map(([k, s]) => {
    const o = OVERRIDES[k];
    if (!o) return [k, s];
    return [k, {
      ...s,
      ...(o.name ? { name: o.name } : {}),
      ...(o.code ? { code: o.code } : {}),
      // A CLASSIFICATION correction as well as a naming one: "this label is a finding, and it is in
      // that". See overrides.ts -- the hypointensities are the case that needed it.
      ...(o.system ? { system: o.system } : {}),
      ...(o.region ? { region: o.region } : {}),
      ...(o.mod ? { mod: o.mod } : {}),
    }];
  }),
);

/**
 * THE VENDORED TABLES, THEN WHATEVER TERMINOLOGY WAS LOADED AT RUNTIME.
 *
 * A SlicerHeart leaflet, a lab's own term from a color-table CSV: neither is in the tables built at
 * release time, and both have to be placed in the tree -- under their own category when no anatomy
 * rule claims them -- rather than under Unclassified. The twenty reads of `STRUCTURES[label]` in
 * the builder below are unchanged; this view answers them from the vendored map first and from
 * `lookupTerm` second, honoring the terminology context the current tree is being built in.
 */
let treeContext: string | undefined;
const STRUCTURES: Record<string, Structure> = new Proxy(VENDORED, {
  get(target, key) {
    if (typeof key !== "string") return Reflect.get(target, key);
    if (key in target) return target[key];
    const t = lookupTerm(key, treeContext);
    return t ? (t.entry as Structure) : undefined;
  },
  has(target, key) { return typeof key === "string" && (key in target || lookupTerm(key, treeContext) !== null); },
});

export interface AnatomyNode {
  /** Stable within a tree: "g:thoracic-cage", "p:Kidney", "s:liver". */
  id: string;
  name: string;
  /** The TA2 path this node claims to be, for the declared groups. */
  ta2?: string;
  /** The TotalSegmentator label, when this node IS a segment rather than a container. */
  structure?: string;
  /** The scene's label value for this segment, when the tree was built from a segmentation. */
  labelValue?: number;
  /** Its display color, 0-1 or 0-255 as the scene holds it. */
  color?: number[];
  /** Whether it is currently shown. A container has none of its own; it reads its children. */
  visible?: boolean;
  children: AnatomyNode[];
}

/**
 * WHAT TISSUE IS THIS, in a pastel.
 *
 * Ron: "for ts:total look for colors that correspond to the structure: ribs are bone. arteries are
 * red in the body and blue in the lung etc." And: "colors never fully saturated. Pick a pleasant
 * pastel." And: "Urinary: yellowish, but not canary yellow. brain and nerves: ivory with a grayish
 * tint." Small bowel differs from large bowel but stays in the same palette.
 *
 * A color here is INFORMATION, so it is stated rather than computed. The first attempt computed a
 * maximally-spread palette and painted the ribs green, left ribs green and right ribs magenta --
 * distinguishable, and wrong about every one of them.
 *
 * THE SAME COLOR ON BOTH SIDES IS CORRECT. Ron, asked whether left and right should differ: "it's
 * ok to have ribs on both side the same color. It's actually better." So side-qualified groups take
 * their base group's color, and which side you are looking at is read from the row you collapsed --
 * not from a hue that would have had to stop being bone in order to say it.
 *
 * The values were SOLVED, not picked: each seed keeps its hue while saturation and lightness are
 * searched within a pastel band (S <= 0.46, L 0.56-0.90) for the candidate closest to the seed that
 * still clears CIE76 ΔE 10 against every color already placed. Four of the hand-picked seeds were
 * over-saturated and four pairs were indistinguishable -- systemic artery against pulmonary vein is
 * two pastel reds, and there is not much room between them. Closest surviving pair: ΔE 9.9.
 *
 * 0-1, matching how the scene holds segment colors.
 */
const TISSUE_COLOUR: Record<string, [number, number, number]> = {
  // systems
  skeletal: [231 / 255, 222 / 255, 199 / 255],            // bone ivory
  muscular: [179 / 255, 121 / 255, 114 / 255],            // muscle
  nervous: [204 / 255, 204 / 255, 197 / 255],             // "ivory with a grayish tint"
  urinary: [205 / 255, 202 / 255, 138 / 255],             // "yellowish, but not canary yellow"
  genital: [198 / 255, 153 / 255, 191 / 255],
  endocrine: [210 / 255, 171 / 255, 140 / 255],
  lymphoid: [165 / 255, 200 / 255, 167 / 255],
  // The two vascular/airway PARENTS are deliberately muted: each holds children of opposite
  // convention (arteries and veins; pink lung and blue airway), so a parent that committed to one of
  // them would be wrong about the other.
  cardio: [193 / 255, 158 / 255, 165 / 255],
  respiratory: [211 / 255, 217 / 255, 227 / 255],
  unclassified: [169 / 255, 174 / 255, 182 / 255],
  // the organs and vessels that carry their own convention
  liver: [181 / 255, 130 / 255, 105 / 255],
  digestive: [220 / 255, 195 / 255, 166 / 255],
  "small-intestine": [220 / 255, 195 / 255, 166 / 255],
  "large-intestine": [198 / 255, 162 / 255, 109 / 255],   // same palette, told apart
  lungs: [235 / 255, 209 / 255, 212 / 255],
  airways: [174 / 255, 199 / 255, 213 / 255],
  pleura: [201 / 255, 193 / 255, 215 / 255],
  heart: [187 / 255, 135 / 255, 143 / 255],
  pericardium: [202 / 255, 185 / 255, 190 / 255],
  // RED IN THE BODY, BLUE IN THE LUNG -- oxygenation, not vessel wall. The tree already separates
  // these four, so the convention needs no special case, only the right four entries.
  "systemic-arteries": [210 / 255, 146 / 255, 140 / 255],
  "systemic-veins": [142 / 255, 161 / 255, 202 / 255],
  "pulmonary-arteries": [152 / 255, 183 / 255, 213 / 255],
  "pulmonary-veins": [199 / 255, 123 / 255, 135 / 255],
};

interface Group {
  id: string;
  name: string;
  parent?: string;
  ta2: string;
  /**
   * SIDE FIRST inside this group: its sided members hang under a `Left` and a `Right` child rather
   * than each structure holding its own pair.
   *
   * Ron, choosing this over the structure-first shape TA2's own list implies: "Laterality is
   * clinically important. We don't want accidental surgery on the left, when the lesion is on the
   * right. These are scary bloopers expensive both to the patient and the care providers." So where
   * a whole region has a side, the side is the branch you open, and everything under it is on that
   * side -- there is no way to be looking at a left femur while reading a row labeled "Femur".
   *
   * Only for regions that ARE sided. A kidney keeps Left and Right children of its own, because
   * there is no left abdomen to put it in.
   */
  sided?: true;
  /**
   * The word this region contributes to a side's name: "Left arm", not "Left".
   *
   * THE CLINICIAN'S WORD IS THE ONE ON SCREEN and TA2's is in the tooltip. Ron, asked which way
   * round: "I prefer: Left arm on screen; Extracranial bones of head in the tooltip." A name like
   * "Bones of free part of upper limb" is exact and is not what anyone says out loud, and the goal
   * here is "a scaffold that is intuitive for a first time user with medical clinical background".
   * Nothing is lost: `ta2` carries the precise term and is what the row's tooltip shows.
   */
  sideLabel?: string;
}

/**
 * The declared containers. Order here is the order they are shown in.
 *
 * The names and paths are TA2's, read from the TA2 Viewer rather than remembered: `Digestive system`
 * (not "Alimentary system", which is what our own systems table calls it), and `Digestive canal`
 * holding esophagus through anal canal with liver, gallbladder and pancreas as its SIBLINGS.
 *
 * The cardiovascular children are TA2's too, and they are the reason there is no "Arteries / Veins"
 * split here. Artery and vein describe direction relative to the heart, not oxygenation -- the
 * pulmonary vein carries oxygenated blood and the pulmonary artery deoxygenated -- so splitting on
 * artery/vein files the pulmonary vein beside the vena cava, opposite in both circulation and oxygen.
 * TA2 splits on circulation instead: `Pulmonary vessels` (the pulmonary, or lesser, circulation)
 * against `Systemic arteries` / `Systemic veins` (the systemic, or greater, circulation).
 *
 * TA2's own top tier (Human body -> Visceral systems / Integrating systems / Musculoskeletal systems)
 * is deliberately skipped: at this size it is ceremony, and it can be inserted later without
 * remapping anything. Ron: "agreed on skipping the top tier". Likewise no Axial/Appendicular tier
 * inside the skeleton -- asked, and declined.
 */
const GROUPS: Group[] = [
  // ── TA2's Digestive system has EIGHT children and we declared two ────────────────────────────────
  //
  // Ron sent the TA2 page for Liver: Mouth, Fauces, Pharynx, Digestive canal, Liver, Gallbladder,
  // Extrahepatic bile ducts, Pancreas. Liver, gallbladder and pancreas were already right -- what was
  // missing was the head end, so 23 structures sat loose at the system's own level: nine paired tooth
  // types, the palate, the tongue, the salivary glands and the three parts of the pharynx. The
  // hierarchy was curated against the ~117-structure body model; this is the 413-structure one, which
  // segments the head.
  //
  // FAUCES IS NOT DECLARED: TA2 has it, no label lands in it, and an empty branch is a row that only
  // costs a reader something. "As simple as possible and complicated as necessary."
  { id: "mouth", name: "Mouth", parent: "digestive", ta2: "Visceral systems / Digestive system / Mouth" },
  { id: "teeth", name: "Teeth", parent: "mouth", ta2: "… / Mouth / Teeth" },
  // THE ARCH IS PART OF WHICH TOOTH THIS IS. TotalSegmentator gives the upper and lower canine the
  // same `type` ("Canine tooth") and the same `mod`, so without the arch they pooled into one pair
  // with two rows called "Left" and two called "Right", and both left canine pulps attached to the
  // UPPER tooth -- putting the lower tooth's pulp inside the upper one. Ron chose the arch as a
  // BRANCH over folding it into the name: it is TA2's own maxillary/mandibular split and it keeps
  // Teeth to two rows instead of sixteen.
  { id: "teeth-upper", name: "Upper teeth", parent: "teeth", ta2: "… / Teeth / Maxillary dentition" },
  { id: "teeth-lower", name: "Lower teeth", parent: "teeth", ta2: "… / Teeth / Mandibular dentition" },
  { id: "palate", name: "Palate", parent: "mouth", ta2: "… / Mouth / Palate" },
  { id: "salivary-glands", name: "Salivary glands", parent: "mouth", ta2: "… / Mouth / Salivary glands" },
  { id: "pharynx", name: "Pharynx", parent: "digestive", ta2: "Visceral systems / Digestive system / Pharynx" },
  { id: "skeletal", name: "Skeletal system", ta2: "Musculoskeletal systems / Skeletal system" },
  // TA2'S OWN NAMES AND TA2'S OWN NESTING, read from the viewer. Ron: "We should follow TA2 as much
  // as possible. Only deviate when the situation forces it." So "Bones of cranium" rather than
  // "Skull bones", "Thoracic skeleton" rather than "Thoracic cage", and the mandible and the hyoid
  // under "Extracranial bones of head" -- which is where TA2 puts them, beside the cranium and not
  // inside it.
  { id: "cranium", name: "Skull", parent: "skeletal", ta2: "Cranium / Bones of cranium" },
  { id: "extracranial-head", name: "Other bones of the head", parent: "skeletal", ta2: "Extracranial bones of head" },
  { id: "vertebral-column", name: "Spine", parent: "skeletal", ta2: "Vertebral column" },
  // The spine in its four regions, as TA2 lists the vertebrae and as Ron reads a spine (2026-09-22:
  // "cervical, thoracal, lumbar and sacral"). The sacrum is a bone of its own with S1 under it, so
  // it stands for the sacral region rather than sitting inside one more container.
  { id: "cervical-vertebrae", name: "Cervical vertebrae", parent: "vertebral-column", ta2: "Vertebral column / Cervical vertebrae [C I–C VII]" },
  { id: "thoracic-vertebrae", name: "Thoracic vertebrae", parent: "vertebral-column", ta2: "Vertebral column / Thoracic vertebrae [T I–T XII]" },
  { id: "lumbar-vertebrae", name: "Lumbar vertebrae", parent: "vertebral-column", ta2: "Vertebral column / Lumbar vertebrae [L I–L V]" },
  { id: "thoracic-cage", name: "Rib cage", parent: "skeletal", ta2: "Thoracic skeleton" },
  { id: "ribs", name: "Ribs", parent: "thoracic-cage", ta2: "… / Thoracic skeleton / Ribs" },
  { id: "ribs-left", name: "Left ribs", parent: "ribs", ta2: "… / Ribs" },
  { id: "ribs-right", name: "Right ribs", parent: "ribs", ta2: "… / Ribs" },
  { id: "upper-limb", name: "Arm", parent: "skeletal", ta2: "Bones of upper limb", sided: true, sideLabel: "arm" },
  { id: "shoulder-girdle", name: "Shoulder", parent: "upper-limb", ta2: "Bones of pectoral girdle" },
  { id: "pelvis", name: "Pelvis", parent: "skeletal", ta2: "Bony pelvis" },
  { id: "pelvic-girdle", name: "Pelvic bones", parent: "pelvis", ta2: "Bones of pelvic girdle" },
  { id: "bones-of-hand", name: "Hand", parent: "upper-limb", ta2: "Bones of hand" },
  { id: "lower-limb", name: "Leg", parent: "skeletal", ta2: "Bones of lower limb", sided: true, sideLabel: "leg" },
  { id: "bones-of-foot", name: "Foot", parent: "lower-limb", ta2: "Bones of foot" },

  // THE WHOLE MUSCULAR SYSTEM IS SIDED, once, at the top -- like the cerebrum, not like the ribs.
  // Ron, 2026-09-21, shown three shapes for ts:abdominal_muscles (a Left/Right split inside each of
  // its four groups, as it was; one split at the top; one row per muscle with the sides under it):
  // "hierarchy: left right should be handled like in the brain" -- "A looks right". So Left and
  // Right are the two branches under the system, and the back / abdomen / chest / leg groups are
  // repeated under each; collapsing "Left" colors every left muscle as one thing.
  { id: "muscular", name: "Muscular system", ta2: "Musculoskeletal systems / Muscular system", sided: true },
  // TA2's OWN MUSCLE TREE, read from Ron's screenshots of the viewer. His standing rule: "When in
  // doubt follow TA2 for anatomy."
  //
  // It settles the two placements a functional reading makes contestable. The latissimus dorsi
  // MOVES THE ARM and TA2 files it with the back -- "Dorsal part of muscular system / Hypaxial
  // muscles of back", beside trapezius, the rhomboids and levator scapulae. And the psoas major
  // moves the femur: TA2 puts it in the LOWER LIMB, inside an Iliopsoas parent that also holds the
  // iliacus and psoas minor.
  //
  // That last one matters beyond the muscle. Ron: "its a conflation of two muscles. You could look
  // at it as a coarse label which will be refined ... by a different algorithm." TA2 already
  // declares the containment we invented `covers` for: iliopsoas IS the parent of the psoas major.
  // ts:total's `iliopsoas` and ts:abdominal_muscles' `psoas_major` therefore nest by the standard's
  // own hierarchy rather than by a rule of ours, and the iliacus is visible as the child nothing
  // produces.
  { id: "muscles-back", name: "Muscles of the back", parent: "muscular", ta2: "Dorsal part of muscular system" },
  { id: "hypaxial-back", name: "Hypaxial muscles", parent: "muscles-back", ta2: "… / Hypaxial muscles of back" },
  { id: "epaxial", name: "Epaxial muscles", parent: "muscles-back", ta2: "… / Epaxial muscles" },
  { id: "muscles-abdomen", name: "Muscles of the abdomen", parent: "muscular", ta2: "… / Muscles of abdomen" },
  { id: "muscles-thorax", name: "Muscles of the chest", parent: "muscular", ta2: "… / Muscles of thorax" },
  { id: "muscles-lower-limb", name: "Muscles of the leg", parent: "muscular", ta2: "Muscular system of lower limb / Muscles of lower limb" },
  { id: "iliopsoas", name: "Iliopsoas muscle", parent: "muscles-lower-limb", ta2: "… / Muscles of lower limb / Iliopsoas muscle" },
  { id: "gluteal", name: "Superficial gluteal muscles", parent: "muscles-lower-limb", ta2: "… / Muscles of lower limb / Superficial gluteal muscles" },

  { id: "digestive", name: "Digestive system", ta2: "Visceral systems / Digestive system" },
  { id: "peritoneum", name: "Peritoneum", parent: "digestive", ta2: "… / Digestive system / Peritoneum" },
  { id: "peritoneal-cavity", name: "Peritoneal cavity", parent: "peritoneum", ta2: "… / Peritoneum / Peritoneal cavity" },
  { id: "digestive-canal", name: "Digestive canal", parent: "digestive", ta2: "… / Digestive canal" },
  // TA2 puts the duodenum inside the small intestine (with jejunum and ileum) and the colon inside
  // the large intestine (with caecum and rectum); the segmenter emits them as siblings, so without
  // these two containers the tree flattened a level TA2 actually has.
  //
  // A CAVEAT WORTH KNOWING: these parents are containers, not sums. TotalSegmentator's `small_bowel`
  // EXCLUDES the duodenum — they are disjoint labels — so "Small intestine" here holds two regions
  // that together approximate it, rather than one region containing another. Visibility still
  // propagates correctly; what does not follow is that a parent's voxels include its children's.
  { id: "small-intestine", name: "Small intestine", parent: "digestive-canal", ta2: "… / Digestive canal / Small intestine" },
  { id: "large-intestine", name: "Large intestine", parent: "digestive-canal", ta2: "… / Digestive canal / Large intestine" },
  // The liver is a container as well as a structure. ts:liver_segments returns the eight Couinaud
  // segments and ts:liver_vessels its vessels and lesions; without this they land as SIBLINGS of
  // the liver, which is how Ron met them -- eight segments in a flat list, "They are all the same
  // color." When `liver` itself is in the run it becomes this node; when it is not, the container
  // still gathers what was produced.
  { id: "liver", name: "Liver", parent: "digestive", ta2: "Visceral systems / Digestive system / Liver" },

  { id: "respiratory", name: "Respiratory system", ta2: "Visceral systems / Respiratory system" },
  { id: "pleura", name: "Pleura", parent: "respiratory", ta2: "… / Respiratory system / Pleura" },
  // One node until a segmenter distinguishes the sides. Ron: "l/r pleura" -- there are two pleural
  // cavities, and `pleural_effusion` is one label that does not say which, so saying it for the
  // segmenter would be an invention. `sided` is set, so the day a task splits them the sides appear.
  { id: "pleural-cavity", name: "Pleural cavity", parent: "pleura", ta2: "… / Pleura / Pleural cavity", sided: true, sideLabel: "pleural cavity" },
  { id: "lungs", name: "Lungs", parent: "respiratory", ta2: "… / Respiratory system / Lung" },
  { id: "lung-right", name: "Right lung", parent: "lungs", ta2: "… / Lung" },
  { id: "lung-left", name: "Left lung", parent: "lungs", ta2: "… / Lung" },

  { id: "cardio", name: "Cardiovascular system", ta2: "Integrating systems / Cardiovascular system" },
  { id: "heart", name: "Heart", parent: "cardio", ta2: "… / Cardiovascular system / Heart" },
  // THE SEROUS SPACES, so a finding in one has somewhere to be. Ron: "Effusion: handle like a kidney
  // cyst conceptually. The pericardial cavity is a potential space between the opposing layers of the
  // serous pericardium's parietal and visceral layer ... You have the following spaces of this kind
  // in the Torso: Pericard, l/r pleura, peritonal cavity."
  //
  // A cyst hangs under the kidney it is in; an effusion hangs under the space it is in, and that
  // space is a potential one -- normally a film of fluid that lets the organ move without friction.
  // TA2 puts each with its membrane: the pericardial cavity inside the pericardium at the heart, the
  // pleural cavity inside the pleura, the peritoneal cavity inside the peritoneum. Created on demand
  // like every other group, so a space nothing was found in never appears.
  { id: "pericardium", name: "Pericardium", parent: "heart", ta2: "… / Heart / Pericardium" },
  { id: "pericardial-cavity", name: "Pericardial cavity", parent: "pericardium", ta2: "… / Pericardium / Pericardial cavity" },
  { id: "pulmonary-vessels", name: "Pulmonary vessels", parent: "cardio", ta2: "… / Pulmonary vessels" },
  { id: "pulmonary-veins", name: "Pulmonary veins", parent: "pulmonary-vessels", ta2: "… / Pulmonary vessels / Pulmonary veins" },
  { id: "pulmonary-arteries", name: "Pulmonary arteries", parent: "pulmonary-vessels", ta2: "… / Pulmonary vessels / Pulmonary arteries" },
  { id: "systemic-arteries", name: "Systemic arteries", parent: "cardio", ta2: "… / Systemic arteries" },
  { id: "systemic-veins", name: "Systemic veins", parent: "cardio", ta2: "… / Systemic veins" },

  { id: "urinary", name: "Urinary system", ta2: "Visceral systems / Urinary system" },
  { id: "genital", name: "Genital system", ta2: "Visceral systems / Genital systems" },
  { id: "endocrine", name: "Endocrine glands", ta2: "Integrating systems / Endocrine glands" },
  { id: "nervous", name: "Nervous system", ta2: "Integrating systems / Nervous system" },
  { id: "lymphoid", name: "Lymphoid organs", ta2: "Integrating systems / Lymphoid organs" },

  // THE BRAIN, ORGANIZED THE WAY FREESURFER ORGANIZES IT.
  //
  // The rest of this table is TA2's, read from the TA2 Viewer. This subtree is not, and saying so
  // matters: Ron asked for "the colors and organization as presented by the freesurfer people", and
  // what a FreeSurfer result actually divides the brain into is the aseg structures plus the
  // Desikan-Killiany cortical parcellation, grouped by lobe. TA2 does have Frontal/Parietal/Temporal/
  // Occipital lobe, so those names agree; the arrangement below is FreeSurfer's. It hangs under
  // TA2's Nervous system so a brain result and a body result still share one tree.
  // TA2 puts Brain and the Meninges side by side inside the CENTRAL nervous system, along with gray
  // matter, white matter, reticular formation, ependyma and the spinal cord. Read from Ron's TA2
  // Viewer shot. The level matters here: the meninges are not in the brain, they are its neighbor.
  //
  // "Nervous system" stays the system key rather than being re-pointed at this, because a segmenter
  // files the optic and inferior alveolar nerves there too, and those are peripheral.
  { id: "cns", name: "Central nervous system", parent: "nervous", ta2: "… / Nervous system / Central nervous system" },
  { id: "brain", name: "Brain", parent: "cns", ta2: "… / Central nervous system / Brain" },
  // THE CEREBRUM IS SIDED, so the hemisphere is the branch you open. Ron: "Brain: Side first, like
  // in the limb", and the reason is the one he gave for the limbs -- a left temporal lesion is not a
  // right one, and an interface that makes you read a modifier to find out is an interface that will
  // eventually be misread.
  { id: "cerebrum", name: "Cerebrum", parent: "brain", ta2: "… / Brain / Cerebrum", sided: true, sideLabel: "hemisphere" },
  { id: "cerebral-cortex", name: "Cerebral cortex", parent: "cerebrum", ta2: "… / Cerebrum / Cerebral cortex" },
  { id: "frontal-lobe", name: "Frontal lobe", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Frontal lobe" },
  { id: "parietal-lobe", name: "Parietal lobe", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Parietal lobe" },
  { id: "temporal-lobe", name: "Temporal lobe", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Temporal lobe" },
  { id: "occipital-lobe", name: "Occipital lobe", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Occipital lobe" },
  { id: "cingulate", name: "Cingulate cortex", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Cingulate gyrus" },
  { id: "insula", name: "Insula", parent: "cerebral-cortex", ta2: "… / Cerebral cortex / Insula" },
  { id: "cerebral-wm", name: "Cerebral white matter", parent: "cerebrum", ta2: "… / Cerebrum / Cerebral white matter" },
  { id: "subcortical-grey", name: "Subcortical gray matter", parent: "cerebrum", ta2: "… / Cerebrum" },
  // THE DIENCEPHALON, which the thalamus and the ventral diencephalon belong to. They had been
  // filed with the basal ganglia under Subcortical gray matter, which is where FreeSurfer's own
  // `system` column puts them and is wrong: the caudate, putamen, pallidum and accumbens are
  // telencephalic, the thalamus is not. Ron: "You left out the midbrain and the diencephalon."
  // Sided, like the cerebrum -- there is a left and a right thalamus and it matters which.
  { id: "diencephalon", name: "Diencephalon", parent: "brain", ta2: "… / Brain / Diencephalon", sided: true },
  { id: "ventricles", name: "Ventricular system", parent: "brain", ta2: "… / Brain / Ventricular system" },
  { id: "cerebellum", name: "Cerebellum", parent: "brain", ta2: "… / Brain / Cerebellum", sided: true, sideLabel: "cerebellar hemisphere" },
  { id: "brainstem", name: "Brainstem", parent: "brain", ta2: "… / Brain / Brainstem" },
  // MIDBRAIN, PONS AND MEDULLA are declared and dormant: FreeSurfer emits one `Brain-Stem` label and
  // TotalSegmentator one `brainstem`, so neither group appears today. They exist so that the day a
  // segmenter distinguishes them -- and Ron's point is that the midbrain is one structure "but
  // contains many l/r structures such as red nucleus, substantia nigra and many more" -- those
  // structures have somewhere to land instead of arriving loose.
  { id: "midbrain", name: "Midbrain", parent: "brainstem", ta2: "… / Brainstem / Midbrain" },
  { id: "pons", name: "Pons", parent: "brainstem", ta2: "… / Brainstem / Pons" },
  { id: "medulla", name: "Medulla oblongata", parent: "brainstem", ta2: "… / Brainstem / Medulla oblongata" },
  { id: "brain-other", name: "Other brain structures", parent: "brain", ta2: "… / Brain" },

  // THE MENINGES, and the choroid plexus with them. Read from Ron's TA2 Viewer screenshot rather
  // than remembered: Meninges / Leptomeninges / Pia / Cranial pia holds Tenia choroidea, Tela
  // choroidea and Choroid plexus as siblings. Ron: "The choroid plexus is not ventricle. See
  // attached TA2 shot." He is right and I had it wrong -- the plexus is tela choroidea, which is
  // pia, invaginated into the cavity and covered by ependyma. It lies IN the ventricle without
  // being part of it, the way a hand in a pocket is not part of the coat.
  //
  // Beside the brain rather than inside it: the meninges surround the brain, they are not of it.
  // THE WALLS OF THE LATERAL VENTRICLE are not the ventricle. Read from Ron's TA2 Viewer shot:
  // Walls of lateral ventricle holds Septum pellucidum (with its cave and laminae), Lamina affixa,
  // Choroid fissure, Tenia of fornix, Choroid plexus of lateral ventricle, Pes hippocampi and the
  // rest -- the structures that BOUND the cavity, listed apart from the cavity itself.
  //
  // That distinction is what gives the cave of the septum a proper home. It had been sitting in
  // "Other brain structures", which was a confession rather than a placement.
  { id: "ventricle-walls", name: "Walls of lateral ventricle", parent: "brain", ta2: "… / Telencephalon / Walls of lateral ventricle" },
  { id: "septum-pellucidum", name: "Septum pellucidum", parent: "ventricle-walls", ta2: "… / Walls of lateral ventricle / Septum pellucidum" },

  { id: "meninges", name: "Meninges", parent: "cns", ta2: "… / Central nervous system / Meninges" },
  { id: "leptomeninges", name: "Leptomeninges", parent: "meninges", ta2: "… / Meninges / Leptomeninges" },
  // The arachnoid holds the subarachnoid space and the fluid in it. Ron, on this branch: "Its kind
  // of like a system" -- and it is one, which is exactly why it is awkward to file. Cerebrospinal
  // fluid is made by the choroid plexus (in the walls of the lateral ventricle), fills the
  // ventricular system, leaves it into the subarachnoid space, and is resorbed through the arachnoid
  // granulations. Four homes in this tree for one circulating fluid. TA2 files the fluid itself under
  // the arachnoid, so that is where it goes -- but nothing about containment can say that those four
  // belong together, which is the argument for facets in one substance.
  { id: "arachnoid", name: "Arachnoid", parent: "leptomeninges", ta2: "… / Leptomeninges / Arachnoid" },
  { id: "pia", name: "Pia", parent: "leptomeninges", ta2: "… / Leptomeninges / Pia" },
  { id: "cranial-pia", name: "Cranial pia", parent: "pia", ta2: "… / Pia / Cranial pia" },

  { id: "airways", name: "Airways", parent: "respiratory", ta2: "… / Respiratory system" },
  // Last, always: structures from a vocabulary this table does not know. Named so it is
  // obvious they are unplaced rather than misplaced.
  { id: "unclassified", name: "Unclassified", ta2: "—" },
];

/**
 * The color a group is painted when it is collapsed.
 *
 * TWO POLICIES, because the two catalogs mean different things by a color.
 *
 *   TISSUE (the default, and what ts:total gets): the nearest declared tissue, inherited down the
 *   tree. A rib group is bone because it is bone; both sides are bone; and a group with nothing
 *   declared above it falls back to its system. Color is information here.
 *
 *   ARBITRARY (FreeSurfer): Ron -- "Fressurfer: the colors are arbitrary so we can pick an arbitrary
 *   color." Every FreeSurfer structure is nervous tissue, so the tissue policy would paint every
 *   collapsed group the same ivory-gray and tell you nothing. Since the colors carry no meaning
 *   there, they are chosen to be maximally TELLABLE instead: each group takes the candidate furthest
 *   from every color already assigned. Measured in hierarchy-colours.test.ts.
 */
// The hue/lightness helpers the per-run spread needs, captured out of the block below.
let spreadTools: {
  toHsl: (c: [number, number, number]) => [number, number, number];
  toRgb: (c: [number, number, number]) => [number, number, number];
  dist: (a: [number, number, number], b: [number, number, number]) => number;
};

const TISSUE_OF = new Map<string, [number, number, number]>();
{
  // rgb <-> hsl on 0-1, local because nothing else here needs them.
  const toHsl = (c: [number, number, number]): [number, number, number] => {
    const mx = Math.max(...c), mn = Math.min(...c), l = (mx + mn) / 2, d = mx - mn;
    if (d === 0) return [0, 0, l];
    const sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === c[0] ? ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
    return [h / 6, sat, l];
  };
  const toRgb = ([h, sat, l]: [number, number, number]): [number, number, number] => {
    if (sat === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    const k = (t: number) => {
      let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return [k(h + 1 / 3), k(h), k(h - 1 / 3)];
  };
  /** CIE76 on 0-1. Inlined rather than imported, so this module stays free of a color dependency. */
  const dist = (a: [number, number, number], b: [number, number, number]) => {
    const f = (c: [number, number, number]) => {
      const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
      const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
      const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
      const g = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
      return [116 * g(Y) - 16, 500 * (g(X) - g(Y)), 200 * (g(Y) - g(Z))];
    };
    const [l1, a1, b1] = f(a), [l2, a2, b2] = f(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };
  const byId = new Map(GROUPS.map((g) => [g.id, g]));
  const systemOf = (id: string): string => {
    let g = byId.get(id);
    while (g?.parent) g = byId.get(g.parent);
    return g?.id ?? "unclassified";
  };
  // TISSUE: the nearest declared ancestor, else the system, else unclassified.
  for (const g of GROUPS) {
    let cur: string | undefined = g.id, found: [number, number, number] | undefined;
    while (cur) {
      const t = TISSUE_COLOUR[cur];
      if (t) { found = t; break; }
      cur = byId.get(cur)?.parent;
    }
    TISSUE_OF.set(g.id, found ?? TISSUE_COLOUR[systemOf(g.id)] ?? TISSUE_COLOUR.unclassified);
  }
  // ARBITRARY is computed PER RUN (below), not here: spreading all 81 groups across a pastel band
  // leaves no room, and crowds whichever groups happen to come last in GROUPS -- which was the
  // meninges, so FreeSurfer got the worst of it. Only the groups one segmentation actually shows
  // have to be tellable apart, and there are far fewer of those.
  spreadTools = { toHsl, toRgb, dist };
}

/**
 * A maximally-tellable color for each of THESE groups, seeded from their tissue colors.
 *
 * For a catalog whose colors carry no meaning -- Ron, on FreeSurfer: "the colors are arbitrary so
 * we can pick an arbitrary color." Every FreeSurfer structure is nervous tissue, so the tissue policy
 * would paint every collapsed group the same ivory-gray and say nothing.
 *
 * Per run, because that is the only set that has to be mutually distinguishable: a pastel band does
 * not hold 81 colors 9 ΔE apart, and no single segmentation shows 81 groups. Deterministic in the
 * order given, so the same run always gets the same palette.
 */
export function arbitraryGroupColours(ids: readonly string[]): Map<string, [number, number, number]> {
  const { toHsl, toRgb, dist } = spreadTools;
  const out = new Map<string, [number, number, number]>();
  const assigned: [number, number, number][] = [];
  for (const raw of ids) {
    const id = (raw.startsWith("g:") ? raw.slice(2) : raw).split("@")[0];
    if (out.has(id)) continue;
    const base = TISSUE_OF.get(id) ?? TISSUE_COLOUR.unclassified;
    const [h0, s0, l0] = toHsl(base);
    let best = base, bestGap = -1;
    for (let step = 0; step < 96; step++) {
      const off = ((step % 2 ? -1 : 1) * Math.ceil(step / 2)) / 96;
      for (const dl of [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3]) {
        for (const ds of [0, 0.12, -0.12]) {
          const c = toRgb([
            (h0 + off + 1) % 1,
            Math.min(0.46, Math.max(0.08, s0 + ds)),
            Math.min(0.9, Math.max(0.56, l0 + dl)),
          ]);
          let gap = Infinity;
          for (const a of assigned) gap = Math.min(gap, dist(c, a));
          if (gap > bestGap) { bestGap = gap; best = c; }
        }
      }
      if (bestGap > 16) break;
    }
    out.set(id, best);
    assigned.push(best);
  }
  return out;
}

/**
 * The color for a group id, by TISSUE. 0-1, as the scene holds colors.
 *
 * Accepts the tree's own ids: `g:<group>`, a side-qualified `g:<group>@left`, and the synthesised
 * pair containers. A side qualifier is STRIPPED rather than varied -- both sides of a region are the
 * same color on purpose.
 *
 * For a catalog whose colors carry no meaning, use `arbitraryGroupColours` instead.
 */
export function groupColour(id: string): [number, number, number] | undefined {
  const bare = (id.startsWith("g:") ? id.slice(2) : id).split("@")[0];
  return TISSUE_OF.get(bare);
}

/** Every group id, for the color-spread test. */
export function allGroupIds(): string[] {
  return GROUPS.map((g) => g.id);
}


/**
 * Where each label goes. First match wins, so the specific patterns lead.
 *
 * A label not matched here falls back to its `system` in totalsegmentator.json, which is why this
 * list is short: it only has to say the things a system name cannot.
 */
const PLACE: [RegExp, string][] = [
  // The inferior (temporal) horn is PART OF its side's lateral ventricle, not a fifth cavity beside
  // it. Ron's components are "left and right lateral ventricle, third ventricle, aqueduct and fourth
  // ventricle" -- the horn is not among them because it is inside one of them, the way a Couinaud
  // segment is inside the liver rather than beside it.
  [/^(Left|Right)-(Thalamus|VentralDC)/, "diencephalon"],
  [/^(thalamus)$/, "diencephalon"],
  [/^Left-Inf-Lat-Vent$/, "s:Left-Lateral-Ventricle"],
  [/^Right-Inf-Lat-Vent$/, "s:Right-Lateral-Ventricle"],
  // Both spellings: TotalSegmentator writes `vertebrae_C4`, MOOSE `vertebra_C4`, and a segment that
  // arrives by its readable name ("C4 vertebra", as a SEG read back from the database does) can
  // resolve to either key. The vertebra is the same; its place in the tree must be too.
  [/^vertebrae?_S\d/, "s:sacrum"], // TA2: the sacrum's children are S1–S5, so S1 hangs under it
  [/^sacrum$/, "vertebral-column"],
  [/^vertebrae?_C\d/, "cervical-vertebrae"],
  [/^vertebrae?_T\d/, "thoracic-vertebrae"],
  [/^vertebrae?_L\d/, "lumbar-vertebrae"],
  [/^vertebrae?_/, "vertebral-column"],
  [/^rib_left_/, "ribs-left"],
  [/^rib_right_/, "ribs-right"],
  [/^(sternum|costal_cartilages)$/, "thoracic-cage"],
  [/^(clavicula|clavicle|scapula)_/, "shoulder-girdle"], // `clavicle_left` is the same bone under another model's key -- and what "Clavicle, left" resolves to by name
  // BOTH FORMS OF EVERY LIMB BONE. TotalSegmentator emits `femur_left`/`femur_right` from one task
  // and a bilateral `femur` from another, and the sided rules matched only the first -- so the
  // bilateral labels fell through to the system root and the limb branch was missing half its bones.
  // The unsided ones stay at the limb's own level: a single label covering both tibiae cannot be
  // filed under a side without claiming a side the segmentation never said.
  [/^humerus(_|$)/, "upper-limb"],
  [/^(radius|ulna)$/, "upper-limb"],
  [/^(carpal|metacarpal|phalanges_hand)$/, "bones-of-hand"],
  [/^hip_/, "pelvic-girdle"],
  [/^(femur|patella|tibia|fibula)(_|$)/, "lower-limb"],
  [/^(tarsal|metatarsal|phalanges_feet)$/, "bones-of-foot"],
  // The head, where TA2 draws the line between the cranium and what sits outside it: the mandible
  // and the hyoid are "Extracranial bones of head", not cranial bones.
  [/^skull$/, "cranium"],
  [/^(upper_jawbone|zygomatic_arch_|styloid_process_)/, "cranium"],
  [/^(mandible|lower_jawbone|hyoid)$/, "extracranial-head"],
  [/^gluteus_/, "gluteal"],
  // The muscles, by TA2's own filing. `autochthon` is TotalSegmentator's name for the deep muscles
  // of the back, which are the epaxial ones.
  [/^(trapezius|latissimus_dorsi|rhomboid|levator_scapulae|serratus_posterior)/, "hypaxial-back"],
  [/^(autochthon|erector_spinae|transversospinalis)/, "epaxial"],
  [/^(rectus_abdominis|external_oblique|internal_oblique|transversus_abdominis|quadratus_lumborum)/, "muscles-abdomen"],
  [/^(pectoralis|serratus_anterior|intercostal)/, "muscles-thorax"],
  [/^iliopsoas_/, "iliopsoas"],
  [/^(psoas_major|psoas_minor|iliacus)_/, "iliopsoas"],
  [/^(quadriceps_femoris|sartorius|thigh_medial_compartment|thigh_posterior_compartment)/, "muscles-lower-limb"],
  [/^lung_(upper|middle|lower)_lobe_left$/, "lung-left"],
  [/^lung_(upper|middle|lower)_lobe_right$/, "lung-right"],
  // The whole-lung labels belong in their side's branch, beside that side's lobes. They used to match
  // nothing, fall to the system root and be auto-paired into a SECOND "Lung" row sitting next to the
  // declared Lungs branch -- the same anatomy twice.
  [/^lung_left$/, "lung-left"],
  [/^lung_right$/, "lung-right"],
  [/^(trachea|lung_airways)/, "airways"],
  // THE WHOLE-LUNG LABELS BELONG WITH THEIR LOBES. `lung_left`/`lung_right` matched nothing, fell to
  // the system root, and were then auto-paired into a second "Lung" row sitting beside the declared
  // Lungs branch -- the same anatomy twice, which is exactly what the tree is for preventing.
  [/^lung$/, "lungs"],
  // ── the mouth and the pharynx (TA2's own filing) ──
  // FDI-numbered teeth, plus TotalSegmentator's two bulk labels for the whole upper and lower rows.
  // NOT the pulps: `_pulp_` keys are FINDINGS and hang under their own tooth. Matching them here gave
  // them a placement rule, which moved them out of the findings path -- 16 rows reading "Dental pulp"
  // loose in the arch branch, and the teeth themselves gone.
  [/^upper_(?!.*_pulp_).*_fdi\d+$/, "teeth-upper"],
  [/^lower_(?!.*_pulp_).*_fdi\d+$/, "teeth-lower"],
  [/^teeth_upper$/, "teeth-upper"],
  [/^teeth_lower$/, "teeth-lower"],
  [/^(hard|soft)_palate$/, "palate"],
  [/^(parotid|submandibular|sublingual)_gland/, "salivary-glands"],
  [/^tongue$/, "mouth"],
  [/^(naso|oro|hypo)pharynx$/, "pharynx"],
  [/^pharynx$/, "pharynx"],
  // BOTH SIDES OF THE PULMONARY CIRCULATION, from both tasks that produce it. `pulmonary_vein` was
  // listed and `pulmonary_artery` was not, so the vein nested under Pulmonary vessels and the artery
  // sat loose at the bottom of the cardiovascular system -- the two halves of one circulation, filed
  // apart, in a result whose whole point is showing them together. Ron: "the segmentations
  // organization has not been updated."
  [/^(lung_arteries|pulmonary_artery)$/, "pulmonary-arteries"],
  [/^(lung_veins|pulmonary_vein)$/, "pulmonary-veins"],
  // ts:lung_vessels' own label covers the lung vasculature without distinguishing artery from vein,
  // so it belongs at the level where that distinction has not yet been made -- above both, not beside
  // the aorta.
  [/^lung_vessels$/, "pulmonary-vessels"],
  // "Trachea and bronchus" is an airway, and it was sitting at the top of the respiratory system
  // next to Airways -- which already holds the trachea, so the same tube appeared twice at two
  // different depths.
  [/^lung_trachea_bronchia$/, "airways"],
  [/^(duodenum|small_bowel)$/, "small-intestine"],
  [/^colon$/, "large-intestine"],
  [/^(esophagus|stomach)$/, "digestive-canal"],
  [/^liver(_segment_\d+)?$/, "liver"],
  [/^(gallbladder|pancreas)$/, "digestive"],
  [/^(heart|atrial_appendage)/, "heart"],
  [/^pericardium$/, "pericardium"],
  // EVERY systemic vessel, not the handful that happened to be listed. The four added here --
  // internal carotid, internal jugular, the coronary arteries and the dural venous sinuses -- fell
  // through to `cardio`, the deliberately muted parent that holds children of opposite convention.
  // So collapsing their branch produced that neutral mauve rather than a red or a blue, which is the
  // one case Ron's "identical only when the hierarchy collapses" is actually about.
  [/^(aorta|brachiocephalic_trunk|common_carotid_artery|internal_carotid_artery|subclavian_artery|iliac_artery|coronary_arteries)/, "systemic-arteries"],
  [/^(superior_vena_cava|inferior_vena_cava|brachiocephalic_vein|iliac_vena|portal_vein|portal_splenic_vein|internal_jugular_vein|venous_sinuses)/, "systemic-veins"],
];

/**
 * A finer label nests under a COARSER one, when the coarse one is in the same result.
 *
 * Ron: "in some networks a particular structure is rudimentary. And in a different network it is
 * explored in more detail ... We need to develop and document a generalized frame work on how to
 * handle this consistently."
 *
 * This is that framework's one moving part in the tree. TotalSegmentator's `autochthon` is the
 * intrinsic (autochthonous, TA2's epaxial) back muscles AS A GROUP; ts:abdominal_muscles segments
 * two of its layers separately. Where both are loaded the fine ones belong INSIDE the coarse one --
 * a container and its contents, not siblings. Where only the fine ones are loaded, they sit in their
 * declared group as usual, because there is no container to be inside of.
 *
 * The relation itself is recorded in relations.ts with the reason; this is only where the tree obeys
 * it. Keyed by exact label so a side never nests under the other side's parent.
 */
const COVERS: Record<string, string> = {
  erector_spinae_left: "autochthon_left",
  erector_spinae_right: "autochthon_right",
  transversospinalis_left: "autochthon_left",
  transversospinalis_right: "autochthon_right",
};

/** Our plain-English system names -> the declared group that stands for them. */
const SYSTEM_GROUP: Record<string, string> = {
  "Skeletal system": "skeletal",
  "Muscular system": "muscular",
  "Alimentary system": "digestive",
  "Respiratory system": "respiratory",
  "Cardiovascular system": "cardio",
  "Urinary system": "urinary",
  "Genital system": "genital",
  "Endocrine glands": "endocrine",
  "Nervous system": "nervous",
  // FreeSurfer's own groupings (logic/anatomy/freesurfer.json), which is what a FastSurfer result
  // carries. Without these every brain structure lands in Unclassified.
  "Cerebral cortex": "cerebral-cortex",
  "Frontal lobe": "frontal-lobe",
  "Parietal lobe": "parietal-lobe",
  "Temporal lobe": "temporal-lobe",
  "Occipital lobe": "occipital-lobe",
  "Cingulate cortex": "cingulate",
  "Insula": "insula",
  "Cerebral white matter": "cerebral-wm",
  "Subcortical gray matter": "subcortical-grey",
  "Ventricular system": "ventricles",
  "Cerebellum": "cerebellum",
  "Brainstem": "brainstem",
  "Other brain structures": "brain-other",
  "Cranial pia": "cranial-pia",
  "Septum pellucidum": "septum-pellucidum",
  "Walls of lateral ventricle": "ventricle-walls",
  "Arachnoid": "arachnoid",
  "Lymphoid system": "lymphoid",
};

/**
 * Labels whose SIDE nests OUTSIDE rather than becoming a pair.
 *
 * The general rule -- same type code, differing only in Left/Right, so make one parent with two
 * children -- is right for an organ that simply comes in twos (Kidney, Femur). It is wrong where TA2
 * names a lateral CONTAINER, or where the members form a lateral SERIES:
 *
 *   lungs  pairing gives "Upper lobe of lung -> L/R" and leaves the middle lobe with no partner,
 *          because there is no left middle lobe. The orphan is the tell: the shape is not anatomy.
 *          A lobe belongs to its side's lung, so: Right lung -> upper / middle / lower.
 *   ribs   pairing gives twelve parents each holding a left and a right. Side-outermost gives two
 *          rows, and matches how anyone reads a chest: the left ribs, the right ribs.
 */
const SIDE_OUTSIDE = /^(rib_|lung_(upper|middle|lower)_lobe_)/;

/**
 * Structures whose side must NOT become a pair, because the thing is not two things.
 *
 * The general rule -- same type, differing only in Left/Right, so make a parent with two children --
 * assumes a bilateral pair: two kidneys, two femurs, two hippocampi. The ventricular system is not
 * that. Ron: "To me, lat ventricles, third ventricle, aqueduct and fourth ventricle are one midline
 * entity." He is right, and it is a fact about the anatomy rather than a preference: the lateral
 * ventricles open through the interventricular foramina into the third, the third runs through the
 * aqueduct into the fourth, and the whole of it is one continuous cavity of cerebrospinal fluid. The
 * lateral ventricles are lateral EXTENSIONS of that cavity, not a pair of organs that happen to sit
 * either side of it.
 *
 * So they list flat under the system, and the system sits at the midline. Pairing them would have
 * drawn a left ventricle and a right ventricle as two structures, which is the one thing they are
 * not.
 *
 * The CHOROID PLEXUS is here for the same reason, though it is NOT part of this system -- it is filed
 * under Walls of lateral ventricle, which is where Ron places it and where TA2 lists it as "Choroid
 * plexus of lateral ventricle". (TA2 also lists it under Meninges / Leptomeninges / Pia / Cranial
 * pia, because it is tela choroidea. Both are true; even the reference vocabulary needed it twice.) Ron: "choroid plexus
 * is continous through the foramen of monroe." It is: the plexus of each lateral ventricle passes
 * through the interventricular foramen and joins its fellow at the roof of the third ventricle, so
 * left and right are one continuous ribbon of tissue. FreeSurfer labels it `Left-choroid-plexus` and
 * `Right-choroid-plexus`, which is the segmentation cutting something continuous in half because it
 * had to put a number on each voxel -- not a claim that there are two. Where it is filed and whether
 * it is one thing are separate questions, and the answers happen to differ.
 *
 * Note what the data cannot say: FreeSurfer's aseg has no cerebral aqueduct -- only PERIaqueductal
 * gray, which is the brainstem tissue around it -- so the cavity arrives with a gap between the
 * third ventricle and the fourth. The entity is right; the segmentation is incomplete.
 */
const NOT_A_PAIR = /^(Left|Right)-(Lateral-Ventricle|Inf-Lat-Vent|choroid-plexus)$/i;

/**
 * Where a structure sits in a natural sequence, when it has one.
 *
 * Ribs and vertebrae are numbered, and alphabetical order puts the tenth rib after the first and
 * T10 before T2 -- nonsense in a list whose whole purpose is anatomical position. The digestive
 * canal has a sequence too, and it is not alphabetical either: a canal runs mouth to anus, so
 * Esophagus before Stomach before Colon, not Colon first because it starts with C.
 */
const CANAL_ORDER = ["esophagus", "stomach", "duodenum", "small_bowel", "colon"];
/** The canal's own containers, ordered the same way so the sequence survives the extra level. */
const CANAL_GROUP_ORDER: Record<string, number> = { "g:small-intestine": 2.5, "g:large-intestine": 4.5 };

const ordinal = (label: string): number => {
  const rib = /^rib_(left|right)_(\d+)$/.exec(label);
  if (rib) return Number(rib[2]);
  // Lobes read down the lung, not down the alphabet.
  const lobe = /^lung_(upper|middle|lower)_lobe_/.exec(label);
  if (lobe) return ["upper", "middle", "lower"].indexOf(lobe[1]);
  const v = /^vertebrae?_([CTLS])(\d+)$/.exec(label);
  if (v) return "CTLS".indexOf(v[1]) * 100 + Number(v[2]);
  const seg = /^liver_segment_(\d+)$/.exec(label);
  if (seg) return Number(seg[1]);      // Couinaud I..VIII, not alphabetical by Roman numeral
  const canal = CANAL_ORDER.indexOf(label);
  if (canal >= 0) return canal;
  return 1e9;
};

/** Lateral containers: inside one, a member's own side is noise. "First rib, left" -> "First rib". */
const LATERAL_CONTAINER = new Set(["g:ribs-left", "g:ribs-right", "g:lung-left", "g:lung-right"]);

/** Strip the side off a display name: "Kidney, left" -> "Kidney". */
const unsided = (name: string) => name.replace(/,\s*(left|right)$/i, "");

/**
 * A member's name INSIDE a lateral container, where its own side is already said by the container.
 * "Lower lobe of lung, left" under Left lung is "Lower lobe"; "First rib, left" is "First rib".
 */
const inside = (name: string) => unsided(name).replace(/\s+of\s+(the\s+)?(left|right)?\s*lung$/i, "");

/**
 * Build the tree for the structures actually present.
 *
 * `labels` are TotalSegmentator label names; anything unknown to the table is returned under an
 * "Unclassified" node rather than dropped, because a structure that vanished silently would be
 * worse than one that looks out of place.
 */
export function buildAnatomyTree(labels: readonly string[]): AnatomyNode[] {
  const nodes = new Map<string, AnatomyNode>();
  const parentOf = new Map<string, string>();

  /**
   * A group, created on demand -- including the SIDE-QUALIFIED ones, written `id@left`.
   *
   * A sided group (`sided: true`) grows a `Left` and a `Right` child, and everything TA2 nests
   * inside it is repeated under each: `Bones of upper limb / Left / Bones of pectoral girdle`. The
   * side is therefore the branch you open, and every row under it is on that side -- which is the
   * whole point of the shape. Ron: "We don't want accidental surgery on the left, when the lesion is
   * on the right."
   *
   * The qualified group's parent is its own parent, side-qualified, up to the sided group itself,
   * whose qualified child is the side node. Nothing is declared twice.
   */
  /**
   * A GROUP THE TABLES NEVER DECLARED, from a terminology loaded at runtime: SlicerHeart files its
   * leaflets under "Mitral Valve", a lab under whatever its CSV's category column says. The category
   * becomes a group of its own at the top level, named as written, so the term is placed under
   * something a person recognizes rather than under Unclassified.
   */
  const adhocNames = new Map<string, string>();
  const adhocGroup = (system: string | undefined): string => {
    if (!system || /^(other|unclassified)$/i.test(system)) return "";
    const id = "term-" + system.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    adhocNames.set(id, system);
    return id;
  };
  const group = (id: string): AnatomyNode => {
    const existing = nodes.get(`g:${id}`);
    if (existing) return existing;
    const at = id.indexOf("@");
    const side = at < 0 ? "" : id.slice(at + 1);
    const base = at < 0 ? id : id.slice(0, at);
    const g = GROUPS.find((x) => x.id === base);
    const isSideNode = !!side && !!g?.sided;
    const n: AnatomyNode = {
      id: `g:${id}`,
      name: isSideNode
        ? `${side === "left" ? "Left" : "Right"}${g?.sideLabel ? " " + g.sideLabel : ""}`
        : (g?.name ?? adhocNames.get(base) ?? base),
      ta2: g?.ta2,
      children: [],
    };
    nodes.set(n.id, n);
    if (isSideNode) parentOf.set(n.id, `g:${base}`);
    else if (g?.parent) parentOf.set(n.id, `g:${g.parent}${side ? "@" + side : ""}`);
    return n;
  };

  /** The declared group `id` is inside a sided one (or is it), or "" if no side applies. */
  const sidedAncestor = (id: string): string => {
    for (let g = GROUPS.find((x) => x.id === id); g; g = g.parent ? GROUPS.find((x) => x.id === g!.parent) : undefined) {
      if (g.sided) return g.id;
    }
    return "";
  };

  const declaredPlacement = (label: string, s: Structure): string => {
    for (const [re, target] of PLACE) if (re.test(label)) return target.startsWith("s:") ? target : `g:${target}`;
    const byName = /^lung_/.test(label) ? "respiratory" : SYSTEM_GROUP[s.system] ?? adhocGroup(s.system);
    return byName ? `g:${byName}` : "g:unclassified";
  };

  /**
   * Where this label goes, with the side folded in when the region it lands in is a sided one.
   *
   * A structure with no side stays at the group's own level even inside a sided region -- and that
   * is not tidiness, it is the truth about the data: TotalSegmentator's `tibia` is ONE label
   * covering both tibiae (a different task from the one that splits the femur), so it cannot be
   * filed under a side without claiming something the segmentation does not say.
   */
  const placement = (label: string, s: Structure): string => {
    // INSIDE THE COARSER LABEL, when that one is present too. See COVERS.
    const covering = COVERS[label];
    if (covering && known.includes(covering)) return `s:${covering}`;
    const target = declaredPlacement(label, s);
    if (!target.startsWith("g:") || !s.mod) return target;
    const base = target.slice(2);
    if (!sidedAncestor(base)) return target;
    return `g:${base}@${s.mod.toLowerCase()}`;
  };

  const known = labels.filter((l) => STRUCTURES[l]);
  /**
   * A HAND-WRITTEN PLACEMENT BEATS THE REGION ROUTE.
   *
   * `region` is the DICOM Region qualifier, and the findings path uses it to hang a lesion off the
   * organ it sits in -- right for a liver tumor, wrong for anything that merely happens to carry
   * one. `lung_vessels` is "Blood vessel" with region "Lung": an anatomical structure qualified by
   * where it is, not a finding. It was therefore attached by region and never consulted PLACE at
   * all, so its rule looked correct and did nothing, and the label sat loose at the bottom of the
   * cardiovascular system. Ron: "the segmentations organization has not been updated."
   *
   * Rather than re-deciding what counts as a finding -- which is the segmenter's assertion and not
   * ours to overrule wholesale -- an explicit rule in PLACE means a person has already said where
   * this one goes, and that is the more specific statement.
   */
  const hasRule = new Set(known.filter((l) => PLACE.some(([re]) => re.test(l))));
  const findings = known.filter((l) => STRUCTURES[l].region && !hasRule.has(l));
  const anatomy = known.filter((l) => !STRUCTURES[l].region || hasRule.has(l));

  // ANYTHING WE DO NOT RECOGNIZE IS SHOWN, NOT DROPPED.
  //
  // The table is keyed by TotalSegmentator's label names, so another segmenter's vocabulary is
  // entirely foreign to it: FastSurfer emits FreeSurfer names (`Left-Hippocampus`,
  // `ctx-lh-superiorfrontal`) and every one of them missed. This function's own documentation said
  // unknowns land under "Unclassified"; the code quietly filtered them out instead, so a FastSurfer
  // run produced an EMPTY panel rather than a list of structures we could not place. An empty panel
  // reads as "the segmentation failed", which would be a lie about someone's finished run.
  //
  // They keep their raw label as the name, because that is the only true thing we know about them.
  const unknown = labels.filter((l) => !STRUCTURES[l]);
  for (const l of unknown) {
    const n: AnatomyNode = { id: `s:${l}`, name: l, structure: l, children: [] };
    nodes.set(n.id, n);
    parentOf.set(n.id, "g:unclassified");
  }

  // 1. Pairs — same type, differing only in side, unless the side belongs outside.
  const byType = new Map<string, string[]>();
  for (const l of anatomy) {
    const s = STRUCTURES[l];
    if (!s.mod || SIDE_OUTSIDE.test(l) || NOT_A_PAIR.test(l) || !s.type) continue;
    // NOT INSIDE A SIDED REGION. There the SIDE is the branch, so pairing as well produced "Bones of
    // upper limb / Left / Clavicle / [Left, Right]" -- a right clavicle filed under Left, which is
    // precisely the confusion side-first exists to prevent.
    const decl = declaredPlacement(l, s);
    if (decl.startsWith("g:") && sidedAncestor(decl.slice(2))) continue;
    // KEYED BY TYPE **AND** PLACEMENT. By type alone, two labels of the same type filed in different
    // branches were pooled into one pair container, which was then parented under whichever branch
    // came first: `lung_left` in Left lung and `lung_right` in Right lung produced a "Lung" pair
    // nested INSIDE Left lung. A pair is two sides of one structure in one place; two structures in
    // two places are two structures.
    const k = `${s.type}\u0000${decl}`;
    (byType.get(k) ?? byType.set(k, []).get(k)!).push(l);
  }

  const nodeForLabel = new Map<string, AnatomyNode>();
  const placed = new Set<string>();

  for (const [key, members] of byType) {
    if (members.length < 2) continue; // a lone side is just a structure; nothing to gather under
    const type = key.split("\u0000")[0];
    // ONE ID PER PAIR, NOT PER TYPE. With the arch branches there are two "Canine tooth" pairs -- one
    // maxillary, one mandibular -- and a bare `p:Canine tooth` for both meant the second overwrote
    // the first: Lower teeth held all eight pairs and Upper teeth came out EMPTY. The first pair of a
    // type keeps the bare id, so the bilateral-label lookup below and every existing reference still
    // resolve; later ones are qualified by where they sit.
    const bare = `p:${type}`;
    const id = nodes.has(bare) ? `${bare}#${key.split("\u0000")[1]}` : bare;
    const parent: AnatomyNode = { id, name: unsided(STRUCTURES[members[0]].name), children: [] };
    nodes.set(parent.id, parent);
    parentOf.set(parent.id, placement(members[0], STRUCTURES[members[0]]));
    for (const l of members.sort((a, b) => (STRUCTURES[a].mod ?? "").localeCompare(STRUCTURES[b].mod ?? ""))) {
      const n: AnatomyNode = { id: `s:${l}`, name: STRUCTURES[l].mod ?? STRUCTURES[l].name, structure: l, children: [] };
      nodes.set(n.id, n);
      nodeForLabel.set(l, n);
      parent.children.push(n);
      placed.add(l);
    }
  }

  // 2. Everything else anatomical, into its declared group.
  for (const l of anatomy) {
    if (placed.has(l)) continue;
    const s = STRUCTURES[l];
    const target = placement(l, s);
    // A GROUP THAT IS ALSO A STRUCTURE. `heart` placed into the Heart group produced "Heart"
    // containing "Heart" and an auricular appendage -- a container and its own contents wearing the
    // same name. When a structure carries the name of the group it lands in, it IS that node, and
    // the rest of the group becomes its children.
    // THE SAME STRUCTURE, SEGMENTED BOTH WAYS. TotalSegmentator emits `femur_left`/`femur_right`
    // from one task and a bilateral `femur` from another; likewise the maxillary sinus. The bilateral
    // label IS the structure, so it lands ON the pair node -- one row with its own eye, the two sides
    // beneath it -- rather than beside it as a second row with the same name. Ron, on the proposal:
    // "your proposal sounds good."
    const pair = !s.mod && s.type ? nodes.get(`p:${s.type}`) : undefined;
    if (pair && !pair.structure) {
      pair.structure = l;
      nodeForLabel.set(l, pair);
      placed.add(l);
      continue;
    }
    const g = nodes.get(target) ?? (target.startsWith("g:") ? group(target.slice(2)) : undefined);
    if (g && !g.structure && g.name.toLowerCase() === unsided(s.name).toLowerCase()) {
      g.structure = l;
      nodeForLabel.set(l, g);
      placed.add(l);
      continue;
    }
    // The side is already said by whatever this sits inside: a lateral container, a side branch, or
    // a covering label that is itself sided ("Deep muscle of back" under Left holds "Erector spinae
    // muscle", not "Erector spinae muscle, left").
    // ...but only where the covering label is ITSELF under a side branch. The inferior horn nests
    // inside "Lateral ventricle, left", whose own name carries the side and which sits in no side
    // branch at all -- the ventricular system is exempt from side-first (exceptions.ts).
    const cover = target.startsWith("s:") ? target.slice(2) : "";
    const coverSided = !!cover && STRUCTURES[cover] &&
      declaredPlacement(cover, STRUCTURES[cover]).startsWith("g:") &&
      !!STRUCTURES[cover].mod &&
      !!sidedAncestor(declaredPlacement(cover, STRUCTURES[cover]).slice(2));
    const inLateral = LATERAL_CONTAINER.has(target) || target.includes("@") || coverSided;
    // A LABEL WITH NO SIDE, INSIDE A REGION THAT HAS SIDES, COVERS BOTH -- and says so. Sitting
    // between the Left and Right branches as a bare "Humerus", it read as a third humerus; the
    // suffix is the truth about the label (TotalSegmentator's `radius` is one label over both radii)
    // and it is what a clinician needs to know before measuring anything from it.
    const bilateral = !s.mod && !inLateral && target.startsWith("g:") && !!sidedAncestor(target.slice(2));
    const n: AnatomyNode = {
      id: `s:${l}`,
      name: inLateral ? inside(s.name) : bilateral ? `${s.name}, both sides` : s.name,
      structure: l,
      children: [],
    };
    nodes.set(n.id, n);
    nodeForLabel.set(l, n);
    parentOf.set(n.id, target);
    placed.add(l);
  }

  // 3. Findings, under the organ their Region names. Ron: "a second qualifier."
  for (const l of findings) {
    const s = STRUCTURES[l];
    const candidates = [...nodeForLabel.entries()].filter(([hl]) => {
      const h = STRUCTURES[hl];
      return h.type === s.region && (!s.regionMod || h.mod === s.regionMod);
    });
    // SAME TYPE, SAME SIDE, AND STILL TWO DIFFERENT STRUCTURES. The upper and lower canine both have
    // type "Canine tooth" and mod "Left", so both left canine pulps matched the first host found --
    // the upper tooth -- and the lower tooth's pulp was filed inside the upper tooth, which is a
    // containment claim and simply false.
    //
    // Broken by the KEY, not by anatomy: a segmenter names its labels systematically, so the host
    // that shares the longest prefix with the finding is the host it belongs to.
    // `lower_left_canine_pulp_fdi133` shares `lower_left_canine_` with `lower_left_canine_fdi33` and
    // nothing with `upper_left_canine_fdi23`. Catalog-agnostic, and it needs no dental knowledge to
    // read. Where only one candidate matches -- the ordinary case, a cyst in a kidney -- it changes
    // nothing.
    const shared = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    let host = candidates[0];
    if (candidates.length > 1) {
      let bestShared = -1;
      for (const c of candidates) {
        const n = shared(c[0], l);
        if (n > bestShared) { bestShared = n; host = c; }
      }
    }
    // OR OFF A DECLARED SPACE. An effusion's Region is a CAVITY -- "Pleural cavity", "Pericardial
    // cavity" -- and no segmenter labels the cavity itself, so there is no structure to match. The
    // space is declared (above) and the finding creates it, which is honest: fluid in a potential
    // space is the evidence that the space is there to be seen at all.
    const spaceId = host ? "" : (GROUPS.find((g) => g.name.toLowerCase() === (s.region ?? "").toLowerCase())?.id ?? "");
    const n: AnatomyNode = {
      id: `s:${l}`,
      name: s.regionMod ? `${s.name} (${s.regionMod.toLowerCase()})` : s.name,
      structure: l,
      children: [],
    };
    nodes.set(n.id, n);
    // ONLY WHAT THE SEGMENTER CALLS A FINDING goes in the Findings branch. `liver_vessels` and
    // `liver_tumor` both attach by their Region qualifier, but only one of them is a finding: the
    // catalog carries TotalSegmentator's own SNOMED category, and it says "Findings" for the
    // tumor, the cyst and the effusion and "Cardiovascular system" for the vessels. Filing a
    // hepatic vessel under Findings would be our error, not the segmenter's.
    const hostNode = host ? host[1] : spaceId ? group(spaceId) : undefined;
    if (hostNode && s.system === "Findings") {
      // A FINDINGS BRANCH INSIDE THE ORGAN, not a row beside its anatomy. Ron: "a findings branch
      // inside the organ sounds most clear to me." A cyst listed among the parts of the kidney reads
      // as another part of the kidney; under Findings it reads as what it is, and the organ's own
      // structures stay together. The branch exists only where something was actually found.
      const h = hostNode;
      let bin = h.children.find((c) => c.id === `f:${h.id}`);
      if (!bin) {
        bin = { id: `f:${h.id}`, name: "Findings", children: [] };
        nodes.set(bin.id, bin);
        h.children.push(bin);
      }
      bin.children.push(n);
    } else if (hostNode) hostNode.children.push(n);
    else parentOf.set(n.id, `g:${SYSTEM_GROUP[s.system] ?? "unclassified"}`);
  }

  // 4. Hang everything off its parent, creating groups on demand — so a group with nothing in it is
  //    never created, which is what "only what was produced" means in practice.
  for (const [id, parentId] of parentOf) {
    const child = nodes.get(id)!;
    if (parentId.startsWith("s:")) {
      const host = nodes.get(parentId);
      if (host) { host.children.push(child); continue; }
    }
    group(parentId.slice(2)).children.push(child);
  }

  // DECLARED ORDER WINS, at every depth. Sorting groups alphabetically put Lower limb before
  // Vertebral column inside the skeleton -- the GROUPS list is written in the order a person reads
  // the body, and that order was being applied only to the top level.
  // A side-qualified group (`g:muscles-back@left`) ranks as the group it repeats, so the branches
  // under Left and Right read in the declared order too, not alphabetically.
  const rank = (id: string) => {
    const base = id.replace(/@(left|right)$/, "");
    const i = GROUPS.findIndex((g) => `g:${g.id}` === base);
    return i < 0 ? 1e9 : i;
  };
  // A NATURAL SEQUENCE, WHERE ONE EXISTS, BEATS THE DECLARED ORDER.
  //
  // The canal now spans two levels -- esophagus and stomach are its own children, small and large
  // intestine are containers under it -- so ordering by declared-group-first would list the two
  // containers before the two structures and break the sequence the canal exists to show.
  //
  // UNPLACED IS 1e9, NOT Infinity: `Infinity - Infinity` is NaN, and the chain below only worked
  // because NaN happens to be falsy. That is an accident, not a design, and it would fail the day
  // someone reordered the comparison.
  const NONE = 1e9;
  const seq = (n: AnatomyNode) =>
    CANAL_GROUP_ORDER[n.id] ?? (n.structure && !n.id.startsWith("g:") ? ordinal(n.structure) : NONE);
  // THE SIDES COME FIRST inside a sided region. Created on demand, they otherwise sorted
  // alphabetically among the bilateral leftovers -- "Bones of hand, Humerus, Left, Radius, Right,
  // Ulna" -- which buries the one distinction the whole shape exists to make.
  const sideRank = (n: AnatomyNode) => (n.id.endsWith("@left") ? -2 : n.id.endsWith("@right") ? -1 : 0);
  const cmp = (a: AnatomyNode, b: AnatomyNode) =>
    sideRank(a) - sideRank(b) || seq(a) - seq(b) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
  const sort = (n: AnatomyNode) => {
    n.children.sort(cmp);
    n.children.forEach(sort);
  };

  const roots: AnatomyNode[] = [];
  for (const n of nodes.values()) if (!parentOf.has(n.id) && !isChild(nodes, n)) roots.push(n);
  roots.sort(cmp);
  roots.forEach(sort);
  return roots;
}

function isChild(nodes: Map<string, AnatomyNode>, n: AnatomyNode): boolean {
  for (const other of nodes.values()) if (other !== n && other.children.includes(n)) return true;
  return false;
}

/**
 * Every node that IS a segment, in tree order — what the columns act on.
 *
 * A node counts if it names a structure OR carries a scene label value: a segment somebody renamed
 * by hand resolves to no structure at all and would otherwise be invisible to every caller that
 * walks this, including the visibility column.
 */
export function leaves(nodes: readonly AnatomyNode[]): AnatomyNode[] {
  const out: AnatomyNode[] = [];
  const walk = (n: AnatomyNode) => {
    if (n.structure || n.labelValue !== undefined) out.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** A plain-text rendering, used by the tests and handy at a terminal. */
export function renderTree(nodes: readonly AnatomyNode[], indent = 0): string {
  return nodes.map((n) =>
    "   ".repeat(indent) + (n.children.length ? "▾ " : "· ") + n.name + "\n" +
    renderTree(n.children, indent + 1)
  ).join("");
}

/** A segment as the scene holds it: a label value, a display name, a color, a visibility. */
export interface SceneSegment {
  labelValue: number;
  name?: string;
  color?: number[];
  visible?: boolean;
  /**
   * The catalog key this segment IS, when whoever made it knew.
   *
   * A DISPLAY NAME IS AMBIGUOUS AND A KEY IS NOT. Three names live in both catalogs -- Brainstem,
   * Third ventricle, Fourth ventricle -- and resolving one of them by name gets TotalSegmentator's
   * entry, whose system is "Nervous system". So a FastSurfer result put its third and fourth
   * ventricles and its brainstem at the top of the nervous system instead of inside the brain, while
   * every unambiguous structure around them nested correctly. Ron: "The segmentations display of the
   * brain hierarchy was also in need of an update."
   *
   * The panel that creates a segmentation has already decided which structure each segment is -- by
   * FreeSurfer label value, which is exact -- so carrying the key forward means the tree never has to
   * guess from a string. Optional, because a segment from anywhere else still resolves by name as
   * before.
   */
  structure?: string;
}

/**
 * Display name -> the segmenter's label key, so a scene segment can find its place in the tree —
 * BUT ONLY WHEN THE NAME MEANS ONE PLACE.
 *
 * 66 display names are carried by more than one catalog key. The map used to be "last key wins",
 * and the critic measured what that costs (2026-09-22, 4.2): a segment named "Phalanx structure"
 * read back from a SEG landed under Arm / Hand whether it was the hand's phalanges or the foot's;
 * a left kidney cyst was filed as "Cyst (right)"; all 32 dental pulps became the upper right one.
 * That is not a guess a tree should make — Ron: "Assert facts, do not guess."
 *
 * So a name resolves only when every key that carries it would be placed the same way: same rule or
 * same system, same laterality. "T7 vertebra" (TotalSegmentator's `vertebrae_T7` and MOOSE's
 * `vertebra_T7`) and "Clavicle, left" (`clavicula_left`, `clavicle_left`) still resolve, because
 * the keys agree about where they go. A name whose keys disagree resolves to nothing and the
 * segment keeps its own name under Unclassified, which says "this is here, I do not know where it
 * belongs" rather than putting a foot bone in the hand.
 */
const placeTarget = (key: string, s: Structure): string => {
  for (const [re, target] of PLACE) if (re.test(key)) return target;
  const byName = /^lung_/.test(key) ? "respiratory" : SYSTEM_GROUP[s.system] ?? "";
  return byName || (s.system ? `term-${s.system.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "unclassified");
};
/**
 * Where a key sits, as the chain of groups from the top down, plus its side. Two keys are the SAME
 * PLACE when one chain is a prefix of the other -- the two tables put the same structure at two
 * depths of one branch (TotalSegmentator's `brainstem` in the nervous system, FreeSurfer's
 * `Brain-Stem` under the brain), and the deeper one is the better answer, not a different one.
 * Two chains that diverge are two places, and no name can choose between them.
 */
const placeChain = (key: string, s: Structure): string[] => {
  const out: string[] = [];
  let target = placeTarget(key, s);
  if (target.startsWith("s:")) {                       // hung off another segment: follow it up
    const host = target.slice(2);
    const hs = VENDORED[host];
    if (hs && host !== key) out.push(...placeChain(host, hs), `s:${host}`);
    else out.push(target);
    return out;
  }
  const chain: string[] = [];
  for (let g = GROUPS.find((x) => x.id === target); g; g = g.parent ? GROUPS.find((x) => x.id === g!.parent) : undefined) {
    chain.unshift(g.id);
    if (!g.parent) break;
  }
  return chain.length ? chain : [target];
};
const samePlace = (a: string[], b: string[]): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((x, i) => long[i] === x);
};
const BY_DISPLAY = new Map<string, string>();
{
  const seen = new Map<string, { key: string; chain: string[]; mod: string; depth: number }>();
  const ambiguous = new Set<string>();
  for (const [key, s] of Object.entries(VENDORED)) {
    const name = s.name.toLowerCase();
    // The side matters twice: `mod` for a structure, `regionMod` for a finding, which hangs under
    // the organ its region names. A left kidney cyst and a right one are one name and two places.
    const chain = placeChain(key, s);
    const here = { key, chain, mod: `${s.mod ?? ""}|${s.region ?? ""}|${s.regionMod ?? ""}`.toLowerCase(), depth: chain.length };
    const first = seen.get(name);
    if (!first) { seen.set(name, here); continue; }
    if (first.mod !== here.mod || !samePlace(first.chain, here.chain)) { ambiguous.add(name); continue; }
    if (here.depth > first.depth) seen.set(name, here);       // the more specific of two agreeing keys
  }
  for (const [name, { key }] of seen) if (!ambiguous.has(name)) BY_DISPLAY.set(name, key);
}

/**
 * The tree for one segmentation, as the module shows it.
 *
 * The scene stores a segment's DISPLAY name ("Kidney, left"), not the segmenter's label key
 * (`kidney_left`), so this resolves one to the other before building. A segment whose name matches
 * nothing keeps its own name and lands under Unclassified rather than disappearing — the same rule
 * as an unknown label, and the case that matters when a person has renamed something by hand.
 *
 * Every node that IS a segment carries its `labelValue`, which is what the visibility column acts on.
 */
export function buildSegmentTree(segments: readonly SceneSegment[], context?: string): AnatomyNode[] {
  treeContext = context;
  try { return buildSegmentTreeIn(segments); } finally { treeContext = undefined; }
}
function buildSegmentTreeIn(segments: readonly SceneSegment[]): AnatomyNode[] {
  const keyOf = new Map<string, SceneSegment>();
  /** Further segments that ARE the same structure as a key already taken — drawn beside it. */
  const alsoAt = new Map<string, SceneSegment[]>();
  const labels: string[] = [];
  const unresolved: SceneSegment[] = [];
  for (const s of segments) {
    const raw = (s.name ?? "").trim();
    // A terminology loaded at runtime answers first, by key or by display name -- the same order
    // lookupStructure uses -- then the key when the maker knew it (a name can mean two structures,
    // a key cannot), then the vendored tables by key and by display name.
    const term = lookupTerm(s.structure || raw, treeContext);
    const key = term
      ? term.entry.key
      : (s.structure && VENDORED[s.structure])
      ? s.structure
      : VENDORED[raw]
      ? raw
      : BY_DISPLAY.get(raw.toLowerCase()) ?? BY_DISPLAY.get(raw.toLowerCase().replace(/[\s-]+/g, "_"));
    // TWO SEGMENTS THAT ARE THE SAME STRUCTURE ARE TWO ROWS, IN THAT STRUCTURE'S PLACE.
    //
    // The first one takes the tree node; the others are kept here and hung beside it below. They
    // used to fall into Unclassified, so a merged segmentation holding two models' vertebrae lost
    // the second copy of each, and the dental model's 32 pulps (all named "Dental pulp") showed one
    // row and 31 orphans (critic 2026-09-22, 4.1). Ron: "you should not design for single
    // anything" -- one segment per catalog key is exactly that assumption.
    if (key && !keyOf.has(key)) {
      keyOf.set(key, s);
      labels.push(key);
    } else if (key) {
      alsoAt.set(key, [...(alsoAt.get(key) ?? []), s]);
    } else unresolved.push(s);
  }

  const tree = buildAnatomyTree(labels);
  /**
   * Segment rows take the segment's own color; GROUP rows take their tissue color, inherited.
   *
   * Inherited because not every container is a declared group: the side-qualified ones (`g:x@left`)
   * and the synthesised pair rows (`p:Hip`) are built from the run, so they have no entry of their
   * own and would otherwise be colorless -- which is what "Hip" and "Left arm" were. A container
   * with no tissue of its own is the same tissue as whatever contains it.
   */
  const attach = (n: AnatomyNode, inherited?: [number, number, number]) => {
    const s = n.structure ? keyOf.get(n.structure) : undefined;
    let group = inherited;
    if (n.children.length) {
      group = groupColour(n.id) ?? inherited;
      if (group) n.color = group;
    }
    if (s) {
      n.labelValue = s.labelValue;
      if (s.color) n.color = s.color;
      n.visible = s.visible !== false;
    }
    n.children.forEach((c) => attach(c, group));
  };
  tree.forEach((n) => attach(n));

  // The extra segments for a shared key, each as its own row immediately after the one that took
  // the node — same place, same name, its own label value, color and eye.
  if (alsoAt.size) {
    const place = (parent: AnatomyNode[], at: number, key: string) => {
      for (const s of alsoAt.get(key) ?? []) {
        parent.splice(++at, 0, {
          id: `lv:${s.labelValue}`,
          name: s.name || `Segment ${s.labelValue}`,
          labelValue: s.labelValue,
          color: s.color,
          visible: s.visible !== false,
          children: [],
        });
      }
    };
    const walk = (siblings: AnatomyNode[]) => {
      for (let i = siblings.length - 1; i >= 0; i--) {
        const n = siblings[i];
        walk(n.children);
        if (n.structure && alsoAt.has(n.structure)) place(siblings, i, n.structure);
      }
    };
    walk(tree);
  }

  if (unresolved.length) {
    const bucket: AnatomyNode = tree.find((n) => n.id === "g:unclassified") ??
      { id: "g:unclassified", name: "Unclassified", children: [] };
    for (const s of unresolved) {
      bucket.children.push({
        id: `lv:${s.labelValue}`,
        name: s.name || `Segment ${s.labelValue}`,
        labelValue: s.labelValue,
        color: s.color,
        visible: s.visible !== false,
        children: [],
      });
    }
    if (!tree.includes(bucket)) tree.push(bucket);
  }
  return tree;
}
