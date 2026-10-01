// The anatomical tree, pinned against the 117 structures ts:total actually produces.
//
// Ron: "nephrogenic is just an example for many more to come" — so the tree is checked by test
// rather than by eye, and the input is the real class list, not a sample of it.
//
//   deno test -A --no-check logic/anatomy/hierarchy.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { type AnatomyNode, buildAnatomyTree, buildSegmentTree, leaves } from "./hierarchy.ts";

/** ts:total, as TotalSegmentator defines it. Kept here so the test needs no Slicer installed. */
const TOTAL = [
  "spleen","kidney_right","kidney_left","gallbladder","liver","stomach","pancreas","adrenal_gland_right",
  "adrenal_gland_left","lung_upper_lobe_left","lung_lower_lobe_left","lung_upper_lobe_right",
  "lung_middle_lobe_right","lung_lower_lobe_right","esophagus","trachea","thyroid_gland","small_bowel",
  "duodenum","colon","urinary_bladder","prostate","kidney_cyst_left","kidney_cyst_right","sacrum",
  "vertebrae_S1","vertebrae_L5","vertebrae_L4","vertebrae_L3","vertebrae_L2","vertebrae_L1",
  "vertebrae_T12","vertebrae_T11","vertebrae_T10","vertebrae_T9","vertebrae_T8","vertebrae_T7",
  "vertebrae_T6","vertebrae_T5","vertebrae_T4","vertebrae_T3","vertebrae_T2","vertebrae_T1",
  "vertebrae_C7","vertebrae_C6","vertebrae_C5","vertebrae_C4","vertebrae_C3","vertebrae_C2","vertebrae_C1",
  "heart","aorta","pulmonary_vein","brachiocephalic_trunk","subclavian_artery_right","subclavian_artery_left",
  "common_carotid_artery_right","common_carotid_artery_left","brachiocephalic_vein_left",
  "brachiocephalic_vein_right","atrial_appendage_left","superior_vena_cava","inferior_vena_cava",
  "portal_vein_and_splenic_vein","iliac_artery_left","iliac_artery_right","iliac_vena_left","iliac_vena_right",
  "humerus_left","humerus_right","scapula_left","scapula_right","clavicula_left","clavicula_right",
  "femur_left","femur_right","hip_left","hip_right","spinal_cord","gluteus_maximus_left","gluteus_maximus_right",
  "gluteus_medius_left","gluteus_medius_right","gluteus_minimus_left","gluteus_minimus_right",
  "autochthon_left","autochthon_right","iliopsoas_left","iliopsoas_right","brain","skull",
  "rib_left_1","rib_left_2","rib_left_3","rib_left_4","rib_left_5","rib_left_6","rib_left_7","rib_left_8",
  "rib_left_9","rib_left_10","rib_left_11","rib_left_12","rib_right_1","rib_right_2","rib_right_3",
  "rib_right_4","rib_right_5","rib_right_6","rib_right_7","rib_right_8","rib_right_9","rib_right_10",
  "rib_right_11","rib_right_12","sternum","costal_cartilages",
];

const tree = buildAnatomyTree(TOTAL);
const find = (name: string, nodes: readonly AnatomyNode[] = tree): AnatomyNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(name, n.children);
    if (hit) return hit;
  }
};
const kids = (name: string) => (find(name)?.children ?? []).map((c) => c.name);

Deno.test("ts:total is 117 structures, and all 117 survive the tree", () => {
  assertEquals(TOTAL.length, 117);
  const got = leaves(tree).map((n) => n.structure!).sort();
  assertEquals(got.length, 117, "nothing is dropped");
  assertEquals(got, [...TOTAL].sort(), "and nothing is invented");
});

Deno.test("117 structures collapse to 10 top-level rows", () => {
  assertEquals(tree.length, 10, tree.map((n) => n.name).join(", "));
});

Deno.test("a pair becomes one row with two sides", () => {
  assertEquals(kids("Kidney"), ["Left", "Right"]);
});

// SIDE FIRST INSIDE A SIDED REGION, and only there. Ron chose this over the structure-first shape
// TA2's own list implies: "Laterality is clinically important. We don't want accidental surgery on
// the left, when the lesion is on the right." So a limb bone is reached THROUGH its side and the row
// says only "Femur", where a kidney -- which has no left abdomen to sit in -- keeps its two sides as
// children of one row.
Deno.test("in a sided region the side is the branch, not the leaf", () => {
  assertEquals(kids("Leg"), ["Left leg", "Right leg"]);
  const left = find("Leg")!.children.find((c) => c.name === "Left leg")!;
  assertEquals(left.children.map((c) => c.name), ["Femur"]);
  assertEquals(left.children[0].structure, "femur_left", "the Left branch holds the LEFT femur");
  const right = find("Leg")!.children.find((c) => c.name === "Right leg")!;
  assertEquals(right.children[0].structure, "femur_right");
  // and TA2's own nesting is repeated inside each side, rather than the side being buried under it
  const upperLeft = find("Arm")!.children.find((c) => c.name === "Left arm")!;
  assertEquals(upperLeft.children.map((c) => c.name), ["Shoulder", "Humerus"]);
  assertEquals(
    upperLeft.children[0].children.map((c) => c.structure),
    ["clavicula_left", "scapula_left"],
    "a right clavicle must never appear under Left",
  );
});

