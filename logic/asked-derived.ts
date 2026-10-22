// WHICH DERIVED SERIES WAS ASKED FOR (Ron, 2026-10-21: "when I loaded the tracts it did not load its parent"). A series
// that is not an image -- fiber tracts, stored with their diffusion scan as the parent -- is shown by the module that
// made it, once its parent is loaded. The DICOM browser brings the parent and records here which child was ticked, so
// the module shows THAT one and not the newest of its kind (a scan can hold several tract sets, each made by a version
// of the pipeline). A saved scene records it the same way, through the module's own state.
//
// The parent may already be loaded when the ask comes (a second set ticked for a scan on screen): the module hears it
// through onAskedDerived (critic 2026-10-21, finding 3). An ask lasts while its parent is in the scene: the module
// forgets it when the parent leaves (forgetAskedDerivedFor), so loading the scan again alone shows the newest.
//
// On globalThis, as the other registries an extension shares with core (logic/scene/extensions.ts).

const KEY = "__albulaAskedDerived", LISTENERS = "__albulaAskedDerivedListeners";
type Listener = (kind: string, parent: string, child: string) => void;
const asked = (): Map<string, string> => ((globalThis as Record<string, unknown>)[KEY] ??= new Map()) as Map<string, string>;
const listeners = (): Set<Listener> => ((globalThis as Record<string, unknown>)[LISTENERS] ??= new Set()) as Set<Listener>;

/** Record that the series `child` of kind `kind` (its provenance edge's kind, "tracts") was asked for under `parent`. */
export function askDerived(kind: string, parent: string, child: string): void {
  const k = `${kind}|${parent}`;
  if (asked().get(k) === child) return;
  asked().set(k, child);
  for (const f of listeners()) { try { f(kind, parent, child); } catch { /* a listener's fault is its own */ } }
}
/** SDK: the series of this kind last asked for under `parent`, or undefined (then the module takes its own choice). */
export function askedDerived(kind: string, parent: string): string | undefined { return asked().get(`${kind}|${parent}`); }
/** SDK: called with each new ask (a different child than before). Returns the function that stops it. */
export function onAskedDerived(f: Listener): () => void { listeners().add(f); return () => { listeners().delete(f); }; }
/** SDK: forget the asks under one parent (it left the scene). */
export function forgetAskedDerivedFor(parent: string): void {
  for (const k of [...asked().keys()]) if (k.endsWith(`|${parent}`)) asked().delete(k);
}
/** Forget every request (closing the scene). */
export function forgetAskedDerived(): void { asked().clear(); }
