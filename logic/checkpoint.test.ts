// A job that finished after a reload finds the result it just saved, whatever form the save's answer
// takes (Ron's ts.v2:total, 2026-09-23 17:19: the save answered with a path, the list holds names, and
// the result landed nowhere).
//
//   deno test -A --no-check logic/checkpoint.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { findSavedCheckpoint } from "./checkpoint.ts";

Deno.test("the saved checkpoint is found in the list by its file name, from a path or a bare name", () => {
  const list = [{ file: "2026-09-23T17-19-00-000Z-ts.v2_total.seg.nrrd" }, { file: "other.seg.nrrd" }];
  const path = "/Users/x/SlicerDICOMDatabase/SlicerAlbula-Checkpoints/2026-09-23T17-19-00-000Z-ts.v2_total.seg.nrrd";
  assertEquals(findSavedCheckpoint(list, path), list[0]);
  assertEquals(findSavedCheckpoint(list, "other.seg.nrrd"), list[1]);
  assertEquals(findSavedCheckpoint(list, "/a/b/missing.seg.nrrd"), undefined);
});
