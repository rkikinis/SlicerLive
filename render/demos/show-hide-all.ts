// The Segmentations list's Show all / Hide all button: what it says and does. Moved out of
// render/demos/segmentations-panel.ts on 2026-10-30 so the SDK (sdk/albula.ts), which re-exports it, does not load the
// whole panel -- and with it the Segment Editor -- into every extension's tests. Unchanged.
/**
 * What the show/hide-all button says, and what it will do.
 *
 * Ron: "can you add a turn off/on all button to the segmentations display?" With 111 structures,
 * "show me only the vessels" is otherwise a hundred and five clicks, and getting back is a hundred
 * and eleven.
 *
 * Separated from the panel because the DECISION is the part that can be wrong, and it needs no DOM:
 * which way the click goes, what it is scoped to, and what it therefore says.
 *
 * - ONE BUTTON, following the same rule the per-row eyes follow: anything still visible means the
 *   click hides; nothing visible means it shows. So it is never a no-op and the way back from a hide
 *   is the same button.
 * - SCOPED TO WHAT THE LIST SHOWS. With a filter typed it acts on the matches only, which is the
 *   useful half of it -- "rib" then Hide these 24 leaves everything else alone.
 * - THE LABEL SAYS WHICH, so there is nothing to discover: "Hide all" or "Show these 24".
 */
export function showHideAllState(
  shown: readonly { labelValue?: number; visible?: boolean }[],
  filtered: boolean,
): { label: string; title: string; show: boolean; labels: number[] } {
  const labels = shown.map((x) => x.labelValue).filter((v): v is number => typeof v === "number");
  const anyVisible = shown.some((x) => x.visible !== false);
  const show = !anyVisible;
  const n = shown.length;
  const label = show
    ? (filtered ? `Show these ${n}` : "Show all")
    : (filtered ? `Hide these ${n}` : "Hide all");
  return {
    label,
    title: show ? "Show every structure in the list below" : "Hide every structure in the list below",
    show,
    labels,
  };
}
