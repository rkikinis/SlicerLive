// LiveScene — the SlicerLive client that mirrors a live Slicer scene the way Slicer's own
// displayable managers do. A view creates DisplayableManagers; each declares the mrson node
// `types` it cares about. LiveScene opens a WebSocket to the LiveStory mrson live server,
// subscribes with the union of those types, and routes the streamed mrson events to the
// interested managers. The initial burst is a snapshot (NodeAdded per node = a static
// declaration); afterwards it's an adaptive stream of change notifications.
//
// Same code runs in the browser and in Deno (both have global WebSocket + fetch).

import { SeriesField } from "./series-field.ts";
import { type Field, hasSharedTexture, ImageField } from "./fields.ts";
import { SLICER_VR_SHADE, type Shade } from "./shading.ts";
import { ColorizeField } from "./colorize-field.ts";
import { segLookOf } from "./look3d.ts";
import { paddedGrid } from "../algorithms/close-labels.ts";
import { makeMergedLabelTexture, mergeLabels } from "./solid-merge.ts";
import { SLICER_BG_BOTTOM, SLICER_BG_TOP } from "./background.ts";
import { FiducialField, type Sphere } from "./fiducial-field.ts";
import { sceneVoxel } from "./scene-scale.ts";
import { CapsuleField, type Segment as LineSegment } from "./capsule-field.ts";
import { createRoiWidget, ROI_BAR_RGB, ROI_CENTER_RGB, ROI_HANDLE_RGB, type RoiWidget } from "./demos/roi-widget.ts";
import { registerTerminology, terminologies, type TerminologySource, unregisterTerminology } from "../logic/anatomy/terminology.ts";
import { ColorizeBaker, makeLabelPaletteTexture, writeLabelPaletteTexture } from "./bake.ts";
import { type Mat4, patientToTextureFromIjkToRAS } from "./mat4.ts";
import { boxPlanePolygon } from "../logic/crop.ts";
import { forgetDecoded, descKey, fetchZarrVolume, fetchZarrVolumeNative, getBlobFetch, knownRange, type ZarrDesc, type ZarrVolume, type ZarrVolumeNative } from "./zarr.ts";
import { rowMul, worldForNode } from "../logic/transforms.ts";
import { DEFAULT_PRESENTATION, presentationParams } from "../logic/presentation.ts";
import type { Finish } from "../logic/anatomy/palettes.ts";
import { lookupStructure } from "../logic/segment-naming.ts";
import { finishFor, onShadingVersion } from "./shading-versions.ts";
import { lutFromTransferFunctions } from "./scene-volume.ts";
import { nodeVoxel, tuned } from "./scene-scale.ts";
import type { MrsonNode } from "./mrson.ts";
import { companionItem, frameMate, sequencePlays } from "../logic/sequences.ts";
import { startWork, type Work } from "./working.ts";
import { applyOp, type ApplyResult, type Op } from "./liveops.ts";

export type Vec3 = [number, number, number];

/** The renderer surface a displayable manager drives — the SlicerLive analogue of the view
 *  a Slicer displayable manager renders into. Managers ADD/REMOVE fields (coarse -> rebuild)
 *  and REDRAW when a field changed in place (fine), per the event-granularity rule. */
export interface SlicePlane {
  orient: "axial" | "coronal" | "sagittal";   // nearest anatomical preset (display convention + fallback)
  posMm: number;                               // out-of-plane position: RAS coordinate along `orient`'s axis, or along basis.nDir
  /** Oblique / Reformat: the slice node's actual (u, v, n) RAS basis from sliceToRAS. Absent for the
   *  anatomical presets. When present, posMm is the signed distance along nDir. */
  basis?: { uDir: Vec3; vDir: Vec3; nDir: Vec3 };
  /** view chrome (vtkMRMLAbstractViewNode): orientation marker type (0 none,1 cube,2 human,3 axes), ruler type (0 none,1 thin,2 thick) */
  chrome?: { orientationMarkerType: number; orientationMarkerSize: number; rulerType: number };
  // Slicer's in-plane navigation, mirrored: the slice centre (RAS) + field of view (mm).
  // Present when the slice node carries them → the view matches Slicer's pan + zoom; absent →
  // the fitted (FitSliceToBackground) view.
  centerRAS?: number[];
  fovX?: number;
  fovY?: number;
}

/** A 2D overlay primitive in RAS — the DOM/canvas analogue of Slicer's slice-view displayable
 *  managers' actors (markup glyphs and lines, crosshair, slice intersections, annotations).
 *  Each slice cell projects these onto its plane (rasToView) and draws what lies within `slabMm`. */
export type OverlayItem =
  /** `inPlaneOnly`: draw only where it lies IN the plane. Off-plane points are otherwise drawn
   *  small and hollow -- right for a markup, which Slicer projects so you can see where it is and
   *  scroll to it, wrong for a crop-box handle, which is a control and either grabbable here or
   *  not there at all. */
  | { kind: "point"; ras: Vec3; color: number[]; radiusPx?: number; label?: string; projected?: boolean; inPlaneOnly?: boolean; ring?: boolean }
  | { kind: "polyline"; points: Vec3[]; color: number[]; widthPx?: number; closed?: boolean }
  | { kind: "text"; ras: Vec3; text: string; color: number[] };

export interface ScalarLayer { field: ImageField; win: number; lev: number; lut?: Uint8Array; interpolate?: boolean; name?: string;
  /** The image node this layer is. The view re-frames a cell when its BACKGROUND becomes a
   *  different volume, and the node id is what says so -- the field object also changes when a
   *  volume is merely re-placed by a transform, which must not re-frame anything. */
  id?: string }
export interface SliceLayers {
  background?: ScalarLayer;
  foreground?: ScalarLayer & { opacity: number; compositing: number };
  label?: { field: ImageField; table: Uint8Array; opacity: number; name?: string };
  linked?: boolean;
  /**
   * A background IS assigned to this composite, just hidden for THIS view (Subject Hierarchy's
   * per-view R/Y/G toggle) -- as opposed to no background being assigned at all. The view falls
   * back to the shared volume-rendering field when background is absent (so a scene with no
   * composite background still shows the 3D-rendered volume in 2D); without this flag, hiding one
   * view via the per-view toggle would have been silently undone by that same fallback.
   */
  backgroundSuppressed?: boolean;
  /**
   * Why this view has nothing to show, in the view's own words.
   *
   * An empty slice cell used to be indistinguishable from a broken one: hidden, never assigned,
   * still streaming and pointing at a deleted volume all rendered as the same dark rectangle, and
   * every one of them reached me as "the slices don't work". The cell states which it is.
   */
  emptyReason?: string;
}

export interface SceneMeshData {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-vertex normals, or absent for flat per-face shading (a loaded model carries none). */
  normals?: Float32Array;
  color: [number, number, number];
  opacity: number;
  /** false: resident on the GPU but not drawn (a sequence frame that is not the current one). */
  visible?: boolean;
}

export interface ThreeDChrome {
  id: string; layoutName: string; boxVisible: boolean; axisLabelsVisible: boolean;
  backgroundColor: number[]; backgroundColor2: number[]; orientationMarkerType: number; rulerType: number;
  /** The Albula profile's fields on a 3D view (SCENE-DESIGN §4), present when the node carries them. */
  drawingLook?: boolean; lighting?: string;
  /** render/shading-versions.ts: the shading version the view is shaded with (1 alike, 2 tissue finishes). */
  shadingVersion?: number;
  /** The four lighting numbers when `lighting` is not a preset's name (a scene's "custom"). */
  shade?: number[];
}

export interface MirrorView {
  /** 3D view chrome (optional): box, axis labels, background gradient, orientation marker, ruler. */
  setViewChrome?(chrome: ThreeDChrome): void;
  /** Per-view 2D overlays (optional): `cell` = a slice cell name or "*" for every slice cell;
   *  `layer` namespaces one producer (e.g. "markups"); [] clears the layer. */
  setOverlay?(cell: string, layer: string, items: OverlayItem[]): void;
  /** Per-slice-view layer stack (optional): Slicer's slice composite — background / foreground / label
   *  volumes with their own geometry, W/L, colour LUTs, opacities and compositing. Absent layers = none. */
  setSliceLayers?(cell: string, layers: SliceLayers): void;
  /** Surface meshes (models) for the 3D view (optional): world-space triangles + display colour/opacity. */
  setMeshes?(meshes: SceneMeshData[]): void;
  /**
   * Surfaces contributed by ONE source, replacing whatever that source last sent.
   *
   * `setMeshes` is the whole list, which works while models are the only thing making surfaces. They
   * are not any more: a segmentation's 3D representation is now an extracted surface too, and if it
   * called `setMeshes` it would erase the models and vice versa. Keyed so each source owns its own
   * group and the view concatenates -- the same reason the slice overlay became a list.
   */
  setMeshGroup?(key: string, meshes: SceneMeshData[]): void;
  setField(key: string, field: Field): void;   // add or replace a 3D field -> rebuild
  removeField(key: string): void;               // -> rebuild
  /** Is the colorize volume field already drawing this segmentation's segments? It is built from the
   *  scalar AND the label volume, so when it is on screen a separate segmentation field would paint
   *  the same anatomy twice. A supplier of such a field asks before building one. Asked PER
   *  SEGMENTATION: with several volumes rendered at once, one may be colorized by its own
   *  segmentation while another's segmentation still has to draw itself. No id means "any".  */
  segments3DDrawnByVolume?(segId?: string): boolean;
  /** Colored by a volume rendering (a sequence's colored volume), not counting the solid look. */
  segmentColoredByVolumeRendering?(segId: string): boolean;
  /** Notified when that answer changes; returns an unsubscribe. */
  onSegments3DChanged?(cb: () => void): () => void;
  redraw(): void;                                // an existing field changed in place
  setCamera(c: CameraState): void;
  setClipBox(lo: Vec3 | null, hi?: Vec3): void;  // null clears the crop
  // volume resource shared by the slice views and the 3D view
  setVolumeField(field: ImageField | null, wl?: { win: number; lev: number }): void;
  /** Add or replace (non-null) / remove (null) the 3D volume rendering for ONE image. Several may
   *  be present at once; the 3D view composites them together. */
  setVolume3D(imageId: string, vol: Volume3D | null): void;
  /** Replace one image's rendering with another's in ONE rebuild, so the view never passes
   *  through "nothing in 3D" between them (a sequence step). Optional: without it the two are
   *  done one after the other. */
  swapVolume3D?(prevId: string, imageId: string, vol: Volume3D | null): void;
  /** The fields in the 3D view are the same ones, but one now reads other textures (a series stepped to another
   *  frame: render/series-field.ts): rebuild the bind group and re-send the uniforms, without re-composing the view or
   *  compiling. Optional: without it the caller re-publishes. */
  rebind3d?(): void;
  // slice/MPR views and layout
  setSlicePlane(cell: string, plane: SlicePlane): void;
  setLayout(name: string): void;
  // segmentation: a crisp labelmap overlay for the slice views (fill + boundary outline,
  // each with its own opacity — mirrors Slicer's 2D fill/outline display settings)
  setSegmentationOverlay(tex: GPUTexture | null, fillOpacity: number, outlineOpacity: number): void;
  /**
   * Color the slice overlay from a LABEL volume plus a 256x2 palette, instead of from a
   * pre-colored rgba volume.
   *
   * Same picture, an eighth of the memory. A colored overlay is rgba16float -- 8 bytes a voxel,
   * 3.35 GB on a 768x768x709 study -- and it was allocated per segmentation at load, for a binding
   * only one of them can hold at a time. The label texture is r8uint and already resident, because
   * the baker uploaded it; the palette is 2 KB. Optional so a view that has not implemented it
   * keeps working through the rgba path.
   */
  setSegmentationLabelOverlay?(
    labels: GPUTexture | null,
    palette: GPUTexture | null,
    fillOpacity: number,
    outlineOpacity: number,
  ): void;
  /**
   * Every segmentation the slices should draw, at once, instead of the single one the binding above
   * can hold.
   *
   * Toggling between a general network and a specialized one is not the same as reading them
   * against each other, and reading them against each other is the whole point of running both.
   * Each entry brings its own RAS->texture matrix, because a specialized network may segment only
   * part of the study; and its own opacities, because they are separate display nodes. Entries are
   * ordered back to front. A view implements this INSTEAD OF the singular form; how many it can
   * actually draw is its own business, and it reports that back as the number accepted.
   */
  setSegmentationLabelOverlays?(list: SegOverlay[]): number;
}

/** One segmentation's contribution to the slice overlay. */
export interface SegOverlay {
  id: string;
  labels: GPUTexture;
  palette: GPUTexture;
  /** RAS -> label texture [0,1]; the labelmap's own geometry, not the background volume's. */
  p2t: Mat4;
  fillOpacity: number;
  outlineOpacity: number;
  /**
   * Which of the 256 label values are DRAWN, as a 256-bit mask (8 x u32, label L is bit L).
   *
   * Built here because this is where the palette exists as numbers -- the GPU texture beside it
   * cannot be read back cheaply. Consumed by the 3D view-ray probe, which was reporting structures
   * that are switched off: Ron, with the neocortex hidden and a deeper structure exposed, "the probe
   * shows the superior fronal gyrus".
   */
  visible: Uint32Array;
  /**
   * Is this segmentation drawn in the 3D VIEW? The list itself is the 2D overlay list, and the two
   * do not always agree.
   *
   * The 3D view-ray probe borrows this list, so without the distinction it happily reported a
   * segmentation that had been switched off in 3D but was still on the slices -- Ron: "I had
   * nephrogenic up and switched from total to lungvessels. The probe still gave me sternum."
   */
  visible3D: boolean;
}

/** One volume rendering in the 3D view. `field` is the colorize field when a segmentation of this
 *  volume is drawn with it (CT and segments in one pass), otherwise the plain grayscale field;
 *  `colorizedSeg` names that segmentation, so its own 3D field can be suppressed as a duplicate. */
export interface Volume3D {
  field: Field;
  colorizedSeg?: string;
  /** A SERIES' field (render/series-field.ts): the segmentations of the family its frames are colored by, one per
   *  frame -- constant while it plays, so a step changes nothing about which segmentations the volume draws (critic
   *  2026-10-16, cine step 1, finding 2). Counted as colorizedSeg is. */
  colorizedSegs?: string[];
  /** Segmentations whose anatomy this field draws (the solid look over merged segmentations): their
   *  own surfaces stand down, as a colorized one's do. */
  drawsSegs?: string[];
}

export interface DisplayableManager {
  interestedTypes: string[];
  /** Node types whose BULK-DATA UPDATES this manager reproduces LOCALLY (it holds the same deterministic
   *  op/filter), so the peer can skip re-streaming their bulk on change. The initial snapshot still
   *  carries the bulk. Optional; declared e.g. by the seged manager (it recomputes the labelmap from
   *  SegEdit intents). LiveSync sends the union on subscribe. */
  localBulkTypes?: string[];
  onNodeAdded?(node: MrsonNode, scene: LiveScene): void | Promise<void>;
  onNodeRemoved?(id: string, scene: LiveScene): void;
  onEvent?(ev: Record<string, unknown>, scene: LiveScene): void | Promise<void>;
  onSceneClosed?(scene: LiveScene): void;   // scene-level reset (Slicer EndCloseEvent)
}

/** One record on the LiveScene `_changes` feed. Inbound remote events and local writes both
 *  normalize into this, so DisplayableManagers, Controls, and LiveSync consume ONE stream — the
 *  CouchDB `_changes` shape (ARCHITECTURE-2026-08-02 §2). */
export interface Change {
  id: string;
  type?: string;
  kind: "upsert" | "remove" | "reset";
  origin: string;      // "local" (this place) or a peer's origin id
  v: number;           // monotonic sequence for this LiveScene
  node?: MrsonNode;    // present on upsert
  op?: Op;             // the originating op, present only for LOCAL writes → LiveSync replicates it out
}

export class LiveScene {
  nodes = new Map<string, MrsonNode>();
  view?: MirrorView;                                  // the renderer surface managers drive

  /** This place's origin id — stamps local writes and drives echo suppression. */
  origin = "local";
  private seq = 0;                                     // monotonic _changes sequence
  private changeSubs = new Set<(c: Change) => void>();

  // LiveScene is the pure data model — no wire. A LiveSync (render/livesync.ts) owns the transport,
  // reconnect, coalescing, and echo suppression; it drives this model via receiveEvent()/applyRemote()
  // and observes it via subscribe(). httpBase stays only so managers can resolve blob URLs (blobBase).
  constructor(
    public httpBase: string,  // http://host:2131/mrson/
    public managers: DisplayableManager[],
  ) {}

  blobBase(): string { return new URL("blobs/", this.httpBase).href; }
  find(type: string): MrsonNode | undefined {
    for (const n of this.nodes.values()) if (n.type === type) return n;
    return undefined;
  }

  /** The union of node types the DisplayableManagers care about; LiveSync subscribes the peer to
   *  these on (re)connect. Public because LiveSync — not the model — owns the wire. */
  subscribedTypes(): string[] {
    return [...new Set(this.managers.flatMap((m) => m.interestedTypes))];
  }
  /** Union of node types the managers reproduce locally — the peer skips re-streaming their bulk updates
   *  (ARCHITECTURE: consumer-declared local authority over deterministic bulk). LiveSync sends it on subscribe. */
  localBulk(): string[] {
    return [...new Set(this.managers.flatMap((m) => m.localBulkTypes ?? []))];
  }
  private interested(type: string | undefined): DisplayableManager[] {
    return type ? this.managers.filter((m) => m.interestedTypes.includes(type)) : [];
  }

  // ── local authority + the _changes feed (ARCHITECTURE-2026-08-02) ───────────

  /** Observe the `_changes` feed. Controls use it to reflect current node state; LiveSync uses it to
   *  replicate out. Returns an unsubscribe function. */
  subscribe(cb: (c: Change) => void): () => void {
    this.changeSubs.add(cb);
    return () => { this.changeSubs.delete(cb); };
  }

  private feed(c: Change): void {
    for (const cb of this.changeSubs) {
      try {
        cb(c);
      } catch (e) {
        // A SUBSCRIBER MUST NEVER BREAK THE FEED -- but it must not fail INVISIBLY either.
        //
        // The DisplayableManagers subscribe here, so a throw while building a field is caught on
        // this line. Swallowed silently, that is indistinguishable from nothing having happened: on
        // 2026-09-05 loading a second segmentation blanked every view, and three separate
        // investigations found no error anywhere, because the error was being eaten here. Ron:
        // "after loading vessels as second I got this image for a second before all the images
        // disappeard" -- the last good frame, and then a renderer left half-updated.
        //
        // Still caught, still non-fatal to the feed. Now it says so.
        const detail = `${(e as Error)?.message ?? e} (change ${c.kind} ${c.type ?? ""} ${c.id})`;
        console.error("LiveScene subscriber threw:", e, c);
        const g = globalThis as unknown as {
          __sceneFailure?: unknown[];
          __onGpuFailure?: (what: string, detail: string) => void;
        };
        (g.__sceneFailure ??= []).push({ detail, at: new Date().toISOString() });
        g.__onGpuFailure?.("scene update failed", detail);
      }
    }
  }

  /** LOCAL authoritative write — how a Control or Interactor changes the scene. Applies the op to the
   *  model IMMEDIATELY (optimistic), notifies displayers, emits on the `_changes` feed, and — if the
   *  op is locally-originated — queues it for sync. Standalone and connected run the identical path;
   *  "connected" only adds a LiveSync peer downstream. Echo suppression is by construction: only
   *  local-origin ops are sent out, and an inbound remote op is applied via `applyRemote`, never here. */
  write(op: Op): void {
    const stamped = { ...op, origin: op.origin ?? this.origin, v: op.v ?? ++this.seq, role: op.role ?? "human" } as Op;
    const r = applyOp(this.nodes, stamped);
    if (r.changed) this.applied(r, stamped.origin as string, stamped.v as number, stamped);
    // No send here — LiveScene is the model. The op rides the _changes feed (Change.op); LiveSync, if
    // connected, coalesces + sends it. Standalone: applied locally, nothing to send. Identical path.
  }

  writeMany(ops: Op[]): void { for (const o of ops) this.write(o); }

  /** Apply an op that arrived from a peer (inbound remote). Same mutation + notify as a local write,
   *  but NOT re-sent (echo suppression). Not yet on the wire path (inbound is still event-shaped in
   *  `handle`); present so Controls/tests exercise the symmetric remote path. */
  applyRemote(op: Op): void {
    const r = applyOp(this.nodes, op);
    if (r.changed) this.applied(r, (op.origin as string) ?? "remote", (op.v as number) ?? ++this.seq);
  }

  /** Fan a completed op mutation out to displayers + the `_changes` feed. `op` is set only for LOCAL
   *  writes so LiveSync replicates them (echo suppression: remote/event changes carry no op). */
  private applied(r: ApplyResult, origin: string, v: number, op?: Op): void {
    if (r.kind === "del") {
      for (const m of this.managers) m.onNodeRemoved?.(r.id, this);   // type gone → offer to all (they no-op)
      this.feed({ id: r.id, kind: "remove", origin, v, op });
      return;
    }
    const node = this.nodes.get(r.id);
    if (!node) return;
    for (const m of this.interested(node.type)) m.onNodeAdded?.(node, this);   // re-deliver the updated node
    this.feed({ id: r.id, type: node.type, kind: "upsert", origin, v, node, op });
  }

  // ── replay (SceneRecorder) ──────────────────────────────────────────────────
  // When applyView is false the model + _changes feed still update on every inbound event (so a
  // SceneRecorder keeps a LOSSLESS record of the live session), but the DISPLAYABLE MANAGERS are NOT
  // driven — the view is under replay control via applySnapshot(). Resuming live re-attaches the view
  // to the current model. This is the DVR head advancing while you scrub the past.
  applyView = true;

  /** Enter/leave replay mode. Leaving does NOT itself repaint — the caller reconciles the view to the
   *  desired node map (present or a seeked past) with applySnapshot(). */
  setLive(on: boolean): void { this.applyView = on; }

  /** Drive the displayable managers so the VIEW reflects `target` (a full node map — the live model, or
   *  a SceneRecorder.seek(t) reconstruction), reconciling from `from` (what the view currently shows).
   *  Emits nothing on the _changes feed and does NOT mutate this.nodes — replay must not pollute the
   *  recording nor the authoritative model. Removes gone nodes, (re)adds new/changed ones (JSON-diff);
   *  heavy GPU resources keyed by id are reused by the managers, so scrubbing is cheap after the first
   *  fetch. */
  async applySnapshot(
    target: Map<string, MrsonNode>,
    from: Map<string, MrsonNode>,
    opts?: { force?: (n: MrsonNode) => boolean },
  ): Promise<void> {
    for (const [id, node] of from) {
      if (!target.has(id)) for (const m of this.interested(node.type)) m.onNodeRemoved?.(id, this);
    }
    for (const [id, node] of target) {
      const prev = from.get(id);
      // `force` re-delivers a node even when its value is unchanged — used to SNAP the view (camera,
      // slice offsets) back to the recorded state after the user branched off with local interaction
      // (which mutates the view but not the model node, so a plain diff would skip it).
      if (!prev || JSON.stringify(prev) !== JSON.stringify(node) || opts?.force?.(node)) {
        for (const m of this.interested(node.type)) await m.onNodeAdded?.(node, this);
      }
    }
  }

  /** Apply one inbound event from a peer (via LiveSync). Slicer sends event-shaped changes (NodeAdded
   *  upsert / NodeRemoved / CameraModified / SceneClosed); each mutates the model, notifies displayers
   *  (unless replay froze the view), and emits on the `_changes` feed with a remote origin so Controls
   *  and the SceneRecorder reflect it. */
  /** A node this place created with a provisional id (put) now has the peer's real id: move it. */
  aliasNode(clientId: string, realId: string): void {
    if (clientId === realId) return;
    const node = this.nodes.get(clientId);
    if (!node) return;
    this.nodes.delete(clientId);
    node.id = realId;
    this.nodes.set(realId, node);
    if (this.applyView) for (const m of this.interested(node.type)) { m.onNodeRemoved?.(clientId, this); m.onNodeAdded?.(node, this); }
    this.feed({ id: clientId, type: node.type, kind: "remove", origin: "remote", v: ++this.seq });
    this.feed({ id: realId, type: node.type, kind: "upsert", origin: "remote", v: ++this.seq, node });
  }

