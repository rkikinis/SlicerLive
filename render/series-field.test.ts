// ONE FIELD FOR A SERIES THAT PLAYS (render/series-field.ts; CINE-RETHINK.md step 1): a step of the beating heart
// re-points the series' field and the view only rebinds -- no swap of fields, no re-composed view. A frame whose shader
// differs (not yet colored) re-publishes. No GPU: the frames' fields are stand-ins.
//
//   deno test -A --no-check render/series-field.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { LiveScene, VolumeRenderingDisplayableManager } from "./livescene.ts";
import { SeriesField, shaderSignature } from "./series-field.ts";
import type { Field } from "./fields.ts";
import type { MrsonNode } from "./mrson.ts";

const stand = (kind: string, tag: string): Field & { tag: string; setLUT(): void; setShade(): void } => ({
  tag, kind, bindingCount: 2, uniformFloats: () => 28, structMembers: (s) => `${kind}${s}`, declareBindings: (s, b) => `${kind}${s}@${b}`,
  samplingWGSL: (s) => `fn sample_field_${kind}${s}`, fillUniforms() {}, bindEntries: () => [], aabb: () => [[0, 0, 0], [1, 1, 1]], sampleStep: () => 1,
  setLUT() {}, setShade() {},
});

Deno.test("two frames' fields of one kind share a shader; another kind does not", () => {
  assertEquals(shaderSignature(stand("img", "a")), shaderSignature(stand("img", "b")));
  assert(shaderSignature(stand("img", "a")) !== shaderSignature(stand("clz", "a")));
  const sf = new SeriesField(stand("img", "a"));
  assertEquals(sf.show(stand("img", "b")), false);
  assertEquals((sf.shown as unknown as { tag: string }).tag, "b");
  assertEquals(sf.show(stand("clz", "c")), true);
  assertEquals(sf.kind, "clz");
});

Deno.test("a step of a series that plays rebinds the one series field; a series without times keeps the swap", async () => {
  for (const plays of [true, false]) {
    const calls: string[] = [];
    const view = {
      setVolume3D: (id: string, vol: unknown) => { calls.push(`set ${id} ${vol ? "vol" : "null"}`); },
      swapVolume3D: (prev: string, id: string, vol: unknown) => { calls.push(`swap ${prev}->${id} ${vol ? "vol" : "null"}`); },
      rebind3d: () => { calls.push("rebind"); },
      redraw: () => {},
    };
    const live = new LiveScene("http://x/mrson/", []);
    live.view = view as unknown as LiveScene["view"];
    live.nodes.set("seq", { type: "sequence", id: "seq", indexType: plays ? "numeric" : "text", items: [{ index: plays ? "213" : "b 0", node: "frame-a" }, { index: plays ? "250" : "b 0", node: "frame-b" }] } as unknown as MrsonNode);
    const vr = new VolumeRenderingDisplayableManager({} as GPUDevice);
    const image = (id: string): MrsonNode => ({ type: "image", id, name: id, dims: [2, 2, 2], sequence: "seq" } as unknown as MrsonNode);
    const a = image("frame-a"), b = image("frame-b");
    live.nodes.set(a.id, a); live.nodes.set(b.id, b);
    await vr.onNodeAdded(a, live); await vr.onNodeAdded(b, live);
    const slots = (vr as unknown as { slots: Map<string, { field?: unknown; zv?: unknown }> }).slots;
    for (const [id, s] of slots) { s.field = stand("img", id); s.zv = { data: new Float32Array(0), dims: [2, 2, 2], range: [0, 1] }; }
    const display = (volume: string): MrsonNode => ({ type: "volumeRenderingDisplay", id: "vr", name: "vr", visible: true, colorize: false, refs: { volume: [volume] } } as unknown as MrsonNode);
    live.nodes.set("vr", display(a.id));
    await vr.onNodeAdded(display(a.id), live);
    calls.length = 0;
    live.nodes.set("vr", display(b.id));
    await vr.onNodeAdded(display(b.id), live);         // the step: a -> b
    if (plays) assertEquals(calls, ["rebind"], `a series that plays: one rebind, got ${calls.join(" | ")}`);
    else assertEquals(calls, ["swap frame-a->frame-b vol"], `a series without times: the swap, got ${calls.join(" | ")}`);
  }
});

Deno.test("the shown frame's field changed in place (the solid look switched) is re-published, not skipped; another frame's push does nothing (critic 2026-10-16, step 1, finding 1)", async () => {
  const calls: string[] = [];
  const view = {
    setVolume3D: (id: string, vol: unknown) => { calls.push(`set ${id} ${vol ? "vol" : "null"}`); },
    swapVolume3D: (prev: string, id: string, vol: unknown) => { calls.push(`swap ${prev}->${id} ${vol ? "vol" : "null"}`); },
    rebind3d: () => { calls.push("rebind"); },
    redraw: () => {},
  };
  const live = new LiveScene("http://x/mrson/", []);
  live.view = view as unknown as LiveScene["view"];
  live.nodes.set("seq", { type: "sequence", id: "seq", indexType: "numeric", items: [{ index: "213", node: "frame-a" }, { index: "250", node: "frame-b" }] } as unknown as MrsonNode);
  const vr = new VolumeRenderingDisplayableManager({} as GPUDevice);
  const image = (id: string): MrsonNode => ({ type: "image", id, name: id, dims: [2, 2, 2], sequence: "seq" } as unknown as MrsonNode);
  const a = image("frame-a"), b = image("frame-b");
  live.nodes.set(a.id, a); live.nodes.set(b.id, b);
  await vr.onNodeAdded(a, live); await vr.onNodeAdded(b, live);
  const slots = (vr as unknown as { slots: Map<string, { field?: unknown; zv?: unknown }> }).slots;
  for (const [id, s] of slots) { s.field = stand("img", id); s.zv = { data: new Float32Array(0), dims: [2, 2, 2], range: [0, 1] }; }
  const display: MrsonNode = { type: "volumeRenderingDisplay", id: "vr", name: "vr", visible: true, colorize: false, refs: { volume: [a.id] } } as unknown as MrsonNode;
  live.nodes.set("vr", display);
  await vr.onNodeAdded(display, live);
  const push = (id: string) => (vr as unknown as { push(id: string, s: unknown): void }).push(id, slots.get(id));
  calls.length = 0;
  push("frame-b");                                     // a frame not shown
  assertEquals(calls, [], `another frame's push: nothing for the view, got ${calls.join(" | ")}`);
  push("frame-a");                                     // the shown frame, changed in place
  assertEquals(calls, ["set series:seq vol"], `the shown frame changed in place: re-published, got ${calls.join(" | ")}`);
  assertEquals(vr.fieldFor("frame-b") !== undefined, true, "a frame's own field can be looked up (the preset thumbnails, finding 4)");
});
