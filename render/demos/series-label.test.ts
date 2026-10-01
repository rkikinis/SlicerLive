import { assertEquals } from "jsr:@std/assert@1";
import { realDescription, seriesLabel, seriesLabelShort } from "./load-panel.ts";
Deno.test("placeholders are not descriptions", () => {
  for (const p of ["= NONE =", "=NONE=", " none ", "NONE", "n/a", "N/A", "unknown", "^", "---", ""]) {
    assertEquals(realDescription(p), "", JSON.stringify(p));
  }
  assertEquals(realDescription("CHEST W/O CONTRAST"), "CHEST W/O CONTRAST");
  assertEquals(realDescription("  2.5mm  "), "2.5mm");
});
Deno.test("a scene name identifies the study, not just the series", () => {
  assertEquals(
    seriesLabel({ description: "= NONE =", modality: "CT", seriesNumber: 2, patientID: "R_180", studyDate: "19960322" }),
    "R_180 · CT series 2 · 1996-03-22",
  );
  assertEquals(
    seriesLabel({ description: "CHEST", modality: "CT", patientID: "100002", studyDate: "19990823" }),
    "100002 · CT CHEST · 1999-08-23",
  );
  // Nothing identifying at all falls back to the uid tail rather than an empty name.
  assertEquals(seriesLabel({ seriesInstanceUID: "1.2.3.4.5.6.7.8.9.123456789012" }), "123456789012");
});

Deno.test("a derived name does not carry the patient and the date into itself", () => {
  // The chain that produced Ron's doubled label: volume -> segmentation -> stored -> loaded again.
  const entry = { description: "= NONE =", modality: "CT", seriesNumber: 2, patientID: "R_180", studyDate: "19960322" };
  const volumeName = seriesLabel(entry);
  assertEquals(volumeName, "R_180 · CT series 2 · 1996-03-22");     // right at the top of a tree
  assertEquals(seriesLabelShort(entry), "CT series 2");              // right inside another name
  // What the AI module now names a segmentation of it, and what gets stored as SeriesDescription.
  const segName = `ts:total of ${seriesLabelShort(entry)}`;
  assertEquals(segName, "ts:total of CT series 2");
  // And on the way back in, a SEG carrying its own name keeps it rather than being wrapped again.
  const own = realDescription(segName);
  assertEquals(own && /\bof\b/.test(own) ? own : seriesLabel({ ...entry, description: segName, modality: "SEG" }), segName);
});

Deno.test("a SEG from elsewhere still gets identified", () => {
  // No name of ours in it, so the patient and the date are the only things naming it.
  const foreign = { description: "= NONE =", modality: "SEG", seriesNumber: 300, patientID: "R_180", studyDate: "19960322" };
  const own = realDescription(foreign.description);
  assertEquals(own && /\bof\b/.test(own) ? own : seriesLabel(foreign), "R_180 · SEG series 300 · 1996-03-22");
});
