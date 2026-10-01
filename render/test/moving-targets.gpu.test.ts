// A moving 3D frame is drawn into the top-left corner of the view-sized targets instead of into targets of its own
// size (scene-renderer.ts, meshTargets / ensureLow), so a drag allocates nothing. Made after Ron's out-of-memory reset
// on 2026-09-24 16:40, which it was suspected of causing; the peaks stayed (WORKING-STATE 17:04), cause unknown.
// Two things must hold: the picture is the same, pixel for pixel, as the same frame drawn into targets of its own
// size (nothing read from beyond the frame's corner -- removing the upscale's tap clamp fails it, 831 bytes); and a
// run of frames of different sizes makes no new texture.
//
//   deno test -A --no-check --unstable-webgpu render/test/moving-targets.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ColorizeField } from "../colorize-field.ts";
import { renderToImage } from "../../test/golden.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "a moving frame in the corner of view-sized targets is the same picture, and a drag makes no new textures",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    // A ball of one label, solid, in the drawing look: the surface targets, the solid pass's copies and the drawing
    // look's neighbor reads are all exercised, and the ball's edge crosses the frame's edge at the sizes below.
    const N = 48;
    const lab = new Uint8Array(N * N * N);
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i - N / 2 + 0.5, y = j - N / 2 + 0.5, z = k - N / 2 + 0.5;
      if (x * x + y * y + z * z < 20 * 20) lab[(k * N + j) * N + i] = 7;
    }
    const ijkToRAS = [1, 0, 0, -N / 2, 0, 1, 0, -N / 2, 0, 0, 1, -N / 2, 0, 0, 0, 1];
    const field = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), {
      clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: [0.3, 0.7, 0.15, 20],
    });
    field.setSegmentColor(7, [0.9, 0.2, 0.2]);
    field.setSegmentOpacity(7, 1);
    field.flushPalette();
    field.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));
    await dev.queue.onSubmittedWorkDone();
    const W = 96, H = 80, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    // A SURFACE MESH TOO: the mesh pass is where the viewport matters (it also draws the slice-in-3D quads); with the
    // ball alone every pass is a full-screen triangle and removing every setViewport still passed (critic, 2026-09-24
    // evening, finding 8). A cube beside the ball, crossing it.
    const cube = (() => {
      const [x0, x1, y0, y1, z0, z1] = [4, 26, -12, 12, -12, 12];
      const positions = new Float32Array([x0,y0,z0, x1,y0,z0, x1,y1,z0, x0,y1,z0, x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1]);
      const indices = new Uint32Array([0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7]);
      return { id: "cube", positions, indices, color: [0.2, 0.8, 0.2] as [number, number, number], opacity: 1 };
    })();
    const make = (exact: boolean) => {
      const sr = new SceneRenderer(gpu, FMT);
      sr.build([field]);
      sr.setMeshes([cube]);
      sr.setDrawingLook(true);
      sr.setExactTargets(exact);
      return sr;
    };
    const cam = (sr: SceneRenderer, w: number, h: number) => sr.setCamera([0, 60, 10], [0, 0, 0], [0, 0, 1], 30, w, h);
    // The same history for both: a settled frame at the view's size, then moving frames.
    const run = async (sr: SceneRenderer, rw: number, rh: number) => {
      cam(sr, W, H); await renderToImage(dev, FMT, W, H, (v) => sr.renderToView(v, W, H));
      cam(sr, rw, rh); return await renderToImage(dev, FMT, W, H, (v) => sr.renderUpscaled(v, rw, rh, W, H));
    };
    dev.pushErrorScope("validation");
    for (const [rw, rh] of [[48, 40], [61, 53], [72, 60]]) {
      const corner = await run(make(false), rw, rh);
      const own = await run(make(true), rw, rh);
      let diff = 0;
      for (let i = 0; i < corner.data.length; i++) if (corner.data[i] !== own.data[i]) diff++;
      assertEquals(diff, 0, `a ${rw}×${rh} frame in the corner differs from the same frame in its own targets at ${diff} bytes`);
      const c = ((H >> 1) * W + (W >> 1)) * 4;
      const [r, g, b] = [corner.data[c], corner.data[c + 1], corner.data[c + 2]];
      assert(r > 100 && r > g + 40 && r > b + 40, `the middle should be the red ball, got ${[r, g, b]}`);
      let green = 0;
      for (let i = 0; i < corner.data.length; i += 4) if (corner.data[i + 1] > 120 && corner.data[i + 1] > corner.data[i] + 40 && corner.data[i + 1] > corner.data[i + 2] + 40) green++;
      assert(green > 200, `the cube should be drawn, ${green} green pixels`);
    }
    // A drag: frames of many sizes after the first; no texture made for any of them.
    const sr = make(false);
    await run(sr, 48, 40);
    const create = dev.createTexture.bind(dev);
    let made = 0, counting = false;
    (dev as unknown as { createTexture: typeof dev.createTexture }).createTexture = (d) => { if (counting) made++; return create(d); };
    for (const s of [0.5, 0.625, 0.375, 0.75, 0.875, 0.25, 0.6, 0.55]) {
      const rw = Math.round(W * s), rh = Math.round(H * s);
      cam(sr, rw, rh);
      await renderToImage(dev, FMT, W, H, (v) => { counting = true; sr.renderUpscaled(v, rw, rh, W, H); counting = false; });
    }
    (dev as unknown as { createTexture: typeof dev.createTexture }).createTexture = create;
    assertEquals(made, 0, "a moving frame made a texture");
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? null, null, "the card refused part of a moving frame");
    field.destroy();
  },
});
