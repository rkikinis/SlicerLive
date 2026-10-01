import { assert, assertEquals } from "jsr:@std/assert@1";
import { fmtCount, fmtDims, fmtMm, volumeInfo } from "./volume-info.ts";

Deno.test("volumeInfo: spacing from the matrix columns, counts, extent, voxel volume", () => {
  // a gated coronary CTA: 0.32143 mm in-plane, 0.3 mm slices, 512 x 512 x 533, RAS-aligned.
  const s = 0.32143359375;
  const m = [-s, 0, 0, 82.2, 0, -s, 0, 100.5, 0, 0, 0.3, -160.1, 0, 0, 0, 1];
  const v = volumeInfo([512, 512, 533], m);
  assertEquals(v.dims, [512, 512, 533]);
  assert(Math.abs(v.spacing[0] - s) < 1e-9 && Math.abs(v.spacing[2] - 0.3) < 1e-9);
  assertEquals(v.origin, [82.2, 100.5, -160.1]);
  assertEquals(v.voxels, 139_722_752);
  assert(Math.abs(v.voxelMm3 - s * s * 0.3) < 1e-9);
  assert(Math.abs(v.totalMl - s * s * 0.3 * 139_722_752 / 1000) < 1e-6);
  assert(Math.abs(v.extentMm[2] - 159.9) < 1e-9);
  assert(v.axisAligned);
  // an oblique grid: the voxel volume is the determinant, not the product of the spacings
  const c = Math.SQRT1_2;
  const ob = volumeInfo([10, 10, 10], [c, -c, 0, 0, c, c, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  assert(!ob.axisAligned);
  assert(Math.abs(ob.voxelMm3 - 2) < 1e-9);
  assert(Math.abs(ob.spacing[0] - 1) < 1e-9);
  assertEquals(fmtDims([512, 512, 533]), "512 × 512 × 533");
  assertEquals(fmtMm(0.32143359375), "0.321");
  assertEquals(fmtMm(0.3), "0.3");
  assertEquals(fmtMm(2), "2");
  assertEquals(fmtCount(139722752), "139,722,752");
});

Deno.test("dtypeInWords", async () => {
  const { dtypeInWords } = await import("./volume-info.ts");
  assertEquals(dtypeInWords("<i2"), "16-bit integer");
  assertEquals(dtypeInWords("|u1"), "8-bit unsigned integer");
  assertEquals(dtypeInWords("<f4"), "32-bit float");
  assertEquals(dtypeInWords("odd"), "odd");
});
