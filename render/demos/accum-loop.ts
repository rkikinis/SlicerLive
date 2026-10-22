import type { SceneRenderer } from "../scene-renderer.ts";
import type { Gpu } from "../device.ts";
import { BudgetController, stepMovingScale } from "../budget-controller.ts";
import { gpuScoped, notePicture } from "../gpu-scope.ts";
import { TurnMeter, type TurnReading } from "../turn-meter.ts";

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

// HOLDING THE 3D VIEW WHILE OTHER HEAVY CARD WORK RUNS (2026-10-03): Ron's window lost its card when whole-brain fiber
// tracking (compute, extensions/diffusion) ran beside a 3D view of the solid anatomy -- macOS's watchdog aborted a command
// buffer, "Impacting Interactivity" in the system log, as on 2026-09-23 with an AI network. While anything holds drawing,
// no 3D frame is started; a change that arrives meanwhile is drawn, at full quality, when the last hold is released.
// One place for the count (single access point): globalThis, so every bundle that mounts a loop sees the same holds.
const HOLDS = "__albulaDrawingHolds";
type Holds = { count: number; reasons: string[]; waiting: Set<() => void> };
const holds = (): Holds => ((globalThis as Record<string, unknown>)[HOLDS] ??= { count: 0, reasons: [], waiting: new Set() }) as Holds;
/** Hold the 3D views' drawing for heavy card work; returns the release (call it once, in a finally). */
export function holdDrawing(reason: string): () => void {
  const h = holds(); h.count++; h.reasons.push(reason);
  let done = false;
  return () => {
    if (done) return; done = true;
    h.count--; h.reasons.splice(h.reasons.indexOf(reason), 1);
    if (h.count === 0) { const w = [...h.waiting]; h.waiting.clear(); for (const f of w) f(); }
  };
}
/** Whether drawing is held, and by what (for the views' own status, and for whoever is looking). */
export const drawingHeld = (): string[] => [...holds().reasons];

