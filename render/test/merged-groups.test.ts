// A COLLAPSED BRANCH IS ONE COLOR, AND IN BOTH PALETTES.
//
// Ron: "when I collapse the left ribs in segmentations, they do not change to a single color" -- and
// after the first attempt: "Left ribs should change color. They dont." The first version taught only
// `segPalette`, which colors the slice overlay and a segmentation's own 3D field. But the 3D view
// usually shows CT and segments composited in ONE pass, and that volume is colored by a different
// function reading each segment's own `color` -- so the slices honored a collapse and 3D ignored it.
//
// Two palette paths is the fact of the code; two SOURCES of truth for what a label is painted was the
// bug. `mergedColours` is now the single flattening both call, and this pins its behavior.
//
//   deno test -A --no-check render/test/merged-groups.test.ts
import { assertEquals } from "jsr:@std/assert";
import { mergedColours } from "../livescene.ts";

Deno.test("no merge means no overrides", () => {
  assertEquals(mergedColours(undefined).size, 0);
  assertEquals(mergedColours([]).size, 0);
});

Deno.test("every label in a collapsed branch maps to that branch's colour", () => {
  const bone = [0.9, 0.87, 0.78];
  const m = mergedColours([{ labels: [12, 13, 14], color: bone }]);
  assertEquals(m.size, 3);
  for (const lv of [12, 13, 14]) assertEquals(m.get(lv), bone);
  assertEquals(m.get(15), undefined, "a label outside the branch must be untouched");
});

Deno.test("several collapsed branches coexist", () => {
  const m = mergedColours([
    { labels: [1, 2], color: [1, 0, 0] },
    { labels: [8, 9], color: [0, 0, 1] },
  ]);
  assertEquals(m.get(1), [1, 0, 0]);
  assertEquals(m.get(9), [0, 0, 1]);
  assertEquals(m.size, 4);
});

// The panel sends only the OUTERMOST closed branch, so this should not arise -- but if it ever does,
// the inner branch is the more specific statement and wins.
Deno.test("a later branch overrides an earlier one on a shared label", () => {
  const m = mergedColours([
    { labels: [5, 6], color: [1, 1, 1] },
    { labels: [6], color: [0, 0, 0] },
  ]);
  assertEquals(m.get(5), [1, 1, 1]);
  assertEquals(m.get(6), [0, 0, 0]);
});
