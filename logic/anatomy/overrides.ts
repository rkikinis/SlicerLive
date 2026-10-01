// Where we disagree with the segmenter, on the record.
//
// `totalsegmentator.json` is a faithful derivation of what TotalSegmentator asserts, and it stays
// that way — correcting it in place would destroy the evidence of what the tool actually said, and
// the next regeneration would silently revert the correction anyway. Disagreements live here
// instead, hand-written, each with its reason and the person standing behind it.
//
// This is the same distinction `core/model/frame.ts` draws for geometry: something ACQUIRED from the
// data is not the same kind of fact as something ASSERTED by a person, and a model that flattens the
// two cannot tell you why it believes what it believes. A lookup carries both — what the segmenter
// said, and what we say instead.
//
// A correction here is a NAMING correction. It does not change a single voxel, and it cannot fix a
// label that covers the wrong region: see `conflates`.

/**
 * One of the structures merged under a single label.
 *
 * `code` is SNOMED CT where one could be SOURCED — from the segmenter's own terminology or from
 * Slicer's. It is absent rather than guessed when it could not be: an invented code is worse than a
 * missing one, because it looks usable.
 */
export interface ConflatedPart {
  name: string;
  code?: string;
}

/** One disagreement with the segmenter's naming. */
export interface NameOverride {
  /** Displayed instead of the segmenter's name. */
  name?: string;
  /** Asserted instead of the segmenter's code, where the segmenter's is coarser or wrong. */
  code?: string;
  /**
   * A display color, 0-255, where the segmenter ships none and the fallback is wrong.
   *
   * The fallback is the anatomical SYSTEM's color, which is right until two structures in one
   * system have to be told apart — see the pulmonary vessels below.
   */
  rgb?: [number, number, number];
  /**
   * The distinct anatomical structures this one label actually contains.
   *
   * A conflation cannot be corrected by renaming — the label covers two things and only a
   * re-segmentation can separate them. Recording it lets the module say so rather than presenting a
   * merged region under a name that implies a single structure, and carrying each part's code means
   * a future split has something to map ONTO rather than a pair of strings.
   */
  conflates?: ConflatedPart[];
  /**
   * The anatomical system this belongs to, where the segmenter has it under the wrong one.
   *
   * A CLASSIFICATION correction rather than a naming one -- the exception to the rule at the top of
   * this file, and it is here for the same reason the naming corrections are: the table is
   * regenerated from the source, so a fix made there is undone by the next release. Setting it to
   * "Findings" says this label is pathology and not anatomy, which is a claim about the world and
   * belongs with a name and a reason attached.
   */
  system?: string;
  /** The structure or space it sits in, so a finding can be hung off it. */
  region?: string;
  /**
   * THE SIDE THIS LABEL IS, when the catalog forgot to say.
   *
   * The pairing that turns `x_left`/`x_right` into one row with Left and Right children keys off
   * `mod`. TotalSegmentator publishes `parotid_gland_left` and `parotid_gland_right` with the same
   * `type` and the same `name` and NO `mod`, so they came out as two sibling rows both called
   * "Parotid gland" -- which is worse than unpaired, because nothing on screen says which is which.
   * Ron listed the parotid first among the structures that "all have two, left and right".
   */
  mod?: string;
  /**
   * What the label ACTUALLY covers, where the segmenter's convention is narrower than the name.
   *
   * Ron's classic example of "arbitrary but not random": "Corpus callosum ... Easy to spot in the
   * midline. If you are a pathologist, take out the brain, split it in half and you have this well
   * defined white matter structure. The lateral extent is not defined at all. Nerve fibers going to
   * the cortex everywhere."
   *
   * That it is there is not arbitrary. Where it stops is. FreeSurfer's answer is not to solve the
   * boundary but to sample it: CC_Posterior through CC_Anterior (251-255) are five slabs near the
   * midsagittal plane. So a volume computed from them is the volume of five slabs, reproducible and
   * not what the name says -- and the only moment that matters is the moment somebody measures it,
   * which is why it belongs on the structure and not in a footnote.
   *
   * Recorded rather than corrected: no renaming fixes a convention, and no other tool would agree
   * with our correction anyway.
   */
  convention?: string;
  /** Why, in the words of whoever asserted it. */
  why: string;
  /** Who asserted it. */
  by: string;
}

