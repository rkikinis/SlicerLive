// SEE-THROUGH WALLS KEEP THEIR OWN DEPTH (scene-renderer.ts VEIL_K; Ron, 2026-10-21: "When I turn it on, the blue is
// behind the fibers"). A see-through red ball (the solid look) and a green tube the ray march draws: the tube BEHIND
// the ball must be seen through the ball's veil (red over green), the tube IN FRONT of it must not. Before the fix the
// veil was composited at the depth of the first opaque wall -- none here, so after the whole ray -- and the tube behind
// the ball came out as green as the one in front.
//
//   deno test -A --no-check --unstable-webgpu render/test/veil-depth.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ColorizeField } from "../colorize-field.ts";
import { FiberField } from "../fiber-field.ts";
import { renderToImage } from "../../test/golden.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "a see-through solid structure veils a tube behind it and not one in front of it",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    const N = 48;
    const lab = new Uint8Array(N * N * N);
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i - N / 2 + 0.5, y = j - N / 2 + 0.5, z = k - N / 2 + 0.5;
      if (x * x + y * y + z * z < 14 * 14) lab[(k * N + j) * N + i] = 7;
    }
    const ijkToRAS = [1, 0, 0, -N / 2, 0, 1, 0, -N / 2, 0, 0, 1, -N / 2, 0, 0, 0, 1];
    dev.pushErrorScope("validation");
    const ball = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), { clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: [0.3, 0.7, 0.15, 20] });
    ball.setSegmentColor(7, [0.95, 0.1, 0.1]);
    ball.setSegmentOpacity(7, 0.4);
    ball.flushPalette();
    ball.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));
    await dev.queue.onSubmittedWorkDone();
    // A thick green tube across the view at y (the camera looks down -y from y = 120).
    const tube = (y: number) => {
      const pts = new Float32Array(3 * 61);
      for (let i = 0; i <= 60; i++) pts.set([i - 30, y, 0], 3 * i);
      return new FiberField(dev, [{ points: pts, bundle: 1 }], { radius: 3, bundleColors: { 1: [0.1, 0.9, 0.1, 1] } });   // bundles are numbered from 1
    };
    const W = 64, H = 64, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const middle = async (t: FiberField) => {
      const sr = new SceneRenderer(gpu, FMT);
      sr.build([ball, t]);
      sr.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 30, W, H);
      const img = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
      const o = ((H >> 1) * W + (W >> 1)) * 4;
      return Array.from(img.data.subarray(o, o + 3));
    };
    const behind = await middle(tube(-20)), front = await middle(tube(20));
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? null, null, "the card refused part of the picture");
    // In front: the tube itself, green. Behind: the same tube under the red veil -- much redder.
    assert(front[1] > front[0] + 60, `the tube in front of the ball should be green, got ${front}`);
    assert(behind[0] > front[0] + 40, `the tube behind the ball should be seen through its red veil, got ${behind} (in front: ${front})`);
    ball.destroy();
    dev.destroy();
  },
});

// THE ORTHOGRAPHIC CAMERA, OFF CENTER (critic 2026-10-21, finding 1): parallel rays do not pass through the eye, and a
// march position converted as d(eye, ro) + t ran ahead by the pixel's distance from the view axis -- the see-through
// ball's veil came out over a tube 4 mm in front of it. Both projections, a pixel well off the axis: the tube in front
// green, the tube behind veiled.
Deno.test({
  name: "see-through walls sort with tubes off center, in perspective and orthographic views",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    const N = 96, R = 40;
    const lab = new Uint8Array(N * N * N);
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i - N / 2 + 0.5, y = j - N / 2 + 0.5, z = k - N / 2 + 0.5;
      if (x * x + y * y + z * z < R * R) lab[(k * N + j) * N + i] = 7;
    }
    const ijkToRAS = [1, 0, 0, -N / 2, 0, 1, 0, -N / 2, 0, 0, 1, -N / 2, 0, 0, 0, 1];
    dev.pushErrorScope("validation");
    const ball = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), { clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: [0.3, 0.7, 0.15, 20] });
    ball.setSegmentColor(7, [0.95, 0.1, 0.1]); ball.setSegmentOpacity(7, 0.4); ball.flushPalette(); ball.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));
    await dev.queue.onSubmittedWorkDone();
    const tube = (y: number) => {
      const pts = new Float32Array(3 * 121);
      for (let i = 0; i <= 120; i++) pts.set([i - 60, y, 0], 3 * i);
      return new FiberField(dev, [{ points: pts, bundle: 1 }], { radius: 3, bundleColors: { 1: [0.1, 0.9, 0.1, 1] } });
    };
    const W = 64, H = 64, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const left = async (t: FiberField, ortho: boolean) => {
      const sr = new SceneRenderer(gpu, FMT);
      sr.build([ball, t]);
      sr.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 60, W, H, ortho ? 48 : undefined);
      const img = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
      // A pixel whose ray crosses the ball off its center: x = -29 mm orthographic, -25 mm at the ball's middle in
      // perspective (the same column would miss the ball in perspective: the 60 degree view widens with distance).
      const o = ((H >> 1) * W + (ortho ? 12 : 20)) * 4;
      return Array.from(img.data.subarray(o, o + 3));
    };
    for (const ortho of [false, true]) {
      const front = await left(tube(35), ortho), behind = await left(tube(-45), ortho);
      const what = ortho ? "orthographic" : "perspective";
      assert(front[1] > front[0] + 60, `${what}: the tube in front of the ball should be green, got ${front}`);
      assert(behind[0] > front[0] + 40, `${what}: the tube behind the ball should be veiled, got ${behind} (in front: ${front})`);
    }
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? null, null, "the card refused part of the picture");
    ball.destroy();
    dev.destroy();
  },
});
