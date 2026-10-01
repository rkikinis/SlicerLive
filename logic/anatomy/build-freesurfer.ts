// Builds logic/anatomy/freesurfer.json from FreeSurfer's own FreeSurferColorLUT.txt.
//
// WHY FROM FREESURFER'S LUT AND NOT FASTSURFER'S. FastSurfer ships both: FreeSurferColorLUT.txt
// (1791 entries) and its own FastSurfer_ColorLUT.tsv (79). Ron: "Use the colors and organization as
// presented by the freesurfer people. I assume that fastsurfer has just used that, but don't assume.
// Check the facts." Checked, on the real result Ron produced -- 95 segments, values 2..2035:
//
//   * FastSurfer's TSV is a SUBSET and an incomplete one. It lists 31 left-hemisphere cortical
//     regions and only 14 right, and does not contain 2035 at all -- a value that result HAS. So 17
//     of the 95 segments arrived named `label_2003` ... `label_2035`, all right-hemisphere cortex.
//     FreeSurfer's LUT names and colors every one of the 95.
//   * Where the two overlap the colors agree, with ONE exception: FastSurfer gives Left-VentralDC
//     (28) rgb(165,42,42), which is the RIGHT side's color. FreeSurfer distinguishes them --
//     left 145,42,42, right 165,42,42. Left and right made identical is a mistake, not a choice.
//   * The colors in the .seg.nrrd itself are neither: dcmqi generates a hue per segment, so
//     Left-Cerebral-White-Matter arrives green where FreeSurfer says white.
//
// So FreeSurfer's LUT is the authority for both name and color, exactly as Ron asked.
//
// THE ORGANIZATION is FreeSurfer's own too. Their LUT states it in the file: the aseg labels, then
// "the cortical labels ... are the same as in colortable_desikan_killiany.txt, except that left
// hemisphere has 1000 added to the index and the right has 2000 added". The lobe each
// Desikan-Killiany gyrus belongs to is from that atlas's own paper (Desikan et al., NeuroImage
// 31(3), 2006), which is how the regions are presented there.
//
//   deno run -A logic/anatomy/build-freesurfer.ts <path-to-FreeSurferColorLUT.txt>

const SRC = Deno.args[0];
if (!SRC) { console.error("usage: build-freesurfer.ts <FreeSurferColorLUT.txt>"); Deno.exit(2); }

/** Desikan-Killiany gyri by lobe, as that atlas presents them. Keyed by the LUT's own suffix. */
const LOBE: Record<string, string> = {
  superiorfrontal: "Frontal lobe", rostralmiddlefrontal: "Frontal lobe", caudalmiddlefrontal: "Frontal lobe",
  parsopercularis: "Frontal lobe", parstriangularis: "Frontal lobe", parsorbitalis: "Frontal lobe",
  lateralorbitofrontal: "Frontal lobe", medialorbitofrontal: "Frontal lobe", precentral: "Frontal lobe",
  paracentral: "Frontal lobe", frontalpole: "Frontal lobe",
  superiorparietal: "Parietal lobe", inferiorparietal: "Parietal lobe", supramarginal: "Parietal lobe",
  postcentral: "Parietal lobe", precuneus: "Parietal lobe",
  superiortemporal: "Temporal lobe", middletemporal: "Temporal lobe", inferiortemporal: "Temporal lobe",
  bankssts: "Temporal lobe", fusiform: "Temporal lobe", transversetemporal: "Temporal lobe",
  entorhinal: "Temporal lobe", temporalpole: "Temporal lobe", parahippocampal: "Temporal lobe",
  lateraloccipital: "Occipital lobe", lingual: "Occipital lobe", cuneus: "Occipital lobe",
  pericalcarine: "Occipital lobe",
  rostralanteriorcingulate: "Cingulate cortex", caudalanteriorcingulate: "Cingulate cortex",
  posteriorcingulate: "Cingulate cortex", isthmuscingulate: "Cingulate cortex",
  insula: "Insula",
};

