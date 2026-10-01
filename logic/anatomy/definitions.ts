// WHAT A MODEL'S LABEL ACTUALLY COVERS -- the definition behind a name, per model, where it is
// known to differ from what the name promises.
//
// A model's label IS its own definition (Ron, 2026-09-20: "Both TS total and CADS omit the head of
// the rib. Any anatomist would say that this is not the complete rib, but TS calls it rib"), and
// nobody publishes the rule the annotators followed (looked for, 2026-09-20: TotalSegmentator's
// paper describes a workflow, not per-structure definitions; CADS, MultiTalent and Auto3DSeg
// inherit theirs from aggregated public datasets; MOOSE names its annotators, not their rules).
// So the definitions here are OBSERVED, on named cases, with the measurement that showed them --
// facts with a source, the way Mike Halle asked for the mapping to be attributable and Ron asked
// for measured facts rather than claims. An entry is one sentence a person reads on the segment,
// and a source line that says how it was found. Empty is the honest default: no entry, no claim.
//
// This is part of the ONE PLACE every mapping comes from (logic/anatomy/, logic/segment-naming.ts;
// Mike, 2026-09-19: "all mappings … in a uniform organized local location in your code so that
// multiple entry points can use it"): the model + label -> concept table is the catalog, the
// concept -> color table is its palette, and this is the model + label -> definition table.

export interface LabelDefinition {
  /** Which models (the task's ecosystem prefix, or the whole task name) the entry is about. */
  models: RegExp;
  /** Which labels, as the model writes them (`rib_left_6`). */
  labels: RegExp;
  /** One sentence: what the label includes and excludes. */
  says: string;
  /** How it was found: the cases, the measurement, the date. */
  source: string;
}

export const DEFINITIONS: LabelDefinition[] = [
  {
    models: /^(ts(\.v2)?:|auto3dseg|multitalent)/i,
    labels: /^rib_(left|right)_\d+$/,
    says: "The rib without its head: the proximal end stops short of the vertebra.",
    source: "Observed 2026-09-20 on two cases (C3N-01524, the thorax crop; NLST 218890 from Giebeler et al. 2026): " +
      "TotalSegmentator 1.5.6 and 2.6, Auto3DSeg and MultiTalent end the sixth right rib within 2–4 mm of each other at the " +
      "proximal end, all short of the vertebral body. Whether any model includes part of the neck was not measured.",
  },
  {
    models: /^cads:/i,
    labels: /^rib_(left|right)_\d+$/,
    says: "Reaches further toward the vertebra than TotalSegmentator on one of two cases; the head is not confirmed.",
    source: "Observed 2026-09-20: on C3N-01524 CADS matched TotalSegmentator v2 within 1–2 mm (24.0 vs 24.4 ml); " +
      "on NLST 218890 its proximal end lay about 14 mm further toward the vertebra than the TotalSegmentator family's.",
  },
  {
    models: /^moose/i,
    labels: /^rib_(left|right)_\d+$|^ribcage$/,
    says: "Reaches further toward the vertebra than TotalSegmentator; pieces near the spine may be separate.",
    source: "Observed 2026-09-20: on NLST 218890 MOOSE's ribs model ended about 15 mm further proximally than TotalSegmentator's; " +
      "on C3N-01524 its all-bones model's single 'ribcage' label carried small separate pieces beside the spine where the heads and necks are.",
  },
];

/** The definition of `label` as `model` writes it, when one is known; otherwise nothing, which is the honest answer. */
export function definitionFor(model: string | undefined | null, label: string | undefined | null): LabelDefinition | undefined {
  if (!model || !label) return undefined;
  return DEFINITIONS.find((d) => d.models.test(model) && d.labels.test(label));
}
