// DICOM Lab colors read as Albula has always read them (logic/dicom-lab.ts, version 1, D65). The reference values are
// dcmjs 0.41.0's dicomlab2RGB, taken 2026-10-28 (the port agreed with it on 20,000 random values, largest difference 0).
//
//   deno test -A --no-check logic/dicom-lab.test.ts
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { DICOM_LAB_VERSION, dicomLabToRgb } from "./dicom-lab.ts";
import { rgbToDicomLab } from "./export-dicom-seg.ts";

Deno.test("version 1 reads DICOM Lab as dcmjs 0.41.0 did", () => {
  assertEquals(DICOM_LAB_VERSION, 1);
  const ref: [number[], number[]][] = [
    [[33358, 49859, 47245], [0.8999626147355753, 0.20025195238543703, 0.10008604007805366]],
    [[34847, 35498, 17674], [0.1004483833440172, 0.4999876565902744, 0.8998955164348121]],
    [[41433, 32896, 32896], [0.5999997728493303, 0.6000247451027596, 0.599933833410491]],
    [[19378, 50446, 4104], [0, 0.38437878237157713, 1.041708427903733]],
  ];
  for (const [lab, rgb] of ref) dicomLabToRgb(lab).forEach((v, c) => assertAlmostEquals(v, rgb[c], 1e-12));
});

Deno.test("what Albula writes, it reads back (the writer and the reader are the same convention)", () => {
  for (const rgb of [[0.9, 0.2, 0.1], [0.1, 0.5, 0.9], [0.6, 0.6, 0.6], [1, 1, 1], [0, 0, 0]] as [number, number, number][]) {
    dicomLabToRgb(rgbToDicomLab(rgb)).forEach((v, c) => assertAlmostEquals(v, rgb[c], 0.002));
  }
});