  async receiveEvent(ev: Record<string, unknown>, origin = "remote"): Promise<void> {
    const e = ev.event as string;
    const live = this.applyView;   // drive managers only when the view is attached to the live model
    if (e === "NodeAdded" && ev.node) {
      const node = ev.node as MrsonNode;
      if (typeof ev.clientId === "string") this.aliasNode(ev.clientId, node.id);   // our own put, now with its real id
      this.nodes.set(node.id, node);                       // upsert
      if (live) for (const m of this.interested(node.type)) await m.onNodeAdded?.(node, this);
      this.feed({ id: node.id, type: node.type, kind: "upsert", origin, v: ++this.seq, node });
    } else if (e === "NodeRemoved") {
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      this.nodes.delete(id);
      if (live) for (const m of this.interested(node?.type)) m.onNodeRemoved?.(id, this);
      this.feed({ id, type: node?.type, kind: "remove", origin, v: ++this.seq });
    } else if (e === "SnapshotComplete") {
      /* managers already received their snapshot nodes */
    } else if (e === "SceneClosed") {
      this.nodes.clear();                                 // wholesale reset (Slicer closed the scene)
      if (live) for (const m of this.managers) m.onSceneClosed?.(this);
      this.feed({ id: "", kind: "reset", origin, v: ++this.seq });
    } else if (e === "SegmentationDisplayModified") {
      // A display-only change from Slicer (visibility / opacity / colour). Keep the MODEL authoritative:
      // merge the display fields into the segmentation node, let the seg manager update the render, then
      // emit on the _changes feed so Controls (the popup switch) reflect it — inbound events must not
      // bypass the model (ARCHITECTURE-2026-08-02 §1).
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      const disp = ev.display as Record<string, unknown> | undefined;
      if (node && disp) {
        for (const k of ["visible", "opacity", "fill2D", "outline2D", "segments"]) {
          if (k in disp) (node as unknown as Record<string, unknown>)[k] = disp[k];
        }
      }
      if (live) for (const m of this.interested("segmentation")) await m.onEvent?.(ev, this);
      if (node) this.feed({ id, type: "segmentation", kind: "upsert", origin, v: ++this.seq, node });
    } else if (e === "CameraModified") {
      // Live camera pose from Slicer. Keep the MODEL authoritative — merge the pose fields into the
      // camera node (like SegmentationDisplayModified) so Controls/recorders read current state from
      // nodes, not just the CameraDisplayableManager's private copy (ARCHITECTURE-2026-08-02 §1).
      const id = ev.sourceId as string;
      const node = this.nodes.get(id);
      if (node) {
        for (const k of ["position", "focalPoint", "viewUp", "viewAngle", "parallelScale"]) {
          if (k in ev) (node as unknown as Record<string, unknown>)[k] = ev[k];
        }
      }
      if (live) for (const m of this.interested("camera")) await m.onEvent?.(ev, this);
      if (node) this.feed({ id, type: "camera", kind: "upsert", origin, v: ++this.seq, node });
    } else {
      const t = this.nodes.get(ev.sourceId as string)?.type;
      if (live) for (const m of this.interested(t)) await m.onEvent?.(ev, this);
    }
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────

export interface CameraState {
  position: number[]; focalPoint: number[]; viewUp: number[];
  viewAngle?: number; parallelScale?: number; parallelProjection?: boolean;
}

/** Mirrors the active camera: applies snapshot + live CameraModified to the view. */
export class CameraDisplayableManager implements DisplayableManager {
  interestedTypes = ["camera"];
  last?: CameraState;
  private apply(n: Record<string, unknown>, scene: LiveScene) {
    this.last = {
      position: n.position as number[], focalPoint: n.focalPoint as number[],
      viewUp: n.viewUp as number[], viewAngle: n.viewAngle as number, parallelScale: n.parallelScale as number,
      parallelProjection: typeof n.parallelProjection === "boolean" ? n.parallelProjection : undefined,
    };
    scene.view?.setCamera(this.last);
  }
  onNodeAdded(node: MrsonNode, scene: LiveScene) { this.apply(node as unknown as Record<string, unknown>, scene); }
  onEvent(ev: Record<string, unknown>, scene: LiveScene) { if (ev.event === "CameraModified") this.apply(ev, scene); }
}

/** Mirrors Markups point lists (fiducials/lines/curves) as rendered glyphs. Aggregates the
 *  control points of every markup node into one FiducialField; adds it once (coarse) and
 *  updates points in place (fine) on live moves. ROI markups are handled by RoiCropDM. */
/** A draggable control-point handle: which markup + control-point index, and its current RAS. */
export interface MarkupHandle { id: string; index: number; ras: Vec3 }

/** The name card's pin: amber, Mike Halle's "Landmark / annotation" color (#FFB300; Ron, 2026-09-25: "lets go with amber for now"). */
export const NAME_CARD_PIN = [1, 0.702, 0, 1];

export class MarkupsDisplayableManager implements DisplayableManager {
  // `view` as well as `markup`: an ROI's 2D outline is its intersection with a slice, so it has to
  // be recomputed when the SLICE moves, not only when the box does.
  interestedTypes = ["markup", "view"];
  private nodes = new Map<string, MrsonNode>();  // markup id -> its full node (points + geometry)
  /** Whether a name card is drawn at all (its structure shown) -- the view's rule, so the slices follow the 3D view. */
  cardShown?: (list: MrsonNode, card: unknown) => boolean;
  /** The card pins the slices were last given ("listId#index"): a drag grabs only one of these, so what is drawn and
   *  what can be grabbed never disagree (critic 2026-10-02, round 2, finding 1). */
  private drawnCardPins = new Set<string>();
  cardPinDrawn(listId: string, index: number): boolean { return this.drawnCardPins.has(`${listId}#${index}`); }
  /** Give the slices the markups again (a segmentation's visibility changed what a name card's pin shows). */
  redrawSlices(scene: LiveScene) { scene.view?.setOverlay?.("*", "markups", this.overlayItems(scene)); }
  private field?: FiducialField;                 // control-point glyphs (all markup types)
  private lines?: CapsuleField;                  // connectors: line/angle/curve/plane geometry

  private spheresFor(node: MrsonNode): Sphere[] {
    if (node.drawAs === "cards") return [];                 // NAME CARDS draw themselves in 3D (render/name-cards-view.ts)
    const col = (node.color as number[]) ?? MARKUP_POINT_RGB;
    const cps = (node.controlPoints as { position: number[] }[] | undefined) ?? [];
    // A small flat ring (Ron, 2026-09-25: "a tiny black ring"): 2.4 px per glyph-size step, 7 px at the default 3.
    const radius = 2.4 * ((node.glyphScale as number) ?? 3);
    return cps.map((cp) => ({ center: cp.position as Vec3, radius, color: [col[0], col[1], col[2], 1] }));
  }
  /**
   * One ROI crop widget per `roi` markup: the tuned wireframe AND its fifteen handles.
   *
   * This was a bare `RoiBoxField`, and last night it was twelve capsules -- which threw away
   * everything roi-widget.ts already had. Ron: "I work with one of the sessions in this project on
   * cropbox already. we worked on the behavior and appearance of the control points and of the
   * yellow lines. What we did yesterday evening is a regression of sorts."
   *
   * It was. The widget carries the handles, the face/corner/centre drag math, the hover feedback and
   * the appearance tuned in 40cc4af for Slicer's light background -- warm ivory bars at 0.12 of the
   * handle radius, saturated near-opaque handles with ghost OFF because ghost halved them into
   * invisibility. The capsule version reproduced all three faults that commit fixed and had no
   * handles at all.
   */
  private roiWidgets = new Map<string, RoiWidget>();
  private syncRoi(node: MrsonNode, scene: LiveScene) {
    const key = "roi:" + node.id, hKey = "roiHandles:" + node.id;
    if (node.markupType !== "roi" || node.visible === false || !node.center || !node.size) {
      if (this.roiWidgets.delete(node.id)) { scene.view?.removeField(key); scene.view?.removeField(hKey); }
      return;
    }
    const c = node.center as Vec3, sz = node.size as Vec3;
    const half: Vec3 = [sz[0] / 2, sz[1] / 2, sz[2] / 2];
    // The box's own axes, when the node carries them -- see RoiBoxOpts.axes. On this study a
    // patient-aligned box around the head maps back onto the tilted grid as the whole volume.
    const ax = node.orientation as number[] | undefined;
    const axes = ax && ax.length === 9 ? ax : undefined;
    // THE SMALLEST BOX IS ONE VOXEL of the finest volume in the scene, whatever its scale (microscopy to astrophysics;
    // Ron, 2026-10-20). The same voxel sizes the box's bars when it is made.
    // The scene's voxel, from the one module that says how big a voxel is (scene-scale.ts).
    const finest = sceneVoxel(scene.nodes.values());
    let w = this.roiWidgets.get(node.id);
    if (!w) {
      // Created from this box's own extent (coverage 0.5 makes half exactly the extent's half), then
      // set explicitly, so the widget's state is the node's rather than a fraction of a volume.
      w = createRoiWidget(
        [c[0] - half[0], c[1] - half[1], c[2] - half[2]],
        [c[0] + half[0], c[1] + half[1], c[2] + half[2]],
        { coverage: 0.5, axes, voxel: finest },
      );
      this.roiWidgets.set(node.id, w);
      scene.view?.setField(key, w.box);
      scene.view?.setField(hKey, w.handles);
    }
    w.setAxes(axes);
    if (finest !== undefined) w.setMinHalf(finest / 2);
    w.setBox(c, half);
    scene.view?.redraw();
  }
  /** Per-type connector geometry: line/angle connect consecutive control points; curve/closedCurve
   *  use Slicer's interpolated world polyline (closedCurve wraps); plane uses its 4 world corners. */
  private segmentsFor(node: MrsonNode): LineSegment[] {
    const t = node.markupType as string;
    const col = (node.color as number[]) ?? [1, 0.85, 0.2, 1];
    const c: [number, number, number, number] = [col[0], col[1], col[2], 1];
    const cps = ((node.controlPoints as { position: number[] }[] | undefined) ?? []).map((p) => p.position as Vec3);
    let pts: Vec3[] = [];
    let closed = false;
    if (t === "line" || t === "angle") pts = cps;
    else if (t === "curve") pts = (node.linePoints as Vec3[] | undefined) ?? cps;
    else if (t === "closedCurve") { pts = (node.linePoints as Vec3[] | undefined) ?? cps; closed = true; }
    else if (t === "plane") { pts = (node.corners as Vec3[] | undefined) ?? []; closed = true; }
    // An ROI's 3D form is its own widget -- the tuned wireframe plus fifteen handles, ray-marched in
    // the same pass as the volume so it occludes and is occluded correctly. Twelve capsules were the
    // wrong answer twice over: they are not in that pass, which is why the slice planes did not
    // obscure them, and they carried the markup styling rather than the ROI's.
    else return [];   // fiducial (points only), roi (its own widget, see syncRoi)
    const segs: LineSegment[] = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i], b: pts[i + 1], radius: 3, color: c });
    if (closed && pts.length > 2) segs.push({ a: pts[pts.length - 1], b: pts[0], radius: 3, color: c });
    return segs;
  }
  private allSpheres(): Sphere[] {
    const out: Sphere[] = [];
    for (const n of this.nodes.values()) out.push(...this.spheresFor(n));
    return out;
  }
  private allSegments(): LineSegment[] {
    const out: LineSegment[] = [];
    for (const n of this.nodes.values()) out.push(...this.segmentsFor(n));
    return out;
  }
  /** 2D overlay items for the slice views: every control point (drawn in-plane or as a projection)
   *  and the connector polylines. Mirrors vtkMRMLMarkupsDisplayableManager's slice-view actors. */
  /**
   * Every slice plane in the scene, as a point and a normal.
   *
   * Read from each slice view's own `sliceToRAS` -- the same matrix SliceDisplayableManager reads --
   * so an ROI outline lands exactly on the plane that view is showing, including an oblique one.
   */
  private slicePlanes(scene: LiveScene): { point: Vec3; normal: Vec3 }[] {
    const out: { point: Vec3; normal: Vec3 }[] = [];
    for (const n of scene.nodes.values()) {
      if (n.type !== "view" || n.kind !== "slice") continue;
      const m = n.sliceToRAS as number[] | undefined;
      if (!m || m.length < 16) continue;
      out.push({ point: [m[3], m[7], m[11]], normal: [m[2], m[6], m[10]] });
    }
    return out;
  }

  private overlayItems(scene?: LiveScene): OverlayItem[] {
    this.drawnCardPins.clear();
    const out: OverlayItem[] = [];
    // THE CROP BOX LIVES IN THE SLICE VIEWS TOO. Ron: "When you look at slicers cropping tool, it
    // lives in all viewers, 2D and 3D." Slicer has a vtkSlicerROIRepresentation2D beside its 3D one,
    // and the 2D form is the box's INTERSECTION with the slice rather than a projection of its
    // wireframe -- a projection would draw the same outline on every slice and so say nothing about
    // where the cut falls.
    //
    // One polygon per slice plane, all in the one item list: the overlay is drawn for every cell,
    // and the drawer skips any segment whose endpoints are off THAT cell's plane, so each view keeps
    // only its own outline. No per-cell overlay plumbing is needed for it.
    const planes = scene ? this.slicePlanes(scene) : [];
    for (const n of this.nodes.values()) {
      if (n.markupType !== "roi" || n.visible === false || !n.center || !n.size) continue;
      const ax = n.orientation as number[] | undefined;
      const box = {
        center: n.center as [number, number, number],
        size: n.size as [number, number, number],
        ...(ax && ax.length === 9 ? { axes: ax } : {}),
      };
      // THE SAME COLOR AS THE 3D FRAME. This fell back to the generic markup gold, so one box was
      // drawn in two colors -- ivory in 3D, gold on the slices. Ron: "the box colors in 2d are not
      // adjusted. In 3d they look nice."
      const col = (n.color as number[]) ?? [...ROI_BAR_RGB, 1];
      for (const pl of planes) {
        const poly = boxPlanePolygon(box, pl.point, pl.normal);
        if (poly) out.push({ kind: "polyline", points: poly as Vec3[], color: col, widthPx: 2, closed: true });
      }
      // AND ITS HANDLES -- the ones that BELONG to each plane, projected onto it, not the fifteen
      // 3D ones. Ron: "It should not show the 3d handles in the 2d, they are useless there. 2D
      // control handles should be usable in the slice that is visible, otherwise they are not
      // functional." A slice can only be clicked on its own plane, so a handle drawn 40 mm off it
      // is decoration; sliceHandles() gives the nine that are reachable and aimable there, and
      // `inPlaneOnly` keeps this plane's set out of the other views. See roi-widget.ts.
      const w = this.roiWidgets.get(n.id);
      if (w) {
        for (const pl of planes) {
          for (const h of w.sliceHandles(pl.point as Vec3, pl.normal as Vec3)) {
            const c = h.data.kind === "center" ? ROI_CENTER_RGB : ROI_HANDLE_RGB;
            out.push({ kind: "point", ras: h.world, color: [c[0], c[1], c[2], 0.95], radiusPx: 5, inPlaneOnly: true });
          }
        }
      }
    }
    for (const n of this.nodes.values()) {
      const col = (n.color as number[]) ?? [1, 0.85, 0.2, 1];               // lines and curves: amber unless colored
      const pointCol = (n.color as number[]) ?? MARKUP_POINT_RGB;          // points: a black ring unless colored
      if (n.visible === false) continue;                                    // hidden markups draw nothing
      // NAME CARDS in the slices only when chosen (Ron, 2026-09-25: "Show in: 3D / Slices", 3D only by default): the
      // amber pin and the typed title, no card -- the card is the 3D view's.
      if (n.drawAs === "cards") {
        if (!(n.showIn as { slices?: boolean } | undefined)?.slices) continue;
        ((n.controlPoints as unknown[] | undefined) ?? []).forEach((cp0, index) => {
          const cp = cp0 as { position: number[]; label?: string; visibility?: boolean; visible?: boolean };
          if (cp.visibility === false || cp.visible === false || this.cardShown?.(n, cp) === false) return;
          this.drawnCardPins.add(`${n.id}#${index}`);
          out.push({ kind: "point", ras: cp.position as Vec3, color: NAME_CARD_PIN, radiusPx: 4, label: cp.label || undefined, ring: false, inPlaneOnly: true });   // on the slice only, never a projection (critic 2026-10-02, 14)
        });
        continue;
      }
      const cps = (n.controlPoints as { position: number[]; label?: string }[] | undefined) ?? [];
      const radiusPx = Math.max(2, ((n.glyphScale as number) ?? 3) * 2);   // 2D glyph size tracks GlyphScale (Slicer)
      // ONLY ON THE SLICE LOOKED AT (Ron, 2026-10-03: "the appearance of the markup point on the slices [is] confusing.
      // They should only show, if they are on the slice that is being looked at") -- no faded copy on every other slice;
      // Slicer's own default (projection off).
      for (const cp of cps) out.push({ kind: "point", ras: cp.position as Vec3, color: pointCol, radiusPx, label: cp.label, ring: true, inPlaneOnly: true });
      // NOT for an ROI. This joins a markup's segments end to end into one path, which is what a
      // line, an angle or a curve IS. A box's twelve edges are not a path: chaining them draws a
      // thirteen-point zigzag through the corners in whatever order they were generated. The 2D form
      // of a box is its intersection with the slice, emitted above.
      const segs = n.markupType === "roi" ? [] : this.segmentsFor(n);
      if (segs.length) {
        const pts: Vec3[] = [segs[0].a, ...segs.map((sg) => sg.b)];
        out.push({ kind: "polyline", points: pts, color: col, widthPx: 2 });
      }
    }
    return out;
  }
  private refresh(scene: LiveScene, first = false) {
    scene.view?.setOverlay?.("*", "markups", this.overlayItems(scene));
    // "GHOSTS": markups show through what is in front of them at half strength. Slicer hides them instead
    // (vtkMRMLMarkupsDisplayNode: OccludedVisibility = false by default); that was tried on 2026-09-25 and Ron went back
    // to this ("After further thinking just go back to the original").
    if (!this.field) this.field = new FiducialField(this.allSpheres(), { screenSpace: true, ghost: true, shininess: 60, ring: true });
    else this.field.setSpheres(this.allSpheres());          // in place
    if (!this.lines) this.lines = new CapsuleField(this.allSegments(), { screenSpace: true, ghost: true });
    else this.lines.setSegments(this.allSegments());
    // Their drawn bounds are padded by a length that follows the data's scale (fiducial-field.ts screenPad).
    const voxel = sceneVoxel(scene.nodes.values());
    this.field.setVoxel(voxel); this.lines.setVoxel(voxel);
    if (first) {
      scene.view?.setField("markups", this.field);           // coarse add once
      scene.view?.setField("markupLines", this.lines);
    } else scene.view?.redraw();
  }

  /**
   * The crop widgets, so a view can offer their handles for dragging.
   *
   * The widget owns the handle list, the drag math and the hover state; the view owns the pointer.
   * They have to meet somewhere, and this is the smallest surface that does it -- the alternative was
   * the manager growing pointer handling, which is the view's job.
   */
  cropWidgets(): { id: string; widget: RoiWidget }[] {
    return [...this.roiWidgets.entries()].map(([id, widget]) => ({ id, widget }));
  }

  /** Every draggable control point, in the same order allSpheres() lays them out. */
  handles(): MarkupHandle[] {
    const out: MarkupHandle[] = [];
    for (const n of this.nodes.values()) {
      const cps = (n.controlPoints as { position: number[] }[] | undefined) ?? [];
      cps.forEach((cp, index) => out.push({ id: n.id, index, ras: cp.position as Vec3 }));
    }
    return out;
  }

  /** Optimistic local move of one control point (SlicerLive drag), before Slicer echoes it back.
   *  Keeps the glyph under the cursor with zero round-trip latency. */
  moveLocal(id: string, index: number, ras: Vec3, scene: LiveScene) {
    const n = this.nodes.get(id);
    const cps = n?.controlPoints as { position: number[] }[] | undefined;
    if (!cps || !cps[index]) return;
    cps[index].position = [...ras];
    this.refresh(scene);
  }

  // ORIGIN / echo suppression: while the user drags a control point locally, that point is the
  // authoritative source — suppress the (stale) echo of our OWN move so it can't rubber-band the
  // glyph. AUTO-EXPIRING (a deadline, not a sticky flag): `touch()` on every drag frame extends the
  // window; it lapses ~holdMs after the last move, so a drag that never cleanly releases (pointer
  // left the canvas, JS error) can NEVER permanently freeze a markup's sync. The final flushed op's
  // echo (arriving well within holdMs) then re-syncs to the same value → no jump.
  private heldUntil = new Map<string, number>();   // "id:index" -> perf.now() deadline
  touch(id: string, index: number, holdMs = 250) { this.heldUntil.set(id + ":" + index, performance.now() + holdMs); }
  private isHeld(id: string): boolean {
    const now = performance.now();
    let held = false;
    for (const [k, t] of this.heldUntil) {
      if (t <= now) { this.heldUntil.delete(k); continue; }
      if (k.startsWith(id + ":")) held = true;
    }
    return held;
  }

  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    // A VIEW MOVED (a slice scrolled): only the 2D outlines follow it -- an ROI's outline is its intersection with
    // that slice. This fell through to the markup path below, stored the view AS A MARKUP and redrew the 3D view on
    // every slice step: most of a scroll's graphics work, and a soft-then-sharp 3D view while scrolling a slice
    // (critic, 2026-09-24, steve-merge finding 3; since 542394c, 2026-09-06).
    if (node.type === "view") {
      this.nodes.delete(node.id);
      if (this.nodes.size) scene.view?.setOverlay?.("*", "markups", this.overlayItems(scene));
      return;
    }
    if (node.markupType === "roi") {
      // AN ROI IS A MARKUP LIKE THE OTHERS, and this returned before it could become one.
      //
      // The early return was right when an ROI was drawn entirely by RoiBoxField -- syncRoi made the
      // wireframe and there was nothing else to do. It stopped being right the moment an ROI could be
      // ORIENTED, because an oriented one is drawn from its twelve edges through the capsule field
      // and its slice outlines through the overlay, and both of those read `this.nodes`. Returning
      // here meant the node was never put in `this.nodes`, so both paths were unreachable: no edges
      // in 3D, no outline on the slices, and syncRoi itself declines to draw an oriented box as an
      // axis-aligned one. Ron, having fitted a box: "and there was no box."
      this.syncRoi(node, scene);
      const firstRoi = !this.field;
      if (node.visible === false) this.nodes.delete(node.id);
      else this.nodes.set(node.id, node);
      this.refresh(scene, firstRoi);
      return;
    }
    if (node.visible === false) { this.onNodeRemoved(node.id, scene); return; }
    if (this.isHeld(node.id)) return;                      // keep the local optimistic drag state
    const first = !this.field;
    this.nodes.set(node.id, node);
    this.refresh(scene, first);
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    if (this.roiWidgets.delete(id)) { scene.view?.removeField("roi:" + id); scene.view?.removeField("roiHandles:" + id); }
    if (!this.nodes.delete(id) || !this.field) return;
    this.field.setSpheres(this.allSpheres());
    this.lines?.setSegments(this.allSegments());
    scene.view?.setOverlay?.("*", "markups", this.overlayItems(scene));
    scene.view?.redraw();
  }
  onSceneClosed(scene: LiveScene) {
    this.nodes.clear();
    this.field = undefined;
    this.lines = undefined;
    scene.view?.setOverlay?.("*", "markups", []);
    scene.view?.removeField("markupLines");
    scene.view?.removeField("markups");
  }
}

/** Mirrors a Markups ROI volume crop the way Slicer does: crop is active only when the
 *  volume-rendering display has cropping ENABLED and references an ROI (not merely because an
 *  ROI node exists). Tracks the VR display's crop state and the ROI geometry independently and
 *  recomputes the clip box; toggling crop in Slicer clears/re-applies it. */
export class RoiCropDisplayableManager implements DisplayableManager {
  interestedTypes = ["volumeRenderingDisplay", "markup"];
  private crop: { enabled: boolean; roiId?: string } = { enabled: false };
  private rois = new Map<string, { center: Vec3; size: Vec3 }>();

  private recompute(scene: LiveScene) {
    const r = this.crop.enabled && this.crop.roiId ? this.rois.get(this.crop.roiId) : undefined;
    if (r) {
      const c = r.center, s = r.size;
      scene.view?.setClipBox(
        [c[0] - s[0] / 2, c[1] - s[1] / 2, c[2] - s[2] / 2],
        [c[0] + s[0] / 2, c[1] + s[1] / 2, c[2] + s[2] / 2],
      );
    } else {
      scene.view?.setClipBox(null);
    }
  }
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "volumeRenderingDisplay") {
      this.crop = { enabled: !!node.cropEnabled, roiId: (node.refs?.roi as string[] | undefined)?.[0] };
      this.recompute(scene);
    } else if (node.markupType === "roi" && node.center && node.size) {
      this.rois.set(node.id, { center: node.center as Vec3, size: node.size as Vec3 });
      this.recompute(scene);
    }
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    let changed = this.rois.delete(id);
    if (this.crop.roiId === id) { this.crop.roiId = undefined; changed = true; }
    if (changed) this.recompute(scene);
  }
  onSceneClosed(scene: LiveScene) {
    this.crop = { enabled: false };
    this.rois.clear();
    scene.view?.setClipBox(null);
  }
}

/** Mirrors the slice (MPR) views: each SliceNode becomes a reslice plane in the cell that carries its
 *  layoutName (Red/Green/Yellow, Compare's Slice4.., Red+ ...): the cell set is whatever the app's layout
 *  engine reports, not a fixed trio. Anatomical orientations use SlicerLive's radiological presets; any
 *  other sliceToRAS (Reformat, oblique) is passed through as a basis so the view reslices along it.
 *  Slice scrolls arrive as NodeAdded upserts and just re-set the plane. */
export class SliceDisplayableManager implements DisplayableManager {
  interestedTypes = ["view"];
  private static ORIENT: Record<string, "axial" | "coronal" | "sagittal"> = { Axial: "axial", Coronal: "coronal", Sagittal: "sagittal" };
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type !== "view" || node.kind !== "slice") return;
    const cell = node.layoutName as string | undefined;
    const m = node.sliceToRAS as number[] | undefined;    // row-major 4x4: columns = u, v, n; last column = centre
    if (!cell || !m || m.length < 16) return;
    const col = (c: number): Vec3 => [m[c], m[4 + c], m[8 + c]];
    const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const nDir = norm(col(2)), uDir = norm(col(0)), vDir = norm(col(1));
    const trans: Vec3 = [m[3], m[7], m[11]];
    // nearest anatomical axis of the normal → display preset; exact match → anatomical plane
    const ax = [Math.abs(nDir[0]), Math.abs(nDir[1]), Math.abs(nDir[2])];
    const axis = ax[2] >= ax[0] && ax[2] >= ax[1] ? 2 : ax[1] >= ax[0] ? 1 : 0;
    const orient = SliceDisplayableManager.ORIENT[node.orientation as string] ?? (["sagittal", "coronal", "axial"] as const)[axis];
    const anatomical = ax[axis] > 0.9999 && SliceDisplayableManager.ORIENT[node.orientation as string] !== undefined;
    const plane: SlicePlane = anatomical
      ? { orient, posMm: trans[axis] }
      : { orient, posMm: trans[0] * nDir[0] + trans[1] * nDir[1] + trans[2] * nDir[2], basis: { uDir, vDir, nDir } };
    const fov = node.fieldOfView as number[] | undefined;   // [fovX, fovY, slabThickness] mm — Slicer's zoom
    if (fov && fov.length >= 2 && fov[0] > 0 && fov[1] > 0) { plane.centerRAS = trans; plane.fovX = fov[0]; plane.fovY = fov[1]; }
    plane.chrome = { orientationMarkerType: (node.orientationMarkerType as number) ?? 0, orientationMarkerSize: (node.orientationMarkerSize as number) ?? 20, rulerType: (node.rulerType as number) ?? 0 };
    scene.view?.setSlicePlane(cell, plane);
  }
}

/** Mirrors the app-level interaction state nodes that gate what a click in a view means:
 *  interaction (viewTransform / place / adjustWindowLevel), selection (what to place, active volumes)
 *  and the crosshair (mode, thickness, cursor + crosshair RAS). Exposes them to the view host via
 *  MirrorView.setViewState (optional) and keeps the latest copies for interaction code to read. */
