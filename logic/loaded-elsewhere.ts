// WHAT IS OPEN THAT A SCENE ABOUT TO OPEN DOES NOT INCLUDE -- the question "Close them, then open the scene / Keep them"
// (render/demos/load-panel.ts) is asked when this is not empty.
//
// Counted as the Scenes list shows it: a volume, a segmentation, and a SERIES IN TIME AS ONE ITEM (the beating heart's
// five phases, a diffusion scan's volumes are hidden frames under one series). Counting only what is not hidden left a
// series in time out entirely: opening C3N-01524 over the beating heart asked nothing and the heart stayed, while the
// other way round asked (Ron, 2026-10-17: "Replacing one scene with a different one should have a consistent
// behaviour"; the same with diffusion cases).
import type { MrsonNode } from "../render/mrson.ts";

/** `wanted`: the series the scene names (SeriesInstanceUIDs). Returns the items to name in the question. */
export function loadedElsewhere(nodes: Iterable<MrsonNode>, wanted: Set<string>): MrsonNode[] {
  const all = new Map<string, MrsonNode>();
  for (const n of nodes) all.set(n.id as string, n);
  const inScene = (n: MrsonNode | undefined) => {
    const org = n?.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
    return !!org && (wanted.has(org.seriesInstanceUID ?? "") || wanted.has(org.savedSeriesInstanceUID ?? ""));
  };
  const out: MrsonNode[] = [];
  for (const n of all.values()) {
    if (n.type === "sequence") {
      // A series in time: one item, in the scene when any of its frames is.
      const members = ((n.items as { node: string }[] | undefined) ?? []).map((it) => all.get(it.node)).filter((m): m is MrsonNode => !!m);
      if (members.length && !members.some(inScene)) out.push(n);
      continue;
    }
    if (n.type !== "image" && n.type !== "segmentation") continue;
    if ((n as { hidden?: boolean }).hidden) continue;        // a frame of a series in time: counted with its series
    if (n.sequence) continue;                                // a member of a family in time: its series is the item
    if (!inScene(n)) out.push(n);
  }
  return out;
}
