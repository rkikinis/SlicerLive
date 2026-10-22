// A FAMILY STEPPING WITH THE PHASES (render/livescene.ts SequenceDisplayableManager.stepCompanions): the member arriving
// takes the display of the one leaving. When the one leaving has been deleted, the family's display as last stepped to is
// handed over, so the family does not stay hidden for good (critic 2026-10-16, cine step 2, seen in passing).
//
//   deno test -A --no-check render/step-companions.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { LiveScene, SequenceDisplayableManager } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";

Deno.test("deleting the member on screen: the next phase's member is shown, not left dark", async () => {
  const live = new LiveScene("http://x/mrson/", []);
  const put = (n: Record<string, unknown>) => live.nodes.set(n.id as string, n as unknown as MrsonNode);
  put({ type: "sequence", id: "seq", indexType: "numeric", items: [{ index: "1", node: "f1" }, { index: "2", node: "f2" }, { index: "3", node: "f3" }] });
  put({ type: "sequence", id: "cor", companionOf: "seq", items: [{ index: "1", node: "C1" }, { index: "2", node: "C2" }, { index: "3", node: "C3" }] });
  for (const [id, on] of [["C1", true], ["C2", false], ["C3", false]] as const) put({ type: "segmentation", id, name: id, sequence: "cor", visible: on, visible3D: on });
  const mgr = new SequenceDisplayableManager();
  const browser = (sel: number) => ({ type: "sequenceBrowser", id: "b", sequences: [{ sequence: "seq" }, { sequence: "cor" }], selectedItemNumber: sel }) as unknown as MrsonNode;
  const step = async (sel: number) => { const b = browser(sel); live.nodes.set("b", b); mgr.onNodeAdded(b, live); await new Promise((r) => setTimeout(r, 0)); };
  await step(0);
  await step(1);
  assertEquals([live.nodes.get("C1")?.visible, live.nodes.get("C2")?.visible], [false, true], "an ordinary step hands the display over");
  live.nodes.delete("C2");                              // the member on screen is deleted
  await step(2);
  assertEquals(live.nodes.get("C3")?.visible, true, "the next member is shown");
  assertEquals(live.nodes.get("C3")?.visible3D, true, "and in 3D");
});

Deno.test("a family the person hid stays hidden after its member on screen is deleted (critic 2026-10-16, tonight's fixes, finding 2)", async () => {
  for (const how of ["3D button", "eye"] as const) {
    const live = new LiveScene("http://x/mrson/", []);
    const put = (n: Record<string, unknown>) => live.nodes.set(n.id as string, n as unknown as MrsonNode);
    put({ type: "sequence", id: "seq", indexType: "numeric", items: [{ index: "1", node: "f1" }, { index: "2", node: "f2" }, { index: "3", node: "f3" }] });
    put({ type: "sequence", id: "cor", companionOf: "seq", items: [{ index: "1", node: "C1" }, { index: "2", node: "C2" }, { index: "3", node: "C3" }] });
    for (const [id, on] of [["C1", true], ["C2", false], ["C3", false]] as const) put({ type: "segmentation", id, name: id, sequence: "cor", visible: on, visible3D: on });
    const mgr = new SequenceDisplayableManager();
    (live.managers as unknown as unknown[]).push(mgr);                // the person's writes reach it as the app's do
    const browser = (sel: number) => ({ type: "sequenceBrowser", id: "b", sequences: [{ sequence: "seq" }, { sequence: "cor" }], selectedItemNumber: sel }) as unknown as MrsonNode;
    const step = async (sel: number) => { const b = browser(sel); live.nodes.set("b", b); mgr.onNodeAdded(b, live); await new Promise((r) => setTimeout(r, 0)); };
    await step(0); await step(1);
    if (how === "3D button") live.write({ op: "patch", id: "C2", path: "#/visible3D", value: false });
    else live.write({ op: "put", id: "C2", node: { ...live.nodes.get("C2")!, visible: false, visible3D: false } as MrsonNode });
    live.nodes.delete("C2");
    await step(2);
    assertEquals(live.nodes.get("C3")?.visible3D, false, `${how}: the next member is not shown in 3D`);
    if (how === "eye") assertEquals(live.nodes.get("C3")?.visible, false, "eye: nor in 2D");
  }
});
