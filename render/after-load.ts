// WHAT THE 3D VIEW SHOWS AFTER A LOAD (Ron, 2026-10-19, demoing a diffusion case: "So I load a data set and nothing
// shows. That is not a good demo. What should we show after loading?"; his answers to the mockup
// Contents/docs/mockups/after-load-2026-10-19.html: MR alone "both" -- the volume rendered and the three slice planes;
// a diffusion case D -- the six major tracts, no plane; a brain tumor case "only the six major tracts").
//
// VERSION 2 (Ron, 2026-10-20: "yes" to FastSurfer when a T1 is added, and to the MR then shown as its brain): an MR alone
// whose brain's structures are stored (logic/import-jobs/brain-structures.ts made them when it was added) comes up with
// them, drawn solid -- the segmentation's own load path leaves the scan plain -- instead of the volume and the planes.
// Version 1 is what an MR without them still gets.
//
// VERSION 3 (the critic's round, 2026-10-20, qa/2026-10-20-after-load-brain-codes.md, findings 7, 8, 15; "you should not
// design for single anything"): SEVERAL MR SCANS IN ONE LOAD -- per study, the brain of ONE T1, the one the import-time
// job prefers (brain-structures-rule.ts studyOrder), and the other MR scans of that study plain: no second brain, and no
// volume rendering around the solid brain. A study without a stored brain gets version 1. The slice planes the rules
// put on are the rules' to take away again -- a load with no MR to look at (a CT after an MR) turns THEM off, never a
// plane the person or a scene switched on. NEVER EMPTY (the mockup's last row): a load after which nothing would be
// drawn in 3D (a diffusion scan alone, no T1, no stored tracts) shows the slice planes at least.
//
// Each version stays (CLAUDE.md, "modular and versioned"): applyAfterLoad(…, version) gives any of them back.
//
// One numbered version of the rules, here. A load from the DICOM browser (or a module's loadDatabaseSeries) ends with
// `applyAfterLoad`; a saved scene does not -- it puts back what was on screen. CT keeps what it had before version 1: a
// CT alone volume rendered (tf-editor.ts), with a segmentation the anatomy solid, the beating heart colored.
//
// An extension that shows something of its own for a load (the diffusion extension: the major tracts) registers a
// handler; when one says it showed something, the anatomy loaded with it is left plain -- no volume rendering, no
// planes -- so what the extension shows is not hidden behind the head.

import type { LiveScene } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";
import { measurementSeries, sequencePlays } from "../logic/sequences.ts";
import { isBrainResult, studyOrder, t1Candidates } from "../logic/import-jobs/brain-structures-rule.ts";

/** The version a load gets. 1 (2026-10-19): an MR alone volume rendered with the planes, a module's own showing.
 *  2 (2026-10-20): an MR with its stored brain shows the brain, solid. 3 (2026-10-20, the critic's round): one brain
 *  per study, the other MR plain; the rules' planes taken back after a load with no MR; never empty. */
export const AFTER_LOAD_VERSION = 3;
/** Version 1's major tracts, by the tract atlas's abbreviations: corticospinal tract, arcuate fasciculus, inferior
 *  occipito-frontal fasciculus, inferior longitudinal fasciculus, uncinate fasciculus, cingulum bundle; both sides. */
export const MAJOR_TRACTS: readonly string[] = ["CST", "AF", "IOFF", "ILF", "UF", "CB"];
/** The slice views shown as planes in 3D for an MR alone. */
export const PLANE_VIEWS: readonly string[] = ["Red", "Yellow", "Green"];

export interface Loaded {
  live: LiveScene;
  /** The node ids the load added. */
  added: string[];
}
/** True when the handler shows something in 3D for this load. */
export type AfterLoadHandler = (l: Loaded) => Promise<boolean> | boolean;
const handlers: AfterLoadHandler[] = [];
/** SDK: an extension's say in what a load shows (the diffusion extension's major tracts). */
export function registerAfterLoad(h: AfterLoadHandler): void { handlers.push(h); }

