// WHICH DATABASE IS IN USE: ONE RULE, IN ONE PLACE (critic 2026-11-07, Load / Save by task, findings 1-3: the face, the Scene
// menu, the scene save and the browser each picked "the one" by a rule of their own, so a save could land in a database no
// line on screen named).
//
// The rule is the critic's of 2026-10-26 (remote database, finding 5): THE DEFAULT, OR NOTHING. A default that cannot be
// reached (a disk unplugged, a Mac asleep) is not silently replaced by another database; with no default set at all, the
// first one that can be reached.

export interface DbLike { id: string; current?: boolean; exists?: boolean }

export function dbInUse<T extends DbLike>(list: readonly T[] | null | undefined): T | undefined {
  const all = list ?? [];
  const def = all.find((d) => d.current);
  return def ? (def.exists ? def : undefined) : all.find((d) => d.exists);
}
