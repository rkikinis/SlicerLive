// THE THRESHOLD TOOL (Ron, 2026-10-30: "yes, lets start with the thershold tool"). Its answers to the mockup
// (Contents/docs/SEGMENT-EDITOR.md; mockups/segment-editor-threshold-2026-10-30.html):
//   - the face: the histogram with two lines and "Keep only the piece I click"; the size of the connections cut is under
//     Advanced ("bridge size under advanced?");
//   - the preview is drawn as it will be written; the slices follow a dragged line, the 3D view when the drag stops
//     ("when drag stops": drawing is held while a line moves, render/demos/accum-loop.ts holdDrawing);
//   - the histogram opens on the scan's useful range, the scroll wheel zooms around the pointer, a double-click goes back
//     ("Histo zoom: agreed");
//   - the yellow button names where it writes: "Put into <structure>".
// Named ranges for a CT (Bone, Soft tissue, Fat, Air) are the prototype's (skull-scissors-prototype-2026-10-30.html), NOT
// yet confirmed by Ron. The arithmetic is logic/threshold-tool.ts.
import type { SegTool, SegToolContext } from "./registry.ts";
import { aroundIsland, countOf, histogramOf, openingRoom, inRange, pieceAt, thresholdInto, type Histogram } from "../../../logic/threshold-tool.ts";
import { autoThreshold } from "../../../algorithms/kernels/auto-threshold.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../../zarr.ts";
import { invertRowMajor } from "../../../logic/transforms.ts";
import { applyRowMajor } from "../../mat4.ts";
import { holdDrawing } from "../accum-loop.ts";
import { escapeHtml } from "../html.ts";
import { workerUrl } from "../../build-id.ts";
import { runAction } from "../app-shell.ts";

export type Scan = { id: string; data: ArrayLike<number>; dims: [number, number, number]; hist: Histogram; inv: number[]; ml: number; ct: boolean };
/** The prototype's named ranges for a CT, in Hounsfield units (not yet confirmed by Ron). */
const CT_RANGES: [string, number, number][] = [["Bone", 250, Infinity], ["Soft tissue", -100, 200], ["Fat", -200, -50], ["Air", -Infinity, -400]];

/** The scans the tools have read, one copy each (Threshold and Paint share it). */
const scans = new Map<string, Scan>();
/** THE RANGE LAST SET IN THRESHOLD, per scan: Paint's default limit (Ron, 2026-10-31: "make threshold range default"). */
const lastRanges = new Map<string, [number, number]>();
export function thresholdRangeOf(scanId: string): [number, number] | null { return lastRanges.get(scanId) ?? null; }
/** LET GO OF THE SCANS NOT IN USE (critic 2026-10-31 evening, finding 7): since Paint reads the scan in the view painted in,
 *  every scan the brush passed over was read whole and kept for the session, after it left the scene too -- three at once
 *  in Side by side, hundreds of megabytes each for a body CT. The editor keeps the outlined scan and the ones the views
 *  show (seg-editor-panel.ts); the rest go. Returns how many went. */
export function keepScans(ids: ReadonlySet<string>): number {
  let n = 0;
  for (const id of [...scans.keys()]) if (!ids.has(id)) { scans.delete(id); n++; }
  return n;
}

/** A scan, read once: its values, histogram, grid and whether it is a CT. By default the one the segmentation was drawn
 *  on; `imageId`: another scan of the scene (Paint's limit reads the scan in the view painted in). */
export async function loadScan(ctx: SegToolContext, imageId?: string): Promise<Scan | null> {
  const own = ctx.source();
  const node = imageId ? ctx.live.nodes.get(imageId) as Record<string, unknown> | undefined : own?.node;
  const src = imageId ? (node ? { id: imageId, node } : null) : own;
  if (!src) return null;
  const have = scans.get(src.id); if (have) return have;
  const z = src.node.zarr as ZarrDesc | undefined; if (!z) return null;
  const vol = await fetchZarrVolumeNative(ctx.live.blobBase(), z);
  const m = src.node.ijkToRAS as number[];
  const det = Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]));
  const s: Scan = {
    id: src.id, data: vol.data as ArrayLike<number>, dims: src.node.dims as [number, number, number], hist: histogramOf(vol.data as ArrayLike<number>),
    inv: invertRowMajor(m), ml: det / 1000, ct: String((src.node.origin as { modality?: string } | undefined)?.modality ?? "").toUpperCase() === "CT",
  };
  scans.set(src.id, s);
  return s;
}

