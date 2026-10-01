/**
 * The Sequences module: what is in time, and what is ABOUT it.
 *
 * Ron, 2026-09-12: "I would like to work on timeseries next." The first data is a gated coronary
 * CTA -- five cardiac phases in one series -- and a bolus-monitoring series of ten frames. The
 * reader splits them (dicom-series.ts), logic/sequences.ts puts them in the scene as one
 * `sequence` with a `sequenceBrowser`. DRIVING a sequence -- which frame, play, speed, real time
 * -- is the transport in the top bar (sequence-toolbar.ts, logic/playback.ts), there in every
 * module. This panel keeps the rest: the list of what is in time, the scanner's pictures of the
 * reconstruction, and the value at one point through the frames.
 */
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { ProbeReading } from "../moduleserver/live-views.ts";
import type { SequencePlayer } from "../../logic/playback.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { browserFrames, sequenceBrowsers, type SequenceDocument } from "../../logic/sequences.ts";

export interface SequencesPanelOptions { live: LiveScene; player: SequencePlayer; onStatus?: (s: string) => void }

/**
 * THE VALUE AT ONE POINT THROUGH THE FRAMES. The probe reads whatever is drawn under the pointer,
 * and when a sequence steps under a still pointer it reads again (live-views `reprobe`); this
 * keeps what it read, one value per frame, for the point it was on. Moving the pointer starts a
 * new curve -- unless pinned, which keeps the curve on screen while the pointer goes elsewhere.
 */
interface Curve { browserId: string; ras: [number, number, number]; values: (number | undefined)[]; pinned: boolean }

const rasKey = (r: [number, number, number]) => r.map((v) => Math.round(v * 2) / 2).join(",");

