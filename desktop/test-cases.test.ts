// The test-case download's bookkeeping (desktop/test-cases.ts), from a small local source, nothing fetched from
// OpenNeuro: a person with files missing is skipped and their partial download removed (critic, 2026-10-01, finding
// 14); a run that finishes says so (the offer to continue goes away, finding 3); a person already done is skipped.
//
//   deno test -A --no-check desktop/test-cases.test.ts
import { assert, assertEquals } from "jsr:@std/assert";

const src = await Deno.makeTempDir({ prefix: "albula-tc-src-" });
const db = await Deno.makeTempDir({ prefix: "albula-tc-db-" });
globalThis.addEventListener("unload", () => { for (const d of [src, db]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });
Deno.env.set("ALBULA_TEST_CASES_SOURCE", src);
const { getTestCases, testCasesComplete, DOWNLOAD_FOLDER, TEST_CASES } = await import("./test-cases.ts");

await Deno.writeTextFile(`${src}/dataset_description.json`, JSON.stringify({ Name: "test", BIDSVersion: "1.0.2", License: "CC0" }));
await Deno.writeTextFile(`${src}/README`, "test");
await Deno.writeTextFile(`${src}/participants.tsv`, "participant_id\tsex\nsub-PAT90\tM\nsub-PAT91\tF\n");
// PAT90 has only its T1 (and its sidecar): not complete.
await Deno.mkdir(`${src}/sub-PAT90/ses-preop/anat`, { recursive: true });
await Deno.writeTextFile(`${src}/sub-PAT90/ses-preop/anat/sub-PAT90_ses-preop_T1w.nii.gz`, "x");
await Deno.writeTextFile(`${src}/sub-PAT90/ses-preop/anat/sub-PAT90_ses-preop_T1w.json`, "{}");

Deno.test("people with files missing are skipped, their partial download removed; the finished run is marked complete", async () => {
  assertEquals(await testCasesComplete(db), false);
  const p = await getTestCases(db, () => {});
  assertEquals(p.subjects, 2);
  assertEquals(p.skipped.length, 2);
  assertEquals(p.failed, []);
  const root = `${db}/${DOWNLOAD_FOLDER}/${TEST_CASES.dataset}`;
  assert(!(await Deno.stat(`${root}/sub-PAT90`).then(() => true, () => false)), "the partial download is gone");
  assertEquals(await testCasesComplete(db), true);
});

Deno.test("a person already done is not fetched again", async () => {
  const root = `${db}/${DOWNLOAD_FOLDER}/${TEST_CASES.dataset}`;
  await Deno.writeTextFile(`${root}/.done-PAT91`, "earlier");
  const p = await getTestCases(db, () => {});
  assertEquals(p.earlier, 1);
  assertEquals(p.skipped.length, 1);
});
