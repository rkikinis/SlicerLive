import type { SceneRenderer } from "../scene-renderer.ts";
import type { Gpu } from "../device.ts";
import { BudgetController, stepMovingScale } from "../budget-controller.ts";

// Shared idle-convergence driver for temporal AA (docs/UNIFIED-RENDERING-PLAN.md M2). While the
// view is still, keep re-rendering with sub-pixel camera jitter so SceneRenderer.renderAccum folds
// each frame into a running mean → a supersampled, time-averaged-AA image. Any interaction calls
// kick(), which resets the mean to the fresh frame and restarts the convergence loop. One rAF chain,
// self-cancelling at the target sample count; the human always sees frame 1 immediately (byte-
// identical to a plain render), then it sharpens over the next ~half-second while idle.
export interface AccumLoop {
  /** View changed (camera/scene/size): render a fresh frame now, then converge while idle. */
  kick(): void;
  /** Cancel any pending convergence frames (e.g. on teardown). */
  stop(): void;
  /** The CONTENT changed, not the camera: redraw from a fresh full-quality frame, with no moving (reduced) frames.
   *  A sequence playing at 4 frames a second changed the resolution with every frame when each step counted as an
   *  interaction (Ron, 2026-09-25: "3d view resolutions changes constantly"). Optional: the plain loop kicks. */
  refresh?(): void;
}