Deno.test("a finding hangs under the organ its Region names, not in a pathology bucket", () => {
  // Ron: "Pathology is missing from TA2 but is in Snowmed CT ... it should be a second qualifier."
  const left = find("Kidney")!.children.find((c) => c.name === "Left")!;
  // In a Findings branch INSIDE the organ, not among its parts. Ron: "a findings branch inside the
  // organ sounds most clear to me." Still not a bucket at the top of the tree: a cyst belongs to the
  // kidney it is in, which is what the Region qualifier says.
  assertEquals(left.children.map((c) => c.name), ["Findings"]);
  assertEquals(left.children[0].children.map((c) => c.structure), ["kidney_cyst_left"]);
  assertEquals(tree.some((r) => r.name === "Findings"), false, "no pathology bucket at the top level");
});

Deno.test("the sacrum keeps S1, as TA2 has it", () => {
  assertEquals(kids("Sacrum"), ["S1 vertebra"]);
});

// Ron, 2026-09-22, looking at a merged segmentation read back from the database: "The vertebrae
// lost their home and organization. It should go: cervical, thoracal, lumbar and sacral." They
// had fallen out of the Spine because a segment that arrives by its readable name ("C4 vertebra")
// resolved to MOOSE's key `vertebra_C4`, which no rule matched.
Deno.test("the spine reads cervical, thoracic, lumbar, sacrum -- in vertebral order", () => {
  assertEquals(kids("Spine"), ["Cervical vertebrae", "Thoracic vertebrae", "Lumbar vertebrae", "Sacrum"]);
  assertEquals(kids("Cervical vertebrae"), ["C1 vertebra", "C2 vertebra", "C3 vertebra", "C4 vertebra", "C5 vertebra", "C6 vertebra", "C7 vertebra"]);
  assertEquals(kids("Thoracic vertebrae").length, 12);
  assertEquals(kids("Thoracic vertebrae")[9], "T10 vertebra", "numeric, not alphabetical");
  assertEquals(kids("Lumbar vertebrae"), ["L1 vertebra", "L2 vertebra", "L3 vertebra", "L4 vertebra", "L5 vertebra"]);
});

Deno.test("a vertebra lands in the same place by either key and by its readable name", () => {
  const where = (nodes: readonly AnatomyNode[], p: string[] = []): string => {
    for (const n of nodes) { if (n.structure) return [...p, n.name].join(" / "); const r = where(n.children, [...p, n.name]); if (r) return r; }
    return "";
  };
  const byTs = where(buildAnatomyTree(["vertebrae_T7"]));
  assertEquals(byTs, "Skeletal system / Spine / Thoracic vertebrae / T7 vertebra");
  assertEquals(where(buildAnatomyTree(["vertebra_T7"])), byTs, "MOOSE's spelling");
  assertEquals(where(buildSegmentTree([{ labelValue: 1, name: "T7 vertebra" }])), byTs, "as a SEG read back names it");
  assertEquals(where(buildSegmentTree([{ labelValue: 1, name: "Clavicle, left" }])), "Skeletal system / Arm / Left arm / Shoulder / Clavicle");
});

Deno.test("ribs nest side-outermost, twelve a side, in rib order", () => {
  assertEquals(kids("Ribs"), ["Left ribs", "Right ribs"]);
  const left = kids("Left ribs");
  assertEquals(left.length, 12);
  assertEquals(left[0], "First rib", "and the side is not repeated inside the container");
  assertEquals(left[11], "Twelfth rib");
});

Deno.test("lobes belong to their side's lung, superior to inferior", () => {
  // The rule that made this necessary: pairing by type orphaned the middle lobe, which has no
  // partner on the left. An orphan means the shape was wrong, not the data.
  assertEquals(kids("Right lung"), ["Upper lobe", "Middle lobe", "Lower lobe"]);
  assertEquals(kids("Left lung"), ["Upper lobe", "Lower lobe"]);
});

Deno.test("the heart is a node, not a container holding another heart", () => {
  const heart = find("Heart")!;
  assertEquals(heart.structure, "heart");
  assertEquals(heart.children.map((c) => c.structure), ["atrial_appendage_left"]);
});

Deno.test("vessels are grouped by circulation, not by artery/vein", () => {
  // A pulmonary vein carries oxygenated blood and a pulmonary artery deoxygenated, so artery/vein
  // is direction from the heart, not oxygenation. TA2 splits on circulation and so do we.
  assert(find("Pulmonary veins")!.children.some((c) => c.structure === "pulmonary_vein"));
  const systemicVeins = find("Systemic veins")!;
  assert(!JSON.stringify(systemicVeins).includes("pulmonary_vein"), "the pulmonary vein is not a systemic vein");
  assert(find("Systemic arteries")!.children.some((c) => c.structure === "aorta"));
});

Deno.test("the digestive canal runs in anatomical order, not alphabetical", () => {
  // The sequence has to survive the extra level TA2 puts in: small and large intestine are
  // containers, esophagus and stomach are not, and mouth-to-anus still has to read top to bottom.
  assertEquals(kids("Digestive canal"), ["Esophagus", "Stomach", "Small intestine", "Large intestine"]);
  assertEquals(kids("Small intestine"), ["Duodenum", "Jejunum and ileum"]);
  assertEquals(kids("Large intestine"), ["Colon"]);
  // liver, gallbladder and pancreas are SIBLINGS of the canal, as TA2 has them
  const digestive = find("Digestive system")!.children.map((c) => c.name);
  assert(digestive.includes("Liver") && digestive.includes("Pancreas"), digestive.join(", "));
});