const isMr = (n: MrsonNode) => String((n.origin as { modality?: string } | undefined)?.modality ?? "").toUpperCase() === "MR";

/**
 * THE PLAN, as a plain function (tested): which of the scans the load added are an MR to look at in 3D -- a scalar MR
 * volume, not a computed map (autoVolumeRendering: false), not a series in time that does not play (a diffusion scan),
 * and with no segmentation drawn on it (a segmentation brings the solid look). For those: the slice planes, and the
 * volume rendering on -- or both off when an extension showed the load (`claimed`).
 */
export function planAfterLoad(nodes: Map<string, MrsonNode>, added: string[], claimed: boolean): { mr: string[]; planes: boolean; volumeRendering: boolean } {
  const segmented = new Set<string>();
  for (const n of nodes.values()) {
    if (n.type !== "segmentation") continue;
    const src = ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    if (src) segmented.add(src);
  }
  const mr = added.filter((id) => {
    const n = nodes.get(id);
    if (!n || n.type !== "image" || n.labelmap || !isMr(n)) return false;
    if ((n as { autoVolumeRendering?: boolean }).autoVolumeRendering === false || (n as { rgb24?: boolean }).rgb24) return false;
    const seq = n.sequence ? nodes.get(n.sequence as string) : undefined;
    if (seq && !sequencePlays(seq as { indexType?: unknown; items?: unknown })) return false;
    return !segmented.has(id);
  });
  return { mr, planes: mr.length > 0 && !claimed, volumeRendering: !claimed };
}

/** What the load panel knows of a scan from the database's index (version 3's choice of T1). */
export interface ScanFacts { description?: string; images?: number }

/** After a load: the extensions first, then the rules. `claimed`: a module showed the load; `line`: for the session log.
 *  `version`: which rules (AFTER_LOAD_VERSION unless a test or a recorded state asks for another). */
export async function applyAfterLoad(l: Loaded, act: {
  setSliceIn3D?: (cell: string, on: boolean) => void; setVolumeRendering: (imageId: string, on: boolean) => void;
  /** Version 2: load the stored brain's structures of these MR scans; how many segmentations came. */
  loadStored?: (imageIds: string[]) => Promise<number>;
  /** Version 3: the slice views shown as planes in 3D now. */
  sliceIn3D?: () => string[];
  /** Version 3: the planes these rules switched on and that are still theirs (kept by the caller between loads). */
  rulesPlanes?: Set<string>;
  /** Version 3: a scan's description and image count, by its node id (from the database's index). */
  facts?: (imageId: string) => ScanFacts | undefined;
  /** Version 3: meshes drawn in 3D that are not nodes of the scene (an extension's tracts, surface models). */
  meshesIn3D?: () => boolean;
}, version = AFTER_LOAD_VERSION): Promise<{ claimed: boolean; line: string }> {
  let claimed = false;
  for (const h of handlers) { try { if (await h(l)) claimed = true; } catch { /* one extension failing does not stop the rest */ } }
  if (version >= 3) return await applyV3(l, act, claimed);
  let plan = planAfterLoad(l.live.nodes, l.added, claimed);
  // The brain's structures, where they are stored: once loaded, those MR scans have a segmentation and leave the plan.
  let brains = 0;
  if (version >= 2 && !claimed && plan.mr.length && act.loadStored) {
    try { brains = await act.loadStored(plan.mr); } catch { brains = 0; }
    if (brains) plan = planAfterLoad(l.live.nodes, l.added, false);
  }
  if (!plan.volumeRendering) for (const id of plan.mr) act.setVolumeRendering(id, false);
  // Planes on for an MR alone; OFF when a module shows the load (Ron's D: no plane) -- also planes left on by an earlier
  // load, which closing a scene does not take away (PAT16 after a T1 alone, 2026-10-19).
  if (plan.planes || claimed || brains) for (const cell of PLANE_VIEWS) act.setSliceIn3D?.(cell, plan.planes);
  const what = [
    claimed ? "shown by a module" + (plan.mr.length ? `, ${plan.mr.length} MR left plain` : "") : "",
    brains ? `the brain's structures of ${brains} MR, solid` : "",
    !claimed && plan.mr.length ? `${plan.mr.length} MR volume rendered, with the slice planes in 3D` : "",
  ].filter(Boolean).join("; ");
  return { claimed, line: what ? `after the load (rules v${version}): ${what}` : "" };
}

