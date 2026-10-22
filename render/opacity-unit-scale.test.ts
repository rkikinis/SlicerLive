// The volume rendering's opacity unit at every scale (render/livescene.ts, VolumeRenderingDisplayableManager): Slicer's
// presets at VTK's 1 mm unit (Ron: "the 1mm did the trick") and the colorize field's 10 mm, EXACTLY as before on every
// clinical grid, and a sane number of voxels on an electron microscope's and an astronomer's.
//   deno test -A --no-check render/opacity-unit-scale.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { VolumeRenderingDisplayableManager as VR } from "./livescene.ts";
import { SCALES } from "./scale-fixtures.ts";

Deno.test("the opacity units are today's on every clinical grid, 0.3 to 3 mm voxels", () => {
  for (let v = 0.3; v <= 3 + 1e-9; v += 0.05) {
    assertEquals(VR.presetUnit(v), 1, `preset unit on ${v.toFixed(2)} mm voxels`);
    assertEquals(VR.colorizeUnit(v), 10, `colorize unit on ${v.toFixed(2)} mm voxels`);
  }
  for (const v of [0.25, 0.5, 0.7, 0.92, 1.5, 4]) { assertEquals(VR.presetUnit(v), 1); assertEquals(VR.colorizeUnit(v), 10); }
  // No grid known: the mm stand.
  assertEquals(VR.presetUnit(undefined), 1);
  assertEquals(VR.colorizeUnit(undefined), 10);
});

for (const [what, v] of SCALES) {
  Deno.test(`the opacity units are a sane number of voxels: ${what}`, () => {
    const preset = VR.presetUnit(v) / v, colorize = VR.colorizeUnit(v) / v;
    assert(preset >= 0.25 && preset <= 4, `preset unit ${preset} voxels`);
    assert(colorize >= 2.5 && colorize <= 40, `colorize unit ${colorize} voxels`);
    // The colorize unit stays ten times the preset's wherever both are inside their ranges, and never below it.
    assert(colorize >= preset);
  });
}
