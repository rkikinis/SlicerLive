// Name cards (name-cards.ts): the list, adding, editing, removing, what a card says, and the save's id mapping.
import { assert, assertEquals } from "jsr:@std/assert";
import { addCardOps, cardLines, cardsOf, findCardList, isCardList, mapCardRefs, removeCardOp, setShowInOp, showInOf, updateCardOp, type NameCard } from "./name-cards.ts";
import type { MrsonNode } from "../../render/mrson.ts";

const apply = (node: MrsonNode | undefined, op: { op: string; node?: unknown; path?: string; value?: unknown }): MrsonNode => {
  if (op.op === "put") return op.node as MrsonNode;
  const key = op.path!.slice(2);
  return { ...node!, [key]: op.value } as MrsonNode;
};

Deno.test("the first card makes the list (a point list named Name cards, 3D only); later cards join it", () => {
  const a = addCardOps(undefined, "cards-1", { position: [1, 2, 3], associatedNodeID: "seg-1", segment: 4 }, "c1");
  assertEquals(a.ops.length, 1);
  let list = apply(undefined, a.ops[0]);
  assert(isCardList(list));
  assertEquals([list.markupType, list.name], ["fiducial", "Name cards"]);
  assertEquals(showInOf(list), { threeD: true, slices: false });
  assertEquals(cardsOf(list)[0], { id: "c1", position: [1, 2, 3], label: "", description: "", associatedNodeID: "seg-1", segment: 4, cardOffset: [70, -56] });
  const b = addCardOps(list, "unused", { position: [4, 5, 6] }, "c2");
  list = apply(list, b.ops[0]);
  assertEquals([b.listId, b.index, cardsOf(list).length], ["cards-1", 1, 2]);
  assertEquals(findCardList([{ type: "markup", id: "x", markupType: "fiducial" } as unknown as MrsonNode, list])?.id, "cards-1");
});

Deno.test("a card's title, text, offset and visibility change alone; removing the last card keeps the list", () => {
  let list = apply(undefined, addCardOps(undefined, "L", { position: [0, 0, 0] }, "c1").ops[0]);
  list = apply(list, updateCardOp(list, "c1", { label: "Look here first", description: "thicker toward the apex" })!);
  list = apply(list, updateCardOp(list, "c1", { cardOffset: [10, 20] })!);
  assertEquals(cardsOf(list)[0].label, "Look here first");
  assertEquals(cardsOf(list)[0].cardOffset, [10, 20]);
  assertEquals(updateCardOp(list, "nope", { label: "x" }), null);
  list = apply(list, setShowInOp(list, { slices: true }));
  assertEquals(showInOf(list), { threeD: true, slices: true });
  list = apply(list, removeCardOp(list, "c1")!);
  assertEquals(cardsOf(list), []);
  assertEquals(showInOf(list).slices, true, "the choice stays for the next card");
});

Deno.test("what a card says: title above, the file's name and code, the description; nothing typed shows the file", () => {
  const c = (label = "", description = ""): NameCard => ({ id: "c", position: [0, 0, 0], label, description, cardOffset: [0, 0] });
  assertEquals(cardLines(c(), { name: "Aorta", code: "SCT 15825003" }), { title: undefined, name: "Aorta", code: "SCT 15825003", description: undefined });
  assertEquals(cardLines(c("Look here first", "the wall"), { name: "Left ventricle" }), { title: "Look here first", name: "Left ventricle", code: undefined, description: "the wall" });
  assertEquals(cardLines(c()), { title: "Name card", description: undefined });
  assertEquals(cardLines(c("", "a note")), { title: undefined, description: "a note" });
});

Deno.test("a save renames the segmentation a card names, and forgets one that is not saved", () => {
  const cards: NameCard[] = [
    { id: "a", position: [0, 0, 0], label: "", description: "", associatedNodeID: "seg-local-1", segment: 3, cardOffset: [0, 0] },
    { id: "b", position: [0, 0, 0], label: "", description: "", associatedNodeID: "seg-gone", segment: 2, cardOffset: [0, 0] },
    { id: "c", position: [0, 0, 0], label: "t", description: "", cardOffset: [0, 0] },
  ];
  const out = mapCardRefs(cards, (id) => id === "seg-local-1" ? "n4" : undefined);
  assertEquals(out[0].associatedNodeID, "n4");
  assertEquals(out[0].segment, 3);
  assertEquals("associatedNodeID" in out[1] || "segment" in out[1], false);
  assertEquals(out[2], cards[2]);
});

Deno.test("a card hidden by the first build (visible: false) is read as hidden, under Slicer's name", () => {
  const list = { type: "markup", id: "L", drawAs: "cards", controlPoints: [{ id: "c", position: [0, 0, 0], label: "", description: "", cardOffset: [0, 0], visible: false }] } as unknown as MrsonNode;
  assertEquals(cardsOf(list)[0].visibility, false);
  assertEquals("visible" in cardsOf(list)[0], false);
});
