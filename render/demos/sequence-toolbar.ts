/**
 * THE TRANSPORT IN THE TOP BAR: which frame, play and pause, step, scrub, speed, real time --
 * present in every module whenever a sequence is in the scene, between the module picker and
 * the layout menu. Slicer's Sequence Browser toolbar sits there, and so does the header of
 * Steve's cardiac page; Ron asked for the same: "you can go to different modules without losing
 * it." The Sequences module keeps what is ABOUT a sequence (the scanner's pictures, a value over
 * time, the list); this is what DRIVES one.
 *
 * A scrub is one op on the browser node; the views follow. Everything here updates in place on a
 * frame step -- the label, the slider, the play glyph -- and rebuilds only when the set of
 * sequences changes, so playback never replaces a control under the pointer.
 */
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { SequencePlayer } from "../../logic/playback.ts";

import { browserFrames, heartbeatFraction, realTimeSchedule, selectFrame, sequenceBrowsers } from "../../logic/sequences.ts";

/** A label beside a slider in a centered bar KEEPS the widest width it has had: text that shrank and grew back
 *  re-centered the bar and moved the slider under the pointer (the slice slider's jump, 2026-09-24). */
const onlyGrow = (el: HTMLElement) => {
  const w = el.getBoundingClientRect().width, had = parseFloat(el.style.minWidth) || 0;
  if (w > had) el.style.minWidth = `${Math.ceil(w)}px`;
};

