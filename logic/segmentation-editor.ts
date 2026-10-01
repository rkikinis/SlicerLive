// Native segmentation editor (W5) — create a segmentation over a source volume and apply the Segment Editor
// effects (logic/segment-effects.ts) by materializing the new labelmap: fetch the current labelmap zarr,
// run the effect, re-upload as a content-addressed zarr, and patch the segmentation node's `zarr` so the
// SegmentationDisplayableManager re-bakes. Discrete-effect editing (threshold/islands/smoothing/margin);
// interactive paint stays on the GPU EditableSegmentation path. This is where W5 materializes voxels — the
// unified field-op backend will host these ops (GPU + out-of-core) later.
import type { LiveScene } from "../render/livescene.ts";
import { cacheDecodedVolumeNative } from "../render/zarr.ts";
import type { MrsonNode } from "../render/mrson.ts";
import type { ZarrDesc } from "../render/zarr.ts";
import { fetchZarrVolumeNative } from "../render/zarr.ts";
import { LocalBlobStore, volumeToZarr } from "./ingest.ts";
import { applyAutoThreshold, applyIslands, applyLogical, applyMargin, applySmoothing, applyThreshold, segmentStatistics, type LogicalOp, type OverwriteMode, type SegmentStats } from "./segment-effects.ts";
import type { ThresholdMethod } from "../algorithms/kernels/auto-threshold.ts";
import { applyRowMajor, type Vec3 } from "../render/mat4.ts";
import { invertRowMajor } from "./transforms.ts";
import { frameIsCurrent, joinSequence } from "./sequences.ts";

let segSeq = 0;
// Slicer default new-segment colours (GenericAnatomyColors sequence, from vtkSegment defaults).
const SEG_PALETTE = [[0.502, 0.6824, 0.502], [0.9451, 0.8392, 0.5686], [0.6941, 0.4784, 0.3961], [0.4353, 0.7216, 0.8235], [0.8471, 0.3961, 0.3098], [0.8667, 0.5098, 0.3961]];

async function emptyLabelmap(store: LocalBlobStore, dims: [number, number, number]): Promise<ZarrDesc> {
  const { desc, blobs } = await volumeToZarr(new Uint8Array(dims[0] * dims[1] * dims[2]), dims, "|u1");
  store.add(blobs);
  return desc;
}

/** Create a segmentation node (empty labelmap matching the source geometry) + one segment. */
export async function createSegmentation(live: LiveScene, store: LocalBlobStore, sourceImageId: string, opts: { name?: string } = {}): Promise<{ segId: string; segment: number }> {
  const src = live.nodes.get(sourceImageId); if (!src) throw new Error("no source image " + sourceImageId);
  const dims = src.dims as [number, number, number];
  const zarr = await emptyLabelmap(store, dims);
  const segId = `local-segmentation-${++segSeq}`;
  const node: MrsonNode = {
    type: "segmentation", id: segId, name: opts.name ?? "Segmentation", frame: "RAS", dims,
    ijkToRAS: src.ijkToRAS, zarr, refs: { source: [sourceImageId] },
    segments: [{ labelValue: 1, name: "Segment_1", color: SEG_PALETTE[0], visible: true }],
    visible: true, opacity: 1, source: { mrmlClass: "vtkMRMLSegmentationNode" }, origin: { local: true },
  } as unknown as MrsonNode;
  live.write({ op: "put", id: segId, node });
  return { segId, segment: 1 };
}

/**
 * THE DIRTY MARK. A segmentation that was edited since it was last saved says so on its node:
 * `edited: true`, set by every voxel edit (paint, threshold, margin) and cleared by the save.
 * Without it nothing distinguished an edited segmentation from the file it came from, and a
 * saved scene would have reloaded the OLD file tomorrow without a word (the critic on the scene
 * review, 2026-09-19, finding 12; SCENE-DESIGN §3).
 */
export function markEdited(live: LiveScene, segId: string): void {
  const n = live.nodes.get(segId);
  if (n && n.edited !== true) live.write({ op: "patch", id: segId, path: "#/edited", value: true });
}

/** Append a new segment; returns its label value. */
export function addSegment(live: LiveScene, segId: string, opts: { name?: string; color?: number[] } = {}): number {
  const n = live.nodes.get(segId); if (!n) throw new Error("no segmentation " + segId);
  const segs = ((n.segments as { labelValue: number }[] | undefined) ?? []).slice();
  const labelValue = segs.reduce((m, s) => Math.max(m, s.labelValue), 0) + 1;
  segs.push({ labelValue, name: opts.name ?? `Segment_${labelValue}`, color: opts.color ?? SEG_PALETTE[(labelValue - 1) % SEG_PALETTE.length], visible: true } as unknown as { labelValue: number });
  live.write({ op: "patch", id: segId, path: "#/segments", value: segs });
  return labelValue;
}

