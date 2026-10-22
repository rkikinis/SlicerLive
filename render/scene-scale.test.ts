// render/scene-scale.ts at three scales: an electron microscope's 1 nm voxels (1e-6 mm), a clinical 0.7 mm CT, and an
// astronomer's 1 parsec voxels (3.086e19 mm).
//   deno test -A --no-check render/scene-scale.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  boxRadius, BRUSH_DEFAULT_VOXELS, DRAW_SPACING_VOXELS, finest, nodeVoxel, onSliceDistance, sceneVoxel, STEREO_NEAREST_VOXELS,
  texelsAcross, tuned, voxelFromExtent, voxelOrUnit, voxels, voxelSizes,
} from "./scene-scale.ts";
import { lengthText, rulerLength } from "./length-text.ts";
import { SCALES } from "./scale-fixtures.ts";

const grid = (v: number, z = v) => [v, 0, 0, 0, 0, v, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

Deno.test("voxel sizes from the grid, the finest of a node", () => {
  assertEquals(voxelSizes(grid(0.5, 2)), [0.5, 0.5, 2]);
  assertEquals(nodeVoxel({ ijkToRAS: grid(0.5, 2) }), 0.5);
  assertEquals(nodeVoxel({}), undefined);
  assertEquals(voxelSizes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), undefined);
});

for (const [what, v] of SCALES) {
  Deno.test(`the scene's voxel is the finest shown: ${what}`, () => {
    const nodes = [
      { type: "image", ijkToRAS: grid(2 * v) },
      { type: "segmentation", ijkToRAS: grid(v) },
      { type: "image", ijkToRAS: grid(v / 10), visible: false },
      { type: "markup" },
    ];
    assertEquals(sceneVoxel(nodes), v);
    assertEquals(sceneVoxel([{ type: "image", ijkToRAS: grid(v / 10), visible: false }]), v / 10);
    assertEquals(sceneVoxel([{ type: "markup" }]), undefined);
    assert(Math.abs(voxelFromExtent(256 * v)! - v) <= v * 1e-12);
    assertEquals(voxels(5, v), 5 * v);
  });
}

Deno.test("a tuned value is unchanged on clinical grids and follows the voxels outside them", () => {
  // The opacity unit: 1 mm, kept between 0.5 and 2 voxels.
  assertEquals(tuned(1, 0.7, 0.5, 2), 1);
  assertEquals(tuned(1, 1.5, 0.5, 2), 1);
  assertEquals(tuned(1, 1e-6, 0.5, 2), 2e-6);
  assertEquals(tuned(1, 3.086e19, 0.5, 2), 1.543e19);
  assertEquals(tuned(1, undefined, 0.5, 2), 1);
});

// The views' sizes (render/moduleserver/live-views.ts), each the same number of voxels at every scale.
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-12;
for (const [what, v] of SCALES) {
  Deno.test(`the views' sizes are voxels: ${what}`, () => {
    // the finest known voxel, and the first known one (1 only when nothing is known)
    assertEquals(finest(undefined, 3 * v, v, 0, NaN), v);
    assertEquals(finest(undefined, 0), undefined);
    assertEquals(voxelOrUnit(undefined, 0, v, 2 * v), v);
    assertEquals(voxelOrUnit(undefined, NaN), 1);
    // the 3D fit: half the box's diagonal, and one voxel for a box with no size (it was 1 mm)
    assert(near(boxRadius([0, 0, 0], [300 * v, 400 * v, 0], v), 250 * v));
    assertEquals(boxRadius([5 * v, 5 * v, 5 * v], [5 * v, 5 * v, 5 * v], v), v);
    // a slice's texture: one texel per voxel, 16 to 2048 (a 0.05 mm floor made a microscope's 16 x 16)
    assertEquals(texelsAcross(512 * v, v, 16, 2048), 512);
    assertEquals(texelsAcross(1e6 * v, v, 16, 2048), 2048);
    assertEquals(texelsAcross(2 * v, v, 16, 2048), 16);
    // on a slice: 1.5 voxels, or half the slice step when that is more (a 5-voxel-thick series: 2.5 voxels)
    assert(near(onSliceDistance(v), 1.5 * v));
    assert(near(onSliceDistance(v, 5 * v), 2.5 * v));
    // the brush, Draw's point spacing and the glasses' nearest distance, in voxels
    assertEquals(voxels(BRUSH_DEFAULT_VOXELS, v), 5 * v);
    assert(near(voxels(DRAW_SPACING_VOXELS, v), 0.1 * v));
    assertEquals(voxels(STEREO_NEAREST_VOXELS, v), 20 * v);
  });
}

Deno.test("on a 1 mm grid the views' sizes are the lengths they were", () => {
  assertEquals(onSliceDistance(1), 1.5);                  // SLAB_MM
  assertEquals(voxels(BRUSH_DEFAULT_VOXELS, 1), 5);       // the brush's 5 mm
  assertEquals(voxels(DRAW_SPACING_VOXELS, 1), 0.1);      // Draw's 0.1 mm
  assertEquals(voxels(STEREO_NEAREST_VOXELS, 1), 20);     // the glasses' 20 mm
  assertEquals(boxRadius([0, 0, 0], [0.5, 0, 0], 1), 1);  // the fit's 1 mm floor
});