export function thresholdTool(): SegTool {
  /** The tool's remembered values, per scan: the range, the histogram's view, the named range chosen. */
  const kept = new Map<string, { lo: number; hi: number; view: [number, number]; named: string | null }>();
  let scan: Scan | null = null, lo = 0, hi = 0, view: [number, number] = [0, 1], named: string | null = null;
  let keep = true, cut = 2, seeds: number[] = [], loading = false;
  /** Pieces Option-clicked out of what is shown (Ron: "yes, option-click removes"). */
  let drops: number[] = [];
  /** ONLY AROUND THE STRUCTURE (Ron, 2026-10-30: raise the line, remove what came apart, "then lower the threshold, but
   *  only around the surviving island" -- an opening with the threshold): the range only as far as `aroundSteps` voxels
   *  from what the structure held before this preview, through voxels in range (logic/threshold-tool.ts aroundIsland). */
  let around = false, aroundSteps = 2;
  /** NOTHING SHOWN UNTIL SOMETHING IS CHANGED, when the structure already holds voxels: leaving the tool writes what it
   *  shows, so opening it and moving on must not replace the structure with the whole range. */
  let waiting4Touch = false;
  /** SOMETHING CHANGED BY THE PERSON since the preview began (critic 2026-10-31, finding 4: opening Threshold on an empty
   *  structure only to look, then choosing Paint, wrote the whole head above Otsu into it and gave Paint that range as its
   *  limit). The preview of an empty structure is still shown at once; leaving writes it only when the person changed
   *  something (a line, a range, a switch, a click); Put into always writes. */
  let touched = false;
  /** AFTER PUT INTO, ANOTHER STRUCTURE GETS NOTHING until something is changed (2026-10-31: bone put into Segment_1, then
   *  Segment_2 chosen at the top to paint, showed the bone again as Segment_2's preview -- over "anything", out of
   *  Segment_1 -- and choosing Paint wrote it: all the bone had moved to Segment_2). */
  let justPut = false;
  let shownVoxels = -1, base: Uint8Array | null = null;
  /** What the last Put into wrote, said in the tool's area until the next preview (Ron: "No feedback. How do I know it
   *  happened?"). */
  let written = "";
  let busy = false, again = false;
  /** Raised by Cancel, Put into, leaving and a new structure: a preview still being made for the old one stops. */
  let gen = 0;
  let el: HTMLElement | null = null, ctx0: SegToolContext | null = null;

  const fmt = (v: number) => !Number.isFinite(v) ? "" : scan?.hist.integer ? String(Math.round(v)) : v.toPrecision(4);
  const unit = () => (scan?.ct ? "HU" : "");

  const load = loadScan;

  /** The values a scan starts with: Bone on a CT; elsewhere the automatic (Otsu) value up to the top. */
  function startValues(s: Scan) {
    const k = kept.get(s.id);
    if (k) { ({ lo, hi, view, named } = { ...k, view: [...k.view] as [number, number] }); return; }
    view = [...s.hist.useful] as [number, number];
    if (s.ct) { named = "Bone"; lo = 250; hi = s.hist.max; }
    else { named = null; lo = autoThreshold("otsu", s.data as unknown as Float32Array); hi = s.hist.max; }
  }
  const remember = () => { if (scan) { kept.set(scan.id, { lo, hi, view: [...view] as [number, number], named }); lastRanges.set(scan.id, [lo, hi]); } };

  // ── THE ARITHMETIC IN A WORKER (seg-tools/threshold-worker.ts), so the page stays free while a line moves (Ron: "the
  //    HU slider is very unresponsive"). Without a worker (it failed to start) it runs here, as before. ──
  let worker: Worker | null = null, workerScan = "", workerBase: Uint8Array | null = null, seq = 0;
  const waiting = new Map<number, (r: { labels: Uint8Array; count: number } | null) => void>();
  function startWorker(): Worker | null {
    if (worker) return worker;
    try {
      worker = new Worker(workerUrl("./threshold-worker.js"), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ seq: number; labels?: Uint8Array; count?: number; error?: string }>) => {
        const f = waiting.get(e.data.seq); waiting.delete(e.data.seq);
        f?.(e.data.labels ? { labels: e.data.labels, count: e.data.count ?? 0 } : null);
      };
      worker.onerror = () => { for (const f of waiting.values()) f(null); waiting.clear(); worker?.terminate(); worker = null; workerScan = ""; workerBase = null; };
    } catch { worker = null; }
    return worker;
  }
  /** The labels for the current values, and how many voxels the result holds. */
  async function compute(ctx: SegToolContext): Promise<{ labels: Uint8Array; count: number } | null> {
    if (!scan || !base) return null;
    const st = ctx.structure(), ov = ctx.over();
    const w = startWorker();
    if (w) {
      if (workerScan !== scan.id) { w.postMessage({ type: "scan", data: scan.data, dims: scan.dims }); workerScan = scan.id; }
      if (workerBase !== base) { w.postMessage({ type: "base", base }); workerBase = base; }
      const n = ++seq;
      const r = await new Promise<{ labels: Uint8Array; count: number } | null>((res) => { waiting.set(n, res); w.postMessage({ type: "compute", seq: n, lo, hi, seeds, keep, cut, drops, around, aroundSteps, segment: st.labelValue, overwrite: ov.overwrite, visibleSegments: ov.visibleSegments, overSegment: ov.overSegment }); });
      if (r) return r;
    }
    let range = inRange(scan.data, lo, hi);
    if (around) { const island = new Uint8Array(base.length); for (let i = 0; i < base.length; i++) if (base[i] === st.labelValue) island[i] = 1; range = aroundIsland(openingRoom(range, island, scan.data), island, scan.dims, aroundSteps); }
    let result = range;
    if (keep && seeds.length) { result = new Uint8Array(range.length); for (const sd of seeds) { const p = pieceAt(range, scan.dims, sd, cut); if (p) for (let i = 0; i < p.length; i++) if (p[i]) result[i] = 1; } }
    for (const d of drops) if (result[d]) { const p = pieceAt(result, scan.dims, d, 0); if (p) { if (result === range) result = range.slice(); for (let i = 0; i < p.length; i++) if (p[i]) result[i] = 0; } }
    return { labels: thresholdInto(base, result, { segment: st.labelValue, overwrite: ov.overwrite, visibleSegments: ov.visibleSegments, overSegment: ov.overSegment }), count: countOf(result) };
  }

  /** Compute what would be written and show it; one at a time, the newest values winning. */
  async function refresh(ctx: SegToolContext, auto = false) {
    waiting4Touch = false; justPut = false;               // a change by the person: from now on the preview follows
    if (!auto) { touched = true; if (scan) lastRanges.set(scan.id, [lo, hi]); }   // what the person set is what Paint takes
    if (busy) { again = true; return; }
    busy = true;
    const my = gen;
    try {
      do {
        again = false;
        if (!scan || !ctx.segId() || my !== gen) return;
        base ??= await ctx.edits.begin();
        if (!base || my !== gen) return;
        const r = await compute(ctx);
        if (!r || my !== gen) return;
        shownVoxels = r.count; written = "";
        await ctx.edits.show(r.labels);
        say();
      } while (again && my === gen);
    } finally {
      busy = false;
      // A request that arrived for a newer generation while this one ran (a new structure, say) is made now.
      if (again && my !== gen) { again = false; void refresh(ctx); }
    }
  }
  function say() {
    const n = el?.querySelector<HTMLElement>(".sl-th-count"); if (!n || !scan) return;
    if (written && !ctx0?.edits.open()) { n.textContent = written; return; }
    if (waiting4Touch) { n.textContent = `${ctx0?.structure().name ?? "The structure"} is as it was: move a line, choose a range or tick a switch to change it`; return; }
    n.textContent = shownVoxels < 0 ? "" : `${(shownVoxels * scan.ml).toLocaleString(undefined, { maximumFractionDigits: shownVoxels * scan.ml < 10 ? 1 : 0 })} ml · ${shownVoxels.toLocaleString()} voxels${keep && seeds.length ? ` · ${seeds.length === 1 ? "the piece" : `${seeds.length} pieces`} clicked` : ""}`;
  }

  // ── the histogram: one canvas, two lines ──
  function drawHistogram() {
    const box = el?.querySelector<HTMLElement>(".sl-th-hist"); const cv = box?.querySelector("canvas");
    if (!box || !cv || !scan) return;
    const w = box.clientWidth || 300, h = 84, dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const H = scan.hist, x = (v: number) => (v - view[0]) / (view[1] - view[0]) * w;
    // one column per pixel: the bins it covers, summed; heights on a log scale (the background would flatten the rest)
    const cols = new Float64Array(w);
    const b0 = Math.max(0, Math.floor((view[0] - H.lo) / H.width)), b1 = Math.min(H.counts.length - 1, Math.ceil((view[1] - H.lo) / H.width));
    for (let b = b0; b <= b1; b++) { const c = Math.floor(x(H.lo + (b + 0.5) * H.width)); if (c >= 0 && c < w) cols[c] += H.counts[b]; }
    let m = 0; for (const c of cols) m = Math.max(m, Math.log1p(c));
    const style = getComputedStyle(box), on = style.getPropertyValue("--sl-accent").trim() || "#f8d764", off = style.getPropertyValue("--sl-fg-dim").trim() || "#777";
    g.fillStyle = "rgba(248,215,100,.10)"; g.fillRect(Math.max(0, x(lo)), 0, Math.min(w, x(hi)) - Math.max(0, x(lo)), h);
    for (let c = 0; c < w; c++) {
      if (!cols[c]) continue;
      const v = view[0] + (c + 0.5) / w * (view[1] - view[0]), bh = Math.max(1, Math.log1p(cols[c]) / (m || 1) * (h - 14));
      g.fillStyle = v >= lo && v <= hi ? on : off; g.fillRect(c, h - bh, 1, bh);
    }
    g.fillStyle = off; g.font = "10px system-ui, sans-serif";
    g.fillText(fmt(view[0]), 2, 10); const t = `${fmt(view[1])} ${unit()}`.trim(); g.fillText(t, w - g.measureText(t).width - 2, 10);
    for (const [cls, v] of [[".sl-th-lo", lo], [".sl-th-hi", hi]] as [string, number][]) {
      const hEl = box.querySelector<HTMLElement>(cls)!, px = x(v), out = !(px >= 0 && px <= w);
      hEl.style.left = `${Math.max(0, Math.min(w, Number.isFinite(px) ? px : px > 0 ? w : 0))}px`;
      hEl.classList.toggle("sl-th-out", out);
      hEl.querySelector("span")!.textContent = `${out && px > w ? "▸ " : out ? "◂ " : ""}${fmt(v)}`;
    }
  }
  const valueAt = (clientX: number) => {
    const r = el!.querySelector<HTMLElement>(".sl-th-hist")!.getBoundingClientRect();
    return view[0] + (clientX - r.left) / r.width * (view[1] - view[0]);
  };

  function wire(ctx: SegToolContext) {
    const box = el!.querySelector<HTMLElement>(".sl-th-hist")!;
    const setLine = (cls: string, v: number) => {
      if (scan?.hist.integer) v = Math.round(v);
      if (cls === ".sl-th-lo") lo = Math.min(v, hi); else hi = Math.max(v, lo);
      named = null; markNamed(); remember(); drawHistogram(); void refresh(ctx);
    };
    for (const cls of [".sl-th-lo", ".sl-th-hi"]) {
      const hEl = box.querySelector<HTMLElement>(cls)!;
      // PRECISE: a line clicked or dragged keeps the focus; the arrow keys move it by one gray value, ten with Shift.
      hEl.addEventListener("keydown", (e) => {
        if (!scan || !["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const step = (scan.hist.integer ? 1 : scan.hist.width) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 1);
        setLine(cls, (cls === ".sl-th-lo" ? lo : hi) + step);
      });
      // A click on the number under the line: type the value.
      const num = hEl.querySelector("span")!;
      num.addEventListener("pointerdown", (e) => e.stopPropagation());
      num.addEventListener("click", (e) => {
        e.stopPropagation();
        const inp = document.createElement("input");
        inp.type = "number"; inp.value = fmt(cls === ".sl-th-lo" ? lo : hi); inp.style.width = "70px";
        num.replaceChildren(inp); inp.focus(); inp.select();
        let done = false;
        const finish = (keepIt: boolean) => { if (done) return; done = true; const v = Number(inp.value); if (keepIt && inp.value !== "" && Number.isFinite(v)) setLine(cls, v); else drawHistogram(); };
        inp.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") finish(true); else if (k.key === "Escape") finish(false); });
        inp.addEventListener("blur", () => finish(true));
      });
      hEl.addEventListener("pointerdown", (e) => {
        e.preventDefault(); hEl.focus(); hEl.setPointerCapture(e.pointerId);
        named = null; markNamed();
        // THE 3D VIEW WAITS FOR THE DRAG TO STOP (Ron); the slices follow the line.
        const release = holdDrawing("Threshold: a line is moving");
        const move = (ev: PointerEvent) => {
          let v = valueAt(ev.clientX); if (scan?.hist.integer) v = Math.round(v);
          if (cls === ".sl-th-lo") lo = Math.min(v, hi); else hi = Math.max(v, lo);
          drawHistogram(); void refresh(ctx);
        };
        const up = () => { hEl.removeEventListener("pointermove", move); hEl.removeEventListener("pointerup", up); hEl.removeEventListener("pointercancel", up); release(); remember(); void refresh(ctx); };
        hEl.addEventListener("pointermove", move); hEl.addEventListener("pointerup", up); hEl.addEventListener("pointercancel", up);
      });
    }
    box.addEventListener("wheel", (e) => {
      e.preventDefault(); if (!scan) return;
      const c = valueAt(e.clientX), f = Math.exp(e.deltaY * 0.002);
      const a = c - (c - view[0]) * f, b = c + (view[1] - c) * f;
      if (b - a < scan.hist.width * 4) return;
      view = [Math.max(scan.hist.min, a), Math.min(scan.hist.max, b)]; remember(); drawHistogram();
    }, { passive: false });
    box.addEventListener("dblclick", () => { if (scan) { view = [...scan.hist.useful] as [number, number]; remember(); drawHistogram(); } });
    el!.querySelectorAll<HTMLButtonElement>("[data-named]").forEach((b) => b.addEventListener("click", () => {
      const r = CT_RANGES.find((x) => x[0] === b.dataset.named); if (!r || !scan) return;
      named = r[0]; lo = Math.max(r[1], scan.hist.min); hi = Math.min(r[2], scan.hist.max); remember(); markNamed(); drawHistogram(); void refresh(ctx);
    }));
    const keepBox = el!.querySelector<HTMLInputElement>(".sl-th-keep")!;
    keepBox.addEventListener("change", () => { keep = keepBox.checked; seeds = []; drops = []; ctx.rerender(); void refresh(ctx); });
    const aroundBox = el!.querySelector<HTMLInputElement>(".sl-th-around")!;
    aroundBox.addEventListener("change", () => { around = aroundBox.checked; void refresh(ctx); });
    const stepsSel = el!.querySelector<HTMLSelectElement>(".sl-th-steps")!;
    stepsSel.addEventListener("change", () => { aroundSteps = Number(stepsSel.value); if (around) void refresh(ctx); });
    const cutSel = el!.querySelector<HTMLSelectElement>(".sl-th-cut")!;
    cutSel.addEventListener("change", () => { cut = Number(cutSel.value); void refresh(ctx); });
    const exact = (cls: string, set: (v: number) => void) => el!.querySelector<HTMLInputElement>(cls)!.addEventListener("change", (e) => {
      const v = Number((e.target as HTMLInputElement).value); if (!Number.isFinite(v)) return;
      set(v); named = null; markNamed(); remember(); drawHistogram(); void refresh(ctx);
    });
    exact(".sl-th-lo-n", (v) => { lo = Math.min(v, hi); });
    exact(".sl-th-hi-n", (v) => { hi = Math.max(v, lo); });
    el!.querySelector<HTMLButtonElement>(".sl-th-auto")!.addEventListener("click", () => {
      if (!scan) return;
      lo = autoThreshold("otsu", scan.data as unknown as Float32Array); hi = scan.hist.max; named = null; markNamed(); remember(); drawHistogram(); void refresh(ctx);
    });
    el!.querySelector<HTMLButtonElement>(".sl-th-cancel")!.addEventListener("click", () => cancel(ctx));
    // THE BUTTON ANSWERS THE CLICK (MODULE-DESIGN-RULES: every button answers): "Writing…", then "Written ✓".
    const putB = el!.querySelector<HTMLButtonElement>(".sl-th-put")!;
    putB.addEventListener("click", () => void runAction(putB, () => put(ctx), { busyLabel: "Writing…", doneLabel: "Written ✓", failedLabel: "Not written" }).catch(() => {}));
  }
  function markNamed() { el?.querySelectorAll<HTMLButtonElement>("[data-named]").forEach((b) => b.classList.toggle("sl-chosen", b.dataset.named === named)); }

  /** On opening, or on another structure: an empty structure gets the preview at once; one that holds voxels waits for a
   *  change (waiting4Touch). */
  async function startOrWait(ctx: SegToolContext) {
    const b = await ctx.edits.begin();
    const seg = ctx.structure().labelValue;
    let holds = false; if (b) for (let i = 0; i < b.length; i++) if (b[i] === seg) { holds = true; break; }
    if (holds) { ctx.edits.cancel(); base = null; waiting4Touch = true; shownVoxels = -1; written = ""; ctx.rerender(); return; }
    ctx.rerender();
    touched = false;
    await refresh(ctx, true);
  }

  async function put(ctx: SegToolContext) {
    if (!ctx.edits.open() || !scan) { ctx.status("Nothing to put in: move a line first"); return; }
    while (busy) await new Promise((r) => setTimeout(r, 20));    // the newest values are shown before they are written
    if (!ctx.edits.open() || !base) return;
    const st = ctx.structure();
    const r = await compute(ctx);
    if (!r || !ctx.edits.open()) return;
    const n = r.count;
    gen++;
    await ctx.edits.commit(r.labels);
    base = null; seeds = []; drops = []; justPut = true;
    written = `Written into ${st.name}: ${(n * scan.ml).toFixed(n * scan.ml < 10 ? 1 : 0)} ml, ${n.toLocaleString()} voxels (${fmt(lo)} to ${fmt(hi)} ${unit()}). Undo takes it back.`.replace(" )", ")");
    ctx.status(written);
    ctx.rerender();
  }
  function cancel(ctx: SegToolContext) {
    gen++; ctx.edits.cancel(); base = null; seeds = []; drops = []; shownVoxels = -1;
    ctx.status("Threshold: nothing written");
    ctx.rerender();
  }

  return {
    id: "threshold", label: "Threshold", icon: "▤", order: 40, shortcut: "t",
    tip: "Everything between two gray values (T). The preview is drawn as it will be written; Put into writes it.",
    async chosen(ctx) {
      if (!ctx.segId()) { ctx.status("Choose which segmentation to edit first — at the top of the Segment Editor"); return; }
      loading = true; ctx.rerender();
      try { scan = await load(ctx); } finally { loading = false; }
      if (!scan) { ctx.status("Threshold needs the scan the segmentation was drawn on"); ctx.rerender(); return; }
      startValues(scan); seeds = []; drops = []; justPut = false;
      ctx.takeClicks(true);   // always: a click keeps, Option-click removes (keep off: a plain click does nothing)
      await startOrWait(ctx);
    },
    mount(host, ctx) {
      el = host; ctx0 = ctx;
      if (loading) { host.innerHTML = `<p class="sl-hint">Reading the scan's gray values…</p>`; return; }
      if (!scan) { host.innerHTML = `<p class="sl-hint">${ctx.segId() ? "Threshold needs the scan the segmentation was drawn on." : "Choose a segmentation at the top first."}</p>`; return; }
      const st = ctx.structure();
      const vox = Math.cbrt(scan.ml * 1000);
      host.innerHTML = `
        ${scan.ct ? `<div class="sl-row sl-th-named">${CT_RANGES.map(([n, a, b]) => `<button data-named="${n}" title="${n}: ${Number.isFinite(a) && Number.isFinite(b) ? `${a} to ${b} HU` : Number.isFinite(a) ? `${a} HU and up` : `below ${b} HU`}"${named === n ? ' class="sl-chosen"' : ""}>${n}</button>`).join("")}</div>` : ""}
        <div class="sl-th-hist" title="The scan's gray values. Drag a line; the scroll wheel zooms; a double-click shows the useful range again." style="position:relative;height:84px;margin:4px 2px 22px;touch-action:none">
          <canvas style="display:block"></canvas>
          <div class="sl-th-lo sl-th-handle" tabindex="0" title="Drag, or the arrow keys (Shift: ten at a time); click the number to type it"><span></span></div><div class="sl-th-hi sl-th-handle" tabindex="0" title="Drag, or the arrow keys (Shift: ten at a time); click the number to type it"><span></span></div>
        </div>
        <div class="sl-row"><label title="A click in any view keeps only the connected piece under it; Shift-click keeps one more; Option-click removes the piece under it"><input type="checkbox" class="sl-th-keep"${keep ? " checked" : ""}> Keep only the piece I click</label></div>
        <div class="sl-row"><label title="The lines act only next to what ${escapeHtml(st.name)} already holds, and only on voxels darker than any it holds (as far as set under Advanced): lower the line to bring back the thin parts a raised line took, not what was cut away"><input type="checkbox" class="sl-th-around"${around ? " checked" : ""}> Only around ${escapeHtml(st.name)}</label></div>
        <div class="sl-row"><span class="sl-hint sl-th-count"></span></div>
        <details class="sl-advanced"><summary>Advanced</summary>
          <div class="sl-row"><label>Exact values</label><input class="sl-th-lo-n" type="number" value="${fmt(lo)}" style="width:76px"> to <input class="sl-th-hi-n" type="number" value="${fmt(hi)}" style="width:76px"> ${unit()}</div>
          <div class="sl-row"><label>Automatic</label><button class="sl-th-auto" title="The value that best separates the scan's gray values in two (Otsu's method), up to the top">Otsu</button></div>
          <div class="sl-row"><label title="With Only around: how far from what the structure holds the lines may reach">Only around: up to</label><select class="sl-th-steps">${[1, 2, 3, 5, 8].map((c) => `<option value="${c}"${c === aroundSteps ? " selected" : ""}>${c} voxel${c === 1 ? "" : "s"} (≈ ${(c * vox).toFixed(1)} mm)</option>`).join("")}</select></div>
          <div class="sl-row"><label title="Before a click keeps its piece, connections this thin are cut, so a structure does not run into what touches it">Cut connections up to</label><select class="sl-th-cut">${[0, 2, 4, 6].map((c) => `<option value="${c}"${c === cut ? " selected" : ""}>${c ? `${c} voxels thick (≈ ${(c * vox).toFixed(1)} mm)` : "nothing cut"}</option>`).join("")}</select></div>
        </details>
        <div class="sl-row sl-actions"><button class="sl-th-cancel" title="Put the segmentation back as it was (Esc)">Cancel</button><button class="sl-th-put sl-primary" title="Replaces ${escapeHtml(st.name)}'s contents with what is shown (Enter)">Put into ${escapeHtml(st.name)}</button></div>`;
      wire(ctx);
      requestAnimationFrame(() => { drawHistogram(); say(); });
    },
    async left(ctx, keepIt) {
      // LEAVING WRITES WHAT IS SHOWN (Ron, 2026-10-30, after a threshold and a click, then Scissors: "the entire
      // segmentation disappearing"). One Undo step, as Put into; only Cancel, Esc, or Undo while it shows drop it.
      if (keepIt && ctx.edits.open() && base && !waiting4Touch && touched) await put(ctx);
      gen++; if (ctx.edits.open()) ctx.edits.cancel(); base = null; seeds = []; drops = []; shownVoxels = -1; ctx.takeClicks(false);
    },
    retarget(ctx) {
      gen++; if (ctx.edits.open()) ctx.edits.cancel(); base = null; seeds = []; drops = [];
      if (justPut) { waiting4Touch = true; written = ""; ctx.rerender(); return; }
      void startOrWait(ctx);
    },
    pick(ras, sign, ctx, remove) {
      if (!scan || (!keep && !remove)) return;
      const [nx, ny, nz] = scan.dims, p = applyRowMajor(scan.inv, ras);
      const i = Math.round(p[0]), j = Math.round(p[1]), k = Math.round(p[2]);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) { ctx.status("That point is outside the scan"); return; }
      const idx = (k * ny + j) * nx + i, v = scan.data[idx];
      if (!(v >= lo && v <= hi)) { ctx.status(`That point is not in the range (${fmt(v)} ${unit()})`.replace(" )", ")")); return; }
      if (remove) { drops = [...drops, idx]; void refresh(ctx); return; }   // Option-click: that piece out of what is shown
      seeds = sign < 0 ? [...seeds, idx] : [idx];
      void refresh(ctx);
    },
    cheats(ctx) {
      const n = ctx.structure().name, step = scan?.hist.integer === false ? "one bin" : `1${unit() ? " " + unit() : ""}`;
      return [
        { keys: "Drag a line", does: "moves the range", tip: "Drag either line on the histogram: the voxels between the two lines are shown on the slices at once, and in 3D when you let go." },
        { keys: "← →", does: `move the chosen line ${step} (Shift: 10)`, tip: "After clicking a line, the arrow keys move it one step at a time; with Shift, ten steps." },
        { keys: "Click a number", does: "type a value", tip: "Click the number under a line and type the value you want; Enter sets it." },
        { keys: "Wheel on histogram", does: "zooms it", tip: "Turn the scroll wheel over the histogram to look closer around the mouse. A double-click on it shows the whole useful range again." },
        ...(keep ? [
          { keys: "Click in a view", does: "keeps the piece under it", tip: "With “Keep only the piece I click” on: a click on a slice or in 3D keeps the connected piece under it; the rest of the range is left out." },
          { keys: "Shift-click", does: "keeps one more piece", tip: "Hold Shift and click another piece to keep it too." },
        ] : []),
        { keys: "Option-click", does: "removes the piece under it", tip: "Hold the Option key and click a piece: it is taken out of what is shown." },
        { keys: "Enter", does: `puts it into ${n}`, tip: `Writes what is shown into ${n}, as one change that Undo can take back.` },
        { keys: "Esc", does: "cancels", tip: "Puts the segmentation back as it was before Threshold showed anything." },
      ];
    },
    onKey(e, ctx) {
      if (e.key === "Enter") { void put(ctx); return true; }
      if (e.key === "Escape") { cancel(ctx); return true; }
      return false;
    },
  };
}
