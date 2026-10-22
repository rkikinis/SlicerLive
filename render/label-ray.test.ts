// The label march's step (render/label-ray.ts) at three scales: an electron microscope's 1 nm voxels, a clinical
// 0.7 mm CT, and an astronomer's 1 parsec voxels. The shader computes the same as labelRayStep.
//   deno test -A --no-check render/label-ray.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { LABEL_RAY_MAX_STEPS, labelRayStep } from "./label-ray.ts";
import { SCALES } from "./scale-fixtures.ts";

for (const [what, v] of SCALES) {
  Deno.test(`the label march steps a voxel and reaches the end: ${what}`, () => {
    const span = 512 * v;                                  // a ray through 512 voxels of labelmap
    assertEquals(labelRayStep(v, span), v);                // the step asked for (it was floored at 0.01 / 1e-3 mm)
    assertEquals(labelRayStep(0.25 * v, span), 0.25 * v);  // the quarter-voxel march from a surface
    // a step too small for the guard is raised so the march still reaches the end of the labelmaps
    const tiny = labelRayStep(v * 1e-6, span);
    assert(tiny * LABEL_RAY_MAX_STEPS >= span * (1 - 1e-12));
    assertEquals(labelRayStep(0, span), span / LABEL_RAY_MAX_STEPS);
    assertEquals(labelRayStep(NaN, span), span / LABEL_RAY_MAX_STEPS);
  });
}
