import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { orthoZO, type Vec3 } from "../mat4.ts";
import { labelFacesAway } from "../vtk-camera.ts";


// ORTHOGRAPHIC, checked against the same depth convention perspectiveZO uses. Ron reported the
// projection toggle as "no visible effect, but when it is activated, zoom and pan stopp working" --
// because setCamera always built a perspective matrix, so parallelScale (which is what dolly changes
// under parallel projection) was written and never read. This pins the matrix that fixes it.
Deno.test("orthoZO maps near to 0 and far to 1, and does not vary with depth", () => {
  const halfH = 50, aspect = 2, near = 1, far = 1001;
  const m = orthoZO(halfH, aspect, near, far);
  const apply = (p: [number, number, number]) => {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w, y / w, z / w];
  };
  // Depth: near -> 0, far -> 1, exactly as perspectiveZO.
  assertAlmostEquals(apply([0, 0, -near])[2], 0, 1e-6);
  assertAlmostEquals(apply([0, 0, -far])[2], 1, 1e-6);
  // The top edge of the view volume lands on the NDC top edge, whatever the depth -- that "whatever
  // the depth" is the whole point of an orthographic projection and what a perspective matrix cannot do.
  for (const z of [-near, -200, -far]) {
    assertAlmostEquals(apply([0, halfH, z])[1], 1, 1e-6);
    assertAlmostEquals(apply([halfH * aspect, 0, z])[0], 1, 1e-6);
  }
});

// WHICH AXIS LABEL TO HIDE. Ron, on a rendering with the P label sitting on the anatomy: "Look at
// the solution in slicer. The one in front of the object is turned off, so it does not obstruct the
// object that we are looking at. In the current location, the P should not be visible."
//
// This test exists because the obvious rule is wrong and looked right. A plain back-face test --
// hide any face pointing away from the camera -- hid FIVE of the six labels on an axis-aligned view.
Deno.test("only the label on the far face is hidden, not the sides", () => {
  const FACES: [readonly [number, number, number], string][] = [
    [[1, 0, 0], "R"], [[-1, 0, 0], "L"], [[0, 1, 0], "A"],
    [[0, -1, 0], "P"], [[0, 0, 1], "S"], [[0, 0, -1], "I"],
  ];
  const hiddenFrom = (viewDir: readonly [number, number, number]) =>
    FACES.filter(([n]) => labelFacesAway(n as unknown as Vec3, viewDir as unknown as Vec3)).map(([, s]) => s);

  // Looking from ANTERIOR: the camera looks along -A, so the far face is P and only P goes.
  assertEquals(hiddenFrom([0, -1, 0]), ["P"]);
  // From every other axis, likewise exactly one -- and never the four sides.
  //
  // MIND THE DIRECTION. `viewDir` is where the camera LOOKS, so the hidden face is the one whose
  // outward normal runs the same way: looking along -x is looking toward the patient's LEFT, so L is
  // the far face and L is what goes. I had four of these six backwards on the first pass, which is
  // the entire reason this test is written out longhand instead of trusting the reasoning.
  assertEquals(hiddenFrom([0, 1, 0]), ["A"]);
  assertEquals(hiddenFrom([-1, 0, 0]), ["L"]);
  assertEquals(hiddenFrom([1, 0, 0]), ["R"]);
  assertEquals(hiddenFrom([0, 0, -1]), ["I"]);
  assertEquals(hiddenFrom([0, 0, 1]), ["S"]);
  // Corner-on, the two faces sharing the far corner both obstruct, and both go. A view direction of
  // (-x, -y) looks toward the patient's LEFT and POSTERIOR, so those are the far faces -- not R,
  // which my first version of this assertion said and which the implementation correctly refused.
  const k = 1 / Math.sqrt(2);
  assertEquals(hiddenFrom([-k, -k, 0]).sort(), ["L", "P"]);
  // A view direction need not be normalised.
  assertEquals(hiddenFrom([0, -37, 0]), ["P"]);
});
