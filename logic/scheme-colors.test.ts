// The color schemes by version, and "what arrives keeps its colors" (logic/scheme-colors.ts, logic/anatomy/palettes.ts).
import { assert, assertEquals } from "jsr:@std/assert";
import { LATEST_PALETTE, paletteFinish, paletteRgb, PALETTES, setPaletteVersion } from "./anatomy/palettes.ts";
import { lookupStructure } from "./segment-naming.ts";
import { deltaE } from "./segment-colours.ts";
import { differsFromScheme, schemeColors } from "./scheme-colors.ts";
import v2 from "./anatomy/palette-v2.json" with { type: "json" };

Deno.test("versions: v1 and v2 exist, v2 is the default, each version gives back its own colors", () => {
  assertEquals(PALETTES.map((p) => p.version), [1, 2, 3]);
  assertEquals(LATEST_PALETTE, 2);
  setPaletteVersion(1);
  assertEquals(lookupStructure("heart_atrium_right")?.rgb, [81, 94, 177]);          // v1: the oxygenation rule
  setPaletteVersion(2);
  assertEquals(lookupStructure("heart_atrium_right")?.rgb, v2.colors.heart_atrium_right);
  setPaletteVersion(99);                                                             // unknown: the latest
  assertEquals(lookupStructure("heart_atrium_right")?.rgb, v2.colors.heart_atrium_right);
});

Deno.test("v2 knows our catalog's spellings of TotalSegmentator's names", () => {
  assertEquals(paletteRgb("vertebra_T5", 2), paletteRgb("vertebrae_T5", 2));
  assertEquals(paletteRgb("clavicle_left", 2), paletteRgb("clavicula_left", 2));
  assert(paletteRgb("vertebra_T5", 2));
  assertEquals(paletteRgb("vertebra_T5", 1), undefined);                            // v1 has no table
});

Deno.test("v2: structures that touch are told apart (the corrections to Mike's ladder)", () => {
  const c = (k: string) => v2.colors[k as keyof typeof v2.colors] as unknown as [number, number, number];
  const pairs: [string, string][] = [
    ["heart_atrium_right", "superior_vena_cava"], ["heart_ventricle_right", "pulmonary_artery"],
    ["heart_atrium_left", "pulmonary_vein"], ["superior_vena_cava", "pulmonary_artery"],
    ["brachiocephalic_vein_left", "brachiocephalic_vein_right"], ["vertebrae_T7", "vertebrae_T8"],
  ];
  for (let k = 1; k <= 12; k++) pairs.push([`rib_left_${k}`, `vertebrae_T${k}`]);
  for (const [a, b] of pairs) assert(deltaE(c(a), c(b)) >= 8, `${a} ~ ${b}: ${deltaE(c(a), c(b)).toFixed(1)}`);
});

Deno.test("v2: every artery a red, every vein a blue", () => {
  const hue = ([r, g, b]: number[]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const [k, m] of Object.entries(v2.material)) {
    const h = hue(v2.colors[k as keyof typeof v2.colors] as unknown as number[]);
    if (m === "vessel_oxygenated") assert(h < 20 || h > 340, `${k} hue ${h.toFixed(0)}`);
    if (m === "vessel_deoxygenated") assert(h > 200 && h < 250, `${k} hue ${h.toFixed(0)}`);
  }
});

Deno.test("a segmentation in its own colors is found to differ; the scheme's colors are not", () => {
  setPaletteVersion(2);
  const segs = [
    { labelValue: 1, structure: "heart_atrium_right", color: [81 / 255, 94 / 255, 177 / 255] },   // v1's color
    { labelValue: 2, structure: "aorta", color: [0.5, 0.5, 0.5] },
    { labelValue: 3, name: "no such structure", color: [0.2, 0.9, 0.2] },               // the scheme knows nothing: never "differs"
  ];
  assertEquals(differsFromScheme(segs), 2);
  const want = schemeColors(segs);
  assertEquals(want[2], undefined);
  const now = segs.map((s, i) => ({ ...s, color: want[i] ?? s.color }));
  assertEquals(differsFromScheme(now), 0);
});

Deno.test("v3: v2 with the spine in v1's colors, for a picture, never the default", () => {
  assertEquals(LATEST_PALETTE, 2);
  for (const k of ["vertebra_T5", "vertebrae_L1", "sacrum", "vertebrae_S1", "intervertebral_discs"]) {
    assertEquals(paletteRgb(k, 3), undefined, `${k}: v1's rules color it`);
  }
  for (const k of ["rib_left_5", "clavicle_left", "kidney_left", "hip_left", "spinal_cord", "erector_spinae_left"]) {
    assertEquals(paletteRgb(k, 3), paletteRgb(k, 2), `${k}: as v2`);
  }
  assertEquals(paletteFinish("vertebra_T5", 3), paletteFinish("vertebra_T5", 2), "the shading stays v2's");
});