// ADAPTIVE driver (M2b): the full budget×AA loop. While interacting (kicks arriving), render fast
// budget-scaled MOVING frames (low-res trace + Catmull-Rom upsample). When kicks stop for idleGapMs,
// switch to SETTLED convergence (native + temporal accumulation). Any kick cancels the settle. This
// is the local half of the transport-driven adaptivity the remote path (M4) reuses with a different
// budget input. renderMoving owns the budget (measure ms → BudgetController.update); the driver just
// decides moving-vs-settled from interaction timing.
export function mountAdaptiveLoop(opts: {
  /** One budget-scaled frame; updates the budget from measured ms. `changeAt`: when the oldest change it shows came. */
  renderMoving: (changeAt: number) => void;
  /** One native accumulated frame. `unchanged`: the settle after a turn, with nothing changed since its last picture. */
  renderSettled: (reset: boolean, unchanged?: boolean) => void;
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
  // AN UNCHANGED VIEW IS NOT DRAWN AGAIN (critic 2026-10-17, fps measurement, findings 1-2): while the view moves, a
  // picture is drawn only when something changed since the last one. Drawing the same view again whenever the card was
  // free made "fps" count repeats -- 22 on the label against 10 new pictures a second on a slow turn -- and a movement
  // that came meanwhile waited behind the repeat (166 ms against 99 from hand to screen).
  let pendingSince = 0;                   // when the oldest change not yet drawn came (0: none)
  // Waiting for the next change: a change wakes the loop at once, not at the next display refresh.
  let wake: (() => void) | null = null;
  const waitForChange = () => new Promise<void>((r) => { wake = r; void paced().then(r); }).finally(() => { wake = null; });
  const step = (): boolean | "wait" => {
    if (performance.now() - lastKick < idleGap) {
      if (!pendingSince && !fresh) return "wait";   // still turning, nothing new: draw nothing
      const since = pendingSince || performance.now(); pendingSince = 0; fresh = false; wasMoving = true; opts.renderMoving(since);
      return true;
    }
    if (wasMoving || fresh) { const unchanged = wasMoving && !fresh && !pendingSince; wasMoving = false; fresh = false; pendingSince = 0; opts.renderSettled(true, unchanged); return true; }
    if (opts.count() < target) { opts.renderSettled(false); return true; }
    return false;                          // converged + idle
  };
  const run = async () => {
    running = true; stopped = false;
    while (!stopped) {
      // Held (holdDrawing): wait for the release, then draw the newest content from a fresh full-quality frame.
      if (holds().count > 0) { holds().waiting.add(resume); break; }
      const did = step();
      if (!did) break;
      await (did === "wait" ? waitForChange() : Promise.all([sync(), paced()]));
    }
    running = false;
  };
  const resume = () => { fresh = true; if (!running && !stopped) run(); };
  return {
    kick() { lastKick = performance.now(); pendingSince ||= lastKick; if (!running) run(); else wake?.(); },   // run() renders the 1st frame synchronously
    stop() { stopped = true; },
    refresh() { fresh = true; pendingSince ||= performance.now(); if (!running) run(); else wake?.(); },
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
  renderSettled(reset: boolean, unchanged?: boolean): void;   // native accumulate (for debug converge)
  renderMoving(changeAt?: number): void;          // one budget-scaled frame (for debug)
  loop: AccumLoop;
  /** The turn reading no longer describes what is on screen (another scene): take it away (onFps(null)). */
  clearFps(): void;
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
  /** How fast the view follows a turn (turn-meter.ts), a few times a second while it turns and once at its end; null:
   *  no reading for what is on screen now (the size, the quality or the scene changed). */
  onFps?: (r: TurnReading | null, scale: number) => void;
  /** ONE RESOLUTION, CHOSEN BY THE PERSON (Ron, 2026-10-14: "I like the desk view to follow the same rule" as the glasses:
   *  a picture whose resolution changes while you look reads as flicker). When this returns a number, every frame --
   *  moving and still -- is drawn at that fraction of the view's pixels: no budget, no soft-while-moving, sharp-when-still.
   *  A slow card gives fewer frames, never a different picture. At 1 the still view still gathers its samples (the same
   *  resolution, less noise); below 1 the still view is one frame at that fraction, the same as the moving ones. */
  fixedScale?: () => number | null;
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
  const fixed = () => { const f = opts.fixedScale?.(); return f == null ? null : Math.min(1, Math.max(0.25, f)); };
  let lowSettled = false;                         // a still frame drawn at a fixed scale below 1: nothing more to gather
  const movingCap = () => typeof opts.movingScaleCap === "function" ? opts.movingScaleCap() : (opts.movingScaleCap ?? 1);
  // ONE LINE PER INTERACTION into the session log (not only with ?perf): how many moving frames the
  // burst drew, their mean and worst GPU time and the resolution scale the budget settled on, then
  // how long the settle took to converge. Ron, 2026-09-17: "the speed of loading, viewing and
  // saving" -- and no frame had ever been timed outside a debug session.
  let burstSize = "", burstDrawn = "";
  let burstN = 0, burstSum = 0, burstMax = 0, burstScale = 1, settleT0 = 0, settleOpen = false;
  // NEW PICTURES A SECOND WHILE THE VIEW MOVES (turn-meter.ts). Ron, 2026-09-23: "15 frames per second are borderline,
  // 30 are more than enough. It would be nice to be able to see the fps." Counted from the first change of the turn, each
  // picture a new view (critic 2026-10-17, fps measurement, findings 1 and 3); shown only for a turn long enough to say
  // (half a second, five pictures) and taken away when the size or the quality changes (finding 4).
  const meter = new TurnMeter();
  let fpsSaidAt = 0, fpsShownFor = "";
  const sayFps = (r: TurnReading | null, s: number, key: string) => {
    if (r) { opts.onFps?.(r, s); fpsShownFor = key; } else if (fpsShownFor) { opts.onFps?.(null, s); fpsShownFor = ""; }
  };
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
    const turn = meter.reading();
    if (turn) sayFps(turn, burstScale, `${burstDrawn}@${burstScale}`);
    meter.reset();
    // Where the card's time went, from its own clock (Ron, 2026-10-16, C3N-01524 at 13-17 frames a second: "I would have
    // hoped for faster" -- measured before anything is changed): the surfaces, the ray tracing, the final picture.
    // THE WHOLE PICTURE ONLY: Apple's card starts a pass before the one it depends on has ended, so its clock cannot
    // split the surfaces-and-solid pass from the ray tracing -- the split said "ray tracing" for what the solid look did
    // (critic 2026-10-16, tonight's fixes, finding 4). The parts, each timed alone: __time3d.
    // Only this turn's pictures (each turn its own sink, and none on the still pictures: finding 5); a reading longer
    // than the whole picture as the page timed it is impossible and is said as such, not averaged in (WebKit's clock
    // has read so, WORKING-STATE 2026-10-16 22:46).
    const pageMean = burstN ? burstSum / burstN : 0, cardMean = stageN ? stageSum.total / stageN : 0;
    const st = !stageN ? "" : cardMean <= pageMean + 1
      ? ` · on the graphics card (${stageN} of them measured): ${cardMean.toFixed(1)} ms a picture`
      : ` · the graphics card's clock read ${cardMean.toFixed(1)} ms, longer than the whole picture: not used`;
    stageN = 0; stageSum = { march: 0, surfaces: 0, composite: 0, total: 0 }; stageGen++;
    const strips = (sc as { strips?: number } | null)?.strips ?? 1;
    const said = turn
      ? `${turn.pictures} new pictures in ${turn.seconds.toFixed(1)} s (${turn.perSecond.toFixed(0)} a second), the first after ${turn.firstMs.toFixed(0)} ms, a movement shown after ${turn.followMs.toFixed(0)} ms (1 in 10 after more than ${turn.followWorstMs.toFixed(0)} ms), the longest wait between two ${turn.longestGapMs.toFixed(0)} ms`
      : `${burstN} new picture${burstN === 1 ? "" : "s"} (too short a turn for a rate)`;
    if (burstN) logLine(`3D interaction: ${said}; each ${burstDrawn} of ${burstSize} pixels (${(burstScale * 100).toFixed(0)}% across and down), mean ${pageMean.toFixed(1)} ms, worst ${burstMax.toFixed(1)} ms until finished on the card, the ray march in ${strips} strip${strips === 1 ? "" : "s"}${builds || uploads ? ` · ${builds} shader build${builds === 1 ? "" : "s"}, ${uploads} mesh upload${uploads === 1 ? "" : "s"}${uploads ? ` (${upMs.toFixed(0)} ms of the page's time)` : ""}` : ""}${st}`);
    burstN = 0; burstSum = 0; burstMax = 0;
  };
  const maxMovingSamples = Math.max(1, Math.round(opts.maxMovingSamples ?? 1));
  let sampleMs = 0;                     // measured cost of ONE moving sample, for sizing k below
  // EACH PICTURE IN ITS OWN ERROR SCOPE, AND TIMED ON THE CARD (render/gpu-scope.ts; Ron, 2026-10-16: "more
  // instrumentation … we want greased lightning"): an error names the 3D view, and the "play" line says its times.
  const scoped = (kind: string, fn: () => void) => {
    const t0 = performance.now();
    gpuScoped(opts.gpu.device, `the 3D view (${kind})`, fn);
    void opts.gpu.device.queue.onSubmittedWorkDone().then(() => notePicture(`3D view ${kind}`, performance.now() - t0));
  };
  const renderMoving = (changeAt?: number) => scoped("moving", () => renderMoving0(changeAt ?? performance.now()));
  type StageSink = NonNullable<SceneRenderer["onStageTimes"]>;
  let stageN = 0, stageSum = { march: 0, surfaces: 0, composite: 0, total: 0 }, stageGen = 0;
  const deskSinks = new WeakSet<StageSink>();
  let sinkGen = -1, sink: StageSink | null = null;
  /** This turn's sink: the renderer keeps the sink a picture was drawn with, so a reading that comes back after its
   *  turn's line was written falls to an old sink and is dropped. */
  const stageSink = (): StageSink => {
    if (sink && sinkGen === stageGen) return sink;
    const gen = sinkGen = stageGen;
    sink = (t) => { if (gen !== stageGen) return; stageN++; stageSum.march += t.marchMs; stageSum.surfaces += t.surfacesMs; stageSum.composite += t.compositeMs; stageSum.total += t.totalMs; };
    deskSinks.add(sink);
    return sink;
  };
  const deskSink = (f: SceneRenderer["onStageTimes"]) => f === null || deskSinks.has(f);
  const renderMoving0 = (changeAt: number) => {
    const sc = opts.scene(); if (!sc) return;
    // The desk's moving pictures carry the card's stage times; the glasses put their own sink while they draw.
    if (deskSink(sc.onStageTimes)) sc.onStageTimes = stageSink();
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
    const f = fixed();
    lowSettled = false;
    const s = f != null ? f : !useBudget ? 1 : (movingScale = stepMovingScale(movingScale, Math.min(cap, budget.scale(vw, vh)))), t0 = performance.now();
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
    const drawn = s > 0.98 ? `${vw}×${vh}` : `${Math.max(16, Math.round(vw * s))}×${Math.max(16, Math.round(vh * s))}`, key = `${drawn}@${s}`;
    // Another size or quality than the reading on screen: it no longer describes this view.
    if (fpsShownFor && fpsShownFor !== key) sayFps(null, s, key);
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => {
      const now = performance.now(), ms = now - t0;
      sampleMs = ms / k;
      // The budget steers on PER-SAMPLE cost (the whole k-sample time would read as one slow frame).
      budget.update(sampleMs); dbgTick("mov", ms, s, k); burstN++; burstSum += ms; burstMax = Math.max(burstMax, ms); burstScale = s; burstSize = `${vw}×${vh}`; burstDrawn = drawn;
      meter.picture(changeAt, now);
      if (now - fpsSaidAt > 250) { const r = meter.reading(); if (r) { sayFps(r, s, key); fpsSaidAt = now; } }
    });
    opts.onFrame?.();
  };
  const renderSettled = (reset: boolean, unchanged = false) => scoped("still", () => renderSettled0(reset, unchanged));
  const renderSettled0 = (reset: boolean, unchanged: boolean) => {
    const sc = opts.scene(); if (!sc) return;
    const { w: vw, h: vh } = opts.size(); if (!vw || !vh) return;
    const t0 = performance.now();
    if (reset) { burstEnd(); settleT0 = t0; settleOpen = true; }
    // The still pictures are not timed on the card: the line is about the turn (finding 5).
    if (deskSinks.has(sc.onStageTimes as StageSink)) sc.onStageTimes = null;
    const f = fixed();
    // Picture quality or the size changed with no turn yet: the reading on screen is not this view's (finding 4).
    if (f != null) { const fs = f, d = fs > 0.98 ? `${vw}×${vh}` : `${Math.max(16, Math.round(vw * fs))}×${Math.max(16, Math.round(vh * fs))}`;
      if (fpsShownFor && fpsShownFor !== `${d}@${fs}`) sayFps(null, fs, ""); }
    if (f != null && f < 0.98) {
      // The person's lower resolution holds for the still view too: one frame, as the moving ones are drawn -- and when
      // the last moving picture already shows everything at this resolution, that picture IS the still view: not drawn
      // again (finding 2: a pause in the hand should cost nothing).
      if (reset && unchanged && burstDrawn === `${Math.max(16, Math.round(vw * f))}×${Math.max(16, Math.round(vh * f))}` && burstScale === f) { lowSettled = true; settleOpen = false; return; }
      if (!reset && lowSettled) return;
      const rw = Math.max(16, Math.round(vw * f)), rh = Math.max(16, Math.round(vh * f));
      opts.setCamera(sc, rw, rh); sc.renderUpscaled(opts.view(), rw, rh, vw, vh);
      lowSettled = true;
      // Not while a series plays: each step settles, and the "play" line already sums them (critic 2026-10-16, general
      // audit, finding 7: about four of these lines a second).
      if (settleOpen) { settleOpen = false; if (!opts.steady?.()) opts.gpu.device.queue.onSubmittedWorkDone().then(() => logLine(`3D settled: one picture at ${Math.round(f * 100)}% (the chosen quality) in ${((performance.now() - settleT0) / 1000).toFixed(2)} s`)); }
      opts.onFrame?.();
      return;
    }
    lowSettled = false;
    opts.setCamera(sc, vw, vh); sc.renderAccum(opts.view(), vw, vh, reset);
    if (DBG) opts.gpu.device.queue.onSubmittedWorkDone().then(() => dbgTick("set", performance.now() - t0, 1));
    if (settleOpen && sc.accumCount() >= (opts.target ?? 24)) {
      settleOpen = false;
      if (!opts.steady?.()) opts.gpu.device.queue.onSubmittedWorkDone().then(() => logLine(`3D settled: ${sc.accumCount()} samples in ${((performance.now() - settleT0) / 1000).toFixed(2)} s`));
    }
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({
    renderMoving, renderSettled,
    count: () => lowSettled ? 1e9 : opts.scene()?.accumCount() ?? 1e9,
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
  const clearFps = () => { meter.reset(); sayFps(null, burstScale, ""); };
  return { draw, refresh, budget, renderSettled, renderMoving, loop, clearFps };
}
