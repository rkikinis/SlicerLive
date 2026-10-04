// NAME CARDS -- a markup type: a card on a structure, placed by hand (Ron, 2026-09-24: "I would like to have a small
// number, manually placed and removed. In addition to the automatically generated text, being able to add a manual
// title/description"; 2026-09-25: "just another type of markup and that module is the full home for this"; 2026-10-01:
// "The cards as a new markup ... I would like to set their origin manually"). Design: Contents/docs/mockups/
// name-cards-2026-09-25.html and WORKING-STATE, 2026-09-25 10:35 (SlicerAlbula workspace).
//
// STORED AS SLICER STORES A POINT LIST, so the cards survive a trip through Slicer as labeled points with descriptions:
// one markup node of type "fiducial" named "Name cards", marked `drawAs: "cards"`; each card is a control point --
//   label             the typed title (Slicer's Label)
//   description       the typed text (Slicer's Description; Slicer keeps it, the card shows it)
//   position          the pin, where the click was
// and three of Slicer's own control-point fields, under Slicer's names: associatedNodeID (here: the segmentation),
// visibility and locked (critic, 2026-10-02, finding 10). New, to propose to Steve Pieper: segment (the label value in that
// segmentation) and cardOffset (where the card sits from its pin, screen pixels; display only). Albula has no Slicer
// markups-file reader or writer yet; the names are chosen so one needs no translation for these.
// The structure's NAME is not stored: it is read from the segmentation each time, so a card never disagrees with the file.
// The list carries showIn: { threeD, slices } -- 3D only by default (Ron: "I am concerned about crowding out the image").
// Pure: ops out, no side effects (as placer.ts).
import type { MrsonNode } from "../../render/mrson.ts";
import type { Op } from "../../render/liveops.ts";
import type { Vec3 } from "../../render/mat4.ts";

export const CARDS_LIST_NAME = "Name cards";
/** Where a new card sits from its pin, in screen pixels: up and to the right, clear of the pin. */
export const DEFAULT_CARD_OFFSET: [number, number] = [70, -56];

export interface NameCard {
  id: string;
  position: Vec3;
  label: string;
  description: string;
  associatedNodeID?: string;
  segment?: number;
  cardOffset: [number, number];
  visibility?: boolean;
  locked?: boolean;
}
export interface ShowIn { threeD: boolean; slices: boolean }

export const isCardList = (n: MrsonNode | undefined): boolean => !!n && n.type === "markup" && n.drawAs === "cards";
/** The cards of a list. A card saved by the first build (2026-10-02, 11:46-13:06) kept its show/hide as `visible`; it is
 *  read as Slicer's `visibility` (critic round 2, finding 12). */
export const cardsOf = (n: MrsonNode): NameCard[] => ((n.controlPoints as (NameCard & { visible?: boolean })[] | undefined) ?? [])
  .map((c) => "visible" in c ? (({ visible, ...rest }) => ({ ...rest, visibility: rest.visibility ?? visible }))(c) : c);
export const showInOf = (n: MrsonNode): ShowIn => ({ threeD: true, slices: false, ...((n.showIn as Partial<ShowIn> | undefined) ?? {}) });

/** The scene's card list (the first, if a scene came with several). */
export function findCardList(nodes: Iterable<MrsonNode>): MrsonNode | undefined {
  for (const n of nodes) if (isCardList(n)) return n;
  return undefined;
}

/** A new, empty card list node. */
export function newCardList(id: string): MrsonNode {
  return {
    type: "markup", id, name: CARDS_LIST_NAME, markupType: "fiducial", drawAs: "cards", frame: "RAS",
    controlPoints: [], showIn: { threeD: true, slices: false }, glyphScale: 3, visible: true, locked: false,
    refs: {}, source: { mrmlClass: "vtkMRMLMarkupsFiducialNode" }, origin: { local: true },
  } as unknown as MrsonNode;
}

/** Add a card at `position`, naming `segment` of `associatedNodeID` (both optional: a card can name nothing). */
export function addCardOps(list: MrsonNode | undefined, newListId: string, card: { position: Vec3; associatedNodeID?: string; segment?: number; label?: string; description?: string }, cardId: string): { ops: Op[]; listId: string; index: number } {
  const c: NameCard = {
    id: cardId, position: card.position, label: card.label ?? "", description: card.description ?? "",
    ...(card.associatedNodeID ? { associatedNodeID: card.associatedNodeID } : {}),
    ...(card.segment !== undefined ? { segment: card.segment } : {}),
    cardOffset: [...DEFAULT_CARD_OFFSET] as [number, number],
  };
  if (!list) {
    const node = newCardList(newListId);
    (node as Record<string, unknown>).controlPoints = [c];
    return { ops: [{ op: "put", id: newListId, node }], listId: newListId, index: 0 };
  }
  const cards = [...cardsOf(list), c];
  return { ops: [{ op: "patch", id: list.id as string, path: "#/controlPoints", value: cards }], listId: list.id as string, index: cards.length - 1 };
}

