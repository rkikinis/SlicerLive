// The paper behind a segmentation network, for the "what does this output mean" link.
//
// Ron's requirement for the haversack module: "Input data, output data, network selection and
// pointer to the paper that describes the output and organization of the output. That paper can be
// viewed in the default browser."
//
// KEYED BY ECOSYSTEM, NOT BY TASK. haversack names tasks `ecosystem:task` and exposes 87 of them
// (`ts:`, `moose:`, `mrsegmentator:`), but a paper describes a model FAMILY and its label set, not
// one checkpoint. So five or six entries cover everything, and the rest is discovery: Ron: "It
// sounds good that we onboard one or two trained networks, but in general lets assume that people
// will do it at runtime." Networks are therefore listed from haversack at runtime; this table only
// says what is known about the families we have actually read the papers for.
//
// EVERY FIELD HERE WAS SOURCED, and the source is named. Nothing is from recall: a fabricated DOI
// looks exactly like a real one, and Ron's standard on acknowledgment is that it is "the
// difference between stealing and leveraging". Verified through the Crossref API, which is the
// registry of record and is open, after RSNA's own page refused the request.
//
// An ecosystem with no entry is NOT an error. `paperFor` returns null and the caller should say
// "no paper on file" and offer a search, which is honest and is what happens for a network the user
// brought themselves.

/** A citation, as printed, with somewhere to click. */
import { ecosystemOf } from "../task-name.ts";
export interface ModelPaper {
  /** The model family, as haversack namespaces it: the part before the colon in a task name. */
  ecosystem: string;
  /** Human name of the family. */
  name: string;
  title: string;
  /** First authors, abbreviated, as a reference list would print them. */
  authors: string;
  journal: string;
  year: number;
  doi: string;
  /** Where a click goes. `https://doi.org/<doi>` resolves for every entry here. */
  url: string;
  /** The project's own repository, where the label list actually lives. */
  repo?: string;
  /** Where WE got this citation, so a reader can check it rather than trust it. */
  sourcedFrom: string;
  /**
   * Further papers the project itself asks users to cite, per module or component.
   *
   * FastSurfer is why this exists: its documentation names a main paper and then one per module
   * (VINN, CerebNet, HypVINN, corpus callosum, LIT), to be cited according to what was actually
   * run. A single paper field would have forced a choice between under-citing and inventing a rule.
   */
  alsoCite?: ModelPaper[];
}

const PAPERS: ModelPaper[] = [
  {
    ecosystem: "ts",
    name: "TotalSegmentator",
    title: "TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images",
    authors: "Wasserthal J., Breit H., Meyer M., Pradella M., Hinck D., Sauter A., et al.",
    journal: "Radiology: Artificial Intelligence 5(5)",
    year: 2023,
    doi: "10.1148/ryai.230024",
    url: "https://doi.org/10.1148/ryai.230024",
    repo: "https://github.com/wasserth/TotalSegmentator",
    // Ron: "The wasserthal paper is now a radiology paper" -- both his own concordance paper and
    // Slicer's TotalSegmentator extension still cite the 2022 arXiv preprint (2208.05868), so the
    // journal version was looked up and confirmed rather than assumed from either.
    sourcedFrom: "Crossref api.crossref.org/works/10.1148/ryai.230024; repo from Slicer's TotalSegmentator extension",
  },
  {
    ecosystem: "moose",
    name: "MOOSE",
    title: "Fully Automated, Semantic Segmentation of Whole-Body 18F-FDG PET/CT Images Based on Data-Centric Artificial Intelligence",
    authors: "Shiyam Sundar L. K., et al.",
    journal: "Journal of Nuclear Medicine 63(12)",
    year: 2022,
    doi: "10.2967/jnumed.122.264063",
    url: "https://doi.org/10.2967/jnumed.122.264063",
    repo: "https://github.com/ENHANCE-PET/MOOSE",
    sourcedFrom: "reference list of PMC13050620 (Giebeler et al. 2026), confirmed via Crossref",
  },
  {
    ecosystem: "fastsurfer",
    name: "FastSurfer",
    title: "FastSurfer - A fast and accurate deep learning based neuroimaging pipeline",
    authors: "Henschel L., Conjeti S., Estrada S., Diers K., Fischl B., Reuter M.",
    journal: "NeuroImage 219",
    year: 2020,
    doi: "10.1016/j.neuroimage.2020.117012",
    url: "https://doi.org/10.1016/j.neuroimage.2020.117012",
    repo: "https://deep-mi.org/FastSurfer",
    // The ecosystem KEY IS UNVERIFIED against haversack. FastSurfer is an engine rather than a
    // checkpoint and its tasks enter the catalog only once its runtime is installed -- on this
    // machine `haversack tasks` lists ts:, moose: and mrsegmentator: only. If the prefix differs,
    // this key is what needs changing.
    sourcedFrom: "deep-mi.org/FastSurfer/dev (the project's own citation request); every DOI confirmed via Crossref",
    alsoCite: [
      {
        ecosystem: "fastsurfer",
        name: "FastSurferVINN",
        title: "FastSurferVINN: Building resolution-independence into deep learning segmentation methods - A solution for HighRes brain MRI",
        authors: "Henschel L., K\u00fcgler D., Reuter M.",
        journal: "NeuroImage 251",
        year: 2022,
        doi: "10.1016/j.neuroimage.2022.118933",
        url: "https://doi.org/10.1016/j.neuroimage.2022.118933",
        sourcedFrom: "deep-mi.org/FastSurfer/dev, confirmed via Crossref",
      },
    ],
  },
];

