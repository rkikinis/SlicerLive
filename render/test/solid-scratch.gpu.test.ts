// The merge and the smoothing of the solid look share their scratch (render/solid-scratch.ts): at most two
// label-sized buffers at once, not three, and none left once the card has run the work. On the whole-body
// case each is 418 MB, in the process the system ends above 4 GB (Ron's window, 2026-09-24).
//
//   deno test -A --no-check --unstable-webgpu render/test/solid-scratch.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { ColorizeBaker, makeLabelPaletteTexture, writeLabelPaletteTexture } from "../bake.ts";
import { makeMergedLabelTexture, mergeLabels } from "../solid-merge.ts";
import { buildSmoothSolid, makeSmoothSolidTexture } from "../solid-smooth.ts";
import { solidScratchBytes } from "../solid-scratch.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "merge then smoothing hold two label-sized scratch buffers at most, and none afterwards",
  ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const dims: [number, number, number] = [40, 32, 24];
    const lab = new Uint8Array(40 * 32 * 24).map((_, i) => (i % 97 < 40 ? 1 : 0));
    const baker = new ColorizeBaker(dev, lab, dims);
    const merged = makeMergedLabelTexture(dev, dims);
    const remap = new Uint32Array(256); remap[1] = 1;
    const size = 256 * 32 * 24;                          // rows padded to 256 bytes
    mergeLabels(dev, [{ labels: baker.labelTexture(), remap }], dims, merged);
    assertEquals(solidScratchBytes(dev), size, "the merge's buffer");
    const lut = makeLabelPaletteTexture(dev);
    const pal = new Float32Array(1024); pal[4 + 3] = 1; writeLabelPaletteTexture(dev, lut, pal);
    const smooth = makeSmoothSolidTexture(dev, dims);
    buildSmoothSolid(dev, merged, lut, dims, smooth);
    assertEquals(solidScratchBytes(dev), 2 * size, "the smoothing reused the merge's buffer: two, not three");
    await dev.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(solidScratchBytes(dev), 0, "nothing held once the card is done");
    baker.destroy(); merged.destroy(); lut.destroy(); smooth.destroy(); dev.destroy();
  },
});