export interface ViewState { interaction?: MrsonNode; selection?: MrsonNode; crosshair?: MrsonNode; segmentEditor?: MrsonNode }
export class ViewStateDisplayableManager implements DisplayableManager {
  interestedTypes = ["interaction", "selection", "crosshair", "segmentEditor"];
  state: ViewState = {};
  private push(scene: LiveScene) { (scene.view as MirrorView & { setViewState?: (s: ViewState) => void })?.setViewState?.(this.state); }
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "interaction") this.state.interaction = node;
    else if (node.type === "selection") this.state.selection = node;
    else if (node.type === "crosshair") this.state.crosshair = node;
    else if (node.type === "segmentEditor") this.state.segmentEditor = node;
    this.push(scene);
  }
  onSceneClosed(scene: LiveScene) { for (const k of Object.keys(this.state)) delete (this.state as Record<string, unknown>)[k]; this.push(scene); }   // same object: views hold a reference
}

/** Keeps the transform nodes (linear matrices, parent refs). World geometry is baked into every
 *  displayable on the wire (ijkToRAS, world control points), so nothing needs composing here; this
 *  manager exists so transforms are subscribed and available for interaction (gizmo, Transforms
 *  module parity) and, later, nonlinear TransformField modifiers. */
export class TransformDisplayableManager implements DisplayableManager {
  interestedTypes = ["transform"];
  nodes = new Map<string, MrsonNode>();
  onNodeAdded(node: MrsonNode) { this.nodes.set(node.id, node); }
  onNodeRemoved(id: string) { this.nodes.delete(id); }
  onSceneClosed() { this.nodes.clear(); }
}

/** Mirrors vtkMRMLViewDisplayableManager's chrome: box, axis labels, background, orientation marker, ruler. */
export class ThreeDViewDisplayableManager implements DisplayableManager {
  interestedTypes = ["view"];
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type !== "view" || node.kind !== "3d") return;
    scene.view?.setViewChrome?.({
      id: node.id, layoutName: node.layoutName as string,
      boxVisible: node.boxVisible !== false, axisLabelsVisible: node.axisLabelsVisible !== false,
      // Defaults are vtkMRMLViewNode's own, read from an installed Slicer (see render/background.ts);
      // the previous values were rounded approximations and [0.45, 0.45, 0.6] was visibly short of
      // Slicer's blue. backgroundColor is the BOTTOM stop, backgroundColor2 the TOP.
      backgroundColor: (node.backgroundColor as number[]) ?? [...SLICER_BG_BOTTOM], backgroundColor2: (node.backgroundColor2 as number[]) ?? [...SLICER_BG_TOP],
      orientationMarkerType: (node.orientationMarkerType as number) ?? 0, rulerType: (node.rulerType as number) ?? 0,
      ...(typeof node.drawingLook === "boolean" ? { drawingLook: node.drawingLook } : {}),
      ...(typeof node.shadingVersion === "number" ? { shadingVersion: node.shadingVersion } : {}),
      ...(typeof node.lighting === "string" ? { lighting: node.lighting } : {}),
      ...(Array.isArray(node.shade) && node.shade.length === 4 ? { shade: node.shade as number[] } : {}),
    });
  }
}

/** Mirrors the application layout (which views are shown, and how). */
export class LayoutDisplayableManager implements DisplayableManager {
  interestedTypes = ["layout"];
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "layout") scene.view?.setLayout((node.arrangementName as string) ?? "fourUp");
  }
}

/** Effective [fill, outline] slice opacities from a segmentation node's 2D display settings,
 *  gated by overall visibility — mirrors Slicer's Opacity * {Opacity2DFill, Opacity2DOutline}
 *  with the Visibility2D{Fill,Outline} toggles. Defaults match Slicer (fill 0.5, outline 1.0). */
function slice2DOpacities(node: MrsonNode, visible: boolean): [number, number] {
  if (!visible) return [0, 0];
  const overall = typeof node.opacity === "number" ? node.opacity : 1;
  const f = node.fill2D as { visible?: boolean; opacity?: number } | undefined;
  const o = node.outline2D as { visible?: boolean; opacity?: number } | undefined;
  const fill = (f?.visible ?? true) ? overall * (f?.opacity ?? 0.5) : 0;
  const outline = (o?.visible ?? true) ? overall * (o?.opacity ?? 1) : 0;
  return [fill, outline];
}

/** `opacity` is display-only, 1 when absent: a see-through surface in 3D. The 2D overlay keeps its own. */
/** A markup point with no color of its own: a black ring (Ron, 2026-09-25), with a white rim where it is drawn. */
const MARKUP_POINT_RGB = [0.05, 0.05, 0.05, 1];

type Segment = { labelValue: number; color: number[]; visible?: boolean; opacity?: number; name?: string };

/** A segment's finish under the shading version in use (render/shading-versions.ts), by the structure its name is; undefined
 *  lights it as every structure is under v1. */
function finishOfSegment(name: string | undefined): Finish | undefined {
  return name ? finishFor(lookupStructure(name)?.key) : undefined;
}

/** 256-entry RGBA palette from the per-segment colours; a hidden segment (visible === false)
 *  gets alpha 0 so it drops out of both the fill and the 3D field. */
/**
 * A COLLAPSED BRANCH IS ONE THING, so it is painted as one color.
 *
 * Ron: "when I collapse the left ribs in segmentations, they do not change to a single color" -- and,
 * asked which he meant, that the VIEWS should change, not just the row's swatch. A branch shown as
 * one row should look like one structure.
 *
 * Display only, and reversible: the labelmap is untouched and the segments keep their own colors.
 * This is the palette -- 2 KB -- so expanding the branch restores them with a re-colorize and no
 * re-bake of anything bulky. It also composes with visibility rather than fighting it: a hidden
 * segment stays hidden, because only labels the loop already made opaque are repainted.
 */
export interface MergedGroup { labels: number[]; color: number[] }

function segPalette(segments: Segment[], merged?: MergedGroup[]): Float32Array {
  const p = new Float32Array(256 * 4);
  for (const s of segments ?? []) {
    const lv = s.labelValue;
    if (lv > 0 && lv < 256 && s.visible !== false) { p[lv * 4] = s.color[0]; p[lv * 4 + 1] = s.color[1]; p[lv * 4 + 2] = s.color[2]; p[lv * 4 + 3] = 1; }
  }
  for (const [lv, c] of mergedColours(merged)) {
    // Only a label the loop above already made opaque: hidden stays hidden, so the merge composes
    // with visibility instead of fighting it.
    if (lv > 0 && lv < 256 && p[lv * 4 + 3] > 0) { p[lv * 4] = c[0]; p[lv * 4 + 1] = c[1]; p[lv * 4 + 2] = c[2]; }
  }
  return p;
}
/** Stable key over the colors + per-segment visibility + any merge — changes only when a re-bake is needed. */
function paletteKey(segments: Segment[], merged?: MergedGroup[]): string {
  const segs = (segments ?? []).map((s) => `${s.labelValue}:${s.color.map((x) => x.toFixed(3)).join(",")}:${s.visible !== false}${typeof s.opacity === "number" && s.opacity < 1 ? `@${s.opacity.toFixed(2)}` : ""}`).join("|");
  const m = (merged ?? []).map((g) => `${g.color.map((x) => x.toFixed(3)).join(",")}<${g.labels.join(",")}`).join("|");
  return m ? `${segs}#${m}` : segs;
}
/** The display-only merge a segmentation node currently declares. */
const mergedOf = (n: unknown): MergedGroup[] | undefined => (n as { mergedGroups?: MergedGroup[] } | null | undefined)?.mergedGroups;

/**
 * label -> the color a collapsed branch paints it, flattened from the declared merges.
 *
 * SHARED BY BOTH PALETTE PATHS, because there are two and they had already diverged: the slice
 * overlay and the segmentation's own 3D field are colored from `segPalette`, while a volume drawing
 * CT and segments in ONE pass -- the usual case in the 3D view -- is colored by `writePalette` from
 * each segment's own `color`. Teaching only the first is why Ron collapsed Left ribs and the ribs in
 * 3D did not change: "Left ribs should change color. They dont."
 *
 * Later entries win, so an inner branch overrides an outer one if both are ever sent.
 */
/** Voxels carrying a label, counted on every 7th voxel and scaled: an estimate, which is all the solid
 *  look's overlap order needs, in about a seventh of the time of a full count (418 M voxels). */
function countLabelled(lab: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < lab.length; i += 7) if (lab[i] !== 0) n++;
  return n * 7;
}

export function mergedColours(merged?: MergedGroup[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const g of merged ?? []) for (const lv of g.labels) out.set(lv, g.color);
  return out;
}

/**
 * One segmentation's resident GPU state.
 *
 * All of this used to be fields on the manager, which is why a scene could hold exactly one: a
 * second segmentation reset the first and took its place. Ron, with an nnInteractive segmentation
 * on one CT and a partly-annotated one on another: "3d for the nninteractive works, but not for
 * partially annotated." Neither was broken -- only one of them existed at a time.
 */
interface SegSlot {
  id: string;
  baker: ColorizeBaker;              // resident: labelmap uploaded once, re-colorized in place
  /**
   * The 2 KB palette the slice overlay is colored from, in the shader.
   *
   * This was `overlayTex`: an rgba16float volume, baked crisp (σ=0), which is 8 bytes a voxel --
   * 3.35 GB on Ron's 768x768x709 study, allocated per segmentation the moment it loaded, for a
   * binding only one segmentation can hold at a time. Two segmentations and a CT came to 6.7 GB of
   * it and the images vanished. A crisp bake is a palette lookup per voxel and nothing else, so it
   * was storing an answer the shader can compute: the slice renderer's label-overlay mode reads the
   * r8uint labelmap the baker already holds, and this.
   */
  paletteTex: GPUTexture;
  // NO SURFACES HERE ANY MORE (Ron, 2026-10-21, option B). This slot held the extracted meshes, their drawing
  // copies, the labelmap copy for the extraction and the worker that made them, for the Surfaces look and the
  // Generate Surface Models module; both are gone. Anatomy is drawn solid from the labels (updateSolid), and
  // surface models are an export made on demand from Save › Files (render/surface-export.ts), which reads the
  // labels back from the card (readLabelmap) and keeps nothing.
  /** Roughly how many voxels carry a label (every 7th voxel counted, times 7): which segmentation is
   *  the more specific where two overlap, for the solid look's merge. Counted when the labels arrive,
   *  because the labelmap itself is not kept on the processor (it is a texture). */
  labelledVoxels?: number;
  dims: Vec3;
  ijkToRAS: number[];
  palKey: string;
  palette?: Float32Array;            // the last palette baked, so a deferred 3D bake can use it
  zarrSig: string;                   // changes when the segmentation is EDITED
  lastDisp?: MrsonNode;              // the display node to re-apply when the 3D answer flips
}

/** The label read-back's slab, in bytes (SegmentationDisplayableManager.readLabels); a test makes it small. */
export const LABEL_READ_SLAB = { bytes: 32 << 20 };

export class SegmentationDisplayableManager implements DisplayableManager {
  interestedTypes = ["segmentation", "image", "volumeRenderingDisplay"]   // the last two: the volume's 3D look (render/look3d.ts);
  private slots = new Map<string, SegSlot>();
  /**
   * Which segmentation currently owns the ONE 2D slice overlay.
   *
   * 3D is genuinely per segmentation -- each has its own keyed field and they composite. 2D is not:
   * the slice renderer binds a single overlay texture, so showing two segmentations at once over
   * the slices would mean threading a second binding through the compositing pass. Until then the
   * most recently shown one owns it, and switching one off hands it back to another that is on
   * rather than leaving the slices bare.
   */
  private overlayOwner?: string;
  private blobBaseHref = "";
  private unlisten?: () => void;
  /**
   * ONE BUILD AT A TIME PER SEGMENTATION.
   *
   * Building a slot is asynchronous (the labelmap is read before anything is made), so two writes
   * of the same segmentation inside that window each found no slot, each built one, and the second
   * replaced the first. Everything was therefore done twice: a 418 MB labelmap uploaded twice and
   * its stored surfaces fetched and decoded twice.
   *
   * Measured on a scene of four segmentations, 2026-09-22 (the load profiler Ron asked for found
   * it on its first run): "surfaces from the database ran 8× for 5 series", 15.9 s of work where
   * half was thrown away, and the two writes were 30 ms apart -- the segmentation being created and
   * then its arrival state being set.
   *
   * A second write now waits for the first build and takes the display-only path, which is what it
   * was always meant to be.
   */
  private building = new Map<string, Promise<void>>();

  /** The second argument was the smoothing of the old blurred 3D picture (gone with it); kept so callers need not change. */
  constructor(private dev: GPUDevice, _sigma = 1.5, private onBytes?: (n: number) => void) {}

