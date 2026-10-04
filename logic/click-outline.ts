// CLICK TO OUTLINE: writing one nnLive outline into the structure the person chose (Ron, 2026-10-03: "user defines the
// structure with tumor as default. iterations are by default staying there. option to have a new structure"; the
// mockup Contents/docs/mockups/click-to-outline-2026-10-03.html, SlicerAlbula workspace). Pure: arrays in, arrays out.
//
// The rule, voxel by voxel, for the chosen structure `target`:
//  - what this tool drew there with the previous click goes (each click's outline REPLACES the last one: the clicks
//    refine one outline, they do not pile up);
//  - the new outline is written where the voxel is empty;
//  - another structure's voxels are never overwritten, and what the person painted into the target by hand stays.
import { applyMat4, invert, transpose4, type Vec3 } from "../render/mat4.ts";

export function mergeOutline(labelmap: Uint8Array, prev: Uint8Array | null, mask: Uint8Array, target: number): { out: Uint8Array; drawn: Uint8Array; voxels: number } {
  const n = labelmap.length;
  if (mask.length !== n || (prev && prev.length !== n)) throw new Error("the outline is not on the segmentation's grid");
  const out = new Uint8Array(n), drawn = new Uint8Array(n);
  let voxels = 0;
  for (let i = 0; i < n; i++) {
    let v = labelmap[i];
    if (prev && prev[i] && v === target) v = 0;
    if (mask[i] && v === 0) { v = target; drawn[i] = 1; }
    out[i] = v;
    if (v === target) voxels++;
  }
  return { out, drawn, voxels };
}

/** A RAS point to the nearest voxel (i, j, k) of a grid given by its row-major ijkToRAS; null outside the grid. */
export function rasToVoxel(ijkToRAS: ArrayLike<number>, dims: [number, number, number], ras: Vec3): [number, number, number] | null {
  const p = applyMat4(invert(transpose4(ijkToRAS)), ras);
  const v = [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])] as [number, number, number];
  return v.every((x, a) => x >= 0 && x < dims[a]) ? v : null;
}

/** The structure clicks go into by default: one named "Tumor" (any case), or null when there is none yet. */
export function defaultTarget(segments: { labelValue: number; name?: string }[]): number | null {
  return segments.find((s) => (s.name ?? "").trim().toLowerCase() === "tumor")?.labelValue ?? null;
}