Deno.test("lengths read in the unit that fits; clinical ones as they did", () => {
  assertEquals(lengthText(13.6), "13.6 mm");
  assertEquals(lengthText(85, 0), "85 mm");
  assertEquals(lengthText(0.97, 2), "0.97 mm");
  assertEquals(lengthText(2.5e-4), "250 nm");
  assertEquals(lengthText(0.014), "14 µm");
  assertEquals(lengthText(3.086e19), "1 pc");
  assertEquals(lengthText(4.2e21), "136 pc");
  assertEquals(lengthText(2.5e4), "25 m");
});

Deno.test("a position's unit comes from the data's voxels, not from how near zero it is", () => {
  assertEquals(lengthText(-0.0535, 1, 0.97), "-0.1 mm");              // the sagittal slice through the middle of a T1
  assertEquals(lengthText(0, 1, 0.97), "0.0 mm");
  assertEquals(lengthText(-0.0535, 1, 2.5e-4), "-53.5 µm");           // the same number on a 250 nm microscope grid
  assertEquals(lengthText(1.2e-5, 1, 1e-6), "12 nm");
  assertEquals(lengthText(3 * 3.086e19, 1, 3.086e19), "3 pc");
});
for (const [what, v] of SCALES) {
  Deno.test(`a ruler is a 1-2-5 length a quarter of the view, in a unit that reads: ${what}`, () => {
    // a 512-pixel view across 256 voxels: a quarter is 64 voxels
    const r = rulerLength((256 * v) / 512, 128);
    assert(r.mm / v >= 30 && r.mm / v <= 130, `${what}: ruler ${r.mm} for 64 voxels of ${v}`);
    assert(!/^0(\.0+)? /.test(r.text), `${what}: "${r.text}"`);
  });
}
Deno.test("on a clinical view the ruler is the length it was", () => {
  assertEquals(rulerLength(500 / 512, 128), { mm: 100, text: "10 cm" });
  assertEquals(rulerLength(20 / 512, 128), { mm: 5, text: "5 mm" });
  for (const [want, text] of [[0.7, "0.5 mm"], [9.5, "1 cm"], [12, "1 cm"], [150, "10 cm"], [180, "20 cm"]] as const) {
    assertEquals(rulerLength(want / 128, 128).text, text, `${want} mm`);
  }
});

// THE READOUTS ON EVERY GRID (critic 2026-10-20, finding 4: on 1-10 µm grids every readout said "0.0 mm"): the Segment
// Editor's brush note, a slice position 37 voxels in and a 12-voxel distance, as their callers ask for them
// (seg-editor-panel.ts, live-views.ts). The clinical grids read exactly as they did.
const PC = 3.0856775814913673e19;
const readouts = (v: number) => [
  `≈ ${lengthText(14 * v, 1, v)} on this ${lengthText(v, 2, v)} grid`,
  `S: ${lengthText(37 * v, 1, v)}`, `S: ${lengthText(-120.3 * v, 1, v)}`, lengthText(12 * v, 12 * v >= 100 ? 0 : 1, v),
];
for (const [v, want] of [
  [1e-6, ["≈ 14 nm on this 1 nm grid", "S: 37 nm", "S: -120 nm", "12 nm"]],
  [1e-3, ["≈ 14 µm on this 1 µm grid", "S: 37 µm", "S: -120 µm", "12 µm"]],
  [1e-2, ["≈ 140 µm on this 10 µm grid", "S: 370 µm", "S: -1203 µm", "120 µm"]],
  [0.7, ["≈ 9.8 mm on this 0.70 mm grid", "S: 25.9 mm", "S: -84.2 mm", "8.4 mm"]],
  [1e3, ["≈ 14 m on this 1 m grid", "S: 37 m", "S: -120 m", "12 m"]],
  [PC, ["≈ 14 pc on this 1 pc grid", "S: 37 pc", "S: -120 pc", "12 pc"]],
] as const) {
  Deno.test(`readouts keep their digits on a ${lengthText(v, 2, v)} grid`, () => assertEquals(readouts(v), [...want]));
}
Deno.test("clinical readouts are unchanged: mm with the caller's digits on 0.25 to 4 mm grids", () => {
  for (const v of [0.25, 0.5, 0.7, 1, 2.5, 4]) {
    assertEquals(lengthText(14 * v, 1, v), `${(14 * v).toFixed(1)} mm`);
    assertEquals(lengthText(v, 2, v), `${v.toFixed(2)} mm`);
    assertEquals(lengthText(-53.5, 1, v), "-53.5 mm");
  }
});
Deno.test("a length far past the grid's unit steps up instead of a row of digits", () => {
  assertEquals(lengthText(1000, 1, 1e-6), "1000 mm");            // a meter in a 1 nm scene, not "1000000000 nm"
  assertEquals(lengthText(1e13), "10,000,000 km");
  assertEquals(lengthText(1e15), "6.68 au");
});
Deno.test("rulers past a meter: m, km, au, pc and kpc, each a 1-2-5 of its own unit", () => {
  assertEquals(rulerLength(5000 / 128, 128).text, "5 m");          // was "500 cm"
  assertEquals(rulerLength(2e5 / 128, 128).text, "200 m");
  assertEquals(rulerLength(3e9 / 128, 128).text, "2000 km");
  assertEquals(rulerLength(1e14 / 128, 128).text, "100,000,000 km");
  assertEquals(rulerLength(1e16 / 128, 128).text, "50 au");         // was "10000000000000 km"
  const pc = rulerLength(1e21 / 128, 128);                           // was "32.4 pc"
  assertEquals(pc.text, "20 pc");
  assert(Math.abs(pc.mm / PC - 20) < 1e-9);
  assertEquals(rulerLength(5e23 / 128, 128).text, "20 kpc");
});