  /** Per image: its look and whether it is rendered, as last seen -- a change re-applies its segmentations. */
  private lookSeen = new Map<string, string>();
  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    if (node.type === "image" || node.type === "volumeRenderingDisplay") {
      const imageId = node.type === "image" ? node.id as string : ((node.refs as Record<string, string[]> | undefined)?.volume ?? [])[0];
      if (!imageId) return;
      const key = `${scene.nodes.get(imageId)?.look3D ?? ""}|${node.type === "volumeRenderingDisplay" ? !!node.visible : this.lookSeen.get(imageId)?.split("|")[1] ?? ""}`;
      if (this.lookSeen.get(imageId) === key) return;
      this.lookSeen.set(imageId, key);
      for (const slot of this.slots.values()) {
        const src = ((scene.nodes.get(slot.id)?.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
        if (src === imageId && slot.lastDisp) this.apply(slot, slot.lastDisp, scene);
      }
      this.scheduleSolid(scene);
      return;
    }
    if (node.type !== "segmentation" || !node.zarr) return;
    // A LOOP, NOT AN `if`. Two writes of one segmentation were handled; three were not. B and C
    // both await A, both resume when A resolves, and C never looks again -- so B starts a build and
    // C starts a second one of the same segmentation, two 418 MB labelmaps and two bakers, with the
    // loser's `slots.set` dropping the winner's textures without freeing them. Every arriving series
    // now re-applies the saved state, which writes each segmentation node whole, so three writes in
    // flight is the ordinary case and not a corner (critic, 2026-09-22, finding 3).
    for (let inFlight = this.building.get(node.id); inFlight; inFlight = this.building.get(node.id)) await inFlight;
    const sig = JSON.stringify(node.zarr);
    const existing = this.slots.get(node.id);
    if (existing && sig === existing.zarrSig) {
      // A DISPLAY-ONLY CHANGE STILL CHANGES THE PALETTE. Keeping the bake is right -- the labelmap
      // has not moved, so re-uploading and re-baking it would be waste -- but this branch went
      // straight to apply(), which pushes the segmentation's OWN visibility and the 3D field and
      // touches no per-segment color at all. So hiding a group wrote `visible: false` onto the
      // node, the node arrived here, and nothing about the picture changed. Ron, having turned off
      // the whole frontal lobe: "I turned off frontal lobe, but as you can see in the 3d viewer, it
      // had no effect on the visualization."
      //
      // The palette is what carries per-segment color and visibility, and it is cheap: a 2 KB write
      // for the slice overlay, and a re-bake of the 3D volume only when one is built.
      const key = paletteKey((node.segments as Segment[]) ?? [], mergedOf(node));
      // lastDisp FIRST, as on the event path below: the solid look reads each segment's color and opacity
      // from lastDisp. Left as it was, every per-segment opacity or color set in one write was drawn one
      // change late -- the look "Vessels in context" showed opaque lungs while its status line said
      // see-through (critic, 2026-09-20 evening, finding 1; the building session's own picture showed it too).
      existing.lastDisp = node;
      if (key !== existing.palKey) {
        existing.palKey = key;
        this.recolorize(existing, segPalette((node.segments as Segment[]) ?? [], mergedOf(node)), scene);
      }
      this.apply(existing, node, scene);
      return;
    }
    let finishBuild!: () => void;
    const mine = new Promise<void>((r) => { finishBuild = r; });
    this.building.set(node.id, mine);
    try {
    this.blobBaseHref = scene.blobBase();
    // NATIVE, not the f32 reader. A labelmap is stored `|u1`, and fetchZarrVolume widens whatever it
    // reads to Float32Array -- so this asked for 418 million bytes, got a 1.67 GB f32 copy of them,
    // and immediately narrowed it back to the 418 MB of bytes it had asked for. Two full-volume
    // allocations and 418 million conversions, to arrive at the input. The native reader also shares
    // a cache with `cacheDecodedVolumeNative`, which createSegmentationFromLabelmap seeds precisely
    // so a freshly made segmentation is not re-read; the f32 reader hit that cache and then undid it.
    // No range: a labelmap's is never read, and computing it was half the per-voxel cost.
    const zv = await timedLoad("labelmap · read the voxels", () => fetchZarrVolumeNative(this.blobBaseHref, node.zarr as ZarrDesc, this.onBytes, 12, false, true));
    // Shared with the cache when it hit, so it is read-only here: both uses below hand it to
    // queue.writeTexture and neither writes into it.
    const lab = timedLoadSync("labelmap · as bytes", () => zv.data instanceof Uint8Array ? zv.data : Uint8Array.from(zv.data));
    const segments = (node.segments as Segment[]) ?? [];
    const sameDims = !!(existing && zv.dims[0] === existing.dims[0] && zv.dims[1] === existing.dims[1] && zv.dims[2] === existing.dims[2]);
    if (existing && sameDims) {
      // EDITED labelmap (live paint / scrub): re-upload + re-bake into the SAME textures the field
      // already renders — an in-place REPLACE. No removeField/setField, so no dark flash between applies.
      existing.zarrSig = sig;
      existing.baker.updateLabelmap(lab);
      existing.labelledVoxels = countLabelled(lab);
      forgetDecoded(node.zarr as ZarrDesc);              // it is a texture now
      existing.palKey = paletteKey(segments, mergedOf(node));
      this.recolorize(existing, segPalette(segments, mergedOf(node)), scene);
      this.apply(existing, node, scene);
      return;
    }
    // Its geometry changed: drop THIS segmentation's resources and rebuild them. Every other
    // segmentation in the scene is untouched -- that reset used to be unconditional, which is what
    // made a second segmentation evict the first.
    if (existing) this.destroySlot(existing, scene);
    // THE SEGMENTATION MAY HAVE GONE WHILE THIS WAS READING. `destroySlot` frees the baker's
    // textures and the palette; a build that carries on with the slot it was holding writes into
    // them and takes the device down: "Destroyed texture ... used in a submit", reproduced by the
    // critic on 2026-09-22 by deleting a segmentation 5 ms into a rebuild.
    if (!scene.nodes.get(node.id)) return;
    // Only the chunks that hold anything go to the card, when the read handed them back (see
    // ColorizeBaker); a labelmap read on the page, without the worker, goes whole as before.
    const baker = timedLoadSync("labelmap · upload to the GPU", () => new ColorizeBaker(this.dev, lab, zv.dims, zv.chunks));
    const slot: SegSlot = {
      id: node.id, baker, paletteTex: makeLabelPaletteTexture(this.dev), dims: zv.dims,
      ijkToRAS: node.ijkToRAS as number[], palKey: paletteKey(segments, mergedOf(node)), zarrSig: sig,
      labelledVoxels: countLabelled(lab),
    };
    // AND IT MAY GO BETWEEN THE UPLOAD AND THE PUBLISH. Checked again rather than once: the two
    // statements above touch the GPU, and a removal in that window would leave this slot in the map
    // with freed textures, which is the same crash one apply() later.
    if (!scene.nodes.get(node.id)) { baker.destroy(); slot.paletteTex.destroy(); return; }
    this.slots.set(node.id, slot);
    forgetDecoded(node.zarr as ZarrDesc);                // uploaded: the cache was the last CPU copy
    // Only the slice overlay's palette is written here; 3D is the solid look's merge (updateSolid), which
    // apply() schedules.
    timedLoadSync("labelmap · color it", () => this.recolorize(slot, segPalette(segments, mergedOf(node)), scene));
    this.listen(scene);
    timedLoadSync("labelmap · show it", () => this.apply(slot, node, scene));
      // ONLY THE BUILD THAT OWNS THE ENTRY CLEARS IT. Deleting whoever's entry is there would let a
      // later write see nothing in flight while a build is still running.
    } finally { if (this.building.get(node.id) === mine) this.building.delete(node.id); finishBuild(); }
  }

  /** Live display change (opacity/visibility/colour). Re-colorize IN PLACE only when the palette
   *  (colour or per-segment visibility) changed — the bulk labelmap is never re-fetched or
   *  re-uploaded, and the output textures are reused, so the 3D field + slice bind stay valid
   *  (a redraw suffices). Opacity-only changes skip the bake entirely. */
  onEvent(ev: Record<string, unknown>, scene: LiveScene) {
    if (ev.event !== "SegmentationDisplayModified") return;
    const slot = this.slots.get(ev.sourceId as string);
    if (!slot) return;
    const d = ev.display as MrsonNode & { segments?: Segment[] };
    const key = paletteKey(d.segments ?? [], mergedOf(d));
    // lastDisp FIRST: the solid look reads the segments' colors and opacity from lastDisp -- so it must
    // see this event's, not the previous one's. (Colors always came right on the NEXT change; a
    // see-through toggle showed one event late.)
    slot.lastDisp = d;
    if (key !== slot.palKey) { slot.palKey = key; this.recolorize(slot, segPalette(d.segments ?? [], mergedOf(d)), scene); }
    this.apply(slot, d, scene);
  }

  /** Push current visibility/opacity to the view. The output textures are stable objects, so an
   *  in-place re-colorize needs only a redraw (no setField / scene rebuild); visibility flips add
   *  or remove the 3D field. */
  /** Hand the 2D slice overlay to this segmentation, in label form when the view understands it.
   *  A view that predates `setSegmentationLabelOverlay` still gets a baked rgba volume, so the
   *  cheap path is an upgrade rather than a requirement. */
  private showOverlay(slot: SegSlot, scene: LiveScene, fill: number, outline: number) {
    const v = scene.view;
    if (!v) return;
    v.setSegmentationLabelOverlay?.(slot.baker.labelTexture(), slot.paletteTex, fill, outline);
  }

  /**
   * Hand the view EVERY visible segmentation at once.
   *
   * Replaces the single-owner handover below for any view that implements it. The list is rebuilt
   * from scratch on every apply(), so a visibility flip needs no bookkeeping: whoever is visible is
   * in it. Each entry carries its own RAS->texture matrix, since a specialized network segments only
   * part of the study. Returns false if this view does not speak the plural form.
   */
  private pushOverlays(scene: LiveScene): boolean {
    const v = scene.view;
    if (!v?.setSegmentationLabelOverlays) return false;
    const list: SegOverlay[] = [];
    // In zOrder, so the slices draw a later one over an earlier one -- the order the Scene module
    // shows and its ▲▼ change. Absent zOrder keeps the arrival order.
    const slots = this.drawOrder();   // the same order as 3D (drawOrder)
    for (const s of slots) {
      const d = s.lastDisp;
      if (!d || d.visible === false) continue;
      const [fillOpacity, outlineOpacity] = slice2DOpacities(d, true);
      const in3D = (d.visible3D as boolean | undefined) ?? (d.visible !== false);
      // A segmentation drawn in 3D but not in the slices STAYS IN THE LIST, at zero 2D opacity:
      // the slice pass draws nothing for it, but the probe and the 3D ray read it, so a pick on
      // its surface names the structure. It used to be dropped here, which is why a 3D pick on a
      // segmentation whose 2D was off said "none".
      if (fillOpacity <= 0 && outlineOpacity <= 0 && !in3D) continue;
      // ALPHA 0 IS HIDDEN, the same test the solid look uses to decide whether a structure is drawn.
      // A segment at low-but-nonzero opacity stays in the mask: it is on screen, so it is what the
      // cursor is over, and only being switched OFF takes a structure out of the picture.
      const vis = new Uint32Array(8);
      const pal = s.palette;
      for (let l = 1; l < 256; l++) {
        if (!pal || pal[l * 4 + 3] > 0) vis[l >> 5] |= 1 << (l & 31);
      }
      list.push({
        id: s.id,
        labels: s.baker.labelTexture(),
        palette: s.paletteTex,
        p2t: patientToTextureFromIjkToRAS(s.ijkToRAS, s.dims),
        fillOpacity,
        outlineOpacity,
        visible: vis,
        // The same rule apply() follows: absent means "follow the 2D visibility".
        visible3D: in3D,
      });
    }
    v.setSegmentationLabelOverlays(list);
    return true;
  }

  /** Clear the 2D overlay, in whichever form this view speaks. */
  private clearOverlay(scene: LiveScene) {
    const v = scene.view;
    if (!v) return;
    if (v.setSegmentationLabelOverlay) v.setSegmentationLabelOverlay(null, null, 0, 0);
    else v.setSegmentationOverlay(null, 0, 0);
  }


  private apply(slot: SegSlot, disp: MrsonNode, scene: LiveScene) {
    slot.lastDisp = disp;
    const visible = disp.visible !== false;
    const [fill, outline] = slice2DOpacities(disp, visible);
    // A view that can draw several segmentations gets the whole list and the handover below is moot.
    // Ron: "the slice viewers show the results of the abdominal muscles but the 3d window shows
    // both. Make up your mind." Two networks over one study are read against each other; toggling
    // between them is not reading them against each other.
    const plural = this.pushOverlays(scene);
    // THE 2D OVERLAY IS A SINGLE BINDING (see overlayOwner). Showing this one takes it; hiding the
    // one that holds it passes it to another that is still shown, so turning off segmentation A
    // does not also blank segmentation B's overlay.
    if (plural) { /* the list above already says who draws */ }
    else if (visible) {
      this.overlayOwner = slot.id;
      this.showOverlay(slot, scene, fill, outline);
    } else if (this.overlayOwner === slot.id) {
      this.overlayOwner = undefined;
      for (const other of this.slots.values()) {
        if (other === slot || other.lastDisp?.visible === false) continue;
        const [f, o] = slice2DOpacities(other.lastDisp!, true);
        this.overlayOwner = other.id;
        this.showOverlay(other, scene, f, o);
        break;
      }
      if (!this.overlayOwner) this.clearOverlay(scene);
    }
    // 3D IS THE SOLID LOOK'S, for every segmentation (updateSolid reads `visible3D`, the volume's look in Scene
    // and whether a volume rendering colors it). Surface models drawn here are gone (Ron, 2026-10-21, option B):
    // they are an export now, made from Save › Files. The redraw is the one this branch always made for a
    // segmentation on in 3D (absent `visible3D` follows `visible`; the volume's look may hide it).
    const segNode = scene.nodes.get(slot.id);
    const visible3D = (disp.visible3D as boolean | undefined) ?? visible;
    if (visible3D && !(segNode && segLookOf(scene, segNode) === "hidden")) scene.view?.redraw();
    this.scheduleSolid(scene);
  }

  // ── THE SOLID LOOK OVER EVERY SEGMENTATION (Ron, 2026-09-23: "1 then 2 then 3") ──
  //
  // Under the Colored look (render/look3d.ts) every segmentation shown in 3D is drawn solid -- with or
  // without its CT: those on one voxel grid (at most two grids) are merged into ONE label image on the
  // card (render/solid-merge.ts; where two overlap, drawOrder decides, for the slices and 3D alike) and
  // drawn by one ColorizeField with no CT. The members of a sequence stay with the colored volume, which
  // steps with the frames. (Ron, 2026-09-23: "keep the surfaces until we know for sure that it works";
  // 2026-10-21, option B: surface models are an export only, render/surface-export.ts.)
  private solidGroups = new Map<string, { field: ColorizeField; labels: GPUTexture; sig: string; palSig: string; drawnKey: string; bytes: number }>();
  private finishWatch?: () => void;
  private solidScheduled = false;
  private lastScene?: LiveScene;
  private scheduleSolid(scene: LiveScene) {
    this.lastScene = scene;
    // The shading version (Settings › 3D view, or a restored scene) changes the palette's finish rows: the next pass writes them.
    this.finishWatch ??= onShadingVersion(() => { if (this.lastScene) this.scheduleSolid(this.lastScene); });
    if (this.solidScheduled) return;
    this.solidScheduled = true;
    queueMicrotask(() => { this.solidScheduled = false; this.updateSolid(scene); });
  }
  /** What the solid look is drawing now, by group: for the status line and for checking. */
  solidReport(): { group: string; segmentations: string[] }[] {
    return [...this.solidGroups.entries()].map(([k, g]) => ({ group: k, segmentations: g.drawnKey ? g.drawnKey.split("|") : [] }));
  }
  /**
   * THE ORDER SEGMENTATIONS ARE DRAWN IN, where they overlap -- ONE RULE FOR THE SLICES AND FOR 3D (critic,
   * 2026-09-23, finding 5: the slices put the later one on top, the solid look the smaller one, and the
   * same voxel was "lung" on a slice and "vessel" in 3D). Per volume: once the Scene module's ▲▼ has
   * ordered its segmentations (every one then carries a zOrder), that order; until then THE MORE SPECIFIC
   * ON TOP -- the one labeling fewer voxels drawn last -- because a vessel network inside the lungs is
   * also "lung" in the whole-body segmentation, and arrival order let the whole-body one erase the
   * vessels. Later in the list is on top.
   */
  private drawOrder(): SegSlot[] {
    const all = [...this.slots.values()];
    const srcOf = (s: SegSlot) => ((s.lastDisp?.refs as Record<string, string[]> | undefined)?.source ?? [])[0] ?? "";
    const groups = new Map<string, SegSlot[]>();
    for (const s of all) { const k = srcOf(s); const g = groups.get(k) ?? []; g.push(s); groups.set(k, g); }
    const out: SegSlot[] = [];
    for (const g of groups.values()) {
      const idx = new Map(g.map((s, i) => [s, i]));
      const ordered = g.every((s) => typeof s.lastDisp?.zOrder === "number");
      g.sort((a, b) => ordered
        ? (a.lastDisp!.zOrder as number) - (b.lastDisp!.zOrder as number)
        : ((b.labelledVoxels ?? Infinity) - (a.labelledVoxels ?? Infinity)) || (idx.get(a)! - idx.get(b)!));
      out.push(...g);
    }
    return out;
  }
  /** The message about segmentations the solid look cannot take, as last said (said again only when it changes). */
  private solidLeftSaid = "";
  private updateSolid(scene: LiveScene) {
    const view = scene.view;
    if (!view?.setVolume3D) return;
    const want = new Map<string, { dims: Vec3; ijkToRAS: number[]; slots: SegSlot[] }>();
    const left: string[] = [];
    // AT MOST TWO VOXEL GRIDS SOLID: a solid set reads 6 of the 16 images one drawing step may read in the
    // application's window, and a third was refused by the card -- its segmentations then drawn neither
    // solid nor as surfaces (critic, finding 2). A third grid's segmentations are not drawn in 3D (nothing
    // stands in) and the status line names them.
    const MAX_GRIDS = 2;
    for (const s of this.drawOrder()) {
      const d = s.lastDisp;
      if (!d) continue;
      // A MEMBER OF A TIME SERIES is drawn here unless its sequence's colored volume draws it. That volume colors ONE
      // family, so a second family on the beating heart (the coronaries beside the chambers) was drawn nowhere in 3D
      // (Ron, 2026-09-24: "a scene … that shows the beating heart including the coronaries"). Each step makes another
      // member the one showing, and the merge follows it.
      // Asked of the VOLUME RENDERING alone: "drawn by a volume" counts the solid look itself, and asking that made
      // a member leave and rejoin the merge on every pass -- a loop that froze the page (2026-09-24, on the heart).
      // And by FAMILY: the colored volume colors each phase with that phase's member but names only the member it
      // started with, so asking per member put the later phases' chambers in the merge as well -- drawn twice.
      if (d.sequence) {
        const family = ((scene.nodes.get(d.sequence as string)?.items as { node: string }[] | undefined) ?? []).map((it) => it.node);
        if ([s.id, ...family].some((id) => scene.view?.segmentColoredByVolumeRendering?.(id) ?? false)) continue;
      } else if (scene.view?.segmentColoredByVolumeRendering?.(s.id)) {
        // ANY VOLUME RENDERING THAT COLORS IT draws it (Volume Rendering › Colorized volume on a plain CT): drawn here as
        // well, the anatomy was in two fields, and the colorize sliders reached only one of them -- Segment opacity at 0
        // left bones, colon and kidneys on screen (critic 2026-10-16, general audit, finding 1).
        continue;
      }
      const segNode = scene.nodes.get(s.id);
      if (!segNode || segLookOf(scene, segNode) !== "solid") continue;   // the volume's look in Scene
      const shown = d.visible !== false;
      if (!((d.visible3D as boolean | undefined) ?? shown)) continue;
      const key = `${s.dims.join("x")}|${s.ijkToRAS.map((v) => v.toFixed(3)).join(",")}`;
      let g = want.get(key);
      if (!g) {
        if (want.size >= MAX_GRIDS) { left.push(`${(d.name as string | undefined) ?? s.id} (on a third voxel grid; at most two are drawn solid at once)`); continue; }
        g = { dims: s.dims, ijkToRAS: s.ijkToRAS, slots: [] }; want.set(key, g);
      }
      g.slots.push(s);
    }
    for (const [key, g] of [...this.solidGroups]) {
      if (want.has(key)) continue;
      view.setVolume3D("solid:" + key, null);
      this.solidDestroy(g);
      this.solidGroups.delete(key);
    }
    for (const [key, w] of want) {
      // One shared numbering, 1..255, in drawing order; a structure hidden in its segmentation gets no
      // number and is not written, so what lies behind it shows.
      let next = 1;
      const inputs: { labels: GPUTexture; remap: Uint32Array }[] = [];
      const pal: { c: number[]; a: number; m?: Finish }[] = [];
      const drawn: string[] = [];
      const mergeParts: string[] = [];
      for (const s of w.slots) {
        const segs = (s.lastDisp?.segments as Segment[] | undefined) ?? [];
        const merged = mergedColours(mergedOf(s.lastDisp));
        const p = s.palette;
        const visible = segs.filter((sg) => {
          const l = sg.labelValue;
          if (!(l > 0 && l < 256) || sg.visible === false || (p && p[l * 4 + 3] <= 0)) return false;
          return (typeof sg.opacity === "number" ? sg.opacity : 1) > 0;
        });
        // Counted over the VISIBLE structures, which are the ones given a number (critic, finding 15).
        if (next + visible.length > 256) { left.push(`${(s.lastDisp?.name as string | undefined) ?? s.id} (more than 255 structures shown on one scan; hide some to bring it in)`); continue; }
        const remap = new Uint32Array(256);
        for (const sg of visible) {
          const l = sg.labelValue;
          const a = typeof sg.opacity === "number" ? Math.max(0, Math.min(1, sg.opacity)) : 1;
          const c = merged.get(l) ?? sg.color ?? (p ? [p[l * 4], p[l * 4 + 1], p[l * 4 + 2]] : [0.8, 0.8, 0.8]);
          const m = finishOfSegment(sg.name);
          remap[l] = next; pal[next] = m ? { c, a, m } : { c, a }; next++;
        }
        inputs.push({ labels: s.baker.labelTexture(), remap });
        drawn.push(s.id);
        // A SERIES MEMBER STANDS FOR ITS WHOLE FAMILY (CINE-RETHINK.md step 1, the critic's count: the solid group
        // re-published, and the 3D view re-composed, on every step, because the member drawn changed): the family's
        // members are all named, the same list at every step, so a step re-merges the voxels and nothing else.
        const fam = s.lastDisp?.sequence ? ((scene.nodes.get(s.lastDisp.sequence as string)?.items as { node: string }[] | undefined) ?? []).map((it) => it.node) : [];
        for (const id of fam) if (id !== s.id) drawn.push(id);
        mergeParts.push(`${s.id}:${s.zarrSig}:${Array.from(remap).join(",")}`);
      }
      // WHAT MAKES A NEW MERGE is which voxels and which numbers -- not a color or an opacity, which is a
      // palette write (critic, finding 7: every change re-merged and re-smoothed, ~0.44 s and 1.25 GB of
      // scratch at 768x768x709).
      const mergeSig = mergeParts.join(";");
      const palSig = JSON.stringify(pal);
      const drawnKey = [...drawn].sort().join("|");
      let g = this.solidGroups.get(key);
      let publish = false;
      if (!g) {
        const labels = makeMergedLabelTexture(this.dev, w.dims as [number, number, number]);
        const field = new ColorizeField(this.dev, null, null, w.dims, new Uint8Array(256 * 4), {
          clim: [0, 1], ijkToRAS: w.ijkToRAS, adoptLabels: labels, noCT: true, contextOpacity: 0,
          shade: [0.30, 0.70, 0.15, 20],
          clippable: false,                      // the crop box does not cut the anatomy (Ron, 2026-09-24: "no")
        });
        field.onlyVisibleLabels = true;           // the merge writes visible structures only
        const bytes = 2 * w.dims[0] * w.dims[1] * w.dims[2];   // the merged labels and the smoothed copy
        g = { field, labels, sig: "", palSig: "", drawnKey: "", bytes };
        this.solidGroups.set(key, g);
        const gm = globalThis as unknown as { __gpuMB?: number };
        gm.__gpuMB = (gm.__gpuMB ?? 0) + Math.round(bytes / 1048576);
        publish = true;
      }
      if (g.sig !== mergeSig) {
        mergeLabels(this.dev, inputs, w.dims as [number, number, number], g.labels);
        g.field.labelsChanged();                // new voxels: the smoothed copy is made again
        g.sig = mergeSig; g.palSig = "";
        view.redraw?.();                        // new voxels in the same field: drawn (a series step no longer re-publishes)
      }
      if (g.palSig !== palSig) {
        for (let l = 1; l < 256; l++) {
          const e = pal[l];
          if (e) { g.field.setSegmentColor(l, [e.c[0], e.c[1], e.c[2]]); g.field.setSegmentOpacity(l, e.a); g.field.setSegmentMaterial(l, e.m); }
          else { g.field.setSegmentOpacity(l, 0); g.field.setSegmentMaterial(l, undefined); }
        }
        g.field.flushPalette();                 // after the merge was submitted: a smoothed copy, if needed, is made from it
        if (!g.field.isSolid()) g.field.setSolid(true);
        g.palSig = palSig;
        view.redraw?.();
      }
      if (g.drawnKey !== drawnKey) { g.drawnKey = drawnKey; publish = true; }
      if (publish) view.setVolume3D("solid:" + key, { field: g.field, drawsSegs: drawn });
    }
    // NOT "shown as surfaces": that was the fallback before the firewall; now nothing stands in, and the
    // line says what is on screen (critic, 2026-09-24, finding 8). The slices still show them.
    const said = left.length ? `Not drawn in 3D: ${left.join("; ")} — still shown in the slices` : "";
    if (said !== this.solidLeftSaid) {
      this.solidLeftSaid = said;
      if (said) (globalThis as unknown as { __shell?: { setStatus?: (t: string) => void } }).__shell?.setStatus?.(said);
    }
  }
  private solidDestroy(g: { field: ColorizeField; labels: GPUTexture; bytes: number }) {
    g.field.destroy(); g.labels.destroy();
    const gm = globalThis as unknown as { __gpuMB?: number };
    gm.__gpuMB = Math.max(0, (gm.__gpuMB ?? 0) - Math.round(g.bytes / 1048576));
  }


  /** Re-apply when the colorize volume starts or stops drawing the segments. Registered once per
   *  scene; it re-applies EVERY segmentation, since which of them a volume colorizes can change. */
  private listen(scene: LiveScene) {
    if (this.unlisten) return;
    this.unlisten = scene.view?.onSegments3DChanged?.(() => {
      for (const slot of this.slots.values()) if (slot.lastDisp) this.apply(slot, slot.lastDisp, scene);
    });
  }

  /**
   * A SEGMENTATION'S LABELS, read back from the graphics card, for the surface export (render/surface-export.ts).
   *
   * The card holds the only copy (the samples were let go when they became a texture, CONSTRAINTS.md "a copy of the
   * data is held only while something is reading it"), and it is the copy that is drawn -- an edit in the Segment
   * Editor is in it. The caller owns what comes back and drops it when its extraction is done; nothing is kept here.
   * Null when the segmentation is not (yet) on the card.
   */
  async readLabelmap(id: string, opts: { pad?: boolean } = {}): Promise<{ labels: Uint8Array; dims: Vec3; ijkToRAS: number[]; padded?: boolean } | null> {
    // A build in flight (onNodeAdded) finishes first, so the labels read are the ones it uploads.
    for (let inFlight = this.building.get(id); inFlight; inFlight = this.building.get(id)) await inFlight;
    const slot = this.slots.get(id);
    if (!slot) return null;
    const labels = await this.readLabels(slot, !!opts.pad);
    // Removed or replaced while it was read: its textures may be gone, and what came back is not this segmentation's.
    if (this.slots.get(id) !== slot) return null;
    // PADDED (Save › Files › "Closed, for 3D printing"; algorithms/close-labels.ts): one voxel of background on every
    // side, written straight into the larger array as the slabs come back -- no second copy, no extra time.
    if (opts.pad) { const g = paddedGrid(slot.dims, slot.ijkToRAS); return { labels, dims: g.dims, ijkToRAS: g.ijkToRAS, padded: true }; }
    return { labels, dims: [...slot.dims] as Vec3, ijkToRAS: slot.ijkToRAS.slice() };
  }
  /** The labelmap, read back from the graphics card. Rows are padded to 256 bytes on the way back. */
  private async readLabels(slot: SegSlot, pad = false): Promise<Uint8Array> {
    const tex = slot.baker.labelTexture();
    const [nx, ny, nz] = slot.dims as [number, number, number];
    const bpr = Math.ceil(nx / 256) * 256;
    // IN SLABS of slices (critic 2026-10-21, surfaces export, finding 14): one 418 MB staging buffer beside its 418 MB
    // copy was 836 MB at once for a whole body; a slab of at most 32 MB is reused. And on any failure (a lost device, a
    // refused buffer) the staging buffer is destroyed and the reason is said in words.
    const slab = Math.max(1, Math.min(nz, Math.floor(LABEL_READ_SLAB.bytes / (bpr * ny))));
    const buf = this.dev.createBuffer({ size: bpr * ny * slab, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    // Padded: each row lands one voxel in, one row down, one slice in, of the larger grid.
    const p = pad ? 1 : 0, X = nx + 2 * p, Y = ny + 2 * p;
    const out = new Uint8Array(X * Y * (nz + 2 * p));
    const rowAt = (z: number, y: number) => ((z + p) * Y + (y + p)) * X + p;
    try {
      for (let z0 = 0; z0 < nz; z0 += slab) {
        const d = Math.min(slab, nz - z0);
        const enc = this.dev.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: tex, origin: { x: 0, y: 0, z: z0 } }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: ny }, [nx, ny, d]);
        this.dev.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ, 0, bpr * ny * d);
        const raw = new Uint8Array(buf.getMappedRange(0, bpr * ny * d));
        if (bpr === nx && !p) out.set(raw, z0 * nx * ny);
        else for (let z = 0; z < d; z++) for (let y = 0; y < ny; y++) out.set(raw.subarray((z * ny + y) * bpr, (z * ny + y) * bpr + nx), rowAt(z0 + z, y));
        buf.unmap();
      }
    } catch (e) {
      throw new Error(`the segmentation's labels could not be read back from the graphics card (${(e as Error).message})`);
    } finally {
      buf.destroy();
    }
    return out;
  }

  /** A new palette (colors, opacity, visibility): the slice overlay's palette texture. */
  private recolorize(slot: SegSlot, palette: Float32Array, _scene?: LiveScene) {
    slot.palette = palette;
    // The slice overlay is now a 2 KB write instead of a full-volume compute dispatch. That
    // dispatch ran on every palette change -- which is every eye toggle, every color edit, every
    // group slider -- over 418 million voxels.
    writeLabelPaletteTexture(this.dev, slot.paletteTex, palette);
  }

  onNodeRemoved(id: string, scene: LiveScene) {
    const slot = this.slots.get(id);
    if (slot) { this.destroySlot(slot, scene); this.scheduleSolid(scene); return; }
    // A volume (or its rendering) gone: its segmentations are now alone, which is drawn solid.
    if (this.lookSeen.delete(id) || [...this.slots.values()].some((sl) => ((scene.nodes.get(sl.id)?.refs as Record<string, string[]> | undefined)?.source ?? [])[0] === id)) {
      for (const sl of this.slots.values()) if (sl.lastDisp) this.apply(sl, sl.lastDisp, scene);
      this.scheduleSolid(scene);
    }
  }
  onSceneClosed(scene: LiveScene) {
    for (const slot of [...this.slots.values()]) this.destroySlot(slot, scene);
    for (const [key, g] of [...this.solidGroups]) { scene.view?.setVolume3D?.("solid:" + key, null); this.solidDestroy(g); }
    this.solidGroups.clear();
    this.unlisten?.();
    this.unlisten = undefined;
  }
  private destroySlot(slot: SegSlot, scene: LiveScene) {
    this.slots.delete(slot.id);
    // UNBIND BEFORE DESTROY. The view holds this slot's labelmap and palette in a bind group, so the
    // list has to be re-pushed without it while those textures are still alive -- destroying first
    // would leave the view bound to freed textures until the next apply(). (The slot left the map above.)
    const plural = this.pushOverlays(scene);
    slot.baker.destroy();
    slot.paletteTex.destroy();
    // Hand the single 2D overlay to another segmentation that is still shown, or clear it.
    if (!plural && this.overlayOwner === slot.id) {
      this.overlayOwner = undefined;
      for (const other of this.slots.values()) {
        if (other.lastDisp?.visible === false) continue;
        const [f, o] = slice2DOpacities(other.lastDisp!, true);
        this.overlayOwner = other.id;
        this.showOverlay(other, scene, f, o);
        break;
      }
      if (!this.overlayOwner) this.clearOverlay(scene);
    }
  }
}

export class ModelDisplayableManager implements DisplayableManager {
  interestedTypes = ["mesh", "modelDisplay"];
  private meshes = new Map<string, MrsonNode>();
  private displays = new Map<string, MrsonNode>();
  private geom = new Map<string, { key: string; positions: Float32Array; indices: Uint32Array }>();
  private loading = new Set<string>();
  private blobBaseHref = "";

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    if (node.type === "mesh") this.meshes.set(node.id, node);
    else if (node.type === "modelDisplay") this.displays.set(node.id, node);
    await this.refresh(scene);
  }
  onNodeRemoved(id: string, scene: LiveScene) { this.meshes.delete(id); this.displays.delete(id); this.geom.delete(id); void this.refresh(scene); }
  onSceneClosed(scene: LiveScene) { this.meshes.clear(); this.displays.clear(); this.geom.clear(); scene.view?.setMeshes?.([]); }

  private displayFor(mesh: MrsonNode): MrsonNode | undefined {
    for (const id of ((mesh.refs as Record<string, string[]> | undefined)?.display) ?? []) { const d = this.displays.get(id); if (d) return d; }
    return undefined;
  }
  private async ensureGeom(mesh: MrsonNode, scene: LiveScene): Promise<void> {
    const key = `${mesh.points}|${mesh.triangles}`;
    if (!mesh.points || !mesh.triangles) return;
    const have = this.geom.get(mesh.id);
    if (have?.key === key || this.loading.has(mesh.id)) return;
    this.loading.add(mesh.id);
    try {
      const [p, t] = await Promise.all([
        getBlobFetch()(new URL(mesh.points as string, this.blobBaseHref).href).then((r) => r.arrayBuffer()),
        getBlobFetch()(new URL(mesh.triangles as string, this.blobBaseHref).href).then((r) => r.arrayBuffer()),
      ]);
      this.geom.set(mesh.id, { key, positions: new Float32Array(p), indices: new Uint32Array(t) });
    } finally { this.loading.delete(mesh.id); }
    await this.refresh(scene);
  }
  // deno-lint-ignore require-await
  private async refresh(scene: LiveScene): Promise<void> {
    const view = scene.view;
    if (!view?.setMeshes) return;
    const out: SceneMeshData[] = [];
    for (const m of this.meshes.values()) {
      const d = this.displayFor(m);
      if (d && d.visible === false) continue;
      const g = this.geom.get(m.id);
      if (!g || g.key !== `${m.points}|${m.triangles}`) { void this.ensureGeom(m, scene); continue; }
      const col = (d?.color as number[]) ?? [0.8, 0.8, 0.8, 1];
      out.push({ id: m.id, positions: g.positions, indices: g.indices, color: [col[0], col[1], col[2]], opacity: (d?.opacity as number) ?? 1 });
    }
    view.setMeshes(out);
  }
}

/**
 * How a volume's texture is built, for the two managers that build one: SHARED under its content
 * key (the slice views and the volume rendering then hold one copy, not two), and HALF PRECISION.
 * See ImageFieldOpts.
 *
 * HALF PRECISION FOR EVERY VOLUME, not only a sequence's frames (Ron, 2026-09-24: "SI ok, space: I am
 * concerned about vessels"). It is the precision of each voxel's VALUE, not the grid: every voxel stays,
 * same size, same place, so a vessel's geometry is exactly as before. Values are exact to 2048 and within
 * 1 above (CT numbers of contrast, 200-600, are exact; dense bone and metal may read 1 off). The whole-body
 * CT goes from 1.6 GB to 0.8 GB on the card, in a window the system ends above about 4 GB. A byte volume
 * (a label map) stays one byte (fields.ts uploadVolumeTexture).
 */
/**
 * THE SAMPLES FOR A TEXTURE, AS STORED (render-audit 2026-10-15, finding 1): ImageField converts slab by slab to what the
 * card holds, so a 16-bit CT is no longer widened to a 32-bit copy (1.7 GB for C3N-01524) on its way. Typed as the
 * ZarrVolume the managers keep, whose samples are dropped (slim) once the texture is up; nothing else reads them.
 */
async function samplesAsStored(blobBase: string, z: ZarrDesc, onBytes?: (n: number) => void): Promise<ZarrVolume> {
  return await fetchZarrVolumeNative(blobBase, z, onBytes).then((nv) => ({ data: nv.data as unknown as Float32Array, dims: nv.dims, range: nv.range }));
}
function textureOpts(node: MrsonNode): { textureKey?: string; halfFloat?: boolean; rgb24?: boolean } {
  // A color volume (`rgb24: true` on its node, fields.ts ImageFieldOpts.rgb24) keeps its packed samples exact: no half float.
  if ((node as { rgb24?: boolean }).rgb24) return { textureKey: descKey(node.zarr as ZarrDesc) ?? undefined, rgb24: true };
  return { textureKey: descKey(node.zarr as ZarrDesc) ?? undefined, halfFloat: true };
}
/**
 * A sequence's frame keeps no CPU copy once its texture is up: 560 MB of f32 per frame on Ron's
 * coronary CTA, times two managers, was most of what killed the webview's page process
 * ("the image loaded, started beating and disappeared", 2026-09-12). The range and dims stay --
 * that is what the display code reads; the samples are on the GPU, and the probe reads them there.
 */
/**
 * THE SAMPLES GO WHEN THE TEXTURE IS UP. What is kept is the shape and the range, which is all
 * anything asks for until someone needs the voxels again — and then they are re-read (the colorize
 * build already does exactly that, and the zarr store is local).
 *
 * MEASURED, 2026-09-22, on Ron's window: one 768x768x709 CT with four whole-body segmentations, no
 * colorize anywhere, and the page held 5 GB and was ended. `__memoryReport()` named it — the CT's
 * samples, widened to float32 (1,595 MB), kept TWICE: once by the slice manager and once by the
 * volume rendering, each having fetched its own copy, for a volume that is 798 MB on the GPU and
 * shared there. Ron: "colorize was not used. So it should not be in memory at all. One grayscale
 * four labelmaps and surfaces."
 *
 * It was already done for a sequence's frames — of which several are resident, so the cost was
 * obvious — and not for the ordinary case of one big volume, where it is the same waste held for
 * longer. Nothing about the picture changes: the texture is what is drawn.
 */
/**
 * GIVE A VOLUME'S FIELD BACK once the views have drawn without it. Nothing did: closing a scene or removing a
 * volume dropped the field from the managers' maps and left its texture on the card (0.8 GB for the whole-body
 * CT, one per phase for the heart), kept reachable by the shared-texture table for the life of the page (code
 * review 2026-09-24, A1). The views are told first (the caller has done that); the texture goes after the next
 * frame, so no frame already on its way binds a destroyed texture. A hidden window draws no frames, hence the
 * two-second fallback. The texture itself is shared and counted (fields.ts): it goes with its last field.
 */