Deno.test("our corrections to the segmenter's names reach the tree", () => {
  // WITHDRAWN, and the test records the withdrawal. This asserted that ts:total's `autochthon`
  // reads "Erector spinae muscle", from Ron's correction of 2026-09-03. He withdrew it on
  // 2026-09-07 with TA2 open: "TA2 has no Autochthon muscle." The autochthonous muscles are the
  // intrinsic back muscles as a GROUP -- TA2's epaxial set -- of which the erector spinae is one
  // layer, so the segmenter's own "Deep muscle of back" (SCT:244849004) is the accurate name and
  // the relation to the finer labels is recorded as `covers` instead.
  assert(find("Deep muscle of back"), "the segmenter's own group name stands");
  assert(!find("Erector spinae muscle"), "ts:total does not segment the erector spinae by itself");
  // Inside a sided branch the side is said by the branch, so the row is the bare name. What the
  // correction has to keep is the side in the NAME, which the collision queue checks.
  assert(find("Gluteus minimus muscle"), "\"minius\" is a typo in the segmenter's own CSV");
  assert(!find("Gluteus minius muscle"));
  assert(!find("Gluteus minius muscle, left"));
  assert(!find("Small Intestine"), "German-style Title Case on a common noun is not English usage");
});

Deno.test("a label that covers two structures is not given a tidier name", () => {
  // `small_bowel` is the small intestine MINUS the duodenum, which is segmented separately. Naming
  // it "Small intestine" would make it the duodenum's parent and assert a containment the two
  // disjoint labels do not have.
  const si = find("Small intestine")!;
  assertEquals(si.structure, undefined, "the container is a container, not one of the two regions");
  assertEquals(si.children.map((c) => c.structure), ["duodenum", "small_bowel"]);
});

Deno.test("only what was produced: a small task makes a small tree", () => {
  const small = buildAnatomyTree(["liver", "spleen", "kidney_left", "kidney_right"]);
  assertEquals(small.map((n) => n.name), ["Digestive system", "Urinary system", "Lymphoid organs"]);
  assert(!find("Thoracic cage", small), "no empty containers");
  assertEquals(leaves(small).length, 4);
});

Deno.test("a lone side is a structure, not a pair with one member", () => {
  const one = buildAnatomyTree(["kidney_left"]);
  assertEquals(leaves(one).length, 1);
  assertEquals(leaves(one)[0].name, "Kidney, left");
});

Deno.test("an unknown label is shown as unplaced, never silently dropped", () => {
  const t = buildAnatomyTree(["liver", "not_a_structure"]);
  assertEquals(leaves(t).length, 2, "both reach the tree");
  assertEquals(find("Unclassified", t)!.children.map((c) => c.structure), ["not_a_structure"]);
});

Deno.test("another segmenter's vocabulary lists in full rather than vanishing", () => {
  // A vocabulary the table does not know used to produce an EMPTY tree, which reads as "your
  // segmentation failed" — a lie about a finished run. Unknown names are listed as unplaced instead.
  //
  // This was written with FreeSurfer's names as the example, because they missed every entry. They
  // no longer do: freesurfer.json is part of the table now and the test below places them properly.
  // The rule it was protecting is not about FreeSurfer, so it keeps a vocabulary that really is
  // unknown.
  const alien = ["Zzz-Structure-A", "Zzz-Structure-B", "not_a_structure"];
  const t = buildAnatomyTree(alien);
  assertEquals(leaves(t).length, 3);
  assertEquals(t.map((n) => n.name), ["Unclassified"]);
  assertEquals(find("Unclassified", t)!.children.map((c) => c.name).sort(), [...alien].sort());
});

Deno.test("FreeSurfer's own label names place, by the key the LUT uses", () => {
  const t = buildAnatomyTree(["Left-Hippocampus", "ctx-lh-superiorfrontal", "Brain-Stem"]);
  assertEquals(find("Unclassified", t), undefined, "none of them should be unplaced");
  assert(find("Frontal lobe", t), "the cortical parcellation groups by lobe");
  assert(find("Subcortical gray matter", t), "the hippocampus is subcortical grey");
});

Deno.test("a task's structures nest inside the organ they belong to", () => {
  // ts:liver_segments returns the eight Couinaud segments. Without a Liver container they land as
  // siblings of the liver — which is how Ron met them: a flat list of eight, "They are all the same
  // color." Vessels and lesions carry region "Liver" and attach the same way findings do.
  const t = buildAnatomyTree(["liver", "liver_vessels", "liver_tumor", "liver_segment_1", "liver_segment_2"]);
  const liver = find("Liver", t)!;
  assertEquals(liver.structure, "liver", "the liver is the node, not a container beside it");
  // The vessels stay among the liver's parts -- they are anatomy qualified by where they are. Only
  // what the segmenter itself categorizes as a finding goes in the Findings branch.
  assertEquals(liver.children.map((c) => c.structure ?? c.name), [
    "liver_segment_1",
    "liver_segment_2",
    "liver_vessels",
    "Findings",
  ]);
  assertEquals(liver.children[3].children.map((c) => c.structure), ["liver_tumor"]);
  assertEquals(leaves(t).length, 5);
});

