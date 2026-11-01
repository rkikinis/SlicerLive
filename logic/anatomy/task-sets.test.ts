// The Segment Editor's tasks (logic/anatomy/task-sets.ts): what each offers, their colors, and the region a scan's body
// part or its structures give.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { allStructures, bodyPartOfScan, regionFromBodyPart, regionFromStructures, taskStructures } from "./task-sets.ts";
import { atPaletteVersion } from "./palettes.ts";

Deno.test("tumor: Tumor (Neoplasm), necrosis, edema in any region; its two parts only with a post-contrast scan", () => {
  for (const r of ["Brain", "Chest", "Abdomen", null] as const) assertEquals(taskStructures("tumor", r).map((s) => s.name), ["Tumor", "Necrosis", "Edema"]);
  const [t, n, e] = taskStructures("tumor", "Chest");
  assertEquals([t.code, t.type, t.rgb, t.colorFrom], ["SCT:108369006", "Neoplasm", [144, 238, 144], "ron"]);
  assertEquals([n.code, e.code], ["SCT:6574001", "SCT:79654002"]);
  for (const r of ["Brain", "Abdomen"] as const) {
    const all = taskStructures("tumor", r, { postContrast: true });
    assertEquals(all.map((s) => s.name), ["Tumor", "Enhancing", "Non-enhancing", "Necrosis", "Edema"]);
    assertEquals(all.map((s) => s.code), ["SCT:108369006", "NCIt:C113842", "NCIt:C81175", "SCT:6574001", "SCT:79654002"]);
    assertEquals(all.map((s) => s.partOf), [undefined, "tumor", "tumor", undefined, undefined]);
    // Tumor light green; its parts strong and pale green (Ron, "as drawn"); Necrosis and Edema the list's
    assertEquals(all.map((s) => s.rgb), [[144, 238, 144], [40, 160, 70], [200, 245, 185], [216, 191, 216], [140, 224, 228]]);
    for (const s of all) assertEquals(s.categoryCode, "SCT:49755003", s.name);
  }
});

Deno.test("general anatomy, chest: the list's structures with a region there, both sides, v2 colors where v2 has them", () => {
  atPaletteVersion(2, () => {
    const chest = taskStructures("anatomy", "Chest");
    const names = chest.map((s) => s.name);
    assert(names.includes("Heart") && names.includes("Trachea"), names.join(", "));
    assert(names.includes("Lung, right") && names.includes("Lung, left"));
    assert(!names.includes("Lung"), "a structure with sides is offered as its sides only");
    assert(chest.every((s) => s.colorFrom === "palette"), "every chest structure has a v2 color");
  });
  // the four limbs have no v2 color: the list's own
  atPaletteVersion(2, () => assert(taskStructures("anatomy", "Extremities").every((s) => s.colorFrom === "general-anatomy")));
  // no region: nothing listed, a search over the whole list instead
  assertEquals(taskStructures("anatomy", null), []);
  assertEquals(taskStructures("own", "Chest"), []);
  assert(allStructures().length > 199, "the whole list, sides counted separately");
});

Deno.test("the region from the scan's body part, as scanners write it", () => {
  assertEquals(regionFromBodyPart("CHEST"), "Chest");
  assertEquals(regionFromBodyPart("BRAIN"), "Brain");
  assertEquals(regionFromBodyPart("HEAD"), "Brain");
  assertEquals(regionFromBodyPart("HEADNECK"), "Head and neck");
  assertEquals(regionFromBodyPart("CHESTABDPELVIS"), "Chest");
  assertEquals(regionFromBodyPart("LSPINE"), "Spine");
  assertEquals(regionFromBodyPart("knee"), "Extremities");
  assertEquals(regionFromBodyPart(""), null);
  assertEquals(regionFromBodyPart("PHANTOM"), null);
});

Deno.test("the region of the structures already in a case", () => {
  assertEquals(regionFromStructures(["liver", "spleen", "aorta"]), "Abdomen");
  assertEquals(regionFromStructures(["Segment_1"]), null);
});

Deno.test("the body part of a scan whose own field is empty: its study's other series, else the study's description", () => {
  // UPENN-GBM-00020 as the main database lists it (2026-10-31): the MR scans have none, the radiologists' SEGs say BRAIN
  assertEquals(bodyPartOfScan("", ["", "BRAIN", null], "BRAIN^ROUTINE"), { part: "BRAIN", from: "study" });
  assertEquals(bodyPartOfScan(null, [null], "BRAIN^SPECTROSCOPY"), { part: "BRAIN", from: "study" });
  assertEquals(bodyPartOfScan("CHEST", ["BRAIN"], "BRAIN^ROUTINE"), { part: "CHEST", from: "scan" });
  assertEquals(bodyPartOfScan("", [], "Research study"), { part: "", from: null });
  assertEquals(regionFromBodyPart(bodyPartOfScan("", [], "BRAIN^ROUTINE").part), "Brain");
  // whole words, anywhere in the description; never a prefix of an ordinary word (critic 2026-10-31, finding 14)
  assertEquals(bodyPartOfScan("", [], "CT ABDOMEN AND PELVIS WITH AND WITHOUT CONTRAST").part, "ABDOMEN");
  for (const d of ["EARLY phase", "LEGACY import", "HIPAA cleared", "ABDUCTION study", "HANDOVER"]) assertEquals(bodyPartOfScan("", [], d).from, null, d);
});
