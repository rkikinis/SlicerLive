// THE SEGMENT EDITOR'S TOOLS: the discrete effects (threshold, islands, smoothing, margin, logical, grow from seeds),
// statistics, and the brush and Draw on a resident labelmap. Moved out of logic/segmentation-editor.ts on 2026-10-30 (Ron:
// "yes to the firewall"): the SDK (sdk/albula.ts) re-exports segmentation-making from that file, so every extension's
// tests loaded the editor's tools with it, and a change to Threshold selected 39 of the diffusion extension's 56 test
// files (Contents/tools/test-select.ts). The code is as it was; only its place changed.
import type { LiveScene } from "../render/livescene.ts";
import type { ZarrDesc } from "../render/zarr.ts";
import { fetchZarrVolumeNative } from "../render/zarr.ts";
import { type LocalBlobStore, volumeToZarr } from "./ingest.ts";
import { canWrite, applyAutoThreshold, applyIslands, applyLogical, applyMargin, applySmoothing, applyThreshold, segmentStatistics, type LogicalOp, type OverwriteMode, type SegmentStats } from "./segment-effects.ts";
import type { ThresholdMethod } from "../algorithms/kernels/auto-threshold.ts";
import type { Vec3 } from "../render/mat4.ts";
import { invertRowMajor } from "./transforms.ts";
import { growDevice, growInPlace } from "./grow-from-seeds.ts";
import { fillPolygon } from "./fill-polygon.ts";
import { type BrushLimits, type BrushParams, type BrushTally, brushPreview, limitsFor, newTally, paintStamps, paintStepMm } from "./paint-brush.ts";
import { markEdited } from "./segmentation-editor.ts";
import { invalidatePaintCache, type PaintCache, paintCaches } from "./paint-cache.ts";

export { invalidatePaintCache };

export interface EffectParams {
  segment: number; overwrite?: OverwriteMode; visibleSegments?: number[]; overSegment?: number;
  // threshold
  lower?: number; upper?: number; autoMethod?: ThresholdMethod;
  // islands
  islands?: "keepLargest" | "removeSmall"; minSize?: number;
  // smoothing
  smooth?: "median" | "open" | "close"; radiusVoxels?: number;
  // margin
  marginMm?: number;
  // logical
  logical?: LogicalOp; other?: number;
}

/** Apply an effect, materialize the new labelmap, patch the segmentation node. Returns the segment's voxel count. */
export async function applyEffect(live: LiveScene, store: LocalBlobStore, segId: string, effect: "threshold" | "autoThreshold" | "islands" | "smoothing" | "margin" | "logical" | "growFromSeeds", params: EffectParams): Promise<{ voxels: number; threshold?: number; ms?: number }> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) throw new Error("no segmentation " + segId);
  const dims = seg.dims as [number, number, number];
  const lab = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
  const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);

  let out: Uint8Array, threshold: number | undefined, ms: number | undefined;
  if (effect === "growFromSeeds") {
    // EVERY SEGMENT'S STROKES COMPETE (logic/grow-from-seeds.ts), inside a box around them; outside it nothing changes.
    // Undo puts the strokes back (Ron, 2026-10-01: "Do we have grow from seed in the editor? That would do the job.").
    const srcId = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    const srcNode = srcId ? live.nodes.get(srcId) : undefined;
    if (!srcNode?.zarr) throw new Error("grow from seeds needs the scan the segmentation was drawn on");
    const src = await fetchZarrVolumeNative(live.blobBase(), srcNode.zarr as ZarrDesc);
    // ONLY THE SEGMENTS SHOWN TAKE PART, as in Slicer (critic, 2026-10-01, finding 7): logic/grow-from-seeds.ts growInPlace.
    const hidden = new Set(((seg.segments as { labelValue: number; visible?: boolean }[] | undefined) ?? []).filter((x) => x.visible === false).map((x) => x.labelValue));
    const r = await growInPlace(await growDevice(), labelmap, src.data as ArrayLike<number>, dims, hidden);
    out = r.out;
    ms = r.ms;
  } else if (effect === "threshold" || effect === "autoThreshold") {
    const srcId = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    const srcNode = srcId ? live.nodes.get(srcId) : undefined;
    if (!srcNode?.zarr) throw new Error("threshold needs a source volume");
    const src = await fetchZarrVolumeNative(live.blobBase(), srcNode.zarr as ZarrDesc);
    if (effect === "autoThreshold") { const r = applyAutoThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, method: params.autoMethod ?? "otsu" }); out = r.labelmap; threshold = r.threshold; }
    else out = applyThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, lower: params.lower ?? 0, upper: params.upper ?? 0 });
  } else if (effect === "islands") {
    out = applyIslands(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, operation: params.islands ?? "keepLargest", minSize: params.minSize });
  } else if (effect === "smoothing") {
    out = applySmoothing(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, method: params.smooth ?? "median", radiusVoxels: params.radiusVoxels });
  } else if (effect === "logical") {
    out = applyLogical(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, operation: params.logical ?? "union", other: params.other });
  } else {
    const sp = spacingFromIjkToRAS(seg.ijkToRAS as number[]);
    out = applyMargin(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, visibleSegments: params.visibleSegments, overSegment: params.overSegment, marginMm: params.marginMm ?? 0, spacingMm: sp });
  }

  const { desc, blobs } = await volumeToZarr(out, dims, "|u1");
  store.add(blobs);
  live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
  markEdited(live, segId);
  invalidatePaintCache(segId);
  let voxels = 0; for (let i = 0; i < out.length; i++) if (out[i] === params.segment) voxels++;
  return { voxels, threshold, ms };
}