export function mountAccumLoop(opts: {
  drawOnce: (reset: boolean) => void;   // setCamera + scene.renderAccum(view, w, h, reset)
  count: () => number;                  // scene.accumCount()
  target?: number;                      // samples to converge to (default 32)
}): AccumLoop {
  const target = opts.target ?? 32;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (opts.count() >= target) return;   // converged — stop until the next kick
    opts.drawOnce(false);                 // accumulate one more jittered sample
    raf = requestAnimationFrame(tick);
  };
  return {
    kick() {
      opts.drawOnce(true);                // reset: fresh frame (byte-identical, no jitter)
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

// ADAPTIVE driver (M2b): the full budget×AA loop. While interacting (kicks arriving), render fast
// budget-scaled MOVING frames (low-res trace + Catmull-Rom upsample). When kicks stop for idleGapMs,
// switch to SETTLED convergence (native + temporal accumulation). Any kick cancels the settle. This
// is the local half of the transport-driven adaptivity the remote path (M4) reuses with a different
// budget input. renderMoving owns the budget (measure ms → BudgetController.update); the driver just
// decides moving-vs-settled from interaction timing.
export function mountAdaptiveLoop(opts: {
  renderMoving: () => void;              // one budget-scaled frame; updates the budget from measured ms
  renderSettled: (reset: boolean) => void;  // one native accumulated frame
  count: () => number;                  // scene.accumCount()
  target?: number;                      // convergence target (default 32)
  idleGapMs?: number;                   // consider the view "settled" this long after the last kick (default 120)
  sync?: () => Promise<unknown>;        // await after each frame — pass queue.onSubmittedWorkDone for GPU pacing
}): AccumLoop {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 120;
  // GPU-PACED async loop (ported from the Python spike's producer). The first frame after a kick
  // renders SYNCHRONOUSLY (immediate response — no rAF wait), then each subsequent frame awaits the
  // GPU (opts.sync = onSubmittedWorkDone) so we NEVER submit faster than the GPU drains. That kills
  // the backlog that made the first drag frame appear a second late (moving frames were queued behind
  // a pile of full-res settle frames). Awaiting also yields to input, so a new kick preempts within
  // one GPU frame. A rAF is awaited too, capping cadence at display rate for light scenes.
  // Frame pacing: requestAnimationFrame caps at the display rate WHEN VISIBLE, but the browser
  // throttles rAF to ~0-1Hz when the window is backgrounded/occluded (even with
  // --disable-renderer-backgrounding on macOS) — which would FREEZE a mirror the moment you focus
  // the other app. So race rAF against a 30Hz timer fallback: rAF wins when foreground; the timer
  // keeps the loop alive (~30fps) when rAF is throttled (setTimeout is exempt under
  // --disable-background-timer-throttling). GPU `sync` still paces us to actual GPU completion.
  const paced = () => Promise.race([
    new Promise<void>((r) => requestAnimationFrame(() => r())),
    new Promise<void>((r) => setTimeout(r, 33)),
  ]);
  const sync = opts.sync ?? (() => Promise.resolve());
  let running = false, stopped = false, lastKick = -1e12, wasMoving = false, fresh = false;
  const step = () => {
    if (performance.now() - lastKick < idleGap) { opts.renderMoving(); wasMoving = true; fresh = false; return true; }
    if (wasMoving || fresh) { wasMoving = false; fresh = false; opts.renderSettled(true); return true; }
    if (opts.count() < target) { opts.renderSettled(false); return true; }
    return false;                          // converged + idle
  };
  const run = async () => {
    running = true; stopped = false;
    while (!stopped && step()) await Promise.all([sync(), paced()]);
    running = false;
  };
  return {
    kick() { lastKick = performance.now(); if (!running) run(); },   // run() renders the 1st frame synchronously
    stop() { stopped = true; },
    refresh() { fresh = true; if (!running) run(); },
  };
}

// One-call adaptive 3D driver: wires a BudgetController + the moving/settled render pair + the
// coalesced loop for a demo's 3D view, so every demo gets budget-scaled interaction + temporal AA
// from a single call (DRY). Getters (scene/view/size) keep it valid across a scene rebuild. Returns
// `draw()` (call on any interaction/redraw) plus the pieces for optional debug hooks.
export interface Adaptive3d {
  draw(): void;                                  // kick the loop: an INTERACTION (camera, a dragged slice)
  refresh(): void;                               // the content changed: a fresh full-quality frame, no moving frames
  budget: BudgetController;
  renderSettled(reset: boolean): void;           // native accumulate (for debug converge)
  renderMoving(): void;                           // one budget-scaled frame (for debug)
  loop: AccumLoop;
}
export function mountAdaptive3d(opts: {
  scene: () => SceneRenderer | null;             // getter (survives scene rebuilds)
  view: () => GPUTextureView;                     // swap-chain view to present into
  size: () => { w: number; h: number };          // 3D canvas drawing-buffer size
  setCamera: (sc: SceneRenderer, w: number, h: number) => void;
  gpu: Gpu;
  target?: number;                                // AA convergence target (default 24)
  targetMs?: number;                              // budget frame-time target (default 16)
  movingScaleCap?: number | (() => number);       // max resolution scale WHILE MOVING (default 1; <1 for heavy scenes); a function reads it per frame
  budgeted?: () => boolean;                       // let the budget lower the moving resolution (default: only when the cap is below 1)
  onFps?: (fps: number, scale: number) => void;   // frames per second and resolution while moving, a few times a second
  /** True while the content changes by itself on a schedule -- a sequence playing. Its changes are then never "moving":
   *  each frame is drawn at full quality (Ron, 2026-09-25, the beating heart: "3d view resolutions changes constantly"). */
  steady?: () => boolean;
  /** Opt-in (default 1 = off). Once a moving frame is already at NATIVE resolution, spend any
   *  remaining frame budget on jittered samples of that frame instead of leaving it idle. At a low
   *  fps target the budget buys resolution first and anti-aliasing second, which is what sub-pixel
   *  geometry (hair-fine tubes) needs: full resolution alone still aliases badly at one sample.
   *  Left at 1, behaviour is exactly as before, so demos that don't ask for it are untouched. */
  maxMovingSamples?: number;
  idleGapMs?: number;                             // stay in cheap MOVING mode this long after the last kick (default 120)
  onFrame?: () => void;                           // after each 3D frame (e.g. redraw a crosshair overlay)
}): Adaptive3d {
  const budget = new BudgetController({ targetMs: opts.targetMs ?? 16 });
  let movingScale = 0;                            // the step in use while moving (0: none yet)
  let lastBuilds = 0, lastUploads = 0;
  const DBG = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
  let dbgN = 0, dbgMoving = 0, dbgSettled = 0, dbgLast = 0;
  const dbgTick = (kind: "mov" | "set", ms: number, s: number, k = 1) => {
    if (!DBG) return;
    dbgN++; if (kind === "mov") dbgMoving += ms; else dbgSettled += ms;
    const now = performance.now();
    if (now - dbgLast > 500) { console.log(`[perf] mov=${dbgMoving.toFixed(0)}ms/${dbgN}f settled=${dbgSettled.toFixed(0)}ms lastScale=${s.toFixed(2)} samples=${k} last=${ms.toFixed(1)}ms`); dbgLast = now; dbgMoving = dbgSettled = dbgN = 0; }
  };
  const movingCap = () => typeof opts.movingScaleCap === "function" ? opts.movingScaleCap() : (opts.movingScaleCap ?? 1);
  // ONE LINE PER INTERACTION into the session log (not only with ?perf): how many moving frames the
  // burst drew, their mean and worst GPU time and the resolution scale the budget settled on, then
  // how long the settle took to converge. Ron, 2026-09-17: "the speed of loading, viewing and
  // saving" -- and no frame had ever been timed outside a debug session.
  let burstN = 0, burstSum = 0, burstMax = 0, burstScale = 1, settleT0 = 0, settleOpen = false;
  // FRAMES PER SECOND AS SEEN: moving frames finished per second of wall clock, from the first
  // finished frame of the drag to the latest. Ron, 2026-09-23: "15 frames per second are borderline,
  // 30 are more than enough. It would be nice to be able to see the fps."
  let burstFirstDone = 0, burstLastDone = 0, fpsSaidAt = 0;
  const burstFps = () => burstN >= 2 && burstLastDone > burstFirstDone ? (burstN - 1) / ((burstLastDone - burstFirstDone) / 1000) : 0;
  let lastUploadMs = 0;
  const logLine = (line: string) => { try { void fetch("/_log", { method: "POST", body: line, keepalive: true }).catch(() => {}); } catch { /* no server */ } };
  const burstEnd = () => {
    // Shader builds and mesh uploads since the last line: a sequence step should add none of
    // either (critic, 2026-09-19, findings 1-2); the numbers here are what shows it in the app.
    const sc = opts.scene();
    const builds = (sc?.buildCount ?? 0) - lastBuilds, uploads = (sc?.uploadCount ?? 0) - lastUploads;
    const upMs = ((sc as { uploadMs?: number } | undefined)?.uploadMs ?? 0) - lastUploadMs;
    lastBuilds = sc?.buildCount ?? 0; lastUploads = sc?.uploadCount ?? 0; lastUploadMs = (sc as { uploadMs?: number } | undefined)?.uploadMs ?? 0;
    // "worst" is from the start of the frame until the GPU has finished EVERYTHING queued by then --
    // other uploads included -- so it is not the page's blocked time. The uploads' own page time is.
    const fps = burstFps();
    if (fps) opts.onFps?.(fps, burstScale);
    if (burstN) logLine(`3D interaction: ${burstN} moving frames${fps ? ` at ${fps.toFixed(0)} frames a second` : ""}, mean ${(burstSum / burstN).toFixed(1)} ms, worst ${burstMax.toFixed(1)} ms, drawn at ${(burstScale * 100).toFixed(0)}% resolution in ${(globalThis as unknown as { __traceStrips?: number }).__traceStrips ?? 1} strip${((globalThis as unknown as { __traceStrips?: number }).__traceStrips ?? 1) === 1 ? "" : "s"}${builds || uploads ? ` · ${builds} shader build${builds === 1 ? "" : "s"}, ${uploads} mesh upload${uploads === 1 ? "" : "s"}${uploads ? ` (${upMs.toFixed(0)} ms of the page's time)` : ""}` : ""}`);
    burstN = 0; burstSum = 0; burstMax = 0; burstFirstDone = 0; burstLastDone = 0;
  };
  const maxMovingSamples = Math.max(1, Math.round(opts.maxMovingSamples ?? 1));
  let sampleMs = 0;                     // measured cost of ONE moving sample, for sizing k below
  const renderMoving = () => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    // Cap moving resolution so a heavy DVR is interactive FROM FRAME ONE (no waiting for the budget
    // to adapt down over several frames). Moving frames are transient — the settle snaps to native.
    // A cap of 1 means "no budget": the caller says the scene is light (surfaces only), and the
    // budget's slow ramp from its 0.35 MP start would otherwise keep a short drag soft and then
    // snap sharp on the settle -- the flicker Ron saw on 2026-09-20. The budget still governs
    // when a volume is rendered (cap 0.4).
    const cap = movingCap();
    // THE BUDGET DECIDES when the caller says so (a volume in view): resolution drops only as far as
    // the frame-time target needs, and not at all when full resolution already makes it.
    const useBudget = opts.budgeted?.() ?? cap < 1;
    // In steps, so a drag reuses one set of render targets (budget-controller.ts, stepMovingScale).
    const s = !useBudget ? 1 : (movingScale = stepMovingScale(movingScale, Math.min(cap, budget.scale(vw, vh)))), t0 = performance.now();
    // Spend LEFTOVER budget on anti-aliasing, but only once resolution is already native: a slow GPU
    // must still buy pixels before samples. k = how many whole samples fit in the frame target.
    // (Steve's, origin/main: off unless a caller asks, maxMovingSamples > 1.)
    const k = (maxMovingSamples > 1 && s > 0.98 && sampleMs > 0)
      ? Math.max(1, Math.min(maxMovingSamples, Math.floor(budget.targetMs / sampleMs)))
      : 1;
    if (s > 0.98) {
      opts.setCamera(sc, vw, vh);
      if (k > 1) {
        // One swap-chain texture for the whole frame, so these k renders resolve to a single present.
        const view = opts.view();
        sc.renderAccum(view, vw, vh, true);
        for (let i = 1; i < k; i++) { opts.setCamera(sc, vw, vh); sc.renderAccum(view, vw, vh, false); }
      } else {
        sc.renderToView(opts.view(), vw, vh);
      }
    } else { const rw = Math.max(16, Math.round(vw * s)), rh = Math.max(16, Math.round(vh * s)); opts.setCamera(sc, rw, rh); sc.renderUpscaled(opts.view(), rw, rh, vw, vh); }
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => {
      const now = performance.now(), ms = now - t0;
      sampleMs = ms / k;
      // The budget steers on PER-SAMPLE cost (the whole k-sample time would read as one slow frame).
      budget.update(sampleMs); dbgTick("mov", ms, s, k); burstN++; burstSum += ms; burstMax = Math.max(burstMax, ms); burstScale = s;
      if (!burstFirstDone) burstFirstDone = now;
      burstLastDone = now;
      if (now - fpsSaidAt > 250) { const f = burstFps(); if (f) { opts.onFps?.(f, s); fpsSaidAt = now; } }
    });
    opts.onFrame?.();
  };
  const renderSettled = (reset: boolean) => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    const t0 = performance.now();
    if (reset) { burstEnd(); settleT0 = t0; settleOpen = true; }
    opts.setCamera(sc, vw, vh); sc.renderAccum(opts.view(), vw, vh, reset);
    if (DBG) opts.gpu.device.queue.onSubmittedWorkDone().then(() => dbgTick("set", performance.now() - t0, 1));
    if (settleOpen && sc.accumCount() >= (opts.target ?? 24)) {
      settleOpen = false;
      opts.gpu.device.queue.onSubmittedWorkDone().then(() => logLine(`3D settled: ${sc.accumCount()} samples in ${((performance.now() - settleT0) / 1000).toFixed(2)} s`));
    }
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({
    renderMoving, renderSettled,
    count: () => opts.scene()?.accumCount() ?? 1e9,
    target: opts.target ?? 24,
    idleGapMs: opts.idleGapMs,
    sync: () => opts.gpu.device.queue.onSubmittedWorkDone(),   // GPU-paced: no backlog, input preempts
  });
  let kickN = 0, kickLast = 0;
  const draw = () => {
    if (DBG) { kickN++; const now = performance.now(); if (now - kickLast > 500) { console.log(`[perf] kicks=${kickN} in 500ms`); kickN = 0; kickLast = now; } }
    loop.kick();
  };
  // A STREAM OF CONTENT CHANGES IS AN INTERACTION after all: a dragged transfer-function point or opacity slider changes
  // the content many times a second for as long as the drag lasts, and keeps the fast moving frames. A short burst -- a
  // sequence step switches every phase's segmentation in a few milliseconds, then nothing for a quarter second at 4 a
  // second -- is one change and draws at full quality. A stream: changes less than 150 ms apart for more than 300 ms.
  let lastRefresh = -1e12, streamStart = -1e12;
  const refresh = () => {
    const now = performance.now();
    if (now - lastRefresh > 150) streamStart = now;
    lastRefresh = now;
    if (loop.refresh && opts.steady?.()) { loop.refresh(); return; }
    if (!loop.refresh || now - streamStart > 300) loop.kick(); else loop.refresh();
  };
  return { draw, refresh, budget, renderSettled, renderMoving, loop };
}
