// Ron: "I have no way to visually assess the muscles as abdominal muscle all have the same color."
//
//   deno test -A --no-check logic/segment-colours.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { type ColourCandidate, coloursFor, deltaE, recolouredCount, resolveColours, SAME_COLOUR } from "./segment-colours.ts";

const c = (type: string, published: [number, number, number] | undefined, fallback: [number, number, number]): ColourCandidate =>
  ({ type, published, fallback });

// TotalSegmentator's own muscle values, measured: they form a CHAIN rather than a cluster -- 4.4
// apart at the closest and 16.4 at the extremes -- so no single pairwise test over the whole set
// catches them. Each is within a glance of a NEIGHBOR, which is why every one of them has to move:
// a color that is distinct from one muscle and identical to the next is no use at all.
Deno.test("the muscle browns each collide with a neighbour, so all of them move", () => {
  const browns: [number, number, number][] = [
    [200, 120, 100], [180, 100, 90], [190, 110, 95], [175, 95, 85], [170, 90, 80],
    [165, 85, 75], [171, 85, 68], [160, 80, 70], [192, 104, 88], [155, 78, 65],
  ];
  for (const b of browns) {
    const nearest = Math.min(...browns.filter((x) => x !== b).map((x) => deltaE(b, x)));
    assert(nearest < SAME_COLOUR, `${b} is ${nearest.toFixed(1)} from its nearest neighbour`);
  }
  // The extremes ARE further apart than the threshold, which is exactly why the rule asks about
  // neighbors and not about the set.
  assert(deltaE(browns[0], browns[9]) > SAME_COLOUR);
  // An organ palette is not like this at all: liver against spleen is 47.
  assert(deltaE([124, 70, 50], [157, 108, 162]) > 40);
});

// ONE OF THEM KEEPS THE PUBLISHED COLOR. Moving every member of a cluster repainted 62 of
// ts:total's 117 structures; keeping the first and moving the rest is the minimum repaint that
// leaves nothing indistinguishable.
Deno.test("all but one of the muscles is recoloured, chain and all", () => {
  const browns: [number, number, number][] = [
    [200, 120, 100], [180, 100, 90], [190, 110, 95], [175, 95, 85], [170, 90, 80],
    [165, 85, 75], [171, 85, 68], [160, 80, 70], [192, 104, 88], [155, 78, 65],
  ];
  const cands = browns.map((rgb, i) => ({
    type: `Muscle ${i}`,
    published: rgb,
    fallback: [(i * 23) % 256, (i * 71) % 256, (i * 137) % 256] as [number, number, number],
  }));
  const got = resolveColours(cands);
  assertEquals(recolouredCount(cands, got), browns.length - 1, "one keeps the published colour; the rest move");
  for (let i = 0; i < got.length; i++) {
    for (let j = i + 1; j < got.length; j++) {
      assert(deltaE(got[i], got[j]) >= SAME_COLOUR, `muscles ${i} and ${j} are still ${deltaE(got[i], got[j]).toFixed(1)} apart`);
    }
  }
});

// THE PROPERTY, not the source. The file's own colors were the first answer and were not good
// enough -- on Ron's 22 muscles they still left two structures 8.6 apart, under the threshold. So
// what is asserted is what matters: after resolving, no two different structures are within a
// glance of each other.
Deno.test("colliding structures come out distinguishable", () => {
  const muscles: ColourCandidate[] = [
    c("Psoas major muscle", [192, 104, 88], [255, 0, 0]),
    c("Rectus abdominis muscle", [190, 110, 95], [250, 5, 5]),      // a fallback that ALSO collides
    c("Trapezius muscle", [180, 100, 90], [245, 10, 10]),
  ];
  const got = resolveColours(muscles);
  assertEquals(recolouredCount(muscles, got), 2, "one keeps its colour, the other two move off it");
  for (let i = 0; i < got.length; i++) {
    for (let j = i + 1; j < got.length; j++) {
      assert(deltaE(got[i], got[j]) >= SAME_COLOUR, `${muscles[i].type} and ${muscles[j].type} are still ${deltaE(got[i], got[j]).toFixed(1)} apart`);
    }
  }
});

// A new color must clear the ones that are STAYING, or fixing the muscles would collide them with
// an organ that was fine.
Deno.test("a new colour clears the published ones that were kept", () => {
  const mixed: ColourCandidate[] = [
    c("Liver", [124, 70, 50], [1, 1, 1]),
    c("Spleen", [157, 108, 162], [2, 2, 2]),
    c("Muscle A", [192, 104, 88], [3, 3, 3]),
    c("Muscle B", [190, 110, 95], [4, 4, 4]),
  ];
  const got = resolveColours(mixed);
  assertEquals(got[0], [124, 70, 50], "the liver keeps its published colour");
  assertEquals(got[1], [157, 108, 162]);
  for (const moved of [got[2], got[3]]) {
    assert(deltaE(moved, got[0]) >= SAME_COLOUR, "a recoloured muscle landed on the liver");
    assert(deltaE(moved, got[1]) >= SAME_COLOUR, "a recoloured muscle landed on the spleen");
  }
  assert(deltaE(got[2], got[3]) >= SAME_COLOUR);
});

Deno.test("a published colour that distinguishes is kept", () => {
  const organs: ColourCandidate[] = [
    c("Liver", [124, 70, 50], [255, 0, 0]),
    c("Spleen", [157, 108, 162], [0, 255, 0]),
    c("Kidney", [212, 126, 151], [0, 0, 255]),
  ];
  const got = resolveColours(organs);
  assertEquals(got, [[124, 70, 50], [157, 108, 162], [212, 126, 151]]);
  assertEquals(recolouredCount(organs, got), 0, "nothing was repainted");
});

