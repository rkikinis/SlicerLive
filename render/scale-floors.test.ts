// NO FIXED LENGTH IN THE 3D VIEW'S FIELDS (Ron, 2026-10-20: "did you forget about scales? from astrophysics to electron
// microscope"; Contents/docs/scale-sweep-2026-10-20.md, items 3, 4, 11, 12, 13, 18). Every step, floor, bar, margin and
// drawing-look length is checked at an electron microscope's 1 nm voxels, a clinical 0.7 mm CT and an astronomer's
// parsec: a sane number of voxels at all three, and at 0.7 mm the value Ron approved by eye, unchanged.
//
// These are CPU-side descriptions of the fields, so the test runs headlessly.
//
//   deno test -A --no-check render/scale-floors.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { SCALES } from "./scale-fixtures.ts";
import { drawingLookParams, marchStep, wgslF32 } from "./scene-renderer.ts";
import { segmentSampleStep } from "./fields.ts";
import { RoiBoxField } from "./roi-box-field.ts";
import { roiBarHalf } from "./demos/roi-widget.ts";
import { FiducialField, glyphStep, screenPad } from "./fiducial-field.ts";
import { CapsuleField } from "./capsule-field.ts";
import { SlicePlaneField } from "./slice-plane-field.ts";
import { CardField } from "./card-field.ts";
import type { Vec3 } from "./mat4.ts";

// A part in a million of slack: glyph centers are held in float32, as the shader reads them.
const inVoxels = (x: number, v: number, lo: number, hi: number, what: string) =>
  assert(Number.isFinite(x) && x >= lo * v * (1 - 1e-6) && x <= hi * v * (1 + 1e-6), `${what}: ${x / v} voxels, not ${lo}..${hi}`);
const cube = (v: number, n = 256): [Vec3, Vec3] => [[0, 0, 0], [n * v, n * v, n * v]];
const tex = {} as GPUTexture;

for (const [what, v] of SCALES) {
  Deno.test(`the march step and a segment's step follow the voxels: ${what}`, () => {
    assertEquals(segmentSampleStep(v), 0.5 * v);
    // A glyph's or a widget's step never holds the scene finer than a fifth of a voxel (it is the MIN that marches).
    inVoxels(marchStep([segmentSampleStep(v), glyphStep(v), new RoiBoxField([0, 0, 0], [128 * v, 128 * v, 128 * v], { voxel: v }).sampleStep()]), v, 0.05, 0.5, "march");
    assertEquals(marchStep([0, NaN, -1, 2 * v]), 2 * v, "a step that is not a positive number is left out, not floored");
  });

  Deno.test(`the drawing look's lengths are voxels of the data: ${what}`, () => {
    const [ao, strength, outline, halo, tol] = drawingLookParams(v);
    inVoxels(ao, v, 2.8, 56, "AO radius");
    inVoxels(outline, v, 0.5, 10, "outline threshold");
    inVoxels(tol, v, 0.06, 1.2, "crevice tolerance");
    assertEquals([strength, halo], [0.9, 0.45]);
  });

  Deno.test(`the crop box's and the scene box's bars are voxels of the data: ${what}`, () => {
    const [lo, hi] = cube(v);
    inVoxels(roiBarHalf(lo, hi, v), v, 0.1, 3, "crop box bar");
    inVoxels(RoiBoxField.frameBarHalf(lo, hi, v), v, 0.08, 3, "scene box bar");
    inVoxels(RoiBoxField.frameBarHalf(lo, hi), v, 0.08, 3, "scene box bar, no voxel given");
    const f = new RoiBoxField([0, 0, 0], [128 * v, 128 * v, 128 * v], { voxel: v });
    const bar = f["bar"] as number;
    inVoxels(bar, v, 0.3, 6, "default bar");
    inVoxels(f.sampleStep(), v, 0.05, 6, "frame step");
    const margin = f.aabb()[1][0] - 128 * v - bar;
    inVoxels(margin, v, 0.1, 2, "frame bounds margin");
  });

  Deno.test(`screen-space glyphs' bounds and steps are voxels of the data: ${what}`, () => {
    inVoxels(screenPad(0, v), v, 8, 160, "pad around one point");
    for (const field of [
      new FiducialField([{ center: [v, v, v], radius: 9, color: [1, 1, 1, 1] }], { screenSpace: true, voxel: v }),
      new CapsuleField([{ a: [v, v, v], b: [v, v, v], radius: 2, color: [1, 1, 1, 1] }], { screenSpace: true, voxel: v }),
    ]) {
      inVoxels(field.aabb()[1][0] - v, v, 8, 160, `${field.kind} bounds margin`);
      inVoxels(field.sampleStep(), v, 0.2, 4, `${field.kind} step`);
    }
    const g = new FiducialField([{ center: [0, 0, 0], radius: 9, color: [1, 1, 1, 1] }], { screenSpace: true });
    g.setVoxel(v);
    inVoxels(g.aabb()[1][0], v, 8, 160, "after setVoxel");
  });

  Deno.test(`a thin slab asks for a step of its own thickness, not of a millimeter: ${what}`, () => {
    const s = new SlicePlaneField(tex, { p2t: new Array(16).fill(0) as never, origin: [0, 0, 0], normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0], halfExtU: 128 * v, halfExtV: 128 * v, clim: [0, 1], halfThick: v / 2 });
    assertEquals(s.sampleStep(), v);
    const c = new CardField(tex, { aabb: cube(v) });
    c.setBillboard([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 10 * v, 10 * v, v);
    assertEquals(c.sampleStep(), 0.5 * v);
    assertEquals(c["inkFrontMm"], v);
  });

  Deno.test(`a bound baked into a shader keeps its digits: ${what}`, () => {
    for (const x of [123.4567 * v, -3.5 * v, 256 * v]) {
      const t = wgslF32(x);
      assert(/[.eE]/.test(t), t);
      assertEquals(Math.fround(Number(t)), Math.fround(x), `${x} written as ${t}`);
    }
  });
}

