/**
 * WHERE A LOAD'S TIME GOES, counted and timed, because loading is the function Ron uses most.
 *
 * Ron, 2026-09-22: "loading is a very important function. Fast and correct loading is critical.
 * Please instrument the scene loading process so you can analyze where time is spent. Are there
 * duplications or inefficiencies?"
 *
 * TWO NUMBERS PER PHASE, AND THE SECOND IS THE POINT. A total tells you what is slow; a COUNT tells
 * you what is done twice. The duplication this file was written to find is exactly of that kind --
 * a phase whose count is 8 where there are four segmentations.
 *
 * Wall-clock spans overlap (the surfaces of one segmentation load while the next decodes), so the
 * phases do not add up to the total and must not be presented as if they did. The report says both:
 * each phase's own time, and the elapsed time of the whole load.
 */
export interface Phase { name: string; ms: number; n: number; longest: number }

let t0 = 0;
let running: string | null = null;
/** When anything last happened. A load is over when the application stops doing things. */
let lastActivity = 0;
const phases = new Map<string, Phase>();
const marks: { at: number; what: string }[] = [];

/**
 * HOW LONG THE PAGE ITSELF WAS BLOCKED, measured, not inferred.
 *
 * By 2026-09-23 the load's remaining waits were all of one kind: small steps (a reply the server had
 * sent in a millisecond, a worker's finished result) taking seconds because the page's thread was
 * busy. The phases time the waiting; this times the blocking. A timer that should fire every 50 ms
 * and how late it runs is how long the thread was held.
 *
 * NOT MEANINGFUL IN A HIDDEN PAGE: browsers slow a hidden page's timers to about once a second, which
 * reads as one-second "stalls" that are nothing of the kind (the browser pane, 2026-09-23). The
 * record says whether the page was hidden, and the line says so.
 */
let busyTimer: ReturnType<typeof setInterval> | null = null;
let busyLast = 0, busyTotal = 0, busyHidden = false;
const busyStalls: { at: number; ms: number }[] = [];
function startBusyMonitor(): void {
  if (busyTimer !== null) clearInterval(busyTimer);
  busyLast = performance.now(); busyTotal = 0; busyStalls.length = 0;
  busyHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  busyTimer = setInterval(() => {
    const now = performance.now(), late = now - busyLast - 50;
    busyLast = now;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") busyHidden = true;
    if (late >= 200) { busyTotal += late; busyStalls.push({ at: now - late - t0, ms: late }); }
  }, 50);
}
function stopBusyMonitor(): { totalMs: number; stalls: { at: number; ms: number }[]; hidden: boolean } {
  if (busyTimer !== null) { clearInterval(busyTimer); busyTimer = null; }
  return { totalMs: busyTotal, stalls: [...busyStalls].sort((a, b) => b.ms - a.ms), hidden: busyHidden };
}

/** Begin a run; everything recorded after this belongs to it. */
export function startLoadProfile(what: string): void {
  t0 = performance.now();
  lastActivity = t0;
  running = what;
  phases.clear();
  marks.length = 0;
  startBusyMonitor();
}

/** Note a moment (a series arriving, a pass finishing), at its offset from the start. */
export function mark(what: string): void {
  if (!running) return;
  lastActivity = performance.now();
  marks.push({ at: lastActivity - t0, what });
}

/** Time one phase. Re-entrant and additive: the same name from four series adds up, and counts 4. */
export async function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!running) return await fn();
  const t = performance.now();
  try {
    return await fn();
  } finally {
    lastActivity = performance.now();
    const ms = lastActivity - t;
    const p = phases.get(name) ?? { name, ms: 0, n: 0, longest: 0 };
    p.ms += ms; p.n++; p.longest = Math.max(p.longest, ms);
    phases.set(name, p);
  }
}

/** A phase somebody else timed: added as if this file had timed it. */
export function noteMs(name: string, ms: number): void {
  if (!running) return;
  lastActivity = performance.now();
  const p = phases.get(name) ?? { name, ms: 0, n: 0, longest: 0 };
  p.ms += ms; p.n++; p.longest = Math.max(p.longest, ms);
  phases.set(name, p);
}

