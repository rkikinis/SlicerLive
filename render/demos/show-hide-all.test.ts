// The show/hide-all button's decision. Ron: "can you add a turn off/on all button to the
// segmentations display?"
//
// Tested rather than clicked: what can be wrong here is which way the click goes, what it is scoped
// to, and whether the label agrees with both -- none of which needs a DOM, and all of which would be
// invisible in a screenshot until someone pressed it on a hundred structures.
import { assertEquals } from "jsr:@std/assert@1";
import { showHideAllState } from "./segmentations-panel.ts";

const on = (labelValue: number) => ({ labelValue, visible: true });
const off = (labelValue: number) => ({ labelValue, visible: false });
/** `visible` absent means visible — that is how the tree reads it everywhere else. */
const unset = (labelValue: number) => ({ labelValue });

Deno.test("anything still visible means the click hides", () => {
  const s = showHideAllState([on(1), off(2), off(3)], false);
  assertEquals(s.show, false);
  assertEquals(s.label, "Hide all");
  assertEquals(s.labels, [1, 2, 3], "it acts on all of them, not only the visible one");
});

Deno.test("nothing visible means the click shows — so it is never a no-op", () => {
  const s = showHideAllState([off(1), off(2)], false);
  assertEquals(s.show, true);
  assertEquals(s.label, "Show all");
});

Deno.test("an absent visible flag counts as visible", () => {
  // buildSegmentTree leaves omit `visible` when it was never set; treating that as hidden would make
  // the button read "Show all" on a segmentation that is entirely on screen.
  assertEquals(showHideAllState([unset(1), unset(2)], false).label, "Hide all");
});

Deno.test("with a filter typed, the label says how many it is scoped to", () => {
  const some = [on(4), on(5), on(6)];
  assertEquals(showHideAllState(some, true).label, "Hide these 3");
  assertEquals(showHideAllState(some.map((x) => ({ ...x, visible: false })), true).label, "Show these 3");
  // ...and unfiltered it does not pretend to a count.
  assertEquals(showHideAllState(some, false).label, "Hide all");
});

Deno.test("an empty list yields nothing to act on", () => {
  const s = showHideAllState([], false);
  assertEquals(s.labels, []);
  assertEquals(s.label, "Show all", "and it reads as the harmless direction while disabled");
});

Deno.test("a structure with no label value is not sent to the setter", () => {
  // Container rows carry no labelValue; passing undefined through would patch nothing and confuse
  // the segment map.
  const s = showHideAllState([on(1), { visible: true }, on(2)], false);
  assertEquals(s.labels, [1, 2]);
});
