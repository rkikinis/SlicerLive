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
// The rule, version 1:
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

export const PRIVATE_RULE_VERSION = 1;

/** Is this tag ("7FD11010") in the private pixel-data range, 7F01-7FFF odd? */
const inPixelRange = (group: number) => group >= 0x7f01 && group <= 0x7fff;

/** The top-level private elements a derived image carries from its source, and what was left out and why. */
export function privateToCarry(dict: DicomJson): { carry: DicomJson; leftOut: { tag: string; why: string }[] } {
  const carry: DicomJson = {};
  const leftOut: { tag: string; why: string }[] = [];
  for (const [tag, el] of Object.entries(dict)) {
    if (!/^[0-9A-Fa-f]{8}$/.test(tag)) continue;
    const group = parseInt(tag.slice(0, 4), 16), element = parseInt(tag.slice(4), 16);
    if (group % 2 === 0) continue;                                   // standard: the writer handles it
    if ([0x0001, 0x0003, 0x0005, 0x0007, 0xffff].includes(group)) continue;
    if (element === 0) { leftOut.push({ tag, why: "a group length, which the writer computes" }); continue; }
    if (inPixelRange(group)) { leftOut.push({ tag, why: "private image data (group 7F01-7FFF), which describes the old pixels" }); continue; }
    carry[tag.toUpperCase()] = el;
  }
  return { carry, leftOut };
}
