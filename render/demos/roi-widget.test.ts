// THE DRAG MATH, IN THE BOX'S OWN FRAME.
//
// A crop box aligned to the patient is useless on an oblique volume, so the box carries the volume's
// direction cosines — and the whole point of putting them in `axes` rather than folding them into
// `center`/`half` is that the gestures stay intuitive: a face handle moves THAT face along the
// box's own axis. Ron: "I want something that is intuitive for a new user."
//
// These fields are CPU-side descriptions, so the widget runs headlessly.
//
//   deno test -A --no-check render/demos/roi-widget.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { createRoiWidget, degenerateAxis, FADE_DEG, handleId, sliceHandles } from "./roi-widget.ts";
import type { Vec3 } from "../mat4.ts";

/** 90 degrees about Z: box X becomes world Y, box Y becomes world -X. */
const ROT_Z90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;
const close = (a: Vec3 | readonly number[], b: readonly number[], tol = 1e-9) =>
  [0, 1, 2].every((i) => near(a[i], b[i], tol));

Deno.test("with no axes the widget is exactly what it was", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5 });
  assertEquals(w.handleList().length, 15);
  assert(close(w.snapshot().center, [0, 0, 0]));
  assert(close(w.snapshot().half, [100, 100, 100]));
  // face +X handle sits at +half on X
  const fx = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!;
  assert(close(fx.world, [100, 0, 0]), fx.world.join());
});

// The visible consequence of orientation: the +X FACE handle of a box rotated 90 degrees about Z
// sits along world +Y, because that is where the box's own X axis points.
Deno.test("handles follow the box's axes, not the patient's", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90 });
  const fx = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!;
  assert(close(fx.world, [0, 100, 0]), `expected +Y, got ${fx.world.join()}`);
  const fy = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 1 && h.data.sign === 1)!;
  assert(close(fy.world, [-100, 0, 0]), `expected -X, got ${fy.world.join()}`);
});

// Dragging that handle must resize the box along ITS axis. A drag in world +Y is a drag along box
// +X, so box X grows and nothing else moves.
Deno.test("a face drag resizes the box's own axis and pins the opposite face", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90 });
  const box0 = w.snapshot();
  const fx = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!;
  w.applyDrag(fx.data, box0, [0, 40, 0]);            // world +Y == box +X
  const b = w.snapshot();
  assert(near(b.half[0], 120), `box X half should be 120, got ${b.half[0]}`);
  assert(near(b.half[1], 100) && near(b.half[2], 100), "the other axes must not change");
  // the opposite face stayed put: center moved half the drag, along box X (world Y)
  assert(close(b.center, [0, 20, 0], 1e-9), b.center.join());
});

// A drag ACROSS the handle's axis must do nothing to it — the component along the box axis is zero.
Deno.test("a face drag ignores motion across its own axis", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90 });
  const box0 = w.snapshot();
  const fx = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!;
  w.applyDrag(fx.data, box0, [50, 0, 0]);            // world +X is box -Y: nothing along box X
  const b = w.snapshot();
  assert(close(b.half, [100, 100, 100]), `half changed: ${b.half.join()}`);
  assert(close(b.center, [0, 0, 0]), `centre moved: ${b.center.join()}`);
});

Deno.test("the centre handle translates in world, whatever the orientation", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90 });
  const box0 = w.snapshot();
  const c = w.handleList().find((h) => h.data.kind === "center")!;
  w.applyDrag(c.data, box0, [10, -20, 5]);
  assert(close(w.snapshot().center, [10, -20, 5]));
  assert(close(w.snapshot().half, [100, 100, 100]), "a translation must not resize");
});

// The minimum-half floor has to hold in the box frame too, or a face can be dragged through its
// opposite and the box inverts.
Deno.test("a face cannot be dragged through its opposite", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90, minHalfMm: 5 });
  const box0 = w.snapshot();
  const fx = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!;
  w.applyDrag(fx.data, box0, [0, -5000, 0]);
  assert(w.snapshot().half[0] >= 5, `half collapsed to ${w.snapshot().half[0]}`);
});

