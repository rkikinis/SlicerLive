// THE ONE PLACE. Mike Halle, 2026-09-19: "all mappings such as segment id to concept and segment
// id or concept to color be made in a uniform organized local location in your code so that
// multiple entry points can use it … prevents staleness through uniformity and local
// centralization." This test is that rule, enforced: outside logic/anatomy/ and
// logic/segment-naming.ts no source file maps a label to a code, and the model-label
// definitions answer through their one function. Extend the allow list only with a reason.
import { assert, assertEquals } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs@1/walk";
import { definitionFor } from "./definitions.ts";
import { codesFor, lookupStructure } from "../segment-naming.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const ALLOWED = [/^logic\/anatomy\//, /^logic\/segment-naming\.ts$/];

Deno.test("no source outside the one place carries a SNOMED code literal", async () => {
  const offenders: string[] = [];
  for await (const e of walk(ROOT, { exts: [".ts"], skip: [/node_modules/, /\/vendor\//, /\.test\.ts$/, /\/scratchpad\//, /\/LiveStory\//] })) {
    const rel = e.path.slice(ROOT.length);
    if (ALLOWED.some((a) => a.test(rel))) continue;
    const text = await Deno.readTextFile(e.path);
    // A code literal is `SCT:<digits>` or a CodeValue with a SNOMED designator beside it; a comment
    // that names one as an example is not a mapping, so lines that are comments are skipped.
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (/["'`]SCT:\d+/.test(t)) offenders.push(`${rel}: ${t.slice(0, 90)}`);
    }
  }
  assertEquals(offenders, [], "a label→code mapping outside logic/anatomy: move it into the one place");
});

Deno.test("the catalogue answers a model's label with a code, and the writer's generic otherwise", () => {
  const liver = codesFor("liver", "ts.v2:total");
  assert(liver.code?.startsWith("SCT:"), "liver has a SNOMED code in the catalogue");
  assertEquals(codesFor("something_no_model_writes", "ts.v2:total"), {});
  assert(lookupStructure("rib_right_6")?.name.toLowerCase().includes("rib"));
});

Deno.test("a model's label has a definition where one was observed, and none where none was", () => {
  const d = definitionFor("ts.v2:total", "rib_right_6");
  assert(d && /head/.test(d.says) && /2026-09-20/.test(d.source), "the TotalSegmentator rib is defined, with its source");
  assert(definitionFor("cads:ribs", "rib_left_3"), "CADS ribs are defined");
  assert(definitionFor("moose:clin_ct_all_bones_v1", "ribcage"), "MOOSE's ribcage is defined");
  assertEquals(definitionFor("ts.v2:total", "liver"), undefined, "no claim where nothing was observed");
  assertEquals(definitionFor(undefined, "rib_right_6"), undefined, "no model, no definition");
});
