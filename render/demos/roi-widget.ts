// Reusable ROI crop widget: a RoiBoxField wireframe + 15 draggable handles
// (6 faces + 8 corners + 1 centre) with the face/corner/centre drag math, extracted so BOTH
// the standalone ROI demo (roi-scene.ts) and the SEGRoulette 3D crop use one source of truth
// (DRY). The caller owns the SceneRenderer: feed lo()/hi() to setClipBox and composite box +
// handles into the field list. Handle-drag mirrors the vtk.js ROIDM (viewer/slicerlive.js).
import { FiducialField, type Sphere } from "../fiducial-field.ts";
import { RoiBoxField } from "../roi-box-field.ts";
import type { Vec3 } from "../mat4.ts";

export type HandleMeta =
  | { kind: "center" }
  | { kind: "face"; axis: 0 | 1 | 2; sign: -1 | 1 }
  | { kind: "corner"; s: [number, number, number] }
  /**
   * An EDGE: the two bounds it names, moved together. Slicer's ROI has twelve of these beside its
   * six faces and eight corners (vtkMRMLMarkupsROIDisplayNode.h: HandleLPEdge ... HandleASEdge), and
   * `ScaleWidgetROI` moves both of the bounds an edge appears in.
   *
   * It is what a box's corner IS on a slice. The four corners of the rectangle a slice cuts out of
   * the box are the projections of the four edges running through the slice -- not of the box's
   * corners, of which two coincide at each of those points. Dragging an edge resizes exactly the two
   * sides you can see, with no question about the third: the handle names the pair.
   */
  | { kind: "edge"; axes: [0 | 1 | 2, 0 | 1 | 2]; s: [-1 | 1, -1 | 1] };

export interface RoiHandle { id: number; world: Vec3; data: HandleMeta; cursor: string }
export interface Box { center: Vec3; half: Vec3 }

export interface RoiWidget {
  box: RoiBoxField;
  handles: FiducialField;
  center: Vec3;
  half: Vec3;
  lo(): Vec3;
  hi(): Vec3;
  handleList(): RoiHandle[];
  /** Apply a drag of `meta` from the box snapshot `box0` by camera-plane `delta` (RAS mm).
   *
   *  `viewDir` (camera -> focal point, any length) makes CORNER drags predictable. The delta comes
   *  from unprojecting the cursor onto a camera-facing plane, so it has a component along the axis
   *  pointing INTO the screen -- an axis the cursor cannot aim. Resizing it anyway reads as the box
   *  moving as well as resizing. Given viewDir, the most view-aligned axis is left alone and a
   *  corner drag resizes only the two axes actually visible. Omit it to resize all three. */
  applyDrag(meta: HandleMeta, box0: Box, delta: Vec3, viewDir?: Vec3): void;
  /** The handles worth showing on one slice plane -- see `sliceHandles`. */
  sliceHandles(point: Vec3, normal: Vec3): RoiHandle[];
  setHover(i: number | null): void;
  snapshot(): Box;
  /** Set the box directly (e.g. reset to a fraction of the volume) and refresh geometry. */
  setBox(center: Vec3, half: Vec3): void;
  /** Re-orient the box; row-major 3x3, columns are the axes, must be orthonormal. */
  setAxes(axes?: number[]): void;
}

/**
 * The crop frame's color, 0-1. Warm ivory rather than saturated gold: gold was chosen against the
 * old dark navy 3D view and reads loud on Slicer's pale lavender, and this is kept off pure ivory so
 * it still separates from the background (40cc4af).
 *
 * Exported because the SLICE views draw the same box and must not pick their own color. Ron: "the
 * box colors in 2d are not adjusted. In 3d they look nice." They were not adjusted because the 2D
 * outline fell back to the generic markup gold, and one box drawn in two colors is one box too
 * many.
 */
export const ROI_BAR_RGB: [number, number, number] = [1, 0.94, 0.66];

/**
 * The handle colors, 0-1, exported for the same reason as the frame's: the slice views draw the
 * same handles and must not invent their own.
 *
 * Saturated and near-opaque because 40cc4af found the original light blue at 50% alpha "turned
 * nearly invisible on pale lavender"; the center is green so the one handle that MOVES the box is
 * not mistaken for one that resizes it; hover is warm for contrast against both.
 */
