import { assert, assertEquals } from "jsr:@std/assert";
import { oxygenationOf, vesselShade } from "./vessel-colour.ts";
import { lookupStructure } from "../segment-naming.ts";
import table from "./totalsegmentator.json" with { type: "json" };

const structures = (table as { structures: Record<string, { name: string; rgb?: number[] }> }).structures;
const vessels = Object.keys(structures).filter((k) => oxygenationOf(k));

/** CIE76 over sRGB, the same measure the group palette was solved against. */
function lab([r, g, b]: readonly number[]): [number, number, number] {
  const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
  const h = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = h(X / 0.95047), fy = h(Y), fz = h(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dE = (a: readonly number[], b: readonly number[]) => {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

Deno.test("the catalogue's vessels are all classified", () => {
  // If this drops, a vessel has been added that the rules do not recognize and it will render in
  // whatever color the segmenter shipped -- gold, in the case that started this.
  assert(vessels.length >= 25, `only ${vessels.length} vessels classified`);
  for (const k of ["aorta", "iliac_artery_left", "iliac_vena_right", "inferior_vena_cava",
    "pulmonary_artery", "pulmonary_vein", "coronary_arteries", "internal_jugular_vein_left"]) {
    assert(oxygenationOf(k), `${k} is not classified as a vessel`);
  }
});

Deno.test("red where the blood carries oxygen, blue where it does not", () => {
  for (const k of vessels) {
    const c = vesselShade(k)!;
    const red = c[0] > c[2];
    assertEquals(red, oxygenationOf(k) === "oxygenated", `${k} has the wrong hue: rgb(${c})`);
  }
  // THE PULMONARY INVERSION, named explicitly because it is the case a reader will think is a bug.
  // Artery and vein describe direction relative to the heart, not oxygenation.
  const pa = vesselShade("pulmonary_artery")!, pv = vesselShade("pulmonary_vein")!;
  assert(pa[2] > pa[0], `the pulmonary ARTERY carries deoxygenated blood and must be blue, got rgb(${pa})`);
  assert(pv[0] > pv[2], `the pulmonary VEIN carries oxygenated blood and must be red, got rgb(${pv})`);
});

Deno.test("individually distinct — Ron: 'they should not be identical individually'", () => {
  let worst = Infinity, pair = "";
  for (let i = 0; i < vessels.length; i++) {
    for (let j = i + 1; j < vessels.length; j++) {
      const d = dE(vesselShade(vessels[i])!, vesselShade(vessels[j])!);
      if (d < worst) { worst = d; pair = `${vessels[i]} vs ${vessels[j]}`; }
    }
  }
  console.log(`${vessels.length} vessels, closest pair ΔE ${worst.toFixed(1)} — ${pair}`);
  // 2.3 is the just-noticeable difference; the floor is set above it with room, and NOT at the group
  // palette's ΔE 10, which is unreachable for thirteen colors inside one hue band. Two earlier
  // attempts scored 0.3 and 1.8 -- indistinguishable in the view -- so this is the assertion that
  // says the spread is real rather than average.
  assert(worst >= 4, `closest vessel pair is ΔE ${worst.toFixed(1)} (${pair}); they must be tellable apart`);
});

Deno.test("pastel, like the rest of the palette", () => {
  // Ron: "colors never fully saturated. Pick a pleasant pastel."
  for (const k of vessels) {
    const [r, g, b] = vesselShade(k)!.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    const sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    assert(sat <= 0.60, `${k} is too saturated: S=${sat.toFixed(2)}`);
    assert(l >= 0.42 && l <= 0.86, `${k} is outside the lightness band: L=${l.toFixed(2)}`);
  }
});

Deno.test("the rule reaches the structure lookup, replacing the segmenter's colour", () => {
  // The whole point: what the app actually reads must be the derived shade, not the table's.
  assertEquals(structures["iliac_artery_left"].rgb, [217, 162, 48], "the table still ships gold");
  const s = lookupStructure("iliac_artery_left")!;
  assert(s.rgb, "the looked-up structure carries a colour");
  assert(s.rgb![0] > s.rgb![2], `the iliac artery must be red, got rgb(${s.rgb})`);
  const ivc = lookupStructure("inferior_vena_cava")!;
  assertEquals(structures["inferior_vena_cava"].rgb, [110, 165, 54], "the table still ships green");
  assert(ivc.rgb![2] > ivc.rgb![0], `the inferior vena cava must be blue, got rgb(${ivc.rgb})`);
});

// THE PATH THE APPLICATION ACTUALLY TAKES, which is not the one the test above takes.
//
// The test above calls lookupStructure directly and passed from the start. Meanwhile the app loaded a
// stored SEG, and load-panel consulted the catalog ONLY for FreeSurfer-numbered tasks -- so a
// TotalSegmentator result fell through to the RGB in the DICOM file, which is the segmenter's own
// gold. Ron: "Iliac is back to gold." A rule that is right in the module and never called is not a
// rule, and the only test that could have caught it is one that goes the way the caller goes.
//
// This asserts the resolution step load-panel performs: name -> structure -> color.
Deno.test("a segment resolved BY NAME, as a loaded SEG is, gets the vessel colour", () => {
  for (const [displayName, wantRed] of [
    ["Common iliac artery, left", true],
    ["Common iliac vein, right", false],
    ["Inferior vena cava", false],
    ["Aorta", true],
    ["Pulmonary artery", false],   // deoxygenated: the inversion
    ["Pulmonary vein", true],
  ] as [string, boolean][]) {
    const s = lookupStructure(displayName);
    assert(s, `${displayName} does not resolve by display name at all`);
    assert(s!.rgb, `${displayName} resolves but carries no colour`);
    const [r, , b] = s!.rgb!;
    assertEquals(
      r > b,
      wantRed,
      `${displayName} should be ${wantRed ? "red" : "blue"}, got rgb(${s!.rgb})`,
    );
  }
});

Deno.test("every artery is red and every vein is blue, at any shade", () => {
  // WHY A HUE TEST AND NOT AN EYEballing. The bands were once 35 degrees wide, which bought the
  // separation the test above measures and cost the thing Ron actually asked for: the common carotid
  // came out hue 17 (#c3785b, terracotta) and the left brachiocephalic vein hue 201 (#558aa6, teal).
  // Both passed every assertion in this file at the time. "Shades of blue and red" is a statement
  // about hue, so it is checked as one.
  const hueOf = (c: number[]) => {
    const [r, g, b] = c.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  for (const k of vessels) {
    const c = vesselShade(k)!;
    const h = hueOf(c);
    if (oxygenationOf(k) === "oxygenated") {
      // Red, allowing the wrap through 0. 15 degrees is where salmon starts becoming peach.
      assert(h >= 345 || h <= 15, `${k} is not a shade of red: hue ${h.toFixed(0)}`);
      assert(c[0] > c[2], `${k} should be red-dominant, got rgb(${c})`);
    } else {
      // Blue. Below 210 it turns teal, above 240 it turns violet.
      assert(h >= 210 && h <= 240, `${k} is not a shade of blue: hue ${h.toFixed(0)}`);
      assert(c[2] > c[0], `${k} should be blue-dominant, got rgb(${c})`);
    }
  }
});

// Ron, 2026-09-24: "the right atrium should be blueish. Not red. But left atrium should be reddish, not yellow."
Deno.test("the heart's chambers are colored by the blood they hold: right blue, left red; the brain's ventricles are not vessels", () => {
  for (const k of ["heart_atrium_right", "heart_ventricle_right"]) assertEquals(oxygenationOf(k), "deoxygenated", k);
  for (const k of ["heart_atrium_left", "heart_ventricle_left", "atrial_appendage_left", "left_ventricular_outflow_tract"]) assertEquals(oxygenationOf(k), "oxygenated", k);
  for (const k of ["ventricle_body_right", "third_ventricle", "heart_myocardium", "heart"]) assertEquals(oxygenationOf(k), undefined, k);
  const [r1, , b1] = vesselShade("heart_atrium_right")!; assert(b1 > r1, `right atrium should be bluish, got ${vesselShade("heart_atrium_right")}`);
  const [r2, g2, b2] = vesselShade("heart_atrium_left")!; assert(r2 > g2 && r2 > b2, `left atrium should be reddish, got ${vesselShade("heart_atrium_left")}`);
});