function releaseFieldLater(field: { destroy(): void } | undefined): void {
  if (!field) return;
  let done = false;
  const go = () => { if (done) return; done = true; try { field.destroy(); } catch { /* already gone */ } };
  const raf = (globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame;
  if (raf) raf(() => raf(go));
  setTimeout(go, 2000);
}

function slim(zv: ZarrVolume): ZarrVolume {
  return { data: new Float32Array(0), dims: zv.dims, range: zv.range };
}

// ── Slice composite layers ───────────────────────────────────────────────────

/** Mirrors vtkMRMLSliceCompositeNode per slice view: resolves the background / foreground / label
 *  volume refs to keyed ImageFields (fetched by content hash on demand), their display nodes (W/L,
 *  colour table) and colour tables, and hands each cell its layer stack. Multiple volumes, different
 *  volumes per view, label maps — the things the singleton VolumeRenderingDM could not express. */
export class VolumeLayersDisplayableManager implements DisplayableManager {
  interestedTypes = ["image", "scalarVolumeDisplay", "labelMapDisplay", "colorTable", "sliceComposite", "transform"];
  /** What this manager is holding on the CPU, per volume, for the memory report. */
  memoryReport(): { what: string; mb: number }[] {
    const out: { what: string; mb: number }[] = [];
    for (const [id, im] of this.images) {
      const n = im.zv?.data?.length ?? 0;
      const bytes = n * ((im.zv?.data as { BYTES_PER_ELEMENT?: number } | undefined)?.BYTES_PER_ELEMENT ?? 4);
      if (bytes) out.push({ what: `samples kept for ${String(im.node?.name ?? id).slice(0, 40)}`, mb: Math.round(bytes / 1048576) });
    }
    return out;
  }
  private images = new Map<string, { node: MrsonNode; field?: ImageField; zv?: ZarrVolume; loading?: boolean; effIjk?: string; failed?: string; failedAt?: number }>();
  private displays = new Map<string, MrsonNode>();
  private tables = new Map<string, MrsonNode>();
  private composites = new Map<string, MrsonNode>();   // layoutName -> node
  private blobBaseHref = "";

  constructor(private dev: GPUDevice, private onBytes?: (n: number) => void) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    if (node.type === "image") {
      const e = this.images.get(node.id);
      if (e) {
        e.node = node;
        // A FAILURE IS NOT FOREVER. The things that fail here are transient -- a chunk that could
        // not be read, a texture that could not be made on a page near its memory ceiling -- and
        // the flag that stops the retry storm was never cleared, so one bad moment blanked that
        // volume for the rest of the session with no way back short of reloading the window
        // (critic, 2026-09-22, finding 7). Anything written about the volume is another chance,
        // at most one every ten seconds so a load that writes it repeatedly cannot become the
        // storm the flag exists to prevent.
        if (e.failed && performance.now() - (e.failedAt ?? 0) > 10_000) {
          console.log(`trying again to build the picture for "${String(node.name ?? node.id)}"`);
          e.failed = undefined;
        }
        this.applyEffectiveIjk(node.id, scene);   // base geom and/or transform chain may have changed
      } else this.images.set(node.id, { node });
    }
    else if (node.type === "transform") { for (const id of this.images.keys()) this.applyEffectiveIjk(id, scene); }
    else if (node.type === "scalarVolumeDisplay" || node.type === "labelMapDisplay") this.displays.set(node.id, node);
    else if (node.type === "colorTable") this.tables.set(node.id, node);
    else if (node.type === "sliceComposite") this.composites.set(node.layoutName as string, node);
    await this.refresh(scene);
  }
  onNodeRemoved(id: string, scene: LiveScene) {
    const gone = this.images.get(id)?.field;
    this.images.delete(id); this.displays.delete(id); this.tables.delete(id);
    for (const [k, c] of this.composites) if (c.id === id) this.composites.delete(k);
    // The slice views are re-given their layers without it, then its texture goes (releaseFieldLater).
    void this.refresh(scene).then(() => releaseFieldLater(gone), () => releaseFieldLater(gone));
  }
  onSceneClosed(scene: LiveScene) {
    const gone = [...this.images.values()].map((e) => e.field);
    this.images.clear(); this.displays.clear(); this.tables.clear();
    for (const k of this.composites.keys()) scene.view?.setSliceLayers?.(k, {});
    this.composites.clear();
    for (const f of gone) releaseFieldLater(f);
  }

  /** world(transform chain) · base ijkToRAS — the geometry the field is actually placed with. */
  private effIjkOf(node: MrsonNode, scene: LiveScene): number[] {
    return rowMul(worldForNode(node, scene.nodes), node.ijkToRAS as number[]);
  }
  /** Re-place an image's field if its effective (transform-composed) geometry changed. */
  private applyEffectiveIjk(id: string, scene: LiveScene): void {
    const e = this.images.get(id); if (!e) return;
    const eff = this.effIjkOf(e.node, scene); const sig = JSON.stringify(eff);
    if (sig === e.effIjk) return;
    e.effIjk = sig;
    if (e.field) e.field.setIjkToRAS(eff);
  }

  private displayFor(image: MrsonNode): MrsonNode | undefined {
    const ids = ((image.refs as Record<string, string[]> | undefined)?.display) ?? [];
    for (const id of ids) { const d = this.displays.get(id); if (d) return d; }
    return undefined;
  }
  private lutFor(display: MrsonNode | undefined): Uint8Array | undefined {
    const cid = ((display?.refs as Record<string, string[]> | undefined)?.color ?? [])[0];
    const t = cid ? this.tables.get(cid) : undefined;
    const entries = t?.entries as number[][] | undefined;
    if (!entries || entries.length !== 256) return undefined;          // a 256-entry table maps the W/L ramp
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { lut[i * 4] = entries[i][0] * 255; lut[i * 4 + 1] = entries[i][1] * 255; lut[i * 4 + 2] = entries[i][2] * 255; lut[i * 4 + 3] = 255; }
    // Grey is the identity ramp: skip the LUT so the plain grayscale path (and interpolation) is used
    if (entries.every((e, i) => Math.abs(e[0] * 255 - i) < 1 && Math.abs(e[1] * 255 - i) < 1 && Math.abs(e[2] * 255 - i) < 1)) return undefined;
    return lut;
  }
  private labelTableFor(display: MrsonNode | undefined): Uint8Array | undefined {
    const cid = ((display?.refs as Record<string, string[]> | undefined)?.color ?? [])[0];
    const t = cid ? this.tables.get(cid) : undefined;
    const entries = t?.entries as number[][] | undefined;
    if (!entries?.length) return undefined;
    const table = new Uint8Array(entries.length * 4);
    entries.forEach((e, i) => { table[i * 4] = e[0] * 255; table[i * 4 + 1] = e[1] * 255; table[i * 4 + 2] = e[2] * 255; table[i * 4 + 3] = (e[3] ?? 1) * 255; });
    return table;
  }
  /**
   * The samples for a field -- or, when the volume's texture is ALREADY on the GPU under its
   * content key (the other manager built it) and its range is known, no samples at all: ImageField
   * adopts the resident texture and never reads `data`. Fetching and widening 559 MB to hand a
   * constructor an array it ignores was half of a frame's first-show stall (critic, 2026-09-19).
   */
  private async samplesOrResident(node: MrsonNode): Promise<ZarrVolume> {
    const z = node.zarr as ZarrDesc;
    const key = descKey(z) ?? undefined;
    const range = knownRange(z);
    if (hasSharedTexture(key) && range) return { data: new Float32Array(0), dims: [...(z.shape as number[])].reverse() as [number, number, number], range };
    return await samplesAsStored(this.blobBaseHref, z, this.onBytes);
  }
  /** Build the fields of these images now (a sequence's frames at load), reporting as it goes. */
  async prepare(ids: string[], scene: LiveScene, onProgress?: (i: number, n: number) => void): Promise<void> {
    for (const [i, id] of ids.entries()) { onProgress?.(i, ids.length); await this.ensureField(id, scene); }
  }
  private async ensureField(id: string, scene: LiveScene): Promise<ImageField | undefined> {
    const e = this.images.get(id);
    if (!e || !e.node.zarr) return undefined;
    if (e.field) return e.field;
    if (e.loading) return undefined;
    if (e.failed) return undefined;                  // said once; a retry storm would say it forever
    e.loading = true;
    try {
      e.zv = await this.samplesOrResident(e.node);
      const lut = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = i; lut[i * 4 + 3] = 255; }
      const eff = this.effIjkOf(e.node, scene); e.effIjk = JSON.stringify(eff);
      e.field = new ImageField(this.dev, e.zv.data, e.zv.dims, [1, 1, 1], lut, { clim: e.zv.range, ijkToRAS: eff, ...textureOpts(e.node) });
      e.zv = slim(e.zv);
      forgetDecoded(e.node.zarr as ZarrDesc);          // the texture is up; the samples were the last copy
    } catch (err) {
      // A SLICE VIEW THAT DRAWS NOTHING HAS TO SAY WHY. This used to leave the layer unresolved
      // and the view reading "loading…" for ever: Ron, 2026-09-22, "the slice viewers are
      // misbehaving. The scene module says they are on, but nothing is visible in the views."
      // Whatever went wrong -- the samples could not be read, the texture could not be made --
      // is now the reason the view shows, and a line in the session log.
      e.failed = (err as Error)?.message ?? String(err);
      e.failedAt = performance.now();
      const say = `the picture for "${String(e.node.name ?? id)}" could not be built: ${e.failed}`;
      console.error(say);
      try { void fetch("/_log", { method: "POST", body: say, keepalive: true }).catch(() => {}); } catch { /* no server */ }
    } finally { e.loading = false; }
    void this.refresh(scene);      // a layer became available: re-hand the stacks
    return e.field;
  }
  /**
   * Subject Hierarchy's per-view toggles (Ron: "each view independently, with the option to link
   * all the slice viewers"): true if `node` is hidden in this specific slice view, either by the
   * blanket `visible` flag or by `hiddenViews` (absent/empty there means visible everywhere, so
   * nothing already relying on `visible` alone changes behavior).
   */
  private isHiddenIn(node: MrsonNode | undefined, layoutName: string): boolean {
    if (!node) return false;
    return node.visible === false || ((node.hiddenViews as string[] | undefined) ?? []).includes(layoutName);
  }
  private scalarLayer(id: string | undefined, scene: LiveScene, layoutName: string): ScalarLayer | undefined {
    if (!id) return undefined;
    const e = this.images.get(id);
    if (!e || this.isHiddenIn(e.node, layoutName)) return undefined;
    if (!e.field) { if (!e.failed) void this.ensureField(id, scene); return undefined; }
    const d = this.displayFor(e.node);
    const range = e.zv?.range ?? [0, 1];
    const win = (d?.window as number) ?? (range[1] - range[0]);
    const lev = (d?.level as number) ?? (range[0] + range[1]) / 2;
    return { id, field: e.field, win, lev, lut: this.lutFor(d), interpolate: (d?.interpolate as boolean) ?? true, name: e.node.name as string };
  }
  // deno-lint-ignore require-await
  private async refresh(scene: LiveScene): Promise<void> {
    const view = scene.view;
    if (!view?.setSliceLayers) return;
    for (const [layoutName, comp] of this.composites) {
      const refs = (comp.refs as Record<string, string[]> | undefined) ?? {};
      const layers: SliceLayers = { linked: !!comp.linkedControl };
      const bgId = refs.background?.[0];
      const bg = this.scalarLayer(bgId, scene, layoutName);
      if (bg) layers.background = bg;
      // A background IS assigned here, just hidden for this view -- say so, or the view's own
      // fallback to the shared volume-rendering field would silently undo the per-view hide.
      else if (bgId && this.isHiddenIn(this.images.get(bgId)?.node, layoutName)) {
        layers.backgroundSuppressed = true;
        layers.emptyReason = "hidden in this view";
      }
      else if (!bgId) layers.emptyReason = "no volume in this view";
      // A reference to a node that is GONE. Not the same as no reference, and it used to look
      // identical on screen: the layer resolved to nothing while the composite still claimed one.
      else if (!this.images.get(bgId)) layers.emptyReason = "volume no longer loaded";
      else if (this.images.get(bgId)?.failed) layers.emptyReason = `could not be drawn: ${this.images.get(bgId)!.failed}`;
      else layers.emptyReason = "loading\u2026";
      const fg = this.scalarLayer(refs.foreground?.[0], scene, layoutName);
      if (fg) layers.foreground = { ...fg, opacity: (comp.foregroundOpacity as number) ?? 0, compositing: (comp.compositing as number) ?? 0 };
      const lid = refs.label?.[0];
      if (lid) {
        const e = this.images.get(lid);
        const hiddenHere = this.isHiddenIn(e?.node, layoutName);
        if (e && !e.field) void this.ensureField(lid, scene);
        const table = this.labelTableFor(e ? this.displayFor(e.node) : undefined);
        if (e?.field && table && !hiddenHere) layers.label = { field: e.field, table, opacity: (comp.labelOpacity as number) ?? 1, name: e.node.name as string };
      }
      view.setSliceLayers(layoutName, layers);
    }
  }
}

// ── Volume rendering ─────────────────────────────────────────────────────────

/** Mirrors EVERY scalar volume in the scene: builds an ImageField for one when a volume-rendering
 *  display makes it VISIBLE (and, for the first volume, at load, so the legacy slice path can
 *  reslice it immediately via view.setVolumeField, matching Slicer showing slices on load), then
 *  publishes it to the 3D view with view.setVolume3D. Several volumes may be published at once --
 *  the 3D view composites them, which is what SceneRenderer.build() has always taken a LIST for.
 *  TF changes re-LUT in place; window/level updates the slice display. */
/**
 * What the last palette write actually put in the texture.
 *
 * A diagnostic, read by the panel. Ron reported the group sliders having "virtually no effect" and I
 * could not tell from the code whether the value was failing to reach the palette or reaching it and
 * not mattering -- the two look identical from outside and I reasoned my way to both conclusions.
 * The alpha here is read back OUT of the palette after the write, so it answers the first question
 * rather than echoing the input.
 */
/** GPU memory the segmentation currently holds for 3D: the smoothed volume plus the blur scratch,
 *  or zero when the colorize volume is drawing the segments and neither is built. Reported in the
 *  panel because "we no longer allocate this" is exactly the kind of claim that should be shown
 *  rather than asserted. */

/** Timing hooks the application installs (load-profile.ts); no-ops in tests and benches. */
export let timedLoad: <T>(name: string, fn: () => Promise<T>) => Promise<T> = (_n, fn) => fn();
export let timedLoadSync: <T>(name: string, fn: () => T) => T = (_n, fn) => fn();
export function setLoadTimers(a: typeof timedLoad, b: typeof timedLoadSync) { timedLoad = a; timedLoadSync = b; }


/**
 * One volume's 3D rendering state.
 *
 * All of this used to be fields on the manager itself, which is why there could only ever be one:
 * `this.image` locked onto a volume and every resource below hung off it. Ron loads a study and
 * then another one and wants both in 3D -- "the data should be arranged so it is clear which seg
 * belongs to which ct" -- so the state that is per-volume now lives per volume, and the manager
 * holds a map of these. The transfer function stays shared: it is one node in the scene, and two
 * CTs sharing a preset is the wanted behavior, not a limitation.
 */
interface VrSlot {
  /** Colorize builds asked for and not yet out, and the one banner they share (render/working.ts). */
  buildCalls?: number;
  buildWork?: Work;
  image: MrsonNode;
  /** The frame this one is replacing in the 3D view, withdrawn in the same rebuild that adds this one. */
  swapFrom?: string;
  /** This volume's own scalarVolumeDisplay (window/level), never another's. */
  scalarDisp?: MrsonNode;
  zv?: ZarrVolume;
  field?: ImageField;
  // Colorize rendering: the CT tinted by segment, with UNLABELED voxels left nearly transparent.
  // This is what the colorize page shows in 3D, and the reason a plain grayscale volume rendering
  // looks dark and solid by comparison: CT presets are opaque well below skin, so the body becomes a
  // shell. Built only when a segmentation covers this volume; the slice views are untouched.
  /**
   * EVERY segmentation drawn on this volume, by id — not the last one seen.
   *
   * This was a single `seg?: MrsonNode`, assigned once per segmentation node, so a volume with two
   * segmentations kept whichever arrived last. That is the same single-instance bug this file has
   * already fixed twice (one volume rather than a map; one segmentation slot rather than one each),
   * one level further down, hiding as a field on a slot rather than as a manager.
   */
  segs: Map<string, MrsonNode>;
  /**
   * Whether this volume should be colorized by its segmentation at all. A display setting on the
   * volumeRenderingDisplay node (`colorize`, absent = true), because Ron wanted it switchable from
   * the Volume Rendering module without touching the segmentation: off means the CT draws grayscale
   * with the segmentation's own 3D field or surfaces on top, exactly as if no segmentation existed
   * for the purposes of this volume's rendering. Display only; nothing about the data changes.
   */
  colorize: boolean;
  /**
   * The segmentation `colorField` was ACTUALLY built from, or undefined when there is no colorize
   * volume. Distinct from "the newest segmentation we have seen", and the distinction is the bug:
   * push() published the latter, telling the 3D view that a segmentation was already being drawn by
   * the volume when the volume was drawing a different one. That segmentation's own field then stood
   * down as a duplicate and nothing drew it.
   */
  colorizeSegId?: string;
  /**
   * What `colorField` was built FROM: the segmentation id and its labelmap's identity. A patch that
   * changes a color or a visibility flag does not change this, and must not cause a rebuild.
   */
  colorizeSig?: string;
  /** Segments changed while the rendering was off: rebuild or re-palette when it comes back on. */
  colorizeStale?: boolean;
  segZv?: ZarrVolumeNative;
  colorField?: ColorizeField;
  /** A colorize build in flight for this slot; a second request waits for it. */
  colorizing?: Promise<void>;
  /** The shared label texture the colorize field adopted (labelTextures key), for release. */
  colorLabelsKey?: string;
  /** What the colorize field allocated, for the running tally. */
  colorBytes?: number;
  /** world(transform chain) · base ijkToRAS, as last placed. */
  effSig: string;
  /** This volume's own transferFunction node (volumeRenderingDisplay.refs.property). Per volume,
   *  not per scene: a CT preset's stops are Hounsfield units, and an MR volume shown under them
   *  renders as a solid block. */
  tf?: MrsonNode;
  tfId?: string;
  /** This volume's volumeRenderingDisplay node, and whether it says to draw it. */
  vrId?: string;
  visible: boolean;
  building: boolean;
  /** When building the 3D field last failed (performance.now()); retried after ten seconds. */
  failedAt?: number;
  /** How many times in a row it failed (retried by itself up to three times). */
  retries?: number;
}

/** The colored fields' diagnostic lines (__gpuLog), the last GPU_LOG_KEEP of them: a sequence playing added about twenty a
 *  second, kept for the whole session (critic 2026-10-16, general audit, finding 6). */
const GPU_LOG_KEEP = 300;
function gpuLogLine(m: string): void {
  const g = globalThis as unknown as { __gpuLog?: string[] };
  const log = (g.__gpuLog ??= []);
  log.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
  if (log.length > GPU_LOG_KEEP) log.splice(0, log.length - GPU_LOG_KEEP);
}

export class VolumeRenderingDisplayableManager implements DisplayableManager {
  /** What this manager is holding, per rendered volume, for the memory report. */
  memoryReport(): { what: string; mb: number }[] {
    const out: { what: string; mb: number }[] = [];
    for (const [id, slot] of this.slots) {
      const ct = (slot.zv?.data?.length ?? 0) * ((slot.zv?.data as { BYTES_PER_ELEMENT?: number } | undefined)?.BYTES_PER_ELEMENT ?? 4);
      const lab = (slot.segZv?.data?.length ?? 0) * ((slot.segZv?.data as { BYTES_PER_ELEMENT?: number } | undefined)?.BYTES_PER_ELEMENT ?? 1);
      if (ct) out.push({ what: `CT samples on the rendering of ${id.slice(0, 28)}`, mb: Math.round(ct / 1048576) });
      if (lab) out.push({ what: `labelmap samples kept for colorize on ${id.slice(0, 28)}`, mb: Math.round(lab / 1048576) });
      if (slot.colorBytes) out.push({ what: `colorize field on ${id.slice(0, 28)} (GPU)`, mb: Math.round(slot.colorBytes / 1048576) });
    }
    return out;
  }
  interestedTypes = ["image", "volumeRenderingDisplay", "scalarVolumeDisplay", "transferFunction", "transform", "segmentation"];
  /** Every scalar volume this manager knows about, keyed by image id. */
  private slots = new Map<string, VrSlot>();
  /** volumeRenderingDisplay node id -> the image it names, so a removed node finds its slot. */
  private vrOwner = new Map<string, string>();
  /** The first image seen: the one pushed to `setVolumeField` for the legacy single-volume slice
   *  path (scenes with no sliceComposite nodes). The 3D view no longer goes through it. */
  private primaryId?: string;
  private blobBaseHref = "";
  private view?: MirrorView;
  private finishWatch?: () => void;

  constructor(private dev: GPUDevice, private onBytes?: (n: number) => void) {}

  async onNodeAdded(node: MrsonNode, scene: LiveScene): Promise<void> {
    this.blobBaseHref = scene.blobBase();
    this.view = scene.view;
    this.lastScene = scene;
    let touched: VrSlot | undefined;
    if (node.type === "image") {
      if (node.labelmap) return;                     // a labelmap is a segmentation's source, not a VR volume
      const slot = this.slots.get(node.id);
      if (slot) {
        const prev = slot.effSig;
        slot.image = node;
        this.replaceGeometry(slot, scene, prev);
        touched = slot;
      } else {
        touched = this.addSlot(node, scene);
      }
    }
    else if (node.type === "transform") {
      // A transform edit can move any of them; re-place every slot whose effective geometry changed.
      for (const s of this.slots.values()) this.replaceGeometry(s, scene, s.effSig);
      return;
    }
    else if (node.type === "volumeRenderingDisplay") {
      const imageId = ((node.refs as Record<string, string[]> | undefined)?.volume ?? [])[0];
      const prev = this.vrOwner.get(node.id);
      // Repointed at a different volume (the singleton node this used to be did exactly that on
      // every toggle): the volume it no longer names stops being drawn.
      //
      // BUT NOT BEFORE THE NEW ONE IS READY. Withdrawing the old frame here, then adding the new
      // one after an awaited ensureField, took the 3D view through "nothing in 3D" on EVERY step
      // of a sequence -- and that path destroys every surface buffer on the GPU (ten sets, ~375 MB
      // for the cardiac case) and re-uploads them all on the same step, with a second shader
      // compile for good measure (critic, 2026-09-19, finding 1: the "ponderous"). The old frame
      // stays on screen until the new one is published, and the two change places in one rebuild.
      let withdraw: string | undefined;
      if (prev && prev !== imageId) {
        const old = this.slots.get(prev);
        if (old) { old.visible = false; old.vrId = undefined; withdraw = prev; }
      }
      if (!imageId) { if (withdraw) this.push(withdraw, this.slots.get(withdraw)!); return; }
      this.vrOwner.set(node.id, imageId);
      let slot = this.slots.get(imageId);
      if (!slot) {
        const img = scene.nodes.get(imageId);
        if (!img) return;                            // the display node arrived first; the image will find it
        slot = this.addSlot(img, scene);
      }
      slot.vrId = node.id;
      slot.tfId = ((node.refs as Record<string, string[]> | undefined)?.property ?? [])[0];
      if (slot.tfId) slot.tf = scene.nodes.get(slot.tfId) ?? slot.tf;
      slot.visible = !!node.visible;
      // RENDERING OFF FREES THE COLORIZE FIELD. It is 1196 MB at 768x768x709 and nobody can see it
      // while the volume is not rendered; WebKit ends the page at 4 GB. Switching the rendering
      // back on rebuilds it (the `touched` path below), a few seconds against a gigabyte held.
      // Destroy and publish in one breath, as the colorize-off case does, so no frame is
      // submitted against a freed palette.
      if (!slot.visible && (slot.colorField || slot.colorizeSegId !== undefined)) { this.decolorize(slot); this.push(imageId, slot); }
      // And every other frame of its sequence, which now keep their colors between steps (colorizeOtherFrames).
      if (!slot.visible && slot.image.sequence) for (const o of this.slots.values()) if (o !== slot && o.image.sequence === slot.image.sequence && !o.visible && o.colorField) this.decolorize(o);
      // Absent means ON for a sequence, OFF for a single volume (see buildColorize).
      const wantColorize = slot.image.sequence ? (node.colorize as boolean | undefined) !== false : node.colorize === true;
      // A different segmentation asked for: rebuild with it, even though the switch did not move.
      const wantWith = node.colorizeWith as string | undefined;
      if (wantColorize && slot.colorize && wantWith && wantWith !== slot.colorizeSegId && slot.segs.has(wantWith)) {
        if (slot.visible) void this.buildColorize(slot, scene, slot.segs.get(wantWith)!); else slot.colorizeStale = true;
      }
      if (wantColorize !== slot.colorize) {
        slot.colorize = wantColorize;
        if (!wantColorize) {
          // Switched off: give back the colorize volume and publish the grayscale one. The
          // segmentation's own field or surfaces reappear because the view no longer sees it as
          // "drawn by the volume".
          //
          // PUSH IN THE SAME BREATH AS THE DESTROY. The caller publishes `touched` only after an
          // awaited ensureField, and in that gap the view submitted a frame against the palette
          // decolorize had just freed: "Destroyed texture (256x2, RGBA8Unorm) used in a submit",
          // every view dead. The segmentation-removal path below does decolorize-then-push with no
          // await between, and that is the only correct order.
          if (slot.colorField || slot.colorizeSegId !== undefined) { this.decolorize(slot); this.push(imageId, slot); }
          // And the other frames of its sequence, which keep their colors between steps (critic 2026-10-16, finding 4).
          if (slot.image.sequence) for (const o of this.slots.values()) if (o !== slot && o.image.sequence === slot.image.sequence && !o.visible && o.colorField) this.decolorize(o);
        } else {
          // Switched on with a segmentation present: build it, preferring the one we colorized
          // before so a toggle off and on comes back to the same picture -- and only while the
          // volume is rendered; a display node arriving off (a scene's) builds nothing (see the
          // segmentation path below; the `touched` path builds when it comes on).
          const seg = slot.visible ? this.colorizeChoice(slot, scene) : undefined;
          if (seg) void this.buildColorize(slot, scene, seg);
        }
      }
      touched = slot;
      touched.swapFrom = withdraw;
    }
    else if (node.type === "transferFunction") {
      for (const s of this.slots.values()) if (s.tfId === node.id) { s.tf = node; this.reLUT(s); }
      return;
    }
    else if (node.type === "segmentation") {
      // A segmentation belongs to the volume its `source` names -- and to every frame of that
      // volume's sequence (see `covers`); it colorizes each of them.
      for (const slot of this.slots.values()) {
        if (!this.covers(node, slot.image, scene)) continue;
        slot.segs.set(node.id as string, node);
        // Keep colorizing whichever one we already were, if it is still here. Switching on every
        // arrival makes the second segmentation silently take over the first one's rendering, which
        // is what Ron saw as "much coarser ... and also the lighting is different": the colorize
        // volume replacing smoothed surfaces.
        const target = this.colorizeChoice(slot, scene) ?? node;
        // A frame that is not on screen is colorized when it comes on screen (buildColorize is
        // called from ensureField), not now: five frames rebuilt at once for a color change
        // would be five label uploads for nothing.
        // AND ONLY WHILE THE VOLUME IS RENDERED. This built the colorize field for every arriving
        // segmentation of a plain volume whether or not its rendering was on -- 1196 MB at
        // 768x768x709, three times over on opening a scene with three segmentations, none of it
        // visible -- and WebKit ends the page at 4 GB (Ron's merge review, 2026-09-21). A volume
        // rendered later builds it then (the `touched` path below); one whose field exists but is
        // off is marked stale and refreshed when it comes back on. Ron: "I just need the labels
        // and surfaces for the merge."
        if (!slot.visible) { if (slot.colorField) slot.colorizeStale = true; continue; }
        if (slot.colorize && (target.id !== slot.colorizeSegId || slot.colorField)) void this.buildColorize(slot, scene, target);
      }
      // A SEQUENCE'S OTHER FRAMES are colored again with what has arrived, once the arrivals settle (scheduleFrameColors).
      const seqs = new Set<string>();
      for (const slot of this.slots.values()) if (slot.visible && slot.colorize && slot.image.sequence && this.covers(node, slot.image, scene)) seqs.add(slot.image.sequence as string);
      for (const q of seqs) this.scheduleFrameColors(q, scene);
      return;
    }
    else if (node.type === "scalarVolumeDisplay") {
      // Only the volume that actually references this display node. Another image's display must not
      // hijack a volume's W/L push -- a locally loaded file did exactly that, 2026-08-29.
      for (const s of this.slots.values()) {
        if (((s.image.refs as Record<string, string[]> | undefined)?.display ?? []).includes(node.id)) {
          s.scalarDisp = node;
          if (s.image.id === this.primaryId && s.field) this.view?.setVolumeField(s.field, this.wl(s));
          this.push(s.image.id, s);
        }
      }
      return;
    }
    if (touched) {
      // A volume's samples are fetched when it is FIRST wanted in 3D, not at load: a CT is hundreds
      // of megabytes and a second study that nobody has asked to see in 3D should not pay for one.
      // The first volume is the exception -- the legacy slice path reads its field.
      if (touched.visible || touched.image.id === this.primaryId) await this.ensureField(touched, scene);
      // A frame of a sequence coming on screen with a segmentation covering it (see `covers`) is
      // colorized now, on its own field: the other frames were not, on purpose.
      if (touched.visible && touched.colorize && (!touched.colorField || touched.colorizeStale) && touched.segs.size) {
        touched.colorizeStale = false;
        const target = this.colorizeChoice(touched, scene);
        if (target) await this.buildColorize(touched, scene, target);
      }
      // If buildColorize already published this frame (and swapped the old one out), the swap
      // is consumed and this is a plain re-publish of the same field set: no shader compile.
      this.push(touched.image.id, touched);
    }
  }
  onEvent() {/* changes arrive as NodeAdded upserts, handled above */}

