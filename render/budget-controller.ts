// Closed-loop render budget (docs/UNIFIED-RENDERING-PLAN.md §8). A direct TS port of the Python
// modal_spike `tune_budget`/`motion_scale`: steer a pixel budget so the MEASURED frame time tracks a
// target, then derive a resolution scale from it. The constraint is pluggable — locally the measured
// ms is GPU frame time (queue.onSubmittedWorkDone), remotely it will be render+encode+transport time —
// so the same controller governs "how many pixels to trace per frame" against GPU headroom OR
// bandwidth+latency. Only used WHILE INTERACTING; a settled view always renders native (scale 1) and
// converges via temporal accumulation.

export interface BudgetOpts {
  targetMs?: number;   // frame-time target the loop steers toward (default 16 ≈ one display refresh)
  minPx?: number;      // budget floor (default 0.15 MP)
  maxPx?: number;      // budget ceiling (default 8 MP)
  startPx?: number;    // initial budget (default 1.2 MP)
}

export class BudgetController {
  budgetPx: number;
  /** Mutable so a demo can expose it: a viewer who would rather have detail than frame rate raises
   *  the target frame time, and the loop then keeps a bigger fraction of the native resolution while
   *  interacting instead of downsampling into aliasing. */
  targetMs: number;
  private minPx: number;
  private maxPx: number;

  constructor(opts: BudgetOpts = {}) {
    this.targetMs = opts.targetMs ?? 16;
    // Floor low enough that even a SMALL viewport can downscale under load: a heavy DVR in a
    // 0.27MP cell must be allowed to drop below native to hit targetMs. Start modest so the first
    // interaction frame isn't a full-res hitch; the controller ramps back up when there's headroom.
    this.minPx = opts.minPx ?? 0.03e6;
    this.maxPx = opts.maxPx ?? 8e6;
    this.budgetPx = opts.startPx ?? 0.35e6;
  }

  /** Nudge the budget toward hitting targetMs. Multiplicative, clamped per step (0.8–1.25×) so the
   *  loop is stable, and bounded to [minPx, maxPx]. Faster-than-target grows it; slower shrinks it. */
  update(measuredMs: number): void {
    if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) return;
    // Asymmetric: shrink faster than we grow, so a heavy scene drops to an interactive resolution
    // within a few frames (engagement latency), then eases back up gently when there's headroom.
    const adj = Math.max(0.35, Math.min(1.2, this.targetMs / measuredMs));
    this.budgetPx = Math.max(this.minPx, Math.min(this.maxPx, this.budgetPx * adj));
  }

  /** Resolution scale for a `w×h` view: sqrt(budget / area), clamped to [0.25, 1]. 1 when the view
   *  already fits the budget (small window); a fraction for a big/retina window under load. */
  scale(w: number, h: number): number {
    const area = Math.max(1, w * h);
    return Math.max(0.25, Math.min(1, Math.sqrt(this.budgetPx / area)));
  }
}

/**
 * THE MOVING SCALE IN STEPS, NOT A CONTINUUM. The budget's scale changes a little every frame, and every new
 * trace size re-creates the 3D view's working images (the low-resolution trace, the surface color, depth and
 * normal targets): ~80 MB a frame on a Retina window at 60%, at 30 frames a second. Suspected of Ron's
 * out-of-memory reset (2026-09-24 16:40, after a minute of dragging a slice shown in 3D and zooming, the log showing
 * a different resolution nearly every frame) -- suspected, NOT confirmed: the page still peaked at 3.2-3.5 GB with
 * this and the corner drawing in place (WORKING-STATE, 16:50 and 17:04). So the scale moves in eighths, and only
 * when the budget has left the step in use by half a step: a drag reuses one set of targets.
 */
export const MOVING_SCALE_STEP = 1 / 8;
export function stepMovingScale(current: number, raw: number): number {
  if (raw > 0.98) return 1;
  // The step in use holds while the budget stays within half a step below it and one and a half above (the
  // step covers [current, current + step); the half steps are the reluctance to switch).
  if (current > 0 && current < 1 && raw >= current - MOVING_SCALE_STEP / 2 && raw < current + 1.5 * MOVING_SCALE_STEP) return current;
  return Math.max(0.25, Math.floor(raw / MOVING_SCALE_STEP) * MOVING_SCALE_STEP);
}
