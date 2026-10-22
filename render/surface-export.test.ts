// The surface export (render/surface-export.ts; Ron, 2026-10-21, option B): surfaces made on demand from a
// segmentation's labels, with the REAL extraction worker, written as STL or OBJ. The labels are handed in as the page
// hook would hand them (read back from the card); the scene is a plain map of nodes.
//
//   deno test -A --no-check render/surface-export.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import type { LiveScene } from "./livescene.ts";
import { makeSurfaces, sceneSurfaceFile, structuresToExport, surfaceFile } from "./surface-export.ts";
import { readObj, readStl } from "../logic/writers/surface-files.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const worker = () => new Worker(new URL("../algorithms/surface-nets-worker.ts", import.meta.url), { type: "module" });
const dims: [number, number, number] = [16, 16, 16];
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Three boxes, labels 1, 2 and 3, apart from one another. */
function labels(): Uint8Array {
  const lab = new Uint8Array(16 * 16 * 16);
  for (let k = 4; k < 12; k++) for (let j = 4; j < 12; j++) for (let i = 1; i < 15; i++) lab[(k * 16 + j) * 16 + i] = i < 5 ? 1 : i < 10 ? (i === 5 ? 0 : 2) : (i === 10 ? 0 : 3);
  return lab;
}
const readLabels = async () => ({ labels: labels(), dims, ijkToRAS: ID });
function sceneWith(segments: { labelValue: number; name: string; color: number[]; visible?: boolean }[]): LiveScene {
  const nodes = new Map<string, unknown>([["seg", { type: "segmentation", id: "seg", name: "Three boxes", dims, segments }]]);
  return { nodes } as unknown as LiveScene;
}
const SEGS = [
  { labelValue: 1, name: "Liver", color: [0.9, 0.5, 0.2] },
  { labelValue: 2, name: "Spleen", color: [0.6, 0.2, 0.6] },
  { labelValue: 3, name: "Kidney", color: [0.7, 0.3, 0.2] },
];
const join = (chunks: Uint8Array[]) => { const o = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return o; };

Deno.test("the structures shown go into the file; all of them when none is shown", () => {
  assertEquals(structuresToExport([{ labelValue: 1 }, { labelValue: 2, visible: false }, { labelValue: 3 }]).map((s) => s.labelValue), [1, 3]);
  assertEquals(structuresToExport([{ labelValue: 1, visible: false }, { labelValue: 2, visible: false }]).map((s) => s.labelValue), [1, 2]);
  assertEquals(structuresToExport([{ labelValue: 0 }, { labelValue: 300 }]).length, 0);
});

Deno.test({ ...opts, name: "the worker makes surfaces of the structures shown only", async fn() {
  const live = sceneWith([SEGS[0], { ...SEGS[1], visible: false }, SEGS[2]]);
  const made = await makeSurfaces(live, "seg", () => {}, { readLabels, makeWorker: worker });
  assertEquals(made.meshes.map((m) => m.label).sort(), [1, 3]);
  assert(made.meshes.every((m) => m.indices.length > 0 && m.positions.length > 0));
} });

Deno.test({ ...opts, name: "STL: one file of the structures shown, named by the segmentation", async fn() {
  const live = sceneWith([SEGS[0], { ...SEGS[1], visible: false }, SEGS[2]]);
  const r = await surfaceFile(live, "seg", "stl", () => {}, { readLabels, makeWorker: worker });
  assertEquals(r.filename, "Three_boxes.surfaces.stl");
  const back = readStl(join(r.chunks));
  assertEquals(r.size, 84 + 50 * back.triangles);
  assert(back.header.includes("Three boxes"));
  // Every corner in LPS: x and y negated from the RAS grid 0..15, so x and y are <= 0 and z >= 0.
  for (let i = 0; i < back.corners.length; i += 3) assert(back.corners[i] <= 0.5 && back.corners[i + 1] <= 0.5 && back.corners[i + 2] >= -0.5);
} });

Deno.test({ ...opts, name: "OBJ: one object per structure shown, named and colored as in Segmentations", async fn() {
  const live = sceneWith(SEGS);
  const r = await surfaceFile(live, "seg", "obj", () => {}, { readLabels, makeWorker: worker });
  assertEquals(r.filename, "Three_boxes.surfaces.obj");
  const back = readObj(new TextDecoder().decode(join(r.chunks)));
  assertEquals(back.objects.map((o) => o.name).sort(), ["Kidney", "Liver", "Spleen"]);
  const liver = back.objects.find((o) => o.name === "Liver")!;
  assertEquals([...liver.colors!.subarray(0, 3)].map((v) => +v.toFixed(3)), [0.9, 0.5, 0.2]);
} });

Deno.test({ ...opts, name: "a segmentation not on the card is refused in a sentence", async fn() {
  const live = sceneWith(SEGS);
  await assertRejects(() => makeSurfaces(live, "seg", () => {}, { readLabels: async () => null, makeWorker: worker }), Error, "not loaded");
  await assertRejects(() => makeSurfaces(live, "nope", () => {}, { readLabels, makeWorker: worker }), Error, "no such segmentation");
} });

