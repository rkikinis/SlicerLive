// The color schemes by version, and "what arrives keeps its colors" (logic/scheme-colors.ts, logic/anatomy/palettes.ts).
import { assert, assertEquals } from "jsr:@std/assert";
import { LATEST_PALETTE, paletteFinish, paletteRgb, PALETTES, schemeAtStart, setPaletteVersion } from "./anatomy/palettes.ts";
import { lookupStructure } from "./segment-naming.ts";
import { deltaE } from "./segment-colours.ts";
import { albulaVersionOf, differsFromScheme, followAlbulaColors, schemeColors } from "./scheme-colors.ts";
import { writtenByAlbula } from "./albula-private.ts";
import { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import v2 from "./anatomy/palette-v2.json" with { type: "json" };

Deno.test("versions: v1 to v4 exist, v4 is the default, each version gives back its own colors", () => {
  assertEquals(PALETTES.map((p) => p.version), [1, 2, 3, 4]);
  assertEquals(LATEST_PALETTE, 4);
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
  assertEquals(LATEST_PALETTE !== 3, true);
  for (const k of ["vertebra_T5", "vertebrae_L1", "sacrum", "vertebrae_S1", "intervertebral_discs"]) {
    assertEquals(paletteRgb(k, 3), undefined, `${k}: v1's rules color it`);
  }
  for (const k of ["rib_left_5", "clavicle_left", "kidney_left", "hip_left", "spinal_cord", "erector_spinae_left"]) {
    assertEquals(paletteRgb(k, 3), paletteRgb(k, 2), `${k}: as v2`);
  }
  assertEquals(paletteFinish("vertebra_T5", 3), paletteFinish("vertebra_T5", 2), "the shading stays v2's");
});

Deno.test("v4: FreeSurfer's cerebrospinal fluid in light blue; v1-v3 keep FreeSurfer's dark gray (critic 2026-10-20, finding 11)", async () => {
  const { freesurferStructureFor } = await import("./segment-naming.ts");
  try {
    for (const v of [1, 2, 3]) {
      setPaletteVersion(v);
      assertEquals(lookupStructure("CSF")?.rgb, [60, 60, 60], `v${v}`);
      assertEquals(freesurferStructureFor(24)?.rgb, [60, 60, 60], `v${v}, by FreeSurfer's label value`);
    }
    setPaletteVersion(4);
    assertEquals(lookupStructure("CSF")?.rgb, [85, 188, 255]);
    assertEquals(freesurferStructureFor(24)?.rgb, [85, 188, 255]);
    // Everything else as v2.
    for (const k of ["heart_atrium_right", "vertebra_T5", "Left-Lateral-Ventricle"]) assertEquals(paletteRgb(k, 4), paletteRgb(k, 2), k);
    assertEquals(paletteFinish("kidney_left", 4), paletteFinish("kidney_left", 2));
    // THE COLOR BUTTON COMPARES WITH THE VERSION IN FORCE: a FastSurfer result saved with the gray differs under v4 only.
    const saved = [{ labelValue: 24, structure: "CSF", color: [60 / 255, 60 / 255, 60 / 255] }];
    assertEquals(differsFromScheme(saved), 1);
    setPaletteVersion(2);
    assertEquals(differsFromScheme(saved), 0);
  } finally { setPaletteVersion(LATEST_PALETTE); }
});

Deno.test("a picture's scheme returns to the newest at start; a regular one stays", () => {
  assertEquals(schemeAtStart(3), { version: LATEST_PALETTE, moved: true });
  assertEquals(schemeAtStart(2), { version: 2, moved: false });
  assertEquals(schemeAtStart(LATEST_PALETTE), { version: LATEST_PALETTE, moved: false });
  // A newer build's version: drawn with this build's newest, the setting left as it is (critic 2026-10-20, section 11).
  assertEquals(schemeAtStart(99), { version: LATEST_PALETTE, moved: false, unknown: true });
});

Deno.test("Albula's own colors follow the version in force; a person's colors stay", () => {
  // FastSurfer's structures as an earlier version colored them: CSF in FreeSurfer's gray.
  const fs = (key: string) => lookupStructure(key);
  setPaletteVersion(2);
  const keys = ["CSF", "Left-Hippocampus", "Right-Putamen"];
  const asV2 = keys.map((k, i) => ({ labelValue: i + 1, structure: fs(k)?.key ?? k, name: k, color: fs(k)!.rgb!.map((c) => c / 255) }));
  setPaletteVersion(4);
  assertEquals(albulaVersionOf(asV2) !== undefined, true);
  assert(differsFromScheme(asV2) >= 1, "v2's gray CSF differs from v4");
  // One segment recolored by a person: not Albula's colors, kept.
  const mine = asV2.map((s, i) => i === 1 ? { ...s, color: [0.1, 0.9, 0.1] } : s);
  assertEquals(albulaVersionOf(mine), undefined);
  // Colors the scheme knows nothing about (another program's labels): kept.
  assertEquals(albulaVersionOf([{ labelValue: 1, name: "my region", color: [0.5, 0.5, 0.5] }]), undefined);
});

Deno.test("only a file Albula wrote follows Albula's colors; the same colors from another program stay (critic 2026-10-20, finding 3)", () => {
  // FreeSurfer's own table (v2's gray CSF): what a FreeSurfer result exported by Slicer or another site carries too.
  const fs = (key: string) => lookupStructure(key);
  setPaletteVersion(2);
  const keys = ["CSF", "Left-Hippocampus", "Right-Putamen"];
  const asV2 = keys.map((k, i) => ({ labelValue: i + 1, structure: fs(k)?.key ?? k, name: k, color: fs(k)!.rgb!.map((c) => c / 255) }));
  setPaletteVersion(4);
  try {
    const live = new LiveScene("http://x/mrson/", []);
    const put = (id: string, origin: Record<string, unknown>) =>
      live.nodes.set(id, { type: "segmentation", id, name: id, segments: asV2.map((s) => ({ ...s })), origin } as unknown as MrsonNode);
    put("ours", { seriesInstanceUID: "1.2", writtenBy: "SlicerAlbula" });
    put("theirs", { seriesInstanceUID: "1.3" });
    assert(followAlbulaColors(live, ["ours", "theirs"]) >= 1);
    const csf = (id: string) => ((live.nodes.get(id)!.segments as { color: number[] }[])[0]).color;
    assert(deltaE(csf("ours").map((c) => Math.round(c * 255)) as [number, number, number], fs("CSF")!.rgb!) < 3, "Albula's file: v4's CSF");
    assertEquals(csf("theirs"), asV2[0].color, "another program's file keeps FreeSurfer's gray");
  } finally { setPaletteVersion(LATEST_PALETTE); }
});

Deno.test("writtenByAlbula: SoftwareVersions naming SlicerAlbula, or Albula's private block; nothing else", () => {
  assertEquals(writtenByAlbula(["haversack 0.15.0", "FastSurferVINN 2.5.4", "SlicerAlbula bce8188"]), true);
  assertEquals(writtenByAlbula("SlicerAlbula"), true);
  assertEquals(writtenByAlbula("haversack 0.15.0", { "00770010": { Value: ["SlicerAlbula provenance 1"] } }), true);
  assertEquals(writtenByAlbula(["3D Slicer 5.8.1", "dcmqi 1.3.4"]), false);
  assertEquals(writtenByAlbula(undefined, { "00770010": { Value: ["SIEMENS CSA HEADER"] } }), false);
  assertEquals(writtenByAlbula("NotSlicerAlbulaX"), false);
});