export interface EffectParams {
  segment: number; overwrite?: OverwriteMode;
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
export async function applyEffect(live: LiveScene, store: LocalBlobStore, segId: string, effect: "threshold" | "autoThreshold" | "islands" | "smoothing" | "margin" | "logical", params: EffectParams): Promise<{ voxels: number; threshold?: number }> {
  const seg = live.nodes.get(segId); if (!seg?.zarr) throw new Error("no segmentation " + segId);
  const dims = seg.dims as [number, number, number];
  const lab = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
  const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);

  let out: Uint8Array, threshold: number | undefined;
  if (effect === "threshold" || effect === "autoThreshold") {
    const srcId = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    const srcNode = srcId ? live.nodes.get(srcId) : undefined;
    if (!srcNode?.zarr) throw new Error("threshold needs a source volume");
    const src = await fetchZarrVolumeNative(live.blobBase(), srcNode.zarr as ZarrDesc);
    if (effect === "autoThreshold") { const r = applyAutoThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, method: params.autoMethod ?? "otsu" }); out = r.labelmap; threshold = r.threshold; }
    else out = applyThreshold(labelmap, src.data, dims, { segment: params.segment, overwrite: params.overwrite, lower: params.lower ?? 0, upper: params.upper ?? 0 });
  } else if (effect === "islands") {
    out = applyIslands(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, operation: params.islands ?? "keepLargest", minSize: params.minSize });
  } else if (effect === "smoothing") {
    out = applySmoothing(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, method: params.smooth ?? "median", radiusVoxels: params.radiusVoxels });
  } else if (effect === "logical") {
    out = applyLogical(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, operation: params.logical ?? "union", other: params.other });
  } else {
    const sp = spacingFromIjkToRAS(seg.ijkToRAS as number[]);
    out = applyMargin(labelmap, dims, { segment: params.segment, overwrite: params.overwrite, marginMm: params.marginMm ?? 0, spacingMm: sp });
  }

  const { desc, blobs } = await volumeToZarr(out, dims, "|u1");
  store.add(blobs);
  live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
  markEdited(live, segId);
  invalidatePaintCache(segId);
  let voxels = 0; for (let i = 0; i < out.length; i++) if (out[i] === params.segment) voxels++;
  return { voxels, threshold };
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
interface PaintCache { labelmap: Uint8Array; dims: [number, number, number]; ijkToRAS: number[]; invIjk: number[]; spacing: Vec3; dirty: boolean; uploading: boolean; }
const paintCaches = new Map<string, PaintCache>();

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
/** Drop the resident labelmap (call when the segmentation changes underneath, e.g. after a discrete effect). */
export function invalidatePaintCache(segId?: string) { if (segId) paintCaches.delete(segId); else paintCaches.clear(); }

export interface PaintParams { segment: number; radiusMm: number; mode: "add" | "remove"; sphere?: boolean; normal?: Vec3; }

/** Rasterize a brush swept along the stroke into the resident labelmap (in-place). Consecutive points are
 *  connected by interpolation (step <= half the radius) so a fast drag leaves a CONTINUOUS stroke, not gaps.
 *  Marks the cache dirty. */
