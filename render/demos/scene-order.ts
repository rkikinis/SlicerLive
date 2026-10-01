// THE ORDER THE SCENE IS LISTED IN, shared by the Scene module and the 3D view's own panel so the
// two never disagree about which segmentation belongs to which volume or which one is drawn on top.
//
// Ron, with two CTs and two segmentations loaded at once: "the data should be arranged so it is
// clear which seg belongs to which ct." A flat list cannot say that. A segmentation names its
// volume in `refs.source`, which is the parent link; one whose source is not loaded stays at the
// top level rather than being hidden under a volume it does not belong to.
//
// THE ORDER IS THE DRAWING ORDER. Segmentations under one volume are listed in `zOrder`, and the
// slices draw them in that order, later ones over earlier ones; the Scene module's ▲▼ move a row.
// Absent zOrder means the order they arrived in.
import type { MrsonNode } from "../mrson.ts";

export function orderScene(all: MrsonNode[]): { node: MrsonNode; depth: number }[] {
  const sourceOf = (n: MrsonNode) => ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
  const ids = new Set(all.map((n) => n.id));
  const children = new Map<string, MrsonNode[]>();
  const top: MrsonNode[] = [];
  for (const n of all) {
    const src = n.type === "segmentation" ? sourceOf(n) : undefined;
    if (src && ids.has(src)) {
      const list = children.get(src) ?? [];
      list.push(n);
      children.set(src, list);
    } else top.push(n);
  }
  const z = (n: MrsonNode, i: number) => typeof n.zOrder === "number" ? n.zOrder : i;
  const out: { node: MrsonNode; depth: number }[] = [];
  for (const n of top) {
    out.push({ node: n, depth: 0 });
    const kids = (children.get(n.id) ?? []).map((c, i) => ({ c, k: z(c, i) })).sort((a, b) => a.k - b.k).map((x) => x.c);
    for (const c of kids) out.push({ node: c, depth: 1 });
  }
  return out;
}
