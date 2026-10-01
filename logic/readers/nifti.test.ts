// T1: synthetic NIfTI-1 volumes (sform / qform / gz) -> correct voxel order and ijkToRAS. No LPS flip.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseNifti, quaternToMat } from "./nifti.ts";
import { readVolume, sniff } from "./registry.ts";

import { makeNifti } from "./synthetic.ts";

Deno.test("sform wins: ijkToRAS = srow, voxel order (z,y,x) C-order", async () => {
  const sform = [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5];
  const v = await parseNifti(makeNifti({ sform, qform: { b: 0, c: 0, d: 0, qfac: 1, off: [99, 99, 99] } }));
  assertEquals(v.dims, [4, 3, 2]);
  assertEquals(v.ijkToRAS, [2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5, 0, 0, 0, 1]);
  assertEquals(v.data[0], 0); assertEquals(v.data[1], 1); assertEquals(v.data[4], 10); assertEquals(v.data[12], 100);   // i fastest, then j, then k
  assertEquals(v.dtype, "<i2");
});

Deno.test("qform: identity quaternion -> pixdim scaling + offset; qfac=-1 flips k", async () => {
  const v = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: 1, off: [1, 2, 3] }, pixdim: [1, 0.5, 0.75, 2] }));
  assertEquals(v.ijkToRAS, [0.5, 0, 0, 1, 0, 0.75, 0, 2, 0, 0, 2, 3, 0, 0, 0, 1]);
  const f = await parseNifti(makeNifti({ qform: { b: 0, c: 0, d: 0, qfac: -1, off: [0, 0, 0] }, pixdim: [-1, 1, 1, 1] }));
  assertEquals(f.ijkToRAS[10], -1);
  // a 90° rotation about z (b=0,c=0,d=sin45) maps i -> +A
  const R = quaternToMat(0, 0, Math.SQRT1_2, 1, 1, 1, 1);
  assert(Math.abs(R[0]) < 1e-6 && Math.abs(R[3] - 1) < 1e-6, "i axis should map to +y");
});

Deno.test("pixdim only, big-endian, gzip, and sniffing", async () => {
  const be = await parseNifti(makeNifti({ bigEndian: true, pixdim: [1, 1.5, 1.5, 3] }));
  assertEquals(be.ijkToRAS[0], 1.5); assertEquals(be.data[12], 100);
  const raw = makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
  const gz = new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  assertEquals(sniff(gz, "x.nii.gz"), "nifti"); assertEquals(sniff(raw), "nifti"); assertEquals(sniff(new TextEncoder().encode("NRRD0004\n")), "nrrd");
  const v = await readVolume(gz, "brain.nii.gz");
  assertEquals(v.name, "brain"); assertEquals(v.data.length, 24);
});

// VALUE SCALING (2026-09-28): stored·scl_slope + scl_inter whenever the slope is non-zero -- a tumor mask stored 0..255
// with slope 1/255 read as 0..255 before this, so a cut at one half took every voxel above zero. Offsets 112 and 116.
Deno.test("scl_slope / scl_inter are applied; 0 or NaN means none, and integers stay integers then", async () => {
  const withScale = (slope: number, inter: number) => {
    const b = makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] });
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    v.setFloat32(112, slope, true); v.setFloat32(116, inter, true);
    return b;
  };
  const scaled = await parseNifti(withScale(1 / 255, 0));
  assertEquals(scaled.dtype, "<f4");
  assert(Math.abs(scaled.data[1] - 1 / 255) < 1e-7 && Math.abs(scaled.data[12] - 100 / 255) < 1e-6, `${scaled.data[1]}, ${scaled.data[12]}`);
  const shifted = await parseNifti(withScale(2, -1000));
  assertEquals([shifted.data[0], shifted.data[1]], [-1000, -998]);
  for (const none of [0, NaN]) {
    const v = await parseNifti(withScale(none, 5));
    assertEquals([v.dtype, v.data[1]], ["<i2", 1], `slope ${none}`);
  }
  const unit = await parseNifti(withScale(1, 0));
  assertEquals(unit.dtype, "<i2");
});
