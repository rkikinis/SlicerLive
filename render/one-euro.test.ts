// The 1€ filter (one-euro.ts): jitter on a still value is reduced, a real move is followed.
//
//   deno test -A --no-check render/one-euro.test.ts
import { assert } from "jsr:@std/assert@1";
import { HEAD_ROTATION, oneEuro } from "./one-euro.ts";

const HZ = 57;   // the glasses' poses arrive about 57 times a second (the session log's "head poses")

Deno.test("held still: the jitter is cut to a small part of what came in", () => {
  const f = oneEuro(HEAD_ROTATION);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  let inMax = 0, outMax = 0;
  for (let i = 0; i < 400; i++) {
    const v = 0.003 * rnd();                                  // ±1.5 mrad of noise around 0
    const out = f.filter([v], i / HZ)[0];
    if (i > 100) { inMax = Math.max(inMax, Math.abs(v)); outMax = Math.max(outMax, Math.abs(out)); }
  }
  // About a fourth of the input (3.9x measured), and -- as a quaternion component, ±1.5e-3 is about ±0.17 degrees of head
  // turn -- below the glasses' 0.1 degree dead zone (live-views.ts `still`), so a still head no longer redraws.
  assert(outMax < inMax / 3, `filtered ${outMax} against ${inMax} in`);
  assert(2 * Math.asin(outMax) * 180 / Math.PI < 0.1, `filtered ${outMax} is not below the 0.1 degree dead zone`);
});

Deno.test("a real turn is followed: within a quarter second of stopping, the value is close to where the head stopped", () => {
  // (and during the turn it lags by at most a few samples: checked below)
  const f = oneEuro(HEAD_ROTATION);
  let out = 0, i = 0;
  for (; i < 30; i++) out = f.filter([0], i / HZ)[0];
  let worstLag = 0;
  for (let k = 0; k < 20; k++, i++) { out = f.filter([(k + 1) * 0.02], i / HZ)[0]; worstLag = Math.max(worstLag, (k + 1) * 0.02 - out); }   // 0.4 in 0.35 s: a quick head turn
  assert(worstLag < 0.08, `during the turn the filter fell ${worstLag} behind (4 samples' worth is 0.08)`);
  for (let k = 0; k < 14; k++, i++) out = f.filter([0.4], i / HZ)[0];              // then still for 0.25 s
  assert(Math.abs(out - 0.4) < 0.04, `at ${out}, the head at 0.4`);
});

Deno.test("reset forgets; a first value comes back unchanged", () => {
  const f = oneEuro({ minCutoff: 1, beta: 0, dCutoff: 1 });
  f.filter([1, 2], 0); f.filter([5, 5], 0.1);
  f.reset();
  const v = f.filter([3, 4], 1);
  assert(v[0] === 3 && v[1] === 4);
});

Deno.test("a clock that steps back does not freeze the head: the value goes on following", () => {
  const f = oneEuro(HEAD_ROTATION);
  let i = 0, out = 0;
  for (; i < 30; i++) out = f.filter([0], 100 + i / HZ)[0];
  for (let k = 0; k < 30; k++) out = f.filter([0.3], 99 + k / HZ)[0];    // the stamps a second earlier than before
  assert(out > 0.25, `stuck at ${out} while the head is at 0.3`);
});
