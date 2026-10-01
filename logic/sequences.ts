/**
 * SEQUENCES IN THE SCENE: a series of volumes in time, as Slicer's Sequences module has them.
 *
 * Two node types, per docs/SEQUENCES-CINE.md §3, mirroring vtkMRMLSequenceNode and
 * vtkMRMLSequenceBrowserNode so SlicerHeart's and IGT's data transfer without translation:
 *
 *   sequence         { indexName, indexUnit, indexType, items: [{ index, node }] }
 *                    -- every item an ordinary `image` node, hidden from the Scene list, so a frame
 *                       is a volume like any other: same reader, same blobs, same renderer.
 *   sequenceBrowser  { sequences: [{ sequence, proxy }], selectedItemNumber, playbackActive,
 *                      playbackRateFps, playbackLooped }
 *                    -- `proxy` is the frame currently shown; scrubbing is one op on
 *                       `#/selectedItemNumber`, and the SequenceDisplayableManager in livescene
 *                       moves the slice views and the 3D rendering to the new frame.
 *
 * The first case is a gated coronary CTA: one series, five cardiac phases of 533 slices each,
 * plus a ten-frame bolus-monitoring series. The DICOM reader splits them (dicom-series.ts
 * groupSeries); this module puts the frames into the scene as one sequence.
 */
import type { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import type { LocalBlobStore } from "./ingest.ts";
import { loadVolumeIntoScene } from "./ingest.ts";
import type { Volume } from "./readers/nifti.ts";
import type { FrameTiming } from "./readers/dicom-series.ts";

/** One frame: its index value (the label's number), its image node, and WHEN it is, in seconds. */
export interface SequenceItem { index: string; node: string; time?: number }

/**
 * A picture that belongs with a sequence: the scanner's ECG documentation of a gated
 * reconstruction (Siemens "ECGDOC" secondary captures -- the trace, the beats it used marked). Not
 * a frame and not a volume; shown beside the transport, as what it is.
 */
export interface SequenceDocument {
  /** The series it came from, as the scene names things. */
  name: string;
  seriesInstanceUID?: string;
  /** PNG data URLs, in instance order, with the pixel size of each. */
  images: { dataUrl: string; width: number; height: number; caption: string }[];
}

/**
 * Playing at the TRUE rate. A gated cardiac sequence's frames sit at their R-wave delays inside
 * one heartbeat (60 / bpm seconds), so a loop is one beat: the frames go by at their delays and the
 * last one holds until the next R-wave. A clock sequence (bolus monitoring: one slice every 0.9 s)
 * loops over its acquisition times plus one more gap at the end.
 */
export interface RealTimeSchedule {
  kind: "cardiac" | "clock";
  /** Seconds from the start of the loop, one per frame, ascending. */
  times: number[];
  /** Seconds one loop takes. */
  period: number;
  bpm?: number;
}

/** The schedule a sequence node supports, or null when the scanner did not say when its frames are. */
export function realTimeSchedule(seq: { items?: SequenceItem[]; heartRateBpm?: number } | undefined): RealTimeSchedule | null {
  const items = seq?.items ?? [];
  if (items.length < 2 || items.some((it) => typeof it.time !== "number" || !Number.isFinite(it.time))) return null;
  const times = items.map((it) => it.time as number);
  if (times.some((t, i) => i > 0 && t < times[i - 1])) return null;
  const bpm = seq?.heartRateBpm;
  if (bpm && bpm > 0) {
    const period = 60 / bpm;
    return times[times.length - 1] < period ? { kind: "cardiac", times, period, bpm } : null;
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)] || 1;
  return { kind: "clock", times, period: times[times.length - 1] + gap };
}

/** Which frame is due `elapsed` seconds into real-time playback: the latest whose time has come, the last one before the loop's first. */
export function frameAtElapsed(s: RealTimeSchedule, elapsed: number): number {
  const phase = elapsed - Math.floor(elapsed / s.period) * s.period;
  let k = -1;
  // 1e-6 s of slack: the times were divided out of milliseconds and the modulo above is not exact.
  for (let i = 0; i < s.times.length; i++) if (s.times[i] <= phase + 1e-6) k = i;
  return k < 0 ? s.times.length - 1 : k;
}

