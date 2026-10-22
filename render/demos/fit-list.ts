// A LIST IN A MODULE FITS ITS SPACE, AND THE PERSON CAN CHANGE IT (Ron, 2026-10-15, on Scenes' "In this scene" box,
// capped at 220 px with a scroll bar above a column of empty space: "Lots of empty space but still a scroll bar. No resize
// option and no automatic resize. We should have both. Scrolling is mouse work. interactive resize for when the user
// does not like the default."). The workspace's Contents/docs/MODULE-DESIGN-RULES.md has the rule.
//
//   - AUTOMATIC: the list is as tall as its rows, until the module column would scroll; then it gives up exactly what
//     the column lacks, never below `min`. Measured again when the rows change or the column changes size.
//   - BY HAND: a grip under the list drags its height; the height is remembered per list (this browser only). A
//     double-click on the grip goes back to automatic.

const MIN = 96;
const storeKey = (key: string) => `sl-list-height:${key}`;
const readStored = (key: string): number | null => {
  try { const v = Number(localStorage.getItem(storeKey(key))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};
const writeStored = (key: string, h: number | null) => {
  try { if (h === null) localStorage.removeItem(storeKey(key)); else localStorage.setItem(storeKey(key), String(Math.round(h))); } catch { /* private window: not remembered */ }
};

/** WHERE EACH LIST WAS SCROLLED TO, by its key: a module draws itself again after a click, the list is a new element,
 *  and it came back at the top (Ron, 2026-10-16, the diffusion module's Shown list: "when I scroll down and click on
 *  visibility, the scroll bar resets. very annoying"). The new list of the same key starts where the old one was. */
const scrolledTo = new Map<string, number>();

/** The nearest ancestor that scrolls vertically (the module column), or null. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/**
 * The automatic height: everything the list holds, less what the column would have to scroll. Pure, for the test:
 * `natural` the list's full height, `overflow` how much taller the column's content is than the column with the list at
 * full height.
 */
export function autoHeight(natural: number, overflow: number, min = MIN): number {
  return Math.max(Math.min(natural, min), natural - Math.max(0, overflow));
}

/** Fit `list` (a scrolling box in a module) to its space, with a grip to change its height. `key` names it for memory. */
/** `opts.scrollKey`: what the remembered scroll position belongs to, when the same list shows different things (a list
 *  per patient under one key): another patient's list then opens at its own top, not 500 px down (critic 2026-10-16,
 *  tonight's fixes, finding 5). The height stays per `key`. */
export function fitList(list: HTMLElement, key: string, opts: { min?: number; scrollKey?: string } = {}): void {
  const min = opts.min ?? MIN;
  const scrollKey = opts.scrollKey ? `${key}|${opts.scrollKey}` : key;
  list.style.overflowY = "auto";
  const grip = document.createElement("div");
  grip.className = "sl-fit-grip";
  grip.title = "Drag to make the list taller or shorter. Double-click: fit it to the space again.";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  // A LIST MAY BE HANDED OVER BEFORE IT IS ON THE PAGE (a module building its rows), and a module that draws itself
  // again throws the old list away (critic 2026-10-15, diffusion v3, finding 17: 19 listeners after a few redraws): the
  // grip and the column are found when the list arrives, and everything is let go when it leaves.
  let queued = false, arrived = false, col: HTMLElement | null = null;
  const apply = () => {
    queued = false;
    if (!list.isConnected) { if (arrived) release(); return; }
    if (!arrived) {
      arrived = true;
      if (!grip.isConnected) list.after(grip);
      col = scroller(list);
      if (col) ro.observe(col);
      if (list.parentElement) ro.observe(list.parentElement);
    }
    if (list.offsetParent === null) return;          // not on screen: measured when it is
    const byHand = readStored(key);
    if (byHand !== null) { list.style.maxHeight = `${Math.max(min, byHand)}px`; putBack(); return; }
    // MEASURED WITHOUT TOUCHING THE LIST: its full height is its scrollHeight already, and the column's overflow at that
    // height is the overflow now plus what the list would grow by. Taking the list to full height for a moment stopped a
    // scroll in progress at every change of a row (critic 2026-10-16, tonight's fixes, finding 6: the Scenes list changes
    // at every step of the heart). Written only when it changes.
    const natural = list.scrollHeight;
    const overflow = col ? col.scrollHeight - col.clientHeight + Math.max(0, natural - list.clientHeight) : 0;
    const want = `${autoHeight(natural, overflow, min)}px`;
    if (list.style.maxHeight !== want) list.style.maxHeight = want;
    putBack();
  };
  // Once, when the list is first measured on screen: its height is set, so the old scroll position fits.
  let putBackDone = false;
  const putBack = () => {
    if (putBackDone) return;
    putBackDone = true;
    const y = scrolledTo.get(scrollKey);
    if (y) list.scrollTop = y;
  };
  list.addEventListener("scroll", () => { if (putBackDone && list.isConnected) scrolledTo.set(scrollKey, list.scrollTop); }, { passive: true });
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(apply); } };

  // Rows added or removed, the column or the window resized, the module shown again.
  const mo = new MutationObserver(later);
  mo.observe(list, { childList: true, subtree: true });
  const ro = new ResizeObserver(later);
  ro.observe(list);
  addEventListener("resize", later);
  const release = () => { mo.disconnect(); ro.disconnect(); removeEventListener("resize", later); };
  later();

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = list.getBoundingClientRect().height;
    list.style.maxHeight = `${h0}px`;
    const move = (m: PointerEvent) => { list.style.maxHeight = `${Math.max(min, h0 + m.clientY - y0)}px`; };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      writeStored(key, list.getBoundingClientRect().height);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => { writeStored(key, null); apply(); });
}