  /**
   * A SEGMENTATION COVERS EVERY FRAME OF ITS SEQUENCE. It is computed on one frame -- the one on
   * screen when the network ran -- and its `source` names that frame; but the frames of a
   * sequence share one grid, and what Ron wants from it is the beating heart with the chest wall
   * and the lung vessels gone: "segmentation would allow me to actually see the beating heart."
   * So it colorizes each frame as it comes, the heart moving a little under a mask that does not.
   */
  private covers(seg: MrsonNode, image: MrsonNode, scene: LiveScene): boolean {
    const src = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    if (!src) return false;
    if (src === image.id) return true;
    const seqId = image.sequence as string | undefined;
    if (!seqId) return false;
    return scene.nodes.get(src)?.sequence === seqId;
  }
  /**
   * One label texture per LABELMAP, shared by the colorize fields of every frame it covers. Keyed
   * by the segmentation and its content signature, so a re-segmented labelmap gets a new entry
   * rather than replacing one that fields still read: the first version keyed by id alone
   * destroyed a texture under a queued frame ("Destroyed texture ... used in a submit", every
   * view dead). Freed, a moment later, when the last field holding it goes.
   */
  private labelTextures = new Map<string, { tex: GPUTexture; refs: number }>();
  /** A merged label texture's members and their renumbering (labelTextures key -> what each member's labels became). */
  private mergeInfos = new Map<string, { segId: string; remap: Uint32Array }[]>();
  /**
   * WHAT ONE FRAME'S FIELD DRAWS under the solid look of a series that plays: `primary` and every other family shown in
   * 3D with the solid look -- each taken at THIS frame (frameMate) -- most structures first. Otherwise `primary` alone,
   * as before.
   */
  private mergeMembers(slot: VrSlot, primary: MrsonNode, scene: LiveScene): MrsonNode[] {
    const seq = slot.image.sequence as string | undefined;
    if (!seq || !this.solidOf(slot) || !this.framesPlay(seq, scene)) return [primary];
    const out = new Map<string, MrsonNode>([[primary.id as string, primary]]);
    // BY FAMILY, not by member: a family is shown when ANY of its members is. A step hides the leaving phase's members and
    // shows the arriving ones in separate writes, so asking each member made a frame see one family mid-step and build
    // without the other -- rebuilds and churn while playing (checked in the pane, 2026-10-16).
    const shown = new Map<string, boolean>();
    for (const v of slot.segs.values()) {
      const mateId = frameMate(scene, v.id as string, slot.image.id as string) ?? (v.id as string);
      const on = ((v.visible3D as boolean | undefined) ?? (v.visible as boolean | undefined)) !== false;
      shown.set(mateId, (shown.get(mateId) ?? false) || on);
    }
    for (const [mateId, on] of shown) {
      if (!on) continue;                                // a family not shown
      const m = scene.nodes.get(mateId);
      if (!m?.zarr || segLookOf(scene, m) !== "solid") continue;
      const dimsOk = (m.dims as number[] | undefined)?.every((d, i) => d === slot.zv?.dims[i]);
      if (dimsOk) out.set(m.id as string, m);
    }
    // A provisional order, the same on every frame (so the signature is): by Scene's ▲▼ when every family has it, else by
    // id. The drawing order itself is settled once the labels are read (mergeOrder).
    const z = (m: MrsonNode) => this.familyLook(slot, scene, m).zOrder;
    const list = [...out.values()].sort((a, b) => typeof z(a) === "number" && typeof z(b) === "number" ? (z(a) as number) - (z(b) as number) : String(a.id) < String(b.id) ? -1 : 1);
    // Counted over the structures SHOWN, which are the ones given a number -- as the solid group counts (critic
    // 2026-10-16, step 2, finding 7). Past 255 the frame draws its own family alone, and says so once.
    const shownCount = (m: MrsonNode) => { const hidden = this.mergeHidden(slot, scene, m); return ((m.segments as { name?: string }[] | undefined) ?? []).filter((sg) => !hidden.has(String(sg.name))).length; };
    const labels = list.reduce((n, m) => n + shownCount(m), 0);
    if (labels <= 255) return list;
    const say = `the time series in 3D shows ${String(primary.name ?? primary.id)} alone: its segmentations have more than 255 structures shown together; hide some to bring them in`;
    if (this.mergeLeftSaid !== say) {
      this.mergeLeftSaid = say;
      (globalThis as unknown as { __shell?: { setStatus(m: string): void } }).__shell?.setStatus(say);
    }
    return [primary];
  }
  private mergeLeftSaid = "";
  /** A FAMILY'S LOOK -- its structures' colors, visibility, its ▲▼ order -- is read from the member shown now, the same for
   *  every frame: a frame's own member is marked hidden whenever another frame is shown (pane, 2026-10-16). */
  private familyLook(slot: VrSlot, scene: LiveScene, member: MrsonNode): MrsonNode {
    return this.familyShownMember(slot, scene, member) ?? member;
  }
  /** The member of `member`'s family shown in 3D now (its 3D button on), or nothing when the family is hidden in 3D. */
  private familyShownMember(slot: VrSlot, scene: LiveScene, member: MrsonNode): MrsonNode | undefined {
    const mateId = member.id as string;
    for (const v0 of slot.segs.values()) {
      const v = scene.nodes.get(v0.id as string) ?? v0;
      if (((v.visible3D as boolean | undefined) ?? (v.visible as boolean | undefined)) === false) continue;
      if ((frameMate(scene, v.id as string, slot.image.id as string) ?? v.id) === mateId) return v;
    }
    return undefined;
  }
  /** The NAMES of a member's structures hidden in 3D (its eye, or opacity 0), from its family's look. A hidden structure is
   *  not written into the merge, so what lies behind it shows -- the solid group's rule (critic 2026-10-16, step 2,
   *  finding 4). */
  private mergeHidden(slot: VrSlot, scene: LiveScene, member: MrsonNode): Set<string> {
    // THE FAMILY'S OWN 3D BUTTON (Ron, 2026-10-16: "chambers stay even when i turn them off by pushing the 3d button in
    // the scenes view"): the family the field was built around is in every merge, so hidden in 3D it is written with
    // none of its structures -- what is behind shows, as for any other family turned off.
    if (!this.familyShownMember(slot, scene, member)) return new Set(((member.segments as { name?: string }[] | undefined) ?? []).map((sg) => String(sg.name)));
    const look = this.familyLook(slot, scene, member);
    return new Set(((look.segments as { name?: string; visible?: boolean; opacity?: number }[] | undefined) ?? [])
      .filter((sg) => sg.visible === false || (typeof sg.opacity === "number" && sg.opacity <= 0)).map((sg) => String(sg.name)));
  }
  /** Labeled voxels of a member's labels (every 7th voxel, as the segmentation manager counts), by member and data. */
  private mergeVoxels = new Map<string, number>();
  private releaseLabels(key: string | undefined): void {
    const t = key ? this.labelTextures.get(key) : undefined;
    if (t && --t.refs <= 0) { this.labelTextures.delete(key!); this.mergeInfos.delete(key!); const tex = t.tex; setTimeout(() => tex.destroy(), 250); }
  }

