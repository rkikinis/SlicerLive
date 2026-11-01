// SCISSORS (Ron, 2026-10-30: "slicer has the scisor effect. no heuristic needed. It's essentially a prism boolean on the
// label selected. Applied twice or three times in sequence it can do a lot. an intuitive UI is critical"; then, on the
// first Threshold build, "How do I do the scisors for the spine?"). As the prototype he was given
// (mockups/skull-scissors-prototype-2026-10-30.html): drag around a part on a slice view or the 3D view; on release the
// outline goes through the whole scan along the view's direction and the structure chosen in "Paint …" is cut there.
// Shift held when letting go swaps to "keep only what is inside" (the outline turns green). Each stroke is written at once,
// one Undo step. The arithmetic is logic/scissors-cut.ts; the outline is drawn by render/moduleserver/live-views.ts.
import type { SegTool, SegToolContext, ToolStroke } from "./registry.ts";
import { cutByOutline, cutOutlinedPart, keepPiecesAt, removePieceAt, outlineOf, sliceProjection, viewProjection, type Vec3 } from "../../../logic/scissors-cut.ts";
import { invertRowMajor } from "../../../logic/transforms.ts";
import { applyRowMajor } from "../../mat4.ts";
import { escapeHtml } from "../html.ts";

export function scissorsTool(): SegTool {
  let mode: "cut" | "keep" = "cut";
  let working = false;
  /** A CLICK KEEPS THE PIECE UNDER IT (Ron, 2026-10-30: "so click means keep in all effects"). The structure as it was
   *  before the first click, and the voxels clicked since: a Shift-click keeps one more piece, found in that state even
   *  after the first click dropped it. A drag, another structure or another tool starts over. */
  let clicks: { segId: string; segment: number; before: Uint8Array; seeds: Vec3[] } | null = null;

  /** Option-click: the piece of the structure under the click goes; the rest stays. */
  async function removeClicked(ras: Vec3, ctx: SegToolContext) {
    if (working) { ctx.status("Scissors: the last change is still being made"); return; }
    const id = ctx.segId(), node = id ? ctx.live.nodes.get(id) : undefined;
    if (!node) { ctx.status("Choose which segmentation to edit first — at the top of the Segment Editor"); return; }
    const s = ctx.structure();
    clicks = null;
    working = true;
    try {
      const t0 = performance.now();
      const now = await ctx.edits.begin(); if (!now) return;
      const r = removePieceAt(now, node.dims as Vec3, s.labelValue, applyRowMajor(invertRowMajor(node.ijkToRAS as number[]), ras) as Vec3);
      if (!r) { ctx.edits.cancel(); ctx.status(`Scissors: no ${s.name} at that point`); return; }
      await ctx.edits.commit(r.labels);
      ctx.status(`Scissors: the piece clicked removed, ${r.cleared.toLocaleString()} voxels of ${s.name}, in ${((performance.now() - t0) / 1000).toFixed(1)} s — Undo puts it back`);
    } finally { working = false; }
  }

  async function keepClicked(ras: Vec3, sign: 1 | -1, ctx: SegToolContext) {
    if (working) { ctx.status("Scissors: the last change is still being made"); return; }
    const id = ctx.segId(), node = id ? ctx.live.nodes.get(id) : undefined;
    if (!node) { ctx.status("Choose which segmentation to edit first — at the top of the Segment Editor"); return; }
    const s = ctx.structure();
    working = true;
    try {
      const t0 = performance.now();
      const now = await ctx.edits.begin(); if (!now) return;
      const ijk = applyRowMajor(invertRowMajor(node.ijkToRAS as number[]), ras) as Vec3;
      const more = sign < 0 && clicks && clicks.segId === id && clicks.segment === s.labelValue;
      const from = more ? clicks!.before : now, seeds = more ? [...clicks!.seeds, ijk] : [ijk];
      const r = keepPiecesAt(from, node.dims as Vec3, s.labelValue, seeds);
      if (!r) { ctx.edits.cancel(); ctx.status(`Scissors: no ${s.name} at that point`); return; }
      if (!more && !r.cleared) { ctx.edits.cancel(); ctx.status(`Scissors: ${s.name} is one piece — nothing else to drop`); return; }
      await ctx.edits.commit(r.labels);
      clicks = { segId: id, segment: s.labelValue, before: from, seeds };
      ctx.status(`Scissors: kept ${seeds.length === 1 ? "the piece clicked" : `${seeds.length} pieces clicked`} (${r.kept.toLocaleString()} voxels); ${r.cleared.toLocaleString()} voxels of ${s.name} in other pieces dropped in ${((performance.now() - t0) / 1000).toFixed(1)} s — Shift-click keeps one more`);
    } finally { working = false; }
  }

  async function stroke(st: ToolStroke, sign: 1 | -1, ctx: SegToolContext) {
    if (working) { ctx.status("Scissors: the last cut is still being made"); return; }
    const id = ctx.segId(), node = id ? ctx.live.nodes.get(id) : undefined;
    if (!node) { ctx.status("Choose which segmentation to edit first — at the top of the Segment Editor"); return; }
    const keepOnly = (mode === "keep") !== (sign < 0);
    const s = ctx.structure();
    clicks = null;                                        // a drag starts the clicks over
    working = true;
    try {
      const t0 = performance.now();
      const base = await ctx.edits.begin(); if (!base) return;
      // ON A SLICE, WHAT IS OUTLINED GOES, as far as it continues through the slices inside the outline, and what is
      // not stays (Ron, of C1 under the skull); in 3D, everything the outline covers, through the depth.
      let r: { labels: Uint8Array; cleared: number };
      if (st.kind === "slice") {
        const pr = sliceProjection(st.normal);
        r = cutOutlinedPart(base, node.dims as Vec3, node.ijkToRAS as number[], s.labelValue, pr, outlineOf(st.points.map((p) => pr(p))), { point: st.points[0], normal: st.normal }, keepOnly);
      } else r = cutByOutline(base, node.dims as Vec3, node.ijkToRAS as number[], s.labelValue, viewProjection(st.vp), outlineOf(st.points), keepOnly);
      if (!r.cleared) { ctx.edits.cancel(); ctx.status(`Scissors: nothing of ${s.name} ${keepOnly ? "outside" : "inside"} the outline`); return; }
      await ctx.edits.commit(r.labels);
      const m = node.ijkToRAS as number[];
      const ml = Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])) / 1000 * r.cleared;
      ctx.status(`Scissors: ${keepOnly ? "kept only what is inside; " : ""}${r.cleared.toLocaleString()} voxels (${ml.toFixed(ml < 10 ? 1 : 0)} ml) of ${s.name} cut away in ${((performance.now() - t0) / 1000).toFixed(1)} s — Undo puts them back`);
    } finally { working = false; }
  }

  return {
    id: "scissors", label: "Scissors", icon: "✂", order: 45,
    tip: "Drag around a part to cut it away: on a slice, what you outline and what continues from it through the slices; in 3D, everything behind the outline (Shift when letting go: keep only that). A click keeps the piece under it; Shift-click keeps one more; Option-click removes it.",
    chosen(ctx) {
      if (!ctx.segId()) { ctx.status("Choose which segmentation to edit first — at the top of the Segment Editor"); return; }
      ctx.takeClicks(true);
      ctx.status("Scissors: drag around a part on a slice or in 3D. In 3D, turn the view with R A S L P I or an Option-drag.");
    },
    mount(el, ctx) {
      const name = escapeHtml(ctx.structure().name);
      el.innerHTML = `<div class="sl-row sl-th-named">
          <button data-mode="cut" class="${mode === "cut" ? "sl-chosen" : ""}" title="What you drag around is cut away from ${name}">Cut away</button>
          <button data-mode="keep" class="${mode === "keep" ? "sl-chosen" : ""}" title="Only what you drag around is kept of ${name}">Keep only</button></div>
        <div class="sl-row"><span class="sl-hint">Drag around a part to cut it; click a piece to keep it, Option-click to remove it. In 3D, R A S L P I turn the view.</span></div>`;
      el.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.mode as "cut" | "keep"; ctx.rerender(); }));
    },
    cheats(ctx) {
      const n = ctx.structure().name, keep = mode === "keep";
      return [
        { keys: "Drag around", does: keep ? `keeps only that of ${n}` : `cuts it away from ${n}`, tip: keep ? `Hold the mouse button down and draw a loop around a part, on a slice or in 3D: only what is inside stays in ${n}.` : `Hold the mouse button down and draw a loop around a part, on a slice or in 3D: it is cut away from ${n}. On a slice it goes as far as the part continues; in 3D, all the way through.` },
        { keys: "Shift at letting go", does: keep ? "cuts it away instead" : "keeps only that instead", tip: "Hold Shift as you let go of the mouse button: the loop does the opposite this once." },
        { keys: "Click", does: "keeps the piece under it", tip: `A click on a piece of ${n}: that piece stays, every other piece of ${n} goes.` },
        { keys: "Shift-click", does: "keeps one more piece", tip: "After a click, hold Shift and click another piece to keep it too." },
        { keys: "Option-click", does: "removes the piece under it", tip: `Hold the Option key and click a piece of ${n}: that piece goes, the rest stays.` },
        { keys: "R A S L P I", does: "turns the 3D view", tip: "The letters turn the 3D view to look from the right, front (A), top (S), left, back (P) or below (I). An Option-drag in 3D turns it freely." },
      ];
    },
    left(ctx) { clicks = null; ctx.takeClicks(false); },
    retarget() { clicks = null; },
    pick: (ras, sign, ctx, remove) => void (remove ? removeClicked(ras as Vec3, ctx) : keepClicked(ras as Vec3, sign, ctx)).catch((e) => ctx.status(`Scissors: ${(e as Error).message ?? e}`)),
    stroke: (st, sign, ctx) => void stroke(st, sign, ctx).catch((e) => ctx.status(`Scissors: ${(e as Error).message ?? e}`)),
  };
}