Deno.test("segments are ordered I..VIII, not by their Roman numerals as text", () => {
  const t = buildAnatomyTree(Array.from({ length: 8 }, (_, i) => `liver_segment_${i + 1}`));
  const names = find("Liver", t)!.children.map((c) => c.name);
  assertEquals(names[0], "Caudate lobe of liver", "segment I is the caudate lobe");
  assertEquals(names[1], "Couinaud hepatic segment II");
  assertEquals(names[7], "Couinaud hepatic segment VIII");
});

Deno.test("a task whose groups were declared for it lands with nothing unclassified", () => {
  // ts:lung_vessels is READY on this machine, and is the first task to reach the Pulmonary
  // arteries / Airways groups that ts:total never fills.
  const t = buildAnatomyTree(["lung_airways", "lung_airways_wall", "lung_arteries", "lung_veins"]);
  assertEquals(leaves(t).length, 4);
  assert(!find("Unclassified", t), "every label had a declared home");
  assert(find("Pulmonary arteries", t) && find("Airways", t));
});

Deno.test("a dural venous sinus is a vein, not a paranasal one", () => {
  // ts:brain_structures emits `venous_sinuses`. It matched neither "vein" nor "vena" in the
  // generator's rules and fell through to the respiratory rule on the word "sinus" — arriving under
  // the Respiratory system on a BRAIN segmentation. The word names two unrelated things.
  const t = buildAnatomyTree(["venous_sinuses", "brainstem", "thalamus"]);
  assert(find("Venous sinus", t), "it is in the tree");
  assert(!find("Respiratory system", t), "and not in the lungs' branch");
  assert(find("Cardiovascular system", t));
});

Deno.test("ts:brain_structures places all 16, none unclassified", () => {
  const brain = [
    "brainstem","subarachnoid_space","venous_sinuses","septum_pellucidum","cerebellum","caudate_nucleus",
    "lentiform_nucleus","insular_cortex","internal_capsule","ventricle","central_sulcus","frontal_lobe",
    "parietal_lobe","occipital_lobe","temporal_lobe","thalamus",
  ];
  const t = buildAnatomyTree(brain);
  assertEquals(leaves(t).length, 16);
  assert(!find("Unclassified", t), "every label had a home");
});

// ---- the tree as the Segmentations module builds it ---------------------------------------------

Deno.test("a scene segment finds its place by display name, and keeps its label value", () => {
  // The scene stores "Kidney, left"; the tree is keyed by `kidney_left`. Every node that IS a
  // segment has to carry the label value, because that is what the visibility column acts on.
  const t = buildSegmentTree([
    { labelValue: 3, name: "Kidney, left", visible: true },
    { labelValue: 4, name: "Kidney, right", visible: false },
    { labelValue: 7, name: "Liver", visible: true },
  ]);
  const kidney = find("Kidney", t)!;
  assertEquals(kidney.children.map((c) => c.labelValue), [3, 4]);
  assertEquals(kidney.children.map((c) => c.visible), [true, false]);
  assertEquals(find("Liver", t)!.labelValue, 7);
});

Deno.test("a hand-renamed segment is listed, not lost", () => {
  // Someone renames a segment and it matches no structure. It must still appear — with its own
  // name — or a person loses a segment by naming it.
  const t = buildSegmentTree([
    { labelValue: 1, name: "Liver" },
    { labelValue: 2, name: "the odd bit near the hilum" },
  ]);
  assertEquals(leaves(t).length, 2);
  const un = find("Unclassified", t)!;
  assertEquals(un.children.map((c) => c.name), ["the odd bit near the hilum"]);
  assertEquals(un.children[0].labelValue, 2);
});

Deno.test("two segments with the same name are two rows", () => {
  // A duplicate name must not silently replace the first in the tree.
  const t = buildSegmentTree([
    { labelValue: 1, name: "Liver" },
    { labelValue: 2, name: "Liver" },
  ]);
  assertEquals(leaves(t).length, 2, "both survive");
  assertEquals(leaves(t).map((n) => n.labelValue).sort(), [1, 2]);
});

Deno.test("the pulmonary vessels arrive colored apart", () => {
  const t = buildSegmentTree([
    { labelValue: 1, name: "Pulmonary artery", color: [0.24, 0.42, 0.77] },
    { labelValue: 2, name: "Pulmonary vein", color: [0.78, 0.24, 0.23] },
  ]);
  const artery = find("Pulmonary arteries", t)!.children[0];
  const vein = find("Pulmonary veins", t)!.children[0];
  assert(artery.color![2] > artery.color![0], "artery blue");
  assert(vein.color![0] > vein.color![2], "vein red");
});

