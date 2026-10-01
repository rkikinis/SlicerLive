// Which image, by the file and its frame (instance-key.ts). Critic, 2026-09-25, finding 8: every volume of a multi-frame
// file shares one SOPInstanceUID, and matching by it alone put one volume's state on another.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { firstInstance, holdsInstance, instanceKeys } from "./instance-key.ts";
import { volumeForSeg } from "./seg-placement.ts";
import type { MrsonNode } from "../render/mrson.ts";

const vol = (frames: number[]) => ({ sopInstanceUIDs: frames.map(() => "1.2.3"), frameNumbers: frames });
const v1 = vol([1, 2, 3]), v2 = vol([4, 5, 6]);

Deno.test("two volumes of one multi-frame file are told apart by their frames", () => {
  assertEquals(firstInstance(v2), { uid: "1.2.3", frame: 4 });
  assert(holdsInstance(v2, firstInstance(v2)));
  assert(!holdsInstance(v1, firstInstance(v2)), "volume 1 does not hold volume 2's first frame");
  assertEquals(instanceKeys(v1), ["1.2.3#1", "1.2.3#2", "1.2.3#3"]);
});

Deno.test("a single-frame series and a reference without a frame still match by the uid", () => {
  const plain = { sopInstanceUIDs: ["1.2.3.1", "1.2.3.2"] };
  assert(holdsInstance(plain, { uid: "1.2.3.2" }));
  assertEquals(firstInstance(plain), { uid: "1.2.3.1" });
  assertEquals(instanceKeys(plain), ["1.2.3.1", "1.2.3.2"]);
  assert(holdsInstance(v1, { uid: "1.2.3" }), "an old scene (no frame saved) still finds a volume of the file");
});

Deno.test("a SEG naming a frame lands on the volume that holds it", () => {
  const images = [
    { id: "a", type: "image", origin: { seriesInstanceUID: "9.9", ...v1 } },
    { id: "b", type: "image", origin: { seriesInstanceUID: "9.9", ...v2 } },
  ] as unknown as MrsonNode[];
  assertEquals(volumeForSeg(images, { referencedSeriesUID: "9.9", referencedFrames: [{ uid: "1.2.3", frame: 5 }] })?.id, "b");
  assertEquals(volumeForSeg(images, { referencedSeriesUID: "9.9", referencedSOPInstanceUIDs: ["1.2.3"] })?.id, "a");
});
