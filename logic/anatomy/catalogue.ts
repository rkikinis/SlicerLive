// THE SEGMENTER CATALOG: one record per label name a segmentation model can write, merged from
// the two generated tables so the rest of the application asks one place.
//
//   totalsegmentator.json -- built from the mapping CSV shipped inside the TotalSegmentator Slicer
//                            extension: 413 labels, readable names, the extension's colors where it
//                            has them (it has none for 190 of them), and Ron's corrections applied
//                            downstream through overrides.ts.
//   harmonized.json       -- built from the IDC segmentation-comparison workbook (Giebeler et al.,
//                            JMI 2026, reviewed by David Clunie): 331 labels across five models,
//                            with a color for every one.
//
// WHO WINS. The harmonized table is the reviewed source for what a label MEANS, so its code, type
// and laterality win where it has them -- and only where it has them: it carries no code for five
// labels the extension codes (prevertebral, insular_cortex, styloid_process, ventricle_trigone,
// lung_nodules), and a missing value must not erase a present one. The extension's readable NAME
// stays where it exists, because the harmonized meanings are SNOMED's own wording ("Structure of
// scalenus anterior muscle") and the names are what a person reads. Color comes from whichever
// has one; where both do, they agree (checked 2026-09-12, no differences).
import ts from "./totalsegmentator.json" with { type: "json" };
import harmonized from "./harmonized.json" with { type: "json" };

export interface CatalogueStructure {
  name: string;
  system: string;
  /** `SCT:10200004` -- SNOMED CT. */
  code?: string;
  /** The coded type MEANING, the key a left/right pair shares ("Kidney" for both kidneys). */
  type?: string;
  /** "Left" | "Right". */
  mod?: string;
  rgb?: [number, number, number];
  /** The SNOMED category when it is not "Anatomical Structure" (a cyst, an implant). */
  category?: string;
  /** For a finding: the structure it is IN, and on which side. */
  region?: string;
  regionMod?: string;
  /** Which models write this label: `ts:total`, `moose/organs`, `auto3dseg`. Absent: the extension only. */
  models?: string[];
}

// A JSON import types `rgb` as `number[]` rather than the 3-tuple it is, and a plain cast cannot
// narrow it; the generators guarantee the shape, writing an rgb only when all three channels parsed.
const A = (ts as { structures: unknown }).structures as Record<string, CatalogueStructure>;
const B = (harmonized as { structures: unknown }).structures as Record<string, CatalogueStructure>;

function merge(a: CatalogueStructure | undefined, b: CatalogueStructure | undefined): CatalogueStructure {
  if (!a) return b!;
  if (!b) return a;
  return {
    ...a,
    code: b.code ?? a.code,
    type: b.type ?? a.type,
    mod: b.mod ?? a.mod,
    rgb: a.rgb ?? b.rgb,
    ...(a.category ?? b.category ? { category: a.category ?? b.category } : {}),
    ...(b.models ? { models: b.models } : {}),
  };
}

/**
 * LABELS A MODEL WRITES THAT NO SOURCE MAPS, written here by hand until the source has them. Each says the model, and
 * a code only where a sourced table already gives that structure one (MOOSE's or TotalSegmentator's own rows for the
 * sided bones); otherwise none -- an invented code is worse than a missing one (overrides.ts). Neither table wins over
 * these, because neither has them; when one gains a label, its row wins and the entry here can go.
 *
 * MOOSE's clin_ct_all_bones_v1 (Ron, 2026-10-31: "It seems that moose did not get the color treatment yet"): its six
 * labels are skull, sternum, clavicle, scapula, ribcage and spine; MOOSE's mapping (moose_snomed_mapping.csv, at our
 * pinned commit and at its main of 2026-10-31) has no rows for this model, so the four without a namesake in another
 * model's table came out Unclassified in the segmenter's own colors. Clavicle and scapula are both sides as one label.
 * "ribcage" is the ribs (the sternum is a label of its own in the same model); "spine" the vertebral column. Codes for
 * the last two: none sourced -- Slicer's General Anatomy list has the cervical, thoracic and lumbar spine apart and
 * "Bone of thorax" (sternum and thoracic spine included), neither the same structure.
 */
const ADDED: Record<string, CatalogueStructure> = {
  clavicle: { name: "Clavicle", system: "Skeletal system", code: "SCT:51299004", type: "Clavicle", models: ["moose/clin_ct_all_bones"] },
  scapula: { name: "Scapula", system: "Skeletal system", code: "SCT:79601000", type: "Scapula", models: ["moose/clin_ct_all_bones"] },
  ribcage: { name: "Ribs", system: "Skeletal system", models: ["moose/clin_ct_all_bones"] },
  spine: { name: "Spine", system: "Skeletal system", models: ["moose/clin_ct_all_bones"] },
};

/** Every label either table knows, keyed by the label name the segmenter writes, and the ones added above. */
export const SEGMENTER_STRUCTURES: Record<string, CatalogueStructure> = {
  ...ADDED,
  ...Object.fromEntries([...new Set([...Object.keys(A), ...Object.keys(B)])].map((k) => [k, merge(A[k], B[k])])),
};

/** Where the harmonized table came from, for anything that cites it. */
export const HARMONIZED_SOURCE = (harmonized as { source: Record<string, string> }).source;
/** And MOOSE's own CSV, read ahead of it. */
export const MOOSE_SOURCE = (harmonized as { mooseSource: Record<string, string> }).mooseSource;

/**
 * THE MAPPING'S IDENTITY, for a SEG to carry. Ron, 2026-09-12, on names changing under us:
 * "versioning raises its head." A SEG's codes come from these two files at these commits; when
 * a code is corrected upstream, every SEG written before differs from every one after, and
 * without this nothing in the file says why. Short, because DICOM's SoftwareVersions is 64
 * characters a value: the repository's last path segment and the commit.
 */
export function mappingVersions(): string[] {
  const short = (src: Record<string, string> | undefined) =>
    src ? `${src.repo.split("/").pop()} ${src.commit.slice(0, 8)}` : "";
  return [short(HARMONIZED_SOURCE), short(MOOSE_SOURCE)].filter(Boolean);
}
