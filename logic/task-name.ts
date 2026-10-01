// A haversack task name, taken apart ONCE.
//
// `ts:total`, `moose:clin_ct_organs`, `fastsurfer:brain` -- an ecosystem, a colon, a name. Mike
// Halle, 2026-09-12, announcing a breaking change for the same day: "Too many different ecosystems
// have the same task name, for instance 'organs' or 'vertebrae'. 'total' will be in TS v2 and v3.
// You'll need to provide a prefix all the time, rather than optionally. ... 'total' will be
// 'ts.v2:total'." So the prefix carries a version now, and every place that read the part before
// the colon as the ecosystem (the license, the paper, FreeSurfer's numbering, the presentation
// preset, the network browser's family facet) goes through here, where `.v2` is taken off once.
//
// Nothing here guesses a missing prefix: haversack resolves bare names, this module does not.

export interface TaskName {
  /** `ts`, `moose`, `fastsurfer` -- the project, without its version. "" for a bare name. */
  ecosystem: string;
  /** `v2`, `v3` -- what followed the dot in the prefix, or "". */
  version: string;
  /** `total`, `clin_ct_organs` -- the part after the colon; the whole string for a bare name. */
  name: string;
}

export function parseTask(task: string): TaskName {
  const i = task.indexOf(":");
  if (i < 0) return { ecosystem: "", version: "", name: task };
  const prefix = task.slice(0, i), name = task.slice(i + 1);
  const dot = prefix.indexOf(".");
  return dot < 0
    ? { ecosystem: prefix, version: "", name }
    : { ecosystem: prefix.slice(0, dot), version: prefix.slice(dot + 1), name };
}

/** The project a task belongs to: `ts` for both `ts:total` and `ts.v2:total`; the bare name when there is no prefix. */
export function ecosystemOf(task: string): string {
  const p = parseTask(task);
  return p.ecosystem || p.name;
}

/** `ts:total` for `ts.v2:total` -- the name with the version taken off, for matching across the change. */
export function unversioned(task: string): string {
  const p = parseTask(task);
  return p.ecosystem ? `${p.ecosystem}:${p.name}` : p.name;
}

/** The same task, whichever version of its ecosystem the two names carry. */
export function sameTask(a: string, b: string): boolean {
  return a === b || unversioned(a) === unversioned(b);
}

/**
 * The catalog's name for a remembered task: the exact name when it is still offered, else the
 * one that matches with the version taken off (`ts:total` remembered, `ts.v2:total` offered), else
 * "" -- the caller says the network is no longer offered rather than running a guess.
 */
export function resolveTask(remembered: string, offered: readonly string[]): string {
  if (!remembered) return "";
  if (offered.includes(remembered)) return remembered;
  const want = unversioned(remembered);
  return offered.find((t) => unversioned(t) === want) ?? "";
}
