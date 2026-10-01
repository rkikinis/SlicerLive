// The region table, checked against the names haversack's 75 tasks actually produce (2026-09-11).
import { assertEquals } from "jsr:@std/assert@1";
import { regionsOfStructure, regionsOfStructures, regionsOfTaskName } from "./regions.ts";

Deno.test("regions: the traps that were wrong the first time", () => {
  assertEquals(regionsOfStructure("heart_ventricle_left"), ["Thorax"]);     // not a cerebral ventricle
  assertEquals(regionsOfStructure("hip_implant"), ["Pelvis"]);              // not a dental implant
  assertEquals(regionsOfStructure("body_extremities"), ["Whole body"]);     // ts:body is the body, not the limbs
  assertEquals(regionsOfStructure("Left-Inf-Lat-Vent"), ["Head"]);          // FastSurfer's spelling
  assertEquals(regionsOfStructure("vertebrae_L3"), ["Spine"]);
  assertEquals(regionsOfStructure("pharynx"), ["Neck"]);
  assertEquals(regionsOfStructure("gallbladder"), ["Abdomen"]);           // not the bladder
  assertEquals(regionsOfStructure("nothing_known"), []);
});

Deno.test("regions: a network is where its structures are; five regions is the whole body", () => {
  assertEquals(regionsOfStructures(["liver", "kidney_left", "spleen"]).regions, ["Abdomen"]);
  assertEquals(regionsOfStructures(["liver", "lung_left", "brain", "femur", "bladder"]).regions, ["Whole body"]);
  assertEquals(regionsOfStructures(["liver", "unknown_thing"]), { regions: ["Abdomen"], unknown: 1 });
});

Deno.test("regions: a nameless-structure task is read from its name, and only that", () => {
  assertEquals(regionsOfTaskName("moose:clin_ct_lungs"), ["Thorax"]);
  assertEquals(regionsOfTaskName("moose:clin_pt_fdg_brain_v1"), ["Head"]);
  assertEquals(regionsOfTaskName("fastsurfer:asegdkt"), ["Head"]);     // FastSurfer's own name, no alias
  assertEquals(regionsOfTaskName("moose:clin_ct_dental"), ["Head"]);
  assertEquals(regionsOfTaskName("moose:clin_ct_vertebrae"), ["Spine"]);
  assertEquals(regionsOfTaskName("mrsegmentator:base"), ["Whole body"]);
  assertEquals(regionsOfTaskName("vendor:mystery"), []);
});
