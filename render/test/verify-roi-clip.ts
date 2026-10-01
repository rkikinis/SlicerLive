// Regression for the ROI-crop feature (ARCHITECTURE-2026-07-24 §6.4):
//   1. setClipBox crops the volume (fewer lit px); clearClip restores byte-identical.
//   2. The RoiBoxField wireframe renders (yellow pixels present).
//   3. applyDrag on a face handle resizes the box; on the centre handle it translates it.
//   All updates are Tier-A (syncUniforms, no rebuild).
//   deno run --unstable-webgpu --allow-read --allow-net render/test/verify-roi-clip.ts
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { buildRoiScene } from "../demos/roi-scene.ts";
import { RoiBoxField } from "../roi-box-field.ts";
import { framedCamera } from "../demos/camera-control.ts";
import type { Vec3 } from "../mat4.ts";

const Q = 360;
const gpu = await initDevice();
const roi = await buildRoiScene(gpu.device);
const scene = new SceneRenderer(gpu);
scene.build([roi.image, roi.box, roi.handles]);
scene.setBackground(0.05, 0.06, 0.09);
const cam = framedCamera(roi.sv.center as Vec3, roi.sv.radius, 2.8);
const render = async () => { scene.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, Q, Q); return await scene.renderToRGBA(Q, Q); };
const lit = (a: Uint8Array) => { let n = 0; for (let i = 0; i < Q * Q; i++) if (Math.max(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]) > 110) n++; return n; };
const yellow = (a: Uint8Array) => { let n = 0; for (let i = 0; i < Q * Q; i++) { const R = a[i * 4], G = a[i * 4 + 1], B = a[i * 4 + 2]; if (R > 140 && G > 110 && B < 90 && Math.min(R, G) - B > 50) n++; } return n; };
const diff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const vol = () => { const h = roi.snapshot().half; return 8 * h[0] * h[1] * h[2]; };
let fail = 0;
const check = (name: string, ok: boolean, note = "") => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(28)} ${note}`); };

// 1) clip crops, clears to byte-identical
scene.clearClip(); scene.syncUniforms();
const noClip = await render();
scene.setClipBox(roi.lo(), roi.hi()); scene.syncUniforms();
const clipped = await render();
check("box crops the volume", lit(clipped) < lit(noClip) * 0.9, `lit ${lit(clipped)} < ${lit(noClip)}`);
check("wireframe renders", yellow(clipped) > 150, `${yellow(clipped)} yellow px`);
scene.clearClip(); scene.syncUniforms();
check("clearClip byte-identical", diff(await render(), noClip) === 0);

// 2) face drag resizes; centre drag translates
scene.setClipBox(roi.lo(), roi.hi()); scene.syncUniforms();
const v0 = vol();
const box0 = roi.snapshot();
// shrink the +R face by pulling it 40mm inward (-x)
roi.applyDrag({ kind: "face", axis: 0, sign: 1 }, box0, [-40, 0, 0] as Vec3);
check("face drag shrinks box", vol() < v0, `vol ${(v0 / 1e3).toFixed(0)}k -> ${(vol() / 1e3).toFixed(0)}k`);

const c0 = roi.snapshot().center;
const box1 = roi.snapshot();
roi.applyDrag({ kind: "center" }, box1, [25, -15, 10] as Vec3);
const c1 = roi.snapshot().center;
const movedBy = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
check("centre drag translates", Math.abs(movedBy - Math.hypot(25, 15, 10)) < 1e-3 && roi.snapshot().half[0] === box1.half[0], `moved ${movedBy.toFixed(1)}mm, half unchanged`);

// GHOST shine-through: the handles must remain visible even where an OPAQUE volume region
// (dense ribs/contrast) occludes them. Regression guard for the ghost post-termination +
// saturation latch: without them a handle behind a saturated ray is re-buried and vanishes.
{
  const roi2 = await buildRoiScene(gpu.device);
  const scene2 = new SceneRenderer(gpu);
  scene2.build([roi2.image, roi2.box, roi2.handles]);
  scene2.setBackground(0.05, 0.06, 0.09);
  scene2.setClipBox(roi2.lo(), roi2.hi());
  const cam2 = framedCamera(roi2.sv.center as Vec3, roi2.sv.radius, 2.7);
  cam2.azimuth(35); cam2.elevation(20);   // off-axis so handles don't stack on the view axis
  scene2.setCamera(cam2.position, cam2.focalPoint, cam2.viewUp, cam2.viewAngle, 360, 360);
  const a2 = await scene2.renderToRGBA(360, 360);
  let blue = 0; for (let i = 0; i < 360 * 360; i++) { const R = a2[i * 4], G = a2[i * 4 + 1], B = a2[i * 4 + 2]; if (B > 110 && B - R > 40 && G > 90) blue++; }
  check("handles shine through volume", blue > 200, `${blue} blue handle px over the volume`);
}

// HOVER CUE: the hovered handle is warm (orange) and larger; idle handles are cool (blue/green).
// This replaced the old ghost-residual cue -- ghost mode halved idle opacity, which was invisible
// against Slicer's light background, so the widget opted out of it (see roi-widget.ts).
{
  const renderHover = async (hover: number | null) => {
    const r = await buildRoiScene(gpu.device); r.setHover(hover);
    const sc = new SceneRenderer(gpu); sc.build([r.image, r.handles]); sc.setBackground(0.05, 0.06, 0.09); sc.setClipBox(r.lo(), r.hi());
    const cam = framedCamera(r.sv.center as Vec3, r.sv.radius, 2.7); cam.azimuth(35); cam.elevation(20);
    sc.setCamera(cam.position, cam.focalPoint, cam.viewUp, cam.viewAngle, 360, 360);
    return await sc.renderToRGBA(360, 360);
  };
  // Diff the two renders: thresholding one image measures the CT (which dominates any global
  // red-over-green peak and is identical either way). The changed pixels ARE the hovered handle.
  const off = await renderHover(null), on = await renderHover(6);   // 6 = first corner; the center
  // handle (14) sits inside the volume and is occluded, so hovering it changes no visible pixel.
  let changed = 0, warmer = 0;
  for (let i = 0; i < 360 * 360; i++) {
    const o = off[i * 4], o1 = off[i * 4 + 1], n = on[i * 4], n1 = on[i * 4 + 1];
    if (Math.abs(n - o) > 8 || Math.abs(n1 - o1) > 8) { changed++; if ((n - n1) > (o - o1) + 20) warmer++; }
  }
  check("hover changes the handle", changed > 50, `${changed} px differ`);
  check("hovered handle reads warm", warmer > changed * 0.3, `${warmer}/${changed} changed px went warm`);
}

// 4) AN ORIENTED BOX RENDERS, AND IS NOT THE SAME PICTURE AS AN UNORIENTED ONE.
//
// A crop box aligned to the patient is useless on an oblique volume -- measured on a tilted 0.67 mm
// T1, a patient-aligned box around the head maps back onto the grid as the whole volume. So the box
// takes the volume's own axes, supplied as a rotation the box is drawn through (RoiBoxOpts.axes).
// With the default identity axes every count above is unchanged, which is the first thing to prove;
// this proves the rotated case actually draws, and draws somewhere else.
{
  const b0 = roi.snapshot();
  const upright = new RoiBoxField(b0.center, b0.half, { color: [1, 0.94, 0.66], barHalfMm: 1.5 });
  // 30 degrees about Z, as direction cosines (orthonormal, which the shader's transpose requires).
  const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6);
  const tilted = new RoiBoxField(b0.center, b0.half, {
    color: [1, 0.94, 0.66], barHalfMm: 1.5, axes: [c, -sn, 0, sn, c, 0, 0, 0, 1],
  });
  const shot = async (f: RoiBoxField) => {
    scene.build([roi.image, f]);
    scene.clearClip();
    scene.syncUniforms();
    return await render();
  };
  const a = await shot(upright), t = await shot(tilted);
  check("oriented box renders", yellow(t) > 150, `${yellow(t)} ivory px`);
  check("oriented box differs", diff(a, t) > 5000, `${diff(a, t)} px differ from upright`);
  // The rotated box's own AABB must cover it, or the empty-space skip would cut rays short of bars.
  const [lo2, hi2] = tilted.aabb();
  const halfSum = b0.half[0] + b0.half[1];
  check("oriented aabb widens", (hi2[0] - lo2[0]) > 2 * b0.half[0] && (hi2[0] - lo2[0]) < 2 * halfSum + 8,
    `x span ${(hi2[0] - lo2[0]).toFixed(1)}mm vs ${(2 * b0.half[0]).toFixed(1)}mm upright`);
}

gpu.device.destroy();
console.log(fail === 0 ? "\nROI clip verified." : `\n${fail} FAILED`);
if (fail) Deno.exit(1);
