// The claim under test: when the segmenter names a structure, the name decides the group; when it
// does not, the measurement does; and neither silently invents an answer.
//
//   deno test -A --no-check logic/segment-naming.test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { freesurferStructureByName, freesurferStructureFor, groupByAnatomy, lookupStructure, namedFraction, usesFreesurferNumbering } from "./segment-naming.ts";
import type { SegmentStats } from "./segment-groups.ts";
import { LATEST_PALETTE, setPaletteVersion } from "./anatomy/palettes.ts";

const stat = (labelValue: number, meanHU: number, sdHU = 20, gasFraction = 0): SegmentStats =>
  ({ labelValue, meanHU, sdHU, gasFraction, voxels: 50_000 });

// --- looking a structure up -----------------------------------------------------------------

Deno.test("lookup: the segmenter's own key resolves", () => {
  assertEquals(lookupStructure("liver")?.system, "Alimentary system");
  assertEquals(lookupStructure("liver")?.name, "Liver");
  assertEquals(lookupStructure("vertebrae_L3")?.system, "Skeletal system");
  assertEquals(lookupStructure("vertebrae_L3")?.name, "L3 vertebra");
});

// A SEG round-trip may carry SegmentLabel as the readable name instead of the segmenter's key, and
// which one depends on who wrote the file. Both have to resolve to the same structure.
Deno.test("lookup: the readable name resolves to the same structure", () => {
  assertEquals(lookupStructure("L3 vertebra")?.system, "Skeletal system");
  assertEquals(lookupStructure("Liver")?.system, "Alimentary system");
  assertEquals(lookupStructure("KIDNEY_RIGHT")?.system, "Urinary system");
  assertEquals(lookupStructure("small bowel")?.system, "Alimentary system");
});

Deno.test("lookup: an unknown name is null, not a guess", () => {
  assertEquals(lookupStructure("Segment_17"), null);
  assertEquals(lookupStructure(""), null);
  assertEquals(lookupStructure(undefined), null);
  assertEquals(lookupStructure("tumour of somewhere"), null);
});

// The ambiguity that the generator had to resolve by rule ORDER, asserted here so a later edit to
// those rules cannot quietly reintroduce it. "ventricle" means two entirely different organs.
Deno.test("lookup: a cardiac ventricle and a brain ventricle are told apart", () => {
  assertEquals(lookupStructure("heart_ventricle_left")?.system, "Cardiovascular system");
  assertEquals(lookupStructure("third_ventricle")?.system, "Nervous system");
  assertEquals(lookupStructure("ventricle_frontal_horn_left")?.system, "Nervous system");
  // This one fell through to "Body regions" on the body_ pattern until the rule order was fixed.
  assertEquals(lookupStructure("ventricle_body_left")?.system, "Nervous system");
});

// Pathology and hardware are not anatomy, and TA2 does not name them. They must not be filed under
// the organ they sit in — a liver lesion is a finding, not the alimentary system.
Deno.test("lookup: findings and devices are outside the anatomical systems", () => {
  assertEquals(lookupStructure("liver_lesions")?.system, "Findings");
  assertEquals(lookupStructure("pleural_effusion")?.system, "Findings");
  assertEquals(lookupStructure("implant")?.system, "Devices");
});

// TA2 places the dentition in the alimentary system; a tooth is not a bone.
Deno.test("lookup: teeth are alimentary, not skeletal", () => {
  assertEquals(lookupStructure("upper_right_canine_fdi13")?.system, "Alimentary system");
  assertEquals(lookupStructure("mandible")?.system, "Skeletal system");
});

Deno.test("lookup: the SNOMED code rides along; the color is the scheme's (v2: Mike Halle's liver; v1: the segmenter's)", () => {
  const liver = lookupStructure("liver")!;
  assertEquals(liver.code, "SCT:10200004");
  assertEquals(liver.rgb, [156, 66, 48]);
  setPaletteVersion(1);
  try {
    assertEquals(lookupStructure("liver")!.rgb, [221, 130, 101]);
  } finally { setPaletteVersion(LATEST_PALETTE); }
});

// --- grouping ---------------------------------------------------------------------------------

Deno.test("groups: a named segmentation groups by system, in anatomical order", () => {
  const groups = groupByAnatomy([
    { labelValue: 1, name: "liver" },
    { labelValue: 2, name: "vertebrae_L3" },
    { labelValue: 3, name: "rib_left_3" },
    { labelValue: 4, name: "aorta" },
    { labelValue: 5, name: "gluteus_maximus_left" },
  ]);
  assertEquals(groups.map((g) => g.name), [
    "Muscular system",
    "Alimentary system",
    "Cardiovascular system",
    "Skeletal system",
  ]);
  assertEquals(groups.find((g) => g.name === "Skeletal system")!.members, [2, 3], "sorted by label");
  assertEquals(groups.find((g) => g.name === "Skeletal system")!.opacity, 1.0);
});

