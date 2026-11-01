// The brush (logic/paint-brush.ts): Erase takes only the structure chosen; "over" holds for the brush; the brightness range
// and the adaptive rule; a scan on another grid than the segmentation.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { brushPreview, type BrushGrid, limitsFor, newTally, paintStamps, segToSourceOf } from "./paint-brush.ts";
import { invertRowMajor } from "./transforms.ts";

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A 20 x 20 x 1 labelmap on the identity grid (1 mm voxels). */
function grid(fill = 0): BrushGrid {
  return { labelmap: new Uint8Array(400).fill(fill), dims: [20, 20, 1], ijkToRAS: ID, invIjk: invertRowMajor(ID), spacing: [1, 1, 1] };
}
const at = (i: number, j: number) => j * 20 + i;
const disk = { radiusMm: 3, normal: [0, 0, 1] as [number, number, number] };
const count = (l: Uint8Array, v: number) => l.reduce((n, x) => n + (x === v ? 1 : 0), 0);

Deno.test("erase takes away only the structure chosen; the others under the brush stay", () => {
  const c = grid(1);
  for (let i = 10; i < 20; i++) for (let j = 0; j < 20; j++) c.labelmap[at(i, j)] = 2;   // right half: structure 2
  const t = paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "remove" });
  assert(t.written > 0);
  assertEquals(c.labelmap[at(9, 10)], 0, "structure 1 under the brush is gone");
  assertEquals(c.labelmap[at(11, 10)], 2, "structure 2 under the brush stays");
  assertEquals(count(c.labelmap, 2), 200);
});

Deno.test("paint over empty voxels only: another structure under the brush is left, and counted", () => {
  const c = grid();
  c.labelmap[at(10, 10)] = 2;
  const t = paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, { overwrite: "none" });
  assertEquals(c.labelmap[at(10, 10)], 2);
  assertEquals(c.labelmap[at(11, 10)], 1);
  assertEquals(t.heldOver.size, 1);
  assertEquals(t.written, count(c.labelmap, 1));
});

Deno.test("paint over one structure: only where that structure is (Necrosis over Tumor)", () => {
  const c = grid();
  for (let i = 0; i < 10; i++) for (let j = 0; j < 20; j++) c.labelmap[at(i, j)] = 3;   // left half: "Tumor"
  paintStamps(c, [[10, 10, 0]], { ...disk, segment: 4, mode: "add" }, { overwrite: "segment", overSegment: 3 });
  assertEquals(c.labelmap[at(9, 10)], 4, "inside the tumor: painted");
  assertEquals(c.labelmap[at(10, 10)], 0, "outside it, even an empty voxel: not painted");
  assertEquals(c.labelmap[at(11, 10)], 0);
});

// The scan: left half 100, right half 500.
const scan = { data: Float32Array.from({ length: 400 }, (_, k) => (k % 20 < 10 ? 100 : 500)), dims: [20, 20, 1] as [number, number, number], segToSource: null };

Deno.test("the brightness range: only voxels in it are painted; the others are counted as left", () => {
  const c = grid();
  const t = paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: scan, range: [400, 600] });
  assertEquals(c.labelmap[at(9, 10)], 0); assertEquals(c.labelmap[at(10, 10)], 1);
  assert(t.heldBrightness.size > 0);
  assertEquals(t.written + t.heldBrightness.size, 29, "a 3 mm disk on a 1 mm grid covers 29 voxels");
});

Deno.test("adaptive: stops at the edge, on the side of the brush's center", () => {
  const left = grid(), right = grid();
  paintStamps(left, [[9, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: scan, adaptive: 50 });
  assertEquals(left.labelmap[at(9, 10)], 1); assertEquals(left.labelmap[at(10, 10)], 0, "the bright side is not painted");
  paintStamps(right, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: scan, adaptive: 50 });
  assertEquals(right.labelmap[at(9, 10)], 0); assertEquals(right.labelmap[at(12, 10)], 1);
  // joined to the center: a bright voxel cut off from it by dark ones is not painted
  const island = { ...scan, data: Float32Array.from({ length: 400 }, (_, k) => (k === at(12, 10) ? 100 : k % 20 < 10 ? 100 : 500)) };
  const c = grid(); paintStamps(c, [[9, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: island, adaptive: 50 });
  assertEquals(c.labelmap[at(12, 10)], 0, "same brightness, not joined: left");
  // a tally is shared along a stroke: a voxel painted later is no longer counted as left
  const tl = newTally(), d = grid();
  paintStamps(d, [[9, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: scan, range: [50, 150] }, tl);
  const held = tl.heldBrightness.size;
  paintStamps(d, [[9, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: scan, range: [50, 600] }, tl);
  assert(held > 0); assertEquals(tl.heldBrightness.size, 0);
});

Deno.test("a scan on another grid: the map between the grids, null on one grid", () => {
  assertEquals(segToSourceOf(ID, [20, 20, 1], invertRowMajor(ID), [20, 20, 1]), null);
  const shifted = [1, 0, 0, -5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];         // the scan starts 5 mm further left
  const m = segToSourceOf(ID, [20, 20, 1], invertRowMajor(shifted), [30, 20, 1])!;
  assertEquals(m[3], 5, "segmentation voxel 0 is the scan's voxel 5");
  const big = { data: Float32Array.from({ length: 600 }, (_, k) => (k % 30 < 15 ? 100 : 500)), dims: [30, 20, 1] as [number, number, number], segToSource: m };
  const c = grid(); paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, { source: big, range: [400, 600] });
  assertEquals(c.labelmap[at(9, 10)], 0, "segmentation x 9 is the scan's x 14: dark"); assertEquals(c.labelmap[at(10, 10)], 1);
});

Deno.test("erase ignores the brightness range (Ron, 2026-10-31): the structure under the brush goes, bright or dark", () => {
  const c = grid(1);
  const t = paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "remove" }, { source: scan, range: [400, 600] });
  assertEquals(c.labelmap[at(9, 10)], 0, "dark side erased too"); assertEquals(c.labelmap[at(10, 10)], 0);
  assertEquals(t.written, 29); assertEquals(t.heldBrightness.size, 0);
});

