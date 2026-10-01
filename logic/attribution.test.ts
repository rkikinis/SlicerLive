import { assertEquals } from "jsr:@std/assert@1";
import { attributionOf, formatCite, licenseLine, primaryCite } from "./attribution.ts";

const rec = { attribution: {
  task: { tag: "07052025", license: { weights: "CC-BY-4.0" } },
  ecosystem: "moose",
  ecosystem_info: { title: "MOOSE (moosez)", group: "QIMP, Medical University of Vienna", repository: "https://github.com/ENHANCE-PET/MOOSE", license: { code: "Apache-2.0", weights: "CC-BY-4.0" } },
  engine: "nnunetv2", engine_info: { title: "nnU-Net", license: { code: "Apache-2.0" } },
  cite: [
    { title: "nnU-Net: a self-configuring method", authors: "Isensee F, et al", journal: "Nature Methods", year: 2021, doi: "10.1038/s41592-020-01008-z", for: "engine" },
    { title: "Fully Automated, Semantic Segmentation of Whole-Body PET/CT", authors: "Shiyam Sundar LK, Yu J, et al.", journal: "Journal of Nuclear Medicine", year: 2022, doi: "10.2967/jnumed.122.264063", for: "ecosystem" },
  ],
} };

Deno.test("attributionOf: the server's record in one shape; the ecosystem's paper first; the license in words", () => {
  const a = attributionOf(rec)!;
  assertEquals(a.title, "MOOSE (moosez)");
  assertEquals(a.repository, "https://github.com/ENHANCE-PET/MOOSE");
  assertEquals(licenseLine(a), "code Apache-2.0 · weights CC-BY-4.0");
  assertEquals(primaryCite(a)?.doi, "10.2967/jnumed.122.264063");
  assertEquals(formatCite(a.cite[0]), "Isensee F, et al. nnU-Net: a self-configuring method. Nature Methods 2021. doi:10.1038/s41592-020-01008-z");
  assertEquals(a.engine?.title, "nnU-Net");
  // a task's own license wins over the ecosystem's (TotalSegmentator's licensed models)
  const b = attributionOf({ attribution: { ecosystem_info: { license: { code: "Apache-2.0", weights: "CC-BY-4.0" } }, task: { license: { weights: "TotalSegmentator model license", url: "https://backend.totalsegmentator.com/license-academic/" } }, cite: [] } })!;
  assertEquals(b.license?.weights, "TotalSegmentator model license");
  assertEquals(attributionOf({}), null);
  assertEquals(attributionOf(null), null);
});
