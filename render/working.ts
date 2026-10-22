// "WORKING…" WHERE THE PERSON LOOKS (Ron, 2026-10-17: "If you need time, you need time. But tell the user that you are
// working. If you don't then the user is left guessing what is going on. Perhaps generalize the progress bar from diffusion
// for anything more than a few seconds?"; the mockup Contents/docs/mockups/working-banner-2026-10-17.html, his answers:
// "The banner on the 3D view only", Stop "yes", a time "only when measured for that work on this Mac: yes", "Facts only").
//
// Work that may take more than a moment calls `startWork`. Nothing shows for the first SHOW_AFTER_MS, so a quick case
// never flashes; after that a banner across the top of the 3D view says what is being done and how far (a count when the
// steps can be counted, a moving bar when not), with Stop when the work can be stopped, and the usual time of that work
// when it has been measured on this Mac. It goes when `done` is called -- not before it has been up MIN_SHOWN_MS, so it
// is never a flash. Facts only: no advice, no estimate that was not measured.
//
// The banner itself is the 3D view's (live-views.ts viewBanner, the diffusion module's since SDK 14); the view hands it
// over with `setWorkBannerHost`. Several pieces of work at once: one banner each in the order they started, at most
// MAX_SHOWN, then one line "and N more", always last. A `generic` piece of work (a button's own action, app-shell.ts
// runAction) shows only while nothing more specific does: the specific one says more.

export interface WorkBanner { update(o: Partial<WorkBannerOpts>): void; close(): void }
export interface WorkBannerOpts {
  title: string;
  hint?: string;
  /** 0..1, or null for a moving bar. */
  progress?: number | null;
  actions?: { label: string; title?: string; onClick: () => void }[];
}
export type WorkBannerHost = (o: WorkBannerOpts) => WorkBanner;

export interface Work {
  /** How far: `done` of `total` (a count shown as "3 of 5 <unit>"); without a total, the one given before. */
  step(done: number, total?: number): void;
  /** Change what is said (a new stage of the same work), and what is counted in it. */
  say(title: string, unit?: string): void;
  /** No count any more (a last stage nobody counts): a moving bar. */
  uncounted(): void;
  /** Stop can no longer act (the work is past the point where it can be stopped): the button goes. */
  unstoppable(): void;
  /** Finished (or failed, or stopped): the banner goes; a finished run's time is remembered when `ok`. */
  done(ok?: boolean): void;
}

export interface WorkOptions {
  /** What is being done, in plain words: "Loading the scene", "Finding the organs". */
  title: string;
  /** What is counted: "series", "phases" -- "4 of 11 series". */
  unit?: string;
  /** The steps, when they are known at the start. */
  total?: number;
  /** For the usual time: one name per kind of work AND size ("save:seg:<voxels bucket>"). Without it, and without
   *  `usualMs`, no time is shown. */
  timeKey?: string;
  /** The usual time from the caller's own measurements (the AI panel keeps one per network and scan): said instead of
   *  this module's own record, so there is one record per kind of work. */
  usualMs?: number;
  /** The work can be stopped: the banner offers Stop and calls this. */
  stop?: () => void;
  /** What Stop says when hovered (what happens): "Stop finding the organs; nothing is changed". */
  stopTitle?: string;
  /** A button's own action (runAction): shown only while no other work is shown, after `showAfterMs`. */
  generic?: boolean;
  /** When to show it, if not SHOW_AFTER_MS. */
  showAfterMs?: number;
}

export const SHOW_AFTER_MS = 300;
/** Once shown, up at least this long: a banner on screen for 71 ms reads as a flicker (critic 2026-10-17, finding 10). */
export const MIN_SHOWN_MS = 700;
/** Two banners and "and N more" at most: four stacked covered 174 px of the 3D view (critic 2026-10-17, finding 18). */
export const MAX_SHOWN = 2;
const KEEP_RUNS = 5;

let host: WorkBannerHost | null = null;
/** The 3D view gives its banner (live-views.ts); until then, and in tests without one, nothing is shown. */
export function setWorkBannerHost(h: WorkBannerHost | null): void { host = h; render(); }

interface Running {
  o: WorkOptions; done: number; total?: number; unit?: string; title: string; stoppable: boolean;
  t0: number; shownAt: number; shown: boolean; banner?: WorkBanner; leaving?: boolean;
}
const running: Running[] = [];
let moreBanner: WorkBanner | undefined;

// THE USUAL TIME, ON THIS MAC: the median of the last KEEP_RUNS finished runs of the same kind of work. Stored in this
// browser only; nothing is an estimate (Ron: "only when measured").
const storeKey = (k: string) => `sl-work-time:${k}`;
function runs(k: string): number[] {
  try { const v = JSON.parse(localStorage.getItem(storeKey(k)) ?? "[]"); return Array.isArray(v) ? v.filter((x) => Number.isFinite(x) && x > 0) : []; } catch { return []; }
}
function remember(k: string, ms: number): void {
  try { localStorage.setItem(storeKey(k), JSON.stringify([...runs(k), ms].slice(-KEEP_RUNS))); } catch { /* not remembered */ }
}
/** The usual time of a kind of work in milliseconds, or undefined when it has never been measured here. The lower
 *  median: with two runs, the shorter (critic 2026-10-17, finding 20). */
