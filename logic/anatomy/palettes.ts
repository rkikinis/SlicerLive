// THE COLOR SCHEMES, BY VERSION. Ron, 2026-09-25: "All of these settings should be versioned. That makes it easier to
// get back to a particular state. Our current colors are v1 and Mike's scheme is v2 and so on."
//
// v1 is what Albula did until 2026-09-25: the catalog's published color, the oxygenation rule for vessels and heart
// chambers (vessel-colour.ts), the asserted overrides (overrides.ts), and the resolver that moves colors a viewer
// cannot tell apart (segment-colours.ts). It has no table of its own -- it IS those rules -- so choosing v1 simply
// turns every later table off.
//
// v2 is Michael Halle's tissue palettes (illustration style, 2026-09-24): each structure is a tissue, each tissue a
// color, neighbors of one tissue told apart by shade. Ron: "Let's go with his. He has a better eye for this kind of
// things." With Albula's corrections for structures that touch (Contents/tools/palette-v2: larger steps, a ladder
// of its own for pale tissues, ribs warmer than vertebrae, a few ladder moves), measured on 97 touching pairs: 54
// below the "cannot tell apart" line before, 3 just under it (8.4-8.5) after. A structure v2 does not know keeps its
// v1 color. A new version is a new table and a new entry below; the old ones stay, so any state can be got back.
//
// v3 is v2 with the spine in v1's colors (Ron, 2026-09-26, for a picture: "temporarily the spine in the colors that we
// had before adopting Mikes scheme"). The spine is the vertebral column as TA2 has it -- every vertebra, the sacrum, the
// coccyx -- and the intervertebral discs; v3 leaves them out of v2's table, so v1's rules color them, and keeps v2's
// finishes for everything. A variant for a picture, not a successor: it is not the default (`forPictures`).
import v2 from "./palette-v2.json" with { type: "json" };

export interface PaletteVersion { version: number; name: string; date: string; forPictures?: boolean }

export const PALETTES: readonly PaletteVersion[] = [
  { version: 1, name: "Albula's first colors (catalog, oxygenation, separated)", date: "2026-09-24" },
  { version: v2.version, name: v2.name, date: v2.date },
  { version: 3, name: "v2 with the spine in v1's colors (for a picture)", date: "2026-09-26", forPictures: true },
];

/** The newest scheme meant for everyday use: the default. A variant for pictures is never it. */
export const LATEST_PALETTE = PALETTES.filter((p) => !p.forPictures).at(-1)!.version;

/** The spine as v3 takes it back to v1: vertebrae (either spelling), sacrum, coccyx, intervertebral discs. */
const SPINE = /^(vertebra|vertebrae)(_|$)|^(sacrum|coccyx|intervertebral_discs?)$/;
const withoutSpine = <T>(t: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(t).filter(([k]) => !SPINE.test(k)));

const TABLES: Record<number, Record<string, number[]>> = {
  [v2.version]: v2.colors as Record<string, number[]>,
  3: withoutSpine(v2.colors as Record<string, number[]>),
};

let current = LATEST_PALETTE;

/** The version new colors come from. Set from Settings at start; a test may set it. */
export function paletteVersion(): number { return current; }
export function setPaletteVersion(v: number): void {
  const was = current;
  current = PALETTES.some((p) => p.version === v) ? v : LATEST_PALETTE;
  // Panels that show the scheme ("Use the current colors") redraw when it changes (Ron, 2026-09-26, choosing v3 in
  // Settings: "Nothing happens" -- the Segmentations panel kept its old view until something else redrew it).
  if (current !== was) globalThis.dispatchEvent?.(new Event("sl-palette-changed"));
}

/** The same structure under the names the tables use: our catalog says vertebra_T5 / clavicle_left where
 *  TotalSegmentator's class map (and so Mike's table) says vertebrae_T5 / clavicula_left. */
function spellings(key: string): string[] {
  return [key, key.replace(/^vertebra_/, "vertebrae_"), key.replace(/^clavicle_/, "clavicula_")];
}

/** The color a palette version gives a structure, 0-255, or undefined where it gives none (v1: always; the rules
 *  in segment-naming.ts decide). */
export function paletteRgb(key: string | undefined, version = current): [number, number, number] | undefined {
  if (!key) return undefined;
  const t = TABLES[version];
  if (!t) return undefined;
  for (const k of spellings(key)) {
    const c = t[k];
    if (c) return [c[0], c[1], c[2]];
  }
  return undefined;
}

/**
 * A STRUCTURE'S FINISH: how its surface takes the light, from Michael Halle's tissue palettes (materials.yaml ›
 * finishes, 2026-09-24). Mike, 2026-09-25: "consider using a physically based rendering shader and the shader styles
 * that were chosen by Claude for the palette." Ron: "Mikes shading yes, if there is no significant slowdown."
 * Physically based: roughness (0 mirror, 1 chalk), the index of refraction (how much a surface reflects head-on), a
 * clear coat (the wet film on living tissue) with its own roughness, sheen (the satin of muscle), subsurface (light
 * that goes in and comes out softened), metallic (implants). Undefined where the version has no finishes (v1) or does
 * not name the structure.
 */
export interface Finish { name: string; roughness: number; ior: number; coat: number; coatRoughness: number; sheen: number; subsurface: number; metallic: number }
const FINISHES: Record<number, { finish: Record<string, string>; finishes: Record<string, Record<string, number>> }> = {
  [v2.version]: { finish: v2.finish as Record<string, string>, finishes: v2.finishes as Record<string, Record<string, number>> },
  3: { finish: v2.finish as Record<string, string>, finishes: v2.finishes as Record<string, Record<string, number>> },
};
export function paletteFinish(key: string | undefined, version = current): Finish | undefined {
  if (!key) return undefined;
  const t = FINISHES[version];
  if (!t) return undefined;
  for (const k of spellings(key)) {
    const name = t.finish[k];
    const p = name ? t.finishes[name] : undefined;
    if (p) return { name, roughness: p.roughness ?? 0.5, ior: p.ior ?? 1.4, coat: p.coat ?? 0, coatRoughness: p.coat_roughness ?? 0.1, sheen: p.sheen ?? 0, subsurface: p.subsurface ?? 0, metallic: p.metallic ?? 0 };
  }
  return undefined;
}
