// Crop a volume to a box, ON THE VOXEL GRID.
//
// Ron, on the studyforrest T1: "About half of the volume is neck. I could crop, if I had a crop
// tool." It is not only tidiness. FastSurfer's conformed grid is derived from the FIELD OF VIEW, so
// a 256 mm box conforms to 384^3 and its 79-class score field is 4.47 billion values -- past what
// Apple's GPU can address, which is why full-resolution FastSurfer fails on this study. A head-tight
// box of about 200 mm conforms to roughly 300^3, and 79 x 300^3 is 2.1 billion. Cropping the neck
// away is what makes the run possible at full resolution rather than at 1 mm.
//
// SO IT MUST NOT RESAMPLE. The whole reason to crop here is to keep resolution -- Ron: "For the
// brain it would be very important to stay with the best possible resolution. Many fiddly bits in
// the brain." Resampling to an axis-aligned box would interpolate every voxel and throw away the
// thing being protected. This takes a sub-box of the existing grid instead: the voxels that come out
// are bit-identical to the voxels that went in, and only the origin of `ijkToRAS` moves.
//
// The consequence of not resampling is that the result contains the requested box and a little more.
// The volume is oblique, so an axis-aligned box in patient space is a tilted region in voxel space;
// the smallest sub-box of the grid that holds it is bigger than the box itself. That is the honest
// trade and it errs the safe way -- nothing the user asked to keep is ever cut.

/**
 * A box in patient space (RAS), as the `roi` markup stores one.
 *
 * `axes` IS THE DIFFERENCE BETWEEN A CROP THAT WORKS AND ONE THAT DOES NOT. An axis-aligned box is
 * the wrong instrument for an oblique volume: measured on the test study, the tightest RAS-aligned box
 * around the tissue maps back onto the tilted voxel grid as 274x384x384 -- the whole volume. Ron:
 * "The cropped volume is not cropped." A box aligned to the VOLUME's own axes has no such slack,
 * and it is the only kind that can be cropped without resampling, which is why Slicer's ROI carries
 * an ObjectToNodeMatrix ("the directional axis of the ROI") and its Crop Volume must resample when
 * the ROI is not aligned to the input.
 *
 * Row-major 3x3, COLUMNS are the box's unit axes in RAS. Absent means axis-aligned.
 */
export interface Box {
  center: [number, number, number];
  size: [number, number, number];
  axes?: number[];
}

