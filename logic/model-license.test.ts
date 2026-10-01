// Which networks stop you before they run, and which do not.
//
// Ron, on the first version: "it also pops up for networks that dont require the license, such as
// lung vessels." It gated on ecosystem, so every TotalSegmentator task raised the dialog — including
// the thirty that are in the public release and need nothing. A dialog in front of a free task
// teaches people to dismiss dialogs.
//
//   deno test -A --no-check logic/model-license.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { licenseFor, outputRestriction } from "./model-license.ts";

Deno.test("a task that needs a license key raises the notice", () => {
  for (const t of ["ts:brain_structures", "ts:coronary_arteries", "ts:vertebrae_body", "ts:aortic_sinuses"]) {
    assert(licenseFor(t), `${t} requires a key`);
  }
});

Deno.test("a free task does not", () => {
  // The ones Ron actually runs. `lung_vessels` is the case he reported.
  for (const t of ["ts:lung_vessels", "ts:total", "ts:total_fast", "ts:liver_segments", "ts:ventricle_parts", "ts:abdominal_muscles"]) {
    assertEquals(licenseFor(t), null, `${t} is in the public release`);
  }
});

Deno.test("another ecosystem gets no claim made about it", () => {
  // Saying nothing is honest; inventing terms for a project whose license we have not read is not.
  assertEquals(licenseFor("moose:clin_ct_organs"), null);
  assertEquals(licenseFor("mrsegmentator:base"), null);
});

Deno.test("the four with restricted RESULTS say so, every time", () => {
  for (const t of ["ts:appendicular_bones", "ts:tissue_types", "ts:heartchambers_highres", "ts:face"]) {
    assert(licenseFor(t)?.restrictedOutput, `${t} restricts its output`);
    assert(outputRestriction(t).includes("may not be used commercially"));
  }
});

Deno.test("a licensed task whose OUTPUT is unrestricted says nothing extra", () => {
  // brain_structures needs a key, but its results carry no commercial restriction — so the notice
  // is shown once and not repeated, unlike the four above.
  assert(licenseFor("ts:brain_structures"));
  assertEquals(licenseFor("ts:brain_structures")!.restrictedOutput, false);
  assertEquals(outputRestriction("ts:brain_structures"), "");
});

Deno.test("the notice carries the license page Ron asked to link", () => {
  const lic = licenseFor("ts:brain_structures")!;
  assertEquals(lic.url, "https://backend.totalsegmentator.com/license-academic");
  assertEquals(lic.terms.length, 4, "academic use, internal use, regulated uses, no warranty");
});