/** The aseg structures FreeSurfer segments, grouped the way it presents them. */
const ASEG_GROUP: Record<string, string> = {
  "Cerebral-White-Matter": "Cerebral white matter", "Cerebral-Cortex": "Cerebral cortex",
  "Lateral-Ventricle": "Ventricular system", "Inf-Lat-Vent": "Ventricular system",
  "3rd-Ventricle": "Ventricular system", "4th-Ventricle": "Ventricular system",
  // NOT components of the ventricular system, on Ron's own definition of it -- "its components are
  // left and right lateral ventricle, third ventricle, aqueduct and fourth ventricle" -- and for the
  // reason that definition rests on, which is that the system is ONE COMMUNICATING cavity.
  //   * The fifth ventricle is the cavum septi pellucidi: a normal variant between the leaves of the
  //     septum, named a ventricle by tradition, and it does not communicate with the others.
  //   * FreeSurfer's `CSF` is its catch-all class for fluid that is NOT in a labeled ventricle --
  //     largely extraventricular -- so filing it with the cavity would say the opposite of what it is.
  // The cave of the septum pellucidum, which is where TA2 puts it: Walls of lateral ventricle /
  // Septum pellucidum / Cave of septum pellucidum. Not the ventricle, and not a leftover either.
  "5th-Ventricle": "Septum pellucidum",
  // TA2 files cerebrospinal fluid under the ARACHNOID, beside the subarachnoid space it fills, the
  // granulations that resorb it and the trabeculae. Ron, having looked again: "actually, you were
  // right and I made a mistake: archnoid is the parent and the others are inside that hierarchy."
  // FreeSurfer's `CSF` is its catch-all for fluid NOT inside a labeled ventricle -- extraventricular
  // fluid, which is what the subarachnoid space holds -- so the placement fits the label as well as
  // the vocabulary.
  //
  // Ron's other remark still stands and is not a placement question: "I think that it doesn't fit
  // anywhere cleanly." It does not. Everything else in this table is tissue or a bounded space -- a
  // thing with a location -- and CSF is a SUBSTANCE, occupying spaces without being any of them and
  // circulating between four in turn: made by the choroid plexus in the walls of the lateral
  // ventricle, filling the ventricular system, leaving into the subarachnoid space, resorbed at the
  // arachnoid granulations. A containment tree asks "what is this inside of", and for a circulating
  // fluid the honest answer is "several things, one after another". TA2 chose one of the four and we
  // follow it; the other three are still true, and no tree can say so. That is the argument for
  // facets, stated by a single substance.
  "CSF": "Arachnoid",
  "Cerebellum-White-Matter": "Cerebellum", "Cerebellum-Cortex": "Cerebellum", "Cerebellum-Exterior": "Cerebellum",
  "Thalamus": "Subcortical gray matter", "Thalamus-Proper": "Subcortical gray matter",
  "Caudate": "Subcortical gray matter", "Putamen": "Subcortical gray matter",
  "Pallidum": "Subcortical gray matter", "Hippocampus": "Subcortical gray matter",
  "Amygdala": "Subcortical gray matter", "Accumbens-area": "Subcortical gray matter",
  "VentralDC": "Subcortical gray matter", "Substancia-Nigra": "Subcortical gray matter",
  "Brain-Stem": "Brainstem",
  // NOT the ventricular system, and not a leftover. Ron: "The choroid plexus is not ventricle",
  // then, of the walls of the lateral ventricle: "It is also the home of the choroid plexus."
  //
  // TA2 LISTS IT TWICE, and both are true. Under Meninges / Leptomeninges / Pia / Cranial pia,
  // because it IS tela choroidea -- pia invaginated into the cavity and covered by ependyma. And
  // under Walls of lateral ventricle as "Choroid plexus of lateral ventricle", beside the choroid
  // fissure, the tenia of fornix and the lamina affixa. The second is the one that fits what
  // FreeSurfer actually labels: an aseg resolves the plexus of the LATERAL ventricle, and the walls
  // are where a person looking at that label would go for it.
  //
  // Worth noticing that even TA2 needed the same structure in two places. That is the argument for
  // facets, made by the reference vocabulary itself rather than by us.
  "choroid-plexus": "Walls of lateral ventricle",
  "vessel": "Other brain structures", "WM-hypointensities": "Other brain structures",
  "non-WM-hypointensities": "Other brain structures", "Optic-Chiasm": "Other brain structures", "undetermined": "Other brain structures",
};

/** "ctx-lh-superiorfrontal" -> "Superior frontal gyrus, left". Readable, without inventing anatomy:
 *  the LUT's own compound word is split on the known suffixes rather than guessed at. */
const GYRUS_WORDS: Record<string, string> = {
  superiorfrontal: "Superior frontal gyrus", rostralmiddlefrontal: "Rostral middle frontal gyrus",
  caudalmiddlefrontal: "Caudal middle frontal gyrus", parsopercularis: "Pars opercularis",
  parstriangularis: "Pars triangularis", parsorbitalis: "Pars orbitalis",
  lateralorbitofrontal: "Lateral orbitofrontal cortex", medialorbitofrontal: "Medial orbitofrontal cortex",
  precentral: "Precentral gyrus", paracentral: "Paracentral lobule", frontalpole: "Frontal pole",
  superiorparietal: "Superior parietal cortex", inferiorparietal: "Inferior parietal cortex",
  supramarginal: "Supramarginal gyrus", postcentral: "Postcentral gyrus", precuneus: "Precuneus",
  superiortemporal: "Superior temporal gyrus", middletemporal: "Middle temporal gyrus",
  inferiortemporal: "Inferior temporal gyrus", bankssts: "Banks of the superior temporal sulcus",
  fusiform: "Fusiform gyrus", transversetemporal: "Transverse temporal gyrus",
  entorhinal: "Entorhinal cortex", temporalpole: "Temporal pole", parahippocampal: "Parahippocampal gyrus",
  lateraloccipital: "Lateral occipital cortex", lingual: "Lingual gyrus", cuneus: "Cuneus",
  pericalcarine: "Pericalcarine cortex",
  rostralanteriorcingulate: "Rostral anterior cingulate cortex",
  caudalanteriorcingulate: "Caudal anterior cingulate cortex",
  posteriorcingulate: "Posterior cingulate cortex", isthmuscingulate: "Isthmus of the cingulate gyrus",
  insula: "Insula", unknown: "Unknown", corpuscallosum: "Corpus callosum",
};

