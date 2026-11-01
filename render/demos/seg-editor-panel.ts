// "Segment Editor" panel: change a segmentation by hand -- ANY segmentation in the scene, not only one it made.
//
// Ron, 2026-09-25 (Contents/docs/mockups/segment-editor-existing-2026-09-25.html, "build it"): until today the editor
// edited only a segmentation it created itself, on the first volume loaded, so an AI result, a segmentation loaded
// from the database or a merged one could not be corrected by hand. Now:
//   * a picker at the top lists ALL segmentations in the scene (grouped by volume, saying where each came from), plus
//     a new one per volume; "lets start with only one way in: segmentations" -- the Edit button on each segmentation's
//     row in the Segmentations module opens this editor on that segmentation (__editSegmentation);
//   * the structures grouped by system, searchable; the brush size in VOXELS first, mm as the translation (Ron,
//     2026-09-24: "work in voxels, not mm");
//   * Undo / Redo: an edit replaces the segmentation's list of stored pieces (#/zarr); the pieces are content-addressed
//     and stay in the store, so going back is putting the previous list back;
//   * SAVE NEVER OVERWRITES THE ORIGINAL: the first save writes a new series "…, edited <date time>" ("dated, the user
//     can always rename"); later saves update that edited copy (Ron: "update as default, a way to change to new
//     series"). The Save button is the yellow one while edits wait; "edited, not saved" is plain text (no orange).
//   * the save diagram is in this module's Help ("having the graph of the save in the help would be good").
// The effects themselves are unchanged (logic/segment-tools.ts).
//
// THE SHAPE SINCE 2026-10-30 (Ron's answers to mockups/segment-editor-threshold-2026-10-30.html, "1: yes"): the
// segmentation and the "Paint [structure] over [what]" line on top; one row of tools (render/demos/seg-tools/registry.ts:
// each brings its button, controls and help; the Threshold tool is the first written as one, seg-tools/threshold.ts);
// only the chosen tool's controls under the row; the structure list folded below. A tool that shows a preview
// (Threshold) writes it into the segmentation through the EditSession here: not an undo step, not marked edited, put
// back by Cancel, one undo step when written.
import { escapeHtml } from "./html.ts";
import { eyeSvg } from "./eye-icon.ts";
import { layout as layoutOf } from "../../logic/layouts.ts";
import { allStructures, CLINICAL_REGIONS, type ClinicalRegion, bodyPartOfScan, regionFromBodyPart, regionFromStructures, type Task, TASK_WORDS, taskStructures, type TaskStructure, TUMOR } from "../../logic/anatomy/task-sets.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";
import { invalidatePaintCache } from "../../logic/segmentation-editor.ts";
import { setPaintLimits, showLabelmap, strokeTallyOf, writeLabelmap } from "../../logic/segment-tools.ts";
import { segToSourceOf } from "../../logic/paint-brush.ts";
import type { OverwriteMode } from "../../logic/segment-effects.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { type CheatLine, registerSegTool, segTools, type EditSession, type SegTool, type SegToolContext, type ToolStroke } from "./seg-tools/registry.ts";
import { keepScans, loadScan, type Scan, thresholdRangeOf, thresholdTool } from "./seg-tools/threshold.ts";
import { scissorsTool } from "./seg-tools/scissors.ts";
import { nodeVoxel, sceneVoxel, voxelOrUnit } from "../scene-scale.ts";
import { lengthText } from "../length-text.ts";
import { defaultTarget } from "../../logic/click-outline.ts";

interface Hooks {
  __createSegmentation: (sourceImageId: string, name?: string) => Promise<{ segId: string; segment: number }>;
  __addSegment: (segId: string) => number;
  /** A short note beside the brush, fading (live-views brushNote). */
  __brushNote?: (text: string) => void;
  __applyEffect: (segId: string, effect: string, params: Record<string, unknown>) => Promise<{ voxels: number; threshold?: number; ms?: number }>;
  __setSegmentProp: (segId: string, labelValue: number, prop: string, value: unknown) => void;
  __volumeList: () => { imageId: string; name: string }[];
  __segmentStats: (segId: string) => Promise<{ labelValue: number; voxels: number; volumeMm3: number }[]>;
  __setSegTool: (segId: string, tool: string, params: { diameterMm?: number; sphere?: boolean; segment?: number }) => void;
  __segTool: () => { activeEffect: string; diameterMm: number; sphere: boolean };
  __saveEditedSegmentation: (segId: string, o?: { asNew?: boolean }) => Promise<{ ok: boolean; name?: string; error?: string; kept?: string }>;
  __editSegmentation?: (segId: string) => void;
  __clickOutlineLicense: () => Promise<boolean>;
  __clickOutlineStart: (segId: string, target: number, made?: boolean) => Promise<boolean>;
  __clickOutlineEnd: () => void;
  __openDatabaseId?: () => Promise<string | null>;
  __databaseSeries?: () => Promise<{ series: { seriesInstanceUID: string; bodyPart?: string; studyInstanceUID?: string; studyDescription?: string; patientID?: string; studyDate?: string; seriesDate?: string; description?: string; modality?: string }[] } | null>;
  /** What kind of scan each series is (load-panel, logic/scan-kind.ts). */
  __seriesKinds?: (uids: string[]) => Promise<Record<string, { kind: string; how: string }>>;
  __loadDatabaseSeries?: (uids: string[], onProgress?: (line: string) => void, o?: { afterLoad?: boolean }) => Promise<{ loaded: number; failures: string[] }>;
  /** Three scans side by side in the three slice views (live-views sideBySide); null puts back what they showed. */
  __sideBySide?: (images: string[] | null, orientation?: "axial" | "sagittal" | "coronal") => boolean;
  __isSideBySide?: () => boolean;
  __setLayout?: (id: number) => void;
  __layoutId?: number;
}
const g = () => globalThis as unknown as Hooks;
type Seg = { labelValue: number; name?: string; structure?: string; color?: number[]; visible?: boolean };
type Obj = Record<string, unknown>;

/** Where a segmentation came from, in words, for the picker. */
function originWords(n: Obj): string {
  const o = (n.origin ?? {}) as Obj;
  if (n.edited === true) return "edited, not saved";
  if (o.merged) return o.savedSeriesInstanceUID ? "merged, saved" : "merged, not saved";
  if (o.editedCopy) return "edited copy, saved";
  if (o.seriesInstanceUID || o.savedSeriesInstanceUID) return "from the database";
  if (o.task) return "AI result, not saved";
  return "new, not saved";
}

