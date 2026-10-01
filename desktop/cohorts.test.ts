// Cohorts in the provenance store: made, filled, emptied, deleted; nothing else touched.
import { assertEquals } from "jsr:@std/assert@1";
import { cohorts, createCohort, deleteCohort, setCohortMembers, setSeriesAttribute, seriesAttributes } from "./db-index.ts";

Deno.test("a cohort is a name and its patients and studies; deleting it leaves the attributes alone", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/provenance.sqlite`;
  await setSeriesAttribute(path, "1.2.3", "collection", "nlst");            // something else in the store first
  await createCohort(path, " Keynote pictures ");
  assertEquals((await cohorts(path)).map((c) => [c.name, c.patients, c.studies]), [["Keynote pictures", [], []]]);
  await setCohortMembers(path, "Keynote pictures", [{ level: "patient", uid: "C3N-01524" }, { level: "study", uid: "1.2.840.1" }], []);
  await setCohortMembers(path, "Muscles", [{ level: "patient", uid: "C3N-01524" }], []);   // created on the way
  let all = await cohorts(path);
  assertEquals(all.map((c) => c.name), ["Keynote pictures", "Muscles"]);
  assertEquals(all[0].patients, ["C3N-01524"]); assertEquals(all[0].studies, ["1.2.840.1"]);
  await setCohortMembers(path, "Keynote pictures", [], [{ level: "study", uid: "1.2.840.1" }]);
  all = await cohorts(path);
  assertEquals(all[0].studies, []);
  await deleteCohort(path, "Muscles");
  assertEquals((await cohorts(path)).map((c) => c.name), ["Keynote pictures"]);
  assertEquals((await seriesAttributes(path)).map((a) => a.value), ["nlst"]);
  await Deno.remove(dir, { recursive: true });
});