// A FASTSURFER RESULT MUST BUILD A TREE, NOT A HEAP.
//
// FreeSurfer's structures come from a different vocabulary than TotalSegmentator's, so without the
// brain subtree every one of the 95 lands in Unclassified -- which is exactly what "the organization
// as presented by the freesurfer people" is meant to prevent.
Deno.test("hierarchy: FreeSurfer structures are placed, not left unclassified", () => {
  const segs = [
    { labelValue: 1, name: "Fusiform gyrus, right" },
    { labelValue: 2, name: "Hippocampus, left" },
    { labelValue: 3, name: "Lateral ventricle, left" },
    { labelValue: 4, name: "Brainstem" },
    { labelValue: 5, name: "Cerebellar cortex, right" },
    { labelValue: 6, name: "Precentral gyrus, left" },
  ];
  const tree = buildSegmentTree(segs);
  const paths: string[] = [];
  const walk = (n: { name: string; children?: unknown[] }, trail: string[]) => {
    const here = [...trail, n.name];
    if (!n.children?.length) paths.push(here.join(" / "));
    else for (const c of n.children) walk(c as { name: string; children?: unknown[] }, here);
  };
  for (const root of tree) walk(root as { name: string; children?: unknown[] }, []);
  const all = paths.join("\n");
  assertEquals(all.includes("Unclassified"), false, `something was unplaced:\n${all}`);
  assertEquals(/Cerebral cortex \/ Temporal lobe/.test(all), true, all);
  assertEquals(/Cerebral cortex \/ Frontal lobe/.test(all), true, all);
  assertEquals(/Brain \/ Ventricular system/.test(all), true, all);
  assertEquals(/Brain \/ Cerebellum/.test(all), true, all);
});

// THE VENTRICULAR SYSTEM IS ONE MIDLINE ENTITY, not a bilateral pair.
//
// Ron: "To me, lat ventricles, third ventricle, aqueduct and fourth ventricle are one midline
// entity." The lateral ventricles open through the interventricular foramina into the third, which
// runs through the aqueduct into the fourth: one continuous cavity. Pairing the lateral ventricles
// would draw a left one and a right one as two structures, which is the one thing they are not.
Deno.test("the ventricles list flat under their system rather than pairing by side", () => {
  const t = buildAnatomyTree([
    "Left-Lateral-Ventricle", "Right-Lateral-Ventricle",
    "Left-Inf-Lat-Vent", "Right-Inf-Lat-Vent",
    "3rd-Ventricle", "4th-Ventricle",
  ]);
  assertEquals(find("Unclassified", t), undefined, "all of them place");
  const sys = find("Ventricular system", t)!;
  assert(sys, "they share one container");
  // No intermediate "Lateral ventricle" node holding a Left and a Right.
  assertEquals(find("Lateral ventricle", t), undefined, "the lateral ventricles must not pair");
  assertEquals(leaves([sys]).length, 6, "all six hang directly off the system");
});

// The rule is about the ventricles specifically, not about everything with a side: a structure that
// genuinely has two sides is reached THROUGH its side, like a limb bone. Ron: "Brain: Side first,
// like in the limb."
Deno.test("a paired brain structure is reached through its hemisphere", () => {
  const t = buildAnatomyTree(["Left-Hippocampus", "Right-Hippocampus"]);
  assertEquals(find("Hippocampus", t)!.children, [], "no Left/Right beneath it: the side is above");
  const left = find("Left hemisphere", t)!;
  assert(left, "the cerebrum is sided");
  assertEquals(
    leaves([left]).map((n) => n.structure),
    ["Left-Hippocampus"],
    "the left hippocampus is in the left hemisphere and nowhere else",
  );
  assertEquals(leaves([find("Right hemisphere", t)!]).map((n) => n.structure), ["Right-Hippocampus"]);
});

// The choroid plexus of each lateral ventricle passes through the interventricular foramen and joins
// its fellow at the roof of the third ventricle. Ron: "choroid plexus is continous through the
// foramen of monroe." FreeSurfer's Left-/Right- labels are the segmentation cutting something
// continuous in half because it must number every voxel — not a claim that there are two.
Deno.test("the choroid plexus is continuous, so it does not pair either", () => {
  const t = buildAnatomyTree(["Left-choroid-plexus", "Right-choroid-plexus", "3rd-Ventricle"]);
  assertEquals(find("Choroid plexus", t), undefined, "no Left/Right parent may be invented for it");
  // TA2 files it under Meninges / Leptomeninges / Pia / Cranial pia -- it is tela choroidea, which
  // is pia, invaginated into the cavity. Ron: "The choroid plexus is not ventricle."
  // TA2 lists it in two places and both are true: under cranial pia because it IS tela choroidea,
  // and under Walls of lateral ventricle as "Choroid plexus of lateral ventricle". The second is
  // where an aseg's label belongs. Ron: "It is also the home of the choroid plexus."
  const walls = find("Walls of lateral ventricle", t)!;
  assert(walls, "it is a wall structure, not the cavity");
  assertEquals(walls.children.map((c) => c.name).sort(), ["Choroid plexus, left", "Choroid plexus, right"]);
  assertEquals(find("Ventricular system", t)!.children.map((c) => c.name), ["Third ventricle"]);
  assertEquals(find("Unclassified", t), undefined);
});

