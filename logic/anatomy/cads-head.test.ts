// CADS's head model in the catalog, the tree and the palette (Ron, 2026-10-31: "cads needs the color treatment too" -- all
// nine of cads:head's structures came out Unclassified: the workbook's CADS sheet had not been imported).
//
//   deno test -A --no-check logic/anatomy/cads-head.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { buildAnatomyTree, renderTree } from "./hierarchy.ts";
import { lookupStructure } from "../segment-naming.ts";
import { atPaletteVersion, paletteRgb } from "./palettes.ts";

const HEAD: [string, string, string][] = [
  ["white matter", "Nervous system", "SCT:389080008"],
  ["gray matter", "Nervous system", "SCT:389081007"],
  ["csf", "Nervous system", "SCT:65216001"],
  ["scalp", "Integument", "SCT:41695006"],
  ["eye balls", "Sense organs", "SCT:79652003"],
  ["compact bone", "Skeletal system", "SCT:32217005"],
  ["spongy bone", "Skeletal system", "SCT:20870005"],
  ["blood", "Cardiovascular system", "SCT:87612001"],
  ["head muscles", "Muscular system", "SCT:22688005"],
];

Deno.test("each cads:head label has the workbook's code and a system", () => {
  for (const [l, system, code] of HEAD) {
    const s = lookupStructure(l);
    assert(s, `${l}: not in the catalog`);
    assertEquals([s.system, s.code], [system, code], l);
  }
  assertEquals(lookupStructure("scalp")?.name, "Scalp");
});

Deno.test("none of them is Unclassified in the tree", () => {
  const text = renderTree(buildAnatomyTree(HEAD.map((h) => h[0])));
  assert(!/Unclassified/.test(text), text);
});

Deno.test("the tissues the palette has under another name take its color", () => {
  atPaletteVersion(4, () => {
    assertEquals(paletteRgb("eye balls"), paletteRgb("eyeball_left"));
    assertEquals(paletteRgb("head muscles"), paletteRgb("skeletal_muscle"));
    assertEquals(paletteRgb("compact bone"), paletteRgb("skull"));
    assertEquals(paletteRgb("csf"), [85, 188, 255]);   // v4's light blue
  });
});
