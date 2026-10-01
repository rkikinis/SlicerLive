// The colored volume's solid look (colorize-field.ts, setSolid) must draw, and draw without the card
// refusing anything. It once built a picture of nothing: a texture only the solid pass read was left
// out of the trace's automatically derived layout, the bind group was refused, and the 3D view went
// blank (2026-09-23, the block map). A ball of one label, solid, must come out as a lit disc in the
// middle of the picture with background at the corner -- and the validation scope must stay empty.
//
//   deno test -A --no-check --unstable-webgpu render/test/solid-look.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ColorizeField } from "../colorize-field.ts";
import { renderToImage } from "../../test/golden.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "the solid look draws a labelled ball as a surface, and the card refuses nothing",
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
    const field = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), {
      clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: [0.3, 0.7, 0.15, 20],
    });
    field.setSegmentColor(7, [0.9, 0.2, 0.2]);
    field.setSegmentOpacity(7, 1);
    field.flushPalette();
    field.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));     // the smoothed copy and block maps are made in a microtask
    await dev.queue.onSubmittedWorkDone();
    const W = 64, H = 64, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const sr = new SceneRenderer(gpu, FMT);
    sr.build([field]);
    sr.setDrawingLook(true);
    sr.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 30, W, H);
    const img = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
    const err = await dev.popErrorScope();
    assertEquals(err?.message ?? null, null, "the card refused part of the solid look");
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3));
    const [r, g, b] = px(W >> 1, H >> 1);
    assert(r > 100 && r > g + 40 && r > b + 40, `the middle should be the red ball, got ${[r, g, b]}`);
    const [cr, cg, cb] = px(1, 1);
    assert(!(cr > cg + 40 && cr > cb + 40), `the corner should be background, got ${[cr, cg, cb]}`);
    // THE CROP BOX DOES NOT CUT IT (Ron, 2026-09-24: "no"): a box that leaves out the middle of the ball
    // still shows the ball there.
    sr.setClipBox([5, -50, -50], [50, 50, 50]);
    const cut = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
    const [kr, kg, kb] = Array.from(cut.data.subarray(((H >> 1) * W + (W >> 1)) * 4, ((H >> 1) * W + (W >> 1)) * 4 + 3));
    assert(kr > 100 && kr > kg + 40 && kr > kb + 40, `under a crop box the middle should still be the red ball, got ${[kr, kg, kb]}`);
    field.destroy();
    dev.destroy();
  },
});

// THE LIGHTING PRESET GOVERNS A TISSUE'S HIGHLIGHT TOO (Ron, 2026-09-25: "lighting has little effect: matte is still
// glossy"). Under shading v2 each structure's highlight comes from its tissue finish; Matte must still take it away.
// A red ball with a wet, coated finish: its brightest green (the white highlight on red) under Matte must sit well
// below Glossy's.
Deno.test({
  name: "the solid look: Matte takes a tissue finish's highlight away, Glossy keeps it",
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
    const GLOSSY: [number, number, number, number] = [0.30, 0.70, 0.15, 20], MATTE: [number, number, number, number] = [0.40, 0.70, 0.00, 1];
    const field = new ColorizeField(dev, null, lab, [N, N, N], new Uint8Array(256 * 4), { clim: [-1000, 1600], ijkToRAS, contextOpacity: 0, shade: GLOSSY });
    field.setSegmentColor(7, [0.8, 0.15, 0.15]);
    field.setSegmentOpacity(7, 1);
    field.setSegmentMaterial(7, { name: "wet", roughness: 0.4, ior: 1.4, coat: 0.8, coatRoughness: 0.1, sheen: 0, subsurface: 0.3, metallic: 0 });
    field.flushPalette();
    field.setSolid(true);
    await new Promise((r) => setTimeout(r, 0));
    await dev.queue.onSubmittedWorkDone();
    const W = 64, H = 64, FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const sr = new SceneRenderer(gpu, FMT);
    sr.build([field]);
    sr.setDrawingLook(true);
    sr.setCamera([0, 120, 0], [0, 0, 0], [0, 0, 1], 30, W, H);
    const maxGreen = async () => {
      const img = await renderToImage(dev, FMT, W, H, (v) => { for (let i = 0; i < 4; i++) sr.renderAccum(v, W, H, i === 0); });
      let m = 0;
      // inside the ball only (radius ~14 px at this camera): the rim blends with the gray background
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if ((x - W / 2) ** 2 + (y - H / 2) ** 2 > 10 * 10) continue;
        m = Math.max(m, img.data[(y * W + x) * 4 + 1]);
      }
      return m;
    };
    field.setShade(GLOSSY); sr.syncUniforms(); const glossy = await maxGreen();
    field.setShade(MATTE); sr.syncUniforms(); const matte = await maxGreen();
    assert(glossy > 120, `under Glossy the finish should show a highlight on the red ball, brightest green ${glossy}`);
    assert(matte + 60 < glossy, `under Matte the highlight should be gone: brightest green ${matte}, Glossy ${glossy}`);
    field.destroy();
    dev.destroy();
  },
});
