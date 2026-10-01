// T1: the layout catalog — every arrangement covers the view area with non-overlapping cells.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { cellsFor, DEFAULT_LAYOUT, layout, LAYOUTS, layoutList, splitBoundary } from "./layouts.ts";

Deno.test("Slicer's layout ids resolve to the right names", () => {
  assertEquals(layout(3).name, "Four-Up");
  assertEquals(layout(6).name, "One-Up Red");
  assertEquals(layout(999).id, DEFAULT_LAYOUT);   // unknown -> default
});

Deno.test("every layout's cells cover the area exactly with no overlap", () => {
  for (const l of layoutList()) {
    let area = 0;
    for (let i = 0; i < l.cells.length; i++) {
      const a = l.cells[i];
      assert(a.w > 0 && a.h > 0 && a.x >= -1e-9 && a.y >= -1e-9 && a.x + a.w <= 1 + 1e-9 && a.y + a.h <= 1 + 1e-9, `${l.name} cell ${a.view} out of bounds`);
      area += a.w * a.h;
      for (let j = i + 1; j < l.cells.length; j++) {
        const b = l.cells[j];
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        assert(ox * oy < 1e-9, `${l.name}: ${a.view} overlaps ${b.view}`);
      }
    }
    assertAlmostEquals(area, 1, 1e-6, `${l.name} does not fill the area (covered ${area})`);
  }
});

Deno.test("cellsFor: fractional cells -> pixel rects", () => {
  const cells = cellsFor(3, 800, 600);
  assertEquals(cells.length, 4);
  const red = cells.find((c) => c.view === "Red")!;
  assertEquals(red.px, { x: 0, y: 0, w: 400, h: 300 });
  assertEquals(red.orientation, "Axial");
  assertEquals(LAYOUTS[3].cells.find((c) => c.view === "1")!.kind, "3d");
});

// A fixed half-and-half split means the slice views are always exactly half the height, whichever
// you are actually reading. These cover moving that boundary.
Deno.test("splitBoundary: only layouts with a clean top/bottom division have one", () => {
  assertEquals(splitBoundary(2), { axis: "row", at: 0.5 }, "Conventional: 3D over three slices");
  assertEquals(splitBoundary(16), { axis: "column", at: 0.625 }, "Widescreen: 3D beside a slice stack");
  for (const l of layoutList()) {
    const b = splitBoundary(l.id);
    if (b) assertEquals(b.at > 0 && b.at < 1, true, `${l.name} boundary in range`);
  }
});

// Transcribed from Slicer's own conventionalWidescreenView, including its slice order, which is NOT
// the same as Conventional's.
Deno.test("Conventional Widescreen: 3D beside a stack of three, in Slicer's order", () => {
  const cells = cellsFor(16, 1600, 900);
  const threeD = cells.find((c) => c.kind === "3d")!;
  assertEquals([threeD.px.x, threeD.px.w], [0, 1000], "500 of 800 split units");
  const stack = cells.filter((c) => c.kind === "slice");
  assertEquals(stack.map((c) => c.orientation), ["Axial", "Coronal", "Sagittal"], "Red, Green, Yellow top to bottom");
  for (const c of stack) assertEquals(Math.round(c.px.x), 1000, "all in the right-hand column");
  assertEquals(stack.map((c) => Math.round(c.px.h)), [300, 300, 300], "equal thirds of the height");
});

Deno.test("cellsFor: a column split widens the 3D view, keeping the stack's thirds", () => {
  const cells = cellsFor(16, 1600, 900, 0, 0, 0.8);
  assertEquals(cells.find((c) => c.kind === "3d")!.px.w, 1280);
  const stack = cells.filter((c) => c.kind === "slice");
  for (const c of stack) assertEquals(Math.round(c.px.x), 1280);
  assertEquals(stack.map((c) => Math.round(c.px.w)), [320, 320, 320]);
  assertEquals(stack.map((c) => Math.round(c.px.h)), [300, 300, 300], "heights untouched by a column split");
});

Deno.test("cellsFor: rowSplit gives the slice row more room, keeping proportions", () => {
  const at = cellsFor(2, 900, 1000, 0, 0, 0.3);
  const threeD = at.find((c) => c.kind === "3d")!;
  const slices = at.filter((c) => c.kind === "slice");
  assertEquals(threeD.px.h, 300, "the 3D cell takes the top 30%");
  for (const s of slices) {
    assertEquals(s.px.y, 300, "slices start at the boundary");
    assertEquals(s.px.h, 700, "and fill the rest");
  }
  // Widths are untouched: this moves a horizontal boundary only.
  assertEquals(slices.map((s) => Math.round(s.px.w)), [300, 300, 300]);
});

Deno.test("cellsFor: without rowSplit the catalog's own layout is unchanged", () => {
  const plain = cellsFor(2, 900, 1000);
  const explicit = cellsFor(2, 900, 1000, 0, 0, 0.5);
  assertEquals(plain.map((c) => c.px), explicit.map((c) => c.px));
});

Deno.test("cellsFor: the split is clamped, so a view cannot be dragged away entirely", () => {
  const tiny = cellsFor(2, 900, 1000, 0, 0, 0.001);
  assertEquals(tiny.find((c) => c.kind === "3d")!.px.h, 100, "clamped to 10%");
  const huge = cellsFor(2, 900, 1000, 0, 0, 0.999);
  assertEquals(huge.find((c) => c.kind === "3d")!.px.h, 900, "and to 90%");
});
