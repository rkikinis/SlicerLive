import { assert, assertEquals } from "jsr:@std/assert@1";
import { documentSeriesFor, pictureFromDataset } from "./dicom-picture.ts";
import type { DbSeriesEntry } from "./dicom-db.ts";

const entry = (o: Partial<DbSeriesEntry>): DbSeriesEntry => ({ seriesInstanceUID: "x", count: 1, available: true, externalCount: 0, ...o });

Deno.test("pictureFromDataset: interleaved RGB, planar RGB, gray and MONOCHROME1 all come out as RGBA", () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]).buffer;   // 2x2
  const p = pictureFromDataset({ Rows: 2, Columns: 2, SamplesPerPixel: 3, BitsAllocated: 8, PlanarConfiguration: 0, PixelData: rgb, InstanceNumber: 2, ImageType: ["DERIVED", "SECONDARY", "OTHER", "CT_SOM ECGDOC"] });
  assert(typeof p !== "string", p as string);
  assertEquals([...p.rgba.slice(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255]);
  assertEquals(p.imageType, ["DERIVED", "SECONDARY", "OTHER", "CT_SOM ECGDOC"]);
  const planar = new Uint8Array([1, 2, 3, 4, 10, 20, 30, 40, 100, 200, 300 % 256, 400 % 256]).buffer;
  const q = pictureFromDataset({ Rows: 2, Columns: 2, SamplesPerPixel: 3, BitsAllocated: 8, PlanarConfiguration: 1, PixelData: planar });
  assert(typeof q !== "string");
  assertEquals([...q.rgba.slice(4, 8)], [2, 20, 200, 255]);
  const gray = pictureFromDataset({ Rows: 1, Columns: 2, SamplesPerPixel: 1, BitsAllocated: 8, PhotometricInterpretation: "MONOCHROME1", PixelData: new Uint8Array([0, 55]).buffer });
  assert(typeof gray !== "string");
  assertEquals([...gray.rgba], [255, 255, 255, 255, 200, 200, 200, 255]);
});

Deno.test("pictureFromDataset: what it will not read, named", () => {
  assertEquals(pictureFromDataset({ Rows: 1, Columns: 1 }), "no pixel data (not an image object)");
  assertEquals(pictureFromDataset({ Rows: 1, Columns: 1, BitsAllocated: 16, PixelData: new Uint8Array(2).buffer }), "16-bit samples (only 8-bit pictures are read)");
  assert(String(pictureFromDataset({ Rows: 4, Columns: 4, SamplesPerPixel: 3, BitsAllocated: 8, PixelData: new Uint8Array(5).buffer }, "1.2.840.10008.1.2.4.50")).startsWith("compressed"));
});

Deno.test("documentSeriesFor: the ECG series named after a reconstruction, in the same study only", () => {
  const all = [
    entry({ seriesInstanceUID: "7", studyInstanceUID: "S", description: "Cardiac  200ms - 400ms" }),
    entry({ seriesInstanceUID: "402", studyInstanceUID: "S", description: "ECG Cardiac  200ms - 400ms" }),
    entry({ seriesInstanceUID: "401", studyInstanceUID: "S", description: "ECG Cardiac BestDiast 66%" }),
    entry({ seriesInstanceUID: "6", studyInstanceUID: "S", description: "Cardiac BestDiast 66%" }),
    entry({ seriesInstanceUID: "other", studyInstanceUID: "T", description: "ECG Cardiac 200ms - 400ms" }),
    entry({ seriesInstanceUID: "5", studyInstanceUID: "S", description: "Monitoring" }),
  ];
  assertEquals(documentSeriesFor(all[0], all).map((e) => e.seriesInstanceUID), ["402"]);
  assertEquals(documentSeriesFor(all[3], all).map((e) => e.seriesInstanceUID), ["401"]);
  assertEquals(documentSeriesFor(all[5], all), []);
  assertEquals(documentSeriesFor(entry({ seriesInstanceUID: "n", studyInstanceUID: "S" }), all), []);
});