/** Change one card's own fields (title, text, offset, visibility, locked). Null when there is no such card. */
export function updateCardOp(list: MrsonNode, cardId: string, patch: Partial<Pick<NameCard, "label" | "description" | "cardOffset" | "visibility" | "locked">>): Op | null {
  const cards = cardsOf(list);
  const i = cards.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const next = cards.slice();
  next[i] = { ...cards[i], ...patch };
  return { op: "patch", id: list.id as string, path: "#/controlPoints", value: next };
}

/** Remove one card. The list stays, empty if need be: its "Show in" choice is kept for the next card. */
export function removeCardOp(list: MrsonNode, cardId: string): Op | null {
  const cards = cardsOf(list);
  if (!cards.some((c) => c.id === cardId)) return null;
  return { op: "patch", id: list.id as string, path: "#/controlPoints", value: cards.filter((c) => c.id !== cardId) };
}

/** Where cards are drawn: 3D, slices. */
export function setShowInOp(list: MrsonNode, showIn: Partial<ShowIn>): Op {
  return { op: "patch", id: list.id as string, path: "#/showIn", value: { ...showInOf(list), ...showIn } };
}

/**
 * WHAT A CARD SAYS, top to bottom (mockup, "the card's four states"): the typed title on top, bold (Ron: "above"); the
 * structure's name from the file; the code line (what the file's codes add, or the code itself); the typed description.
 * A card with nothing typed shows the file's name and code; a card naming nothing shows what was typed, or "Name card".
 */
export function cardLines(card: NameCard, structure?: { name: string; code?: string }): { title?: string; name?: string; code?: string; description?: string } {
  const title = card.label.trim() || undefined, description = card.description.trim() || undefined;
  if (!structure) return { title: title ?? (description ? undefined : "Name card"), description };
  return { title, name: structure.name, code: structure.code, description };
}

/** The scene file keeps a card's segmentation by its id, which a save renames: map it, and drop it when that node is not saved. */
export function mapCardRefs(cards: NameCard[], idOf: (id: string) => string | undefined): NameCard[] {
  return cards.map((c) => {
    if (!c.associatedNodeID) return c;
    const to = idOf(c.associatedNodeID);
    if (to) return { ...c, associatedNodeID: to };
    const { associatedNodeID: _gone, segment: _s, ...rest } = c;
    return rest as NameCard;
  });
}

/**
 * THE CODE LINE under a structure's name -- Steve Pieper's rule (render/segment-cards.ts bodyText): what the segment's
 * codes ADD to the name (a region, a type whose meaning differs), else the type's code itself; nothing when the segment
 * carries no codes. Read from whichever coded fields the segment has (type / region, or DICOM's property type / anatomic
 * region).
 */
export function segmentCodeLine(segment: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!segment) return undefined;
  type Coded = { scheme?: string; value?: string; meaning?: string; CodingSchemeDesignator?: string; CodeValue?: string; CodeMeaning?: string };
  const pick = (...keys: string[]) => { for (const k of keys) { const v = segment[k] as Coded | null | undefined; if (v && typeof v === "object") return v; } return undefined; };
  const norm = (t?: string) => (t ?? "").trim().toLowerCase();
  const type = pick("type", "propertyType", "segmentedPropertyType"), region = pick("region", "anatomicRegion");
  const meaning = (c?: Coded) => c?.meaning ?? c?.CodeMeaning;
  const code = (c?: Coded) => `${c?.scheme ?? c?.CodingSchemeDesignator ?? ""} ${c?.value ?? c?.CodeValue ?? ""}`.trim();
  if (!type && !region) return undefined;
  const parts: string[] = [];
  if (meaning(type) && norm(meaning(type)) !== norm(name)) parts.push(meaning(type)!);
  if (meaning(region) && norm(meaning(region)) !== norm(name) && norm(meaning(region)) !== norm(meaning(type))) parts.push(meaning(region)!);
  if (!parts.length && type && code(type)) parts.push(code(type));
  return parts.length ? parts.join(" · ") : undefined;
}