// THE COMPONENTS OF THE VENTRICULAR SYSTEM, as Ron defines them: "the entity is ventricular system,
// its components are left and right lateral ventricle, third ventricle, aqueduct and fourth
// ventricle." The inferior horn is not among them because it is INSIDE one of them.
Deno.test("the inferior horn sits inside its lateral ventricle, not beside it", () => {
  const t = buildAnatomyTree([
    "Left-Lateral-Ventricle", "Left-Inf-Lat-Vent",
    "Right-Lateral-Ventricle", "Right-Inf-Lat-Vent",
    "3rd-Ventricle", "4th-Ventricle",
  ]);
  const sys = find("Ventricular system", t)!;
  // Four components directly under the system; each horn hangs off its own lateral ventricle.
  assertEquals(sys.children.map((c) => c.name).sort(), [
    "Fourth ventricle", "Lateral ventricle, left", "Lateral ventricle, right", "Third ventricle",
  ]);
  const left = sys.children.find((c) => c.name === "Lateral ventricle, left")!;
  assertEquals(left.children.map((c) => c.name), ["Inferior horn of the lateral ventricle, left"]);
  assertEquals(leaves([sys]).length, 6, "nothing was lost by nesting");
});

// FreeSurfer's CSF is fluid NOT in a labeled ventricle, and the fifth ventricle does not
// communicate with the others — neither is part of one continuous cavity.
Deno.test("CSF and the fifth ventricle are not filed with the communicating system", () => {
  const t = buildAnatomyTree(["3rd-Ventricle", "CSF", "5th-Ventricle"]);
  const sys = find("Ventricular system", t)!;
  assertEquals(sys.children.map((c) => c.name), ["Third ventricle"]);
  assertEquals(find("Unclassified", t), undefined, "the other two still place, elsewhere");
});

// "5th-Ventricle" is FreeSurfer's own label name for the cavum septi pellucidi, and it is a misnomer:
// the space is not lined by ependyma and does not communicate with the ventricular system. Leaving
// the name while defining that system as one continuous cavity would have contradicted the
// definition in the same tree. Ron: "just don't call it 5th ventricle. Cavum septum pellucidy is
// leggit."
Deno.test("the fifth ventricle is named for what it is, and filed away from the ventricles", () => {
  const t = buildAnatomyTree(["5th-Ventricle", "3rd-Ventricle"]);
  const names = leaves(t).map((n) => n.name);
  assertEquals(names.includes("Cavum septi pellucidi"), true, names.join(", "));
  assertEquals(names.some((n) => /fifth ventricle/i.test(n)), false, "the misnomer must not survive");
  assertEquals(find("Ventricular system", t)!.children.map((c) => c.name), ["Third ventricle"]);
  // TA2: Walls of lateral ventricle / Septum pellucidum / Cave of septum pellucidum. The walls are
  // not the cavity, which is what gives the cave a real home instead of "Other brain structures".
  const sp = find("Septum pellucidum", t)!;
  assert(sp, "it lives in the septum, not in a leftovers bin");
  assertEquals(sp.children.map((c) => c.name), ["Cavum septi pellucidi"]);
  assert(find("Walls of lateral ventricle", t), "and the septum is a wall structure");
});

// TA2, from Ron's Viewer shot: Nervous system / Central nervous system holds Gray matter, White
// matter, Reticular formation, Ependyma, Meninges, Brain and Spinal cord — so the meninges are the
// brain's NEIGHBOR, not something inside it. And cerebrospinal fluid is filed under the arachnoid,
// beside the subarachnoid space it fills.
Deno.test("the meninges sit beside the brain, not inside it, and CSF is arachnoid", () => {
  const t = buildAnatomyTree(["3rd-Ventricle", "CSF"]);
  const cns = find("Central nervous system", t)!;
  assert(cns, "the brain and the meninges share a parent");
  assertEquals(cns.children.map((c) => c.name).sort(), ["Brain", "Meninges"]);
  // TA2 files the fluid under the arachnoid, beside the subarachnoid space it fills and the
  // granulations that resorb it. Ron, after a second look: "archnoid is the parent and the others
  // are inside that hierarchy."
  assertEquals(find("Arachnoid", t)!.children.map((c) => c.name), ["Cerebrospinal fluid"]);
  assertEquals(find("Other brain structures", t), undefined, "nothing is left in the leftovers bin");
});

// THE TWO HALVES OF THE PULMONARY CIRCULATION BELONG TOGETHER. `pulmonary_vein` had a placement rule
// and `pulmonary_artery` did not, so the vein nested and the artery sat loose beside the aorta — in a
// result whose whole point is showing the two together. Ron: "the segmentations organization has not
// been updated."
Deno.test("pulmonary artery and vein sit together under the pulmonary vessels", () => {
  const t = buildAnatomyTree(["pulmonary_artery", "pulmonary_vein", "lung_vessels", "aorta"]);
  const pv = find("Pulmonary vessels", t)!;
  const under = leaves([pv]).map((n) => n.name).sort();
  assertEquals(under, ["Blood vessel", "Pulmonary artery", "Pulmonary vein"]);
  assertEquals(find("Systemic arteries", t)!.children.map((c) => c.name), ["Aorta"]);
});

// `lung_vessels` carries region "Lung", which routed it down the FINDINGS path — attach to the organ
// named by the region — so its placement rule was never consulted and looked correct while doing
// nothing. A hand-written rule is the more specific statement and wins.
Deno.test("an explicit placement beats the region route, and real findings still attach", () => {
  const lung = buildAnatomyTree(["lung_vessels"]);
  assert(find("Pulmonary vessels", lung), "the rule applies despite the region qualifier");
  // A genuine finding has no rule, so it still hangs off the organ its region names.
  const liver = buildAnatomyTree(["liver", "liver_tumor"]);
  assertEquals(find("Liver", liver)!.children.map((c) => c.name), ["Findings"]);
  assertEquals(find("Findings", liver)!.children.map((c) => c.name), ["Neoplasm"]);
});

