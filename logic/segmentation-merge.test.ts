// Merging segmentations: overlaps are counted, decisions are applied, the earlier input wins by default.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { countContested, findOverlaps, MAX_MERGE_INPUTS, mergeLabelmaps, type MergeInput, overlapGeometry, overlapKey, sharedLabelmap, structureKey } from "./segmentation-merge.ts";

const seg = (labelValue: number, name: string) => ({ labelValue, name, color: [1, 0, 0] as [number, number, number] });
// Eight voxels. A: liver (1) on 0-3, aorta (2) on 4-5. B: aorta (7) on 3-6 -- overlaps liver at 3 and aorta at 4-5.
const A: MergeInput = { id: "a", name: "organs", labelmap: new Uint8Array([1, 1, 1, 1, 2, 2, 0, 0]), segments: [seg(1, "liver"), seg(2, "aorta")] };
const B: MergeInput = { id: "b", name: "cardiac", labelmap: new Uint8Array([0, 0, 0, 7, 7, 7, 7, 0]), segments: [seg(7, "aorta")] };

Deno.test("findOverlaps: every pair of structures that share voxels, most first", () => {
  const o = findOverlaps([A, B]);
  assertEquals(o.map((x) => [x.a.label, x.b.label, x.voxels]), [[2, 7, 2], [1, 7, 1]]);
});

Deno.test("mergeLabelmaps: earlier input wins where nobody decided; renumbered 1..n in order", () => {
  const r = mergeLabelmaps([A, B], new Map());
  assertEquals([...r.labelmap], [1, 1, 1, 1, 2, 2, 3, 0]);
  assertEquals(r.segments.map((s) => [s.labelValue, s.name, s.source.input, s.source.labelValue]), [[1, "liver", 0, 1], [2, "aorta", 0, 2], [3, "aorta", 1, 7]]);
  assertEquals(r.contested, 3);
  assertEquals(r.wonByLater, 0);
});

Deno.test("mergeLabelmaps: a decision gives the later input the voxels of that pair only", () => {
  const o = findOverlaps([A, B]);
  const d = new Map([[overlapKey(o.find((x) => x.a.label === 2)!), "b" as const]]);   // cardiac's aorta over organs' aorta
  const r = mergeLabelmaps([A, B], d);
  assertEquals([...r.labelmap], [1, 1, 1, 1, 3, 3, 3, 0]);   // liver keeps voxel 3, cardiac takes 4-5
  assertEquals(r.wonByLater, 2);
});

Deno.test("mergeLabelmaps: refuses more than 255 structures, and a different volume", () => {
  const many: MergeInput = { id: "m", name: "m", labelmap: new Uint8Array(8), segments: Array.from({ length: 254 }, (_, i) => seg(i + 1, `s${i}`)) };
  assertThrows(() => mergeLabelmaps([A, many], new Map()), Error, "255");
  const other: MergeInput = { ...B, labelmap: new Uint8Array(9) };
  assertThrows(() => findOverlaps([A, other]), Error, "not the same volume");
  assert(findOverlaps([A]).length === 0);
});

// THE HEADLINE COUNTS A VOXEL ONCE (critic, 2026-09-17, finding 12): three inputs on one voxel are
// three pairs but one contested voxel. And the pair key holds 16 inputs; a 17th is refused.
Deno.test("countContested counts each voxel once; findOverlaps refuses a 17th input", () => {
  const input = (name: string, lab: number[]): MergeInput => ({ id: name, name, labelmap: new Uint8Array(lab), segments: [...new Set(lab.filter(Boolean))].map((v) => seg(v, `${name}${v}`)) });
  const A = input("A", [1, 1, 0, 0]), B = input("B", [2, 2, 0, 0]), C = input("C", [3, 0, 0, 0]);
  const pairs = findOverlaps([A, B, C]);
  assertEquals(pairs.reduce((s, x) => s + x.voxels, 0), 4, "pairs add up to 4 claims");
  assertEquals(countContested([A, B, C]), 2, "but only 2 voxels are contested");
  const many = Array.from({ length: MAX_MERGE_INPUTS + 1 }, (_, i) => input(`in${i}`, [1, 0]));
  assertThrows(() => findOverlaps(many), Error, "at most 16");
});

// A LABEL NO SEGMENT NAMES DOES NOT WIN (second critic, 2026-09-17, finding 7): A has an unlisted
// label 9 at voxel 3; B's liver has voxels 3 and 4. The merged liver keeps both, and the dropped
// claim is counted.
Deno.test("mergeLabelmaps: an unlisted label is not a claim", () => {
  const A2: MergeInput = { id: "a", name: "A", labelmap: new Uint8Array([0, 0, 0, 9, 0]), segments: [seg(1, "spleen")] };
  const B2: MergeInput = { id: "b", name: "B", labelmap: new Uint8Array([0, 0, 0, 7, 7]), segments: [seg(7, "liver")] };
  const r = mergeLabelmaps([A2, B2], new Map());
  assertEquals(Array.from(r.labelmap), [0, 0, 0, 2, 2], "the liver (renumbered 2, after the spleen) keeps voxel 3");
  assertEquals(r.contested, 0);
  assertEquals(r.unlistedVoxels, 1);
});

// Ron, 2026-09-21: "completely discard the psoas from that task." Every voxel of the structure goes,
// not only the shared ones, and the structure is not in the result's list.
Deno.test("mergeLabelmaps: a structure left out is no claim anywhere", () => {
  const r = mergeLabelmaps([A, B], new Map(), new Set([structureKey(0, 2)]));   // organs' aorta out
  assertEquals([...r.labelmap], [1, 1, 1, 1, 2, 2, 2, 0]);   // cardiac's aorta takes 4-6 with no decision; liver keeps 3
  assertEquals(r.segments.map((s) => s.name), ["liver", "aorta"]);
  assertEquals(r.leftOutVoxels, 2);
  assertEquals(r.unlistedVoxels, 0);
  assertEquals(r.contested, 1);                              // only liver/aorta at voxel 3 is still contested
});

Deno.test("overlapGeometry: each structure's box and each pair's shared centre, in ijk", () => {
  // The eight voxels as a 4 x 2 x 1 grid: i fastest.
  const g = overlapGeometry([A, B], [4, 2, 1]);
  assertEquals(g.boxes.get(structureKey(0, 1)), [0, 0, 0, 3, 0, 0]);   // liver: i 0-3 on row 0
  assertEquals(g.boxes.get(structureKey(0, 2)), [0, 1, 0, 1, 1, 0]);   // aorta: i 0-1 on row 1
  assertEquals(g.boxes.get(structureKey(1, 7)), [0, 0, 0, 3, 1, 0]);   // cardiac's aorta: voxels 3 (i3,j0), 4-6 (i0-2,j1)
  const o = findOverlaps([A, B]);
  assertEquals(g.centroids.get(overlapKey(o.find((x) => x.a.label === 1)!)), [3, 0, 0]);
  assertEquals(g.centroids.get(overlapKey(o.find((x) => x.a.label === 2)!)), [0.5, 1, 0]);
});

Deno.test("sharedLabelmap: the shared voxels carry their pair's index, first pair wins", () => {
  const o = findOverlaps([A, B]);                            // [aorta/aorta (2 voxels), liver/aorta (1)]
  const { labelmap, marked } = sharedLabelmap([A, B], o);
  assertEquals([...labelmap], [0, 0, 0, 2, 1, 1, 0, 0]);
  assertEquals(marked, 2);
});
