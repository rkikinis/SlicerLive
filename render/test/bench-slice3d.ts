// WHAT A SLICE IN THE 3D VIEW COSTS.
//
// Ron: "making the a slice visible in the 3d window perceptibly slows down the rendering in the 3d."
//
// Two candidate causes and they are not the same fix. The scene marches at the MINIMUM sampleStep of
// any field (scene-renderer.ts), and SlicePlaneField asks for 0.25 mm — so one slice can force the
// whole volume to a finer step. Separately, every field costs work at every step, so three slices
// are three more evaluations per step regardless of the step size. Measured here rather than argued.
//
//   deno run --unstable-webgpu --allow-read --allow-net render/test/bench-slice3d.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildRoiScene } from "../demos/roi-scene.ts";
import { SlicePlaneField } from "../slice-plane-field.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const Q = 512, FRAMES = 12;
const gpu = await initDevice();
const roi = await buildRoiScene(gpu.device);
const scene = new SceneRenderer(gpu);
const cam = framedCamera(roi.sv.center as Vec3, roi.sv.radius, 2.8);

const time = async (label: string, fields: unknown[]) => {
  scene.build(fields as Parameters<typeof scene.build>[0]);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  await scene.renderToRGBA(Q, Q);                      // warm: pipeline build is not what we measure
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) await scene.renderToRGBA(Q, Q);
  const ms = (performance.now() - t0) / FRAMES;
  console.log(`  ${label.padEnd(30)} ${ms.toFixed(1)} ms/frame`);
  return ms;
};

const plane = (halfThick: number) => {
  const [lo, hi] = roi.image.aabb();
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return new SlicePlaneField(roi.image.volumeTexture(), {
    p2t: roi.image.patientToTexture(),
    origin: c, normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0],
    halfExtU: (hi[0] - lo[0]) / 2, halfExtV: (hi[1] - lo[1]) / 2,
    clim: roi.image.getClim(), halfThick, normScale: roi.image.normScaleOf(),
  });
};

console.log(`volume sampleStep ${roi.image.sampleStep().toFixed(3)} mm`);
const base = await time("volume only", [roi.image]);
const p1 = plane(0.5);
console.log(`slice sampleStep   ${p1.sampleStep().toFixed(3)} mm`);
const one = await time("+ 1 slice", [roi.image, p1]);
const three = await time("+ 3 slices", [roi.image, plane(0.5), plane(0.5), plane(0.5)]);
// The same three slices, but not allowed to drag the global step below the volume's.
const coarse = plane(0.5) as unknown as { sampleStep(): number };
const asVolume = roi.image.sampleStep();
for (const p of [coarse]) p.sampleStep = () => asVolume;
const c1 = plane(0.5), c2 = plane(0.5);
for (const p of [c1, c2] as unknown as { sampleStep(): number }[]) p.sampleStep = () => asVolume;
const threeCoarse = await time("+ 3 slices, step not forced", [roi.image, coarse, c1, c2]);

console.log(`\none slice: ${((one / base - 1) * 100).toFixed(0)}% slower · three: ${((three / base - 1) * 100).toFixed(0)}%`);
console.log(`of which the forced step accounts for ${(((three - threeCoarse) / (three - base)) * 100).toFixed(0)}%`);

// ── THE SAME SLICES AS QUADS ───────────────────────────────────────────────────────────────────
//
// The composite on a textured quad in the mesh pass, which is what Slicer does and what the app now
// does. Not a field: not in the march, not in min(sampleStep), and its cost does not depend on how
// many datasets went into the picture. Everything above is the cost of the design it replaced.
const sliceComposite = (n: number) => {
  const [lo, hi] = roi.image.aabb();
  const sr = new SliceRenderer(gpu, "rgba8unorm-srgb");
  sr.setVolume(roi.image.patientToTexture(), lo, hi);
  sr.setTextures(roi.image.volumeTexture());
  const cl = roi.image.getClim();
  sr.setWindowLevel(cl[1] - cl[0], (cl[0] + cl[1]) / 2);
  sr.setPlane("axial", 0.5 + n * 0.03);       // slightly apart, so three of them actually intersect
  const T = 512;
  const tex = gpu.device.createTexture({
    size: [T, T], format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const frame = sr.renderPatientFrameInto(tex.createView(), T, T);
  return { id: "q" + n, tex, opacity: 1, ...frame };
};
const timeQuads = async (label: string, n: number) => {
  scene.build([roi.image] as Parameters<typeof scene.build>[0]);
  scene.setSliceQuads(Array.from({ length: n }, (_, i) => sliceComposite(i)));
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  await scene.renderToRGBA(Q, Q);
  const t0 = performance.now();
  for (let i = 0; i < FRAMES; i++) await scene.renderToRGBA(Q, Q);
  const ms = (performance.now() - t0) / FRAMES;
  console.log(`  ${label.padEnd(30)} ${ms.toFixed(1)} ms/frame   (${((ms / base - 1) * 100).toFixed(0)}% vs volume only)`);
  scene.setSliceQuads([]);
  return ms;
};
console.log("");
const q1 = await timeQuads("+ 1 slice as a QUAD", 1);
const q3 = await timeQuads("+ 3 slices as QUADS", 3);
console.log(`\nfield -> quad:  one slice ${((one / base - 1) * 100).toFixed(0)}% -> ${((q1 / base - 1) * 100).toFixed(0)}%   three ${((three / base - 1) * 100).toFixed(0)}% -> ${((q3 / base - 1) * 100).toFixed(0)}%`);

// ── is the fine step BUYING anything? ───────────────────────────────────────────────────────────
//
// A slab of thickness T is guaranteed at least one sample when the step is T: whatever the phase, a
// sample landing just before the slab puts the next one inside it. SlicePlaneField asks for
// halfThick — HALF the slab — so it oversamples by two and drags the whole scene with it. Whether
// that buys anything is a question about pixels, and the answer is countable.
const litPlane = (a: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < Q * Q; i++) if (Math.max(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]) > 40) n++;
  return n;
};
const shot = async (step: number) => {
  const p = plane(0.5) as unknown as { sampleStep(): number };
  p.sampleStep = () => step;
  scene.build([roi.image, p] as Parameters<typeof scene.build>[0]);
  scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q);
  return litPlane(await scene.renderToRGBA(Q, Q));
};
const fine = await shot(0.5), coarseN = await shot(1.0);
console.log(`\nlit pixels at step 0.5: ${fine}   at step 1.0 (the slab's own thickness): ${coarseN}`);
console.log(`difference: ${(Math.abs(fine - coarseN) / fine * 100).toFixed(2)}%`);
