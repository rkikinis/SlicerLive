// When the published colors cannot be told apart, use ones that can.
//
// Ron, looking at ts:abdominal_muscles: "I have no way to visually assess the muscles as abdominal
// muscle all have the same color."
//
// He is right and the cause is upstream: TotalSegmentator's terminology table colors by TISSUE, so
// all eleven abdominal muscles land within a narrow brown (155-200, 78-120, 65-100). Meanwhile the
// file the segmenter wrote carries 22 auto-generated colors that are well spread. We were
// discarding those in favor of the table, which is right for a liver and wrong for a muscle.
//
// THE PUBLISHED COLOR IS KEPT WHEREVER IT DISTINGUISHES. Ron's own instruction about FreeSurfer --
// "Use the colors and organization as presented by the freesurfer people" -- is why this is a repair
// and not a repaint: a published color carries meaning (FreeSurfer's hues ARE the convention), and
// replacing them all because some collide would throw that away.
//
// A LEFT/RIGHT PAIR SHARING A COLOR IS NOT A COLLISION. That is one structure seen twice, and the
// tree already says which side is which. Only two DIFFERENT structures wearing indistinguishable
// colors are a problem, so the comparison is between types.
import { rgbToDicomLab } from "./export-dicom-seg.ts";
import { oxygenationOf } from "./anatomy/vessel-colour.ts";
import { paletteRgb } from "./anatomy/palettes.ts";

/** CIELab, 0-100 / -128..127, from 0-255 sRGB — decoded back out of the DICOM encoding. */
function lab(rgb: [number, number, number]): [number, number, number] {
  const [L, a, b] = rgbToDicomLab([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]);
  return [(L / 0xFFFF) * 100, (a / 0xFFFF) * 255 - 128, (b / 0xFFFF) * 255 - 128];
}

/**
 * CIE76 color difference. Crude next to CIEDE2000 and sufficient here: the question is "could a
 * person tell these two apart on a screen", and the answer at ΔE < 10 is reliably no.
 */
export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * Below this, two colors read as the same color at a glance.
 *
 * MEASURED AGAINST BOTH REAL CASES rather than chosen. At 12 every one of Ron's eleven abdominal
 * muscle browns is caught -- and so are 22 of ts:total's 55 distinct colors, which repainted the
 * liver, the spleen and the bowel and drew "total is not rendered correctly." At 9 the muscles are
 * still all caught and ts:total drops to 8. Below 5 a muscle pair starts to escape.
 *
 * The number therefore sits where the two cases separate: tight enough to catch a palette that has
 * given up, loose enough to leave one that has not.
 */
export const SAME_COLOUR = 9;

export interface ColourCandidate {
  /** The structure this segment IS — a left/right pair shares one, and may share a color. */
  type?: string;
  /** The color the catalog publishes, 0-255, if it publishes one. */
  published?: [number, number, number];
  /** The color the segmenter's own file carries, 0-255. A starting point, not a guarantee. */
  fallback: [number, number, number];
  /**
   * This color MEANS something and must not be moved.
   *
   * The vessels are the case this exists for, and they broke without it. `vessel-colour.ts` gives
   * every vessel a shade of red or blue by oxygenation, deliberately WITHIN a narrow band -- Ron:
   * "I would like all the vessels to be shades of blue and red ... They should not be identical
   * individually" -- and the closest pair sits at ΔE 4.9. This function's threshold for
   * indistinguishable is 9. So it judged every vessel a collision, correctly by its own rule, and
   * repainted them at arbitrary hues: Ron, looking at the tree, "subclavian and common carotid
   * escaped your attention and are green", with the iliac artery orange and the iliac vein magenta.
   *
   * A pinned color is not a suggestion the segmenter published; it is derived from what the
   * structure IS, and an arbitrary hue in its place destroys the one thing it was carrying. So
   * pinned entries never move. Anything unpinned that collides with them still does.
   */
  pinned?: boolean;
}

/**
 * A color that is far from every color already in use.
 *
 * The file's own colors were the first choice and are not good enough: on Ron's 22 abdominal
 * muscles they left two structures 8.6 apart, below the threshold this module exists to enforce.
 * They are auto-generated to look varied, which is not the same as being separable.
 *
 * Hues walk by the golden angle, which spreads any number of samples about as evenly as a sequence
 * can, and the walk simply continues until the result clears everything already assigned. Saturation
 * and lightness are held where a color reads well on both the dark 3D background and a bright
 * slice.
 */
function distinctFrom(used: readonly [number, number, number][], seed: number): [number, number, number] {
  const hsl = (h: number): [number, number, number] => {
    const s = 0.62, l = 0.55;
    const k = (n: number) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  };
  const GOLDEN = 0.618033988749895;
  let best = hsl((seed * GOLDEN) % 1), bestGap = -1;
  for (let i = 0; i < 64; i++) {
    const c = hsl(((seed + i) * GOLDEN) % 1);
    const gap = used.length ? Math.min(...used.map((u) => deltaE(c, u))) : Infinity;
    if (gap >= SAME_COLOUR * 1.5) return c;
    if (gap > bestGap) { bestGap = gap; best = c; }
  }
  return best;                       // as far apart as 64 tries could get: better than a collision
}

/**
 * The color each segment should be drawn in.
 *
 * Published colors are kept unless two DIFFERENT structures would be indistinguishable; those fall
 * back to the file's own, which the segmenter generated to be distinct. A segment with no published
 * color keeps the file's from the start.
 */
