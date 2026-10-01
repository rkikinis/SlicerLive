// NAMED LOOKS FOR THE 3D VIEW: one click, several settings, and the click back.
//
// Ron, 2026-09-20, on seeing the critic's window with half-transparent surfaces over a bone
// volume rendering: "named optional look. Not the default." And on what he wants to see first on
// a whole-body case with vessel networks: "ribcage off, lungs transparent, vessels visible. Same
// for liver."
//
// A look SETS what is shown -- opacities, visibilities, the volume rendering -- and nothing about
// how it is lit: the lighting is the person's and stays. The DRAWING LOOK is the one exception,
// and not by choice: its pass draws every surface opaque (measured 2026-09-20: lungs at opacity
// 0.25 read solid with it on, see-through with it off), so a see-through look switches it off and
// "Surfaces" switches it back. Ron asked "Can I turn drawing look on for glass over bone?" -- not
// until that pass honors alpha; the switch under Advanced says so. Every change a look makes is
// remembered, so "Surfaces" puts back exactly what the look changed and not what the person had
// set by hand before it (a rib hidden on purpose stays hidden).
//
// Nothing here reaches into a renderer: it writes nodes, the managers draw them.
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { RIBCAGE, VESSEL_CONTEXTS } from "../../logic/anatomy/contexts.ts";
import { browserFrames, sequenceBrowsers } from "../../logic/sequences.ts";

export type LookName = "Surfaces" | "Glass over bone" | "Vessels in context";

export const LOOKS: { name: LookName; tip: string }[] = [
  // Named "Surfaces" in the code only: on screen it is "the structures opaque" -- solid from the labels, or
  // surface models where Generate Surface Models made them (critic, 2026-09-24, finding 10).
  { name: "Surfaces", tip: "Every visible segmentation opaque, no volume rendering: drawn solid from its labels, or as surface models where you generated them. The default; puts back what another look changed." },
  { name: "Glass over bone", tip: "Every visible segmentation at half opacity over a volume rendering of its volume (CT-Bone on a CT; the data window otherwise): the colored anatomy shows through the glass." },
  { name: "Vessels in context", tip: "For every vessel network in the view: the organ it runs through goes see-through, the vessels stay opaque, and the rib cage in front is hidden. Ron's preferred first view of a whole-body case with lung and liver vessels." },
];

type Obj = Record<string, unknown>;
/** How see-through the organ around a vessel network is drawn (0 = invisible, 1 = solid). Ron, 2026-09-20: 0.25 was "more transparent than before"; "let's try 0.35". 2026-09-24, under the solid look: "The lungs and liver are too transparent. Can you increase opacity in the entire segmentations module by 10%" -- 0.45. */
const CONTAINER_OPACITY = 0.45;
type Segment = { labelValue: number; structure?: string; fileLabel?: string; name?: string; opacity?: number; visible?: boolean };

/** What the last look changed, so Surfaces can put it back. Per segmentation: the fields as they were. */
interface Remembered { opacity?: number; segments?: Map<number, { opacity?: number; visible?: boolean }>; }
const remembered = new Map<string, Remembered>();
const vrWasOn = new Map<string, boolean>();
/** The transfer function as it was before a look put CT-Bone on it, by node id (critic, finding 6: Surfaces left CT-Bone behind). */
const tfWas = new Map<string, MrsonNode>();
let drawingWas: boolean | undefined;                 // the drawing look before a see-through look switched it off
let current: LookName = "Surfaces";

const view3d = (live: LiveScene) => [...live.nodes.values()].find((n) => n.type === "view" && n.kind === "3d");
/** A see-through look needs the drawing look off; remember what it was. */
function drawingOff(live: LiveScene) {
  const v = view3d(live); if (!v) return;
  if (drawingWas === undefined) drawingWas = v.drawingLook !== false;
  if (v.drawingLook !== false) live.write({ op: "put", id: v.id, node: { ...v, drawingLook: false } });
}

export const currentLook = (): LookName => current;

/** The model's key (`structure`, as the catalog resolved it); the file's label or the name only when there is none. */
const labelOf = (sg: Segment) => sg.structure ?? sg.fileLabel ?? sg.name ?? "";

// The segmentations on screen. A sequence family's members are `hidden` nodes (one row for the
// family) and the family step keeps the member on screen `visible` and the others not -- so
// `visible` is the test, not `hidden` (Ron, 2026-09-20, on the cardiac scene: "Glass over bone
// is not having any perceptible effect" -- every member was hidden and the look found nothing).
const visibleSegmentations = (live: LiveScene): MrsonNode[] =>
  [...live.nodes.values()].filter((n) => n.type === "segmentation" && n.visible !== false);