// The same airway appeared at two depths: "Trachea" under Airways and "Trachea and bronchus" loose
// at the top of the respiratory system.
Deno.test("the airways are all in one place", () => {
  const t = buildAnatomyTree(["trachea", "lung_trachea_bronchia"]);
  assertEquals(find("Airways", t)!.children.map((c) => c.name).sort(), ["Trachea", "Trachea and bronchus"]);
  assertEquals(find("Respiratory system", t)!.children.map((c) => c.name), ["Airways"]);
});

// A DISPLAY NAME IS AMBIGUOUS; A KEY IS NOT.
//
// Brainstem, Third ventricle and Fourth ventricle exist in both catalogs. buildSegmentTree
// resolved a scene segment by its stored NAME, so a FastSurfer result got TotalSegmentator's
// entries for those three — whose system is "Nervous system" — and they appeared at the top of the
// tree while every unambiguous structure around them nested correctly inside the brain. Ron: "The
// segmentations display of the brain hierarchy was also in need of an update."
Deno.test("a segment carrying its key lands in its own catalogue's branch", () => {
  const segs = [
    { labelValue: 1, name: "Third ventricle", structure: "3rd-Ventricle" },
    { labelValue: 2, name: "Fourth ventricle", structure: "4th-Ventricle" },
    { labelValue: 3, name: "Brainstem", structure: "Brain-Stem" },
    { labelValue: 4, name: "Hippocampus, left", structure: "Left-Hippocampus" },
  ];
  const t = buildSegmentTree(segs);
  const brain = find("Brain", t)!;
  assert(brain, "everything is inside the brain");
  const vs = find("Ventricular system", t)!;
  assertEquals(vs.children.map((c) => c.name).sort(), ["Fourth ventricle", "Third ventricle"]);
  assert(find("Brainstem", brain.children.length ? t : t), "the brainstem is placed");
  // Nothing may sit directly under Nervous system: that was the symptom.
  const nervous = find("Nervous system", t)!;
  assertEquals(nervous.children.map((c) => c.name), ["Central nervous system"]);
});

// Without a key the old behavior stands, so a segment from anywhere else still resolves.
Deno.test("a segment with no key still resolves by name", () => {
  const t = buildSegmentTree([{ labelValue: 1, name: "Liver" }]);
  assert(find("Liver", t), "an unambiguous name is enough");
});

// A FINDING IN A POTENTIAL SPACE. Ron: "Effusion: handle like a kidney cyst conceptually ... You
// have the following spaces of this kind in the Torso: Pericard, l/r pleura, peritonal cavity." No
// segmenter labels the cavity itself -- an effusion's Region names it and nothing else does -- so
// the space is declared and the finding brings it into being, which is honest: fluid in a potential
// space is the evidence that there is a space to see.
Deno.test("an effusion sits in its serous space, the way a cyst sits in its organ", () => {
  const t = buildAnatomyTree(["heart", "pericardium", "pericardial_effusion", "pleural_effusion"]);
  const pericardial = find("Pericardial cavity", t)!;
  assertEquals(pericardial.children.map((c) => c.name), ["Findings"]);
  assertEquals(pericardial.children[0].children.map((c) => c.structure), ["pericardial_effusion"]);
  // and it is inside the pericardium, inside the heart -- TA2's own nesting
  const heart = find("Heart", t)!;
  assertEquals(heart.children.map((c) => c.name), ["Pericardium"]);
  // the pleural one is in the respiratory system, not beside the heart
  const pleural = find("Pleural cavity", t)!;
  assertEquals(pleural.children[0].children.map((c) => c.structure), ["pleural_effusion"]);
  assert(find("Pleura", t), "the space sits inside its membrane");
  assertEquals(find("Respiratory system", t)!.children.map((c) => c.name), ["Pleura"]);
});

