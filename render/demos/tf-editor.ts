// "Volume Rendering" panel + transfer-function editor (W3): enable VR on the active scalar volume, apply a
// Slicer CT VR preset, and edit the scalar-opacity curve on a canvas (drag handles, click to add, dbl-click
// to remove). Everything patches a `transferFunction` node (colorStops + scalarOpacity) and a
// `volumeRenderingDisplay` node through the LiveScene, so VolumeRenderingDisplayableManager.reLUT() rebuilds
// the LUT and the 3D view updates. One shared transferFunction node, and one volumeRenderingDisplay
// node PER VOLUME, so several volumes can be rendered at once. Plain DOM, theme.css. RAS/geometry-free.
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { currentFrames } from "../../logic/sequences.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { CT_VR_PRESETS, type CtVrPreset } from "../ct-vr-presets.ts";
import { LIGHT_PRESETS, lightPresetOf } from "../light-presets.ts";
import { openVrPresetMenu, type VrPresetItem } from "./vr-preset-menu.ts";
// The fallback for the unlabeled-body slider comes from the preset rather than being restated
// here: a literal in this file is how the slider ends up disagreeing with what was rendered.
import { DEFAULT_PRESENTATION, presentationParams } from "../../logic/presentation.ts";
import { looksLikeHounsfield, windowLevelPreset } from "../window-level-preset.ts";
import { type Look3D, vrNodeOf } from "../look3d.ts";
import { cssToken } from "../css-token.ts";

export interface TfEditorOpts { live: LiveScene; onStatus?: (s: string) => void; }

interface ColorStop { value: number; rgba: [number, number, number]; }
interface OpacityStop { value: number; opacity: number; }

/** ONE `transferFunction` NODE PER VOLUME, named after the volume it describes.
 *
 * Shared was wrong the moment two volumes could render at once: an MR head under the CT preset the
 * CT was using came out a solid black box, because a CT transfer function's stops are Hounsfield
 * units and MR intensities are not. Slicer has a volume property per display node; so does this. */
export const tfIdFor = (imageId: string) => `local-transferFunction-${imageId}`;

const tfNodeFor = (id: string): MrsonNode =>
  ({ type: "transferFunction", id, name: "VR transfer function", colorStops: [], scalarOpacity: [], source: { mrmlClass: "vtkMRMLVolumePropertyNode" }, origin: { local: true } }) as unknown as MrsonNode;

/**
 * The volume's transferFunction node, made if it is not there yet.
 *
 * Pulled out so anything that wants to set a colorize parameter -- the AI panel applying a
 * presentation preset, say -- does not have to re-derive this module's node ids or duplicate the
 * make-if-absent step. The panel used to be the only writer; it is not any more.
 */
export function ensureTransferFunction(live: LiveScene, imageId: string): string {
  const id = tfNodeIdFor(live, imageId);
  if (!live.nodes.get(id)) live.write({ op: "put", id, node: tfNodeFor(id) });
  return id;
}

/**
 * Set colorize parameters on a volume -- `contextOpacity`, `ctModulation`, `segmentOpacity`.
 *
 * One patch per key, which is what the renderer already listens for, so this is exactly what moving
 * the sliders in Volume Rendering does. That equivalence is the point: a preset must not be able to
 * put the scene somewhere the user cannot then reach by hand.
 */
export function setColorizeParams(live: LiveScene, imageId: string, params: Record<string, number | number[]>): void {
  const id = ensureTransferFunction(live, imageId);
  for (const [key, value] of Object.entries(params)) live.write({ op: "patch", id, path: `#/${key}`, value });
}

/** One colorize parameter as the scene currently holds it, or `dflt` when it has never been set. */
export function colorizeParamOf(live: LiveScene, imageId: string, key: string, dflt: number): number {
  const v = live.nodes.get(tfNodeIdFor(live, imageId))?.[key] as number | undefined;
  return typeof v === "number" ? v : dflt;
}

/**
 * ONE `volumeRenderingDisplay` NODE PER VOLUME, named after the volume it renders.
 *
 * It used to be a single node for the whole scene, repointed at whichever volume was being turned
 * on -- which is why turning 3D on for a second CT turned it off for the first: there was one slot
 * and the toggle moved it. Slicer has a display node per volume, and the renderer here composites
 * a list of fields, so nothing but this id forced the singleton.
 */
export const vrIdFor = (imageId: string) => `local-volumeRenderingDisplay-${imageId}`;

/**
 * Turn 3D volume rendering on or off for one image -- the one thing Subject Hierarchy's own 3D
 * toggle needs, pulled out so it does not have to re-derive this module's node ids by hand.
 *
 * The transfer function stays shared (one `transferFunction` node): two CTs looking the same under
 * one preset is the wanted behavior, and it is what the panel edits.
 */
/**
 * The display node rendering this image -- BY REFERENCE, not by name. A display is named after
 * the volume it was made for, but a sequence's display travels: the frame manager repoints one
 * display at whichever frame is on screen, so the display named for frame 1 renders frame 3 a
 * moment later. Asking by name made every frame but the first read as "3D off" -- the Scene
 * row's 3D button blinked once per loop (Ron: "most of the time off sometime on") -- and the
 * Volume Rendering module created a second display for the frame it thought had none.
 */