// AT 0.7 MM, EVERYTHING IS AS RON APPROVED IT: the old fixed values come out exactly.
Deno.test("on a clinical grid the old values are kept", () => {
  const v = 0.7;
  assertEquals(drawingLookParams(v), [14, 0.9, 2.5, 0.45, 0.3]);
  assertEquals(drawingLookParams(undefined), [14, 0.9, 2.5, 0.45, 0.3]);
  for (const ext of [30, 100, 200, 400, 900]) {
    const lo: Vec3 = [0, 0, 0], hi: Vec3 = [ext, ext * 0.8, ext * 0.6];
    const d = Math.hypot(hi[0], hi[1], hi[2]);
    assertEquals(roiBarHalf(lo, hi, v), Math.max(0.5, Math.max(3, d * 0.012) * 0.12), `crop bar at ${ext} mm`);
    assertEquals(RoiBoxField.frameBarHalf(lo, hi, v), Math.max(0.4, d * 0.001), `scene bar at ${ext} mm`);
    if (ext >= 64) assertEquals(RoiBoxField.frameBarHalf(lo, hi), Math.max(0.4, d * 0.001), `scene bar at ${ext} mm, no voxel`);
  }
  for (const bar of [0.3, 0.4, 0.5, 1.5, 3]) {
    const f = new RoiBoxField([0, 0, 0], [100, 100, 100], { barHalfMm: bar, voxel: v });
    assertEquals(f.sampleStep(), Math.max(0.5 * bar, 0.25));
    assertEquals(f.aabb()[1][0], 100 + bar + 0.5);
  }
  for (const half of [32, 100, 640]) assertEquals(new RoiBoxField([0, 0, 0], [half, half, half])["bar"], 1.5, `default bar, box half ${half}`);
  assertEquals(screenPad(0, v), 40);
  assertEquals(screenPad(1000, v), 150);
  assertEquals(screenPad(0, undefined), 40);
  assertEquals(glyphStep(v), 1);
  assertEquals(glyphStep(undefined), 1);
  assertEquals(new FiducialField([]).sampleStep(), 1);
  assertEquals(new CapsuleField([]).sampleStep(), 1);
  assertEquals(segmentSampleStep(v), Math.max(0.5 * v, 0.1));
  assertEquals(marchStep([v, 1, 0.25]), 0.25);
  assertEquals(marchStep([]), 1);
});

// No shader floors the step at a length any more; every field reads it through the renderer's scene_step().
Deno.test("no shader floors the march step at 1e-3 mm", async () => {
  const dir = new URL(".", import.meta.url);
  for (const f of ["scene-renderer.ts", "fields.ts", "colorize-field.ts", "roi-box-field.ts", "fiber-field.ts", "cine-field.ts"]) {
    const src = await Deno.readTextFile(new URL(f, dir));
    assert(!/max\(u_material\.[a-z0-9_${}.]+, 1e-3\)/.test(src), `${f} still floors a uniform at 1e-3`);
  }
  assert((await Deno.readTextFile(new URL("scene-renderer.ts", dir))).includes("fn scene_step() -> f32"));
});
