// SELECTING A DERIVED SERIES BRINGS WHAT IT NEEDS.
//
// Ron: "If I only click on the surface in the db, it should drag the segmentation with it." The same
// was true one level up and was an outright error: ticking a SEG alone gave "load the grayscale
// series first — a segmentation needs the volume it was drawn on", a correct description of a
// requirement the browser could have met itself, since it draws its own tree from these edges.
//
// The ordering function is tested rather than the panel: the panel needs a database and a DOM, and
// what can be wrong here is the ORDER and the cycle guard, both of which are arithmetic.
import { assertEquals } from "jsr:@std/assert@1";

type S = { seriesInstanceUID: string; modality?: string };

/** The same walk registerLoadPanel does, over injected maps. */
function withAncestors(chosen: S[], all: S[], derivedFrom: Map<string, string>): S[] {
  const byUid = new Map(all.map((s) => [s.seriesInstanceUID, s]));
  const out: S[] = [];
  const placed = new Set<string>();
  const add = (s: S, guard: Set<string>) => {
    const uid = s.seriesInstanceUID;
    if (placed.has(uid) || guard.has(uid)) return;
    guard.add(uid);
    const par = derivedFrom.get(uid);
    const parent = par ? byUid.get(par) : undefined;
    if (parent) add(parent, guard);
    if (!placed.has(uid)) { placed.add(uid); out.push(s); }
  };
  for (const s of chosen) add(s, new Set());
  return out;
}

const CT: S = { seriesInstanceUID: "ct", modality: "CT" };
const SEG: S = { seriesInstanceUID: "seg", modality: "SEG" };
const SURF: S = { seriesInstanceUID: "surf", modality: "SEG" };
const ALL = [CT, SEG, SURF];
const EDGES = new Map([["seg", "ct"], ["surf", "seg"]]);

const uids = (l: S[]) => l.map((s) => s.seriesInstanceUID);
/** The panel sorts images before segmentations after this, and that sort is stable. */
const asLoaded = (l: S[]) => uids([...l].sort((a, b) => Number(a.modality === "SEG") - Number(b.modality === "SEG")));

Deno.test("ticking only the surfaces brings the segmentation and the images, in that order", () => {
  assertEquals(asLoaded(withAncestors([SURF], ALL, EDGES)), ["ct", "seg", "surf"]);
});

Deno.test("ticking only the segmentation brings the images it was drawn on", () => {
  // This is the case that used to throw rather than load.
  assertEquals(asLoaded(withAncestors([SEG], ALL, EDGES)), ["ct", "seg"]);
});

Deno.test("nothing is loaded twice when the whole chain is ticked", () => {
  assertEquals(asLoaded(withAncestors([SURF, CT, SEG], ALL, EDGES)), ["ct", "seg", "surf"]);
});

Deno.test("a series with no parent is left exactly as it was", () => {
  assertEquals(asLoaded(withAncestors([CT], ALL, EDGES)), ["ct"]);
});

Deno.test("a cycle in the edges terminates instead of hanging the browser", () => {
  // Edges come from a table anything could have written; a loop must cost nothing.
  const cyclic = new Map([["a", "b"], ["b", "a"]]);
  const A = { seriesInstanceUID: "a" }, B = { seriesInstanceUID: "b" };
  assertEquals(uids(withAncestors([A], [A, B], cyclic)).sort(), ["a", "b"]);
});

Deno.test("a parent that is not in this database is skipped, not waited for", () => {
  // The edge survives a series being deleted; the load must still work with what is here.
  assertEquals(asLoaded(withAncestors([SEG], [SEG], EDGES)), ["seg"]);
});