// The point of the whole module: a name beats a measurement. Liver and muscle are both ~40 HU and
// the intensity classifier calls them both "Soft tissue"; the names separate them exactly.
Deno.test("groups: a name wins over the measurement that cannot make the distinction", () => {
  const segments = [{ labelValue: 1, name: "liver" }, { labelValue: 2, name: "gluteus_maximus_left" }];
  const stats = [stat(1, 45), stat(2, 48)];
  const groups = groupByAnatomy(segments, stats);
  assertEquals(groups.map((g) => g.name), ["Muscular system", "Alimentary system"]);
});

// Ron's current data: nnInteractive, nothing named. The measurement is all there is, and this must
// fall back to it rather than declaring everything ungrouped.
Deno.test("groups: with no names at all, the measurement groups them", () => {
  const groups = groupByAnatomy(
    [{ labelValue: 1 }, { labelValue: 2 }, { labelValue: 3 }],
    [stat(1, 350), stat(2, 40), stat(3, 12, 122, 0.031)],
  );
  assertEquals(new Set(groups.map((g) => g.name)), new Set(["Bone", "Soft tissue", "Gas-containing"]));
});

// A mixed segmentation: some structures named, others painted by hand afterwards.
Deno.test("groups: named and measured segments coexist, known systems first", () => {
  const groups = groupByAnatomy(
    [{ labelValue: 1, name: "liver" }, { labelValue: 2, name: "Segment_2" }],
    [stat(2, 350)],
  );
  assertEquals(groups.map((g) => g.name), ["Alimentary system", "Bone"]);
});

// Neither named nor measured. It must be visibly unfinished rather than filed somewhere plausible.
Deno.test("groups: with neither a name nor a measurement, a segment is Ungrouped", () => {
  const groups = groupByAnatomy([{ labelValue: 9, name: "Segment_9" }]);
  assertEquals(groups.map((g) => g.name), ["Ungrouped"]);
  assertEquals(groups[0].members, [9]);
});

Deno.test("groups: empty groups never appear", () => {
  const groups = groupByAnatomy([{ labelValue: 1, name: "liver" }]);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].name, "Alimentary system");
});

// --- which mode are we in ----------------------------------------------------------------------

Deno.test("namedFraction: says whether names or measurement will drive the grouping", () => {
  assertAlmostEquals(namedFraction([{ labelValue: 1, name: "liver" }, { labelValue: 2, name: "aorta" }]), 1);
  assertAlmostEquals(namedFraction([{ labelValue: 1, name: "liver" }, { labelValue: 2, name: "Segment_2" }]), 0.5);
  assertAlmostEquals(namedFraction([{ labelValue: 1 }]), 0);
  assertAlmostEquals(namedFraction([]), 0, 1e-9);
});

// --- where we disagree with the segmenter -------------------------------------------------------

// A CORRECTION, WITHDRAWN — and the withdrawal is as much a fact as the correction was.
//
// Ron, 2026-09-03: "autochthon muscle of the back is for me the erector spinae", which renamed
// ts:total's `autochthon` to Erector spinae with that muscle's code. Ron, 2026-09-07, with TA2 open:
// "TA2 has no Autochthon muscle." The autochthonous muscles are the intrinsic back muscles as a
// GROUP — TA2 files the same set as EPAXIAL — and the erector spinae is one layer of it. So the
// segmenter's own SCT:244849004 "Deep muscle of back" was right, the correction was too narrow, and
// the relation to the finer labels belongs in relations.ts as `covers` rather than in a rename.
Deno.test("the autochthon correction is withdrawn: the segmenter's own name stands", () => {
  const s = lookupStructure("autochthon_left")!;
  assertEquals(s.name, "Deep muscle of back, left");
  assertEquals(s.code, "SCT:244849004");
  assertEquals(s.origin, "acquired", "no longer OUR assertion — it is the segmenter's own");
});

// The evidence of what the tool actually said must survive the disagreement, or there is no way to
// tell a correction from a misreading later.
// `asSegmented` records what the tool said WHEN WE DISAGREE. With the autochthon correction
// withdrawn there is nothing to disagree with, so there is nothing to record beside it — the entry
// is simply the segmenter's. The iliopsoas below still carries one, because that disagreement stands.
Deno.test("with no correction there is no second version to keep", () => {
  const s = lookupStructure("autochthon_right")!;
  assertEquals(s.asSegmented, undefined);
  assertEquals(s.name, "Deep muscle of back, right");
});