/** The volume a segmentation is drawn on -- for a frame of a sequence, the frame ON SCREEN, which is where the one rendering points. */
const sourceOf = (live: LiveScene, n: MrsonNode): string | undefined => {
  const src = ((n.refs as Obj | undefined)?.source as string[] | undefined)?.[0];
  const seqId = src && (live.nodes.get(src)?.sequence as string | undefined);
  if (!seqId) return src;
  const b = sequenceBrowsers(live).find((x) => ((x.sequences as { sequence: string }[] | undefined) ?? [])[0]?.sequence === seqId);
  if (!b) return src;
  const { frames, selected } = browserFrames(live, b.id);
  return frames[selected]?.node ?? src;
};

const vrOn = (live: LiveScene, imageId: string): boolean => {
  const seqId = live.nodes.get(imageId)?.sequence as string | undefined;
  for (const n of live.nodes.values()) {
    if (n.type !== "volumeRenderingDisplay") continue;
    const vol = ((n.refs as Obj | undefined)?.volume as string[] | undefined)?.[0];
    if (vol === imageId || (seqId && live.nodes.get(vol ?? "")?.sequence === seqId)) return n.visible !== false;
  }
  return false;
};

/** Remember a segmentation's fields once (the first look to touch it wins; Surfaces clears). */
function remember(n: MrsonNode, segs: Segment[]) {
  if (remembered.has(n.id)) return;
  remembered.set(n.id, { opacity: n.opacity as number | undefined, segments: new Map(segs.map((sg) => [sg.labelValue, { opacity: sg.opacity, visible: sg.visible }])) });
}

export interface LookDeps {
  setVolumeRendering: (imageId: string, on: boolean) => void;
  applyVrPreset: (imageId: string, preset: string) => void;
}

/**
 * WHAT THIS LOOK WILL COST, IN BYTES, BEFORE IT IS APPLIED.
 *
 * The colorized look builds a second copy of the volume (r16, 2 bytes a voxel) plus a copy of the
 * labelmap (1 byte), on top of what is already resident: the volume's own texture and one labelmap
 * texture per visible segmentation. On 2026-09-22 Ron had a 768x768x709 CT with FOUR whole-body
 * segmentations and switched to this look; the page was ended a minute later. The arithmetic:
 *
 *   CT texture            798 MB      (768 x 768 x 709 x 2)
 *   4 labelmaps         1,596 MB      (399 MB each)
 *   colorize copy       1,196 MB      (798 CT + 399 labels; measured, 2026-09-22)
 *                       -------
 *                       3,590 MB, before surfaces, slices and the decoded caches in the heap
 *
 * and WebKit ends a page well before 4 GB of it is actually addressable. So the look asks first
 * when it would take the window into that country, instead of the window disappearing.
 */
export function colorizeCostMB(live: LiveScene): { total: number; volumeMB: number; labelmapsMB: number; colorizeMB: number; segmentations: number } {
  const segs = visibleSegmentations(live);
  let volumeMB = 0, labelmapsMB = 0, colorizeMB = 0;
  const counted = new Set<string>();
  for (const seg of segs) {
    const src = sourceOf(live, seg);
    const img = src ? live.nodes.get(src) : undefined;
    const dims = (img?.dims as number[] | undefined) ?? (seg.dims as number[] | undefined);
    if (!dims || dims.length !== 3) continue;
    const voxels = dims[0] * dims[1] * dims[2];
    labelmapsMB += Math.round(voxels / 1048576);                       // one r8uint per segmentation
    if (src && !counted.has(src)) {
      counted.add(src);
      volumeMB += Math.round(voxels * 2 / 1048576);                    // the volume's own r16 texture
      colorizeMB += Math.round(voxels * 3 / 1048576);                  // the colorize copy: r16 + labels
    }
  }
  return { total: volumeMB + labelmapsMB + colorizeMB, volumeMB, labelmapsMB, colorizeMB, segmentations: segs.length };
}