function spacingFromIjkToRAS(m: number[]): [number, number, number] {
  const col = (c: number): number => Math.hypot(m[c], m[4 + c], m[8 + c]);
  return [col(0), col(1), col(2)];
}


/** Per-segment statistics (voxel count, volume mm^3, bounds) for a segmentation. */
export async function computeStats(live: LiveScene, segId: string): Promise<SegmentStats[]> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) return [];
  const dims = seg.dims as [number, number, number];
  const lab = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
  const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);
  const labels = ((seg.segments as { labelValue: number }[] | undefined) ?? []).map((x) => x.labelValue);
  return segmentStatistics(labelmap, dims, labels, spacingFromIjkToRAS(seg.ijkToRAS as number[]));
}
// ── native paint/erase (W5): a resident CPU labelmap painted in-place during a stroke, re-uploaded on a
//    throttle. Fast sphere/disk rasterization in voxel space; the display re-bakes when #/zarr is patched.

async function paintCache(live: LiveScene, segId: string): Promise<PaintCache | null> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) return null;
  const existing = paintCaches.get(segId); if (existing) return existing;
  const lab = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
  const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);
  const ijk = seg.ijkToRAS as number[];
  const c: PaintCache = { labelmap, dims: seg.dims as [number, number, number], ijkToRAS: ijk, invIjk: invertRowMajor(ijk), spacing: spacingFromIjkToRAS(ijk), dirty: false, uploading: false };
  paintCaches.set(segId, c);
  return c;
}

export type PaintParams = BrushParams;
export { paintStepMm };

/** WHAT THE BRUSH MAY TOUCH, per segmentation (the over rule, the brightness range or adaptive, the scan): set by the
 *  Segment Editor (render/demos/seg-editor-panel.ts), the one writer, whenever one of them changes. */
const paintLimits = new Map<string, BrushLimits>();
export function setPaintLimits(segId: string, limits: BrushLimits | null): void { if (limits) paintLimits.set(segId, limits); else paintLimits.delete(segId); }
/** The stroke being painted, per segmentation: what it wrote and what the limits left (for the status line). */
const strokeTally = new Map<string, BrushTally>();
export function strokeTallyOf(segId: string): BrushTally | undefined { return strokeTally.get(segId); }

/** Rasterize a brush swept along the stroke into the resident labelmap (in-place; logic/paint-brush.ts). `first`: the
 *  stroke's first batch, which starts its tally. Marks the cache dirty. */
export function paintStroke(live: LiveScene, segId: string, points: Vec3[], params: PaintParams, first = false, viewImage?: string): Promise<void> {
  const p = (pendingPaint.get(segId) ?? Promise.resolve()).then(async () => {
    const c = await paintCache(live, segId); if (!c) return;
    if (first || !strokeTally.has(segId)) strokeTally.set(segId, { ...newTally(), mode: params.mode });
    paintStamps(c, points, params, limitsFor(paintLimits.get(segId) ?? {}, viewImage), strokeTally.get(segId)!);
    c.dirty = true;
  });
  pendingPaint.set(segId, p.catch(() => {}));
  return p;
}
/** WHAT THE BRUSH WOULD PAINT AT `center`, for the slice view to fill in under the mouse (logic/paint-brush.ts
 *  brushPreview): the scanner coordinates of those voxels' centers, and the grid's three voxel steps (so the view can
 *  draw each voxel as it lies on the slice). Null while the
 *  segmentation's labelmap is still being read (the read is started; the next move has it). */