  /** Start tracking an image. Picks up a volumeRenderingDisplay and a segmentation that are already
   *  in the scene: either may have been written before this image arrived, and neither event fires
   *  again afterwards. */
  private addSlot(node: MrsonNode, scene: LiveScene): VrSlot {
    const slot: VrSlot = { image: node, effSig: "", visible: false, building: false, segs: new Map(), colorize: true };
    this.slots.set(node.id, slot);
    if (!this.primaryId) this.primaryId = node.id;
    const dispId = ((node.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
    slot.scalarDisp = dispId ? scene.nodes.get(dispId) : undefined;
    for (const n of scene.nodes.values()) {
      if (n.type === "volumeRenderingDisplay" && ((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] === node.id) {
        slot.vrId = n.id; slot.visible = !!n.visible; this.vrOwner.set(n.id, node.id);
        slot.tfId = ((n.refs as Record<string, string[]> | undefined)?.property ?? [])[0];
        if (slot.tfId) slot.tf = scene.nodes.get(slot.tfId);
      } else if (n.type === "segmentation" && this.covers(n, node, scene)) {
        slot.segs.set(n.id as string, n);
      }
    }
    return slot;
  }

  /**
   * STOP DRAWING THE COLORIZED VOLUME, and give back its textures.
   *
   * Ron, after a demo: "When I turned off ts:total and deleted it from the scene, the volume
   * rendering of the gray scale volume still showed the colorize volume colorization and
   * visibility."
   *
   * `push` picks `slot.colorField ?? slot.field`, so while the colorize field EXISTS it is what the
   * 3D view shows -- and clearing `colorizeSegId` alone (which is all the early exits did) leaves the
   * colored picture on screen with nothing left in the scene to explain it. The field has to go, not
   * just the name of what it was built from. It is also the biggest thing this manager holds, so
   * keeping it for a segmentation that no longer exists wastes the memory as well as lying.
   */
  /**
   * WHICH SEGMENTATION TINTS THE VOLUME, when it has several.
   *
   * It was the first to arrive. Ron, with ts:total and ts:lung_vessels on one CT: "I get colorized
   * volume with the lung vessels, not the total. How do I change it?" -- he could not. Now: the one
   * the display node names (`colorizeWith`, set from the Volume Rendering module), else the one
   * with the most structures -- a whole-body result over a four-structure specialist, which is what
   * a person expects to see tinted before they have said otherwise. A tie keeps the one already
   * colorizing, so a toggle off and on comes back to the same picture, and an arrival of the same
   * size does not silently take over (the "much coarser" surprise of 2026-09-10).
   */
  private colorizeChoice(slot: VrSlot, scene: LiveScene): MrsonNode | undefined {
    // A named choice, or the one already in use, stands for ITS SEQUENCE when it is in one: this
    // frame is colorized by the member made on it (logic/sequences.ts frameMate).
    const mate = (id: string | undefined) => { const m = id ? frameMate(scene, id, slot.image.id) : undefined; return m && slot.segs.has(m) ? slot.segs.get(m) : undefined; };
    const want = slot.vrId ? (scene.nodes.get(slot.vrId)?.colorizeWith as string | undefined) : undefined;
    if (want) { const m = mate(want); if (m) return m; if (slot.segs.has(want)) return slot.segs.get(want); }
    const count = (s: MrsonNode) => ((s.segments as unknown[] | undefined) ?? []).length;
    let best: MrsonNode | undefined = mate(slot.colorizeSegId) ?? (slot.colorizeSegId ? slot.segs.get(slot.colorizeSegId) : undefined);
    // Own frame first: a member made on this very frame beats one covering it from another.
    const own = (s: MrsonNode) => ((s.refs as Record<string, string[]> | undefined)?.source ?? [])[0] === slot.image.id;
    for (const s of slot.segs.values()) if (!best || (own(s) && !own(best)) || (own(s) === own(best) && count(s) > count(best))) best = s;
    return best;
  }

  private decolorize(slot: VrSlot): void {
    if (slot.colorField) {
      // The GPU-memory line in the log is a running total; it used to only go up, so after an
      // off-and-on toggle it reported 208 MB for a 104 MB field and read as a leak that was not one.
      const g = globalThis as unknown as { __gpuMB?: number };
      g.__gpuMB = Math.max(0, (g.__gpuMB ?? 0) - Math.round((slot.colorBytes ?? 0) / 1048576));
      slot.colorBytes = undefined;
    }
    if (slot.colorField) { slot.colorField.destroy(); this.releaseLabels(slot.colorLabelsKey); }
    slot.colorField = undefined;
    slot.colorLabelsKey = undefined;
    slot.colorizeSegId = undefined;
    slot.colorizeSig = undefined;
  }

  /** Publish (or withdraw) this volume's contribution to the 3D view. The colorize field replaces
   *  the grayscale one when it exists -- they are alternatives, not layers -- and naming the
   *  segmentation it draws is what lets that segmentation's own 3D field stand down instead of
   *  painting the same anatomy a second time. */
  /** The scene last seen (push has none of its own; a series' "plays" is asked of it). */
  private lastScene?: LiveScene;
  /** A series that plays: ONE field in the 3D view (render/series-field.ts), keyed `series:<sequence id>`. */
  private series = new Map<string, { field: SeriesField; vol: Volume3D }>();
  /** Frames published under their own id (a single volume, a series that does not play, a frame before its series
   *  was known): taken out when their series takes over. */
  private published = new Set<string>();
  /**
   * ONE FIELD FOR A SERIES THAT PLAYS (Ron, 2026-10-16: "Steve architecture is superior"; CINE-RETHINK.md, step 1). The
   * series' entry in the 3D view stands for its frames and shows the one rendered now; a step re-points it, and when the
   * shader is the same (the frames' fields are of one kind) the view only rebinds -- no field swapped, the view not
   * re-composed. A shader change (a frame not yet colored beside colored ones) re-publishes, as a step did before.
   */
  private pushSeries(seq: string, from?: string): void {
    const key = `series:${seq}`;
    let shown: VrSlot | undefined;
    for (const s of this.slots.values()) if (s.image.sequence === seq && s.visible) { shown = s; break; }
    const f = shown ? shown.colorField ?? shown.field : undefined;
    const leftovers = [...this.published].filter((id) => this.slots.get(id)?.image.sequence === seq);
    const drop = () => { for (const id of leftovers) { this.published.delete(id); this.view?.setVolume3D(id, null); } };
    const cur = this.series.get(seq);
    if (!f) {
      if (cur) { this.series.delete(seq); this.view?.setVolume3D(key, null); }
      drop();
      return;
    }
    const colorizedSeg = shown!.colorField ? shown!.colorizeSegId : undefined;
    // The whole family the shown frame is colored by, one member per frame (frameMate): what the volume draws over the
    // series, the same set at every step.
    // And every segmentation merged into a frame's field (step 2): the volume draws them, their own 3D stands down.
    const fromMerges = [...this.slots.values()].filter((s) => s.image.sequence === seq && s.colorLabelsKey)
      .flatMap((s) => (this.mergeInfos.get(s.colorLabelsKey!) ?? []).map((i) => i.segId));
    const colorizedSegs = colorizedSeg && this.lastScene
      ? [...new Set([...[...this.slots.values()].filter((s) => s.image.sequence === seq).map((s) => frameMate(this.lastScene!, colorizedSeg, s.image.id as string) ?? colorizedSeg), ...fromMerges])].sort()
      : undefined;
    if (!cur) {
      const field = new SeriesField(f);
      const vol: Volume3D = { field, colorizedSeg, colorizedSegs };
      this.series.set(seq, { field, vol });
      // From the frame published under its own id to the series in ONE rebuild, so the view never holds both.
      if (leftovers.length === 1 && this.view?.swapVolume3D) { this.published.delete(leftovers[0]); this.view.swapVolume3D(leftovers[0], key, vol); }
      else { this.view?.setVolume3D(key, vol); drop(); }
      return;
    }
    drop();
    cur.vol.colorizedSeg = colorizedSeg; cur.vol.colorizedSegs = colorizedSegs;
    // THE SAME FIELD AGAIN: either a push for another frame (a hidden one decolorized, a display node of a frame not
    // shown) -- nothing for the view -- or the shown frame's field changed IN PLACE (the solid look switched: its
    // textures replaced, its shader too), which is re-published in full, as before series (critic 2026-10-16, cine step
    // 1, finding 1: returning here left the view drawing destroyed textures).
    if (f === cur.field.shown) {
      if (from === shown!.image.id) { cur.field.recheck(); this.view?.setVolume3D(key, cur.vol); }
      return;
    }
    const changed = cur.field.show(f);
    if (changed || !this.view?.rebind3d) this.view?.setVolume3D(key, cur.vol);
    else this.view.rebind3d();
  }

  private push(imageId: string, slot: VrSlot): void {
    const seq = slot.image.sequence as string | undefined;
    if (seq && this.lastScene && this.framesPlay(seq, this.lastScene)) { slot.swapFrom = undefined; this.pushSeries(seq, imageId); return; }
    // A series that no longer plays (critic 2026-10-16, cine step 1, finding 5): its series field leaves the view.
    if (seq && this.series.has(seq)) { this.series.delete(seq); this.view?.setVolume3D(`series:${seq}`, null); }
    const f = slot.colorField ?? slot.field;
    const vol = slot.visible && f ? { field: f, colorizedSeg: slot.colorField ? slot.colorizeSegId : undefined } : null;
    if (vol) this.published.add(imageId); else this.published.delete(imageId);
    // A frame replacing another (a sequence step) is published as ONE swap by whichever path
    // publishes first -- buildColorize's own push, or the handler's tail -- so the view never
    // holds both frames (two colorize fields: a shader compile) nor neither (every surface gone).
    const from = slot.swapFrom;
    if (from && from !== imageId) {
      slot.swapFrom = undefined;
      this.published.delete(from);
      if (this.view?.swapVolume3D) { this.view.swapVolume3D(from, imageId, vol); return; }
      this.view?.setVolume3D(imageId, vol);
      const old = this.slots.get(from); if (old) this.view?.setVolume3D(from, null);
      return;
    }
    this.view?.setVolume3D(imageId, vol);
  }

  onNodeRemoved(id: string, scene: LiveScene) {
    // A DELETED SEGMENTATION. Nothing here used to react to one, so the colorize field outlived the
    // node it was built from and the volume kept rendering its colors -- Ron's demo. Every slot is
    // checked, because a segmentation belongs to a volume and the id alone does not say which.
    let droppedSeg = false;
    for (const [imageId, slot] of this.slots) {
      if (!slot.segs.delete(id)) continue;
      droppedSeg = true;
      if (slot.colorizeSegId === id || slot.colorField) {
        this.decolorize(slot);
        // Another segmentation may still be on this volume and want colorizing; the next upsert
        // rebuilds it. Publishing the plain grayscale now is the honest intermediate state.
        this.push(imageId, slot);
      }
    }
    if (droppedSeg) return;

    const owned = this.vrOwner.get(id);
    if (owned !== undefined) {
      this.vrOwner.delete(id);
      const slot = this.slots.get(owned);
      if (slot) { slot.visible = false; slot.vrId = undefined; this.push(owned, slot); }
      return;
    }
    const slot = this.slots.get(id);
    if (!slot) return;
    this.decolorize(slot);   // a colorize field is GPU memory; a deleted volume's must go with it
    this.slots.delete(id);
    this.published.delete(id);
    scene.view?.setVolume3D(id, null);
    if (slot.image.sequence && this.series.has(slot.image.sequence as string)) this.pushSeries(slot.image.sequence as string);
    releaseFieldLater(slot.field);                     // after the views have let go (see releaseFieldLater)
    if (id === this.primaryId) {
      this.primaryId = this.slots.keys().next().value;
      const next = this.primaryId ? this.slots.get(this.primaryId) : undefined;
      // BUILD it if it has never been built. A volume that was only ever loaded (never turned on in
      // 3D) has no field yet, so handing the slice views `next.field` hands them undefined -- the
      // legacy fallback goes null at exactly the moment it is most likely to be the only thing
      // left showing anything.
      if (next?.field) scene.view?.setVolumeField(next.field, this.wl(next));
      else {
        // The views let go of the removed field NOW: its texture is released within two seconds
        // (releaseFieldLater), and the next volume's field may take longer to build (critic, 2026-09-24,
        // review-bugfixes finding 9). ensureField hands it to them when it is there.
        scene.view?.setVolumeField(null);
        if (next) void this.ensureField(next, scene);
      }
    }
  }
  onSceneClosed(scene: LiveScene) { this.reset(scene); }
  private reset(scene: LiveScene) {
    for (const id of this.slots.keys()) scene.view?.setVolume3D(id, null);
    for (const seq of this.series.keys()) scene.view?.setVolume3D(`series:${seq}`, null);
    this.series.clear(); this.published.clear();
    for (const slot of this.slots.values()) { this.decolorize(slot); releaseFieldLater(slot.field); }
    this.slots.clear();
    this.vrOwner.clear();
    this.primaryId = undefined;
    scene.view?.setVolumeField(null);
  }

  /** world(transform chain) · base ijkToRAS for one volume. */
  private effIjk(slot: VrSlot, scene: LiveScene): number[] {
    return rowMul(worldForNode(slot.image, scene.nodes), slot.image.ijkToRAS as number[]);
  }
  /** Re-place a 3D field if its effective geometry changed (base moved or a transform edited). */
  private replaceGeometry(slot: VrSlot, scene: LiveScene, prevSig: string) {
    const eff = this.effIjk(slot, scene); const sig = JSON.stringify(eff);
    if (sig === prevSig) return;
    slot.effSig = sig;
    if (slot.field) {
      slot.field.setIjkToRAS(eff);
      if (slot.image.id === this.primaryId) this.view?.setVolumeField(slot.field, this.wl(slot));
      this.view?.redraw();
    }
  }

  private wl(slot: VrSlot): { win: number; lev: number } {
    const range = slot.zv?.range ?? [0, 1];
    const win = (slot.scalarDisp?.window as number) ?? (range[1] - range[0]);
    const lev = (slot.scalarDisp?.level as number) ?? (range[0] + range[1]) / 2;
    return { win, lev };
  }
  /** The preset's lighting, carried on this volume's transferFunction node; Slicer's default if unset. */
  private shadeOf(slot: VrSlot): Shade {
    const s = slot.tf?.shade as number[] | undefined;
    return s && s.length === 4 ? [s[0], s[1], s[2], s[3]] : [...SLICER_VR_SHADE] as Shade;
  }

  // Lighting is part of a preset, not a global constant: CT-Soft-Tissue is matte (specular 0) while
  // CT-AAA is glossy (0.2 at power 10), and hard-coding one made every preset look the same -- and
  // shinier than Slicer. reLUT runs whenever the transferFunction changes, so the shading tracks it.
  /**
   * Write every segment's color and opacity into one volume's palette, then flush.
   *
   * `segmentOpacity` on the transfer-function node scales all of them together. It is a first step
   * towards per-group control rather than a substitute for it: the colorize page gets its
   * readability from bones at 100% against muscle at 5%, and one multiplier cannot express that.
   * What it can do is let the whole segmentation be faded against the unlabeled body without
   * touching sixty-seven segments one at a time.
   *
   * A segment hidden with `visible: false` stays at zero whatever the scale is — hidden is not a
   * degree of transparency.
   */
  private writePalette(slot: VrSlot): void {
    // The shading version (Settings › 3D view, or a restored scene): every colored volume's finish rows again.
    this.finishWatch ??= onShadingVersion(() => { for (const sl of this.slots.values()) this.writePalette(sl); this.view?.redraw(); });
    const colorized = slot.colorizeSegId ? slot.segs.get(slot.colorizeSegId) : undefined;
    if (!slot.colorField || !colorized) return;
    const scale = typeof slot.tf?.segmentOpacity === "number" ? slot.tf.segmentOpacity as number : 1;
    // MERGED (several families in one field): each member's structures at their new numbers.
    const merged0 = slot.colorLabelsKey ? this.mergeInfos.get(slot.colorLabelsKey) : undefined;
    if (merged0) {
      for (const { segId, remap } of merged0) {
        const own = slot.segs.get(segId) ?? this.lastScene?.nodes.get(segId);
        if (!own) continue;
        // THE FAMILY'S LOOK, from the member shown now -- the same for every frame. A frame's own member is marked hidden
        // whenever another frame is shown, and taking that hid its structures, changed what is solid and re-smoothed
        // the whole volume at every step (pane, 2026-10-16: the smoothing ran ~8 times a second while playing).
        const m = this.lastScene ? this.familyLook(slot, this.lastScene, own) : own;
        const mc = mergedColours(mergedOf(m));
        // Matched by structure NAME to this frame's own member, as a step carries them (critic, finding 9): a phase whose
        // segmentation numbers its structures differently still gets each structure's own color.
        const ownLabel = new Map(((own.segments as { labelValue: number; name?: string }[] | undefined) ?? []).map((sg) => [String(sg.name), sg.labelValue]));
        for (const sg of (m.segments as { labelValue: number; color?: number[]; visible?: boolean; opacity?: number; name?: string }[] | undefined) ?? []) {
          const lv = ownLabel.get(String(sg.name)) ?? sg.labelValue;
          const n = lv > 0 && lv < 256 ? remap[lv] : 0;
          if (!n) continue;
          const c = mc.get(sg.labelValue) ?? sg.color;
          if (c) slot.colorField.setSegmentColor(n, [c[0], c[1], c[2]]);
          slot.colorField.setSegmentMaterial(n, finishOfSegment(sg.name));
          slot.colorField.setSegmentOpacity(n, sg.visible === false ? 0 : (sg.opacity ?? 1) * scale);
        }
      }
      slot.colorField.flushPalette();
      return;
    }

    // NO GROUP OPACITIES (Ron, 2026-09-23: "abandon the group settings. I prefer working in the
    // segmentations module."). Each structure's own opacity, as the surfaces and the solid look take it;
    // a transfer function saved with `segmentGroups` keeps them in the file and nothing reads them.

    const segs = (colorized.segments as { labelValue: number; color?: number[]; visible?: boolean; opacity?: number; name?: string }[] | undefined) ?? [];
    // Its 3D button off (in Scene or Segmentations): none of its structures in 3D (Ron, 2026-10-16, the chambers).
    const off3D = !!this.lastScene && !this.familyShownMember(slot, this.lastScene, colorized);
    // A COLLAPSED BRANCH IS ONE COLOR HERE TOO. This path colors the volume that draws CT and
    // segments together, which is what the 3D view usually shows, and it reads each segment's own
    // color -- so without this the slices honored a collapse and 3D ignored it.
    const merged = mergedColours(mergedOf(colorized));
    for (const seg of segs) {
      const c = merged.get(seg.labelValue) ?? seg.color;
      if (c) slot.colorField.setSegmentColor(seg.labelValue, [c[0], c[1], c[2]]);
      slot.colorField.setSegmentMaterial(seg.labelValue, finishOfSegment(seg.name));
      const a = off3D || seg.visible === false ? 0 : (seg.opacity ?? 1) * scale;
      slot.colorField.setSegmentOpacity(seg.labelValue, a);
    }
    slot.colorField.flushPalette();
  }

  /** The solid look for a colored volume: a sequence's, under the Scene module's "Colored" (setLook3D
   *  writes the flag on its transfer function). */
  private solidOf(slot: VrSlot): boolean { return slot.tf?.colorizeSolid === true; }

  private applyColorizeParams(slot: VrSlot): void {
    if (!slot.colorField) return;
    // The palette carries the global scale, so it has to be rewritten when that changes -- the other
    // parameters below are uniforms and do not.
    this.writePalette(slot);
    const ctx = slot.tf?.contextOpacity as number | undefined;
    const mod = slot.tf?.ctModulation as number | undefined;
    // No opinion on the transfer function means the unlabeled body is OFF, as every presentation
    // preset starts (logic/presentation.ts contextOn: false). This fell back to 0.12 -- the value a
    // preset returns to when the body is switched ON -- so a segmentation loaded from the database
    // without a preset drew the chest as a gray haze around the heart. Ron: "The unlabeled voxels
    // should be fully transparent."
    slot.colorField.setContextOpacity(typeof ctx === "number" ? ctx : 0);
    slot.colorField.setCtModulation(typeof mod === "number" ? mod : 0.55);
    // The solid look (colorize-field.ts, setSolid): an experiment of 2026-09-23, off unless the
    // transfer function asks for it.
    // Turning it on makes the smoothed copy -- a new texture, so the view must rebind.
    if (slot.colorField.setSolid(this.solidOf(slot)) && slot.image) this.push(slot.image.id as string, slot);
    slot.colorField.setCtLUT(this.buildLUT(this.climOf(slot), slot));
    slot.colorField.setShade(this.shadeOf(slot));
  }

  /**
   * Build (or rebuild) the colorize rendering for the 3D view.
   *
   * The two constants are the colorize page's own, and they are what make this readable rather than
   * a solid block: context 0.12 leaves the unlabeled body as a faint hint of anatomy, and CT
   * modulation 0.55 lets the underlying HU vary each segment's brightness so organs look like tissue
   * instead of flat paint. At context 1.0 the skin alone hides everything behind it.
   */
  /**
   * Opacity is per CENTIMETER of tissue, not per voxel.
   *
   * This is the appearance bug Ron kept describing as "too dark and too shiny". Every field here
   * defaults `opacityUnitDistance` to `min(spacing)`, and slicer-app never set it — so on his
   * 0.92 x 0.92 x 0.5 mm series the unit distance was 0.5 mm and opacity accumulated **twenty times
   * faster** than in the colorize page he asked us to match, which sets 10 mm deliberately.
   *
   * The consequence is not subtle. A ray crossing 15 cm of tissue takes hundreds of samples, so at
   * voxel-scale accumulation almost any transfer function saturates within the first few
   * millimeters: the volume renders as a dense shell that is dark, hard-edged, and looks specular
   * whatever the shading says. It also explains two complaints that looked separate — the sliders
   * behaving like step functions, because the entire useful range was compressed into their bottom
   * few percent, and CT modulation having no visible effect, because modulating the brightness of an
   * already-saturated surface does nothing.
   *
   * 10 mm is the colorize page's own value (`examples/colorize/colorize-scene.ts`), chosen so that a
   * slider reads as opacity per centimeter. It is deliberately NOT VTK's 1 mm default: the number has
   * to mean what someone dragging the slider expects.
   */
  private static readonly OPACITY_UNIT_MM = 10;
  /**
   * BUT A PRESET IS AUTHORED FOR VTK's UNIT, which is 1 mm (vtkVolumeProperty's
   * ScalarOpacityUnitDistance default; Slicer's presets do not change it). At 10 mm every preset
   * came out ten times too thin: CT-Bone's 0.72 per mm makes a 5 mm rib 99.8% opaque in Slicer and
   * 47% here; CT-Bones' 0.2 makes it 67% there and 10% here. Ron, side by side: "The presets look
   * very different in slicer." The grayscale volume rendering -- the path a preset is chosen for --
   * uses VTK's unit, so a preset looks as it does in Slicer. The colorize field keeps 10 mm: its
   * sliders were tuned to read as opacity per centimeter and that is what they say.
   */
  private static readonly PRESET_UNIT_MM = 1;
  /**
   * BOTH UNITS ARE IN mm, AND mm IS RIGHT AT ONE SCALE ONLY (Ron, 2026-10-20: "did you forget about scales? from
   * astrophysics to electron microscope"; MODULE-DESIGN-RULES "Any scale"). The scene is in the data's own units, so on
   * 1 nm voxels a 1 mm unit is a million voxels long -- the volume fully transparent -- and on 1 parsec voxels it is
   * 3e-20 of a voxel -- an opaque shell. Each unit is kept EXACTLY as tuned while it lies within its range of voxels of the
   * volume's own grid, and held to that range outside it (`tuned`): the preset's 1 mm between 1/4 and 4 voxels, the
   * colorize field's 10 mm between 2.5 and 40, so every clinical grid from 0.25 to 4 mm voxels renders as it did.
   */
  static presetUnit(voxel: number | undefined): number { return tuned(VolumeRenderingDisplayableManager.PRESET_UNIT_MM, voxel, 0.25, 4); }
  static colorizeUnit(voxel: number | undefined): number { return tuned(VolumeRenderingDisplayableManager.OPACITY_UNIT_MM, voxel, 2.5, 40); }

  /**
   * The HU window the CT is normalized against, for the LUT and for brightness modulation.
   *
   * Fixed, not taken from the data's observed range, and that is the point: Hounsfield units are
   * absolute, so a CT transfer function's stops mean the same thing in every study. Normalizing
   * against `min..max` of whatever happened to be scanned makes the same tissue land at a different
   * position in the LUT from one series to the next — and since modulation scales segment brightness
   * by that position, it makes the same organ a different brightness in every dataset.
   *
   * Measured on a CT series whose observed range is [-1024, 2577]: normalizing against the data
   * rather than this window darkened labeled voxels by 8-12%. Not the whole of the difference he
   * reported, but real, and wrong for a reason that does not depend on the number being right.
   *
   * The value is the colorize page's own (`examples/colorize/colorize-scene.ts`), which is the look
   * being matched. It is the same principle as pinning the transfer-function editor's axis: the axis
   * must not move with the data.
   */
  private static readonly CT_WINDOW: [number, number] = [-1000, 1600];

  /**
   * The intensity window ONE volume is normalized against.
   *
   * CT_WINDOW for CT, for every reason set out above. The volume's own range for anything else --
   * because the absolute-units argument that makes a fixed window right for CT is precisely what MR
   * (and PET, and ultrasound) do not have. An MR head normalized against [-1000, 1600] occupies a
   * quarter of the LUT, and under a CT preset's Hounsfield stops it renders as a solid block of
   * "soft tissue". That was invisible while only one volume could be in the 3D view at a time and
   * obvious the moment two could: a CT chest with a black box beside it.
   *
   * Whether it IS a CT is asked of the DATA, not of a modality tag that may not be there: HU air is
   * about -1000, and nothing else loaded here is meaningfully negative.
   */
  /**
   * For the Volume Rendering module's preset picker, which renders THIS volume with each preset into
   * a thumbnail: the scalar range the LUT is sampled over, and the LUT the volume is drawing with
   * right now so the field can be put back exactly after the thumbnails are made.
   */
  /** The field that draws this volume in 3D now (its colored one, or its plain one), whether the view holds it under
   *  the volume's own id or under its series' (render/series-field.ts). For the preset thumbnails and the lighting. */
  fieldFor(imageId: string): Field | undefined { const s = this.slots.get(imageId); return s ? s.colorField ?? s.field : undefined; }
  climFor(imageId: string): [number, number] | null {
    const s = this.slots.get(imageId);
    return s ? this.climOf(s) : null;
  }
  currentLUT(imageId: string): Uint8Array | null {
    const s = this.slots.get(imageId);
    return s ? this.buildLUT(this.climOf(s), s) : null;
  }

  private climOf(slot: VrSlot): [number, number] {
    const r = slot.zv?.range;
    if (!r || r[0] <= -500) return VolumeRenderingDisplayableManager.CT_WINDOW;
    return [r[0], r[1]];
  }

  /**
   * Build the colorize volume for ONE named segmentation.
   *
   * Takes the segmentation explicitly rather than reading "the current one", and every early exit
   * clears `colorizeSegId` and republishes. That matters more than it looks: an early return used to
   * leave the slot claiming to colorize a segmentation it had not built, so the 3D view suppressed
   * that segmentation's own field as a duplicate of a volume that was drawing something else.
   */
  /**
   * A COLORIZE BUILD THAT FAILS SAYS SO (critic, 2026-09-23, round 2, finding 5). Every caller starts
   * it with `void`, and the page has no handler for a rejected promise, so a failed read of a piece
   * left the previous segmentation's colors on screen while the scene had chosen the new one, and
   * nothing reached the status line or the session log. Now the old colors are taken down and one
   * line says why.
   */
  private async buildColorize(slot: VrSlot, scene: LiveScene, seg: MrsonNode): Promise<void> {
    // A SINGLE VOLUME IS COLORIZED ONLY WHEN ASKED (the Volume Rendering module's Colorize, which is the
    // old see-through look): its segmentations are otherwise drawn by the Scene module's look -- solid by
    // the segmentation manager's merged field, or as surfaces. A sequence colorizes unless told not to.
    const vrNode = slot.vrId ? scene.nodes.get(slot.vrId) : undefined;
    if (!slot.image.sequence && vrNode?.colorize !== true) {
      if (slot.colorField || slot.colorizeSegId !== undefined) { this.decolorize(slot); this.push(slot.image.id as string, slot); }
      return;
    }
    // The picture ON SCREEN being built is said on the 3D view (render/working.ts; Ron, 2026-10-17): the heart's first
    // phase took 4 s after the load with nothing said. Hidden frames are counted by colorFrames' own banner. A build that
    // finds nothing to do returns within the banner's first 0.3 s and shows nothing.
    // ONE BANNER PER PICTURE however many calls queue for it (each segmentation change starts one; they wait in turn):
    // opened by the first, closed when the last is out (pane, 2026-10-17: 60 banners on the heart's load).
    slot.buildCalls = (slot.buildCalls ?? 0) + 1;
    if (slot.visible && !slot.buildWork) slot.buildWork = startWork({ title: "Preparing the 3D picture" });
    try {
      await this.buildColorizeInner(slot, scene, seg);
    } catch (e) {
      // A build for a volume no longer in the scene (closed while it read) is not a failure to tell anyone about.
      if (this.slots.get(slot.image.id) !== slot) return;
      const why = `the colored 3D view of ${String(seg.name ?? seg.id)} could not be built: ${(e as Error)?.message ?? e}`;
      console.warn(why);
      // The app's status line, which also writes the session log (app-shell.ts setStatus); the log
      // alone where there is no shell (a test page, the headless server's other pages).
      const shell = (globalThis as unknown as { __shell?: { setStatus(m: string): void } }).__shell;
      if (shell) shell.setStatus(why);
      else try { void fetch("/_log", { method: "POST", body: why, keepalive: true }).catch(() => {}); } catch { /* no server */ }
      if (this.slots.get(slot.image.id) === slot && (slot.colorField || slot.colorizeSegId !== undefined)) {
        this.decolorize(slot);
        this.push(slot.image.id, slot);
        this.view?.redraw();
      }
    } finally {
      slot.buildCalls = (slot.buildCalls ?? 1) - 1;
      if (slot.buildCalls <= 0) { slot.buildWork?.done(); slot.buildWork = undefined; }
    }
  }

  private async buildColorizeInner(slot: VrSlot, scene: LiveScene, seg: MrsonNode): Promise<void> {
    const note = (m: string) => {
      gpuLogLine(m);
    };
    const giveUp = () => {
      if (slot.colorizeSegId !== undefined || slot.colorField) {
        this.decolorize(slot);
        this.push(slot.image.id, slot);
      }
    };
    note(`colorize requested for ${seg.id} on ${slot.image.id}`);
    if (!slot.zv) return;                                      // CT not loaded yet; retried on build
    // A sequence's frame kept no CPU samples (slim) and its CT is already on the GPU
    // as r16float: the colorize field ADOPTS that texture rather than uploading the CT again.
    // ANY VOLUME'S CT, not only a series frame's (critic 2026-10-16, general audit, finding 2: Colorized volume on a plain
    // CT read the scan back and uploaded it again, +798 MB of C3N-01524's +1,196). The volume's own field lives as long as
    // this colored field can: both go together (onNodeRemoved, reset), the colored one first.
    const adoptCT = slot.field?.textureFormat() === "r16float" ? slot.field.volumeTexture() : undefined;
    if (!adoptCT && !slot.zv.data.length && slot.image.zarr) slot.zv = await fetchZarrVolume(this.blobBaseHref, slot.image.zarr as ZarrDesc, this.onBytes);
    const segZarr = seg.zarr as ZarrDesc | undefined;
    if (!segZarr) { giveUp(); return; }
    const dimsOk = (seg.dims as number[] | undefined)?.every((d, i) => d === slot.zv!.dims[i]);
    if (!dimsOk) { giveUp(); return; }                         // a mismatched grid cannot be composed

    // NOTHING TO REBUILD IF THE LABELMAP IS THE SAME ONE.
    //
    // This runs on every upsert of a segmentation node, and most of them change a color or a
    // visibility flag -- including every eye toggle in the Segmentations module. Rebuilding for
    // those re-fetched the labelmap and allocated another 1.25 GB of GPU textures (836 MB ctTex +
    // 418 MB labTex at this volume's size) for a palette change that writePalette does in
    // microseconds. The colors are applied below on the existing field instead.
    // SEVERAL FAMILIES IN ONE FIELD, for a series that plays under the solid look (CINE-RETHINK.md step 2, Ron 2026-10-16:
    // "ok that makes a lot of sense. Do both"): the chambers and the coronary arteries of a phase merged into one label
    // image, drawn by this one colored field -- the solid group no longer re-merges and re-smooths them at every step.
    // AFTER THE STEP'S WRITES: a step hides the leaving phase's members and shows the arriving ones one write after another,
    // and a build begun in between saw a family hidden and left it out (pane, 2026-10-16: two phases fell back to one
    // family during play, the solid group came back, ~300 textures churned). The writes are one task; this waits it out.
    if (slot.image.sequence) await new Promise((r) => setTimeout(r, 0));
    if (this.slots.get(slot.image.id as string) !== slot) return;
    const members = this.mergeMembers(slot, seg, scene);
    // A merge is made anew when its members' data, their ▲▼ order or the structures hidden change -- not for a color.
    const sig = members.length > 1
      ? `merged|${members.map((m) => `${m.id}|${JSON.stringify(m.zarr)}|${this.familyLook(slot, scene, m).zOrder ?? ""}|${[...this.mergeHidden(slot, scene, m)].sort().join(",")}`).join(";")}`
      : `${seg.id}|${JSON.stringify(segZarr)}`;
    if (slot.colorField && slot.colorizeSig === sig) {
      // The family asked for ("Colorize with") is in the merge already: the slot names it (critic, finding 8).
      if (members.length > 1 && slot.colorizeSegId !== seg.id) slot.colorizeSegId = seg.id as string;
      this.writePalette(slot);
      this.applyColorizeParams(slot);
      this.view?.redraw();
      return;
    }

    // Native dtype: labels are u8 and ColorizeField takes ArrayLike<number>, so widening them to
    // Float32 would cost 4x the memory and a 149M-element conversion for nothing.
    //
    // ONE LABEL TEXTURE PER SEGMENTATION for a sequence: the frames share it (labelTextures),
    // and the labelmap is fetched once for the first of them.
    // ONE BUILD AT A TIME PER SLOT. Two arrivals in the same tick (the segmentation upsert and
    // the frame coming on screen) each awaited a fetch and then both built; the second tore down
    // what the first had just handed the renderer.
    if (slot.colorizing) { await slot.colorizing; if (slot.colorField && slot.colorizeSig === sig) return; }
    let finish!: () => void;
    slot.colorizing = new Promise<void>((r) => { finish = r; });
    try {
    let adoptLabels: GPUTexture | undefined;
    let labelsKey: string | undefined;
    if (slot.image.sequence && members.length > 1) {
      labelsKey = sig;
      const have = this.labelTextures.get(labelsKey);
      if (have) { adoptLabels = have.tex; have.refs++; }
      else {
        // Each member's labels on the card for the moment of the merge, renumbered into one numbering (1..255) in order:
        // the one with most structures first, so a smaller, more specific one is drawn over it where they overlap (the
        // solid look's rule, solid-merge.ts).
        // Every member READ first, the build still wanted after each read; only then anything on the card, destroyed on
        // every way out (critic 2026-10-16, step 2, finding 2: a scene closed mid-merge left a 133 MB texture to the
        // garbage collector and a "could not be built" about a scene already closed).
        const read: { m: MrsonNode; data: ArrayLike<number> }[] = [];
        for (const m of members) {
          const zv = await fetchZarrVolumeNative(this.blobBaseHref, m.zarr as ZarrDesc, this.onBytes);
          if (this.slots.get(slot.image.id as string) !== slot || !slot.zv) return;
          read.push({ m, data: zv.data });
        }
        // WHICH FAMILY IS ON TOP where two overlap: the slices' rule (drawOrder; critic, finding 3) -- Scene's ▲▼ once
        // every family has it, else the one labeling fewer voxels drawn last. Later in the list is on top.
        const voxels = (r: { m: MrsonNode; data: ArrayLike<number> }) => {
          const k = `${r.m.id}|${JSON.stringify(r.m.zarr)}`;
          let n = this.mergeVoxels.get(k);
          if (n === undefined) { n = countLabelled(r.data); this.mergeVoxels.set(k, n); }
          return n;
        };
        const zo = (r: { m: MrsonNode }) => this.familyLook(slot, scene, r.m).zOrder;
        const ordered = read.every((r) => typeof zo(r) === "number");
        read.sort((a, b) => ordered ? (zo(a) as number) - (zo(b) as number) : voxels(b) - voxels(a));
        const inputs: { labels: GPUTexture; remap: Uint32Array }[] = [], info: { segId: string; remap: Uint32Array }[] = [];
        try {
          let next = 1;
          for (const { m, data } of read) {
            const hidden = this.mergeHidden(slot, scene, m);
            const remap = new Uint32Array(256);
            for (const sg of (m.segments as { labelValue: number; name?: string }[] | undefined) ?? []) {
              if (sg.labelValue > 0 && sg.labelValue < 256 && next < 256 && !hidden.has(String(sg.name))) remap[sg.labelValue] = next++;
            }
            inputs.push({ labels: ColorizeField.makeLabelTexture(this.dev, data, slot.zv.dims), remap });
            info.push({ segId: m.id as string, remap });
          }
          const again = this.labelTextures.get(labelsKey);   // made by another frame meanwhile
          if (again) { adoptLabels = again.tex; again.refs++; }
          else {
            adoptLabels = makeMergedLabelTexture(this.dev, slot.zv.dims as [number, number, number]);
            mergeLabels(this.dev, inputs, slot.zv.dims as [number, number, number], adoptLabels);
            this.labelTextures.set(labelsKey, { tex: adoptLabels, refs: 1 });
            this.mergeInfos.set(labelsKey, info);
          }
        } finally {
          for (const inp of inputs) inp.labels.destroy();   // merged: each member's own copy is not kept (the labels once)
        }
      }
    } else if (slot.image.sequence) {
      labelsKey = sig;
      const have = this.labelTextures.get(labelsKey);
      if (have) { adoptLabels = have.tex; have.refs++; }
      else {
        slot.segZv = await fetchZarrVolumeNative(this.blobBaseHref, segZarr, this.onBytes);
        const again = this.labelTextures.get(labelsKey);   // made by another frame meanwhile
        if (again) { adoptLabels = again.tex; again.refs++; }
        else {
          adoptLabels = ColorizeField.makeLabelTexture(this.dev, slot.segZv.data, slot.zv.dims);
          this.labelTextures.set(labelsKey, { tex: adoptLabels, refs: 1 });
        }
      }
    } else {
      slot.segZv = await fetchZarrVolumeNative(this.blobBaseHref, segZarr, this.onBytes);
    }
    // THE CT'S SAMPLES ARE CHECKED AGAIN HERE, after the waits above. The check at the head of this
    // function runs before them, and a build that finished during them ends by emptying
    // `slot.zv` (slim, below): the second of two quick upserts of a new AI result then built its
    // field from an empty CT, and WebGPU refused the upload -- "requiredBytesInCopy (35651584) is
    // less than byteSize(0)" -- and the views stopped drawing (Ron, 2026-09-23 13:34).
    if (!adoptCT && !slot.zv!.data.length && slot.image.zarr) slot.zv = await fetchZarrVolume(this.blobBaseHref, slot.image.zarr as ZarrDesc, this.onBytes);
    // STILL WANTED? (critic, 2026-09-23, round 2, finding 3; CONSTRAINTS rule 3.) The waits above take
    // seconds, and the volume or the segmentation can be deleted inside them. Publishing anyway put a
    // deleted segmentation's colors back on the volume, or drew a deleted volume in 3D with a field
    // nothing could free any more. After this line there is no wait until the result is published.
    if (this.slots.get(slot.image.id) !== slot || !slot.segs.has(seg.id as string)) {
      this.releaseLabels(labelsKey);                  // the reference this build took, if it took one
      slot.segZv = undefined;
      if (slot.zv) slot.zv = slim(slot.zv);
      note(`colorize of ${seg.id} dropped: ${this.slots.get(slot.image.id) !== slot ? "its volume" : "the segmentation"} was removed while it was being built`);
      return;
    }
    // THE OLD FIELD IS RELEASED BEFORE THE NEW ONE IS BUILT. A GPUTexture is not reclaimed by the
    // garbage collector, so assigning over colorField leaked 1.25 GB every time.
    if (slot.colorField) {
      slot.colorField.destroy(); this.releaseLabels(slot.colorLabelsKey);
      // And off the tally, as decolorize does: three builds in a row on one volume read as
      // "colorize fields now ~3588 MB" for one 1196 MB field (2026-09-21).
      const g = globalThis as unknown as { __gpuMB?: number };
      g.__gpuMB = Math.max(0, (g.__gpuMB ?? 0) - Math.round((slot.colorBytes ?? 0) / 1048576));
      slot.colorBytes = undefined;
    }
    slot.colorLabelsKey = labelsKey;
    slot.colorizeSegId = seg.id as string;
    slot.colorizeSig = sig;

    // A RUNNING TALLY OF GPU MEMORY, because this is where it goes and there was no way to see it.
    // Ron: "I think you will have to instrument the relevant pieces so I can paste you the
    // feedback." __gpuLog is a plain array of strings on globalThis, read by tests and a diagnosis; its last
    // GPU_LOG_KEEP lines are kept (gpuLogLine). __colorizeFields counts the fields built (the play line reads it).
    {
      const [dx, dy, dz] = slot.zv.dims;
      const mb = (bytes: number) => Math.round(bytes / 1048576);
      // What this build ALLOCATES: nothing for an adopted CT, nothing for adopted labels.
      const ctB = adoptCT ? 0 : dx * dy * dz * 2, labB = adoptLabels && this.labelTextures.get(labelsKey!)!.refs > 1 ? 0 : dx * dy * dz;
      const one = ctB + labB;
      slot.colorBytes = one;
      const g = globalThis as unknown as { __gpuMB?: number; __colorizeFields?: number };
      g.__gpuMB = (g.__gpuMB ?? 0) + mb(one);
      g.__colorizeFields = (g.__colorizeFields ?? 0) + 1;
      gpuLogLine(
        `colorize ${seg.id} ` +
        `${dx}x${dy}x${dz} = ${mb(one)} MB (ct ${adoptCT ? "shared with the volume" : mb(ctB) + " MB"} + labels ${labB ? mb(labB) + " MB" : "shared"}) ` +
        `· colorize fields now ~${g.__gpuMB} MB`,
      );
    }
    const ijkToRAS = rowMul(worldForNode(slot.image, scene.nodes), slot.image.ijkToRAS as number[]);
    slot.colorField = new ColorizeField(
      this.dev, adoptCT ? null : slot.zv.data, adoptLabels ? null : slot.segZv!.data, slot.zv.dims, this.buildLUT(this.climOf(slot), slot),
      {
        adoptCT, adoptLabels,
        clim: this.climOf(slot), ijkToRAS, shade: this.shadeOf(slot),
        // FROM THE PRESET, not a literal. These were 0.12 and 0.55 written out here, so the field was
        // built showing the unlabeled body no matter what the default preset said -- and turning the
        // default off would have left this one site still switching it on at construction.
        contextOpacity: presentationParams(DEFAULT_PRESENTATION).contextOpacity as number,
        ctModulation: presentationParams(DEFAULT_PRESENTATION).ctModulation as number,
        opacityUnitDistance: VolumeRenderingDisplayableManager.colorizeUnit(nodeVoxel({ ijkToRAS: slot.image.ijkToRAS })),
      },
    );
    // COLOR AND OPACITY, then flush. The palette starts as all zeros and setSegmentColor writes only
    // RGB, so a segment left at alpha 0 has dens = pal.a * occupancy = 0 and every one of its voxels
    // is discarded -- the volume renders as context alone: dark, colorless, and unaffected by CT
    // modulation, since that only brightens labeled voxels. And nothing reaches the GPU at all
    // without flushPalette().
    // (Groups were inferred here from the CT under each segment, for per-group opacity sliders. Gone
    // with the groups, 2026-09-23: each structure's own settings, in the Segmentations module.)
    this.writePalette(slot);
    this.applyColorizeParams(slot);
    // WHAT WAS ASKED FOR MAY NO LONGER BE WANTED. A build takes seconds (the fetch, the upload, the
    // bake); the rendering can be switched off inside that window -- pressing the 3D look button
    // twice does exactly that -- and the arriving field then published itself over a volume nobody
    // is rendering, holding 1,196 MB for the rest of the session. Measured 2026-09-22: the look
    // back on "Surfaces", the rendering `visible: false`, and the tally still at 1196.
    //
    // NOT A FRAME OF A SEQUENCE, though (2026-10-16, Ron: the beating heart "seems to flicker"): a frame's build that
    // finished after the player had moved on was thrown away, so a frame slower to build than one step of play never
    // kept its colors -- it came back empty on every loop (the 300 and 350 ms phases, checked in the pane), and the 3D
    // view showed the solid anatomy alone for that step. A frame is on screen again within a second: its field is kept
    // and published when shown -- WHILE ITS SEQUENCE IS RENDERED AND COLORIZED (critic 2026-10-16, findings 2-3: a build
    // finishing after the rendering went off kept four frames' fields, about 1 GB, with nothing drawing them).
    if (!slot.colorize || (!slot.visible && !this.frameWanted(slot, scene))) {
      this.decolorize(slot);
      this.push(slot.image.id, slot);
      this.view?.redraw();
      slot.zv = slim(slot.zv!);
      slot.segZv = undefined;
      return;
    }
    if (slot.visible) { this.push(slot.image.id, slot); this.view?.redraw(); }
    // THE OTHER FRAMES NEXT, one after another in the background, so the first loop of play does not wait for each
    // frame's build as it comes on screen.
    if (slot.visible && slot.image.sequence) this.scheduleFrameColors(slot.image.sequence as string, scene);
    // THE SAMPLES HAVE DONE THEIR WORK. Both arrays are now textures inside the colorize field, and
    // the statistics above were the last CPU reader. Keeping them meant a colorize build put 2 GB
    // back on the heap it had just been cleared of (measured, 2026-09-22); a rebuild re-reads them
    // from the local store, which is what the empty-data branch at the head of this function is for.
    slot.zv = slim(slot.zv!);
    slot.segZv = undefined;
    forgetDecoded(slot.image.zarr as ZarrDesc);
    if (seg.zarr) forgetDecoded(seg.zarr as ZarrDesc);
    } finally { slot.colorizing = undefined; finish(); }
  }

  /** The frame of this sequence that is rendered with its colors now, if any (the display node names one frame). */
  private sequenceShown(seq: string): VrSlot | undefined {
    for (const s of this.slots.values()) if (s.image.sequence === seq && s.visible && s.colorize) return s;
    return undefined;
  }
  /** A hidden frame whose colors are worth keeping: its sequence is rendered, colorized, and plays. */
  private frameWanted(slot: VrSlot, scene: LiveScene): boolean {
    const seq = slot.image.sequence as string | undefined;
    return !!seq && !!this.sequenceShown(seq) && this.framesPlay(seq, scene);
  }
  /** A sequence that PLAYS: indexed by times rising frame by frame (the heart's phases), not by names or repeated values
   *  (a diffusion scan's b-values) -- the render audit's rule for preparing frames ahead (load-panel.ts), here for colors. */
  private framesPlay(seq: string, scene: LiveScene): boolean { return sequencePlays(scene.nodes.get(seq)); }
  /** Passes over a sequence's frames: running, and asked again while running. */
  private frameColorPass = new Map<string, { again: boolean }>();
  private frameColorTimer = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * COLOR EVERY FRAME OF A SEQUENCE THAT PLAYS, not only the one on screen, so play never waits for a frame's build
   * (2026-10-16, the beating heart's flicker). Asked whenever a frame on screen is colored or a segmentation of the
   * sequence arrives, and run once things have settled (FRAME_COLOR_SETTLE_MS after the last ask): a scene's
   * segmentations arrive one by one, and a pass started at the first colored every phase with the coronary arteries of
   * phase 2 (critic 2026-10-16, finding 1). Each frame is built with ITS choice (colorizeChoice, the display node's
   * colorizeWith included) and the look on screen (the shown frame's transfer function: finding 7), and a frame whose
   * choice changed since is built again (finding 8). The pass stops, and the hidden frames' fields go, as soon as the
   * sequence is no longer rendered with its colors (finding 2).
   *
   * WHAT IT HOLDS (finding 5): per frame, under the Colored look, its labels (a texture shared with the frames one
   * labelmap covers; the heart has one SEG per phase, so one each, 133 MB) and the smoothed solid copy (133 MB) --
   * about 1.3 GB for the heart's five phases. The CT is not copied (the frame's own field is adopted).
   */
  private scheduleFrameColors(seq: string, scene: LiveScene): void {
    const running = this.frameColorPass.get(seq);
    if (running) { running.again = true; return; }
    clearTimeout(this.frameColorTimer.get(seq));
    this.frameColorTimer.set(seq, setTimeout(() => { this.frameColorTimer.delete(seq); void this.colorFrames(seq, scene); }, VolumeRenderingDisplayableManager.FRAME_COLOR_SETTLE_MS));
  }
  static readonly FRAME_COLOR_SETTLE_MS = 800;
  private async colorFrames(seq: string, scene: LiveScene): Promise<void> {
    const pass = { again: true };
    this.frameColorPass.set(seq, pass);
    // SAID ON THE 3D VIEW while it takes (render/working.ts; Ron, 2026-10-17, the pause after the heart loaded): the
    // phases still being prepared, counted. Opened only when a phase is actually built; quick passes show nothing.
    let work: Work | undefined, built = 0;
    const phases = [...this.slots.values()].filter((o) => o.image.sequence === seq).length;
    try {
      while (pass.again) {
        pass.again = false;
        for (const s of [...this.slots.values()]) {
          const shown = this.sequenceShown(seq);
          if (!shown || !this.framesPlay(seq, scene)) break;
          if (s === shown || s.image.sequence !== seq || !s.segs.size || this.slots.get(s.image.id) !== s) continue;
          // The look on screen, and the display node's choice of segmentation, are the shown frame's.
          s.tf = shown.tf; s.tfId = shown.tfId; s.colorize = shown.colorize;
          const target = this.colorizeChoice({ ...s, vrId: shown.vrId }, scene);
          if (!target || (s.colorField && !s.colorizeStale && s.colorizeSegId === target.id)) continue;
          // Its own field first (the CT texture the colorize field adopts); a frame not yet shown has none.
          if (!s.field) await this.ensureField(s, scene);
          if (this.slots.get(s.image.id) !== s || !s.field) continue;
          s.colorizeStale = false;
          work ??= startWork({ title: "Preparing the series in 3D", unit: "phases", total: Math.max(1, phases - 1) });
          await this.buildColorize(s, scene, target);
          // The scene closed meanwhile: nothing more to prepare, and nothing to count (critic 2026-10-17, finding 19).
          if (!scene.nodes.has(seq)) { pass.again = false; break; }
          if (this.slots.get(s.image.id) === s && s.colorField) work.step(++built);
        }
      }
    } finally {
      work?.done();
      this.frameColorPass.delete(seq);
      // NOT WANTED ANY MORE: the hidden frames' fields go (the rendering or the colors went off during the pass).
      if (!this.sequenceShown(seq) || !this.framesPlay(seq, scene)) for (const o of this.slots.values()) if (o.image.sequence === seq && !o.visible && o.colorField) this.decolorize(o);
    }
  }

  private reLUT(only?: VrSlot) {
    let any = false;
    for (const slot of only ? [only] : this.slots.values()) {
      if (!slot.zv) continue;
      // The grayscale field and the colorize field are alternatives, not layers, and either may be the
      // one showing. Requiring `slot.field` meant that with colorize active a group-opacity change
      // reached nothing at all -- the slider moved and the picture did not.
      if (slot.field) {
        slot.field.setLUT(this.buildLUT(this.climOf(slot), slot));
        slot.field.setShade?.(this.shadeOf(slot));
      }
      if (slot.field || slot.colorField) { this.applyColorizeParams(slot); any = true; }
    }
    if (any) this.view?.redraw();
  }

  private async ensureField(slot: VrSlot, scene: LiveScene): Promise<void> {
    if (slot.field || slot.building || !slot.image?.zarr) return;
    // A COLOR MAP (Color FA) has no volume rendering: its samples are packed colors. Said once, and the rendering is
    // switched back off, so nothing claims to be on while drawing nothing (critic, 2026-09-29, diffusion module, 3).
    if ((slot.image as { rgb24?: boolean }).rgb24) {
      for (const n of scene.nodes.values()) {
        if (n.type === "volumeRenderingDisplay" && n.visible && ((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] === slot.image.id) scene.write({ op: "patch", id: n.id, path: "#/visible", value: false });
      }
      (globalThis as unknown as { __shell?: { setStatus?: (t: string) => void } }).__shell?.setStatus?.(`"${String(slot.image.name ?? slot.image.id)}" is a color map: it is shown on the slices, and has no volume rendering.`);
      return;
    }
    // A FAILURE IS NOT FOREVER, as in the slice manager (critic 2026-09-22, finding 7): `building` stayed true
    // after a throw and the volume could never be shown in 3D again that session, with nothing said (code
    // review 2026-09-24, A7). Now: said once, and tried again on a later write, at most every ten seconds.
    if (slot.failedAt && performance.now() - slot.failedAt < 10_000) return;
    slot.building = true;
    try {
      await this.buildField(slot, scene);
      slot.failedAt = undefined;
      slot.retries = undefined;
    } catch (e) {
      slot.failedAt = performance.now();
      // TRIED AGAIN BY ITSELF, three times, ten seconds apart: the message promised a retry that a quick second
      // click did not get (critic, 2026-09-24, review-bugfixes finding 10).
      slot.retries = (slot.retries ?? 0) + 1;
      const again = slot.retries <= 3;
      const msg = `the 3D picture of "${String(slot.image.name ?? slot.image.id)}" could not be made: ${(e as Error)?.message ?? e} — ` +
        (again ? "trying again in ten seconds" : "tried three times; switch it off and on in Scene to try again");
      console.warn(msg);
      (globalThis as unknown as { __shell?: { setStatus?: (t: string) => void } }).__shell?.setStatus?.(msg);
      if (again) setTimeout(() => { if (this.slots.get(slot.image.id as string) === slot && !slot.field) void this.ensureField(slot, scene); }, 10_500);
      else slot.failedAt = undefined;                  // the next change asks again, at once
    } finally {
      slot.building = false;
    }
  }
  private async buildField(slot: VrSlot, scene: LiveScene): Promise<void> {
    if (!slot.zv) {
      // The slice manager's texture, if it is up: adopted, not fetched again (see samplesOrResident).
      const z = slot.image.zarr as ZarrDesc, key = descKey(z) ?? undefined, range = knownRange(z);
      slot.zv = hasSharedTexture(key) && range
        ? { data: new Float32Array(0), dims: [...(z.shape as number[])].reverse() as [number, number, number], range }
        : await samplesAsStored(this.blobBaseHref, z, this.onBytes);
      // STILL WANTED? The volume (or the whole scene) may have gone during the read: no field for a slot nobody holds
      // (critic 2026-10-16, finding 10; CONSTRAINTS, held-memory rule 3).
      if (this.slots.get(slot.image.id) !== slot) { slot.zv = slim(slot.zv); return; }
    }
    const ijkToRAS = rowMul(worldForNode(slot.image, scene.nodes), slot.image.ijkToRAS as number[]);   // apply the transform chain
    slot.effSig = JSON.stringify(ijkToRAS);
    // The same unit distance as the colorize field: the plain grayscale rendering had the identical
    // problem, so the two looked wrong in the same way and for the same reason.
    slot.field = new ImageField(this.dev, slot.zv.data, slot.zv.dims, [1, 1, 1], this.buildLUT(this.climOf(slot), slot), { clim: this.climOf(slot), ijkToRAS, shade: this.shadeOf(slot), opacityUnitDistance: VolumeRenderingDisplayableManager.presetUnit(nodeVoxel({ ijkToRAS: slot.image.ijkToRAS })), ...textureOpts(slot.image) });
    slot.zv = slim(slot.zv);
    forgetDecoded(slot.image.zarr as ZarrDesc);
    // A segmentation may have arrived before the CT finished streaming; colorize now that it can --
    // if the volume is rendered. The primary volume's field is ensured at load for the slices,
    // and colorizing it then built 1196 MB nobody could see (2026-09-21); the `touched` path
    // builds it when the rendering comes on.
    const first = slot.segs.values().next().value;
    if (first && slot.visible && slot.colorize) await this.buildColorize(slot, scene, first);
    // The legacy single-volume slice path reads the FIRST volume's field. The 3D view does not go
    // through it any more -- it reads the map that `push` writes, one entry per volume.
    if (slot.image.id === this.primaryId) this.view?.setVolumeField(slot.field, this.wl(slot));
  }

  // 256-entry rgba8 LUT sampled across the DATA RANGE (clim is fixed to that range).
  private buildLUT(range: [number, number], slot: VrSlot): Uint8Array {
    const cs = slot.tf?.colorStops as { value: number; rgba: number[] }[] | undefined;
    const os = slot.tf?.scalarOpacity as { value: number; opacity: number }[] | undefined;
    if (cs?.length && os?.length) {
      const colorTF = cs.map((s) => [s.value, s.rgba[0], s.rgba[1], s.rgba[2]]);
      const opac = os.map((s) => [s.value, s.opacity]);
      return lutFromTransferFunctions(colorTF, opac, range);   // sample TF across the data range
    }
    // window/level grayscale, positioned within the data range
    const win = (slot.scalarDisp?.window as number) ?? (range[1] - range[0]);
    const lev = (slot.scalarDisp?.level as number) ?? (range[0] + range[1]) / 2;
    const lo = lev - win / 2, hi = lev + win / 2;
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = range[0] + (i / 255) * (range[1] - range[0]);
      const g = Math.max(0, Math.min(1, (v - lo) / Math.max(hi - lo, 1e-6)));
      lut[i * 4] = lut[i * 4 + 1] = lut[i * 4 + 2] = Math.round(g * 255);
      lut[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (g - 0.15) / 0.85)) * 200);
    }
    return lut;
  }
}

/** Module registry (S11): `module` nodes describe what each connected ModuleServer offers (name, server,
 *  gui: "stream" | "none"). Every peer contributes its own; LiveScene ends up with the union, which is
 *  what a client menu / launcher enumerates. Slicer's AppServer role publishes its modules the same way. */
/**
 * A `terminology` node is a terminology loaded at runtime -- a Slicer `.term.json` or a color-table
 * CSV, parsed once into the shape logic/anatomy/terminology.ts uses and stored in the scene, so it is
 * in the session, saved and versioned with everything else, and every peer sees the same terms.
 * This manager keeps the in-memory registry in step with the scene; naming, the tree, the probe and
 * the SEG writer consult the registry (see lookupTerm) before the vendored tables.
 */
export class TerminologyDisplayableManager implements DisplayableManager {
  interestedTypes = ["terminology"];
  onNodeAdded(node: MrsonNode) {
    const n = node as unknown as TerminologySource & { type: string };
    if (!n.entries) return;
    const e = (node as { editable?: boolean }).editable;
    registerTerminology({ id: node.id, name: n.name ?? node.id, format: n.format ?? "csv", schemes: n.schemes ?? [], entries: n.entries, byName: n.byName ?? {}, ...(e ? { editable: true } : {}) });
  }
  onNodeRemoved(id: string) { unregisterTerminology(id); }
  onSceneClosed() { for (const t of terminologies()) unregisterTerminology(t.id); }
}

/**
 * A `sequenceBrowser` chooses which frame of a sequence the views show. Scrubbing is one op on
 * `#/selectedItemNumber` (logic/sequences.ts selectFrame also moves `proxy`); this manager turns
 * the move into the views following: every slice composite showing the previous frame shows the
 * new one, and a volume rendering on the previous frame moves to the new one -- its display node
 * re-points its `volume` ref, which the VolumeRenderingDisplayableManager already handles as an
 * owner change, so the transfer function and its preset carry across frames. Every frame is an
 * ordinary image node with its own GPU field, so once each has been shown once, a frame change is
 * a binding change and not an upload.
 */
export class SequenceDisplayableManager implements DisplayableManager {
  // Segmentations too: the member on screen of a family is watched, so its look is known when it is deleted (lastLook).
  interestedTypes = ["sequenceBrowser", "segmentation"];
  private shown = new Map<string, string>();   // browser id -> the frame it last put on screen
  /** True while a step writes the members: those writes are the step's, not the person's look. */
  private stepping = false;
  onNodeAdded(node: MrsonNode, scene: LiveScene) {
    if (node.type === "segmentation") {
      // THE FAMILY'S LOOK AS THE PERSON LEAVES IT, at every change of the member on screen -- its eye, Scenes' 2D/3D
      // buttons, a structure turned off -- not only at a step: hidden and then deleted, the family came back at the next
      // step (critic 2026-10-16, tonight's fixes, finding 2).
      if (this.stepping) return;
      for (const [key, id] of this.shown) if (id === node.id && key.includes("#")) this.lastLook.set(key, { ...node });
      return;
    }
    const seqs = (node.sequences as { sequence: string; proxy?: string }[] | undefined) ?? [];
    const seq = seqs[0] ? scene.nodes.get(seqs[0].sequence) : undefined;
    const items = (seq?.items as { index: string; node: string }[] | undefined) ?? [];
    if (!items.length) return;
    const n = Math.max(0, Math.min(items.length - 1, (node.selectedItemNumber as number | undefined) ?? 0));
    const next = items[n].node;
    const prev = this.shown.get(node.id) ?? seqs[0].proxy ?? items[0].node;
    this.shown.set(node.id, next);
    this.stepCompanions(node, scene);
    if (prev === next) return;
    const refs = (x: MrsonNode | undefined) => (x?.refs as Record<string, string[]> | undefined) ?? {};
    // ONE WINDOW/LEVEL FOR THE WHOLE SEQUENCE. Each frame is a volume with its own display node,
    // and each computed its own percentile window, so the picture brightened and dimmed from
    // phase to phase for no anatomical reason. The frame leaving hands its window/level to the
    // frame arriving, so a setting made on any frame holds across all of them.
    const dispOf = (img: string) => { const d = (refs(scene.nodes.get(img)).display ?? [])[0]; return d ? scene.nodes.get(d) : undefined; };
    const from = dispOf(prev), to = dispOf(next);
    if (from && to && typeof from.window === "number" && typeof from.level === "number" && (from.window !== to.window || from.level !== to.level)) {
      scene.write({ op: "patch", id: to.id, path: "#/window", value: from.window });
      scene.write({ op: "patch", id: to.id, path: "#/level", value: from.level });
      scene.write({ op: "patch", id: to.id, path: "#/autoWindowLevel", value: false });
    }
    for (const c of scene.nodes.values()) {
      if (c.type === "sliceComposite") {
        for (const layer of ["background", "foreground"]) {
          if ((refs(c)[layer] ?? [])[0] === prev) scene.write({ op: "patch", id: c.id, path: `#/refs/${layer}`, value: [next] });
        }
      } else if (c.type === "volumeRenderingDisplay" && (refs(c).volume ?? [])[0] === prev) {
        scene.write({ op: "patch", id: c.id, path: "#/refs/volume", value: [next] });
      }
    }
  }
  /**
   * THE COMPANIONS STEP WITH THE MASTER (logic/sequences.ts joinSequence). Each companion sequence
   * -- the segmentations made on the frames -- has one member on screen: the one for the frame
   * showing, or the latest earlier one. Members are real nodes with their own GPU state, so the
   * step is a change of visibility, not of content: the member arriving takes the display of the
   * one leaving (which of it shows, in which views, in 3D, with what opacity -- and per segment,
   * so an aorta switched off stays off through the beat), and the one leaving goes dark.
   */
  private stepCompanions(browser: MrsonNode, scene: LiveScene) {
    this.stepping = true;
    try { this.stepCompanions0(browser, scene); } finally { this.stepping = false; }
  }
  private stepCompanions0(browser: MrsonNode, scene: LiveScene) {
    const seqs = (browser.sequences as { sequence: string }[] | undefined) ?? [];
    for (let k = 1; k < seqs.length; k++) {
      const it = companionItem(scene, browser.id, k);
      const key = `${browser.id}#${k}`;
      const wanted = it?.node;
      const was = this.shown.get(key);
      const seq = scene.nodes.get(seqs[k].sequence);
      // The display of the member leaving, read BEFORE it goes dark below -- a write lands in
      // `nodes` at once, and the first version copied the darkness onto the member arriving.
      // A MEMBER LEAVING THAT NO LONGER EXISTS (deleted) hands over the family's display as it was last seen: without it
      // the member arriving kept the darkness the join gave it, and the whole family stayed hidden for good (critic
      // 2026-10-16, step 2, seen in passing).
      const from = was && was !== wanted ? (scene.nodes.get(was) ? { ...scene.nodes.get(was)! } : this.lastLook.get(key)) : undefined;
      // ONE WRITE PER MEMBER. Each write of a segmentation node rebuilds the Scene list, the
      // Volume Rendering panel and the overlay list of every segmentation; a step wrote up to eight
      // (critic, 2026-09-19, finding 3). The member leaving gets one put with both flags off, the
      // member arriving one put with everything it takes over.
      for (const m of (seq?.items as { node: string }[] | undefined) ?? []) {
        const mn = scene.nodes.get(m.node);
        if (!mn || m.node === wanted) continue;
        if (mn.visible !== false || mn.visible3D !== false) scene.write({ op: "put", id: m.node, node: { ...mn, visible: false, visible3D: false } });
      }
      if (!wanted) continue;
      const to = scene.nodes.get(wanted);
      if (to && from) {
        const next: Record<string, unknown> = { ...to };
        let changed = false;
        for (const f of ["visible", "visible3D", "hiddenViews", "fill2D", "outline2D", "opacity", "zOrder"]) {
          if (JSON.stringify(from[f]) === JSON.stringify(to[f])) continue;
          // UNSET IS A VALUE TOO: the member leaving with `visible3D` unset (it follows `visible`) handed over
          // nothing, and the member arriving kept the `false` the join gave it -- so after the first step the
          // family was in 3D nowhere (2026-09-24, the heart with its coronaries).
          if (from[f] === undefined) delete next[f]; else next[f] = from[f];
          changed = true;
        }
        type Seg = { labelValue: number; name?: string; visible?: boolean; opacity?: number; color?: number[] };
        const fs = (from.segments as Seg[] | undefined) ?? [], ts = (to.segments as Seg[] | undefined) ?? [];
        if (fs.length && ts.length) {
          const byName = new Map(fs.map((sg) => [sg.name ?? String(sg.labelValue), sg]));
          const merged = ts.map((sg) => { const src = byName.get(sg.name ?? String(sg.labelValue)); return src ? { ...sg, ...(src.visible !== undefined ? { visible: src.visible } : {}), ...(src.opacity !== undefined ? { opacity: src.opacity } : {}), ...(src.color ? { color: src.color } : {}) } : sg; });
          if (JSON.stringify(merged) !== JSON.stringify(ts)) { next.segments = merged; changed = true; }
        }
        if (changed) scene.write({ op: "put", id: wanted, node: next as MrsonNode });
      } else if (to && !from && to.visible === false && was === undefined) {
        // First time this companion is stepped and its member was hidden by the join: show it.
        scene.write({ op: "patch", id: wanted, path: "#/visible", value: true });
      }
      this.shown.set(key, wanted);
      const now = scene.nodes.get(wanted);
      if (now) this.lastLook.set(key, { ...now });
    }
  }
  /** Each companion's display as last stepped to, for a member leaving that was deleted meanwhile. */
  private lastLook = new Map<string, MrsonNode>();
  onNodeRemoved(id: string) { this.shown.delete(id); }
  onSceneClosed() { this.shown.clear(); this.lastLook.clear(); }
}

export class ModuleRegistryDisplayableManager implements DisplayableManager {
  interestedTypes = ["module"];
  modules = new Map<string, MrsonNode>();
  onNodeAdded(node: MrsonNode) { this.modules.set(node.id, node); }
  onNodeRemoved(id: string) { this.modules.delete(id); }
  onSceneClosed() { this.modules.clear(); }
  /** Modules offered by one server (from `node.server`, or `source.server`). */
  byServer(server: string): MrsonNode[] {
    return [...this.modules.values()].filter((m) => (m.server ?? (m.source as { server?: string } | undefined)?.server) === server);
  }
}
