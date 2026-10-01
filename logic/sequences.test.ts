// Real-time playback: where a frame sits in a heartbeat, or on the clock.
import { assertEquals } from "jsr:@std/assert@1";
import { frameAtElapsed, frameTime, heartbeatFraction, indexOf, realTimeSchedule } from "./sequences.ts";
import type { FrameTiming } from "./readers/dicom-series.ts";

const cardiac: FrameTiming[] = [213, 250, 300, 350, 400].map((d, i) => ({ index: i, count: 5, label: `${d} ms`, delayMs: d, bpm: 86, timeSec: 43218 }));
const clock: FrameTiming[] = Array.from({ length: 10 }, (_, i) => ({ index: i, count: 10, label: `${i + 1} of 10`, timeSec: 43201.5 + i * 0.9 }));

Deno.test("frameTime: a cardiac frame is its R-wave delay; a clock frame is seconds since the first; neither is nothing", () => {
  assertEquals(frameTime(cardiac, 1), { time: 0.25 });
  assertEquals(frameTime(clock, 0), { time: 0 });
  assertEquals(frameTime(clock, 3), { time: 2.7 });
  assertEquals(frameTime([{ index: 0, count: 2, label: "1 of 2" }, { index: 1, count: 2, label: "2 of 2" }], 1), {});
  assertEquals(frameTime(undefined, 0), {});
});

Deno.test("realTimeSchedule: one heartbeat for a gated series, the acquisition times plus a gap for a clock series", () => {
  const items = (t: FrameTiming[]) => t.map((x, i) => ({ index: String(i), node: `n${i}`, ...frameTime(t, i) }));
  const c = realTimeSchedule({ items: items(cardiac), heartRateBpm: 86 })!;
  assertEquals(c.kind, "cardiac");
  assertEquals(c.times, [0.213, 0.25, 0.3, 0.35, 0.4]);
  assertEquals(Math.round(c.period * 1000), 698);   // 60 / 86
  const k = realTimeSchedule({ items: items(clock) })!;
  assertEquals(k.kind, "clock");
  assertEquals(k.times[9], 8.1);
  assertEquals(k.period, 9);                        // 8.1 s of frames and one more 0.9 s gap
  // no times, or a delay past the beat: no schedule rather than a wrong one
  assertEquals(realTimeSchedule({ items: [{ index: "0", node: "a" }, { index: "1", node: "b" }] }), null);
  assertEquals(realTimeSchedule({ items: [{ index: "0", node: "a", time: 0.2 }, { index: "1", node: "b", time: 0.9 }], heartRateBpm: 86 }), null);
  assertEquals(realTimeSchedule(undefined), null);
});

Deno.test("frameAtElapsed: the latest frame whose time has come; the last one holds through the wait for the next R-wave", () => {
  const s = realTimeSchedule({ items: cardiac.map((x, i) => ({ index: String(i), node: `n${i}`, ...frameTime(cardiac, i) })), heartRateBpm: 86 })!;
  assertEquals(frameAtElapsed(s, 0.0), 4);       // before 213 ms: still the 400 ms frame
  assertEquals(frameAtElapsed(s, 0.213), 0);
  assertEquals(frameAtElapsed(s, 0.26), 1);
  assertEquals(frameAtElapsed(s, 0.5), 4);
  assertEquals(frameAtElapsed(s, s.period + 0.31), 2);   // the second beat
  assertEquals(frameAtElapsed(s, -0.1), 4);
});

Deno.test("heartbeatFraction: the delay as a share of the R-R interval; nothing without a heart rate", () => {
  assertEquals(heartbeatFraction({ heartRateBpm: 86 }, { index: "250", node: "n", time: 0.25 }), "36 % of R-R at 86 bpm");
  assertEquals(heartbeatFraction({}, { index: "250", node: "n", time: 0.25 }), "");
  assertEquals(heartbeatFraction({ heartRateBpm: 86 }, { index: "1", node: "n" }), "");
  assertEquals(indexOf("250 ms", 3), { value: "250", numeric: true });
});