const originOf = (n: MrsonNode | undefined) => (n?.origin ?? {}) as { studyInstanceUID?: string; task?: string };
const refSource = (n: MrsonNode) => ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
/** A segmentation that is the brain's structures (its name is the result's description, or its file named the task). */
const isBrainNode = (n: MrsonNode) => n.type === "segmentation" &&
  (isBrainResult(String(n.name ?? "")) || (!!originOf(n).task && isBrainResult(`${originOf(n).task} of `)));
const on3D = (n: MrsonNode) => !(n as { hidden?: boolean }).hidden && ((n.visible3D as boolean | undefined) ?? (n.visible !== false));
const anyVrOn = (nodes: Map<string, MrsonNode>) => [...nodes.values()].some((n) => n.type === "volumeRenderingDisplay" && n.visible === true);

/** IS ANYTHING DRAWN IN 3D besides the slice planes (version 3's "never empty"): a volume rendering on, a segmentation
 *  (the solid look), a model, a markup or tracts shown in 3D. Read from the scene's nodes, as the views compose it. */
export function shownIn3D(nodes: Map<string, MrsonNode>): boolean {
  for (const n of nodes.values()) {
    if (n.type === "volumeRenderingDisplay" && n.visible === true) return true;
    if ((n.type === "segmentation" || n.type === "model" || n.type === "markup" || n.type === "fiberBundle") && on3D(n)) return true;
  }
  return false;
}

/**
 * VERSION 3'S PLAN, as a plain function (tested): the MR scans of the load to look at in 3D (as version 1, except that a
 * series in time is left out only when it is a series of measurements -- logic/sequences.ts measurementSeries), and per
 * study, the order in which their brains are looked for: the T1 scans in the import-time job's order first, then the
 * other MR scans (a brain saved from the AI panel can be on any of them). A study that already shows a brain is named.
 */
export function planV3(nodes: Map<string, MrsonNode>, added: string[], facts: (id: string) => ScanFacts | undefined = () => undefined): {
  mr: string[]; byStudy: Map<string, string[]>; brainShown: Set<string>;
} {
  const segmented = new Set<string>(), brainShown = new Set<string>();
  for (const n of nodes.values()) {
    if (n.type !== "segmentation") continue;
    const src = refSource(n);
    if (src) segmented.add(src);
    if (src && isBrainNode(n) && on3D(n)) brainShown.add(originOf(nodes.get(src)).studyInstanceUID ?? "");
  }
  const mr = added.filter((id) => {
    const n = nodes.get(id);
    if (!n || n.type !== "image" || n.labelmap || !isMr(n)) return false;
    if ((n as { autoVolumeRendering?: boolean }).autoVolumeRendering === false || (n as { rgb24?: boolean }).rgb24) return false;
    const seq = n.sequence ? nodes.get(n.sequence as string) : undefined;
    if (seq && measurementSeries(seq as { indexType?: unknown; items?: unknown }, n)) return false;
    return !segmented.has(id);
  });
  const byStudy = new Map<string, string[]>();
  const rows = new Map<string, { seriesUID: string; modality: string; description: string }[]>(), images = new Map<string, number>();
  for (const id of mr) {
    const f = facts(id) ?? {}, study = originOf(nodes.get(id)).studyInstanceUID ?? "";
    if (!rows.has(study)) rows.set(study, []);
    rows.get(study)!.push({ seriesUID: id, modality: "MR", description: f.description ?? String(nodes.get(id)?.name ?? "") });
    images.set(id, f.images ?? 0);
  }
  for (const [study, r] of rows) {
    const t1 = studyOrder(t1Candidates(r), images);
    const rest = studyOrder(r.filter((x) => !t1.includes(x)), images);
    byStudy.set(study, [...t1, ...rest].map((x) => x.seriesUID));
  }
  return { mr, byStudy, brainShown };
}

