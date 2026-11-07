// The strokes kept apart from Grow's result (logic/grow-strokes.ts), through the app's own paths: paintStroke + commitPaint,
// applyEffect, and Undo as the panel does it (the earlier description written back). The scenarios are the critic's of
// 2026-11-06 (qa/2026-11-06-editor-and-load-save.md, findings 1, 2, 3, 8, 9).
//
//   deno test -A --no-check --unstable-ffi logic/grow-strokes.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { LocalBlobStore, volumeToZarr } from "./ingest.ts";
import { applyEffect, commitPaint, invalidatePaintCache, paintStroke } from "./segment-tools.ts";
import { chunkOfMark, forgetStrokes, NO_STROKES, outsideStrokesFor, rememberStrokes, setGrowing, strokesAt, strokesOf, withChunks, withGrown } from "./grow-strokes.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../render/zarr.ts";
import type { LiveScene } from "../render/livescene.ts";
import type { Vec3 } from "../render/mat4.ts";
import { initDevice } from "../render/device.ts";

const gpu = await initDevice().catch(() => null);

Deno.test("the record: replay in order, erasing, and painting another structure over a stroke", () => {
  const u = (...a: number[]) => Uint32Array.from(a);
  let r = withChunks(NO_STROKES, [{ label: 1, erase: false, at: u(1, 2, 3, 4) }]);
  r = withChunks(r, [{ label: 1, erase: true, at: u(2) }]);        // erased
  r = withChunks(r, [{ label: 9, erase: false, at: u(3), forStructure: 1 }]);   // gray over a stroke
  r = withChunks(r, [{ label: 9, erase: true, at: u(4) }]);        // erasing the gray does not touch structure 1
  assertEquals([...strokesOf(r, 1)].sort(), [1, 4]);
  assertEquals([...(outsideStrokesFor(r, new Set([9]), 1) ?? [])], [3]);
  assertEquals(outsideStrokesFor(r, new Set([9]), 2)?.length, 0);
  assertEquals(outsideStrokesFor(withChunks(NO_STROKES, [{ label: 1, erase: false, at: u(1) }]), new Set([9]), 1), undefined);
  assert(!r.grown.has(1)); assert(withGrown(r, 1).grown.has(1)); assert(!r.grown.has(1));
  const m = new Uint8Array(6); m[5] = 1; m[0] = 1;
  assertEquals([...chunkOfMark(m, 7, false)!.at], [0, 5]);
  assertEquals(chunkOfMark(new Uint8Array(3), 7, false), null);
});

Deno.test("the record goes by the state of the labels; what is not known is undefined", () => {
  forgetStrokes("s");
  const a = withChunks(NO_STROKES, [{ label: 1, erase: false, at: Uint32Array.of(1) }]);
  rememberStrokes("s", { hash: "A" }, a);
  assertEquals(strokesAt("s", { hash: "A" }), a);
  assertEquals(strokesAt("s", { hash: "B" }), undefined);
  forgetStrokes("s");
  assertEquals(strokesAt("s", { hash: "A" }), undefined);
});

