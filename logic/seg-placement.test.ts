import { assertEquals } from "jsr:@std/assert@1";
import { volumeForSeg } from "./seg-placement.ts";
import type { MrsonNode } from "../render/mrson.ts";

const im = (id: string, series: string, uids?: string[]) => ({ type: "image", id, origin: { seriesInstanceUID: series, ...(uids ? { sopInstanceUIDs: uids } : {}) } } as unknown as MrsonNode);

Deno.test("volumeForSeg: the frame whose instances the SEG names, not the first of the series", () => {
  const frames = [im("f0", "S", ["a1", "a2"]), im("f1", "S", ["b1", "b2"]), im("f2", "S", ["c1", "c2"]), im("other", "T", ["t1"])];
  assertEquals(volumeForSeg(frames, { referencedSeriesUID: "S", referencedSOPInstanceUIDs: ["b2", "b1"] })?.id, "f1");
  assertEquals(volumeForSeg(frames, { referencedSeriesUID: "S", referencedSOPInstanceUIDs: ["c1"] })?.id, "f2");
  // a SEG that names no instances, or instances no frame has: the series' first, as before
  assertEquals(volumeForSeg(frames, { referencedSeriesUID: "S" })?.id, "f0");
  assertEquals(volumeForSeg(frames, { referencedSeriesUID: "S", referencedSOPInstanceUIDs: ["zz"] })?.id, "f0");
  // a series not loaded: nothing
  assertEquals(volumeForSeg(frames, { referencedSeriesUID: "U", referencedSOPInstanceUIDs: ["a1"] }), undefined);
  assertEquals(volumeForSeg(frames, {}), undefined);
  // volumes that do not record their instances (loaded before this existed): by series
  assertEquals(volumeForSeg([im("x", "S"), im("y", "S")], { referencedSeriesUID: "S", referencedSOPInstanceUIDs: ["a1"] })?.id, "x");
});
