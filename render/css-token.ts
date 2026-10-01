/**
 * Theme tokens for code that draws on a canvas.
 *
 * Every color in the application is a custom property in render/demos/theme.css -- ONE place, so
 * a palette change is one file. CSS reads them with var(); a canvas cannot, so this reads the
 * computed value off the document root once and caches it (the theme does not change while the
 * page lives). The fallback is used only when there is no document or the token is not defined,
 * which is the same value theme.css carries, so a canvas and a stylesheet never disagree.
 */
const cache = new Map<string, string>();

export function cssToken(name: string, fallback: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let v = "";
  try {
    if (typeof document !== "undefined") v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch { /* no DOM: a worker or a test */ }
  if (!v) return fallback;                       // not cached: the stylesheet may still be coming
  cache.set(name, v);
  return v;
}

/** `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, x)` with the alpha replaced -- canvases apply their own. */
export function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const r = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (r) return `rgba(${r[1]}, ${r[2]}, ${r[3]}, ${alpha})`;
  return color;
}
