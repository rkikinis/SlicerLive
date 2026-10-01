// The graphics memory ledger counts what is created, forgets what is destroyed, and names the maker.
//
//   deno test -A --no-check --unstable-webgpu render/test/gpu-ledger.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { gpuLedger, makerOf, textureBytes } from "../gpu-ledger.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test("texture bytes: format, depth, mips and samples", () => {
  assertEquals(textureBytes({ size: [768, 768, 709], format: "r8uint", dimension: "3d", usage: 0 }), 768 * 768 * 709);
  assertEquals(textureBytes({ size: [768, 768, 709], format: "r16float", dimension: "3d", usage: 0 }), 768 * 768 * 709 * 2);
  assertEquals(textureBytes({ size: [100, 50], format: "rgba32float", usage: 0 }), 100 * 50 * 16);
  assertEquals(textureBytes({ size: [8, 8], format: "rgba8unorm", mipLevelCount: 2, usage: 0 }), (64 + 16) * 4);
});

Deno.test("the maker is read from both engines' stack formats", () => {
  assertEquals(makerOf("Error\n    at record (x.ts:1:1)\n    at makeLabelTexture (y.ts:2:2)\n    at buildColorizeInner (z.ts:3:3)"), "makeLabelTexture < buildColorizeInner");
  assertEquals(makerOf("record@x.js:1:1\nmakeLabelTexture@y.js:2:2\nbuildColorizeInner@z.js:3:3"), "makeLabelTexture < buildColorizeInner");
});

Deno.test({
  name: "the ledger counts a texture and a buffer, and forgets them when destroyed",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const before = gpuLedger({ top: 50 });
    function makeTheTestTexture() {
      return gpu.device.createTexture({ size: [256, 256, 64], format: "r16float", dimension: "3d", usage: GPUTextureUsage.TEXTURE_BINDING });
    }
    const t = makeTheTestTexture();
    const b = gpu.device.createBuffer({ size: 4 * 1048576, usage: GPUBufferUsage.STORAGE, label: "ledger-test" });
    const mid = gpuLedger({ top: 50 });
    assertEquals(mid.allocations, before.allocations + 2);
    assert(mid.byMaker.some((r) => r.maker.includes("makeTheTestTexture") && r.mb === 8), JSON.stringify(mid.byMaker));
    assert(mid.byMaker.some((r) => r.maker.startsWith("buffer: ledger-test") && r.mb === 4), JSON.stringify(mid.byMaker));
    t.destroy(); b.destroy();
    const after = gpuLedger({ top: 50 });
    assertEquals(after.allocations, before.allocations);
    assertEquals(after.destroyed, before.destroyed + 2);
    gpu.device.destroy();
  },
});
