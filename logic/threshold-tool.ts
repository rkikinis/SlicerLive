// THE THRESHOLD TOOL'S ARITHMETIC (Ron, 2026-10-30: "yes, lets start with the thershold tool"; the shape and its answers in
// Contents/docs/SEGMENT-EDITOR.md, the mockup mockups/segment-editor-threshold-2026-10-30.html). Pure functions on arrays,
// so the panel (render/demos/seg-tools/threshold.ts) stays a picture of them and the tests can check every rule:
//   - the scan's histogram, one bin per gray value for integer scans, and its useful range (1st to 99.5th percentile),
//     which is what the histogram spans when the tool opens (Ron: "Histo zoom: agreed");
//   - the voxels in range;
//   - "Keep only the piece I click": the connected piece under the click, after connections up to `cut` voxels thick are
//     cut, so a tumor does not run into the fluid around the brain (Ron: the size "under advanced");
//   - what is written: the structure's contents REPLACED by the result, under the editor's "over" rule
//     (segment-effects.ts writeBack, Slicer's Apply). The preview is this same array, so what is seen is what is written.
// Sizes are in voxels (Ron, 2026-09-24: "work in voxels, not mm"); the panel gives the mm beside them.
import type { Dims, MaskOpts, Scalars } from "./segment-effects.ts";
import { writeBack } from "./segment-effects.ts";

export interface Histogram {
  /** The gray value of bin 0 and the width of a bin: bin b holds values in [lo + b*width, lo + (b+1)*width). */
  lo: number; width: number; counts: Float64Array;
  /** The scan's smallest and largest values, and the 1st and 99.5th percentiles (the "useful range"). */
  min: number; max: number; useful: [number, number];
  /** True when every value is a whole number (one bin per value). */
  integer: boolean;
}

/** The histogram of a scan. Integer scans spanning at most 65,536 values get one bin per value; anything else 4,096. */
export function histogramOf(src: Scalars): Histogram {
  let min = Infinity, max = -Infinity, integer = true;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    if (integer && v !== Math.round(v)) integer = false;
  }
  if (min > max) { min = 0; max = 0; }
  const span = max - min;
  const perValue = integer && span < 65536;
  const n = perValue ? span + 1 : 4096;
  const width = perValue ? 1 : (span || 1) / n;
  const counts = new Float64Array(n);
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (!Number.isFinite(v)) continue;
    counts[Math.min(n - 1, Math.floor((v - min) / width))]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const at = (q: number) => { let s = 0; for (let b = 0; b < n; b++) { s += counts[b]; if (s >= q * total) return min + b * width; } return max; };
  return { lo: min, width, counts, min, max, useful: [at(0.01), Math.max(at(0.995), at(0.01) + width)], integer };
}

/** 1 where lo <= value <= hi. */
export function inRange(src: Scalars, lo: number, hi: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) { const v = src[i]; out[i] = v >= lo && v <= hi ? 1 : 0; }
  return out;
}

const neighbors = (dims: Dims) => { const [nx, ny] = dims; return [1, -1, nx, -nx, nx * ny, -nx * ny]; };
/** Whether index i + d stays inside the volume (6-neighbor steps only). */
function inside(i: number, d: number, dims: Dims): boolean {
  const [nx, ny, nz] = dims, x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
  if (d === 1) return x < nx - 1; if (d === -1) return x > 0;
  if (d === nx) return y < ny - 1; if (d === -nx) return y > 0;
  if (d === nx * ny) return z < nz - 1; return z > 0;
}

/** The 6-connected piece of `mask` containing `seed` (a voxel index), or every voxel reachable inside `within`. */
function component(mask: Uint8Array, dims: Dims, seeds: number[]): Uint8Array {
  const out = new Uint8Array(mask.length), queue = new Int32Array(mask.length), d6 = neighbors(dims);
  let head = 0, tail = 0;
  for (const s of seeds) if (mask[s] && !out[s]) { out[s] = 1; queue[tail++] = s; }
  while (head < tail) {
    const i = queue[head++];
    for (const d of d6) { const j = i + d; if (mask[j] && !out[j] && inside(i, d, dims)) { out[j] = 1; queue[tail++] = j; } }
  }
  return out;
}

/** One 6-neighbor erosion: a voxel stays when it and its six neighbors are in the mask (the volume's edge counts as out). */
function erode6(mask: Uint8Array, dims: Dims): Uint8Array {
  const out = new Uint8Array(mask.length), d6 = neighbors(dims);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    let keep = 1;
    for (const d of d6) if (!inside(i, d, dims) || !mask[i + d]) { keep = 0; break; }
    out[i] = keep;
  }
  return out;
}

