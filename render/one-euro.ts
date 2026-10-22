// THE 1€ FILTER (Casiez, Roussel and Vogel, "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in
// Interactive Systems", CHI 2012): a low-pass filter whose cutoff rises with the speed of the signal -- strong smoothing
// when the input is nearly still (the jitter is removed), little when it moves fast (no lag on a real movement).
//
// Here for the glasses' head pose (Ron, 2026-10-16: "yes go ahead"): held still, the head sensor still reported moves of
// 3-6 pixels at the eye's resolution, so the view was redrawn about seven times a second for nothing and the picture
// shimmered by those pixels. Written from the paper's pseudocode; each value is filtered on its own.

export interface OneEuroParams {
  /** The cutoff when still, in hertz: lower is steadier and slower to follow a slow drift. */
  minCutoff: number;
  /** How fast the cutoff rises with speed (per unit of the value per second): higher is less lag on fast moves. */
  beta: number;
  /** The cutoff for the speed estimate itself, in hertz. */
  dCutoff: number;
}

const alpha = (cutoff: number, dt: number) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

/** A 1€ filter over a fixed-length vector: `filter(values, tSeconds)` returns the filtered values. `reset()` forgets. */
export function oneEuro(p: OneEuroParams): { filter(v: readonly number[], t: number): number[]; reset(): void } {
  let x: number[] | null = null, dx: number[] = [], last = 0;
  return {
    filter(v, t) {
      if (!x || x.length !== v.length) { x = [...v]; dx = v.map(() => 0); last = t; return [...x]; }
      // A STAMP NOT AFTER THE LAST (a wall clock stepped back, or two poses in one tick) is taken as one tick later, so
      // the head keeps moving (critic 2026-10-16, finding 12: a 1 s step back froze the head for 992 ms).
      const dt = t > last ? t - last : 1 / 60;
      if (t > last) last = t;
      const out = v.map((vi, i) => {
        const d = (vi - x![i]) / dt;
        dx[i] = dx[i] + alpha(p.dCutoff, dt) * (d - dx[i]);
        const cutoff = p.minCutoff + p.beta * Math.abs(dx[i]);
        return x![i] + alpha(cutoff, dt) * (vi - x![i]);
      });
      x = out;
      return [...out];
    },
    reset() { x = null; dx = []; last = 0; },
  };
}

/**
 * THE HEAD'S SETTINGS (version 1, 2026-10-16). The rotation as a unit quaternion's four components; the position in
 * meters. Held still, ±0.17 degrees of sensor jitter comes out under 0.05 degrees, below the 0.1 degree dead zone the
 * glasses already had; a head turn of 60 degrees a second (about 0.5 a second in a quaternion component) raises the
 * cutoff to 3 Hz, about 50 ms of lag; a 0.2 m/s lean raises the position's to 10 Hz.
 */
export const HEAD_ROTATION: OneEuroParams = { minCutoff: 0.5, beta: 5, dCutoff: 1 };
export const HEAD_POSITION: OneEuroParams = { minCutoff: 0.5, beta: 50, dCutoff: 1 };