export function registerSegEditorPanel(shell: AppShell, opts: { live: LiveScene; store: LocalBlobStore; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  let segId = "", active = 1, filter = "";
  let brushVox = 14;
  /** Click to outline's structure, per segmentation: a label value, "tumor" (a Tumor structure to be made) or "new". */
  const clickInto = new Map<string, number | "tumor" | "new" | "newseg">();
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  const node = () => (segId ? live.nodes.get(segId) : undefined) as Obj | undefined;
  const segsOf = (id: string) => ((live.nodes.get(id)?.segments as Seg[] | undefined) ?? []);
  const sourceOf = (id: string) => live.nodes.get((((live.nodes.get(id)?.refs as Record<string, string[]> | undefined)?.source) ?? [])[0] ?? "") as Obj | undefined;

  // ── undo / redo: the segmentation's list of stored pieces before each edit ──
  const lastZarr = new Map<string, string>();
  /** Segmentations a tool is showing a preview in: their writes are no undo step and do not redraw this panel. */
  const quiet = new Set<string>();
  const undo = new Map<string, string[]>(), redo = new Map<string, string[]>();
  let restoring = false, burstFrom = "", burstTimer: number | undefined;
  live.subscribe((c) => {
    const id = (c as { id?: string }).id;
    if (!id || (c as { type?: string }).type !== "segmentation") return;
    const n = live.nodes.get(id); if (!n?.zarr) { lastZarr.delete(id); return; }
    const now = JSON.stringify(n.zarr), before = lastZarr.get(id);
    lastZarr.set(id, now);
    if (before === undefined || before === now || restoring || quiet.has(id)) return;
    // One stroke writes several times (the paint is throttled): the step is the state before the first write of a burst.
    if (burstFrom !== id + "|") {
      const u = undo.get(id) ?? []; u.push(before); if (u.length > 40) u.shift(); undo.set(id, u); redo.set(id, []);
      burstFrom = id + "|";
    }
    clearTimeout(burstTimer); burstTimer = setTimeout(() => { burstFrom = ""; render(); }, 700) as unknown as number;
  });
  const step = (from: Map<string, string[]>, to: Map<string, string[]>) => {
    if (sess) { void leaveTool(false).then(() => render()); return; }     // a preview open: Undo drops it, as Cancel does
    const n = node(); if (!n) return;
    const list = from.get(segId) ?? []; const prev = list.pop(); if (!prev) return;
    (to.get(segId) ?? to.set(segId, []).get(segId)!).push(JSON.stringify(n.zarr));
    restoring = true;
    // The brush keeps its own copy of the labels while painting (logic/segment-tools.ts paintCache): drop it, or
    // the next stroke paints onto the undone state and brings it back.
    invalidatePaintCache(segId);
    try { live.write({ op: "patch", id: segId, path: "#/zarr", value: JSON.parse(prev) }); live.write({ op: "patch", id: segId, path: "#/edited", value: true }); }
    finally { restoring = false; lastZarr.set(segId, prev); }
    render();
  };

  // ── a tool's preview, shown before it is written (the Threshold tool) ──
  let sess: { segId: string; zarr: string; base: Uint8Array | null; shown: string[][] } | null = null;
  const hashesOf = (z: unknown, into: Set<string>) => { const h = (z as { chunkHashes?: Record<string, string> } | undefined)?.chunkHashes; if (h) for (const v of Object.values(h)) into.add(v); };
  /** Give back the pieces of previews no longer shown -- uncompressed, 30 MB a time on a large CT -- unless anything still
   *  names them (a node, an undo step, the state Cancel puts back). Two most recent kept: a display may still be reading. */
  const giveBack = (lists: string[][]) => {
    const all = lists.flat(); if (!all.length) return;
    const keep = new Set<string>();
    for (const n of live.nodes.values()) hashesOf(n.zarr, keep);
    for (const m of [undo, redo]) for (const list of m.values()) for (const z of list) hashesOf(JSON.parse(z), keep);
    if (sess) hashesOf(JSON.parse(sess.zarr), keep);
    opts.store.release(all.filter((h) => !keep.has(h)));
  };
  const edits: EditSession = {
    async begin() {
      const n = node(); if (!n?.zarr) return null;
      if (sess && sess.segId === segId) return sess.base;
      if (sess) edits.cancel();
      const s = { segId, zarr: JSON.stringify(n.zarr), base: null as Uint8Array | null, shown: [] as string[][] };
      sess = s; quiet.add(segId);
      // Save waits while a preview is shown. Only the Save row changes: a redraw now would end a drag in progress.
      root?.querySelectorAll<HTMLButtonElement>(".sl-se-save, .sl-se-saveas").forEach((b) => { b.disabled = true; b.classList.remove("sl-primary"); });
      const words = root?.querySelector<HTMLElement>(".sl-se-save")?.closest(".sl-section-body")?.querySelector<HTMLElement>(".sl-hint");
      if (words) words.textContent = "A tool's preview is shown: Put it in, or Cancel, before saving.";
      const lab = await fetchZarrVolumeNative(live.blobBase(), n.zarr as ZarrDesc);
      s.base = Uint8Array.from(lab.data as ArrayLike<number>);
      return sess === s ? s.base : null;
    },
    async show(labels) {
      const s = sess; if (!s) return;
      const h = await showLabelmap(live, opts.store, s.segId, labels, () => sess === s);
      if (!h) return;
      s.shown.push(h);
      if (s.shown.length > 3) giveBack(s.shown.splice(0, s.shown.length - 3));
    },
    async commit(labels) {
      const s = sess; if (!s) return;
      sess = null;
      try { await writeLabelmap(live, opts.store, s.segId, labels); }
      finally { quiet.delete(s.segId); }
      const u = undo.get(s.segId) ?? []; u.push(s.zarr); if (u.length > 40) u.shift(); undo.set(s.segId, u); redo.set(s.segId, []);
      lastZarr.set(s.segId, JSON.stringify(live.nodes.get(s.segId)?.zarr));
      setTimeout(() => giveBack(s.shown), 3000);
      render();
    },
    cancel() {
      const s = sess; if (!s) return;
      sess = null;
      try { if (live.nodes.has(s.segId)) { live.write({ op: "patch", id: s.segId, path: "#/zarr", value: JSON.parse(s.zarr) }); invalidatePaintCache(s.segId); } }
      finally { quiet.delete(s.segId); lastZarr.set(s.segId, s.zarr); }
      setTimeout(() => giveBack(s.shown), 3000);
      render();
    },
    open: () => !!sess,
  };

  // NEVER A SEGMENTATION BY ITSELF. A tool pressed before one was chosen used to create a new, empty "Segmentation"
  // on the first volume without a word -- which a scene then refused as never saved, and whose save failed as empty
  // (Ron, 2026-09-25: after saving in the editor the scene "complained that the segmentation has not been saved").
  // A new one is made only by "+ New segmentation" in the picker; until one is chosen, the tools say so.
  async function ensureSeg(): Promise<string> {
    if (segId && live.nodes.has(segId)) return segId;
    status("Choose which segmentation to edit first — at the top of the Segment Editor, or Edit in Segmentations");
    return "";
  }
  async function effect(name: string, params: Record<string, unknown>) {
    const id = await ensureSeg(); if (!id) return;
    ensureChosen();
    status(name === "growFromSeeds" ? "Growing from the strokes…" : `${name}…`);
    const r = await g().__applyEffect(id, name, { segment: active, ...ctx.over(), ...params });
    const said = name === "growFromSeeds" ? "Grown from the strokes" : name;
    status(`${said}: ${r.voxels.toLocaleString()} voxels${r.threshold !== undefined ? ` (threshold ${r.threshold.toFixed(0)})` : ""}${r.ms !== undefined ? ` in ${(r.ms / 1000).toFixed(1)} s` : ""}`);
    render();
  }
  /** Every effect button reports on itself (Ron, 2026-09-22: "immediate visual feedback … for every button"). */
  const onEffect = (b: HTMLButtonElement, name: string, params: () => Record<string, unknown>) =>
    b.addEventListener("click", () => void runAction(b, () => effect(name, params()), { busyLabel: "Working…", doneLabel: "Done ✓", failedLabel: "Failed" }).catch(() => {}));

  // Opened from the Segmentations module's Edit button, on THAT segmentation.
  g().__editSegmentation = async (id: string) => {
    if (!live.nodes.has(id)) return;
    // THE TOOL ENDS, as choosing in the picker ends it (critic 2026-10-31, finding 2: Paint left on, strokes went into the
    // segmentation edited before).
    if (id !== segId) { await leaveTool(); chosen = ""; }
    segId = id; filter = ""; pending = null;
    const segs = segsOf(id); active = segs[0]?.labelValue ?? 1;
    if (taskOf.has(id)) firstRow();
    void shell.showPanel("segment");
    render();
  };

  function picker(): string {
    const vols = [...live.nodes.values()].filter((n) => n.type === "image" && !(n as Obj).hidden && !(n as Obj).labelmap);
    const segs = [...live.nodes.values()].filter((n) => n.type === "segmentation" && !(n as Obj).hidden);
    const groups = vols.map((v) => {
      const mine = segs.filter((s) => ((s.refs as Record<string, string[]> | undefined)?.source ?? [])[0] === v.id);
      return `<optgroup label="${escapeHtml(String(v.name ?? v.id))}">${mine.map((s) =>
        `<option value="${escapeHtml(String(s.id))}"${s.id === segId ? " selected" : ""}>${escapeHtml(String(s.name ?? s.id))} · ${segsOf(String(s.id)).length} — ${originWords(s as Obj)}</option>`).join("")}
        <option value="new:${escapeHtml(String(v.id))}">+ New segmentation on ${escapeHtml(String(v.name ?? v.id))}</option></optgroup>`;
    }).join("");
    return `<select class="sl-seg-pick" title="Which segmentation the tools change. Every segmentation in the scene is listed; the others are left as they are.">${segId ? "" : `<option value="" selected>Choose a segmentation…</option>`}${groups}</select>`;
  }

  // WHERE AN OUTLINE GOES (Ron, 2026-10-03: "I do not want to overwrite the existing segementation. It should offer to
  // create a new one, if I did not load one"; then, asked: a new one by default, a loaded one only when chosen; and a
  // question before making one when none is loaded). A segmentation this tool made is its own: its Tumor is the default
  // there. Any other -- loaded from the database or a file, or made by hand -- defaults to "a new segmentation".
  const madeByTool = new Set<string>();
  type Into = number | "tumor" | "new" | "newseg";
  const intoOf = (id: string): Into => clickInto.get(id) ?? (!id || !madeByTool.has(id) ? "newseg" : defaultTarget(segsOf(id)) ?? "tumor");
  /** "Into:" — a new segmentation (with a Tumor structure), or, in the chosen one, Tumor, a structure, or a new structure. */
  function clickOptions(): string {
    const segs = segsOf(segId);
    const cur = intoOf(segId);
    const opt = (v: string | number, label: string) => `<option value="${v}"${cur === v ? " selected" : ""}>${label}</option>`;
    return opt("newseg", "Into: a new segmentation") + (segId ? (defaultTarget(segs) === null ? opt("tumor", "Into: Tumor (new, in this one)") : "") +
      segs.map((x) => opt(x.labelValue, `Into: ${escapeHtml(x.name ?? `Segment ${x.labelValue}`)} (this one)`)).join("") +
      opt("new", "Into: a new structure (this one)") : "");
  }
  /** Make the chosen structure if it is to be made; its label value. */
  function clickTarget(id: string): number {
    const segs = segsOf(id);
    const want = intoOf(id);
    if (typeof want === "number" && segs.some((x) => x.labelValue === want)) return want;
    const v = g().__addSegment(id);
    if (want !== "new") describe(id, v, TUMOR);
    clickInto.set(id, v);
    return v;
  }
  /** The scan the slice views show (the first view's background), else the only scan loaded. */
  function shownScan(): string {
    for (const n of live.nodes.values()) {
      if (n.type !== "sliceComposite") continue;
      const bg = ((n.refs as Record<string, string[]> | undefined)?.background ?? [])[0];
      const img = bg ? live.nodes.get(bg) : undefined;
      if (img?.type === "image" && !img.labelmap) return bg;
    }
    return ([...live.nodes.values()].find((n) => n.type === "image" && !n.labelmap)?.id as string | undefined) ?? "";
  }
  async function clickOutlineToggle() {
    if (String(g().__segTool?.().activeEffect).toLowerCase() === "clickoutline") { g().__clickOutlineEnd(); return; }
    // The license first: a structure made for the outline and then refused would stay behind, empty.
    if (!(await g().__clickOutlineLicense())) return;
    // ON A SCAN WITH NO SEGMENTATION CHOSEN (Ron, 2026-10-03, on a T1 alone: "click to outline does not respond" -- every
    // tool was grayed out until a segmentation was chosen, and only a tooltip said so): the press makes one on the scan
    // the views show, with a Tumor structure. Made by this press, for this tool: removed again if no click lands in it.
    let made = false;
    const none = !segId || !live.nodes.has(segId);
    if (none || intoOf(segId) === "newseg") {
      // On the scan of the segmentation chosen, else the scan the views show.
      const scan = (!none && (((live.nodes.get(segId)?.refs as Record<string, string[]> | undefined)?.source ?? [])[0])) || shownScan();
      if (!scan) { status("Click to outline: load a scan first"); return; }
      // NOTHING LOADED: ask first (Ron's choice).
      if (none) {
        const scanName = String(live.nodes.get(scan)?.name ?? "the scan");
        const ok = await shell.confirm({ title: "Make a new segmentation for the outline?", body: `<p>No segmentation is loaded. Click to outline makes a new one on <b>${escapeHtml(scanName)}</b>, with a structure named Tumor.</p><p class="sl-hint">It is not saved until you press Save; if you end without clicking, it is removed again.</p>`, ok: "Make it", cancel: "Cancel" });
        if (!ok) return;
      }
      const r = await g().__createSegmentation(scan, "Tumor outline");
      segId = r.segId; made = true; madeByTool.add(segId);
      describe(segId, r.segment, TUMOR);
      clickInto.set(segId, r.segment);
    }
    const id = segId;
    const target = clickTarget(id);
    active = target;
    render();
    const ok = await g().__clickOutlineStart(id, target, made);
    if (ok) g().__setSegTool(id, "clickOutline", { segment: target });
    render();
  }

  // ── the tools: the chosen one's controls under the row (render/demos/seg-tools/registry.ts) ──
  /** "over": anything, empty voxels only, the visible structures, or one structure by name (`overSeg`). */
  let chosen = "", over: OverwriteMode = "all", overSeg = 0;
  const toolOf = (id: string) => segTools().find((t) => t.id === id);
  const activeEffect = () => String(g().__segTool?.().activeEffect ?? "").toLowerCase();
  const ctx: SegToolContext = {
    live, store: opts.store,
    segId: () => (segId && live.nodes.has(segId) ? segId : ""),
    structure: () => {
      if (pending) return { labelValue: -1, name: pending.name, color: pending.rgb.map((c) => c / 255) };
      const x = segsOf(segId).find((v) => v.labelValue === active); return { labelValue: active, name: x?.name ?? `Segment ${active}`, color: x?.color ?? [0.8, 0.8, 0.8] };
    },
    over: () => ({ overwrite: over, visibleSegments: segsOf(segId).filter((v) => v.visible !== false).map((v) => v.labelValue), overSegment: over === "segment" ? overSeg : undefined }),
    source: () => { const id = (((live.nodes.get(segId)?.refs as Record<string, string[]> | undefined)?.source) ?? [])[0]; const n = id ? live.nodes.get(id) : undefined; return id && n ? { id, node: n as Obj } : null; },
    edits,
    takeClicks: (on) => { if (segId) g().__setSegTool(segId, on ? chosen : "", { segment: active }); },
    status,
    rerender: () => render(),
  };
  /** Put the chosen tool away (its brush, its clicks). What it shows is written (`keep`), or dropped for Undo. */
  async function leaveTool(keep = true) { const t = toolOf(chosen); if (t) await t.left?.(ctx, keep); if (sess) edits.cancel(); }
  /** The pointer: whatever tool is on goes off (as pressing it again does). */
  async function pointer() { if (!chosen) return; await leaveTool(); chosen = ""; render(); }
  async function choose(id: string) {
    const t = toolOf(id); if (!t) return;
    const again = chosen === id;
    // A tool pressed again: off -- except one that ended by itself (Esc ended Click to outline), which starts again.
    if (again && (id === "outline" ? activeEffect() === "clickoutline" : id === "paint" || id === "erase" || id === "draw" ? activeEffect() === id : true)) { await leaveTool(); chosen = ""; render(); return; }
    if (!again) await leaveTool();
    if (id !== "outline") ensureChosen();
    chosen = id; render();
    await t.chosen?.(ctx);
    render();
  }
  const sp = () => voxelOrUnit(segId ? nodeVoxel(sourceOf(segId)) : undefined, nodeVoxel(node()), sceneVoxel(live.nodes.values() as Iterable<Obj>));
  /** The brush (Paint, Erase) or Draw on or off. */
  const brush = async (t: "paint" | "erase" | "draw" | "") => {
    const id = t ? await ensureSeg() : segId; if (t && !id) return;
    if (activeEffect() === "clickoutline") g().__clickOutlineEnd();
    g().__setSegTool(id, t, { diameterMm: brushVox * sp(), sphere: !!g().__segTool?.().sphere, segment: active });
    if (t) status(t === "draw" ? "Draw: click around the region in a slice view; double-click to fill" : t === "paint" ? "Paint: drag in a slice view; Option-drag erases" : "Erase: drag in a slice view");
  };
  // ── PAINT AND ERASE (Ron, 2026-10-31): the brush, what it may touch -- the "over" rule and a brightness limit, by default
  //    the Threshold's range, a slide switch to adaptive ("make threshold range default adaptiv a slider to toggle") --
  //    and Option-drag erasing in Paint (render/moduleserver/live-views.ts brushMode). The arithmetic: logic/paint-brush.ts.
  /** Per scan: a range typed here (else the Threshold's, else none), and the adaptive tolerance typed here. */
  const paintRange = new Map<string, [number, number]>(), adaptTol = new Map<string, number>();
  let adaptive = false;
  const brushOn = () => chosen === "paint" || chosen === "erase";
  // THE LIMIT READS THE SCAN IN THE VIEW PAINTED IN (2026-10-31, three scans side by side: edema is painted on the FLAIR,
  // the enhancing rim on the T1 post-contrast). Each scan keeps its own range; the row shows the one of the view the
  // brush was last over (live-views onViewScan), named when it is not the segmentation's own.
  const brushScans = new Map<string, Scan>();
  let viewScanId: string | null = null;
  const viewScanOrOwn = () => (viewScanId && live.nodes.has(viewScanId) ? viewScanId : ctx.source()?.id) ?? null;
  const scanOfView = () => { const id = viewScanOrOwn(); return id ? brushScans.get(id) ?? null : null; };
  const readScan = (id: string) => void loadScan(ctx, id === ctx.source()?.id ? undefined : id).then((x) => { if (x) brushScans.set(id, x); syncPaintLimits(); if (brushOn()) render(); })
    .catch((e) => status(`Paint: the scan could not be read (${(e as Error).message ?? e})`));
  /** A scan in words: its kind from the header when known (T1 post-contrast, FLAIR), else its name. */
  const scanWord = (id: string) => {
    const uid = String(((live.nodes.get(id)?.origin ?? {}) as Obj).seriesInstanceUID ?? "");
    return tState().sameDay?.find((x) => x.uid === uid)?.kind ?? String(live.nodes.get(id)?.name ?? "this scan");
  };
  const rangeFor = (s: Scan): { lo: number; hi: number; from: "typed" | "threshold" | "whole" } => {
    const r = paintRange.get(s.id) ?? thresholdRangeOf(s.id);
    if (!r || (r[0] <= s.hist.min && r[1] >= s.hist.max)) return { lo: s.hist.min, hi: s.hist.max, from: "whole" };
    return { lo: r[0], hi: r[1], from: paintRange.has(s.id) ? "typed" : "threshold" };
  };
  /** Adaptive's tolerance: typed, else a tenth of the scan's useful range (1st to 99.5th percentile). */
  const tolFor = (s: Scan) => adaptTol.get(s.id) ?? (s.hist.integer ? Math.max(1, Math.round((s.hist.useful[1] - s.hist.useful[0]) / 10)) : (s.hist.useful[1] - s.hist.useful[0]) / 10);
  const fmtV = (s: Scan, x: number) => s.hist.integer ? String(Math.round(x)) : x.toPrecision(4);
  /** Tell the brush what it may touch (logic/segment-tools.ts setPaintLimits, read by Paint, Erase and Draw). */
  function syncPaintLimits() {
    if (!segId || !live.nodes.has(segId)) return;
    const n = node()!;
    const limitOf = (s: Scan | null | undefined) => {
      if (!s) return {};
      const r = rangeFor(s);
      return {
        source: { data: s.data, dims: s.dims, segToSource: segToSourceOf(n.ijkToRAS as number[], n.dims as [number, number, number], s.inv, s.dims) },
        range: !adaptive && r.from !== "whole" ? [r.lo, r.hi] as [number, number] : undefined,
        adaptive: adaptive ? tolFor(s) : undefined,
      };
    };
    const own = ctx.source()?.id;
    // Only the outlined scan and the ones the views show stay read (finding 7).
    const inUse = new Set<string>([...(own ? [own] : []), ...[...live.nodes.values()].filter((x) => x.type === "sliceComposite").flatMap((x) => ((x.refs as Record<string, string[]> | undefined)?.background ?? []))]);
    for (const id of [...brushScans.keys()]) if (!inUse.has(id)) brushScans.delete(id);
    keepScans(inUse);
    setPaintLimits(segId, { ...ctx.over(), ...limitOf(own ? brushScans.get(own) : null), ownImage: own, byImage: Object.fromEntries([...brushScans].map(([id, s]) => [id, limitOf(s)])) });
  }
  /** The brush one step bigger or smaller (Shift+wheel over a slice, + and -): a voxel at a time below 10, a tenth above. */
  function brushStep(dir: 1 | -1) {
    if (!brushOn()) return;
    brushVox = Math.max(1, Math.min(60, brushVox + dir * (brushVox < 10 ? 1 : Math.max(1, Math.round(brushVox / 10)))));
    const cur = g().__segTool?.(); if (cur?.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: brushVox * sp(), sphere: cur.sphere, segment: active });
    const el = root?.querySelector<HTMLInputElement>(".sl-brush-vox");
    if (el) { el.value = String(brushVox); el.dispatchEvent(new Event("input")); }
  }
  /** The status after a stroke, in words: what it wrote, and what the over rule or the limit left. */
  function saidPainted(id: string) {
    const t = strokeTallyOf(id); if (!t || id !== segId) return;
    const name = ctx.structure().name, s = scanOfView(), u = s?.ct ? " HU" : "";
    const parts = [t.mode === "remove" ? `Erase: ${t.written.toLocaleString()} voxels of ${name} taken away` : `Paint: ${t.written.toLocaleString()} voxels into ${name}`];
    if (t.heldOver.size) {
      const on = segsOf(segId).find((x) => x.labelValue === overSeg)?.name ?? `Segment ${overSeg}`;
      parts.push(`${t.heldOver.size.toLocaleString()} under the brush left as they were: ${over === "segment" ? `outside ${on} (“over ${on}”)` : over === "none" ? "they hold another structure (“over empty voxels only”)" : "they hold a hidden structure (“over visible structures”)"}`);
    }
    if (t.heldBrightness.size && s) parts.push(`${t.heldBrightness.size.toLocaleString()} left: ${adaptive ? "not like the voxel under the brush's center" : `outside ${fmtV(s, rangeFor(s).lo)} to ${fmtV(s, rangeFor(s).hi)}${u}`}`);
    status(parts.join("; "));
    // The same, short, beside the brush (live-views brushNote): the line under the views is the backup.
    const n = t.heldBrightness.size, d = t.heldDarker.size, o = t.heldOver.size;
    const said = [n ? `${n.toLocaleString()} ${adaptive ? "unlike" : d === n ? "darker" : d === 0 ? "brighter" : "brighter or darker"} voxels` : "",
      o ? `${o.toLocaleString()} ${over === "segment" ? `outside ${segsOf(segId).find((x) => x.labelValue === overSeg)?.name ?? "it"}` : over === "none" ? "of other structures" : "of hidden structures"}` : ""].filter(Boolean);
    if (t.mode !== "remove" && said.length) g().__brushNote?.(`left out ${said.join(", ")}`);
  }
  const brushArea = (el: HTMLElement) => {
    const tool = g().__segTool?.() ?? { sphere: false };
    const v = sp(), s = scanOfView(), vid = viewScanOrOwn();
    if (!s && vid) readScan(vid);
    const u = s?.ct ? "HU" : "", r = s ? rangeFor(s) : null;
    const onWhich = s && s.id !== ctx.source()?.id ? `On the ${escapeHtml(scanWord(s.id))}: o` : "O";
    const from = r?.from === "threshold" ? "Threshold's range" : r?.from === "whole" ? "the whole scan" : "";
    const limit = !s ? `<div class="sl-row"><span class="sl-hint">Reading the scan…</span></div>` : adaptive
      ? `<div class="sl-row sl-pb-limit"><span>${onWhich}nly voxels within ±</span><input type="number" class="sl-pb-tol" value="${fmtV(s, tolFor(s))}" title="How different from the voxel under the brush's center a voxel may be and still be painted"><span>${u} of the one under the brush's center, joined to it</span></div>`
      : `<div class="sl-row sl-pb-limit"><span>${onWhich}nly voxels from</span><input type="number" class="sl-pb-lo" value="${fmtV(s, r!.lo)}" title="The darkest voxel the brush paints"><span>to</span><input type="number" class="sl-pb-hi" value="${fmtV(s, r!.hi)}" title="The brightest voxel the brush paints"><span>${u}</span><span class="sl-hint">${from}</span>${r!.from !== "whole" ? `<button class="sl-pb-any" title="Paint whatever is under the brush, bright or dark">Any</button>` : ""}</div>`;
    el.innerHTML = `<div class="sl-row"><label>Brush</label><input class="sl-brush-vox" type="range" min="1" max="60" step="1" value="${brushVox}"><span class="sl-brush-v">${brushVox} voxels</span><label><input type="checkbox" class="sl-brush-sphere"${tool.sphere ? " checked" : ""}> Sphere</label></div>
      <div class="sl-row"><span class="sl-hint sl-brush-mm">≈ ${lengthText(brushVox * v, 1, v)} on this ${lengthText(v, 2, v)} grid</span></div>
      ${limit}
      ${s ? `<div class="sl-row"><label class="sl-switch" title="On: the brush paints only voxels like the one under its center, so it stops at an edge. Off: it paints the voxels between the two numbers."><input type="checkbox" role="switch" class="sl-pb-adapt" aria-label="Adaptive brush"${adaptive ? " checked" : ""}><i aria-hidden="true"></i></label><span>Adaptive: stops at edges</span></div>` : ""}`;
    const sync = () => { const cur = g().__segTool?.(); if (cur?.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: brushVox * v, sphere: (el.querySelector(".sl-brush-sphere") as HTMLInputElement).checked, segment: active }); };
    el.querySelector(".sl-brush-vox")!.addEventListener("input", (e) => { brushVox = Number((e.target as HTMLInputElement).value); (el.querySelector(".sl-brush-v") as HTMLElement).textContent = `${brushVox} voxels`; (el.querySelector(".sl-brush-mm") as HTMLElement).textContent = `≈ ${lengthText(brushVox * v, 1, v)} on this ${lengthText(v, 2, v)} grid`; sync(); });
    el.querySelector(".sl-brush-sphere")!.addEventListener("change", sync);
    if (!s) return;
    const num = (q: string) => Number(el.querySelector<HTMLInputElement>(q)?.value);
    const typed = () => { const a = num(".sl-pb-lo"), b = num(".sl-pb-hi"); if (Number.isFinite(a) && Number.isFinite(b)) paintRange.set(s.id, [Math.min(a, b), Math.max(a, b)]); syncPaintLimits(); render(); };
    el.querySelector(".sl-pb-lo")?.addEventListener("change", typed);
    el.querySelector(".sl-pb-hi")?.addEventListener("change", typed);
    el.querySelector(".sl-pb-any")?.addEventListener("click", () => { paintRange.set(s.id, [s.hist.min, s.hist.max]); syncPaintLimits(); render(); });
    el.querySelector(".sl-pb-tol")?.addEventListener("change", () => { const t = Math.abs(num(".sl-pb-tol")); if (Number.isFinite(t)) adaptTol.set(s.id, t); syncPaintLimits(); });
    el.querySelector(".sl-pb-adapt")?.addEventListener("change", (e) => { adaptive = (e.target as HTMLInputElement).checked; syncPaintLimits(); render(); });
  };
  const L = (keys: string, does: string, tip: string): CheatLine => ({ keys, does, tip });
  const brushCheats = (erase: boolean) => (c: SegToolContext): CheatLine[] => { const n = c.structure().name; return [
    L("Drag", erase ? `erases ${n}` : `paints ${n}`, erase ? `Hold the mouse button down and move over a slice: the brush takes ${n} away. Other structures stay.` : `Hold the mouse button down and move over a slice: the brush paints ${n}, the structure chosen at the top.`),
    L("Click", erase ? "erases one spot" : "paints one spot", "A click without moving the mouse does one spot the size of the brush."),
    ...(erase ? [] : [L("Option-drag", `erases ${n}`, `Hold the Option key while you drag: the brush takes ${n} away instead of painting it. Other structures stay.`)]),
    L("Shift + wheel", "brush bigger or smaller", "Hold Shift and turn the scroll wheel over a slice to change the size of the brush. The + and − keys do the same."),
    L("Wheel", "next slice", "The scroll wheel alone moves through the slices, as always."),
  ]; };
  const builtIn: SegTool[] = [
    { id: "paint", label: "Paint", icon: "●", order: 10, tip: "Paint the structure chosen at the top with a brush in a slice view (Option-drag erases it)", chosen: () => brush("paint"), mount: brushArea, cheats: brushCheats(false), left: () => { if (activeEffect() === "paint") void brush(""); } },
    { id: "erase", label: "Erase", icon: "○", order: 20, tip: "Erase the structure chosen at the top with a brush in a slice view; other structures stay", chosen: () => brush("erase"), mount: brushArea, cheats: brushCheats(true), left: () => { if (activeEffect() === "erase") void brush(""); } },
    { id: "draw", label: "Draw", icon: "✎", order: 30, tip: "Outline a region on one slice; it is filled into the structure (double-click, Enter or a right-click)", chosen: () => brush("draw"),
      mount: (el) => { el.innerHTML = `<p class="sl-hint">Click around the region in a slice view, or drag along its edge; a double-click fills it.</p>`; }, left: () => { if (activeEffect() === "draw") void brush(""); },
      cheats: (c) => [
        L("Click", "adds a corner", "Each click on a slice adds a corner of the outline."),
        L("Drag", "traces the edge", "Hold the mouse button down and move along the edge: the outline follows the mouse."),
        L("Double-click", `fills it into ${c.structure().name}`, "A double-click closes the outline and fills it, on this slice. Enter or a right-click do the same."),
        L("Backspace", "takes the last corner back", "Removes the corner you added last."),
        L("Esc", "drops the outline", "Throws the outline away; nothing is filled."),
      ] },
    { id: "outline", label: "Outline", icon: "✦", order: 50, tip: "Click inside a structure in any view and it is outlined in 3D; click again to add, shift-click to take away. Esc or a right-click ends. Academic, non-commercial use (nnLive, from nnInteractive). More in Help.",
      chosen: () => clickOutlineToggle().catch((e) => status(`Click to outline: ${(e as Error).message ?? e}`)),
      mount: (el) => {
        el.innerHTML = `<div class="sl-row"><select class="sl-click-into" title="The structure the outline goes into. Further clicks refine the same one.">${clickOptions()}</select></div>`;
        el.querySelector<HTMLSelectElement>(".sl-click-into")!.addEventListener("change", async (e) => {
          const v = (e.target as HTMLSelectElement).value;
          clickInto.set(segId, v === "tumor" || v === "new" || v === "newseg" ? v : Number(v));
          if (activeEffect() === "clickoutline") {
            if (v === "newseg") { g().__clickOutlineEnd(); await clickOutlineToggle(); render(); return; }   // start over in a new one
            const target = clickTarget(segId); active = target;
            if (await g().__clickOutlineStart(segId, target)) g().__setSegTool(segId, "clickOutline", { segment: target });
          }
          render();
        });
      },
      left: () => { if (activeEffect() === "clickoutline") g().__clickOutlineEnd(); },
      cheats: () => [
        L("Click", "outlines what is under it", "Click inside a structure on a slice or in 3D: it is outlined in 3D. Click again elsewhere to add to it."),
        L("Shift-click", "takes a part away", "Hold Shift and click on a part that should not be in the outline."),
        L("Esc", "ends", "Ends outlining; the outline stays. A right-click does the same."),
      ] },
    { id: "grow", label: "Grow", icon: "❋", order: 60, tip: "Fill each structure out to its edges from a few painted strokes",
      mount: (el) => {
        el.innerHTML = `<div class="sl-row sl-actions"><button class="sl-eff-seeds sl-primary" title="Paint strokes inside the structure, and with a second segment in what surrounds it, then press. Every segment shown takes part, and everything around the strokes becomes one of them; hide the segments that should stay as they are (the eye). Undo puts the strokes back.">Grow from the strokes</button></div>`;
        onEffect(el.querySelector(".sl-eff-seeds")!, "growFromSeeds", () => ({}));
      } },
    { id: "more", label: "More", icon: "⋯", order: 90, tip: "Islands, smoothing, margin, logical operations and statistics",
      mount: (el) => {
        el.innerHTML = `
          <div class="sl-row"><label>Islands</label><button class="sl-eff-largest" title="Keep the largest connected piece of this structure; remove the rest">Keep largest</button><button class="sl-eff-small" title="Remove pieces smaller than 10 voxels">Remove small</button></div>
          <div class="sl-row"><label>Smoothing</label><button class="sl-eff-median">Median</button><button class="sl-eff-open">Open</button><button class="sl-eff-close">Close</button></div>
          <div class="sl-row"><label>Margin (voxels)</label><input class="sl-margin" type="number" value="2" step="1" style="width:48px" title="How far to grow or shrink, in voxels of this volume"><button class="sl-eff-grow">Grow</button><button class="sl-eff-shrink">Shrink</button></div>
          <div class="sl-row"><label>Logical (label no.)</label><input class="sl-other" type="number" value="2" step="1" style="width:60px"><button class="sl-eff-union">∪</button><button class="sl-eff-sub">−</button><button class="sl-eff-int">∩</button></div>
          <div class="sl-row"><button class="sl-eff-stats">Statistics</button></div><div class="sl-seg-stats"></div>`;
        const $ = <T extends HTMLElement>(q: string) => el.querySelector(q) as T;
        const num = (q: string) => Number(($(q) as HTMLInputElement).value);
        const v = sp();
        onEffect($(".sl-eff-largest"), "islands", () => ({ islands: "keepLargest" }));
        onEffect($(".sl-eff-small"), "islands", () => ({ islands: "removeSmall", minSize: 10 }));
        onEffect($(".sl-eff-median"), "smoothing", () => ({ smooth: "median", radiusVoxels: 1 }));
        onEffect($(".sl-eff-open"), "smoothing", () => ({ smooth: "open", radiusVoxels: 1 }));
        onEffect($(".sl-eff-close"), "smoothing", () => ({ smooth: "close", radiusVoxels: 1 }));
        onEffect($(".sl-eff-grow"), "margin", () => ({ marginMm: Math.abs(num(".sl-margin")) * v }));
        onEffect($(".sl-eff-shrink"), "margin", () => ({ marginMm: -Math.abs(num(".sl-margin")) * v }));
        onEffect($(".sl-eff-union"), "logical", () => ({ logical: "union", other: num(".sl-other") }));
        onEffect($(".sl-eff-sub"), "logical", () => ({ logical: "subtract", other: num(".sl-other") }));
        onEffect($(".sl-eff-int"), "logical", () => ({ logical: "intersect", other: num(".sl-other") }));
        const sb = $<HTMLButtonElement>(".sl-eff-stats");
        sb.addEventListener("click", () => void runAction(sb, async () => { const stt = await g().__segmentStats(segId); $(".sl-seg-stats").innerHTML = stt.map((x) => `<div class="sl-hint">${escapeHtml(segsOf(segId).find((s) => s.labelValue === x.labelValue)?.name ?? `Segment ${x.labelValue}`)}: ${x.voxels.toLocaleString()} voxels, ${(x.volumeMm3 / 1000).toFixed(2)} mL</div>`).join(""); }, { busyLabel: "Counting…", doneLabel: "Done ✓" }).catch(() => {}));
      } },
  ];
  for (const t of builtIn) registerSegTool(t);
  registerSegTool(thresholdTool());
  registerSegTool(scissorsTool());

  const OVER: [OverwriteMode, string, string][] = [["all", "anything", "The tools may write over any structure"], ["none", "empty voxels only", "The tools write only where no structure is"], ["visible", "visible structures", "The tools may write over the structures shown, not over hidden ones"]];

  /** The "over" choices: the three rules, then each other structure by name (ITK-SNAP's "Paint over" one label; Ron,
   *  2026-10-31: "Yes, now"), so that Necrosis painted over Tumor stays inside the tumor. */
  function overOptions(): string {
    const others = segsOf(segId).filter((x) => x.labelValue !== active);
    const nm = (x: Seg) => escapeHtml(x.name ?? `Segment ${x.labelValue}`);
    return OVER.map(([v, w, t]) => `<option value="${v}" title="${t}"${v === over ? " selected" : ""}>${w}</option>`).join("")
      + (others.length ? `<optgroup label="only one structure">${others.map((x) => `<option value="seg:${x.labelValue}" title="The tools write only where ${nm(x)} is; nowhere else"${over === "segment" && overSeg === x.labelValue ? " selected" : ""}>${nm(x)}</option>`).join("")}</optgroup>` : "");
  }

  // ── THE TASK, AND ITS STRUCTURES AS THE PICKER (Ron, 2026-10-31: "the user gets to choose a task from a collapsible area
  //    at the top"; "have the list, I click and then paint"; "surgical resident too busy to read or think is our default
  //    customer"; "keep it simple and tuck the complexities away under advanced"; mockups/segment-editor-task-2026-10-31.html).
  //    One folded line says the task and where; the task's structures are the list, the outlined row is what the tools
  //    paint, the first is chosen. A structure joins the segmentation when a tool starts on it (or it is clicked), so the
  //    list is not filled with empty ones; Save leaves out what is still empty. The sets: logic/anatomy/task-sets.ts. ──
  /** postContrast: the series description of a post-contrast scan of this patient from the same day, and how its kind was
   *  read; it brings the tumor's two parts (logic/anatomy/task-sets.ts). */
  type TaskState = { task: Task; region: ClinicalRegion | null; why: string; db: string | null; postContrast?: { name: string; how: string } | null;
    /** This patient's scans of the same day, by kind (logic/scan-kind.ts): what "Side by side" offers. */
    sameDay?: { uid: string; kind: string; name: string }[] };
  const offered = (t: TaskState = tState()) => taskStructures(t.task, t.region, { postContrast: !!t.postContrast });
  const taskOf = new Map<string, TaskState>();
  let taskOpen = false, alsoOpen = false;
  /** The task's structure chosen and not made yet (the first row by default): made when a tool starts on it. */
  let pending: TaskStructure | null = null;
  const tState = (): TaskState => taskOf.get(segId) ?? { task: "anatomy", region: null, why: "", db: null };
  /** THE LAST TASK ON A DATABASE, per machine (a resident going through a tumor database answers once). */
  const taskKey = (db: string | null) => `sl.segTask.${db ?? "-"}`;
  const lastTask = (db: string | null): { task?: Task; region?: ClinicalRegion | null } | null => { try { return JSON.parse(localStorage.getItem(taskKey(db)) ?? "null"); } catch { return null; } };
  const keepTask = (t: TaskState) => { try { localStorage.setItem(taskKey(t.db), JSON.stringify({ task: t.task, region: t.region })); } catch { /* private mode: nothing remembered */ } };
  const sameStructure = (x: Seg, t: TaskStructure) => (x.name ?? "").toLowerCase() === t.name.toLowerCase();
  /** SMART DEFAULTS, in order: the task last used on this database, else General anatomy (Ron: "the general anatomy as
   *  default"); the region from the scan's Body Part field, else from the structures already in the case, else as last
   *  time on this database, else none (a search instead). */
  const resolving = new Set<string>();
  async function resolveTask(id: string) {
    if (!id || taskOf.has(id) || resolving.has(id)) return;
    resolving.add(id);
    try {
      const db = await g().__openDatabaseId?.().catch(() => null) ?? null;
      const last = lastTask(db);
      const uid = String(((sourceOf(id)?.origin ?? {}) as Obj).seriesInstanceUID ?? "");
      const listed = uid ? await g().__databaseSeries?.().catch(() => null) : null;
      const me = listed?.series.find((x) => x.seriesInstanceUID === uid);
      const kin = me?.studyInstanceUID ? listed!.series.filter((x) => x.studyInstanceUID === me.studyInstanceUID) : [];
      const said = bodyPartOfScan(me?.bodyPart, kin.map((x) => x.bodyPart), me?.studyDescription), bodyPart = said.part;
      const fromScan = regionFromBodyPart(bodyPart), fromStructures = regionFromStructures(segsOf(id).map((x) => x.structure ?? x.name ?? ""));
      // A POST-CONTRAST SCAN OF THE SAME DAY (Ron: "same day"): this patient's series acquired that day, read from their
      // headers (logic/scan-kind.ts).
      const day = (x: { seriesDate?: string; studyDate?: string } | undefined) => (x?.seriesDate || x?.studyDate || "").replace(/\D/g, "");
      const sameDay = me && me.patientID && day(me) ? listed!.series.filter((x) => x.patientID === me.patientID && day(x) === day(me) && (x.modality === "MR" || x.modality === "CT")) : [];
      const kinds: Record<string, { kind: string; how: string }> = sameDay.length ? await g().__seriesKinds?.(sameDay.map((x) => x.seriesInstanceUID)).catch(() => ({})) ?? {} : {};
      const post = sameDay.find((x) => /post-contrast/.test(kinds[x.seriesInstanceUID]?.kind ?? ""));
      const t: TaskState = { task: last?.task ?? "anatomy", region: null, why: "", db, postContrast: post ? { name: post.description ?? "a scan", how: kinds[post.seriesInstanceUID].how } : null,
        sameDay: sameDay.filter((x) => kinds[x.seriesInstanceUID] && kinds[x.seriesInstanceUID].kind !== "other").map((x) => ({ uid: x.seriesInstanceUID, kind: kinds[x.seriesInstanceUID].kind, name: x.description ?? "" })) };
      if (fromScan) { t.region = fromScan; t.why = `from the ${said.from === "study" ? "study" : "scan"}: ${bodyPart.trim().toUpperCase()}`; }
      else if (fromStructures) { t.region = fromStructures; t.why = "from the structures in this case"; }
      else if (last?.region) { t.region = last.region; t.why = "as last time on this database"; }
      else if (last?.task) t.why = "as last time on this database";
      taskOf.set(id, t);
      if (id === segId) { firstRow(); render(); }
    } finally { resolving.delete(id); }
  }
  /** The first of the task's structures is chosen: the one already painted, else to be made when a tool starts. */
  function firstRow() {
    const ts = offered();
    if (!ts.length) { pending = null; return; }
    const seg = segsOf(segId).find((x) => sameStructure(x, ts[0]));
    if (seg) { active = seg.labelValue; pending = null; } else pending = ts[0];
    retargetTool();
  }
  /** The tools follow the chosen structure. */
  function retargetTool() {
    const cur = g().__segTool?.();
    // WITH A TOOL ON, THE OUTLINED ROW IS MADE NOW (critic 2026-10-31, finding 1: after a task change the list outlined the
    // new first structure while the brush kept painting the old one). Save leaves it out if it stays empty.
    if ((chosen || cur?.activeEffect) && segId && live.nodes.has(segId) && pending) { active = make(pending); pending = null; }
    if (cur?.activeEffect && segId && !pending) g().__setSegTool(segId, cur.activeEffect, { diameterMm: cur.diameterMm, sphere: cur.sphere, segment: active });
    toolOf(chosen)?.retarget?.(ctx);
  }
  /** A STRUCTURE OF A TASK GIVEN TO A SEGMENT: its name, color and codes (logic/anatomy/task-sets.ts). The one place a
   *  segment is described from a task, for the list and for Click to outline's Tumor alike. */
  function describe(id: string, lv: number, t: TaskStructure) {
    g().__setSegmentProp(id, lv, "name", t.name);
    g().__setSegmentProp(id, lv, "color", t.rgb.map((c) => c / 255));
    const code = (c: string | undefined) => /^([^:]+):(.+)$/.exec(c ?? "");
    const m = code(t.code), cat = code(t.categoryCode);
    if (m) g().__setSegmentProp(id, lv, "fileCodes", {
      type: { scheme: m[1], value: m[2], meaning: t.type ?? t.name },
      ...(t.category ? { category: { scheme: cat?.[1] ?? "SCT", value: cat?.[2] ?? "", meaning: t.category } } : {}),
      ...(t.mod ? { modifier: { scheme: "SCT", value: t.mod === "Right" ? "24028007" : "7771000", meaning: t.mod } } : {}),
    });
  }
  /** A structure of the list made in the segmentation. */
  function make(t: TaskStructure): number {
    const lv = g().__addSegment(segId);
    describe(segId, lv, t);
    return lv;
  }
  /** Before a tool starts: the chosen structure exists (made now if it is the task's and not made yet). */
  function ensureChosen() {
    if (!segId || !live.nodes.has(segId)) return;
    if (pending) { active = make(pending); pending = null; retargetTool(); return; }
    if (!segsOf(segId).length) { active = g().__addSegment(segId); retargetTool(); }
  }
  function pickRow(el: HTMLElement) {
    if (el.dataset.new !== undefined) { active = g().__addSegment(segId); pending = null; }
    else if (el.dataset.seg) { active = Number(el.dataset.seg); pending = null; }
    else if (el.dataset.key) {
      const t = [...offered(), ...allStructures()].find((x) => x.key === el.dataset.key);
      if (!t) return;
      const seg = segsOf(segId).find((x) => sameStructure(x, t));
      // A click is the person's choice: made now, so a tool already on paints it at the next stroke.
      active = seg ? seg.labelValue : make(t); pending = null;
    }
    retargetTool(); render();
  }
  function taskHtml(): string {
    const t = tState();
    // Where decides the list for General anatomy; a tumor's list is the same everywhere (its two parts come with a
    // post-contrast scan of the same day), so its line asks nothing when no region is known.
    const where = t.region ? ` · <b>${t.region}</b>` : t.task === "anatomy" ? ` · <span class="sl-hint">where?</span>` : "";
    return `<details class="sl-se-task"${taskOpen ? " open" : ""}><summary title="What you are outlining: it decides the structures offered below">Task: <b>${TASK_WORDS[t.task]}</b>${where}<span class="sl-hint sl-se-why">${escapeHtml(t.why)}</span></summary>
      <div class="sl-se-task-body"><div class="sl-se-task3" role="radiogroup" aria-label="Task">${(["tumor", "anatomy", "own"] as Task[]).map((k) =>
        `<button data-task="${k}" class="${k === t.task ? "sl-chosen" : ""}" title="${k === "tumor" ? "Outline a tumor, dead tissue (necrosis) and swelling (edema); with a post-contrast scan of the same day, also the tumor’s enhancing and non-enhancing parts" : k === "anatomy" ? "Outline organs and other anatomy, named and colored from the General Anatomy list" : "Start empty and name the structures yourself"}">${TASK_WORDS[k]}</button>`).join("")}</div>
      ${t.task === "own" ? "" : `<div class="sl-hint">Where</div><div class="sl-se-chips">${CLINICAL_REGIONS.map((r) => `<button data-region="${r}" class="${r === t.region ? "sl-chosen" : ""}">${r}</button>`).join("")}</div>`}</div></details>${sideHtml(t)}`;
  }
  // THREE SCANS SIDE BY SIDE (Ron, 2026-10-31: "remember that we have 3 2d viewers by default. Is there a good way to take
  // advantage of this?" ... "go ahead with the three scans side by side"): one button puts three of this patient's scans of
  // the same day into the three slice views, in one direction, linked; the segmentation is drawn over each, and a stroke in
  // any of them paints it. The scan outlined comes first, then the others by what a tumor shows on (post-contrast T1,
  // FLAIR, T2, T1). Loads a scan that is not loaded yet. "One scan again" puts the views back.
  const KIND_ORDER = ["T1 post-contrast", "FLAIR", "T2", "T1", "CT post-contrast", "CT"];
  /** The layout before Side by side changed it, to put back. */
  let layoutBefore: number | null = null;
  const shortKind = (k: string) => k === "T1 post-contrast" ? "T1 post" : k === "CT post-contrast" ? "CT post" : k;
  function sideScans(t: TaskState): { uid: string; kind: string; name: string }[] {
    const own = String(((sourceOf(segId)?.origin ?? {}) as Obj).seriesInstanceUID ?? "");
    const all = [...(t.sameDay ?? [])].sort((a, b) => (a.uid === own ? -1 : b.uid === own ? 1 : KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)));
    // One of each kind (a second FLAIR waits), at most three.
    const seen = new Set<string>();
    return all.filter((x) => !seen.has(x.kind) && seen.add(x.kind)).slice(0, 3);
  }
  function sideHtml(t: TaskState): string {
    if (g().__isSideBySide?.()) return `<div class="sl-row sl-se-side"><span class="sl-hint">Three scans side by side</span><button class="sl-se-side-off" title="Put the slice views back as they were">One scan again</button></div>`;
    const sc = sideScans(t);
    if (sc.length < 2) return "";
    return `<div class="sl-row sl-se-side"><button class="sl-se-side-on" title="Show ${sc.map((x) => escapeHtml(x.name || x.kind)).join(", ")} in the three slice views, the same slice in each, moving together; paint in any of them">Side by side: ${sc.map((x) => shortKind(x.kind)).join(" · ")}</button></div>`;
  }
  async function sideBySideOn() {
    const sc = sideScans(tState());
    const imageOf = (uid: string) => [...live.nodes.values()].find((n) => n.type === "image" && !n.labelmap && ((n.origin ?? {}) as Obj).seriesInstanceUID === uid)?.id as string | undefined;
    const missing = sc.filter((x) => !imageOf(x.uid)).map((x) => x.uid);
    if (missing.length) {
      status(`Side by side: loading ${missing.length} scan${missing.length === 1 ? "" : "s"}…`);
      const r = await g().__loadDatabaseSeries?.(missing, (line) => status(`Side by side: ${line}`), { afterLoad: false });
      if (r?.failures.length) status(`Side by side: ${r.failures.join("; ")}`);
    }
    const ids = sc.map((x) => imageOf(x.uid)).filter((x): x is string => !!x);
    if (ids.length < 2) { status("Side by side: fewer than two of the scans could be shown"); render(); return; }
    // THE THREE SLICE VIEWS ON SCREEN: a layout that does not show all three (One-Up) becomes Four-Up, the default, and
    // comes back with "One scan again".
    const lid = g().__layoutId, shown = new Set(layoutOf(lid ?? 3).cells.map((c) => c.view));
    if (!["Red", "Yellow", "Green"].every((v) => shown.has(v)) && g().__setLayout) { layoutBefore = lid ?? null; g().__setLayout!(3); await new Promise((r) => setTimeout(r, 300)); }
    g().__sideBySide?.(ids, "axial");
    status(`Side by side: ${sc.filter((x) => imageOf(x.uid)).map((x) => x.name || x.kind).join(" · ")} — a scroll in one moves all three`);
    render();
  }
  function listHtml(): string {
    const t = tState(), ts = offered(t), segs = segsOf(segId);
    const others = segs.filter((x) => !ts.some((y) => sameStructure(x, y)));
    const q = filter.trim().toLowerCase(), hit = (n: string) => !q || n.toLowerCase().includes(q);
    const searchable = ts.length + others.length > 8 || (t.task === "anatomy" && !t.region);
    const swatch = (rgb: number[]) => `<span class="sl-seg-swatch" style="background:rgb(${rgb.map((c) => Math.round(c)).join(",")})"></span>`;
    const eye = (x: Seg) => `<button data-vis="${x.labelValue}" title="${x.visible === false ? "Hidden — click to show" : "Showing — click to hide"}">${eyeSvg(x.visible === false ? "hidden" : "shown")}</button>`;
    // A PART OF ANOTHER STRUCTURE (the tumor's Enhancing and Non-enhancing) sits indented under it; that one's eye shows or
    // hides its parts too.
    const kid = (x: Seg) => ts.find((y) => sameStructure(x, y))?.partOf ? " sl-se-kid" : "";
    const segRow = (x: Seg) => `<div class="sl-se-srow${kid(x)}${!pending && x.labelValue === active ? " sl-chosen" : ""}" data-seg="${x.labelValue}" role="option">${swatch((x.color ?? [0.8, 0.8, 0.8]).map((c) => c * 255))}<span class="sl-seg-name">${escapeHtml(x.name ?? `Segment ${x.labelValue}`)}</span>${eye(x)}</div>`;
    const taskRow = (y: TaskStructure) => {
      const x = segs.find((z) => sameStructure(z, y));
      if (x) return segRow(x);
      const why = y.partOf && t.postContrast ? ` · offered because “${t.postContrast.name}” is a post-contrast scan of the same day (${t.postContrast.how})` : "";
      return `<div class="sl-se-srow${y.partOf ? " sl-se-kid" : ""}${pending?.key === y.key ? " sl-chosen" : ""}" data-key="${escapeHtml(y.key)}" role="option" title="${pending?.key === y.key ? "Chosen: the tools paint it" : "Click to paint it"}${escapeHtml(why)}">${swatch(y.rgb)}<span class="sl-seg-name">${escapeHtml(y.name)}</span><span class="sl-hint">empty</span></div>`;
    };
    const mine = ts.filter((y) => hit(y.name)).map(taskRow).join("");
    const rest = others.filter((x) => hit(x.name ?? ""));
    const also = !rest.length ? "" : ts.length
      ? `<div class="sl-se-also" data-also="1">${alsoOpen || q || rest.some((x) => !pending && x.labelValue === active) ? "▾" : "▸"} Also in this segmentation <span class="sl-hint">${rest.length}</span></div>${alsoOpen || q || rest.some((x) => !pending && x.labelValue === active) ? rest.map(segRow).join("") : ""}`
      : rest.map(segRow).join("");
    // A name typed that the task does not offer: the General Anatomy list's structures of that name.
    const more = q ? allStructures().filter((y) => hit(y.name) && !ts.some((z) => z.key === y.key) && !segs.some((z) => sameStructure(z, y))).slice(0, 12) : [];
    const found = more.length ? `<div class="sl-hint sl-se-from">From the General Anatomy list</div>${more.map(taskRow).join("")}` : "";
    const own = t.task === "own" || (!ts.length && !segs.length) ? `<div class="sl-se-srow" data-new="1" role="option" title="Add a structure and name it yourself">+ New structure</div>` : "";
    const empty = !mine && !also && !found && !own ? `<div class="sl-hint" style="padding:4px 8px">${t.task === "anatomy" && !t.region ? "Choose Where above, or type a structure's name" : "Nothing of that name"}</div>` : "";
    return `${searchable ? `<input type="search" class="sl-search sl-se-find" placeholder="Type to find a structure" value="${escapeHtml(filter)}">` : ""}
      <div class="sl-se-list" role="listbox" aria-label="Structures">${mine}${also}${found}${own}${empty}</div>`;
  }

  function render() {
    if (!root) return;
    const n = node();
    if (segId && !n) segId = "";
    const segs = segsOf(segId);
    if (segs.length && !pending && !segs.some((s) => s.labelValue === active)) active = segs[0].labelValue;
    if (segId && !taskOf.has(segId)) void resolveTask(segId);
    // Over one structure that is the one painted, or gone: back to anything, said where the person looks.
    if (over === "segment" && (overSeg === active || !segs.some((s) => s.labelValue === overSeg))) { over = "all"; status("“over” is back to anything: a structure cannot be painted over itself"); }
    const edited = n?.edited === true;
    const o = (n?.origin ?? {}) as Obj;
    // A segmentation made here has no original: its words say so (critic 2026-10-31, finding 7).
    const madeHere = o.madeHere === true || (!o.seriesInstanceUID && !o.editedFrom && !o.savedSeriesInstanceUID);
    const saveWords = !segId ? "" : madeHere
      ? (edited ? (o.editedCopy ? `Changed since it was saved. Save updates “${escapeHtml(String(n?.name ?? ""))}” in the database.` : `Not saved yet. Save puts “${escapeHtml(String(n?.name ?? ""))}” in the database.`) : o.editedCopy ? "Saved in the database." : "Nothing painted yet.")
      : edited
      ? (o.editedCopy ? `Edited, not saved. Save updates “${escapeHtml(String(n?.name ?? ""))}”, the edited copy; the original stays.` : "Edited, not saved. Save writes a new series named “…, edited” with the date and time; the original stays in the database, unchanged.")
      : (o.editedCopy ? "Saved — the edited copy is in the database, beside the original." : "No changes to save.");
    const u = (undo.get(segId) ?? []).length, rd = (redo.get(segId) ?? []).length;
    root.innerHTML = `<h2>Segment Editor</h2>`;
    const ed = shell.section(root, "Editing", { open: true, band: "green" });
    const overName = over === "segment" ? (segsOf(segId).find((x) => x.labelValue === overSeg)?.name ?? `Segment ${overSeg}`) : "";
    ed.innerHTML = `<div class="sl-row">${picker()}</div>${segId ? taskHtml() + listHtml() : ""}
      ${segId && over !== "all" ? `<p class="sl-hint sl-se-overnote">Paints only ${over === "segment" ? `over ${escapeHtml(overName)}` : over === "none" ? "empty voxels" : "over the structures shown"} — change under Advanced</p>` : ""}
      ${segId ? `<details class="sl-se-adv"><summary>Advanced</summary><div class="sl-row"><span>Paint over</span><select class="sl-se-over" title="What the tools may write over">${overOptions()}</select></div>
        <div class="sl-row"><button class="sl-seg-new" title="Add a structure and name it yourself">+ New structure</button></div></details>` : ""}`;
    const tl = shell.section(root, "Tools", { open: true, band: "yellow" });
    const tool = toolOf(chosen);
    // POINTER FIRST (Ron, 2026-10-31: "It would be nice to have a pointer mode (like in slicer) if I want to rotate the
    // skull in 3d"): no tool on, so a drag turns the 3D view and the slices move as without the editor. Slicer's Segment
    // Editor has the arrow first among its effects for the same reason. Pressing the chosen tool again does the same.
    tl.innerHTML = `<div class="sl-se-tools" role="toolbar"><button class="sl-se-tool${chosen ? "" : " sl-chosen"}" data-tool="" title="Pointer: no tool on -- drag to turn the 3D view, scroll and move the slices as usual. What a tool shows and you changed (Threshold's preview) is kept, as when you press the tool again"><b>↖</b>Pointer</button>${segTools().map((t) => `<button class="sl-se-tool${t.id === chosen ? " sl-chosen" : ""}" data-tool="${t.id}" title="${escapeHtml(t.tip)}${t.shortcut ? ` (${t.shortcut.toUpperCase()})` : ""}"${segId || t.id === "outline" ? "" : " disabled"}><b>${t.icon}</b>${escapeHtml(t.label)}</button>`).join("")}</div>
      <div class="sl-se-tool-area"></div>
      <div class="sl-row"><button class="sl-se-undo"${u || sess ? "" : " disabled"} title="Put back the segmentation as it was before the last change">↶ Undo</button><button class="sl-se-redo"${rd && !sess ? "" : " disabled"} title="Do the undone change again">↷ Redo</button><span class="sl-hint">${u ? `${u} change${u === 1 ? "" : "s"}` : ""}</span></div>`;
    const area = tl.querySelector<HTMLElement>(".sl-se-tool-area")!;
    const cheats = tool?.cheats?.(ctx) ?? [];
    if (cheats.length) area.insertAdjacentHTML("afterend", `<dl class="sl-se-cheats" aria-label="Mouse and keys">${cheats.map((c) => `<dt title="${escapeHtml(c.tip)}">${escapeHtml(c.keys)}</dt><dd title="${escapeHtml(c.tip)}">${escapeHtml(c.does)}</dd>`).join("")}</dl>`);
    syncPaintLimits();
    if (tool) tool.mount(area, ctx); else area.innerHTML = segId ? `<p class="sl-hint">No tool on: drag in the 3D view to turn it. Pick a tool to edit.</p>` : `<p class="sl-hint">Choose a segmentation above, or press Edit on one in Segmentations.</p>`;
    const sv = shell.section(root, "Save", { open: true, band: "yellow" });
    sv.innerHTML = `<p class="sl-hint">${sess ? "A tool's preview is shown: Put it in, or Cancel, before saving." : saveWords}</p>
      <div class="sl-row sl-actions">${segId && o.editedCopy ? `<button class="sl-se-saveas" title="Keep the edited copy as it is and write these edits as another new series"${sess ? " disabled" : ""}>Save as a new series</button>` : ""}<button class="sl-se-save${edited && !sess ? " sl-primary" : ""}"${segId && !sess ? "" : " disabled"}>Save</button></div>`;

    const $ = <T extends HTMLElement>(q: string) => root!.querySelector(q) as T;

    $<HTMLSelectElement>(".sl-seg-pick").addEventListener("change", async (e) => {
      const v = (e.target as HTMLSelectElement).value;
      await leaveTool(); chosen = "";
      if (v.startsWith("new:")) {
        const r = await g().__createSegmentation(v.slice(4)); segId = r.segId; active = r.segment;
        // EMPTY, NOT "Segment_1": the task's list says what to paint, and its first row is made when a tool starts.
        live.write({ op: "patch", id: segId, path: "#/segments", value: [] });
        status("A new segmentation, empty");
      }
      else { segId = v; active = segsOf(v)[0]?.labelValue ?? 1; }
      filter = ""; pending = null; if (taskOf.has(segId)) firstRow(); render();
    });
    root.querySelector<HTMLDetailsElement>(".sl-se-task")?.addEventListener("toggle", (e) => { taskOpen = (e.currentTarget as HTMLDetailsElement).open; });
    root.querySelector(".sl-se-side-on")?.addEventListener("click", () => { void sideBySideOn(); });
    root.querySelector(".sl-se-side-off")?.addEventListener("click", () => {
      g().__sideBySide?.(null);
      if (layoutBefore !== null) { g().__setLayout?.(layoutBefore); layoutBefore = null; }
      status("One scan again: the slice views as they were"); render();
    });
    const setTask = (f: (t: TaskState) => void) => { const t = { ...tState() }; f(t); t.why = ""; taskOf.set(segId, t); keepTask(t); filter = ""; firstRow(); render(); };
    root.querySelectorAll<HTMLButtonElement>("[data-task]").forEach((b) => b.addEventListener("click", () => setTask((t) => { t.task = b.dataset.task as Task; })));
    root.querySelectorAll<HTMLButtonElement>("[data-region]").forEach((b) => b.addEventListener("click", () => setTask((t) => { t.region = b.dataset.region as ClinicalRegion; })));
    root.querySelectorAll<HTMLElement>(".sl-se-srow").forEach((el) => el.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("[data-vis]")) return; pickRow(el); }));
    root.querySelector<HTMLElement>("[data-also]")?.addEventListener("click", () => { alsoOpen = !alsoOpen; render(); });
    root.querySelector<HTMLSelectElement>(".sl-se-over")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v.startsWith("seg:")) { over = "segment"; overSeg = Number(v.slice(4)); } else over = v as OverwriteMode;
      syncPaintLimits(); toolOf(chosen)?.retarget?.(ctx);
    });
    root.querySelectorAll<HTMLButtonElement>(".sl-se-tool").forEach((b) => b.addEventListener("click", () => void (b.dataset.tool ? choose(b.dataset.tool) : pointer())));
    const find = root.querySelector<HTMLInputElement>(".sl-se-find");
    find?.addEventListener("input", () => { filter = find.value; const at = find.selectionStart; render(); const f2 = root!.querySelector<HTMLInputElement>(".sl-se-find"); f2?.focus(); if (at !== null) f2?.setSelectionRange(at, at); });
    root.querySelector<HTMLElement>(".sl-seg-new")?.addEventListener("click", () => { if (!segId) return; active = g().__addSegment(segId); pending = null; retargetTool(); render(); });
    root.querySelectorAll<HTMLElement>("[data-vis]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const lv = Number(b.dataset.vis); const segs = segsOf(segId), x = segs.find((v) => v.labelValue === lv); const show = x?.visible === false;
      g().__setSegmentProp(segId, lv, "visible", show);
      // Tumor's eye shows or hides its parts too.
      const ts = offered(), key = x ? ts.find((y) => sameStructure(x, y))?.key : undefined;
      if (key) for (const k of ts.filter((y) => y.partOf === key)) { const p = segs.find((v) => sameStructure(v, k)); if (p) g().__setSegmentProp(segId, p.labelValue, "visible", show); }
      render(); }));
    $(".sl-se-undo").addEventListener("click", () => step(undo, redo));
    $(".sl-se-redo").addEventListener("click", () => step(redo, undo));
    const save = (asNew: boolean) => (b: HTMLButtonElement) => b.addEventListener("click", () => void runAction(b, async () => {
      // THE BRUSH GOES OFF WITH THE SAVE: left on, the next click in a slice view painted again and the segmentation
      // was "edited since it was saved" the moment after it was saved.
      if (g().__segTool?.().activeEffect) g().__setSegTool(segId, "", {});
      // STRUCTURES STILL EMPTY ARE LEFT OUT OF THE FILE (Ron, 2026-10-31: "yes"): a tumor saved without its necrosis carries
      // no empty Necrosis. They stay in the segmentation on screen (critic 2026-10-31, finding 3: removed from it, a Redo
      // then brought back voxels no structure named, and the next structure made took that label and them).
      const counts = await g().__segmentStats(segId);
      const emptyOnes = new Set(counts.filter((x) => !x.voxels).map((x) => x.labelValue));
      if (emptyOnes.size && emptyOnes.size === counts.length) throw new Error("nothing painted yet");
      const all = segsOf(segId);
      if (emptyOnes.size) live.write({ op: "patch", id: segId, path: "#/segments", value: all.filter((x) => !emptyOnes.has(x.labelValue)) });
      let r: Awaited<ReturnType<Hooks["__saveEditedSegmentation"]>>;
      try { r = await g().__saveEditedSegmentation(segId, { asNew }); }
      finally { if (emptyOnes.size && live.nodes.has(segId)) live.write({ op: "patch", id: segId, path: "#/segments", value: all }); }
      if (!r.ok) throw new Error(r.error ?? "not saved");
      status(`Saved: “${r.name}”${r.kept ? ` — ${r.kept}` : ""}${emptyOnes.size ? ` — ${emptyOnes.size} empty structure${emptyOnes.size === 1 ? "" : "s"} left out` : ""}`);
      render();
    }, { busyLabel: "Saving…", doneLabel: "Saved", failedLabel: "Not saved" }).catch(() => {}));
    save(false)($<HTMLButtonElement>(".sl-se-save"));
    const sa = root.querySelector<HTMLButtonElement>(".sl-se-saveas"); if (sa) save(true)(sa);
  }

  // A click in a view for the chosen tool (live-views onToolPick -> slicer-app -> here).
  Object.assign(globalThis, {
    __segToolPick: (tool: string, ras: [number, number, number], sign: 1 | -1, remove?: boolean) => { const t = toolOf(chosen); if (t?.pick && t.id === tool) t.pick(ras, sign, ctx, remove); },
    __segToolStroke: (tool: string, stroke: ToolStroke, sign: 1 | -1) => { const t = toolOf(chosen); if (t?.stroke && t.id === tool) t.stroke(stroke, sign, ctx); },
    // Shift+wheel over a slice (live-views onBrushStep), and what a stroke wrote (slicer-app onNativePaintCommit).
    __segBrushStep: (dir: 1 | -1) => brushStep(dir),
    __segPainted: (id: string) => saidPainted(id),
    // The scan of the slice view the brush is over (live-views onViewScan): the limit's row follows it.
    __segViewScan: (id: string) => { if (id === viewScanId) return; viewScanId = id; if (!brushScans.has(id)) readScan(id); else { syncPaintLimits(); if (brushOn()) render(); } },
  });
  // Keys while the editor is on screen and no text field or dialog has the focus: the chosen tool's (Enter, Esc), then
  // a tool's letter (T for Threshold).
  addEventListener("keydown", (e) => {
    if (!root?.isConnected || root.offsetParent === null || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable || (!root.contains(a) && a.tagName !== "CANVAS"))) return;
    const t = toolOf(chosen);
    if (t?.onKey?.(e, ctx)) { e.preventDefault(); return; }
    if (brushOn() && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "−")) { e.preventDefault(); brushStep(e.key === "-" || e.key === "−" ? -1 : 1); return; }
    const k = segTools().find((x) => x.shortcut && x.shortcut === e.key.toLowerCase());
    if (k && segId) { e.preventDefault(); void choose(k.id); }
  });

  shell.registerPanel({
    id: "segment", title: "Segment Editor", groups: ["Segmentation"], order: 3,
    tip: "Change any segmentation by hand: paint, erase, threshold, smooth, islands",
    help: `<p>Changes a segmentation by hand. Choose which one at the top, or press <b>Edit</b> on its row in
      Segmentations. The others in the scene are left as they are.</p>
      <p><b>Paint</b> paints the structure chosen at the top with a brush on a slice; an Option-drag, or <b>Erase</b>,
      takes that structure away and leaves every other one as it is. Shift and the scroll wheel, or + and −, change the
      brush. The brush paints only where "over" allows (over one structure by name keeps it inside that structure), and
      only voxels between the two numbers, which start as the range last set in Threshold (Any: no limit). With
      <b>Adaptive</b> on, it paints only the voxels like the one under its center and joined to it, so it stops at an
      edge. The line under the views says what a stroke painted and what it left out, and why.</p>
      <p>Each tool lists its mouse and key actions under its controls; point at a line for more.</p>
      <p><b>Draw</b> outlines a region on one slice and fills it: click around the region, or drag to trace its edge;
      a double-click, Enter or a right-click fills it into the structure chosen above. Backspace takes the last point
      back, Esc drops the outline. An outline belongs to its slice: moving the slice, turning the view or choosing
      another tool or segmentation before it is filled clears it. Draw on the next slice to make the region thicker.</p>
      <p><b>Threshold</b> (T) keeps the voxels whose gray value lies between the two lines on the histogram. What it would
      write is drawn at once, on the slices and in 3D (the 3D view waits until a line stops moving). The scroll wheel zooms
      the histogram; a double-click shows the scan's useful range again. On a CT, Bone, Soft tissue, Fat and Air set the
      lines. With <b>Keep only the piece I click</b>, a click in any view keeps the connected piece under it, and a
      shift-click adds another; connections thinner than the size under Advanced are cut first. <b>Put into …</b> (Enter)
      replaces the structure's contents with what is shown, under the "over" choice at the top; Cancel (Esc) puts it back.</p>
      <p><b>Saving never changes the original.</b></p>
      <svg viewBox="0 0 420 150" width="100%" role="img" aria-label="How saving works">
        <g font-size="10" font-family="system-ui, sans-serif">
          <rect x="4" y="8" width="118" height="40" rx="5" fill="none" stroke="var(--sl-view-green)"/>
          <text x="12" y="23" fill="var(--sl-fg-muted)">IN THE DATABASE</text><text x="12" y="38" fill="var(--sl-fg)">the original</text>
          <line x1="122" y1="28" x2="150" y2="28" stroke="var(--sl-fg-dim)"/><text x="126" y="22" fill="var(--sl-fg-dim)">edit</text>
          <rect x="150" y="8" width="118" height="40" rx="5" fill="none" stroke="var(--sl-fg-dim)"/>
          <text x="158" y="23" fill="var(--sl-fg-muted)">IN THE SCENE</text><text x="158" y="38" fill="var(--sl-fg)">edited, not saved</text>
          <line x1="268" y1="28" x2="296" y2="28" stroke="var(--sl-fg-dim)"/>
          <rect x="296" y="14" width="80" height="28" rx="5" fill="var(--sl-accent)"/><text x="317" y="32" fill="var(--sl-accent-fg)" font-weight="700">Save</text>
          <line x1="336" y1="42" x2="336" y2="70" stroke="var(--sl-fg-dim)"/>
          <rect x="4" y="96" width="170" height="44" rx="5" fill="none" stroke="var(--sl-view-green)"/>
          <text x="12" y="112" fill="var(--sl-fg-muted)">IN THE DATABASE, UNCHANGED</text><text x="12" y="129" fill="var(--sl-fg)">the original</text>
          <rect x="196" y="70" width="220" height="70" rx="5" fill="none" stroke="var(--sl-view-green)"/>
          <text x="204" y="86" fill="var(--sl-fg-muted)">IN THE DATABASE, NEW</text><text x="204" y="102" fill="var(--sl-fg)">"…, edited 2026-09-25 10:14"</text>
          <text x="204" y="118" fill="var(--sl-fg-dim)">the next Save updates this copy;</text><text x="204" y="132" fill="var(--sl-fg-dim)">Save as a new series keeps it</text>
        </g>
      </svg>
      <p>The first save writes a new series named “…, edited” and the date and time; rename it with a double-click in
      Segmentations. Later saves update that edited copy; <b>Save as a new series</b> keeps it and writes another. A
      copy that a saved scene uses is kept either way.</p>
      <h4>Click to outline</h4>
      <p>Press <b>Click to outline</b>, then click inside a structure in a slice view or on it in 3D: it is outlined in
      3D. Each further click refines the same outline — a click where it missed adds, a <b>shift-click</b> where it
      spilled over takes away. The outline goes into the structure chosen beside the button (<b>Tumor</b> unless you
      choose another, or a new one); it replaces what the tool drew there with the last click, never another structure
      and never what you painted by hand. <b>Undo</b> takes back the last click; Esc or a right-click ends.</p>
      <p>It runs <b>nnLive</b> (Steve Pieper, <a href="https://github.com/pieper/nnLive">github.com/pieper/nnLive</a>), a
      smaller copy of <b>nnInteractive</b> (MIC-DKFZ, <a href="https://github.com/MIC-DKFZ/nnInteractive">github.com/MIC-DKFZ/nnInteractive</a>),
      on this computer's graphics card: nothing is sent anywhere. The model is fetched once (188 MB) the first time it
      is used. nnLive's own measurement: its outlines agree with nnInteractive's at about 0.74 Dice when refining.</p>
      <p><b>License:</b> the model is for academic, non-commercial use only (Creative Commons BY-NC-SA 4.0, inherited from
      nnInteractive); you are asked to agree once a session. The program code is Apache 2.0.</p>
      <p><b>Please cite</b> when you publish work that used it: Isensee F, Rokuss M, Krämer L, et al. nnInteractive:
      Redefining 3D Promptable Segmentation. 2025. <a href="https://arxiv.org/abs/2503.08373">arXiv:2503.08373</a></p>`,
    mount(el) { root = el; render(); },
  });
  live.subscribe((c) => { if ((c.type === "segmentation" || c.type === "image") && !quiet.has(String((c as { id?: string }).id ?? ""))) render(); });
  Object.assign(globalThis, { __segEditorRender: () => render() });
  // Esc ends Click to outline, as it ends placing a markup.
  addEventListener("keydown", (e) => { if (e.key === "Escape" && String(g().__segTool?.().activeEffect).toLowerCase() === "clickoutline") g().__clickOutlineEnd(); });
}