/**
 * Keyed by the segmenter's own label name.
 *
 * Both entries below are Ron's, 2026-09-03, and both are corroborated by TotalSegmentator's own
 * finer-grained tasks — which is what makes them corrections rather than opinions: the tool
 * contradicts itself between tasks, and these say which side is right.
 */
export const OVERRIDES: Record<string, NameOverride> = {
  // THE PAROTIDS HAVE NO SIDE IN THE CATALOG. Both entries are `type: "Parotid gland"` with the
  // same name and no `mod`, so the pairing had nothing to key off and produced two sibling rows both
  // reading "Parotid gland" -- indistinguishable on screen, which for a paired organ is the failure
  // mode Ron cares most about. Asserting the side the label's own key already states.
  parotid_gland_left: {
    mod: "Left",
    why: "TotalSegmentator gives both parotids the same type and the same name with no side, so the " +
      "pairing had nothing to key off and drew two sibling rows both reading 'Parotid gland'. The " +
      "side is already in the label's own key; this asserts it where the tree can see it.",
    by: "Ron Kikinis, 2026-09-08",
  },
  parotid_gland_right: {
    mod: "Right",
    why: "The right parotid, for the same reason as the left: the catalog states no side.",
    by: "Ron Kikinis, 2026-09-08",
  },
  // HYPOINTENSITIES ARE PATHOLOGY, and their sides are incidental.
  //
  // Ron: "non white matter hypointensities are pathology, sometimes paired (like periventricular)
  // and sometimes not (like ms lesions)." FreeSurfer's LUT lists them among the brain's structures,
  // which is how a table of label values has to list everything it can write -- but a hypointensity
  // is a finding, and a finding's laterality is a property of the lesion rather than of the anatomy.
  // Periventricular caps are usually bilateral; MS lesions are wherever they are.
  //
  // So they go where the cyst and the effusion go: a Findings branch inside what they are in. And
  // for the same reason as the cyst, the left and right labels are NOT gathered into a pair -- two
  // lesions on two sides are two findings, not one structure with two halves. Ron, on cysts: "They
  // can be singular or plural and unilateral or bilateral."
  ...Object.fromEntries(
    ["WM-hypointensities", "Left-WM-hypointensities", "Right-WM-hypointensities",
     "non-WM-hypointensities", "Left-non-WM-hypointensities", "Right-non-WM-hypointensities"]
      .map((k) => [k, {
        system: "Findings",
        region: "Brain",
        why: "pathology, not anatomy: a hypointensity is a lesion, and its side is the lesion's " +
          "and not the brain's -- periventricular ones are often paired, MS lesions are not",
        by: "Ron Kikinis, 2026-09-07",
      } as NameOverride]),
  ),
  // TotalSegmentator's coarse task calls this "autochthon" and codes it SCT:244849004, "Deep muscle
  // of back" -- a region rather than a named muscle. Its own muscle task ships erector_spinae_left
  // and _right against SCT:44947003, "Erector spinae muscle", for the same anatomy. So the code
  // asserted here is not invented: it is the tool's own, from the task that looked closer.
  // WITHDRAWN, by the person who made it. Ron, 2026-09-03: "autochthon muscle of the back is for me
  // the erector spinae", which renamed this to Erector spinae with that muscle's code. Ron,
  // 2026-09-07, with TA2's Epaxial muscles open beside a comparison of the two terms: "TA2 has no
  // Autochthon muscle."
  //
  // He is right, and the correction was too narrow. `Autochthone Rückenmuskulatur` is the
  // topographic name for the intrinsic back muscles AS A GROUP -- the ones that develop, remain and
  // act within the back, all innervated by the posterior rami. TA2 files the same set under
  // EPAXIAL, an embryological name for very nearly the same muscles, and the group contains the
  // erector spinae, the transversospinal group, the spinotransversales, interspinales and
  // intertransversarii. The erector spinae is one layer of it, not the whole.
  //
  // So the segmenter's own name stands: TotalSegmentator maps `autochthon` to "Deep muscle of back"
  // (SCT:244849004), which is the group. Nothing to override -- and the label's relation to the
  // finer ones is recorded where relations belong, as `covers`.
  //
  // The renamed version shipped for four days and made ts:total's autochthon collide with
  // ts:abdominal_muscles' erector_spinae. That collision was real; the verdict on it was wrong.

  // The iliopsoas is the iliacus and the psoas major together. SNOMED's own SCT:68455001 is a
  // compound concept, so the label is not mis-coded -- it is mis-SHAPED, one region over two
  // muscles. TotalSegmentator ships psoas_major separately (SCT:64038003) and ships no iliacus at
  // all, so it cannot currently produce the pair. No rename fixes that, which is why this carries
  // `conflates` and no `name`: the module should show the caveat, not a tidier label.
  //
  // Why the merge matters for imaging rather than only for nomenclature: the two have DIFFERENT
  // ORIGINS and a shared insertion. Psoas major descends from the lumbar vertebrae; the iliacus
  // fans off the iliac fossa and the anterior inferior iliac spine; they join and insert together
  // on the lesser trochanter of the femur (en.wikipedia.org/wiki/Iliacus_muscle, and the anterior
  // hip illustration Ron sent, which shows the two converging). So one "iliopsoas" region runs from
  // the spine to the femur and merges a spinal muscle with a pelvic one -- any volume, length or
  // asymmetry measured on it is a measurement of neither muscle.
  //
  // The iliacus has no SNOMED code here because none could be SOURCED, which is not the same as
  // SNOMED lacking one. Ron: "Snowmed must have them, but perhaps not snowmed ct." He is right, and
  // the absence is a fact about this machine:
  //
  //   - TotalSegmentator's 413 labels          no iliacus
  //   - Slicer's terminology files             no iliacus (they are DICOM context-group SUBSETS,
  //                                            not the full SNOMED CT release)
  //   - SNOMED CT's own browser API            needs an affiliate license; returns 302 to login
  //   - Wikidata                               has the muscle (Q1508879) with FMA:22310 and
  //                                            TA2:2594, but no SNOMED id -- and it maps SNOMED for
  //                                            only 125 anatomical items in total, not even the
  //                                            psoas major code we know is real, so its silence
  //                                            here is evidence of nothing.
  //
  // And the boundary is a LICENSE, not a failed search. Ron: "snowmed has a strange
  // commercialization model in that most of it is behind a paywall but the ct terms are not, as
  // long as you use them in conjunction with ct." Read as: the SNOMED CT concepts that DICOM
  // incorporates into its context groups are usable in imaging work, and the rest of the release is
  // not free to redistribute.
  //
  // Which is exactly the set we already have, and the data says so plainly -- the segmenter's
  // terminology carries each code's DICOM context group beside it: cid 6116 MuscularAnatomy, 6114
  // OsseousAnatomyFindingorFeature, 4031 CommonAnatomicRegions, 3010 CardiovascularAnatomicLocations.
  // The iliacus is in none of them, so its code sits on the paid side rather than merely out of
  // reach.
  //
  // THE RULE THIS SETS. Use a SNOMED code when it arrives with a DICOM context group, and leave the
  // field absent otherwise. Do not look one up from a licensed release and paste it in: it would put
  // a paywalled identifier into a repository meant to be shareable, which is the kind of license
  // question this project does not reopen. FMA:22310 and TA2:2594 are recorded on the structure
  // instead, cited as Wikipedia's infobox rather than as terminology.
  //
  // NOTE that this label being unsplittable is a fact about TotalSegmentator, NOT about the anatomy
  // or about what a segmenter can do. Ron: "in the nninteractive segmentation they are two muscles.
  // So they are easily separateable." His current study already holds them as two regions -- they
  // are merely unnamed. So the module's job on this pair is NAMING two things that exist, and
  // `iliacus` is in KNOWN_STRUCTURES for exactly that reason.
  iliopsoas_left: {
    conflates: [{ name: "Iliacus muscle" }, { name: "Psoas major muscle", code: "SCT:64038003" }],
    why: "iliopsoas are actually two muscles",
    by: "Ron Kikinis",
  },
  iliopsoas_right: {
    conflates: [{ name: "Iliacus muscle" }, { name: "Psoas major muscle", code: "SCT:64038003" }],
    why: "iliopsoas are actually two muscles",
    by: "Ron Kikinis",
  },

  // ---- spelling and house style, not anatomy -------------------------------------------------
  //
  // These change no claim about what a structure IS. They are here rather than patched into the
  // generated table because the table is derived from the segmenter's CSV and is regenerated: a fix
  // made there would be silently undone by the next TotalSegmentator release, while one made here
  // survives and stays attributable.

  // "minius" is a typo in TotalSegmentator's own mapping CSV. The muscle is the gluteus MINIMUS,
  // and the segmenter's own label name (gluteus_minimus_left) spells it correctly -- only the
  // display meaning in the CSV is wrong, which is how it reached us.
  // "5th-Ventricle" is FreeSurfer's own label name for the cavum septi pellucidi, and it is a
  // misnomer on two counts: the space is not lined by ependyma, and it does not communicate with the
  // ventricular system. Calling it a ventricle puts it in company it does not keep -- and having just
  // defined that system as one continuous cavity, leaving the name would have contradicted the
  // definition in the same tree. Ron: "just don't call it 5th ventricle. Cavum septum pellucidy is
  // leggit."
  //
  // Here rather than in build-freesurfer.ts because that is where corrections live: the generated
  // table says what the tool asserts, and this says a person disagreed, with the reason attached.
  "5th-Ventricle": {
    // TA2's own English is "Cave of septum pellucidum"; the Latin Ron used is the same structure and
    // is what a radiologist writes. Kept as he gave it, with TA2's term recorded so the two are
    // findable from each other.
    name: "Cavum septi pellucidi",
    why: "\"fifth ventricle\" is a traditional misnomer -- the space is not lined by ependyma and " +
      "does not communicate with the ventricular system. TA2 calls it the cave of the septum " +
      "pellucidum, under Walls of lateral ventricle / Septum pellucidum",
    by: "Ron Kikinis",
  },

  // THE SIDE HAS TO SURVIVE THE CORRECTION. Both of these read "Gluteus minimus muscle" with no
  // side, so the pair's two members drew the same row -- a typo fix that introduced a worse fault
  // than the typo. Found by the collision queue once it started comparing the names we DISPLAY.
  gluteus_minimus_left: { name: "Gluteus minimus muscle, left", why: "\"minius\" is a typo for minimus", by: "Ron Kikinis" },
  gluteus_minimus_right: { name: "Gluteus minimus muscle, right", why: "\"minius\" is a typo for minimus", by: "Ron Kikinis" },

  // "Small Intestine" -- Title Case on a common noun is German orthography surfacing in English,
  // where every noun is capitalized, and TotalSegmentator is written by a German-speaking group.
  // Ron: "Small Intestine is probably because Jakob is a native German speaker." English anatomical
  // usage is sentence case, as TA2 writes it.
  //
  // But the label is also mis-SHAPED, and the fix for the capital exposed it. TA2's small intestine
  // is duodenum + jejunum + ileum; TotalSegmentator emits `duodenum` SEPARATELY, so `small_bowel` is
  // the remaining two. Calling it "Small intestine" made it the parent of the duodenum -- asserting
  // that one contains the other when the two labels are disjoint. So it is named for what it holds
  // and carries `conflates`, the same treatment as the iliopsoas: the module says the region covers
  // two structures rather than offering a tidier label that hides it.
  // ---- the pulmonary vessels: color carries the meaning ---------------------------------------
  //
  // Ron, having run ts:lung_vessels: "Both veins and arteries are red. The vein should be red and
  // the artery should be blue as we discussed previously."
  //
  // TotalSegmentator's CSV ships NO color for either, so both fell back to the Cardiovascular
  // system's single red and the segmentation drew the two vessel trees identically -- which erases
  // the one distinction the task exists to make.
  //
  // Red vein and blue artery is the reverse of the systemic convention, and deliberately so: the
  // colors track OXYGENATION, and the pulmonary circulation is the one place where the vein carries
  // oxygenated blood and the artery carries deoxygenated. It is the same fact that put these under
  // `Pulmonary vessels` in the tree rather than under an artery/vein split.
  lung_arteries: {
    rgb: [62, 108, 196],
    why: "the pulmonary artery carries deoxygenated blood, so it is the blue one",
    by: "Ron Kikinis",
  },
  lung_veins: {
    rgb: [198, 62, 58],
    why: "the pulmonary vein carries oxygenated blood, so it is the red one",
    by: "Ron Kikinis",
  },
  // ts:total's single pulmonary vein label, same structure and same reasoning.
  pulmonary_vein: {
    rgb: [198, 62, 58],
    why: "the pulmonary vein carries oxygenated blood, so it is the red one",
    by: "Ron Kikinis",
  },

  small_bowel: {
    name: "Jejunum and ileum",
    conflates: [{ name: "Jejunum" }, { name: "Ileum" }],
    why: "sentence case, and the label is the small intestine MINUS the duodenum, which is segmented separately",
    by: "Ron Kikinis",
  },
};