/** A soft-walled ball in noise, on a 1 mm grid, in a scene the app's functions can run on. */
async function scene() {
  const dims: [number, number, number] = [90, 80, 70], [nx, ny, nz] = dims, N = nx * ny * nz, c = [45, 40, 35], R = 16;
  const at = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  const img = new Float32Array(N), truth = new Uint8Array(N);
  let rng = 11; const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const r = Math.hypot(x - c[0], y - c[1], z - c[2]), t = Math.min(1, Math.max(0, (r - (R - 1.5)) / 3));
    img[at(x, y, z)] = 40 + 110 * t + (rand() - 0.5) * 16; truth[at(x, y, z)] = r <= R ? 1 : 0;
  }
  const store = new LocalBlobStore();
  const ijk = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const nodes = new Map<string, Record<string, unknown>>();
  const put = async (id: string, data: Float32Array | Uint8Array, dtype: string, extra: Record<string, unknown>) => {
    const { desc, blobs } = await volumeToZarr(data, dims, dtype); store.add(blobs);
    nodes.set(id, { id, dims, ijkToRAS: ijk, zarr: desc, ...extra });
  };
  await put("img", img, "<f4", { type: "image" });
  await put("seg", new Uint8Array(N), "|u1", { type: "segmentation", refs: { source: ["img"] }, segments: [
    { labelValue: 1, name: "Ball", visible: true }, { labelValue: 2, name: "Other", visible: true }, { labelValue: 9, name: "Outside", visible: true, rejection: true }] });
  const live = {
    nodes, blobBase: () => "blob://",
    write: (w: { op: string; id: string; path: string; value: unknown }) => { nodes.get(w.id)![w.path.slice(2)] = w.value; },
  } as unknown as LiveScene;
  invalidatePaintCache("seg"); forgetStrokes("seg");
  const flat = (points: Vec3[], segment: number, radiusMm = 2, mode: "add" | "remove" = "add") =>
    paintStroke(live, "seg", points, { segment, radiusMm, mode, sphere: true }, true).then(() => commitPaint(live, store, "seg"));
  const labels = async () => (await fetchZarrVolumeNative("blob://", nodes.get("seg")!.zarr as ZarrDesc)).data as Uint8Array;
  const count = (a: Uint8Array, v: number, f: (i: number) => boolean = () => true) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === v && f(i)) n++; return n; };
  const grow = (segment = 1) => applyEffect(live, store, "seg", "growFromSeeds", { segment });
  // Undo as the panel does it: the earlier description written back, the brush's copy dropped.
  const state = () => JSON.stringify(nodes.get("seg")!.zarr);
  const restore = (s: string) => { nodes.get("seg")!.zarr = JSON.parse(s); invalidatePaintCache("seg"); };
  const ringGray = async (rr = R + 7) => {
    const pts: Vec3[] = [];
    for (let k = 0; k <= 360; k += 4) { const a = k * Math.PI / 180; pts.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a), c[2]]); }
    await flat(pts, 9, 1);
    const pts2: Vec3[] = [];
    for (let k = 0; k <= 360; k += 4) { const a = k * Math.PI / 180; pts2.push([c[0], c[1] + rr * Math.cos(a), c[2] + rr * Math.sin(a)]); }
    await flat(pts2, 9, 1);
  };
  return { live, store, nodes, c, R, at, nx, truth, flat, labels, count, grow, state, restore, ringGray };
}

Deno.test({ name: "Margin, then Grow: no box, it grows from the strokes (finding 1, Ron's \"filled the box\")", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  const first = await s.grow();
  const m = await applyEffect(s.live, s.store, "seg", "margin", { segment: 1, marginMm: 2 });
  assert(m.voxels > first.voxels, `margin ${first.voxels} -> ${m.voxels}`);
  const again = await s.grow();
  console.log(`grow ${first.voxels}, margin ${m.voxels}, grow ${again.voxels}`);
  assertEquals(again.voxels, first.voxels);
}});

Deno.test({ name: "Smoothing, then Grow: the same (finding 1)", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  const first = await s.grow();
  await applyEffect(s.live, s.store, "seg", "smoothing", { segment: 1, smooth: "close", radiusVoxels: 2 });
  assertEquals((await s.grow()).voxels, first.voxels);
}});

Deno.test({ name: "Undo: two presses, Undo, a press with nothing changed gives the second result (finding 2)", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  const r1 = await s.grow();
  // gray close in, so the second press differs from the first
  await s.ringGray(10);
  const before2 = s.state();
  const r2 = await s.grow();
  assert(r2.voxels < r1.voxels, `gray closer in: ${r1.voxels} -> ${r2.voxels}`);
  s.restore(before2);
  const r3 = await s.grow();
  console.log(`press ${r1.voxels}, gray, press ${r2.voxels}, undo, press ${r3.voxels}`);
  assertEquals(r3.voxels, r2.voxels);
}});

