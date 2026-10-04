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
// The effects themselves are unchanged (logic/segmentation-editor.ts).
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";
import { lookupStructure } from "../../logic/segment-naming.ts";
import { invalidatePaintCache } from "../../logic/segmentation-editor.ts";
import { defaultTarget } from "../../logic/click-outline.ts";

interface Hooks {
  __createSegmentation: (sourceImageId: string, name?: string) => Promise<{ segId: string; segment: number }>;
  __addSegment: (segId: string) => number;
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

/** The voxel size of a volume (the smallest spacing), from its ijkToRAS. */
function spacingOf(img: Obj | undefined): number {
  const m = img?.ijkToRAS as number[] | undefined;
  if (!m || m.length < 12) return 1;
  const col = (j: number) => Math.hypot(m[j], m[4 + j], m[8 + j]);
  return Math.min(col(0), col(1), col(2)) || 1;
}

export function registerSegEditorPanel(shell: AppShell, opts: { live: LiveScene; store: LocalBlobStore; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  let segId = "", active = 1, filter = "";
  const openGroups = new Set<string>();
  let brushVox = 14;
  /** Click to outline's structure, per segmentation: a label value, "tumor" (a Tumor structure to be made) or "new". */
  const clickInto = new Map<string, number | "tumor" | "new" | "newseg">();
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  const node = () => (segId ? live.nodes.get(segId) : undefined) as Obj | undefined;
  const segsOf = (id: string) => ((live.nodes.get(id)?.segments as Seg[] | undefined) ?? []);
  const sourceOf = (id: string) => live.nodes.get((((live.nodes.get(id)?.refs as Record<string, string[]> | undefined)?.source) ?? [])[0] ?? "") as Obj | undefined;

  // ── undo / redo: the segmentation's list of stored pieces before each edit ──
  const lastZarr = new Map<string, string>();
  const undo = new Map<string, string[]>(), redo = new Map<string, string[]>();
  let restoring = false, burstFrom = "", burstTimer: number | undefined;
  live.subscribe((c) => {
    const id = (c as { id?: string }).id;
    if (!id || (c as { type?: string }).type !== "segmentation") return;
    const n = live.nodes.get(id); if (!n?.zarr) { lastZarr.delete(id); return; }
    const now = JSON.stringify(n.zarr), before = lastZarr.get(id);
    lastZarr.set(id, now);
    if (before === undefined || before === now || restoring) return;
    // One stroke writes several times (the paint is throttled): the step is the state before the first write of a burst.
    if (burstFrom !== id + "|") {
      const u = undo.get(id) ?? []; u.push(before); if (u.length > 40) u.shift(); undo.set(id, u); redo.set(id, []);
      burstFrom = id + "|";
    }
    clearTimeout(burstTimer); burstTimer = setTimeout(() => { burstFrom = ""; render(); }, 700) as unknown as number;
  });
  const step = (from: Map<string, string[]>, to: Map<string, string[]>) => {
    const n = node(); if (!n) return;
    const list = from.get(segId) ?? []; const prev = list.pop(); if (!prev) return;
    (to.get(segId) ?? to.set(segId, []).get(segId)!).push(JSON.stringify(n.zarr));
    restoring = true;
    // The brush keeps its own copy of the labels while painting (logic/segmentation-editor.ts paintCache): drop it, or
    // the next stroke paints onto the undone state and brings it back.
    invalidatePaintCache(segId);
    try { live.write({ op: "patch", id: segId, path: "#/zarr", value: JSON.parse(prev) }); live.write({ op: "patch", id: segId, path: "#/edited", value: true }); }
    finally { restoring = false; lastZarr.set(segId, prev); }
    render();
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
    status(name === "growFromSeeds" ? "Growing from the strokes…" : `${name}…`);
    const r = await g().__applyEffect(id, name, { segment: active, ...params });
    const said = name === "growFromSeeds" ? "Grown from the strokes" : name;
    status(`${said}: ${r.voxels.toLocaleString()} voxels${r.threshold !== undefined ? ` (threshold ${r.threshold.toFixed(0)})` : ""}${r.ms !== undefined ? ` in ${(r.ms / 1000).toFixed(1)} s` : ""}`);
    render();
  }
  /** Every effect button reports on itself (Ron, 2026-09-22: "immediate visual feedback … for every button"). */
  const onEffect = (b: HTMLButtonElement, name: string, params: () => Record<string, unknown>) =>
    b.addEventListener("click", () => void runAction(b, () => effect(name, params()), { busyLabel: "Working…", doneLabel: "Done ✓", failedLabel: "Failed" }).catch(() => {}));

  // Opened from the Segmentations module's Edit button, on THAT segmentation.
  g().__editSegmentation = (id: string) => {
    if (!live.nodes.has(id)) return;
    segId = id; filter = "";
    const segs = segsOf(id); active = segs[0]?.labelValue ?? 1;
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

  function structures(): string {
    const segs = segsOf(segId);
    if (!segs.length) return `<p class="sl-hint">${segId ? "No structures yet — New structure adds one." : "Choose a segmentation above, or press Edit on one in Segmentations."}</p>`;
    const q = filter.trim().toLowerCase();
    const bySys = new Map<string, Seg[]>();
    for (const s of segs) {
      if (q && !(s.name ?? "").toLowerCase().includes(q)) continue;
      const sys = lookupStructure(s.structure ?? s.name)?.system ?? "Other";
      (bySys.get(sys) ?? bySys.set(sys, []).get(sys)!).push(s);
    }
    const one = bySys.size === 1;
    return [...bySys.entries()].map(([sys, list]) => {
      const open = one || !!q || openGroups.has(sys) || list.some((s) => s.labelValue === active);
      return `<div class="sl-se-group"><div class="sl-se-group-h" data-group="${escapeHtml(sys)}">${open ? "▾" : "▸"} ${escapeHtml(sys)} <span class="sl-hint">${list.length}</span></div>${open ? list.map((s) =>
        `<div class="sl-seg-row${s.labelValue === active ? " sl-active" : ""}" data-seg="${s.labelValue}"><span class="sl-seg-swatch" style="background:rgb(${(s.color ?? [0.8, 0.8, 0.8]).map((c) => Math.round(c * 255)).join(",")})"></span><span class="sl-seg-name">${escapeHtml(s.name ?? `Segment ${s.labelValue}`)}</span><button data-vis="${s.labelValue}" title="Show or hide">${s.visible === false ? "🚫" : "👁"}</button></div>`).join("") : ""}</div>`;
    }).join("");
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
    if (want !== "new") g().__setSegmentProp(id, v, "name", "Tumor");
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
      g().__setSegmentProp(segId, r.segment, "name", "Tumor");
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

  function render() {
    if (!root) return;
    const n = node();
    if (segId && !n) segId = "";
    const segs = segsOf(segId);
    if (segs.length && !segs.some((s) => s.labelValue === active)) active = segs[0].labelValue;
    const sp = segId ? spacingOf(sourceOf(segId)) : 1;
    const edited = n?.edited === true;
    const o = (n?.origin ?? {}) as Obj;
    const tool = g().__segTool?.() ?? { activeEffect: "", diameterMm: 8, sphere: false };
    const saveWords = !segId ? "" : edited
      ? (o.editedCopy ? `Edited, not saved. Save updates “${escapeHtml(String(n?.name ?? ""))}”, the edited copy; the original stays.` : "Edited, not saved. Save writes a new series named “…, edited” with the date and time; the original stays in the database, unchanged.")
      : (o.editedCopy ? "Saved — the edited copy is in the database, beside the original." : "No changes to save.");
    const u = (undo.get(segId) ?? []).length, rd = (redo.get(segId) ?? []).length;
    root.innerHTML = `<h2>Segment Editor</h2>`;
    const ed = shell.section(root, "Editing", { open: true, band: "yellow" });
    ed.innerHTML = `<div class="sl-row">${picker()}</div>`;
    const st = shell.section(root, "Structures", { open: true, band: "green", note: segs.length ? String(segs.length) : "" });
    st.innerHTML = `<div class="sl-row"><input type="search" class="sl-search sl-se-find" placeholder="" title="Type a structure's name" value="${escapeHtml(filter)}"><button class="sl-seg-new" title="Add a structure to this segmentation">+ Structure</button></div><div class="sl-seg-list">${structures()}</div>`;
    const tl = shell.section(root, "Tools", { open: true, note: segs.length ? `acting on: ${escapeHtml(segs.find((s) => s.labelValue === active)?.name ?? "")}` : "" });
    tl.innerHTML = `
      <div class="sl-row"><button class="sl-eff-paint${tool.activeEffect === "paint" ? " sl-primary" : ""}">Paint</button><button class="sl-eff-erase${tool.activeEffect === "erase" ? " sl-primary" : ""}">Erase</button><label><input type="checkbox" class="sl-brush-sphere"${tool.sphere ? " checked" : ""}> Sphere</label></div>
      <div class="sl-row"><label>Brush</label><input class="sl-brush-vox" type="range" min="1" max="60" step="1" value="${brushVox}"><span class="sl-brush-v">${brushVox} voxels</span></div>
      <div class="sl-row"><span class="sl-hint sl-brush-mm">≈ ${(brushVox * sp).toFixed(1)} mm on this ${sp.toFixed(2)} mm grid</span></div>
      <div class="sl-row"><button class="sl-se-undo"${u ? "" : " disabled"} title="Put back the segmentation as it was before the last change">↶ Undo</button><button class="sl-se-redo"${rd ? "" : " disabled"} title="Do the undone change again">↷ Redo</button><span class="sl-hint">${u ? `${u} change${u === 1 ? "" : "s"}` : ""}</span></div>
      <div class="sl-row"><label>Threshold</label><input class="sl-th-lo" type="number" placeholder="low" style="width:70px"><input class="sl-th-hi" type="number" placeholder="high" style="width:70px"><button class="sl-eff-th">Apply</button><button class="sl-eff-auto">Auto</button></div>
      <div class="sl-row"><label>Islands</label><button class="sl-eff-largest" title="Keep the largest connected piece of this structure; remove the rest">Keep largest</button><button class="sl-eff-small" title="Remove pieces smaller than 10 voxels">Remove small</button></div>
      <div class="sl-row"><label>Smoothing</label><button class="sl-eff-median">Median</button><button class="sl-eff-open">Open</button><button class="sl-eff-close">Close</button></div>
      <div class="sl-row"><label>Margin (voxels)</label><input class="sl-margin" type="number" value="2" step="1" style="width:48px" title="How far to grow or shrink, in voxels of this volume"><button class="sl-eff-grow">Grow</button><button class="sl-eff-shrink">Shrink</button></div>
      <div class="sl-row"><label>By clicking</label><button class="sl-eff-click${String(tool.activeEffect).toLowerCase() === "clickoutline" ? " sl-primary" : ""}" title="Click inside a structure in any view and it is outlined in 3D; click again to add, shift-click to take away. Esc or a right-click ends. Academic, non-commercial use (nnLive, from nnInteractive). More in Help.">Click to outline</button><select class="sl-click-into" title="The structure the outline goes into. Further clicks refine the same one.">${clickOptions()}</select></div>
      <div class="sl-row"><label>From strokes</label><button class="sl-eff-seeds" title="Fills each structure out to its edges from a few painted strokes. Paint strokes inside the structure, and with a second segment in what surrounds it, then press. Every segment shown takes part, and everything around the strokes becomes one of them; hide the segments that should stay as they are (the eye). Undo puts the strokes back.">Grow from seeds</button></div>
      <details class="sl-advanced"><summary>Advanced</summary>
        <div class="sl-row"><label>Logical (label no.)</label><input class="sl-other" type="number" value="2" step="1" style="width:60px"><button class="sl-eff-union">∪</button><button class="sl-eff-sub">−</button><button class="sl-eff-int">∩</button></div>
        <div class="sl-row"><button class="sl-eff-stats">Statistics</button></div><div class="sl-seg-stats"></div>
      </details>`;
    if (!segId) tl.querySelectorAll<HTMLButtonElement>("button:not(.sl-eff-click)").forEach((b) => { b.disabled = true; b.title = "Choose a segmentation at the top first"; });
    const sv = shell.section(root, "Save", { open: true, band: "yellow" });
    sv.innerHTML = `<p class="sl-hint">${saveWords}</p>
      <div class="sl-row sl-actions">${segId && o.editedCopy ? `<button class="sl-se-saveas" title="Keep the edited copy as it is and write these edits as another new series">Save as a new series</button>` : ""}<button class="sl-se-save${edited ? " sl-primary" : ""}"${segId ? "" : " disabled"}>Save</button></div>`;

    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    const num = (s: string) => Number(($(s) as HTMLInputElement).value);
    const syncTool = () => { const cur = g().__segTool?.(); if (cur && cur.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: brushVox * sp, sphere: cur.sphere, segment: active }); };

    $<HTMLSelectElement>(".sl-seg-pick").addEventListener("change", async (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v.startsWith("new:")) { const r = await g().__createSegmentation(v.slice(4)); segId = r.segId; active = r.segment; status("A new segmentation, empty"); }
      else { segId = v; active = segsOf(v)[0]?.labelValue ?? 1; }
      filter = ""; syncTool(); render();
    });
    const find = $<HTMLInputElement>(".sl-se-find");
    find.addEventListener("input", () => { filter = find.value; const at = find.selectionStart; render(); const f2 = root!.querySelector<HTMLInputElement>(".sl-se-find"); f2?.focus(); if (at !== null) f2?.setSelectionRange(at, at); });
    $(".sl-seg-new").addEventListener("click", async () => { if (!segId) { await ensureSeg(); return; } active = g().__addSegment(segId); syncTool(); render(); });
    root.querySelectorAll<HTMLElement>(".sl-se-group-h").forEach((h) => h.addEventListener("click", () => { const k = h.dataset.group!; if (openGroups.has(k)) openGroups.delete(k); else openGroups.add(k); render(); }));
    root.querySelectorAll<HTMLElement>(".sl-seg-row").forEach((el) => el.addEventListener("click", (e) => { if ((e.target as HTMLElement).dataset.vis) return; active = Number(el.dataset.seg); syncTool(); render(); }));
    root.querySelectorAll<HTMLElement>("[data-vis]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); const lv = Number(b.dataset.vis); const s = segsOf(segId).find((x) => x.labelValue === lv); g().__setSegmentProp(segId, lv, "visible", s?.visible === false); render(); }));
    onEffect($(".sl-eff-th"), "threshold", () => ({ lower: num(".sl-th-lo"), upper: num(".sl-th-hi") }));
    onEffect($(".sl-eff-auto"), "autoThreshold", () => ({ autoMethod: "otsu" }));
    onEffect($(".sl-eff-largest"), "islands", () => ({ islands: "keepLargest" }));
    onEffect($(".sl-eff-small"), "islands", () => ({ islands: "removeSmall", minSize: 10 }));
    onEffect($(".sl-eff-median"), "smoothing", () => ({ smooth: "median", radiusVoxels: 1 }));
    onEffect($(".sl-eff-open"), "smoothing", () => ({ smooth: "open", radiusVoxels: 1 }));
    onEffect($(".sl-eff-close"), "smoothing", () => ({ smooth: "close", radiusVoxels: 1 }));
    onEffect($(".sl-eff-grow"), "margin", () => ({ marginMm: Math.abs(num(".sl-margin")) * sp }));
    onEffect($(".sl-eff-shrink"), "margin", () => ({ marginMm: -Math.abs(num(".sl-margin")) * sp }));
    onEffect($(".sl-eff-seeds"), "growFromSeeds", () => ({}));
    onEffect($(".sl-eff-union"), "logical", () => ({ logical: "union", other: num(".sl-other") }));
    onEffect($(".sl-eff-sub"), "logical", () => ({ logical: "subtract", other: num(".sl-other") }));
    onEffect($(".sl-eff-int"), "logical", () => ({ logical: "intersect", other: num(".sl-other") }));
    { const sb = $<HTMLButtonElement>(".sl-eff-stats"); sb.addEventListener("click", () => void runAction(sb, async () => { const stt = await g().__segmentStats(segId); $(".sl-seg-stats").innerHTML = stt.map((x) => `<div class="sl-hint">${escapeHtml(segsOf(segId).find((s) => s.labelValue === x.labelValue)?.name ?? `Segment ${x.labelValue}`)}: ${x.voxels.toLocaleString()} voxels, ${(x.volumeMm3 / 1000).toFixed(2)} mL</div>`).join(""); }, { busyLabel: "Counting…", doneLabel: "Done ✓" }).catch(() => {})); }
    const setTool = async (t: string) => { const id = await ensureSeg(); if (!id) return; if (String(g().__segTool().activeEffect).toLowerCase() === "clickoutline") g().__clickOutlineEnd(); const cur = g().__segTool().activeEffect; g().__setSegTool(id, cur === t ? "" : t, { diameterMm: brushVox * sp, sphere: ($(".sl-brush-sphere") as HTMLInputElement).checked, segment: active }); status(cur === t ? "Brush off" : `${t === "paint" ? "Paint" : "Erase"}: drag in a slice view`); render(); };
    // CLICK TO OUTLINE (render/click-outline-tool.ts): the button starts and ends it; changing "Into:" while it is on
    // moves it to that structure (Ron, 2026-10-03: "user defines the structure with tumor as default … option to have a
    // new structure").
    { const cb = $<HTMLButtonElement>(".sl-eff-click"); cb.addEventListener("click", () => void runAction(cb, clickOutlineToggle, { busyLabel: "Starting…", doneLabel: "", failedLabel: "Failed" }).catch((e) => status(`Click to outline: ${(e as Error).message ?? e}`))); }
    $<HTMLSelectElement>(".sl-click-into").addEventListener("change", async (e) => {
      const v = (e.target as HTMLSelectElement).value;
      clickInto.set(segId, v === "tumor" || v === "new" || v === "newseg" ? v : Number(v));
      if (String(g().__segTool?.().activeEffect).toLowerCase() === "clickoutline") {
        if (v === "newseg") { g().__clickOutlineEnd(); await clickOutlineToggle(); render(); return; }   // start over in a new one
        const target = clickTarget(segId); active = target;
        if (await g().__clickOutlineStart(segId, target)) g().__setSegTool(segId, "clickOutline", { segment: target });
      }
      render();
    });
    $(".sl-eff-paint").addEventListener("click", () => setTool("paint"));
    $(".sl-eff-erase").addEventListener("click", () => setTool("erase"));
    $(".sl-brush-vox").addEventListener("input", (e) => { brushVox = Number((e.target as HTMLInputElement).value); ($(".sl-brush-v") as HTMLElement).textContent = `${brushVox} voxels`; ($(".sl-brush-mm") as HTMLElement).textContent = `≈ ${(brushVox * sp).toFixed(1)} mm on this ${sp.toFixed(2)} mm grid`; syncTool(); });
    $(".sl-brush-sphere").addEventListener("change", () => { const cur = g().__segTool(); if (cur.activeEffect) g().__setSegTool(segId, cur.activeEffect, { diameterMm: brushVox * sp, sphere: ($(".sl-brush-sphere") as HTMLInputElement).checked, segment: active }); });
    $(".sl-se-undo").addEventListener("click", () => step(undo, redo));
    $(".sl-se-redo").addEventListener("click", () => step(redo, undo));
    const save = (asNew: boolean) => (b: HTMLButtonElement) => b.addEventListener("click", () => void runAction(b, async () => {
      // THE BRUSH GOES OFF WITH THE SAVE: left on, the next click in a slice view painted again and the segmentation
      // was "edited since it was saved" the moment after it was saved.
      if (g().__segTool?.().activeEffect) g().__setSegTool(segId, "", {});
      const r = await g().__saveEditedSegmentation(segId, { asNew });
      if (!r.ok) throw new Error(r.error ?? "not saved");
      status(`Saved: “${r.name}”${r.kept ? ` — ${r.kept}` : ""}`);
      render();
    }, { busyLabel: "Saving…", doneLabel: "Saved", failedLabel: "Not saved" }).catch(() => {}));
    save(false)($<HTMLButtonElement>(".sl-se-save"));
    const sa = root.querySelector<HTMLButtonElement>(".sl-se-saveas"); if (sa) save(true)(sa);
  }

  shell.registerPanel({
    id: "segment", title: "Segment Editor", groups: ["Segmentation"], order: 3,
    tip: "Change any segmentation by hand: paint, erase, threshold, smooth, islands",
    help: `<p>Changes a segmentation by hand. Choose which one at the top, or press <b>Edit</b> on its row in
      Segmentations. The others in the scene are left as they are.</p>
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
  live.subscribe((c) => { if (c.type === "segmentation" || c.type === "image") render(); });
  Object.assign(globalThis, { __segEditorRender: () => render() });
  // Esc ends Click to outline, as it ends placing a markup.
  addEventListener("keydown", (e) => { if (e.key === "Escape" && String(g().__segTool?.().activeEffect).toLowerCase() === "clickoutline") g().__clickOutlineEnd(); });
}
