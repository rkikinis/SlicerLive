// The Threshold tool's arithmetic (logic/threshold-tool.ts): the histogram and its useful range, the range, the piece
// under a click with thin connections cut, and the write that replaces the structure under the "over" rule.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { aroundIsland, countOf, openingRoom, histogramOf, inRange, pieceAt, thresholdInto } from "./threshold-tool.ts";

Deno.test("histogram: one bin per gray value for an integer scan; the useful range is the 1st to 99.5th percentile", () => {
  const src = new Int16Array(1000); for (let i = 0; i < 1000; i++) src[i] = i - 200;   // -200 .. 799, once each
  const h = histogramOf(src);
  assert(h.integer); assertEquals(h.width, 1); assertEquals(h.counts.length, 1000);
  assertEquals([h.min, h.max], [-200, 799]);
  assertEquals(h.useful[0], -191);   // the 10th smallest of 1000 values
  assertEquals(h.useful[1], 794);    // the 995th
});

Deno.test("histogram: a scan of fractions gets 4,096 bins over its span", () => {
  const src = new Float32Array([0, 0.5, 1, 1.25]);
  const h = histogramOf(src);
  assert(!h.integer); assertEquals(h.counts.length, 4096); assertEquals(h.counts.reduce((a, b) => a + b, 0), 4);
});

Deno.test("range: both ends included", () => {
  assertEquals([...inRange(new Int16Array([9, 10, 11, 20, 21]), 10, 20)], [0, 1, 1, 1, 0]);
});

// Two blocks of 4 x 4 x 4 joined by a bridge one voxel thick: the click in one keeps it alone when thin connections are
// cut, both when nothing is cut.
function twoBlocks(): { mask: Uint8Array; dims: [number, number, number]; at: (i: number, j: number, k: number) => number } {
  const dims: [number, number, number] = [14, 6, 6], at = (i: number, j: number, k: number) => k * 84 + j * 14 + i;
  const mask = new Uint8Array(14 * 6 * 6);
  for (let k = 1; k <= 4; k++) for (let j = 1; j <= 4; j++) { for (let i = 1; i <= 4; i++) mask[at(i, j, k)] = 1; for (let i = 9; i <= 12; i++) mask[at(i, j, k)] = 1; }
  for (let i = 5; i <= 8; i++) mask[at(i, 2, 2)] = 1;   // the bridge
  return { mask, dims, at };
}

Deno.test("piece: nothing cut -- the click keeps everything connected to it, bridge included", () => {
  const { mask, dims, at } = twoBlocks();
  const p = pieceAt(mask, dims, at(2, 2, 2), 0)!;
  assertEquals(countOf(p), 64 + 64 + 4);
});

Deno.test("piece: connections up to two voxels thick cut -- the clicked block alone, whole", () => {
  const { mask, dims, at } = twoBlocks();
  const p = pieceAt(mask, dims, at(2, 2, 2), 2)!;
  let block = 0; for (let k = 1; k <= 4; k++) for (let j = 1; j <= 4; j++) for (let i = 1; i <= 4; i++) block += p[at(i, j, k)];
  assertEquals(block, 64, "the clicked block, edges and corners included");
  assertEquals(p[at(10, 2, 2)], 0, "the other block is left out");
  // The face voxel where the bridge joins survives the cut (its six neighbors are all in range), so the regrowth takes
  // one voxel of the bridge with it: a stub of at most the cut's depth, never the far side.
  assertEquals(countOf(p), 65);
  assertEquals(p[at(6, 2, 2)], 0);
});

Deno.test("piece: a click on the bridge takes the nearest block that survives the cut", () => {
  const { mask, dims, at } = twoBlocks();
  const p = pieceAt(mask, dims, at(5, 2, 2), 2)!;
  assertEquals(p[at(2, 2, 2)], 1);
  assertEquals(p[at(10, 2, 2)], 0);
});

Deno.test("piece: a click outside the range gives nothing", () => {
  const { mask, dims, at } = twoBlocks();
  assertEquals(pieceAt(mask, dims, at(0, 0, 0), 2), null);
});

Deno.test("write: the structure is replaced by the result; over 'empty voxels only' another structure stays", () => {
  const lm = new Uint8Array([1, 1, 0, 2, 0]);
  const result = new Uint8Array([0, 1, 1, 1, 0]);
  assertEquals([...thresholdInto(lm, result, { segment: 1, overwrite: "all" })], [0, 1, 1, 1, 0]);
  assertEquals([...thresholdInto(lm, result, { segment: 1, overwrite: "none" })], [0, 1, 1, 2, 0]);
});

Deno.test("around the island: the range grows from it a set number of voxels, and stops at a gap", () => {
  // a row of 20 voxels all in range except x = 12; the island holds x 4..6
  const dims: [number, number, number] = [20, 1, 1];
  const range = new Uint8Array(20).fill(1); range[12] = 0;
  const island = new Uint8Array(20); island[4] = island[5] = island[6] = 1;
  assertEquals([...aroundIsland(range, island, dims, 2)].join(""), "00111111100000000000");   // x 2..8
  const far = aroundIsland(range, island, dims, 10);
  assertEquals(far[11], 1); assertEquals(far[13], 0, "the gap at x 12 stops it");
  // an island voxel out of the new range does not count
  const r2 = range.slice(); r2[5] = 0;
  assertEquals(aroundIsland(r2, island, dims, 0).reduce((a, b) => a + b, 0), 2);
});

Deno.test("opening: what the raised line took (darker) comes back; a piece cut by hand (as bright) does not", () => {
  // a row: island x 4..6 at 500; x 7 at 300 (thin edge the raised line took); x 8..9 at 500, cut away by hand
  const dims: [number, number, number] = [12, 1, 1];
  const src = new Int16Array([0, 0, 0, 0, 500, 500, 500, 300, 500, 500, 0, 0]);
  const island = new Uint8Array(12); island[4] = island[5] = island[6] = 1;
  const range = inRange(src, 250, 3000);
  const grown = aroundIsland(openingRoom(range, island, src), island, dims, 2);
  assertEquals([...grown].join(""), "000011110000", "x 4..7: the thin edge back, the cut piece not");
  assertEquals([...aroundIsland(range, island, dims, 2)].join(""), "000011111000", "through the whole range the cut piece would come back");
});

