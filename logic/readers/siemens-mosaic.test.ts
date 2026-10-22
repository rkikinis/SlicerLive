// A Siemens mosaic's slice spacing is the file's, or said to be a guess (siemens-mosaic.ts): "absent means unknown"
// (DUCKN-WORKING-COPY.md, "Dimensions are declared, never assumed"; Ron: "People use slicer from microscopy to
// astrophysics").
//   deno test -A --no-check logic/readers/siemens-mosaic.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { mosaicTile, siemensMosaic } from "./siemens-mosaic.ts";
import { reconstructSeries } from "./dicom-series.ts";

// Four 2x2 slices tiled 2 by 2 into one 4x4 image; the slice count in Siemens' private (0019,100A).
const raw = { "00190010": { Value: ["SIEMENS MR HEADER"] }, "0019100A": { Value: [4] } };
const ds = (extra: Record<string, unknown> = {}) => ({
  ImageType: ["ORIGINAL", "PRIMARY", "M", "MOSAIC"], Rows: 4, Columns: 4,
  ImageOrientationPatient: [1, 0, 0, 0, 1, 0], ImagePositionPatient: [0, 0, 0], PixelSpacing: [2, 2], ...extra,
});

Deno.test("a mosaic's declared spacing places its slices, and nothing is flagged", () => {
  // A SpacingBetweenSlices of 0 is no spacing: the thickness is taken instead.
  for (const [extra, step] of [[{ SpacingBetweenSlices: 3 }, 3], [{ SliceThickness: 2.5 }, 2.5], [{ SpacingBetweenSlices: "0", SliceThickness: 4 }, 4]] as const) {
    const m = siemensMosaic(ds(extra), raw)!;
    assertEquals(m.n, 4);
    assertEquals(m.positions.map((p) => p[2]), [0, 1, 2, 3].map((k) => k * step));
    assertEquals(m.spacingNotDeclared, undefined);
  }
});

Deno.test("a mosaic with no spacing is put 1 mm apart AND says so, through to the volume's geometry", () => {
  const m = siemensMosaic(ds(), raw)!;
  assertEquals(m.positions.map((p) => p[2]), [0, 1, 2, 3]);
  assertEquals(m.spacingNotDeclared, true);
  const pixels = new Int16Array(16).map((_, i) => i);
  const slices = [0, 1, 2, 3].map((k) => ({
    seriesInstanceUID: "1.2.3", rows: m.rows, columns: m.columns, pixelSpacing: [2, 2] as [number, number],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0], imagePositionPatient: m.positions[k], frameNumber: k + 1,
    pixels: mosaicTile(pixels, m, 4, k), spacingNotDeclared: true as const,
  }));
  const v = reconstructSeries(slices);
  assertEquals(v.geometry?.origin, "assumed");
  assertEquals(v.geometry?.spacingNotDeclared, [2]);
  // A declared one stays "derived from slice positions".
  const d = siemensMosaic(ds({ SpacingBetweenSlices: 3 }), raw)!;
  const w = reconstructSeries(slices.map((s, k) => ({ ...s, imagePositionPatient: d.positions[k], spacingNotDeclared: undefined })));
  assertEquals(w.geometry?.origin, "derived");
  assertEquals(w.ijkToRAS[10], 3);
});
