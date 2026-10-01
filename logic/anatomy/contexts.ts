// WHAT A VESSEL TREE SITS INSIDE, and what is in front of it -- the anatomy behind the
// "Vessels in context" look (render/demos/looks.ts).
//
// Ron, 2026-09-20, on the whole-body case with TotalSegmentator's total, lung_vessels and
// liver_vessels: "my preferred initial view for this data set is ribcage off, lungs transparent,
// vessels visible. Same for liver." The rule generalizes: a vessel tree is read inside the organ
// that holds it, so the organ goes see-through and the vessels stay opaque; the bones in front
// of the thorax and the upper abdomen -- the ribs, the sternum, the costal cartilages -- are
// hidden, because they are what stands between the eye and the lungs and the liver.
//
// Part of the ONE PLACE every mapping comes from (logic/anatomy/, logic/segment-naming.ts): the
// labels are matched by the model's key (`structure`: lung_upper_lobe_left, pulmonary_artery,
// rib_left_6), the same keys the catalog and the hierarchy use. A vessel tree with no entry here is left alone, which is the honest default.

export interface VesselContext {
  /** The vessel labels (the model's), as a pattern. */
  vessels: RegExp;
  /** The organ they run through: goes see-through when the vessels are in the scene. */
  container: RegExp;
  /** What the person reads on the row; the tooltip. */
  says: string;
}

/** The bones between the eye and the thoracic and upper-abdominal organs: hidden by the look. */
export const RIBCAGE = /^(rib_(left|right)_\d+|ribs?|sternum|costal_cartilages?)$/i;

export const VESSEL_CONTEXTS: VesselContext[] = [
  { vessels: /^lung_vessels$|^lung_(arteries|veins)$|^pulmonary_(artery|vein)/i, container: /^lung$|^lung_(left|right)$|^lung_(upper|middle|lower)_lobe_/i, says: "The pulmonary vessels, inside see-through lungs." },
  { vessels: /^liver_vessels$|^portal_vein|^hepatic_vein|^liver_(arteries|veins)$/i, container: /^liver$/i, says: "The hepatic vessels, inside a see-through liver." },
  { vessels: /^coronary_arteries$|^coronary/i, container: /^heart(_|$)|myocardium|ventricle|atrium/i, says: "The coronary arteries, on a see-through heart." },
  { vessels: /^kidney_(artery|vein)|^renal_(artery|vein)/i, container: /^kidney(_|$)/i, says: "The renal vessels, inside see-through kidneys." },
  { vessels: /^brain_(artery|vein|vessels)|^cerebral_(artery|vein)|^dural_venous/i, container: /^brain$|^cerebrum|^cerebellum/i, says: "The cerebral vessels, inside a see-through brain." },
];

/** The context a vessel label belongs to, if any. */
export const vesselContextOf = (label: string): VesselContext | undefined => VESSEL_CONTEXTS.find((c) => c.vessels.test(label));
