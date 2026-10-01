// DOES THE CROP BOX ACTUALLY REACH THE SCREEN?
//
// Not "is the geometry right" -- that is logic/crop.test.ts -- but the question I twice failed to
// ask: does the code that draws it ever RUN. Ron, after fitting a box and seeing nothing: "and there
// was no box." Then: "dont guess bites you again."
//
// The cause both times was reachability, not arithmetic. MarkupsDisplayableManager.onNodeAdded
// returned for an ROI three lines before the node reached `this.nodes`, and BOTH drawing paths --
// the twelve edges through the capsule field, and the slice outlines through the overlay -- read
// `this.nodes`. So they were dead code from the moment they were written, and no test noticed,
// because every test I had asked whether the numbers were right.
//
// These fields are CPU-side descriptions with no GPUDevice, so the manager can be driven headlessly.
// That is what makes this testable at all, and it is the answer to having no GPU: I cannot see the
// picture, but I CAN see whether the renderer was ever told to draw one.
//
//   deno test -A --no-check render/markups-roi.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { MarkupsDisplayableManager } from "./livescene.ts";
import { axesOfVolume } from "../logic/crop.ts";
import { ROI_BAR_RGB } from "./demos/roi-widget.ts";

/** What the manager was told to draw. */
interface Drawn {
  fields: Map<string, unknown>;
  overlays: Map<string, { kind: string; points?: unknown[]; closed?: boolean }[]>;
  redraws: number;
}

function stubScene(extraNodes: Record<string, unknown>[] = []) {
  const drawn: Drawn = { fields: new Map(), overlays: new Map(), redraws: 0 };
  const nodes = new Map<string, unknown>();
  for (const n of extraNodes) nodes.set((n as { id: string }).id, n);
  const scene = {
    nodes,
    view: {
      setField: (k: string, f: unknown) => drawn.fields.set(k, f),
      removeField: (k: string) => drawn.fields.delete(k),
      setOverlay: (_cell: string, layer: string, items: unknown[]) =>
        drawn.overlays.set(layer, items as Drawn["overlays"] extends Map<string, infer V> ? V : never),
      redraw: () => { drawn.redraws++; },
    },
  };
  return { scene, drawn };
}

/** An axial slice view node, the shape SliceDisplayableManager reads. */
const axialAt = (s: number) => ({
  id: "view:Red", type: "view", kind: "slice", layoutName: "Red",
  sliceToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, s, 0, 0, 0, 1],
});

/** A crop box aligned to a volume's own axes, as the crop panel writes one. */
const orientedRoi = () => ({
  id: "local-markup-cropbox", type: "markup", markupType: "roi", name: "Crop box",
  center: [0, 0, 0], size: [100, 120, 140],
  orientation: axesOfVolume([0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1]),
  visible: true,
});

Deno.test("an ROI reaches the renderer at all — the bug that made the box invisible", () => {
  const { scene, drawn } = stubScene();
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  assert(drawn.fields.has("roi:local-markup-cropbox"), "the manager never asked for a box to be drawn");
});

// An oriented box goes to its OWN WIDGET now — the tuned wireframe plus fifteen handles, ray-marched
// with the volume so it occludes correctly. This test previously asserted the opposite, because
// RoiBoxField was axis-aligned and the box was drawn as twelve markup capsules. Ron: "What we did
// yesterday evening is a regression of sorts."
Deno.test("an oriented box is drawn by its own widget, with handles", () => {
  const { scene, drawn } = stubScene();
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  assert(drawn.fields.has("roi:local-markup-cropbox"), "no wireframe");
  assert(drawn.fields.has("roiHandles:local-markup-cropbox"), "no handles — the whole complaint");
});

// The capsule field must NOT carry the box: it is not in the volume's ray-march pass, which is why
// the slice planes failed to obscure it. Ron: "the slice displays in the 3d window should partially
// obscure the box outline."
Deno.test("the box does not go through the markup connector field", () => {
  const { scene, drawn } = stubScene();
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const lines = drawn.fields.get("markupLines") as { count: number } | undefined;
  // The connector field is created once for all markups, so it may exist -- but an ROI must put
  // nothing in it. Twelve capsules there were the bug: that field is not in the volume's ray-march
  // pass, which is why the slice planes failed to obscure the box.
  assertEquals(lines?.count ?? 0, 0, "the ROI put segments in the connector field");
});