/** The box's own axis `k` as a unit vector in RAS. */
export function boxAxis(box: Box, k: 0 | 1 | 2): [number, number, number] {
  const a = box.axes;
  if (!a) return [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
  const v: [number, number, number] = [a[k], a[3 + k], a[6 + k]];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The eight corners, in RAS, honoring the box's own axes. */
export function boxCorners(box: Box): [number, number, number][] {
  const u = boxAxis(box, 0), v = boxAxis(box, 1), w = boxAxis(box, 2);
  const out: [number, number, number][] = [];
  for (let n = 0; n < 8; n++) {
    const a = (n & 1 ? 0.5 : -0.5) * box.size[0];
    const b = (n & 2 ? 0.5 : -0.5) * box.size[1];
    const c = (n & 4 ? 0.5 : -0.5) * box.size[2];
    out.push([
      box.center[0] + u[0] * a + v[0] * b + w[0] * c,
      box.center[1] + u[1] * a + v[1] * b + w[1] * c,
      box.center[2] + u[2] * a + v[2] * b + w[2] * c,
    ]);
  }
  return out;
}

/** The unit axes of a volume's own grid, as a box `axes` matrix. */
export function axesOfVolume(ijkToRAS: readonly number[]): number[] {
  const col = (k: number) => {
    const v = [ijkToRAS[k], ijkToRAS[4 + k], ijkToRAS[8 + k]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const [a, b, c] = [col(0), col(1), col(2)];
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

export interface CropResult {
  data: ArrayLike<number> & { length: number };
  dims: [number, number, number];
  ijkToRAS: number[];
  /** Where the crop starts on the original grid, so the operation can be described and undone. */
  origin: [number, number, number];
}

/** Invert a row-major 4x4 whose last row is [0,0,0,1] (every ijkToRAS in this application). */
export function invertAffine(m: readonly number[]): number[] {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error("crop: ijkToRAS is not invertible");
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  const tx = -(inv[0] * t[0] + inv[1] * t[1] + inv[2] * t[2]);
  const ty = -(inv[3] * t[0] + inv[4] * t[1] + inv[5] * t[2]);
  const tz = -(inv[6] * t[0] + inv[7] * t[1] + inv[8] * t[2]);
  return [inv[0], inv[1], inv[2], tx, inv[3], inv[4], inv[5], ty, inv[6], inv[7], inv[8], tz, 0, 0, 0, 1];
}

const apply = (m: readonly number[], p: readonly number[]): [number, number, number] => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/**
 * The smallest whole-voxel range of the grid that contains `box`.
 *
 * All EIGHT corners, not two. The volume is oblique, so the box's extreme corners in patient space
 * are not its extreme corners in voxel space; transforming only the min and max would produce a
 * range that misses part of what was asked for, and would do it silently.
 *
 * Clamped to the volume, so a box hanging over the edge crops to what exists. Returns null when the
 * box misses the volume entirely, which is a thing to report rather than an empty array to render.
 */
export function voxelRangeFor(
  dims: readonly [number, number, number],
  ijkToRAS: readonly number[],
  box: Box,
): { lo: [number, number, number]; hi: [number, number, number] } | null {
  const rasToIjk = invertAffine(ijkToRAS);
  let lo: [number, number, number] = [Infinity, Infinity, Infinity];
  let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const corner of boxCorners(box)) {
    const v = apply(rasToIjk, corner);
    for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  }
  const out = {
    lo: [0, 0, 0] as [number, number, number],
    hi: [0, 0, 0] as [number, number, number],
  };
  for (let k = 0; k < 3; k++) {
    const a = Math.max(0, Math.floor(lo[k]));
    const b = Math.min(dims[k] - 1, Math.ceil(hi[k]));
    if (a > b) return null;                       // the box does not meet the volume
    out.lo[k] = a;
    out.hi[k] = b;
  }
  return out;
}

/**
 * Take the sub-box of `data` that holds `box`. The voxels are copied unchanged.
 *
 * `dims` is [nx, ny, nz] and `data` is C-order (z, y, x) -- the layout every volume in this
 * application uses, and the one `volumeToZarr` writes.
 */
export function cropVolume<T extends { length: number; [i: number]: number }>(
  data: T,
  dims: readonly [number, number, number],
  ijkToRAS: readonly number[],
  box: Box,
  make: (n: number) => T,
): CropResult | null {
  const r = voxelRangeFor(dims, ijkToRAS, box);
  if (!r) return null;
  const [nx, ny] = dims;
  const w = r.hi[0] - r.lo[0] + 1, h = r.hi[1] - r.lo[1] + 1, d = r.hi[2] - r.lo[2] + 1;
  const out = make(w * h * d);
  for (let k = 0; k < d; k++) {
    const sk = (r.lo[2] + k) * ny;
    for (let j = 0; j < h; j++) {
      const srcRow = ((sk + r.lo[1] + j) * nx) + r.lo[0];
      const dstRow = ((k * h + j) * w);
      for (let i = 0; i < w; i++) out[dstRow + i] = data[srcRow + i];
    }
  }
  // Only the ORIGIN moves. The direction cosines and the spacing are the source's, unchanged, which
  // is what makes this lossless and what keeps a segmentation made on the crop aligned with the
  // original.
  const o = apply(ijkToRAS, r.lo);
  const m = [...ijkToRAS];
  m[3] = o[0]; m[7] = o[1]; m[11] = o[2];
  return { data: out, dims: [w, h, d], ijkToRAS: m, origin: [...r.lo] as [number, number, number] };
}

/**
 * A box around everything above `frac` of the volume's peak intensity, padded by `padMm`.
 *
 * A starting box, not an answer: it is what a person then drags. The test study is "about half neck",
 * and thresholding finds the head and the neck alike -- so this narrows an empty 256 mm field of
 * view down to the tissue, and the operator does the anatomy.
 */
export function boxAroundData(
  data: { length: number; [i: number]: number },
  dims: readonly [number, number, number],
  ijkToRAS: readonly number[],
  opts: { frac?: number; padMm?: number } = {},
): Box | null {
  const frac = opts.frac ?? 0.08, pad = opts.padMm ?? 10;
  const [nx, ny, nz] = dims;
  let peak = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > peak) peak = data[i];
  const t = peak * frac;
  let lo: [number, number, number] = [nx, ny, nz], hi: [number, number, number] = [-1, -1, -1];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        if (data[row + i] <= t) continue;
        if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i;
        if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j;
        if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k;
      }
    }
  }
  if (hi[0] < 0) return null;                     // nothing above the threshold
  // ALIGNED TO THE VOLUME, and built from the voxel range rather than from two transformed corners.
  //
  // Both halves of that mattered. Taking only the `lo` and `hi` corners is right for an axis-aligned
  // volume and wrong for an oblique one -- on the test study it understated the extent by 85 mm in R and
  // 84 mm in A. And correcting THAT alone made things worse, not better: the true RAS-aligned box
  // around the tissue maps back onto the tilted grid as the entire volume. "The cropped volume is not
  // cropped." A box on the volume's own axes has neither problem, and is the only kind that crops
  // without resampling.
  const spacing = (k: number) => Math.hypot(ijkToRAS[k], ijkToRAS[4 + k], ijkToRAS[8 + k]) || 1;
  const padV = [pad / spacing(0), pad / spacing(1), pad / spacing(2)];
  const l: [number, number, number] = [
    Math.max(0, lo[0] - padV[0]), Math.max(0, lo[1] - padV[1]), Math.max(0, lo[2] - padV[2]),
  ];
  const h: [number, number, number] = [
    Math.min(nx - 1, hi[0] + padV[0]), Math.min(ny - 1, hi[1] + padV[1]), Math.min(nz - 1, hi[2] + padV[2]),
  ];
  const center = apply(ijkToRAS, [(l[0] + h[0]) / 2, (l[1] + h[1]) / 2, (l[2] + h[2]) / 2]);
  return {
    center,
    size: [(h[0] - l[0]) * spacing(0), (h[1] - l[1]) * spacing(1), (h[2] - l[2]) * spacing(2)],
    axes: axesOfVolume(ijkToRAS),
  };
}

