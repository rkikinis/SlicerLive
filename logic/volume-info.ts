/**
 * WHAT A VOLUME IS, IN NUMBERS -- Slicer's Volumes module has a "Volume Information" section
 * (dimensions, spacing, origin, scalar type, scalar range) and Ron asked for the same here
 * (2026-09-15: "add information about voxel dimension and number of voxels in analogy to what is
 * available in slicer"). Everything is read off the node's own geometry: `dims` and the row-major
 * `ijkToRAS`, whose columns are the voxel steps in mm. Nothing here touches the voxels.
 */
export interface VolumeInfo {
  /** Voxels along i, j, k. */
  dims: [number, number, number];
  /** Voxel size along i, j, k in mm -- the length of each column of ijkToRAS. */
  spacing: [number, number, number];
  /** RAS of voxel (0,0,0). */
  origin: [number, number, number];
  /** Extent along i, j, k in mm: dims x spacing. */
  extentMm: [number, number, number];
  /** Total number of voxels. */
  voxels: number;
  /** Volume of one voxel in mm3, and of the whole grid in mL. */
  voxelMm3: number;
  totalMl: number;
  /** Whether the grid is aligned with RAS (every column along one axis) -- an oblique grid is said so. */
  axisAligned: boolean;
}

export function volumeInfo(dims: ArrayLike<number>, ijkToRAS: ArrayLike<number>): VolumeInfo {
  const M = ijkToRAS;
  const col = (c: number): [number, number, number] => [M[c], M[4 + c], M[8 + c]];
  const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  const d: [number, number, number] = [dims[0] | 0, dims[1] | 0, dims[2] | 0];
  const spacing: [number, number, number] = [len(col(0)), len(col(1)), len(col(2))];
  const origin: [number, number, number] = [M[3], M[7], M[11]];
  const voxels = d[0] * d[1] * d[2];
  // The voxel's volume is the determinant of the 3x3 (the parallelepiped the three steps span),
  // which equals the product of the spacings only when the grid is orthogonal.
  const a = col(0), b = col(1), c = col(2);
  const det = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  const axisAligned = [a, b, c].every((v) => v.filter((x) => Math.abs(x) > 1e-6 * (len(v) || 1)).length === 1);
  return {
    dims: d, spacing, origin,
    extentMm: [d[0] * spacing[0], d[1] * spacing[1], d[2] * spacing[2]],
    voxels, voxelMm3: det, totalMl: det * voxels / 1000, axisAligned,
  };
}

/** "512 × 512 × 533" and friends, for a panel. */
export const fmtDims = (d: ArrayLike<number>) => `${d[0]} × ${d[1]} × ${d[2]}`;
export const fmtMm = (v: number, digits = 3) => {
  const s = v.toFixed(digits);
  return s.replace(/\.?0+$/, "") || "0";
};
export const fmtCount = (n: number) => n.toLocaleString("en-US");

/** A zarr dtype ("<i2", "|u1", "<f4") in words: "16-bit integer", "8-bit unsigned integer", "32-bit float". */
export function dtypeInWords(dtype: string): string {
  const m = /^[<>|]?([iuf])(\d)$/.exec(dtype);
  if (!m) return dtype;
  const bits = Number(m[2]) * 8;
  return m[1] === "f" ? `${bits}-bit float` : m[1] === "u" ? `${bits}-bit unsigned integer` : `${bits}-bit integer`;
}
