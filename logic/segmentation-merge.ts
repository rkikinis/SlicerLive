// Merging several segmentations of one volume into one. Pure: labelmaps in, one labelmap out.
//
// WHY. Ron, with four MOOSE results on one CT: "Moose does everything separate: abdominal organs,
// cardiac, digestive system. How do I merge them once they are listed in segmentations?" Each
// segmentation owns its own labelmap, so a merge is a voxel operation: every input label is given
// a new value in one byte-wide map, in the order the inputs were given.
//
// OVERLAP IS THE USER'S CALL. Two networks can claim one voxel -- ts:total's lung lobes and
// ts:lung_vessels' vessels do, wholesale -- and there is no rule that decides that honestly. Ron:
// "it will require user input at runtime." So the merge is two passes: findOverlaps() counts, per
// pair of structures from different inputs, how many voxels both claim; the caller shows that and
// collects a decision per pair; mergeLabelmaps() applies them. A pair without a decision goes to the
// EARLIER input, which is the order the user ticked them -- stated, and reported as such.
//
// The result is a new segmentation. The inputs are not touched.

export interface MergeSegment {
  labelValue: number;
  name: string;
  color: [number, number, number];
  /** The catalog key, when known, so the anatomy tree places it without re-deriving. */
  structure?: string;
}

export interface MergeInput {
  id: string;
  name: string;
  labelmap: Uint8Array;
  segments: MergeSegment[];
  /** The network that made this input, when one did (the scene node's `origin.task`). */
  task?: string;
}

/** Two structures from two different inputs that share voxels. `a` is from the earlier input. */
export interface Overlap {
  a: { input: number; label: number };
  b: { input: number; label: number };
  voxels: number;
}

export type Winner = "a" | "b";

/** The key a decision is stored under: earlier input first. */
export function overlapKey(o: Overlap): string {
  return `${o.a.input}:${o.a.label}|${o.b.input}:${o.b.label}`;
}

/** Every pair of structures, across inputs, that claim at least one voxel in common, most voxels first. */
/** How many voxels are claimed by more than one input, each counted ONCE -- the number a headline
 *  can say. Summing the pairs overcounts a voxel three inputs claim (critic, 2026-09-17, finding 12). */
export function countContested(inputs: MergeInput[]): number {
  if (inputs.length < 2) return 0;
  const n = inputs[0].labelmap.length, maps = inputs.map((i) => i.labelmap);
  let contested = 0;
  for (let v = 0; v < n; v++) {
    let claims = 0;
    for (let i = 0; i < maps.length && claims < 2; i++) if (maps[i][v]) claims++;
    if (claims > 1) contested++;
  }
  return contested;
}

/** The pair key packs the input index in 4 bits, so 16 inputs is the most this can tell apart;
 *  a 17th would alias pairs and send a decision to the wrong structures (finding 12). */
export const MAX_MERGE_INPUTS = 16;

