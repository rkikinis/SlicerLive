// Grouping segments by what they ARE, when the segmenter said so.
//
// WHY THIS EXISTS ALONGSIDE segment-groups.ts. That module infers groups by measuring the CT under
// each segment, because nnInteractive numbers regions and names nothing. Ron: "the current data set
// is a random data set labled with nn interactive. Many data sets will start with total
// segmentator or one of the alternatives such as moose. There, we will have more materials to do
// the grouping (anatomical names), but manual regroup might still be needed."
//
// So there are two sources of grouping and they are not equal. A name from TotalSegmentator is a
// statement about anatomy; a Hounsfield mean is an inference from density. When a name is present
// it wins outright — intensity cannot tell liver from muscle and never will, whereas the name says
// so exactly. When no name is present the measurement is all there is. Neither is the final answer:
// both produce a STARTING grouping that the user corrects by dragging, and a correction is a record
// of its own, not an edit in place.
//
// NOMENCLATURE: SNOMED CT. Ron asked first for the English TA2 (ta2viewer.openanatomy.org, Michael
// Halle's OpenAnatomy), then withdrew it: "FIPAT is in a decades long civil war. Let's go with
// snowmed for now." FIPAT is TA2's custodian, so an unsettled custodian means an unsettled
// identifier, and hanging a data model off one is borrowing someone else's argument.
//
// SNOMED CT is what TotalSegmentator itself asserts for every structure it produces, so using it
// costs no translation and no guessing: the `code` field carries the segmenter's own assertion
// through unchanged. "For now" is on the record — if TA2 settles, `code` is where its identifier
// goes, and the note in build-totalsegmentator.ts says what would have to change.
//
// The GROUP names below are plain English names for the anatomical systems. They are not claimed to
// be any vocabulary's canonical terms — SNOMED CT has body-system concepts and this does not pretend
// to have looked them up, because the CSV carries codes per structure and none per system. They are
// labels on a grouping, and the grouping is what the module is for. Two of them name things no
// anatomical vocabulary does: `Findings` (effusion, hemorrhage, lesion — pathology) and `Devices`
// (a dental crown or implant). A liver lesion is a finding, not the alimentary system.
import { SEGMENTER_STRUCTURES } from "./anatomy/catalogue.ts";
import freesurferJson from "./anatomy/freesurfer.json" with { type: "json" };
import { classify, type SegmentGroup, type SegmentStats } from "./segment-groups.ts";
import { type ConflatedPart, type NameOverride, OVERRIDES } from "./anatomy/overrides.ts";
import { KNOWN_STRUCTURES } from "./anatomy/known-structures.ts";
import { vesselShade } from "./anatomy/vessel-colour.ts";
import { paletteRgb } from "./anatomy/palettes.ts";
import { ecosystemOf } from "./task-name.ts";
import { lookupTerm } from "./anatomy/terminology.ts";

/** One structure a segmenter can produce, as the segmenter itself describes it. */
export interface NamedStructure {
  /**
   * The catalog key this resolved to — `3rd-Ventricle`, `liver`, `ctx-rh-fusiform`.
   *
   * Carried so a caller can record WHICH structure it decided on, rather than only what to call it.
   * A display name is ambiguous where two catalogs share one: Brainstem, Third ventricle and
   * Fourth ventricle exist in both, so a segment stored with only its name resolves to the wrong
   * catalog's entry and lands in the wrong branch of the tree.
   */
  key?: string;
  /** Readable form, from the segmenter's own terminology: `vertebrae_L3` → `L3 vertebra`. */
  name: string;
  /** The anatomical system it belongs to — the group. */
  system: string;
  /** `SCT:10200004` — SNOMED CT. The segmenter's own, unless `origin` says otherwise. */
  code?: string;
  /** The segmenter's recommended display color, 0-255. */
  rgb?: [number, number, number];
  /**
   * Where the name and code come from.
   *
   * `acquired` — read from the segmenter's terminology, unchanged.
   * `asserted` — a person disagreed with the segmenter; `asSegmented` keeps what it said and
   * `note`/`by` say why and who. The same distinction core/model/frame.ts draws for geometry: a
   * fact read from data and a fact stated by a person are not the same kind of fact.
   */
  origin?: "acquired" | "asserted";
  /** What the segmenter called it, kept whenever we display something else. */
  asSegmented?: { name: string; code?: string };
  /**
   * Distinct structures merged under this one label.
   *
   * Present means the label is mis-SHAPED rather than mis-named: no rename fixes it, only a
   * re-segmentation, and a caller should say so rather than show a tidier name.
   */
  conflates?: ConflatedPart[];
  /** The reason for the disagreement, in the words of whoever asserted it. */
  note?: string;
  /** Who asserted it. */
  by?: string;
  /** Identifiers in other vocabularies, e.g. `FMA:22310`, where no SNOMED code could be sourced. */
  otherIds?: string[];
}