/** The whole volume as a box in patient space: the smallest RAS box containing all eight corners. */
export function volumeAlignedBox(
  dims: readonly [number, number, number],
  ijkToRAS: readonly number[],
): Box {
  const c = apply(ijkToRAS, [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2]);
  const len = (k: number) =>
    Math.hypot(ijkToRAS[k], ijkToRAS[4 + k], ijkToRAS[8 + k]) * (dims[k] - 1);
  return { center: c, size: [len(0), len(1), len(2)], axes: axesOfVolume(ijkToRAS) };
}

export function boundingBoxOf(
  dims: readonly [number, number, number],
  ijkToRAS: readonly number[],
): Box {
  let lo: [number, number, number] = [Infinity, Infinity, Infinity];
  let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < 8; n++) {
    const p = apply(ijkToRAS, [
      n & 1 ? dims[0] - 1 : 0,
      n & 2 ? dims[1] - 1 : 0,
      n & 4 ? dims[2] - 1 : 0,
    ]);
    for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  }
  return {
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  };
}

/**
 * Trim a box on one patient axis, keeping the side the slice views are showing.
 *
 * Ron, looking at the sagittal view with the axial line just under the cerebellum: "The red
 * line/red viewer is a reasonable place to crop." Which is the right instrument -- a box dragged in
 * 3D is guessed at, and a slice line is placed while looking at the anatomy it cuts through.
 *
 * `keep` is "above" to keep the greater side of `at` on that axis (superior for the S axis), or
 * "below" for the lesser. Returns null when the cut leaves nothing.
 */
export function cutBox(box: Box, axis: 0 | 1 | 2, at: number, keep: "above" | "below"): Box | null {
  const u = boxAxis(box, axis);
  // Positions along the box's OWN axis, measured from the origin, so this works for an oriented box.
  const cAt = box.center[0] * u[0] + box.center[1] * u[1] + box.center[2] * u[2];
  const lo = cAt - box.size[axis] / 2, hi = cAt + box.size[axis] / 2;
  const nLo = keep === "above" ? Math.max(lo, at) : lo;
  const nHi = keep === "above" ? hi : Math.min(hi, at);
  if (nHi <= nLo) return null;
  const shift = (nLo + nHi) / 2 - cAt;
  const size: [number, number, number] = [...box.size];
  size[axis] = nHi - nLo;
  return {
    center: [box.center[0] + u[0] * shift, box.center[1] + u[1] * shift, box.center[2] + u[2] * shift],
    size,
    ...(box.axes ? { axes: [...box.axes] } : {}),
  };
}

/**
 * Trim a box at a PLANE, keeping the side the plane's normal points away from ("above" = the +normal
 * side).
 *
 * An oriented box cut by a plane that is not parallel to one of its faces is not a box, so this cuts
 * along the box axis most nearly parallel to the plane's normal. On a head study the volume's axes
 * are within a few degrees of the anatomical ones, so "everything above the axial line" is what it
 * means; `tiltDeg` reports how far off the two are, so a caller can say when the answer is loose
 * rather than pretending it is exact.
 */
