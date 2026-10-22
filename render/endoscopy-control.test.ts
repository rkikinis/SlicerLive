// Endoscopy's defaults at every scale (render/endoscopy-control.ts): 8 mm/s, a focal point 30 mm ahead and 6 mm from the
// wall on a CT, as before; a sane number of voxels on an electron microscope's grid and an astronomer's (Ron,
// 2026-10-20: "did you forget about scales? from astrophysics to electron microscope").
//   deno test -A --no-check render/endoscopy-control.test.ts
import { assert, assertAlmostEquals } from "jsr:@std/assert@1";
import { attachEndoscopyControls, type EndoCamera } from "./endoscopy-control.ts";
import { SCALES } from "./scale-fixtures.ts";

const fakeCanvas = () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) as unknown as HTMLCanvasElement;

/** One flight: `seconds` of cruise toward a wall `wall` ahead; what it did. */
function fly(voxel: number | undefined, wall = Infinity, seconds = 1) {
  const camera: EndoCamera = { position: [0, 0, 0], focalPoint: [0, 1, 0], viewUp: [0, 0, 1], viewAngle: 80 };
  const c = attachEndoscopyControls(fakeCanvas(), camera, { voxel, clearance: () => wall - camera.position[1] });   // a wall at y = wall
  c.setCruise("forward");
  for (let i = 0; i < seconds * 10; i++) c.tick(0.1);
  const focal = Math.hypot(camera.focalPoint[0] - camera.position[0], camera.focalPoint[1] - camera.position[1], camera.focalPoint[2] - camera.position[2]);
  const out = { speed: c.speed(), travelled: camera.position[1], focal, slowest: (c.setSpeed(0), c.speed()) };
  c.detach();
  return out;
}

Deno.test("endoscopy on a clinical grid flies as before", () => {
  for (const v of [undefined, 0.3, 0.7, 3]) {
    const f = fly(v);
    assertAlmostEquals(f.speed, 8, 1e-12);
    assertAlmostEquals(f.travelled, 8, 1e-9);
    assertAlmostEquals(f.focal, 30, 1e-9);
    assertAlmostEquals(f.slowest, 0.1, 1e-12);
    assertAlmostEquals(fly(v, 10).travelled, 4, 1e-9, "stops 6 mm short of a wall 10 mm ahead");
  }
});

for (const [what, v] of SCALES) {
  Deno.test(`endoscopy's defaults are a sane number of voxels: ${what}`, () => {
    const f = fly(v);
    const perSec = f.travelled / v, focal = f.focal / v, slowest = f.slowest / v;
    assert(perSec >= 2 && perSec <= 32 * (1 + 1e-9), `${perSec} voxels a second`);
    assert(focal >= 7.5 && focal <= 120 * (1 + 1e-9), `focal point ${focal} voxels ahead`);
    assert(slowest > 0 && slowest <= 0.4 * (1 + 1e-9), `slowest ${slowest} voxels a second`);
    const short = (100 * v - fly(v, 100 * v, 60).travelled) / v;   // what it keeps from a wall 100 voxels ahead
    assert(short >= 1.5 * (1 - 1e-9) && short <= 24 * (1 + 1e-9), `stops ${short} voxels short of the wall`);
  });
}
