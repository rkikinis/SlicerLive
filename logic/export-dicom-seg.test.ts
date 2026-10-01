// The color conversion is the one piece of the SEG writer that is pure arithmetic, so it is the one
// piece a unit test can pin. The rest needs dcmjs and a real series, and is exercised by the
// round-trip check in the browser (write a SEG, decode it with our own reader, compare voxels).
import { assertEquals } from "jsr:@std/assert@1";
import { rgbToDicomLab, setFrameBits } from "./export-dicom-seg.ts";

Deno.test("rgbToDicomLab: DICOM's 16-bit PCS-Values encoding", () => {
  // Black and white pin the L axis at both ends; a/b sit at the neutral point for both.
  const [lBlack, aBlack, bBlack] = rgbToDicomLab([0, 0, 0]);
  assertEquals(lBlack, 0, "black is L=0");
  const [lWhite] = rgbToDicomLab([1, 1, 1]);
  assertEquals(lWhite, 0xFFFF, "white is L=100, the top of the range");
  // Neutral gray must have no chroma: a and b both land on the encoded zero.
  const zero = Math.round((0 - -128) / (127 - -128) * 0xFFFF);
  assertEquals([aBlack, bBlack], [zero, zero], "greys carry no chroma");
  const [, aGrey, bGrey] = rgbToDicomLab([0.5, 0.5, 0.5]);
  assertEquals([aGrey, bGrey], [zero, zero], "mid grey too");
  // Red is the sanity check that the axes are not swapped: large +a, positive b, mid L.
  const [lRed, aRed, bRed] = rgbToDicomLab([1, 0, 0]);
  assertEquals(lRed > 0 && lRed < 0xFFFF, true, "red is neither black nor white");
  assertEquals(aRed > zero, true, "red is on the +a (red-green) side");
  assertEquals(bRed > zero, true, "and the +b (yellow-blue) side");
});

// The bug this pins cost a 933 MB export and looked like anatomy: a liver whose bounding box covered
// the whole field of view, structures orbiting the torso. `bit >> 3` and `bit & 7` coerce to SIGNED
// 32-BIT, so past 2^31 bits the index wraps. On a 768 x 768 series that is frame 3,641 — beyond
// every test that existed (172 frames, then 430), and squarely inside a real ts:total run of 13,167.
Deno.test("setFrameBits stays correct past the 2^31-bit mark, where 32-bit operators wrap", () => {
  const sliceLen = 768 * 768;                 // 589,824 bits per frame, a whole number of bytes
  const frame = 12000;                        // 12000 * 589,824 = 7.08e9 bits — well past 2^31
  const base = frame * (sliceLen / 8);
  const packed = new Uint8Array(base + sliceLen / 8);
  const labels = new Uint8Array(sliceLen);
  for (const i of [0, 1, 7, 8, 9, 63, 64, sliceLen - 1]) labels[i] = 3;

  setFrameBits(packed, labels, 0, 3, frame, sliceLen);

  const isSet = (i: number) => (packed[base + (i >> 3)] >> (i & 7)) & 1;
  for (const i of [0, 1, 7, 8, 9, 63, 64, sliceLen - 1]) {
    assertEquals(isSet(i), 1, `voxel ${i} should be set`);
  }
  for (const i of [2, 6, 10, 65, sliceLen - 2]) assertEquals(isSet(i), 0, `voxel ${i} should be clear`);
  // and NOTHING was written before this frame — the wrap wrote all over the earlier frames
  assertEquals(packed.subarray(0, base).some((b) => b !== 0), false, "no bits landed outside the frame");
});

Deno.test("setFrameBits handles a frame that is not a whole number of bytes", () => {
  const sliceLen = 5;                          // straddles byte boundaries: frames are not aligned
  const packed = new Uint8Array(8);
  const labels = new Uint8Array([1, 0, 1, 0, 1]);
  setFrameBits(packed, labels, 0, 1, 3, sliceLen);   // frame 3 starts at bit 15
  const bitAt = (i: number) => (packed[i >> 3] >> (i & 7)) & 1;
  assertEquals([bitAt(15), bitAt(16), bitAt(17), bitAt(18), bitAt(19)], [1, 0, 1, 0, 1]);
  assertEquals(bitAt(14), 0, "nothing spilled into the previous frame");
});
