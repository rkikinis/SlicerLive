import { assertEquals } from "jsr:@std/assert";
import { MOVING_SCALE_STEP, stepMovingScale } from "./budget-controller.ts";

// A drag must not ask for a new render-target size every frame (Ron's window, 2026-09-24 16:40: reset out of
// memory after a minute of a scale that changed nearly every frame).
Deno.test("the moving scale changes in steps, and only when the budget leaves the band", () => {
  let s = 0, sizes = new Set<number>();
  // A budget wobbling around 0.6.
  for (const raw of [0.61, 0.58, 0.66, 0.55, 0.63, 0.57, 0.64, 0.6, 0.56, 0.67]) { s = stepMovingScale(s, raw); sizes.add(s); }
  assertEquals([...sizes], [0.5], "one size for the whole wobble");
  assertEquals(stepMovingScale(0.5, 0.64), 0.5, "inside the band: stay");
  assertEquals(stepMovingScale(0.5, 0.7), 0.625, "past the band: move");
  assertEquals(stepMovingScale(0.5, 0.42), 0.375, "below the band: move down");
  assertEquals(stepMovingScale(0.5, 0.99), 1, "near full resolution is full resolution");
  assertEquals(stepMovingScale(1, 0.9), 0.875, "leaving full resolution lands on a step");
  assertEquals(stepMovingScale(0, 0.1), 0.25, "never below a quarter");
  for (const raw of [0.3, 0.44, 0.71, 0.93]) assertEquals((stepMovingScale(0, raw) / MOVING_SCALE_STEP) % 1, 0);
});
