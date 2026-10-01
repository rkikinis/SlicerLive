// THE FIT, CHECKED AGAINST GEOMETRY RATHER THAN AGAINST A REMEMBERED CONSTANT.
//
// The 3D view fitted with `radius * 2.6`, which contains a sphere of radius r only if the half
// field of view is asin(1/2.6) = 22.6 degrees. vtk's default is 15 (a 30 degree view angle), so the
// fit was a third too close and always overflowed. Ron, having pressed the fit button: "the zoom is
// incorrect, because I dont see the entire data." Nothing in the file said what 2.6 was for, so
// nothing could contradict it.
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { fitDistance, fitParallelScale } from "./vtk-camera.ts";

/** Does a sphere of radius r at distance d fall inside a view of this half-angle? */
const contained = (r: number, d: number, halfAngleRad: number) => Math.asin(Math.min(1, r / d)) <= halfAngleRad + 1e-9;
const halfV = (deg: number) => (deg * Math.PI) / 360;
const halfH = (deg: number, aspect: number) => Math.atan(Math.tan(halfV(deg)) * aspect);

Deno.test("a square viewport at 30 degrees needs 3.86 r, not 2.6 r", () => {
  const d = fitDistance(100, 30, 1, 1);            // no margin, so the number is exact
  assertAlmostEquals(d / 100, 1 / Math.sin(halfV(30)), 1e-6);
  assertAlmostEquals(d, 386.37, 0.01);
  assert(d > 260, `2.6 r would be ${260}, which does not contain the sphere`);
});

Deno.test("the sphere is contained on BOTH axes, at any aspect", () => {
  for (const aspect of [0.35, 0.5, 0.8, 1, 1.4, 2.5, 4]) {
    for (const deg of [20, 30, 45]) {
      const r = 137;
      const d = fitDistance(r, deg, aspect);
      assert(contained(r, d, halfV(deg)), `vertical overflow at aspect ${aspect}, ${deg}deg`);
      assert(contained(r, d, halfH(deg, aspect)), `horizontal overflow at aspect ${aspect}, ${deg}deg`);
    }
  }
});

Deno.test("a tall narrow pane pulls the camera further back than a square one", () => {
  // Conventional Widescreen's 3D pane is taller than it is wide, which is where Ron saw it.
  const square = fitDistance(100, 30, 1);
  const portrait = fitDistance(100, 30, 0.5);
  assert(portrait > square * 1.5, `portrait ${portrait.toFixed(0)} should be well beyond square ${square.toFixed(0)}`);
  // ...and a wide pane never comes closer than the vertical field allows.
  assertAlmostEquals(fitDistance(100, 30, 4), square, 1e-6);
});

Deno.test("orthographic fits the sides too", () => {
  // parallelScale is the half-height in world units. A pane narrower than it is tall must scale up.
  assertAlmostEquals(fitParallelScale(100, 1, 1), 100, 1e-6);
  assertAlmostEquals(fitParallelScale(100, 0.5, 1), 200, 1e-6);
  assertAlmostEquals(fitParallelScale(100, 2, 1), 100, 1e-6);   // wide: height still limits
});