/** "36 % of R-R at 86 bpm", for a cardiac frame; empty when the sequence is not one. */
export function heartbeatFraction(seq: { heartRateBpm?: number } | undefined, item: SequenceItem | undefined): string {
  const bpm = seq?.heartRateBpm;
  if (!bpm || !item || typeof item.time !== "number") return "";
  return `${Math.round((item.time / (60 / bpm)) * 100)} % of R-R at ${bpm} bpm`;
}

export interface SequenceLoad {
  sequenceId: string;
  browserId: string;
  frameIds: string[];
}

/** The numeric value a frame label carries ("250 ms" -> 250), or its ordinal when it has none. */
export function indexOf(label: string, ordinal: number): { value: string; numeric: boolean } {
  const m = /(-?\d+(?:\.\d+)?)/.exec(label);
  return m ? { value: m[1], numeric: true } : { value: String(ordinal), numeric: false };
}

/**
 * Put the frames of a sequence into the scene: each frame an image node (hidden from the Scene
 * list, `sequence` naming its owner), the first one placed in the slice views, then the sequence
 * and its browser. Returns the ids; the caller reports.
 */
export async function loadSequenceIntoScene(
  live: LiveScene, store: LocalBlobStore,
  frames: Volume[], labels: string[],
  opts: { name: string; indexName?: string; indexUnit?: string; meta?: Record<string, unknown>; timing?: FrameTiming[]; onFrame?: (i: number, n: number) => void },
): Promise<SequenceLoad> {
  if (!frames.length) throw new Error("a sequence needs at least one frame");
  const stamp = Date.now().toString(36);
  const sequenceId = `local-sequence-${stamp}`;
  const browserId = `local-sequenceBrowser-${stamp}`;
  const allNumeric = labels.every((l, i) => indexOf(l, i).numeric);
  const unit = opts.indexUnit ?? (allNumeric && /ms\b/.test(labels[0]) ? "ms" : allNumeric ? "" : "");
  const frameIds: string[] = [];
  const items: SequenceItem[] = [];
  for (const [i, vol] of frames.entries()) {
    opts.onFrame?.(i, frames.length);
    const named = vol as Volume & { name?: string; meta?: Record<string, unknown> };
    named.name = `${opts.name} · ${labels[i]}`;
    named.meta = { ...(named.meta ?? {}), ...(opts.meta ?? {}), frame: i, frameLabel: labels[i] };
    const r = await loadVolumeIntoScene(live, store, vol, { name: named.name, place: i === 0, extra: { hidden: true, sequence: sequenceId } });
    frameIds.push(r.imageId);
    items.push({ index: indexOf(labels[i], i).value, node: r.imageId, ...frameTime(opts.timing, i) });
  }
  const bpm = opts.timing?.find((t) => t.bpm)?.bpm;
  live.write({ op: "put", id: sequenceId, node: {
    type: "sequence", id: sequenceId, name: opts.name,
    indexName: opts.indexName ?? (unit === "ms" ? "delay after R-wave" : "frame"),
    indexUnit: unit, indexType: allNumeric ? "numeric" : "text", numericIndexValueTolerance: 0.001,
    items, ...(bpm ? { heartRateBpm: bpm } : {}),
    source: { mrmlClass: "vtkMRMLSequenceNode" }, origin: { local: true, ...(opts.meta ?? {}) },
  } as unknown as MrsonNode });
  live.write({ op: "put", id: browserId, node: {
    type: "sequenceBrowser", id: browserId, name: `${opts.name} browser`,
    sequences: [{ sequence: sequenceId, proxy: frameIds[0], playback: true }],
    selectedItemNumber: 0, playbackActive: false, playbackRateFps: 4, playbackLooped: true,   // 4, not Slicer's 10 (Ron, 2026-09-25)
    source: { mrmlClass: "vtkMRMLSequenceBrowserNode" }, origin: { local: true },
  } as unknown as MrsonNode });
  return { sequenceId, browserId, frameIds };
}