// Ron chose the arch as a BRANCH ("2 for the teeth") over folding it into each tooth's name.
//
// Four defects met here, all from one cause -- the arch was not part of a tooth's identity, so the
// upper and lower canine were indistinguishable to every mechanism that keys off `type`:
//   * two rows called "Left" and two called "Right" under a single "Canine tooth" pair;
//   * both left canine pulps attached to the UPPER tooth, so the lower tooth's pulp was filed inside
//     the upper one -- a containment claim, and false;
//   * with the arches split, both arches produced a pair with the same id `p:Canine tooth`, and the
//     second overwrote the first: Lower teeth held all eight, Upper teeth came out EMPTY;
//   * a catch-all placement rule for `_fdi` keys swallowed the pulps onto the anatomy path, so they
//     sat loose in the branch as sixteen identical "Dental pulp" rows.
// Each of those passed a spot check of something else, which is why all four are asserted here.
Deno.test("both dental arches are populated, paired, and hold their own pulps", async () => {
  const cat = JSON.parse(await Deno.readTextFile(new URL("./totalsegmentator.json", import.meta.url)));
  const keys: string[] = Array.isArray(cat) ? cat.map((x) => x.key ?? x.name) : Object.keys(cat.structures ?? cat);
  const tree = buildSegmentTree(keys.map((k, i) => ({ labelValue: i + 1, name: k, structure: k, color: [0.5, 0.5, 0.5] as [number, number, number] })));
  const find = (n: AnatomyNode, id: string): AnatomyNode | undefined =>
    n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean);
  const at = (id: string) => tree.map((t) => find(t, id)).find(Boolean);

  for (const arch of ["g:teeth-upper", "g:teeth-lower"]) {
    const node = at(arch);
    assert(node, `${arch} is missing`);
    // Eight tooth types an arch, each ONE pair row with exactly a Left and a Right.
    assertEquals(node!.children.length, 8, `${arch} should hold 8 tooth types, not ${node!.children.length}`);
    for (const t of node!.children) {
      const sides = t.children.map((c) => c.name).sort();
      assertEquals(sides, ["Left", "Right"], `${arch} / ${t.name} sides are ${sides.join("+")}`);
    }
  }

  // Every pulp under the tooth it is the pulp OF.
  let checked = 0;
  const walk = (n: AnatomyNode, host: string | undefined) => {
    if (n.structure && /_pulp_fdi/.test(n.structure)) {
      checked++;
      const tooth = n.structure.replace("_pulp", "").replace(/_fdi\d+$/, "");
      assert(host && host.replace(/_fdi\d+$/, "") === tooth, `${n.structure} sits under ${host}`);
    }
    for (const c of n.children) walk(c, n.structure ?? host);
  };
  for (const t of tree) walk(t, undefined);
  assertEquals(checked, 32, "expected 32 dental pulps");

  // And nothing anywhere was dropped on the way.
  const placed = new Set(leaves(tree).map((l) => l.structure).filter(Boolean));
  assertEquals(keys.filter((k) => !placed.has(k)), [], "labels missing from the tree");
});

// Ron, 2026-09-21, on ts:abdominal_muscles: "left right should be handled like in the brain". One
// Left / Right split under the muscular system, the regional groups repeated under each side in
// their declared order, and no second split anywhere below.
Deno.test("the muscular system is sided once, at the top, like the cerebrum", () => {
  const tree = buildAnatomyTree([
    "pectoralis_major_right", "pectoralis_major_left", "rectus_abdominis_right", "rectus_abdominis_left",
    "latissimus_dorsi_right", "latissimus_dorsi_left", "erector_spinae_right", "erector_spinae_left",
    "psoas_major_right", "psoas_major_left",
  ]);
  const muscular = tree.find((n) => n.name === "Muscular system")!;
  assertEquals(muscular.children.map((c) => c.name), ["Left", "Right"]);
  for (const side of muscular.children) {
    assertEquals(side.children.map((c) => c.name), ["Muscles of the back", "Muscles of the abdomen", "Muscles of the chest", "Muscles of the leg"]);
    const walk = (n: AnatomyNode) => { assert(!/^(Left|Right)$/.test(n.name) || n === side, `a second side split under ${side.name}: ${n.name}`); n.children.forEach(walk); };
    walk(side);
  }
  assertEquals(leaves(tree).length, 10);
});

// TWO SEGMENTS THAT ARE THE SAME STRUCTURE ARE TWO ROWS IN THAT STRUCTURE'S PLACE, not one row and
// an orphan. A merged segmentation carries two models' copies of a vertebra, and a SEG read back
// from the database carries display names, so both copies resolve to one key (critic 2026-09-22,
// 4.1). Before this they were: the first in the Spine, the second in Unclassified.
Deno.test("a structure claimed by two segments keeps both, side by side", () => {
  const t = buildSegmentTree([{ labelValue: 1, name: "T7 vertebra" }, { labelValue: 2, name: "T7 vertebra" }]);
  const rows = leaves(t).map((n) => `${n.name} [${n.labelValue}]`);
  assertEquals(rows, ["T7 vertebra [1]", "T7 vertebra [2]"]);
  assertEquals(t.some((n) => n.name === "Unclassified"), false, "neither copy is orphaned");
});

// A DISPLAY NAME CARRIED BY KEYS THAT DISAGREE ABOUT WHERE THEY BELONG RESOLVES TO NOTHING.
// "Phalanx structure" is both `phalanges_hand` and `phalanges_feet`; the map used to keep whichever
// came last, so a foot bone was drawn under the hand (critic 4.2). Unplaced is honest; misplaced is
// not. Names whose keys AGREE -- two spellings of one vertebra, two of one clavicle -- still place.
Deno.test("an ambiguous name is left unplaced rather than placed wrongly", () => {
  const amb = buildSegmentTree([{ labelValue: 1, name: "Phalanx structure" }]);
  assertEquals(amb.map((n) => n.name), ["Unclassified"]);
  const cyst = buildSegmentTree([{ labelValue: 1, name: "Cyst" }]);
  assertEquals(cyst.map((n) => n.name), ["Unclassified"]);
  const where = (t: AnatomyNode[], p: string[] = []): string => {
    for (const n of t) { if (n.labelValue !== undefined) return [...p, n.name].join(" / "); const r = where(n.children, [...p, n.name]); if (r) return r; }
    return "";
  };
  assertEquals(where(buildSegmentTree([{ labelValue: 1, name: "T7 vertebra" }])), "Skeletal system / Spine / Thoracic vertebrae / T7 vertebra");
  assertEquals(where(buildSegmentTree([{ labelValue: 1, name: "Clavicle, left" }])), "Skeletal system / Arm / Left arm / Shoulder / Clavicle");
});