const ASEG_WORDS: Record<string, string> = {
  "Cerebral-White-Matter": "Cerebral white matter", "Cerebral-Cortex": "Cerebral cortex",
  "Lateral-Ventricle": "Lateral ventricle", "Inf-Lat-Vent": "Inferior horn of the lateral ventricle",
  "3rd-Ventricle": "Third ventricle", "4th-Ventricle": "Fourth ventricle", "5th-Ventricle": "Fifth ventricle",
  "CSF": "Cerebrospinal fluid", "Cerebellum-White-Matter": "Cerebellar white matter",
  "Cerebellum-Cortex": "Cerebellar cortex", "Cerebellum-Exterior": "Cerebellar exterior",
  "Thalamus": "Thalamus", "Thalamus-Proper": "Thalamus", "Caudate": "Caudate nucleus",
  "Putamen": "Putamen", "Pallidum": "Globus pallidus", "Hippocampus": "Hippocampus",
  "Amygdala": "Amygdala", "Accumbens-area": "Nucleus accumbens",
  "VentralDC": "Ventral diencephalon", "Substancia-Nigra": "Substantia nigra",
  "Brain-Stem": "Brainstem", "choroid-plexus": "Choroid plexus", "vessel": "Vessel",
  "WM-hypointensities": "White matter hypointensities",
  "non-WM-hypointensities": "Non-white-matter hypointensities",
  "Optic-Chiasm": "Optic chiasm", "undetermined": "Undetermined",
};

interface Entry {
  name: string; system: string; rgb: [number, number, number];
  type: string; mod?: string; freesurfer: string; labelValue: number;
}

/** LUT entries that duplicate a sided pair of the same structure. See the note at the skip below. */
const LEGACY_ALIAS = new Set([218]);   // Amygdala, beside Left-Amygdala (18) and Right-Amygdala (54)

const structures: Record<string, Entry> = {};
const byLabel: Record<string, string> = {};

for (const line of (await Deno.readTextFile(SRC)).split("\n")) {
  const bare = line.split("#")[0].trim();
  if (!bare) continue;
  const p = bare.split(/\s+/);
  if (p.length < 5 || !/^\d+$/.test(p[0])) continue;
  const id = Number(p[0]), fsName = p[1];
  const rgb: [number, number, number] = [Number(p[2]), Number(p[3]), Number(p[4])];

  let name: string | undefined, system: string | undefined, type: string | undefined, mod: string | undefined;

  const ctx = /^ctx-(lh|rh)-(.+)$/.exec(fsName);
  if (ctx && LOBE[ctx[2]]) {
    const side = ctx[1] === "lh" ? "left" : "right";
    type = GYRUS_WORDS[ctx[2]] ?? ctx[2];
    name = `${type}, ${side}`;
    system = LOBE[ctx[2]];
    mod = side === "left" ? "Left" : "Right";
  } else {
    const side = /^Left-/.test(fsName) ? "Left" : /^Right-/.test(fsName) ? "Right" : undefined;
    const stem = fsName.replace(/^(Left|Right)-/, "");
    if (ASEG_GROUP[stem]) {
      type = ASEG_WORDS[stem] ?? stem;
      name = side ? `${type}, ${side.toLowerCase()}` : type;
      system = ASEG_GROUP[stem];
      mod = side;
    }
  }
  if (!name || !system || !type) continue;      // not a structure this table covers
  // A LEGACY ALIAS IS NOT A STRUCTURE. FreeSurferColorLUT.txt carries entries from several eras and
  // several tools: label 218 "Amygdala" sits beside 18 and 54, the left and right amygdala that
  // aseg actually writes. Keeping it produced a third row -- "Amygdala, both sides" -- beside a
  // structure that is paired and always has been. Ron: "Amygdala should be left and right, like
  // hippocampus."
  //
  // Only where a SIDED PAIR of the same type already exists, and only for this one label: the
  // sideless hypointensities (77, 80) are different -- aseg does write 77, and a bilateral finding
  // is a real thing to report.
  if (LEGACY_ALIAS.has(id)) continue;

  structures[fsName] = { name, system, rgb, type, ...(mod ? { mod } : {}), freesurfer: fsName, labelValue: id };
  byLabel[String(id)] = fsName;
}

const out = {
  source: "FreeSurferColorLUT.txt, as shipped with FastSurfer (FastSurferCNN/config). Names, colours " +
    "and the 1000/2000 hemisphere offset are FreeSurfer's own; the lobe each Desikan-Killiany gyrus " +
    "belongs to is from Desikan et al., NeuroImage 31(3), 2006.",
  generatedBy: "logic/anatomy/build-freesurfer.ts",
  structures,
  byLabel,
};
await Deno.writeTextFile(
  new URL("./freesurfer.json", import.meta.url),
  JSON.stringify(out, null, 1) + "\n",
);
console.log(`freesurfer.json: ${Object.keys(structures).length} structures, ${Object.keys(byLabel).length} label values`);
