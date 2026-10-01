import { assertEquals } from "jsr:@std/assert@1";
import { ecosystemOf, parseTask, resolveTask, sameTask, unversioned } from "./task-name.ts";

Deno.test("task names: the prefix carries a version now, and the ecosystem is read without it", () => {
  assertEquals(parseTask("ts.v2:total"), { ecosystem: "ts", version: "v2", name: "total" });
  assertEquals(parseTask("ts:total"), { ecosystem: "ts", version: "", name: "total" });
  assertEquals(parseTask("moose.v3:clin_ct_organs"), { ecosystem: "moose", version: "v3", name: "clin_ct_organs" });
  assertEquals(parseTask("total"), { ecosystem: "", version: "", name: "total" });
  assertEquals(ecosystemOf("ts.v2:total"), "ts");
  assertEquals(ecosystemOf("fastsurfer.v2:brain"), "fastsurfer");
  assertEquals(ecosystemOf("ts"), "ts");                        // a bare ecosystem, as the paper lookup gets
  assertEquals(unversioned("ts.v2:total"), "ts:total");
  assertEquals(sameTask("ts:total", "ts.v2:total"), true);
  assertEquals(sameTask("ts.v2:total", "ts.v3:total"), true);   // the same task name in two versions
  assertEquals(sameTask("ts.v2:total", "moose.v3:total"), false);
});

Deno.test("task names: a remembered choice finds its renamed self, or nothing", () => {
  const offered = ["ts.v2:total", "ts.v2:total_fast", "moose.v3:clin_ct_organs"];
  assertEquals(resolveTask("ts:total_fast", offered), "ts.v2:total_fast");
  assertEquals(resolveTask("ts.v2:total", offered), "ts.v2:total");
  assertEquals(resolveTask("ts:gone", offered), "");
  assertEquals(resolveTask("", offered), "");
});

// Every reader of the prefix, on the names as they will arrive after the change.
import { licenseFor } from "./model-license.ts";
import { paperFor } from "./anatomy/model-papers.ts";
import { usesFreesurferNumbering } from "./segment-naming.ts";
import { presetIdFor } from "./presentation.ts";
import { regionsOfTaskName } from "./anatomy/regions.ts";

Deno.test("task names: the licence, the paper, the numbering, the preset and the region all read through the version", () => {
  assertEquals(licenseFor("ts.v2:appendicular_bones")?.project, "TotalSegmentator");
  assertEquals(licenseFor("ts.v2:total"), null);                       // free, as before
  assertEquals(paperFor("ts.v2:total")?.ecosystem, "ts");
  assertEquals(paperFor("moose.v3:clin_ct_organs")?.ecosystem, "moose");
  assertEquals(usesFreesurferNumbering("fastsurfer.v2:brain"), true);
  assertEquals(presetIdFor("fastsurfer.v2:brain"), presetIdFor("fastsurfer:brain"));
  assertEquals(regionsOfTaskName("moose.v3:clin_ct_lungs"), ["Thorax"]);
});
