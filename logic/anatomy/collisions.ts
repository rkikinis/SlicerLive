// Which labels would draw the same row — computed from the catalogs, so it cannot go stale.
//
// This is the input to the curation queue (relations.ts). It exists as a function rather than a
// note in a document because the question "what needs curating?" has to be answerable after
// somebody adds a network, not only on the day it was first asked.
import fsCatalogue from "./freesurfer.json" with { type: "json" };
import tsCatalogue from "./totalsegmentator.json" with { type: "json" };
import { OVERRIDES } from "./overrides.ts";

export interface Collision {
  /** The display name they share. */
  name: string;
  /** The catalog keys that produce it, in catalog order. */
  keys: string[];
  /** Whether the keys come from more than one catalog -- already disambiguated by the key itself. */
  crossCatalogue: boolean;
}

type Entry = { name: string };

/**
 * Every display name carried by more than one label.
 *
 * Case-insensitive, because two rows differing only in case are two rows a person reads as one.
 */
/**
 * The name a row will actually SHOW — the override where there is one.
 *
 * Comparing the raw catalog names made the queue blind to the collisions we create ourselves. Ron
 * asserted that TotalSegmentator's `autochthon` is the erector spinae (overrides.ts, 2026-09-03),
 * which gave it the same display name AND the same SNOMED code as ts:abdominal_muscles'
 * `erector_spinae` -- one muscle under two labels, and the queue said nothing because the two
 * catalog entries still read "Deep muscle of back" and "Erector spinae muscle".
 */
const display = (key: string, e: Entry) => OVERRIDES[key]?.name ?? e.name;

export function collisions(): Collision[] {
  const ts = (tsCatalogue as { structures: Record<string, Entry> }).structures;
  const fs = (fsCatalogue as { structures: Record<string, Entry> }).structures;
  const seen = new Map<string, { keys: string[]; sources: Set<string> }>();
  for (const [src, cat] of [["ts", ts], ["fs", fs]] as const) {
    for (const [key, v] of Object.entries(cat)) {
      const k = display(key, v).trim().toLowerCase();
      const e = seen.get(k) ?? { keys: [], sources: new Set<string>() };
      e.keys.push(key);
      e.sources.add(src);
      seen.set(k, e);
    }
  }
  const named = (key: string) => display(key, ts[key] ?? fs[key]);
  return [...seen.entries()]
    .filter(([, e]) => e.keys.length > 1)
    .map(([, e]) => ({ name: named(e.keys[0]), keys: e.keys, crossCatalogue: e.sources.size > 1 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
