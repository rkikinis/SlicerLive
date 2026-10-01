/**
 * PLAYING A SEQUENCE: one player per scene, driven from wherever the transport is shown (the top
 * bar in every module; the Sequences module's list). Moved out of the Sequences panel so that
 * switching modules does not lose it -- Ron: "like 3D Slicer, he has the sequence controls at the
 * top, so you can go to different modules without losing it."
 *
 * Playback advances on the wall clock with frame dropping, as Slicer's browser does
 * (render/sequence.ts has the faithful mirror). The loop is a TIMER at twice the frame rate, not
 * requestAnimationFrame: Slicer polls at 50 Hz, and a browser throttles rAF for a pane it
 * considers in the background (the in-app browser fired it twice in 500 ms), which would make
 * playback crawl for no reason a person could see.
 */
import type { LiveScene } from "../render/livescene.ts";
import { browserFrames, frameAtElapsed, realTimeSchedule, selectFrame, sequenceBrowsers, type RealTimeSchedule } from "./sequences.ts";

interface Playing { browserId: string; startedAt: number; startFrame: number; fps: number; timer: ReturnType<typeof setInterval>; schedule: RealTimeSchedule | null }

export class SequencePlayer {
  private playing: Playing | null = null;
  private currentId = "";
  private listeners = new Set<() => void>();
  constructor(private live: LiveScene) {
    live.subscribe((c) => { if ((c.kind === "remove" || c.kind === "reset") && this.playing && !live.nodes.has(this.playing.browserId)) this.stop(); });
  }
  /** The browser the transport acts on: the chosen one, else the first in the scene. */
  get current(): string {
    const all = sequenceBrowsers(this.live);
    if (!all.some((b) => b.id === this.currentId)) this.currentId = all[0]?.id ?? "";
    return this.currentId;
  }
  set current(id: string) { if (id !== this.currentId) { this.currentId = id; this.emit(); } }
  get isPlaying(): boolean { return !!this.playing; }
  get playingId(): string | null { return this.playing?.browserId ?? null; }
  /** Called when play/stop or the chosen browser changes; a scrub is a scene change, seen through live.subscribe. */
  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private emit() { for (const cb of this.listeners) cb(); }

  /** The one timer this player may own, cleared unconditionally: there is never a second. */
  private timer: ReturnType<typeof setInterval> | null = null;
  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    const id = this.playing?.browserId ?? this.current;
    this.playing = null;
    if (id && this.live.nodes.get(id)?.playbackActive) this.live.write({ op: "patch", id, path: "#/playbackActive", value: false });
    this.emit();
  }
  play(browserId = this.current): void {
    this.stop();
    const b = this.live.nodes.get(browserId); if (!b) return;
    const fps = (b.playbackRateFps as number | undefined) ?? 4;
    const { sequence } = browserFrames(this.live, browserId);
    const schedule = b.playbackRealTime ? realTimeSchedule(sequence as unknown as Parameters<typeof realTimeSchedule>[0]) : null;
    const p: Playing = { browserId, startedAt: performance.now(), startFrame: (b.selectedItemNumber as number | undefined) ?? 0, fps, timer: 0 as unknown as ReturnType<typeof setInterval>, schedule };
    this.playing = p;
    this.live.write({ op: "patch", id: browserId, path: "#/playbackActive", value: true });
    // Real time steps as fast as the frames come (37 ms apart in a beat), so the timer is tight.
    this.timer = p.timer = setInterval(() => this.tick(), schedule ? 10 : Math.max(10, Math.round(500 / fps)));
    this.emit();
  }
  /** Playing by either account -- this player's, or the node's flag -- stops; otherwise plays. */
  toggle(browserId = this.current): void {
    if (this.playing || this.timer !== null || this.live.nodes.get(browserId)?.playbackActive) this.stop(); else this.play(browserId);
  }
  /** After a change of rate or real time: keep playing under the new setting. */
  restart(): void { if (this.playing) this.play(this.playing.browserId); }
  /** Step by hand: stops playback, moves one op. */
  step(n: number, browserId = this.current): void { this.stop(); selectFrame(this.live, browserId, n); }

  private tick() {
    const p = this.playing; if (!p) return;
    const { frames } = browserFrames(this.live, p.browserId);
    if (!frames.length) { this.stop(); return; }
    const elapsed = (performance.now() - p.startedAt) / 1000;
    // Real time: the frame whose moment in the beat (or on the clock) has come, the loop starting
    // at the frame that was showing. Otherwise floor(elapsed * fps + 0.5): the frame due now,
    // whatever was actually drawn since.
    const due = p.schedule
      ? frameAtElapsed(p.schedule, p.schedule.times[Math.min(p.startFrame, p.schedule.times.length - 1)] + elapsed)
      : (p.startFrame + Math.floor(elapsed * p.fps + 0.5)) % frames.length;
    const cur = (this.live.nodes.get(p.browserId)?.selectedItemNumber as number | undefined) ?? 0;
    if (due !== cur) selectFrame(this.live, p.browserId, due);
  }
}
