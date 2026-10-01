// A segmentation made on a frame joins the sequence at that frame; the browser steps it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import { companionItem, currentFrames, frameMate, joinSequence, selectFrame } from "./sequences.ts";

function scene(): { live: LiveScene; browser: string; frames: string[] } {
  const live = new LiveScene("http://x/mrson/", []);
  const frames = ["f0", "f1", "f2"];
  for (const f of frames) live.write({ op: "put", id: f, node: { type: "image", id: f, name: `ct · ${f}`, hidden: true, sequence: "seq" } as unknown as MrsonNode });
  live.write({ op: "put", id: "seq", node: { type: "sequence", id: "seq", name: "ct", indexName: "delay", indexUnit: "ms", indexType: "numeric", items: [{ index: "213", node: "f0", time: 0.213 }, { index: "250", node: "f1", time: 0.25 }, { index: "300", node: "f2", time: 0.3 }] } as unknown as MrsonNode });
  live.write({ op: "put", id: "b", node: { type: "sequenceBrowser", id: "b", sequences: [{ sequence: "seq", proxy: "f0", playback: true }], selectedItemNumber: 0 } as unknown as MrsonNode });
  return { live, browser: "b", frames };
}
const seg = (live: LiveScene, id: string, frame: string, name = "chambers") =>
  live.write({ op: "put", id, node: { type: "segmentation", id, name, refs: { source: [frame] }, visible: true, segments: [{ labelValue: 1, name: "aorta", visible: true }] } as unknown as MrsonNode });

Deno.test("joinSequence: a companion sequence in the same browser, at the frame's index; same name joins, another name starts its own", () => {
  const { live } = scene();
  seg(live, "s0", "f0");
  const r = joinSequence(live, "s0")!;
  assertEquals(r.index, "213");
  const b = live.nodes.get("b")!;
  assertEquals((b.sequences as { sequence: string }[]).length, 2);
  assertEquals(live.nodes.get("s0")!.sequence, r.sequenceId);
  assertEquals(live.nodes.get("s0")!.hidden, true);
  seg(live, "s2", "f2");
  assertEquals(joinSequence(live, "s2")!.sequenceId, r.sequenceId);
  assertEquals((live.nodes.get(r.sequenceId)!.items as { index: string; node: string }[]).map((i) => i.node), ["s0", "s2"]);
  seg(live, "c1", "f1", "coronaries");
  const c = joinSequence(live, "c1")!;
  assert(c.sequenceId !== r.sequenceId);
  assertEquals((live.nodes.get("b")!.sequences as unknown[]).length, 3);
  // not on a frame: nothing happens
  seg(live, "x", "nowhere");
  assertEquals(joinSequence(live, "x"), null);
});

Deno.test("companionItem and frameMate: the member for the frame, else the latest earlier one", () => {
  const { live } = scene();
  seg(live, "s0", "f0"); joinSequence(live, "s0");
  seg(live, "s2", "f2"); joinSequence(live, "s2");
  assertEquals(companionItem(live, "b", 1)!.node, "s0");
  selectFrame(live, "b", 1);
  assertEquals(companionItem(live, "b", 1)!.node, "s0");     // no member for 250 ms: the previous holds
  selectFrame(live, "b", 2);
  assertEquals(companionItem(live, "b", 1)!.node, "s2");
  assertEquals(frameMate(live, "s0", "f2"), "s2");
  assertEquals(frameMate(live, "s2", "f1"), "s0");
  assertEquals(frameMate(live, "s2", "f0"), "s0");
  assertEquals(frameMate(live, "nope", "f0"), undefined);
  // the current member is listed with the frames, under the sequence's name
  const cur = currentFrames(live);
  assertEquals(cur.get("f2"), "ct · 300 ms");
  assertEquals(cur.get("s2"), "chambers · 300 ms");
  assert(!cur.has("s0"));
});

Deno.test("joinSequence: a second segmentation for the same frame replaces the first, which leaves the sequence", () => {
  const { live } = scene();
  seg(live, "s0", "f0"); joinSequence(live, "s0");
  seg(live, "s0b", "f0"); const r = joinSequence(live, "s0b")!;
  assertEquals((live.nodes.get(r.sequenceId)!.items as { node: string }[]).map((i) => i.node), ["s0b"]);
  assert(!live.nodes.get("s0")!.sequence);
  assertEquals(live.nodes.get("s0")!.hidden, false);
});

Deno.test("SequenceDisplayableManager: one member on screen per companion; the display travels with the step", async () => {
  const { SequenceDisplayableManager } = await import("../render/livescene.ts");
  const live = new LiveScene("http://x/mrson/", [new SequenceDisplayableManager()]);
  const frames = ["f0", "f1", "f2"];
  for (const f of frames) live.write({ op: "put", id: f, node: { type: "image", id: f, name: f, hidden: true, sequence: "seq" } as unknown as MrsonNode });
  live.write({ op: "put", id: "seq", node: { type: "sequence", id: "seq", name: "ct", indexType: "numeric", items: [{ index: "213", node: "f0" }, { index: "250", node: "f1" }, { index: "300", node: "f2" }] } as unknown as MrsonNode });
  live.write({ op: "put", id: "b", node: { type: "sequenceBrowser", id: "b", sequences: [{ sequence: "seq", proxy: "f0", playback: true }], selectedItemNumber: 0 } as unknown as MrsonNode });
  seg(live, "s0", "f0"); joinSequence(live, "s0");
  seg(live, "s1", "f1"); joinSequence(live, "s1");
  seg(live, "s2", "f2"); joinSequence(live, "s2");
  const vis = () => ["s0", "s1", "s2"].map((id) => live.nodes.get(id)!.visible !== false).join("");
  const in3D = (id: string) => { const n = live.nodes.get(id)!; return ((n.visible3D as boolean | undefined) ?? (n.visible !== false)); };
  assertEquals(vis(), "truefalsefalse");                     // frame 0: its member, the others dark
  selectFrame(live, "b", 1);
  assertEquals(vis(), "falsetruefalse");
  // 3D FOLLOWS TOO: the first member had visible3D unset (in 3D), and the next must not keep the join's false
  // (2026-09-24: after one step the heart's families were in 3D nowhere)
  assertEquals(in3D("s1"), true);
  // the user turns the aorta off and hides the member in 3D; the next member inherits both
  live.write({ op: "patch", id: "s1", path: "#/visible3D", value: false });
  live.write({ op: "patch", id: "s1", path: "#/segments", value: [{ labelValue: 1, name: "aorta", visible: false }] });
  selectFrame(live, "b", 2);
  assertEquals(vis(), "falsefalsetrue");
  assertEquals(live.nodes.get("s2")!.visible3D, false);
  assertEquals((live.nodes.get("s2")!.segments as { visible?: boolean }[])[0].visible, false);
  selectFrame(live, "b", 0);
  assertEquals(vis(), "truefalsefalse");
  assertEquals(live.nodes.get("s0")!.visible3D, false);
});

Deno.test("a phase joining a family given surface models does NOT take the flag: no implicit creation (Ron, 2026-09-24)", () => {
  const { live } = scene();
  seg(live, "s0", "f0");
  joinSequence(live, "s0");
  live.write({ op: "patch", id: "s0", path: "#/surfaceModels", value: true });
  seg(live, "s1", "f1");
  joinSequence(live, "s1");
  assertEquals(live.nodes.get("s1")!.surfaceModels, undefined);
  seg(live, "c1", "f1", "coronaries");
  joinSequence(live, "c1");
  assertEquals(live.nodes.get("c1")!.surfaceModels, undefined);
});
