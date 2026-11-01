// WHICH OF A SOURCE FILE'S PRIVATE ATTRIBUTES A DERIVED IMAGE CARRIES -- one rule, versioned, in its own module
// (CLAUDE.md, "modular and versioned").
//
// Ron, 2026-09-25: "Private fields are very important as vendors often use them to store real information. For
// instance, Philips had an identical DMRI header, and the actual orientation, and etc of the acquisitions were stored
// in private fields without documentation." And 2026-09-26, on the critic's finding that the image writer dropped all
// of them (233 -> 0 on a public Philips file; qa/2026-09-26-dcmjs-pr-tests.md, finding 3): "agree" -- copy them as
// they are, drop only a vendor's private image data (a thumbnail, a private pixel block) that no longer matches the
// new pixels.
//
// RULE 2, SINCE 2026-10-29 (Ron: "q2 yes", on Michael Halle's reply to the data-architecture mail: "Once we transform the
// dicom file into a derived format, I would argue that carrying over many of those original headers is actually
// misleading. What we really want to do is have a strong provenance record so that we know where that data came from").
// A derived image carries NO private attribute of its source: what it was made from is said by its references
// (SourceImageSequence) and its made-from record, and the source keeps every attribute as received in the archive.
// Rule 1 stays below for reading what earlier objects carry (CLAUDE.md, "modular and versioned").
//
// The rule, version 1 (2026-09-26 to 2026-10-28):
//   - every top-level private element is carried, byte for byte as the source had it (a private element is one whose
//     group is odd: PS3.5 §7.8.1), with its private creator;
//   - EXCEPT the private groups in the pixel-data range, 7F01-7FFF (odd). PS3.5 §7.6 reserves group 7FE0 for the
//     standard's pixel data and the 7Fxx groups around it for pixel data of the old "overlay/pixel" style; vendors put
//     private pixel blocks and thumbnails there (GE's archive thumbnail, private creator "GEIIS", is group 7FD1). Those
//     describe the OLD pixels and are left out;
//   - group-length elements (gggg,0000) are left out: the writer computes lengths, a copied one would be stale;
//   - groups 0001, 0003, 0005, 0007 and FFFF are not private groups (PS3.5 §7.8.1) and are never copied.
// Private elements NESTED inside standard sequences are not handled here (the naturalized copy keeps some, by number;
// dcmjs #388). Top level is what the critic measured and what vendors mostly use.
import type { DicomJson } from "./dicom-io.ts";

export const PRIVATE_RULE_VERSION = 2;

/** Is this tag ("7FD11010") in the private pixel-data range, 7F01-7FFF odd? */
const inPixelRange = (group: number) => group >= 0x7f01 && group <= 0x7fff;

/** The top-level private elements a derived image carries from its source, and what was left out and why, by the rule
 *  of that version (today's by default). */
export type LeftOutKind = "group-length" | "image-data" | "rule-2";
export function privateToCarry(dict: DicomJson, version: number = PRIVATE_RULE_VERSION): { carry: DicomJson; leftOut: { tag: string; why: string; kind: LeftOutKind }[] } {
  const carry: DicomJson = {};
  const leftOut: { tag: string; why: string; kind: LeftOutKind }[] = [];
  for (const [tag, el] of Object.entries(dict)) {
    if (!/^[0-9A-Fa-f]{8}$/.test(tag)) continue;
    const group = parseInt(tag.slice(0, 4), 16), element = parseInt(tag.slice(4), 16);
    if (group % 2 === 0) continue;                                   // standard: the writer handles it
    if ([0x0001, 0x0003, 0x0005, 0x0007, 0xffff].includes(group)) continue;
    if (version >= 2) { leftOut.push({ tag, kind: "rule-2", why: "rule 2: a derived image carries no private attribute; the source keeps it in the archive" }); continue; }
    if (element === 0) { leftOut.push({ tag, kind: "group-length", why: "a group length, which the writer computes" }); continue; }
    if (inPixelRange(group)) { leftOut.push({ tag, kind: "image-data", why: "private image data (group 7F01-7FFF), which describes the old pixels" }); continue; }
    carry[tag.toUpperCase()] = el;
  }
  return { carry, leftOut };
}

/** RULE 2, NESTED TOO (the critic, 2026-10-29, private rule 2 finding 4): private elements inside the standard sequences
 *  of a naturalized dataset (kept there by number: dcmjs #388) are removed, at any depth. Returns the tags removed. */
export function stripNestedPrivate(ds: Record<string, unknown>): string[] {
  const removed: string[] = [];
  const isPrivate = (k: string) => {
    const m = /^\(?([0-9A-Fa-f]{4}),?([0-9A-Fa-f]{4})\)?$/.exec(k);
    if (!m) return false;
    const group = parseInt(m[1], 16);
    return group % 2 === 1 && ![0x0001, 0x0003, 0x0005, 0x0007, 0xffff].includes(group);
  };
  const walk = (o: unknown, depth: number) => {
    if (Array.isArray(o)) { for (const x of o) walk(x, depth); return; }
    if (!o || typeof o !== "object" || o instanceof ArrayBuffer || ArrayBuffer.isView(o)) return;
    for (const k of Object.keys(o as Record<string, unknown>)) {
      if (k === "_vrMap" || k === "_meta") continue;
      if (depth > 0 && isPrivate(k)) { removed.push(k.replace(/[(),]/g, "").toUpperCase()); delete (o as Record<string, unknown>)[k]; continue; }
      walk((o as Record<string, unknown>)[k], depth + 1);
    }
  };
  walk(ds, 0);
  return removed;
}