// A corner drag leaves the most view-aligned BOX axis alone — the axis the cursor cannot aim.
Deno.test("a corner drag skips the box axis pointing into the screen", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5, axes: ROT_Z90 });
  const box0 = w.snapshot();
  const corner = w.handleList().find((h) => h.data.kind === "corner")!;
  // Looking along world +X, which after the rotation is the box's -Y axis: box Y must not resize.
  w.applyDrag(corner.data, box0, [30, 30, 30], [1, 0, 0]);
  assert(near(w.snapshot().half[1], 100), `box Y resized to ${w.snapshot().half[1]}`);
});

Deno.test("setAxes re-orients an existing box and moves its handles", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5 });
  const before = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!.world;
  w.setAxes(ROT_Z90);
  const after = w.handleList().find((h) => h.data.kind === "face" && h.data.axis === 0 && h.data.sign === 1)!.world;
  assert(close(before, [100, 0, 0]));
  assert(close(after, [0, 100, 0]), after.join());
});

// ── the handles a SLICE gets ────────────────────────────────────────────────────────────────────
//
// Ron: "It should not show the 3d handles in the 2d, they are useless there. 2D control handles
// should be usable in the slice that is visible, otherwise they are not functional." Two properties
// make a handle functional in a slice view, and both are geometry:
//
//   REACHABLE -- it lies on the plane, because a slice view can only be clicked on its plane.
//   AIMABLE   -- the drag it starts can be steered by a cursor that moves only in that plane.
//
// A plain box on the axial plane: box axes R, A, S with half-extents 50, 60, 70.
const BOX = { center: [0, 0, 0] as Vec3, half: [50, 60, 70] as Vec3 };
const AXIAL = { point: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };

Deno.test("a slice gets four sides, four corners and the centre", () => {
  const hs = sliceHandles(BOX, AXIAL.point, AXIAL.normal);
  assertEquals(hs.length, 9);
  assertEquals(hs.filter((h) => h.data.kind === "face").length, 4, "the two in-plane axes, both ends");
  assertEquals(hs.filter((h) => h.data.kind === "edge").length, 4, "the rectangle's corners ARE edges");
  assertEquals(hs.filter((h) => h.data.kind === "center").length, 1);
  assertEquals(hs.filter((h) => h.data.kind === "corner").length, 0, "a box corner is ambiguous here");
  for (const h of hs) assert(h.cursor.length > 0, "no cursor, so the pointer says nothing");
});

Deno.test("every slice handle lies ON the plane, or it cannot be clicked", () => {
  for (const at of [0, 25, -69.5]) {
    for (const h of sliceHandles(BOX, [0, 0, at], AXIAL.normal)) assert(near(h.world[2], at, 1e-9), `${h.data.kind} at S=${h.world[2]}, plane at ${at}`);
  }
});

// The through-plane axis cannot be aimed: the cursor has no component along it. Its faces would be
// handles that move when dragged in a direction the user cannot express. Slicer fades them out below
// FADE_DEG (vtkMRMLInteractionWidgetRepresentation::GetHandleOpacity).
Deno.test("the faces along the slice normal are left out", () => {
  const faces = sliceHandles(BOX, AXIAL.point, AXIAL.normal).filter((h) => h.data.kind === "face");
  assertEquals(faces.some((h) => h.data.kind === "face" && h.data.axis === 2), false, "an S face on an axial slice");
  assertEquals(new Set(faces.map((h) => h.data.kind === "face" ? h.data.axis : -1)), new Set([0, 1]));
});

// ...but ONLY when it is nearly along the normal. This is where following Slicer's number rather
// than "the most view-aligned of the three" shows: a box tipped 30 degrees has no unaimable axis, so
// every side stays draggable.
Deno.test("a box tipped well off the slice keeps all six sides", () => {
  const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);      // 30 degrees about box Y
  const tipped = { ...BOX, axes: [c, 0, -sn, 0, 1, 0, sn, 0, c] };
  const hs = sliceHandles(tipped, AXIAL.point, AXIAL.normal);
  assertEquals(hs.filter((h) => h.data.kind === "face").length, 6, "30 degrees is plenty to aim");
  assertEquals(hs.filter((h) => h.data.kind === "edge").length, 4, "still four corners on the rectangle");
  assertEquals(hs.length, 11);
  // 5 degrees is NOT: that axis is effectively the view direction.
  const c5 = Math.cos(Math.PI / 36), s5 = Math.sin(Math.PI / 36);
  const barely = { ...BOX, axes: [c5, 0, -s5, 0, 1, 0, s5, 0, c5] };
  assertEquals(sliceHandles(barely, AXIAL.point, AXIAL.normal).filter((h) => h.data.kind === "face").length, 4);
});