// Ron: "iliopsoas are actually two muscles". SNOMED's SCT:68455001 is itself a compound concept, so
// the label is not mis-coded — it is mis-shaped, one region over two muscles. TotalSegmentator ships
// psoas_major separately and ships no iliacus at all, so it cannot produce the pair. No rename fixes
// that, so the entry carries the conflation and does NOT quietly relabel it.
Deno.test("override: iliopsoas is flagged as two muscles rather than renamed", () => {
  const s = lookupStructure("iliopsoas_left")!;
  assertEquals(s.conflates, [
    { name: "Iliacus muscle" },
    { name: "Psoas major muscle", code: "SCT:64038003" },
  ]);
  assertEquals(s.name, "Iliopsoas muscle, left", "not renamed — renaming would not fix the shape");
  assertEquals(s.origin, "asserted");
  assertEquals(s.note, "iliopsoas are actually two muscles");
});

Deno.test("override: psoas major on its own is the segmenter's, uncorrected", () => {
  const s = lookupStructure("psoas_major_left")!;
  assertEquals(s.code, "SCT:64038003");
  assertEquals(s.origin, "acquired");
  assertEquals(s.conflates, undefined);
});

// The point of the correction: the two tasks stop contradicting each other on screen.
// They are NOT the same muscle: `autochthon` is the intrinsic back muscles as a group and the
// erector spinae is one layer of it. Their relation is containment, recorded in relations.ts as
// `covers` and obeyed by the tree (COVERS in hierarchy.ts), not equality of name and code.
Deno.test("autochthon is the group, the erector spinae one layer of it", () => {
  assert(lookupStructure("autochthon_left")!.name !== lookupStructure("erector_spinae_left")!.name);
  assert(lookupStructure("autochthon_left")!.code !== lookupStructure("erector_spinae_left")!.code);
});

// Everything not corrected must stay exactly as the segmenter asserted it.
Deno.test("override: an uncorrected structure is untouched and marked acquired", () => {
  const liver = lookupStructure("liver")!;
  assertEquals(liver.origin, "acquired");
  assertEquals(liver.asSegmented, undefined);
  assertEquals(liver.note, undefined);
  assertEquals(liver.code, "SCT:10200004");
});

// The iliacus is absent from TotalSegmentator's 413 labels and from Slicer's terminology files, so
// no SNOMED code could be sourced for it. It must stay ABSENT rather than be invented: a code that
// looks usable and is wrong is worse than a missing one. The psoas major's code is real, from the
// segmenter's own table, and this asserts the asymmetry deliberately.
Deno.test("override: an unsourceable code is left out, not guessed", () => {
  const parts = lookupStructure("iliopsoas_right")!.conflates!;
  assertEquals(parts.find((p) => p.name === "Iliacus muscle")!.code, undefined);
  assertEquals(parts.find((p) => p.name === "Psoas major muscle")!.code, "SCT:64038003");
  // And the part that IS coded matches the standalone label the segmenter ships.
  assertEquals(lookupStructure("psoas_major_right")!.code, "SCT:64038003");
});

// --- structures only a person can name ----------------------------------------------------------

// Ron: "in the nninteractive segmentation they are two muscles. So they are easily separateable."
// TotalSegmentator cannot produce an iliacus, but a study can already hold one as its own region --
// unnamed, not missing. Without a catalog entry the module would offer a wrong name or none.
Deno.test("known: a structure the segmenter cannot produce is still nameable", () => {
  const s = lookupStructure("iliacus_left")!;
  assertEquals(s.name, "Iliacus muscle, left");
  assertEquals(s.system, "Muscular system");
  assertEquals(s.origin, "asserted", "a person put it there, and the record says so");
  assertEquals(s.by, "Ron Kikinis");
});

// No SNOMED code could be sourced on this machine, which is NOT evidence that SNOMED lacks one.
// The field stays absent and the identifiers that could be sourced are carried instead.
Deno.test("known: unsourceable SNOMED stays absent; other identifiers are carried", () => {
  const s = lookupStructure("iliacus_right")!;
  assertEquals(s.code, undefined);
  assertEquals(s.otherIds, ["FMA:22310", "TA2:2594"]);
});

Deno.test("known: it resolves by readable name too, as a SEG round-trip would carry it", () => {
  assertEquals(lookupStructure("Iliacus muscle, left")?.system, "Muscular system");
});

// The catalog widens what can be named; it must never shadow what a tool actually asserted.
Deno.test("known: the segmenter's own entries win over the hand-added catalogue", () => {
  const psoas = lookupStructure("psoas_major_left")!;
  assertEquals(psoas.origin, "acquired");
  assertEquals(psoas.code, "SCT:64038003");
  // And iliopsoas still reports the conflation rather than being quietly resolved by the new entry.
  assertEquals(lookupStructure("iliopsoas_left")!.conflates!.length, 2);
});

