// HOLDING THE 3D VIEW (accum-loop.ts holdDrawing, 2026-10-03): macOS's watchdog took Ron's card when fiber tracking ran
// beside the 3D view's solid anatomy. While held, no frame is started; after the release, one fresh full-quality frame.
//   deno test -A --no-check render/demos/accum-loop.hold.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { drawingHeld, holdDrawing, mountAdaptiveLoop } from "./accum-loop.ts";
(globalThis as Record<string, unknown>).requestAnimationFrame = (f: () => void) => setTimeout(f, 1);
Deno.test("a held 3D view draws nothing, then one fresh full-quality frame and its samples after the release", async () => {
  let moving = 0, settled = 0, count = 0;
  const loop = mountAdaptiveLoop({ renderMoving: () => moving++, renderSettled: (reset) => { settled++; count = reset ? 1 : count + 1; }, count: () => count, target: 3, idleGapMs: 0 });
  const release = holdDrawing("tracking");
  assertEquals(drawingHeld(), ["tracking"]);
  loop.refresh!();
  await new Promise((r) => setTimeout(r, 60));
  assertEquals([moving, settled], [0, 0]);
  release(); release();                                   // a second call changes nothing
  await new Promise((r) => setTimeout(r, 200));
  assertEquals(drawingHeld(), []);
  assertEquals([moving, settled, count], [0, 3, 3]);
});
