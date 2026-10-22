// CLOSED, FOR 3D PRINTING: CAPS WHERE THE SCAN CUTS A STRUCTURE OFF (Ron, 2026-10-22: "Closing holes, so the surface is
// watertight (what a 3D printer needs)"; then, after the critic's round, "Caps only"). Surface nets (surface-nets.ts)
// gives each structure a closed surface when it lies inside the scan; one cut off by the edge of the scan (the body in
// most CTs) has no wall there -- 44 open edges on a box touching one side, 7,008 on a CT's body. With one voxel of
// background around the labels, the cut gets a cap. No voxel of any structure changes, and it costs no time: the labels
// are read back from the card straight into the larger array (render/livescene.ts readLabelmap, `pad`).
//
// What it does not do, said where it is offered: two structures that touch share their wall, so an STL of both (one set
// of triangles) has edges used by four triangles there; and a structure that touches itself only along a voxel edge or
// at a corner keeps that spot. Slicing programs for 3D printers repair both routinely.
//
// Versions (Ron, 2026-09-25: versioned):
//   1 (2026-10-22 morning, commit 75a065d): caps, plus untangling edge and corner touches by giving voxels to structures
//     in label order, plus splitting pinched vertices. WITHDRAWN the same morning (critic 2026-10-22, closed surface
//     export): an STL does not keep the split vertices, the label order took voxels from anatomy (white matter
//     hypointensities +27% from the ventricles), the untangling could write into its own padding, and a 418 M-voxel
//     whole body took about 75 s in the app's engine. No file made by it was kept.
//   2 (2026-10-22): caps only.
export const CLOSE_LABELS_VERSION = 2;

/** The grid one voxel larger on every side: its size, and the placement that keeps every structure where it was. */
export function paddedGrid(dims: readonly number[], ijkToRAS: readonly number[]): { dims: [number, number, number]; ijkToRAS: number[] } {
  const m = ijkToRAS, moved = [...m];
  // Index (i, j, k) of the padded grid is (i-1, j-1, k-1) of the original: the translation moves back one voxel.
  for (let r = 0; r < 3; r++) moved[4 * r + 3] = m[4 * r + 3] - (m[4 * r] + m[4 * r + 1] + m[4 * r + 2]);
  return { dims: [dims[0] + 2, dims[1] + 2, dims[2] + 2], ijkToRAS: moved };
}

/** The labels inside one voxel of background, as a new array (for labels already on the processor; the card's are
 *  read back padded instead). */
export function padLabels(lab: Uint8Array, dims: readonly number[], ijkToRAS: readonly number[]): { lab: Uint8Array; dims: [number, number, number]; ijkToRAS: number[] } {
  const [nx, ny, nz] = dims as [number, number, number];
  const g = paddedGrid(dims, ijkToRAS), [X, Y] = g.dims;
  const out = new Uint8Array(g.dims[0] * g.dims[1] * g.dims[2]);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const src = (k * ny + j) * nx;
    out.set(lab.subarray(src, src + nx), ((k + 1) * Y + (j + 1)) * X + 1);
  }
  return { lab: out, ...g };
}