export function registerSequencesPanel(shell: AppShell, opts: SequencesPanelOptions): void {
  const { live, player } = opts;
  let root: HTMLElement | null = null;
  let curve: Curve | null = null;
  const chosenId = () => player.current;

  /** A probe reading: keep the current frame's value for the point, or start over for a new point. */
  const onProbe = (p: ProbeReading | null) => {
    const chosen = chosenId();
    if (!p || !chosen) return;
    const { frames, selected } = browserFrames(live, chosen);
    const frame = frames[selected]; if (!frame) return;
    const row = p.rows.find((r) => r.kind === "image" && r.id === frame.node);
    if (!row || typeof row.value !== "number") return;
    const ras = p.ras as [number, number, number];
    if (!curve || curve.browserId !== chosen || (!curve.pinned && rasKey(curve.ras) !== rasKey(ras))) {
      if (curve?.pinned) return;   // pinned: the curve stays as it is while the pointer is elsewhere
      curve = { browserId: chosen, ras, values: new Array(frames.length).fill(undefined), pinned: false };
    }
    if (curve.pinned && rasKey(curve.ras) !== rasKey(ras)) return;
    curve.values[selected] = row.value;
    drawCurve();
  };
  (globalThis as unknown as { __onProbe?: (fn: (p: ProbeReading | null) => void) => () => void }).__onProbe?.(onProbe);

  /** The curve section's body, redrawn on every new value rather than the whole panel. */
  function drawCurve() {
    const host = root?.querySelector(".sl-seq-curve") as HTMLElement | null;
    // Not on screen (the module column holds another panel): an SVG nobody sees is not drawn.
    // `root` outlives the panel's visit, so the check is on the element itself.
    if (!host || !host.isConnected) return;
    const chosen = chosenId();
    const { frames, selected, sequence } = browserFrames(live, chosen);
    const c = curve && curve.browserId === chosen ? curve : null;
    if (!c) {
      host.innerHTML = `<p class="sl-hint">Hold the pointer on a point in a slice view and play, or scrub: the value there is kept for every frame visited, and drawn here.</p>`;
      return;
    }
    const unit = (sequence?.indexUnit as string) ?? "";
    const xs = frames.map((f, i) => { const n = Number(f.index); return Number.isFinite(n) ? n : i; });
    const have = c.values.map((v, i) => [i, v] as const).filter((x): x is readonly [number, number] => typeof x[1] === "number");
    const W = 300, H = 120, x0 = 42, x1 = 292, y0 = 12, y1 = 92;
    const lo0 = have.length ? Math.min(...have.map((h) => h[1])) : 0, hi0 = have.length ? Math.max(...have.map((h) => h[1])) : 1;
    const pad = Math.max(1, (hi0 - lo0) * 0.15), lo = Math.floor(lo0 - pad), hi = Math.ceil(hi0 + pad);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const X = (i: number) => xmax === xmin ? (x0 + x1) / 2 : x0 + ((xs[i] - xmin) / (xmax - xmin)) * (x1 - x0);
    const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);
    const fmt = (v: number) => Number.isInteger(v) ? String(v) : v.toFixed(1);
    const ax = (r: number, pos: string, neg: string) => `${r >= 0 ? pos : neg} ${Math.abs(r).toFixed(1)}`;
    let svg = `<g class="sl-seq-axes"><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}"/><line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}"/></g>`;
    svg += `<g class="sl-seq-ticks"><text x="4" y="${y0 + 3}">${fmt(hi)}</text><text x="4" y="${y1 + 3}">${fmt(lo)}</text>`;
    svg += `<text x="${x0}" y="${y1 + 13}">${fmt(xmin)}${unit ? " " + unit : ""}</text><text x="${x1 - 40}" y="${y1 + 13}">${fmt(xmax)}${unit ? " " + unit : ""}</text></g>`;
    if (have.length > 1) svg += `<polyline class="sl-seq-line" points="${have.map((h) => `${X(h[0]).toFixed(1)},${Y(h[1]).toFixed(1)}`).join(" ")}"/>`;
    for (const h of have) svg += `<circle class="sl-seq-dot" cx="${X(h[0]).toFixed(1)}" cy="${Y(h[1]).toFixed(1)}" r="2.4"/>`;
    const v = c.values[selected];
    svg += `<line class="sl-seq-now-line" x1="${X(selected).toFixed(1)}" y1="${y0}" x2="${X(selected).toFixed(1)}" y2="${y1}"/>`;
    if (typeof v === "number") svg += `<text class="sl-seq-now-text" x="${Math.min(X(selected) + 4, x1 - 70).toFixed(1)}" y="${y0 + 10}">frame ${selected + 1} · ${fmt(v)}</text>`;
    host.innerHTML = `
      <div class="sl-row sl-seq-at"><label>at</label><span class="sl-seq-ras">${ax(c.ras[0], "R", "L")}  ${ax(c.ras[1], "A", "P")}  ${ax(c.ras[2], "S", "I")}</span>
        <button class="sl-tool sl-seq-pin${c.pinned ? " sl-seq-pin-on" : ""}" title="${c.pinned ? "Let the pointer choose the point again" : "Keep this curve while the pointer moves elsewhere"}">${c.pinned ? "Pinned" : "Pin"}</button></div>
      <svg class="sl-seq-plot" viewBox="0 0 ${W} ${H}">${svg}</svg>
      <p class="sl-hint">${have.length} of ${frames.length} frames read at this point. Moving the pointer starts a new curve${c.pinned ? " once unpinned" : ""}.</p>`;
    host.querySelector(".sl-seq-pin")?.addEventListener("click", () => { if (curve) { curve.pinned = !curve.pinned; drawCurve(); } });
  }

  /** One document large, in a window: the picture at its own size, or fitted when larger. */
  const showDocument = (d: SequenceDocument, i: number) => {
    const img = d.images[i]; if (!img) return;
    const win = openFloatingWindow({ title: `${d.name} · ${img.caption}`, size: { w: Math.min(img.width + 24, 1100), h: Math.min(img.height + 60, 800) } });
    const body = document.createElement("div");
    body.className = "sl-seq-docwin";
    body.innerHTML = `<img src="${img.dataUrl}" alt="${escapeHtml(d.name)} ${escapeHtml(img.caption)}">`;
    win.box.appendChild(body);
  };

  function render() {
    if (!root) return;
    const browsers = sequenceBrowsers(live);
    const chosen = chosenId();
    root.innerHTML = `<h2>Sequences</h2>`;
    if (!browsers.length) {
      root.innerHTML += `<p class="sl-hint">Nothing in time is loaded. A DICOM series that holds several volumes in time — a gated cardiac CT, a bolus-monitoring series, a cine — arrives here as a sequence when loaded from the database.</p>`;
      return;
    }
    const sec = shell.section(root, "In time", { open: true, band: "green", note: String(browsers.length) });
    const list = document.createElement("div");
    list.className = "sl-seq-list";
    for (const b of browsers) {
      const { frames, sequence } = browserFrames(live, b.id);
      const row = document.createElement("div");
      row.className = "sl-seq-row" + (b.id === chosen ? " sl-seq-row-on" : "");
      row.innerHTML = `<span class="sl-seq-name">${escapeHtml((sequence?.name as string) ?? b.id)}</span><span class="sl-hint">${frames.length} frame${frames.length === 1 ? "" : "s"}</span>`;
      row.addEventListener("click", () => { player.current = b.id; render(); });
      list.appendChild(row);
    }
    sec.appendChild(list);

    const { sequence } = browserFrames(live, chosen);
    const hint = document.createElement("p");
    hint.className = "sl-hint";
    hint.textContent = "Play, scrub and set the speed in the bar at the top of the window; it stays there in every module.";
    sec.appendChild(hint);

    // THE SCANNER'S PICTURES of this reconstruction, when it left any (load-panel puts them on the
    // sequence node). Absent, not empty, for a sequence without them.
    const docs = (sequence?.documents as SequenceDocument[] | undefined) ?? [];
    const nDocs = docs.reduce((n, d) => n + d.images.length, 0);
    if (nDocs) {
      const ds = shell.section(root, "Documents", { open: true, band: "3d", note: String(nDocs) });
      const strip = document.createElement("div");
      strip.className = "sl-seq-docs";
      for (const d of docs) for (const [i, img] of d.images.entries()) {
        const card = document.createElement("div");
        card.className = "sl-seq-doc";
        card.title = "Open large";
        card.innerHTML = `<img src="${img.dataUrl}" alt="${escapeHtml(d.name)} ${escapeHtml(img.caption)}"><div class="sl-seq-doc-cap">${escapeHtml(d.name)} · ${escapeHtml(img.caption)}</div>`;
        card.addEventListener("click", () => showDocument(d, i));
        strip.appendChild(card);
      }
      ds.appendChild(strip);
      const hint = document.createElement("p");
      hint.className = "sl-hint";
      hint.textContent = "Pictures the scanner stored with this reconstruction: the ECG during the scan, the beats it used marked. Click one to open it large.";
      ds.appendChild(hint);
    }

    // THE VALUE AT A POINT THROUGH THE FRAMES.
    const ov = shell.section(root, "Over time", { open: true, band: "orange", note: (sequence?.name as string) ?? "" });
    const curveHost = document.createElement("div");
    curveHost.className = "sl-seq-curve";
    ov.appendChild(curveHost);
    drawCurve();
  }

  shell.registerPanel({
    id: "sequences", title: "Sequences", groups: ["Data"], order: 4,
    tip: "Volumes in time — cardiac phases, a bolus, a cine: step through the frames or play them",
    mount(el) { root = el; render(); },
  });
  live.subscribe((c) => {
    if (c.type === "sequenceBrowser" || c.type === "sequence" || c.kind === "remove" || c.kind === "reset") {
      // A scrub op arrives here too: the curve's "now" line moves; the list only changes when a
      // sequence comes or goes.
      if (c.type === "sequenceBrowser" && c.kind === "upsert") { drawCurve(); return; }
      if (c.kind === "remove" || c.kind === "reset") { if (curve && !live.nodes.has(curve.browserId)) curve = null; }
      render();
    }
  });
  player.onChange(() => render());
}