/** Default to `acquired`, but never overwrite an entry that already says who asserted it. */
function withOrigin(s: NamedStructure): NamedStructure {
  return s.origin ? { ...s } : { ...s, origin: "acquired" };
}

/**
 * A VESSEL'S COLOR COMES FROM ITS OXYGENATION, not from the segmenter's table.
 *
 * Ron: "I would like all the vessels to be shades of blue and red, depending on oxygenation," and,
 * looking at a rendering, "the inguinal vessels are shades of yellow." They were: the table ships the
 * common iliac artery gold, the common iliac vein yellow and the inferior vena cava GREEN, and
 * seventeen more vessels ship no color at all and fell back to one red for the whole cardiovascular
 * system -- which is what made arteries and veins indistinguishable.
 *
 * Applied here rather than as entries in `overrides.ts` because it is a rule about what a structure
 * IS. An override list would have to be extended for every segmenter that names an iliac artery
 * differently, and the next one would be gold again.
 *
 * PRECEDENCE: an explicit human assertion still wins -- `corrected` applies OVERRIDES after this --
 * because a person who wrote down a color and a reason has said something this cannot know.
 */
function vesselColoured(key: string, base: NamedStructure): NamedStructure {
  const shade = vesselShade(key);
  return shade ? { ...base, rgb: shade } : base;
}

/** Apply a correction to what the segmenter said, keeping both sides. The color scheme in use (palettes.ts)
 *  has the last word on color where it names the structure: v1 is the rules above, v2 and later are tables. */
function corrected(key: string, baseIn: NamedStructure): NamedStructure {
  const r = correctedV1(key, baseIn);
  const scheme = paletteRgb(key);
  return scheme ? { ...r, rgb: scheme } : r;
}

function correctedV1(key: string, baseIn: NamedStructure): NamedStructure {
  const base = vesselColoured(key, baseIn);
  const o: NameOverride | undefined = OVERRIDES[key];
  if (!o) return { ...base, key };
  return {
    ...base,
    key,
    ...(o.name ? { name: o.name } : {}),
    ...(o.code ? { code: o.code } : {}),
    // An asserted color, for the case where the segmenter ships none and the system fallback
    // collapses two structures into one hue (the pulmonary artery and vein).
    ...(o.rgb ? { rgb: o.rgb } : {}),
    ...(o.conflates ? { conflates: o.conflates } : {}),
    origin: "asserted",
    asSegmented: { name: base.name, ...(base.code ? { code: base.code } : {}) },
    note: o.why,
    by: o.by,
  };
}

// Both generated tables, merged in catalogue.ts -- the extension's readable names, the harmonized
// mapping's codes. The shapes agree field for field; NamedStructure only adds `key` and `origin`.
const FROM_SEGMENTER = SEGMENTER_STRUCTURES as unknown as Record<string, NamedStructure>;

/**
 * The segmenter's catalog, widened by the structures only a person can name.
 *
 * The segmenter's entries come first and are never shadowed: where a tool produces a structure, its
 * assertion about that structure is the one to keep. KNOWN_STRUCTURES fills what the tool cannot
 * produce at all, which is why a hand-named iliacus can resolve while `iliopsoas` continues to
 * report, accurately, that it is two muscles in one region.
 */
/**
 * FreeSurfer's own structures, for the FastSurfer family.
 *
 * Keyed by FreeSurfer's label name (`ctx-rh-fusiform`, `Left-Hippocampus`), which is what a
 * FreeSurfer-family result carries -- when it carries one at all. See FREESURFER_BY_LABEL for the
 * ones that do not.
 */
const FROM_FREESURFER = freesurferJson.structures as unknown as Record<string, NamedStructure>;

/**
 * FreeSurfer label VALUE -> its key, because a name is not always there to look up.
 *
 * On Ron's first FastSurfer result, 17 of 95 segments arrived called `label_2003` ... `label_2035` --
 * every one of them right-hemisphere cortex -- because haversack names from FastSurfer's own
 * ColorLUT.tsv and that file is missing them. A name lookup cannot rescue a segment that has no
 * name. The label VALUE identifies it exactly: FreeSurfer's numbering is the identity, 2035 is
 * ctx-rh-insula wherever it is written, and it is now kept as `sourceLabelValue` through the
 * renumbering that fits the labelmap into a byte.
 */
const FREESURFER_BY_LABEL = freesurferJson.byLabel as Record<string, string>;

