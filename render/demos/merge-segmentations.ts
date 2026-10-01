/**
 * The Merge window: several segmentations of one volume become one new segmentation.
 *
 * Ron: "Moose does everything separate: abdominal organs, cardiac, digestive system. How do I merge
 * them once they are listed in segmentations?" And on the voxels two networks both claim: "it will
 * require user input at runtime."
 *
 * So: tick the segmentations, in the order that should win where nothing else is said; Find
 * overlaps counts, per pair of structures, the voxels both claim and puts a choice beside each;
 * Merge writes one labelmap and one segment list, as a NEW segmentation derived from the inputs.
 * The inputs stay. The logic is in logic/segmentation-merge.ts; this is the window.
 */
import { escapeHtml } from "./html.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { createSegmentationFromLabelmap } from "../../logic/segmentation-editor.ts";
import { countContested, findOverlaps, type MergeInput, mergeLabelmaps, type Overlap, overlapGeometry, type OverlapGeometry, overlapKey, sharedLabelmap, structureKey, type VoxelBox, type Winner } from "../../logic/segmentation-merge.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { runAction } from "./app-shell.ts";

type Vec3 = [number, number, number];
/** The review's one color scheme, for every pair (Ron: "one color scheme for all the comparisons"). */
const REVIEW_A: Vec3 = [224 / 255, 138 / 255, 60 / 255];     // the first segmentation's structure: orange
const REVIEW_B: Vec3 = [79 / 255, 143 / 255, 214 / 255];     // the second's: blue
const REVIEW_SHARED: Vec3 = [248 / 255, 215 / 255, 100 / 255]; // claimed by both: yellow, over the two
const FOUR_UP = 3;

/** ijk (voxel center) -> RAS through a row-major 4x4. */
const ijkToRas = (m: number[], p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
/** The RAS box around a voxel box (all eight corners, half a voxel out). */
const rasBoxOf = (m: number[], b: VoxelBox): [Vec3, Vec3] => {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of [b[0] - 0.5, b[3] + 0.5]) for (const j of [b[1] - 0.5, b[4] + 0.5]) for (const k of [b[2] - 0.5, b[5] + 0.5]) {
    const r = ijkToRas(m, [i, j, k]);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], r[a]); hi[a] = Math.max(hi[a], r[a]); }
  }
  return [lo, hi];
};
const unionBox = (a: VoxelBox, b: VoxelBox): VoxelBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];

export interface MergeRoot { id: string; name: string; sourceId?: string; segments: { labelValue: number; name?: string; color?: number[]; structure?: string }[] }

export interface MergeOptions {
  live: LiveScene;
  store: LocalBlobStore;
  roots: MergeRoot[];
  status: (s: string) => void;
  /** The new segmentation's id, once it is in the scene. */
  onMerged: (segId: string) => void;
}

const fmt = (n: number) => n.toLocaleString();

