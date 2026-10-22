// The paint stroke's stamp spacing (logic/segmentation-editor.ts paintStepMm) at three scales, and unchanged on
// clinical grids.
//   deno test -A --no-check logic/segmentation-editor.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { paintStepMm } from "./segmentation-editor.ts";
import { SCALES } from "../render/scale-fixtures.ts";

for (const [what, v] of SCALES) {
  Deno.test(`a stroke stamps every half to one voxel: ${what}`, () => {
    const s = paintStepMm(v);
    assert(s >= 0.5 * v * (1 - 1e-12) && s <= v * (1 + 1e-12), `${s} for a ${v} mm voxel`);
  });
}

Deno.test("on clinical grids the stamp spacing is the 0.5 mm it was", () => {
  // the old rule, max(0.5, half the smaller of the radius and the voxel), for a brush wider than a voxel
  const old = (v: number, r: number) => Math.max(0.5, Math.min(r, v) * 0.5);
  for (const v of [0.5, 0.7, 0.8, 1, 1.25, 2, 3, 5]) assertEquals(paintStepMm(v), old(v, 10), `${v} mm grid`);
});