export async function paintStroke(live: LiveScene, segId: string, points: Vec3[], params: PaintParams): Promise<void> {
  const c = await paintCache(live, segId); if (!c) return;
  const [nx, ny, nz] = c.dims;
  const [sx, sy, sz] = c.spacing;
  const r = params.radiusMm, r2 = r * r;
  const val = params.mode === "add" ? params.segment : 0;
  const ri = Math.ceil(r / (sx || 1)), rj = Math.ceil(r / (sy || 1)), rk = Math.ceil(r / (sz || 1));
  const n = params.normal;
  const m = c.ijkToRAS;   // direction cosines: a voxel step (di,dj,dk) maps to a RAS offset via the 3x3 linear part
  // disk half-thickness along the normal = the RAS extent of the volume axis MOST aligned with the slice normal
  // (so a 2D brush is exactly one voxel thick in the volume plane parallel to the slice, whatever the axes are).
  let halfThick = 0;
  if (n) for (let a = 0; a < 3; a++) halfThick = Math.max(halfThick, Math.abs(m[a] * n[0] + m[4 + a] * n[1] + m[8 + a] * n[2]));
  halfThick *= 0.5;

  const stamp = (p: Vec3) => {
    const ijk = applyRowMajor(c.invIjk, p);
    const ci = Math.round(ijk[0]), cj = Math.round(ijk[1]), ck = Math.round(ijk[2]);
    for (let dk = -rk; dk <= rk; dk++) for (let dj = -rj; dj <= rj; dj++) for (let di = -ri; di <= ri; di++) {
      const i = ci + di, j = cj + dj, k = ck + dk;
      if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) continue;
      const rx = m[0] * di + m[1] * dj + m[2] * dk;   // RAS offset of this voxel from the stamp centre
      const ry = m[4] * di + m[5] * dj + m[6] * dk;
      const rz = m[8] * di + m[9] * dj + m[10] * dk;
      if (rx * rx + ry * ry + rz * rz > r2) continue;                                        // sphere/disk radius (RAS mm)
      if (!params.sphere && n && Math.abs(rx * n[0] + ry * n[1] + rz * n[2]) > halfThick) continue;   // one-voxel-thick, in the slice plane
      c.labelmap[k * nx * ny + j * nx + i] = val;
    }
  };

  const stepMm = Math.max(0.5, Math.min(r, sx, sy, sz) * 0.5 || r * 0.5);   // dense enough to overlap adjacent stamps
  let prev: Vec3 | null = null;
  for (const p of points) {
    if (prev) {
      const seg: Vec3 = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]];
      const len = Math.hypot(seg[0], seg[1], seg[2]);
      const steps = Math.max(1, Math.ceil(len / stepMm));
      for (let sIdx = 1; sIdx <= steps; sIdx++) { const t = sIdx / steps; stamp([prev[0] + seg[0] * t, prev[1] + seg[1] * t, prev[2] + seg[2] * t]); }
    } else stamp(p);
    prev = p;
  }
  c.dirty = true;
}

/** Upload the resident labelmap and patch the segmentation (call on a throttle + at stroke end). */
export async function commitPaint(live: LiveScene, store: LocalBlobStore, segId: string): Promise<number> {
  const c = paintCaches.get(segId); if (!c || !c.dirty || c.uploading) return 0;
  c.uploading = true; c.dirty = false;
  try {
    const { desc, blobs } = await volumeToZarr(c.labelmap, c.dims, "|u1");
    store.add(blobs);
    live.write({ op: "patch", id: segId, path: "#/zarr", value: desc });
    markEdited(live, segId);
    let v = 0; for (let i = 0; i < c.labelmap.length; i++) if (c.labelmap[i]) v++;
    return v;
  } finally { c.uploading = false; }
}

/**
 * Create a segmentation node from an ALREADY-DECODED labelmap (see readers/dicom-seg.ts), on the
 * geometry of `sourceImageId`.
 *
 * Unlike createSegmentation this does not start empty and does not invent segments: the labelmap
 * and the segment list both come from the source object, so a DICOM SEG keeps its own segment
 * numbers, names and recommended colors rather than being renumbered.
 *
 * Segments carrying no voxels are dropped: a SEG can declare segments it never wrote any frames
 * for (the 2025-07-16 nnInteractive object declares 68 and fills 67), and listing empty ones gives
 * a segment list that does not match what is on screen.
 */
