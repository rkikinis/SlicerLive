/**
 * Every vessel a shade of red or blue, by OXYGENATION.
 *
 * Ron: "I would like all the vessels to be shades of blue and red, depending on oxygenation. They
 * should not be identical individually, only when the hierarchy collapses." And, looking at a
 * rendering: "the inguinal vessels are shades of yellow."
 *
 * They were. The segmenter's own table hands vessels colors from no scheme at all -- the common
 * iliac artery gold (217, 162, 48), the common iliac vein yellow (197, 174, 37), the inferior vena
 * cava GREEN (110, 165, 54) -- and seventeen more ship no color, so they fell back to one red for
 * the whole cardiovascular system, which is what made veins and arteries indistinguishable earlier.
 *
 * A RULE, NOT MORE OVERRIDES. There is already an asserted-color mechanism in `overrides.ts` and it
 * is the wrong tool here: it takes one structure at a time, and the next segmenter with a differently
 * named iliac artery would be gold again. This derives the color from what the structure IS.
 *
 * OXYGENATION, NOT VESSEL WALL. Artery and vein describe direction relative to the heart; the
 * pulmonary artery carries deoxygenated blood and the pulmonary vein oxygenated. So the pulmonary
 * pair is the reverse of the systemic pair, which is the same fact that files them under `Pulmonary
 * vessels` in the tree rather than under an artery/vein split.
 *
 * DISTINCT INDIVIDUALLY, IDENTICAL COLLAPSED. Each structure gets its own shade within its family's
 * band, so two vessels side by side are told apart; collapsing the branch replaces them with the
 * group's single color, which is `TISSUE_COLOUR` in `hierarchy.ts` and already works that way. The
 * shade is derived from the KEY, not from a counter, so it does not change between loads or depend
 * on which other structures happen to be present.
 */

import table from "./totalsegmentator.json" with { type: "json" };

/** Which side of the circulation carries oxygen here. */
export type Oxygenation = "oxygenated" | "deoxygenated";

/**
 * First match wins. Written against structure KEYS rather than names, because keys are what every
 * segmenter agrees on and names vary ("Common iliac artery, left" against "left common iliac artery").
 *
 * The order matters in one place: `pulmonary_artery` and `lung_arteries` must be tested before any
 * general artery rule, or the one artery that carries deoxygenated blood comes out red.
 */
const VESSEL_RULES: [RegExp, Oxygenation][] = [
  // ── the pulmonary circulation, where the convention inverts ──
  [/^(pulmonary_artery|lung_arteries|pulmonary_trunk)/, "deoxygenated"],
  [/^(pulmonary_vein|lung_veins)/, "oxygenated"],
  // ── the heart's chambers, by the blood they hold: the right heart receives the body's venous blood, the left
  // heart the lungs' oxygenated blood. Ron, 2026-09-24, looking at the heart-chambers segmentation: "the right
  // atrium should be blueish. Not red. But left atrium should be reddish, not yellow." The ventricles follow the
  // same convention. Anchored to `heart_`, so the brain's ventricles are not touched. ──
  [/^heart_(atrium|ventricle)_right$/, "deoxygenated"],
  [/^(heart_(atrium|ventricle)_left|atrial_appendage_left|left_ventricular_outflow_tract)$/, "oxygenated"],
  // ── the portal system: venous blood from the gut, deoxygenated ──
  [/^(portal_vein|splenic_vein|superior_mesenteric_vein|inferior_mesenteric_vein|hepatic_vein)/, "deoxygenated"],
  // ── everything else: systemic, so artery means oxygenated ──
  [/(^|_)(artery|arteries|aorta|arterial|trunk_brachiocephalic|brachiocephalic_trunk)($|_)/, "oxygenated"],
  [/(^|_)(vein|veins|vena|venous|jugular)($|_)/, "deoxygenated"],
  // Names that do not carry the word but are vessels all the same.
  [/^aorta/, "oxygenated"],
  [/^(superior_vena_cava|inferior_vena_cava)/, "deoxygenated"],
];