export function findOverlaps(inputs: MergeInput[]): Overlap[] {
  if (inputs.length < 2) return [];
  if (inputs.length > MAX_MERGE_INPUTS) throw new Error(`${inputs.length} segmentations at once; a merge takes at most ${MAX_MERGE_INPUTS}. Merge in two steps`);
  const n = inputs[0].labelmap.length;
  for (const inp of inputs) if (inp.labelmap.length !== n) throw new Error(`"${inp.name}" has ${inp.labelmap.length} voxels, the first has ${n}: not the same volume`);
  const counts = new Map<number, number>();
  const maps = inputs.map((i) => i.labelmap);
  const k = maps.length;
  // One pass. A voxel with labels in two or more inputs is the rare case; the fast path is the
  // per-voxel loop over k arrays with no allocation.
  for (let v = 0; v < n; v++) {
    for (let i = 0; i < k; i++) {
      const la = maps[i][v];
      if (!la) continue;
      for (let j = i + 1; j < k; j++) {
        const lb = maps[j][v];
        if (!lb) continue;
        const key = ((i * 256 + la) * 16 + j) * 256 + lb;       // up to 16 inputs, 256 labels
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const out: Overlap[] = [];
  for (const [key, voxels] of counts) {
    const lb = key % 256, j = Math.floor(key / 256) % 16, la = Math.floor(key / 4096) % 256, i = Math.floor(key / (4096 * 256));
    out.push({ a: { input: i, label: la }, b: { input: j, label: lb }, voxels });
  }
  return out.sort((x, y) => y.voxels - x.voxels);
}

export interface MergeResult {
  labelmap: Uint8Array;
  /** The merged segment list, renumbered 1..n in input order; `source` says where each came from. */
  segments: (MergeSegment & { source: { input: number; labelValue: number } })[];
  /** Voxels that more than one input claimed. */
  contested: number;
  /** How many of those went to the later input because a decision said so. */
  wonByLater: number;
  /** Voxel claims dropped because their label is in no input's segment list. 0 is the normal case. */
  unlistedVoxels: number;
  /** Voxel claims dropped because the person left the structure out. */
  leftOutVoxels: number;
}

/**
 * One labelmap from several. `decisions` is keyed by overlapKey(); a missing decision means the
 * earlier input keeps the voxel. Throws when the inputs together have more than 255 structures,
 * because the labelmap is a byte and silently dropping structures would be worse.
 */
/** The key a structure is left out under: `input:label`. */
export function structureKey(input: number, label: number): string { return `${input}:${label}`; }

/**
 * One labelmap from several. `decisions` is keyed by overlapKey(); a missing decision means the
 * earlier input keeps the voxel. `leaveOut` names structures (structureKey) dropped from the result
 * entirely -- every voxel, not only the contested ones. Ron, 2026-09-21, on a psoas major the
 * abdominal network cuts off at the bottom while ts:total's iliopsoas is whole: "I would like to
 * completely discard the psoas from that task." A left-out structure is no claim, so a voxel only
 * it held comes out unlabeled and a voxel it shared goes to the other claimant without a decision.
 */
export function mergeLabelmaps(inputs: MergeInput[], decisions: Map<string, Winner>, leaveOut: ReadonlySet<string> = new Set()): MergeResult {
  if (!inputs.length) throw new Error("nothing to merge");
  const n = inputs[0].labelmap.length;
  for (const inp of inputs) if (inp.labelmap.length !== n) throw new Error(`"${inp.name}" has ${inp.labelmap.length} voxels, the first has ${n}: not the same volume`);
  const total = inputs.reduce((s, i) => s + i.segments.length, 0);
  if (total > 255) throw new Error(`${total} structures together; a labelmap holds at most 255. Merge fewer at a time`);

  // New label per (input, old label), sequential in input order.
  const remap = inputs.map(() => new Uint8Array(256));
  const segments: MergeResult["segments"] = [];
  let next = 1;
  const dropped = inputs.map(() => new Uint8Array(256));
  inputs.forEach((inp, i) => {
    for (const s of inp.segments) {
      if (s.labelValue <= 0 || s.labelValue > 255) continue;
      if (leaveOut.has(structureKey(i, s.labelValue))) { dropped[i][s.labelValue] = 1; continue; }
      remap[i][s.labelValue] = next;
      segments.push({ ...s, labelValue: next, source: { input: i, labelValue: s.labelValue } });
      next++;
    }
  });

  // The decisions as a lookup the voxel loop can afford: later wins for (i, la, j, lb).
  const laterWins = new Set<number>();
  for (const [key, w] of decisions) {
    if (w !== "b") continue;
    const m = key.match(/^(\d+):(\d+)\|(\d+):(\d+)$/);
    if (!m) continue;
    laterWins.add(((+m[1] * 256 + +m[2]) * 16 + +m[3]) * 256 + +m[4]);
  }

  const out = new Uint8Array(n);
  const maps = inputs.map((i) => i.labelmap);
  const k = maps.length;
  let contested = 0, wonByLater = 0, unlisted = 0, leftOut = 0;
  for (let v = 0; v < n; v++) {
    let wi = -1, wl = 0, wasContested = false, later = false;
    for (let i = 0; i < k; i++) {
      const l = maps[i][v];
      if (!l) continue;
      if (dropped[i][l]) { leftOut++; continue; }                  // left out on purpose: not a claim
      // A LABEL NO SEGMENT NAMES IS NOT A CLAIM. With it as the first winner, a later input's real
      // structure counted as contested and lost by default to remap 0 -- the voxel came out
      // unlabeled although one input had a named structure there (second critic, 2026-09-17,
      // finding 7). Counted, and skipped.
      if (!remap[i][l]) { unlisted++; continue; }
      if (wi < 0) { wi = i; wl = l; continue; }
      wasContested = true;
      if (laterWins.has(((wi * 256 + wl) * 16 + i) * 256 + l)) { wi = i; wl = l; later = true; }
    }
    if (wasContested) { contested++; if (later) wonByLater++; }
    if (wi >= 0) out[v] = remap[wi][wl];
  }
  return { labelmap: out, segments, contested, wonByLater, unlistedVoxels: unlisted, leftOutVoxels: leftOut };
}

/** A voxel box in ijk, inclusive: [i0, j0, k0, i1, j1, k1]. */
export type VoxelBox = [number, number, number, number, number, number];

export interface OverlapGeometry {
  /** Every structure's voxel box, by structureKey. */
  boxes: Map<string, VoxelBox>;
  /** The mean ijk of the voxels each pair shares, by overlapKey. */
  centroids: Map<string, [number, number, number]>;
}

/**
 * Where each structure is and where each pair meets -- what a review needs to frame a pair: the
 * slices zoomed to the extent of the two structures and positioned through their shared voxels.
 * One pass over the labelmaps; `dims` is [nx, ny, nz] with i fastest, as the labelmaps are stored.
 */
export function overlapGeometry(inputs: MergeInput[], dims: [number, number, number]): OverlapGeometry {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const maps = inputs.map((i) => i.labelmap);
  const k = maps.length;
  // Boxes as flat typed arrays: 6 numbers per (input, label), no allocation in the loop.
  const box = inputs.map(() => { const b = new Int32Array(256 * 6); for (let l = 0; l < 256; l++) { b[l * 6] = b[l * 6 + 1] = b[l * 6 + 2] = 1 << 30; b[l * 6 + 3] = b[l * 6 + 4] = b[l * 6 + 5] = -1; } return b; });
  const sums = new Map<number, [number, number, number, number]>();   // pair key -> sum i, sum j, sum k, count
  let v = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, v++) {
    for (let i = 0; i < k; i++) {
      const la = maps[i][v];
      if (!la) continue;
      const b = box[i], o = la * 6;
      if (x < b[o]) b[o] = x; if (y < b[o + 1]) b[o + 1] = y; if (z < b[o + 2]) b[o + 2] = z;
      if (x > b[o + 3]) b[o + 3] = x; if (y > b[o + 4]) b[o + 4] = y; if (z > b[o + 5]) b[o + 5] = z;
      for (let j = i + 1; j < k; j++) {
        const lb = maps[j][v];
        if (!lb) continue;
        const key = ((i * 256 + la) * 16 + j) * 256 + lb;
        let s = sums.get(key);
        if (!s) { s = [0, 0, 0, 0]; sums.set(key, s); }
        s[0] += x; s[1] += y; s[2] += z; s[3]++;
      }
    }
  }
  const boxes = new Map<string, VoxelBox>();
  inputs.forEach((inp, i) => {
    for (const s of inp.segments) {
      const o = s.labelValue * 6, b = box[i];
      if (s.labelValue <= 0 || s.labelValue > 255 || b[o + 3] < 0) continue;
      boxes.set(structureKey(i, s.labelValue), [b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]]);
    }
  });
  const centroids = new Map<string, [number, number, number]>();
  for (const [key, s] of sums) {
    const lb = key % 256, j = Math.floor(key / 256) % 16, la = Math.floor(key / 4096) % 256, i = Math.floor(key / (4096 * 256));
    centroids.set(overlapKey({ a: { input: i, label: la }, b: { input: j, label: lb }, voxels: s[3] }), [s[0] / s[3], s[1] / s[3], s[2] / s[3]]);
  }
  return { boxes, centroids };
}

/**
 * A labelmap of the voxels claimed by more than one input, each voxel carrying the index (1-based)
 * of the first pair in `overlaps` that claims it -- so a review can draw "claimed by both" as one
 * temporary segmentation and show one pair's shared voxels at a time. A byte holds 255 pairs; a
 * voxel of a later pair is left unmarked and the caller says so.
 */
export function sharedLabelmap(inputs: MergeInput[], overlaps: readonly Overlap[]): { labelmap: Uint8Array; marked: number } {
  const n = inputs[0]?.labelmap.length ?? 0;
  const index = new Map<number, number>();
  overlaps.forEach((o, i) => { if (i < 255) index.set(((o.a.input * 256 + o.a.label) * 16 + o.b.input) * 256 + o.b.label, i + 1); });
  const out = new Uint8Array(n);
  const maps = inputs.map((i) => i.labelmap);
  const k = maps.length;
  for (let v = 0; v < n; v++) {
    for (let i = 0; i < k && !out[v]; i++) {
      const la = maps[i][v];
      if (!la) continue;
      for (let j = i + 1; j < k; j++) {
        const lb = maps[j][v];
        if (!lb) continue;
        const p = index.get(((i * 256 + la) * 16 + j) * 256 + lb);
        if (p) { out[v] = p; break; }
      }
    }
  }
  return { labelmap: out, marked: Math.min(overlaps.length, 255) };
}