Deno.test({ name: "a stroke painted inside the last result stays a seed, also after Undo (finding 3)", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const fromScratch = await (async () => {
    const s = await scene();
    await s.flat([[s.c[0] - 8, s.c[1], s.c[2]]], 1, 3); await s.ringGray();
    const sheet: Vec3[] = [];
    for (let y = -16; y <= 16; y += 2) for (let z = -16; z <= 16; z += 2) sheet.push([s.c[0], s.c[1] + y, s.c[2] + z]);
    await s.flat(sheet, 9, 1);
    await s.flat([[s.c[0] + 8, s.c[1], s.c[2]]], 1, 3);
    return await s.grow();
  })();
  const s = await scene();
  await s.flat([[s.c[0] - 8, s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  const empty = s.state();
  await s.grow();
  const sheet: Vec3[] = [];
  for (let y = -16; y <= 16; y += 2) for (let z = -16; z <= 16; z += 2) sheet.push([s.c[0], s.c[1] + y, s.c[2] + z]);
  await s.flat(sheet, 9, 1);
  await s.flat([[s.c[0] + 8, s.c[1], s.c[2]]], 1, 3);     // inside what the first press filled
  const after = await s.grow();
  console.log(`from scratch ${fromScratch.voxels}, painted inside the result ${after.voxels}`);
  assertEquals(after.voxels, fromScratch.voxels);
  // And after Undo of the first press, the same strokes again.
  s.restore(empty);
  await s.flat(sheet, 9, 1);
  await s.flat([[s.c[0] + 8, s.c[1], s.c[2]]], 1, 3);
  assertEquals((await s.grow()).voxels, fromScratch.voxels);
}});

Deno.test({ name: "erasing a stroke takes it out of the strokes", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  await s.flat([[60, 60, 60]], 1, 2);    // a stray stroke, beyond the gray
  const withStray = await s.grow();
  await s.flat([[60, 60, 60]], 1, 3, "remove");
  const without = await s.grow();
  assert(without.voxels < withStray.voxels, `${withStray.voxels} -> ${without.voxels}`);
  const l = await s.labels();
  assertEquals(l[s.at(60, 60, 60)], 0);
}});

Deno.test({ name: "another structure's gray does not make a box for a new one, or pass as the second place (finding 9)", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  await s.grow();
  setGrowing("seg", 2);
  await s.flat([[8, 8, 8]], 2, 2);       // far from the old gray: no gray of its own
  let said = "";
  try { await s.grow(2); } catch (e) { said = (e as Error).message; }
  assert(said.startsWith("Draw strokes in two places"), said);
}});

Deno.test({ name: "with nothing on record (a segmentation opened from a file) the whole label counts as strokes, and stays so (finding 8, as the cheatsheet says)", ignore: !gpu, fn: async () => {
  setGrowing("seg", 1);
  const s = await scene();
  await s.flat([[s.c[0], s.c[1], s.c[2]]], 1, 3); await s.ringGray();
  const first = await s.grow();
  forgetStrokes("seg");                  // as after a reload
  const reopened = await s.grow();
  assert(reopened.voxels >= first.voxels);
  assertEquals((await s.grow()).voxels, reopened.voxels);   // and a further press does not creep
}});

Deno.test("a stroke on the brush records voxels already of the structure too", async () => {
  const s = await scene();
  await s.flat([[10, 10, 10]], 1, 2);
  await s.flat([[10, 10, 10]], 1, 2);    // no label changes the second time
  const rec = strokesAt("seg", s.nodes.get("seg")!.zarr)!;
  assertEquals(rec.chunks.length, 2);
  assertEquals(rec.chunks[0].at.length, rec.chunks[1].at.length);
  assert(rec.chunks[0].at.length > 0);
});
