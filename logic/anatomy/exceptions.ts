// THE EXCEPTIONS, cataloged — because they are the content, not the failures.
//
// Ron: "All of these rules are just there to make our lifes easier. Like in grammar, you have rules
// and then catalogs with exceptions. The body does what the body does and our rules fit most but
// not everything ... All of anatomy is arbitrary, but not random. That is the root cause why there
// is so much fighting." And then, on German: "grammar rules for german serve the main purpose of
// providing a scaffold for the exceptions."
//
// Which is the right way round. A rule earns its place by making an exception STATABLE in one line:
// "the ventricular system is not split by hemisphere, because it is one space." Without the rule
// that sentence has no subject. So the rules are declared in hierarchy.ts and every deliberate
// departure from one is written here, with the reason -- arbitrary but not random means the reason
// is the whole of it, and an exception without one is indistinguishable from a bug.
//
// Read this before deciding that the tree is wrong somewhere. It may be wrong; it may also be here.

export interface Exception {
  /** The rule being departed from, named as it is named in hierarchy.ts. */
  rule: string;
  /** What it applies to. */
  applies: string;
  /** Why the body does not do what the rule says. This is the part that matters. */
  why: string;
}

export const EXCEPTIONS: Exception[] = [
  {
    rule: "side first inside a sided region",
    applies: "the ventricular system",
    why:
      "It is one continuous space. CSF runs from the lateral ventricles through the interventricular " +
      "foramina to the third, down the aqueduct to the fourth and out; filing the halves under two " +
      "hemispheres would hide the connection that makes it a system. Ron: 'Its kind of like a system.'",
  },
  {
    rule: "a structure with two sides becomes one row with Left and Right",
    applies: "pathology — cysts, effusions, hypointensities",
    why:
      "A lesion's side belongs to the lesion, not to the anatomy. Ron: cysts 'can be singular or " +
      "plural and unilateral or bilateral', and 'non white matter hypointensities are pathology, " +
      "sometimes paired (like periventricular) and sometimes not (like ms lesions)'. Two lesions on " +
      "two sides are two findings, not one structure with two halves.",
  },
  {
    rule: "a structure with two sides becomes one row with Left and Right",
    applies: "the lateral ventricles and their inferior horns, and the choroid plexus",
    why:
      "The inferior horn is PART OF its side's lateral ventricle, not a fifth cavity beside it. And " +
      "the plexus of each lateral ventricle joins its fellow at the roof of the third, so the two are " +
      "continuous rather than a mirrored pair.",
  },
  {
    rule: "side first inside a sided region",
    applies: "a label with no side inside one — 'Radius, both sides'",
    why:
      "TotalSegmentator's `radius` is a single label over both radii, from a different task than the " +
      "one that splits the femur. Filing it under a side would assert a side the segmentation never " +
      "did, and it would hide that there is no per-side number to measure.",
  },
  {
    rule: "a group contains structures; a structure is a leaf",
    applies: "Skull, Sacrum, Liver, Maxillary sinus, Pericardium",
    why:
      "A coarse label and the finer ones can arrive from different tasks for the same anatomy. The " +
      "coarse one IS the structure and the fine ones are inside it, so the node is both — one row " +
      "with its own eye and children beneath.",
  },
  {
    rule: "one display name, one row",
    applies: "Brainstem, third ventricle, fourth ventricle",
    why:
      "They exist in both catalogs with different colors and different systems. A segment carries " +
      "its catalog key, so TotalSegmentator's and FreeSurfer's resolve apart despite the shared name.",
  },
  {
    rule: "a finding hangs under the organ its Region names",
    applies: "the effusions",
    why:
      "Their Region is a potential space, not an organ, and no segmenter labels a potential space. " +
      "The space is declared and the finding brings it into being — the fluid is the evidence that " +
      "there is a space to see.",
  },
  {
    rule: "anything attached by Region is a finding",
    applies: "liver_vessels, lung_vessels",
    why:
      "They are anatomy qualified by where they are, and TotalSegmentator's own SNOMED category says " +
      "so. Only what the segmenter categorizes as a finding goes in a Findings branch.",
  },
  {
    rule: "a structure sits in the cavity it lies in",
    applies: "the choroid plexus",
    why:
      "It is tela choroidea — pia, invaginated into the ventricle and covered by ependyma. It lies IN " +
      "the ventricle without being part of it, the way a hand in a pocket is not part of the coat. " +
      "TA2 lists it under the walls of the lateral ventricle.",
  },
  {
    rule: "vessels are grouped as arteries and veins",
    applies: "the pulmonary circulation",
    why:
      "Artery and vein describe direction relative to the heart, not oxygenation. Splitting on that " +
      "files the pulmonary vein beside the vena cava, opposite in both circulation and oxygen, so TA2 " +
      "splits on circulation instead and so do we.",
  },
  {
    rule: "a parent's extent is the sum of its children",
    applies: "Small intestine (duodenum and small bowel), and every `covers` relation",
    why:
      "TotalSegmentator's `small_bowel` EXCLUDES the duodenum: they are disjoint labels that together " +
      "approximate the whole. And where a coarse label covers fine ones, the parent is the SAME " +
      "voxels rather than their sum. Either way a parent's number is not the total of its children's.",
  },
];
