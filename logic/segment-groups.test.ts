// The fixtures here are the REAL measurements from Ron's 67-segment study, taken before the code was
// written. Testing the classifier against invented numbers would only prove it agrees with whatever I
// imagined; these are what the CT actually contains.
//
//   deno test -A --no-check logic/segment-groups.test.ts
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { classify, inferGroups, type SegmentStats, segmentStatistics } from "./segment-groups.ts";

const stat = (labelValue: number, meanHU: number, sdHU: number, gasFraction = 0, voxels = 50_000): SegmentStats =>
  ({ labelValue, meanHU, sdHU, gasFraction, voxels });

// --- the classifier, against measured segments ---------------------------------------------------

// Twenty-one segments measured 312-422 HU with nothing between 119 and 236. The threshold sits in
// the middle of that gap, so these are not near it.
Deno.test("bone: the measured bone cluster classifies as bone", () => {
  for (const hu of [312, 316, 330, 352, 376, 422]) {
    assertEquals(classify(stat(1, hu, 120)), "Bone", `${hu} HU`);
  }
});

// The two that gave bowel away: 3.1% and 3.7% of voxels below -200 HU, SD 122 and 156, while their
// MEANS (12 and 18) sit squarely inside the soft-tissue band. Mean alone would miss them entirely.
Deno.test("bowel: gas gives it away where the mean cannot", () => {
  assertEquals(classify(stat(66, 12, 122, 0.031)), "Gas-containing");
  assertEquals(classify(stat(28, 18, 156, 0.037)), "Gas-containing");
  // And a marginal one: exactly at the 0.5% threshold.
  assertEquals(classify(stat(30, 40, 55, 0.005)), "Gas-containing");
});

// The bug that running on real data exposed. A first version also accepted SD >= 50, which swept in
// a contrast-filled vessel and a heterogeneous soft-tissue region -- six segments in the bowel group
// where only two hold any air. Spread is a symptom of several things; air is a symptom of one.
Deno.test("bowel: wide spread WITHOUT gas is not bowel", () => {
  assertEquals(classify(stat(46, 10, 56, 0)), "Soft tissue", "heterogeneous, but no air");
  assertEquals(classify(stat(1, 236, 60, 0)), "Contrast / vessel", "a contrast vessel is not bowel");
});

// Every solid structure measured 0.0% gas and SD around 20. These must NOT land in the bowel group.
Deno.test("solid tissue: homogeneous segments stay soft tissue", () => {
  for (const [hu, sd] of [[42, 19], [42, 23], [37, 22], [98, 24], [119, 26], [32, 27]] as const) {
    assertEquals(classify(stat(1, hu, sd, 0)), "Soft tissue", `${hu} HU, SD ${sd}`);
  }
});

Deno.test("contrast: between the soft-tissue band and bone", () => {
  assertEquals(classify(stat(1, 236, 30, 0)), "Contrast / vessel");
  assertEquals(classify(stat(1, 149, 30, 0)), "Soft tissue", "just below the threshold");
});

// The honest limit, asserted so it cannot be quietly forgotten: muscle and liver are the same to
// this classifier, and the reference renders them at 5% and 90%.
Deno.test("limit: muscle and liver are indistinguishable, and that is recorded", () => {
  const muscle = stat(1, 50, 20, 0);
  const liver = stat(2, 60, 22, 0);
  assertEquals(classify(muscle), classify(liver));
  assertEquals(classify(muscle), "Soft tissue");
});

// --- grouping ------------------------------------------------------------------------------------

Deno.test("groups: members are gathered, ordered, and given the reference's opacities", () => {
  const groups = inferGroups([
    stat(11, 376, 130), stat(3, 339, 120),          // bone
    stat(66, 12, 122, 0.031),                        // bowel
    stat(19, 42, 19), stat(58, 42, 18),              // soft tissue
    stat(1, 236, 30),                                // contrast
  ]);
  assertEquals(groups.map((g) => g.name), ["Soft tissue", "Contrast / vessel", "Gas-containing", "Bone"]);
  assertEquals(groups.find((g) => g.name === "Bone")!.members, [3, 11], "sorted by label value");
  assertEquals(groups.find((g) => g.name === "Bone")!.opacity, 1.0);
  assertEquals(groups.find((g) => g.name === "Gas-containing")!.opacity, 0.55);
});

// A chest study has no bowel; showing an empty slider for it would be noise.
Deno.test("groups: empty groups are dropped", () => {
  const groups = inferGroups([stat(1, 350, 120), stat(2, 40, 20)]);
  assertEquals(groups.map((g) => g.name), ["Soft tissue", "Bone"]);
});

// --- the measurement itself ----------------------------------------------------------------------

Deno.test("statistics: mean, spread and gas fraction over a labelmap", () => {
  //  label 1: HU 100, 100, 100, 100   (solid, no spread)
  //  label 2: HU 50, 50, -800, -800   (half air — bowel-like)
  const lab = new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]);
  const ct = new Int16Array([100, 100, 100, 100, 50, 50, -800, -800]);
  const s = segmentStatistics(lab, ct, { stride: 1 });

  const one = s.find((x) => x.labelValue === 1)!;
  assertEquals(one.voxels, 4);
  assertAlmostEquals(one.meanHU, 100, 1e-9);
  assertAlmostEquals(one.sdHU, 0, 1e-9);
  assertEquals(one.gasFraction, 0);

  const two = s.find((x) => x.labelValue === 2)!;
  assertAlmostEquals(two.meanHU, -375, 1e-9);
  assertEquals(two.gasFraction, 0.5, "half its voxels are air");
  assertEquals(classify(two), "Gas-containing");
});

// Sampling must not change the answer, only the cost — and the voxel count must be scaled back so a
// caller sees the size of the segment rather than the size of the sample.
Deno.test("statistics: a stride samples without distorting the mean", () => {
  const n = 6000;
  const lab = new Uint8Array(n).fill(1);
  const ct = new Int16Array(n);
  for (let i = 0; i < n; i++) ct[i] = 40 + (i % 7);          // mean 43
  const all = segmentStatistics(lab, ct, { stride: 1 })[0];
  const sampled = segmentStatistics(lab, ct, { stride: 3 })[0];
  assertAlmostEquals(sampled.meanHU, all.meanHU, 0.5);
  assertEquals(sampled.voxels, n, "scaled back to the whole labelmap");
});

Deno.test("statistics: label 0 is background and is never a segment", () => {
  const s = segmentStatistics(new Uint8Array([0, 0, 0, 1]), new Int16Array([9, 9, 9, 60]), { stride: 1 });
  assertEquals(s.length, 1);
  assertEquals(s[0].labelValue, 1);
});