Deno.test("known: a hand-named iliacus groups with the muscles", () => {
  const groups = groupByAnatomy([
    { labelValue: 1, name: "iliacus_left" },
    { labelValue: 2, name: "psoas_major_left" },
  ]);
  assertEquals(groups.map((g) => g.name), ["Muscular system"]);
  assertEquals(groups[0].members, [1, 2]);
});

Deno.test("the pulmonary artery and vein are told apart by colour", () => {
  // Ron, after ts:lung_vessels: "Both veins and arteries are red." TotalSegmentator ships no color
  // for either, so both fell back to the Cardiovascular system's single red and the two vessel trees
  // drew identically — erasing the distinction the task exists to make.
  const artery = lookupStructure("lung_arteries")!;
  const vein = lookupStructure("lung_veins")!;
  assert(artery.rgb && vein.rgb, "both carry an asserted colour");
  // Blue artery, red vein: the colors track OXYGENATION, and the pulmonary circulation is where
  // the vein is the oxygenated one. The reverse of the systemic convention, on purpose.
  assert(artery.rgb![2] > artery.rgb![0], `artery is blue, got ${artery.rgb}`);
  assert(vein.rgb![0] > vein.rgb![2], `vein is red, got ${vein.rgb}`);
  assertEquals(artery.origin, "asserted");
  assert(artery.note?.includes("deoxygenated"));
});

// FREESURFER, AND THE ROUND TRIP THROUGH THE DICOM DATABASE.
//
// FastSurfer names its output from its own ColorLUT.tsv, which is a subset: on Ron's first result 17
// of 95 segments arrived as `label_2003` ... `label_2035`, all right-hemisphere cortex, simply
// absent from that file. FreeSurfer's own LUT names and colors all 95. Ron: "Use the colors and
// organization as presented by the freesurfer people ... but don't assume. Check the facts."

Deno.test("freesurfer: a label value names the structure the file could not", () => {
  const s = freesurferStructureFor(2035);
  assertEquals(s?.name, "Insula, right");
  assertEquals(s?.system, "Insula");
});

Deno.test("freesurfer: the colour is FreeSurfer's own, not the SEG's generated hue", () => {
  assertEquals(freesurferStructureFor(2007)?.rgb, [180, 220, 140]);   // ctx-rh-fusiform
});

// FastSurfer's table gives Left-VentralDC the RIGHT side's color. FreeSurfer distinguishes them,
// and left and right made identical is a mistake rather than a choice.
Deno.test("freesurfer: left and right VentralDC keep FreeSurfer's different colours", () => {
  assertEquals(freesurferStructureFor(28)?.rgb, [145, 42, 42]);
  assertEquals(freesurferStructureFor(60)?.rgb, [165, 42, 42]);
});

Deno.test("freesurfer: the organization is by lobe, as the Desikan-Killiany atlas presents it", () => {
  assertEquals(freesurferStructureFor(1012)?.system, "Frontal lobe");      // ctx-lh-lateralorbitofrontal
  assertEquals(freesurferStructureFor(2022)?.system, "Parietal lobe");    // ctx-rh-postcentral
  assertEquals(freesurferStructureFor(2015)?.system, "Temporal lobe");    // ctx-rh-middletemporal
  assertEquals(freesurferStructureFor(17)?.system, "Subcortical gray matter");
  assertEquals(freesurferStructureFor(16)?.system, "Brainstem");
});

// THE ROUND TRIP. What we write into the SEG is the readable name; what comes back has to resolve to
// the same structure, with the same color, or the appearance changes every time a result is
// reloaded.
Deno.test("round trip: the name written into a SEG resolves back to the same structure", () => {
  const made = freesurferStructureFor(2007)!;
  const back = freesurferStructureByName(made.name);
  assertEquals(back?.name, made.name);
  assertEquals(back?.rgb, made.rgb);
  assertEquals(back?.system, made.system);
});

// Three display names live in both catalogs. For a TotalSegmentator result the general lookup is
// right; for a FreeSurfer one it silently changes the color and the grouping.
Deno.test("round trip: a name in both catalogues resolves within its own family", () => {
  assertEquals(freesurferStructureByName("Brainstem")?.system, "Brainstem");
  assertEquals(freesurferStructureByName("Third ventricle")?.system, "Ventricular system");
  assertEquals(freesurferStructureByName("Fourth ventricle")?.system, "Ventricular system");
});

Deno.test("round trip: a name from another family is not claimed by FreeSurfer's table", () => {
  assertEquals(freesurferStructureByName("Liver"), null);
  assertEquals(freesurferStructureByName("Erector spinae muscle"), null);
});

Deno.test("freesurfer numbering is claimed per ecosystem, not per task", () => {
  assertEquals(usesFreesurferNumbering("fastsurfer:brain"), true);
  assertEquals(usesFreesurferNumbering("fastsurfer:anything_later"), true);
  assertEquals(usesFreesurferNumbering("ts:total"), false);
});