export async function createSegmentationFromLabelmap(
  live: LiveScene,
  store: LocalBlobStore,
  sourceImageId: string,
  labelmap: Uint8Array,
  segments: {
    labelValue: number;
    name: string;
    color: [number, number, number];
    /** The catalog key this segment is, when the caller knew it — so the tree never has to
     *  re-derive it from a display name, which is ambiguous where two catalogs share one. */
    structure?: string;
    /** The value the SOURCE used for this structure, when the labelmap had to be renumbered to fit
     *  a byte. FreeSurfer's 17 means left hippocampus wherever it is written; keeping it means the
     *  renumbering is reversible and a result can still be matched against the file it came from. */
    sourceLabelValue?: number;
  }[],
  opts: {
    name?: string;
    /** Where the time went, so the remainder can be attributed rather than guessed at. */
    onPhases?: (p: { histogramMs: number; ingestMs: number }) => void;
    /**
     * The network that produced this, e.g. `fastsurfer:brain`.
     *
     * It reaches the DICOM SEG as `SegmentAlgorithmName` (0062,0009) -- the standard's own place for
     * which algorithm made a segment -- via `origin.task`, which slicer-app already passes to the
     * exporter. Without it a result is written as MANUAL and the round trip loses the one fact that
     * says how it should be named, colored and presented when it comes back.
     */
    task?: string;
    /**
     * Start with the 3D view of this segmentation OFF (2D still on).
     *
     * Ron: "by default the 3d of label maps should be off when loading from the dicom db." Loading a
     * stored SEG is a review action -- you open it to look at the slices -- and a full-body labelmap
     * arriving in 3D unasked costs a smoothed volume plus its blur scratch, and buries the anatomy
     * you opened it to see. The Subject Hierarchy's 3D button turns it on, which is one click in the
     * module you are already in.
     */
    hiddenIn3D?: boolean;
    /**
     * WHERE THIS SEGMENTATION CAME FROM, merged into `origin`.
     *
     * A SEG loaded from the DICOM database recorded only `{ local: true, task }` -- so it did not
     * know which series it was, and everything that asks "what is this segmentation's series" fell
     * through to the images it sits on. That is what made the surface round trip miss on the load
     * side: the stored surfaces are parented to the SEG's series, the lookup asked with the CT's,
     * and the answer was to extract again. Ron: "It recomputed the surfaces."
     *
     * Third time the two ends of this have disagreed about identity, so it is a parameter now
     * rather than something each caller assembles.
     */
    origin?: Record<string, unknown>;
  } = {},
): Promise<{ segId: string; segments: number; built: { desc: Record<string, unknown>; chunks: Map<string, Uint8Array>; segments: Segment[] } }> {
  const src = live.nodes.get(sourceImageId);
  if (!src) throw new Error("no source image " + sourceImageId);
  const dims = src.dims as [number, number, number];
  const expected = dims[0] * dims[1] * dims[2];
  if (labelmap.length !== expected) {
    throw new Error(`labelmap is ${labelmap.length} voxels, but ${(src.name as string) ?? sourceImageId} is ${expected}`);
  }

  // Which label values actually occur -- the question that decides which segments are listed, since
  // one with no voxels must not be. `new Set(labelmap)` hashes and inserts 149 MILLION elements to
  // learn 68 answers; a 256-entry presence array answers it in one pass with no allocation.
  //
  // AND THAT PASS IS NOT MADE HERE ANY MORE. The chunking below already reads every voxel, in the
  // worker pool, so the count comes back with it (`census`): eight ways parallel, inside time that
  // was being spent anyway. On Ron's scene the pass on this thread was 0.8 s per whole-body
  // labelmap, 3.25 s for four, and it is the one phase of a load that was pure main-thread work
  // (measured with the load profiler, 2026-09-22).
  const tZarr = performance.now();
  const { desc, blobs, seen: census } = await volumeToZarr(labelmap, dims, "|u1", { census: true });
  const zarrMs = performance.now() - tZarr;
  const tHist = performance.now();
  const seen = census ?? (() => { const s8 = new Uint8Array(256); for (let i = 0; i < labelmap.length; i++) s8[labelmap[i]] = 1; return s8; })();
  const histMs = performance.now() - tHist;
  const kept = segments.filter((s) => s.labelValue >= 0 && s.labelValue < 256 && seen[s.labelValue] === 1);

  // Labelmaps are still deflated, and this is where the cost of that shows. Note the cache line
  // below: like the grayscale path, these chunks are handed straight to the reader, so nothing
  // decompresses them in the session that paid to compress them. The reason to keep deflate here is
  // space, not speed -- a labelmap is mostly zeros and shrinks by more than an order of magnitude --
  // and the compressor field means that choice can be revisited per store rather than per format.
  opts.onPhases?.({ histogramMs: histMs, ingestMs: zarrMs });
  store.add(blobs);
  // Same round trip the scalar path had: the colorize field asks for this labelmap through
  // fetchZarrVolume, which would fetch the chunks just written and inflate every one to rebuild the
  // array already in hand. Seed the reader instead. Float32 because fetchZarrVolume returns that.
  // Cached in its STORED dtype: widening 149M labels to Float32 would allocate 596 MB and convert
  // element by element, costing more than the round trip this avoids.
  cacheDecodedVolumeNative(desc, { data: labelmap, dtype: "|u1", dims, range: [0, 255] });

  const segId = `local-segmentation-${++segSeq}`;
  const node: MrsonNode = {
    type: "segmentation", id: segId, name: opts.name ?? "Segmentation", frame: "RAS", dims,
    ijkToRAS: src.ijkToRAS, zarr: desc, refs: { source: [sourceImageId] },
    segments: kept.map((s, i) => ({
      labelValue: s.labelValue,
      ...(s.structure ? { structure: s.structure } : {}),
      ...(s.sourceLabelValue !== undefined && s.sourceLabelValue !== s.labelValue
        ? { sourceLabelValue: s.sourceLabelValue }
        : {}),
      // What the file said (codes, its own label and color), carried through untouched: the
      // mapping place's answer is used, the file's kept as a record (load-panel.ts, the SEG load).
      ...((s as { fileCodes?: unknown }).fileCodes ? { fileCodes: (s as { fileCodes?: unknown }).fileCodes } : {}),
      ...((s as { fileLabel?: string }).fileLabel ? { fileLabel: (s as { fileLabel?: string }).fileLabel } : {}),
      ...((s as { fileColor?: number[] }).fileColor ? { fileColor: (s as { fileColor?: number[] }).fileColor } : {}),
      name: s.name,
      // A SEG that gives every segment the same recommended color (white is the fallback) would be
      // unreadable; fall back to the palette so segments stay distinguishable.
      color: s.color[0] === 1 && s.color[1] === 1 && s.color[2] === 1 ? SEG_PALETTE[i % SEG_PALETTE.length] : s.color,
      visible: true,
    })),
    // A member for a frame that is not on screen enters dark; the sequence shows it on its frame.
    ...(frameIsCurrent(live, sourceImageId) === false
      ? { visible: false, visible3D: false }
      : { visible: true, ...(opts.hiddenIn3D ? { visible3D: false } : {}) }),
    opacity: 1, source: { mrmlClass: "vtkMRMLSegmentationNode" },
    origin: { local: true, ...(opts.task ? { task: opts.task } : {}), ...(opts.origin ?? {}) },
  } as unknown as MrsonNode;
  // NOTHING STEPS ASIDE ANY MORE.
  //
  // This used to hide every other segmentation, because the slice renderer bound ONE overlay texture
  // while 3D composited all of them -- so a second run left the views disagreeing and the newest one
  // was made to win. The slice shader now carries two overlays with independent geometry, which is
  // what Ron wanted in the first place: two networks over one study are there to be read against
  // each other, and hiding one is not reading them against each other.
  //
  // Beyond two, 2D draws the first two of the visible ones and reports how many it took; the eye and
  // 3D buttons on every Segmentations row are how you choose which.
  live.write({ op: "put", id: segId, node });
  // Made on a frame of a sequence: it joins the sequence at that frame (the beating heart's
  // surfaces are five of these, one per phase), and the browser steps it with the images.
  joinSequence(live, segId);
  // THE BUILT FORM, for the caller to keep (logic/readers/built-seg-cache.ts): the chunks and the
  // settled segment list, which together are what a second load would otherwise decode and compress
  // all over again. Three megabytes for four whole-body segmentations, measured 2026-09-22.
  return { segId, segments: kept.length, built: { desc: desc as unknown as Record<string, unknown>, chunks: blobs, segments: node.segments as Segment[] } };
}