/** The oxygenation this structure carries, or undefined if it is not a vessel. */
export function oxygenationOf(key: string): Oxygenation | undefined {
  const k = key.toLowerCase();
  for (const [re, ox] of VESSEL_RULES) if (re.test(k)) return ox;
  return undefined;
}

/**
 * A stable, well-spread position in [0, 1) for this key.
 *
 * FNV-1a, then the golden-ratio conjugate. A plain hash clusters -- neighboring keys such as
 * `iliac_artery_left` and `iliac_artery_right` differ in one character and would land next to each
 * other, which is exactly the pair that has to be told apart. Multiplying by the golden ratio and
 * taking the fraction spreads any sequence of inputs as evenly as it can be spread.
 */
function spread(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ((h / 0x100000000) * 0.618033988749895) % 1;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * The band each family occupies: a hue range, and saturation / lightness ranges.
 *
 * PASTEL, because Ron set that policy for the whole palette: "colors never fully saturated. Pick a
 * pleasant pastel." The bands are narrow in hue so the family reads as one color at a glance and
 * wide enough in lightness that individual vessels separate. Red is given a little more hue room
 * than blue because the eye discriminates less well among dark blues.
 */
const BANDS: Record<Oxygenation, { h: [number, number]; s: [number, number]; l: [number, number] }> = {
  // ONE RED AND ONE BLUE. Ron asked for "shades of blue and red", and a shade is the same hue at a
  // different lightness -- so the hue range is only as wide as stays unambiguous, and the separation
  // between individual vessels is bought with lightness and saturation instead.
  //
  // The first version bought it with hue: 348-22 and 198-234, about 35 degrees each, whose ends stop
  // being red and blue. Measured against Mike Halle's reference rendering: the common carotid came
  // out hue 17 at 56% lightness -- #c3785b, terracotta, most of the way back to the gold Ron
  // objected to in the first place -- and the left brachiocephalic vein hue 201 at 49%, #558aa6,
  // teal. Hue is the thing he has complained about twice; it is the thing to hold.
  //
  // AND THE SEPARATION SURVIVED THE NARROWING, which the first two attempts said it would not.
  // Lightness is monotonic in rank while hue and saturation walk in coprime strides, so closing the
  // hue band removes most of one channel's contribution -- ΔE fell to 3.1 and the test's floor of 4
  // failed. What recovered it was SATURATION, not hue: chroma is (1-|2l-1|)*s, so the pale end of a
  // wide lightness band has almost no chroma left to differ in. Trimming lightness to 0.48-0.76 and
  // raising saturation to 0.32-0.50 gives ΔE 4.4 -- better than the wide-hue version managed -- with
  // every artery unmistakably red and every vein unmistakably blue.
  //
  // The ends land at #a9525f..#dea4a0 and #5176a9..#a0abde. Mike's two flat colors are #e08a84 and
  // #9fa9d6, so the pale end of each family is close to his; he pays for the tidiness by making
  // every artery identical, which is the distinction Ron asked to keep.
  // The saturation ceiling is Ron's, not a tuning knob: "colors never fully saturated. Pick a
  // pleasant pastel", which this file's own test reads as S <= 0.60. 0.70 at the pale end broke it
  // (the pulmonary artery came out 0.63), so the band tops out at 0.58 and the pale end gives up a
  // little chroma to stay inside a constraint that predates it.
  oxygenated: { h: [349, 11], s: [0.34, 0.58], l: [0.46, 0.72] },
  deoxygenated: { h: [213, 237], s: [0.34, 0.58], l: [0.46, 0.72] },
};

/**
 * RANK AMONG THE KNOWN VESSELS OF ITS FAMILY, which is what makes the shades actually distinct.
 *
 * The hash below spreads well on average and still collided badly in practice: measured over the 25
 * vessels TotalSegmentator ships, the closest pair came out at CIE76 ΔE 0.3 -- the portal vein and
 * the left internal jugular, indistinguishable. Ron's requirement is that individual vessels are NOT
 * identical, so an average is not good enough.
 *
 * Ranking the family's members and spreading them evenly across the band gives the largest minimum
 * separation available. Sorted by key, so it depends on the catalog rather than on load order and
 * a given vessel keeps its color between sessions. A key the catalog does not know -- another
 * segmenter's naming -- falls back to the hash, which is still far better than the segmenter's own
 * gold and green.
 */
const RANKS: Map<string, { i: number; n: number }> = (() => {
  const fam = new Map<Oxygenation, string[]>([["oxygenated", []], ["deoxygenated", []]]);
  const structures = (table as { structures: Record<string, unknown> }).structures ?? {};
  for (const key of Object.keys(structures)) {
    const ox = oxygenationOf(key);
    if (ox) fam.get(ox)!.push(key.toLowerCase());
  }
  const out = new Map<string, { i: number; n: number }>();
  for (const keys of fam.values()) {
    keys.sort();
    for (let i = 0; i < keys.length; i++) out.set(keys[i], { i, n: keys.length });
  }
  return out;
})();

/**
 * This vessel's own shade, 0-255.
 *
 * Two independent quantities are varied so that neighbors differ in more than one way: lightness
 * takes the spread directly, hue takes a second decorrelated pass over it. Varying lightness alone
 * would make a family read as a grayscale ramp of one hue, which is harder to tell apart than a
 * genuine spread.
 */
export function vesselShade(key: string): [number, number, number] | undefined {
  const ox = oxygenationOf(key);
  if (!ox) return undefined;
  const b = BANDS[ox];
  const r = RANKS.get(key.toLowerCase());
  const n = Math.max(r?.n ?? 1, 1);
  // LIGHTNESS IS MONOTONIC IN RANK, so two known vessels can never share it. The first version
  // derived lightness from (t + u) mod 1, which wrapped and let two different ranks land on the same
  // value: measured ΔE 0.3 between the portal vein and the left internal jugular, then 1.8 between
  // the inferior vena cava and the pulmonary arteries. Monotonic removes the failure mode rather
  // than making it less likely.
  const t = r ? (r.i + 0.5) / n : spread(key);
  // Hue and saturation walk the band in coprime strides, so ranked neighbors differ in all three
  // channels rather than only getting lighter -- a pure lightness ramp of one hue is much harder to
  // read as separate structures.
  const uh = r ? ((r.i * 5 + 1) % n) / n : (t * 2.399963229728653) % 1;
  // SATURATION FOLLOWS LIGHTNESS instead of striding independently, and it is not a stylistic choice.
  //
  // Chroma in HSL is (1 - |2l - 1|) * s, so it collapses as lightness rises: whoever ranks highest
  // gets the palest lightness AND, if saturation happens to stride low there, almost no color at
  // all. Ron: "I like them, with the exception of the subclavians. They are too pale." The
  // subclavians are simply what lands at the top of the band.
  //
  // Raising saturation as lightness rises keeps the chroma roughly even across the band. Measured
  // over the 25 vessels: the closest pair improves from ΔE 4.4 to 5.1 -- BETTER separation, because
  // a cluster of washed-out near-grays at the pale end was costing more than the independent stride
  // was buying -- and the palest artery goes from #dea4a0 (Lab chroma 23) to #e9928b (chroma 37),
  // which is Mike Halle's reference #e08a84 (chroma 36) almost exactly.
  const us = t;
  // The red band wraps through 0, so interpolate in a continuous space and fold afterwards.
  const hueSpan = b.h[1] >= b.h[0] ? b.h[1] - b.h[0] : b.h[1] + 360 - b.h[0];
  const h = b.h[0] + uh * hueSpan;
  const sat = b.s[0] + us * (b.s[1] - b.s[0]);
  const l = b.l[0] + t * (b.l[1] - b.l[0]);
  return hslToRgb(h, sat, l);
}
