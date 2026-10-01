// Grouping segments that nobody named, by measuring the CT underneath them.
//
// WHY. Interactive segmentation produces unnamed regions: nnInteractive numbers them sequentially,
// and naming each one means knowing the anatomy while you paint, which Ron reports would have
// tripled the time on a 67-segment study. So "unnamed" is the normal case, not an oversight, and a
// renderer that needs names to look right is a renderer that will not look right on real work.
//
// The colorize page gets its readability entirely from per-group opacity — bones at 100% against
// muscle at 5% — and it can do that because its structures came from TotalSegmentator, which names
// everything. Here nothing is named. But the CT is still underneath every segment, and it knows what
// tissue is there.
//
// WHAT IT ACTUALLY SEPARATES, measured on Ron's 67-segment abdomen/pelvis study before any of this
// was written, because he expected it not to work:
//
//   bone vs everything          YES, cleanly. 21 segments at 312-422 HU, and nothing at all between
//                               119 and 236 — a gap wider than the entire soft-tissue band.
//   gas-containing vs solid     YES, on the AIR FRACTION specifically. Bowel holds air: two segments
//                               at 3.1% and 3.7% of voxels below -200 HU, against 0.0% for every
//                               solid structure. Spread alone does not work — a first version also
//                               accepted SD >= 50 and swept in a contrast-filled vessel and a
//                               heterogeneous soft-tissue region, neither of which contains gas.
//   organ vs muscle             NO. Liver, kidney, spleen and muscle all sit at 30-70 HU with SD ~20
//                               and are not separable by intensity at all.
//
// So this produces four groups where the reference has seven, and the two it gets right are the two
// that matter most for a first view. It is a STARTING POINT, not a claim about anatomy: a segment in
// the wrong group is expected, and moving it is the user's to do.

/** What can be measured about one segment without knowing what it is. */
export interface SegmentStats {
  labelValue: number;
  /** Voxels carrying this label. */
  voxels: number;
  meanHU: number;
  /** Standard deviation of HU inside the segment. High means mixed content — gas, contrast, bone edge. */
  sdHU: number;
  /** Fraction of voxels below the air threshold, 0..1. Solid tissue is 0; bowel is not. */
  gasFraction: number;
}

/** A group of segments, with the opacity it starts at. */
export interface SegmentGroup {
  name: string;
  /** Label values belonging to this group. */
  members: number[];
  /** Starting opacity, from the colorize page's own defaults where a group corresponds. */
  opacity: number;
}

/** Below this is air rather than tissue: bowel gas, lung, or outside the body. */
const AIR_HU = -200;

/**
 * Thresholds, each taken from the measurement above rather than from a textbook.
 *
 * `BONE_HU` sits in the middle of an empty 117 HU gap, so it is not a knife-edge: no segment in that
 * study lies within 40 HU of it. `CONTRAST_HU` is looser and separates two segments only.
 * `GAS_FRACTION` is generous — 0.5% against observed 3.1% and 3.7% — because a false negative leaves
 * bowel rendering as solid as liver, which is the bug this exists to fix.
 *
 * There was also an `sdHU >= 50` alternative, on the reasoning that bowel is mixed content. Running
 * the classifier over the real study removed it: it caught six segments where only two have any gas
 * at all. A contrast-filled vessel has a wide spread and no air, and calling it gas-containing is
 * simply wrong; so is a heterogeneous soft-tissue region at 0.0% gas. Spread is a symptom of several
 * things, air is a symptom of one, and the rule now tests the thing it actually means.
 */
const BONE_HU = 275;
const CONTRAST_HU = 150;
const GAS_FRACTION = 0.005;

/**
 * Measure every label in a labelmap against the scalars underneath it.
 *
 * `stride` samples every Nth voxel. A mean over a third of a 149-million-voxel labelmap is
 * indistinguishable from a mean over all of it, and this runs on the main thread while a user waits.
 */
export function segmentStatistics(
  labelmap: ArrayLike<number>,
  scalars: ArrayLike<number>,
  opts: { stride?: number } = {},
): SegmentStats[] {
  const stride = Math.max(1, opts.stride ?? 3);
  const n = Math.min(labelmap.length, scalars.length);
  const sum = new Float64Array(256), sq = new Float64Array(256);
  const cnt = new Float64Array(256), air = new Float64Array(256);

  for (let i = 0; i < n; i += stride) {
    const l = labelmap[i];
    if (l === 0) continue;
    const hu = scalars[i];
    sum[l] += hu;
    sq[l] += hu * hu;
    cnt[l]++;
    if (hu < AIR_HU) air[l]++;
  }

  const out: SegmentStats[] = [];
  for (let l = 1; l < 256; l++) {
    if (cnt[l] === 0) continue;
    const mean = sum[l] / cnt[l];
    out.push({
      labelValue: l,
      voxels: cnt[l] * stride,                       // scaled back to the whole labelmap
      meanHU: mean,
      sdHU: Math.sqrt(Math.max(0, sq[l] / cnt[l] - mean * mean)),
      gasFraction: air[l] / cnt[l],
    });
  }
  return out;
}

/**
 * Which group one segment falls in, on the evidence.
 *
 * Order matters: bone is tested first because a bone segment can also carry marrow fat and would
 * otherwise look mixed, and gas is tested before intensity because bowel's mean sits squarely inside
 * the soft-tissue band -- 12 and 18 HU on the two real ones -- so only its air content gives it away.
 */
export function classify(s: SegmentStats): string {
  if (s.meanHU >= BONE_HU) return "Bone";
  if (s.gasFraction >= GAS_FRACTION) return "Gas-containing";
  if (s.meanHU >= CONTRAST_HU) return "Contrast / vessel";
  return "Soft tissue";
}

/**
 * Starting opacity per group, following the colorize page where a group corresponds to one of its.
 *
 * Soft tissue stays high because it holds the organs, which are the point of the view. That does
 * mean muscle stays high too — the reference drops muscle to 5% and this cannot tell muscle from
 * liver, which is the honest limit of inferring from intensity.
 */
const GROUP_OPACITY: Record<string, number> = {
  "Bone": 1.0,
  "Contrast / vessel": 0.9,
  "Soft tissue": 0.9,
  "Gas-containing": 0.55,
};

/** Display order: outermost and most enclosing last, so the sliders read top to bottom as depth. */
const GROUP_ORDER = ["Soft tissue", "Contrast / vessel", "Gas-containing", "Bone"];

/**
 * Sort measured segments into groups.
 *
 * Empty groups are dropped: a chest study has no bowel and should not show a slider for it.
 */
export function inferGroups(stats: readonly SegmentStats[]): SegmentGroup[] {
  const by = new Map<string, number[]>();
  for (const s of stats) {
    const g = classify(s);
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(s.labelValue);
  }
  return GROUP_ORDER
    .filter((name) => by.has(name))
    .map((name) => ({ name, members: by.get(name)!.sort((a, b) => a - b), opacity: GROUP_OPACITY[name] ?? 1 }));
}