// A left/right pair IS one structure wearing one color. Moving it must move both sides together,
// or the tree would show a pair whose halves no longer look related.
Deno.test("a left and right pair keeps one colour, before and after", () => {
  const segs: ColourCandidate[] = [
    { type: "Psoas major muscle", published: [192, 104, 88], fallback: [10, 20, 30] },
    { type: "Psoas major muscle", published: [192, 104, 88], fallback: [40, 50, 60] },
    { type: "Rectus abdominis muscle", published: [190, 110, 95], fallback: [70, 80, 90] },
    { type: "Rectus abdominis muscle", published: [190, 110, 95], fallback: [100, 110, 120] },
  ];
  const got = resolveColours(segs);
  assertEquals(got[0], got[1], "the psoas pair still matches");
  assertEquals(got[2], got[3], "and so does the rectus pair");
  assert(deltaE(got[0], got[2]) >= SAME_COLOUR, "but the two muscles no longer share a colour");
});

Deno.test("a segment with no published colour just uses the file's", () => {
  const segs: ColourCandidate[] = [
    { type: "Something", published: undefined, fallback: [1, 2, 3] },
    { type: "Liver", published: [124, 70, 50], fallback: [4, 5, 6] },
  ];
  assertEquals(resolveColours(segs), [[1, 2, 3], [124, 70, 50]]);
});

Deno.test("a pinned colour never moves, however close its neighbours are", () => {
  // THE VESSELS, WHICH THIS BROKE. vessel-colour.ts puts every vessel in a narrow band of red or
  // blue by oxygenation -- the closest pair at ΔE 4.9 -- and SAME_COLOUR here is 9. So every vessel
  // read as a collision, correctly by this function's own rule, and was repainted at an arbitrary
  // hue. Ron, reading the tree: "subclavian and common carotid escaped your attention and are
  // green", with the iliac artery orange and the iliac vein magenta.
  const reds: [number, number, number][] = [[162, 78, 91], [178, 94, 82], [194, 97, 115], [220, 132, 138]];
  const cands = [
    ...reds.map((published, i) => ({ type: `vessel-${i}`, published, fallback: [40, 40, 40] as [number, number, number], pinned: true })),
    // An unpinned structure sitting right on top of one of them still has to move.
    { type: "muscle", published: [163, 79, 92] as [number, number, number], fallback: [90, 90, 90] as [number, number, number] },
  ];
  const out = resolveColours(cands);
  reds.forEach((c, i) => assertEquals(out[i], c, `vessel ${i} must keep its shade`));
  assert(out[4].join() !== cands[4].published!.join(), "the unpinned neighbour still moves");
  // And it must clear EVERY pinned color, not just the one it was clustered against.
  for (const c of reds) assert(deltaE(out[4], c) >= SAME_COLOUR, `moved colour still collides with ${c}`);
});

Deno.test("several pinned colours in one cluster all keep theirs", () => {
  // Two vessels a hair apart are still two vessels. Nothing in the cluster is a "loser".
  const a: [number, number, number] = [162, 78, 91], b: [number, number, number] = [164, 80, 93];
  const out = resolveColours([
    { type: "a", published: a, fallback: [0, 0, 0], pinned: true },
    { type: "b", published: b, fallback: [0, 0, 0], pinned: true },
  ]);
  assertEquals(out, [a, b]);
});

// THE SAME COLORS FROM BOTH DOORS. A fresh result and the same segmentation read back from the
// database go through one helper; the load path used to take the published brown as it was, so a
// saved muscle set came back in eleven near-identical browns (Ron, 2026-09-21: "there is a
// distinction, but it is very subtle").
Deno.test("a saved segmentation reopens in the colours it landed in", () => {
  const browns: [number, number, number][] = [
    [200, 120, 100], [180, 100, 90], [190, 110, 95], [175, 95, 85], [170, 90, 80],
    [165, 85, 75], [171, 85, 68], [160, 80, 70], [192, 104, 88], [155, 78, 65],
  ];
  // Fresh: the segmenter's own spread colors as the fallback.
  const fresh = coloursFor(browns.map((rgb, i) => ({
    known: { type: `Muscle ${i}`, rgb },
    fallback: [(i * 23) % 256, (i * 71) % 256, (i * 137) % 256] as [number, number, number],
  })));
  assertEquals(fresh.moved, browns.length - 1);
  // Reopened: the file now carries what the fresh run resolved, and the catalog still says brown.
  const reopened = coloursFor(browns.map((rgb, i) => ({ known: { type: `Muscle ${i}`, rgb }, fallback: fresh.resolved[i] })));
  assertEquals(reopened.resolved, fresh.resolved);
  // A left/right pair is one structure and keeps one color through both.
  const pair = coloursFor([
    { known: { type: "Psoas", rgb: [192, 104, 88] }, fallback: [1, 2, 3] },
    { known: { type: "Psoas", rgb: [192, 104, 88] }, fallback: [4, 5, 6] },
    { known: { type: "Quadratus", rgb: [155, 78, 65] }, fallback: [7, 8, 9] },
  ]);
  assertEquals(pair.resolved[0], pair.resolved[1]);
  assert(deltaE(pair.resolved[0], pair.resolved[2]) >= SAME_COLOUR);
});
