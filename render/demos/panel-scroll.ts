// KEEPING A PANEL'S PLACE ACROSS A REBUILD.
//
// Ron: "I tried to turn off small and large bowel in the Segmentations module. Every time I changed
// visibility it jumped to the top of the list. In a case like total where the bowel was two screens
// down, that is annoying."
//
// Every panel here redraws itself with `root.innerHTML = ""` followed by a fresh tree, and that
// throws away three kinds of state the person put there by hand:
//
//   * the SIDEBAR's scroll, because emptying the content collapses its height and the browser
//     clamps scrollTop to 0;
//   * the scroll of any box that scrolls ITSELF -- `.sl-anat-tree` is `overflow: auto`, and it is a
//     DESCENDANT of the panel root, so it is destroyed and rebuilt at the top. This is the one that
//     actually moved the bowel rows: a first version of this file only walked ANCESTORS, restored
//     the sidebar, and changed nothing Ron could see;
//   * an inline height from `resize: vertical` -- the drag handle on that same tree, which Ron asked
//     for ("give me a drag handle to increase the size"). Dragging it taller and then toggling an
//     eye snapped it back.
//
// Fixed here rather than in one panel because four of them rebuild this way, and because the same
// symptom was already being patched piecemeal: segmentations-panel calls `find.focus()` after a
// render because the focused input was destroyed along with everything else.
//
// Elements are matched across the rebuild by CLASS plus ordinal among same-class siblings-in-order.
// That is sound here precisely because these panels rebuild the same structure from the same data --
// and if a row's class does change, the effect is a lost scroll position, not a wrong one.
//
// The alternative -- update only the row that changed instead of rebuilding -- is better in
// principle and much larger in practice: a group's eye acts on every descendant, the search reflows
// the tree, and a correction can rename a row. This keeps the rebuild and restores what it lost.

interface Mark { top: number; left: number; height?: string }

/** The nearest ancestor that scrolls. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
  }
  return null;
}

/** Record every descendant worth restoring, keyed by class + ordinal. */
function survey(root: HTMLElement): Map<string, Mark> {
  const out = new Map<string, Mark>();
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[class]")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls) continue;
    const n = seen.get(cls) ?? 0;
    seen.set(cls, n + 1);
    const height = el.style.height || undefined;      // set by a resize drag, not by the stylesheet
    if (el.scrollTop > 0 || el.scrollLeft > 0 || height) {
      out.set(`${cls}#${n}`, { top: el.scrollTop, left: el.scrollLeft, height });
    }
  }
  return out;
}

/** Put those marks back on the rebuilt tree. */
function restore(root: HTMLElement, marks: Map<string, Mark>) {
  if (!marks.size) return;
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[class]")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls) continue;
    const n = seen.get(cls) ?? 0;
    seen.set(cls, n + 1);
    const m = marks.get(`${cls}#${n}`);
    if (!m) continue;
    // Height FIRST: a shorter box clamps the scroll that is about to be set on it.
    if (m.height) el.style.height = m.height;
    if (m.top) el.scrollTop = m.top;
    if (m.left) el.scrollLeft = m.left;
  }
}

/**
 * Run `rebuild` with the panel's scroll positions and dragged heights preserved.
 *
 * The re-apply on the next frame covers a rebuild whose final height is not settled synchronously:
 * the first assignment is clamped against a still-short box, and by the next frame it is tall enough
 * to honor it. It only re-applies where the position came back SHORT of the target, so a deliberate
 * scroll during that frame is not overridden.
 */
export function keepScroll(el: HTMLElement | null | undefined, rebuild: () => void) {
  if (!el) { rebuild(); return; }
  const inner = survey(el);
  const sc = scroller(el);
  const outer = sc ? sc.scrollTop : 0;
  const focus = surveyFocus(el);

  rebuild();

  restore(el, inner);
  restoreFocus(el, focus);
  if (sc && outer > 0) sc.scrollTop = outer;
  if (!inner.size && !(sc && outer > 0)) return;
  requestAnimationFrame(() => {
    restoreIfShort(el, inner);
    if (sc && outer > 0 && sc.scrollTop < outer) sc.scrollTop = outer;
  });
}

function restoreIfShort(root: HTMLElement, marks: Map<string, Mark>) {
  if (!marks.size) return;
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>("[class]")) {
    const cls = typeof el.className === "string" ? el.className : "";
    if (!cls) continue;
    const n = seen.get(cls) ?? 0;
    seen.set(cls, n + 1);
    const m = marks.get(`${cls}#${n}`);
    if (m && m.top && el.scrollTop < m.top) el.scrollTop = m.top;
  }
}

/**
 * THE FIELD BEING TYPED IN SURVIVES A REBUILD. Ron, 2026-09-24: searching Segmentations for the esophagus, "after
 * typing in the letter E I had to click in the field in order to be able to continue typing" -- the keystroke
 * published the tree's fold state to the scene, the scene change rebuilt the panel, and the rebuilt search field was
 * a new element without the focus. The focused text field (or select) is found again by the same key the scroll
 * positions use -- its class and which of that class it was -- and gets the focus and the caret back.
 */
interface FocusMark { key: string; n: number; start: number | null; end: number | null }
function surveyFocus(root: HTMLElement): FocusMark | null {
  const a = (root.ownerDocument ?? document).activeElement as HTMLElement | null;
  if (!a || !root.contains(a) || !(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement)) return null;
  const key = typeof a.className === "string" ? a.className : "";
  if (!key) return null;
  const same = [...root.querySelectorAll<HTMLElement>("input, textarea, select")].filter((e) => e.className === key);
  const n = same.indexOf(a);
  let start: number | null = null, end: number | null = null;
  try { if (!(a instanceof HTMLSelectElement)) { start = a.selectionStart; end = a.selectionEnd; } } catch { /* a type without a caret */ }
  return { key, n, start, end };
}
function restoreFocus(root: HTMLElement, m: FocusMark | null) {
  if (!m) return;
  const doc = root.ownerDocument ?? document;
  const same = [...root.querySelectorAll<HTMLElement>("input, textarea, select")].filter((e) => e.className === m.key);
  const t = same[m.n] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
  if (!t || doc.activeElement === t) return;
  t.focus({ preventScroll: true });
  try { if (!(t instanceof HTMLSelectElement) && m.start !== null) t.setSelectionRange(m.start, m.end ?? m.start); } catch { /* a type without a caret */ }
}
