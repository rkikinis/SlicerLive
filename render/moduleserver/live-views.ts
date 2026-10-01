// mountLiveViews — SlicerLive slice/3D cells driven by LiveScene displayable managers over the mrson
// channel, used as the *view area* of a streamed legacy app. The app is the layout engine: cells are
// created and placed from the AppServer's view-cell rects (any number of slice cells, keyed by the
// app's layout names — Red/Green/Yellow, Compare's Slice4.., Red+ ...), one 3D cell for view "1"
// (multi-3D waits for per-view scene renderers). Each slice cell carries a 2D overlay canvas that
// projects OverlayItems (markups, later crosshair / intersections / annotations) onto its plane.
// Local interaction (slice scroll/pan/zoom, 3D orbit) is written back to LiveScene as ops so the
// legacy app follows — the views are SlicerLive's, the state is shared.
// Trimmed from render/demos/mirror-browser.ts (no replay/timeline). TODO(DRY): mirror-browser should mount this too.
import { onShadingVersion, SHADINGS, setShadingVersion, shadingVersion } from "../shading-versions.ts";
import { escapeHtml } from "../demos/html.ts";
import { DRAW_ERROR_VOXELS } from "../../logic/decimate.ts";
import type { Gpu } from "../device.ts";
import { SceneRenderer, type SliceQuad } from "../scene-renderer.ts";
import { LabelRay } from "../label-ray.ts";
import { type Orientation, SliceRenderer } from "../slice-renderer.ts";
import { fitFovToVolume } from "../../logic/slice-logic.ts";
import { applyMat4, type Mat4 } from "../mat4.ts";
import { broadcastSlice, type LinkSliceState, type SliceLinkFlag } from "../../logic/link.ts";
import { reformatSliceToRAS } from "../../logic/slice-logic.ts";
import { placeClick, removeControlPointOp } from "../../logic/markups/placer.ts";
import { measurementsFor, polygonArea, polylineLength, type MarkupType } from "../../logic/markups/measurements.ts";
import { interpolateCurve } from "../../logic/markups/curve.ts";
import { VtkCamera, fitDistance, fitParallelScale, labelFacesAway } from "../vtk-camera.ts";
import { DEFAULT_LIGHT, LIGHT_PRESETS } from "../light-presets.ts";
import { lutFromTransferFunctions } from "../scene-volume.ts";
import { CT_VR_PRESETS } from "../ct-vr-presets.ts";
import type { VrPresetItem } from "../demos/vr-preset-menu.ts";
import { attachWidgetControls } from "../demos/widget-control.ts";
import type { Box, HandleMeta } from "../demos/roi-widget.ts";
import { RoiBoxField } from "../roi-box-field.ts";
import { orderScene } from "../demos/scene-order.ts";
import { applyVrPreset, setLook3D, setVolumeRenderingOn, volumeRenderingOn } from "../demos/tf-editor.ts";
import { applyLook, colorizeCostMB, currentLook, forgetLooks, LOOKS } from "../demos/looks.ts";
import { currentFrames } from "../../logic/sequences.ts";
import { CARDIAC_VIEWS, type CardiacAxes, type CardiacView, cardiacAxes, cardiacPlane, findCardiacLabels, planeToSliceToRAS } from "../../logic/cardiac-axes.ts";
import { lineAxes, lineFieldOfView, lineOrientation, linePlane, lineRange, type LineView, LINE_VIEWS, parseLineOrientation } from "../../logic/line-axes.ts";
import { decodedCacheReport, fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { segCacheBytes } from "../../logic/readers/seg-cache.ts";
import { rowMul, worldForNode } from "../../logic/transforms.ts";
import { type Field, halfToFloat, type ImageField } from "../fields.ts";
import { mountAdaptive3d } from "../demos/accum-loop.ts";
import { cssToken, withAlpha } from "../css-token.ts";
import { LiveSync } from "../livesync.ts";
import { WsTransport } from "../transport.ts";
import { CameraInteractor } from "../vtk-interactor.ts";
import { attachSliceControls, type SliceControls } from "../demos/slice-control.ts";
import { attachDoubleClick } from "../demos/view-grid.ts";
import { mountSliceController, type SliceController } from "../demos/slice-controller.ts";
import { mountSliceScheduler } from "../slice-scheduler.ts";
import "./view-cmds.ts";   // registers setCursor / setSliceFrame / viewContextMenu client handlers
import { type RGB, SLICER_BG_BOTTOM, SLICER_BG_TOP } from "../background.ts";

/** A chrome color ([number, number, number] by convention, but typed number[]) as an RGB tuple. */
const rgbOf = (c: number[]): RGB => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];

/** Slicer's 3D background as a CSS gradient, for the cell behind the canvas (top -> bottom). */
const css255 = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const CSS_BG_GRADIENT = `linear-gradient(${css255(SLICER_BG_TOP)}, ${css255(SLICER_BG_BOTTOM)})`;
import {
  CameraDisplayableManager, type CameraState, LayoutDisplayableManager, LiveScene, MarkupsDisplayableManager,
  type MirrorView, type OverlayItem, RoiCropDisplayableManager, SegmentationDisplayableManager, SliceDisplayableManager,
  type SceneMeshData, type SegOverlay, type SlicePlane, type SliceLayers, type ThreeDChrome, ModelDisplayableManager, ThreeDViewDisplayableManager, TransformDisplayableManager, type Vec3, ViewStateDisplayableManager, type ViewState, VolumeLayersDisplayableManager, VolumeRenderingDisplayableManager, type Volume3D, ModuleRegistryDisplayableManager, TerminologyDisplayableManager, SequenceDisplayableManager } from "../livescene.ts";

/** What the 3D view last composited: the volume it drew, the other fields, and any segmentation
 *  field suppressed because the colorize volume already renders those segments. Read by the
 *  transfer-function panel. Exported as a live binding, so a consumer must read it at render time
 *  rather than capture it -- an earlier diagnostic in this codebase was interpolated once into a
 *  template string and then never updated, which made a working path look dead. */
export let last3DFields: { volume: string | null; keys: string[]; suppressed: string[] } =
  { volume: null, keys: [], suppressed: [] };

export interface ViewCellRect { id: string; kind: string; name: string; view: { x: number; y: number; w: number; h: number } }
export interface LiveViews { live: LiveScene; sync: LiveSync; resize(): void; setCells(cells: ViewCellRect[]): void; camera(): { position: Vec3; focalPoint: Vec3; viewUp: Vec3; viewAngle: number }; cells(): string[]; fitVolume(rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[]): void }

const SLAB_MM = 1.5;                  // overlay items within this distance of the plane are "in plane"
// THE VIEW COLORS ARE THE THEME'S -- the same token the view bar and the Red / Yellow / Green
// buttons use, read once for the canvases, which cannot use var(). These were literals here
// (#f05a5a, #f0d24a, #5ad07a) beside different literals in theme.css (Slicer's own #F34A33,
// #EDD54C, #6EB04B), so a slice's line in another view was not quite the color of its bar.
const CELL_COLORS: Record<string, string> = {
  Red: cssToken("--sl-view-red", "#F34A33"), Yellow: cssToken("--sl-view-yellow", "#EDD54C"), Green: cssToken("--sl-view-green", "#6EB04B"),
};
const VIEW_INK = cssToken("--sl-view-ink", "#ffffff");
const ink = (alpha: number) => withAlpha(VIEW_INK, alpha);

interface SliceCell {
  name: string; el: HTMLElement; canvas: HTMLCanvasElement; ctx: GPUCanvasContext; overlay: HTMLCanvasElement;
  slice: SliceRenderer;          // per-cell reslicer: its own layer stack, basis, pan/zoom
  layers?: SliceLayers;          // from the app's slice composite node (absent → legacy shared volume)
  plane?: SlicePlane; controls?: SliceControls; orientKey: Orientation;
  branched?: boolean;   // a local pan/zoom is in progress: keep the local frame until it is written back
  bgId?: string;        // the image node currently in the background layer (see setSliceLayers)
}

/**
 * One dataset's answer at the probed point.
 *
 * A LIST OF DATASETS, of both kinds, with no privileged one. Ron: "The probe should show all gray
 * scale values and all segmentations names at the probe location... I just mention now to remind you
 * that you should not design for single anything." Today a cell can already carry three grayscale
 * layers (background, foreground, label) alongside two segmentations; more volumes in the scene will
 * arrive through the same list rather than through a special case.
 */
export interface ProbeRow {
  kind: "image" | "segmentation";
  id: string;
  /** The dataset's own name, as the Subject Hierarchy shows it. */
  source: string;
  /** Which slice layer it is, for an image: B, F or L, as Slicer labels them. */
  layer?: "B" | "F" | "L";
  /** IMAGE COORDINATES in that dataset's own grid -- each has its own, and they differ. */
  ijk: [number, number, number];
  /** images: the scalar at that voxel, in the volume's own units. */
  value?: number;
  /** a color image (fields.ts ImageFieldOpts.rgb24): its red, green and blue there, 0..255, instead of `value`. */
  rgb?: [number, number, number];
  /** segmentations: the label value (0 is background) and what it is called. */
  label?: number;
  segment?: string;
  color?: [number, number, number];
}
/** What is under the pointer, for every dataset drawn there. */
export interface ProbeReading {
  cell: string;
  ras: Vec3;
  rows: ProbeRow[];
}

