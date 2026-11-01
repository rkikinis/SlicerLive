// A STRUCTURE ONE VOXEL THICK IS DRAWN WHOLE FROM EVERY SIDE (Ron, 2026-10-31, the maxilla from MOOSE's clin_ct_dental:
// "a lot of artefacts ... they again depend on camera angle"). A tilted plate one voxel thick fills the middle of the
// picture; from each camera the middle must be the plate, with no holes where the ray stepped over it.
//
//   deno test -A --no-check --unstable-webgpu render/test/thin-plate.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ColorizeField } from "../colorize-field.ts";
import { renderToImage } from "../../test/golden.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "a plate one voxel thick has no holes, from several directions",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    const N = 64;
    const lab = new Uint8Array(N * N * N);
    const nl = Math.hypot(0.35, 1, 0.25), n = [0.35 / nl, 1 / nl, 0.25 / nl];
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i - N / 2 + 0.5, y = j - N / 2 + 0.5, z = k - N / 2 + 0.5;
      if (Math.abs(x * n[0] + y * n[1] + z * n[2]) <= 0.5) lab[(k * N + j) * N + i] = 7;   // one voxel thick
    }
    const ijkToRAS = [1, 0, 0, -N / 2, 0, 1, 0, -N / 2, 0, 0, 1, -N / 2, 0, 0, 0, 1];
    dev.pushErrorScope("validation");
    const field = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), { clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: [0.3, 0.7, 0.15, 20] });
    field.setSegmentColor(7, [0.9, 0.2, 0.2]); field.setSegmentOpacity(7, 1);
    field.flushPalette(); field.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));
    await dev.queue.onSubmittedWorkDone();
    const W = 96, H = 96, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const sr = new SceneRenderer(gpu, FMT);
    sr.build([field]);
    sr.setDrawingLook(true);
    const holes: string[] = [];
    // from the front, the back, and obliquely: the eye at 150 mm along each direction
    for (const d of [[0, 1, 0], [0, -1, 0], [0.6, 0.8, 0.2], [-0.5, 0.7, -0.5], [0.3, -0.6, 0.74], [0.8, 0.45, -0.4]]) {
      const L = Math.hypot(d[0], d[1], d[2]);
      sr.setCamera([150 * d[0] / L, 150 * d[1] / L, 150 * d[2] / L], [0, 0, 0], Math.abs(d[2] / L) > 0.9 ? [0, 1, 0] : [0, 0, 1], 12, W, H);
      const img = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
      let miss = 0, all = 0;
      for (let y = H / 2 - 12; y < H / 2 + 12; y++) for (let x = W / 2 - 12; x < W / 2 + 12; x++) {
        const o = (y * W + x) * 4, r = img.data[o], g = img.data[o + 1], b = img.data[o + 2];
        all++; if (!(r > 60 && r > g + 25 && r > b + 25)) miss++;
      }
      if (miss) holes.push(`from ${d.join(",")}: ${miss} of ${all} pixels not the plate`);
    }
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? null, null, "the card refused part of the solid look");
    assert(holes.length === 0, holes.join("; "));
    field.destroy();
    dev.destroy();
  },
});