const STRUCTURES: Record<string, NamedStructure> = { ...KNOWN_STRUCTURES, ...FROM_FREESURFER, ...FROM_SEGMENTER };

/** Display name → key, so a segment already carrying a readable name still resolves. */
const BY_DISPLAY = new Map<string, string>();
for (const [key, v] of Object.entries(STRUCTURES)) BY_DISPLAY.set(v.name.toLowerCase(), key);

/**
 * The structure a segment name refers to, or `null` if nothing recognizes it.
 *
 * Tries the segmenter's own key first, then a normalized form, then the readable name — because a
 * DICOM SEG round-trip may carry `SegmentLabel` as either `vertebrae_L3` or `L3 vertebra`, and
 * which one depends on who wrote the file rather than on anything we control.
 */
export function lookupStructure(label: string | undefined | null, context?: string): NamedStructure | null {
  if (!label) return null;
  const raw = label.trim();
  // A TERMINOLOGY LOADED AT RUNTIME COMES FIRST -- a lab's own term or SlicerHeart's leaflet is
  // what the person meant, whatever the vendored tables say about a name they happen to share;
  // and the segmentation's own context, when it names one, before every other loaded terminology.
  const t = lookupTerm(raw, context);
  if (t) return { ...(t.entry as NamedStructure), key: t.entry.key, origin: "acquired" };
  if (STRUCTURES[raw]) return corrected(raw, withOrigin(STRUCTURES[raw]));

  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (STRUCTURES[key]) return corrected(key, withOrigin(STRUCTURES[key]));

  const byName = BY_DISPLAY.get(raw.toLowerCase());
  return byName ? corrected(byName, withOrigin(STRUCTURES[byName])) : null;
}

/**
 * What a segment IS, in codes, for writing a DICOM SEG: the harmonized type code with its own
 * meaning, the laterality as a modifier, and the category when it is not an anatomical structure.
 * Everything optional: an unrecognized label gets an empty object and the writer's generic code.
 */
export function codesFor(label: string | undefined | null, context?: string): { code?: string; type?: string; mod?: string; category?: string } {
  const st = lookupStructure(label, context);
  if (!st) return {};
  const c = st as NamedStructure & { type?: string; mod?: string; category?: string };
  return {
    ...(c.code ? { code: c.code } : {}),
    ...(c.type ? { type: c.type } : {}),
    ...(c.mod ? { mod: c.mod } : {}),
    ...(c.category ? { category: c.category } : {}),
  };
}

/**
 * The FreeSurfer structure a LABEL VALUE names, or null if it is not one.
 *
 * Only meaningful for a result from the FreeSurfer family -- 17 means the left hippocampus there and
 * nothing in particular anywhere else -- so the caller decides when to ask, from the task's
 * ecosystem, rather than this guessing from a bare number.
 */
/**
 * Ecosystems whose label VALUES are FreeSurfer's numbering.
 *
 * A table rather than a test on the task name, for the same reason the presentation presets are one:
 * the next package that adopts FreeSurfer's numbering is an entry here, not a new branch.
 */
const FREESURFER_NUMBERING = new Set(["fastsurfer", "freesurfer"]);

/** Does this task number its labels the FreeSurfer way? Keyed on the ecosystem -- the part before
 *  the colon -- so every task a package publishes is covered. */
export function usesFreesurferNumbering(task: string): boolean {
  return FREESURFER_NUMBERING.has(ecosystemOf(task));
}

/**
 * The FreeSurfer structure a NAME refers to, searching only FreeSurfer's own table.
 *
 * Three display names exist in both catalogs -- "Brainstem", "Third ventricle", "Fourth
 * ventricle" -- and the general lookup resolves them to TotalSegmentator's entry, which is right for
 * a TotalSegmentator result and wrong for this one: different color, different grouping. When the
 * SEG says which family produced it, that ambiguity is already settled and there is no reason to
 * re-introduce it.
 */
export function freesurferStructureByName(name: string | undefined | null): NamedStructure | null {
  if (!name) return null;
  const raw = name.trim();
  if (FROM_FREESURFER[raw]) return corrected(raw, withOrigin(STRUCTURES[raw]));
  const lower = raw.toLowerCase();
  for (const [key, v] of Object.entries(FROM_FREESURFER)) {
    if (v.name.toLowerCase() === lower) return corrected(key, withOrigin(STRUCTURES[key]));
  }
  return null;
}

export function freesurferStructureFor(labelValue: number | undefined | null): NamedStructure | null {
  if (labelValue === undefined || labelValue === null) return null;
  const key = FREESURFER_BY_LABEL[String(labelValue)];
  return key ? corrected(key, withOrigin(STRUCTURES[key])) : null;
}

