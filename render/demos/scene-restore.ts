// RESTORING A SAVED SCENE'S STATE onto what the loader has just loaded (SCENE-DESIGN §5, step 4).
//
// The data came through the browser's own load path; every node in the scene now has a live
// counterpart with a session-local id. This maps each saved node to its live one by the durable
// identity the writer stored (an instance of the series for a volume, the SEG's series for a
// segmentation, the layout name for a view or a composite, the one browser), and applies the
// saved state in dependency order -- views and composites, then displays and transfer functions,
// then the segmentations' visibility, order and colors, then the sequence's frame, then the
// camera last. A patch re-delivers the node to its manager (LiveScene.applied), so what is
// written is what is shown; nothing here reaches into a renderer.
//
// What is NOT restored is said back: a saved node with no live counterpart (its series was not
// loaded, or the loader refused it) is listed, not silently skipped.
import { firstInstance, holdsInstance } from "../../logic/instance-key.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { frameIsCurrent, selectFrame } from "../../logic/sequences.ts";
import { cardsOf, isCardList, mapCardRefs, type NameCard } from "../../logic/markups/name-cards.ts";

type Obj = Record<string, unknown>;

export interface RestoreHooks {
  setLayout?: (arrangement: number) => void;
  setSliceOffset?: (cell: string, mm: number) => void;
  /** A heart plane by name, computed from the chambers in the scene NOW rather than taken from the file. */
  cardiacReformat?: (cell: string, view: string) => Promise<boolean>;
  /** A slice view drawn in the 3D view, and which are (live-views.ts, setSliceIn3D). */
  setSliceIn3D?: (cell: string, on: boolean) => void;
  sliceIn3D?: () => string[];
}
const CARDIAC = new Set(["short-axis", "four-chamber", "two-chamber"]);

/** `notes`: what the person should hear about the markups (one added beside a changed one, a crop box kept). */
export interface RestoreReport { applied: string[]; missing: string[]; notes: string[] }

const origin = (n: MrsonNode | undefined) => (n?.origin as Obj | undefined) ?? {};
/** The live id each saved markup was put back under, per scene document: the restore runs once per arriving series and
 *  must put a markup back once, not once a pass. */
const markupIds = new WeakMap<Obj, Map<string, string>>();
/** The Crop panel's box (crop-panel.ts FITTED_ID; not imported, that module is the panel's DOM). */
const CROP_BOX_ID = "local-markup-cropbox";
/** What a markup is where it is: its points, or a box's center, size and axes. */
const geometry = (n: MrsonNode) => JSON.stringify([((n.controlPoints as { position?: unknown }[] | undefined) ?? []).map((c) => c.position), n.center ?? null, n.size ?? null, n.orientation ?? null]);
const withoutRefs = (n: Obj): Obj => { const { refs: _r, ...rest } = n; return rest; };