/**
 * The Help & Acknowledgment text for anything that shows structure names — built FROM the table
 * above, so it cannot fall out of step with what the application actually does.
 *
 * Ron, on the naming corrections: "Help should explain." A user who sees "Erector spinae" in
 * Albula and "autochthon" in TotalSegmentator's own output is owed the reason, and a user who
 * sees "Jejunum and ileum" is owed the fact that no tool here can separate the two. Writing this by
 * hand would mean a second place to update and a first place to forget.
 */
export function describeCorrections(): string {
  const rows = Object.entries(OVERRIDES)
    // Left and right are one correction to a reader, not two.
    .filter(([k], i, all) => !k.endsWith("_right") || !all.some(([j]) => j === k.replace(/_right$/, "_left")))
    .map(([label, o]) => {
      const from = `<code>${label.replace(/_(left|right)$/, "")}</code>`;
      // The side is stripped from the NAME as well as the label: one correction reads as one
      // line, and "autochthon -> Erector spinae muscle, left" would state a side the row is
      // deliberately not about.
      const to = o.name ? `<b>${o.name.replace(/,\s*(left|right)$/i, "")}</b>` : "";
      const covers = o.conflates?.length
        ? `covers ${o.conflates.map((c) => c.name).join(" and ")}, which no task here separates`
        : "";
      return `<li>${from}${to ? ` → ${to}` : ""} — ${o.why}${covers ? `; ${covers}` : ""} <i>(${o.by})</i></li>`;
    });
  return `<p>Structure names come from the segmenter that produced them, with its own coded
    identifiers (SNOMED CT) kept as asserted. Where we disagree, the disagreement is recorded rather
    than applied silently:</p><ul>${rows.join("")}</ul>
    <h4>The two vocabularies, and why there are two</h4>
    <p><b>SNOMED CT</b> answers <i>what is this?</i> — a concept identifier per structure
    (the liver is <code>SCT:10200004</code>), which is what a segmenter asserts about each label and
    what DICOM carries in a segmentation object. It says nothing about what contains what.
    <a href="https://www.snomed.org/">snomed.org</a>. Note that SNOMED CT is licensed: the concepts
    DICOM incorporates into its context groups are usable in imaging work, and the rest of the
    release is not free to redistribute, which is why a code here is either the segmenter's own or
    absent.</p>
    <p><b>Terminologia Anatomica (TA2)</b> answers <i>what is part of what?</i> — the international
    standard for anatomical terminology, maintained by FIPAT, and a containment hierarchy: the
    esophagus is in the digestive canal, in the digestive system, in the visceral systems.
    <a href="https://ta2viewer.openanatomy.org/">TA2 Viewer</a> ·
    <a href="https://fipat.library.dal.ca/">FIPAT</a>.</p>
    <p>Neither replaces the other, and this is not a preference: a vocabulary of identities cannot
    draw a tree, and a tree of containment cannot identify a segment inside a DICOM file. So each is
    used for the one job it does.</p>
    <p>The tree itself follows Terminologia Anatomica (TA2) for what contains what — TA2 supplies
    containment, SNOMED supplies identity, and neither replaces the other. Groups that no segmenter
    produces, such as <i>Thoracic cage</i>, exist only to hold what it did produce; a group with
    nothing in it is not shown. A parent groups its children, which does not always mean it is their
    sum: <i>Small intestine</i> holds two regions that are segmented separately and do not overlap.</p>`;
}