export function cutBoxAtPlane(
  box: Box,
  point: readonly number[],
  normal: readonly number[],
  keep: "above" | "below",
): { box: Box; axis: 0 | 1 | 2; tiltDeg: number } | null {
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  if (!nl) return null;
  const n = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  let axis: 0 | 1 | 2 = 0, best = -1, sign = 1;
  for (const k of [0, 1, 2] as const) {
    const u = boxAxis(box, k);
    const d = u[0] * n[0] + u[1] * n[1] + u[2] * n[2];
    if (Math.abs(d) > best) { best = Math.abs(d); axis = k; sign = d < 0 ? -1 : 1; }
  }
  const u = boxAxis(box, axis);
  const at = point[0] * u[0] + point[1] * u[1] + point[2] * u[2];
  // If the box axis runs opposite the normal, "above the plane" is the lesser side along that axis.
  const side = sign > 0 ? keep : (keep === "above" ? "below" : "above");
  const cut = cutBox(box, axis, at, side);
  return cut ? { box: cut, axis, tiltDeg: Math.acos(Math.min(1, best)) * 180 / Math.PI } : null;
}

/**
 * Where a box crosses a plane: the polygon, in order, or null when it does not reach.
 *
 * THE BOX HAS TO BE VISIBLE WHERE THE ANATOMY IS. Ron: "When you look at slicers cropping tool, it
 * lives in all viewers, 2D and 3D." Slicer has a `vtkSlicerROIRepresentation2D` beside its 3D one --
 * every markup type there has both -- and the 2D form is the box's INTERSECTION with the slice, not
 * a projection of its wireframe. A projection would draw the whole box on every slice and say
 * nothing about where the cut falls; the intersection is the outline of what survives on the slice
 * you are actually looking at.
 *
 * Method: walk the twelve edges, keep the point where each crosses the plane, then order those
 * points by angle about their own centroid. A convex section of a convex solid is always a convex
 * polygon, so the angular order IS the polygon and no triangulation is needed.
 *
 * `normal` need not be unit length; `point` is any point on the plane.
 */
export function boxPlanePolygon(
  box: Box,
  point: readonly number[],
  normal: readonly number[],
): [number, number, number][] | null {
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  if (!nl) return null;
  const nrm = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
  const cs = boxCorners(box);
  const corner = (n: number): [number, number, number] => cs[n];
  const sd = (p: readonly number[]) =>
    nrm[0] * (p[0] - point[0]) + nrm[1] * (p[1] - point[1]) + nrm[2] * (p[2] - point[2]);

  // The twelve edges, as pairs of corner indices differing in exactly one bit.
  const pts: [number, number, number][] = [];
  for (let a = 0; a < 8; a++) {
    for (const bit of [1, 2, 4]) {
      const b = a | bit;
      if (b === a) continue;                     // that bit is already set: this edge is walked from the other end
      const pa = corner(a), pb = corner(b);
      const da = sd(pa), db = sd(pb);
      if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;   // both on one side
      if (da === db) continue;                   // the edge lies in the plane; its endpoints arrive via other edges
      const t = da / (da - db);
      pts.push([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t]);
    }
  }
  if (pts.length < 3) return null;

  // Order by angle about the centroid, in a basis of the plane.
  const g: [number, number, number] = [0, 0, 0];
  for (const p of pts) { g[0] += p[0] / pts.length; g[1] += p[1] / pts.length; g[2] += p[2] / pts.length; }
  const seed = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [
    seed[1] * nrm[2] - seed[2] * nrm[1],
    seed[2] * nrm[0] - seed[0] * nrm[2],
    seed[0] * nrm[1] - seed[1] * nrm[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]);
  const uu = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv = [
    nrm[1] * uu[2] - nrm[2] * uu[1],
    nrm[2] * uu[0] - nrm[0] * uu[2],
    nrm[0] * uu[1] - nrm[1] * uu[0],
  ];
  const ang = (p: readonly number[]) => {
    const d = [p[0] - g[0], p[1] - g[1], p[2] - g[2]];
    return Math.atan2(d[0] * vv[0] + d[1] * vv[1] + d[2] * vv[2], d[0] * uu[0] + d[1] * uu[1] + d[2] * uu[2]);
  };
  // Duplicates arrive when the plane passes exactly through a corner; drop them so the outline does
  // not double back on itself.
  const sorted = pts.sort((a, b) => ang(a) - ang(b));
  const out: [number, number, number][] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 1e-6) continue;
    out.push(p);
  }
  return out.length >= 3 ? out : null;
}
