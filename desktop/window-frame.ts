// WHERE THE WINDOW WAS, AND HOW BIG -- remembered by the application itself, ONE PER DISPLAY.
//
// Ron, 2026-09-23: "Improve the dock start experience and I will use it exclusively." Until then the
// remembering was the launcher script's, from outside through System Events, which cost a Terminal
// window per start and gave a Dock start no position at all.
//
// And then: "right now I am in the office with an external display. In my accomodation, I am using
// the laptop display." One remembered window is wrong for a person who moves between two displays:
// the 1908 x 1365 window of the office's 2560 x 1440 screen does not fit a laptop's. So each frame is
// kept under the size of the display it was on ("2560x1440"), and a start uses the one saved for a
// display that is attached now. The first time on a display with nothing saved, the most recent frame
// is shrunk to fit that display's usable area and centered on it.
//
// The page reports (it can see its own window: screenX/screenY, outerWidth/outerHeight, and the
// screen it is on), the server writes (POST /_window), main.ts places. Only the native application
// writes: main.ts hands its server the file, the headless server does not, and the page reports only
// in the app's own window -- so a browser pane driven for testing can never move Ron's window.
//
// THE FILE: one line per display, most recent first:  "<W>x<H> <x> <y> <w> <h>"
// in top-left, y-down screen coordinates (the convention the launcher used). A line of four numbers is
// the launcher's older format and is read as a frame for an unknown display.
import { dirname, join } from "jsr:@std/path@1";

export const WINDOW_FILE = ".slicer-app-window";
/** Smaller than this is not the application window (a panel, a minimized window) and is neither
 *  saved nor restored -- the same rule the launcher learned the hard way on 2026-09-23 (53 x 48). */
export const MIN_W = 640, MIN_H = 480;
/** Displays remembered; the least recently used goes first. */
const KEEP = 8;

export interface WindowFrame { x: number; y: number; w: number; h: number }
export interface SavedFrame extends WindowFrame { display: string }   // "2560x1440", or "" when unknown
/** A display as the chooser needs it: its size, and its usable area (menu bar and Dock excluded), top-left coords. */
export interface Display { w: number; h: number; usable: WindowFrame }

/** The file beside the launcher: walk up from the gallery until one is found, else the workspace root. */
export function windowFilePath(galleryRoot: string): string {
  let dir = dirname(galleryRoot);
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    try { Deno.statSync(join(dir, WINDOW_FILE)); return join(dir, WINDOW_FILE); } catch { /* next */ }
  }
  // Contents/src/live -> the workspace root, three levels up: where the launcher always kept it.
  return join(dirname(dirname(dirname(galleryRoot))), WINDOW_FILE);
}

const displayKey = (w: number, h: number) => `${Math.round(w)}x${Math.round(h)}`;

/** One line: "<W>x<H> x y w h", or the launcher's "x y w h". Null if it is not a usable frame. */
export function parseLine(line: string): SavedFrame | null {
  const parts = line.trim().split(/\s+/);
  let display = "";
  if (parts.length === 5 && /^\d+x\d+$/.test(parts[0])) display = parts.shift()!;
  if (parts.length !== 4) return null;
  const [x, y, w, h] = parts.map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w < MIN_W || h < MIN_H) return null;
  return { display, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function parseFile(text: string): SavedFrame[] {
  return text.split("\n").map(parseLine).filter((f): f is SavedFrame => f !== null);
}

export function readWindowFrames(path: string): SavedFrame[] {
  try { return parseFile(Deno.readTextFileSync(path)); } catch { return []; }
}

/** Shrink a frame to fit an area (never grow it) and center it there. */
export function fitInto(f: WindowFrame, area: WindowFrame): WindowFrame {
  const s = Math.min(1, area.w / f.w, area.h / f.h);
  const w = Math.round(f.w * s), h = Math.round(f.h * s);
  return { x: Math.round(area.x + (area.w - w) / 2), y: Math.round(area.y + (area.h - h) / 2), w, h };
}

const inside = (f: WindowFrame, a: WindowFrame) => f.x >= a.x && f.y >= a.y && f.x + f.w <= a.x + a.w && f.y + f.h <= a.y + a.h;

/**
 * THE FRAME TO OPEN WITH, for the displays attached now. `displays[0]` is the main one (menu bar).
 *
 *  1. the most recent frame saved for a display that is here -- as it was, if it still fits that
 *     display's usable area, else shrunk and centered there;
 *  2. otherwise the most recent frame of any display, shrunk to fit the main display and centered;
 *  3. otherwise nothing: the window's own default.
 */
export function chooseFrame(saved: SavedFrame[], displays: Display[]): (WindowFrame & { why: string }) | null {
  if (!saved.length) return null;
  for (const f of saved) {
    const d = displays.find((d) => f.display && displayKey(d.w, d.h) === f.display);
    if (!d) continue;
    if (inside(f, d.usable)) return { x: f.x, y: f.y, w: f.w, h: f.h, why: `as it was on the ${f.display} display` };
    return { ...fitInto(f, d.usable), why: `the ${f.display} display's frame, fitted to its usable area` };
  }
  const main = displays[0];
  if (!main) return { x: saved[0].x, y: saved[0].y, w: saved[0].w, h: saved[0].h, why: "no display information; as saved" };
  // The launcher's old, unlabelled line: used as it is when it fits the main display, so the first
  // start after this change does not move a window that was fine.
  if (!saved[0].display && inside(saved[0], main.usable)) return { x: saved[0].x, y: saved[0].y, w: saved[0].w, h: saved[0].h, why: "the launcher's saved window, which fits this display" };
  return { ...fitInto(saved[0], main.usable), why: `nothing saved for a ${displayKey(main.w, main.h)} display yet; the last frame${saved[0].display ? ` (${saved[0].display})` : ""} fitted to it and centered` };
}

/** POST /_window "<W>x<H> x y w h" -- that display's line replaced and moved to the top. 404 without a file. */
export async function handleWindowRequest(req: Request, path: string | undefined): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/_window") return null;
  if (!path) return new Response("this server does not keep a window", { status: 404 });
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const f = parseLine(await req.text());
  if (!f || !f.display) return new Response("not a window frame on a display", { status: 400 });
  try { recordFrame(path, f); } catch (e) { return new Response(String(e), { status: 500 }); }
  return new Response(null, { status: 204 });
}

/** That display's line replaced by `f` and moved to the top (the launcher's unlabelled line goes); written only when
 *  it changes. Used by POST /_window and by the app itself (main.ts, slicerliveRememberWindow). */
export function recordFrame(path: string, f: SavedFrame): void {
  if (!f.display || f.w < MIN_W || f.h < MIN_H) return;
  let text = "";
  try { text = Deno.readTextFileSync(path); } catch { /* first time */ }
  const others = parseFile(text).filter((o) => o.display && o.display !== f.display);
  const lines = [f, ...others].slice(0, KEEP).map((o) => `${o.display} ${Math.round(o.x)} ${Math.round(o.y)} ${Math.round(o.w)} ${Math.round(o.h)}`);
  const next = lines.join("\n") + "\n";
  if (next !== text) Deno.writeTextFileSync(path, next);
}
