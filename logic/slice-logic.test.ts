// T1: fit + offset-range math vs the live-Slicer fixture (harness/fixtures/slicer-startup.json = MRHead).
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { fitFovToVolume, offsetRangeResolution, reformatSliceToRAS } from "./slice-logic.ts";
import { fixture } from "../harness/fixtures.ts";

interface Startup { volume: { dims: number[]; ijkToRAS: number[]; rasLo: number[]; rasHi: number[] }; slices: Record<string, { fieldOfView: number[]; dimensions: number[] }> }
const ORIENT: Record<string, "axial" | "coronal" | "sagittal"> = { axial: "axial", coronal: "coronal", sagittal: "sagittal" };

Deno.test("fitFovToVolume matches Slicer's FitSliceToVolumes for MRHead (all 3 orientations)", async () => {
  const s = await fixture<Startup>("slicer-startup.json");
  const { ijkToRAS, rasLo, rasHi } = s.volume;
  for (const [key, sl] of Object.entries(s.slices)) {
    const [w, h] = sl.dimensions;
    const fov = fitFovToVolume(ORIENT[key], rasLo as [number, number, number], rasHi as [number, number, number], ijkToRAS, w, h);
    assertAlmostEquals(fov[0], sl.fieldOfView[0], 0.5, `${key} fovX`);
    assertAlmostEquals(fov[1], sl.fieldOfView[1], 0.5, `${key} fovY`);
    assertAlmostEquals(fov[2], sl.fieldOfView[2], 0.01, `${key} slab`);
  }
});

// The MRHead fixture only exercises volumes the HEIGHT ratio happens to decide, so it passed both
// with and without the extent actually being covered. These are the cases it never reached: a volume
// proportionally wider than its cell, and one proportionally taller.
Deno.test("fitFovToVolume covers the WHOLE extent, whichever way the volume is out of proportion", () => {
  const wide = fitFovToVolume("axial", [0, 0, 0], [350, 100, 10], [], 270, 180);
  assert(wide[0] >= 350 - 1e-6, `wide fovX ${wide[0]} must cover the 350 mm extent`);
  assert(wide[1] >= 100 - 1e-6, `wide fovY ${wide[1]} must cover the 100 mm extent`);

  const tall = fitFovToVolume("axial", [0, 0, 0], [100, 400, 10], [], 200, 100);
  assert(tall[0] >= 100 - 1e-6, `tall fovX ${tall[0]} must cover the 100 mm extent`);
  assert(tall[1] >= 400 - 1e-6, `tall fovY ${tall[1]} must cover the 400 mm extent`);

  // and the field of view keeps the viewport's aspect, so the fit letterboxes rather than distorts
  assertAlmostEquals(wide[0] / wide[1], 270 / 180, 1e-9, "wide keeps the viewport aspect");
  assertAlmostEquals(tall[0] / tall[1], 200 / 100, 1e-9, "tall keeps the viewport aspect");
});

Deno.test("offsetRangeResolution: bounds along the normal, step = spacing", async () => {
  const s = await fixture<Startup>("slicer-startup.json");
  const { ijkToRAS, rasLo, rasHi } = s.volume;
  const ax = offsetRangeResolution("axial", ijkToRAS, rasLo as [number, number, number], rasHi as [number, number, number]);
  assertAlmostEquals(ax.step, 1.0, 1e-3);                       // MRHead axial spacing
  assert(ax.max - ax.min > 250, "axial range spans the S extent (~256)");
  const sag = offsetRangeResolution("sagittal", ijkToRAS, rasLo as [number, number, number], rasHi as [number, number, number]);
  assertAlmostEquals(sag.step, 1.3, 0.01);                      // sagittal normal is R; spacing 1.3
});

Deno.test("reformatSliceToRAS: canonical planes with the current centre", () => {
  const c: [number, number, number] = [5, -3, 12];
  const ax = reformatSliceToRAS("axial", c);
  // translation column holds the centre
  assertEquals([ax[3], ax[7], ax[11]], [5, -3, 12]);
  // plane normal (col 2) is +S for axial, +R for sagittal, +A for coronal
  const normal = (m: number[]) => [m[2], m[6], m[10]];
  assertEquals(normal(reformatSliceToRAS("axial", c)), [0, 0, 1]);
  assertEquals(normal(reformatSliceToRAS("sagittal", c)), [1, 0, 0]);
  assertEquals(normal(reformatSliceToRAS("coronal", c)), [0, 1, 0]);
});