export function mountSequenceToolbar(shell: AppShell, opts: { live: LiveScene; player: SequencePlayer }): HTMLElement {
  const { live, player } = opts;
  const el = document.createElement("div");
  el.className = "sl-transport";
  el.hidden = true;
  // In the bar's Scene zone when there is one: the transport is part of the scene (app-shell.ts, scene-control.ts).
  const zone = shell.toolbar.parentElement!.querySelector(".sl-scene-zone");
  if (zone) zone.appendChild(el); else shell.toolbar.parentElement!.insertBefore(el, shell.toolbar);
  let builtFor = "";   // the browsers the controls were built for, by id

  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T | null;

  /** The parts that change on a step: label, beat, slider, the play glyph. */
  const update = () => {
    const id = player.current; if (!id) return;
    const b = live.nodes.get(id); if (!b) return;
    const { frames, selected, sequence } = browserFrames(live, id);
    const unit = (sequence?.indexUnit as string | undefined) ?? "";
    const label = q(".sl-transport-label"); if (label) { label.textContent = `${frames[selected]?.index ?? ""}${unit ? " " + unit : ""}`; onlyGrow(label); }
    const beat = heartbeatFraction(sequence as unknown as Parameters<typeof heartbeatFraction>[0], frames[selected]);
    const where = q(".sl-transport-where"); if (where) { where.textContent = `${selected + 1}/${frames.length}${beat ? " · " + beat : ""}`; onlyGrow(where); }
    const slider = q<HTMLInputElement>(".sl-transport-scrub");
    if (slider && document.activeElement !== slider) slider.value = String(selected);
    const play = q<HTMLButtonElement>(".sl-transport-play");
    if (play) {
      const on = player.isPlaying && player.playingId === id;
      // Touch the button only when its state changed: this runs on every frame step, and a
      // button rewritten under a press is a press that may never become a click.
      const glyph = on ? "❚❚" : "▶";
      if (play.textContent !== glyph) { play.textContent = glyph; play.title = on ? "Pause" : "Play through the frames, looping"; play.classList.toggle("sl-transport-on", on); }
    }
    const rt = q<HTMLButtonElement>(".sl-transport-rt");
    if (rt) rt.classList.toggle("sl-transport-on", !!b.playbackRealTime);
    // NOT UNDER THE POINTER. This runs on every frame step; writing the speed slider's value while
    // it is being dragged put it back to the old speed before the drag ended, so the new speed
    // never took -- Ron: "I set the speed to 4 fps, but it felt faster." Same rule as the scrub.
    const rate = q<HTMLInputElement>(".sl-transport-rate");
    const dragging = rate && document.activeElement === rate;
    if (rate) { rate.disabled = !!b.playbackRealTime; if (!dragging) rate.value = String((b.playbackRateFps as number | undefined) ?? 4); }
    const fps = q(".sl-transport-fps"); if (fps && !dragging) { fps.textContent = b.playbackRealTime ? "as acquired" : `${(b.playbackRateFps as number | undefined) ?? 4} /s`; onlyGrow(fps); }
  };

  const build = () => {
    const browsers = sequenceBrowsers(live);
    const key = browsers.map((b) => b.id).join(",") + "|" + player.current;
    if (key === builtFor) { update(); return; }
    builtFor = key;
    if (!browsers.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const id = player.current;
    const { frames, sequence } = browserFrames(live, id);
    const schedule = realTimeSchedule(sequence as unknown as Parameters<typeof realTimeSchedule>[0]);
    const name = (sequence?.name as string | undefined) ?? id;
    const picker = browsers.length > 1
      ? `<select class="sl-transport-pick" title="Which sequence the transport drives">${browsers.map((b) => { const s = browserFrames(live, b.id).sequence; return `<option value="${b.id}"${b.id === id ? " selected" : ""}>${escapeHtml((s?.name as string | undefined) ?? b.id)}</option>`; }).join("")}</select>`
      : `<span class="sl-transport-name" title="${name}">${name}</span>`;
    const rtTitle = schedule
      ? (schedule.kind === "cardiac"
        // Say what the frames cover: five phases at 213-400 ms of a 698 ms beat leave the last one
        // on screen for the rest of it, which is the acquisition window, not a stall (critic, 2026-09-19).
        ? `Real time: one heartbeat per loop at ${schedule.bpm} bpm (${Math.round(schedule.period * 1000)} ms). The ${schedule.times.length} frames cover ${Math.round(Math.min(...schedule.times) * 1000)}–${Math.round(Math.max(...schedule.times) * 1000)} ms after the R-wave; the last is held for the rest of the beat.`
        : `Real time: a frame every ${(schedule.period / schedule.times.length).toFixed(1)} s, as acquired`)
      : "Real time is not available: the scanner did not say when these frames are";
    el.innerHTML = `
      ${picker}
      <button class="sl-tool sl-transport-first" title="First frame">⏮</button>
      <button class="sl-tool sl-transport-prev" title="Previous frame">◀</button>
      <button class="sl-tool sl-transport-play" title="Play through the frames, looping">▶</button>
      <button class="sl-tool sl-transport-next" title="Next frame">▶|</button>
      <button class="sl-tool sl-transport-last" title="Last frame">⏭</button>
      <input class="sl-transport-scrub" type="range" min="0" max="${Math.max(0, frames.length - 1)}" step="1" value="0" title="Which frame is shown; drag to scrub">
      <span class="sl-transport-label"></span>
      <span class="sl-transport-where"></span>
      <input class="sl-transport-rate" type="range" min="1" max="30" step="1" value="10" title="Frames per second when playing">
      <span class="sl-transport-fps"></span>
      <button class="sl-tool sl-transport-rt" title="${rtTitle}"${schedule ? "" : " disabled"}>real time</button>`;
    q<HTMLSelectElement>(".sl-transport-pick")?.addEventListener("change", (e) => { player.current = (e.target as HTMLSelectElement).value; });
    const cur = () => (live.nodes.get(player.current)?.selectedItemNumber as number | undefined) ?? 0;
    const n = () => browserFrames(live, player.current).frames.length;
    q(".sl-transport-first")!.addEventListener("click", () => player.step(0));
    q(".sl-transport-prev")!.addEventListener("click", () => player.step(cur() - 1));
    q(".sl-transport-next")!.addEventListener("click", () => player.step(cur() + 1));
    q(".sl-transport-last")!.addEventListener("click", () => player.step(n() - 1));
    // On pointerdown, not click: a click needs the press and the release to agree on an element
    // that is being updated ten times a second while the sequence plays. Ron: "I can't pause it
    // once the sequence is running."
    q(".sl-transport-play")!.addEventListener("pointerdown", (e) => { e.preventDefault(); player.toggle(); });
    const scrub = q<HTMLInputElement>(".sl-transport-scrub")!;
    scrub.addEventListener("input", () => { player.stop(); selectFrame(live, player.current, Number(scrub.value)); });
    const rate = q<HTMLInputElement>(".sl-transport-rate")!;
    // The speed takes effect as the slider moves, not only on release: the value is written on
    // every input and the player restarted on release.
    rate.addEventListener("input", () => {
      const f = q(".sl-transport-fps"); if (f) { f.textContent = `${rate.value} /s`; onlyGrow(f); }
      live.write({ op: "patch", id: player.current, path: "#/playbackRateFps", value: Math.max(1, Math.min(30, Number(rate.value) || 4)) });
    });
    rate.addEventListener("change", () => { player.restart(); rate.blur(); });
    q(".sl-transport-rt")!.addEventListener("click", () => {
      const b = live.nodes.get(player.current); if (!b) return;
      live.write({ op: "patch", id: b.id, path: "#/playbackRealTime", value: !b.playbackRealTime });
      player.restart();
      update();
    });
    update();
  };

  live.subscribe((c) => {
    if (c.type === "sequenceBrowser" || c.type === "sequence" || c.kind === "remove" || c.kind === "reset") build();
  });
  player.onChange(build);   // play/stop only updates; a change of the chosen sequence rebuilds (its id is in the key)
  build();
  return el;
}
