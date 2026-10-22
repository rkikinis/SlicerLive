// The driver's default brush (algorithms/seg-edit-driver.ts strokeDiameterMm) at three scales: 6 voxels of the grid.
//   deno test -A --no-check algorithms/seg-edit-driver.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { DEFAULT_BRUSH_VOXELS, strokeDiameterMm } from "./seg-edit-driver.ts";
import { SCALES } from "../render/scale-fixtures.ts";

for (const [what, v] of SCALES) {
  Deno.test(`the default brush is ${DEFAULT_BRUSH_VOXELS} voxels of the grid: ${what}`, () => {
    assertEquals(strokeDiameterMm(undefined, undefined, [2 * v, v, 3 * v]), DEFAULT_BRUSH_VOXELS * v);
    assertEquals(strokeDiameterMm({ diameterMm: 12 * v }, undefined, [v, v, v]), 12 * v);   // the op's own wins
    assertEquals(strokeDiameterMm({ shape: "sphere" }, 4 * v, [v, v, v]), 4 * v);         // then the driver's
  });
}

Deno.test("the default brush on a 1 mm grid is the 6 mm it was; a grid with no spacing gets the last resort", () => {
  assertEquals(strokeDiameterMm(undefined, undefined, [1, 1, 1]), 6);
  assertEquals(strokeDiameterMm(undefined, undefined, [0, 0, 0]), 6);
});