export function openMergeWindow(o: MergeOptions): void {
  // The window closing (its lights, or Escape) during a review would leave the app rearranged.
  let onWindowClose: (() => void) | undefined;
  const win = openFloatingWindow({ title: "Merge segmentations", size: { w: 820, h: 640 }, zIndex: 2100, onClose: () => onWindowClose?.() });
  const { box } = win;
  const body = document.createElement("div");
  body.className = "sl-merge";
  body.innerHTML = `
    <div class="sl-merge-scroll">
    <p class="sl-merge-lead">Tick the segmentations to combine. Where two of them claim the same voxel, the one marked <b>wins</b> keeps it — every pair below can still be decided the other way. The result is a new segmentation; these stay as they are.</p>
    <div class="sl-merge-list"></div>
    <div class="sl-merge-overlaps"></div>
    </div>
    <div class="sl-merge-foot">
      <span class="sl-merge-note"></span>
      <button class="sl-merge-find">Find overlaps</button>
      <button class="sl-merge-review" disabled title="Look at each pair in the slices and in 3D, one at a time, and decide">Review pairs…</button>
      <button class="sl-primary sl-merge-go" disabled>Merge</button>
    </div>`;
  box.appendChild(body);
  const q = <T extends Element>(sel: string) => body.querySelector(sel) as T;
  const listEl = q<HTMLElement>(".sl-merge-list"), overlapsEl = q<HTMLElement>(".sl-merge-overlaps"), note = q<HTMLElement>(".sl-merge-note");
  const findBtn = q<HTMLButtonElement>(".sl-merge-find"), goBtn = q<HTMLButtonElement>(".sl-merge-go"), reviewBtn = q<HTMLButtonElement>(".sl-merge-review");

  /**
   * Ticked, with the WINNER first: this is the priority. The winner is chosen with a radio on its
   * row, and defaults to the ticked segmentation with the FEWEST structures -- the specialist. Ron,
   * with ts:total (111) and ts:lung_vessels (4) ticked in that order and the window defaulting the
   * other way: "I am confused ... lung vessels replace every voxel where they are." A network that
   * segments four things has looked harder at them than one that segments a hundred and eleven,
   * so it wins by default; the radio says so and changes it in one click.
   */
  const order: string[] = [];
  let winner: string | undefined;
  let winnerChosen = false;   // by a click on the radio; until then the default is recomputed on every tick
  const structuresOf = (id: string) => o.roots.find((r) => r.id === id)?.segments.length ?? 0;
  /** Put the winner first; the rest keep their tick order. */
  const settle = () => {
    if (!winnerChosen || !winner || !order.includes(winner)) {
      winner = order.length ? [...order].sort((a, b) => structuresOf(a) - structuresOf(b))[0] : undefined;
      winnerChosen = false;
    }
    if (winner) { order.splice(order.indexOf(winner), 1); order.unshift(winner); }
  };
  let inputs: MergeInput[] | null = null;         // labelmaps in hand, in `order`
  let overlaps: Overlap[] | null = null;
  const decisions = new Map<string, Winner>();
  /** Structures dropped from the result entirely (structureKey). Set in the review. */
  const leaveOut = new Set<string>();

  const sourceOf = (id: string) => o.roots.find((r) => r.id === id)?.sourceId;
  const firstSource = () => order.length ? sourceOf(order[0]) : undefined;

  function paintList() {
    const src = firstSource();
    listEl.innerHTML = o.roots.map((r) => {
      const at = order.indexOf(r.id);
      const otherVolume = src !== undefined && r.sourceId !== src;
      const srcName = (o.live.nodes.get(r.sourceId ?? "")?.name as string | undefined) ?? "";
      // Two controls on one row, so two labels: the tick (checkbox, number, name) and, once two
      // are ticked, "wins" (radio). Not one label around both -- a click on the radio would toggle
      // the checkbox too.
      return `<div class="sl-merge-row${otherVolume ? " sl-merge-row-off" : ""}" title="${otherVolume ? "on a different volume than the first ticked — a merge needs one volume" : srcName ? `on ${srcName}` : ""}">
        <label class="sl-merge-tick">
          <input type="checkbox" data-id="${r.id}"${at >= 0 ? " checked" : ""}${otherVolume ? " disabled" : ""}>
          <span class="sl-merge-prio">${at >= 0 ? at + 1 : ""}</span>
          <span class="sl-merge-name">${escapeHtml(r.name)}</span>
        </label>
        ${at >= 0 && order.length >= 2 ? `<label class="sl-merge-wins" title="Where this and another claim the same voxel, this one keeps it"><input type="radio" name="sl-merge-winner" data-win="${r.id}"${r.id === winner ? " checked" : ""}> wins</label>` : ""}
        <span class="sl-merge-n">${r.segments.length} structure${r.segments.length === 1 ? "" : "s"}</span>
      </div>`;
    }).join("");
    listEl.querySelectorAll<HTMLInputElement>("input").forEach((c) => c.addEventListener("change", () => {
      const id = c.dataset.id!;
      if (c.checked) order.push(id); else order.splice(order.indexOf(id), 1);
      settle();
      inputs = null; overlaps = null; decisions.clear(); leaveOut.clear();
      paint();
    }));
    listEl.querySelectorAll<HTMLInputElement>("input[data-win]").forEach((rd) => rd.addEventListener("change", () => {
      winner = rd.dataset.win!; winnerChosen = true;
      settle();
      // The labelmaps in hand follow `order`, so a new winner means a new first input: the
      // overlaps are found again (cheap against the read) and every pair defaults to the winner.
      inputs = null; overlaps = null; decisions.clear(); leaveOut.clear();
      paint();
    }));
  }

  function paintOverlaps() {
    if (!overlaps) { overlapsEl.innerHTML = ""; return; }
    if (!overlaps.length) {
      overlapsEl.innerHTML = `<p class="sl-merge-ok">No voxel is claimed by more than one of these. Nothing to decide.</p>`;
      return;
    }
    const nameOf = (input: number, label: number) => inputs![input].segments.find((s) => s.labelValue === label)?.name ?? `label ${label}`;
    // Each voxel counted once, whatever the number of claims on it; the pair rows below can add up to
    // more than this when three inputs meet (critic, 2026-09-17, finding 12).
    const total = countContested(inputs!);
    overlapsEl.innerHTML = `<p class="sl-merge-lead"><b>${fmt(total)} voxels</b> are claimed by ${inputs!.length > 2 ? "more than one structure" : "two structures"}, in ${overlaps.length} pair${overlaps.length === 1 ? "" : "s"}. For each, which keeps them${inputs!.length > 2 ? " (with three or more inputs the decisions are applied in the order the inputs are listed, one pair at a time)" : ""}:</p>
      <div class="sl-merge-bulk">All to: ${inputs!.map((inp, i) => `<button data-all="${i}">${escapeHtml(inp.name)}</button>`).join(" ")}</div>
      <table class="sl-merge-table"><thead><tr><th class="sl-netb-num">voxels</th><th>from ${inputs!.length > 2 ? "the earlier" : escapeHtml(inputs![0].name)}</th><th></th><th>from ${inputs!.length > 2 ? "the later" : escapeHtml(inputs![1].name)}</th></tr></thead><tbody>` +
      overlaps.map((x) => {
        const key = overlapKey(x), w = decisions.get(key) ?? "a";
        const outA = leaveOut.has(structureKey(x.a.input, x.a.label)), outB = leaveOut.has(structureKey(x.b.input, x.b.label));
        if (outA || outB) {
          return `<tr class="sl-merge-settled">
          <td class="sl-netb-num">${fmt(x.voxels)}</td>
          <td>${outA ? "<s>" : ""}${nameOf(x.a.input, x.a.label)}${outA ? "</s>" : ""}</td>
          <td class="sl-netb-dim">${outA && outB ? "both left out" : outA ? "left out — the voxels go right" : "left out — the voxels go left"}</td>
          <td>${outB ? "<s>" : ""}${nameOf(x.b.input, x.b.label)}${outB ? "</s>" : ""}</td>
        </tr>`;
        }
        return `<tr>
          <td class="sl-netb-num">${fmt(x.voxels)}</td>
          <td><label><input type="radio" name="${key}" value="a"${w === "a" ? " checked" : ""}> ${escapeHtml(nameOf(x.a.input, x.a.label))}${inputs!.length > 2 ? ` <span class="sl-netb-dim">(${escapeHtml(inputs![x.a.input].name)})</span>` : ""}</label></td>
          <td class="sl-netb-dim">or</td>
          <td><label><input type="radio" name="${key}" value="b"${w === "b" ? " checked" : ""}> ${escapeHtml(nameOf(x.b.input, x.b.label))}${inputs!.length > 2 ? ` <span class="sl-netb-dim">(${escapeHtml(inputs![x.b.input].name)})</span>` : ""}</label></td>
        </tr>`;
      }).join("") + `</tbody></table>`;
    overlapsEl.querySelectorAll<HTMLInputElement>("input[type=radio]").forEach((r) => r.addEventListener("change", () => {
      decisions.set(r.name, r.value as Winner);
    }));
    overlapsEl.querySelectorAll<HTMLButtonElement>("[data-all]").forEach((b) => b.addEventListener("click", () => {
      const i = +b.dataset.all!;
      for (const x of overlaps!) {
        if (x.a.input === i) decisions.set(overlapKey(x), "a");
        else if (x.b.input === i) decisions.set(overlapKey(x), "b");
      }
      paintOverlaps();
    }));
  }

  function paint() {
    paintList();
    paintOverlaps();
    findBtn.disabled = order.length < 2;
    reviewBtn.disabled = !(overlaps && overlaps.length);
    goBtn.disabled = !(order.length >= 2 && overlaps !== null);
    note.textContent = order.length < 2 ? "tick at least two" : overlaps === null ? `${order.length} ticked — find the overlaps first` : "";
  }

  async function loadInputs(): Promise<MergeInput[]> {
    const out: MergeInput[] = [];
    for (const id of order) {
      const r = o.roots.find((x) => x.id === id)!;
      const node = o.live.nodes.get(id);
      if (!node?.zarr) throw new Error(`"${r.name}" has no labelmap in the scene`);
      o.status(`reading ${r.name}…`);
      const v = await fetchZarrVolumeNative(o.live.blobBase(), node.zarr as ZarrDesc);
      if (!(v.data instanceof Uint8Array)) throw new Error(`"${r.name}" is not a byte labelmap (${v.dtype})`);
      const task = (node.origin as { task?: string } | undefined)?.task;
      out.push({
        id, name: r.name, labelmap: v.data, ...(task ? { task } : {}),
        segments: r.segments.map((s) => ({ labelValue: s.labelValue, name: s.name ?? `label ${s.labelValue}`, color: (s.color?.length === 3 ? s.color : [1, 1, 1]) as [number, number, number], ...(s.structure ? { structure: s.structure } : {}) })),
      });
    }
    return out;
  }

  // The button carries the wait: loading three whole-body labelmaps and comparing them is seconds,
  // and the outcome used to appear only in the status line (Ron, 2026-09-22: "immediate visual
  // feedback ... for every button that can be clicked").
  findBtn.addEventListener("click", () => void runAction(findBtn, async () => {
    try {
      const t0 = performance.now();
      inputs = await loadInputs();
      overlaps = findOverlaps(inputs);
      const ms = performance.now() - t0;
      o.status(overlaps.length
        ? `${overlaps.length} overlapping pair${overlaps.length === 1 ? "" : "s"} found in ${(ms / 1000).toFixed(1)}s — choose who keeps the voxels, then Merge`
        : `no overlap between these ${order.length} — checked in ${(ms / 1000).toFixed(1)}s`);
    } catch (e) {
      o.status((e as Error).message);
      inputs = null; overlaps = null;
    }
    paint();
  }, { busyLabel: "Looking…" }).catch(() => {}));

  goBtn.addEventListener("click", () => void runAction(goBtn, async () => {
    if (!inputs) return;
    findBtn.disabled = true;
    try {
      const t0 = performance.now();
      const r = mergeLabelmaps(inputs, decisions, leaveOut);
      const sourceId = firstSource()!;
      const names = inputs.map((i) => i.name.replace(/ of .*$/, ""));
      const sourceName = (o.live.nodes.get(sourceId)?.name as string | undefined) ?? "";
      const name = `merged: ${names.join(" + ")}${sourceName ? ` of ${sourceName}` : ""}`;
      const made = await createSegmentationFromLabelmap(o.live, o.store, sourceId, r.labelmap, r.segments.map((s) => ({
        labelValue: s.labelValue, name: s.name, color: s.color, ...(s.structure ? { structure: s.structure } : {}),
      })), {
        name,
        // Derived from the inputs, and the decisions written down with it, so the result can say
        // where each voxel's owner came from.
        // The inputs' networks travel with the result, so the SEG can say what made it: a merged
        // file read as MANUAL with no algorithm name was the first critic's finding 7 (2026-09-17).
        // The task is read from the scene node when the inputs are loaded (MergeInput.task); the
        // first version of this read a field MergeInput never had, so the SEG was asked for
        // SEMIAUTOMATIC with no name and dcmjs refused every merged save (second critic, finding 1).
        origin: {
          merged: inputs.map((i) => i.id), decisions: Object.fromEntries(decisions), contested: r.contested,
          ...(leaveOut.size ? { leftOut: [...leaveOut] } : {}),
          ...(inputs.some((i) => i.task) ? { task: inputs.map((i) => i.task).filter(Boolean).join(" + ") } : {}),
        },
      });
      const ms = performance.now() - t0;
      o.status(`merged ${inputs.length} segmentations into "${name}": ${made.segments} structures` +
        (r.unlistedVoxels ? ` — NOTE: ${r.unlistedVoxels.toLocaleString()} voxel claims carried a label no structure is named for and were left out` : "") +
        (r.contested ? `, ${fmt(r.contested)} contested voxels (${fmt(r.wonByLater)} went to the later one by your choice)` : ", no contested voxels") +
        (leaveOut.size ? `, ${leaveOut.size} structure${leaveOut.size === 1 ? "" : "s"} left out (${fmt(r.leftOutVoxels)} voxels)` : "") +
        ` — ${(ms / 1000).toFixed(1)}s. The ${inputs.length} originals are unchanged.`);
      o.onMerged(made.segId);
      win.close();
    } catch (e) {
      o.status(`merge failed: ${(e as Error).message}`);
      paint();
      throw e;                                   // so the button says "Not merged", not nothing
    }
  }, { busyLabel: "Merging…", doneLabel: "Merged ✓", failedLabel: "Not merged" }).catch(() => {}));

  // ---------------------------------------------------------------------------------------------
  // REVIEW THE PAIRS ONE AT A TIME. Ron, 2026-09-21: "In order to make decisions, I would need to
  // inspect each pair in cross sections. Four up would be the right layout. I would want only the
  // pair at hand visible over the cross sections and in 3d, make a decision and step to the next
  // structure." And: "a bar for text and buttons taking up about 20% of the window on top ...
  // maximize the image display area and zoom to the extent of the structures inspected."
  //
  // The whole window becomes the review: the module column goes, a bar takes the top fifth, the
  // layout is Four-Up, every segmentation but the two structures of the pair is hidden, the slices
  // are zoomed to the two structures and positioned through their shared voxels, the 3D view is
  // fitted to the same two. One color scheme for every pair; the shared voxels are one temporary
  // segmentation (one segment per pair, yellow) so they draw over the two colors. Nothing touches
  // the voxels: the review sets decisions and display, and Back to the list -- a separate click,
  // so a person at the bottom of the list can go back over pairs (Ron) -- puts everything back.
  // ---------------------------------------------------------------------------------------------
  const g = globalThis as unknown as {
    __setLayout?: (id: number) => void; __layoutId?: number;
    __frameTo?: (lo: Vec3, hi: Vec3, through?: Vec3) => void;
    __shell?: { root: HTMLElement; setSidebarVisible(v: boolean): void };
  };
  interface SegSnapshot { visible?: boolean; visible3D?: boolean; zOrder?: number; segments: { visible?: boolean; color?: number[] }[] }
  /** The volume-rendering displays switched off for the review, with what to put back. */
  interface VrSnapshot { visible?: boolean; colorize?: boolean }
  let review: {
    at: number; geometry: OverlapGeometry; ijkToRAS: number[]; sharedId: string | null; marked: number;
    snapshot: Map<string, SegSnapshot>; views: Map<string, Record<string, unknown>>; vr: Map<string, VrSnapshot>; layoutId: number | undefined; bar: HTMLElement;
  } | null = null;

  const patch = (id: string, path: string, value: unknown) => o.live.write({ op: "patch", id, path, value });

  async function startReview() {
    if (!inputs || !overlaps?.length) return;
    const sourceId = firstSource()!;
    const src = o.live.nodes.get(sourceId);
    const dims = src?.dims as [number, number, number] | undefined, ijkToRAS = src?.ijkToRAS as number[] | undefined;
    if (!dims || !ijkToRAS) { o.status("the volume's geometry is not in the scene; cannot review"); return; }
    reviewBtn.disabled = true;
    const t0 = performance.now();
    o.status("measuring where the pairs meet…");
    const geometry = overlapGeometry(inputs, dims);
    // What is on screen now, so Back to the list can put it back: every segmentation's visibility
    // and colors, the slice frames, the camera.
    const snapshot = new Map<string, SegSnapshot>();
    const views = new Map<string, Record<string, unknown>>();
    for (const n of o.live.nodes.values()) {
      if (n.type === "camera") views.set(n.id, { position: [...(n.position as number[])], focalPoint: [...(n.focalPoint as number[])], viewUp: [...(n.viewUp as number[])], ...(typeof n.parallelScale === "number" ? { parallelScale: n.parallelScale } : {}) });
      if (n.type === "view" && n.kind === "slice" && n.sliceToRAS) views.set(n.id, { sliceToRAS: [...(n.sliceToRAS as number[])], ...(n.fieldOfView ? { fieldOfView: [...(n.fieldOfView as number[])] } : {}), ...(typeof n.offset === "number" ? { offset: n.offset } : {}) });
      if (n.type !== "segmentation") continue;
      snapshot.set(n.id, {
        visible: n.visible as boolean | undefined, visible3D: n.visible3D as boolean | undefined, zOrder: n.zOrder as number | undefined,
        segments: ((n.segments as { visible?: boolean; color?: number[] }[]) ?? []).map((x) => ({ visible: x.visible, color: x.color ? [...x.color] : undefined })),
      });
    }
    // VOLUME RENDERING OFF FOR THE REVIEW. A segmentation shown "in context" colorizes the rendered
    // volume, and that colorize copy (1.2 GB at this volume's size) is rebuilt whenever the
    // segmentation it draws is hidden or another is shown -- which the review does on every step.
    // Ron's first try ended at the second pair: "The window was reset ... holds more than 4 GB".
    // The review is surfaces and slices; the rendering comes back when it ends.
    const vr = new Map<string, VrSnapshot>();
    for (const n of o.live.nodes.values()) {
      if (n.type !== "volumeRenderingDisplay") continue;
      vr.set(n.id, { visible: n.visible as boolean | undefined, colorize: n.colorize as boolean | undefined });
      patch(n.id, "#/visible", false);
      patch(n.id, "#/colorize", false);
    }
    // The shared voxels as one temporary segmentation, drawn over everything.
    let sharedId: string | null = null;
    const shared = sharedLabelmap(inputs, overlaps);
    try {
      const nameOf = (input: number, label: number) => inputs![input].segments.find((x) => x.labelValue === label)?.name ?? `label ${label}`;
      const made = await createSegmentationFromLabelmap(o.live, o.store, sourceId, shared.labelmap,
        overlaps.slice(0, shared.marked).map((x, i) => ({ labelValue: i + 1, name: `claimed by both: ${nameOf(x.a.input, x.a.label)} / ${nameOf(x.b.input, x.b.label)}`, color: REVIEW_SHARED })),
        { name: "claimed by both (merge review)", hiddenIn3D: true, origin: { local: true, review: true } });
      sharedId = made.segId;
      patch(sharedId, "#/zOrder", 1000);
    } catch (e) { o.status(`the shared voxels could not be drawn: ${(e as Error).message}`); }
    // Everything else off; the two inputs on, with every segment hidden until showPair.
    for (const [id, snap] of snapshot) {
      if (order.includes(id)) {
        patch(id, "#/visible", true); patch(id, "#/visible3D", true);
        snap.segments.forEach((_, i) => patch(id, `#/segments/${i}/visible`, false));
      } else { patch(id, "#/visible", false); patch(id, "#/visible3D", false); }
    }
    // The window out of the way, the module column gone, the bar in, Four-Up.
    win.overlay.style.display = "none";
    const bar = document.createElement("div");
    bar.className = "sl-merge-review-bar";
    const app = g.__shell?.root ?? document.body;
    app.insertBefore(bar, app.querySelector(".sl-body"));
    g.__shell?.setSidebarVisible(false);
    const layoutId = g.__layoutId;
    g.__setLayout?.(FOUR_UP);
    review = { at: 0, geometry, ijkToRAS, sharedId, marked: shared.marked, snapshot, views, vr, layoutId, bar };
    o.status(`review: ${overlaps.length} pairs measured in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    showPair(0);
  }

  function showPair(i: number) {
    if (!review || !inputs || !overlaps) return;
    review.at = Math.max(0, Math.min(overlaps.length - 1, i));
    const x = overlaps[review.at], key = overlapKey(x);
    const idA = inputs[x.a.input].id, idB = inputs[x.b.input].id;
    const nameOf = (input: number, label: number) => inputs![input].segments.find((s) => s.labelValue === label)?.name ?? `label ${label}`;
    // Only the pair: every segment of the two inputs off, the two on in the review colors. ONE
    // write per segmentation -- a patch per segment was 133 upserts a step, each re-examined by the
    // colorize and surface paths.
    const showOnly = (id: string, keep: Map<number, Vec3>) => {
      const node = o.live.nodes.get(id); if (!node) return;
      const segs = ((node.segments as { labelValue: number; visible?: boolean; color?: number[] }[]) ?? []).map((sg) => {
        const c = keep.get(sg.labelValue);
        return c ? { ...sg, visible: true, color: c } : { ...sg, visible: false };
      });
      patch(id, "#/segments", segs);
    };
    const keepA = new Map<number, Vec3>([[x.a.label, REVIEW_A]]), keepB = new Map<number, Vec3>([[x.b.label, REVIEW_B]]);
    if (idA === idB) { keepA.set(x.b.label, REVIEW_B); showOnly(idA, keepA); }
    else { for (const id of order) showOnly(id, id === idA ? keepA : id === idB ? keepB : new Map()); }
    if (review.sharedId) showOnly(review.sharedId, new Map([[review.at + 1, REVIEW_SHARED]]));
    // Frame: zoomed to the two structures, positioned through their shared voxels.
    const ba = review.geometry.boxes.get(structureKey(x.a.input, x.a.label)), bb = review.geometry.boxes.get(structureKey(x.b.input, x.b.label));
    const c = review.geometry.centroids.get(key);
    if (ba && bb) {
      const [lo, hi] = rasBoxOf(review.ijkToRAS, unionBox(ba, bb));
      g.__frameTo?.(lo, hi, c ? ijkToRas(review.ijkToRAS, c) : undefined);
    }
    // The bar.
    const outA = leaveOut.has(structureKey(x.a.input, x.a.label)), outB = leaveOut.has(structureKey(x.b.input, x.b.label));
    const settled = outA || outB;
    const w = decisions.get(key) ?? "a";
    const decided = [...overlaps].filter((y) => decisions.has(overlapKey(y)) || leaveOut.has(structureKey(y.a.input, y.a.label)) || leaveOut.has(structureKey(y.b.input, y.b.label))).length;
    const sw = (rgb: Vec3) => `<span class="sl-merge-sw" style="background:rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})"></span>`;
    review.bar.innerHTML = `
      <div class="sl-merge-step"><span class="sl-merge-step-n">Pair ${review.at + 1} of ${overlaps.length}</span>
        <span class="sl-netb-dim">${fmt(x.voxels)} voxels claimed by both · largest first${review.at >= review.marked ? " · not drawn in yellow (more than 255 pairs)" : ""}</span>
        <span class="sl-netb-dim">${decided} decided · ${overlaps.length - decided} to go</span></div>
      <div class="sl-merge-pair">
        <div class="sl-merge-side">
          <div class="sl-netb-dim">from ${escapeHtml(inputs[x.a.input].name)}</div>
          <label><input type="radio" name="sl-merge-rv" value="a"${w === "a" ? " checked" : ""}${settled ? " disabled" : ""}> ${sw(REVIEW_A)}${outA ? "<s>" : ""}${nameOf(x.a.input, x.a.label)}${outA ? "</s>" : ""}</label>
          <label class="sl-merge-drop"><input type="checkbox" data-out="${structureKey(x.a.input, x.a.label)}"${outA ? " checked" : ""}> leave this structure out of the merge entirely</label>
        </div>
        <div class="sl-netb-dim">${settled ? (outA && outB ? "both left out" : outA ? "left out — the voxels go to the right" : "left out — the voxels go to the left") : "or"}</div>
        <div class="sl-merge-side">
          <div class="sl-netb-dim">from ${escapeHtml(inputs[x.b.input].name)}</div>
          <label><input type="radio" name="sl-merge-rv" value="b"${w === "b" ? " checked" : ""}${settled ? " disabled" : ""}> ${sw(REVIEW_B)}${outB ? "<s>" : ""}${nameOf(x.b.input, x.b.label)}${outB ? "</s>" : ""}</label>
          <label class="sl-merge-drop"><input type="checkbox" data-out="${structureKey(x.b.input, x.b.label)}"${outB ? " checked" : ""}> leave this structure out of the merge entirely</label>
        </div>
      </div>
      <div class="sl-merge-btns">
        <div><button data-act="prev"${review.at === 0 ? " disabled" : ""}>◀ Previous</button> <button data-act="skip"${review.at === overlaps.length - 1 ? " disabled" : ""}>Skip</button> <button class="sl-primary" data-act="decide">${settled ? "Next ▶" : review.at === overlaps.length - 1 ? "Decide" : "Decide and next ▶"}</button></div>
        <div><button data-act="back">Back to the list</button></div>
        <div class="sl-netb-dim">${sw(REVIEW_A)} first · ${sw(REVIEW_B)} second · ${sw(REVIEW_SHARED)} claimed by both</div>
      </div>`;
    review.bar.querySelectorAll<HTMLInputElement>("input[data-out]").forEach((cb) => cb.addEventListener("change", () => {
      if (cb.checked) leaveOut.add(cb.dataset.out!); else leaveOut.delete(cb.dataset.out!);
      showPair(review!.at);
    }));
    review.bar.querySelector<HTMLButtonElement>("[data-act=prev]")!.addEventListener("click", () => showPair(review!.at - 1));
    review.bar.querySelector<HTMLButtonElement>("[data-act=skip]")!.addEventListener("click", () => showPair(review!.at + 1));
    review.bar.querySelector<HTMLButtonElement>("[data-act=decide]")!.addEventListener("click", () => {
      if (!settled) {
        const v = review!.bar.querySelector<HTMLInputElement>("input[name=sl-merge-rv]:checked")?.value as Winner | undefined;
        if (v) decisions.set(key, v);
      }
      // The last pair stays: leaving is its own click (Ron).
      showPair(review!.at < overlaps!.length - 1 ? review!.at + 1 : review!.at);
    });
    review.bar.querySelector<HTMLButtonElement>("[data-act=back]")!.addEventListener("click", endReview);
  }

  function endReview() {
    if (!review) return;
    const r = review; review = null;
    if (r.sharedId) o.live.write({ op: "del", id: r.sharedId });
    for (const [id, snap] of r.snapshot) {
      if (!o.live.nodes.has(id)) continue;
      // An unset visible3D means "as visible" to the renderer (livescene.ts), so unset goes back to that, not to off.
      patch(id, "#/visible", snap.visible ?? true); patch(id, "#/visible3D", snap.visible3D ?? snap.visible ?? true);
      if (snap.zOrder !== undefined) patch(id, "#/zOrder", snap.zOrder);
      snap.segments.forEach((sg, k) => { patch(id, `#/segments/${k}/visible`, sg.visible ?? true); if (sg.color) patch(id, `#/segments/${k}/color`, sg.color); });
    }
    for (const [id, was] of r.vr) {
      if (!o.live.nodes.has(id)) continue;
      patch(id, "#/colorize", was.colorize ?? true);
      patch(id, "#/visible", was.visible ?? false);
    }
    r.bar.remove();
    g.__shell?.setSidebarVisible(true);
    if (r.layoutId !== undefined) g.__setLayout?.(r.layoutId);
    // The views as they were: after the layout, so the cells that come back are framed as before.
    for (const [id, fields] of r.views) {
      if (!o.live.nodes.has(id)) continue;
      for (const [k, v] of Object.entries(fields)) patch(id, `#/${k}`, v);
    }
    win.overlay.style.display = "";
    paint();
    o.status(`review closed — ${decisions.size} decided, ${leaveOut.size} left out; Merge when ready`);
  }

  reviewBtn.addEventListener("click", () => void startReview());
  onWindowClose = () => { if (review) endReview(); };

  paint();
}
