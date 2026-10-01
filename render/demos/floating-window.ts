/**
 * ONE KIND OF WINDOW. The DICOM database browser was the first in-page window: movable by its
 * title bar, resizable at its corner, with macOS traffic lights on the left (close, restore the
 * default size, fill the window) and Escape to close. Ron, when the network browser arrived with
 * its own chrome: "quitting the window should be the same as the dicom window and future windows."
 * So the chrome lives here, once, and every window is this one with different contents.
 *
 * Lifted from load-panel.ts's showDatabaseBrowser, behavior unchanged: the same clamp so a window
 * can never be dragged somewhere it cannot be dragged back from; move and up bound on the window
 * rather than the header, because a webview drops pointer capture; window-bound listeners removed
 * with the element so five openings do not leave five drag handlers running.
 */

export interface FloatingWindow {
  /** The scrim behind the window; remove it and the window is gone. */
  overlay: HTMLElement;
  /** The window itself: a column. Append the body below `head`. */
  box: HTMLElement;
  /** The title bar. The lights and the title are already in it; add controls after them. */
  head: HTMLElement;
  close: () => void;
}

export interface FloatingWindowOptions {
  title: string;
  /** Hover text on the title, e.g. the full path behind a shortened name. */
  titleTip?: string;
  /** Default size as a fraction of the viewport (0.94 is the DICOM browser's). */
  fraction?: number;
  /** Or an explicit default, in pixels; the viewport still clamps it. */
  size?: { w: number; h: number };
  zIndex?: number;
  onClose?: () => void;
}

const vp = () => globalThis as unknown as { innerWidth: number; innerHeight: number };

