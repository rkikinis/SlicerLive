/**
 * THE HEART'S OWN AXES, from a segmentation of it.
 *
 * Cardiac imaging is read in planes set by the heart, not by the body: the AHA statement on
 * standardized myocardial segmentation (Cerqueira et al., Circulation 2002;105:539-542) defines
 * them from the long axis of the left ventricle -- the line from the apex to the center of the
 * mitral valve. The SHORT-AXIS planes are perpendicular to it; the ventricle is divided into equal
 * thirds along it (basal, mid-cavity, apical) for the 17-segment model; the two long-axis planes
 * contain it: the HORIZONTAL long axis (four-chamber) also passes through the right ventricle,
 * the VERTICAL long axis (two-chamber) is perpendicular to that.
 *
 * Everything here is computed from labels alone -- left ventricular cavity, left ventricular
 * myocardium, left atrium, right ventricular cavity -- which every heart-chamber network provides
 * (TotalSegmentator heartchambers_highres, MOOSE clin_ct_cardiac, the MM-WHS classes). The mitral
 * center is the centroid of the cavity voxels that touch the left atrium; the apex is the point of
 * the left ventricle (cavity plus myocardium) farthest from it.
 *
 * Display conventions follow cardiac MR practice, which is what readers expect:
 *   short axis   viewed from the apex toward the base -- right ventricle on the LEFT of the
 *                picture, anterior wall at the TOP;
 *   four-chamber apex on the LEFT, atria on the right, right ventricle at the top (it is anterior);
 *                the same way round as the two-chamber, which is perpendicular to it (Ron,
 *                2026-09-20: the apex pointed up while the two-chamber's pointed left);
 *   two-chamber  apex on the left, atrium on the right, anterior wall at the top.
 * The plane matrices use the slice views' own handedness (screen-right x screen-up = -normal, the
 * radiological convention of the axial preset), so a cardiac plane is just another sliceToRAS.
 */
import type { Vec3 } from "../render/mat4.ts";

export interface CardiacLabels { lv: number; myocardium?: number; la: number; rv: number }

/** One slice plane: RAS unit vectors for screen-right, screen-up and the normal, plus an origin. */
export interface CardiacPlane { u: Vec3; v: Vec3; n: Vec3; origin: Vec3 }

export interface CardiacAxes {
  /** RAS, mm. */
  apex: Vec3;
  mitral: Vec3;
  lvCenter: Vec3;
  rvCenter: Vec3;
  /** Unit vector from the mitral center to the apex. */
  longAxis: Vec3;
  /** Apex-to-base length, mm. */
  length: number;
  shortAxis: CardiacPlane;
  fourChamber: CardiacPlane;
  twoChamber: CardiacPlane;
  /** Short-axis origins at the centers of the basal, mid and apical thirds (Cerqueira 2002). */
  levels: { basal: Vec3; mid: Vec3; apical: Vec3 };
  /**
   * How far the labeled heart reaches from each plane's origin along its normal, mm: the
   * farthest labeled voxel on either side. A slice slider that runs origin +/- reach starts in
   * the middle and covers the heart and nothing else -- Ron: "initial slice view in the center
   * of the slider."
   */
  reach: { shortAxis: number; fourChamber: number; twoChamber: number };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, t = 1): Vec3 => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** The part of `a` perpendicular to unit `n`. */
const perp = (a: Vec3, n: Vec3): Vec3 => add(a, n, -dot(a, n));

/**
 * Pick the chamber labels out of a segmentation's segment list by name. Names are the
 * catalog's readable ones ("Left ventricle of heart") or a network's own ("heart_ventricle_left").
 */
export function findCardiacLabels(segments: { labelValue: number; name?: string }[]): CardiacLabels | null {
  const find = (re: RegExp) => segments.find((s) => re.test((s.name ?? "").toLowerCase()))?.labelValue;
  const lv = find(/left ventric|ventricle_left|^lv$|lv cavity/);
  const la = find(/left atri|atrium_left|^la$/);
  const rv = find(/right ventric|ventricle_right|^rv$/);
  const myocardium = find(/myocard/);
  if (lv === undefined || la === undefined || rv === undefined) return null;
  return { lv, la, rv, myocardium };
}

