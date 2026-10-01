// The 3D background must match 3D Slicer's 3D view, not merely look similar.
//
// Reference values were measured from an installed Slicer (5.13.0-2026-08-17) by rendering
// vtkMRMLViewNode's default gradient offscreen and sampling rows -- not copied from documentation.
// That measurement also established the two facts this test pins:
//
//   * orientation: VTK's `SetBackground` is the BOTTOM stop and `SetBackground2` the TOP, so the
//     view is darker above and lighter below;
//   * interpolation space: VTK ramps linearly between the 8-bit sRGB endpoints. Mixing in linear
//     light instead lands the midtone ~6/255 too light, which is what this test would catch.
//
//   deno test -A --no-check --unstable-webgpu render/test/slicer-bg.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { renderToImage } from "../../test/golden.ts";
import { SLICER_BG_BOTTOM, SLICER_BG_TOP } from "../background.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

// Sampled from Slicer itself at t = 0, .25, .5, .75, 1 (t measured from the BOTTOM), for its
// default stops #C1C3E8 (bottom) and #7478BE (top).
const SLICER_ROWS: Array<[number, [number, number, number]]> = [
  [0.00, [192, 194, 231]],
  [0.25, [174, 176, 222]],
  [0.50, [154, 157, 211]],
  [0.75, [135, 139, 201]],
  [1.00, [116, 120, 190]],
];

Deno.test({
  name: "3D background reproduces Slicer's gradient (orientation and sRGB ramp)",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const W = 8, H = 201;
    // Must be an *-srgb target: the shaders composite in physical (linear) light and rely on the
    // GPU re-encoding to sRGB on write. Into a plain rgba8unorm target the linear values are read
    // back directly and every sample lands far too dark (0.756863 -> 136 rather than 193).
    const FMT: GPUTextureFormat = "rgba8unorm-srgb";
    const sr = new SceneRenderer(gpu, FMT);
    sr.build([]);                      // empty scene: every ray misses, so only background shows
    sr.setCamera([0, 0, 500], [0, 0, 0], [0, 1, 0], 30, W, H);
    const img = await renderToImage(gpu.device, FMT, W, H, (v) => sr.renderToView(v, W, H));

    // renderToImage returns rows top-first; Slicer's t is measured from the bottom.
    const px = (t: number) => {
      const rowFromTop = Math.round((1 - t) * (H - 1));
      const o = (rowFromTop * W + (W >> 1)) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2]] as [number, number, number];
    };

    const failures: string[] = [];
    for (const [t, want] of SLICER_ROWS) {
      const got = px(t);
      const worst = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
      // 2/255 absorbs VTK's own rounding (its endpoint reads 192 where exact is 193).
      if (worst > 2) failures.push(`t=${t.toFixed(2)}: got ${got}, Slicer ${want} (off by ${worst})`);
    }
    assertEquals(failures, [], `background differs from Slicer:\n  ${failures.join("\n  ")}`);

    // Guard the orientation explicitly: darker at the top.
    const top = px(1), bottom = px(0);
    const lum = (c: number[]) => c[0] + c[1] + c[2];
    if (!(lum(top) < lum(bottom))) {
      throw new Error(`gradient is inverted: top ${top} should be darker than bottom ${bottom}`);
    }

    // And that the constants are the ones measured from Slicer.
    assertEquals(SLICER_BG_TOP.map((v) => Math.round(v * 255)), [116, 120, 190]);
    assertEquals(SLICER_BG_BOTTOM.map((v) => Math.round(v * 255)), [193, 195, 232]);
  },
});