export function openFloatingWindow(o: FloatingWindowOptions): FloatingWindow {
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;z-index:${o.zIndex ?? 9000};background:var(--sl-scrim);`;
  const box = document.createElement("div");
  // A window, not a panel pinned to the viewport. Ron: "the popup window of the database is glued
  // to the main window. It would be nice to be able to resize and move it." Explicit
  // left/top/width/height, so a drag can change two of them and a resize the other two.
  const f = o.fraction ?? 0.94;
  const DEF = () => {
    const w = o.size ? Math.min(o.size.w, vp().innerWidth) : Math.round(vp().innerWidth * f);
    const h = o.size ? Math.min(o.size.h, vp().innerHeight) : Math.round(vp().innerHeight * f);
    return { w, h, x: Math.round((vp().innerWidth - w) / 2), y: Math.round((vp().innerHeight - h) / 2) };
  };
  const place = (g: { x: number; y: number; w: number; h: number }) => {
    // Clamp so a window can never be dragged somewhere it cannot be dragged back from: at least a
    // title bar's worth stays on screen horizontally, and the top edge stays reachable.
    const w = Math.max(420, Math.min(g.w, vp().innerWidth));
    const h = Math.max(260, Math.min(g.h, vp().innerHeight));
    box.style.width = w + "px";
    box.style.height = h + "px";
    box.style.left = Math.max(60 - w, Math.min(g.x, vp().innerWidth - 60)) + "px";
    box.style.top = Math.max(0, Math.min(g.y, vp().innerHeight - 40)) + "px";
  };
  box.className = "sl-fw-box";   // so the app's button ranks reach the windows (theme.css, 2026-09-22)
  box.style.cssText = "position:absolute;display:flex;flex-direction:column;" +
    "background:var(--sl-bg);color:var(--sl-fg);border:1px solid var(--sl-line-strong);" +
    "border-radius:10px;box-shadow:var(--sl-shadow-dialog);overflow:hidden;font:13px var(--sl-font);";
  place(DEF());

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    globalThis.removeEventListener("pointermove", onMove);
    globalThis.removeEventListener("pointerup", endDrag);
    globalThis.removeEventListener("pointercancel", endDrag);
    globalThis.removeEventListener("pointermove", onSize);
    globalThis.removeEventListener("pointerup", endSize);
    globalThis.removeEventListener("pointercancel", endSize);
    o.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey, true);

  // --- title bar ---
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 14px;" +
    "border-bottom:1px solid var(--sl-line);flex:0 0 auto;flex-wrap:wrap;cursor:move;" +
    "user-select:none;-webkit-user-select:none;";
  // Drag the window by its title bar. A drag that starts on a control in the header is not a
  // window drag.
  let drag: { dx: number; dy: number } | null = null;
  let zoomed = false;
  head.addEventListener("pointerdown", (e) => {
    const t = (e as PointerEvent).target as HTMLElement;
    if (t.closest("button, input, select, a")) return;
    const r = box.getBoundingClientRect();
    drag = { dx: (e as PointerEvent).clientX - r.left, dy: (e as PointerEvent).clientY - r.top };
    try { globalThis.getSelection?.()?.removeAllRanges(); } catch { /* not fatal */ }
    document.body.style.userSelect = "none";
    (e as PointerEvent).preventDefault();
  });
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const r = box.getBoundingClientRect();
    place({ x: e.clientX - drag.dx, y: e.clientY - drag.dy, w: r.width, h: r.height });
    // Dragging a zoomed window means the user no longer wants it filling the viewport.
    zoomed = false;
  };
  const endDrag = () => { if (drag) { drag = null; document.body.style.userSelect = ""; } };
  globalThis.addEventListener("pointermove", onMove);
  globalThis.addEventListener("pointerup", endDrag);
  globalThis.addEventListener("pointercancel", endDrag);

  // macOS traffic lights, on the LEFT where the platform puts them. This is an in-page dialog, not
  // an OS window, so the three buttons are given the closest honest meanings: close, shrink back
  // to the default size (the "minimize" slot -- there is no Dock to minimize into), and zoom to
  // fill the viewport. Glyphs only appear on hover, as macOS does.
  const lights = document.createElement("div");
  lights.style.cssText = "display:flex;gap:8px;align-items:center;margin-right:4px;";
  const light = (color: string, glyph: string, tip: string, act: () => void) => {
    const b = document.createElement("button");
    b.className = "sl-fw-light";   // not a push button: theme.css exempts it from the ranks
    b.title = tip;
    b.setAttribute("aria-label", tip);
    b.textContent = glyph;
    b.style.cssText = "width:12px;height:12px;min-width:0;min-height:0;border-radius:50%;border:none;padding:0;cursor:pointer;" +
      `background:${color};color:var(--sl-on-fill);font:8px/12px system-ui;text-align:center;` +
      "opacity:.9;transition:opacity 90ms;";
    b.style.textIndent = "-999px";
    lights.addEventListener("mouseenter", () => { b.style.textIndent = "0"; });
    lights.addEventListener("mouseleave", () => { b.style.textIndent = "-999px"; });
    b.addEventListener("click", (e) => { e.stopPropagation(); act(); });
    return b;
  };
  const zoomToggle = () => {
    zoomed = !zoomed;
    place(zoomed ? { x: 0, y: 0, w: vp().innerWidth, h: vp().innerHeight } : DEF());
    box.style.borderRadius = zoomed ? "0" : "10px";
  };
  // macOS's own three colors, on purpose: these imitate the window's traffic lights, so they
  // follow the operating system and not the theme. The one place a literal color belongs.
  lights.append(
    light("#ff5f57", "×", "Close (Esc)", close),
    light("#febc2e", "–", "Restore the default size and position", () => { zoomed = false; place(DEF()); box.style.borderRadius = "10px"; }),
    light("#28c840", "+", "Fill the window", zoomToggle),
  );
  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;";
  title.textContent = o.title;
  if (o.titleTip) title.title = o.titleTip;
  head.append(lights, title);

  box.appendChild(head);

  // RESIZE BY A GRIP OF OUR OWN, not CSS `resize: both`. The CSS resizer belongs to the box, and a
  // child that fills the box to its corner -- a scrolling body -- sits on top of it and takes the
  // pointer, so the window looked resizable and was not. Ron, on the Merge window: "I can not
  // change the size of the window." A grip element above every child, with the same drag
  // mechanics as the title bar, works whatever the body is.
  const grip = document.createElement("div");
  grip.title = "Drag to resize";
  grip.style.cssText = "position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:5;" +
    "background:linear-gradient(135deg, transparent 0 55%, var(--sl-fg-dim) 55% 62%, transparent 62% 72%, var(--sl-fg-dim) 72% 79%, transparent 79%);" +
    "opacity:.7;";
  let sizing: { x0: number; y0: number; w0: number; h0: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    const r = box.getBoundingClientRect();
    sizing = { x0: e.clientX, y0: e.clientY, w0: r.width, h0: r.height };
    document.body.style.userSelect = "none";
    e.preventDefault(); e.stopPropagation();
  });
  const onSize = (e: PointerEvent) => {
    if (!sizing) return;
    const r = box.getBoundingClientRect();
    place({ x: r.left, y: r.top, w: sizing.w0 + e.clientX - sizing.x0, h: sizing.h0 + e.clientY - sizing.y0 });
    zoomed = false;
  };
  const endSize = () => { if (sizing) { sizing = null; document.body.style.userSelect = ""; } };
  globalThis.addEventListener("pointermove", onSize);
  globalThis.addEventListener("pointerup", endSize);
  globalThis.addEventListener("pointercancel", endSize);
  box.appendChild(grip);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return { overlay, box, head, close };
}
