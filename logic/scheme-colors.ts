// A SEGMENTATION'S COLORS AGAINST THE COLOR SCHEME IN USE (logic/anatomy/palettes.ts).
//
// Ron, 2026-09-24/25: "When data arrives with its own colors, it would be good to not automatically change them. The
// user could say that they want to update, we do not want to ask this at each load" -- and, asked whether keeping them
// is the default: "yes as default so people do not need to click on it for that scenario." So a segmentation loaded
// from the database keeps the colors its file carries, a scene keeps the colors it was saved with, and a fresh result
// takes the scheme's. Where the two differ, one button -- "Use the current colors" -- brings a segmentation to the
// scheme; nothing asks.
//
// `colorScheme` on the segmentation node says where its colors came from: a version number (the scheme's), or "file"
// (kept as they arrived). It travels with a saved scene like any other field of the node.
import { coloursFor, deltaE, type LookedUp } from "./segment-colours.ts";
import { lookupStructure } from "./segment-naming.ts";
import { paletteVersion } from "./anatomy/palettes.ts";
import type { LiveScene } from "../render/livescene.ts";

export interface SchemeSegment { labelValue: number; structure?: string; name?: string; fileLabel?: string; color: number[] }

const to255 = (c: number[]): [number, number, number] => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];

/** Each segment's color under the current scheme (0-1), or undefined where the scheme knows nothing about it. The
 *  stored catalog key comes first; a name only when there is no key. The same resolver every arrival uses. */
export function schemeColors(segs: readonly SchemeSegment[]): ([number, number, number] | undefined)[] {
  const looked = segs.map((s) => (s.structure ? lookupStructure(s.structure) : null) ?? lookupStructure(s.fileLabel ?? s.name));
  const { resolved } = coloursFor(looked.map((known, i) => ({
    known: (known ?? undefined) as LookedUp | undefined, name: segs[i].name, fallback: to255(segs[i].color),
  })));
  return segs.map((_, i) => looked[i]?.rgb ? [resolved[i][0] / 255, resolved[i][1] / 255, resolved[i][2] / 255] : undefined);
}

/** Below this the two colors are the same to the eye; a file's CIELab round trip moves a color by about 1. */
const SAME = 3;

/** How many segments are drawn in a color other than the scheme's. */
export function differsFromScheme(segs: readonly SchemeSegment[]): number {
  const want = schemeColors(segs);
  return segs.reduce((n, s, i) => n + (want[i] && deltaE(to255(s.color), to255(want[i]!)) >= SAME ? 1 : 0), 0);
}

/** The segmentations in the scene whose colors differ from the scheme's, with how many segments differ. */
export function segmentationsOffScheme(live: LiveScene): { id: string; name: string; differ: number }[] {
  const out: { id: string; name: string; differ: number }[] = [];
  for (const n of live.nodes.values()) {
    if (n.type !== "segmentation" || (n as { hidden?: boolean }).hidden) continue;
    const segs = (n.segments ?? []) as SchemeSegment[];
    const differ = differsFromScheme(segs);
    if (differ) out.push({ id: n.id as string, name: String(n.name ?? n.id), differ });
  }
  return out;
}

/** "Use the current colors": the scheme's color for every segment it knows, the others unchanged. */
export function useCurrentColors(live: LiveScene, segId: string): number {
  const n = live.nodes.get(segId);
  if (!n || n.type !== "segmentation") return 0;
  const segs = (n.segments ?? []) as SchemeSegment[];
  const want = schemeColors(segs);
  let changed = 0;
  const next = segs.map((s, i) => {
    const w = want[i];
    if (!w || deltaE(to255(s.color), to255(w)) < SAME) return s;
    changed++;
    return { ...s, color: w };
  });
  if (changed) live.write({ op: "patch", id: segId, path: "#/segments", value: next });
  live.write({ op: "patch", id: segId, path: "#/colorScheme", value: paletteVersion() });
  return changed;
}
