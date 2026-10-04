// Click to outline (click-outline.ts): each click replaces the tool's last outline in the chosen structure; other
// structures and hand painting are kept; RAS to voxel; the default structure.
import { assertEquals } from "jsr:@std/assert";
import { defaultTarget, mergeOutline, rasToVoxel } from "./click-outline.ts";
import { applyRowMajor } from "../render/mat4.ts";

Deno.test("an outline fills empty voxels; the next click's outline replaces it; other structures and hand painting stay", () => {
  // 8 voxels: 0 empty, 1 empty, 2 other structure (5), 3 painted target (2) by hand, 4..7 empty
  const lab = Uint8Array.from([0, 0, 5, 2, 0, 0, 0, 0]);
  const first = mergeOutline(lab, null, Uint8Array.from([1, 1, 1, 1, 0, 0, 0, 0]), 2);
  assertEquals([...first.out], [2, 2, 5, 2, 0, 0, 0, 0], "voxel 2 stays the other structure; voxel 3 was already the target");
  assertEquals([...first.drawn], [1, 1, 0, 0, 0, 0, 0, 0], "only what this tool wrote counts as drawn");
  const second = mergeOutline(first.out, first.drawn, Uint8Array.from([0, 1, 0, 0, 1, 1, 0, 0]), 2);
  assertEquals([...second.out], [0, 2, 5, 2, 2, 2, 0, 0], "voxel 0 (drawn last time, not now) goes; the hand-painted voxel 3 stays");
  assertEquals(second.voxels, 4);
});

Deno.test("a RAS point goes to its voxel through the grid's own matrix, oblique included; outside the grid is null", () => {
  const c = Math.cos(0.3), s = Math.sin(0.3);
  const m = [0.9 * c, -1.1 * s, 0, 10, 0.9 * s, 1.1 * c, 0, -20, 0, 0, 2.5, 5, 0, 0, 0, 1];
  const ras = applyRowMajor(m, [4, 7, 3]);
  assertEquals(rasToVoxel(m, [10, 10, 10], ras), [4, 7, 3]);
  assertEquals(rasToVoxel(m, [10, 10, 10], applyRowMajor(m, [12, 1, 1])), null);
});

Deno.test("the default structure is the one named Tumor, if there is one", () => {
  assertEquals(defaultTarget([{ labelValue: 1, name: "Edema" }, { labelValue: 3, name: " tumor " }]), 3);
  assertEquals(defaultTarget([{ labelValue: 1, name: "Edema" }]), null);
});
