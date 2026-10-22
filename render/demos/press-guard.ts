// A LIST THAT REDRAWS ITSELF WAITS WHILE A BUTTON IN IT IS PRESSED (Ron, 2026-10-17, the beating heart playing: "neither
// ventricles nor coronaries can be turned off while the sequencer is running. The 3d buttons are nonresponsive"). Each
// step of a playing series rewrites the segmentations, and a module that rebuilds its rows on every such change replaced
// the button between the press and the release: no click. A rebuild asks `pressedIn(root)`; while it is true it hands
// itself to `afterPress`, which runs it once the press has ended and its click has been delivered.

let pressedAt: Element | null = null;
const waiting = new Set<() => void>();
let listening = false;

function listen(): void {
  if (listening || typeof addEventListener !== "function") return;
  listening = true;
  addEventListener("pointerdown", (e) => { pressedAt = e.target as Element | null; }, true);
  const released = () => {
    if (!pressedAt) return;
    pressedAt = null;
    if (!waiting.size) return;
    const run = [...waiting]; waiting.clear();
    setTimeout(() => { for (const f of run) f(); }, 0);   // after the click
  };
  addEventListener("pointerup", released, true);
  addEventListener("pointercancel", released, true);
}

/** Is a press going on that started inside `root`? */
export function pressedIn(root: Element | null | undefined): boolean {
  listen();
  return !!root && !!pressedAt && root.contains(pressedAt);
}

/** Run `fn` once the press going on has ended (each function once, however often it is asked). */
export function afterPress(fn: () => void): void {
  listen();
  waiting.add(fn);
}