export function resolveColours(candidates: readonly ColourCandidate[]): [number, number, number][] {
  const out: [number, number, number][] = candidates.map((c) => c.published ?? c.fallback);
  // Which types collide with a DIFFERENT type. Compared once per type rather than per segment, so a
  // left/right pair is one participant.
  const byType = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    if (!c.published) return;
    const k = c.type ?? `#${i}`;
    (byType.get(k) ?? byType.set(k, []).get(k)!).push(i);
  });
  const types = [...byType.entries()];
  // WHO COLLIDES WITH WHOM, as clusters rather than as a flat set.
  //
  // Colliding colors chain: A is close to B, B to C, and A to C not at all. Treating every
  // participant as needing to move repainted 62 of ts:total's 117 structures -- the liver, the
  // spleen, the pancreas, the bowel -- because TotalSegmentator's liver brown IS within a glance of
  // its gluteus maximus. Ron, seeing it: "total is not rendered correctly."
  //
  // ONE MEMBER OF EACH CLUSTER KEEPS ITS COLOR: the first in the result's own order, which is the
  // segmenter's label order. So the liver keeps liver-brown and the gluteal muscles beside it move,
  // and among Ron's eleven abdominal muscles one keeps the published brown and ten are separated.
  // The minimum repaint that leaves nothing indistinguishable.
  const root = new Map(types.map(([t]) => [t, t]));
  const find = (a: string): string => {
    const p = root.get(a)!;
    if (p === a) return a;
    const r = find(p);
    root.set(a, r);
    return r;
  };
  for (let i = 0; i < types.length; i++) {
    for (let j = i + 1; j < types.length; j++) {
      const a = candidates[types[i][1][0]].published!, b = candidates[types[j][1][0]].published!;
      if (deltaE(a, b) < SAME_COLOUR) root.set(find(types[i][0]), find(types[j][0]));
    }
  }
  // WHICH TYPES ARE PINNED, and therefore never move whatever they collide with.
  const pinnedType = new Set(types.filter(([, idxs]) => idxs.some((i) => candidates[i].pinned)).map(([t]) => t));
  const keeper = new Map<string, string>();          // cluster -> the type that keeps its color
  // A pinned type keeps its color by definition, so it is preferred as the cluster's keeper; the
  // first in the segmenter's own order wins among equals, as before.
  for (const [t] of types) if (pinnedType.has(t)) { const r = find(t); if (!keeper.has(r)) keeper.set(r, t); }
  for (const [t] of types) { const r = find(t); if (!keeper.has(r)) keeper.set(r, t); }
  const collides = new Set(
    types.map(([t]) => t).filter((t) => !pinnedType.has(t) && keeper.get(find(t)) !== t),
  );
  // The colors that are STAYING, which the new ones have to clear as well as clearing each other.
  const used: [number, number, number][] = [];
  for (const [t, idxs] of types) if (!collides.has(t)) used.push(candidates[idxs[0]].published!);
  // Every pinned color is staying, including several from one cluster, so a moved color must clear
  // all of them and not only the one that happened to be its cluster's keeper.
  for (const [t, idxs] of types) if (pinnedType.has(t)) used.push(candidates[idxs[0]].published!);
  candidates.forEach((c, i) => { if (!c.published) used.push(c.fallback); });
  let seed = 0;
  for (const [t, idxs] of types) {
    if (!collides.has(t)) continue;
    // The whole type moves together, so a pair stays a pair: left and right of one muscle keep
    // looking like one structure, which is what the tree says they are.
    const c = distinctFrom(used, seed++);
    used.push(c);
    for (const i of idxs) out[i] = c;
  }
  return out;
}

/** How many segments had to be moved off their published color — for saying so in the panel. */
export function recolouredCount(
  candidates: readonly ColourCandidate[],
  resolved: readonly [number, number, number][],
): number {
  return candidates.reduce(
    (n, c, i) => n + (c.published && resolved[i].join() !== c.published.join() ? 1 : 0),
    0,
  );
}

/** What a catalog lookup gives the resolver: the type (a pair shares one), the published color, the key. */
export interface LookedUp { key?: string; name?: string; type?: string; rgb?: [number, number, number] }

/**
 * THE ONE PLACE, for every entry point. A fresh result from the server and a SEG read back from
 * the database must come out in the same colors, and until 2026-09-21 they did not: the fresh
 * path resolved collisions and the load path took the catalog's published color as it was --
 * so ts:abdominal_muscles was 22 distinct colors when it landed and eleven near-identical browns
 * once saved and reopened. Ron, looking at the reopened one: "there is a distinction, but it is
 * very subtle." Both paths now build their candidates here.
 *
 * `fallback` is 0-255: the segmenter's own color on a fresh run, the file's color on a load.
 */
export function coloursFor(
  items: readonly { known?: LookedUp; name?: string; fallback: [number, number, number] }[],
): { resolved: [number, number, number][]; moved: number } {
  const candidates: ColourCandidate[] = items.map(({ known, name, fallback }) => ({
    type: known?.type ?? known?.name ?? name,
    published: known?.rgb,
    // A color from a versioned scheme (v2 on) is pinned as well: its neighbors are already told apart by shade, and
    // the resolver's threshold would otherwise repaint a rib cage in arbitrary hues.
    pinned: known?.key ? !!oxygenationOf(known.key) || !!paletteRgb(known.key) : false,
    fallback,
  }));
  const resolved = resolveColours(candidates);
  return { resolved, moved: recolouredCount(candidates, resolved) };
}