export function vrNodeFor(live: LiveScene, imageId: string): MrsonNode | undefined {
  for (const n of live.nodes.values()) {
    if (n.type === "volumeRenderingDisplay" && ((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] === imageId) return n;
  }
  return undefined;
}
/** The transfer function a display reads, else the one named for the image. */
export function tfNodeIdFor(live: LiveScene, imageId: string): string {
  return ((vrNodeFor(live, imageId)?.refs as Record<string, string[]> | undefined)?.property ?? [])[0] ?? tfIdFor(imageId);
}

/**
 * A NAMED PRESET ONTO A VOLUME'S TRANSFER FUNCTION, from outside the editor: the color and opacity
 * stops, the preset's name, and its lighting (see applyPreset in the editor for why the light
 * vector is taken directly). Turns the rendering on. The editor's own applyPreset does the same and
 * also pins its axis; a look (render/demos/looks.ts) has no axis to pin.
 */
export function applyVrPreset(live: LiveScene, imageId: string, presetName: string): boolean {
  // A CT PRESET ON WHAT IS NOT CT draws stripes and nothing (its stops are Hounsfield units;
  // an MR head's values are elsewhere): Ron, 2026-09-20, on the colorized MR brain, "looks worse
  // than before". Not-CT gets the ramp from its own window/level, as the editor starts it.
  const img = live.nodes.get(imageId);
  const disp = [...live.nodes.values()].find((n) => n.type === "scalarVolumeDisplay" && ((img?.refs as Record<string, string[]> | undefined)?.display ?? []).includes(n.id));
  const modality = (img?.origin as { modality?: string } | undefined)?.modality;
  const range = disp?.threshold as [number, number] | undefined;
  const own = !looksLikeHounsfield(range, modality) && typeof disp?.window === "number" && typeof disp?.level === "number" ? windowLevelPreset(disp.window as number, disp.level as number) : null;
  const p = own ?? CT_VR_PRESETS.find((x) => x.name === presetName); if (!p) return false;
  const id = ensureTransferFunction(live, imageId);
  live.write({ op: "patch", id, path: "#/colorStops", value: p.colorTF.map((s) => ({ value: s[0], rgba: [s[1], s[2], s[3]] })) });
  live.write({ op: "patch", id, path: "#/scalarOpacity", value: p.opacityTF.map((s) => ({ value: s[0], opacity: s[1] })) });
  live.write({ op: "patch", id, path: "#/preset", value: own ? own.name : presetName });
  live.write({ op: "patch", id, path: "#/shade", value: [...p.light] });
  setVolumeRenderingOn(live, imageId, true);
  return true;
}

export function setVolumeRenderingOn(live: LiveScene, imageId: string, on: boolean): void {
  // ONE RENDERING PER SEQUENCE. The frames of a sequence are one volume in time; the browser moves
  // the rendering's `volume` ref from frame to frame. Asked about any frame, act on the sequence's
  // rendering wherever it points -- else each SEG load, which turns the rendering on for the frame
  // it was drawn on, made a rendering per frame: five colorize fields at once, 18 bindings, and
  // WebKit's "Generated pipeline layout is not valid" (Ron, 2026-09-14, 16 sampled textures is
  // the limit).
  const seqId = live.nodes.get(imageId)?.sequence as string | undefined;
  if (seqId) {
    for (const n of live.nodes.values()) {
      if (n.type !== "volumeRenderingDisplay") continue;
      const vol = ((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0];
      if (vol && live.nodes.get(vol)?.sequence === seqId) { live.write({ op: "patch", id: n.id, path: "#/visible", value: on }); return; }
    }
  }
  const have = vrNodeFor(live, imageId);
  if (have) { live.write({ op: "patch", id: have.id, path: "#/visible", value: on }); return; }
  const tfId = tfIdFor(imageId);
  if (!live.nodes.get(tfId)) live.write({ op: "put", id: tfId, node: tfNodeFor(tfId) });
  const id = vrIdFor(imageId);
  if (live.nodes.get(id)) {
    // Named for this image but pointed elsewhere by the frame manager: bring it back.
    live.write({ op: "patch", id, path: "#/refs/volume", value: [imageId] });
    live.write({ op: "patch", id, path: "#/visible", value: on });
    return;
  }
  live.write({
    op: "put", id,
    node: { type: "volumeRenderingDisplay", id, name: "Volume rendering", visible: on, refs: { volume: [imageId], property: [tfId] }, source: { mrmlClass: "vtkMRMLGPURayCastVolumeMapper" }, origin: { local: true } } as unknown as MrsonNode,
  });
}
/**
 * THE 3D LOOK OF ONE VOLUME, as the Scene module sets it (render/look3d.ts has the four and what they
 * mean). Written as the state the rest of the application already reads: the look on the image node,
 * the volume rendering on or off, the colored volume's flags. So a module that switches the volume
 * rendering itself still works, and the Scene module reads back what is on.
 */
export function setLook3D(live: LiveScene, imageId: string, look: Look3D): void {
  const img = live.nodes.get(imageId);
  if (!img || img.type !== "image") return;
  // A SEQUENCE HAS ONE LOOK: written on every frame, since each member segmentation reads its own
  // frame's (segLookOf) -- a look on the frame showing alone left the other phases on the old one.
  const frames = img.sequence ? [...live.nodes.values()].filter((n) => n.type === "image" && n.sequence === img.sequence) : [img];
  for (const f of frames) if (f.look3D !== look) live.write({ op: "patch", id: f.id as string, path: "#/look3D", value: look });
  const seq = !!img.sequence;
  const vrOn = volumeRenderingOn(live, imageId);
  if (look === "volume" || (look === "solid" && seq)) {
    // The volume rendered. A transfer function that has never been given a preset is empty, and an
    // empty one renders nothing: the flesh preset then (a non-CT gets the ramp from its window).
    // A SEQUENCE HAS ONE RENDERING, on whichever frame it points at, with that frame's transfer
    // function: found through it (vrNodeOf), not through this frame's own ids -- which wrote the solid
    // flag onto transfer functions nothing drew with (2026-09-23, the beating heart).
    const vr0 = vrNodeOf(live, imageId);
    const tfId0 = ((vr0?.refs as Record<string, string[]> | undefined)?.property ?? [])[0] ?? tfNodeIdFor(live, imageId);
    const tf = live.nodes.get(tfId0);
    const empty = !tf || !((tf.scalarOpacity as unknown[] | undefined)?.length);
    if (empty && !vr0) applyVrPreset(live, imageId, "Albula-Soft-Tissue");
    else if (!vrOn) setVolumeRenderingOn(live, imageId, true);
    const vr = vrNodeOf(live, imageId) ?? vrNodeFor(live, imageId);
    // Colorized only for a sequence under "solid" (the frames step together; drawn solid).
    if (vr) live.write({ op: "patch", id: vr.id, path: "#/colorize", value: look === "solid" });
    const tfId = ((vr?.refs as Record<string, string[]> | undefined)?.property ?? [])[0] ?? tfNodeIdFor(live, imageId);
    if (live.nodes.get(tfId)) live.write({ op: "patch", id: tfId, path: "#/colorizeSolid", value: look === "solid" });
  } else if (vrOn) {
    setVolumeRenderingOn(live, imageId, false);
  }
}

/** Is this image 3D-volume-rendered right now? Asked per volume, since several may be. */
export function volumeRenderingOn(live: LiveScene, imageId: string): boolean {
  const seqId = live.nodes.get(imageId)?.sequence as string | undefined;
  if (seqId) {
    for (const n of live.nodes.values()) {
      if (n.type !== "volumeRenderingDisplay") continue;
      const vol = ((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0];
      if (vol && live.nodes.get(vol)?.sequence === seqId) return !!n.visible;
    }
  }
  return !!vrNodeFor(live, imageId)?.visible;
}

export function registerTfEditor(shell: AppShell, opts: TfEditorOpts): void {
  const { live } = opts;
  let activeId = "";

  const scalarVolumes = (): { imageId: string; name: string }[] => {
    const out: { imageId: string; name: string }[] = [];
    // A sequence's frames are hidden; the one on screen is offered, under the sequence's name.
    const current = currentFrames(live);
    for (const n of live.nodes.values()) {
      if (n.type !== "image" || n.labelmap) continue;
      if ((n as { hidden?: boolean }).hidden && !current.has(n.id)) continue;
      out.push({ imageId: n.id, name: current.get(n.id) ?? (n.name as string) ?? n.id });
    }
    return out;
  };
  const tfId = () => tfNodeIdFor(live, activeId);
  const tfNode = () => (activeId ? live.nodes.get(tfId()) : undefined);
  const vrNode = () => (activeId ? vrNodeFor(live, activeId) : undefined);
  /** Segmentations of the active volume — their presence is what enables colorize rendering. */
  // A segmentation on any frame of a sequence colorizes every frame (livescene `covers`), so
  // the frame on screen offers it too -- not only the frame the network happened to run on.
  const segsOfActive = () => {
    const active = live.nodes.get(activeId);
    const seqId = active?.sequence as string | undefined;
    // A segmentation sequence is listed once, as its member for the frame on screen.
    const current = currentFrames(live);
    return [...live.nodes.values()].filter((n) => {
      if (n.type !== "segmentation") return false;
      if ((n as { hidden?: boolean }).hidden && !current.has(n.id)) return false;
      const src = ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
      return src === activeId || (!!seqId && live.nodes.get(src ?? "")?.sequence === seqId);
    });
  };
  const colorizeParam = (key: string, dflt: number) => {
    const v = tfNode()?.[key] as number | undefined;
    return typeof v === "number" ? v : dflt;
  };
  const setColorizeParam = (key: string, v: number) => {
    ensureTf();
    live.write({ op: "patch", id: tfId(), path: `#/${key}`, value: v });
  };

  /**
   * The four lighting terms, exposed because diagnosing appearance by reasoning about them did not
   * work.
   *
   * Ron said the labeled voxels were "much darker in native" and guessed ambient. Finding out took
   * several wrong turns on my part -- one real bug (an unshaded preset being shaded) and one real but
   * minor contributor (the CT window). Rather than continue narrowing by hypothesis, these let the
   * person looking at the screen find it in seconds.
   *
   * They ride on the transferFunction node's `shade`, which is what the renderer already reads, so a
   * preset still sets them and these still override.
   */
  const shadeVec = (): [number, number, number, number] => {
    const v = tfNode()?.shade as number[] | undefined;
    return v && v.length === 4 ? [v[0], v[1], v[2], v[3]] : [0.2, 1.0, 0.0, 1.0];
  };
  const setShadeTerm = (i: number, val: number) => {
    ensureTf();
    const v = shadeVec();
    v[i] = val;
    live.write({ op: "patch", id: tfId(), path: "#/shade", value: v });
  };
  const setShade = (v: [number, number, number, number]) => {
    ensureTf();
    live.write({ op: "patch", id: tfId(), path: "#/shade", value: [...v] });
  };
  /** Colorize is a display setting on the volumeRenderingDisplay node. Absent means ON for a sequence
   *  and OFF for a single volume: a single volume's segmentations are drawn by the Scene module's look
   *  (Colored draws them solid without the volume); tinting it is the old see-through look, kept as a
   *  choice here (2026-09-23). */
  const colorizeOn = () => {
    const v = vrNode()?.colorize as boolean | undefined;
    return live.nodes.get(activeId)?.sequence ? v !== false : v === true;
  };
  /** The segmentation tinting the volume: the display node's choice, else the manager's default (most structures). */
  const colorizeWith = () => {
    const want = vrNode()?.colorizeWith as string | undefined;
    if (want && segsOfActive().some((s) => s.id === want)) return want;
    let best = "", n = -1;
    for (const s of segsOfActive()) { const k = ((s.segments as unknown[] | undefined) ?? []).length; if (k > n) { n = k; best = s.id; } }
    return best;
  };
  const setColorize = (on: boolean) => {
    if (!vrNode()) setVolumeRendering(activeId, true);      // the flag lives on the display node
    const id = vrNode()?.id ?? vrIdFor(activeId);
    live.write({ op: "patch", id, path: "#/colorize", value: on });
  };
  // THE ADVANCED SECTION REMEMBERS WHETHER IT WAS OPEN across the panel's own re-renders, which
  // happen on every scene change. Every panel redraws with innerHTML and forgets what the person
  // opened by hand; this one does not.
  let advancedOpen = false;
  /** Repaint the lighting buttons and sliders from the node. Set by render(). */
  let paintShade: () => void = () => {};
  /** Repaint the two on/off buttons from the scene without rebuilding the panel. Set by render(). */
  let paintToggles: () => void = () => {};

  const opacityStops = (): OpacityStop[] => (tfNode()?.scalarOpacity as OpacityStop[] | undefined)?.slice() ?? [];
  const colorStops = (): ColorStop[] => (tfNode()?.colorStops as ColorStop[] | undefined)?.slice() ?? [];

  const ensureTf = () => {
    if (!tfNode()) live.write({ op: "put", id: tfId(), node: tfNodeFor(tfId()) });
  };
  const setVolumeRendering = (imageId: string, on: boolean) => setVolumeRenderingOn(live, imageId, on);
  /**
   * The transfer function a volume should START with.
   *
   * Every entry in CT_VR_PRESETS is stated in absolute Hounsfield units, so on data that is not CT
   * every stop falls outside the values present, every voxel gets opacity 0, and the 3D view is
   * empty. Ron, on the studyforrest T1: "when I loaded the forrest data I had a black cube in the 3D
   * viewer." Slicer ships MR presets and copying them was the obvious answer; Ron: "an heuristic is
   * better as MRI signal intensities are not standardized. There is no Hounsfield units equivalent
   * in mri." So non-CT data gets a ramp built from its OWN window/level -- the pair ingest already
   * computed and the slice views were already using, which is why 2D looked right while 3D did not.
   */
  const startingPreset = (imageId: string): CtVrPreset | null => {
    const img = live.nodes.get(imageId);
    const disp = [...live.nodes.values()].find((n) =>
      n.type === "scalarVolumeDisplay" && ((img?.refs as Record<string, string[]> | undefined)?.display ?? []).includes(n.id)
    );
    const modality = (img?.origin as { modality?: string } | undefined)?.modality;
    const range = (disp?.threshold as [number, number] | undefined);
    if (looksLikeHounsfield(range, modality)) return null;      // null = use the named CT preset
    const window = disp?.window as number | undefined;
    const level = disp?.level as number | undefined;
    if (typeof window !== "number" || typeof level !== "number") return null;
    return windowLevelPreset(window, level);
  };

  /** Write one preset's stops and lighting onto a volume's transfer-function node. */
  const applyPresetObject = (imageId: string, p: CtVrPreset) => {
    forgetGain();
    const id = ensureTransferFunction(live, imageId);
    const cs: ColorStop[] = p.colorTF.map((s) => ({ value: s[0], rgba: [s[1], s[2], s[3]] as [number, number, number] }));
    const os: OpacityStop[] = p.opacityTF.map((s) => ({ value: s[0], opacity: s[1] }));
    live.write({ op: "patch", id, path: "#/colorStops", value: cs });
    live.write({ op: "patch", id, path: "#/scalarOpacity", value: os });
    live.write({ op: "patch", id, path: "#/preset", value: p.name });
    live.write({ op: "patch", id, path: "#/shade", value: [...p.light] });
  };

  const applyPreset = (imageId: string, presetName: string) => {
    const p = CT_VR_PRESETS.find((x) => x.name === presetName); if (!p) return;
    const id = ensureTransferFunction(live, imageId);
    const cs: ColorStop[] = p.colorTF.map((s) => ({ value: s[0], rgba: [s[1], s[2], s[3]] as [number, number, number] }));
    const os: OpacityStop[] = p.opacityTF.map((s) => ({ value: s[0], opacity: s[1] }));
    live.write({ op: "patch", id, path: "#/colorStops", value: cs });
    live.write({ op: "patch", id, path: "#/scalarOpacity", value: os });
    live.write({ op: "patch", id, path: "#/preset", value: presetName });
    // Lighting travels WITH the preset, as it does in Slicer and in the colorize scene: CT-Soft-Tissue
    // is matte (specular 0), CT-AAA glossy. Without this the renderer kept one hard-coded shading for
    // every preset, which is why volumes looked shinier here than in either.
    //
    // p.light DIRECTLY, and not through presetLUT.
    //
    // presetLUT honors a preset's `shade` boolean and returns [1,0,0,1] -- flat, fully ambient --
    // for anything marked unshaded, CT-Soft-Tissue included. Routing through it looked like the
    // careful thing to do and was the wrong thing: the colorize page, which is the appearance being
    // matched, calls `field.setShade(r.preset.shade)` with the light vector itself and consults no
    // such flag. For CT-Soft-Tissue that is [0.2, 1.0, 0.0, 1.0].
    //
    // So the "fix" set ambient to 1, which saturates `rgb * (ka + kd * ldotn)` before the diffuse
    // term is added -- and diffuse and specular stopped doing anything at all. Ron reported exactly
    // that. Following the reference implementation rather than reasoning about which flag ought to
    // win would have avoided it, and is what this line now does.
    live.write({ op: "patch", id, path: "#/shade", value: [...p.light] });
    // Pin the axis to this preset's own range (padded), so Shift visibly slides the curve.
    const vs = [...cs.map((c) => c.value), ...os.map((o) => o.value)];
    axisRange = [Math.min(...vs) - SHIFT_LIMIT, Math.max(...vs) + SHIFT_LIMIT];
    setVolumeRendering(imageId, true);
  };
  const setOpacityStops = (stops: OpacityStop[]) => { ensureTf(); const s = stops.slice().sort((a, b) => a.value - b.value); live.write({ op: "patch", id: tfId(), path: "#/scalarOpacity", value: s }); };
  /** Shift ALL transfer-function points (colour + opacity) by `delta` intensity units as a unit (Slicer's
   *  Volume Rendering "Shift" slider). */
  const shiftTf = (delta: number) => {
    if (!tfNode() || !delta) return;
    forgetGain();
    const cs = colorStops().map((c) => ({ ...c, value: c.value + delta }));
    const os = opacityStops().map((o) => ({ ...o, value: o.value + delta }));
    live.write({ op: "patch", id: tfId(), path: "#/colorStops", value: cs });
    live.write({ op: "patch", id: tfId(), path: "#/scalarOpacity", value: os });
  };

  /** Slide the COLOR scale alone, leaving the opacity stops where they are. Ron: "being able to
   *  slide the entire color scale left right without changing the control points." */
  const shiftColours = (delta: number) => {
    if (!tfNode() || !delta) return;
    live.write({ op: "patch", id: tfId(), path: "#/colorStops", value: colorStops().map((c) => ({ ...c, value: c.value + delta })) });
  };
  /**
   * Push the whole opacity curve up or down. Ron: "global change of opacity: pushing the transfer
   * function up or down." Multiplicative, against the stops as they were when the drag began: a
   * stop at zero stays at zero (air stays clear), a stop at one is clamped there. Held as a base
   * copy so that going past 1 and back does not flatten the curve; any other edit drops the copy.
   */
  let gainBase: OpacityStop[] | null = null;
  const forgetGain = () => { gainBase = null; };
  const setOpacityGain = (gain: number) => {
    if (!tfNode()) return;
    if (!gainBase) gainBase = opacityStops().map((o) => ({ ...o }));
    setOpacityStops(gainBase.map((o) => ({ ...o, opacity: Math.max(0, Math.min(1, o.opacity * gain)) })));
  };

  Object.assign(globalThis, {
    __vrState: (imageId?: string) => { const vr = vrNode(), tf = tfNode(); return { visible: !!vr?.visible, volume: ((vr?.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] ?? imageId, preset: tf?.preset as string | undefined, colorStops: colorStops(), scalarOpacity: opacityStops() }; },
    __setVolumeRendering: setVolumeRendering,
    __setVrPreset: applyPreset,
    __setOpacityStops: setOpacityStops,
    __shiftTf: shiftTf,
  });

  // ── UI ────────────────────────────────────────────────────────────────────
  let root: HTMLElement | null = null;
  let shiftLast = 0;   // last Shift-slider value applied (deltas move the whole TF as a unit)
  let colourShiftLast = 0;   // same, for the color-only shift
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  // VOLUME RENDERING IS ON BY DEFAULT for the first scalar volume that appears.
  //
  // Enabling it alone would show nothing: a fresh transferFunction node has empty colour/opacity
  // stops, so a preset has to come with it. DEFAULT_VR_PRESET is that choice -- change this one
  // constant to pick a different look. The status line names it so it stays discoverable.
  //
  // Auto-enabled AT MOST ONCE per session, and never when a volumeRenderingDisplay node already
  // exists, so switching it off (or choosing another preset) is not undone by the next scene change.
  // CT-Soft-Tissue: the preset the colorize scene opens with, so the two pages agree on how a CT
  // looks by default. Its lighting is matte (0.2/1.0/0.0/1.0) -- no specular at all.
  // Albula's flesh-colored Soft Tissue since 2026-09-23 (Ron: "Fleshcolor would be nice"; the body came out
  // gray under Slicer's CT-Soft-Tissue). Slicer's own stays in the menu under its own name.
  const DEFAULT_VR_PRESET = "Albula-Soft-Tissue";
  /**
   * The specular highlight the app opens with, on top of the default preset's own lighting.
   *
   * CT-Soft-Tissue publishes light [0.2, 1.0, 0.0, 1.0] -- matte, no specular at all -- which is
   * Slicer's value for that preset and is deliberately not edited here: choosing "CT Soft Tissue"
   * from the menu still gives Slicer's CT Soft Tissue. This is the APP's default look, applied when
   * volume rendering comes on by itself at load. Ron: "I would like add specular 0.20 and
   * shininess 20 to the default."
   */
  // Replaced 2026-09-23 by the Standard lighting preset: "too dark, too shiny, even standard is very shiny".
  const DEFAULT_LIGHTING = LIGHT_PRESETS.find((p) => p.name === "Standard")!;
  /**
   * A NEWLY LOADED VOLUME BECOMES THE ONE SHOWN, in 3D and on the slices alike.
   *
   * This used to enable volume rendering once, for the first scalar volume ever seen, and never
   * again. The loader meanwhile repoints the slice composites at whatever was loaded LAST. With two
   * studies open those are two different volumes, and the app showed one dataset's anatomy in 3D
   * beside another's on the slices. Ron: "when I load the four volumes I see the abomen in the 3d
   * view and the chest in the slices. Pick one pair on load and show them both in 3d and on slices."
   *
   * So loading picks the pair: this volume in 3D, this volume on the slices (the loader's own doing),
   * and any segmentation drawn on it follows automatically -- the volume-rendering manager colorizes
   * with the segmentation whose `source` is this image. Switching 3D by hand afterwards still wins;
   * the next load is what re-picks.
   */
  const shownImages = new Set<string>();
  const showOnLoad = (imageId: string) => {
    // Exactly one volume rendering on: the others stay in the scene with their own transfer
    // functions, ready to be switched back on from Subject Hierarchy.
    for (const n of live.nodes.values()) {
      if (n.type !== "volumeRenderingDisplay" || !n.visible) continue;
      if (((n.refs as Record<string, string[]> | undefined)?.volume ?? [])[0] === imageId) continue;
      live.write({ op: "patch", id: n.id, path: "#/visible", value: false });
    }
    activeId = imageId;
    // The preset comes WITH the enable: a fresh transferFunction node has empty colour/opacity
    // stops, so enabling alone would render nothing at all.
    const own = startingPreset(imageId);
    if (own) applyPresetObject(imageId, own);
    else applyPreset(imageId, DEFAULT_VR_PRESET);
    // ...and the app's own specular over the preset's ambient/diffuse. The four terms are
    // [ambient, diffuse, specular, power]; the sliders in this panel edit the same vector, so this
    // is a starting point, not a lock.
    live.write({ op: "patch", id: tfNodeIdFor(live, imageId), path: "#/shade", value: [...DEFAULT_LIGHTING.shade] });
    status(`volume rendering on (${own ? own.name : DEFAULT_VR_PRESET}, ${DEFAULT_LIGHTING.name} lighting)`);
  };
  /** First sight of a scalar volume — a load. Later upserts of the same node (window/level, a
   *  rename, a transform) must not re-pick it and undo a manual choice. */
  const seenBrowsers = new Set<string>();
  const autoEnableVr = (imageId?: string) => {
    const candidates = imageId ? [imageId] : scalarVolumes().map((v) => v.imageId);
    const current = currentFrames(live);
    for (const id of candidates) {
      const n = live.nodes.get(id);
      if (!n || n.type !== "image" || n.labelmap) continue;
      // A MAP COMPUTED FROM A SCAN (FA, Color FA: `autoVolumeRendering: false` on its node) does not take the 3D view
      // over from the scan it came from; it can still be switched on by hand in Scene.
      if ((n as { autoVolumeRendering?: boolean }).autoVolumeRendering === false) continue;
      // A sequence's frames arrive hidden, one after another; enabling each would build five
      // renderings and leave the last one on while the slices show the first. Only the frame the
      // browser has on screen is enabled -- when the browser arrives, below.
      if ((n as { hidden?: boolean }).hidden && !current.has(id)) continue;
      if (shownImages.has(id)) continue;
      shownImages.add(id);
      showOnLoad(id);
    }
  };
  // BAR is the color-transfer-function strip along the bottom. It was 5px, which reads as a hairline
  // rather than as the color ramp it is; the opacity curve is inset above it so the two do not overlap.
  const W = 260, H = 132, PAD = 6, BAR = 16;

  // The axis is FIXED once a preset is applied. Deriving it from the stops made Shift look broken:
  // shifting moves every stop by the same amount, so the axis moved with them and the drawing came
  // out pixel-identical. A stable frame is what lets a shift be seen. Padded by the slider's range
  // so a fully shifted curve stays inside the plot.
  let axisRange: [number, number] | null = null;
  const SHIFT_LIMIT = 500;
  /**
   * THE ZOOM: the part of the axis the canvas shows, as fractions 0..1 of the full range. Ron: "in MR
   * you sometimes need fine control. In Slicer we have those double headed sliders, which allow
   * zoom in on an area of the transfer function." The double-headed slider under the canvas sets
   * this; the curve keeps every stop, the canvas shows the window.
   */
  let zoom: [number, number] = [0, 1];
  function fullRange(): [number, number] {
    if (axisRange) return axisRange;
    const os = opacityStops(), cs = colorStops();
    const vals = [...os.map((s) => s.value), ...cs.map((s) => s.value)];
    if (!vals.length) return [-1000, 1000];
    return [Math.min(...vals), Math.max(...vals)];
  }
  function tfRange(): [number, number] {
    const [lo, hi] = fullRange();
    return [lo + (hi - lo) * zoom[0], lo + (hi - lo) * zoom[1]];
  }
  // ONE MAPPING between values and pixels, used by the drawing AND the hit test. They were two:
  // the drawing inset the curve above the color bar and the hit test did not, so the ring showed
  // 16 px away from where the handle was drawn, a press on the drawn handle missed it and ADDED a
  // point, and a grabbed handle jumped. Ron: "clicking on them to grab them changes the shape of
  // the mouse pointer. Because of this, I end up creating new control points accidentally."
  const X = (v: number) => { const [lo, hi] = tfRange(); return PAD + ((v - lo) / Math.max(1e-6, hi - lo)) * (W - 2 * PAD); };
  const Y = (a: number) => (H - PAD - BAR) - a * (H - 2 * PAD - BAR);
  const toVal = (px: number) => { const [lo, hi] = tfRange(); return lo + ((px - PAD) / (W - 2 * PAD)) * (hi - lo); };
  const toOpac = (py: number) => Math.max(0, Math.min(1, ((H - PAD - BAR) - py) / (H - 2 * PAD - BAR)));
  /** The grab radius: 14 px on a 260 px canvas that is drawn wider, so it is more on screen. */
  const GRAB = 14;

  /** Which opacity handle the cursor is over, or -1. Drives the hover ring in drawCurve. */
  let hoverStop = -1;

  function drawCurve(cv: HTMLCanvasElement) {
    const g = cv.getContext("2d"); if (!g) return;
    const os = opacityStops();
    g.clearRect(0, 0, W, H);
    g.fillStyle = cssToken("--sl-view-bg", "#0a0b10"); g.fillRect(0, 0, W, H);
    g.save(); g.beginPath(); g.rect(PAD, 0, W - 2 * PAD, H); g.clip();   // a zoomed-out stop stays off the plot
    // the color transfer function, as a ramp along the bottom
    const cs = colorStops();
    for (let i = 0; i < cs.length - 1; i++) {
      const c0 = cs[i], c1 = cs[i + 1];
      const grad = g.createLinearGradient(X(c0.value), 0, X(c1.value), 0);
      grad.addColorStop(0, `rgb(${c0.rgba.map((v) => Math.round(v * 255)).join(",")})`);
      grad.addColorStop(1, `rgb(${c1.rgba.map((v) => Math.round(v * 255)).join(",")})`);
      g.fillStyle = grad; g.fillRect(X(c0.value), H - BAR, Math.max(1, X(c1.value) - X(c0.value)), BAR);
    }
    g.strokeStyle = cssToken("--sl-line-strong", "rgba(255,255,255,.18)"); g.lineWidth = 1;
    g.strokeRect(PAD + 0.5, H - BAR + 0.5, W - 2 * PAD - 1, BAR - 1);
    // opacity polyline + handles
    //
    // The hovered handle is drawn large with a ring. The grab radius is 12 px while a handle is only
    // 3.5 px of ink, so without this the only way to find out whether you are on a handle is to click
    // and see whether it grabs or adds a point -- which is exactly the ambiguity that made
    // double-click-to-remove feel broken.
    g.strokeStyle = cssToken("--sl-curve", "#EDD54C"); g.lineWidth = 1.5; g.beginPath();
    os.forEach((s, i) => { const x = X(s.value), y = Y(s.opacity); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
    g.stroke();
    g.fillStyle = cssToken("--sl-curve", "#EDD54C");
    os.forEach((s, i) => {
      const x = X(s.value), y = Y(s.opacity), on = i === hoverStop;
      g.beginPath(); g.arc(x, y, on ? 6 : 4.5, 0, Math.PI * 2); g.fill();
      if (on) {
        g.strokeStyle = cssToken("--sl-fg", "#ffffff"); g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, GRAB - 3, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = cssToken("--sl-curve", "#EDD54C"); g.lineWidth = 1.5;
      }
    });
    g.restore();
  }

  /**
   * THE DOUBLE-HEADED SLIDER under the curve: two handles on a bar, the span between them is the
   * part of the axis the curve shows. Drawn on a canvas of its own rather than two stacked native
   * range inputs, because native thumbs are 5 px and the point is fine motor control: these are
   * 14 px wide, the bar between them drags as a whole, and a double-click on the bar shows all.
   */
  const ZH = 22, ZPAD = PAD;
  function drawZoom(zc: HTMLCanvasElement) {
    const g = zc.getContext("2d"); if (!g) return;
    g.clearRect(0, 0, W, ZH);
    const x0 = ZPAD + zoom[0] * (W - 2 * ZPAD), x1 = ZPAD + zoom[1] * (W - 2 * ZPAD);
    g.fillStyle = cssToken("--sl-surface-2", "#29221c"); g.fillRect(ZPAD, 8, W - 2 * ZPAD, 6);
    g.fillStyle = cssToken("--sl-accent", "#f8d764"); g.fillRect(x0, 8, Math.max(2, x1 - x0), 6);
    for (const x of [x0, x1]) {
      g.fillStyle = cssToken("--sl-fg", "#fbf9f5"); g.beginPath(); g.roundRect(x - 7, 2, 14, ZH - 4, 3); g.fill();
      g.strokeStyle = cssToken("--sl-border", "#140f0b"); g.lineWidth = 1; g.stroke();
    }
  }
  /** Follow a drag outside the canvas: window listeners for the drag's length only. They were added on every
   *  redraw of the panel and never removed, so an hour's work ran hundreds per mouse move, each holding an old
   *  canvas (code review 2026-09-24, A16). */
  function follow(move: (e: MouseEvent) => void, end: () => void) {
    const up = () => { globalThis.removeEventListener("mousemove", move as EventListener); globalThis.removeEventListener("mouseup", up); end(); };
    globalThis.addEventListener("mousemove", move as EventListener);
    globalThis.addEventListener("mouseup", up);
  }
  function mountZoom(zc: HTMLCanvasElement, cv: HTMLCanvasElement) {
    let grab: "lo" | "hi" | "bar" | null = null, grabAt = 0, grabZoom: [number, number] = [0, 1];
    const fx = (e: MouseEvent) => { const r = zc.getBoundingClientRect(); return ((e.clientX - r.left) * (W / r.width) - ZPAD) / (W - 2 * ZPAD); };
    const px = (f: number) => ZPAD + f * (W - 2 * ZPAD);
    zc.addEventListener("mousedown", (e) => {
      const r = zc.getBoundingClientRect(), mx = (e.clientX - r.left) * (W / r.width);
      const dl = Math.abs(mx - px(zoom[0])), dh = Math.abs(mx - px(zoom[1]));
      grab = dl <= 10 && dl <= dh ? "lo" : dh <= 10 ? "hi" : mx > px(zoom[0]) && mx < px(zoom[1]) ? "bar" : null;
      grabAt = fx(e); grabZoom = [zoom[0], zoom[1]];
      e.preventDefault();
      if (grab) follow(onMove, () => { grab = null; });
    });
    zc.addEventListener("dblclick", () => { zoom = [0, 1]; drawZoom(zc); drawCurve(cv); });
    zc.addEventListener("mousemove", (e) => {
      if (grab) return;
      const r = zc.getBoundingClientRect(), mx = (e.clientX - r.left) * (W / r.width);
      zc.style.cursor = Math.abs(mx - px(zoom[0])) <= 10 || Math.abs(mx - px(zoom[1])) <= 10 ? "ew-resize" : mx > px(zoom[0]) && mx < px(zoom[1]) ? "grab" : "default";
    });
    function onMove(e: MouseEvent) {
      if (!grab) return;
      const f = Math.max(0, Math.min(1, fx(e))), MIN = 0.02;
      if (grab === "lo") zoom = [Math.min(f, zoom[1] - MIN), zoom[1]];
      else if (grab === "hi") zoom = [zoom[0], Math.max(f, zoom[0] + MIN)];
      else { const d = Math.max(-grabZoom[0], Math.min(1 - grabZoom[1], f - grabAt)); zoom = [grabZoom[0] + d, grabZoom[1] + d]; }
      drawZoom(zc); drawCurve(cv);
    }
  }

  function mountCanvasEditing(cv: HTMLCanvasElement) {
    let drag = -1;
    const near = (mx: number, my: number) => {
      const os = opacityStops();
      for (let i = 0; i < os.length; i++) if (Math.hypot(mx - X(os[i].value), my - Y(os[i].opacity)) < GRAB) return i;
      return -1;
    };
    const rel = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)] as const; };
    // ADD on mousedown, but never on the second click of a double-click.
    //
    // This was the bug behind "when I try to double click they don't disappear but I end up adding a
    // point". Add fired on mousedown whenever the press missed a handle, so a double-click aimed
    // slightly off a handle went: first press adds a point; second press now lands ON that new point
    // and starts a DRAG; the smallest movement relocates it; and dblclick's proximity test then finds
    // nothing to remove. Net effect, one extra point and no deletion.
    //
    // `e.detail` is the click count, so the second press of a double-click is detail 2 and simply
    // does not add. No timer, no delay, and a double-click that misses now does nothing at all
    // rather than something unwanted.
    cv.addEventListener("mousedown", (e) => {
      forgetGain();
      const [mx, my] = rel(e);
      drag = near(mx, my);
      if (drag >= 0) follow(onDrag, () => { drag = -1; });
      if (drag >= 0 || e.detail >= 2) return;
      const os = opacityStops();
      os.push({ value: toVal(mx), opacity: toOpac(my) });
      setOpacityStops(os);
      drawCurve(cv);
    });

    // Show what is about to be hit. Without this the only way to discover the grab radius is to miss.
    cv.addEventListener("mousemove", (e) => {
      if (drag >= 0) return;                       // dragging: the cursor is already committed
      const [mx, my] = rel(e);
      const i = near(mx, my);
      cv.style.cursor = i >= 0 ? "pointer" : "crosshair";
      if (i !== hoverStop) { hoverStop = i; drawCurve(cv); }
    });
    cv.addEventListener("mouseleave", () => { if (hoverStop !== -1) { hoverStop = -1; drawCurve(cv); } });
    // BLOCKED AT THE NEIGHBORS. The stops are kept sorted by value, so dragging one past the next
    // used to re-sort them and the drag index then pointed at the neighbor -- which moved instead.
    // Ron: "If I move the control point beyond the one to its left, that one gets dragged. It
    // should block me instead." A handle now stops one unit short of each neighbor's value, and the
    // first and last keep the ends of the axis, so the order of the stops never changes under a drag.
    function onDrag(e: MouseEvent) {
      if (drag < 0) return;
      const [mx, my] = rel(e);
      const os = opacityStops();
      if (!os[drag]) { drag = -1; return; }
      const [lo, hi] = fullRange();
      const minV = drag > 0 ? os[drag - 1].value + 1 : lo;
      const maxV = drag < os.length - 1 ? os[drag + 1].value - 1 : hi;
      os[drag] = { value: Math.max(minV, Math.min(maxV, toVal(mx))), opacity: toOpac(my) };
      setOpacityStops(os); drawCurve(cv);
    }
    cv.addEventListener("dblclick", (e) => {
      const [mx, my] = rel(e);
      const i = near(mx, my);
      const os = opacityStops();
      // Two stops are the minimum a ramp can be defined by, so the last two cannot be removed. Said
      // out loud rather than silently ignored, because a control that does nothing looks broken.
      if (i >= 0 && os.length <= 2) { status("a transfer function needs at least two points"); return; }
      if (i < 0 || os.length <= 2) return;
      os.splice(i, 1);
      setOpacityStops(os);
      drawCurve(cv);
    });
  }

  let renderQueued = false;
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    // A TIMER BEHIND THE FRAME: requestAnimationFrame does not fire while the window is hidden or
    // minimized, and the flag then stayed set for good -- the panel went on naming a closed scene's
    // volume. The same trap as the Segmentations module (WORKING-STATE, 2026-09-22 19:30).
    let done = false;
    const go = () => { if (done) return; done = true; renderQueued = false; if (root) render(); };
    requestAnimationFrame(go);
    setTimeout(go, 250);
  }
  /** The Preset button's words for a transfer function: the preset's label, its name, or an invitation. */
  function presetLabelOf(tf: MrsonNode | undefined): string {
    return CT_VR_PRESETS.find((p) => p.name === tf?.preset)?.label ?? (tf?.preset ? String(tf.preset) : "Choose a preset…");
  }
  /** Which volumes the Volume list offers, as one string: the panel is rebuilt when it changes. */
  let volumesShown = "";
  const volumesSig = () => scalarVolumes().map((v) => `${v.imageId}=${v.name}`).join("|");
  function render() {
    if (!root) return;
    volumesShown = volumesSig();
    const vols = scalarVolumes();
    if (!activeId || !vols.some((v) => v.imageId === activeId)) activeId = vols[0]?.imageId ?? "";
    if (!activeId) { root.innerHTML = `<h2>Volume Rendering</h2><p class="sl-hint">No scalar volume loaded.</p>`; return; }
    const vr = vrNode(), tf = tfNode();
    const volOpts = vols.map((x) => `<option value="${x.imageId}"${x.imageId === activeId ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
    const presetLabel = presetLabelOf(tf);
    const lightIdx = lightPresetOf(shadeVec());
    const hasSegs = segsOfActive().length > 0;
    // TWO SECTIONS, on Ron's instruction: "a small section for nontechnical users and an advanced
    // section for the pro. the first section should have: select volume, turn it on/off, turn colorize
    // on/off, shift slider and the three light presets. transfer function and detailed lighting
    // controls go into advanced." Nothing was removed; it was sorted.
    root.innerHTML = `
      <h2>Volume Rendering</h2>
      <div class="sl-row"><label>Volume</label><select class="sl-vr-active">${volOpts}</select></div>
      <div class="sl-row"><label>Show in 3D</label><button class="sl-tool sl-vr-on" aria-pressed="${vr?.visible ? "true" : "false"}" title="Which look this volume has in 3D (Off, Volume, Solid, Surfaces) is chosen in Scene. Here you tune the Volume look: preset, colors, opacity, lighting.">${vr?.visible ? "on" : "off"}</button></div>
      <div class="sl-row"><label>Colorized volume</label>${hasSegs
        ? `<button class="sl-tool sl-vr-clz" aria-pressed="${colorizeOn() ? "true" : "false"}" title="Colorized volume: the scan rendered see-through and tinted by its segmentation, as Slicer's Colorize Volume does. For the anatomy drawn solid, choose Solid in Scene.">${colorizeOn() ? "on" : "off"}</button>` +
          (segsOfActive().length > 1
            ? ` <span class="sl-hint">with</span> <select class="sl-vr-clz-with" title="Which segmentation tints the volume. One at a time; the others are drawn as surfaces on top.">${segsOfActive().map((sg) =>
                `<option value="${sg.id}"${sg.id === colorizeWith() ? " selected" : ""}>${escapeHtml((sg.name as string) ?? sg.id)} (${((sg.segments as unknown[] | undefined) ?? []).length})</option>`).join("")}</select>`
            : "")
        : `<span class="sl-hint">no segmentation on this volume</span>`}</div>
      <div class="sl-row"><label>Preset</label><button class="sl-tool sl-vr-preset-btn" title="Pick a preset from thumbnails of this volume">${presetLabel}</button></div>
      <div class="sl-row"><label>Shift</label><input class="sl-vr-shift" type="range" min="-500" max="500" step="1" value="0" title="Slide the whole transfer function, colors and opacity together"><span class="sl-vr-shiftv">0</span></div>
      <div class="sl-row"><label>Colors</label><input class="sl-vr-cshift" type="range" min="-500" max="500" step="1" value="0" title="Slide the color scale alone; the opacity points stay"><span class="sl-vr-cshiftv">0</span></div>
      <div class="sl-row"><label>Opacity</label><input class="sl-vr-gain" type="range" min="0" max="3" step="0.05" value="1" title="Push the whole opacity curve up or down; a point at zero stays at zero"><span class="sl-vr-gainv">×1.00</span></div>
      <div class="sl-row"><label>Lighting</label><span class="sl-vr-lights">${LIGHT_PRESETS.map((lp, i) =>
        `<button class="sl-tool sl-vr-light" data-i="${i}" title="${lp.why}" aria-pressed="${i === lightIdx ? "true" : "false"}">${lp.name}</button>`).join("")}</span></div>
      <details class="sl-advanced"${advancedOpen ? " open" : ""}><summary>Advanced</summary>
      ${segsOfActive().length ? `
      <h3>Colorized volume</h3>
      <p class="sl-hint">${segsOfActive().length} segmentation${segsOfActive().length > 1 ? "s" : ""} on this volume.
        One volume, not two: labeled voxels are tinted by their segment, and the rest of the body is
        drawn by the CT transfer function at the opacity below. That faint body is the whole backdrop —
        there is no second grayscale rendering underneath.</p>
      <div class="sl-row"><label>Unlabeled body</label><input class="sl-clz-ctx" type="range" min="0" max="1" step="0.01"
        value="${colorizeParam("contextOpacity", presentationParams(DEFAULT_PRESENTATION).contextOpacity as number)}" title="Opacity of the unlabeled body — the same control the colorize viewer calls Unlabeled body. At 1 the skin alone hides everything behind it."><span class="sl-clz-ctxv">${colorizeParam("contextOpacity", presentationParams(DEFAULT_PRESENTATION).contextOpacity as number).toFixed(2)}</span></div>
      <div class="sl-row"><label>Segment opacity</label><input class="sl-clz-seg" type="range" min="0" max="1" step="0.01"
        value="${colorizeParam("segmentOpacity", 1)}" title="Scales every segment together. A first step towards per-group control, not a substitute: the colorize page reads well because bones are at 100% and muscle at 5%, which one slider cannot express."><span class="sl-clz-segv">${colorizeParam("segmentOpacity", 1).toFixed(2)}</span></div>
      <div class="sl-row"><label>CT modulation</label><input class="sl-clz-mod" type="range" min="0" max="1" step="0.01"
        value="${colorizeParam("ctModulation", 0.55)}" title="How strongly the underlying CT varies each segment's brightness. At 0 segments are flat color."><span class="sl-clz-modv">${colorizeParam("ctModulation", 0.55).toFixed(2)}</span></div>` : ""}
      <h3>Lighting</h3>
      <p class="sl-hint">A preset sets these; drag to override. Ambient is flat brightness everywhere,
        diffuse is the directional light, specular is the highlight. An unshaded preset is ambient 1
        with the rest at 0.</p>
      <div class="sl-row"><label>Ambient</label><input class="sl-lt-ka" type="range" min="0" max="1" step="0.01"
        value="${shadeVec()[0]}"><span class="sl-lt-kav">${shadeVec()[0].toFixed(2)}</span></div>
      <p class="sl-hint sl-lt-warn" style="color:var(--sl-warn)"></p>
      <div class="sl-row"><label>Diffuse</label><input class="sl-lt-kd" type="range" min="0" max="1" step="0.01"
        value="${shadeVec()[1]}"><span class="sl-lt-kdv">${shadeVec()[1].toFixed(2)}</span></div>
      <div class="sl-row"><label>Specular</label><input class="sl-lt-ks" type="range" min="0" max="1" step="0.01"
        value="${shadeVec()[2]}"><span class="sl-lt-ksv">${shadeVec()[2].toFixed(2)}</span></div>
      <div class="sl-row"><label>Shininess</label><input class="sl-lt-sp" type="range" min="1" max="64" step="1"
        value="${shadeVec()[3]}"><span class="sl-lt-spv">${shadeVec()[3].toFixed(0)}</span></div>
      <h3>Scalar opacity</h3>
      <canvas class="sl-tf-canvas" width="${W}" height="${H}" style="width:100%;border:1px solid var(--sl-border);border-radius:4px;cursor:crosshair"></canvas>
      <canvas class="sl-tf-zoom" width="${W}" height="${ZH}" style="width:100%;display:block;margin-top:2px" title="Drag a handle to zoom the curve to part of its range; drag the bar to pan; double-click to show all"></canvas>
      <div class="sl-actions"><button class="sl-tf-reset" title="Put the curve back to the preset's own, undoing every edit">Reset to preset</button></div>
      <p class="sl-hint">Drag a handle to change opacity, click empty space to add, double-click a handle to remove. A handle rings white when you are on it; it stops at its neighbors.</p>
      </details>`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    $("select.sl-vr-active").addEventListener("change", (e) => { activeId = (e.target as HTMLSelectElement).value; render(); });
    // THE TWO SWITCHES READ THE SCENE, not the click. `vr` above is a snapshot from render time;
    // the node is patched in place, so the current value is on the node. Painting from the node
    // also keeps them honest when something else flips the volume (the Subject Hierarchy's 3D
    // button, a preset that turns rendering on).
    const onBtn = $<HTMLButtonElement>("button.sl-vr-on"), clzBtn = root.querySelector("button.sl-vr-clz") as HTMLButtonElement | null;
    paintToggles = () => {
      const on = !!vrNode()?.visible;
      onBtn.textContent = on ? "on" : "off"; onBtn.setAttribute("aria-pressed", String(on));
      if (clzBtn) { const c = colorizeOn(); clzBtn.textContent = c ? "on" : "off"; clzBtn.setAttribute("aria-pressed", String(c)); }
    };
    onBtn.addEventListener("click", () => { const on = !vrNode()?.visible; setVolumeRendering(activeId, on); paintToggles(); status(on ? "volume rendering on" : "volume rendering off"); });
    clzBtn?.addEventListener("click", () => { const on = !colorizeOn(); setColorize(on); paintToggles(); status(on ? "colorize on" : "colorize off: grayscale CT, segmentation drawn on top"); });
    (root.querySelector(".sl-vr-clz-with") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
      const id = (e.target as HTMLSelectElement).value;
      if (!vrNode()) setVolumeRendering(activeId, true);
      live.write({ op: "patch", id: vrNode()?.id ?? vrIdFor(activeId), path: "#/colorizeWith", value: id });
      if (!colorizeOn()) setColorize(true);
      status(`colorizing with ${(live.nodes.get(id)?.name as string) ?? id}`);
    });
    // THE PRESET PICKER IS STEVE'S THUMBNAIL GRID, with the thumbnails made from this volume at the
    // current camera by the 3D view (live-views.ts, __renderVrPresetThumbnails). If the volume is not
    // being drawn in 3D there is nothing to render, so it is switched on first -- a preset with the
    // rendering off is not a choice anyone makes -- and if the thumbnails still cannot be made the
    // grid falls back to labeled tiles, so the picker always works.
    $("button.sl-vr-preset-btn").addEventListener("click", () => {
      if (!vr?.visible) setVolumeRendering(activeId, true);
      const g = globalThis as unknown as { __renderVrPresetThumbnails?: (id: string) => VrPresetItem[] };
      let items: VrPresetItem[] = [];
      try { items = g.__renderVrPresetThumbnails?.(activeId) ?? []; } catch (e) { console.log(`preset thumbnails: ${e}`); }
      // NO LIVE PREVIEW: draw each preset's color ramp, so a tile still says what the preset is.
      // A grid of black squares is a picker that does not work -- Ron saw exactly that -- and a
      // ramp is what Slicer's own preset list shows.
      if (!items.length) {
        items = CT_VR_PRESETS.map((p) => {
          const c = document.createElement("canvas"); c.width = c.height = 116;
          const g = c.getContext("2d");
          if (g) {
            const lo = p.colorTF[0][0], hi = p.colorTF[p.colorTF.length - 1][0];
            const grad = g.createLinearGradient(0, 116, 0, 0);
            for (const [v, r, gg, b] of p.colorTF) grad.addColorStop(Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))), `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`);
            g.fillStyle = cssToken("--sl-view-canvas", "#000000"); g.fillRect(0, 0, 116, 116);
            g.fillStyle = grad; g.fillRect(28, 8, 60, 100);
          }
          return { name: p.name, label: p.label, canvas: c };
        });
        status("preset previews unavailable for this volume — showing color ramps");
      }
      openVrPresetMenu({ items, current: (tf?.preset as string | undefined) ?? null, onPick: (nm) => {
        if (!nm) return;
        applyPreset(activeId, nm); shiftLast = 0; colourShiftLast = 0;
        // A PRESET IS A WAY OF LOOKING AT THE CT. With Colorize on it reaches only the unlabeled
        // body, which is drawn faint or not at all, so the preset was applied and invisible. Ron:
        // "Using the presets on the 01524 did not produce the results I was expecting. It stayed
        // in colorize mode." And: "yes, a preset should switch colorize off."
        const wasColorized = segsOfActive().length > 0 && colorizeOn();
        if (wasColorized) setColorize(false);
        render();
        status(`VR preset ${nm}${wasColorized ? " — colorize off, so the preset shows; the segmentation is drawn on top" : ""}`);
      } });
    });
    const lightBtns = Array.from(root.querySelectorAll("button.sl-vr-light")) as HTMLButtonElement[];
    const paintLights = () => { const i = lightPresetOf(shadeVec()); for (const b of lightBtns) b.setAttribute("aria-pressed", String(Number(b.dataset.i) === i)); };
    paintShade = () => {
      paintLights();
      const sh = shadeVec();
      for (const [cls, idx, dp] of [["ka", 0, 2], ["kd", 1, 2], ["ks", 2, 2], ["sp", 3, 0]] as const) {
        const el = root!.querySelector(`input.sl-lt-${cls}`) as HTMLInputElement | null;
        const num = root!.querySelector(`.sl-lt-${cls}v`) as HTMLElement | null;
        if (el && document.activeElement !== el) el.value = String(sh[idx]);
        if (num) num.textContent = sh[idx].toFixed(dp);
      }
    };
    for (const b of lightBtns) {
      b.addEventListener("click", () => {
        const lp = LIGHT_PRESETS[Number(b.dataset.i)];
        setShade(lp.shade);
        // Paint the pressed state now rather than wait for the scene round trip: a button that
        // was pressed and does not look pressed is the 3D panel's old lie in a new place.
        for (const o of lightBtns) o.setAttribute("aria-pressed", String(o === b));
        status(`lighting: ${lp.name}`);
      });
    }
    // And the sliders under Advanced move the shade away from every preset, so they unpress.
    root.addEventListener("input", (e) => { if ((e.target as HTMLElement).matches("input.sl-lt-ka, input.sl-lt-kd, input.sl-lt-ks, input.sl-lt-sp")) paintLights(); });
    root.querySelector("details.sl-advanced")?.addEventListener("toggle", (e) => { advancedOpen = (e.target as HTMLDetailsElement).open; });
    const shiftEl = $<HTMLInputElement>("input.sl-vr-shift");
    shiftEl.addEventListener("input", (e) => { const v = Number((e.target as HTMLInputElement).value); shiftTf(v - shiftLast); shiftLast = v; ($(".sl-vr-shiftv") as HTMLElement).textContent = String(v); });
    const cshiftEl = $<HTMLInputElement>("input.sl-vr-cshift");
    cshiftEl.addEventListener("input", (e) => { const v = Number((e.target as HTMLInputElement).value); shiftColours(v - colourShiftLast); colourShiftLast = v; ($(".sl-vr-cshiftv") as HTMLElement).textContent = String(v); });
    const gainEl = $<HTMLInputElement>("input.sl-vr-gain");
    gainEl.addEventListener("input", (e) => { const v = Number((e.target as HTMLInputElement).value); setOpacityGain(v); ($(".sl-vr-gainv") as HTMLElement).textContent = `×${v.toFixed(2)}`; });
    // The base for the gain is the curve as it was when the slider was first moved; any other edit
    // of the curve (a handle, a preset, Reset) starts a fresh base, and the panel's next render
    // puts the slider back at ×1 against the curve as it then is.
    const ctxEl = root.querySelector("input.sl-clz-ctx") as HTMLInputElement | null;
    if (ctxEl) {
      ctxEl.addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        (root!.querySelector(".sl-clz-ctxv") as HTMLElement).textContent = v.toFixed(2);
        setColorizeParam("contextOpacity", v);
      });
    }

    // Ambient at 1 saturates before the directional term is added -- the shader clamps
    // rgb * (ka + kd * ldotn) to 1 -- so diffuse and specular silently do nothing. Say it, rather
    // than let someone discover it by dragging a control that appears to be broken. CT-Soft-Tissue
    // is an UNSHADED preset and sets exactly this, so it is the default state, not an odd corner.
    const refreshLightWarn = () => {
      const el = root!.querySelector(".sl-lt-warn") as HTMLElement | null;
      if (!el) return;
      const [ka, kd] = shadeVec();
      // Peak brightness is ka + kd, reached only where a surface faces the viewer. Slicer's shaded
      // presets sum to 1 (CT-Muscle is 0.1 + 0.9); land below that and the whole volume is dimmer
      // than the unshaded preset it was compared against, which reads as the lighting being broken
      // rather than as a budget being underspent.
      const peak = ka + kd;
      el.textContent = ka >= 0.995
        ? "Ambient is 1.00, which saturates: diffuse and specular have no effect until you lower it. This preset is unshaded by design."
        : peak < 0.95
        ? `Ambient + diffuse = ${peak.toFixed(2)}, so nothing can be brighter than that. Slicer's shaded presets sum to 1.`
        : "";
    };
    refreshLightWarn();

    const segEl = root.querySelector("input.sl-clz-seg") as HTMLInputElement | null;
    if (segEl) {
      segEl.addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        (root!.querySelector(".sl-clz-segv") as HTMLElement).textContent = v.toFixed(2);
        setColorizeParam("segmentOpacity", v);
      });
    }
    const modEl = root.querySelector("input.sl-clz-mod") as HTMLInputElement | null;
    if (modEl) {
      modEl.addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        (root!.querySelector(".sl-clz-modv") as HTMLElement).textContent = v.toFixed(2);
        setColorizeParam("ctModulation", v);
      });
    }
    // Lighting: one binding for all four terms, since they differ only in index and format.
    for (const [cls, idx, dp] of [["ka", 0, 2], ["kd", 1, 2], ["ks", 2, 2], ["sp", 3, 0]] as const) {
      const el = root.querySelector(`input.sl-lt-${cls}`) as HTMLInputElement | null;
      if (!el) continue;
      el.addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        (root!.querySelector(`.sl-lt-${cls}v`) as HTMLElement).textContent = v.toFixed(dp);
        setShadeTerm(idx, v);
        refreshLightWarn();
      });
    }
    const cv = $<HTMLCanvasElement>("canvas.sl-tf-canvas"); drawCurve(cv); mountCanvasEditing(cv);
    const zc = $<HTMLCanvasElement>("canvas.sl-tf-zoom"); drawZoom(zc); mountZoom(zc, cv);
    // RESET. Ron: "There is no reset." The preset's own stops and lighting, written again; the
    // axis and the zoom stay where they were, so the difference is visible.
    $<HTMLButtonElement>("button.sl-tf-reset").addEventListener("click", () => {
      const name = tfNode()?.preset as string | undefined;
      const p = name ? CT_VR_PRESETS.find((x) => x.name === name) : undefined;
      if (p) { applyPresetObject(activeId, p); status(`curve reset to ${p.label}`); }
      else { const own = startingPreset(activeId); if (own) { applyPresetObject(activeId, own); status("curve reset"); } else status("no preset to reset to — choose one first"); }
      drawCurve(cv);
    });
  }

  shell.registerPanel({ id: "vr", title: "Volume Rendering", groups: ["Display"], order: 2, tip: "Show a volume in 3D: presets, colors, opacity, lighting", mount(el) { root = el; autoEnableVr(); render(); } });
  live.subscribe((c) => {
    if (c.type === "image" || c.type === "transferFunction" || c.type === "volumeRenderingDisplay" || c.type === "segmentation" || c.kind === "remove") {
      if (c.type === "image" && c.kind === "upsert") autoEnableVr(c.id);   // fires whether or not this panel is open
    }
    // A sequence has ARRIVED (not scrubbed -- every scrub is an upsert of the same browser): its
    // current frame gets the rendering a loaded volume gets; from then on the
    // SequenceDisplayableManager moves that rendering from frame to frame.
    if (c.type === "sequenceBrowser" && c.kind === "upsert") {
      if (!seenBrowsers.has(c.id)) {
        seenBrowsers.add(c.id);
        const cur = [...currentFrames(live).keys()];
        autoEnableVr(cur[cur.length - 1]);
        render();
        return;
      }
      // A SCRUB OR A PLAYING SEQUENCE: the active volume moves to the frame on screen and the
      // Volume list says so, IN PLACE. Rebuilding the panel at the playback rate replaced the
      // sliders under the pointer, and a control replaced between press and release does nothing.
      const frames = currentFrames(live);
      const active = live.nodes.get(activeId);
      if (active?.sequence && !frames.has(activeId)) {
        const seqFrame = [...frames.keys()].find((id) => live.nodes.get(id)?.sequence === active.sequence);
        if (seqFrame) activeId = seqFrame;
      }
      const sel = root?.querySelector("select.sl-vr-active") as HTMLSelectElement | null;
      if (sel) sel.innerHTML = scalarVolumes().map((x) => `<option value="${x.imageId}"${x.imageId === activeId ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
      paintToggles();
      return;
    }
    if (c.type === "image" || c.type === "transferFunction" || c.type === "volumeRenderingDisplay" || c.type === "segmentation" || c.kind === "remove" || c.kind === "reset") {
      // A segmentation arriving changes which SECTIONS exist, not just the curve, so re-render --
      // once per frame, not once per write: a sequence step writes several members at once.
      if (c.type === "segmentation") { renderSoon(); return; }
      // A VOLUME ARRIVING OR GOING, or a scene closed, changes the Volume list: rebuilt. Only the curve
      // was redrawn, so after a scene was closed and CT-Training-LC003 loaded, this module still named the
      // previous CT and its four segmentations (2026-09-23). Other image writes (a window/level drag, a
      // rename of another node) leave the list as it was and do not rebuild it.
      if (c.kind === "remove" || c.kind === "reset" || (c.type === "image" && volumesSig() !== volumesShown)) { renderSoon(); return; }
      // The canvas now lives under Advanced and is always in the DOM, so "redraw the curve" is no
      // longer the same as "the panel is showing the current state": the switches repaint too.
      if (c.type === "volumeRenderingDisplay") paintToggles();
      // The lighting can change from outside this panel -- the gear in the 3D view writes through
      // to every volume -- so the three buttons and the four sliders follow the node, not the click.
      if (c.type === "transferFunction") {
        paintShade();
        // AND THE PRESET'S NAME: a preset applied at load, or from a look, arrives after the panel was
        // drawn, and the button went on saying "Choose a preset…".
        const pb = root?.querySelector("button.sl-vr-preset-btn");
        if (pb) pb.textContent = presetLabelOf(tfNode());
      }
      const cv = root?.querySelector("canvas.sl-tf-canvas") as HTMLCanvasElement | null;
      if (cv) drawCurve(cv); else render();
    }
  });
}
