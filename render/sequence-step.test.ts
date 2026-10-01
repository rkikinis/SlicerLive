// A SEQUENCE STEP NEVER EMPTIES THE 3D VIEW. Re-pointing the volume rendering from one frame to
// the next used to withdraw the old frame first and add the new one after an await, and the view
// in between -- nothing in 3D -- threw every resident surface off the GPU and recompiled the
// shader (critic, 2026-09-19, finding 1). The manager now hands the view one swap. No GPU here:
// the frames' fields are stand-ins, so ensureField returns at once and only the publishing order
// is under test.
import { assertEquals } from "jsr:@std/assert";
import { LiveScene, VolumeRenderingDisplayableManager } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";

Deno.test("re-pointing the rendering at another frame is one swap, never a withdraw-then-add", async () => {
  const calls: string[] = [];
  const view = {
    setVolume3D: (id: string, vol: unknown) => { calls.push(`set ${id} ${vol ? "vol" : "null"}`); },
    swapVolume3D: (prev: string, id: string, vol: unknown) => { calls.push(`swap ${prev}->${id} ${vol ? "vol" : "null"}`); },
    redraw: () => {},
  };
  const live = new LiveScene("http://x/mrson/", []);
  live.view = view as unknown as LiveScene["view"];
  const vr = new VolumeRenderingDisplayableManager({} as GPUDevice);
  const image = (id: string): MrsonNode => ({ type: "image", id, name: id, dims: [2, 2, 2], sequence: "seq" } as unknown as MrsonNode);
  const a = image("frame-a"), b = image("frame-b");
  live.nodes.set(a.id, a); live.nodes.set(b.id, b);
  await vr.onNodeAdded(a, live); await vr.onNodeAdded(b, live);
  // Stand-in fields, so nothing is fetched or uploaded.
  const slots = (vr as unknown as { slots: Map<string, { field?: unknown; zv?: unknown }> }).slots;
  for (const s of slots.values()) { s.field = { setLUT() {}, setShade() {} }; s.zv = { data: new Float32Array(0), dims: [2, 2, 2], range: [0, 1] }; }
  const display = (volume: string): MrsonNode => ({ type: "volumeRenderingDisplay", id: "vr", name: "vr", visible: true, colorize: false, refs: { volume: [volume] } } as unknown as MrsonNode);
  live.nodes.set("vr", display(a.id));
  await vr.onNodeAdded(display(a.id), live);
  calls.length = 0;
  live.nodes.set("vr", display(b.id));
  await vr.onNodeAdded(display(b.id), live);           // the step: a -> b
  assertEquals(calls, ["swap frame-a->frame-b vol"], `the step must publish one swap; got: ${calls.join(" | ")}`);
});