Deno.test("the box appears on a slice as a closed outline, where the slice cuts it", () => {
  const { scene, drawn } = stubScene([axialAt(0)]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const items = drawn.overlays.get("markups") ?? [];
  const outlines = items.filter((i) => i.kind === "polyline" && i.closed);
  assertEquals(outlines.length, 1, "one outline, for the one slice plane in the scene");
  assertEquals((outlines[0].points as unknown[]).length, 4, "an axial cut of a box is a rectangle");
});

Deno.test("a slice that misses the box draws no outline", () => {
  const { scene, drawn } = stubScene([axialAt(5000)]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const items = drawn.overlays.get("markups") ?? [];
  assertEquals(items.filter((i) => i.kind === "polyline").length, 0);
});

Deno.test("each slice view gets its own outline", () => {
  const coronal = {
    id: "view:Green", type: "view", kind: "slice", layoutName: "Green",
    sliceToRAS: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  };
  const { scene, drawn } = stubScene([axialAt(0), coronal]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const outlines = (drawn.overlays.get("markups") ?? []).filter((i) => i.kind === "polyline");
  assertEquals(outlines.length, 2, "one per plane; the drawer keeps only the one in its own cell");
});

// Moving a slice has to recompute the outline, which is why the manager listens to `view` too.
Deno.test("scrolling a slice moves the outline", () => {
  const { scene, drawn } = stubScene([axialAt(0)]);
  const m = new MarkupsDisplayableManager();
  m.onNodeAdded(orientedRoi() as never, scene as never);
  const before = JSON.stringify(drawn.overlays.get("markups"));
  scene.nodes.set("view:Red", axialAt(30));
  m.onNodeAdded(axialAt(30) as never, scene as never);
  const after = JSON.stringify(drawn.overlays.get("markups"));
  assert(before !== after, "the outline did not follow the slice");
});

Deno.test("hiding the box removes it", () => {
  const { scene, drawn } = stubScene([axialAt(0)]);
  const m = new MarkupsDisplayableManager();
  m.onNodeAdded(orientedRoi() as never, scene as never);
  m.onNodeAdded({ ...orientedRoi(), visible: false } as never, scene as never);
  assertEquals((drawn.overlays.get("markups") ?? []).filter((i) => i.kind === "polyline").length, 0);
});

// An axis-aligned ROI keeps the old path: RoiBoxField draws it, and there is no reason to change
// that just because oriented ones cannot use it.
Deno.test("an axis-aligned ROI is still drawn by its own field", () => {
  const { scene, drawn } = stubScene();
  const plain = { ...orientedRoi(), orientation: undefined };
  new MarkupsDisplayableManager().onNodeAdded(plain as never, scene as never);
  assert(drawn.fields.has("roi:local-markup-cropbox"), "the axis-aligned path is untouched");
});

// THE HANDLES HAVE TO BE REACHABLE BY THE VIEW, or there is nothing for a pointer to grab. This is
// the same reachability question that made the box invisible twice — asked about the handles this
// time, before Ron has to ask it for a third time.
Deno.test("the manager exposes the crop widget's handles to the view", () => {
  const { scene } = stubScene();
  const m = new MarkupsDisplayableManager();
  m.onNodeAdded(orientedRoi() as never, scene as never);
  const widgets = m.cropWidgets();
  assertEquals(widgets.length, 1, "the view cannot find the widget");
  assertEquals(widgets[0].id, "local-markup-cropbox");
  const handles = widgets[0].widget.handleList();
  assertEquals(handles.length, 15, "6 faces + 8 corners + 1 centre");
  assertEquals(handles.filter((h) => h.data.kind === "face").length, 6);
  assertEquals(handles.filter((h) => h.data.kind === "corner").length, 8);
  assertEquals(handles.filter((h) => h.data.kind === "center").length, 1);
  // Every handle needs a world position for picking, and a cursor so the pointer says it is grabbable.
  for (const h of handles) {
    assertEquals(h.world.length, 3);
    assert(h.cursor.length > 0, "no cursor");
  }
});

Deno.test("the widget follows the node, so a drag written back does not fight it", () => {
  const { scene } = stubScene();
  const m = new MarkupsDisplayableManager();
  m.onNodeAdded(orientedRoi() as never, scene as never);
  const w = m.cropWidgets()[0].widget;
  m.onNodeAdded({ ...orientedRoi(), center: [10, 20, 30], size: [40, 40, 40] } as never, scene as never);
  const b = w.snapshot();
  assertEquals([...b.center], [10, 20, 30]);
  assertEquals([...b.half], [20, 20, 20]);
  assertEquals(m.cropWidgets().length, 1, "the widget is reused, not rebuilt");
});

Deno.test("removing the ROI takes both its fields away", () => {
  const { scene, drawn } = stubScene();
  const m = new MarkupsDisplayableManager();
  m.onNodeAdded(orientedRoi() as never, scene as never);
  m.onNodeRemoved("local-markup-cropbox", scene as never);
  assertEquals(drawn.fields.has("roi:local-markup-cropbox"), false);
  assertEquals(drawn.fields.has("roiHandles:local-markup-cropbox"), false);
  assertEquals(m.cropWidgets().length, 0);
});

// THE HANDLES MUST BE DRAWN IN THE SLICE VIEWS TOO, or there is nothing to pick there. Ron: "2D
// dislplay works but no control handles available in 2d."
//
// But the PLANE'S OWN nine, not the fifteen from 3D. Ron, next: "It should not show the 3d handles
// in the 2d, they are useless there. 2D control handles should be usable in the slice that is
// visible, otherwise they are not functional." So this test pins the count AND the reachability:
// every point emitted for a slice lies on that slice.
Deno.test("the slice overlay carries the handles that belong to that plane", () => {
  const { scene, drawn } = stubScene([axialAt(0)]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const items = drawn.overlays.get("markups") ?? [];
  const outline = items.filter((i) => i.kind === "polyline" && i.closed);
  const points = items.filter((i) => i.kind === "point") as unknown as { ras: number[]; inPlaneOnly?: boolean }[];
  assertEquals(outline.length, 1, "the outline");
  assertEquals(points.length, 9, "4 faces + 4 corners + the centre, all of them grabbable");
  // The axial plane sits at S = 0, so every handle drawn there must too -- a handle off the plane
  // cannot be clicked in that view however clearly it is drawn.
  for (const p of points) {
    assertEquals(Math.abs(p.ras[2]) < 1e-9, true, `handle off the plane at S=${p.ras[2]}`);
    assertEquals(p.inPlaneOnly, true, "a control, so it must not be drawn in the other views");
  }
});

// Two planes, two sets: the overlay goes to every cell at once ("*"), so each plane's handles have
// to be distinguishable BY POSITION or the sagittal view would draw the axial view's.
Deno.test("each slice plane gets its own handles", () => {
  const { scene, drawn } = stubScene([axialAt(0), {
    id: "view:Yellow", type: "view", kind: "slice", layoutName: "Yellow",
    sliceToRAS: [0, 0, 1, 12, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  }]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const points = (drawn.overlays.get("markups") ?? []).filter((i) => i.kind === "point") as unknown as { ras: number[] }[];
  assertEquals(points.length, 18, "nine per plane");
  // The sagittal nine all sit at R = 12; the rest are the axial nine, all at S = 0. (Three of the
  // sagittal handles also have S = 0 -- the center and the two faces along A -- so the axial set is
  // what is LEFT rather than everything at S = 0.)
  const sag = points.filter((p) => Math.abs(p.ras[0] - 12) < 1e-9);
  const ax = points.filter((p) => Math.abs(p.ras[0] - 12) >= 1e-9);
  assertEquals(sag.length, 9, "the sagittal nine, on R = 12");
  assertEquals(ax.length, 9, "the axial nine");
  for (const p of ax) assertEquals(Math.abs(p.ras[2]) < 1e-9, true, `axial handle off S=0: ${p.ras[2]}`);
});

// A plane that misses the box has no outline, so it must have no handles either -- handles floating
// where there is nothing to grab is the same fault in a different place.
Deno.test("a slice clear of the box gets no handles", () => {
  const { scene, drawn } = stubScene([axialAt(500)]);
  new MarkupsDisplayableManager().onNodeAdded(orientedRoi() as never, scene as never);
  const items = drawn.overlays.get("markups") ?? [];
  assertEquals(items.filter((i) => i.kind === "point").length, 0);
  assertEquals(items.filter((i) => i.kind === "polyline" && i.closed).length, 0);
});

// One box, one color. The outline fell back to the generic markup gold while the 3D frame was warm
// ivory. Ron: "the box colors in 2d are not adjusted. In 3d they look nice."
Deno.test("the slice outline is the frame's ivory, not markup gold", () => {
  const { scene, drawn } = stubScene([axialAt(0)]);
  new MarkupsDisplayableManager().onNodeAdded({ ...orientedRoi(), color: undefined } as never, scene as never);
  const outline = (drawn.overlays.get("markups") ?? []).find((i) => i.kind === "polyline" && i.closed)!;
  const col = (outline as unknown as { color: number[] }).color;
  assertEquals([col[0], col[1], col[2]], [...ROI_BAR_RGB]);
});
