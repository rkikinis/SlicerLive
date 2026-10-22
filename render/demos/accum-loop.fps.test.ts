// THE fps IN THE 3D VIEW'S BAR COUNTS NEW PICTURES (critic 2026-10-17, fps measurement, findings 1, 2, 4 and 9): a
// scripted pointer -- slow, paused, continuous -- against a fake card, the label checked against the changes drawn.
//   deno test -A --no-check render/demos/accum-loop.fps.test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { mountAdaptive3d } from "./accum-loop.ts";
import { TurnMeter } from "../turn-meter.ts";
import type { TurnReading } from "../turn-meter.ts";
import type { SceneRenderer } from "../scene-renderer.ts";
import type { Gpu } from "../device.ts";
(globalThis as Record<string, unknown>).requestAnimationFrame = (f: () => void) => setTimeout(f, 1);
const realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.resolve(new Response(""))) as typeof fetch;   // the session log: nowhere

function fakeScene() {
  const calls: string[] = [];
  const sc = {
    renderToView: (_v: unknown, w: number, h: number) => { calls.push(`full ${w}x${h}`); },
    renderUpscaled: (_v: unknown, rw: number, rh: number) => { calls.push(`scaled ${rw}x${rh}`); },
    renderAccum: (_v: unknown, w: number, h: number) => { calls.push(`accum ${w}x${h}`); },
    accumCount: () => 1e9, buildCount: 0, uploadCount: 0, onStageTimes: null,
  };
  return { sc: sc as unknown as SceneRenderer, calls };
}
const gpu = { device: { queue: { onSubmittedWorkDone: () => Promise.resolve() } } } as unknown as Gpu;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mount(quality = 0.7) {
  const { sc, calls } = fakeScene();
  const said: (TurnReading | null)[] = [];
  let w = 200;
  const a = mountAdaptive3d({
    scene: () => sc, view: () => ({}) as GPUTextureView, size: () => ({ w, h: 100 }), setCamera: () => {},
    gpu, fixedScale: () => quality, target: 4, idleGapMs: 120, onFps: (r) => said.push(r),
  });
  return { a, calls, said, resize: (n: number) => { w = n; } };
}
/** Move the "mouse" `n` times, `gapMs` apart. */
async function turn(a: { draw(): void }, n: number, gapMs: number) {
  for (let i = 0; i < n; i++) { a.draw(); await wait(gapMs); }
}

Deno.test("a slow turn: one picture per movement, and the label says the movements' rate, not the card's", async () => {
  const { a, calls, said } = mount();
  await turn(a, 12, 100);                     // 10 movements a second for 1.2 s
  await wait(200);
  assertEquals(calls.length, 12);             // no picture of an unchanged view, and no extra still picture at Balanced
  const r = said.filter(Boolean).at(-1)!;
  assertEquals(r.pictures, 12);
  assertAlmostEquals(r.perSecond, 10, 1.5);   // was the card's free rate before (critic: 22 against 10)
});

Deno.test("pauses in the hand draw nothing", async () => {
  const { a, calls } = mount();
  await turn(a, 3, 10);
  const before = calls.length;
  await wait(100);                            // a pause shorter than the settle
  assertEquals(calls.length, before);
  await wait(200);
  assertEquals(calls.length, before);         // the still view at Balanced is the last moving picture
});

Deno.test("Best: the still view still gathers its samples after a turn", async () => {
  const { a, calls } = mount(1);
  await turn(a, 3, 10);
  await wait(300);
  assert(calls.some((c) => c.startsWith("accum")));
});

Deno.test("a button press or a short flick sets no label; a new size takes the label away", async () => {
  const { a, said, resize } = mount();
  a.draw(); await wait(300);
  await turn(a, 3, 20); await wait(300);
  assertEquals(said.filter(Boolean).length, 0);
  await turn(a, 10, 60); await wait(300);
  assert(said.at(-1) !== null);
  resize(300);
  a.draw(); await wait(300);
  assertEquals(said.at(-1), null);
});

Deno.test("the meter: the first picture counts with its own time; the waits are the movements'", () => {
  const m = new TurnMeter();
  // Movement at 0; pictures finished at 120 (the slow first), then every 40 ms; each shows a movement 30 ms old.
  m.picture(0, 120);
  for (let i = 1; i < 15; i++) m.picture(120 + i * 40 - 30, 120 + i * 40);
  const r = m.reading()!;
  assertEquals(r.pictures, 15);
  assertAlmostEquals(r.perSecond, 15 / 0.68, 0.01);   // not 14 / 0.56: the first picture's time is in
  assertEquals(r.firstMs, 120);
  assertEquals(r.longestGapMs, 120);
  assertEquals(r.followMs, 30);
  assertEquals(m.reading() !== null, true);
  m.reset();
  m.picture(0, 40); m.picture(40, 80);
  assertEquals(m.reading(), null);                     // too short to say
});

Deno.test({ name: "(restore fetch)", fn: () => { globalThis.fetch = realFetch; } });
