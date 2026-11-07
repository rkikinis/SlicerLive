// GROW FROM SEEDS: a few strokes inside a structure and a few around it, and the structure is filled out to its edges.
//
// Ron, 2026-10-01, on outlining a brain tumor when the case has no outline: "Do we have grow from seed in the editor?
// That would do the job." Slicer's Grow from seeds (FastGrowCut) is the model. Two rules decide, versioned below: Steve
// Pieper's GPU GrowCut (algorithms/effects/growcut.ts: Vezhnevets & Konouchine 2005, a cellular automaton on the
// graphics card) and the cheapest path (algorithms/effects/grow-by-path.ts).
//
// What this adds around it: the grow runs only in a BOX around the strokes (their extent plus a margin), as Slicer's
// does, so a brain MR of 256 x 256 x 180 grows a tumor-sized box instead of the whole head; every label among the
// strokes competes (at least two are needed: the structure, and what is not the structure); the answer is a label map
// of the whole grid, zero outside the box.
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { GrowCutEffect, uploadImage } from "../algorithms/effects/growcut.ts";
import { growByPath } from "../algorithms/effects/grow-by-path.ts";
import type { Vec3 } from "../algorithms/geom.ts";

/**
 * THE RULE THAT DECIDES WHICH SEED A VOXEL JOINS, versioned (Ron, 2026-09-25: "modular as possible and also versioned").
 * 1: Steve's GrowCut (algorithms/effects/growcut.ts), the default until 2026-11-01, and still what the Diffusion module's
 * tumor outline uses (logic/segmentation-editor.ts growIntoSegmentation: nothing measured it on a tumor with rule 2).
 * 2: the cheapest path, the sum of brightness steps, on 6 neighbors, 2026-11-01 (algorithms/effects/grow-by-path.ts, which
 * says why: on the Prisma T1 rule 1 covered 25 % of the ventricles from Ron-like strokes, rule 2 84 %).
 * 3: the same on 26 neighbors, as Slicer looks, 2026-11-06 (Ron: "26 is the way to go"). The node records the rule that made
 * its result: growRule.
 */
export const GROW_RULE_VERSION = 3;

export interface GrowResult {
  /** The grown labels on the whole grid; 0 outside the box. */
  labels: Uint8Array;
  /** The box that was grown, in voxels: lo inclusive, hi exclusive. */
  box: { lo: Vec3; hi: Vec3 };
  iterations: number;
  ms: number;
}

/** One graphics-card device for growing, made on first use (a page's renderer keeps its own). */
let device: Promise<GPUDevice> | undefined;
export function growDevice(): Promise<GPUDevice> {
  device ??= (async () => {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
    const adapter = await gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("this computer's graphics card is not available to Albula");
    // THE ADAPTER'S OWN SIZE LIMITS, as render/device.ts initDevice asks for them. With the WebGPU defaults (128 MiB per
    // storage binding) a box over 2^25 voxels failed with "validation error occurred" (critic, 2026-11-01, finding 4:
    // 320^3 grew, 323^3 failed), and the tests, on initDevice, could not see it.
    const requiredLimits: Record<string, number> = {};
    for (const k of ["maxBufferSize", "maxStorageBufferBindingSize", "maxTextureDimension3D"] as const) {
      const v = adapter.limits[k] as number | undefined;
      if (typeof v === "number") requiredLimits[k] = v;
    }
    return await adapter.requestDevice({ requiredLimits });
  })();
  device.catch(() => { device = undefined; });
  return device;
}

/**
 * The strokes' extent plus a margin: a third of the extent on each side, at least `minMargin` voxels, inside the grid.
 * Generous on purpose: the grow cannot reach past the box, so a structure the strokes do not span is cut flat at its
 * edge (seen 2026-10-01 on PAT16: strokes on three slices gave a tumor with a flat top and bottom). The guidance asks
 * for strokes from the top slice to the bottom one; the margin covers what the strokes miss by a little.
 */