export const ROI_HANDLE_RGB: [number, number, number] = [0.1, 0.35, 0.85];
export const ROI_CENTER_RGB: [number, number, number] = [0.05, 0.55, 0.2];
export const ROI_HOVER_RGB: [number, number, number] = [0.95, 0.35, 0.05];

export interface RoiWidgetOpts {
  coverage?: number;    // initial half-extent as a fraction of the volume extent (default 0.35)
  minHalfMm?: number;   // never let a side collapse below this (default 5 mm)
  /**
   * The box's own axes in world space: row-major 3x3, COLUMNS are the axes. Must be orthonormal.
   * Omitted means world-aligned, and every number below is then what it always was.
   *
   * A crop box aligned to the patient is useless on an oblique volume, so the box takes the volume's
   * direction cosines. It stays axis-aligned IN ITS OWN FRAME, which is what keeps the drags
   * intuitive: a face handle moves that face along the box's own axis, and a corner resizes the two
   * axes the cursor can actually aim. Folding the rotation into `center`/`half` instead would have
   * skewed every gesture.
   */
  axes?: number[];
}

/** The handle's index in a fixed layout -- 6 faces, 8 corners, the center, then the 12 edges -- so a
 *  slice handle and its 3D twin are one handle with one id (hover, tests) rather than two that
 *  happen to coincide. */
export function handleId(m: HandleMeta): number {
  if (m.kind === "center") return 14;
  if (m.kind === "face") return m.axis * 2 + (m.sign > 0 ? 1 : 0);
  if (m.kind === "corner") return 6 + (m.s[0] > 0 ? 4 : 0) + (m.s[1] > 0 ? 2 : 0) + (m.s[2] > 0 ? 1 : 0);
  const pair = m.axes[0] === 0 ? (m.axes[1] === 1 ? 0 : 1) : 2;          // (0,1) (0,2) (1,2)
  return 15 + pair * 4 + (m.s[0] > 0 ? 2 : 0) + (m.s[1] > 0 ? 1 : 0);
}

/**
 * How close to the view direction an axis has to be before its handle is useless, in degrees.
 *
 * Slicer's number: `vtkMRMLInteractionWidgetRepresentation::StartFadeAngleDegrees` is 10 and
 * `EndFadeAngleDegrees` is 8, and `GetHandleOpacity` fades a translation or scale handle to nothing
 * as the angle between its axis and the view normal drops below them. So Slicer hides such a handle
 * only when its axis is very nearly ALONG the view direction -- not whenever it is the most
 * view-aligned of the three, which is what this used to do. On a strongly oblique box every face is
 * draggable from every view, and now stays offered.
 */
export const FADE_DEG = 10;

/**
 * The box axis so nearly along `dir` that dragging it cannot be aimed -- or -1 if there is none.
 *
 * `axes` is the row-major 3x3 with the box's axes as its columns; `dir` is the view direction (a
 * camera vector in 3D, the slice normal in 2D -- Slicer substitutes the same way in
 * `GetHandleToCameraVectorWorld`).
 */
export function degenerateAxis(axes: number[] | undefined, dir: Vec3 | readonly number[]): number {
  const L = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(L > 0)) return -1;
  const A = axes && axes.length === 9 ? axes : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const cosFade = Math.cos((FADE_DEG * Math.PI) / 180);
  let best = -1, bestDot = cosFade;
  for (let k = 0; k < 3; k++) {
    const d = Math.abs((A[k] * dir[0] + A[3 + k] * dir[1] + A[6 + k] * dir[2]) / L);
    if (d > bestDot) { bestDot = d; best = k; }
  }
  return best;
}

