// THREE SLICES FROM A LINE: one across it, two along it at 90 degrees -- the heart's planes (logic/cardiac-axes.ts), with
// the axis given by hand instead of found in a segmentation.
//
// Ron, 2026-09-25, wanting to join a stray piece of the inferior vena cava to the rest by painting on a slice along the
// vessel: "I could provide two markups for orienting three oblique slices (same philosophy as with the heart). The two
// markups would define the axis." A Line markup's two points are that axis.
//
// The planes are oriented so that a line running head-to-foot gives exactly the body's own three: across = axial,
// along-1 = sagittal, along-2 = coronal (the matrices 3D Slicer uses for those). For any other line they tilt with it:
// "up" in the along views is the line's end nearer the head, and the along-2 plane is turned to face front-to-back as
// closely as the line allows (along-1 is at 90 degrees to it).
import type { CardiacPlane } from "./cardiac-axes.ts";

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export type LineView = "across" | "along-1" | "along-2";
export const LINE_VIEWS: { id: LineView; label: string; tip: string }[] = [
  { id: "across", label: "Across", tip: "Perpendicular to the line; the slider moves along it" },
  { id: "along-1", label: "Along 1", tip: "Through the line, facing sideways (a sagittal slice tilted to the line)" },
  { id: "along-2", label: "Along 2", tip: "Through the line, facing front-to-back (a coronal slice tilted to the line)" },
];

export interface LineAxes {
  /** The two points, RAS mm, and the midpoint. */
  p0: Vec3; p1: Vec3; mid: Vec3;
  /** Unit direction, pointing toward the head end (or, for a line with no head-to-foot component, forward). */
  dir: Vec3;
  /** Length, mm. */
  length: number;
  across: CardiacPlane; along1: CardiacPlane; along2: CardiacPlane;
}

const S: Vec3 = [0, 0, 1], A: Vec3 = [0, 1, 0];

/** The three planes for a line from p0 to p1 (RAS mm), or null when the two points coincide. */
export function lineAxes(p0: Vec3, p1: Vec3): LineAxes | null {
  const d = sub(p1, p0);
  const length = Math.hypot(d[0], d[1], d[2]);
  if (length < 1e-6) return null;
  let s = norm(d);
  // "Up" is the head end; a line lying level (no head-to-foot part to speak of) points forward instead.
  if (dot(s, S) < -1e-6 || (Math.abs(dot(s, S)) <= 1e-6 && dot(s, A) < 0)) s = scale(s, -1);
  // The front-to-back direction perpendicular to the line; for a line that itself runs front-to-back, head-to-foot.
  let ref = sub(A, scale(s, dot(A, s)));
  if (Math.hypot(ref[0], ref[1], ref[2]) < 0.3) ref = sub(S, scale(s, dot(S, s)));
  const a = norm(ref);
  const r = norm(cross(a, s));
  const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
  return {
    p0, p1, mid, dir: s, length,
    across: { u: r, v: a, n: s, origin: mid },     // axial-like: right, anterior; normal along the line
    along1: { u: a, v: s, n: r, origin: mid },     // sagittal-like: anterior, up; normal to the side
    along2: { u: r, v: s, n: a, origin: mid },     // coronal-like: right, up; normal front-to-back
  };
}

export function linePlane(ax: LineAxes, view: LineView): CardiacPlane {
  return view === "across" ? ax.across : view === "along-1" ? ax.along1 : ax.along2;
}

/** The slider's range for a view: across runs the line's length (a quarter more at each end); along runs the same
 *  distance either side of the line. In mm along the plane's normal. */
export function lineRange(ax: LineAxes, view: LineView): { min: number; max: number } {
  const p = linePlane(ax, view);
  const o = dot(p.origin, p.n);
  const half = ax.length / 2 + ax.length * 0.25 + 5;
  return { min: o - half, max: o + half };
}

/** The field of view that frames the line: its length and some context around it. */
export function lineFieldOfView(ax: LineAxes, view: LineView): number {
  return view === "across" ? Math.max(40, ax.length * 1.2) : Math.max(60, ax.length * 1.8);
}

/** A slice node's orientation value for a line's view, and back. */
export const lineOrientation = (markupId: string, view: LineView) => `line:${markupId}:${view}`;
export function parseLineOrientation(o: string | undefined): { markupId: string; view: LineView } | null {
  const m = /^line:(.+):(across|along-1|along-2)$/.exec(o ?? "");
  return m ? { markupId: m[1], view: m[2] as LineView } : null;
}
