// WHAT ONE FRAME'S MERGED FIELD DRAWS (render/livescene.ts mergeMembers, CINE-RETHINK.md step 2; critic 2026-10-16,
// step 2, findings 3, 4, 7, 9, 10): each family taken at THIS frame, a family shown when the member shown now is, its
// look -- hidden structures, Scene's ▲▼ order -- read from that member, the 255 count over the structures shown.
// No GPU: the merge itself (solid-merge.ts) has its own tests.
//
//   deno test -A --no-check render/merge-members.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { LiveScene, VolumeRenderingDisplayableManager } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";

type Seg = { name: string; labelValue: number; visible?: boolean };
function heart(opts: { chambers?: number; hideOnShown?: string[]; zOrder?: { A?: number; C?: number }; chambersOff3D?: boolean } = {}) {
  const live = new LiveScene("http://x/mrson/", []);
  const put = (n: Record<string, unknown>) => live.nodes.set(n.id as string, n as unknown as MrsonNode);
  put({ type: "sequence", id: "seq", indexType: "numeric", items: [{ index: "213", node: "fa" }, { index: "250", node: "fb" }] });
  put({ type: "sequence", id: "segA", companionOf: "seq", items: [{ index: "213", node: "A1" }, { index: "250", node: "A2" }] });
  put({ type: "sequence", id: "segC", companionOf: "seq", items: [{ index: "213", node: "C1" }, { index: "250", node: "C2" }] });
  const chambers: Seg[] = Array.from({ length: opts.chambers ?? 7 }, (_, i) => ({ name: `chamber ${i + 1}`, labelValue: i + 1 }));
  // Frame b is shown: its members are visible, frame a's are hidden (a step hides the leaving phase's members).
  for (const [id, seq, shown, segs, fam] of [["A1", "segA", false, chambers, "A"], ["A2", "segA", true, chambers, "A"], ["C1", "segC", false, [{ name: "Coronary artery", labelValue: 1 }], "C"], ["C2", "segC", true, [{ name: "Coronary artery", labelValue: 1 }], "C"]] as const) {
    const z = opts.zOrder?.[fam as "A" | "C"];
    put({ type: "segmentation", id, name: id, sequence: seq, dims: [2, 2, 2], zarr: { id }, visible: shown,
      segments: segs.map((sg) => ({ ...sg, visible: shown && opts.hideOnShown?.includes(sg.name) ? false : sg.visible })),
      ...(shown && typeof z === "number" ? { zOrder: z } : {}), ...(fam === "A" && opts.chambersOff3D ? { visible3D: false } : {}) });
  }
  const vr = new VolumeRenderingDisplayableManager({} as GPUDevice);
  const slot = { image: { id: "fa", sequence: "seq" }, zv: { dims: [2, 2, 2] }, tf: { colorizeSolid: true }, segs: new Map(["A1", "A2", "C1", "C2"].map((id) => [id, live.nodes.get(id)!])) };
  const m = vr as unknown as {
    mergeMembers(slot: unknown, primary: MrsonNode, scene: LiveScene): MrsonNode[];
    mergeHidden(slot: unknown, scene: LiveScene, member: MrsonNode): Set<string>;
    familyLook(slot: unknown, scene: LiveScene, member: MrsonNode): MrsonNode;
  };
  return { live, slot, m, node: (id: string) => live.nodes.get(id)! };
}

Deno.test("a frame merges its OWN phase's member of every family shown, though those members are marked hidden", () => {
  const { live, slot, m, node } = heart();
  assertEquals(m.mergeMembers(slot, node("A1"), live).map((n) => n.id).sort(), ["A1", "C1"]);
});

Deno.test("a family's look comes from the member shown now; a structure hidden there is not written (finding 4)", () => {
  const { live, slot, m, node } = heart({ hideOnShown: ["Coronary artery"] });
  assertEquals(m.familyLook(slot, live, node("C1")).id, "C2");
  assertEquals([...m.mergeHidden(slot, live, node("C1"))], ["Coronary artery"]);
  assertEquals([...m.mergeHidden(slot, live, node("A1"))], []);
});

Deno.test("past 255 structures SHOWN the frame draws its own family alone; hidden ones do not count (finding 7)", () => {
  const over = heart({ chambers: 255 });
  assertEquals(over.m.mergeMembers(over.slot, over.node("A1"), over.live).map((n) => n.id), ["A1"]);
  const hidden = heart({ chambers: 255, hideOnShown: ["chamber 1"] });
  assertEquals(hidden.m.mergeMembers(hidden.slot, hidden.node("A1"), hidden.live).map((n) => n.id).sort(), ["A1", "C1"]);
});

Deno.test("Scene's ▲▼ order, set on the members shown, orders every frame's merge (finding 3)", () => {
  const a = heart({ zOrder: { A: 1, C: 0 } });
  assertEquals(a.m.mergeMembers(a.slot, a.node("A1"), a.live).map((n) => n.id), ["C1", "A1"]);
  const b = heart({ zOrder: { A: 0, C: 1 } });
  assertEquals(b.m.mergeMembers(b.slot, b.node("A1"), b.live).map((n) => n.id), ["A1", "C1"]);
});

Deno.test("the family the field is built around, its 3D button off, is written with none of its structures (Ron, 2026-10-16)", () => {
  const { live, slot, m, node } = heart({ chambersOff3D: true });
  assertEquals(m.mergeHidden(slot, live, node("A1")).size, 7);
  assertEquals(m.mergeHidden(slot, live, node("C1")).size, 0);
  assertEquals(m.mergeMembers(slot, node("A1"), live).map((n) => n.id).sort(), ["A1", "C1"]);
});
