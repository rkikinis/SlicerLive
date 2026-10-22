// A BUTTON ON A TIME SERIES' ROW ACTS ON THE PHASE ON SCREEN WHEN IT IS CLICKED (logic/sequences.ts shownMember; Ron,
// 2026-10-17: the 3D buttons did nothing while the heart played -- the row named a phase already gone from the screen).
//
//   deno test -A --no-check logic/shown-member.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import { shownMember } from "./sequences.ts";

Deno.test("the member on screen now, whichever member the row was drawn with; a plain segmentation is itself", () => {
  const live = new LiveScene("http://x/mrson/", []);
  const put = (n: Record<string, unknown>) => live.nodes.set(n.id as string, n as unknown as MrsonNode);
  put({ type: "sequence", id: "seq", indexType: "numeric", items: [{ index: "1", node: "f1" }, { index: "2", node: "f2" }, { index: "3", node: "f3" }] });
  put({ type: "sequence", id: "cor", companionOf: "seq", items: [{ index: "1", node: "C1" }, { index: "2", node: "C2" }, { index: "3", node: "C3" }] });
  for (const id of ["C1", "C2", "C3"]) put({ type: "segmentation", id, name: id, sequence: "cor" });
  put({ type: "segmentation", id: "plain", name: "plain" });
  const browser = (sel: number) => put({ type: "sequenceBrowser", id: "b", sequences: [{ sequence: "seq" }, { sequence: "cor" }], selectedItemNumber: sel });
  browser(2);
  assertEquals(shownMember(live, "C1"), "C3", "the row drawn with phase 1, clicked at phase 3");
  browser(0);
  assertEquals(shownMember(live, "C3"), "C1");
  assertEquals(shownMember(live, "plain"), "plain");
});