/**
 * A frame's time in seconds for the sequence node: the R-wave delay when the frame has one (a
 * cardiac phase), else seconds since the first frame's acquisition (a clock sequence). Nothing when
 * the scanner said neither, and the sequence then has no real-time schedule.
 */
export function frameTime(timing: FrameTiming[] | undefined, i: number): { time?: number } {
  const t = timing?.[i];
  if (!t) return {};
  if (typeof t.delayMs === "number") return { time: t.delayMs / 1000 };
  const first = timing?.find((x) => typeof x.timeSec === "number")?.timeSec;
  if (typeof t.timeSec === "number" && typeof first === "number") return { time: Math.round((t.timeSec - first) * 1000) / 1000 };
  return {};
}

/** The frame the browser is on, and the frames it can be on. */
export function browserFrames(live: LiveScene, browserId: string): { frames: SequenceItem[]; selected: number; sequence: MrsonNode | undefined } {
  const b = live.nodes.get(browserId);
  const first = ((b?.sequences as { sequence: string }[] | undefined) ?? [])[0];
  const seq = first ? live.nodes.get(first.sequence) : undefined;
  return { frames: ((seq?.items as SequenceItem[] | undefined) ?? []), selected: (b?.selectedItemNumber as number | undefined) ?? 0, sequence: seq };
}

/** Scrub: one op, which the displayable manager turns into the views moving. */
export function selectFrame(live: LiveScene, browserId: string, n: number): void {
  const { frames } = browserFrames(live, browserId);
  if (!frames.length) return;
  const k = ((n % frames.length) + frames.length) % frames.length;
  // ONE op, not two: every subscriber of the browser -- the companion step, the transport, the
  // Sequences panel's curve, the Volume Rendering panel's list -- ran twice per step when the
  // frame number and the proxy were written separately (critic, 2026-09-19, finding 3).
  const b = live.nodes.get(browserId)!;
  const sequences = ((b.sequences as { sequence: string; proxy?: string; playback?: boolean }[] | undefined) ?? []).map((x, i) => i === 0 ? { ...x, proxy: frames[k].node } : x);
  live.write({ op: "put", id: browserId, node: { ...b, selectedItemNumber: k, sequences } });
}

/** Every browser in the scene, for the module's list. */
export function sequenceBrowsers(live: LiveScene): MrsonNode[] {
  return [...live.nodes.values()].filter((n) => n.type === "sequenceBrowser");
}

/**
 * The frames currently on screen, one per browser: the image nodes a list of "what is loaded"
 * should show although they are `hidden` (a sequence's frames are, so ten frames do not become
 * ten rows). Keyed by frame id; the value is the name to show, the sequence's plus the frame's.
 */
export function currentFrames(live: LiveScene): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of sequenceBrowsers(live)) {
    const { frames, selected, sequence } = browserFrames(live, b.id);
    const f = frames[selected];
    if (!f) continue;
    const unit = (sequence?.indexUnit as string | undefined) ?? "";
    out.set(f.node, `${(sequence?.name as string) ?? "sequence"} · ${f.index}${unit ? " " + unit : ""}`);
  }
  // The companions' current members too (a segmentation sequence's member for this frame).
  for (const [id, name] of currentCompanions(live)) out.set(id, name);
  return out;
}

