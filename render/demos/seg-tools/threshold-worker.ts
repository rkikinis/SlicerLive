// THE THRESHOLD TOOL'S ARITHMETIC OFF THE PAGE'S THREAD (Ron, 2026-10-30, on the first build: "the HU slider is very
// unresponsive and not usable for precise positioning"). On the Prisma CT (30 M voxels) one preview took 0.6-0.7 s with a
// kept piece, during which the page could not move the line. Here it runs beside the page: the line follows the pointer,
// and the preview follows as fast as this can make it, the newest values winning (render/demos/seg-tools/threshold.ts).
// Bundled to webgpu/threshold-worker.js by the rebuild; loaded through workerUrl (render/build-id.ts).
import { aroundIsland, countOf, inRange, openingRoom, pieceAt, thresholdInto } from "../../../logic/threshold-tool.ts";
import type { OverwriteMode } from "../../../logic/segment-effects.ts";

type Msg =
  | { type: "scan"; data: ArrayLike<number>; dims: [number, number, number] }
  | { type: "base"; base: Uint8Array }
  | { type: "compute"; seq: number; lo: number; hi: number; seeds: number[]; keep: boolean; cut: number; drops: number[]; around: boolean; aroundSteps: number; segment: number; overwrite: OverwriteMode; visibleSegments: number[]; overSegment?: number };

let data: ArrayLike<number> | null = null, dims: [number, number, number] = [0, 0, 0], base: Uint8Array | null = null;

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === "scan") { data = m.data; dims = m.dims; return; }
  if (m.type === "base") { base = m.base; return; }
  if (!data || !base) { (self as unknown as Worker).postMessage({ seq: m.seq, error: "not ready" }); return; }
  const t0 = performance.now();
  let range = inRange(data, m.lo, m.hi);
  // Only around what the structure held before this preview: the range grown from it, a few voxels at most.
  if (m.around) { const island = new Uint8Array(base.length); for (let i = 0; i < base.length; i++) if (base[i] === m.segment) island[i] = 1; range = aroundIsland(openingRoom(range, island, data), island, dims, m.aroundSteps); }
  let result = range;
  if (m.keep && m.seeds.length) {
    result = new Uint8Array(range.length);
    for (const s of m.seeds) { const p = pieceAt(range, dims, s, m.cut); if (p) for (let i = 0; i < p.length; i++) if (p[i]) result[i] = 1; }
  }
  // Option-clicked pieces are taken out of what is shown (Ron: "option-click removes").
  for (const d of m.drops ?? []) if (result[d]) { const p = pieceAt(result, dims, d, 0); if (p) { if (result === range) result = range.slice(); for (let i = 0; i < p.length; i++) if (p[i]) result[i] = 0; } }
  const labels = thresholdInto(base, result, { segment: m.segment, overwrite: m.overwrite, visibleSegments: m.visibleSegments, overSegment: m.overSegment });
  (self as unknown as Worker).postMessage({ seq: m.seq, labels, count: countOf(result), ms: performance.now() - t0 }, [labels.buffer]);
};