// A rectangle's corner names TWO sides, and dragging it moves exactly those two. This is the whole
// reason the slice offers edges rather than box corners: at each of those four points two box
// corners coincide, and a click cannot say which of the two through-plane bounds was meant.
Deno.test("an edge drag resizes the two sides it names and holds the third", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5 });
  const b0 = w.snapshot();
  const edge = w.sliceHandles([0, 0, 0], [0, 0, 1]).find((h) => h.data.kind === "edge")!;
  assert(edge, "no edge handle on the axial plane");
  const e = edge.data as { kind: "edge"; axes: [number, number]; s: [number, number] };
  w.applyDrag(edge.data, b0, [e.s[0] * 10, e.s[1] * 10, 40]);        // 40 mm of through-plane nonsense
  const b1 = w.snapshot();
  assert(near(b1.half[e.axes[0]], b0.half[e.axes[0]] + 5), `axis ${e.axes[0]}: ${b1.half[e.axes[0]]}`);
  assert(near(b1.half[e.axes[1]], b0.half[e.axes[1]] + 5), `axis ${e.axes[1]}: ${b1.half[e.axes[1]]}`);
  assertEquals(b1.half[2], b0.half[2], "the through-plane side moved");
  assertEquals(b1.center[2], b0.center[2], "the box drifted through the plane");
});

Deno.test("a plane clear of the box gets nothing", () => {
  assertEquals(sliceHandles(BOX, [0, 0, 71], AXIAL.normal).length, 0);
  assertEquals(sliceHandles(BOX, [0, 0, -70.001], AXIAL.normal).length, 0);
  assertEquals(sliceHandles(BOX, [0, 0, 69.9], AXIAL.normal).length, 9, "just inside still counts");
  assertEquals(sliceHandles(BOX, AXIAL.point, [0, 0, 0]).length, 0, "no normal, no plane");
});

// One handle, one id: the slice handle and its 3D twin are the same handle seen from two views, so
// hover and tests can name it. The edges have ids of their own, above the fifteen.
Deno.test("slice handles carry stable ids, and the faces match the 3D fifteen", () => {
  const w = createRoiWidget([-100, -100, -100], [100, 100, 100], { coverage: 0.5 });
  const byId = new Map(w.handleList().map((h) => [h.id, h.data]));
  assertEquals(byId.size, 15);
  const hs = w.sliceHandles([0, 0, 0], [0, 0, 1]);
  assertEquals(new Set(hs.map((h) => h.id)).size, hs.length, "two handles share an id");
  for (const h of hs) {
    assertEquals(handleId(h.data), h.id);
    if (h.data.kind === "edge") { assert(h.id >= 15 && h.id <= 26, `edge id ${h.id}`); continue; }
    assertEquals(JSON.stringify(byId.get(h.id)), JSON.stringify(h.data), `id ${h.id} means a different handle in 3D`);
  }
});

// The view direction decides which axis, if any, is unaimable -- Slicer substitutes the slice normal
// for the camera vector in a slice view (GetHandleToCameraVectorWorld) and this is the same test.
Deno.test("degenerateAxis names an axis only when it is nearly along the view direction", () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  assertEquals(degenerateAxis(I, [0, 0, 1]), 2);
  assertEquals(degenerateAxis(I, [0, 0, -1]), 2, "a sign is not a direction difference here");
  assertEquals(degenerateAxis(I, [1, 0, 0]), 0);
  assertEquals(degenerateAxis(I, [1, 1, 0]), -1, "45 degrees off both: neither is unaimable");
  assertEquals(degenerateAxis(I, [0, 0, 0]), -1, "no direction at all");
  // 9 degrees is inside Slicer's fade, 11 is outside
  const d = (deg: number): Vec3 => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)];
  assertEquals(degenerateAxis(I, d(9)), 2);
  assertEquals(degenerateAxis(I, d(11)), -1);
  assertEquals(FADE_DEG, 10);
});