/**
 * A NODE MADE ON ONE FRAME JOINS THE SEQUENCE AT THAT FRAME.
 *
 * Slicer's model, which Steve's docs/SEQUENCES-CINE.md sets out: a browser advances several
 * synchronized sequences on one index -- the images, and the segmentations made on them -- and
 * SlicerHeart's per-phase work is built on exactly that. Here a segmentation whose `source` is a
 * frame of a sequence goes into a COMPANION sequence in the same browser (`sequences[1..]`), at the
 * frame's own index value, so the browser steps it with the images: the heart's surfaces beat with
 * the heart. Ron: "the segmentations move in the slice viewers but not in the 3D viewer" -- they
 * did not move anywhere; one segmentation stood still while the CT under it changed.
 *
 * Which companion: the one whose members carry this node's name (the chambers of every phase are
 * all "ts:heartchambers_highres of ..."), else a new one. A frame that already has a member with
 * this name is replaced by the newer one, which leaves the sequence as an ordinary node. The node
 * is marked `sequence` and `hidden` like a frame is, so the Scene list shows one row for the
 * sequence; the displayable manager shows the member for the frame on screen and hides the rest.
 */
export function joinSequence(live: LiveScene, nodeId: string): { browserId: string; sequenceId: string; index: string } | null {
  const node = live.nodes.get(nodeId); if (!node) return null;
  const src = ((node.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
  const frame = src ? live.nodes.get(src) : undefined;
  const masterId = frame?.sequence as string | undefined;
  if (!masterId) return null;
  const master = live.nodes.get(masterId); if (!master) return null;
  const browser = sequenceBrowsers(live).find((b) => ((b.sequences as { sequence: string }[] | undefined) ?? [])[0]?.sequence === masterId);
  if (!browser) return null;
  const masterItem = ((master.items as SequenceItem[] | undefined) ?? []).find((it) => it.node === src);
  if (!masterItem) return null;
  const synced = ((browser.sequences as { sequence: string; proxy?: string; playback?: boolean }[] | undefined) ?? []).slice();
  const memberName = (seq: MrsonNode | undefined) => { const first = ((seq?.items as SequenceItem[] | undefined) ?? [])[0]; return first ? live.nodes.get(first.node)?.name : undefined; };
  let companion = synced.slice(1).map((s) => live.nodes.get(s.sequence)).find((s) => s && (s.name === node.name || memberName(s) === node.name));
  if (!companion) {
    const id = `local-sequence-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    companion = {
      type: "sequence", id, name: node.name,
      indexName: master.indexName, indexUnit: master.indexUnit, indexType: master.indexType, numericIndexValueTolerance: master.numericIndexValueTolerance,
      items: [], companionOf: masterId,
      source: { mrmlClass: "vtkMRMLSequenceNode" }, origin: { local: true },
    } as unknown as MrsonNode;
    live.write({ op: "put", id, node: companion });
    synced.push({ sequence: id, proxy: nodeId, playback: true });
  }
  const items = ((companion.items as SequenceItem[] | undefined) ?? []).slice();
  const at = items.findIndex((it) => it.index === masterItem.index);
  if (at >= 0) {
    const old = items[at].node;
    if (old !== nodeId) { live.write({ op: "patch", id: old, path: "#/sequence", value: null }); live.write({ op: "patch", id: old, path: "#/hidden", value: false }); }
    items[at] = { ...items[at], node: nodeId };
  } else {
    items.push({ index: masterItem.index, node: nodeId, ...(masterItem.time !== undefined ? { time: masterItem.time } : {}) });
    const order = new Map(((master.items as SequenceItem[] | undefined) ?? []).map((it, i) => [it.index, i]));
    items.sort((a, b) => (order.get(a.index) ?? 0) - (order.get(b.index) ?? 0));
  }
  live.write({ op: "patch", id: companion.id, path: "#/items", value: items });
  live.write({ op: "patch", id: nodeId, path: "#/sequence", value: companion.id });
  live.write({ op: "patch", id: nodeId, path: "#/hidden", value: true });
  // A PHASE JOINING A FAMILY GIVEN SURFACE MODELS DOES NOT TAKE THEM. Ron, 2026-09-24: "Surfaces should only
  // be available if they have been created in the firewalled section. No implicit or accidental creation."
  // Generate Surface Models shows the family as "k of m phases have none" with "Generate the rest".
  // The browser last, so the displayable manager sees the whole picture in one change.
  live.write({ op: "patch", id: browser.id, path: "#/sequences", value: synced });
  return { browserId: browser.id, sequenceId: companion.id, index: masterItem.index };
}

/**
 * THE MEMBER OF A COMPANION SEQUENCE THAT GOES WITH THE MASTER'S FRAME: the item with the same
 * index value, else the latest earlier one (Slicer's default for a missing item is to keep the
 * previous), else the first. Nothing for an empty companion.
 */
export function companionItem(live: LiveScene, browserId: string, k: number): SequenceItem | undefined {
  const b = live.nodes.get(browserId);
  const synced = (b?.sequences as { sequence: string }[] | undefined) ?? [];
  const master = synced[0] ? live.nodes.get(synced[0].sequence) : undefined;
  const seq = synced[k] ? live.nodes.get(synced[k].sequence) : undefined;
  if (!master || !seq) return undefined;
  const masterItems = (master.items as SequenceItem[] | undefined) ?? [];
  const sel = Math.max(0, Math.min(masterItems.length - 1, (b?.selectedItemNumber as number | undefined) ?? 0));
  return memberAt(seq, master, sel);
}

/** The member of `companion` for the master's `sel`-th frame (same index, else the latest earlier, else the first). */
function memberAt(companion: MrsonNode, master: MrsonNode, sel: number): SequenceItem | undefined {
  const order = new Map(((master.items as SequenceItem[] | undefined) ?? []).map((it, i) => [it.index, i]));
  const items = ((companion.items as SequenceItem[] | undefined) ?? []).filter((it) => order.has(it.index)).sort((a, b) => order.get(a.index)! - order.get(b.index)!);
  if (!items.length) return undefined;
  let best = items[0];
  for (const it of items) if (order.get(it.index)! <= sel) best = it;
  return best;
}

/**
 * For a node in a companion sequence and a frame of the master: the companion's member that goes
 * with that frame. The volume rendering uses it so that each frame is colorized by ITS
 * segmentation, whichever member was named. Nothing when the node is not in a companion.
 */
export function frameMate(live: LiveScene, nodeId: string, frameId: string): string | undefined {
  const node = live.nodes.get(nodeId);
  const companion = node?.sequence ? live.nodes.get(node.sequence as string) : undefined;
  const masterId = companion?.companionOf as string | undefined;
  const master = masterId ? live.nodes.get(masterId) : undefined;
  if (!companion || !master) return undefined;
  const sel = ((master.items as SequenceItem[] | undefined) ?? []).findIndex((it) => it.node === frameId);
  if (sel < 0) return undefined;
  return memberAt(companion, master, sel)?.node;
}

/** The current member of every companion sequence in the scene: node id -> "<sequence> · <index>". */
export function currentCompanions(live: LiveScene): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of sequenceBrowsers(live)) {
    const synced = (b.sequences as { sequence: string }[] | undefined) ?? [];
    for (let k = 1; k < synced.length; k++) {
      const it = companionItem(live, b.id, k);
      const seq = live.nodes.get(synced[k].sequence);
      if (it && seq) out.set(it.node, `${seq.name as string} · ${it.index}${seq.indexUnit ? " " + seq.indexUnit : ""}`);
    }
  }
  return out;
}

/**
 * Is this frame the one its browser shows? `null` when the image is not a frame of a sequence.
 * A segmentation made on a frame that is NOT on screen enters the scene dark (joinSequence
 * would darken it a moment later anyway): built visible first, its slice overlay and a 3D
 * presence volume were made for nothing -- on a gated coronary CTA, the sixth segmentation to
 * arrive that way took the GPU down ("Generated pipeline layout is not valid", 2026-09-13).
 */
export function frameIsCurrent(live: LiveScene, imageId: string): boolean | null {
  const seqId = live.nodes.get(imageId)?.sequence as string | undefined;
  if (!seqId) return null;
  const b = sequenceBrowsers(live).find((x) => ((x.sequences as { sequence: string }[] | undefined) ?? [])[0]?.sequence === seqId);
  if (!b) return null;
  const { frames, selected } = browserFrames(live, b.id);
  return frames[selected]?.node === imageId;
}
