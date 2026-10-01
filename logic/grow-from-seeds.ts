// GROW FROM SEEDS: a few strokes inside a structure and a few around it, and the structure is filled out to its edges.
//
// Ron, 2026-10-01, on outlining a brain tumor when the case has no outline: "Do we have grow from seed in the editor?
// That would do the job." Slicer's Grow from seeds (FastGrowCut) is the model; the algorithm here is Steve Pieper's
// GPU GrowCut (algorithms/effects/growcut.ts: Vezhnevets & Konouchine 2005, a cellular automaton on the graphics card),
// which existed and was tested but was reachable from nothing in the application.
//
// What this adds around it: the grow runs only in a BOX around the strokes (their extent plus a margin), as Slicer's
// does, so a brain MR of 256 x 256 x 180 grows a tumor-sized box instead of the whole head; every label among the
// strokes competes (at least two are needed: the structure, and what is not the structure); the answer is a label map
// of the whole grid, zero outside the box.
import { EditableSegmentation } from "../algorithms/editable-segmentation.ts";
import { GrowCutEffect, uploadImage } from "../algorithms/effects/growcut.ts";
import type { Vec3 } from "../algorithms/geom.ts";

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
    return await adapter.requestDevice();
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
export function seedBox(seeds: ArrayLike<number>, dims: Vec3, minMargin = 12): { lo: Vec3; hi: Vec3; labels: Set<number> } {
  const [nx, ny] = dims;
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-1, -1, -1];
  const labels = new Set<number>();
  for (let i = 0; i < seeds.length; i++) {
    const v = seeds[i];
    if (!v) continue;
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
export async function growFromSeeds(device: GPUDevice, seeds: ArrayLike<number>, image: ArrayLike<number>, dims: Vec3, opts: { minMargin?: number } = {}): Promise<GrowResult> {
  const t0 = performance.now();
  const { lo, hi, labels } = seedBox(seeds, dims, opts.minMargin);
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
  const seg = new EditableSegmentation(device, sub, { ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  const imageTex = uploadImage(device, cropImage, sub);
  const gc = new GrowCutEffect(seg, imageTex);
  try {
    seg.loadLabelmap(cropSeeds);
    const iterations = await gc.grow();
    const grown = await seg.readLabelmap();
    const labelsOut = new Uint8Array(nx * ny * dims[2]);
    for (let z = 0; z < sub[2]; z++) for (let y = 0; y < sub[1]; y++) {
      const dst = ((z + lo[2]) * ny + (y + lo[1])) * nx + lo[0], src = (z * sub[1] + y) * sub[0];
      for (let x = 0; x < sub[0]; x++) labelsOut[dst + x] = grown[src + x];
    }
    return { labels: labelsOut, box: { lo, hi }, iterations, ms: Math.round(performance.now() - t0) };
  } finally {
    seg.destroy(); gc.destroy(); imageTex.destroy();
  }
}