async function applyV3(l: Loaded, act: Parameters<typeof applyAfterLoad>[1], claimed: boolean): Promise<{ claimed: boolean; line: string }> {
  const nodes = l.live.nodes;
  const ours = act.rulesPlanes ?? new Set<string>();
  // A plane the person switched off is no longer the rules' (switched on again by hand, it is theirs).
  const onBefore = new Set(act.sliceIn3D?.() ?? []);
  for (const c of [...ours]) if (!onBefore.has(c)) ours.delete(c);
  const plan = planV3(nodes, l.added, act.facts);
  // ONE BRAIN PER STUDY: the first scan in the job's order whose brain is stored; none where a brain is already shown.
  const brainStudies = new Set<string>(), brains: string[] = [];
  if (!claimed && act.loadStored) {
    for (const [study, order] of plan.byStudy) {
      if (plan.brainShown.has(study)) { brainStudies.add(study); continue; }
      for (const id of order) {
        let n = 0;
        try { n = await act.loadStored([id]); } catch { n = 0; }
        if (n) { brains.push(id); brainStudies.add(study); break; }
      }
    }
  }
  const studyOf = (id: string) => originOf(nodes.get(id)).studyInstanceUID ?? "";
  // Plain: every MR when a module shows the load; every MR of a study that shows its brain (the T1 under it included).
  const plain = plan.mr.filter((id) => claimed || brainStudies.has(studyOf(id)));
  const looked = plan.mr.filter((id) => !plain.includes(id));
  for (const id of plain) act.setVolumeRendering(id, false);
  // Exactly one volume rendering (tf-editor.ts showOnLoad gave it to the last scan to arrive): when that one was left
  // plain and none is on, the last MR still to look at gets it.
  if (looked.length && !anyVrOn(nodes)) act.setVolumeRendering(looked[looked.length - 1], true);
  // THE PLANES: on for an MR to look at; never empty; otherwise the rules take back only their own.
  const empty = !claimed && !looked.length && !brains.length && !shownIn3D(nodes) && !(act.meshesIn3D?.() ?? false);
  const want = !claimed && (looked.length > 0 || empty);
  let planes = "";
  if (want) {
    for (const cell of PLANE_VIEWS) if (!onBefore.has(cell)) { act.setSliceIn3D?.(cell, true); ours.add(cell); }
    planes = empty ? "nothing else to show: the slice planes in 3D" : "with the slice planes in 3D";
  } else if (l.added.length && ours.size) {
    for (const cell of [...ours]) { act.setSliceIn3D?.(cell, false); ours.delete(cell); }
    planes = "the slice planes the rules had put on taken off";
  }
  const what = [
    claimed ? "shown by a module" + (plan.mr.length ? `, ${plan.mr.length} MR left plain` : "") : "",
    brains.length ? `the brain's structures of ${brains.length === 1 ? "one T1" : `${brains.length} T1 (one per study)`}, solid` +
      (plain.length > brains.length ? `, ${plain.length - brains.length} other MR plain` : "") : "",
    looked.length ? `${looked.length === 1 ? "the MR" : `${looked.length} MR, the last of them`} volume rendered` : "",
    planes,
  ].filter(Boolean).join("; ");
  return { claimed, line: what ? `after the load (rules v3): ${what}` : "" };
}