/**
 * KEEP ONLY THE PIECE I CLICK. The 6-connected piece of `mask` under `seed`, after connections up to `cut` voxels thick
 * are cut: the mask is eroded `cut / 2` times (one 6-neighbor erosion removes a sheet or bridge up to two voxels thick),
 * the piece under the click is taken in what is left, and it grows back the same number of steps (a voxel in any
 * direction each), never outside the mask; where a cut bridge joins the piece, a stub of at most that depth stays. A click on a part too thin to survive the cut takes the nearest surviving piece it is connected to, else the
 * uncut piece. null when the click is not in range. `cut` 0: the plain connected piece.
 */
export function pieceAt(mask: Uint8Array, dims: Dims, seed: number, cut: number): Uint8Array | null {
  if (seed < 0 || seed >= mask.length || !mask[seed]) return null;
  const r = Math.max(0, Math.floor(cut / 2));
  if (r === 0) return component(mask, dims, [seed]);
  let core = mask;
  for (let k = 0; k < r; k++) core = erode6(core, dims);
  let start = [seed];
  if (!core[seed]) {
    // The nearest voxel that survived the cut, walking inside the mask from the click.
    const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length), d6 = neighbors(dims);
    let head = 0, tail = 0, found = -1; seen[seed] = 1; queue[tail++] = seed;
    while (head < tail && found < 0) {
      const i = queue[head++];
      if (core[i]) { found = i; break; }
      for (const d of d6) { const j = i + d; if (mask[j] && !seen[j] && inside(i, d, dims)) { seen[j] = 1; queue[tail++] = j; } }
    }
    if (found < 0) return component(mask, dims, [seed]);   // nothing of this piece survives the cut: it is thin everywhere
    start = [found];
  }
  // The surviving piece, grown back r steps inside the mask, each step to all 26 neighbors (a voxel in any direction):
  // a 6-neighbor step would not give back a block's edges and corners, which the cut also took.
  const piece = component(core, dims, start), [nx, ny, nz] = dims;
  let edge: number[] = [];
  for (let i = 0; i < piece.length; i++) if (piece[i]) edge.push(i);
  for (let k = 0; k < r; k++) {
    const next: number[] = [];
    for (const i of edge) {
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
        const j = (zz * ny + yy) * nx + xx;
        if (mask[j] && !piece[j]) { piece[j] = 1; next.push(j); }
      }
    }
    edge = next;
  }
  // What grew back is joined to the piece through the mask; keep the part connected to the click's piece.
  return component(piece, dims, [piece[seed] ? seed : start[0]]);
}

/**
 * ONLY AROUND WHAT THE STRUCTURE HOLDS (Ron, 2026-10-30: "we increase the lower threshold, remove a structure (scisor or
 * one click on the connected component) and then lower the threshold, but only around the surviving island" -- an
 * opening done with the threshold: the raised line is the erosion, this is the dilation). The voxels in `range` that can
 * be reached from `island` in at most `steps` steps (a voxel in any direction each) without leaving the range; the
 * island's own voxels count when they are in range. A gap -- voxels out of range -- stops it, as does the distance.
 */
export function aroundIsland(range: Uint8Array, island: Uint8Array, dims: Dims, steps: number): Uint8Array {
  const [nx, ny, nz] = dims, out = new Uint8Array(range.length);
  let edge: number[] = [];
  for (let i = 0; i < range.length; i++) if (island[i] && range[i]) { out[i] = 1; edge.push(i); }
  for (let s = 0; s < steps && edge.length; s++) {
    const next: number[] = [];
    for (const i of edge) {
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
        const j = (zz * ny + yy) * nx + xx;
        if (range[j] && !out[j]) { out[j] = 1; next.push(j); }
      }
    }
    edge = next;
  }
  return out;
}

/**
 * THE ROOM AN OPENING MAY GROW INTO: the voxels in range that are darker than every voxel the island holds, plus the
 * island's own voxels in range. What a raised line took away is darker than the line, so lowering it brings that back;
 * a piece cut away by hand was as bright as the island and stays out (found on the Prisma CT, 2026-10-30: growing through
 * the whole range gave back the 9,789 voxels just cut, almost all of them).
 */
export function openingRoom(range: Uint8Array, island: Uint8Array, src: Scalars): Uint8Array {
  let darkest = Infinity;
  for (let i = 0; i < island.length; i++) if (island[i] && src[i] < darkest) darkest = src[i];
  const out = new Uint8Array(range.length);
  for (let i = 0; i < range.length; i++) if (range[i] && (island[i] || src[i] < darkest)) out[i] = 1;
  return out;
}

/** The labelmap as the tool would leave it: `segment` replaced by `result`, under the "over" rule. */
export function thresholdInto(labelmap: Scalars, result: Uint8Array, o: MaskOpts): Uint8Array {
  return writeBack(labelmap, result, o);
}

/** Voxels set in a mask. */
export function countOf(mask: Uint8Array): number { let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i]; return n; }