/**
 * The handles worth showing on ONE slice plane, projected onto it.
 *
 * Ron: "It should not show the 3d handles in the 2d, they are useless there. 2D control handles
 * should be usable in the slice that is visible, otherwise they are not functional." Then, when they
 * still did not work: "Look at how slicer handles this." So this follows Slicer's own three rules,
 * from Libs/MRML/DisplayableManager/vtkMRMLInteractionWidgetRepresentation.cxx:
 *
 *   PROJECTED ONTO THE PLANE. `UpdateSlicePlaneFromSliceNode` transforms the whole handle set into
 *   slice coordinates and then translates it onto the plane -- its comment: "Move the interaction
 *   handle to the slice plane to prevent it from being clipped." A handle off the plane cannot be
 *   clicked in a view that can only be clicked on its plane, so it is brought onto it.
 *
 *   THE SLICE NORMAL IS THE VIEW DIRECTION. `GetHandleToCameraVectorWorld` returns the slice plane
 *   normal in a slice view where it returns the camera vector in 3D.
 *
 *   A HANDLE IS DROPPED ONLY WHEN ITS AXIS IS NEARLY ALONG THAT DIRECTION -- within FADE_DEG (see
 *   above), not merely whenever it is the most view-aligned of the three.
 *
 * The four corners of the rectangle a slice cuts out of the box are the projections of the four
 * EDGES crossing the slice, and that is how they are offered: dragging one resizes the two sides you
 * can see, because the handle names that pair. Slicer has the same twelve edge handles and
 * `ScaleWidgetROI` moves both bounds an edge appears in. Offering the box's corners instead would
 * put two coincident glyphs at each of those points -- the two ends of the edge -- and a click could
 * not say which was meant.
 *
 * What is left is 4 sides + 4 corners + the center, ON the plane, every one of them draggable with
 * no ambiguity about the axis the cursor cannot aim. An empty list means the plane misses the box
 * entirely, and then there is no outline to put handles on either.
 */
export function sliceHandles(
  box: { center: Vec3 | readonly number[]; half: Vec3 | readonly number[]; axes?: number[] },
  point: Vec3 | readonly number[],
  normal: Vec3 | readonly number[],
): { id: number; world: Vec3; data: HandleMeta; cursor: string }[] {
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(nl > 0)) return [];
  const n: Vec3 = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const A = box.axes && box.axes.length === 9 ? box.axes : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const col = (k: number): Vec3 => [A[k], A[3 + k], A[6 + k]];
  const dotN = (v: Vec3) => v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const c = box.center, h = box.half;
  const lean = [0, 1, 2].map((k) => dotN(col(k)));
  // THROUGH-PLANE: the axis the slice looks along. The four edges parallel to it are what the
  // rectangle's corners are, so it is always well defined -- while whether its two FACES are worth
  // offering is Slicer's fade question, and on a strongly oblique box the answer is yes.
  let t = 0;
  for (let k = 1; k < 3; k++) if (Math.abs(lean[k]) > Math.abs(lean[t])) t = k;
  const hidden = degenerateAxis(box.axes, n);          // -1 when no axis is nearly along the normal
  const inPlane = [0, 1, 2].filter((k) => k !== t) as [number, number];
  // DOES THE PLANE CUT THE BOX AT ALL? The box's extent along the normal is the sum of each
  // half-extent's projection; the center's distance beyond that means no intersection.
  const base = dotN([c[0] - point[0], c[1] - point[1], c[2] - point[2]]);
  const reach = [0, 1, 2].reduce((sum, k) => sum + Math.abs(h[k] * lean[k]), 0);
  if (Math.abs(base) > reach) return [];
  const at = (s: readonly number[]): Vec3 => {
    const u = col(0), v = col(1), w = col(2);
    return [
      c[0] + u[0] * s[0] * h[0] + v[0] * s[1] * h[1] + w[0] * s[2] * h[2],
      c[1] + u[1] * s[0] * h[0] + v[1] * s[1] * h[1] + w[1] * s[2] * h[2],
      c[2] + u[2] * s[0] * h[0] + v[2] * s[1] * h[1] + w[2] * s[2] * h[2],
    ];
  };
  /** Drop the component along the normal: the point ON the plane, where it can be clicked. */
  const onPlane = (w: Vec3): Vec3 => {
    const d = dotN([w[0] - point[0], w[1] - point[1], w[2] - point[2]]);
    return [w[0] - n[0] * d, w[1] - n[1] * d, w[2] - n[2] * d];
  };
  const out: { id: number; world: Vec3; data: HandleMeta; cursor: string }[] = [];
  const push = (m: HandleMeta, w: Vec3) =>
    out.push({ id: handleId(m), world: onPlane(w), data: m, cursor: m.kind === "center" ? "move" : "grab" });
  for (let k = 0; k < 3; k++) {
    if (k === hidden) continue;                        // its axis points along the normal: unaimable
    for (const sign of [-1, 1] as const) {
      const s = [0, 0, 0];
      s[k] = sign;
      push({ kind: "face", axis: k as 0 | 1 | 2, sign }, at(s));
    }
  }
  for (const a of [-1, 1] as const) {
    for (const b of [-1, 1] as const) {
      const s = [0, 0, 0];
      s[inPlane[0]] = a; s[inPlane[1]] = b;            // the edge's midpoint: zero along t
      push({ kind: "edge", axes: [inPlane[0] as 0 | 1 | 2, inPlane[1] as 0 | 1 | 2], s: [a, b] }, at(s));
    }
  }
  push({ kind: "center" }, [c[0], c[1], c[2]]);
  return out;
}

