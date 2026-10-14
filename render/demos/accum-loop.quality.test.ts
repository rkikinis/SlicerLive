// ONE RESOLUTION WHILE YOU LOOK (accum-loop.ts fixedScale; Ron, 2026-10-14: "I like the desk view to follow the same
// rule" as the glasses). With a chosen quality, moving and still pictures are drawn at the same resolution: below Best
// the still view is one frame at that fraction, never a full-resolution picture after the moving ones.
//   deno test -A --no-check render/demos/accum-loop.quality.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { mountAdaptive3d } from "./accum-loop.ts";
import type { SceneRenderer } from "../scene-renderer.ts";
import type { Gpu } from "../device.ts";
(globalThis as Record<string, unknown>).requestAnimationFrame = (f: () => void) => setTimeout(f, 1);

/** A renderer that records what it was asked to draw, at which size. */
function fakeScene() {
  const calls: string[] = [];
  let n = 0;
  const sc = {
    renderToView: (_v: unknown, w: number, h: number) => { calls.push(`full ${w}x${h}`); },
    renderUpscaled: (_v: unknown, rw: number, rh: number) => { calls.push(`scaled ${rw}x${rh}`); },
    renderAccum: (_v: unknown, w: number, h: number, reset: boolean) => { n = reset ? 1 : n + 1; calls.push(`accum ${w}x${h}`); },
    accumCount: () => n,
    buildCount: 0, uploadCount: 0,
  };
  return { sc: sc as unknown as SceneRenderer, calls };
}
const gpu = { device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } } } as unknown as Gpu;
const mount = (sc: SceneRenderer, quality: number) => mountAdaptive3d({
  scene: () => sc, view: () => ({}) as GPUTextureView, size: () => ({ w: 200, h: 100 }), setCamera: () => {},
  gpu, fixedScale: () => quality, target: 4, idleGapMs: 20,
});
const settle = () => new Promise((r) => setTimeout(r, 150));

Deno.test("Fastest: the moving and the still pictures are all drawn at half the pixels, and nothing at full resolution", async () => {
  const { sc, calls } = fakeScene();
  const a = mount(sc, 0.5);
  a.draw(); a.draw();
  await settle();
  assertEquals(calls.length > 0, true);
  assertEquals(calls.filter((c) => c !== "scaled 100x50"), []);
});

Deno.test("Balanced: the still view after a turn is one picture at 70%, not a sharper one", async () => {
  const { sc, calls } = fakeScene();
  const a = mount(sc, 0.7);
  a.draw();
  await settle();
  const after = calls.length;
  await settle();
  assertEquals(calls.every((c) => c === "scaled 140x70"), true);
  assertEquals(calls.length, after);                       // still: nothing more drawn
});

Deno.test("Best: every picture at full resolution; the still view gathers its samples at that same size", async () => {
  const { sc, calls } = fakeScene();
  const a = mount(sc, 1);
  a.draw();
  await settle();
  assertEquals(calls.filter((c) => !c.endsWith("200x100")), []);
  assertEquals(calls.filter((c) => c.startsWith("accum")).length, 4);
});