export function usualMs(k: string | undefined): number | undefined {
  if (!k) return undefined;
  const r = runs(k).sort((a, b) => a - b);
  return r.length ? r[(r.length - 1) >> 1] : undefined;
}
/** "usually 40 s", "usually 1 min 30 s", "usually 4 min" -- a measured fact, said as one. */
export function usualText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `usually ${s} s`;
  const r = Math.round(s / 10) * 10, m = Math.floor(r / 60), sec = r % 60;
  return sec && m < 10 ? `usually ${m} min ${sec} s` : `usually ${Math.round(s / 60)} min`;
}
/** A size class for a time key: the same kind of work on a scan twice the size is a different kind (finding 6). */
export function sizeClass(voxels: number): string {
  return voxels > 0 ? `${Math.round(Math.log2(voxels) * 2)}` : "0";
}

function opts(r: Running): WorkBannerOpts {
  const known = r.total !== undefined && r.total > 0;
  const count = known ? `${Math.min(r.done, r.total!)} of ${r.total}${r.unit ? ` ${r.unit}` : ""}` : "";
  const usual = r.o.usualMs ?? usualMs(r.o.timeKey);
  const hint = [count, usual !== undefined ? usualText(usual) : ""].filter(Boolean).join(" · ") || undefined;
  return {
    title: r.title,
    progress: known ? Math.max(0, Math.min(1, r.done / r.total!)) : null,
    hint,
    actions: r.o.stop && r.stoppable ? [{ label: "Stop", title: r.o.stopTitle ?? `Stop: ${r.title.toLowerCase()}`, onClick: () => r.o.stop!() }] : [],
  };
}

/** Show what is due: the first MAX_SHOWN of the work past its delay, then "and N more", always last. The same line twice
 *  is shown once (two calls for one piece of work must not read as two); a generic piece only while nothing else shows. */
function render(): void {
  const titles = new Set<string>();
  const specific = running.some((r) => r.shown && !r.o.generic);
  const due = running.filter((r) => {
    const want = r.shown && !(r.o.generic && specific) && !titles.has(r.title);
    if (want) titles.add(r.title);
    else if (r.banner && !r.leaving) { r.banner.close(); r.banner = undefined; }
    return want;
  });
  let made = false;
  due.forEach((r, i) => {
    if (i < MAX_SHOWN && host) {
      if (r.banner) r.banner.update(opts(r));
      else { r.banner = host(opts(r)); r.shownAt = performance.now(); made = true; }
    } else if (r.banner && !r.leaving) { r.banner.close(); r.banner = undefined; }
  });
  const more = due.length - MAX_SHOWN;
  // "and N more" stays the last line: made again after any banner that came after it (critic 2026-10-17, finding 16).
  if (moreBanner && (more <= 0 || made)) { moreBanner.close(); moreBanner = undefined; }
  if (more > 0 && host) {
    const o: WorkBannerOpts = { title: `and ${more} more` };
    if (moreBanner) moreBanner.update(o); else moreBanner = host(o);
  }
}

/** Start telling the person that work is going on. Call `done()` on every way out. */
export function startWork(o: WorkOptions): Work {
  const r: Running = { o, done: 0, total: o.total, unit: o.unit, title: o.title, stoppable: true, t0: performance.now(), shownAt: 0, shown: false };
  running.push(r);
  const timer = setTimeout(() => { r.shown = true; render(); }, o.showAfterMs ?? SHOW_AFTER_MS);
  let finished = false;
  return {
    step(done, total) { r.done = done; if (total !== undefined) r.total = total; if (r.shown) render(); },
    say(title, unit) { r.title = title; if (unit !== undefined) r.unit = unit; if (r.shown) render(); },
    uncounted() { r.total = undefined; if (r.shown) render(); },
    unstoppable() { r.stoppable = false; if (r.shown) render(); },
    done(ok = true) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (ok && o.timeKey && o.usualMs === undefined) remember(o.timeKey, performance.now() - r.t0);
      const at = running.indexOf(r);
      if (at >= 0) running.splice(at, 1);
      const banner = r.banner;
      r.banner = undefined;
      // The same line still running: it takes the banner over (one line, never two for a moment).
      const heir = banner ? running.find((x) => x.shown && !x.banner && x.title === r.title) : undefined;
      if (banner && heir) { heir.banner = banner; heir.shownAt = r.shownAt; render(); return; }
      if (banner) {
        // Up long enough to be read, then gone: the rest of the stack is drawn without it at once.
        const left = MIN_SHOWN_MS - (performance.now() - r.shownAt);
        if (left > 0) { r.leaving = true; setTimeout(() => banner.close(), left); } else banner.close();
      }
      render();
    },
  };
}

/** What is going on now, for a test or a diagnosis. */
export function workingNow(): { title: string; shown: boolean; done: number; total?: number }[] {
  return running.map((r) => ({ title: r.title, shown: r.shown, done: r.done, total: r.total }));
}
(globalThis as unknown as Record<string, unknown>).__workingNow = workingNow;