export function applySceneState(live: LiveScene, doc: Obj, hooks: RestoreHooks = {}): RestoreReport {
  const nodes = (doc.nodes as Record<string, Obj>) ?? {};
  const liveAll = [...live.nodes.values()];
  const map = new Map<string, string>();          // saved id -> live id
  const applied: string[] = [], missing: string[] = [], notes: string[] = [];

  // ── identity: volumes by an instance, segmentations by their SEG series ──
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "image") {
      const dcm = (n.dicom as Obj | undefined) ?? {};
      // By the file AND its frame where the volume came from a multi-frame file (logic/instance-key.ts).
      const inst = firstInstance({ sopInstanceUIDs: dcm.sopInstanceUIDs as string[] | undefined, frameNumbers: dcm.frameNumbers as number[] | undefined });
      const hit = liveAll.find((l) => l.type === "image" && holdsInstance(origin(l) as { sopInstanceUIDs?: string[]; frameNumbers?: number[] }, inst))
        ?? liveAll.find((l) => l.type === "image" && (origin(l).seriesInstanceUID === dcm.seriesInstanceUID || origin(l).savedSeriesInstanceUID === dcm.seriesInstanceUID));
      if (hit) map.set(id, hit.id); else missing.push(`a volume of series …${String(dcm.seriesInstanceUID ?? "").slice(-8)}${n.frameLabel ? ` (${n.frameLabel})` : ""}`);
    }
    if (n.type === "segmentation") {
      const uid = ((n.dicom as Obj | undefined) ?? {}).seriesInstanceUID;
      const hit = liveAll.find((l) => l.type === "segmentation" && (origin(l).savedSeriesInstanceUID === uid || origin(l).seriesInstanceUID === uid));
      if (hit) map.set(id, hit.id); else missing.push(`${n.name ?? "a segmentation"}`);
    }
  }
  // Displays follow their volume; the transfer function follows its rendering display.
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "scalarVolumeDisplay") {
      const owner = Object.entries(nodes).find(([, m]) => m.type === "image" && ((m.refs as Obj | undefined)?.display as string[] | undefined)?.includes(id));
      const liveImg = owner && map.get(owner[0]);
      const liveDisp = liveImg && ((live.nodes.get(liveImg)?.refs as Obj | undefined)?.display as string[] | undefined)?.[0];
      if (liveDisp) map.set(id, liveDisp);
    }
    if (n.type === "volumeRenderingDisplay") {
      const vol = ((n.refs as Obj | undefined)?.volume as string[] | undefined)?.[0];
      const liveVol = vol && map.get(vol);
      // One rendering per sequence: it points at whichever frame is on screen, so a display saved
      // on frame 4 matches the live one through the sequence, not only through the frame.
      const liveSeq = liveVol && (live.nodes.get(liveVol)?.sequence as string | undefined);
      const hit = liveVol && (liveAll.find((l) => l.type === "volumeRenderingDisplay" && ((l.refs as Obj | undefined)?.volume as string[] | undefined)?.[0] === liveVol)
        ?? (liveSeq ? liveAll.find((l) => l.type === "volumeRenderingDisplay" && live.nodes.get(((l.refs as Obj | undefined)?.volume as string[] | undefined)?.[0] ?? "")?.sequence === liveSeq) : undefined));
      if (hit) {
        map.set(id, hit.id);
        const tf = ((n.refs as Obj | undefined)?.transferFunction as string[] | undefined)?.[0];
        const liveTf = ((hit.refs as Obj | undefined)?.property as string[] | undefined)?.[0];
        if (tf && liveTf) map.set(tf, liveTf);
      }
    }
    if (n.type === "view" && n.kind === "slice" && typeof n.layoutName === "string") {
      const hit = liveAll.find((l) => l.type === "view" && l.kind === "slice" && l.layoutName === n.layoutName);
      if (hit) map.set(id, hit.id);
    }
    if (n.type === "view" && n.kind === "3d") { const hit = liveAll.find((l) => l.type === "view" && l.kind === "3d"); if (hit) map.set(id, hit.id); }
    if (n.type === "camera") { const hit = liveAll.find((l) => l.type === "camera"); if (hit) map.set(id, hit.id); }
    if (n.type === "sliceComposite" && typeof n.layoutName === "string") {
      const hit = liveAll.find((l) => l.type === "sliceComposite" && l.layoutName === n.layoutName);
      if (hit) map.set(id, hit.id);
    }
    if (n.type === "sequenceBrowser") { const hit = liveAll.find((l) => l.type === "sequenceBrowser"); if (hit) map.set(id, hit.id); }
  }
  const mapRef = (id: unknown) => (typeof id === "string" ? map.get(id) : undefined);
  /** Writes only what differs, and SAYS whether it wrote: this runs again after every series that
   *  arrives, and a hook fired on a pass that changed nothing undoes what the person did in
   *  between (critic, 2026-09-22, finding 9). */
  const patch = (liveId: string, fields: Obj, what: string): boolean => {
    const cur = live.nodes.get(liveId); if (!cur) return false;
    const changed: Obj = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && JSON.stringify(cur[k]) !== JSON.stringify(v)) changed[k] = v;
    if (!Object.keys(changed).length) return false;
    live.write({ op: "put", id: liveId, node: { ...cur, ...changed } });
    applied.push(what);
    return true;
  };

  // ── 1. the layout, the slice views, the composites ──
  const layout = Object.values(nodes).find((n) => n.type === "layout");
  if (layout && typeof layout.arrangement === "number") { hooks.setLayout?.(layout.arrangement); applied.push("layout"); }
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "sliceComposite") {
      const liveId = map.get(id); if (!liveId) continue;
      const refs = n.refs as Record<string, string[]> | undefined;
      // A LAYER WHOSE VOLUME HAS NOT ARRIVED IS LEFT ALONE, not emptied. This maps each saved layer
      // to what is live and drops what is not -- and during a progressive load "not yet" looks the
      // same as "gone", so a background whose series loads second was written as `[]`: a blank slice
      // view until it landed (critic, 2026-09-22, finding 9).
      const mapped = refs
        ? Object.fromEntries(Object.entries(refs).flatMap(([k, v]) => {
          const live2 = v.map(mapRef).filter(Boolean);
          return live2.length || !v.length ? [[k, live2]] : [];
        }))
        : undefined;
      patch(liveId, { ...(mapped ? { refs: mapped } : {}), foregroundOpacity: n.foregroundOpacity, labelOpacity: n.labelOpacity, compositing: n.compositing, linkedControl: n.linkedControl }, `${n.layoutName} composite`);
    }
  }
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "view" && n.kind === "slice") {
      const liveId = map.get(id); if (!liveId) continue;
      // THE SLICE IN 3D, which was saved and never put back (Ron, 2026-09-24: the green view came back without it).
      // Before the plane, so it follows whichever plane the view ends up on; a pass before the volume has arrived
      // changes nothing (setSliceIn3D needs one) and the next pass tries again.
      if (typeof n.visibleIn3D === "boolean" && typeof n.layoutName === "string" && hooks.setSliceIn3D && hooks.sliceIn3D && hooks.sliceIn3D().includes(n.layoutName) !== n.visibleIn3D) {
        hooks.setSliceIn3D(n.layoutName, n.visibleIn3D);
        if (hooks.sliceIn3D().includes(n.layoutName) === n.visibleIn3D) applied.push(`${n.layoutName} slice ${n.visibleIn3D ? "shown" : "hidden"} in 3D`);
      }
      // A NAMED HEART PLANE IS RECOMPUTED, not copied: "four-chamber" in the file means the
      // four-chamber plane as this build defines it (Ron, 2026-09-20, after the plane was turned
      // to read like the two-chamber: a scene saved before still "points to the heavens"). The
      // file's matrix is the fallback when no chambers are in the scene.
      // AND RECOMPUTED ONCE. This whole function runs again after every series that arrives, and
      // each pass recomputed the plane from the chambers in the scene AT THAT MOMENT -- on the
      // cardiac CTA (five phases) that is a plane computed from an incomplete set, four times over,
      // each one moving the views under the person (critic, 2026-09-22, finding 9).
      if (typeof n.orientation === "string" && CARDIAC.has(n.orientation) && hooks.cardiacReformat && typeof n.layoutName === "string" && live.nodes.get(liveId)?.orientation !== n.orientation) {
        // The plane is recomputed and the saved framing kept on it: the person's zoom (the field
        // of view) and where along the normal they had scrolled (the offset). Not awaited here
        // because this function is synchronous for everything else; the report says what it
        // asked for, and the fallback puts the file's plane back if no chambers are found.
        const name = n.layoutName, orient = n.orientation, fov = n.fieldOfView, off = n.offset;
        void hooks.cardiacReformat(name, orient).then((ok) => {
          if (!ok) { patch(liveId, { orientation: orient, sliceToRAS: n.sliceToRAS, fieldOfView: fov, offset: off }, `${name} view`); return; }
          if (fov) patch(liveId, { fieldOfView: fov }, `${name} zoom`);
        });
        applied.push(`${name} view (${orient}, recomputed from the chambers)`);
        continue;
      }
      const moved = patch(liveId, { orientation: n.orientation, sliceToRAS: n.sliceToRAS, fieldOfView: n.fieldOfView, offset: n.offset }, `${n.layoutName} view`);
      if (moved && typeof n.offset === "number" && typeof n.layoutName === "string") hooks.setSliceOffset?.(n.layoutName, n.offset);
    }
  }
  // ── 2. THE FRAME, BEFORE ANYTHING PER FRAME. The sequence manager hands the leaving frame's
  // window/level to the arriving one and the companion step hands the leaving member's state to
  // the arriving member; applied after the displays, that step undid them (critic, 2026-09-20,
  // finding 1). So the frame goes first, and what follows lands on the frame on screen.
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type !== "sequenceBrowser") continue;
    const liveId = map.get(id); if (!liveId) continue;
    const cur = live.nodes.get(liveId)!;
    patch(liveId, { playbackRateFps: n.playbackRateFps, playbackLooped: n.playbackLooped }, "playback");
    if (typeof n.selectedItemNumber === "number" && n.selectedItemNumber !== cur.selectedItemNumber) { selectFrame(live, liveId, n.selectedItemNumber); applied.push(`frame ${n.selectedItemNumber + 1}`); }
  }
  // ── 3. displays and transfer functions ──
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "scalarVolumeDisplay") {
      const liveId = map.get(id); if (!liveId) continue;
      patch(liveId, { visible: n.visible, window: n.window, level: n.level, autoWindowLevel: false, interpolate: n.interpolate, applyThreshold: n.applyThreshold, threshold: n.threshold, color: n.color }, "window/level");
    }
    if (n.type === "transferFunction") {
      const liveId = map.get(id); if (!liveId) continue;
      const sh = n.shading as { ambient: number; diffuse: number; specular: number; power: number } | undefined;
      patch(liveId, { colorStops: n.colorStops, scalarOpacity: n.scalarOpacity, gradientOpacity: n.gradientOpacity, preset: n.preset, ...(sh ? { shade: [sh.ambient, sh.diffuse, sh.specular, sh.power] } : {}), segmentGroups: n.segmentGroups, contextOpacity: n.contextOpacity, ctModulation: n.ctModulation, segmentOpacity: n.segmentOpacity }, "transfer function");
    }
    if (n.type === "volumeRenderingDisplay") { const liveId = map.get(id); if (liveId) patch(liveId, { visible: n.visible }, "volume rendering"); }
    // THE VOLUME'S 3D LOOK (Scene › In 3D; render/look3d.ts). Left out, every scene came back Colored
    // whatever it was saved as (critic, 2026-09-24, finding 2).
    if (n.type === "image" && typeof n.look3D === "string") { const liveId = map.get(id); if (liveId) patch(liveId, { look3D: n.look3D === "colored" ? "solid" : n.look3D }, "3D look"); }
  }
  // ── 4. segmentations: visibility, order, colors, per-segment state ──
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type !== "segmentation") continue;
    const liveId = map.get(id); if (!liveId) continue;
    const cur = live.nodes.get(liveId)!;
    const saved = (n.segments as Obj[]) ?? [];
    const segments = ((cur.segments as Obj[]) ?? []).map((sg) => {
      const s = saved.find((x) => x.labelValue === sg.labelValue);
      if (!s) return sg;
      const c = s.color as number[] | undefined;
      // Name, color, visibility AND opacity: a scene saved with see-through organs came back
      // solid (Ron, 2026-09-20: "The scene does not adjust transparency").
      const { opacity: _o, ...base } = sg;
      return { ...base, ...(s.name !== undefined ? { name: s.name } : {}), ...(c ? { color: c.slice(0, 3) } : {}), ...(s.visible !== undefined ? { visible: s.visible } : {}), ...(typeof s.opacity === "number" ? { opacity: s.opacity } : {}) };
    });
    // A member of a sequence family: its `visible` in the file is the family step's own flag
    // (which member is on screen), not a choice. The member on screen takes the file's word;
    // the others stay as the step left them (dark), or the whole family would go dark.
    const src = ((cur.refs as Obj | undefined)?.source as string[] | undefined)?.[0];
    const onScreen = cur.sequence ? (src ? frameIsCurrent(live, src) : null) : null;
    const visible = cur.sequence && onScreen === false ? undefined : n.visible;
    // UNSET IN THE FILE MEANS "FOLLOWS VISIBLE": a member that joined its family arrives with visible3D false, and
    // skipping the unset value left the family's member on screen out of 3D (2026-09-24, the coronaries on the
    // beating heart came back in the slices only).
    const visible3D = n.visible3D !== undefined ? n.visible3D
      : cur.sequence && onScreen === false ? undefined
      : cur.visible3D === false ? n.visible !== false : undefined;
    // `mergedGroups` IS PART OF THE PICTURE: it is what the views paint when a branch of the tree
    // is folded (24 ribs in one color). Left out here, a scene came back with every structure in
    // its own color however it had been saved -- Ron, 2026-09-22: "The scene does not fully
    // recover the segmentations settings that I had at save time."
    // `surfaceModels`: the segmentation was given surface models (Generate Surface Models) -- a saved
    // choice, like the rest; without it a scene came back without them (critic, 2026-09-24, finding 2).
    patch(liveId, { segments, visible, visible3D, opacity: n.opacity, zOrder: n.zOrder, hiddenViews: n.hiddenViews, fill2D: n.fill2D, outline2D: n.outline2D, mergedGroups: n.mergedGroups, ...(typeof n.surfaceModels === "boolean" ? { surfaceModels: n.surfaceModels } : {}),
      // Where its colors came from (logic/scheme-colors.ts): the scene's word; for a scene saved before the field, "scene"
      // over the load's "file" -- the colors just applied are the scene's. Nothing where the load set none (a file saved
      // and read back stays the same file).
      colorScheme: n.colorScheme !== undefined ? n.colorScheme : cur.colorScheme !== undefined ? "scene" : undefined }, n.name as string ?? "segmentation");
  }
  // ── 5. the 3D view and, last, the camera ──
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "view" && n.kind === "3d") {
      const liveId = map.get(id); if (!liveId) continue;
      const sh = n.shading as { ambient: number; diffuse: number; specular: number; power: number } | undefined;
      patch(liveId, { drawingLook: n.drawingLook, ...(typeof n.shadingVersion === "number" ? { shadingVersion: n.shadingVersion } : {}), boxVisible: n.boxVisible, axisLabelsVisible: n.axisLabelsVisible, orientationMarkerType: n.orientationMarkerType, lighting: n.lighting, ...(sh ? { shade: [sh.ambient, sh.diffuse, sh.specular, sh.power] } : {}) }, "3D view");
    }
  }
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type === "camera") { const liveId = map.get(id); if (liveId) patch(liveId, { position: n.position, focalPoint: n.focalPoint, viewUp: n.viewUp, viewAngle: n.viewAngle, parallelProjection: n.parallelProjection, parallelScale: n.parallelScale }, "camera"); }
  }
  // ── 6. markups: points, lines, curves, boxes and name cards, which a person made and nothing else brings back ──
  // (the writer has saved them since the scene format began; the restore never put them back -- found 2026-10-02 with the
  // name cards). A name card's segmentation is the live one by the saved id's identity; on a pass before that
  // segmentation has arrived the card waits without it, and a later pass fills it in.
  const ids = markupIds.get(doc) ?? new Map<string, string>();
  markupIds.set(doc, ids);
  for (const [id, n] of Object.entries(nodes)) {
    if (n.type !== "markup") continue;
    const cards = isCardList(n as MrsonNode) ? mapCardRefs(cardsOf(n as MrsonNode), (sid) => map.get(sid)) : undefined;
    if (cards) for (const c of cardsOf(n as MrsonNode)) if (c.associatedNodeID && !map.has(c.associatedNodeID)) missing.push(`name card ${c.label || "(no title)"}: its segmentation`);
    const done = ids.get(id);
    if (done) {
      // PUT BACK ON AN EARLIER PASS: the person's now. Deleted since, it stays deleted (critic 2026-10-02, finding 12);
      // only a card still waiting for its segmentation is filled in.
      const cur = cards && live.nodes.get(done);
      if (cards && cur) {
        const now = cardsOf(cur);
        const filled = now.map((c) => { const k = cards.find((x) => x.id === c.id); return !c.associatedNodeID && k?.associatedNodeID ? { ...c, associatedNodeID: k.associatedNodeID, segment: k.segment } as NameCard : c; });
        if (filled.some((c, i) => c !== now[i])) patch(done, { controlPoints: filled }, "name cards");
      }
      continue;
    }
    let kin: MrsonNode[] = [];
    if (cards) {
      // ONE CARD LIST A SCENE (name-cards.ts): a scene opened on top of cards already there adds its cards to that list.
      const there = [...live.nodes.values()].find((x) => isCardList(x));
      if (there) {
        ids.set(id, there.id as string);
        const have = new Set(cardsOf(there).map((c) => c.id));
        patch(there.id as string, { controlPoints: [...cardsOf(there), ...cards.filter((c) => !have.has(c.id))] }, String(n.name ?? "name cards"));
        continue;
      }
    } else {
      // THE SAME MARKUP ALREADY HERE -- the scene opened again over its own study (critic 2026-10-02, finding 2: a second
      // and a third copy of every point list and crop box): same kind, name and geometry, so it is that one. A live markup
      // is matched at most once, and never one this open has just put back: two saved lists stay two (round 2, finding 4).
      const claimed = new Set(ids.values());
      kin = [...live.nodes.values()].filter((x) => x.type === "markup" && !isCardList(x) && !claimed.has(x.id as string) && x.markupType === n.markupType && x.name === n.name);
      const same = kin.find((x) => geometry(x) === geometry(n as MrsonNode));
      if (same) { ids.set(id, same.id as string); continue; }
      // THE CROP BOX goes back under the Crop panel's own id (crop-panel.ts FITTED_ID), so the panel finds it and its
      // "Fit a box" moves this box instead of drawing a second. One already here is the person's: kept, and said.
      if (n.markupType === "roi" && n.name === "Crop box") {
        ids.set(id, CROP_BOX_ID);
        if (live.nodes.has(CROP_BOX_ID)) { notes.push("the crop box here was kept; the scene's is in a different place"); continue; }
        live.write({ op: "put", id: CROP_BOX_ID, node: { ...withoutRefs(n), id: CROP_BOX_ID, origin: { local: true } } as unknown as MrsonNode });
        applied.push("crop box");
        continue;
      }
    }
    const liveId = `local-markup-scene-${Math.random().toString(36).slice(2, 8)}-${id}`;
    ids.set(id, liveId);
    if (kin.length) notes.push(`"${String(n.name)}" from the scene was added beside the one already here (they differ)`);
    live.write({ op: "put", id: liveId, node: { ...withoutRefs(n), id: liveId, ...(cards ? { controlPoints: cards } : {}), origin: { local: true } } as unknown as MrsonNode });
    applied.push(String(n.name ?? "markup"));
  }
  return { applied, missing, notes };
}