/** Build an ROI widget spanning the middle `coverage` of the [lo,hi] volume box. */
export function createRoiWidget(lo: Vec3, hi: Vec3, opts: RoiWidgetOpts = {}): RoiWidget {
  const MIN_HALF = opts.minHalfMm ?? 5;
  let axes = opts.axes && opts.axes.length === 9 ? [...opts.axes] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Column k: the box's k-th axis in world. */
  const ax = (k: number): Vec3 => [axes[k], axes[3 + k], axes[6 + k]];
  /** A world vector's component along box axis k. Identity axes make this v[k]. */
  const along = (v: Vec3 | readonly number[], k: number): number => {
    const a = ax(k);
    return v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  };
  const cov = opts.coverage ?? 0.35;
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half: Vec3 = [(hi[0] - lo[0]) * cov, (hi[1] - lo[1]) * cov, (hi[2] - lo[2]) * cov];
  const hR = Math.max(3, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 0.012);
  // Thin bars: the frame is a reference, not a feature. At 0.35 of the handle radius they read as
  // fat painted lines against the sculpted volume; a third of that still reads crisply at any zoom.
  const bar = Math.max(0.5, hR * 0.12);

  // Warm ivory rather than saturated gold: gold was chosen against the old dark navy view and reads
  // loud on Slicer's pale lavender. Kept off pure ivory so it still separates from the background.
  const box = new RoiBoxField(center, half, { color: [...ROI_BAR_RGB], barHalfMm: bar, axes });
  // Screen-space (constant on-screen size), ghost (shine through), not clipped by the box.
  // ghost:false — ghost mode multiplies every non-hovered glyph by 0.5 (fiducial-field.ts), which
  // halved these handles on top of their own alpha and left them washed out against Slicer's light
  // background. Hover is still distinguished by color and radius, so the cue is not lost.
  const handles = new FiducialField([], { shininess: 60, kSpecular: 0.4, clippable: false, screenSpace: true, ghost: false });
  let hover: number | null = null;

  // Handle layout: 6 face centres + 8 corners + 1 centre = 15, in a fixed order so `id`
  // maps stably to a descriptor.
  const metas: HandleMeta[] = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1] as const) metas.push({ kind: "face", axis: axis as 0 | 1 | 2, sign });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) metas.push({ kind: "corner", s: [sx, sy, sz] });
  metas.push({ kind: "center" });

  /** center + a*u + b*v + c*w, in world. With identity axes this is the old component arithmetic. */
  const offset = (a: number, b: number, c: number): Vec3 => {
    const u = ax(0), v = ax(1), w = ax(2);
    return [
      center[0] + u[0] * a + v[0] * b + w[0] * c,
      center[1] + u[1] * a + v[1] * b + w[1] * c,
      center[2] + u[2] * a + v[2] * b + w[2] * c,
    ];
  };
  const worldOf = (m: HandleMeta): Vec3 => {
    if (m.kind === "center") return [...center] as Vec3;
    if (m.kind === "face") {
      const d = [0, 0, 0];
      d[m.axis] = m.sign * half[m.axis];
      return offset(d[0], d[1], d[2]);
    }
    if (m.kind === "edge") {
      const d = [0, 0, 0];                              // an edge's MIDPOINT: zero along its own run
      d[m.axes[0]] = m.s[0] * half[m.axes[0]];
      d[m.axes[1]] = m.s[1] * half[m.axes[1]];
      return offset(d[0], d[1], d[2]);
    }
    return offset(m.s[0] * half[0], m.s[1] * half[1], m.s[2] * half[2]);
  };

  const refreshHandles = () => {
    // Radii in PIXELS (screen-space); hovered = larger + warm. Colors have to read against
    // Slicer's LIGHT background (render/background.ts): the original light-blue at 50% alpha was
    // tuned for the old dark navy view and turned nearly invisible on pale lavender, so idle
    // handles are saturated and near-opaque, and the hover color is warm for contrast.
    const pins: Sphere[] = metas.map((m, i): Sphere => {
      const on = i === hover;
      const base = m.kind === "center" ? ROI_CENTER_RGB : ROI_HANDLE_RGB;
      return {
        center: worldOf(m),
        radius: on ? 13 : 9,
        color: on ? [...ROI_HOVER_RGB, 1] : [base[0], base[1], base[2], 0.95],
      };
    });
    handles.setSpheres(pins);
  };
  refreshHandles();

  /**
   * Move one face along the box's OWN axis, keeping the opposite face fixed.
   *
   * Returns the new center COORDINATE ALONG THAT AXIS and the new half-extent. Positions along a box
   * axis are `dot(center, axis)`, which for identity axes is `center[axis]` -- so this is the same
   * arithmetic it always was, read in the box's basis instead of the patient's.
   */
  const moveFace = (axis: number, sign: number, box0: Box, deltaAxis: number): [number, number] => {
    const c0 = along(box0.center, axis);
    const opp = c0 - sign * box0.half[axis];
    let face = c0 + sign * box0.half[axis] + deltaAxis;
    face = sign > 0 ? Math.max(face, opp + 2 * MIN_HALF) : Math.min(face, opp - 2 * MIN_HALF);
    return [(face + opp) / 2, Math.abs(face - opp) / 2];
  };
  /** Shift the center so its coordinate along box axis k becomes `want`. */
  const setAlong = (k: number, want: number) => {
    const d = want - along(center, k), a = ax(k);
    center[0] += a[0] * d; center[1] += a[1] * d; center[2] += a[2] * d;
  };

  return {
    box, handles, center, half,
    lo: () => [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    hi: () => [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
    handleList: () => metas.map((m, i) => ({
      id: i, world: worldOf(m), data: m,
      cursor: m.kind === "center" ? "move" : "grab",
    })),
    applyDrag(meta, box0, delta, viewDir) {
      if (meta.kind === "center") {
        for (let a = 0; a < 3; a++) center[a] = box0.center[a] + delta[a];
      } else if (meta.kind === "face") {
        const [c, h] = moveFace(meta.axis, meta.sign, box0, along(delta, meta.axis));
        half[meta.axis] = h; setAlong(meta.axis, c);
      } else if (meta.kind === "edge") {
        // TWO BOUNDS, the two the handle names -- Slicer's ScaleWidgetROI moves both of the bounds an
        // edge appears in. No third axis to decide about, which is the whole reason a slice offers
        // edges where the rectangle has corners.
        const want: [number, number][] = [];
        for (let i = 0; i < 2; i++) {
          const a = meta.axes[i];
          const [c, h] = moveFace(a, meta.s[i], box0, along(delta, a));
          want.push([a, c]);
          half[a] = h;
        }
        for (const [a, c] of want) setAlong(a, c);
      } else {
        // Skip an axis pointing INTO the screen: the cursor cannot aim it, so resizing it turns a
        // corner drag into an unpredictable depth change on top of the resize. Only when it is
        // nearly along the view direction, which is Slicer's own test (FADE_DEG) -- on a box seen
        // from an oblique angle every axis gets a real share of the cursor's motion, and this used
        // to hold the most view-aligned of the three however far from the camera axis it was.
        const skip = viewDir ? degenerateAxis(axes, viewDir) : -1;
        // Every face first, then the center shifts, so each moveFace reads the ORIGINAL center.
        const want: [number, number][] = [];
        for (let a = 0; a < 3; a++) {
          if (a === skip) continue;
          want.push([a, 0]);
          const [c, h] = moveFace(a, meta.s[a], box0, along(delta, a));
          want[want.length - 1][1] = c;
          half[a] = h;
        }
        for (const [a, c] of want) setAlong(a, c);
      }
      box.setBox(center, half);
      refreshHandles();
    },
    sliceHandles: (point, normal) => sliceHandles({ center, half, axes }, point, normal),
    setHover(i) { hover = i; refreshHandles(); },
    snapshot: () => ({ center: [...center] as Vec3, half: [...half] as Vec3 }),
    setBox(c, h) { for (let a = 0; a < 3; a++) { center[a] = c[a]; half[a] = h[a]; } box.setBox(center, half); refreshHandles(); },
    setAxes(a) { axes = a && a.length === 9 ? [...a] : [1, 0, 0, 0, 1, 0, 0, 0, 1]; box.setAxes(axes); refreshHandles(); },
  };
}