Deno.test("the brush preview: what a stroke would paint and hold back, with nothing written", () => {
  const c = grid();
  c.labelmap[at(11, 10)] = 1;   // already painted: counted as painted, so the brush looks full there
  const p = brushPreview(c, [10, 10, 0], { ...disk, segment: 1, mode: "add" }, { source: scan, range: [400, 600] });
  assertEquals(count(c.labelmap, 1), 1, "nothing written");
  assert(p.will.includes(at(10, 10)) && p.will.includes(at(11, 10)));
  assert(p.held.includes(at(9, 10)));
  assertEquals(p.will.length + p.held.length, 29);
});

Deno.test("a stroke in a view showing another scan reads that scan's limit; 'over' stays as set", () => {
  const other = { data: Float32Array.from({ length: 400 }, (_, k) => (k % 20 < 10 ? 500 : 100)), dims: [20, 20, 1] as [number, number, number], segToSource: null };
  const l = { overwrite: "none" as const, source: scan, range: [400, 600] as [number, number], byImage: { flair: { source: other, range: [400, 600] as [number, number] } } };
  assertEquals(limitsFor(l, "flair").source, other); assertEquals(limitsFor(l, "flair").overwrite, "none");
  assertEquals(limitsFor(l, "unknown").source, scan); assertEquals(limitsFor(l).source, scan);
  const c = grid();
  paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, limitsFor(l, "flair"));
  assertEquals(c.labelmap[at(9, 10)], 1, "bright on the other scan: painted"); assertEquals(c.labelmap[at(10, 10)], 0);
});

/** A 40^3 grid of 1 mm voxels turned `deg` degrees about x (a scan not lined up with the scanner's axes). */
function tilted(deg: number): BrushGrid {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const m = [1, 0, 0, -20, 0, c, -s, -20, 0, s, c, -20, 0, 0, 0, 1];
  return { labelmap: new Uint8Array(40 * 40 * 40), dims: [40, 40, 40], ijkToRAS: m, invIjk: invertRowMajor(m), spacing: [1, 1, 1] };
}
/** The voxel the slice view draws at a point of its plane: the nearest, as slice-renderer.ts samples (floor of i + 0.5). */
function shownAt(c: BrushGrid, p: [number, number, number]): number {
  const m = c.invIjk, q = [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
  const [i, j, k] = q.map((v) => Math.floor(v + 0.5));
  return (k * 40 + j) * 40 + i;
}

Deno.test("a flat stroke on a tilted scan is on the slice shown, wherever the slice is (critic 2026-10-31, finding 2)", () => {
  for (const deg of [0, 1.1, 4.4, 30]) {
    for (const z of [0, 0.13, 0.37, 0.5, 0.71]) {   // the axial plane's position, between voxel middles and borders
      const c = tilted(deg);
      paintStamps(c, [[-6, 0, z], [6, 0, z]], { segment: 1, mode: "add", radiusMm: 3, normal: [0, 0, 1] });
      // inside the stroke (2 mm in from its edge): every point of the plane shows a painted voxel
      let shown = 0, all = 0;
      for (let x = -6; x <= 6; x += 0.25) for (let y = -1; y <= 1; y += 0.25) { all++; if (c.labelmap[shownAt(c, [x, y, z])] === 1) shown++; }
      assertEquals(shown, all, `${deg} degrees, plane at ${z}: ${shown} of ${all} points show the stroke`);
    }
  }
});

Deno.test("a sphere's preview is its cut through the slice shown, not the voxels above and below (finding 3)", () => {
  const c = tilted(0);
  const p = brushPreview(c, [0, 0, 0.2], { segment: 1, mode: "add", radiusMm: 5, sphere: true, normal: [0, 0, 1] });
  // the axial plane at z = 0.2 passes through the boxes of slice k = 20 only (centers at z = 0, boxes -0.5..0.5)
  assert(p.will.length > 0);
  for (const at of p.will) assertEquals(Math.floor(at / 1600), 20, "a voxel off the slice in the preview");
});

Deno.test("with a limit on, a stroke in a view whose scan is still being read waits (finding 8)", () => {
  const c = grid(), own = { data: new Float32Array(400).fill(100), dims: [20, 20, 1] as [number, number, number], segToSource: null };
  const l = { source: own, range: [50, 150] as [number, number], ownImage: "t1", byImage: { t1: { source: own, range: [50, 150] as [number, number] } } };
  assertEquals(paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, limitsFor(l, "flair")).written, 0, "the FLAIR's limit is not known yet");
  assert(paintStamps(c, [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, limitsFor(l, "t1")).written > 0, "the outlined scan's view paints");
  const free = { ownImage: "t1" };
  assert(paintStamps(grid(), [[10, 10, 0]], { ...disk, segment: 1, mode: "add" }, limitsFor(free, "flair")).written > 0, "no limit: it paints");
});
