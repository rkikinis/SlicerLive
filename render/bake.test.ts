// The slice overlay's palette layout.
//
// The overlay used to be an rgba16float volume baked crisp from the labelmap -- 8 bytes a voxel,
// 3.35 GB on a 768x768x709 study, per segmentation, allocated at load for a binding only one
// segmentation can hold at a time. A crisp bake is a palette lookup per voxel and nothing else, so
// the shader's label-overlay mode does the same work from the labelmap plus this 2 KB table.
//
// Everything about that depends on two indices being right, and neither fails loudly: the wrong row
// binds cleanly and samples zero, and the wrong column colors the wrong organ.
//
//   deno test -A --no-check render/bake.test.ts

import { assertEquals } from "jsr:@std/assert";
import { labelPaletteBytes } from "./bake.ts";

/** segPalette's layout: p[labelValue*4 .. +3] = rgb + presence. */
function paletteWith(entries: Record<number, [number, number, number, number]>): Float32Array {
  const p = new Float32Array(256 * 4);
  for (const [lv, rgba] of Object.entries(entries)) p.set(rgba, Number(lv) * 4);
  return p;
}

Deno.test("palette: the colour lands in ROW 1, where the shader loads it", () => {
  const bytes = labelPaletteBytes(paletteWith({ 1: [1, 0, 0, 1] }));
  const row1 = (256 + 1) * 4;
  assertEquals([...bytes.subarray(row1, row1 + 4)], [255, 0, 0, 255]);
});

Deno.test("palette: row 0 stays empty, so nothing is coloured by the unused row", () => {
  const bytes = labelPaletteBytes(paletteWith({ 1: [1, 1, 1, 1] }));
  assertEquals([...bytes.subarray(0, 256 * 4)].some((b) => b !== 0), false);
});

// The column is the label value. Off by one here paints the liver with the spleen's color.
Deno.test("palette: the column is the label value, not a running index", () => {
  const bytes = labelPaletteBytes(paletteWith({ 5: [0, 1, 0, 1], 200: [0, 0, 1, 1] }));
  const at = (lv: number) => [...bytes.subarray((256 + lv) * 4, (256 + lv) * 4 + 4)];
  assertEquals(at(5), [0, 255, 0, 255]);
  assertEquals(at(200), [0, 0, 255, 255]);
  assertEquals(at(4), [0, 0, 0, 0]);
  assertEquals(at(6), [0, 0, 0, 0]);
});

// A hidden segment gets presence 0 from segPalette; that has to survive as a zero alpha, or hiding
// an organ would leave it on screen in full color.
Deno.test("palette: a hidden segment's zero presence becomes a zero alpha", () => {
  const bytes = labelPaletteBytes(paletteWith({ 3: [1, 0, 0, 0] }));
  assertEquals(bytes[(256 + 3) * 4 + 3], 0);
});

Deno.test("palette: label 0 is background and is never given a colour", () => {
  const bytes = labelPaletteBytes(paletteWith({ 1: [1, 1, 1, 1] }));
  assertEquals([...bytes.subarray(256 * 4, 256 * 4 + 4)], [0, 0, 0, 0]);
});

Deno.test("palette: values outside 0..1 are clamped rather than wrapping", () => {
  const bytes = labelPaletteBytes(paletteWith({ 2: [1.5, -0.2, 0.5, 1] }));
  assertEquals([...bytes.subarray((256 + 2) * 4, (256 + 2) * 4 + 4)], [255, 0, 128, 255]);
});

Deno.test("palette: the table is always the full 256x2 rgba image the texture expects", () => {
  assertEquals(labelPaletteBytes(new Float32Array(8)).length, 256 * 2 * 4);
});