export function seedBox(seeds: ArrayLike<number>, dims: Vec3, minMargin = 12, only?: Set<number>): { lo: Vec3; hi: Vec3; labels: Set<number> } {
  const [nx, ny] = dims;
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-1, -1, -1];
  const labels = new Set<number>();
  for (let i = 0; i < seeds.length; i++) {
    const v = seeds[i];
    if (!v || (only && !only.has(v))) continue;
    labels.add(v);
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
    if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
  }
  if (!labels.size) return { lo: [0, 0, 0], hi: [0, 0, 0], labels };
  const out = { lo: [0, 0, 0] as Vec3, hi: [0, 0, 0] as Vec3, labels };
  for (let a = 0; a < 3; a++) {
    const m = Math.max(minMargin, Math.ceil((hi[a] - lo[a] + 1) / 3));
    out.lo[a] = Math.max(0, lo[a] - m);
    out.hi[a] = Math.min(dims[a], hi[a] + 1 + m);
  }
  return out;
}

/**
 * Grow `seeds` (a label per voxel, 0 = no stroke) over `image` on the grid `dims`. Throws, in words a person
 * understands, when there is nothing to grow from.
 */
export async function growFromSeeds(device: GPUDevice, seeds: ArrayLike<number>, image: ArrayLike<number>, dims: Vec3, opts: { minMargin?: number; boxFrom?: Set<number>; boxSeeds?: ArrayLike<number>; rule?: 1 | 2 | 3 } = {}): Promise<GrowResult> {
  const t0 = performance.now();
  // The box from `boxSeeds` when given (this round's strokes), or the strokes of `boxFrom`, else from every seed.
  const { lo, hi } = seedBox(opts.boxSeeds ?? seeds, dims, opts.minMargin, opts.boxFrom);
  const labels = new Set<number>();
  if (hi[0] > lo[0]) for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) {
    const row = (z * dims[1] + y) * dims[0];
    for (let x = lo[0]; x < hi[0]; x++) { const v = seeds[row + x]; if (v) labels.add(v); }
  }
  if (labels.size < 2) {
    throw new Error(labels.size ? "Draw strokes in two places: inside the structure, and in what surrounds it." : "Draw a few strokes first: inside the structure, and in what surrounds it.");
  }
  const [nx, ny] = dims;
  const sub: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const n = sub[0] * sub[1] * sub[2];
  const cropSeeds = new Uint32Array(n), cropImage = new Float32Array(n);
  for (let z = 0; z < sub[2]; z++) for (let y = 0; y < sub[1]; y++) {
    const src = ((z + lo[2]) * ny + (y + lo[1])) * nx + lo[0], dst = (z * sub[1] + y) * sub[0];
    for (let x = 0; x < sub[0]; x++) { cropSeeds[dst + x] = seeds[src + x]; cropImage[dst + x] = image[src + x]; }
  }
  const labelsOut = new Uint8Array(nx * ny * dims[2]);
  const place = (grown: ArrayLike<number>) => {
    for (let z = 0; z < sub[2]; z++) for (let y = 0; y < sub[1]; y++) {
      const dst = ((z + lo[2]) * ny + (y + lo[1])) * nx + lo[0], src = (z * sub[1] + y) * sub[0];
      for (let x = 0; x < sub[0]; x++) labelsOut[dst + x] = grown[src + x];
    }
  };
  const rule = opts.rule ?? GROW_RULE_VERSION;
  if (rule !== 1) {
    const r = await growByPath(device, cropSeeds, cropImage, sub, { neighbors: rule === 2 ? 6 : 26 });
    place(r.labels);
    return { labels: labelsOut, box: { lo, hi }, iterations: r.passes, ms: Math.round(performance.now() - t0) };
  }
  const seg = new EditableSegmentation(device, sub, { ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  const imageTex = uploadImage(device, cropImage, sub);
  const gc = new GrowCutEffect(seg, imageTex);
  try {
    seg.loadLabelmap(cropSeeds);
    const iterations = await gc.grow();
    place(await seg.readLabelmap());
    return { labels: labelsOut, box: { lo, hi }, iterations, ms: Math.round(performance.now() - t0) };
  } finally {
    seg.destroy(); gc.destroy(); imageTex.destroy();
  }
}

/**
 * THE REJECTION CLASS (Ron, 2026-11-01: "grow from seeds: I need a rejection class"; asked what happens to its region:
 * "Dropped"). A segment marked `rejection` is painted where the structure is NOT, competes in the grow like any other,
 * and what it wins beyond its strokes is left empty. Its strokes stay for the next round (since the second ventricle
 * trial, 2026-11-01: growInPlace), and it is never saved (render/demos/slicer-app.ts). Slicer has no such class: there
 * the person adds a "background" segment and deletes it by hand after the grow.
 */
export const isRejection = (s: { rejection?: boolean }): boolean => s.rejection === true;

/** What is known of the strokes for growInPlace (logic/grow-strokes.ts). */
export interface GrowStrokes {
  /** The target's strokes, when the rest of its label is an earlier result: everything else of it is decided again. */
  strokes?: ArrayLike<number>;
  /** Outside's strokes of this round, when known: the box and the "two places" check look at these and not at the gray of an earlier structure. */
  roundOutside?: ArrayLike<number>;
}

/**
 * GROW IN PLACE, as the Segment Editor's effect does. Only `target` grows: the box is around its strokes and Outside's,
 * and of what the grow decides inside it only the target's voxels are written; the other segments shown take part as
 * seeds, so the target stops where it meets them, but they neither gain nor lose a voxel (critic, 2026-11-01, finding 1).
 * The segments in `hidden` are neither seeds nor overwritten (critic, 2026-10-01, finding 7). Without a `target` every
 * shown segment grows, as Slicer's Grow from seeds does.
 *
 * THE STROKES STAY, THE RESULT IS DECIDED AGAIN (Ron's second ventricle trial, 2026-11-01: after a second round of
 * strokes the result filled the box). Slicer keeps the seeds and shows the grow as a preview until Apply
 * (AbstractScriptedSegmentEditorAutoCompleteEffect.py, onApply); here the result is written at once, so instead:
 * Outside's strokes stay (only what Outside wins beyond them is dropped, Ron: "Dropped"), and with `known.strokes`
 * (logic/grow-strokes.ts) everything of the target that is not a stroke, the last result and what Margin or Smoothing did
 * to it alike, is taken back before growing, so each press grows from the person's strokes, old and new. Without it
 * (the first press, or a structure opened from a file) the whole label counts as strokes; `seeds` says which those were.
 */
export async function growInPlace(device: GPUDevice, labelmap: Uint8Array, image: ArrayLike<number>, dims: Vec3, hidden: Set<number>, rejection: Set<number> = new Set(), target?: number, known: GrowStrokes = {}): Promise<{ out: Uint8Array; box: { lo: Vec3; hi: Vec3 }; ms: number; seeds?: Uint32Array }> {
  const base = new Uint8Array(labelmap);
  if (target !== undefined && known.strokes) {
    for (let i = 0; i < base.length; i++) if (base[i] === target) base[i] = 0;
    for (let k = 0; k < known.strokes.length; k++) { const at = known.strokes[k]; if (!base[at]) base[at] = target; }   // another structure over a stroke stays
  }
  const seeds = hidden.size ? base.map((v) => hidden.has(v) && !rejection.has(v) ? 0 : v) : base;
  const boxFrom = target !== undefined ? new Set([target, ...rejection]) : undefined;
  if (target !== undefined && !seeds.some((v) => v === target)) throw new Error("Paint a few strokes inside the structure first.");
  let targetSeeds: Uint32Array | undefined, boxSeeds: Uint8Array | undefined;
  if (target !== undefined) {
    let n = 0;
    for (let i = 0; i < seeds.length; i++) if (seeds[i] === target) n++;
    targetSeeds = new Uint32Array(n);
    for (let i = 0, k = 0; i < seeds.length; i++) if (seeds[i] === target) targetSeeds[k++] = i;
    if (known.roundOutside) {
      boxSeeds = new Uint8Array(seeds.length);
      for (const at of targetSeeds) boxSeeds[at] = target;
      for (let k = 0; k < known.roundOutside.length; k++) { const at = known.roundOutside[k]; if (rejection.has(seeds[at])) boxSeeds[at] = seeds[at]; }
    }
  }
  const r = await growFromSeeds(device, seeds, image, dims, { boxFrom, boxSeeds });
  const out = new Uint8Array(base);
  const [nx, ny] = dims, { lo, hi } = r.box;
  for (let z = lo[2]; z < hi[2]; z++) for (let y = lo[1]; y < hi[1]; y++) {
    const row = (z * ny + y) * nx;
    for (let x = lo[0]; x < hi[0]; x++) {
      const was = base[row + x], won = r.labels[row + x];
      if (was) continue;                                      // strokes, Outside's included, and every other segment stay
      if (target !== undefined) { if (won === target) out[row + x] = target; continue; }
      out[row + x] = rejection.has(won) ? 0 : won;
    }
  }
  return { out, box: r.box, ms: r.ms, seeds: targetSeeds };
}