/**
 * The same segmentation, from a build that was kept rather than done again.
 *
 * Everything that depends on the FILE — the voxels as chunks, the segment list with its colors and
 * codes — comes from the record; everything that depends on this load — the name, where it came
 * from, whether 3D starts on — comes from the caller, exactly as in the path above. The two must
 * stay in step: a change to what the build produces is a change to BUILD_CODE.
 */
export function createSegmentationFromBuilt(
  live: LiveScene,
  store: LocalBlobStore,
  sourceImageId: string,
  built: { desc: Record<string, unknown>; chunks: Record<string, Uint8Array> | Map<string, Uint8Array>; segments: Segment[] },
  opts: { name?: string; task?: string; hiddenIn3D?: boolean; origin?: Record<string, unknown> } = {},
): { segId: string; segments: number } {
  const src = live.nodes.get(sourceImageId);
  if (!src) throw new Error("no source image " + sourceImageId);
  const chunks = built.chunks instanceof Map ? built.chunks : new Map(Object.entries(built.chunks).map(([h, b]) => [h, b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer)]));
  store.add(chunks);
  const segId = `local-segmentation-${++segSeq}`;
  const node = {
    type: "segmentation", id: segId, name: opts.name ?? "Segmentation", frame: "RAS",
    dims: src.dims as [number, number, number], ijkToRAS: src.ijkToRAS, zarr: built.desc,
    refs: { source: [sourceImageId] },
    segments: built.segments,
    ...(frameIsCurrent(live, sourceImageId) === false
      ? { visible: false, visible3D: false }
      : { visible: true, ...(opts.hiddenIn3D ? { visible3D: false } : {}) }),
    opacity: 1, source: { mrmlClass: "vtkMRMLSegmentationNode" },
    origin: { local: true, ...(opts.task ? { task: opts.task } : {}), ...(opts.origin ?? {}) },
  } as unknown as MrsonNode;
  live.write({ op: "put", id: segId, node });
  joinSequence(live, segId);
  return { segId, segments: built.segments.length };
}
