// TWO segmentations in ONE slice, each with its own geometry.
//
// Ron: "the slice viewers show the results of the abdominal muscles but the 3d window shows both.
// Make up your mind." / "The two segmentations do not show, I am still in toggle land."
//
// What this pins down, and why it needs a GPU rather than a unit test:
//   1. both overlays draw AT ONCE -- not "whichever was set last wins";
//   2. overlay B is addressed through ITS OWN RAS->texture matrix. A specialized network segments a
//      SUB-VOLUME, so B's labelmap here is a fraction of the background's and sits off to one side.
//      Addressed through the background's matrix -- which is all the single-overlay shader could do
//      -- B lands in the wrong place, and the last case below shows that it would.
//
// Subject, not stand-in: the real SliceRenderer, real ColorizeBaker label textures, real palettes.
// A previous probe test built its own texture with the usage the subject was missing, so it verified
// the test rather than the code; nothing here is constructed by hand that the app builds itself.
//
//   deno test -A --no-check --unstable-webgpu render/test/slice-two-overlays.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { ColorizeBaker, makeLabelPaletteTexture, writeLabelPaletteTexture } from "../bake.ts";
import { patientToTextureFromIjkToRAS, volumeAABBFromIjkToRAS } from "../mat4.ts";
import type { Vec3 } from "../mat4.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "two segmentations composite in one slice, each through its own geometry",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const W = 128, H = 128;
    const gpu = await initDevice();
    const dev = gpu.device;
    const errs: string[] = [];
    dev.addEventListener("uncapturederror", (e) => errs.push(String((e as GPUUncapturedErrorEvent).error)));

    // ── background: 64x64x32 at 1mm, centered on the origin ──
    const bgDims: Vec3 = [64, 64, 32];
    const bgIjk = [1, 0, 0, -32, 0, 1, 0, -32, 0, 0, 1, -16, 0, 0, 0, 1];
    const nvox = bgDims[0] * bgDims[1] * bgDims[2];
    const scalar = new Float32Array(nvox).fill(0.5);
    const scalarTex = dev.createTexture({
      size: bgDims as [number, number, number], dimension: "3d", format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture({ texture: scalarTex }, scalar, { bytesPerRow: bgDims[0] * 4, rowsPerImage: bgDims[1] }, bgDims as [number, number, number]);

    // ── A: whole-study segmentation, label 1 filling the LEFT half (i < 32 → RAS x < 0) ──
    const labA = new Uint8Array(nvox);
    for (let z = 0; z < bgDims[2]; z++) for (let y = 0; y < bgDims[1]; y++) for (let x = 0; x < bgDims[0]; x++) {
      if (x < 32) labA[(z * bgDims[1] + y) * bgDims[0] + x] = 1;
    }
    const bakerA = new ColorizeBaker(dev, labA, bgDims);
    const palA = new Float32Array(256 * 4);
    palA[4] = 1; palA[5] = 0; palA[6] = 0; palA[7] = 1;          // label 1 = RED
    const palTexA = makeLabelPaletteTexture(dev);
    writeLabelPaletteTexture(dev, palTexA, palA);

    // ── B: a SUB-VOLUME, 16x16x8, sitting at RAS x in [+8,+24] — entirely on the RIGHT ──
    const bDims: Vec3 = [16, 16, 8];
    const bIjk = [1, 0, 0, 8, 0, 1, 0, -8, 0, 0, 1, -4, 0, 0, 0, 1];
    const labB = new Uint8Array(bDims[0] * bDims[1] * bDims[2]).fill(1);
    const bakerB = new ColorizeBaker(dev, labB, bDims);
    const palB = new Float32Array(256 * 4);
    palB[4] = 0; palB[5] = 0; palB[6] = 1; palB[7] = 1;          // label 1 = BLUE
    const palTexB = makeLabelPaletteTexture(dev);
    writeLabelPaletteTexture(dev, palTexB, palB);

    const [lo, hi] = volumeAABBFromIjkToRAS(bgIjk, bgDims);
    const sr = new SliceRenderer(gpu, "rgba8unorm");
    sr.setVolume(patientToTextureFromIjkToRAS(bgIjk, bgDims), lo, hi);
    sr.setTextures(scalarTex);
    sr.setWindowLevel(1, 0.5);
    sr.setPlane("axial", 0.5);
    sr.setOverlayOpacity(1); sr.setOutlineOpacity(0);            // fill only: the outline would blur the counts

    /**
     * Count red and blue pixels per ANATOMICAL half.
     *
     * `BASES.axial.uDir` is [-1,0,0], so screen +x runs toward RAS -x: the patient's RIGHT is on the
     * screen LEFT, the radiological convention. Counting by screen half and calling it left/right is
     * how this test failed the first time it ran, so it counts by the side of the patient instead.
     */
    const tally = async () => {
      const px = await sr.renderToRGBA(W, H);
      const t = { redPatR: 0, redPatL: 0, bluePatR: 0, bluePatL: 0 };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, r = px[i], g = px[i + 1], b = px[i + 2];
        const red = r > 140 && g < 90 && b < 90, blue = b > 140 && r < 90 && g < 90;
        if (red) (x < W / 2 ? t.redPatR++ : t.redPatL++);
        if (blue) (x < W / 2 ? t.bluePatR++ : t.bluePatL++);
      }
      return t;
    };

    // 1. A alone
    sr.setLabelOverlay(bakerA.labelTexture(), palTexA, patientToTextureFromIjkToRAS(bgIjk, bgDims));
    sr.setLabelOverlayB(null, null);
    const aOnly = await tally();

    // 2. A and B together, B through its OWN matrix
    sr.setLabelOverlayB(bakerB.labelTexture(), palTexB, patientToTextureFromIjkToRAS(bIjk, bDims), 1, 0);
    const both = await tally();

    // 3. B alone through the BACKGROUND's matrix — the old, wrong addressing, for contrast
    sr.setLabelOverlay(bakerB.labelTexture(), palTexB, patientToTextureFromIjkToRAS(bgIjk, bgDims));
    sr.setLabelOverlayB(null, null);
    const wrongGeom = await tally();

    const row = (n: string, t: typeof aOnly) =>
      console.log(`${n.padEnd(13)} red patR=${t.redPatR} patL=${t.redPatL}   blue patR=${t.bluePatR} patL=${t.bluePatL}`);
    row("A alone", aOnly); row("A + B", both); row("B, bg matrix", wrongGeom);
    console.log(`GPU errors=${errs.length}`);

    // A occupies RAS x < 0 (the patient's LEFT); B occupies RAS x in [+8,+24] (the patient's RIGHT).
    const checks: [string, boolean][] = [
      ["A alone draws on the patient's left only", aOnly.redPatL > 1000 && aOnly.redPatR === 0],
      ["A alone draws no blue anywhere", aOnly.bluePatL === 0 && aOnly.bluePatR === 0],
      ["A is undisturbed when B is added", both.redPatL > aOnly.redPatL * 0.95],
      ["B draws at the same time as A", both.bluePatR > 100],
      ["B stays inside its own sub-volume", both.bluePatL === 0],
      ["through the background's matrix B would have spilled across the patient's left", wrongGeom.bluePatL > 0],
      ["no GPU errors", errs.length === 0],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
    const failures = checks.filter(([, ok]) => !ok).map(([n]) => n);
    assertEquals(failures, [], `two-overlay compositing broke:\n  ${failures.join("\n  ")}`);
    dev.destroy();
  },
});
