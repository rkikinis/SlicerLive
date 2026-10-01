// The ray march drawn in strips, each its own submission (SceneRenderer.traceInStrips), must give the
// same picture as one pass: the strips exist only so that no single batch of GPU work runs long enough
// for macOS's watchdog to kill it (Ron's run, 2026-09-23 17:10, "Impacting Interactivity"). Checked on
// both paths that trace -- the settled frame and the moving (upscaled) frame -- with a volume that
// has both a translucent fill and a surface, at a height the strip count does not divide.
//
//   deno test -A --no-check --unstable-webgpu render/test/trace-strips.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { renderToImage } from "../../test/golden.ts";
import { EditableSegmentation } from "../../algorithms/editable-segmentation.ts";
import { PaintEffect } from "../../algorithms/effects/paint.ts";
import { SegmentationLogic } from "../../logic/segmentation-logic.ts";
import type { Vec3 } from "../../algorithms/geom.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "the ray march in strips gives the same picture as in one pass, settled and moving",
  ignore: !hasGpu,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const gpu = await initDevice();
    const dims: Vec3 = [64, 64, 64];
    const ijkToRAS = [2, 0, 0, -64, 0, 2, 0, -64, 0, 0, 2, -64, 0, 0, 0, 1];
    const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
    const logic = new SegmentationLogic(gpu.device, seg, { renderMode: "sdf" });
    const paint = new PaintEffect(seg);
    logic.setLabelColor(1, [0.95, 0.25, 0.25]);
    logic.setLabelColor(2, [0.30, 0.45, 0.98]);
    paint.stampStroke([[0, 20, 0]], { radiusMm: 20, id: 1, mode: "add" });
    paint.stampStroke([[0, -20, 0]], { radiusMm: 16, id: 2, mode: "add" });
    logic.setLabelShading(2, "volume");
    logic.refineNow();

    const W = 160, H = 123;                     // 123 rows: 7 strips of 18 leave a short last strip
    const sr = new SceneRenderer(gpu);
    sr.build([logic.field()]);
    sr.setBackground(0.05, 0.06, 0.09);
    sr.setCamera([0, -300, 40], [0, 0, 0], [0, 0, 1], 30, W, H);

    const settled = async (strips: number) => { sr.setTraceStrips(strips); return await sr.renderToRGBA(W, H); };
    const one = await settled(1);
    const seven = await settled(7);
    const many = await settled(H);              // one row per strip
    let lit = 0; for (let i = 0; i < one.length; i += 4) if (one[i] !== one[i + 2]) lit++;
    assertEquals(lit > 500, true, `the scene drew too little to be a test (${lit} colored pixels)`);
    assertEquals(seven, one, "7 strips differ from one pass");
    assertEquals(many, one, "one strip per row differs from one pass");

    // The moving frame: traced low and upsampled into the view.
    const lw = 40, lh = 31;
    const moving = async (strips: number) => {
      sr.setTraceStrips(strips);
      sr.setCamera([0, -300, 40], [0, 0, 0], [0, 0, 1], 30, lw, lh);
      // The renderer's own output format (rgba8unorm-srgb by default); any other and every draw is
      // refused, which would compare two blank pictures and pass.
      return (await renderToImage(gpu.device, "rgba8unorm-srgb", W, H, (v) => sr.renderUpscaled(v, lw, lh, W, H))).data;
    };
    const m1 = await moving(1);
    let mlit = 0; for (let i = 0; i < m1.length; i += 4) if (m1[i] !== m1[i + 2]) mlit++;
    assertEquals(mlit > 500, true, `the moving frame drew too little to be a test (${mlit} colored pixels)`);
    assertEquals(await moving(5), m1, "the moving frame in 5 strips differs from one pass");

    // THE SAVED PICTURE, CONVERGED: one accumulated sample is the plain frame (the first is un-jittered
    // by design); sixteen are the averaged picture the settled screen shows, so they must differ.
    sr.setCamera([0, -300, 40], [0, 0, 0], [0, 0, 1], 30, W, H);
    sr.setTraceStrips(1);
    const plain = await sr.renderToRGBA(W, H);
    assertEquals(await sr.renderToRGBAConverged(W, H, 1), plain, "one converged sample is not the plain frame");
    const conv = await sr.renderToRGBAConverged(W, H, 16);
    let differ = 0; for (let i = 0; i < conv.length; i++) if (conv[i] !== plain[i]) differ++;
    assertEquals(differ > 100, true, `16 samples changed only ${differ} bytes`);
    gpu.device.destroy();
  },
});
