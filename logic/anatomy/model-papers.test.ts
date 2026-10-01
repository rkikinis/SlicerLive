// The claim under test: a network's paper can be found from what haversack calls it, an unknown
// network says so instead of guessing, and every DOI here resolves to the shape a DOI has.
//
//   deno test -A --no-check logic/anatomy/model-papers.test.ts
import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { allPapers, CONCORDANCE_PAPER, formatCitation, METHOD_PAPER, paperFor } from "./model-papers.ts";

Deno.test("paperFor: a full task name resolves to its family's paper", () => {
  assertEquals(paperFor("ts:total_fast")?.doi, "10.1148/ryai.230024");
  assertEquals(paperFor("moose:clin_ct_muscles")?.doi, "10.2967/jnumed.122.264063");
});

Deno.test("paperFor: a bare ecosystem resolves too", () => {
  assertEquals(paperFor("ts")?.name, "TotalSegmentator");
  assertEquals(paperFor("moose")?.name, "MOOSE");
});

// haversack resolves a bare task name across ecosystems; this module does not, because attributing
// a paper to the wrong family is worse than declining to attribute one.
Deno.test("paperFor: a bare task name with no ecosystem is not guessed", () => {
  assertEquals(paperFor("total_fast"), null);
});

// A network the user brought themselves has no entry, and that is a normal state rather than a bug.
Deno.test("paperFor: an unknown ecosystem returns null, not a placeholder", () => {
  assertEquals(paperFor("mrsegmentator:base"), null);
  assertEquals(paperFor(""), null);
  assertEquals(paperFor(undefined), null);
});

// The Radiology version, not the 2022 arXiv preprint that Slicer's extension and the concordance
// paper both still cite. Ron: "The wasserthal paper is now a radiology paper."
Deno.test("TotalSegmentator: the journal version, not the preprint", () => {
  const p = paperFor("ts:body")!;
  assertEquals(p.year, 2023);
  assertEquals(p.journal.startsWith("Radiology"), true);
  assertEquals(p.url.includes("arxiv"), false);
});

Deno.test("every entry has a resolvable DOI url and says where it came from", () => {
  for (const p of allPapers()) {
    assertMatch(p.doi, /^10\.\d{4,9}\/\S+$/, `${p.name}: not a DOI`);
    assertEquals(p.url, `https://doi.org/${p.doi}`, `${p.name}: url must resolve the DOI`);
    assertEquals(p.sourcedFrom.length > 10, true, `${p.name}: must name its source`);
  }
});

// The two papers that apply whatever family a task came from.
Deno.test("the method and concordance papers are marked as applying to all", () => {
  assertEquals(METHOD_PAPER.ecosystem, "*");
  assertEquals(CONCORDANCE_PAPER.ecosystem, "*");
  assertEquals(METHOD_PAPER.name, "nnU-Net");
  // Ron is a co-author of the concordance paper, alongside the TotalSegmentator and MOOSE authors.
  assertEquals(CONCORDANCE_PAPER.authors.includes("Kikinis R."), true);
  assertEquals(CONCORDANCE_PAPER.authors.includes("Wasserthal J."), true);
});

Deno.test("formatCitation: one printable line", () => {
  const line = formatCitation(paperFor("ts")!);
  assertEquals(line.includes("TotalSegmentator: Robust Segmentation"), true);
  assertEquals(line.endsWith("doi:10.1148/ryai.230024"), true);
});

// FastSurfer asks for a main paper plus one per module, per its own documentation, so `alsoCite`
// carries the extras rather than forcing a choice between under-citing and inventing a rule.
Deno.test("FastSurfer: the main paper, with its module paper alongside", () => {
  const f = paperFor("fastsurfer:whatever")!;
  assertEquals(f.doi, "10.1016/j.neuroimage.2020.117012");
  assertEquals(f.year, 2020);
  assertEquals(f.alsoCite?.length, 1);
  assertEquals(f.alsoCite![0].doi, "10.1016/j.neuroimage.2022.118933");
});

// Every DOI must resolve through doi.org, including the ones nested in alsoCite -- Ron: "Please
// include DOI for all papers that you cite", which applies to a module paper as much as a main one.
Deno.test("every nested citation carries a DOI and a source too", () => {
  for (const p of allPapers()) {
    for (const a of p.alsoCite ?? []) {
      assertMatch(a.doi, /^10\.\d{4,9}\/\S+$/, `${a.name}: not a DOI`);
      assertEquals(a.url, `https://doi.org/${a.doi}`, `${a.name}: url must resolve the DOI`);
      assertEquals(a.sourcedFrom.length > 10, true, `${a.name}: must name its source`);
    }
  }
});