/** Apply a look. Returns what it did, for the status line. */
export function applyLook(live: LiveScene, name: LookName, deps: LookDeps): string {
  const segmentations = visibleSegmentations(live);
  const put = (n: MrsonNode, fields: Obj) => live.write({ op: "put", id: n.id, node: { ...n, ...fields } });
  if (name === "Surfaces") {
    let n = 0;
    for (const seg of [...live.nodes.values()].filter((x) => x.type === "segmentation")) {
      const r = remembered.get(seg.id); if (!r) continue;
      const segments = ((seg.segments as Segment[]) ?? []).map((sg) => { const was = r.segments?.get(sg.labelValue); if (!was) return sg; const { opacity: _o, visible: _v, ...rest } = sg; return { ...rest, ...(was.opacity !== undefined ? { opacity: was.opacity } : {}), ...(was.visible !== undefined ? { visible: was.visible } : {}) }; });
      const { opacity: _oo, ...rest } = seg as MrsonNode & { opacity?: number };
      live.write({ op: "put", id: seg.id, node: { ...rest, ...(r.opacity !== undefined ? { opacity: r.opacity } : {}), segments } });
      n++;
    }
    for (const [id, was] of tfWas) if (live.nodes.get(id)) live.write({ op: "put", id, node: was });
    for (const [imageId, was] of vrWasOn) if (!was) deps.setVolumeRendering(imageId, false);
    const v = view3d(live);
    if (v && drawingWas !== undefined && (v.drawingLook !== false) !== drawingWas) live.write({ op: "put", id: v.id, node: { ...v, drawingLook: drawingWas } });
    remembered.clear(); vrWasOn.clear(); tfWas.clear(); drawingWas = undefined; current = name;
    return n ? `Opaque again: ${n} segmentation${n === 1 ? "" : "s"} put back, volume rendering as it was` : "Opaque";
  }
  if (name === "Glass over bone") {
    // NOTHING TO DO IS NOT THE LOOK: with no segmentation on screen the button must not claim
    // "Colorized volume" (critic, finding 6).
    if (!segmentations.length) return "Colorized volume: no segmentation is shown, nothing to make see-through";
    drawingOff(live);
    // COUNTED BY VOLUME, NOT BY SEGMENTATION. `volumes++` inside this loop counted the same CT once
    // per segmentation, so four segmentations of one study reported "a volume rendering of 4
    // volumes" -- which reads like four copies of the CT, and was the first thing suspected when
    // the page ran out of memory on 2026-09-22.
    const rendered = new Set<string>();
    for (const seg of segmentations) {
      remember(seg, (seg.segments as Segment[]) ?? []);
      put(seg, { opacity: 0.5 });
      const src = sourceOf(live, seg);
      if (src && live.nodes.get(src)) {
        if (!vrWasOn.has(src)) vrWasOn.set(src, vrOn(live, src));
        for (const n of live.nodes.values()) {          // the transfer function this volume's rendering uses, before the preset changes it
          if (n.type !== "volumeRenderingDisplay") continue;
          const tf = ((n.refs as Obj | undefined)?.property as string[] | undefined)?.[0];
          const vol = ((n.refs as Obj | undefined)?.volume as string[] | undefined)?.[0];
          if (tf && vol && (vol === src || live.nodes.get(vol)?.sequence === live.nodes.get(src)?.sequence) && !tfWas.has(tf) && live.nodes.get(tf)) tfWas.set(tf, JSON.parse(JSON.stringify(live.nodes.get(tf))));
        }
        deps.applyVrPreset(src, "CT-Bone"); rendered.add(live.nodes.get(src)?.sequence as string ?? src);
      }
    }
    current = name;
    const volumes = rendered.size;
    return `Colorized volume: ${segmentations.length} segmentation${segmentations.length === 1 ? "" : "s"} at half opacity over a volume rendering of ${volumes} volume${volumes === 1 ? "" : "s"}`;
  }
  // VESSELS IN CONTEXT. First, which vessel networks are in the view; then, in every visible
  // segmentation, their containers go see-through, the rib cage hides, the vessels stay opaque.
  const contexts = new Set<number>();
  for (const seg of segmentations) for (const sg of (seg.segments as Segment[]) ?? []) VESSEL_CONTEXTS.forEach((c, i) => { if (c.vessels.test(labelOf(sg))) contexts.add(i); });
  if (!contexts.size) { return "Vessels in context: no vessel network is in the view (lung, liver, coronary, renal or cerebral vessels)"; }
  drawingOff(live);
  let hidden = 0, seeThrough = 0;
  for (const seg of segmentations) {
    const segs = (seg.segments as Segment[]) ?? [];
    remember(seg, segs);
    const segments = segs.map((sg) => {
      const label = labelOf(sg);
      if (RIBCAGE.test(label)) { hidden++; return { ...sg, visible: false }; }
      if ([...contexts].some((i) => VESSEL_CONTEXTS[i].container.test(label))) { seeThrough++; return { ...sg, opacity: CONTAINER_OPACITY }; }
      if ([...contexts].some((i) => VESSEL_CONTEXTS[i].vessels.test(label))) return { ...sg, opacity: 1, visible: true };
      return sg;
    });
    put(seg, { segments, opacity: 1 });
    const src = sourceOf(live, seg);
    if (src && live.nodes.get(src)) { if (!vrWasOn.has(src)) vrWasOn.set(src, vrOn(live, src)); deps.setVolumeRendering(src, false); }
  }
  current = name;
  return `Vessels in context: ${[...contexts].map((i) => VESSEL_CONTEXTS[i].says.replace(/\.$/, "")).join("; ")} — ${seeThrough} structure${seeThrough === 1 ? "" : "s"} see-through, ${hidden} of the rib cage hidden`;
}

/** When the scene's data changes under a look (a close, a new load), the memory no longer applies. */
export function forgetLooks(): void { remembered.clear(); vrWasOn.clear(); tfWas.clear(); drawingWas = undefined; current = "Surfaces"; }