// ONE AT A TIME (critic 2026-10-21, finding 6): a second export waits for the first; its labels are not read until then.
Deno.test({ ...opts, name: "two exports at once run one after the other", async fn() {
  const live = sceneWith(SEGS);
  const events: string[] = [];
  const reader = (tag: string) => async () => { events.push(`read ${tag}`); await new Promise((r) => setTimeout(r, 30)); return { labels: labels(), dims, ijkToRAS: ID }; };
  const said: string[] = [];
  // The worker's own answer marks the end of an extraction.
  const watched = (tag: string) => () => { const w = worker(); w.addEventListener("message", (e) => { if ((e as MessageEvent).data?.build !== undefined) events.push(`made ${tag}`); }); return w; };
  const a = surfaceFile(live, "seg", "stl", () => {}, { readLabels: reader("A"), makeWorker: watched("A") });
  const b = surfaceFile(live, "seg", "obj", (m) => said.push(m), { readLabels: reader("B"), makeWorker: watched("B") });
  await Promise.all([a, b]);
  assertEquals(events, ["read A", "made A", "read B", "made B"]);
  assert(said.some((m) => /waiting/.test(m)), "the second says it waits");
} });

// CLOSED, FOR 3D PRINTING (Ron, 2026-10-22, "Caps only"): a box cut off by the scan's edge comes out with a cap -- every edge of the
// STL (corners matched by position) used by exactly two triangles -- and the note says it was closed.
function stlEdges(bytes: Uint8Array) {
  const back = readStl(bytes), key = (i: number) => `${back.corners[i].toFixed(4)},${back.corners[i + 1].toFixed(4)},${back.corners[i + 2].toFixed(4)}`;
  const m = new Map<string, number>();
  for (let t = 0; t < back.triangles; t++) for (let c = 0; c < 3; c++) {
    const a = key(9 * t + 3 * c), b = key(9 * t + 3 * ((c + 1) % 3)); const k = a < b ? `${a}|${b}` : `${b}|${a}`; m.set(k, (m.get(k) ?? 0) + 1);
  }
  let open = 0, multi = 0; for (const v of m.values()) { if (v === 1) open++; else if (v > 2) multi++; }
  return { open, multi };
}
Deno.test({ ...opts, name: "closed for 3D printing: a structure cut off by the scan's edge gets a cap", async fn() {
  const cut = async () => { const lab = new Uint8Array(16 * 16 * 16); for (let k = 4; k < 12; k++) for (let j = 4; j < 12; j++) for (let i = 0; i < 8; i++) lab[(k * 16 + j) * 16 + i] = 1; return { labels: lab, dims, ijkToRAS: ID }; };
  const live = sceneWith([SEGS[0]]);
  const open = await surfaceFile(live, "seg", "stl", () => {}, { readLabels: cut, makeWorker: worker });
  assert(stlEdges(join(open.chunks)).open > 0, "without closing, the cut is open");
  const closed = await surfaceFile(live, "seg", "stl", () => {}, { readLabels: cut, makeWorker: worker, closed: true });
  assertEquals(stlEdges(join(closed.chunks)), { open: 0, multi: 0 });
  assert(/closed where the scan cuts a structure off/.test(closed.note), closed.note);
} });

// EVERYTHING SHOWN IN 3D (Ron, 2026-10-22): two segmentations in one OBJ, each structure named "segmentation · structure",
// the vertex numbers right across the parts (readObj checks every face's numbers against the vertices).
Deno.test({ ...opts, name: "everything shown in 3D: two segmentations in one OBJ and one STL", async fn() {
  const nodes = new Map<string, unknown>([
    ["a", { type: "segmentation", id: "a", name: "Organs", dims, segments: SEGS.slice(0, 2) }],
    ["b", { type: "segmentation", id: "b", name: "Kidneys", dims, segments: SEGS.slice(2) }],
  ]);
  const live = { nodes } as unknown as LiveScene;
  const obj = await sceneSurfaceFile(live, ["a", "b"], "obj", () => {}, { readLabels, makeWorker: worker });
  assertEquals(obj.filename, "Everything_shown_in_3D.surfaces.obj");
  const back = readObj(new TextDecoder().decode(join(obj.chunks)));
  assertEquals(back.objects.map((o) => o.name), ["Organs · Liver", "Organs · Spleen", "Kidneys · Kidney"]);
  for (const o of back.objects) assert(o.triangles.every((t) => t < o.vertices.length / 3), `${o.name}: a face points past its vertices`);
  const stl = await sceneSurfaceFile(live, ["a", "b"], "stl", () => {}, { readLabels, makeWorker: worker });
  const s = readStl(join(stl.chunks));
  assertEquals(stl.size, 84 + 50 * s.triangles);
  assert(s.header.startsWith("SPACE=LPS"), s.header);
  assert(/2 segmentations, 3 structures/.test(stl.note), stl.note);
} });