/**
 * The method paper shared by every task here.
 *
 * All 87 of haversack's tasks are nnU-Net v2 checkpoints, so this describes HOW they were trained
 * whatever family they came from. Offered alongside the family's own paper rather than instead of
 * it.
 */
export const METHOD_PAPER: ModelPaper = {
  ecosystem: "*",
  name: "nnU-Net",
  title: "nnU-Net: a self-configuring method for deep learning-based biomedical image segmentation",
  authors: "Isensee F., Jaeger P. F., Kohl S. A. A., Petersen J., Maier-Hein K. H.",
  journal: "Nature Methods 18(2)",
  year: 2020,
  doi: "10.1038/s41592-020-01008-z",
  url: "https://doi.org/10.1038/s41592-020-01008-z",
  sourcedFrom: "Crossref api.crossref.org/works/10.1038/s41592-020-01008-z",
};

/**
 * The paper on comparing these models' outputs to each other.
 *
 * This is the one that answers Ron's question most directly — not what one network produces, but
 * how the families' label sets and outputs relate, which is exactly "the organization of the
 * output" across more than one of them. He pointed at it himself and is a co-author, alongside
 * Steve Pieper, Jakob Wasserthal (TotalSegmentator) and Lalith Kumar Shiyam Sundar (MOOSE).
 */
export const CONCORDANCE_PAPER: ModelPaper = {
  ecosystem: "*",
  name: "Model concordance",
  title: "In search of truth: evaluating concordance of AI-based anatomy segmentation models",
  authors: "Giebeler L., Krishnaswamy D., Clunie D., Wasserthal J., Shiyam Sundar L. K., Diaz-Pinto A., Maier-Hein K. H., Xu M., Menze B., Pieper S., Kikinis R., Fedorov A.",
  journal: "Journal of Medical Imaging 13(6)",
  year: 2026,
  doi: "10.1117/1.JMI.13.6.062204",
  url: "https://doi.org/10.1117/1.JMI.13.6.062204",
  sourcedFrom: "pmc.ncbi.nlm.nih.gov/articles/PMC13050620, confirmed via Crossref",
};

/**
 * The paper for a task name or an ecosystem, or `null` when none is on file.
 *
 * Accepts either form — `ts:total_fast` or `ts` — because the caller has whichever haversack gave
 * it. A bare task name with no ecosystem prefix cannot be attributed and returns null rather than
 * guessing: haversack resolves bare names across ecosystems, and this module does not.
 */
export function paperFor(task: string | undefined | null): ModelPaper | null {
  if (!task) return null;
  const eco = ecosystemOf(task);   // `ts.v2:total_fast`, `ts:total_fast` and `ts` all read as `ts`
  return PAPERS.find((p) => p.ecosystem === eco) ?? null;
}

/** Everything on file, for a credits list. */
export function allPapers(): ModelPaper[] {
  return [...PAPERS, METHOD_PAPER, CONCORDANCE_PAPER];
}

/** One line, as a reference list would print it. */
export function formatCitation(p: ModelPaper): string {
  return `${p.authors} ${p.title}. ${p.journal}, ${p.year}. doi:${p.doi}`;
}
