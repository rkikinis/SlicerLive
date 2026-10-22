// The "loaded that this scene does not include" question asks the same way whichever scene is open (Ron, 2026-10-17).
//
//   deno test -A --no-check logic/loaded-elsewhere.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import type { MrsonNode } from "../render/mrson.ts";
import { loadedElsewhere } from "./loaded-elsewhere.ts";

const node = (n: Record<string, unknown>) => n as unknown as MrsonNode;
// The beating heart: five hidden frames of one series under a sequence, and a family of segmentations in time.
const heart = [
  node({ type: "sequence", id: "seq", name: "CT cardiac phases", items: [1, 2, 3, 4, 5].map((i) => ({ node: `f${i}` })) }),
  ...[1, 2, 3, 4, 5].map((i) => node({ type: "image", id: `f${i}`, hidden: true, sequence: "seq", origin: { seriesInstanceUID: "HEART-CT" } })),
  node({ type: "sequence", id: "cor", name: "coronaries", companionOf: "seq", items: [1, 2, 3, 4, 5].map((i) => ({ node: `c${i}` })) }),
  ...[1, 2, 3, 4, 5].map((i) => node({ type: "segmentation", id: `c${i}`, sequence: "cor", origin: { seriesInstanceUID: `HEART-SEG-${i}` } })),
];
// C3N-01524: a volume and a segmentation.
const c3n = [
  node({ type: "image", id: "ct", name: "CT NEPHROGENIC", origin: { seriesInstanceUID: "C3N-CT" } }),
  node({ type: "segmentation", id: "s", name: "total", origin: { seriesInstanceUID: "C3N-SEG" } }),
];

Deno.test("the beating heart open, C3N-01524 about to open: the heart is named (it was not)", () => {
  assertEquals(loadedElsewhere(heart, new Set(["C3N-CT", "C3N-SEG"])).map((n) => n.name), ["CT cardiac phases", "coronaries"]);
});

Deno.test("C3N-01524 open, the heart about to open: C3N's volume and segmentation are named", () => {
  assertEquals(loadedElsewhere(c3n, new Set(["HEART-CT", "HEART-SEG-1"])).map((n) => n.name), ["CT NEPHROGENIC", "total"]);
});

Deno.test("a scene opened over its own data asks nothing", () => {
  assertEquals(loadedElsewhere(heart, new Set(["HEART-CT", ...[1, 2, 3, 4, 5].map((i) => `HEART-SEG-${i}`)])), []);
  assertEquals(loadedElsewhere(c3n, new Set(["C3N-CT", "C3N-SEG"])), []);
});
