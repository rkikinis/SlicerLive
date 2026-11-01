// What kind of scan (logic/scan-kind.ts), on UPENN-GBM-00020's four scans as their headers say them (read 2026-10-31).
import { assertEquals } from "jsr:@std/assert@1";
import { scanKind, scanKindV1 } from "./scan-kind.ts";

Deno.test("UPENN-GBM-00020: the FLAIR carries the agent too and is still the FLAIR", () => {
  assertEquals(scanKind({ modality: "MR", agent: "OMNISCAN", repetitionTime: 1760, echoTime: 3.1, inversionTime: 950, description: "t1 axial stealth-post" }).kind, "T1 post-contrast");
  assertEquals(scanKind({ modality: "MR", agent: "", repetitionTime: 1760, echoTime: 3.11, inversionTime: 950, description: "t1 axial" }).kind, "T1");
  assertEquals(scanKind({ modality: "MR", agent: "OMNISCAN", repetitionTime: 9420, echoTime: 141, inversionTime: 2500, description: "t2_Flair_axial" }).kind, "FLAIR");
  assertEquals(scanKind({ modality: "MR", repetitionTime: 4680, echoTime: 85, description: "Axial T2 tse" }).kind, "T2");
  // its diffusion scan has a T2's timing
  assertEquals(scanKind({ modality: "MR", repetitionTime: 5000, echoTime: 86, description: "ep2d_DTI_30dir" }).kind, "other");
});

Deno.test("the series name decides only when the header does not", () => {
  assertEquals(scanKind({ modality: "MR", description: "T1 POST GAD" }), { kind: "T1 post-contrast", how: "from the series name" });
  assertEquals(scanKind({ modality: "MR", description: "MPRAGE" }).kind, "T1");
  assertEquals(scanKind({ modality: "MR", description: "DWI" }).kind, "other");
  // the header wins over a misleading name
  assertEquals(scanKind({ modality: "MR", repetitionTime: 4680, echoTime: 85, description: "t1 something" }).kind, "T2");
});

Deno.test("CT: with an agent, post-contrast; 'NONE' is no agent; other modalities are other", () => {
  assertEquals(scanKind({ modality: "CT", agent: "Omnipaque" }).kind, "CT post-contrast");
  assertEquals(scanKind({ modality: "CT", agent: "NONE" }).kind, "CT");
  assertEquals(scanKind({ modality: "PT" }).kind, "other");
});

Deno.test("version 2: the critic's cases of 2026-10-31 evening (qa/2026-10-31-evening-editor-3d.md, finding 4)", () => {
  // ReMIND-035: no timing in the header, the words split by underscores
  assertEquals(scanKind({ modality: "MR", description: "3D_AX_T1_postcontrast" }).kind, "T1 post-contrast");
  assertEquals(scanKind({ modality: "MR", description: "2D_AX_T2" }).kind, "T2");
  assertEquals(scanKindV1({ modality: "MR", description: "3D_AX_T1_postcontrast" }).kind, "other");   // what version 1 said
  // an empty agent field is not "no agent": the name decides
  assertEquals(scanKind({ modality: "MR", agent: "", repetitionTime: 2300, echoTime: 2.3, description: "MPRAGE POST GAD" }).kind, "T1 post-contrast");
  // "No contrast" is no agent
  assertEquals(scanKind({ modality: "MR", agent: "No contrast", repetitionTime: 2300, echoTime: 2.3, description: "MPRAGE" }).kind, "T1");
  // taken after the injection, but not an image of the anatomy
  assertEquals(scanKind({ modality: "MR", agent: "GADAVIST", repetitionTime: 27, echoTime: 20, description: "SWI_Images" }).kind, "other");
  assertEquals(scanKind({ modality: "MR", agent: "GADAVIST", repetitionTime: 8.6, echoTime: 4, description: "localizer" }).kind, "other");
  assertEquals(scanKind({ modality: "MR", repetitionTime: 650, echoTime: 20, description: "t2*_gre_tra" }).kind, "other");
  // the cases version 1 got right stay right
  assertEquals(scanKind({ modality: "MR", agent: "OMNISCAN", repetitionTime: 1760, echoTime: 3.1, inversionTime: 950, description: "t1 axial stealth-post" }).kind, "T1 post-contrast");
  assertEquals(scanKind({ modality: "MR", agent: "OMNISCAN", repetitionTime: 9420, echoTime: 141, inversionTime: 2500, description: "t2_Flair_axial" }).kind, "FLAIR");
  assertEquals(scanKind({ modality: "MR", repetitionTime: 5000, echoTime: 86, description: "ep2d_DTI_30dir" }).kind, "other");
  assertEquals(scanKind({ modality: "MR", description: "AX_T1_MPRAGE" }).kind, "T1");
});
