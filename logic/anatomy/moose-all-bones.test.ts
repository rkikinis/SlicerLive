// MOOSE's clin_ct_all_bones_v1 in the catalog, the tree and the palette (Ron, 2026-10-31: "It seems that moose did not
// get the color treatment yet" -- four of its six labels came out Unclassified in the segmenter's own colors).
//
//   deno test -A --no-check logic/anatomy/moose-all-bones.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { buildAnatomyTree, renderTree } from "./hierarchy.ts";
import { lookupStructure } from "../segment-naming.ts";
import { atPaletteVersion, LATEST_PALETTE, paletteRgb } from "./palettes.ts";

const ALL_BONES = ["skull", "sternum", "clavicle", "scapula", "ribcage", "spine"];

Deno.test("every clin_ct_all_bones label is a named skeletal structure", () => {
  for (const l of ALL_BONES) {
    const s = lookupStructure(l);
    assert(s, `${l}: not in the catalog`);
    assertEquals(s.system, "Skeletal system", l);
  }
  assertEquals(lookupStructure("clavicle")?.code, "SCT:51299004");
  assertEquals(lookupStructure("scapula")?.code, "SCT:79601000");
  // none sourced for these two: absent, not guessed
  assertEquals(lookupStructure("ribcage")?.code, undefined);
  assertEquals(lookupStructure("spine")?.code, undefined);
});

Deno.test("they hang in the skeleton's groups, none Unclassified", () => {
  const text = renderTree(buildAnatomyTree(ALL_BONES));
  assert(!/Unclassified/.test(text), text);
  // the both-sided bones read "Clavicle, both sides"
  const has = (name: string) => text.split("\n").some((l) => l.replace(/^[\s·▾▸]+/, "").startsWith(name));
  for (const n of ["Clavicle", "Scapula", "Ribs", "Spine", "Skull", "Sternum"]) assert(has(n), `${n} missing:\n${text}`);
});

Deno.test("each takes the color of the bones it is in the current palette", () => {
  atPaletteVersion(LATEST_PALETTE, () => {
    assertEquals(paletteRgb("clavicle"), paletteRgb("clavicula_left"));
    assertEquals(paletteRgb("scapula"), paletteRgb("scapula_left"));
    assertEquals(paletteRgb("ribcage"), paletteRgb("rib_left_5"));
    assertEquals(paletteRgb("spine"), paletteRgb("vertebrae"));
    assert(paletteRgb("spine"));
  });
});
