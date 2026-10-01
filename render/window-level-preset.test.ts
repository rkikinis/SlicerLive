// The 3D view was a black cube for MR, because every preset is stated in absolute Hounsfield units.
//
//   deno test -A --no-check render/window-level-preset.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { looksLikeHounsfield, RAMP_PEAK, windowLevelPreset } from "./window-level-preset.ts";

// The failure exactly: CT-Soft-Tissue's ramp lives between about -160 and 240 HU. A T1 brain sits at
// a few hundred arbitrary units with nothing negative, so every voxel is below the first stop.
Deno.test("the ramp covers the data's own window, which a HU preset does not", () => {
  const p = windowLevelPreset(600, 400);          // level 400, window 600 -> [100, 700]
  const lo = p.opacityTF[0][0], hi = p.opacityTF[p.opacityTF.length - 1][0];
  assertEquals(lo, 100);
  assertEquals(hi, 700);
  assertEquals(p.opacityTF[p.opacityTF.length - 1][1], RAMP_PEAK);
});

Deno.test("nothing is opaque at the bottom of the window, or it renders as fog", () => {
  const p = windowLevelPreset(600, 400);
  assertEquals(p.opacityTF[0][1], 0);
  assertEquals(p.opacityTF[1][1], 0);
  assert(p.opacityTF[1][0] > p.opacityTF[0][0], "the dead zone has width");
});

Deno.test("opacity rises across the window and never reaches fully opaque", () => {
  const a = windowLevelPreset(600, 400).opacityTF.map((s) => s[1]);
  for (let i = 1; i < a.length; i++) assert(a[i] >= a[i - 1], "monotonic");
  assert(a[a.length - 1] < 1, "a fully opaque surface hides everything behind it");
});

Deno.test("colour is a greyscale ramp: the data comes with no palette to use", () => {
  const p = windowLevelPreset(600, 400);
  assertEquals(p.colorTF[0].slice(1), [0, 0, 0]);
  assertEquals(p.colorTF[1].slice(1), [1, 1, 1]);
});

Deno.test("a zero window does not produce a degenerate or NaN transfer function", () => {
  const p = windowLevelPreset(0, 100);
  for (const s of [...p.colorTF, ...p.opacityTF]) for (const v of s) assert(Number.isFinite(v), `${v}`);
});

// The discriminator is air: a CT of anything contains it at about -1000 HU; MR magnitude images are
// non-negative. A stated modality beats an inferred one.
Deno.test("Hounsfield is recognised by the presence of air, or by a stated modality", () => {
  assertEquals(looksLikeHounsfield([-1024, 3071]), true);
  assertEquals(looksLikeHounsfield([0, 1400]), false, "an MR range is not Hounsfield");
  assertEquals(looksLikeHounsfield([-5, 1400]), false, "slightly negative is noise, not air");
  assertEquals(looksLikeHounsfield([0, 1400], "CT"), true, "a stated modality wins");
  assertEquals(looksLikeHounsfield([-1024, 3071], "MR"), false, "a stated modality wins here too");
  assertEquals(looksLikeHounsfield(undefined), false, "unknown is not assumed to be CT");
});
