// The merged catalog: what wins, what must not be erased, and the two errata in the source.
import { assertEquals } from "jsr:@std/assert@1";
import { SEGMENTER_STRUCTURES as S } from "./catalogue.ts";
import { codesFor, lookupStructure } from "../segment-naming.ts";
import { regionsOfStructure } from "./regions.ts";

Deno.test("catalogue: the harmonized code wins, the extension's readable name stays", () => {
  // The extension coded the right eye as its own lateralised concept; the harmonization uses the
  // generic Eye with a Right modifier, which is what every other model does.
  assertEquals(S.eye_right.code, "SCT:81745001");
  assertEquals(S.eye_right.mod, "Right");
  assertEquals(S.medial_pterygoid_right.name, "Medial pterygoid muscle, right");   // not "Structure of ..."
  assertEquals(S.medial_pterygoid_right.type, "Structure of medial pterygoid muscle");
});

Deno.test("catalogue: a value the harmonized table lacks does not erase the extension's", () => {
  assertEquals(S.prevertebral_right.code, "SCT:714472006");   // the workbook has no code for it
  assertEquals(S.insular_cortex.code, "SCT:36169008");
});

Deno.test("catalogue: colours the extension never had are filled from the workbook", () => {
  assertEquals(S.heart.rgb, [239, 71, 111]);
  assertEquals(S.lung_left.rgb, [255, 159, 64]);
  assertEquals(S.liver.rgb, [221, 130, 101]);   // both have it and they agree
});

Deno.test("catalogue: the erratum in the workbook is corrected; MOOSE's own CSV supersedes its sheet", () => {
  assertEquals(S.ventricle_frontal_horn_right.mod, "Right");   // workbook says Left
  assertEquals(S.gluteus_minimus_left.code, "SCT:75297007");    // the sheet said gluteus medius; the repo CSV is right
  assertEquals(S.gluteus_minimus_left.type, "Gluteus minimus muscle");
  assertEquals(S.gluteus_maximus_left.code, "SCT:206007");      // the repo CSV over the TS sheet's 181674001
  assertEquals(S.toes_left.code, "SCT:29707007");               // Toe + Left, the code DICOM's CIDs carry
  assertEquals(S.toes_left.mod, "Left");
  assertEquals(S.vertebra_L3.code, "SCT:36470004");             // MOOSE's singular spelling resolves too
  assertEquals(S.vertebrae_L3.code, "SCT:36470004");
});

Deno.test("catalogue: labels only the other models write resolve, with their model named", () => {
  assertEquals(S.clavicle_left.code, "SCT:51299004");
  assertEquals(S.clavicle_left.models, ["moose/peripheral_bones"]);
  assertEquals(S.Legs.system, "Body regions");   // clin_ct_body, capitalized as MOOSE writes it
  assertEquals(S.fingers_left.system, "Body regions");
  assertEquals(lookupStructure("toes_right")?.name, "Toe, right");
});

Deno.test("codesFor: what a SEG segment carries", () => {
  assertEquals(codesFor("kidney_right"), { code: "SCT:64033007", type: "Kidney", mod: "Right" });
  // A finding: its side is on the REGION it sits in (Kidney, Left), not on the type, so no modifier here.
  assertEquals(codesFor("kidney_cyst_left"), { code: "SCT:367643001", type: "Cyst", category: "Morphologically Altered Structure" });
  assertEquals(codesFor("nothing_known"), {});
});

Deno.test("regions: by the concept first, by the name when no concept covers it", () => {
  assertEquals(regionsOfStructure("kidney_left"), ["Abdomen"]);        // curated, by SCT:64033007
  assertEquals(regionsOfStructure("Kidney, left"), ["Abdomen"]);       // the readable name resolves too
  assertEquals(regionsOfStructure("liver_vessels"), ["Abdomen"]);      // generic concept left empty: the name decides
  assertEquals(regionsOfStructure("lung_vessels"), ["Thorax"]);
  assertEquals(regionsOfStructure("Left-Hippocampus"), ["Head"]);      // FastSurfer: no concept, name rules
});
