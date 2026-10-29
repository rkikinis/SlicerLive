// WHAT IS OPEN THAT A SCENE ABOUT TO OPEN DOES NOT INCLUDE -- the question "Close them, then open the scene / Keep them"
// (render/demos/load-panel.ts) is asked when this is not empty.
//
// Counted as the Scenes list shows it: a volume, a segmentation, and a SERIES IN TIME AS ONE ITEM (the beating heart's
// five phases, a diffusion scan's volumes are hidden frames under one series). Counting only what is not hidden left a
// series in time out entirely: opening C3N-01524 over the beating heart asked nothing and the heart stayed, while the
// other way round asked (Ron, 2026-10-17: "Replacing one scene with a different one should have a consistent
// behaviour"; the same with diffusion cases).
import type { MrsonNode } from "../render/mrson.ts";

/** The items the Scenes list shows, each with the nodes that stand for it: a series in time once (its frames), a volume
 *  or a segmentation alone; the hidden frames and the members of a family in time are counted with their series. */
function openItems(nodes: Iterable<MrsonNode>): { all: Map<string, MrsonNode>; items: { node: MrsonNode; members: MrsonNode[] }[] } {
  const all = new Map<string, MrsonNode>();
  for (const n of nodes) all.set(n.id as string, n);
  const items: { node: MrsonNode; members: MrsonNode[] }[] = [];
  for (const n of all.values()) {
    if (n.type === "sequence") {
      const members = ((n.items as { node: string }[] | undefined) ?? []).map((it) => all.get(it.node)).filter((m): m is MrsonNode => !!m);
      if (members.length) items.push({ node: n, members });
      continue;
    }
    if (n.type !== "image" && n.type !== "segmentation") continue;
    if ((n as { hidden?: boolean }).hidden) continue;        // a frame of a series in time: counted with its series
    if (n.sequence) continue;                                // a member of a family in time: its series is the item
    items.push({ node: n, members: [n] });
  }
  return { all, items };
}

/** `wanted`: the series the scene names (SeriesInstanceUIDs). Returns the items to name in the question. */
export function loadedElsewhere(nodes: Iterable<MrsonNode>, wanted: Set<string>): MrsonNode[] {
  const inScene = (n: MrsonNode | undefined) => {
    const org = n?.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
    return !!org && (wanted.has(org.seriesInstanceUID ?? "") || wanted.has(org.savedSeriesInstanceUID ?? ""));
  };
  // A series in time is in the scene when any of its frames is.
  return openItems(nodes).items.filter((it) => !it.members.some(inScene)).map((it) => it.node);
}

// ANOTHER PATIENT'S DATA ON SCREEN WHEN A SERIES LOADS FROM THE DICOM BROWSER -- the same question as a scene's (Ron,
// 2026-10-22: "it should ask whether I load a scene or individual series (both parents and derived)"; he had loaded
// PAT16's scan over CON01's and nothing asked). A scene is one patient's (2026-09-20); a series of the SAME patient
// (a T1 after the diffusion scan) goes in beside what is open without a question.

/** The items open that belong to a patient other than `incoming` (the patients of the series about to load, keyed as
 *  `patientOf` keys them). `patientOf(node)` gives a node's patient, or undefined when it is not known -- an item whose
 *  patient is not known is not counted (a sample, a file). A segmentation without one takes its volume's. */
export function otherPatientsOpen(nodes: Iterable<MrsonNode>, incoming: Set<string>, patientOf: (n: MrsonNode) => string | undefined): MrsonNode[] {
  const { all, items } = openItems(nodes);
  const whose = (n: MrsonNode): string | undefined => {
    const own = patientOf(n);
    if (own || n.type !== "segmentation") return own;
    const src = ((n.refs as { source?: string[] } | undefined)?.source ?? [])[0];
    const vol = src ? all.get(src) : undefined;
    return vol ? patientOf(vol) : undefined;
  };
  return items.filter((it) => {
    const p = it.members.map(whose).find((w): w is string => !!w);
    return !!p && !incoming.has(p);
  }).map((it) => it.node);
}
