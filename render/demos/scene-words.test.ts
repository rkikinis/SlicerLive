// The Scenes module's words on the values the databases hold (BodyPartExamined in SlicerAlbulaMain and Mediastinal lymph nodes,
// read 2026-11-08: CHEST, CHESTABDPELVIS, ABDOMEN, LUNG, LIVER, PANCREAS, COLON, HEART, NECK, BRAIN, HEAD, UTERUS).
import { assertEquals } from "jsr:@std/assert@1";
import { plainResult, plainScan, scanWords } from "./scene-words.ts";

Deno.test("a scan in a resident's words, from the body part the scanner recorded", () => {
  const ct = (bodyPart: string) => plainScan({ uid: "1", modality: "CT", bodyPart });
  assertEquals(ct("CHESTABDPELVIS"), "CT chest/abd/pelvis", "IDC's one-word value (critic, finding 11)");
  assertEquals(ct("CHEST"), "CT chest");
  assertEquals(ct("ABDOMEN"), "CT abdomen");
  assertEquals(ct("LUNG"), "CT chest");
  assertEquals(ct("PANCREAS"), "CT pancreas");
  assertEquals(ct("HEART"), "CT heart");
  assertEquals(plainScan({ uid: "1", modality: "MR", bodyPart: "BRAIN" }), "MR head");
  assertEquals(plainScan({ uid: "1", modality: "CT", description: "CT CHEST 1.0 B30f", studyDescription: "CT ABD PELVIS" }), "CT chest/abd/pelvis");
  assertEquals(plainScan({ uid: "1", modality: "CT", studyDescription: "CTPA" }), "CTPA");
  assertEquals(plainScan({ uid: "1", modality: "MR", description: "MR-head" }), "MR head");
  assertEquals(plainScan({ uid: "1", modality: "MR", description: "T1w MPRAGE" }), "MR · T1w MPRAGE");
  assertEquals(plainScan({ uid: "1" }), " · scan", "nothing known: the caller reads the series again (finding 10)");
  assertEquals(plainScan(undefined), "No scan");
});

Deno.test("the scan's line leaves out the patient's id when the description starts with it; results in words", () => {
  assertEquals(scanWords({ uid: "1", patientID: "ds000113-sub-01", modality: "MR", description: "ds000113-sub-01 T1w", n: "176" }), "MR · ds000113-sub-01 T1w · 176 images");
  assertEquals(scanWords({ uid: "1", patientID: "case_0890", modality: "CT", description: "None" }), "case_0890 · CT");
  assertEquals(plainResult("ts.v2:lung_vessels of CT series 2"), "Lung vessels · TotalSegmentator");
  assertEquals(plainResult("fastsurfer:asegdkt of MR-head"), "Brain structures · FastSurfer");
  assertEquals(plainResult("Tumor"), "Tumor");
});