export function previewBrush(live: LiveScene, segId: string, center: Vec3, params: PaintParams, viewImage?: string): { will: Vec3[]; axes: [Vec3, Vec3, Vec3] } | null {
  const c = paintCaches.get(segId);
  if (!c) { void paintCache(live, segId).catch(() => {}); return null; }
  const { will } = brushPreview(c, center, params, limitsFor(paintLimits.get(segId) ?? {}, viewImage));
  const [nx, ny] = c.dims, m = c.ijkToRAS;
  return {
    will: will.map((at) => { const i = at % nx, j = Math.floor(at / nx) % ny, k = Math.floor(at / (nx * ny)); return [m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]] as Vec3; }),
    axes: [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]],
  };
}
/** The batches of a stroke still being painted, per segmentation, in order: a commit waits for them (2026-10-31: the
 *  stroke's last batch landed after its commit had read the tally -- "99 voxels" said for 190 painted). */
const pendingPaint = new Map<string, Promise<void>>();

/** DRAW (Slicer's Draw effect): fill the polygon drawn on a slice into `segment`, one voxel thick, in the resident
 *  labelmap the brush paints (logic/fill-polygon.ts). The caller commits with commitPaint. Returns the voxels written. */
export async function drawFill(live: LiveScene, segId: string, points: Vec3[], params: { segment: number; normal: Vec3 }): Promise<number> {
  const c = await paintCache(live, segId); if (!c) return 0;
  const lim = paintLimits.get(segId), ov = { segment: params.segment, overwrite: lim?.overwrite, visibleSegments: lim?.visibleSegments, overSegment: lim?.overSegment };
  const n = fillPolygon(c.labelmap, c.dims, c.ijkToRAS, c.invIjk, points, params.normal, params.segment, (cur) => canWrite(cur, ov));
  if (n) c.dirty = true;
  return n;
}

/** Upload the resident labelmap and patch the segmentation (call on a throttle + at stroke end). */
export async function commitPaint(live: LiveScene, store: LocalBlobStore, segId: string): Promise<number> {
  await pendingPaint.get(segId);
  const c = paintCaches.get(segId); if (!c || !c.dirty) return 0;
  // ONE UPLOAD AT A TIME, AND NOTHING LEFT BEHIND: a commit that arrives during an upload (a stroke's final one, say) is
  // taken by the running one, which goes round again while there is more painted -- it was dropped, and the stroke's end
  // waited for the next stroke to be written.
  if (c.uploading) return -1;
  c.uploading = true;
  try {
    while (c.dirty) {
      c.dirty = false;
      const { desc, blobs } = await volumeToZarr(c.labelmap, c.dims, "|u1");
      store.add(blobs);
      live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
      markEdited(live, segId);
      await pendingPaint.get(segId);
    }
    let v = 0; for (let i = 0; i < c.labelmap.length; i++) if (c.labelmap[i]) v++;
    return v;
  } finally { c.uploading = false; }
}

/**
 * A LABELMAP SHOWN WHILE A TOOL IS OPEN (the Threshold tool's preview, 2026-10-30): written into the segmentation so the
 * slices and the 3D view draw it as it would be written, but stored uncompressed and not marked edited -- the tool puts
 * the original back on Cancel, and writes it for real with writeLabelmap. Uncompressed because it follows a dragged line:
 * 4 ms for 3.4 M voxels and 31 ms for 30 M, against 77 and 633 ms compressed (measured 2026-10-30). Returns the hashes
 * it stored (null when `stillWanted` said no by the time it was made), so the editor can give back those a later preview
 * replaced.
 */
export async function showLabelmap(live: LiveScene, store: LocalBlobStore, segId: string, labels: Uint8Array, stillWanted: () => boolean = () => true): Promise<string[] | null> {
  const n = live.nodes.get(segId); if (!n) throw new Error("no segmentation " + segId);
  const { desc, blobs } = await volumeToZarr(labels, n.dims as [number, number, number], "|u1", { compressor: "raw" });
  // Cancelled or replaced while it was being made: written now, it would cover what Cancel put back.
  if (!stillWanted() || !live.nodes.has(segId)) return null;
  store.add(blobs);
  live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
  invalidatePaintCache(segId);
  return [...blobs.keys()];
}

/** A labelmap written into a segmentation as an edit (a tool's result): compressed, marked edited. */
export async function writeLabelmap(live: LiveScene, store: LocalBlobStore, segId: string, labels: Uint8Array): Promise<void> {
  const n = live.nodes.get(segId); if (!n) throw new Error("no segmentation " + segId);
  const { desc, blobs } = await volumeToZarr(labels, n.dims as [number, number, number], "|u1");
  store.add(blobs);
  live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
  markEdited(live, segId);
  invalidatePaintCache(segId);
}