/** The same, for work that is not a promise. */
export function spanSync<T>(name: string, fn: () => T): T {
  if (!running) return fn();
  const t = performance.now();
  try {
    return fn();
  } finally {
    lastActivity = performance.now();
    const ms = lastActivity - t;
    const p = phases.get(name) ?? { name, ms: 0, n: 0, longest: 0 };
    p.ms += ms; p.n++; p.longest = Math.max(p.longest, ms);
    phases.set(name, p);
  }
}

export interface LoadProfile {
  what: string;
  elapsedMs: number;
  phases: Phase[];
  marks: { at: number; what: string   /** How long the page itself could not respond: stalls of 200 ms or more, at their offsets. */
  busy?: { totalMs: number; stalls: { at: number; ms: number }[]; hidden: boolean };
}[];
  /** Phases done more often than the number of series would explain — the duplication check. */
  suspects: string[];
}

/** Close the run and report it. `expected` is how many series the load was for. */
export function endLoadProfile(expected: number): LoadProfile | null {
  if (!running) return null;
  const elapsedMs = performance.now() - t0;
  // A SNAPSHOT, not the live objects. `phases` holds these until the next run starts, and a span
  // that began inside the run and finishes after it would go on changing the numbers the report
  // already handed out (critic, 2026-09-22, finding 11).
  const list = [...phases.values()].map((p) => ({ ...p })).sort((a, b) => b.ms - a.ms);
  // A phase that runs more than once per series is doing something twice. Stated as a suspicion,
  // not a verdict: some phases legitimately run per FRAME or per structure.
  const suspects = list.filter((p) => expected > 0 && p.n > expected && p.ms > 200).map((p) => `${p.name} ran ${p.n}× for ${expected} series`);
  const out: LoadProfile = { what: running, elapsedMs, phases: list, marks: [...marks], suspects, busy: stopBusyMonitor() };
  running = null;
  return out;
}

/**
 * WAIT FOR THE PICTURE TO STAND STILL, then close the run.
 *
 * Ron: "when I say loading I mean the entire process until I have a stable display." The data being
 * applied is not that moment -- the surfaces of the last segmentation are still being read and
 * pushed to the GPU after it. So the run ends when nothing has happened for `quietMs`, and the
 * elapsed time is measured to the last thing that did happen, not to the timeout.
 */
export async function endLoadProfileWhenQuiet(expected: number, quietMs = 1500, capMs = 120000): Promise<LoadProfile | null> {
  if (!running) return null;
  const start = performance.now();
  while (performance.now() - lastActivity < quietMs && performance.now() - start < capMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const settled = lastActivity;                  // the last real event, not the quiet period after it
  const p = endLoadProfile(expected);
  if (p) p.elapsedMs = settled - t0;
  return p;
}

/**
 * EVERY PART OF 20 ms OR MORE, for the session log only. The line below shows the eight largest,
 * which is right for the status bar and cut off the ingest's own parts on 2026-09-23, the one load
 * where they were the question. The log has room; the status bar does not.
 */
export function describeProfilePhases(p: LoadProfile): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return `load profile, every part — ${p.what}: ` + p.phases.filter((x) => x.ms >= 20)
    .map((x) => `${x.name} ${s(x.ms)}${x.n > 1 ? ` (${x.n}×, worst ${s(x.longest)})` : ""}`).join(" · ");
}

/** One line for the session log, and the table for anyone asking. */
export function describeProfile(p: LoadProfile): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const top = p.phases.slice(0, 8).map((x) => `${x.name} ${s(x.ms)}${x.n > 1 ? ` (${x.n}×, worst ${s(x.longest)})` : ""}`).join(" · ");
  const when = p.marks.map((m) => `${m.what} at ${s(m.at)}`).join(", ");
  const b = p.busy;
  const busy = !b ? "" : b.hidden
    ? " · page blocked: not measurable (the page was hidden)"
    : ` · page blocked ${s(b.totalMs)}${b.stalls.length ? ` (longest ${b.stalls.slice(0, 3).map((x) => `${s(x.ms)} at ${s(x.at)}`).join(", ")})` : ""}`;
  return `load profile — ${p.what}: ${s(p.elapsedMs)} in all${busy} · ${top}${when ? ` · ${when}` : ""}${p.suspects.length ? ` · DONE TWICE? ${p.suspects.join("; ")}` : ""}`;
}