/**
 * The axes, from a labelmap on a grid (row-major ijkToRAS). Two passes over the voxels at a
 * stride of 2 for the centroids and the apex, one pass over the cavity for the valve; ~0.3 s on
 * a 512x512x533 grid.
 */
export function cardiacAxes(labels: ArrayLike<number>, dims: [number, number, number], ijkToRAS: ArrayLike<number>, L: CardiacLabels): CardiacAxes | null {
  const [nx, ny, nz] = dims;
  const M = ijkToRAS;
  const ras = (i: number, j: number, k: number): Vec3 => [
    M[0] * i + M[1] * j + M[2] * k + M[3],
    M[4] * i + M[5] * j + M[6] * k + M[7],
    M[8] * i + M[9] * j + M[10] * k + M[11],
  ];
  const acc = { lv: [0, 0, 0, 0], rv: [0, 0, 0, 0], la: [0, 0, 0, 0], mv: [0, 0, 0, 0] };
  const bump = (a: number[], i: number, j: number, k: number) => { a[0] += i; a[1] += j; a[2] += k; a[3]++; };
  const S = 2;
  for (let k = 0; k < nz; k += S) for (let j = 0; j < ny; j += S) {
    const row = k * nx * ny + j * nx;
    for (let i = 0; i < nx; i += S) {
      const v = labels[row + i];
      if (v === L.lv) bump(acc.lv, i, j, k);
      else if (v === L.rv) bump(acc.rv, i, j, k);
      else if (v === L.la) bump(acc.la, i, j, k);
    }
  }
  if (!acc.lv[3] || !acc.rv[3] || !acc.la[3]) return null;
  const centroid = (a: number[]) => ras(a[0] / a[3], a[1] / a[3], a[2] / a[3]);
  const lvCenter = centroid(acc.lv), rvCenter = centroid(acc.rv);
  // THE VALVE: cavity voxels with an atrium among their six neighbors.
  const nxy = nx * ny;
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) {
    const row = k * nxy + j * nx;
    for (let i = 1; i < nx - 1; i++) {
      const p = row + i;
      if (labels[p] !== L.lv) continue;
      if (labels[p - 1] === L.la || labels[p + 1] === L.la || labels[p - nx] === L.la || labels[p + nx] === L.la || labels[p - nxy] === L.la || labels[p + nxy] === L.la) bump(acc.mv, i, j, k);
    }
  }
  if (!acc.mv[3]) return null;
  const mitral = centroid(acc.mv);
  // THE APEX: the far end of the ventricle along its axis. Not the single farthest voxel -- on
  // a blunt or flattened apex that is a point on the rim, and the axis through it leans. The axis
  // starts as valve-to-centroid; the apex is the centroid of the ventricle's last 3 mm along it;
  // the axis is redrawn through that and the step repeated once, which settles it.
  const myo = L.myocardium;
  let longAxis = unit(sub(lvCenter, mitral));
  let apex: Vec3 = lvCenter;
  for (let pass = 0; pass < 2; pass++) {
    let tmax = -Infinity;
    for (let k = 0; k < nz; k += S) for (let j = 0; j < ny; j += S) {
      const row = k * nxy + j * nx;
      for (let i = 0; i < nx; i += S) {
        const v = labels[row + i];
        if (v !== L.lv && v !== myo) continue;
        const t = dot(sub(ras(i, j, k), mitral), longAxis);
        if (t > tmax) tmax = t;
      }
    }
    const cap = [0, 0, 0, 0];
    for (let k = 0; k < nz; k += S) for (let j = 0; j < ny; j += S) {
      const row = k * nxy + j * nx;
      for (let i = 0; i < nx; i += S) {
        const v = labels[row + i];
        if (v !== L.lv && v !== myo) continue;
        if (dot(sub(ras(i, j, k), mitral), longAxis) > tmax - 3) bump(cap, i, j, k);
      }
    }
    if (!cap[3]) return null;
    apex = centroid(cap);
    longAxis = unit(sub(apex, mitral));
  }
  const length = len(sub(apex, mitral));
  const toBase = unit(sub(mitral, apex));
  const A: Vec3 = [0, 1, 0];
  // SHORT AXIS. Screen-right runs from the right ventricle toward the left, in the plane; the
  // viewing direction is whichever of the two puts the anterior wall at the top (see the header).
  const rvToLv = unit(perp(sub(lvCenter, rvCenter), longAxis));
  let n = toBase;
  let v = cross(rvToLv, n);
  if (dot(v, A) < 0) { n = longAxis; v = cross(rvToLv, n); }
  const mid = add(mitral, longAxis, length / 2);
  const shortAxis: CardiacPlane = { u: rvToLv, v: unit(v), n, origin: mid };
  // FOUR-CHAMBER: the long axis and the right ventricle in one plane; apex on the left, base on
  // the right, the right ventricle (anterior) at the top -- read the same way as the two-chamber.
  const u4 = toBase;
  const v4 = unit(perp(sub(rvCenter, lvCenter), u4));
  const fourChamber: CardiacPlane = { u: u4, v: v4, n: cross(v4, u4), origin: mid };
  // TWO-CHAMBER: perpendicular to the four-chamber through the long axis; apex on the left,
  // anterior wall at the top.
  const u2 = toBase;
  const n2 = v4;                              // perpendicular to the four-chamber, through the long axis
  const v2raw = perp(perp(A, n2), u2);
  const v2 = unit(len(v2raw) > 1e-6 ? v2raw : cross(n2, u2));
  const n2signed = cross(v2, u2);            // the handedness the slice views use
  const twoChamber: CardiacPlane = { u: u2, v: v2, n: unit(n2signed), origin: mid };
  // THE REACH: one more pass at the stride, over every labeled voxel, for the three normals.
  const planes = [shortAxis, fourChamber, twoChamber];
  const reach = [0, 0, 0];
  for (let k = 0; k < nz; k += S) for (let j = 0; j < ny; j += S) {
    const row = k * nxy + j * nx;
    for (let i = 0; i < nx; i += S) {
      const v = labels[row + i];
      if (v !== L.lv && v !== L.rv && v !== L.la && v !== myo) continue;
      const p = ras(i, j, k);
      for (let q = 0; q < 3; q++) { const d = Math.abs(dot(sub(p, planes[q].origin), planes[q].n)); if (d > reach[q]) reach[q] = d; }
    }
  }
  return {
    apex, mitral, lvCenter, rvCenter, longAxis, length, shortAxis, fourChamber, twoChamber,
    levels: { basal: add(mitral, longAxis, length / 6), mid, apical: add(mitral, longAxis, length * 5 / 6) },
    reach: { shortAxis: reach[0], fourChamber: reach[1], twoChamber: reach[2] },
  };
}

/** A plane as a row-major 4x4 sliceToRAS: columns u, v, n and the origin. */
export function planeToSliceToRAS(p: CardiacPlane, origin: Vec3 = p.origin): number[] {
  return [
    p.u[0], p.v[0], p.n[0], origin[0],
    p.u[1], p.v[1], p.n[1], origin[1],
    p.u[2], p.v[2], p.n[2], origin[2],
    0, 0, 0, 1,
  ];
}

export type CardiacView = "short-axis" | "four-chamber" | "two-chamber";
export const CARDIAC_VIEWS: { id: CardiacView; label: string; tip: string }[] = [
  { id: "short-axis", label: "Short axis", tip: "Perpendicular to the long axis of the left ventricle; viewed from the apex, right ventricle on the left" },
  { id: "four-chamber", label: "4-chamber", tip: "Horizontal long axis: through the left ventricle's long axis and the right ventricle" },
  { id: "two-chamber", label: "2-chamber", tip: "Vertical long axis: through the long axis, perpendicular to the 4-chamber plane" },
];
export function cardiacPlane(a: CardiacAxes, view: CardiacView): CardiacPlane {
  return view === "short-axis" ? a.shortAxis : view === "four-chamber" ? a.fourChamber : a.twoChamber;
}