export function mountLiveViews(gpu: Gpu, root: HTMLElement, cfg: { httpBase: string; wsUrl: string; peers?: string[]; onStatus?: (s: string) => void; onNotify?: (n: { title: string; body?: string; actions?: { label: string; primary?: boolean; onClick: () => void }[] }) => void; startup?: () => { drawing?: boolean; lighting?: string }; onFrame?: () => void; onNativePaint?: (segId: string, segment: number, points: Vec3[], mode: "add" | "remove", radiusMm: number, sphere: boolean, normal: Vec3) => void; onNativePaintCommit?: (segId: string) => void; connect?: boolean }): LiveViews {
  const preferred = (navigator as unknown as { gpu: GPU }).gpu.getPreferredCanvasFormat();
  const srgb = (preferred + "-srgb") as GPUTextureFormat;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  root.style.display = "block";

  const makeCanvas = (parent: HTMLElement, css: string) => { const c = document.createElement("canvas"); c.style.cssText = css; parent.appendChild(c); return c; };
  const makeCell = (name: string, label: string, color: string) => {
    const el = document.createElement("div"); el.className = "lv-cell"; el.dataset.cell = name;
    el.style.cssText = "position:absolute;display:none;overflow:hidden;background:var(--sl-view-bg)";
    const canvas = makeCanvas(el, "position:absolute;inset:0;width:100%;height:100%;display:block;background:var(--sl-view-canvas);touch-action:none");
    const lab = document.createElement("div"); lab.textContent = label; lab.className = "lv-cell-label";
    lab.style.cssText = `position:absolute;top:4px;left:6px;font:700 11px system-ui;pointer-events:none;opacity:.85;color:${color}`;
    el.appendChild(lab); root.appendChild(el);
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
    ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
    return { el, canvas, ctx };
  };

  // ── 3D cell (view "1") ──
  const three = makeCell("3D", "3D", "var(--sl-view-3d)");
  const threeOverlay = makeCanvas(three.el, "position:absolute;inset:0;width:100%;height:100%;pointer-events:none");
  let chrome3d: ThreeDChrome | undefined;
  /**
   * WHAT THE 3D VIEW PANEL SETS, held here rather than on the scene node.
   *
   * `chrome3d` arrives from the mirrored MRML view node and is replaced wholesale whenever the scene
   * pushes it, so a user's choice written into it would be silently reverted on the next update.
   * These are view-local display state -- Ron's "global conditions for the 3D window" -- and they
   * override the node's values when set. Undefined means "follow the node", which is what a freshly
   * loaded scene should do.
   */
  const view3dOpts: { box?: boolean; labels?: boolean; marker?: boolean; shade?: [number, number, number, number]; drawing?: boolean } = {};
  /** The ⋮ panel's controls re-read view3dOpts through these when a node changes them from outside. */
  const panelRepaints: (() => void)[] = [];
  // THE DRAWING LOOK, remembered per machine: matte surfaces, outlines, shadow in the crevices
  // (scene-renderer.ts). On by default -- Ron, 2026-09-19, on the mockup: "let's do the drawing
  // look" -- and a switch here because a plain-lit picture is sometimes what a figure needs.
  // Settings › 3D view decides how a new window starts (`[View3D] drawing`, `lighting` in
  // settings.ini, read here through cfg.startup); the switch in the ⋮ panel changes this window
  // only. Before 2026-09-20 the switch itself was remembered in localStorage; that value is
  // honored once more as the fallback, so nobody's choice is lost on the day of the change.
  const startup = cfg.startup?.() ?? {};
  if (startup.drawing !== undefined) view3dOpts.drawing = startup.drawing;
  else { try { view3dOpts.drawing = localStorage.getItem("sl-3d-drawing-look") !== "off"; } catch { view3dOpts.drawing = true; } }

  /**
   * The 3D view's lighting, applied to EVERYTHING it draws.
   *
   * Ron: "the light settings should apply to both surface and volume rendering... With colorize
   * volume on, the light settings have no effect." They did not: the presets drove only
   * SceneRenderer.setMeshShade, so surfaces responded and the colorize volume -- which is what a
   * whole-body CT is actually drawn with -- did not.
   *
   * Re-applied after every field registration and rebuild, because livescene pushes a field's shade
   * from its presentation preset whenever it re-colorizes, and would otherwise quietly revert this.
   */
  /**
   * ONE OWNER PER VOLUME'S LIGHTING: the volume's transfer-function node, which its preset writes
   * and the Volume Rendering module edits. This used to re-assert the view's lighting over every
   * volume field on EVERY FRAME (from setCamera), so the module's Matte / Standard / Glossy and the
   * four sliders wrote a value the view overwrote before it was drawn. Ron, on C3N-01524: "the
   * buttons for glossy etc had no perceptible effect." Measured: the transfer function said
   * ambient 1.0 and the field said 0.16, frame after frame.
   *
   * Now the view's lighting (the gear in the 3D view) owns the SURFACES and the non-volume fields,
   * and when a person changes it there it is WRITTEN THROUGH to every volume's transfer function --
   * once, as a scene change -- so the module shows it and the next re-colorize keeps it. A volume
   * being registered is not touched: it arrives lit by its preset, as Slicer does.
   */
  const applyShade = (toVolumes = false) => {
    const sh = view3dOpts.shade;
    if (!sh) return;
    type Shadeable = { setShade?: (s: typeof sh) => void };
    scene?.setMeshShade?.(sh);
    scene?.setDrawingLook?.(view3dOpts.drawing !== false);
    for (const f of fields3d.values()) (f as Shadeable).setShade?.(sh);
    (volumeField as Shadeable | undefined)?.setShade?.(sh);
    // The solid look's merged segmentations are SURFACES in all but how they are made: the view's
    // lighting, as the meshes have it, not a volume preset's.
    for (const v of vol3d.values()) if (v.drawsSegs) (v.field as Shadeable).setShade?.(sh);
    if (toVolumes) {
      for (const n of live.nodes.values()) {
        if (n.type !== "transferFunction") continue;
        const cur = n.shade as number[] | undefined;
        if (cur && cur.length === 4 && cur.every((v, i) => Math.abs(v - sh[i]) < 1e-6)) continue;
        live.write({ op: "patch", id: n.id as string, path: "#/shade", value: [...sh] });
      }
    }
    scene?.syncUniforms?.();
  };
  const AXIS_LABELS: [Vec3, string][] = [[[1, 0, 0], "R"], [[-1, 0, 0], "L"], [[0, 1, 0], "A"], [[0, -1, 0], "P"], [[0, 0, 1], "S"], [[0, 0, -1], "I"]];
  /** vtkMRMLViewDisplayableManager chrome: the scene bounding box, R/A/S/L/P/I labels, orientation marker. */
  const drawThreeOverlay = () => {
    const ov = threeOverlay, g = ov.getContext("2d")!;
    if (ov.width !== three.canvas.width || ov.height !== three.canvas.height) { ov.width = three.canvas.width; ov.height = three.canvas.height; }
    g.clearRect(0, 0, ov.width, ov.height);
    if (!threeVisible) return;
    // AN EMPTY 3D VIEW SAYS SO, for the same reason an empty slice cell does: nothing is wrong, every
    // volume and segmentation is simply switched off here, and a bare gradient does not distinguish
    // that from a broken renderer. Ron, looking at exactly this: "the 3d view is empty."
    if (nothingIn3D) {
      g.font = `${11 * dpr}px system-ui`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = ink(0.45);
      g.fillText("nothing shown in 3D — use the 3D buttons in Scene", ov.width / 2, ov.height / 2);
    }
    // WHAT TO DRAW, resolved once: the panel's choice, else the view node's, else off. This used to
    // bail out entirely when no view node had been mirrored yet, which would have made the panel's
    // toggles do nothing at all until a scene pushed chrome.
    const wantBox = view3dOpts.box ?? chrome3d?.boxVisible ?? false;
    const wantLabels = view3dOpts.labels ?? chrome3d?.axisLabelsVisible ?? false;
    const wantMarker = view3dOpts.marker ?? ((chrome3d?.orientationMarkerType ?? 0) > 0);
    if (!wantBox && !wantLabels && !wantMarker) return;
    const w = ov.width, h = ov.height;
    const proj = (p: Vec3) => camera.worldToDisplay(p, w, h);
    // bounds: union of volume + mesh AABBs, else the default 100 mm box
    // WHAT IS ACTUALLY DRAWN, and nothing invented. The +/-100 mm starting box is gone: it was only
    // ever grown, so anything smaller than 200 mm got a box that was neither its size nor its center.
    const fb = sceneBounds();
    if (!fb) return;
    const [lo, hi] = fb;
    // The box itself is no longer drawn here: it is a field in the 3D pass (syncSceneBox), so the
    // anatomy hides the edges behind it. `wantBox` still gates the labels' companion below.
    void wantBox;
    if (wantLabels) {
      const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      const half: Vec3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
      g.font = `bold ${13 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "middle";
      for (const [d, label] of AXIS_LABELS) {
        const at: Vec3 = [c[0] + d[0] * half[0] * 1.08, c[1] + d[1] * half[1] * 1.08, c[2] + d[2] * half[2] * 1.08];
        // HIDE THE LABEL THAT WOULD LAND ON THE ANATOMY -- Slicer's answer, and the reason to copy it.
        //
        // Ron: "Look at the solution in slicer. The one in front of the object is turned off, so it
        // does not obstruct the object that we are looking at. In the current location, the P should
        // not be visible."
        //
        // The far face's center projects INSIDE the silhouette: perspective pulls it toward the
        // vanishing point, and this overlay carries no depth, so it draws over the organs instead of
        // behind them. The near and side faces project outside, where a label belongs.
        if (labelFacesAway(d, camera.directionOfProjection)) continue;
        const p = proj(at);
        if (p.depth <= 0) continue;
        g.fillStyle = cssToken("--sl-scrim-strong", "rgba(0,0,0,.55)"); g.beginPath(); g.arc(p.x, p.y, 10 * dpr, 0, Math.PI * 2); g.fill();
        g.fillStyle = VIEW_INK; g.fillText(label, p.x, p.y);
      }
    }
    if (wantMarker) drawOrientationMarker(g, w, h, (p: Vec3) => { const q = camera.worldToDisplay([camera.focalPoint[0] + p[0], camera.focalPoint[1] + p[1], camera.focalPoint[2] + p[2]], w, h); const f = camera.worldToDisplay(camera.focalPoint, w, h); return { dx: q.x - f.x, dy: q.y - f.y }; }, 1);
  };
  /** Corner orientation marker (axes glyph): world direction -> screen delta supplied by the caller. */
  const drawOrientationMarker = (g: CanvasRenderingContext2D, w: number, h: number, dir: (p: Vec3) => { dx: number; dy: number }, scaleMm: number) => {
    // LOWER LEFT. Ron: "anatomical orientation on off in the lower left corner of the image (again,
    // slicer)". It was lower right, which is where nothing else lives in the 3D view -- but the 3D
    // view is not a slice cell, and the corner Ron reads is the left one.
    // ROOM FOR THE WHOLE GLYPH. An axis and its label reach `size` from the origin in any direction,
    // so the origin needs that much clearance on every side or an axis pointing at the nearer edge is
    // clipped -- Ron: "The orientation marker has a visibility problem." It sat `size` from the left
    // and bottom, which is exactly one label's width short, and the R axis ran off the edge.
    const size = 34 * dpr, pad = size + 14 * dpr;
    const cx = pad, cy = h - pad;

    // DESATURATED, and readable against the light part of the gradient. Ron: "I hate saturated colors
    // and I hate poor contrast." The old #ff6b6b / #6bff8f / #6b9bff are near-full-chroma, and the
    // green in particular sat at roughly 1.5:1 against the pale blue background -- invisible. These
    // are the same three hues taken down in chroma and darkened until each clears about 4.5:1 on the
    // lightest part of the backdrop, which is what makes them legible rather than merely present.
    const axes: [Vec3, string, string][] = [
      [[1, 0, 0], "R", cssToken("--sl-axis-r", "#b3453f")],
      [[0, 1, 0], "A", cssToken("--sl-axis-a", "#2f7d46")],
      [[0, 0, 1], "S", cssToken("--sl-axis-s", "#3a5fa8")],
    ];
    // A faint disc behind the glyph, so it does not depend on whatever is drawn under it.
    g.save();
    g.fillStyle = cssToken("--sl-view-scrim", "rgba(16,18,26,.34)");
    g.beginPath(); g.arc(cx, cy, size * 1.18, 0, Math.PI * 2); g.fill();
    g.lineWidth = 2.5 * dpr; g.font = `bold ${11 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "middle";
    for (const [d, label, col] of axes) {
      const v = dir([d[0] * scaleMm, d[1] * scaleMm, d[2] * scaleMm]);
      const l = Math.hypot(v.dx, v.dy) || 1;
      const ex = cx + (v.dx / l) * size * 0.72, ey = cy + (v.dy / l) * size * 0.72;
      g.strokeStyle = col; g.beginPath(); g.moveTo(cx, cy); g.lineTo(ex, ey); g.stroke();
      // The letter carries a light halo, which is what lets a dark glyph sit on a dark disc AND on a
      // pale gradient without either one swallowing it.
      const lx = cx + (v.dx / l) * size * 0.95, ly = cy + (v.dy / l) * size * 0.95;
      g.lineWidth = 3 * dpr; g.strokeStyle = ink(0.85);
      g.strokeText(label, lx, ly);
      g.fillStyle = col; g.fillText(label, lx, ly);
      g.lineWidth = 2.5 * dpr;
    }
    g.restore();
  };
  const camera = VtkCamera.slicerDefault();
  let scene: SceneRenderer | null = null;
  let thumbScene: SceneRenderer | null = null;   // preset thumbnails only; see __renderVrPresetThumbnails
  const fields3d = new Map<string, Field>();
  let volumeField: ImageField | null = null;
  // THE 3D VOLUME RENDERINGS, KEYED BY IMAGE ID -- one entry per volume the VR manager is drawing.
  //
  // This was a single `volume3DField` plus a `volumeShown3D` flag, which could only ever describe
  // one volume: loading a second CT and turning 3D on for it repointed the same slot, so the first
  // one vanished. The renderer never had that limit -- SceneRenderer.build() takes a list of fields
  // and composites them, which is exactly how a segmentation already draws alongside a CT (see
  // src/live/webgpu/selftest-multi, two volumes in one scene). Ron asked for that here.
  //
  // The field in an entry is a SEPARATE object from the slice views' `volumeField`: the colorize
  // rendering (CT tinted by segment, unlabeled voxels nearly transparent) belongs in 3D only, and
  // one field cannot serve both because the slice renderer reslices the grayscale scalars.
  const vol3d = new Map<string, Volume3D>();
  let clip: { lo: Vec3; hi: Vec3 } | null = null;
  let threeVisible = false;
  /** Nothing at all is being composited in 3D — drawn as a note rather than a bare gradient.
   *  Declared here, above mountAdaptive3d: drawThreeOverlay is its onFrame, and a draw during
   *  setup would otherwise read this before it is initialized. */
  let nothingIn3D = false;
  /** The frame-rate readout in the 3D view's bar (built with the bar, far below). */
  let fpsEl: HTMLElement | null = null;
  const sizeCanvas = (c: HTMLCanvasElement) => { c.width = Math.max(1, Math.round(c.clientWidth * dpr)); c.height = Math.max(1, Math.round(c.clientHeight * dpr)); };
  const clearCanvas = (ctx: GPUCanvasContext) => {
    const enc = gpu.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView({ format: srgb }), clearValue: { r: 0.02, g: 0.024, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end(); gpu.device.queue.submit([enc.finish()]);
  };
  const a3d = mountAdaptive3d({
    scene: () => scene,
    // A sequence playing changes the content on a schedule: full-quality frames, not moving ones (accum-loop.ts).
    steady: () => { for (const n of live.nodes.values()) if (n.type === "sequenceBrowser" && n.playbackActive === true) return true; return false; },
    view: () => three.ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: threeVisible ? three.canvas.width : 0, h: three.canvas.height }),
    setCamera: (s, w, h) => {
      // Nothing re-asserted here any more: a volume's lighting is its transfer function's (see
      // applyShade), and the surfaces' is set once on the renderer.
      s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h,
        camera.parallelProjection ? camera.parallelScale : undefined);
    },
    // THE MOVING RESOLUTION IS CAPPED ONLY WHEN A VOLUME IS BEING RENDERED. Every frame during a
    // drag was drawn at 40% and the still frame at 100%, so a rotation flickered between soft and
    // sharp (Ron, 2026-09-20: "when I rotate, there is a flickering. Is there some downsampling
    // going on during movement? Is it necessary?"). Measured on C3N-01524 at 1354x1642: surfaces
    // alone orbit at 61 frames/s at full resolution (28 with the cap), so the cap only cost
    // sharpness there; with the volume rendering on, full resolution drops to 12 frames/s and the
    // budget controller alone oscillates, so the 40% cap stays for that case.
    //
    // 2026-09-23, Ron on CT-Training-LC003: the moving frames took 13-18 ms and were still drawn at 25%,
    // chasing a 16 ms (60 frames a second) target, and the noise of a single low-resolution frame read as
    // "a snow globe". His target: "15 frames per second are borderline, 30 are more than enough." So:
    // aim for 33 ms, no fixed 40% cap, and let the budget lower the resolution only as far as a volume
    // needs it -- on a small CT not at all. The rate is shown in the 3D view's bar (onFps).
    gpu, movingScaleCap: 1, budgeted: () => !!last3DFields.volume, targetMs: 33, target: 8,
    onFrame: () => { drawThreeOverlay(); cfg.onFrame?.(); },
    onFps: (fps, scale) => {
      if (!fpsEl) return;
      fpsEl.textContent = `${fps.toFixed(0)} fps${scale < 0.98 ? ` · ${Math.round(scale * 100)}%` : ""}`;
      fpsEl.title = `While the view moves: ${fps.toFixed(0)} frames a second, drawn at ${Math.round(scale * 100)}% resolution. A still view is always drawn at full resolution.`;
    },
  });
  let meshes: SceneMeshData[] = [];
  // Slicer fits the 3D view to the data the first time there IS data, and leaves the camera alone
  // afterwards. Without it a volume renders wherever the default camera happened to point -- which
  // is what "not centered" looks like. Declared before rebuild3d, which sets it.
  let fittedOnce = false;
  const rebuild3d = () => {
    // The view's own lighting, re-asserted. livescene pushes a field's shade from its presentation
    // preset on every re-colorize, so without this the panel's choice is reverted the next time
    // anything is rebuilt -- and at startup the scene may not exist yet when the default is chosen.
    applyShade();
    // The colorize volume field renders the CT *and* the segments in one pass -- it is built from
    // both the scalar and the label volume. When it is the volume being drawn, a separately baked
    // segmentation volume would paint the same anatomy a SECOND time, and the two copies do not
    // agree: the baked one carries a fixed shade and a per-segment palette, so it answers neither
    // the lighting sliders nor the group-opacity sliders. Ron saw exactly that -- bone set to 0
    // still showing bone, "as if there are two structures there and only one is affected" -- and
    // the unshaded copy sitting on top of the shaded one is also why ambient and diffuse looked
    // inert. The reference (examples/colorize) builds ONE field for this reason.
    //
    // Suppressed here rather than at the segmentation manager because this is the single place
    // that composes the 3D frame, so it stays correct across every transition -- rebuild3d runs on
    // both setVolume3D and setField -- without the two managers having to know about each
    // other. The segmentation's 2D slice overlay is untouched: that is a separate path.
    // Suppression is now per segmentation, not global: with two volumes rendered at once, one may
    // be colorized by its own segmentation while the other's segmentation still has to draw itself.
    const colorized = new Set<string>();
    const vrColored = new Set<string>();                          // by a volume rendering alone, not the solid look
    for (const v of vol3d.values()) {
      if (v.colorizedSeg) { colorized.add(v.colorizedSeg); vrColored.add(v.colorizedSeg); }
      for (const id of v.drawsSegs ?? []) colorized.add(id);     // the solid look's merged segmentations
    }
    syncSceneBox();
    const dup = (k: string) => k.startsWith("seg:") && colorized.has(k.slice(4));
    const kept = [...fields3d.entries()].filter(([k]) => !dup(k));
    const fs = kept.map(([, f]) => f);
    for (const v of vol3d.values()) fs.unshift(v.field);
    // What the 3D view is ACTUALLY compositing, published for the diagnostic line in the panel.
    // The panel already claims "one volume, not two"; that claim was true of the colorize page and
    // false here, and nothing on screen said so. A count of the volumes in the frame is the one
    // number that would have shown it immediately.
    (globalThis as unknown as { __last3DFields?: unknown }).__last3DFields = last3DFields = {
      volume: vol3d.size
        ? [...vol3d.entries()].map(([id, v]) => (v.colorizedSeg ? "colorize " : "ct ") + id).join(", ")
        : null,
      keys: kept.map(([k]) => k),
      suppressed: [...fields3d.keys()].filter(dup),
    };
    // Announce a CHANGE only, and off this call stack: a listener responds by adding or removing a
    // field, which re-enters rebuild3d. Deferring breaks that re-entrancy, and notifying on change
    // rather than on every rebuild keeps a camera nudge from triggering a re-bake.
    const colorizedKey = [...colorized].sort().join("|");
    if (colorizedKey !== colorizedLast) {
      colorizedLast = colorizedKey;
      colorizedSegs = colorized;
      queueMicrotask(() => { for (const l of seg3DListeners) l(); });
    }
    colorizedSegs = colorized;
    vrColoredSegs = vrColored;
    // An EMPTY 3D view still renders a frame, exactly as an empty slice cell does below. Clearing
    // the canvas instead left the view a black hole until the first volume appeared, so Slicer's
    // background only showed up once something was rendered: build([]) paints just the gradient.
    nothingIn3D = fs.length === 0 && !meshes.some((m) => m.visible !== false);
    if (nothingIn3D) {
      if (!scene) scene = new SceneRenderer(gpu, srgb);
      scene.build([]);
      scene.setMeshes([]);
      scene.setSliceQuads([]);      // no data means no slice to show one of

      // Emptying the view arms the fit again, so the NEXT dataset is centered rather than inheriting
      // the camera that was framing the last one.
      fittedOnce = false;
      if (threeVisible) a3d.refresh();
      return;
    }
    if (!scene) scene = new SceneRenderer(gpu, srgb);
    // WITHIN THE DEVICE'S LIMIT, or the whole 3D view is refused. Every field's textures share one
    // bind group, and WebKit allows 16 sampled textures per stage: five colorize fields at once
    // (2026-09-14) were 15 plus the rest, and the view stopped drawing. Keep the fields that fit,
    // first in first kept, and say which were left out rather than lose everything.
    const limit = gpu.device.limits?.maxSampledTexturesPerShaderStage ?? 16;
    let used = 0;
    const fits: Field[] = [], dropped: string[] = [];
    for (const f of fs) { if (used + f.bindingCount <= limit) { fits.push(f); used += f.bindingCount; } else dropped.push(f.kind); }
    if (dropped.length) cfg.onStatus?.(`3D: ${dropped.length} field${dropped.length === 1 ? "" : "s"} not drawn (${dropped.join(", ")}) — the graphics device binds at most ${limit} textures at once`);
    scene.build(fits);
    scene.setMeshes(meshes);
    // Re-point the slice quads: renderSliceIn3D may have run before the scene existed, and build()
    // does not clear them (their textures are ours, and their contents are already current).
    scene.setSliceQuads([...sliceQuads.values()]);
    if (clip) scene.setClipBox(clip.lo, clip.hi);
    // FIT WHEN THE CONTENT ARRIVES, not merely the first time anything does.
    //
    // This fired on the FIRST rebuild -- when the first field appeared, before the segmentation and
    // long before the extracted surfaces -- and then never again. So the view was framed on whatever
    // happened to exist in that instant and stayed there. Ron: "When I load the data, the view is
    // messed up."
    //
    // It was survivable only by accident: the R/A/S/L/P/I buttons used to re-derive the distance and
    // focal point, so pressing one silently re-framed. Now that they correctly change orientation
    // alone, the bad framing has nowhere to go, which is why this surfaced the moment that was fixed.
    //
    // Re-fit when what is drawn has MATERIALLY changed -- a fifth of the diagonal, in size or in
    // position -- and only while the user has not moved the camera themselves. That is the balance
    // the old comment was reaching for: do not fight a camera someone has set, but do frame data
    // that was not there when the last decision was made.
    if (refitIfContentChanged()) return;
    a3d.refresh();
  };

  /**
   * Re-frame if what is drawn has materially changed. Returns whether it re-framed and drew.
   *
   * ITS OWN FUNCTION BECAUSE MESHES ARRIVE BY A DIFFERENT DOOR. This test used to live inline in
   * `rebuild3d`, which is reached when a FIELD is added or removed -- and extracted surfaces are not
   * a field. `pushMeshes` calls `scene.setMeshes(...)` and draws directly whenever the scene already
   * exists, which it does by the time a segmentation is ready, so 12 million triangles could land
   * without this ever running. Ron, on the first view after loading a stored segmentation: the
   * camera sat inside the liver until he pressed "Center and fit", which framed it perfectly --
   * proving the bounds were right all along and only this test was being skipped.
   */
  const refitIfContentChanged = (): boolean => {
    const nb = sceneBounds();
    if (!nb || userMovedCamera) return false;
    const diag = (b: [Vec3, Vec3]) => Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]);
    const mid = (b: [Vec3, Vec3], i: number) => (b[0][i] + b[1][i]) / 2;
    const d = diag(nb);
    // SOMETHING NEW OUTSIDE THE FRAME re-frames; less on screen does not. The old test re-framed
    // on any 20% change of the bounds either way, so switching the volume rendering off (the
    // surfaces alone are a smaller box) zoomed in and switching it back on zoomed out -- Ron,
    // 2026-09-20, two pictures of the same brain: "I only changed the two 3d buttons in the
    // panel. Why is one brain larger than the other?" The frame is kept until what is drawn
    // reaches past it by more than a tenth of its size.
    const grown = !fittedBounds || [0, 1, 2].some((i) => nb[0][i] < fittedBounds![0][i] - 0.1 * d || nb[1][i] > fittedBounds![1][i] + 0.1 * d);
    void mid;
    if (!grown) return false;
    fittedBounds = [[...nb[0]] as Vec3, [...nb[1]] as Vec3];
    fitCamera3D();
    return true;
  };

  // ── slice cells (dynamic, keyed by the app's layout names), one SliceRenderer each ──
  const cells = new Map<string, SliceCell>();
  // Whether the colorize volume is drawing the segments, and who wants to know when that changes.
  // The segmentation manager allocates and bakes a smoothed 3D volume only when its field will
  // actually be drawn, so it has to be told when the answer flips -- switching volume rendering off
  // makes its field the only way to see segments in 3D again.
  const seg3DListeners = new Set<() => void>();
  let colorizedLast = "";
  let colorizedSegs = new Set<string>();
  let vrColoredSegs = new Set<string>();
  const sliceChangeListeners = new Set<() => void>();   // controller bars re-read offset/range after any slice render
  let segOverlay: GPUTexture | null = null, segFill = 0.5, segOutline = 1.0;
  // The label-overlay form of the same thing: the segmentation's own r8uint labelmap plus a 256x2
  // palette, colored in the shader. Either this or `segOverlay` is set, never both -- whichever
  // arrived last wins, and clearing one clears the other.
  let segLabels: GPUTexture | null = null, segPaletteTex: GPUTexture | null = null;
  /**
   * Every segmentation the slices are drawing, back to front, with its own geometry and opacities.
   *
   * Ron: "the slice viewers show the results of the abdominal muscles but the 3d window shows both.
   * Make up your mind." Two networks over one study are there to be read against each other, so both
   * are drawn. The shader carries TWO label slots, so the list is capped at two and setSegOverlays
   * reports back how many it took -- silently dropping the third would be a lie to the panel.
   */
  // The slice renderer binds TWO segmentations per pass. It used to be the cap on how many the
  // slices showed, the probe read and the 3D ray tested -- with four MOOSE results loaded, two were
  // drawn and two silently were not. Ron: "the segmentations are messed up and the probe is even
  // worse." Now it is only the pair size: every further pair is one more overlay-only pass over
  // the frame (drawExtraOverlays), the probe reads every visible segmentation, and the 3D ray
  // walks them in pairs.
  const SEG_PAIR = 2;
  let segOverlays: SegOverlay[] = [];

  // ── the data probe: what structure is under the cursor ──────────────────────────────────────────
  //
  // Ron: "I need the data probe so I can explore individual structures." He is right that without it
  // he cannot help -- a segmentation you cannot interrogate is a picture, and 22 muscles in 22
  // colors still need a name attached to the one you are pointing at.
  //
  // ONE TEXEL FROM THE GPU, not a copy of the labelmap. The label volume is already resident as an
  // r8uint 3D texture (the baker uploaded it); holding a second CPU copy would be ~150 MB per
  // segmentation for a question about a single voxel. copyTextureToBuffer of a 1x1x1 region costs
  // one small buffer and about a millisecond, and the answer is exactly what is on screen rather
  // than a re-derivation of it.
  let probe: ProbeReading | null = null;
  let probeBusy = false, probeAt = 0;
  const probeListeners = new Set<(p: ProbeReading | null) => void>();
  const emitProbe = () => { for (const l of probeListeners) l(probe); };
  /**
   * One padded row per dataset probed (256 is WebGPU's bytesPerRow alignment), sized for the
   * grayscale layers a cell can carry plus the segmentation slots -- every dataset read in ONE
   * submit and ONE map, so the cost is a readback, not a readback per dataset.
   */
  // One 256-byte row per dataset read, GROWN when more are shown: it was fixed at 8 and the ninth dataset
  // was dropped without a word (six segmentations and three grayscale layers; code review 2026-09-24, A12).
  let probeRows = 8;
  let probeBuf = gpu.device.createBuffer({ size: 256 * probeRows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  /**
   * EVERY dataset at the point: each grayscale layer's value and each segmentation's segment.
   *
   * Ron: "When you look at the gluteus medius right it has labels displayed from both segmentations
   * but the probe only shows one." It did -- it took the FIRST visible segmentation node in the
   * scene and read that, pairing a node with a texture by hoping they were the same one. And: "The
   * probe should show all gray scale values and all segmentations names at the probe location."
   *
   * So the probe is built from what is DRAWN: the hovered cell's layer stack and the overlay list.
   * Both say which texture and with what geometry, so the probe cannot name something the view is
   * not showing.
   *
   * ONE TEXEL PER DATASET, never a CPU copy. They are already resident; a copy would be the whole
   * volume again for a question about a single voxel. Every copy goes into one buffer on one submit.
   *
   * Indexed through each dataset's OWN patientToTexture and its texture's OWN dimensions, with
   * `floor(tex * dims)` -- the identical arithmetic the shader uses to pick a texel. Anything else
   * can disagree with the picture by a voxel at a boundary, which is exactly where you probe.
   */
  /** Say nothing, rather than keep saying the last thing. */
  /**
   * Where the pointer last probed, so the reading can be REPEATED when the picture under a still
   * pointer changes: a sequence stepping to its next frame changes the value at the point without
   * the pointer moving, and a probe that only fires on hover would keep naming the frame that was.
   * Cleared when the pointer leaves the views.
   */
  let lastProbed: { cell: string; ras: Vec3 } | null = null;
  const clearProbe = () => { lastProbed = null; if (probe) { probe = null; emitProbe(); } };
  const reprobe = () => { if (lastProbed) requestAnimationFrame(() => { if (lastProbed) void probeAtRas(lastProbed.cell, lastProbed.ras, true); }); };

  const probeAtRas = async (cell: string, ras: Vec3, force = false) => {
    const now = performance.now();
    lastProbed = { cell, ras };
    if (probeBusy || (!force && now - probeAt < 40)) return;             // 25 Hz is plenty for a pointer
    const clear = clearProbe;
    const c = cells.get(cell);

    type Target = {
      row: number; tex: GPUTexture; kind: "image" | "segmentation"; id: string; source: string;
      layer?: "B" | "F" | "L"; ijk: [number, number, number];
      format: GPUTextureFormat; segments?: { labelValue: number; name?: string; color?: number[] }[];
      /** 256-bit mask of the structures actually drawn; absent means all of them. */
      visible?: Uint32Array;
    };
    const targets: Target[] = [];
    /** Place a dataset: RAS -> its texture coords -> its own voxel. Outside its grid, it is not read. */
    const place = (t: Omit<Target, "row" | "ijk">, p2t: Mat4) => {
      // A texture uploaded by a path that did not ask for COPY_SRC makes copyTextureToBuffer throw,
      // and a throw in the view update takes every view down -- it did once: "sourceTexture usage
      // does not contain CopySrc". A probe is a convenience; it must never be able to do that.
      if (!(t.tex.usage & GPUTextureUsage.COPY_SRC)) return;
      const dims: [number, number, number] = [t.tex.width, t.tex.height, t.tex.depthOrArrayLayers];
      const tc = applyMat4(p2t, ras);
      const ijk: [number, number, number] = [Math.floor(tc[0] * dims[0]), Math.floor(tc[1] * dims[1]), Math.floor(tc[2] * dims[2])];
      if (ijk.some((v, k) => v < 0 || v >= dims[k])) return;
      targets.push({ ...t, row: targets.length, ijk });
    };

    // ── the grayscale volumes at this point ──
    //
    // IN A SLICE: that cell's layer stack, in Slicer's order -- label, foreground, background.
    // Whatever is assigned; none of them is assumed to be there.
    //
    // IN 3D: there is no cell and no layer stack, so it is every volume the app has resolved
    // anywhere, de-duplicated by field. A ray does not have a background and a foreground.
    const gray: { layer?: "B" | "F" | "L"; f: ImageField }[] = [];
    if (c) {
      if (c.layers?.label) gray.push({ layer: "L", f: c.layers.label.field });
      if (c.layers?.foreground) gray.push({ layer: "F", f: c.layers.foreground.field });
      const bg = bgField(c);
      if (bg) gray.push({ layer: "B", f: bg });
    } else {
      const seen = new Set<ImageField>();
      const add = (f: ImageField | null | undefined) => { if (f && !seen.has(f)) { seen.add(f); gray.push({ f }); } };
      for (const cc of cells.values()) { add(cc.layers?.label?.field); add(cc.layers?.foreground?.field); add(bgField(cc)); }
      // `volumeField` ONLY IF NOTHING ELSE TURNED UP. It is the legacy shared volume, for a scene with
      // no slice composite at all -- and where a composite DOES exist it is a second ImageField over
      // the same image, so adding it unconditionally reported that volume twice. Ron: "what is the
      // meaning of the two 37?" One row was the cell's background by name, the other the same voxel
      // through the fallback, which has no name and so read as "volume". De-duplicating by field
      // object could not catch it: two objects, one image.
      if (!gray.length) add(volumeField);
    }
    for (const g of gray) {
      place({
        tex: g.f.volumeTexture(), kind: "image", id: fieldIds.get(g.f) ?? (imageName(g.f) || g.layer || "volume"),
        source: imageName(g.f) || "volume", layer: g.layer, format: g.f.textureFormat(),
      }, g.f.patientToTexture());
    }

    // ── every segmentation the slices are drawing, each through its own geometry. A specialized
    //    network covers a sub-volume, so one point can be inside one labelmap and outside another.
    // ONLY WHAT THIS CELL SHOWS. Ron: "If I have turned off structures in the segmentations module,
    // the probe should show me what is visible. Period... I want to have the name of what I see."
    //
    // Two switches, and both have to be honored or the probe names something that is not on screen:
    // a whole segmentation can be off in 3D while still drawn on the slices, and an individual
    // structure can be off everywhere. The mask carries the second; `visible3D` the first, and only
    // the 3D cell consults it -- a segmentation hidden in 3D is still legitimately probed in a slice.
    for (const o of segOverlays) {
      if (cell === "3D" && !o.visible3D) continue;
      const node = live.nodes.get(o.id);
      place({
        tex: o.labels, kind: "segmentation", id: o.id,
        source: (node?.name as string | undefined) ?? o.id, format: o.labels.format,
        segments: (node?.segments as Target["segments"]) ?? [],
        visible: o.visible,
      }, o.p2t);
    }

    if (!targets.length) { clear(); return; }
    probeBusy = true;
    probeAt = now;
    if (targets.length > probeRows) {
      probeBuf.destroy();
      while (probeRows < targets.length) probeRows *= 2;
      probeBuf = gpu.device.createBuffer({ size: 256 * probeRows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    try {
      const enc = gpu.device.createCommandEncoder();
      for (const t of targets) {
        enc.copyTextureToBuffer(
          { texture: t.tex, origin: { x: t.ijk[0], y: t.ijk[1], z: t.ijk[2] } },
          { buffer: probeBuf, offset: t.row * 256, bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      }
      gpu.device.queue.submit([enc.finish()]);
      await probeBuf.mapAsync(GPUMapMode.READ);
      const raw = probeBuf.getMappedRange().slice(0);
      probeBuf.unmap();
      const bytes = new Uint8Array(raw), halves = new Uint16Array(raw), floats = new Float32Array(raw);
      const rows: ProbeRow[] = targets.map((t) => {
        if (t.kind === "image") {
          // DECODE, do not assume: r32float carries the value, r16float the same at half precision
          // (a sequence's frames); r8unorm carries the original byte, which is what the shader
          // recovers by scaling the /255 sample by normScale.
          if (t.format === "rgba8unorm") {                   // a color volume: its three bytes, said as color
            const o = t.row * 256;
            return { kind: "image" as const, id: t.id, source: t.source, layer: t.layer, ijk: t.ijk, rgb: [bytes[o], bytes[o + 1], bytes[o + 2]] as [number, number, number] };
          }
          const value = t.format === "r32float" ? floats[t.row * 64] : t.format === "r16float" ? halfToFloat(halves[t.row * 128]) : bytes[t.row * 256];
          return { kind: "image" as const, id: t.id, source: t.source, layer: t.layer, ijk: t.ijk, value };
        }
        let v = bytes[t.row * 256];
        // A STRUCTURE THAT IS SWITCHED OFF READS AS NOTHING HERE. It is not drawn, so it is not what
        // is being pointed at, and naming it is the probe describing a different picture from the one
        // on screen. Falling back to 0 rather than dropping the row keeps "that segmentation has
        // nothing here" distinct from "that segmentation is not loaded".
        if (v !== 0 && t.visible && !(t.visible[v >> 5] & (1 << (v & 31)))) v = 0;
        const hit = t.segments?.find((y) => y.labelValue === v);
        return {
          kind: "segmentation" as const, id: t.id, source: t.source, ijk: t.ijk, label: v,
          // Label 0 is background: named so rather than dropped, because "nothing here" is an answer
          // about that segmentation and a missing row would read as a missing dataset.
          segment: v === 0 ? "" : hit?.name ?? `label ${v}`,
          color: hit?.color as [number, number, number] | undefined,
        };
      });
      const next: ProbeReading = { cell, ras, rows };
      const key = (p: ProbeReading | null) =>
        p ? p.cell + "|" + p.rows.map((r) => `${r.id}:${r.label ?? r.value ?? r.rgb?.join("/")}:${r.ijk.join(",")}`).join("|") : "";
      if (key(next) !== key(probe)) { probe = next; emitProbe(); }
    } catch { /* a readback that fails is a probe that says nothing, not a broken view */ }
    finally { probeBusy = false; }
  };
  /** Bind this cell's renderer to the current overlay list (or to the legacy single overlay). */
  /** Bind one PAIR of the overlay list (index i and i+1) as the renderer's A and B. */
  const bindSegPair = (sr: SliceRenderer, i: number) => {
    const a = segOverlays[i], b = segOverlays[i + 1];
    sr.setLabelOverlay(a.labels, a.palette, a.p2t);
    sr.setOverlayOpacity(a.fillOpacity); sr.setOutlineOpacity(a.outlineOpacity);
    if (b) sr.setLabelOverlayB(b.labels, b.palette, b.p2t, b.fillOpacity, b.outlineOpacity);
    else sr.setLabelOverlayB(null, null);
  };
  const applySegOverlays = (sr: SliceRenderer) => {
    if (segOverlays.length) { bindSegPair(sr, 0); return; }
    sr.setLabelOverlay(segLabels, segPaletteTex);
    sr.setLabelOverlayB(null, null);
  };
  /** After a frame with the first pair: every further pair, drawn over it; then the first pair is
   *  bound again so the renderer is left as applySegOverlays leaves it. */
  let paintLog: { cell: string; t: number; orient: string; posMm: number; off01: number; basis: boolean }[] | null = null;
  /**
   * EVERY SLIDER DRAG, SUMMED UP IN THE SESSION LOG. Ron, 2026-09-24 on 17:23: the green view "jumping around" while
   * he dragged its slider with the red and yellow views on screen, steady with green alone -- not reproduced in the
   * test browser (81 steps, only green painted, every paint where the slider was). So his window says, after each
   * drag: how many steps were asked, how many paints were drawn and how many of them away from the slider, and which
   * other views painted meanwhile.
   */
  let sliderDrag: { cell: string; last: number; asked: number; t0: number; timer?: number; paints: { cell: string; posMm: number; orient: string; basis: boolean; asked: number }[]; jumps: string[]; writers: Map<string, number> } | null = null;
  /** Where a call came from, as the first frames outside this file's plumbing: what moved the slice. */
  const callerOf = (): string => (new Error().stack ?? "").split("\n").slice(3, 6).map((l) => l.trim().replace(/^at /, "").replace(/\(?https?:\/\/[^)]*\/([^/)]+)\)?/, "$1")).join(" < ");
  const noteSliderStep = (cell: string, mm: number) => {
    if (!sliderDrag || sliderDrag.cell !== cell) { flushSliderDrag(); sliderDrag = { cell, last: mm, asked: 0, t0: performance.now(), paints: [], jumps: [], writers: new Map() }; }
    // A STEP OF MORE THAN 5 mm is not a drag: the slider moves a fraction of a millimeter to a few per event. Who asked.
    if (sliderDrag.asked > 0 && Math.abs(mm - sliderDrag.last) > 5 && sliderDrag.jumps.length < 6) sliderDrag.jumps.push(`${sliderDrag.last.toFixed(1)} → ${mm.toFixed(1)} mm from ${callerOf()}`);
    sliderDrag.last = mm; sliderDrag.asked++;
    clearTimeout(sliderDrag.timer); sliderDrag.timer = setTimeout(flushSliderDrag, 800) as unknown as number;
  };
  const flushSliderDrag = () => {
    const d = sliderDrag; sliderDrag = null; if (!d || d.asked < 5) return;
    const own = d.paints.filter((p) => p.cell === d.cell);
    const off = own.filter((p) => Number.isFinite(p.asked) && Math.abs(p.posMm - p.asked) > 0.5);
    const worst = off.reduce((m, p) => Math.max(m, Math.abs(p.posMm - p.asked)), 0);
    const others = new Map<string, number>(); for (const p of d.paints) if (p.cell !== d.cell) others.set(p.cell, (others.get(p.cell) ?? 0) + 1);
    const orients = [...new Set(own.map((p) => p.orient + (p.basis ? " (oblique)" : "")))].join(", ");
    // WRITTEN ONLY WHEN SOMETHING IS WRONG: a paint away from the slider, or a write to the plane that was not the
    // slider's. (The jump Ron saw was the slider's own values -- its number resized it, theme.css .sl-slice-value.)
    if (!off.length && !d.writers.size) return;
    const writers = [...d.writers].map(([k, v]) => `${v}× ${k}`).join("; ");
    const line = `slider drag in ${d.cell}: ${d.asked} steps in ${((performance.now() - d.t0 - 800) / 1000).toFixed(1)} s, ${own.length} paints, ${off.length} away from the slider${off.length ? ` (worst ${worst.toFixed(1)} mm)` : ""}; drawn as ${orients || "nothing"}; other views painted: ${others.size ? [...others].map(([k, v]) => `${k} ${v}`).join(", ") : "none"}` +
      `; jumps over 5 mm: ${d.jumps.length ? d.jumps.join(" | ") : "none"}; other writes to its plane: ${writers || "none"}`;
    void fetch("/_log", { method: "POST", body: line, keepalive: true }).catch(() => {});
  };
  const drawExtraOverlays = (sr: SliceRenderer, view: GPUTextureView, w: number, h: number) => {
    if (segOverlays.length <= SEG_PAIR) return;
    for (let i = SEG_PAIR; i < segOverlays.length; i += SEG_PAIR) {
      bindSegPair(sr, i);
      sr.renderOverlayPassInto(view, w, h);
    }
    bindSegPair(sr, 0);
  };
  const segShown = () => segOverlays.length > 0 || segOverlay !== null || (segLabels !== null && segPaletteTex !== null);
  const overlays = new Map<string, OverlayItem[]>();   // layer -> items (cell "*")
  const viewStateDM = new ViewStateDisplayableManager();  // interaction / selection / crosshair / segmentEditor nodes
  const viewState: ViewState = viewStateDM.state;         // read the manager's state directly (never a stale copy)
  // Read app-level state straight from the model (live.nodes): the single source of truth, never a stale copy.
  const stateNode = (type: string) => live.find(type);
  const interactionMode = () => (stateNode("interaction")?.mode as string | undefined) ?? "viewTransform";
  let nextOrient = 0;
  const ORIENTS: Orientation[] = ["axial", "coronal", "sagittal"];

  const sliceCell = (name: string): SliceCell => {
    let c = cells.get(name);
    if (c) return c;
    const made = makeCell(name, name, CELL_COLORS[name] ?? "var(--sl-fg-muted)");
    const overlay = makeCanvas(made.el, "position:absolute;inset:0;width:100%;height:100%;pointer-events:none");
    // Each SliceRenderer orientation slot holds ONE basis/plane; cells beyond the anatomical trio share
    // slots round-robin until the renderer gets per-cell state (S6). Red/Green/Yellow map to their presets.
    const orientKey: Orientation = name === "Red" ? "axial" : name === "Green" ? "coronal" : name === "Yellow" ? "sagittal" : ORIENTS[nextOrient++ % 3];
    const sr = new SliceRenderer(gpu, srgb);
    if (volumeField) { const [lo, hi] = volumeField.aabb(); sr.setVolume(volumeField.patientToTexture(), lo, hi); sr.setTextures(volumeField.volumeTexture(), segOverlay ?? undefined); applySegOverlays(sr); }
    c = { name, ...made, overlay, orientKey, slice: sr };
    cells.set(name, c);
    attachInteraction(c);
    return c;
  };
  const fieldNames = new WeakMap<object, string>();
  const imageName = (f: object) => fieldNames.get(f) ?? "";
  /** The image NODE a field shows, so a probe row can be matched to the scene (a sequence's frame,
   *  say) rather than only read by a person. Names are not ids: two frames share a stem. */
  const fieldIds = new WeakMap<object, string>();
  /** The background volume a cell reslices: its composite's background layer, else the legacy shared
   *  volume -- UNLESS the composite has one assigned but hidden for this view specifically (Subject
   *  Hierarchy's per-view toggle), in which case falling back would silently undo that hide. */
  /** Two image nodes that are frames of the same sequence (logic/sequences.ts marks each with its id). */
  const sameSequence = (a: string, b: string): boolean => {
    const sa = live.nodes.get(a)?.sequence, sb = live.nodes.get(b)?.sequence;
    return !!sa && sa === sb;
  };
  const bgField = (c: SliceCell): ImageField | null => c.layers?.background?.field ?? (c.layers?.backgroundSuppressed ? null : volumeField);
  /** Push a cell's layer stack (or the legacy shared volume) into its renderer. */
  const applyLayers = (c: SliceCell) => {
    const L = c.layers, sr = c.slice, bg = bgField(c);
    if (!bg) return;
    const [lo, hi] = bg.aabb();
    sr.setVolume(bg.patientToTexture(), lo, hi);
    sr.setTextures(bg.volumeTexture(), segOverlay ?? undefined);
    applySegOverlays(sr);
    if (L?.background) sr.setWindowLevel(L.background.win, L.background.lev); else if (legacyWL) sr.setWindowLevel(legacyWL.win, legacyWL.lev);
    sr.setLayerLUTs(L?.background?.lut ?? null, L?.foreground?.lut ?? null);
    sr.setBackgroundRGB(bg.rgb);
    sr.setForegroundRGB(!!L?.foreground?.field?.rgb);
    if (L?.foreground) sr.setForeground(L.foreground.field.volumeTexture(), L.foreground.field.patientToTexture(), L.foreground.win, L.foreground.lev, L.foreground.opacity, L.foreground.compositing);
    else sr.setForeground(null, null, 0, 0, 0);
    if (L?.label) sr.setLabelLayer(L.label.field.volumeTexture(), L.label.field.patientToTexture(), L.label.table, L.label.opacity);
    else sr.setLabelLayer(null, null, null, 0);
    // Only the legacy single-overlay path takes its opacities from here; with a list, each entry
    // carries its own (they are separate display nodes) and applySegOverlays has already set them.
    if (!segOverlays.length) { sr.setOverlayOpacity(segShown() ? segFill : 0); sr.setOutlineOpacity(segShown() ? segOutline : 0); }
  };
  let legacyWL: { win: number; lev: number } | undefined;

  const planeOffset01 = (c: SliceCell): number => {
    const pl = c.plane!;
    if (pl.basis) return c.slice.offset01Along(c.orientKey, [pl.basis.nDir[0] * pl.posMm, pl.basis.nDir[1] * pl.posMm, pl.basis.nDir[2] * pl.posMm]);
    const [lo, hi] = bgField(c)!.aabb();
    const axis = pl.orient === "axial" ? 2 : pl.orient === "coronal" ? 1 : 0;
    return Math.max(0, Math.min(1, (pl.posMm - lo[axis]) / Math.max(hi[axis] - lo[axis], 1e-6)));
  };
  const applyPlane = (c: SliceCell) => {
    const pl = c.plane!, slice = c.slice;
    slice.setBasis(c.orientKey, pl.basis ? { uDir: pl.basis.uDir, vDir: pl.basis.vDir, nDir: pl.basis.nDir } : null);
    if (!c.branched) {   // while a local pan/zoom is in flight the renderer's own viewState is the truth
      if (pl.centerRAS && pl.fovX && pl.fovY) slice.setMirrorFrame(c.orientKey, pl.centerRAS as Vec3, pl.fovX, pl.fovY); else slice.resetView(c.orientKey);
    }
    slice.setPlane(c.orientKey, planeOffset01(c));
  };
  const drawOverlay = (c: SliceCell) => {
    const ov = c.overlay, g = ov.getContext("2d")!;
    if (ov.width !== c.canvas.width || ov.height !== c.canvas.height) { ov.width = c.canvas.width; ov.height = c.canvas.height; }
    g.clearRect(0, 0, ov.width, ov.height);
    if (!bgField(c) || !c.plane) return;
    const off = planeOffset01(c), aspect = ov.width / ov.height;
    const proj = (ras: Vec3) => { const r = c.slice.rasToView(c.orientKey, off, ras, aspect); return { x: r.u * ov.width, y: r.v * ov.height, d: r.distMm }; };
    const rgba = (col: number[], a = 1) => `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${a})`;
    g.lineWidth = 2 * dpr; g.font = `${11 * dpr}px system-ui`;
    for (const items of overlays.values()) {
      for (const it of items) {
        if (it.kind === "point") {
          const p = proj(it.ras); const inPlane = Math.abs(p.d) <= SLAB_MM;
          if (it.inPlaneOnly && !inPlane) continue;      // a control, not a projection (see OverlayItem)
          const rad = (it.radiusPx ?? 5) * dpr * (inPlane ? 1 : 0.7);
          if (it.ring) {
            // A RING, as in 3D: a white rim under the markup's color, the center clear. Out of the slice: fainter.
            const lw = g.lineWidth, a = inPlane ? 1 : 0.55;
            g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2);
            g.strokeStyle = `rgba(255,255,255,${0.9 * a})`; g.lineWidth = 3.5 * dpr; g.stroke();
            g.strokeStyle = rgba(it.color, a); g.lineWidth = 1.8 * dpr; g.stroke();
            g.lineWidth = lw;
          } else {
            g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2);
            if (inPlane) { g.fillStyle = rgba(it.color); g.fill(); } else { g.strokeStyle = rgba(it.color, 0.6); g.stroke(); }
          }
          if (it.label) {
            // A white edge under the text, so a black label reads on a dark slice.
            const lw = g.lineWidth, x = p.x + rad + 3 * dpr, y = p.y - rad;
            g.strokeStyle = `rgba(255,255,255,${inPlane ? 0.85 : 0.5})`; g.lineWidth = 3 * dpr; g.strokeText(it.label, x, y);
            g.fillStyle = rgba(it.color, inPlane ? 1 : 0.6); g.fillText(it.label, x, y); g.lineWidth = lw;
          }
        } else if (it.kind === "polyline") {
          g.strokeStyle = rgba(it.color, 0.9); g.lineWidth = (it.widthPx ?? 2) * dpr; g.beginPath();
          const pts = it.points.map(proj);
          for (let i = 0; i + 1 < pts.length; i++) { if (Math.abs(pts[i].d) <= SLAB_MM && Math.abs(pts[i + 1].d) <= SLAB_MM) { g.moveTo(pts[i].x, pts[i].y); g.lineTo(pts[i + 1].x, pts[i + 1].y); } }
          if (it.closed && pts.length > 2) { const a = pts[pts.length - 1], b = pts[0]; if (Math.abs(a.d) <= SLAB_MM && Math.abs(b.d) <= SLAB_MM) { g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); } }
          g.stroke();
        } else if (it.kind === "text") {
          const p = proj(it.ras); g.fillStyle = rgba(it.color); g.fillText(it.text, p.x, p.y);
        }
      }
    }
    // ── slice intersection lines: where every OTHER slice plane cuts THIS plane (Slicer's coloured localizers) ──
    if (sliceIntersections) {
      const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const scl = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
      const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      const normalOf = (cc: SliceCell): Vec3 => cc.plane?.basis ? cc.plane.basis.nDir : cc.orientKey === "axial" ? [0, 0, 1] : cc.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
      const nc = normalOf(c), dc = c.plane.posMm;
      for (const o of cells.values()) {
        if (o === c || o.el.style.display === "none" || !o.plane) continue;
        const no = normalOf(o), doff = o.plane.posMm;
        const dir = crossV(nc, no), dd = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
        if (dd < 1e-9) continue;                                    // parallel planes: no intersection line
        // a point on both planes: p0 = (dc (no×dir) + doff (dir×nc)) / |dir|^2  (standard two-plane intersection)
        const p0 = scl(add3(scl(crossV(no, dir), dc), scl(crossV(dir, nc), doff)), 1 / dd);
        const L = 1e4;
        const a = proj(add3(p0, scl(dir, L))), b = proj(add3(p0, scl(dir, -L)));
        // A grabbed or hovered line is drawn brighter and thicker, with a soft halo: with three thin
        // colored lines on a gray slice there is otherwise nothing to say the press landed, or which
        // of them it landed on. Ron: "It would be nice to have some visual indication that the grab
        // has happened. Make the line brighter?"
        const hot = lineActive(c, o.name);
        g.strokeStyle = (CELL_COLORS[o.name] ?? cssToken("--sl-fg-muted", "#b4b4b4"));
        if (hot) {
          g.globalAlpha = 0.35; g.lineWidth = 6 * dpr;
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();   // halo
        }
        g.globalAlpha = hot ? 1 : 0.85; g.lineWidth = (hot ? 2.5 : 1.5) * dpr;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.globalAlpha = 1;
      }
    }

    // ── slice-view chrome: orientation marker, ruler, corner annotations (DataProbe's SliceViewAnnotations) ──
    const chrome = c.plane.chrome;
    if (chrome?.orientationMarkerType) drawOrientationMarker(g, ov.width, ov.height, (p) => { const o = c.slice.rasToView(c.orientKey, off, [0, 0, 0], aspect); const q = c.slice.rasToView(c.orientKey, off, p, aspect); return { dx: (q.u - o.u) * ov.width, dy: (q.v - o.v) * ov.height }; }, 10);
    if (chrome?.rulerType) {
      const f = c.slice.mirrorFrame(c.orientKey, aspect);          // mm across the view width
      const mmPerPx = f.fovX / (ov.width / dpr);
      const steps = [1, 2, 5, 10, 20, 50, 100, 200]; const targetPx = (ov.width / dpr) * 0.25;
      const mm = steps.reduce((best, sMm) => Math.abs(sMm / mmPerPx - targetPx) < Math.abs(best / mmPerPx - targetPx) ? sMm : best, steps[0]);
      const px = (mm / mmPerPx) * dpr, x0 = ov.width / 2 - px / 2, y = ov.height - 14 * dpr;
      g.strokeStyle = VIEW_INK; g.lineWidth = (chrome.rulerType === 2 ? 3 : 1.5) * dpr; g.beginPath();
      g.moveTo(x0, y); g.lineTo(x0 + px, y); g.moveTo(x0, y - 5 * dpr); g.lineTo(x0, y + 5 * dpr); g.moveTo(x0 + px, y - 5 * dpr); g.lineTo(x0 + px, y + 5 * dpr); g.stroke();
      g.fillStyle = VIEW_INK; g.font = `${10 * dpr}px system-ui`; g.textAlign = "center"; g.textBaseline = "bottom"; g.fillText(mm >= 10 ? `${mm / 10} cm` : `${mm} mm`, x0 + px / 2, y - 3 * dpr);
    }
    {   // corner annotations: background/foreground names (top-left), offset + W/L (bottom-left)
      const L = c.layers; const bgName = L?.background ? imageName(L.background.field) : (volumeField ? "volume" : "");
      g.font = `${11 * dpr}px system-ui`; g.textAlign = "left"; g.textBaseline = "top"; g.fillStyle = ink(0.85);
      let y = 22 * dpr;
      if (bgName) { g.fillText("B: " + bgName, 6 * dpr, y); y += 13 * dpr; }
      if (L?.foreground) { g.fillText("F: " + imageName(L.foreground.field), 6 * dpr, y); y += 13 * dpr; }
      if (L?.label) { g.fillText("L: " + imageName(L.label.field), 6 * dpr, y); }
      g.textBaseline = "bottom";
      // A color background (fields.ts ImageFieldOpts.rgb24) has no window/level: it is drawn as its colors.
      const wl = L?.background?.field?.rgb ? "color" : L?.background ? `W:${L.background.win.toFixed(0)} L:${L.background.lev.toFixed(0)}` : legacyWL ? `W:${legacyWL.win.toFixed(0)} L:${legacyWL.lev.toFixed(0)}` : "";
      g.fillText(`${c.plane.orient === "axial" ? "S" : c.plane.orient === "coronal" ? "A" : "R"}: ${c.plane.posMm.toFixed(1)} mm  ${wl}`, 6 * dpr, ov.height - 6 * dpr);
      // The probe readout used to be drawn here, bottom right. Ron: "Probe location should be changed
      // to a box at the bottom of the module space." It could only ever show one line in a corner,
      // and with two segmentations there is more than one thing to say -- so it moved to a panel
      // that has room for a row per dataset. Slicer puts its Data Probe in the same place.
    }
    // ── segment editor feedback: brush circle at the cursor + the stroke being painted (until the labelmap echo lands) ──
    if (brushEffect() && (brushCursor?.cell === c || brushStroke?.cell === c)) {
      const f = c.slice.mirrorFrame(c.orientKey, aspect); const pxPerMm = ov.width / f.fovX;
      const rPx = (brushDiameterMm() / 2) * pxPerMm;
      const col = withAlpha(brushEffect() === "remove" ? cssToken("--sl-brush-remove", "rgb(255,80,80)") : cssToken("--sl-brush-add", "rgb(255,255,80)"), 0.9);
      if (brushStroke?.cell === c && brushStroke.points.length) {
        g.strokeStyle = withAlpha(brushEffect() === "remove" ? cssToken("--sl-brush-remove", "rgb(255,80,80)") : cssToken("--sl-brush-add", "rgb(255,255,80)"), 0.35); g.lineWidth = rPx * 2; g.lineCap = "round"; g.lineJoin = "round"; g.beginPath();
        brushStroke.points.forEach((p, i) => { const q = proj(p); if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y); });
        if (brushStroke.points.length === 1) { const q = proj(brushStroke.points[0]); g.lineTo(q.x + 0.01, q.y); }
        g.stroke(); g.lineCap = "butt"; g.lineJoin = "miter";
      }
      if (brushCursor?.cell === c) { const q = proj(brushCursor.ras); g.strokeStyle = col; g.lineWidth = 1.5 * dpr; g.beginPath(); g.arc(q.x, q.y, rPx, 0, Math.PI * 2); g.stroke(); }
    }
    const ch = stateNode("crosshair");
    if (ch && (ch.mode as number) && ch.crosshairRAS) {           // full-view cross lines (Slicer's crosshair modes)
      const p = proj(ch.crosshairRAS as Vec3);
      g.strokeStyle = withAlpha(cssToken("--sl-brush-add", "rgb(255,255,80)"), 0.8); g.lineWidth = ((ch.thickness as number) || 1) * dpr; g.beginPath();
      g.moveTo(0, p.y); g.lineTo(ov.width, p.y); g.moveTo(p.x, 0); g.lineTo(p.x, ov.height); g.stroke();
    }
  };
  /** Say WHY a cell is empty, in the cell. Every reason -- switched off, never assigned, still
   *  streaming, pointing at a deleted volume -- used to render as the same dark rectangle, and every
   *  one of them reached me as "the slices don't work". Ron, after one click on a linked R/Y/G
   *  toggle blanked all three views: "did you notice that there were no cross sections?" */
  const drawSuppressedNote = (c: SliceCell, note: string) => {
    const g = c.overlay?.getContext("2d");
    if (!g) return;
    const dpr = globalThis.devicePixelRatio || 1;
    g.font = `${11 * dpr}px system-ui`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = ink(0.45);
    g.fillText(note, c.overlay.width / 2, c.overlay.height / 2);
  };
  const paintSlice = (c: SliceCell) => {
    if (c.el.style.display === "none") return;
    if (!bgField(c) || !c.plane) {
      clearCanvas(c.ctx); drawOverlay(c);
      if (c.layers?.emptyReason) drawSuppressedNote(c, c.layers.emptyReason);
      cfg.onFrame?.(); return;                                                  // an empty cell still renders a frame
    }
    applyLayers(c);
    applyPlane(c);
    // A RECORD OF WHAT EACH PAINT DREW, when a test or a diagnosis asks for it (__paintLog(true)): the cell, its
    // orientation key, the plane's position and the offset the renderer was given.
    const paintRec = { cell: c.name, t: Math.round(performance.now()), orient: c.orientKey, posMm: +c.plane.posMm.toFixed(2), off01: +planeOffset01(c).toFixed(4), basis: !!c.plane.basis };
    if (paintLog) paintLog.push(paintRec);
    if (sliderDrag) sliderDrag.paints.push({ ...paintRec, asked: sliderDrag.cell === c.name ? sliderDrag.last : NaN });
    const target = c.ctx.getCurrentTexture().createView({ format: srgb });
    c.slice.renderToView(target, c.canvas.width, c.canvas.height);
    drawExtraOverlays(c.slice, target, c.canvas.width, c.canvas.height);
    // The slice in 3D follows the 2D composite from HERE, the one place a cell is drawn -- so
    // scrolling, window/level, a palette change, a segmentation edit and a layer change all reach it
    // without a list of triggers to keep current. Only cells actually shown in 3D pay for it.
    // A refresh, not a kick: a sequence step redraws the slices too, and a kick here made every step a low-resolution
    // 3D frame. A dragged slider is a lasting stream of refreshes, which the loop still draws as moving (accum-loop.ts).
    if (sliceIn3D.has(c.name)) { renderSliceIn3D(c.name); a3d.refresh(); }
    drawOverlay(c);
    cfg.onFrame?.();                                   // slice frames count as frames (tests' settle/ready signal)
    for (const l of sliceChangeListeners) l();
  };
  // EACH SLICE VIEW DRAWN AT MOST ONCE PER SCREEN REFRESH (Steve's scheduler, render/slice-scheduler.ts, origin/main
  // 9a87238). A change MARKS the view; one loop draws every marked view once per frame and sleeps when none is.
  // Drawing on the spot, one wheel step redrew a view two or three times and the slice in 3D again (code review
  // 2026-09-24, A13). Ron asked for Steve's speedups from the start ("down the road, we will have to deal with
  // heavier loads"). WITHOUT Steve's moving mode (idleGapMs 0): every draw is at full resolution, so a still
  // change never shows soft-then-sharp, which Ron rejected in 3D on 2026-09-20.
  const sched = mountSliceScheduler({
    listCells: () => [...cells.keys()],
    drawSlice: (cell) => { const c = cells.get(cell); if (c) paintSlice(c); },
    drawOverlay: (cell) => { const c = cells.get(cell); if (c) drawOverlay(c); },
    idleGapMs: 0,
    // A HIDDEN WINDOW GETS NO SCREEN REFRESH (requestAnimationFrame stops), so marked views would wait until it is
    // shown again; a timer draws them meanwhile, as the old on-the-spot drawing did (a minimized window keeps its
    // study, 2026-09-16; a picture or a probe may be asked of it).
    // And a frame asked for just before the window hid never comes; a fallback timer runs it anyway, once (the
    // first of the two to fire wins) -- otherwise the scheduler waited, marked busy, until the window was shown
    // (critic, 2026-09-24, steve-merge finding 5).
    schedule: (fn) => {
      if (document.visibilityState === "hidden") { setTimeout(fn, 16); return; }
      let ran = false;
      const once = () => { if (ran) return; ran = true; fn(); };
      requestAnimationFrame(once);
      setTimeout(once, 250);
    },
  });
  const renderSlice = (c: SliceCell) => sched.markSlice(c.name);
  const renderSlices = () => sched.markAll();
  const resizeAll = () => { sizeCanvas(three.canvas); for (const c of cells.values()) sizeCanvas(c.canvas); };

  // ── MirrorView ──
  const crosshairOverlay = () => {
    const ch = stateNode("crosshair");
    const mode = (ch?.mode as number) ?? 0, ras = ch?.crosshairRAS as Vec3 | undefined;
    if (!mode || !ras) { overlays.delete("crosshair"); return; }
    // Slicer draws the crosshair through crosshairRAS as lines spanning the view; two long polylines per
    // cell in the plane's own axes are what the projection produces. Represent as an in-plane cross of
    // 1e4 mm arms along the cell basis — drawn per cell in drawOverlay via the "cross" hint.
    overlays.set("crosshair", [{ kind: "point", ras, color: [1, 1, 0.3, 1], radiusPx: 3, label: "" }]);
  };
  const view: MirrorView & { setViewState?: (st: ViewState) => void } = {
    setViewState(_st) { crosshairOverlay(); for (const c of cells.values()) drawOverlay(c); },
    setOverlay(_cell, layer, items) { if (items.length) overlays.set(layer, items); else overlays.delete(layer); for (const c of cells.values()) drawOverlay(c); },
    setField(k, f) { fields3d.set(k, f); applyShade(); rebuild3d(); },
    removeField(k) { if (fields3d.delete(k)) rebuild3d(); },
    segments3DDrawnByVolume(segId?: string) { return segId ? colorizedSegs.has(segId) : colorizedSegs.size > 0; },
    segmentColoredByVolumeRendering(segId: string) { return vrColoredSegs.has(segId); },
    onSegments3DChanged(cb: () => void) { seg3DListeners.add(cb); return () => seg3DListeners.delete(cb); },
    redraw() { scene?.syncUniforms(); a3d.refresh(); },
    setCamera(c: CameraState) {
      if (cam3d.action !== "none") return;
      // A POSE THAT ARRIVES FROM THE MODEL AND DIFFERS FROM THE VIEW'S is someone's framing -- a
      // saved scene's camera, a peer's -- and is kept the way a drag is: no arrival re-frames
      // over it. An echo of this view's own pose (the node written by a drag) changes nothing.
      const moved = [0, 1, 2].some((i) => Math.abs(c.position[i] - camera.position[i]) > 1e-3 || Math.abs(c.focalPoint[i] - camera.focalPoint[i]) > 1e-3);
      const before = JSON.stringify([camera.viewUp, camera.viewAngle, camera.parallelProjection, camera.parallelScale]);
      if (moved) userMovedCamera = true;
      camera.position = c.position as Vec3; camera.focalPoint = c.focalPoint as Vec3; camera.viewUp = c.viewUp as Vec3;
      if (c.viewAngle) camera.viewAngle = c.viewAngle;
      const cc = c as CameraState & { parallelProjection?: boolean; parallelScale?: number };
      if (typeof cc.parallelProjection === "boolean") camera.parallelProjection = cc.parallelProjection;
      if (typeof cc.parallelScale === "number" && cc.parallelScale > 0) camera.parallelScale = cc.parallelScale;
      // AN ECHO OF THIS VIEW'S OWN POSE DRAWS NOTHING. The node written after a drag comes back here (the scene
      // re-delivers every write), and drawing again started the settle over: a second soft-then-sharp step just
      // after the release (code review 2026-09-24, A15). A projection change still draws.
      if (!moved && JSON.stringify([camera.viewUp, camera.viewAngle, camera.parallelProjection, camera.parallelScale]) === before) return;
      a3d.refresh();
    },
    setClipBox(lo, hi) { clip = lo ? { lo, hi: hi! } : null; if (scene) { if (clip) scene.setClipBox(clip.lo, clip.hi); else scene.setClipPlanes([]); } a3d.refresh(); },
    setSliceLayers(cell, layers) {
      const c = sliceCell(cell); c.layers = layers;
      for (const l of [layers.background, layers.foreground, layers.label]) {
        if (l && !fieldNames.has(l.field)) fieldNames.set(l.field, (l as { name?: string }).name ?? "");
        const id = (l as { id?: string } | undefined)?.id;
        if (l && id && !fieldIds.has(l.field)) fieldIds.set(l.field, id);
      }
      // A DIFFERENT volume in the background means the frame that was showing the old one is
      // meaningless: its offset and field of view are in the old volume's extent. Deleting the
      // volume a composite was showing re-points it at another (logic/ingest removeVolumeFromScene),
      // and without this the cells came back with the deleted volume's framing -- slices that are
      // "working" but mostly black, which is barely better than the blank ones.
      //
      // Keyed on the NODE ID, not the field object: a transform re-places a volume and builds a new
      // field for the same image, and re-framing on that would throw away the user's pan every time
      // they nudged a transform. Absent -> present (an unhidden view) is not a change of volume
      // either, so unhiding leaves the frame alone.
      //
      // The next frame of a SEQUENCE is not a different volume either: the frames share one
      // geometry, and re-framing on every step threw away whatever plane the user had set --
      // Ron: "When I tried [the short axis], it reset when the sequence was running."
      const bgId = layers.background?.id;
      if (bgId && c.bgId && bgId !== c.bgId && !sameSequence(bgId, c.bgId)) { c.bgId = bgId; fitCell(cell); restageSlicesIn3D(); return; }
      if (bgId) c.bgId = bgId;
      renderSlice(c);
    },
    setViewChrome(ch) {
      chrome3d = ch;
      // The node's own fields for the drawing look and the lighting (a restored scene, or a peer
      // that carries them): applied here so what the node says is what the view does; the ⋮ panel
      // reads the same state when it opens.
      // The shading version a restored scene was saved with (render/shading-versions.ts); a scene without one keeps the window's.
      if (typeof ch.shadingVersion === "number" && ch.shadingVersion !== shadingVersion()) setShadingVersion(ch.shadingVersion);
      if (typeof ch.drawingLook === "boolean" && ch.drawingLook !== (view3dOpts.drawing !== false)) {
        view3dOpts.drawing = ch.drawingLook; scene?.setDrawingLook?.(ch.drawingLook); scene?.resetAccumulation?.();
      }
      if (typeof ch.lighting === "string") {
        const p = LIGHT_PRESETS.find((l) => l.name === ch.lighting);
        // A preset by name; otherwise the node's own four numbers (a saved "custom" lighting).
        const want = p?.shade ?? (Array.isArray(ch.shade) && ch.shade.length === 4 ? ch.shade : undefined);
        if (want && (!view3dOpts.shade || want.some((v, i) => Math.abs(v - view3dOpts.shade![i]) > 1e-6))) { view3dOpts.shade = [...want] as [number, number, number, number]; applyShade(true); }
      }
      for (const f of panelRepaints) f();
      // The view node carries BOTH gradient stops and, per VTK, backgroundColor is the BOTTOM and
      // backgroundColor2 the TOP. Pushing only the first through the flat setter collapsed the
      // gradient to a single color.
      if (scene) scene.setBackgroundGradient?.(rgbOf(ch.backgroundColor2), rgbOf(ch.backgroundColor));
      if (syncSceneBox()) rebuild3d(); else { drawThreeOverlay(); a3d.refresh(); }
    },
    setMeshes(list) { meshGroups.set("models", list); pushMeshes(); },
    setMeshGroup(key, list) { if (list.length) meshGroups.set(key, list); else meshGroups.delete(key); pushMeshes(); },
    setVolume3D(imageId, vol) {
      if (vol?.drawsSegs && view3dOpts.shade) (vol.field as { setShade?: (s: [number, number, number, number]) => void }).setShade?.(view3dOpts.shade);
      if (vol) vol3d.set(imageId, vol); else if (!vol3d.delete(imageId)) return;
      rebuild3d();
    },
    // One rebuild for a frame step: the leaving frame and the arriving one change places without
    // an empty view in between (which would throw every resident surface off the GPU).
    swapVolume3D(prevId, imageId, vol) {
      vol3d.delete(prevId);
      if (vol) vol3d.set(imageId, vol); else vol3d.delete(imageId);
      rebuild3d();
    },
    setVolumeField(f, wl) {
      volumeField = f; legacyWL = wl;
      renderSlices(); rebuild3d();
    },
    // The cell's orientation key FOLLOWS the plane it is given. applyPlane draws with c.orientKey, which only the
    // orientation menu's paths set; a scene putting a coronal view back over a heart plane (key "axial", the four-
    // chamber's nearest axis) changed the node and left the view drawing axial (Ron, 2026-09-24 17:06).
    setSlicePlane(cell, pl) { const c = sliceCell(cell); c.plane = pl; c.orientKey = pl.orient; renderSlice(c); },
    setLayout(_name) { /* the app's layout engine places cells (setCells) */ },
    setSegmentationOverlay(tex, fillOpacity, outlineOpacity) {
      segOverlay = tex; segFill = fillOpacity; segOutline = outlineOpacity;
      segLabels = null; segPaletteTex = null;      // the two forms are exclusive
      renderSlices();
    },
    setSegmentationLabelOverlay(labels, palette, fillOpacity, outlineOpacity) {
      segLabels = labels; segPaletteTex = palette; segFill = fillOpacity; segOutline = outlineOpacity;
      segOverlay = null; segOverlays = [];
      renderSlices();
    },
    setSegmentationLabelOverlays(list) {
      segOverlays = list.slice();                          // ALL of them; the renderer takes them two at a time
      segLabels = segOverlays[0]?.labels ?? null;
      segPaletteTex = segOverlays[0]?.palette ?? null;
      if (segOverlays.length) segOverlay = null;
      renderSlices();
      return segOverlays.length;
    },
  };

  const markupsDM = new MarkupsDisplayableManager();
  const segDM = new SegmentationDisplayableManager(gpu.device, 1.5);   // named, so the save can ask it for surfaces
  const vrDM = new VolumeRenderingDisplayableManager(gpu.device);      // named, so the preset picker can ask it for LUTs
  const volDM = new VolumeLayersDisplayableManager(gpu.device);        // named, so the memory report can ask what it keeps
  const moduleRegistry = new ModuleRegistryDisplayableManager();   // S11: union of every peer's `module` nodes
  const live = new LiveScene(cfg.httpBase, [
    new LayoutDisplayableManager(), new CameraDisplayableManager(), vrDM, volDM,
    new SliceDisplayableManager(), segDM, markupsDM, new RoiCropDisplayableManager(),
    viewStateDM, new TransformDisplayableManager(), new ModelDisplayableManager(), new ThreeDViewDisplayableManager(), moduleRegistry,
    new TerminologyDisplayableManager(), new SequenceDisplayableManager(),
  ]);
  live.view = view;
  // THE DEFAULT 3D LOOK ON LOAD (Ron, 2026-09-23: "solid colored volume, but keep the surfaces"): the first
  // time a segmentation arrives on a volume whose look was never chosen (nor saved with its scene), the
  // volume goes to Colored -- its segmentations solid, its own rendering off. Chosen or saved looks stay.
  {
    const segSeen = new Set<string>();
    live.subscribe((c) => {
      if (c.kind === "reset") { segSeen.clear(); return; }
      if (c.type !== "segmentation" || c.kind !== "upsert" || segSeen.has(c.id)) return;
      segSeen.add(c.id);
      const src = ((live.nodes.get(c.id)?.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
      const img = src ? live.nodes.get(src) : undefined;
      if (!img || img.type !== "image" || img.look3D !== undefined) return;
      queueMicrotask(() => { if (live.nodes.get(src!)?.look3D === undefined) setLook3D(live, src!, "solid"); });
    });
  }
  const hub = (cfg.peers?.length ?? 0) > 0;
  const sync = new LiveSync(live, new WsTransport(cfg.wsUrl), { peerId: "app", relay: hub });
  // Additional ModuleServers (registry entries): the page is the hub — each peer gets everything that
  // did not originate from it, as put/del. Other servers' outputs arrive as ordinary nodes.
  const peers: LiveSync[] = (cfg.peers ?? []).map((url, i) => new LiveSync(live, new WsTransport(url), { peerId: "peer" + (i + 1), relay: true }));
  sync.onStatus = (s) => cfg.onStatus?.(s.state === "connected" ? "mirroring Slicer" : s.state === "connecting" ? "connecting…" : "connection lost — retrying");

  // ── local interaction → ops (the app follows) ──
  const nodeIdFor = (pred: (n: Record<string, unknown>) => boolean): string | null => {
    for (const [id, n] of (live as unknown as { nodes: Map<string, Record<string, unknown>> }).nodes) if (pred(n)) return id;
    return null;
  };
  const cam3d = new CameraInteractor(camera, () => { a3d.draw(); pushCamera(); });
  /**
   * THE CAMERA IS A NODE. Standalone, no camera node ever existed: the pose lived in the renderer
   * alone, and "save the scene" had nothing to save (the critic on the scene review, 2026-09-19,
   * finding 19; SCENE-DESIGN §4). Now the window makes one at start (`local-camera-3d`; a peer's
   * camera, when one arrives, takes over as before) and every change of pose is written to it as
   * DATA -- all six fields, not the three the old `setCameraPose` command carried -- so a scene
   * writer reads the pose off the node like anything else. Throttled: the interactor calls this
   * on every mouse move, and a scene write per move would rebuild every panel that listens; the
   * node gets the pose at most every 200 ms and once more when the moves stop. The write DOES come back
   * (the scene re-delivers every write to the camera manager); view.setCamera ignores it during a drag
   * and draws nothing for a pose equal to the view's own.
   */
  const cameraPose = () => ({
    position: [...camera.position], focalPoint: [...camera.focalPoint], viewUp: [...camera.viewUp], viewAngle: camera.viewAngle,
    parallelProjection: !!camera.parallelProjection, parallelScale: camera.parallelScale,
  });
  let cameraPushTimer: number | null = null, cameraPushedAt = 0;
  const writeCameraNow = () => {
    const id = nodeIdFor((n) => n.type === "camera");
    if (!id) return;
    const node = live.nodes.get(id);
    if (!node) return;
    const pose = cameraPose();
    // Unchanged pose, no write: a fit, a reset and the interactor all call this freely.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (same(node.position, pose.position) && same(node.focalPoint, pose.focalPoint) && same(node.viewUp, pose.viewUp) && node.viewAngle === pose.viewAngle && node.parallelProjection === pose.parallelProjection && node.parallelScale === pose.parallelScale) return;
    live.write({ op: "put", id, node: { ...node, ...pose } });
    cameraPushedAt = performance.now();
  };
  const pushCamera = () => {
    if (cameraPushTimer !== null) return;                    // a write is already due
    const wait = Math.max(0, 200 - (performance.now() - cameraPushedAt));
    cameraPushTimer = setTimeout(() => { cameraPushTimer = null; writeCameraNow(); }, wait);
  };
  /**
   * THE 3D VIEW IS A NODE TOO (`nativeView-3D`, kind "3d"): the drawing look, the bounding box,
   * the axis labels, the orientation marker and the lighting preset -- what the ⋮ panel holds --
   * written as data whenever one of them changes, so a scene writer finds them on a node and a
   * scene loader can put them back (SCENE-DESIGN §4). The 3D view manager reacts to the node being
   * added by setting the chrome from it, with the same values it already has, so adding it changes
   * nothing on screen.
   */
  const view3dNodeId = "nativeView-3D";
  const view3dState = () => ({
    drawingLook: view3dOpts.drawing !== false,
    shadingVersion: shadingVersion(),               // render/shading-versions.ts: the version this view is shaded with
    boxVisible: view3dOpts.box ?? chrome3d?.boxVisible ?? false,
    axisLabelsVisible: view3dOpts.labels ?? chrome3d?.axisLabelsVisible ?? false,
    orientationMarkerType: (view3dOpts.marker ?? ((chrome3d?.orientationMarkerType ?? 0) > 0)) ? 1 : 0,
    lighting: view3dOpts.shade ? (LIGHT_PRESETS.find((p) => p.shade.every((v, i) => Math.abs(v - view3dOpts.shade![i]) < 1e-6))?.name ?? "custom") : LIGHT_PRESETS[DEFAULT_LIGHT].name,
    shade: view3dOpts.shade ? [...view3dOpts.shade] : undefined,
  });
  const syncView3dNode = () => {
    const existing = live.nodes.get(view3dNodeId);
    const node = { type: "view", id: view3dNodeId, kind: "3d", name: "3D", layoutName: "3D", ...(existing ?? {}), ...view3dState(), refs: { camera: ["local-camera-3d"] }, source: { local: true } };
    if (existing && JSON.stringify(existing) === JSON.stringify(node)) return;
    live.write({ op: "put", id: view3dNodeId, node });
  };
  // A NEW SHADING VERSION (Settings › 3D view, or a restored scene) goes onto the view's node at once, so the scene
  // saved next records the version on screen; and the view is drawn again with it.
  onShadingVersion(() => { if (live.nodes.get(view3dNodeId)) syncView3dNode(); a3d.refresh(); });
  const ensureCameraNode = () => {
    if (nodeIdFor((n) => n.type === "camera")) return;
    live.write({ op: "put", id: "local-camera-3d", node: { type: "camera", id: "local-camera-3d", name: "3D camera", ...cameraPose(), source: { local: true } } });
  };
  // 3D standard anatomical views (Slicer's reset-to-view: look from R/A/S/L/P/I toward the volume centre) + ortho
  /**
   * The union AABB of everything the 3D view draws -- fields AND MESHES -- or null if it draws nothing.
   *
   * MESHES WERE MISSING, and that is not a detail: a segmentation shown as extracted surfaces is a
   * mesh group, not a field, so with the grayscale switched off in 3D the view's own content counted
   * for nothing. "Center and fit" then framed whatever field was left -- and the R/A/S/L/P/I buttons,
   * which derived their distance from the same radius, put the camera somewhere unrelated to what was
   * on screen. It is the same failure the comment below already records for volumes ("it framed the
   * CT and left the actual content a speck at the edge"), one representation later.
   */
  const sceneBounds = (): [Vec3, Vec3] | null => {
    let lo: Vec3 | null = null, hi: Vec3 | null = null;
    const add = (a: Vec3, b: Vec3) => {
      if (![...a, ...b].every(Number.isFinite)) return;
      if (!lo) { lo = [...a] as Vec3; hi = [...b] as Vec3; return; }
      for (let i = 0; i < 3; i++) { lo![i] = Math.min(lo![i], a[i]); hi![i] = Math.max(hi![i], b[i]); }
    };
    // AN EMPTY GLYPH FIELD IS NOT CONTENT. A FiducialField with no points answers aabb() with a
    // unit box at the origin (it has to answer something for the ray entry), and that box was in
    // the union: a coronary volume at S 1628..1788 got a scene box reaching down to S -1, and the
    // camera fitted to the whole of that -- the volume a small square in the middle of the view.
    const field = (f: { aabb?(): [Vec3, Vec3]; count?: number } | null | undefined) => {
      if (!f?.aabb || f.count === 0) return;
      const [a, b] = f.aabb(); add(a, b);
    };
    // WHAT IS DRAWN, which is not the same as what is registered. `rebuild3d` drops a segmentation's
    // own field when a volume is colorizing it -- otherwise the two draw the same voxels twice -- and
    // this counted the dropped one anyway. A field's AABB is the whole labelmap; the box is meant to
    // be around what you can see. Same predicate as rebuild3d, so the two cannot drift.
    const colorized = new Set<string>();
    for (const v of vol3d.values()) {
      if (v.colorizedSeg) colorized.add(v.colorizedSeg);
      for (const id of v.drawsSegs ?? []) colorized.add(id);     // the solid look's merged segmentations
    }
    for (const v of vol3d.values()) field(v.field);
    // Widgets are not content: a crop box or the scene box itself must not set the scene's size.
    const widget = (k: string) => k === SCENE_BOX_KEY || k.startsWith("roi:") || k.startsWith("roiHandles:");
    for (const [k, f] of fields3d) if (!widget(k) && !(k.startsWith("seg:") && colorized.has(k.slice(4)))) field(f);
    if (meshBounds) add(meshBounds[0], meshBounds[1]);
    // The slice fallback only when the 3D view is genuinely empty; fitting to nothing would leave the
    // camera wherever it happened to be.
    if (!lo) { if (volumeField) field(volumeField); else for (const c of cells.values()) field(bgField(c)); }
    return lo && hi ? [lo, hi] : null;
  };

  /**
   * THE BOUNDING BOX IS IN THE SCENE, NOT ON TOP OF IT.
   *
   * It was twelve lines on the 2D overlay canvas, which has no depth: every edge drew over the
   * anatomy, including the ones behind it. The crop box beside it is a RoiBoxField, ray-marched in
   * the same pass as the volume, and Ron put the two side by side: "the bounding box in the 3d
   * viewer has still not been corrected. For comparison the crop box which has proper obstruction."
   * So the box is the same kind of field, thinner and in the view's ink, with no handles. It
   * follows the scene bounds and is added or removed as the toggle and the contents change.
   *
   * Returns true when the field set changed, so a caller outside rebuild3d knows to rebuild;
   * a size change alone is a uniform update.
   */
  const SCENE_BOX_KEY = "sceneBox";
  let sceneBox: { field: RoiBoxField; bar: number } | null = null;
  const syncSceneBox = (): boolean => {
    const want = (view3dOpts.box ?? chrome3d?.boxVisible ?? false) && threeVisible;
    // Around CONTENT only. sceneBounds falls back to the slice volumes when the 3D view is empty
    // (for the camera); a box around nothing would make "nothing shown in 3D" a lie.
    const widgetKey = (k: string) => k === SCENE_BOX_KEY || k.startsWith("roi:") || k.startsWith("roiHandles:");
    const content = vol3d.size > 0 || meshes.some((m) => m.visible !== false) || [...fields3d.keys()].some((k) => !widgetKey(k));
    const b = want && content ? sceneBounds() : null;
    if (!b) {
      if (!sceneBox) return false;
      sceneBox = null; fields3d.delete(SCENE_BOX_KEY);
      return true;
    }
    const [lo, hi] = b;
    const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const half: Vec3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    // A hair thinner than the crop box's bars (roi-widget: diagonal x 0.012 x 0.12), so the two read
    // as reference and control when both are up.
    const bar = Math.max(0.4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.001);
    if (sceneBox && Math.abs(sceneBox.bar - bar) < sceneBox.bar * 0.25) {
      sceneBox.field.setBox(center, half);
      scene?.syncUniforms();
      return false;
    }
    const rgb = cssToken("--sl-view-ink", "#f4f2ee").replace("#", "");
    const chan = (i: number) => (rgb.length === 6 ? parseInt(rgb.slice(i, i + 2), 16) / 255 : 0.95);
    const field = new RoiBoxField(center, half, { color: [chan(0), chan(2), chan(4)], opacity: 0.8, barHalfMm: bar });
    sceneBox = { field, bar };
    fields3d.set(SCENE_BOX_KEY, field);
    return true;
  };

  /** Center and radius of what the 3D view draws. One source of truth: `sceneBounds`. */
  const volumeCenterRadius = (): { center: Vec3; radius: number } => {
    const b = sceneBounds();
    if (!b) return { center: camera.focalPoint, radius: Math.max(1, camera.distance / 2.6) };
    const [L, H] = b;
    return {
      center: [(L[0] + H[0]) / 2, (L[1] + H[1]) / 2, (L[2] + H[2]) / 2],
      radius: Math.max(1, Math.hypot(H[0] - L[0], H[1] - L[1], H[2] - L[2]) / 2),
    };
  };
  const VIEW_DIRS: Record<string, { dir: Vec3; up: Vec3 }> = {
    R: { dir: [1, 0, 0], up: [0, 0, 1] }, L: { dir: [-1, 0, 0], up: [0, 0, 1] },
    A: { dir: [0, 1, 0], up: [0, 0, 1] }, P: { dir: [0, -1, 0], up: [0, 0, 1] },
    S: { dir: [0, 0, 1], up: [0, 1, 0] }, I: { dir: [0, 0, -1], up: [0, 1, 0] },
  };
  /**
   * Look from R / A / S / L / P / I -- and change NOTHING ELSE.
   *
   * Ron: "the orientation buttons at the top don't reset the view properly. They should only change
   * the camera orientation. Instead they change both zoom and pan. The center and fit the view button
   * does not correct this."
   *
   * They did: each one re-derived the focal point and the distance from the scene bounds, so pressing
   * one re-framed as well as re-oriented -- and while the bounds ignored the meshes, "re-framed" could
   * mean putting the camera somewhere with nothing in front of it, which no amount of pressing fit
   * would undo because fit used the same bounds. Those bounds are fixed separately, in `sceneBounds`.
   *
   * Now the focal point, the distance and `parallelScale` are all left exactly as they were: the eye
   * swings to the new direction at the same range, and framing stays the fit button's job alone --
   * which is the division of labor Ron is describing.
   */
  const resetCamera3D = (which: string) => {
    const v = VIEW_DIRS[which]; if (!v) return;
    const f = camera.focalPoint;
    // A camera that has never been framed has no meaningful range yet; fall back to the scene's.
    const d = camera.distance > 1e-3 && Number.isFinite(camera.distance)
      ? camera.distance
      : volumeCenterRadius().radius * 2.6;
    camera.position = [f[0] + v.dir[0] * d, f[1] + v.dir[1] * d, f[2] + v.dir[2] * d];
    camera.viewUp = [...v.up] as Vec3; camera.orthogonalizeViewUp();
    a3d.draw(); pushCamera(); sync.flush();
  };
  /**
   * Slicer's projection toggle. `parallelScale` is the half-height of the view volume, so switching
   * on has to seed it from what is visible or the first frame is either empty or absurd.
   *
   * KEEP THE APPARENT SIZE. Seeding from the scene radius alone made the view jump, because under
   * perspective the visible half-height at the focal point is distance * tan(fov/2), which is a
   * different number. Matching that keeps the switch a change of PROJECTION rather than of zoom,
   * which is what makes the toggle legible: straight edges stop converging and nothing else moves.
   *
   * And a floor on it, because a zero scale divides to infinity in orthoZO and would silently fall
   * back to perspective through setCamera's guard -- the failure Ron already met once as "no visible
   * effect".
   */
  const setOrthographic = (on: boolean) => {
    camera.parallelProjection = on;
    if (on) {
      const fromView = camera.distance * Math.tan((camera.viewAngle * Math.PI) / 360);
      camera.parallelScale = Math.max(fromView || 0, volumeCenterRadius().radius || 0, 1e-3);
    }
    a3d.refresh();
    pushCamera();
  };

  /**
   * Center and scale on what is actually visible, KEEPING the current view direction.
   *
   * resetCamera3D snaps to an anatomical axis, which is right for the R/A/S/L/P/I buttons and wrong
   * for an automatic fit: arriving data should not also spin the view the user set.
   */
  const fitCamera3D = () => {
    const { center, radius } = volumeCenterRadius();
    let dx = camera.position[0] - camera.focalPoint[0];
    let dy = camera.position[1] - camera.focalPoint[1];
    let dz = camera.position[2] - camera.focalPoint[2];
    const len = Math.hypot(dx, dy, dz);
    // A degenerate camera (position == focal point) has no direction to preserve; look from anterior,
    // which is Slicer's default 3D orientation.
    if (len < 1e-6) { dx = 0; dy = 1; dz = 0; }
    else { dx /= len; dy /= len; dz /= len; }
    // THE DISTANCE IS TRIGONOMETRY, NOT A CONSTANT.
    //
    // This was `radius * 2.6`, and 2.6 does not fit anything in particular. To get a sphere of
    // radius R inside a perspective view of half-angle a you need R / sin(a); at vtk's default 30
    // degree view angle that is R / sin(15) = 3.86 R, so 2.6 R was a third too close and the data
    // always overflowed. Ron: "the zoom is incorrect, because I dont see the entire data."
    //
    // AND THE ASPECT MATTERS, which was missing entirely. `viewAngle` is the VERTICAL field of view,
    // so in a pane taller than it is wide -- which is exactly the 3D pane in Conventional Widescreen
    // -- the horizontal field is the narrower one and it is what the fit has to satisfy. Fitting to
    // the vertical alone is why a wide thorax ran off both sides.
    const aspect = three.canvas.height > 0 ? three.canvas.width / three.canvas.height : 1;
    const dist = fitDistance(radius, camera.viewAngle, aspect);
    camera.focalPoint = [...center] as Vec3;
    camera.position = [center[0] + dx * dist, center[1] + dy * dist, center[2] + dz * dist];
    camera.orthogonalizeViewUp();
    // Orthographic has the same problem and the same answer: parallelScale is the half-HEIGHT in
    // world units, so a pane narrower than it is tall needs it divided by the aspect or the sides
    // are cut off. That is the other half of "the orthographic toggle has no visible effect".
    camera.parallelScale = fitParallelScale(radius, aspect);
    a3d.draw(); pushCamera(); sync.flush();
  };

  /**
   * SAVE A PICTURE. Ron, 2026-09-20: "Add the Save picture entry to the 3D menu. The default is a
   * 3D view and the slice viewers at the current resolution. Under advanced: 3D view only toggle,
   * add the module panel, and different sizes." -- the screenshot Slicer has, for Albula.
   *
   * Every view is rendered OFF SCREEN at the size asked for (the 3D scene by SceneRenderer.
   * renderToRGBA, each slice by its SliceRenderer.renderToRGBA -- the same frame the view draws,
   * without the toolbars) and composed in the layout the views have on screen; each view's own
   * overlay canvas (annotations, crosshair, markups) goes on top. "Current resolution" is the
   * canvases' own pixel size; the size choice multiplies it. The module panel, when asked for, is
   * the sidebar's DOM drawn through an SVG foreignObject with the page's stylesheets inlined --
   * which a WebKit canvas may refuse to export (a tainted canvas); then the picture is saved
   * without the panel and the message says so. The PNG goes to the server's /_picture route
   * (desktop/pictures.ts), which writes it where Ron's downloads go and answers with the path.
   */
  const pictureOpts: { only3d: boolean; panel: boolean; scale: number } = { only3d: false, panel: false, scale: 1 };
  // Settings › Pictures sets these (the shipped defaults above until it does); the ⋮ panel's Advanced
  // shows them and changes them for this window.
  const pictureRepaints: (() => void)[] = [];
  (globalThis as unknown as { __setPictureDefaults?: (d: typeof pictureOpts) => void }).__setPictureDefaults = (d) => { Object.assign(pictureOpts, d); for (const f of pictureRepaints) f(); };
  const rgbaToCanvas = (rgba: Uint8Array, w: number, h: number): HTMLCanvasElement => {
    if (srgb.startsWith("bgra")) for (let i = 0; i < rgba.length; i += 4) { const b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; }
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
    return cv;
  };
  const render3dTo = async (w: number, h: number): Promise<HTMLCanvasElement | null> => {
    // An empty 3D view has no pipeline to render with ("can not find bind group in pipeline" --
    // Ron, saving before loading anything); the picture shows the empty view as the screen does.
    const sc = scene; if (!sc || nothingIn3D) return null;
    sc.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h, camera.parallelProjection ? camera.parallelScale : undefined);
    // Converged, as the settled screen is: one frame keeps the volume rendering's jitter grain.
    const rgba = await sc.renderToRGBAConverged(w, h, 16);
    // The on-screen size back: setCamera is what the next frame draws with.
    sc.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, three.canvas.width, three.canvas.height, camera.parallelProjection ? camera.parallelScale : undefined);
    return rgbaToCanvas(rgba, w, h);
  };
  const panelImage = async (px: number): Promise<HTMLCanvasElement | null> => {
    const side = document.querySelector(".sl-sidebar") as HTMLElement | null;
    if (!side || side.style.display === "none") return null;
    const r = side.getBoundingClientRect();
    let css = "";
    for (const sheet of Array.from(document.styleSheets)) {
      try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\n"; } catch { /* a sheet from another origin: skipped */ }
    }
    const clone = side.cloneNode(true) as HTMLElement;
    clone.style.width = `${r.width}px`; clone.style.height = `${r.height}px`; clone.style.overflow = "hidden";
    // The copy has to be XML: an HTML comment with "--" inside it (the panels carry a few) is not,
    // and a script has no business in a picture.
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const drop: Node[] = []; for (let n = walker.nextNode(); n; n = walker.nextNode()) drop.push(n);
    for (const n of drop) n.parentNode?.removeChild(n);
    for (const sc of Array.from(clone.querySelectorAll("script"))) sc.remove();
    const xml = new XMLSerializer().serializeToString(clone);
    // The copy has no <body>, and the page's font and color are set there: put the body's computed
    // values on the wrapper, or the panel comes out in the browser's default serif.
    const bs = getComputedStyle(document.body);
    const wrap = `background:${bs.backgroundColor};color:${bs.color};font-family:${bs.fontFamily.replace(/"/g, "'")};font-size:${bs.fontSize};line-height:${bs.lineHeight}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}"><style>${css.replace(/]]>/g, "")}</style><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${wrap}">${xml}</div></foreignObject></svg>`;
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("the panel could not be drawn")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
    const cv = document.createElement("canvas"); cv.width = Math.round(r.width * px); cv.height = Math.round(r.height * px);
    cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  };
  const savePicture = async (o: Partial<typeof pictureOpts> & { name?: string; width?: number; height?: number } = {}): Promise<{ path?: string; error?: string; note?: string }> => {
    const opts = { ...pictureOpts, ...o };
    const dpr = globalThis.devicePixelRatio || 1;
    const px = dpr * (opts.scale || 1);
    // Local time in the name, not UTC: a picture taken at 11:48 was called 09-48 (Ron, 2026-09-20).
    const d = new Date(), two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
    const name = (o.name ?? `SlicerAlbula picture ${stamp}`).replace(/\.png$/, "") + ".png";
    let out: HTMLCanvasElement;
    let note = "";
    if (opts.only3d && (o.width || o.height)) {
      // A size given outright: the 3D view alone at exactly that size (the scripting call).
      const cv = await render3dTo(o.width ?? 1600, o.height ?? o.width ?? 1600);
      if (!cv) return { error: "nothing is drawn in 3D" };
      out = cv;
    } else {
      const host = root.getBoundingClientRect();
      const shown = [...cells.values()].filter((c) => c.el.style.display !== "none");
      // The views' state as of NOW: a change may be marked and not yet drawn (the scheduler draws on the next frame).
      for (const c of shown) paintSlice(c);
      const parts: { el: HTMLElement; draw: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => Promise<void> }[] = [];
      if (threeVisible) parts.push({ el: three.el, draw: async (ctx, x, y, w, h) => {
        const cv = await render3dTo(w, h); if (cv) ctx.drawImage(cv, x, y);
        ctx.drawImage(threeOverlay, x, y, w, h);
      } });
      if (!opts.only3d) for (const c of shown) parts.push({ el: c.el, draw: async (ctx, x, y, w, h) => {
        // An empty cell has no reslicer state to draw with (renderSlice clears it instead); the
        // picture shows it as the screen does: the cell's background and its overlay.
        if (bgField(c) && c.plane) {
          // With the further segmentation pairs, as the screen draws them: the picture had only the first two
          // (code review 2026-09-24, A6).
          const rgba = await c.slice.renderToRGBA(w, h, (tv) => drawExtraOverlays(c.slice, tv, w, h));
          ctx.drawImage(rgbaToCanvas(rgba, w, h), x, y);
        } else {
          ctx.fillStyle = getComputedStyle(c.canvas).backgroundColor || "#000"; ctx.fillRect(x, y, w, h);
        }
        ctx.drawImage(c.overlay, x, y, w, h);
      } });
      if (!parts.length) { cfg.onNotify?.({ title: "Nothing to save", body: "No view is shown." }); return { error: "nothing is shown" }; }
      // The picture's frame is the union of the views it holds, in the layout they have on screen.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of parts) { const r = p.el.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
      void host;
      out = document.createElement("canvas"); out.width = Math.round((x1 - x0) * px); out.height = Math.round((y1 - y0) * px);
      const ctx = out.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(root).getPropertyValue("--sl-view-bg") || "#000"; ctx.fillRect(0, 0, out.width, out.height);
      for (const p of parts) {
        const r = p.el.getBoundingClientRect();
        const x = Math.round((r.left - x0) * px), y = Math.round((r.top - y0) * px), w = Math.round(r.width * px), h = Math.round(r.height * px);
        if (w > 0 && h > 0) await p.draw(ctx, x, y, w, h);
      }
      if (opts.panel) {
        try {
          const pcv = await panelImage(px);
          if (pcv) {
            const both = document.createElement("canvas"); both.width = pcv.width + out.width; both.height = Math.max(pcv.height, out.height);
            const bc = both.getContext("2d")!;
            bc.fillStyle = getComputedStyle(document.body).backgroundColor || "#000"; bc.fillRect(0, 0, both.width, both.height);
            bc.drawImage(pcv, 0, 0); bc.drawImage(out, pcv.width, 0);
            // A canvas that drew an SVG with HTML inside may be unexportable here; find out now.
            await new Promise<void>((res, rej) => both.toBlob((b) => b ? res() : rej(new Error("tainted")), "image/png"));
            out = both;
          }
        } catch { note = " — without the module panel, which this window cannot export"; }
      }
    }
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    if (!blob) return { error: "the picture could not be encoded" };
    const res = await fetch(`/_picture/${encodeURIComponent(name)}`, { method: "POST", body: blob });
    const r = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { path?: string; error?: string };
    if (r.path) {
      cfg.onStatus?.(`picture saved: ${r.path} (${out.width}×${out.height})${note}`);
      // Said where a person looks, not only in the status line (Ron, 2026-09-20: "With data no
      // message. Where is the data saved to?").
      const folder = r.path.replace(/\/[^/]*$/, "");
      cfg.onNotify?.({ title: `Picture saved — ${out.width}×${out.height}`, body: `${name}\nin ${folder.replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, "iCloud Drive")}${note}`,
        actions: [{ label: "Show in Finder", primary: true, onClick: () => { void fetch(`/_picture/${encodeURIComponent(name)}?reveal=1`); } }] });
    } else cfg.onNotify?.({ title: "The picture was not saved", body: r.error ?? "unknown reason" });
    return { ...r, note };
  };
  // 3D controller bar: look-from buttons (R/A/S/L/P/I) + orthographic toggle (Slicer's 3D view controller)
  {
    const bar = document.createElement("div"); bar.className = "sl-3d-bar";
    // Fit first, as in Slicer: the view is fitted automatically when data arrives, and this is the
    // button that does it again on demand -- after cropping, or once the camera has wandered.
    const fit = document.createElement("button");
    fit.textContent = "⤢"; fit.title = "Center and fit the view to the data";
    // Pressing fit says "frame it now", and also re-arms automatic framing: whatever the camera was
    // doing, the user has just asked for the default again.
    fit.addEventListener("click", () => { userMovedCamera = false; fittedBounds = sceneBounds(); fitCamera3D(); });
    bar.appendChild(fit);
    for (const k of ["R", "A", "S", "L", "P", "I"]) { const b = document.createElement("button"); b.textContent = k; b.title = `Look from ${k}`; b.addEventListener("click", () => resetCamera3D(k)); bar.appendChild(b); }
    // ORTHO STAYS, AND REJOINS THE GROUP. The stylesheet pushes the last button to the far right, so
    // this one sat alone in the corner reading as unrelated chrome -- Ron: "there is a small square at
    // the top right. Right now it seems to have no function." It has one, and it is Slicer's: the
    // projection toggle. The corner belongs to the panel instead, and this goes back with the rest.
    const ortho = document.createElement("button"); ortho.textContent = "⬚"; ortho.title = "Orthographic projection (Slicer's 3D view controller)";
    ortho.addEventListener("click", () => { const on = !camera.parallelProjection; setOrthographic(on); ortho.setAttribute("aria-pressed", String(on)); });
    bar.appendChild(ortho);
    fpsEl = document.createElement("span"); fpsEl.className = "sl-3d-fps";
    fpsEl.title = "Frames a second while the view moves; shown after the first turn of the view";
    bar.appendChild(fpsEl);

    // ── the 3D view panel: what Ron asked the corner to become ──
    // "It's an ideal pop up for a panel to set global conditions for the 3D window."
    const panel = document.createElement("div"); panel.className = "sl-3d-panel"; panel.hidden = true;
    // TWO OPENERS, one panel. Ron asked for "another button with a light symbol which toggles the
    // popup" -- the lamp says what the panel is mostly for, the gear says it holds settings, and a
    // person reaches for whichever they think in. They share one open/closed state so the pressed
    // marking never disagrees between them.
    const openers: HTMLButtonElement[] = [];
    const paintOpeners = () => { for (const b of openers) b.setAttribute("aria-pressed", String(!panel.hidden)); };
    const close = () => { panel.hidden = true; paintOpeners(); };
    const opener = (glyph: string, title: string) => {
      const b = document.createElement("button");
      b.textContent = glyph; b.title = title;
      b.addEventListener("click", () => { panel.hidden = !panel.hidden; paintOpeners(); });
      openers.push(b); return b;
    };
    // ONE BUTTON. Ron asked for a lamp when the panel held only lighting, and I added it BESIDE the
    // gear instead of instead of it -- Ron: "Why 2 buttons?" Quite. The panel now also holds the
    // bounding box, the orientation marker, the axis labels and the raw coefficients, so a lamp would
    // promise less than it opens.
    //
    // AND IT IS NOT A GEAR ANY MORE. Ron: "the cogwheel is barely recognizable, perhaps three vertical
    // dots?" It is his call and it is also the better glyph: U+2699 renders at this size as a small
    // ring of specks that reads as noise, and several systems substitute a color emoji for it. Three
    // dots are five strokes at any size, and "more here" is what this button actually means -- the
    // panel is not only settings. Vertical because the bar is horizontal.
    const gear = opener("\u22EE", "3D view settings — lighting, bounding box, orientation marker");

    // A CLOSE CONTROL, because a popup that only its opener can dismiss is a trap: Ron asked for "a
    // close function on the popup". Clicking into the view also closes it, but that is not
    // discoverable and it costs a click in the scene.
    const head = document.createElement("div"); head.className = "sl-3d-panel-head";
    head.innerHTML = `<span>3D view</span>`;
    const x = document.createElement("button");
    x.textContent = "✕"; x.title = "Close";
    x.addEventListener("click", close);
    head.appendChild(x);
    panel.appendChild(head);

    // GLOSSY IS THE DEFAULT, on Ron's instruction, and it is APPLIED rather than merely marked. The
    // first version pressed "Standard" in the interface while the renderer still held its baked-in
    // ambient 0.25 / diffuse 0.75 and NO specular -- so the panel reported a lighting model that was
    // not the one drawing. A pressed button that lies is worse than no button.
    // The table lives in render/light-presets.ts, shared with the Volume Rendering module.
    // ── THE LOOK, first: one click sets what is shown (opacities, the volume rendering), and
    // "Surfaces" puts it back. Ron, 2026-09-20: "named optional look. Not the default." What is
    // shown, not how it is lit or drawn: the lighting and the drawing look stay the person's.
    const lookRow = document.createElement("div"); lookRow.className = "sl-3d-panel-row";
    lookRow.innerHTML = `<label title="How the anatomy looks. One button goes through Illustration (an atlas illustration: matte colors, thin dark outlines), Realistic (a realistic model: shading and highlights) and Colorized volume (the anatomy see-through over the scan); the other shows the vessel networks inside their organs. Click a pressed button to switch it off. What is shown in 3D (the scan, the anatomy, surface models) is chosen in Scene › In 3D.">Look</label>`;
    const lookDeps = { setVolumeRendering: (id: string, on: boolean) => setVolumeRenderingOn(live, id, on), applyVrPreset: (id: string, preset: string) => { applyVrPreset(live, id, preset); } };
    // ONE BUTTON, THREE STATES, sized for its longest label so nothing jumps (Ron, 2026-09-20: "a
    // single button, sized properly so there is no jumping, to toggle between surface and
    // colorized volume", then "add another function to that button to toggle display à la Mike
    // on and off" -- the drawing look). It reads what is shown NOW; each click shows the next:
    // Drawing (opaque surfaces, drawn like an illustration) -> Surfaces (opaque, lit) ->
    // Colorized volume (see-through surfaces over a CT-Bone rendering) -> Drawing.
    const glassBtn = document.createElement("button");
    glassBtn.className = "sl-3d-look-toggle";
    const lookTip = (n: string) => LOOKS.find((l) => l.name === n)?.tip ?? "";
    const view3dNode = () => live.nodes.get(view3dNodeId);
    const setDrawing = (on: boolean) => { const v = view3dNode(); if (v && (v.drawingLook !== false) !== on) live.write({ op: "put", id: v.id, node: { ...v, drawingLook: on } }); };
    // NAMED BY WHAT IS DRAWN. It said "Surfaces" / "Drawing of surfaces" while nothing but the solid look
    // was on screen (critic, 2026-09-24, finding 10): "Lit" is the structures lit without the drawing's
    // outlines, whatever draws them -- the solid look, or surface models where they were generated.
    // Ron, 2026-09-25, on which words a doctor understands: Illustration and Realistic (were Drawing and Lit).
    type Shown = "Illustration" | "Realistic" | "Colorized volume";
    const shown = (): Shown => currentLook() === "Glass over bone" ? "Colorized volume" : (view3dOpts.drawing !== false ? "Illustration" : "Realistic");
    const paintLook = () => {
      const cur = shown();
      glassBtn.textContent = cur;
      glassBtn.title = cur === "Illustration" ? "Illustration: the anatomy as in an atlas: matte colors, a thin dark outline where one structure passes in front of another, crevices a little darker. Click for Realistic."
        : cur === "Realistic" ? "Realistic: the anatomy as a realistic model: shading and highlights, no outlines. Click for the colorized volume: the anatomy see-through over the scan."
        : `Colorized volume: ${lookTip("Glass over bone")} Click for Illustration.`;
      glassBtn.setAttribute("aria-pressed", String(cur !== "Realistic"));
      vesselsBtn.setAttribute("aria-pressed", String(currentLook() === "Vessels in context"));
    };
    // THE COLORIZED LOOK IS ASKED ABOUT WHEN IT WOULD COST THE WINDOW.
    //
    // It builds a second copy of the volume and of the labelmap on top of everything resident. Ron,
    // 2026-09-22, with a 768x768x709 CT and four whole-body segmentations: he pressed it and the
    // page was ended a minute later ("The window was reset"). The numbers are measurable before the
    // click, so the window says what it is about to cost instead of disappearing.
    const HEAVY_MB = 3000;
    const glass = () => {
      const said = applyLook(live, "Glass over bone", lookDeps);
      cfg.onStatus?.(said); paintLook(); a3d.refresh();
    };
    glassBtn.addEventListener("click", () => {
      const cur = shown();
      if (cur === "Illustration") { setDrawing(false); cfg.onStatus?.("Realistic: shading and highlights, no outlines"); paintLook(); a3d.refresh(); return; }
      if (cur !== "Realistic") { const said = applyLook(live, "Surfaces", lookDeps); setDrawing(true); cfg.onStatus?.(said && "Illustration"); paintLook(); a3d.refresh(); return; }
      const cost = colorizeCostMB(live);
      const gb = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
      if (cost.total < HEAVY_MB || !cfg.onNotify) { glass(); return; }
      cfg.onNotify({
        title: "This will need about " + gb(cost.total),
        body: `<p>The colorized volume is a second copy of the volume and of the labels (${gb(cost.colorizeMB)}), on top of the volume itself (${gb(cost.volumeMB)}) and one labelmap for each of the ${cost.segmentations} segmentations on screen (${gb(cost.labelmapsMB)}).</p>` +
          `<p>The window is ended by the system somewhere above 4 GB, and everything only in the window is lost. Hiding a segmentation you do not need, in Segmentations, takes ${gb(Math.round(cost.labelmapsMB / Math.max(1, cost.segmentations)))} off it each time.</p>`,
        actions: [
          { label: "Show it anyway", primary: true, onClick: () => glass() },
          { label: "Not now", onClick: () => {} },
        ],
      });
    });
    const vesselsBtn = document.createElement("button");
    vesselsBtn.className = "sl-3d-look-toggle";
    vesselsBtn.textContent = "Vessels in context"; vesselsBtn.title = lookTip("Vessels in context") + " Click again to switch it off.";
    vesselsBtn.addEventListener("click", () => {
      const said = applyLook(live, currentLook() === "Vessels in context" ? "Surfaces" : "Vessels in context", lookDeps);
      cfg.onStatus?.(said); paintLook(); a3d.refresh();
    });
    lookRow.append(glassBtn, vesselsBtn);
    paintLook(); panel.appendChild(lookRow);
    panelRepaints.push(paintLook);
    // A close or a new load makes the look's memory stale: back to Surfaces, nothing to put back.
    live.subscribe((c) => { if (c.kind === "reset" || (c.kind === "remove" && c.type === "segmentation")) { forgetLooks(); paintLook(); } });

    // ── ADVANCED, folded away at the bottom, made here so the rows below can file themselves in it.
    // Ron: "We can stash an 'Advanced' feature at the bottom of the box for additional controls."
    // And, 2026-09-20: "drawing look can move to advanced. Please organize advanced too and add
    // tool tips." Groups under it, each with a heading: View aids (the box, the orientation aids), Glasses,
    // Picture (what Save… leaves out). The Lighting numbers were removed with the
    // Lighting row (2026-09-25). A <details>, so the browser owns the open/closed state and the arrow.
    const adv = document.createElement("details"); adv.className = "sl-3d-adv";
    const sum = document.createElement("summary"); sum.textContent = "Advanced";
    sum.title = "Settings set once: the bounding box and the orientation aids; the head-tracking glasses; the picture's choices.";
    adv.appendChild(sum);
    // Each group under a heading, a thin line between groups (Ron: "thin horizontal lines to separate the different sections under advanced").
    const subHead = (label: string, tip: string) => { const h = document.createElement("div"); h.className = "sl-3d-panel-row sl-3d-panel-sub"; h.innerHTML = `<label title="${tip.replace(/"/g, "&quot;")}">${label}</label>`; adv.appendChild(h); };
    subHead("View aids", "What is drawn around the anatomy: the box, the orientation marker, the axis labels.");

    // NO LIGHTING CONTROL IN THIS PANEL (Ron, 2026-09-25: "yes" to dropping it completely, row and numbers). With
    // Per-tissue shading each tissue has its own gloss, and a second, global one confused ("matte is still glossy").
    // The anatomy is lit at the default preset, Glossy, the one Mike's finishes were chosen under; a scene saved with
    // another lighting still restores it (onChange above). The scan's own rendering keeps its presets in Volume
    // Rendering.
    view3dOpts.shade = [...LIGHT_PRESETS[DEFAULT_LIGHT].shade] as [number, number, number, number];
    applyShade();

    // SHADING (Ron, 2026-09-25: yes to moving it here from Settings, which keeps the default a new window starts
    // with). A choice here is for this window; a saved scene records it.
    const shadeRow = document.createElement("div"); shadeRow.className = "sl-3d-panel-row";
    shadeRow.innerHTML = `<label title="Whether each tissue takes the light its own way. Per tissue: a wet sheen on organs, satin on muscle, matte bone (Michael Halle's tissue palettes). Uniform: every structure alike. The default for a new window is in Settings › 3D view.">Shading</label>`;
    const shadeBtns = SHADINGS.map((s) => {
      const b = document.createElement("button");
      b.textContent = s.label; b.title = s.what;
      b.addEventListener("click", () => setShadingVersion(s.version));
      shadeRow.appendChild(b);
      return [s.version, b] as const;
    });
    const paintShade = () => { for (const [v, b] of shadeBtns) b.setAttribute("aria-pressed", String(v === shadingVersion())); };
    paintShade(); onShadingVersion(paintShade); panelRepaints.push(paintShade);
    panel.appendChild(shadeRow);

    // The drawing look, beside the lighting it replaces for surfaces (the presets still light the
    // volumes; a surface in the drawing look is matte whatever the preset says).
    const drawRow = document.createElement("div"); drawRow.className = "sl-3d-panel-row";
    drawRow.innerHTML = `<label title="On: the anatomy as in an atlas illustration: matte colors, a thin dark outline where one structure passes in front of another, crevices a little darker. Off: Realistic, shading and highlights. The same choice as the Look button's Illustration and Realistic.">Illustration</label>`;
    const drawBtn = document.createElement("button");
    drawBtn.title = "On: the anatomy as in an atlas illustration. Off: Realistic.";
    const paintDraw = () => { const on = view3dOpts.drawing !== false; drawBtn.textContent = on ? "on" : "off"; drawBtn.setAttribute("aria-pressed", String(on)); };
    drawBtn.addEventListener("click", () => {
      view3dOpts.drawing = view3dOpts.drawing === false;
      try { localStorage.setItem("sl-3d-drawing-look", view3dOpts.drawing ? "on" : "off"); } catch { /* private mode: not remembered */ }
      scene?.setDrawingLook?.(view3dOpts.drawing);
      scene?.resetAccumulation?.();
      paintDraw(); a3d.refresh(); syncView3dNode();
    });
    // NOT IN THE PANEL (Ron, 2026-09-20: "don't need a separate button under advanced"): the Look
    // button sets it -- Surfaces draws, Colorized volume does not -- and Settings › 3D view keeps
    // the default. The switch is built and kept off-screen so the state and its storage stay one.
    paintDraw(); drawRow.appendChild(drawBtn);
    panelRepaints.push(paintDraw);

    // (The "Solid colors (test)" switch of 2026-09-23 stood here. Its lasting place is the Scene module's
    // In 3D choice per volume -- render/look3d.ts.)

    // SAVE PICTURE: the views as they are, at their own resolution; the choices are under Advanced.
    const picRow = document.createElement("div"); picRow.className = "sl-3d-panel-row";
    picRow.innerHTML = `<label title="A PNG of the views as they are. What it includes and how large: Advanced › Picture; where it goes: Settings › Pictures.">Picture</label>`;
    const picBtn = document.createElement("button");
    picBtn.textContent = "Save…";
    picBtn.title = "Save a PNG of the views as they are, at their current resolution, in your Downloads. Advanced: the 3D view only, with the module panel, larger sizes.";
    picBtn.addEventListener("click", async () => {
      picBtn.disabled = true; picBtn.textContent = "saving…";
      try { await savePicture(); } finally { picBtn.disabled = false; picBtn.textContent = "Save…"; }
    });
    picRow.appendChild(picBtn); panel.appendChild(picRow);

    // The three chrome toggles, each reading its current effective value so the panel opens honest.
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, why: string, into: HTMLElement) => {
      const row = document.createElement("div"); row.className = "sl-3d-panel-row";
      const b = document.createElement("button");
      const paint = () => { const on = get(); b.textContent = on ? "on" : "off"; b.setAttribute("aria-pressed", String(on)); };
      b.title = why;
      b.addEventListener("click", () => { set(!get()); paint(); if (syncSceneBox()) rebuild3d(); else { drawThreeOverlay(); a3d.refresh(); } syncView3dNode(); });
      row.innerHTML = `<label>${label}</label>`;
      row.appendChild(b); paint(); into.appendChild(row);
    };
    toggle("Bounding box", () => view3dOpts.box ?? chrome3d?.boxVisible ?? false,
      (v) => { view3dOpts.box = v; }, "A box around everything in the view, the way Slicer draws it. Its numbers are at the bottom of Advanced.", adv);

    // ── IN THIS VIEW: what is drawn here, with the same 3D button the Scene module has ──
    // Ron, with the Scene rows beside the 3D view: "add something along this to the settings pop
    // up" -- and, on the mockup, 3D only: the slice buttons and the drawing order are about the
    // other views. Same rows, same order, same button as Scene (scene-order.ts, tf-editor.ts), so
    // switching a segmentation on here is the same write as switching it on there. Controls live
    // in the view you are in; this is the one place a person is when they want a structure to
    // appear or vanish in 3D.
    const inViewHead = document.createElement("div"); inViewHead.className = "sl-3d-panel-head sl-3d-inview-head";
    inViewHead.innerHTML = `<span title="The volumes and segmentations in the scene, each with its 3D button, as the Scene module lists them.">In this view</span>`;
    const inView = document.createElement("div"); inView.className = "sl-3d-inview";
    const refreshInView = () => {
      // A sequence's frames are hidden; the one on screen is listed, under the sequence's name.
      const current = currentFrames(live);
      const nodes = [...live.nodes.values()].filter((n) =>
        (!(n as { hidden?: boolean }).hidden || current.has(n.id)) &&
        ((n.type === "image" && !(n as { labelmap?: boolean }).labelmap) || n.type === "segmentation"));
      const rows = orderScene(nodes);
      inView.innerHTML = rows.length ? rows.map(({ node: n, depth }) => {
        const on = n.type === "image" ? volumeRenderingOn(live, n.id) : ((n.visible3D as boolean | undefined) ?? (n.visible !== false));
        const name = current.get(n.id) ?? String(n.name ?? n.id);
        return `<div class="sl-3d-panel-row sl-3d-inview-row${depth ? " sl-3d-inview-child" : ""}" data-id="${n.id}">` +
          `<label title="${escapeHtml(name)}">${escapeHtml(name)}</label>` +
          `<button class="sl-sh-view sl-sh-view-3d${on ? "" : " sl-sh-view-off"}" data-view3d title="${on ? "Shown in 3D — click to hide" : "Show in 3D"}">3D</button></div>`;
      }).join("") : `<div class="sl-3d-inview-empty">nothing loaded</div>`;
      inView.querySelectorAll<HTMLButtonElement>("[data-view3d]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest("[data-id]") as HTMLElement).dataset.id!;
        const n = live.nodes.get(id);
        if (!n) return;
        if (n.type === "image") setVolumeRenderingOn(live, id, !volumeRenderingOn(live, id));
        else live.write({ op: "patch", id, path: "#/visible3D", value: !((n.visible3D as boolean | undefined) ?? (n.visible !== false)) });
        refreshInView();   // the volumeRenderingDisplay change alone would not reach the subscription below
      }));
    };
    live.subscribe((c) => {
      if (c.type === "image" || c.type === "segmentation" || c.type === "volumeRenderingDisplay" || c.type === "sequenceBrowser" || c.kind === "remove") refreshInView();
      if (c.type === "sequenceBrowser") reprobe();
      if (c.type === "segmentation" && c.kind !== "remove") cardiacDefaults();
      if (c.kind === "remove" && cardiacHeld && ![...live.nodes.values()].some((n) => n.type === "segmentation")) cardiacHeld = false;
    });
    refreshInView();
    panel.appendChild(inViewHead);
    panel.appendChild(inView);

    // The orientation aids, with the box under Drawing; then the picture's choices; then the lighting numbers.
    toggle("Orientation marker", () => view3dOpts.marker ?? ((chrome3d?.orientationMarkerType ?? 0) > 0),
      (v) => { view3dOpts.marker = v; }, "The R/A/S axes glyph, lower left", adv);
    toggle("Axis labels", () => view3dOpts.labels ?? chrome3d?.axisLabelsVisible ?? false,
      (v) => { view3dOpts.labels = v; }, "R/A/S/L/P/I on the faces of the scene bounds that face you", adv);
    // ── THE VITURE GLASSES: the 3D camera follows the head (Ron, 2026-09-25: "use pieces of domenico's code and make them
    // work with albula"). The pose comes from Contents/tools/viture/viture-pose.ts, which loads Domenico Riggio's bridge
    // from where it is (Viture's libraries may not be copied into Albula) and serves it on ws://127.0.0.1:8779. The math
    // is his Slicer script's: the head's rigid motion since the start (or Recenter), in its own frame -- x right, y up,
    // z backward, the same as a camera's -- applied to the camera as it was then; meters to mm. ──
    subHead("Glasses", "Viture glasses: the 3D view follows your head. Needs the pose helper running (Contents/tools/viture/viture-pose.ts).");
    {
      const row = document.createElement("div"); row.className = "sl-3d-panel-row";
      row.innerHTML = `<label title="The 3D camera moves as your head moves, from where it is when you start">Follow my head</label>`;
      const go = document.createElement("button"); go.type = "button"; go.textContent = "Start"; go.setAttribute("aria-pressed", "false");
      const rc = document.createElement("button"); rc.type = "button"; rc.textContent = "Recenter"; rc.title = "Take the head's position now as the start, keeping the view as it is";
      const say = document.createElement("span"); say.className = "sl-hint";
      row.append(go, rc, say); adv.appendChild(row);
      type M = number[];   // 4x4 row-major
      const mul = (a: M, b: M): M => { const r = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j]; return r; };
      const inv = (m: M): M => {   // rigid: R^T, -R^T t
        const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
        const t = [m[3], m[7], m[11]];
        const it = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])];
        return [r[0], r[1], r[2], it[0], r[3], r[4], r[5], it[1], r[6], r[7], r[8], it[2], 0, 0, 0, 1];
      };
      const poseM = (p: number[]): M => {   // [px,py,pz (m), qw,qx,qy,qz] -> head-to-start, in mm
        const [x, y, z, w, qx, qy, qz] = p; const n = Math.hypot(w, qx, qy, qz) || 1; const a = w / n, b = qx / n, c = qy / n, d = qz / n;
        return [1 - 2 * (c * c + d * d), 2 * (b * c - a * d), 2 * (b * d + a * c), x * 1000,
          2 * (b * c + a * d), 1 - 2 * (b * b + d * d), 2 * (c * d - a * b), y * 1000,
          2 * (b * d - a * c), 2 * (c * d + a * b), 1 - 2 * (b * b + c * c), z * 1000, 0, 0, 0, 1];
      };
      const nrm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
      const crs = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      let ws: WebSocket | null = null, H0inv: M | null = null, C0: M | null = null, dist0 = 0, n = 0;
      let stereoOn = () => false;
      const capture = (p: number[]) => {
        H0inv = inv(poseM(p));
        const back = nrm([camera.position[0] - camera.focalPoint[0], camera.position[1] - camera.focalPoint[1], camera.position[2] - camera.focalPoint[2]]);
        const right = nrm(crs(camera.viewUp as Vec3, back)), up = crs(back, right);
        C0 = [right[0], up[0], back[0], camera.position[0], right[1], up[1], back[1], camera.position[1], right[2], up[2], back[2], camera.position[2], 0, 0, 0, 1];
        dist0 = camera.distance;
      };
      let pending: number[] | null = null;
      // THE MOUSE AND THE HEAD TOGETHER (Ron: "can I use the mouse to turn the object?"): while the mouse turns, pans or
      // zooms, the head waits; on release the head goes on from the view the mouse left, as after Recenter.
      let mouseHeld = false;
      // A DEAD ZONE (Ron, 13:06 build: "The vessel boundaries are flickering"): the glasses report small movements even
      // lying still, so every frame moved the camera, the 3D view never settled, and it drew at its reduced "moving"
      // quality forever -- edges shimmered. A pose within 0.1 degree and 0.3 mm of the last one used is ignored; the
      // view settles to full quality while the head is still.
      let used: number[] | null = null;
      const still = (p: number[]) => {
        if (!used) return false;
        const dq = Math.abs(p[3] * used[3] + p[4] * used[4] + p[5] * used[5] + p[6] * used[6]) / ((Math.hypot(p[3], p[4], p[5], p[6]) * Math.hypot(used[3], used[4], used[5], used[6])) || 1);
        const deg = 2 * Math.acos(Math.min(1, dq)) * 180 / Math.PI;
        const mm = Math.hypot(p[0] - used[0], p[1] - used[1], p[2] - used[2]) * 1000;
        return deg < 0.1 && mm < 0.3;
      };
      const apply = () => {
        const p = pending; pending = null; if (!p) return;
        if (cam3d.action !== "none") { mouseHeld = true; return; }
        if (mouseHeld) { mouseHeld = false; H0inv = null; }
        if (H0inv && still(p)) return;
        used = p;
        if (!H0inv) capture(p);
        const m = mul(C0!, mul(H0inv!, poseM(p)));
        const pos: Vec3 = [m[3], m[7], m[11]], up: Vec3 = [m[1], m[5], m[9]], back: Vec3 = [m[2], m[6], m[10]];
        camera.position = pos; camera.viewUp = up;
        camera.focalPoint = [pos[0] - back[0] * dist0, pos[1] - back[1] * dist0, pos[2] - back[2] * dist0];
        // refresh, not draw: a head is never quite still, so draw() kept the view flipping between the reduced
        // "moving" resolution and the settled one -- the flicker. Every head frame is drawn at full resolution.
        if (!stereoOn()) a3d.refresh();
      };
      const stop = () => { ws?.close(); ws = null; H0inv = null; go.textContent = "Start"; go.setAttribute("aria-pressed", "false"); pushCamera(); sync.flush(); };
      go.addEventListener("click", () => {
        if (ws) { stop(); say.textContent = "stopped"; return; }
        n = 0; H0inv = null;
        ws = new WebSocket("ws://127.0.0.1:8779");
        go.textContent = "Stop"; go.setAttribute("aria-pressed", "true"); say.textContent = "connecting…";
        ws.onerror = () => { say.textContent = "no pose helper on this Mac — start Contents/tools/viture/viture-pose.ts"; stop(); };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data)) as { pose?: number[]; status?: string };
          if (msg.status) say.textContent = msg.status;
          if (msg.pose) { if (++n === 1) say.textContent = "following your head"; const first = !pending; pending = msg.pose; if (first) requestAnimationFrame(apply); }
        };
      });
      rc.addEventListener("click", () => { H0inv = null; say.textContent = "recentered"; });

      // ── STEREO: one picture per eye, side by side, for the glasses' 3D mode (3840 x 1080: 1920 per eye). The window
      // is covered by two canvases; each frame the scene is drawn twice, the eye cameras parallel, IPD apart (the
      // glasses' own 3D mode fuses them). Put the Albula window on the glasses (as a second screen, not mirrored), make
      // it full screen, press "Glasses 3D" to switch the glasses to side-by-side, then Start stereo. Esc ends it. The
      // field of view is the glasses', not the screen's (review finding 4): default 27 degrees vertical -- from a 52
      // degree diagonal, the figure believed to be Viture's for the Luma line, NOT verified; adjust until the world
      // holds still as the head turns. ──
      const srow = document.createElement("div"); srow.className = "sl-3d-panel-row";
      srow.innerHTML = `<label title="Two pictures side by side, one per eye, filling the window. Esc ends it.">Stereo</label>`;
      const sgo = document.createElement("button"); sgo.type = "button"; sgo.textContent = "Start stereo";
      const sbs = document.createElement("button"); sbs.type = "button"; sbs.textContent = "Glasses 3D"; sbs.title = "Switch the glasses to their side-by-side 3D mode (again: back to 2D)";
      srow.append(sgo, sbs); adv.appendChild(srow);
      const frow = document.createElement("div"); frow.className = "sl-3d-panel-row";
      frow.innerHTML = `<label title="The glasses' vertical field of view per eye. Too small and the anatomy looks too big and swims as the head turns; too large, the reverse.">Field of view</label>`;
      const fov = document.createElement("input"); fov.type = "range"; fov.min = "15"; fov.max = "50"; fov.step = "0.5"; fov.value = "27";
      const fovV = document.createElement("span"); fovV.className = "sl-hint"; fovV.textContent = "27°";
      fov.addEventListener("input", () => { fovV.textContent = `${fov.value}°`; });
      frow.append(fov, fovV); adv.appendChild(frow);
      const irow = document.createElement("div"); irow.className = "sl-3d-panel-row";
      irow.innerHTML = `<label title="The distance between the two eye cameras, in mm (a typical adult: 63). Larger makes the anatomy look smaller and nearer.">Eye distance</label>`;
      const ipd = document.createElement("input"); ipd.type = "range"; ipd.min = "0"; ipd.max = "150"; ipd.step = "1"; ipd.value = "63";
      const ipdV = document.createElement("span"); ipdV.className = "sl-hint"; ipdV.textContent = "63 mm";
      ipd.addEventListener("input", () => { ipdV.textContent = `${ipd.value} mm`; });
      irow.append(ipd, ipdV); adv.appendChild(irow);
      let sbsOn = false;
      sbs.addEventListener("click", () => {
        const w2 = new WebSocket("ws://127.0.0.1:8779");
        w2.onopen = () => { w2.send(sbsOn ? "2d" : "sbs"); sbsOn = !sbsOn; sbs.setAttribute("aria-pressed", String(sbsOn)); setTimeout(() => w2.close(), 500); };
        w2.onmessage = (e) => { const m = JSON.parse(String(e.data)) as { status?: string }; if (m.status && m.status !== "streaming the head pose") say.textContent = m.status; };
        w2.onerror = () => { say.textContent = "no pose helper on this Mac — start Contents/tools/viture/viture-pose.ts"; };
      });
      let stereo: { el: HTMLDivElement; eyes: { canvas: HTMLCanvasElement; ctx: GPUCanvasContext }[]; raf: number } | null = null;
      const stopStereo = () => {
        if (!stereo) return;
        cancelAnimationFrame(stereo.raf); stereo.el.remove(); stereo = null;
        sgo.textContent = "Start stereo"; sgo.setAttribute("aria-pressed", "false");
        removeEventListener("keydown", escStereo, true);
        a3d.refresh();
      };
      const escStereo = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); stopStereo(); } };
      const frameStereo = () => {
        if (!stereo) return;
        stereo.raf = requestAnimationFrame(frameStereo);
        const sc = scene; if (!sc || nothingIn3D) return;
        const dop = nrm([camera.focalPoint[0] - camera.position[0], camera.focalPoint[1] - camera.position[1], camera.focalPoint[2] - camera.position[2]]);
        const right = nrm(crs(dop, camera.viewUp as Vec3));
        const half = Number(ipd.value) / 2, va = Number(fov.value);
        stereo.eyes.forEach((e, i) => {
          const w = Math.max(16, Math.round(e.canvas.clientWidth * dpr)), h = Math.max(16, Math.round(e.canvas.clientHeight * dpr));
          if (e.canvas.width !== w || e.canvas.height !== h) { e.canvas.width = w; e.canvas.height = h; }
          const k = i === 0 ? -half : half;
          const off: Vec3 = [right[0] * k, right[1] * k, right[2] * k];
          sc.setCamera([camera.position[0] + off[0], camera.position[1] + off[1], camera.position[2] + off[2]],
            [camera.focalPoint[0] + off[0], camera.focalPoint[1] + off[1], camera.focalPoint[2] + off[2]], camera.viewUp, va, w, h);
          sc.renderToView(e.ctx.getCurrentTexture().createView({ format: srgb }), w, h);
        });
      };
      sgo.addEventListener("click", () => {
        if (stereo) { stopStereo(); return; }
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;inset:0;z-index:20000;display:flex;background:#000;cursor:none";
        el.title = "Stereo — Esc ends it";
        const eyes = [0, 1].map(() => {
          const canvas = document.createElement("canvas"); canvas.style.cssText = "flex:1 1 50%;width:50%;height:100%;display:block";
          el.appendChild(canvas);
          const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
          ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
          return { canvas, ctx };
        });
        document.body.appendChild(el);
        stereo = { el, eyes, raf: 0 };
        stereoOn = () => !!stereo;
        addEventListener("keydown", escStereo, true);
        sgo.textContent = "Stop stereo"; sgo.setAttribute("aria-pressed", "true");
        frameStereo();
      });
      (globalThis as unknown as { __headTracking?: () => { on: boolean; poses: number } }).__headTracking = () => ({ on: !!ws, poses: n });
    }
    subHead("Picture", "What Save… leaves out by default, and how large. The defaults are in Settings › Pictures.");
    toggle("3D view only", () => pictureOpts.only3d, (v) => { pictureOpts.only3d = v; }, "Leave the slice views out of the picture. The default is in Settings › Pictures.", adv);
    toggle("With the module panel", () => pictureOpts.panel, (v) => { pictureOpts.panel = v; }, "Add the module column on the left, as on screen. The default is in Settings › Pictures.", adv);
    pictureRepaints.push(() => { for (const b of Array.from(adv.querySelectorAll<HTMLButtonElement>(".sl-3d-panel-row > button[aria-pressed]"))) { const l = b.parentElement?.querySelector("label")?.textContent; if (l === "3D view only") { b.textContent = pictureOpts.only3d ? "on" : "off"; b.setAttribute("aria-pressed", String(pictureOpts.only3d)); } if (l === "With the module panel") { b.textContent = pictureOpts.panel ? "on" : "off"; b.setAttribute("aria-pressed", String(pictureOpts.panel)); } } });
    const sizeRow = document.createElement("div"); sizeRow.className = "sl-3d-panel-row";
    sizeRow.innerHTML = `<label title="How many pixels the picture has: as on screen, or a multiple of it.">Size</label>`;
    const sizeSel = document.createElement("select");
    for (const [v, t] of [[1, "as on screen"], [2, "2× the pixels"], [3, "3×"], [4, "4×"]] as [number, string][]) { const op = document.createElement("option"); op.value = String(v); op.textContent = t; sizeSel.appendChild(op); }
    sizeSel.value = String(pictureOpts.scale);
    sizeSel.title = "Every view rendered again at this multiple of its on-screen pixels; the framing stays the same.";
    sizeSel.addEventListener("change", () => { pictureOpts.scale = Number(sizeSel.value) || 1; });
    pictureRepaints.push(() => { sizeSel.value = String(pictureOpts.scale); });
    sizeRow.appendChild(sizeSel); adv.appendChild(sizeRow);

    // WHAT THE BOX IS ACTUALLY AROUND, printed rather than asserted.
    //
    // Ron, on the box, twice: "the 3d view bounding box is not right ... we had the same issue with
    // the original crop box" -- which was a box that started from a default and only ever grew, so it
    // was neither the size nor the center of its contents. The arithmetic here is a union of AABBs
    // and reads correct, and a static screenshot of a perspective projection cannot settle it: an
    // axis-aligned box seen at an angle looks loose even when it is tight. So the numbers go on
    // screen next to the toggle that draws it, the way the 3D field list already does. If the box is
    // bigger than the meshes, this says by how much and which contributor did it.
    const boxInfo = document.createElement("div");
    boxInfo.className = "sl-3d-panel-row sl-3d-boxinfo";
    const mm = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
    // ONE LINE PER AXIS, the full width of the panel (Ron, 2026-09-25: "the text is all pushed to the right" -- it sat
    // in the 4-character number column of the sliders and wrapped into a stack). Surface models get a line only when
    // there are some: since the firewall they are the exception.
    const span = (b: [Vec3, Vec3] | null) =>
      b ? `R ${mm(b[0][0])} to ${mm(b[1][0])} mm<br>A ${mm(b[0][1])} to ${mm(b[1][1])} mm<br>S ${mm(b[0][2])} to ${mm(b[1][2])} mm` : "nothing in the view";
    const refreshBoxInfo = () => {
      const all = sceneBounds();
      const same = all && meshBounds &&
        [0, 1, 2].every((i) => Math.abs(all[0][i] - meshBounds![0][i]) < 0.5 && Math.abs(all[1][i] - meshBounds![1][i]) < 0.5);
      boxInfo.innerHTML = `<label title="The region the 3D view's box is drawn around, in millimeters: R right, A anterior, S superior. When surface models are shown and they set a different size, both are listed.">Box</label>` +
        `<span class="sl-3d-boxnum">${span(all)}` +
        (meshBounds ? (same ? "<br>the same as the surface models" : `<br>Surface models alone:<br>${span(meshBounds)}`) : "") +
        `</span>`;
    };
    adv.addEventListener("toggle", () => { if (adv.open) refreshBoxInfo(); });
    adv.appendChild(boxInfo);

    panel.appendChild(adv);

    bar.appendChild(gear);
    three.el.appendChild(bar);
    three.el.appendChild(panel);
    // DISMISS ON A CLICK INTO THE SCENE, but never on one that started inside the panel or the bar.
    //
    // This used to listen on the canvas alone, which is a sibling of the bar, so in principle an
    // opener's own click could not reach it. Ron: "clicking the light doesn't make the box
    // disappear" -- and it toggles correctly here under both a programmatic click and a full
    // synthesised pointerdown/up/click, so whatever he is hitting is something this environment does
    // not reproduce. The listener moves to the cell WITH an explicit containment guard, which is
    // correct on its own terms and removes the one ordering hazard available: a pointerdown closing
    // the panel a moment before the click on the opener re-opens it, leaving it stubbornly open.
    three.el.addEventListener("pointerdown", (e: Event) => {
      const t = e.target as Node | null;
      if (t && (panel.contains(t) || bar.contains(t))) return;
      close();
    }, true);
  }

  const xy3d = (e: PointerEvent) => { const r = three.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  three.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Touching the camera hands framing to the user: no automatic re-fit after this, ever.
  // NOT A BROWSER DRAG. Ron, 2026-09-23: "When I click in the render window, it moves the entire
  // view. click again and the pointer is stuck to rotation of the model, even without the left
  // button depressed." Part of the page was selected, and a press on selected content is where
  // WebKit starts dragging it -- a ghost of the whole window followed the pointer, and the drag
  // swallowed the button's release, so the camera never heard the rotation end. The slice views
  // already refused the browser's default here; the 3D view did not. So: no default, and no
  // stale selection left for a press to pick up.
  three.canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); window.getSelection()?.removeAllRanges(); });
  three.canvas.addEventListener("pointerdown", (e) => { userMovedCamera = true; const { x, y } = xy3d(e); cam3d.start(e.button as 0 | 1 | 2, x, y, three.canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }); three.canvas.setPointerCapture(e.pointerId); });
  /**
   * THE PROBE IN 3D: what the ray MEETS, asked of the segmentations.
   *
   * Ron: "analyze what is along the viewray. That information is somewhere... One simplistic option
   * is when the accumulation reaches 50% or so of opacity. That is what was used in slicer."
   *
   * THE 50% RULE WAS THE FIRST ANSWER AND THE WRONG QUESTION. `SceneRenderer.pick` returns where
   * front-to-back opacity crosses 0.5, accumulated over everything the renderer composites -- so
   * with a step transfer function the soft tissue the ray meets first passes 0.5 long before it
   * reaches the structure being looked at. Ron pointed at the gluteus medius and got "Iliopsoas
   * muscle, right": honest, and about something else.
   *
   * So the segmentations are asked instead (Ron, on that option: "1: agree"), by marching the ray
   * against their labelmaps and taking the first non-zero label -- `LabelRay`. Two properties come
   * with it: there is no threshold to defend, and the answer cannot change when an opacity slider
   * does, which is Ron's standing rule seen from the probe's side.
   *
   * The opacity pick REMAINS as the fallback, for a ray that meets no segmentation at all: on a bare
   * volume, "where does this become substance" is the only question there is.
   *
   * ONE PROBE IN FLIGHT, latest cursor wins. Both routes end in a GPU readback, which is a full
   * CPU<->GPU round trip -- ~14 ms for the pick and ~16 ms for the ray march, essentially all of it
   * waiting rather than computing. So this is paced slower than the slice probe (a texel fetch) and
   * never queued up.
   */
  let labelRay: LabelRay | null = null;
  let pick3dBusy = false, pick3dAt = 0;
  const probe3dWarned = new Set<string>();
  /** The point on what the 3D view shows under (x, y), RAS mm, or null: the surface seen first, else the first
   *  visible structure along the ray, else where the volume becomes substance. The probe names it; a click while
   *  placing a markup puts a point there (as Slicer places markups on what is shown in 3D). */
  const pickRas3d = async (x: number, y: number): Promise<Vec3 | null> => {
    if (!scene) return null;
      const u = x / Math.max(1, three.canvas.clientWidth), v = y / Math.max(1, three.canvas.clientHeight);
      let ras: Vec3 | null = null;
      // The finest voxel spacing on screen: the march step below, and the nudge just after.
      const vox = Math.max(0.2, Math.min(...[...cells.values()].map((c) => bgField(c)?.sampleStep() ?? 1), 1));

      // THE SURFACE ON SCREEN FIRST, when there is one.
      //
      // Ron: "I want to have the name of what I see." Where surfaces are drawn, what he sees at a
      // pixel is the nearest mesh, and the renderer already knows its distance -- so ask that before
      // marching anything. Marching the labelmap answers "what does this ray meet first", which is a
      // different question wherever structures interdigitate: periventricular hypointensities wrap a
      // ventricle, so a ray meets one while the other is the surface being looked at. He saw exactly
      // that -- three adjacent bands named one across -- while the same point probed in a slice view
      // was correct, which is what proved the labelmap innocent.
      const surf = await scene.pickMeshSurface(u, v);
      if (surf) {
        // A HALF VOXEL INSIDE, PLUS THE DRAWING COPY'S BOUND. The mesh vertex sits ON the boundary
        // between the structure and what is outside it, so sampling the labelmap exactly there lands
        // on either side by rounding, and half the time names the neighbor. Stepping along the view
        // direction moves into the solid, which is the structure whose surface is being looked at.
        // Since 2026-09-18 the surface hit is the DRAWING COPY, which may sit up to DRAW_ERROR_VOXELS
        // outside the full mesh (critic, finding 6), so the step covers that too.
        const rr = scene.worldRay(u, v);
        const step = vox * (0.5 + DRAW_ERROR_VOXELS);
        ras = rr
          ? [surf[0] + rr.dir[0] * step, surf[1] + rr.dir[1] * step, surf[2] + rr.dir[2] * step] as Vec3
          : surf;
        // THE FIRST SOLID THE RAY ENTERS AT THE SURFACE, not the voxel a fixed step inside. One
        // step of 0.7 voxel from a cortex ribbon's surface lands under it, in a white-matter
        // hypointensity island a voxel below, and the probe named that while the eye was on the
        // cingulate (Ron, 2026-09-20: "the data probe is struggling with the white matter
        // hypointensities and the color disagrees with the color on the 3d structure"). So march
        // from just outside the hit -- the drawing copy sits up to DRAW_ERROR_VOXELS out -- in
        // quarter-voxel steps, and take the first label that is drawn: that is the surface seen.
        if (rr && segOverlays.length) {
          labelRay ??= new LabelRay(gpu);
          const back = vox * (0.5 + DRAW_ERROR_VOXELS);
          const from: Vec3 = [surf[0] - rr.dir[0] * back, surf[1] - rr.dir[1] * back, surf[2] - rr.dir[2] * back];
          const hit = await labelRay.first(segOverlays.filter((o) => o.visible3D).map((o) => ({ labels: o.labels, p2t: o.p2t, visible: o.visible })), from, rr.dir, vox * 0.25);
          if (hit && hit.tMm <= back * 2 + vox) ras = hit.ras;
        }
      }
      const r = ras ? null : scene.worldRay(u, v);
      if (r && segOverlays.length) {
        labelRay ??= new LabelRay(gpu);
        // A step at or below the finest voxel spacing of anything on screen: coarser than a voxel can
        // step over a thin structure, and a rib is thin.
        const step = vox;
        const hit = await labelRay.first(
          // ONLY WHAT THE 3D VIEW DRAWS, and within that only the structures that are switched on.
          // Ron: "If I have turned off structures in the segmentations module, the probe should show
          // me what is visible. Period." Two levels, because there are two ways to switch something
          // off: a whole segmentation (visible3D) and an individual structure (alpha 0, in the mask).
          //
          // Every visible segmentation is in the list now (a 3D-only one at zero 2D opacity), and
          // the ray walks them in pairs, so nothing on screen is out of the probe's reach.
          segOverlays
            .filter((o) => o.visible3D)
            .map((o) => ({ labels: o.labels, p2t: o.p2t, visible: o.visible })),
          r.origin,
          r.dir,
          step,
        );
        if (hit) ras = hit.ras;
      }
      // No segmentation on this ray: fall back to where the volume becomes substance.
      ras ??= await scene.pick(u, v);
      return ras;
  };
  const probe3d = async (x: number, y: number) => {
    if (!scene || pick3dBusy) return;
    const now = performance.now();
    if (now - pick3dAt < 90) return;
    pick3dBusy = true; pick3dAt = now;
    try {
      const ras = await pickRas3d(x, y);
      if (ras) await probeAtRas("3D", ras);
      else clearProbe();
    } catch (e) {
      // A probe that fails says nothing on screen; it must never break the view. But it says so in
      // the console, once per distinct message: a silent failure here cost a round of "the probe
      // is confused" before anyone looked.
      const msg = String((e as Error)?.message ?? e);
      if (!probe3dWarned.has(msg)) { probe3dWarned.add(msg); console.warn("3D probe failed:", e); }
    }
    finally { pick3dBusy = false; }
  };
  three.canvas.addEventListener("pointermove", (e) => {
    const { x, y } = xy3d(e);
    if (cam3d.action === "none") { void probe3d(x, y); return; }
    // NO BUTTON HELD, SO NO ROTATION -- whatever swallowed the release (a browser drag, a release
    // outside the window, a dialog). The camera ends the gesture itself rather than turning with a
    // pointer that is only hovering.
    if (e.buttons === 0) { end3d(e); return; }
    cam3d.move(x, y, three.canvas.clientWidth, three.canvas.clientHeight);
  });
  three.canvas.addEventListener("pointerleave", () => clearProbe());
  const end3d = (e: PointerEvent) => { if (cam3d.action !== "none") { cam3d.end(); pushCamera(); sync.flush(); try { three.canvas.releasePointerCapture(e.pointerId); } catch { /* */ } } };
  // PLACING IN 3D. A markup was placeable only in the slice views, so a click on the vena cava in 3D did nothing and
  // placement just waited (Ron, 2026-09-25: "no align" -- the line was never made). A left click that did not move
  // (a drag still rotates) puts the point on what the 3D view shows there, as Slicer does.
  let down3d: { x: number; y: number } | null = null;
  three.canvas.addEventListener("pointerdown", (e) => { down3d = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
  three.canvas.addEventListener("pointerup", (e) => {
    const d = down3d; down3d = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const inter = live.nodes.get(INTERACTION_ID); if (!inter || inter.mode !== "place" || !inter.markupType) return;
    const { x, y } = xy3d(e);
    void pickRas3d(x, y).then((ras) => {
      if (ras) { placeAtNative(ras); a3d.refresh(); }
      else cfg.onStatus?.("Nothing is shown at that point in 3D — click on the anatomy, or in a slice view");
    });
  });
  three.canvas.addEventListener("pointerup", end3d); three.canvas.addEventListener("pointercancel", end3d);
  // Zooming is the user framing the view too, so it stops automatic re-framing exactly as a drag does.
  three.canvas.addEventListener("wheel", (e) => { e.preventDefault(); userMovedCamera = true; cam3d.wheel(e.deltaY < 0); pushCamera(); }, { passive: false });

  const sliceNodeId = (name: string) => nodeIdFor((nd) => nd.type === "view" && nd.kind === "slice" && nd.layoutName === name);
  const scalarDisplayId = () => nodeIdFor((nd) => nd.type === "scalarVolumeDisplay");
  /** The display node of a cell's BACKGROUND volume (what Slicer's W/L drag adjusts): the cell's
   *  sliceComposite -> background image -> refs.display[0]; falls back to any scalar display. */
  const bgDisplayId = (c: SliceCell): string | undefined => {
    const comp = [...live.nodes.values()].find((n) => n.type === "sliceComposite" && n.layoutName === c.name);
    const imgId = ((comp?.refs as Record<string, string[]> | undefined)?.background ?? [])[0];
    const img = imgId ? live.nodes.get(imgId) : undefined;
    const did = ((img?.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
    return did ?? scalarDisplayId() ?? undefined;
  };
  const crosshairId = () => stateNode("crosshair")?.id ?? null;
  /** RAS of a cell pixel (u,v in [0,1]) on the cell's current plane. */
  const cellRas = (c: SliceCell, u: number, v: number): Vec3 => { applyPlane(c); return c.slice.viewToRas(c.orientKey, planeOffset01(c), u, v, c.canvas.width / c.canvas.height); };
  /** Nearest markup control point to a cell pixel within `px`, among in-plane points. */
  const pickMarkup = (c: SliceCell, u: number, v: number, w: number, h: number, px = 12) => {
    applyPlane(c);
    const off = planeOffset01(c), aspect = w / h;
    let best: { id: string; index: number; ras: Vec3 } | null = null, bestD = px * dpr;
    for (const hd of markupsDM.handles()) {
      if (live.nodes.get(hd.id)?.locked) continue;                       // locked markups aren't grabbable
      const r = c.slice.rasToView(c.orientKey, off, hd.ras, aspect);
      if (Math.abs(r.distMm) > SLAB_MM) continue;
      const d = Math.hypot((r.u - u) * w, (r.v - v) * h);
      if (d < bestD) { bestD = d; best = { id: hd.id, index: hd.index, ras: hd.ras }; }
    }
    return best;
  };
  let sliceDrag: { id: string; index: number } | null = null;

  /**
   * A cell's plane as a point and a normal, FROM THE CELL ITSELF.
   *
   * This read `live.nodes.get("view:" + c.name)`, and no node has ever had that id -- a native slice
   * node is `nativeSlice-<cell>` (nativeSliceId, below) and a mirrored one is whatever the peer calls
   * it. So it returned null every time, `pickRoiHandle` returned null every time, and the crop box
   * could not be grabbed on a slice at all: Ron, testing it, "the interaction in 2d is not working."
   * The outlines drew correctly throughout, because MarkupsDisplayableManager finds the slice nodes
   * by TYPE rather than by id -- which is exactly how a bug like this stays invisible.
   *
   * Taking it from the cell's own projection instead of from a node removes the class of fault: this
   * is the same `viewToRas` that `cellRas` uses to turn the click into RAS and the same one
   * `rasToView` inverts to hit-test, so what is drawn, what is picked and what a drag reads cannot
   * disagree. It works for a mirrored frame too, which has no node to read. Slicer likewise takes
   * the plane from the slice node's own XYToRAS -- one matrix per view, and everything derived from
   * it (vtkMRMLInteractionWidgetRepresentation::UpdateSlicePlaneFromSliceNode).
   */
  const cellPlane = (c: SliceCell): { point: Vec3; normal: Vec3 } | null => {
    const o = cellRas(c, 0.5, 0.5), a = cellRas(c, 1, 0.5), b = cellRas(c, 0.5, 1);
    const u: Vec3 = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
    const v: Vec3 = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const L = Math.hypot(n[0], n[1], n[2]);
    if (!(L > 0)) return null;
    return { point: o, normal: [n[0] / L, n[1] / L, n[2] / L] };
  };

  /**
   * Nearest CROP-BOX handle to a cell pixel, among the ones that plane HAS.
   *
   * The candidates are the plane's own nine (roi-widget's sliceHandles), the same ones the overlay
   * draws there -- so what is grabbable and what is visible are one list and cannot disagree. It
   * used to offer all fifteen 3D handles and keep whichever happened to fall within SLAB_MM of the
   * plane, which is how the views came to show handles that could not be grabbed. Ron: "2D control
   * handles should be usable in the slice that is visible, otherwise they are not functional."
   *
   * Same pixel radius as pickMarkup, since a control point and a box handle are grabbed the same way.
   */
  const pickRoiHandle = (c: SliceCell, u: number, v: number, w: number, h: number, px = 12) => {
    applyPlane(c);
    const off = planeOffset01(c), aspect = w / h;
    const pl = cellPlane(c);
    if (!pl) return null;
    let best: { roi: string; meta: HandleMeta; world: Vec3 } | null = null, bestD = px * dpr;
    for (const { id, widget } of markupsDM.cropWidgets()) {
      if (live.nodes.get(id)?.visible === false || live.nodes.get(id)?.locked) continue;
      for (const hd of widget.sliceHandles(pl.point, pl.normal)) {
        const r = c.slice.rasToView(c.orientKey, off, hd.world, aspect);
        if (Math.abs(r.distMm) > SLAB_MM) continue;
        const d = Math.hypot((r.u - u) * w, (r.v - v) * h);
        if (d < bestD) { bestD = d; best = { roi: id, meta: hd.data, world: hd.world }; }
      }
    }
    return best;
  };
  let roiSliceDrag: { roi: string; meta: HandleMeta; world: Vec3; box0: Box } | null = null;
  /** Apply a slice drag to the box and publish it. */
  const dragRoiOnSlice = (c: SliceCell, ras: Vec3) => {
    if (!roiSliceDrag) return;
    const w = markupsDM.cropWidgets().find((x) => x.id === roiSliceDrag!.roi);
    if (!w) return;
    const d = roiSliceDrag.world;
    const delta: Vec3 = [ras[0] - d[0], ras[1] - d[1], ras[2] - d[2]];
    // The slice NORMAL as the view direction: in a slice view the cursor cannot aim the
    // through-plane axis at all, so a corner drag must leave it alone. Exactly what viewDir is for.
    const normal = cellPlane(c)?.normal;
    w.widget.applyDrag(roiSliceDrag.meta, roiSliceDrag.box0, delta, normal);
    const b = w.widget.snapshot();
    live.write({ op: "patch", id: roiSliceDrag.roi, path: "#/center", value: [...b.center] });
    live.write({ op: "patch", id: roiSliceDrag.roi, path: "#/size", value: [b.half[0] * 2, b.half[1] * 2, b.half[2] * 2] });
  };

  // ── the crop box's handles, draggable in the 3D view ────────────────────────────────────────────
  //
  // Ron, twice: "the box has no grab handles on either 2d or 3d", then "still no grab point." The
  // widget has had the handles, the drag math and the hover feedback all along (roi-widget.ts); what
  // was missing was a pointer. attachWidgetControls registers on the CAPTURE phase, so grabbing a
  // handle does not also orbit the camera, and empty space still bubbles through to the orbit
  // handler below.
  //
  // The drag is applied to the widget for the immediate picture and written back to the node so the
  // rest of the application -- the crop panel's numbers, the slice outlines -- follows one source of
  // truth. syncRoi then sets the widget from the node with the same values, so the round trip is a
  // no-op rather than a fight.
  let roiDrag: { id: string; box0: Box } | null = null;
  const roiHandles = () =>
    markupsDM.cropWidgets().flatMap(({ id, widget }) =>
      live.nodes.get(id)?.locked
        ? []
        : widget.handleList().map((h) => ({ id: h.id, world: h.world, data: { roi: id, meta: h.data }, cursor: h.cursor }))
    );
  attachWidgetControls(three.canvas, camera, {
    getHandles: () => (threeVisible ? roiHandles() : []),
    getSize: () => ({ w: three.canvas.width, h: three.canvas.height }),
    onDragStart: (h) => {
      const d = h.data as { roi: string; meta: HandleMeta };
      const w = markupsDM.cropWidgets().find((x) => x.id === d.roi);
      roiDrag = w ? { id: d.roi, box0: w.widget.snapshot() } : null;
    },
    onDrag: (h, world) => {
      if (!roiDrag) return;
      const d = h.data as { roi: string; meta: HandleMeta };
      const w = markupsDM.cropWidgets().find((x) => x.id === d.roi);
      if (!w) return;
      const delta: Vec3 = [world[0] - h.world[0], world[1] - h.world[1], world[2] - h.world[2]];
      // viewDir makes a corner drag predictable: the box axis pointing into the screen is the one
      // the cursor cannot aim, so it is left alone.
      const viewDir: Vec3 = [
        camera.focalPoint[0] - camera.position[0],
        camera.focalPoint[1] - camera.position[1],
        camera.focalPoint[2] - camera.position[2],
      ];
      w.widget.applyDrag(d.meta, roiDrag.box0, delta, viewDir);
      const b = w.widget.snapshot();
      live.write({ op: "patch", id: d.roi, path: "#/center", value: [...b.center] });
      live.write({ op: "patch", id: d.roi, path: "#/size", value: [b.half[0] * 2, b.half[1] * 2, b.half[2] * 2] });
      renderSlices();
    },
    onDragEnd: () => { roiDrag = null; },
    onHover: (h) => {
      const d = h?.data as { roi: string } | undefined;
      for (const { id, widget } of markupsDM.cropWidgets()) widget.setHover(d && d.roi === id ? h!.id : null);
      draw3d();
    },
    onChange: () => draw3d(),
  });
  // ── segment editor: brush cursor + strokes sent to the app (Paint / Erase active in the streamed editor) ──
  const brushEffect = (): "add" | "remove" | null => {
    const e = ((stateNode("segmentEditor")?.activeEffect as string) ?? "").toLowerCase();
    return e === "paint" ? "add" : e === "erase" ? "remove" : null;
  };
  const brushDiameterMm = (): number => {
    const P = (stateNode("segmentEditor")?.params as Record<string, string> | undefined) ?? {};
    const abs = parseFloat(P.BrushAbsoluteDiameter ?? "");
    return Number.isFinite(abs) && abs > 0 ? abs : 5;
  };
  let brushStroke: { cell: SliceCell; points: Vec3[]; seq: number; lastSent: number; lastPt: Vec3 } | null = null;
  let strokeSeq = 0;
  let brushCursor: { cell: SliceCell; ras: Vec3 } | null = null;
  let paintCommitTimer: number | undefined;
  const localSegForEditor = (): { segId: string; segment: number } | null => {
    const se = stateNode("segmentEditor"); if (!se) return null;
    const segId = ((se.refs as Record<string, string[]> | undefined)?.segmentation ?? [])[0];
    const seg = segId ? live.nodes.get(segId) : undefined;
    if (!seg || !(seg.origin as { local?: boolean } | undefined)?.local) return null;   // peer segmentation -> use the cmd path
    return { segId, segment: Number(se.selectedSegmentId ?? 1) || 1 };
  };
  const sendStroke = (final = false) => {
    if (!brushStroke) return;
    const id = stateNode("segmentEditor")?.id; if (!id) return;
    const pts = brushStroke.points.slice(brushStroke.lastSent);
    if (pts.length === 0) return;
    const send = brushStroke.lastSent > 0 ? [brushStroke.lastPt, ...pts] : pts;   // overlap with the previous batch
    const pl = brushStroke.cell.plane!;
    const normal: Vec3 = pl.basis ? pl.basis.nDir : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
    const P = (stateNode("segmentEditor")?.params as Record<string, string> | undefined) ?? {};
    const local = localSegForEditor();
    if (local && cfg.onNativePaint) {                                 // standalone: paint the resident labelmap
      cfg.onNativePaint(local.segId, local.segment, send, brushEffect() ?? "add", brushDiameterMm() / 2, P.BrushSphere === "1", normal);
      clearTimeout(paintCommitTimer);
      if (final) cfg.onNativePaintCommit?.(local.segId);
      else paintCommitTimer = setTimeout(() => cfg.onNativePaintCommit?.(local.segId), 120) as unknown as number;
    } else {
      live.write({ op: "cmd", id, cmd: "segPaint", args: { points: send, mode: brushEffect() ?? "add", diameterMm: brushDiameterMm(), sphere: P.BrushSphere === "1", normal, seq: ++strokeSeq, index: strokeSeq } });
      if (final) sync.flush();
    }
    brushStroke.lastSent = brushStroke.points.length; brushStroke.lastPt = pts[pts.length - 1];
  };
  const pushSliceFrame = (c: SliceCell) => {
    const id = sliceNodeId(c.name); const pl = c.plane; if (!id || !pl) return;
    const f = c.slice.mirrorFrame(c.orientKey, c.canvas.width / c.canvas.height);
    const n: Vec3 = pl.basis ? pl.basis.nDir : pl.orient === "axial" ? [0, 0, 1] : pl.orient === "coronal" ? [0, 1, 0] : [1, 0, 0];
    // keep the out-of-plane position: replace the centre's component along the normal with posMm
    const along = f.centerRAS[0] * n[0] + f.centerRAS[1] * n[1] + f.centerRAS[2] * n[2];
    const center: Vec3 = [f.centerRAS[0] + (pl.posMm - along) * n[0], f.centerRAS[1] + (pl.posMm - along) * n[1], f.centerRAS[2] + (pl.posMm - along) * n[2]];
    live.write({ op: "cmd", id, cmd: "setSliceFrame", args: { center, fov: [f.fovX, f.fovY] } });   // the app keeps its slab thickness
    pl.centerRAS = center; pl.fovX = f.fovX; pl.fovY = f.fovY;
    c.branched = false;
  };
  let frameTimer: number | undefined;
  const branch = (c: SliceCell) => { c.branched = true; clearTimeout(frameTimer); frameTimer = setTimeout(() => pushSliceFrame(c), 200) as unknown as number; };
  /** A slice plane's RAS normal (its reformat basis if it has one, else the canonical axis). */
  const normalOfCell = (cc: SliceCell): Vec3 =>
    cc.plane?.basis ? cc.plane.basis.nDir : cc.orientKey === "axial" ? [0, 0, 1] : cc.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];

  /**
   * Where every OTHER slice plane cuts THIS one, in normalized view coords — Slicer's colored
   * localizer lines. The overlay draws them; the accessor publishes them; the grab test below makes
   * them draggable, which is the point of having them in one place.
   */
  const intersectLines = (c: SliceCell, aspect: number): { cell: string; a: [number, number]; b: [number, number] }[] => {
    if (!c.plane) return [];
    const off = planeOffset01(c);
    const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nc = normalOfCell(c), dc = c.plane.posMm;
    const out: { cell: string; a: [number, number]; b: [number, number] }[] = [];
    for (const o of cells.values()) {
      if (o === c || o.el.style.display === "none" || !o.plane) continue;
      const no = normalOfCell(o), dir = crossV(nc, no);
      const dd = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
      if (dd < 1e-9) continue;                                    // parallel planes: no intersection line
      const co1 = crossV(no, dir), co2 = crossV(dir, nc);
      const p0: Vec3 = [(co1[0] * dc + co2[0] * o.plane.posMm) / dd, (co1[1] * dc + co2[1] * o.plane.posMm) / dd, (co1[2] * dc + co2[2] * o.plane.posMm) / dd];
      const pa = c.slice.rasToView(c.orientKey, off, [p0[0] + dir[0] * 1e4, p0[1] + dir[1] * 1e4, p0[2] + dir[2] * 1e4], aspect);
      const pb = c.slice.rasToView(c.orientKey, off, [p0[0] - dir[0] * 1e4, p0[1] - dir[1] * 1e4, p0[2] - dir[2] * 1e4], aspect);
      out.push({ cell: o.name, a: [pa.u, pa.v], b: [pb.u, pb.v] });
    }
    return out;
  };

  /**
   * Which intersection line the cursor is on, if any — the handle for dragging another slice.
   *
   * Ron: "It would be nice to be able to drag the crosshairs to position the slices." The colored
   * lines already showed where the other two slices cut this one and were inert; in Slicer they are
   * the handle. Grabbing one and dragging moves THAT slice, which is the most direct way to say
   * "put the sagittal here" while looking at the axial.
   *
   * Deliberately a narrow band (a few pixels): a plain left-drag anywhere else stays window/level,
   * Slicer's default 2D mouse mode, which must not be stolen.
   */
  const pickIntersection = (c: SliceCell, u: number, v: number, w: number, h: number, px = 6): string[] => {
    const near: { cell: string; d: number }[] = [];
    for (const ln of intersectLines(c, w / h)) {
      // distance from the point to the segment, in pixels
      const ax = ln.a[0] * w, ay = ln.a[1] * h, bx = ln.b[0] * w, by = ln.b[1] * h;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((u * w - ax) * dx + (v * h - ay) * dy) / len2));
      const d = Math.hypot(u * w - (ax + t * dx), v * h - (ay + t * dy));
      if (d < px * dpr) near.push({ cell: ln.cell, d });
    }
    // EVERY line in reach, nearest first -- at the crossing that is both of them, and grabbing there
    // drags both slices at once, which is the whole point of a crosshair. Ron: "if I grab the
    // crossing, then it would be nice if both would be grabed."
    return near.sort((a, b) => a.d - b.d).map((x) => x.cell);
  };
  /** The slices whose intersection lines are being dragged, and the cell they are dragged in. */
  let intersectDrag: { in: SliceCell; targets: string[] } | null = null;
  /** The lines the cursor is over — highlighted so it is clear what a press would grab. */
  let intersectHover: { in: SliceCell; targets: string[] } | null = null;
  /** Is this cell's line for `target` among those being grabbed or hovered? */
  const lineActive = (c: SliceCell, target: string) =>
    (!!intersectDrag && intersectDrag.in === c && intersectDrag.targets.includes(target)) ||
    (!!intersectHover && intersectHover.in === c && intersectHover.targets.includes(target));
  /** Every cell's intersection lines depend on EVERY slice's position, so moving one restages them all. */
  const redrawIntersections = () => { for (const cc of cells.values()) drawOverlay(cc); };
  /** Put `target`'s slice through this RAS point: its offset is the point's component along its own normal. */
  const dragSliceTo = (target: string, ras: Vec3) => {
    const t = cells.get(target); if (!t?.plane) return;
    const n = normalOfCell(t);
    // setSliceOffset repaints every cell's lines (see patchNativeOffset): the TARGET cell re-renders
    // itself off the node change, but the cell being dragged IN does not -- its image has not
    // changed, only the line drawn over it -- and neither does the third view, which shows the same
    // slice as a line too. So the line stayed put under the cursor until something unrelated
    // repainted that view. Ron: "the other slices move but the lines do not update until I change
    // something in the viewer where I am dragging."
    setSliceOffset(target, ras[0] * n[0] + ras[1] * n[1] + ras[2] * n[2]);
  };

  function attachInteraction(c: SliceCell) {
    c.controls = attachSliceControls(c.canvas, {
      orient: c.orientKey, getSlice: () => c.slice,
      step: (fwd) => {
        // one slice per wheel notch, through the NATIVE-node path (setSliceOffset -> patchNativeOffset keeps
        // sliceToRAS AND offset in sync). Before: step() patched only #/offset, so the DM re-pushed the plane
        // from the stale sliceToRAS and the slice snapped back -> jitter (worst on the 1.3mm sagittal axis).
        const cur = getSliceOffset(c.name); const range = sliceOffsetRange(c.name);
        if (cur == null || !range) return;
        const stepMm = range.step > 0 ? range.step : 1;
        setSliceOffset(c.name, cur + stepMm * (fwd ? -1 : 1));
      },
      redraw: () => renderSlice(c),
      // Slicer's AdjustWindowLevel mouse mode: gated by the interaction node streamed from the app
      wl: {
        enabled: () => { const m = stateNode("interaction"); return m ? (m.mode === "adjustWindowLevel") : !!bgDisplayId(c); },   // Slicer default 2D mouse mode
        get: () => { const d = live.nodes.get(bgDisplayId(c) ?? ""); return [(d?.window as number) ?? 100, (d?.level as number) ?? 50]; },
        set: (win, lev) => { const id = bgDisplayId(c); if (!id) return; live.write({ op: "patch", id, path: "#/window", value: win }); live.write({ op: "patch", id, path: "#/level", value: lev }); live.write({ op: "patch", id, path: "#/autoWindowLevel", value: false }); c.slice.setWindowLevel(win, lev); renderSlice(c); },
        range: () => bgField(c) ? bgField(c)!.getClim() : [0, 1],
      },
      hooks: {
        onZoom: () => branch(c),
        onLeftGrab: (u, v, w, h) => {
          if (brushEffect()) {                                          // Segment Editor Paint/Erase: stroke in this cell
            brushStroke = { cell: c, points: [cellRas(c, u, v)], seq: 0, lastSent: 0, lastPt: cellRas(c, u, v) };
            sendStroke();                                               // the initial dab paints immediately
            return true;
          }
          if (interactionMode() === "place") {                          // Slicer's Place mode: a click places
            const ras = cellRas(c, u, v);
            if (placeAtNative(ras)) return true;                          // native placer (standalone)
            const id = stateNode("interaction")?.id; if (!id) return true;
            live.write({ op: "cmd", id, cmd: "placeAt", args: { ras, view: c.name } });   // peer path
            sync.flush();
            return true;                                                  // consume: no scroll-drag starts
          }
          const roiHit = pickRoiHandle(c, u, v, w, h);
          if (roiHit) {
            const wd = markupsDM.cropWidgets().find((x) => x.id === roiHit.roi);
            if (wd) { roiSliceDrag = { ...roiHit, box0: wd.widget.snapshot() }; return true; }
          }
          const hit = pickMarkup(c, u, v, w, h);
          if (hit) { sliceDrag = { id: hit.id, index: hit.index }; markupsDM.touch(hit.id, hit.index); return true; }
          const lines = pickIntersection(c, u, v, w, h);
          if (lines.length) { intersectDrag = { in: c, targets: lines }; drawOverlay(c); return true; }
          return false;   // anything else is window/level, Slicer's default 2D mouse mode
        },
        onLeftDrag: (u, v) => {
          if (brushStroke) {
            const ras = cellRas(c, u, v); brushStroke.points.push(ras); brushCursor = { cell: c, ras };
            const now = performance.now();
            if (now - (brushStroke as { t?: number }).t! > 60 || !(brushStroke as { t?: number }).t) { (brushStroke as { t?: number }).t = now; sendStroke(); }
            drawOverlay(c); return;
          }
          if (intersectDrag) {
            const ras = cellRas(c, u, v);
            for (const t of intersectDrag.targets) dragSliceTo(t, ras);
            return;
          }
          if (roiSliceDrag) { dragRoiOnSlice(c, cellRas(c, u, v)); return; }
          if (!sliceDrag) return;
          const ras = cellRas(c, u, v);
          markupsDM.moveLocal(sliceDrag.id, sliceDrag.index, ras, live);   // optimistic
          markupsDM.touch(sliceDrag.id, sliceDrag.index);
          live.write({ op: "cmd", id: sliceDrag.id, cmd: "setControlPoint", args: { index: sliceDrag.index, position: ras } });
          storeMeasurements(sliceDrag.id);
        },
        onLeftDrop: () => { if (brushStroke) { sendStroke(true); brushStroke = null; drawOverlay(c); } if (roiSliceDrag) { sync.flush(); roiSliceDrag = null; } if (sliceDrag) { sync.flush(); sliceDrag = null; } if (intersectDrag) { sync.flush(); const was = intersectDrag.in; intersectDrag = null; intersectHover = null; drawOverlay(was); } },
        onHover: (u, v, w, h) => {
          // THE PROBE FIRST, because it needs nothing from the app. This sat after the crosshair
          // guard below, and a standalone scene has no crosshair node -- that node is streamed by a
          // Slicer peer -- so `onHover` returned before reaching it and the probe never ran once.
          // Ron: "The data probe is nowhere to be seen." It was not: it was behind an early return.
          const rasHere = cellRas(c, u, v);
          void probeAtRas(c.name, rasHere);
          // cursor -> the app's crosshair cursor (DataProbe follows); shift-move -> crosshair position too
          const id = crosshairId(); if (!id) return;
          const ras = rasHere;
          live.write({ op: "cmd", id, cmd: "setCursor", args: { ras, view: c.name } });
          if (shiftHeld) { live.write({ op: "patch", id, path: "#/crosshairRAS", value: ras }); jumpLocal(ras); }
          if (brushEffect()) { brushCursor = { cell: c, ras }; c.canvas.style.cursor = "none"; drawOverlay(c); }
          else {
            const overMarkup = pickMarkup(c, u, v, w, h);
            const overLines = overMarkup ? [] : pickIntersection(c, u, v, w, h);
            // Highlight what a press would grab, and repaint only when that answer changes.
            const wasKey = intersectHover && intersectHover.in === c ? intersectHover.targets.join() : "";
            const nowKey = overLines.join();
            intersectHover = overLines.length ? { in: c, targets: overLines } : null;
            if (wasKey !== nowKey) drawOverlay(c);
            c.canvas.style.cursor = interactionMode() === "place"
              ? "crosshair"
              : overMarkup ? "grab" : overLines.length ? "move" : "default";
          }
        },
      },
    });
    attachDoubleClick(c.canvas, () => toggleMaximize(c.name));
    const lbl = c.el.querySelector(".lv-cell-label") as HTMLElement | null; if (lbl) lbl.style.display = "none";
    // slice controller bar (orientation + offset slider + fit) over this cell, node/peer-agnostic via the adapter
    (c as SliceCell & { controller?: SliceController }).controller = mountSliceController(c.el, c.name, {
      orientation: () => orientationShown(c), offset: () => getSliceOffset(c.name), range: () => sliceOffsetRange(c.name),
      setOffset: (mm) => setSliceOffset(c.name, mm), fit: () => fitCell(c.name),
      setOrientation: (o) => { const lo = parseLineOrientation(o); if (lo) lineReformat(c.name, lo.markupId, lo.view); else if (CARDIAC_VIEWS.some((v) => v.id === o)) void cardiacReformat(c.name, o as CardiacView); else reformatCell(c.name, o as "axial" | "coronal" | "sagittal"); },
      cardiacAvailable,
      lines: () => lineMarkups().map((n) => ({ id: String(n.id), name: String(n.name ?? "Line") })),
      toggle3D: () => setSliceIn3D(c.name, !sliceIn3D.has(c.name)),
      in3D: () => sliceIn3D.has(c.name),
      onChange: (cb) => { sliceChangeListeners.add(cb); return () => sliceChangeListeners.delete(cb); },
    });
    // pan (middle / shift+left drag) and right-drag zoom have no hooks: branch on the press that starts
    // them (capture phase, before the control handles it) and write the frame back on release
    c.canvas.addEventListener("pointerdown", (e) => { if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) c.branched = true; }, true);
    c.canvas.addEventListener("pointerup", () => { if (c.branched && !sliceDrag) pushSliceFrame(c); });
    c.canvas.addEventListener("pointerleave", () => {
      lastProbed = null;   // the readout stays, as Slicer's does; only the repeat-on-change stops
      const id = crosshairId(); if (id) live.write({ op: "cmd", id, cmd: "setCursor", args: { ras: null, view: c.name } });
      if (intersectHover?.in === c) { intersectHover = null; drawOverlay(c); }
    });
    c.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = sliceNodeId(c.name); if (!id) return;
      const r = c.canvas.getBoundingClientRect();
      const ras = cellRas(c, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      live.write({ op: "cmd", id, cmd: "viewContextMenu", args: { ras, x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) } });
      sync.flush();
    });
  }
  let sliceIntersections = true;
  let shiftHeld = false;
  addEventListener("keydown", (e) => { if (e.key === "Shift") shiftHeld = true; }, true);
  addEventListener("keyup", (e) => { if (e.key === "Shift") shiftHeld = false; }, true);

  let lastRects: ViewCellRect[] = [];
  let maximizedCell: string | null = null;
  const applyCells = () => {
    const origin = root.getBoundingClientRect();
    // when a cell is maximized (double-click, like the MPR demos' attachViewGrid), show only it, full area
    const rects = maximizedCell
      ? lastRects.filter((r) => r.name === maximizedCell).map((r) => ({ ...r, view: { x: origin.left, y: origin.top, w: origin.width, h: origin.height } }))
      : lastRects;
    const shownSlices = new Set<string>();
    threeVisible = false;
    for (const r of rects) {
      const box = `position:absolute;overflow:hidden;left:${r.view.x - origin.left}px;top:${r.view.y - origin.top}px;width:${r.view.w}px;height:${r.view.h}px;display:block`;
      if (r.kind === "slice") { const c = sliceCell(r.name); c.el.style.cssText = `${box};background:var(--sl-view-bg)`; shownSlices.add(r.name); }
      // The 3D cell's CSS fallback is Slicer's own gradient rather than near-black, so resizing or
      // the moment before the first rendered frame never flashes a dark box behind the canvas.
      else if (r.kind === "3d") { if (r.name === "1") { three.el.style.cssText = `${box};background:${CSS_BG_GRADIENT}`; threeVisible = true; } else console.warn("live-views: second 3D view not yet supported:", r.name); }
    }
    for (const [name, c] of cells) if (!shownSlices.has(name)) c.el.style.display = "none";
    if (!threeVisible) three.el.style.display = "none";
    resizeAll(); renderSlices();
    // a3d.draw() is a no-op while `scene` is null, which is the state at startup before any data
    // is loaded -- so the 3D cell showed its bare CSS background (near-black) instead of Slicer's.
    // Build the empty scene once so the very first frame paints the gradient.
    if (threeVisible) { if (!scene) rebuild3d(); else a3d.refresh(); }
  };
  const setCells = (rects: ViewCellRect[]) => { lastRects = rects; if (maximizedCell && !rects.some((r) => r.name === maximizedCell)) maximizedCell = null; applyCells(); };
  /** Double-click a cell to maximize/restore (reuses the MPR demos' behaviour, systematized here). */
  const toggleMaximize = (name: string) => { maximizedCell = maximizedCell === name ? null : name; applyCells(); };
  attachDoubleClick(three.canvas, () => toggleMaximize("1"));
  // Native sliceView nodes (standalone, no Slicer peer): the SliceDisplayableManager consumes `view`/slice
  // nodes (sliceToRAS + fieldOfView) and pushes a plane to each cell, so a locally loaded volume renders and
  // jump/offset persist (the node owns the plane). One per anatomical cell; the same setSlicePlane path a peer
  // uses. Red=Axial, Yellow=Sagittal, Green=Coronal.
  const NATIVE_SLICE: Record<string, { orientation: string; axis: 0 | 1 | 2; transIdx: 3 | 7 | 11; mat: (c: Vec3) => number[] }> = {
    Red: { orientation: "Axial", axis: 2, transIdx: 11, mat: (c) => [1, 0, 0, c[0], 0, 1, 0, c[1], 0, 0, 1, c[2], 0, 0, 0, 1] },
    Yellow: { orientation: "Sagittal", axis: 0, transIdx: 3, mat: (c) => [0, 0, 1, c[0], 1, 0, 0, c[1], 0, 1, 0, c[2], 0, 0, 0, 1] },
    Green: { orientation: "Coronal", axis: 1, transIdx: 7, mat: (c) => [1, 0, 0, c[0], 0, 0, 1, c[1], 0, 1, 0, c[2], 0, 0, 0, 1] },
  };
  const nativeSliceId = (cell: string) => `nativeSlice-${cell}`;
  const ensureNativeSlices = (rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[], center: Vec3) => {
    for (const [cell, def] of Object.entries(NATIVE_SLICE)) {
      // EVERY SLICE VIEW, SHOWN OR NOT, as in Slicer, where the three slice nodes exist whatever the layout. Skipping
      // the hidden ones meant a volume or a scene opened in One-Up 3D never got its slice views: the scene's layout then
      // brought back three black cells, its planes were not restored, and no layout change repaired it (found
      // 2026-09-25). A hidden cell has no size yet; its field of view is fitted to a square until it is shown.
      const c = cells.get(cell); if (!c) continue;
      const shown = c.el.style.display !== "none" && c.canvas.width > 1 && c.canvas.height > 1;
      const w = shown ? c.canvas.width : 512, h = shown ? c.canvas.height : 512;
      const [fovX, fovY, slab] = fitFovToVolume(c.orientKey, rasLo, rasHi, ijkToRAS, w, h);
      const id = nativeSliceId(cell);
      live.write({ op: "put", id, node: { type: "view", kind: "slice", id, name: cell, layoutName: cell, orientation: def.orientation, sliceToRAS: def.mat(center), fieldOfView: [fovX, fovY, slab], offset: center[def.axis], source: { local: true } } });
    }
    renderSlices();
  };
  /** Slicer SliceLink: is this cell's composite linkedControl on? (the toggle sets all composites together). */
  const compositeLinked = (cell: string): boolean => {
    const comp = [...live.nodes.values()].find((n) => n.type === "sliceComposite" && n.layoutName === cell);
    return !!comp?.linkedControl;
  };
  const linkStateOf = (cell: string): LinkSliceState | null => {
    const n = live.nodes.get(nativeSliceId(cell)); if (!n) return null;
    return { name: cell, sliceToRAS: n.sliceToRAS as number[], fieldOfView: (n.fieldOfView as [number, number, number]) ?? [250, 250, 1], viewGroup: 0 };
  };
  const normalOfMatrix = (m: number[]): Vec3 => { const v: Vec3 = [m[2], m[6], m[10]]; const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
  /** Propagate a change in `sourceCell` to linked native slice cells (vtkMRMLSliceLinkLogic rules). */
  const propagateLink = (sourceCell: string, flags: SliceLinkFlag[]): void => {
    if (!compositeLinked(sourceCell)) return;
    const src = linkStateOf(sourceCell); if (!src) return;
    const others = [...cells.keys()].map(linkStateOf).filter((x): x is LinkSliceState => !!x && x.name !== sourceCell);
    const updates = broadcastSlice(src, others, flags);
    for (const [cell, u] of updates) {
      const id = nativeSliceId(cell); if (!live.nodes.has(id)) continue;
      if (u.sliceToRAS) {
        live.write({ op: "patch", id, path: "#/sliceToRAS", value: u.sliceToRAS });
        const n = normalOfMatrix(u.sliceToRAS);                                   // keep the redundant offset field consistent
        live.write({ op: "patch", id, path: "#/offset", value: u.sliceToRAS[3] * n[0] + u.sliceToRAS[7] * n[1] + u.sliceToRAS[11] * n[2] });
      }
      if (u.fieldOfView) live.write({ op: "patch", id, path: "#/fieldOfView", value: u.fieldOfView });
    }
    renderSlices();
  };

  /** Move a native slice node's plane to offset `mm` along its CURRENT normal (works for reformatted cells
   *  whose orientation differs from the cell's original axis). Node-owned, persists, links to same-orientation
   *  views. Offset = signed distance of the plane origin along the normal (Slicer's convention). */
  let ownPatch = false;   // patchNativeOffset's own writes, not counted as "other writes" in a drag's report
  live.subscribe((ch) => {
    const d = sliderDrag; if (!d || ownPatch || ch.id !== nativeSliceId(d.cell)) return;
    const k = callerOf(); d.writers.set(k, (d.writers.get(k) ?? 0) + 1);
  });
  const patchNativeOffset = (cell: string, mm: number): boolean => {
    const id = nativeSliceId(cell); const node = live.nodes.get(id); if (!node) return false;
    const m = (node.sliceToRAS as number[]).slice();
    const n = normalOfMatrix(m);
    const t: Vec3 = [m[3], m[7], m[11]];
    const cur = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    const d = mm - cur;
    m[3] = t[0] + d * n[0]; m[7] = t[1] + d * n[1]; m[11] = t[2] + d * n[2];
    ownPatch = true;
    try {
      live.write({ op: "patch", id, path: "#/sliceToRAS", value: m });
      live.write({ op: "patch", id, path: "#/offset", value: mm });
    } finally { ownPatch = false; }
    propagateLink(cell, ["SliceToRAS"]);                                          // linked same-orientation views follow
    refreshSlicesIn3D();                                                          // hot-update the dropped slice in 3D
    redrawIntersections();   // this slice is a LINE in the other two views; they must restage it
    return true;
  };

  // ── Slice Model / Drop-Slice (show a slice as a plane at its RAS location in 3D; hot-updates on scroll) ──
  /**
   * The slices dropped into the 3D view, and WHICH VOLUME each one was built from.
   *
   * The volume matters because a `SlicePlaneField` binds a GPU texture at construction and the hot
   * path only re-places the plane. So after a crop -- new volume in every slice cell -- the 2D views
   * showed the crop while the planes in 3D still sampled the original, neck and all. Ron: "Slices
   * show the cropped, 3D doesn't. Look for instance at the yellow slice and its equivalent in the 3d
   * viewer. As a heuristic the 3d viewer should update with the slice viewers."
   *
   * Keyed on the image NODE id, like the cell's own re-framing rule: a transform builds a new field
   * for the same image, and rebuilding the 3D pipeline for that would be a stutter for nothing.
   */
  /**
   * The slices drawn in 3D: for each cell, the 2D composite rendered into a texture, and the quad
   * frame that goes with it.
   *
   * Ron: "The user does the compositing work in the 2d viewer and whatever is there, goes to the 3D
   * viewer. This means that no matter how complex the data only a single slice gets displayed in the
   * 3D viewer." Which is Slicer's design -- vtkMRMLSliceLogic textures a vtkPlaneSource model -- and
   * it replaces a SlicePlaneField per slice. Three things that bought:
   *
   *   * the 3D slice cannot disagree with the 2D view, because it IS the 2D view. Foreground blend,
   *     label layer, both segmentation overlays and their outlines all arrive for free, and no
   *     matching logic exists to fall out of step;
   *   * cost is flat in the number of datasets. The composite is paid once, in 2D;
   *   * it is out of the ray-march, so it no longer sets the scene's global sample step. The march
   *     runs at min(sampleStep) over every field, so a slice as a field slowed the volume down
   *     everywhere -- one slice 15%, three 22%.
   */
  /**
   * Surfaces by source. Models were the only source until segmentations grew extracted surfaces of
   * their own, and one shared list meant whichever spoke last erased the other.
   */
  const meshGroups = new Map<string, SceneMeshData[]>();
  /**
   * The union AABB of every mesh, or null when there are none. Cached, because it is O(vertices) and
   * the answer only changes when the meshes do.
   *
   * The overlay used to compute this per FRAME and bail out with `if (b.length > 3000) break` after
   * the first sizeable mesh -- so with 95 parcels it measured one of them. And it started from a
   * hard-coded +/-100 mm box that it then only ever grew, so a brain sitting inside that box got a
   * 200 mm cube drawn around it, off-center and far too large. Ron: "same issue as with the crop box
   * initially."
   */
  let meshBounds: [Vec3, Vec3] | null = null;
  /** The bounds the camera was last framed on, so a material change can be recognized. */
  let fittedBounds: [Vec3, Vec3] | null = null;
  /** Set the moment the user touches the 3D camera. After that, framing is theirs and not ours. */
  let userMovedCamera = false;
  // AN EMPTY SCENE FORGETS THE FRAMING: after Close scene the next study frames itself, instead
  // of landing in the camera the last one left (a restored scene's camera counts as the person's).
  live.subscribe((c) => {
    if (c.kind !== "remove" && c.kind !== "reset") return;
    if (![...live.nodes.values()].some((n) => n.type === "image" || n.type === "segmentation")) { userMovedCamera = false; fittedBounds = null; }
  });
  const computeMeshBounds = () => {
    let lo: Vec3 | null = null, hi: Vec3 | null = null;
    for (const m of meshes) {
      if (m.visible === false) continue;
      const b = m.positions;
      for (let i = 0; i + 2 < b.length; i += 3) {
        const x = b[i], y = b[i + 1], z = b[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (!lo) { lo = [x, y, z]; hi = [x, y, z]; continue; }
        if (x < lo[0]) lo[0] = x; else if (x > hi![0]) hi![0] = x;
        if (y < lo[1]) lo[1] = y; else if (y > hi![1]) hi![1] = y;
        if (z < lo[2]) lo[2] = z; else if (z > hi![2]) hi![2] = z;
      }
    }
    meshBounds = lo && hi ? [lo, hi] : null;
  };

  const pushMeshes = () => {
    meshes = [...meshGroups.values()].flat();
    computeMeshBounds();
    if (!scene) { rebuild3d(); return; }
    if (syncSceneBox()) { rebuild3d(); return; }
    scene.setMeshes(meshes);
    // The surfaces are usually the largest thing in the view and often the ONLY thing with real
    // extent, so arriving is exactly the "content changed" this test is for. fitCamera3D draws.
    if (!refitIfContentChanged()) a3d.refresh();
  };

  const sliceIn3D = new Map<string, { tex: GPUTexture; w: number; h: number }>();
  const sliceQuads = new Map<string, SliceQuad>();
  const sliceFieldKey = (cell: string) => "slice3d:" + cell;
  /**
   * The texture resolution for a cell's slice in 3D: ONE TEXEL PER VOXEL of the volume's finest
   * spacing, capped.
   *
   * Deliberately derived from the DATA and not from the screen. Ron: "remember, some users have
   * other dimensions" -- a figure picked to suit one monitor is wrong on every other one, and it
   * would also make the baked outline width mean "1.5 pixels of somebody's display". At one texel
   * per voxel the outline means "the boundary voxel", which is the same on every machine. (Slicer's
   * separate UVW stack exists so its 3D texture COULD be run coarser than the 2D view, but that was
   * a concession to the hardware of the time, not a target to copy.)
   */
  const sliceTexSize = (c: SliceCell): { w: number; h: number } => {
    const bg = bgField(c); if (!bg) return { w: 512, h: 512 };
    const { uvec, vvec } = c.slice.patientFrame();
    const mm = Math.max(bg.sampleStep(), 0.05);
    const cap = 2048;                                 // a huge FOV must not allocate without bound
    const n = (v: Vec3) => Math.max(16, Math.min(cap, Math.ceil(Math.hypot(v[0], v[1], v[2]) / mm)));
    return { w: n(uvec), h: n(vvec) };
  };
  /** Render a cell's composite into its 3D texture and re-point the quad at the frame it used. */
  const renderSliceIn3D = (cell: string) => {
    const e = sliceIn3D.get(cell), c = cells.get(cell);
    if (!e || !c || !bgField(c) || !c.plane) return;
    // Called ONLY from paintSlice: the renderer is configured for this cell -- paintSlice() just called applyLayers and
    // applyPlane -- so this is the same pipeline and the same bindings, drawn once more with the
    // patient-space frame instead of the user's zoomed one.
    // AND SIZED HERE, where the renderer knows the volume and the plane. Sized when the slice was switched on -- during
    // a scene restore, before the view had its volume -- it came out at the 16-texel floor and stayed there: Ron's
    // restored CTPA scene showed the coronal slice in 3D as blurred blocks (2026-09-24, build 17:17). The size
    // depends on the volume's extent along the plane, not on the zoom, so it changes only with the orientation or
    // the volume, and a drag allocates nothing.
    const want = sliceTexSize(c);
    if (want.w !== e.w || want.h !== e.h) { e.tex.destroy(); e.tex = c.slice.makeSliceTarget(want.w, want.h); e.w = want.w; e.h = want.h; }
    const view3 = e.tex.createView();
    const frame = c.slice.renderPatientFrameInto(view3, e.w, e.h);
    drawExtraOverlays(c.slice, view3, e.w, e.h);
    sliceQuads.set(cell, { id: sliceFieldKey(cell), tex: e.tex, opacity: 1, ...frame });
    scene?.setSliceQuads([...sliceQuads.values()]);
  };
  /** Toggle a cell's slice in the 3D view. */
  const setSliceIn3D = (cell: string, on: boolean) => {
    const c = cells.get(cell); if (!c) return;
    if (!on) {
      const e = sliceIn3D.get(cell);
      if (e) { sliceIn3D.delete(cell); sliceQuads.delete(cell); scene?.setSliceQuads([...sliceQuads.values()]); e.tex.destroy(); a3d.refresh(); }
      // Off is written too: only "on" was, so a view turned off still said visibleIn3D and a saved scene put it back.
      const node = live.nodes.get(nativeSliceId(cell)); if (node?.visibleIn3D) live.write({ op: "patch", id: node.id, path: "#/visibleIn3D", value: false });
      return;
    }
    if (!bgField(c)) return;
    const { w, h } = sliceTexSize(c);
    const old = sliceIn3D.get(cell);
    // Drawn by the cell's own paint, where the renderer holds this cell's current layers and plane: drawn here
    // it could still hold a closed scene's destroyed textures (critic, 2026-09-24, steve-merge findings 1-2).
    if (old && old.w === w && old.h === h) { renderSlice(c); return; }
    old?.tex.destroy();
    // The RENDERER allocates it, so the format cannot be got wrong here. It is *-srgb, so the slice
    // shader's composite in physical light is re-encoded on write and decoded again on the quad's
    // sample: what the quad reads is the linear color the 3D pass wants, with no correction.
    const tex = c.slice.makeSliceTarget(w, h);
    sliceIn3D.set(cell, { tex, w, h });
    renderSlice(c);
    const node = live.nodes.get(nativeSliceId(cell)); if (node) live.write({ op: "patch", id: node.id, path: "#/visibleIn3D", value: true });
  };
  /** Re-render every slice in 3D (called after an offset/geometry/composite change). */
  const refreshSlicesIn3D = () => {
    // MARKED, not drawn here: the cell's paint draws its slice in 3D once, with the current plane and layers.
    // Drawn here it came first with the previous plane, and after a close with destroyed textures -- a false
    // "views have stopped drawing" dialog nine times (critic, 2026-09-24, steve-merge findings 1-2).
    for (const cell of sliceIn3D.keys()) { const c = cells.get(cell); if (c) renderSlice(c); }
  };
  /**
   * A cell now showing a DIFFERENT volume.
   *
   * This used to rebuild the 3D pipeline, because SlicePlaneField baked the volume texture into a
   * bind group. The quad's texture is our own render target and never changes identity, so a new
   * volume is just new contents -- except for the resolution, which follows the new volume's
   * spacing, so it goes through setSliceIn3D to resize when it has to.
   */
  const restageSlicesIn3D = () => {
    for (const cell of [...sliceIn3D.keys()]) setSliceIn3D(cell, true);
  };

  /** Reformat a native slice cell to a standard orientation through its current centre
   *  (vtkMRMLSliceNode::SetOrientation): rebuild the plane, update the cell's orientation so fit/offset math
   *  follow, re-render, and broadcast to linked views. */
  const reformatCell = (cell: string, orientation: Orientation): boolean => {
    const id = nativeSliceId(cell); const node = live.nodes.get(id); if (!node) return false;
    const m = node.sliceToRAS as number[]; const center: Vec3 = [m[3], m[7], m[11]];
    const nm = reformatSliceToRAS(orientation, center);
    const nrm = normalOfMatrix(nm);
    const c = cells.get(cell); if (c) c.orientKey = orientation;
    live.write({ op: "patch", id, path: "#/sliceToRAS", value: nm });
    live.write({ op: "patch", id, path: "#/orientation", value: orientation[0].toUpperCase() + orientation.slice(1) });
    live.write({ op: "patch", id, path: "#/offset", value: center[0] * nrm[0] + center[1] * nrm[1] + center[2] * nrm[2] });
    if (c) { const bg = bgField(c); if (bg) { const [lo, hi] = bg.aabb(); const w = c.canvas.width || 1, h = c.canvas.height || 1; const [fx, fy] = fitFovToVolume(orientation, lo, hi, [], w, h); c.slice.setMirrorFrame(orientation, center, fx, fy); c.branched = false; } }
    propagateLink(cell, ["Orientation"]);
    renderSlices();
    refreshSlicesIn3D();
    return true;
  };

  /**
   * THE HEART'S PLANES -- short axis, four-chamber, two-chamber -- from a segmentation of the
   * chambers in the scene (logic/cardiac-axes.ts). Offered in every slice controller's orientation
   * menu beside Axial/Coronal/Sagittal, because that menu is where a plane is chosen; a heart
   * segmentation makes them available, and the axes are computed once per labelmap.
   */
  const cardiacCache = new Map<string, Promise<CardiacAxes | null>>();
  const cardiacSegmentation = (): MrsonNode | undefined =>
    [...live.nodes.values()].find((n) => n.type === "segmentation" && n.zarr && findCardiacLabels((n.segments as { labelValue: number; name?: string }[] | undefined) ?? []));
  const cardiacAvailable = () => !!cardiacSegmentation();
  const cardiacAxesFor = (seg: MrsonNode): Promise<CardiacAxes | null> => {
    const key = `${seg.id}|${JSON.stringify(seg.zarr)}`;
    let p = cardiacCache.get(key);
    if (!p) {
      p = (async () => {
        const labels = findCardiacLabels((seg.segments as { labelValue: number; name?: string }[] | undefined) ?? []);
        if (!labels) return null;
        const zv = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as ZarrDesc);
        const dims = seg.dims as [number, number, number];
        const ijkToRAS = rowMul(worldForNode(seg, live.nodes), seg.ijkToRAS as number[]);
        const axes = cardiacAxes(zv.data as unknown as ArrayLike<number>, dims, ijkToRAS, labels);
        if (axes) cardiacReady.set(key, axes);
        return axes;
      })();
      cardiacCache.set(key, p);
    }
    return p;
  };
  const cardiacReformat = async (cell: string, view: CardiacView): Promise<boolean> => {
    const id = nativeSliceId(cell); const node = live.nodes.get(id); if (!node) return false;
    const seg = cardiacSegmentation(); if (!seg) { cfg.onStatus?.("no heart segmentation in the scene — the cardiac planes need the chambers"); return false; }
    cfg.onStatus?.("finding the heart's axes…");
    const axes = await cardiacAxesFor(seg);
    if (!axes) { cfg.onStatus?.(`the heart's axes could not be found in ${seg.name}`); return false; }
    const plane = cardiacPlane(axes, view);
    const m = planeToSliceToRAS(plane);
    const c = cells.get(cell);
    // pan/zoom live per anatomical slot; an oblique plane borrows the slot of its nearest axis
    const ax = [Math.abs(plane.n[0]), Math.abs(plane.n[1]), Math.abs(plane.n[2])];
    if (c) c.orientKey = ax[2] >= ax[0] && ax[2] >= ax[1] ? "axial" : ax[1] >= ax[0] ? "coronal" : "sagittal";
    // A field of view that frames the heart: twice its length for the long-axis views, a little
    // less for the short axis, which shows one cross-section of it.
    const fov = view === "short-axis" ? axes.length * 1.6 : axes.length * 2.0;
    live.write({ op: "patch", id, path: "#/sliceToRAS", value: m });
    live.write({ op: "patch", id, path: "#/orientation", value: view });
    live.write({ op: "patch", id, path: "#/offset", value: plane.origin[0] * plane.n[0] + plane.origin[1] * plane.n[1] + plane.origin[2] * plane.n[2] });
    live.write({ op: "patch", id, path: "#/fieldOfView", value: [fov, fov, 1] });
    if (c) c.branched = false;
    const label = CARDIAC_VIEWS.find((v) => v.id === view)?.label ?? view;
    cfg.onStatus?.(`${cell}: ${label} — long axis ${axes.length.toFixed(0)} mm from the mitral valve to the apex (Cerqueira 2002)`);
    renderSlices();
    refreshSlicesIn3D();
    return true;
  };
  /** The axes once found, for the synchronous callers (the slider's range). */
  const cardiacReady = new Map<string, CardiacAxes>();
  const cardiacRange = (c: SliceCell): { min: number; max: number; step: number } | null => {
    const node = live.nodes.get(nativeSliceId(c.name));
    const view = node?.orientation as string | undefined;
    if (!view || !CARDIAC_VIEWS.some((v) => v.id === view)) return null;
    const seg = cardiacSegmentation(); if (!seg) return null;
    const axes = cardiacReady.get(`${seg.id}|${JSON.stringify(seg.zarr)}`); if (!axes) return null;
    const plane = cardiacPlane(axes, view as CardiacView);
    const o = plane.origin[0] * plane.n[0] + plane.origin[1] * plane.n[1] + plane.origin[2] * plane.n[2];
    const reach = view === "short-axis" ? axes.reach.shortAxis : view === "four-chamber" ? axes.reach.fourChamber : axes.reach.twoChamber;
    const margin = 3;
    const step = bgField(c)?.sampleStep() ?? 1;
    return { min: o - reach - margin, max: o + reach + margin, step: step || 1 };
  };
  /**
   * THE HEART'S PLANES BY DEFAULT. When a segmentation of the chambers arrives, the three slice
   * views that are still on the body's axes take the heart's: short axis in the red view, the
   * four-chamber in the green, the two-chamber in the yellow -- cardiac imaging is read in these,
   * and Ron asked for them as the default. A view a person has already set to something else
   * is left alone, and this runs once per segmentation, not on every step of the sequence.
   */
  const cardiacDefaulted = new Set<string>();
  // A SAVED SCENE'S PLANES WIN. While a scene is being loaded (and until its segmentations are gone) the default
  // stays out: a coronal green view looks untouched -- coronal is its default -- so the chambers arriving turned the
  // scene's coronal view into the four-chamber one (Ron, 2026-09-24 17:06:08).
  let cardiacHeld = false;
  const cardiacDefaults = () => {
    if (cardiacHeld) return;
    const seg = cardiacSegmentation(); if (!seg) return;
    const key = `${seg.id}|${JSON.stringify(seg.zarr)}`;
    if (cardiacDefaulted.has(key)) return;
    cardiacDefaulted.add(key);
    const wanted: Record<string, CardiacView> = { axial: "short-axis", coronal: "four-chamber", sagittal: "two-chamber" };
    for (const c of cells.values()) {
      const node = live.nodes.get(nativeSliceId(c.name)); if (!node) continue;
      const cur = node.orientation as string | undefined;
      if (cur && CARDIAC_VIEWS.some((v) => v.id === cur)) continue;
      const v = wanted[c.orientKey]; if (v) void cardiacReformat(c.name, v);
    }
  };
  /**
   * THREE SLICES FROM A LINE MARKUP (logic/line-axes.ts). Ron, 2026-09-25: "I could provide two markups for orienting
   * three oblique slices (same philosophy as with the heart). The two markups would define the axis." A Line markup's
   * two points are the axis: across it, and along it twice at 90 degrees. The slices follow the points when they move.
   */
  type Vec3L = [number, number, number];
  const lineMarkups = () => [...live.nodes.values()].filter((n) => n.type === "markup" && n.markupType === "line" && ((n.controlPoints as unknown[] | undefined)?.length ?? 0) >= 2);
  const lineAxesOf = (markupId: string) => {
    const cps = live.nodes.get(markupId)?.controlPoints as { position: Vec3L }[] | undefined;
    return cps && cps.length >= 2 ? lineAxes(cps[0].position, cps[1].position) : null;
  };
  const lineReformat = (cell: string, markupId: string, view: LineView, quiet = false): boolean => {
    const id = nativeSliceId(cell); if (!live.nodes.get(id)) return false;
    const ax = lineAxesOf(markupId);
    if (!ax) { if (!quiet) cfg.onStatus?.("the line needs two points before it can orient the slices"); return false; }
    const plane = linePlane(ax, view);
    const c = cells.get(cell);
    // pan/zoom live per anatomical slot; an oblique plane borrows the slot of its nearest axis (as the heart's do)
    const an = [Math.abs(plane.n[0]), Math.abs(plane.n[1]), Math.abs(plane.n[2])];
    if (c) c.orientKey = an[2] >= an[0] && an[2] >= an[1] ? "axial" : an[1] >= an[0] ? "coronal" : "sagittal";
    const fov = lineFieldOfView(ax, view);
    live.write({ op: "patch", id, path: "#/sliceToRAS", value: planeToSliceToRAS(plane) });
    live.write({ op: "patch", id, path: "#/orientation", value: lineOrientation(markupId, view) });
    live.write({ op: "patch", id, path: "#/offset", value: plane.origin[0] * plane.n[0] + plane.origin[1] * plane.n[1] + plane.origin[2] * plane.n[2] });
    live.write({ op: "patch", id, path: "#/fieldOfView", value: [fov, fov, 1] });
    if (c) c.branched = false;
    if (!quiet) cfg.onStatus?.(`${cell}: ${LINE_VIEWS.find((v) => v.id === view)?.label ?? view} “${String(live.nodes.get(markupId)?.name ?? "line")}” — ${ax.length.toFixed(0)} mm between its points`);
    renderSlices();
    refreshSlicesIn3D();
    return true;
  };
  /** Red across the line, yellow and green along it: the three views at once (Markups' "Align slices"). */
  const alignSlicesToLine = (markupId: string): boolean => {
    const wanted: Record<string, LineView> = { Red: "across", Yellow: "along-1", Green: "along-2" };
    let any = false;
    for (const c of cells.values()) { const v = wanted[c.name]; if (v && lineReformat(c.name, markupId, v, true)) any = true; }
    const ax = lineAxesOf(markupId);
    if (any && ax) cfg.onStatus?.(`Slices aligned to “${String(live.nodes.get(markupId)?.name ?? "line")}”: red across it, yellow and green along it — ${ax.length.toFixed(0)} mm between its points`);
    return any;
  };
  const lineRangeFor = (c: SliceCell): { min: number; max: number } | null => {
    const lo = parseLineOrientation(live.nodes.get(nativeSliceId(c.name))?.orientation as string | undefined);
    if (!lo) return null;
    const ax = lineAxesOf(lo.markupId); return ax ? lineRange(ax, lo.view) : null;
  };
  // THE SLICES FOLLOW THE POINTS: a line that moves re-orients every view set to it.
  const lineSeen = new Map<string, string>();
  live.subscribe((ch) => {
    const mid = (ch as { id?: string }).id;
    if (!mid || (ch as { type?: string }).type !== "markup") return;
    const cps = JSON.stringify(live.nodes.get(mid)?.controlPoints ?? null);
    if (lineSeen.get(mid) === cps) return;
    lineSeen.set(mid, cps);
    for (const c of cells.values()) {
      const lo = parseLineOrientation(live.nodes.get(nativeSliceId(c.name))?.orientation as string | undefined);
      if (lo?.markupId === mid) lineReformat(c.name, mid, lo.view, true);
    }
  });
  /** What the controller shows as the orientation: a cardiac plane or a line's plane by name, else the anatomical axis. */
  const orientationShown = (c: SliceCell): string => {
    const o = live.nodes.get(nativeSliceId(c.name))?.orientation as string | undefined;
    return o && (CARDIAC_VIEWS.some((v) => v.id === o) || parseLineOrientation(o)) ? o : c.orientKey;
  };

  const NORMAL_OF = (c: SliceCell): Vec3 => c.plane?.basis ? c.plane.basis.nDir : c.orientKey === "axial" ? [0, 0, 1] : c.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
  /** A slice cell's current offset (mm along its normal), its [min,max,step] range, and a setter — the
   *  slice controller bar's data source. Works for native (node-owned) and peer (patched) cells. */
  const getSliceOffset = (cell: string): number | null => { const c = cells.get(cell); return c?.plane ? c.plane.posMm : null; };
  const sliceOffsetRange = (cell: string): { min: number; max: number; step: number } | null => {
    const c = cells.get(cell); const bg = c ? bgField(c) : null; if (!c || !bg) return null;
    const [lo, hi] = bg.aabb(), n = NORMAL_OF(c);
    // A HEART PLANE RUNS THE HEART, NOT THE SCAN: from the plane through the heart's middle as
    // far as the labeled heart reaches either side, so the slider starts centered and its two
    // ends are the two ends of the heart. Ron: "initial slice view in the center of the slider."
    const heart = cardiacRange(c);
    if (heart) return heart;
    const alongLine = lineRangeFor(c);
    if (alongLine) return { ...alongLine, step: bgField(c)?.sampleStep() ?? 1 };
    // The extent of the box ALONG THE NORMAL: all eight corners projected, not the two extreme
    // ones -- for an oblique plane (the heart's short axis) the minimum corner's projection is
    // not the minimum, the range collapsed, and the slider sat at its end with the slice outside it.
    let a = Infinity, b = -Infinity;
    for (let k = 0; k < 8; k++) {
      const d = (k & 1 ? hi[0] : lo[0]) * n[0] + (k & 2 ? hi[1] : lo[1]) * n[1] + (k & 4 ? hi[2] : lo[2]) * n[2];
      if (d < a) a = d; if (d > b) b = d;
    }
    // step = the spacing along the normal (Slicer's GetSliceOffsetRangeResolution): the voxel size of the
    // volume axis most parallel to the slice normal (so a 1.3mm sagittal steps 1.3mm, a 1mm axial steps 1mm).
    let step = (bg as { stepMm?: number }).stepMm ?? 1;
    const comp = [...live.nodes.values()].find((nd) => nd.type === "sliceComposite" && nd.layoutName === c.name);
    const imgId = ((comp?.refs as Record<string, string[]> | undefined)?.background ?? [])[0];
    const m = imgId ? (live.nodes.get(imgId)?.ijkToRAS as number[] | undefined) : undefined;
    if (m) { let bestDot = 0; for (let ax = 0; ax < 3; ax++) { const dx = m[ax], dy = m[4 + ax], dz = m[8 + ax]; const sp = Math.hypot(dx, dy, dz) || 1; const dot = Math.abs((dx * n[0] + dy * n[1] + dz * n[2]) / sp); if (dot > bestDot) { bestDot = dot; step = sp; } } }
    return { min: Math.min(a, b), max: Math.max(a, b), step: step || 1 };
  };
  /**
   * Fit this slice view to its volume — the bar's ⤢ button.
   *
   * THE FITTED FRAME HAS TO REACH THE NODE, not just the renderer. The node is the authority:
   * applyPlane re-applies `plane.centerRAS/fovX/fovY` on every render whenever the cell is not
   * mid-drag. So setting the renderer's frame and then rendering wrote the fit and threw it away
   * one line later, restoring whatever pan and zoom the node still held. The slice offset moved --
   * that goes through patchNativeOffset, which does write to the node -- and nothing else did, so
   * the button looked like it half-worked. Ron: "recenter button in the slice views doesnt seem to
   * work."
   *
   * pushSliceFrame is the existing path for "the local frame is now the truth" (a pan or zoom ends
   * with it); fitting is the same statement, so it uses the same path.
   */
  const fitCell = (cell: string): void => {
    const c = cells.get(cell), bg = c ? bgField(c) : null; if (!c || !bg) return;
    const [lo, hi] = bg.aabb();
    frameCellTo(cell, lo, hi);
  };
  /**
   * Frame one slice cell on a RAS box: centered on it, zoomed to it, positioned through `through`
   * (a point on the slice's normal) or the box's center. fitCell is this with the volume's box;
   * the merge review uses it with the box of the two structures under review.
   */
  const frameCellTo = (cell: string, lo: Vec3, hi: Vec3, through?: Vec3): void => {
    const c = cells.get(cell); if (!c || !bgField(c)) return;
    const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const w = c.canvas.width || 1, h = c.canvas.height || 1;
    const [fx, fy] = fitFovToVolume(c.orientKey, lo, hi, [], w, h);
    const axis = c.orientKey === "axial" ? 2 : c.orientKey === "coronal" ? 1 : 0;
    patchNativeOffset(cell, (through ?? center)[axis]);
    c.slice.setMirrorFrame(c.orientKey, center, fx, fy);
    c.branched = false;
    pushSliceFrame(c);   // make the fitted frame the node's frame, or the next render undoes it
    renderSlice(c);
  };
  /** Frame the 3D view on a RAS box, keeping the view direction (fitCamera3D with a given box). */
  const fitCameraTo = (lo: Vec3, hi: Vec3): void => {
    const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const radius = Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    let dx = camera.position[0] - camera.focalPoint[0], dy = camera.position[1] - camera.focalPoint[1], dz = camera.position[2] - camera.focalPoint[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= len; dy /= len; dz /= len; }
    const aspect = three.canvas.height > 0 ? three.canvas.width / three.canvas.height : 1;
    const dist = fitDistance(radius, camera.viewAngle, aspect);
    camera.focalPoint = [...center] as Vec3;
    camera.position = [center[0] + dx * dist, center[1] + dy * dist, center[2] + dz * dist];
    camera.orthogonalizeViewUp();
    camera.parallelScale = fitParallelScale(radius, aspect);
    a3d.draw(); pushCamera(); sync.flush();
  };
  const setSliceOffset = (cell: string, mm: number): void => {
    const c = cells.get(cell); if (!c) return;
    noteSliderStep(cell, mm);
    if (patchNativeOffset(cell, mm)) return;                       // node-owned: sticks + re-renders via the DM
    if (!c.plane) return;
    c.plane.posMm = mm;
    const id = sliceNodeId(cell);
    if (id) live.write({ op: "patch", id, path: "#/offset", value: mm });   // peer follows
    renderSlice(c);
    redrawIntersections();
  };

  /** Jump every slice cell to a RAS point (Slicer's crosshair jump) — the native half of shift-move, so a
   *  standalone scene jumps without a Slicer peer. Sets each cell's out-of-plane position to ras·normal. */
  const jumpLocal = (ras: Vec3) => {
    for (const c of cells.values()) {
      if (c.el.style.display === "none") continue;
      const n: Vec3 = c.plane?.basis ? c.plane.basis.nDir : c.orientKey === "axial" ? [0, 0, 1] : c.orientKey === "coronal" ? [0, 1, 0] : [1, 0, 0];
      const mm = ras[0] * n[0] + ras[1] * n[1] + ras[2] * n[2];
      if (patchNativeOffset(c.name, mm)) continue;                                  // node-owned: sticks + re-renders via the DM
      if (!c.plane) continue;
      c.plane.posMm = mm;
      const id = sliceNodeId(c.name);
      if (id) live.write({ op: "patch", id, path: "#/offset", value: mm });         // peer's slices follow (transient)
      renderSlice(c);
    }
  };
  // ── native markups placement (W4): the interaction node + placer state machine drive put/patch ops ──
  let markupSeq = 0;
  const nextMarkupId = () => `local-markup-${++markupSeq}`;
  const INTERACTION_ID = "local-interaction";
  const ensureInteraction = () => {
    if (!live.nodes.has(INTERACTION_ID)) live.write({ op: "put", id: INTERACTION_ID, node: { type: "interaction", id: INTERACTION_ID, name: "Interaction", mode: "viewTransform", placeNodeId: "", markupType: "", placeModePersistence: false, source: { mrmlClass: "vtkMRMLInteractionNode" }, origin: { local: true } } });
    return live.nodes.get(INTERACTION_ID)!;
  };
  /** Start Slicer Place mode for a markup type (the markups panel calls this). */
  const startPlace = (markupType: MarkupType, persistent = false) => {
    ensureInteraction();
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "place" });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/markupType", value: markupType });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeModePersistence", value: persistent });
    live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" });
  };
  const endPlace = () => { if (live.nodes.has(INTERACTION_ID)) { live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "viewTransform" }); live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" }); } };
  /** Store the type's measurements on a markup node (so the panel + annotations can show them). */
  const storeMeasurements = (id: string) => {
    const n = live.nodes.get(id); if (!n || n.type !== "markup") return;
    const t = n.markupType as MarkupType;
    const cps = ((n.controlPoints as { position: Vec3 }[] | undefined) ?? []).map((c) => c.position);
    if ((t === "curve" || t === "closedCurve") && cps.length >= 2) {
      const closed = t === "closedCurve";
      const lp = interpolateCurve(cps, closed);                          // Slicer's Cardinal-spline curve points
      live.write({ op: "patch", id, path: "#/linePoints", value: lp });  // DM renders the smooth spline
      const ms = closed
        ? [{ name: "length", value: polylineLength(lp, false), units: "mm" }, { name: "area", value: polygonArea(lp), units: "mm2" }]
        : [{ name: "length", value: polylineLength(lp, false), units: "mm" }];
      live.write({ op: "patch", id, path: "#/measurements", value: ms });
      return;
    }
    const ms = measurementsFor(t, cps, n.size as Vec3 | undefined);
    if (ms.length) live.write({ op: "patch", id, path: "#/measurements", value: ms });
  };
  /** Native placement click: create/extend the markup via the placer, update the interaction node. */
  const placeAtNative = (ras: Vec3): boolean => {
    const inter = live.nodes.get(INTERACTION_ID); if (!inter || inter.mode !== "place" || !inter.markupType) return false;
    const markupType = inter.markupType as MarkupType;
    const placeId = (inter.placeNodeId as string) || "";
    const node = placeId ? live.nodes.get(placeId) ?? null : null;
    const newId = placeId || nextMarkupId();
    const r = placeClick(markupType, node, ras, newId);
    for (const op of r.ops) live.write(op);
    storeMeasurements(r.nodeId);
    if (r.complete) {
      live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: "" });
      if (!inter.placeModePersistence) live.write({ op: "patch", id: INTERACTION_ID, path: "#/mode", value: "viewTransform" });
    } else {
      live.write({ op: "patch", id: INTERACTION_ID, path: "#/placeNodeId", value: r.nodeId });
    }
    renderSlices();
    return true;
  };
  addEventListener("resize", () => { resizeAll(); renderSlices(); a3d.refresh(); });
  Object.assign(globalThis, { __live: live, __sync: sync, __cells: () => [...cells.keys()], __overlays: () => Object.fromEntries(overlays), __viewState: () => viewState, __brush: () => ({ effect: brushEffect(), diam: brushDiameterMm() }),
    __layers: () => Object.fromEntries([...cells].map(([k, c]) => [k, { bg: !!c.layers?.background, fg: c.layers?.foreground ? [c.layers.foreground.opacity, c.layers.foreground.compositing] : null, label: c.layers?.label ? c.layers.label.opacity : null, bgLut: !!c.layers?.background?.lut }])) });
  if (cfg.connect !== false) { sync.connect(); for (const p of peers) p.connect(); }   // peer connect is opt-in (native-first); standalone by default
  // STANDALONE, THE WINDOW OWNS ITS CAMERA AND ITS 3D VIEW AS NODES (SCENE-DESIGN §4, step 1 of
  // the order of work). Connected, the peer's nodes arrive and take over as they always did.
  if (cfg.connect === false) { ensureCameraNode(); syncView3dNode(); }
  Object.assign(globalThis, {
    __peers: peers, __modules: () => [...moduleRegistry.modules.values()],
    // local (not node) slice-plane offsets per cell — the truth of a native jump/scroll (a peer-owned view
    // node can be re-asserted by the peer; pl.posMm is what the renderer actually shows)
    __cellPlanes: () => Object.fromEntries([...cells].filter(([, c]) => c.plane).map(([k, c]) => [k, c.plane!.posMm])),
    __jumpTo: (ras: Vec3) => jumpLocal(ras),
    // Which intersection line a point in a cell would grab (null = none): the drag handle's hit test,
    // exposed so it can be checked without a real mouse.
    // Force the grab highlight on (or off, with a null target) without a pointer — the same state a
    // hover sets. The Browser pane cannot deliver pointer input while it is hidden, so this is the
    // only way to see what a grab looks like.
    __hoverIntersection: (cell: string, target: string | null) => {
      const c = cells.get(cell); if (!c) return "no cell";
      intersectHover = target ? { in: c, targets: target.split(",") } : null;
      redrawIntersections();
      return { cell, target };
    },
    __pickIntersection: (cell: string, u: number, v: number, w: number, h: number) => {
      const c = cells.get(cell); if (!c) return "no cell";
      return { hit: pickIntersection(c, u, v, w, h), lines: intersectLines(c, w / h), hasPlane: !!c.plane };
    },
    // Reformat (W2): set a native slice cell to a standard orientation (vtkMRMLSliceNode::SetOrientation).
    __reformatCell: (cell: string, orientation: "axial" | "sagittal" | "coronal") => reformatCell(cell, orientation),
    /** A heart plane by name (short-axis, four-chamber, two-chamber), computed from the chambers in the scene now. */
    __cardiacReformat: (cell: string, view: string) => CARDIAC_VIEWS.some((v) => v.id === view) ? cardiacReformat(cell, view as CardiacView) : Promise.resolve(false),
    // Held while a scene loads; released when it has, with the scene's own heart segmentation marked as done, so its
    // saved planes stay and a heart segmentation added later in the session still gets the heart's planes (critic,
    // 2026-09-24 evening, finding 3: the hold was released only when every segmentation had gone).
    __alignSlicesToLine: (markupId: string) => alignSlicesToLine(markupId),
    __lineReformat: (cell: string, markupId: string, view: LineView) => lineReformat(cell, markupId, view),
    __holdCardiacDefaults: (on: boolean) => {
      cardiacHeld = on;
      if (!on) for (const n of live.nodes.values()) if (n.type === "segmentation" && n.zarr && findCardiacLabels((n.segments as { labelValue: number; name?: string }[] | undefined) ?? [])) cardiacDefaulted.add(`${n.id}|${JSON.stringify(n.zarr)}`);
    },
    // Slice linking (W2): toggle linkedControl on every sliceComposite (Slicer's link button), and read a
    // native slice node's plane/offset for tests.
    __setLinked: (on: boolean) => { for (const n of live.nodes.values()) if (n.type === "sliceComposite") live.write({ op: "patch", id: n.id, path: "#/linkedControl", value: on }); },
    __isLinked: () => [...live.nodes.values()].some((n) => n.type === "sliceComposite" && n.linkedControl),
    __sliceNode: (cell: string) => { const n = live.nodes.get(nativeSliceId(cell)); return n ? { orientation: n.orientation, offset: n.offset, sliceToRAS: n.sliceToRAS } : null; },
    __setSliceOffset: (cell: string, mm: number) => setSliceOffset(cell, mm),
    /** Frame every visible slice cell and the 3D view on a RAS box, the slices positioned through `through` (merge review). */
    __frameTo: (lo: Vec3, hi: Vec3, through?: Vec3) => {
      for (const c of cells.values()) if (c.el.style.display !== "none" && c.plane) frameCellTo(c.name, lo, hi, through);
      fitCameraTo(lo, hi);
    },
    __fitCamera3D: () => fitCamera3D(),
    __setSliceIn3D: (cell: string, on: boolean) => setSliceIn3D(cell, on),
    /**
     * PRESET THUMBNAILS OF THE ACTUAL DATA. Steve's picker (render/demos/vr-preset-menu.ts) lays out
     * canvases; this makes them: the active volume, at the current camera, drawn once per preset into
     * a small WebGPU canvas. Not canned pictures of some other study -- Ron: "Steve showed me a
     * feature in SlicerLive that brought up the presets in a popup with small volume rendering of the
     * actual data." That is bir-browser's renderPresetThumbnails, done here for slicer-app.
     *
     * ITS OWN RENDERER, NOT THE VIEW'S. The first version drew the thumbnails through `scene`, the
     * live 3D cell's SceneRenderer, at 116x116 -- and ensureTrace destroys the trace target on any
     * size change, while the adaptive cell still had a frame in flight against the 512x690 one:
     * "Destroyed texture used in a submit", and every view stopped drawing. bir-browser does the
     * same thing and survives only because its view is not an accumulating one. So the thumbnails
     * get a second SceneRenderer that shares the device and the FIELD (a field's textures are only
     * read by build) and owns its own targets. Created once, kept.
     *
     * The field's LUT is still swapped in place per preset (ImageField.setLUT is a GPU write), and
     * the LUT the volume is actually using is put back from the manager at the end.
     */
    /** What the 3D field of a volume is lit with right now -- for checking that a lighting change arrived. */
    __vrFieldShade: (imageId: string) => { const f = vol3d.get(imageId)?.field as unknown as { shade?: number[] } | undefined; return f?.shade ?? null; },
    /**
     * A PICTURE OF THE 3D VIEW AS A FILE, at any size, with the camera as it is on screen. Rendered
     * off screen by SceneRenderer.renderToRGBA (the same frame the view draws, without the chrome),
     * turned into a PNG here, and handed to the server's /_picture route, which writes it where
     * Ron's downloads go and answers with the path. A comparison of segmentations is pictures, and
     * a screenshot of the window was the only picture the app could make (Ron, 2026-09-20, the
     * sixth right rib in every network). The renderer's target is BGRA on this platform, so the
     * bytes are swizzled before they become an image.
     */
    /** The picture the ⋮ panel saves, from a script: `__savePicture(name, w, h)` is the 3D view alone at
     *  that size; `__savePicture({ only3d, panel, scale, name })` is the panel's own choices. */
    /** The 3D view as a converged PNG data URL, nothing written anywhere -- for the test browser and the
     *  critic, which must not put files into the person's Downloads. */
    __picture3d: async (w = 800, h = 600) => (await render3dTo(w, h))?.toDataURL("image/png") ?? null,
    __savePicture: (nameOrOpts: string | Partial<typeof pictureOpts> & { name?: string; width?: number; height?: number } = {}, width?: number, height?: number) =>
      typeof nameOrOpts === "string" ? savePicture({ name: nameOrOpts, only3d: true, width: width ?? 1600, height: height ?? width ?? 1600 }) : savePicture(nameOrOpts),
    __renderVrPresetThumbnails: (imageId: string): VrPresetItem[] => {
      const v = vol3d.get(imageId);
      // TWO FIELD CLASSES DRAW A VOLUME. A plain volume is an ImageField with setLUT; a volume being
      // colorized by its segmentation is a ColorizeField with setCtLUT for the CT half of it. The
      // first version knew only the first, so with Colorize on -- Ron's normal case -- it found no
      // setter, returned nothing, and the picker opened with twelve black tiles.
      const f = v?.field as (Field & { setLUT?: (l: Uint8Array) => void; setCtLUT?: (l: Uint8Array) => void }) | undefined;
      const setLut = f?.setLUT?.bind(f) ?? f?.setCtLUT?.bind(f);
      const field = f;
      const clim = vrDM.climFor(imageId);
      const restore = vrDM.currentLUT(imageId);
      if (!field || !setLut || !clim || !restore) {
        console.log(`preset thumbnails: no field=${!field} setter=${!setLut} clim=${!clim} lut=${!restore} for ${imageId}`);
        return [];
      }
      const THUMB = 116;
      thumbScene ??= new SceneRenderer(gpu, srgb);
      thumbScene.build([field]);                       // the volume alone: a clean preview
      const items: VrPresetItem[] = [];
      try {
        for (const p of CT_VR_PRESETS) {
          const c = document.createElement("canvas");
          c.width = THUMB; c.height = THUMB;
          const cxt = c.getContext("webgpu") as GPUCanvasContext | null;
          if (!cxt) continue;
          cxt.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
          setLut(lutFromTransferFunctions(p.colorTF, p.opacityTF, clim));
          thumbScene.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, THUMB, THUMB);
          thumbScene.renderToView(cxt.getCurrentTexture().createView({ format: srgb }), THUMB, THUMB);
          items.push({ name: p.name, label: p.label, canvas: c });
        }
      } finally {
        setLut(restore);
        a3d.refresh();
      }
      return items;
    },
    // The extracted surfaces, for the DICOM Surface Segmentation save. Null unless the segmentation was
    // given surface models in Generate Surface Models (the firewall), and until they are built.
    __segmentationSurfaces: (id: string) => segDM.surfacesOf(id),
    // THE ONLY WAY IN to surface models (Generate Surface Models; the firewall in livescene.ts).
    __generateSurfaces: (id: string) => segDM.generateSurfaces(id, live),
    __removeSurfaces: (id: string) => segDM.removeSurfaces(id, live),
    __surfaceState: (id: string) => segDM.surfaceState(id, live),
    // WHICH SURFACES ARE DRAWN, per segmentation: the memory report counts what is HELD, and a held
    // surface of a colored segmentation is not drawn (Ron, 2026-09-23: "Please double check that they
    // are not present").
    __solidDebug: (on: number) => { (scene as unknown as { setSolidDebug?: (v: number) => void } | undefined)?.setSolidDebug?.(on); scene?.resetAccumulation?.(); a3d.refresh(); },
    __solidGroups: () => segDM.solidReport(),
    __drawnSurfaces: () => [...meshGroups.entries()].map(([k, l]) => ({ group: k, meshes: l.filter((m) => (m as { visible?: boolean }).visible !== false).length })),
    // WHAT THIS WINDOW IS HOLDING, counted rather than guessed. The page is ended above about 4 GB
    // and the first question after every reset is "on what?" -- Ron, 2026-09-22, on a window that
    // died with one CT and four segmentations: "colorize was not used. So it should not be in
    // memory at all. One grayscale four labelmaps and surfaces."
    // THE SELF-CHECK. The report above answers "what is being held"; this answers "should it be",
    // and says so where it will be seen without anyone asking -- the session log.
    //
    // The rule it enforces: A COPY OF THE DATA IS HELD ONLY WHILE SOMETHING IS READING IT. Samples
    // that have become a texture are not being read; a cache is a convenience, never the last owner
    // of hundreds of megabytes. Two of today's three memory incidents were exactly this, and
    // neither was visible until the window died (2026-09-22).
    __memoryCheck: () => {
      const g = globalThis as unknown as { __memoryReport?: () => { rows: { what: string; mb: number }[]; totalMB: number } };
      const r = g.__memoryReport?.();
      if (!r) return "";
      // Surfaces are the one thing legitimately held: they ARE the drawing. Everything else over a
      // hundred megabytes is a copy of something that is already on the GPU.
      const held = r.rows.filter((x) => !/^surfaces of/.test(x.what) && !/the store\)$/.test(x.what) && !/the decode cache\)$/.test(x.what) && x.mb >= 100);
      // AND IT SAYS WHAT THE REST IS. "all of it drawn" was read as an all-clear on a page that was
      // holding 867 MB of chunks and 445 MB of decoded segmentations the report could not see
      // (critic, 2026-09-22, finding 2). Now that it can see them, the line names them rather than
      // calling everything that is not a copy "drawn".
      const part = (re: RegExp) => r.rows.filter((x) => re.test(x.what)).reduce((n, x) => n + x.mb, 0);
      // HELD IS NOT DRAWN. This said "surfaces being drawn" for surfaces that were only held while the
      // solid look drew the anatomy (Ron's load of 2026-09-24 02:28) -- the kind of claim Ron will not
      // take on trust any more. What is drawn is counted from what the view composes.
      const drawnSurf = [...meshGroups.entries()].filter(([k]) => k.startsWith("seg:"))
        .reduce((n, [, l]) => n + l.filter((m) => (m as { visible?: boolean }).visible !== false).length, 0);
      const where = [
        [part(/^surfaces of/), `surface models held (${drawnSurf} structures of them drawn)`],
        [part(/the store\)$/), "chunks in the store"],
        [part(/the decode cache\)$/), "segmentations kept decoded"],
      ].filter(([mb]) => (mb as number) > 0).map(([mb, what]) => `${mb} MB ${what}`).join(", ");
      const line = held.length
        ? `memory check: holding ${r.totalMB} MB (${where}), and ${held.reduce((n, x) => n + x.mb, 0)} MB of it is a copy of data that is already on the GPU — ${held.map((x) => `${x.what} (${x.mb} MB)`).join("; ")}`
        : `memory check: holding ${r.totalMB} MB: ${where || "nothing"}, and no copy of anything that is already on the GPU`;
      void fetch("/_log", { method: "POST", body: line, keepalive: true }).catch(() => {});
      // AND WHAT IS ON THE GRAPHICS CARD, which the line above cannot see (render/gpu-ledger.ts): on
      // 2026-09-23 the page's process held 12 GB, 10 GB of it graphics, while this check said 1.3 GB.
      const ledger = (globalThis as unknown as { __gpuLedgerLine?: () => string }).__gpuLedgerLine?.();
      if (ledger) void fetch("/_log", { method: "POST", body: ledger, keepalive: true }).catch(() => {});
      return ledger ? `${line}\n${ledger}` : line;
    },
    __memoryReport: () => {
      const blobs = (globalThis as unknown as { __blobStoreBytes?: () => number }).__blobStoreBytes?.() ?? 0;
      const rows = [...segDM.memoryReport(), ...vrDM.memoryReport(), ...volDM.memoryReport(), ...decodedCacheReport(),
        // THE BLOB STORE, which holds every volume and labelmap of the session as compressed chunks.
        // It was missing, and it was the largest holder on the page the report called "438 MB, all
        // of it drawn" (critic, 2026-09-22). The chunks ARE the data the application draws from, so
        // it is not waste — but a report that cannot see it is not a report.
        ...(blobs ? [{ what: "volumes and labelmaps held as chunks (the store)", mb: Math.round(blobs / 1048576) }] : []),
        // AND THE DECODED SEGMENTATIONS, kept so a second load of the same object is free. Bounded
        // at 512 MB, and also missing from the report (critic, 2026-09-22, finding 2).
        ...(segCacheBytes() ? [{ what: "segmentations kept decoded (the decode cache)", mb: Math.round(segCacheBytes() / 1048576) }] : [])];
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const total = rows.reduce((n, r) => n + r.mb, 0);
      return { rows: rows.sort((a, b) => b.mb - a.mb), totalMB: total, jsHeapMB: heap ? Math.round(heap.usedJSHeapSize / 1048576) : undefined };
    },
    // Ask for the surfaces regardless of what the 3D view is showing -- ONLY for a segmentation given
    // surface models (segDM.ensureSurfaces refuses the rest: the firewall, 2026-09-24).
    // THE LIVE SCENE, not the renderer: in this file `scene` is the SceneRenderer, and passing it here
    // was silent until the firewall read the segmentation's node from it -- then every segmentation
    // load from the DICOM browser failed with "undefined is not an object (evaluating
    // 'scene.nodes.get')" (Ron, 2026-09-24 03:10).
    __ensureSurfaces: (id: string) => segDM.ensureSurfaces(id, live),
    // The data probe, for the readout box in the sidebar (and for tests to assert against).
    __onProbe: (fn: (p: ProbeReading | null) => void) => { probeListeners.add(fn); fn(probe); return () => { probeListeners.delete(fn); }; },
    __probe: () => probe,
    __paintLog: (on?: boolean) => { if (on === true) paintLog = []; const out = paintLog ?? []; if (on === false) paintLog = null; return out; },
    __sliceIn3D: () => [...sliceIn3D.keys()],
    __sliceIn3DSize: (cell: string) => { const e = sliceIn3D.get(cell); return e ? [e.w, e.h] : null; },
    __sliceZoom: (cell: string) => { const c = cells.get(cell); return c ? c.slice.zoom(c.orientKey) : null; },
    // Markups (W4): place mode, list, delete a control point, and read a node's measurements.
    __startPlace: (markupType: MarkupType, persistent = false) => startPlace(markupType, persistent),
    __endPlace: () => endPlace(),
    __placeState: () => { const i = live.nodes.get("local-interaction"); return i ? { mode: i.mode, markupType: i.markupType, persistent: i.placeModePersistence, placeNodeId: i.placeNodeId } : null; },
    __markups: () => [...live.nodes.values()].filter((n) => n.type === "markup").map((n) => ({ id: n.id, markupType: n.markupType, name: n.name, points: ((n.controlPoints as { position: Vec3 }[] | undefined) ?? []).length, measurements: n.measurements ?? [], visible: n.visible !== false, locked: !!n.locked })),
    __removeControlPoint: (id: string, index: number) => { const n = live.nodes.get(id); if (!n) return false; const op = removeControlPointOp(n, index); if (op) { live.write(op); storeMeasurements(id); renderSlices(); return true; } live.write({ op: "del", id }); renderSlices(); return true; },
    __deleteMarkup: (id: string) => { if (live.nodes.has(id)) { live.write({ op: "del", id }); renderSlices(); return true; } return false; },
    __setMarkupProp: (id: string, prop: "visible" | "locked", value: boolean) => { if (live.nodes.has(id)) { live.write({ op: "patch", id, path: `#/${prop}`, value }); renderSlices(); return true; } return false; },
    // RENAME A MARKUP (Ron, 2026-09-25: "I would like to rename it from F to tail of the pancreas"). The views show each
    // point's own label; a label still the automatic one ("F-1") follows the new name -- the name alone for a single
    // point, name-N for several -- and a label someone typed is kept.
    __renameMarkup: (id: string, name: string) => {
      const n = live.nodes.get(id);
      const to = name.trim();
      if (!n || n.type !== "markup" || !to) return false;
      const from = String(n.name ?? "");
      const cps = (n.controlPoints as { label?: string }[] | undefined) ?? [];
      const auto = (l: string | undefined, i: number) => !l || l === `${from}-${i + 1}` || (cps.length === 1 && l === from);
      const relabeled = cps.map((c, i) => auto(c.label, i) ? { ...c, label: cps.length === 1 ? to : `${to}-${i + 1}` } : c);
      live.write({ op: "patch", id, path: "#/name", value: to });
      if (cps.length) live.write({ op: "patch", id, path: "#/controlPoints", value: relabeled });
      renderSlices(); a3d.refresh();
      return true;
    },
    __setGlyphScale: (scale: number) => { for (const n of live.nodes.values()) if (n.type === "markup") live.write({ op: "patch", id: n.id, path: "#/glyphScale", value: scale }); renderSlices(); },
    __glyphScale: () => { const m = [...live.nodes.values()].find((n) => n.type === "markup"); return (m?.glyphScale as number) ?? 3; },
  });
  return {
    live, sync, resize() { resizeAll(); renderSlices(); a3d.refresh(); }, setCells,
    // W2: frame a volume in every slice cell (vtkMRMLSliceLogic::FitSliceToVolumes) — used on a native load
    // and by the controller "fit" button; the mirrored plane path (setMirrorFrame) still wins when a Slicer
    // peer streams a slice frame, so this only takes effect for standalone/native scenes.
    fitVolume(rasLo: Vec3, rasHi: Vec3, ijkToRAS: number[]) {
      const center: Vec3 = [(rasLo[0] + rasHi[0]) / 2, (rasLo[1] + rasHi[1]) / 2, (rasLo[2] + rasHi[2]) / 2];
      if (!sync.transport.isOpen) { ensureNativeSlices(rasLo, rasHi, ijkToRAS, center); return; }   // standalone: node-owned planes
      for (const c of cells.values()) {                                                             // peer: transient mirror frame
        if (c.el.style.display === "none") continue;
        const w = c.canvas.width || 1, h = c.canvas.height || 1;
        const [fovX, fovY] = fitFovToVolume(c.orientKey, rasLo, rasHi, ijkToRAS, w, h);
        c.slice.setMirrorFrame(c.orientKey, center, fovX, fovY);
      }
      renderSlices();
    },
    // numeric state for tests (render/introspect.ts): the 3D camera as a vtkCamera-comparable pose
    camera: () => ({ position: [...camera.position] as Vec3, focalPoint: [...camera.focalPoint] as Vec3, viewUp: [...camera.viewUp] as Vec3, viewAngle: camera.viewAngle }),
    cells: () => [...cells.keys()],
    getSliceOffset, setSliceOffset, sliceOffsetRange, setSliceIn3D, sliceIn3D: () => [...sliceIn3D.keys()],
    /** Subscribe to the data probe. Called with null when the pointer leaves the data. */
    onProbe: (fn: (p: ProbeReading | null) => void) => { probeListeners.add(fn); fn(probe); return () => { probeListeners.delete(fn); }; },
    setSliceIntersections: (on: boolean) => { sliceIntersections = on; renderSlices(); },
    resetCamera3D, fitCamera3D, setOrthographic, isOrthographic: () => camera.parallelProjection,
    sliceIntersectionLines: (cell: string) => {
      const c = cells.get(cell); if (!c) return [];
      return intersectLines(c, c.overlay.width / c.overlay.height);
    },
    orientationOf: (cell: string) => cells.get(cell)?.orientKey ?? null,
    fitCell,
  };
}