/** A segment as the grouping sees it: a label value, and whatever name came with it. */
export interface NamedSegment {
  labelValue: number;
  name?: string;
}

/** Starting opacity per group. Bone opaque, everything else readable through. */
const SYSTEM_OPACITY: Record<string, number> = {
  "Skeletal system": 1.0,
  "Findings": 1.0,
  "Devices": 1.0,
  "Respiratory system": 0.55,
  "Body regions": 0.35,
};
const DEFAULT_OPACITY = 0.9;

/**
 * Display order. Structures a reader looks THROUGH come first, so the sliders read top to bottom
 * roughly as depth — the same reasoning as the intensity grouping's order.
 */
const SYSTEM_ORDER = [
  "Body regions",
  "Integument",
  "Muscular system",
  "Alimentary system",
  "Urinary system",
  "Genital system",
  "Endocrine glands",
  "Lymphoid system",
  "Respiratory system",
  "Cardiovascular system",
  "Nervous system",
  "Sense organs",
  "Skeletal system",
  "Findings",
  "Devices",
];

/**
 * Group segments, preferring names and falling back to measurement.
 *
 * A segment whose name is recognized goes to its anatomical system. One whose name is missing or
 * unrecognized is classified from `stats` if a measurement for it was supplied, and otherwise
 * dropped into `Ungrouped` — visible and obviously unfinished, rather than quietly filed somewhere
 * plausible. A wrong group that looks right is worse than one that admits it.
 *
 * Empty groups never appear: a chest study has no dentition and should not show a slider for it.
 */
export function groupByAnatomy(
  segments: readonly NamedSegment[],
  stats: readonly SegmentStats[] = [],
): SegmentGroup[] {
  const statFor = new Map(stats.map((s) => [s.labelValue, s]));
  const members = new Map<string, number[]>();

  for (const seg of segments) {
    const known = lookupStructure(seg.name);
    const stat = statFor.get(seg.labelValue);
    const group = known ? known.system : stat ? classify(stat) : "Ungrouped";
    if (!members.has(group)) members.set(group, []);
    members.get(group)!.push(seg.labelValue);
  }

  // Systems in anatomical order, then any intensity-derived or Ungrouped names after them, so a
  // mixed segmentation reads as "what is known" followed by "what is not".
  const rest = [...members.keys()].filter((g) => !SYSTEM_ORDER.includes(g)).sort();
  return [...SYSTEM_ORDER, ...rest]
    .filter((g) => members.has(g))
    .map((name) => ({
      name,
      members: members.get(name)!.sort((a, b) => a - b),
      opacity: SYSTEM_OPACITY[name] ?? DEFAULT_OPACITY,
    }));
}

/**
 * A color for a structure that has none, chosen by its anatomical system.
 *
 * 200 of the segmenter's 413 structures carry no recommended color -- the heart, the thyroid, the
 * pulmonary vein, most vertebrae -- so the fallback is the COMMON case and not an edge. dcmqi fills
 * the gap with an arbitrary hue per segment, which is why a whole-body result arrives looking like a
 * box of highlighters even when every name resolved.
 *
 * These are ours and are stated as such: one color per system, in the register anatomical
 * illustration uses -- bone pale, muscle red-brown, vessels red and blue, nerve pale yellow. A
 * reader can then tell a system at a glance, which is the property the random hues destroy. It is a
 * weaker claim than a published per-structure color, so it is used only where there is none.
 */
export function systemColour(system: string): [number, number, number] {
  switch (system) {
    case "Skeletal system": return [222, 208, 180];
    case "Muscular system": return [166, 84, 70];
    case "Cardiovascular system": return [188, 60, 52];
    case "Respiratory system": return [150, 190, 216];
    case "Alimentary system": return [200, 150, 110];
    case "Urinary system": return [180, 168, 100];
    case "Genital system": return [176, 140, 160];
    case "Endocrine glands": return [150, 176, 120];
    case "Nervous system": return [228, 222, 160];
    case "Sense organs": return [150, 160, 200];
    case "Lymphoid system": return [140, 120, 168];
    case "Integument": return [216, 184, 168];
    case "Body regions": return [170, 170, 170];
    case "Findings": return [230, 120, 120];
    case "Devices": return [190, 190, 200];
    default: return [160, 160, 160];
  }
}

/** How many of these segments carry a name this recognizes. Lets a caller say which mode it is in. */
export function namedFraction(segments: readonly NamedSegment[]): number {
  if (segments.length === 0) return 0;
  return segments.filter((s) => lookupStructure(s.name)).length / segments.length;
}
