// Ron: "Mike used the plus sign to expand or collapse branches. That is a natural way to change
// color. eg from each gyrus colored, to each lobe colored to each hemisphere."
//
//   deno test -A --no-check logic/anatomy/level-colours.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { type ColourNode, colourOverrides, levelColour, LEVEL_PALETTE } from "./level-colours.ts";

const leaf = (id: string, labelValue: number): ColourNode => ({ id, labelValue, children: [] });
const group = (id: string, children: ColourNode[]): ColourNode => ({ id, children });

/** hemisphere → lobe → gyrus → side, the shape a FastSurfer result actually makes. */
const brain = () => [
  group("g:cortex", [
    group("g:frontal", [
      group("p:precentral", [leaf("s:lh-precentral", 1), leaf("s:rh-precentral", 2)]),
      group("p:superiorfrontal", [leaf("s:lh-superiorfrontal", 3), leaf("s:rh-superiorfrontal", 4)]),
    ]),
    group("g:parietal", [
      group("p:postcentral", [leaf("s:lh-postcentral", 5), leaf("s:rh-postcentral", 6)]),
    ]),
  ]),
];

Deno.test("fully expanded, every structure keeps its own colour", () => {
  assertEquals(colourOverrides(brain(), new Set()).size, 0);
});

Deno.test("collapsing the lobes colours each lobe's structures as one", () => {
  const o = colourOverrides(brain(), new Set(["g:frontal", "g:parietal"]));
  assertEquals(o.get(1), o.get(3), "both frontal gyri take the frontal colour");
  assertEquals(o.get(2), o.get(4), "and so do their right-side partners");
  assert(o.get(1)!.join() !== o.get(5)!.join(), "frontal and parietal must differ");
  assertEquals(o.size, 6, "every leaf under a collapsed lobe is painted");
});

// The movement Ron described: collapse further and the colors coarsen again.
Deno.test("collapsing the level above recolours everything to that level", () => {
  const o = colourOverrides(brain(), new Set(["g:cortex"]));
  const colours = new Set([...o.values()].map((c) => c.join()));
  assertEquals(colours.size, 1, "one colour for the whole cortex");
  assertEquals(o.size, 6);
});

// The nearest collapsed ancestor wins, so an outer collapse overrides an inner one rather than the
// two disagreeing about a leaf.
Deno.test("the nearest collapsed ancestor decides", () => {
  const o = colourOverrides(brain(), new Set(["g:cortex", "g:frontal"]));
  assertEquals(new Set([...o.values()].map((c) => c.join())).size, 1, "the outer collapse wins");
});

Deno.test("a collapsed leaf keeps its own colour, having nothing to stand in for", () => {
  const t = [group("g:a", [leaf("s:x", 1)])];
  assertEquals(colourOverrides(t, new Set(["s:x"])).size, 0);
});

// Same rule, other anatomy — the reason this is worth having rather than a brain special case.
Deno.test("it works for ribs and lungs, which is the point", () => {
  const ribs = [group("g:ribs", [
    group("g:ribs-left", [leaf("s:rib_left_1", 10), leaf("s:rib_left_2", 11)]),
    group("g:ribs-right", [leaf("s:rib_right_1", 20), leaf("s:rib_right_2", 21)]),
  ])];
  const bySide = colourOverrides(ribs, new Set(["g:ribs-left", "g:ribs-right"]));
  assertEquals(bySide.get(10), bySide.get(11));
  assert(bySide.get(10)!.join() !== bySide.get(20)!.join(), "left and right ribs differ");
  const all = colourOverrides(ribs, new Set(["g:ribs"]));
  assertEquals(new Set([...all.values()].map((c) => c.join())).size, 1, "all ribs as one");
});

Deno.test("a branch keeps its colour across collapse and expand", () => {
  const a = colourOverrides(brain(), new Set(["g:frontal"]));
  const b = colourOverrides(brain(), new Set(["g:frontal", "g:parietal"]));
  assertEquals(a.get(1), b.get(1), "collapsing a sibling must not repaint this one");
});

Deno.test("the palette is distinct and stays in range", () => {
  assertEquals(new Set(LEVEL_PALETTE.map((c) => c.join())).size, LEVEL_PALETTE.length);
  for (const c of LEVEL_PALETTE) for (const v of c) assert(v >= 0 && v <= 255, `${v}`);
  assertEquals(levelColour(0), levelColour(LEVEL_PALETTE.length), "it cycles");
  assertEquals(levelColour(-1), LEVEL_PALETTE[LEVEL_PALETTE.length - 1], "and does not break on a negative");
});
