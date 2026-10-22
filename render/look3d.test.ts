// The 3D look's rules (render/look3d.ts). Since 2026-10-21 (Ron, option B) there is no "surfaces" look:
// surface models are an export made from Save › Files, never drawn. A segmentation or a scene that still
// says `surfaceModels: true` / `look3D: "surfaces"` (saved before then) is drawn solid.
//
//   deno test -A --no-check render/look3d.test.ts
import { assertEquals } from "jsr:@std/assert";
import type { LiveScene } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";
import { LOOKS_3D, look3DOf, looksOn, segLookOf } from "./look3d.ts";

function scene(nodes: MrsonNode[]): LiveScene {
  return { nodes: new Map(nodes.map((n) => [n.id as string, n])) } as unknown as LiveScene;
}
const ct = (look?: string): MrsonNode => ({ type: "image", id: "ct", ...(look ? { look3D: look } : {}) } as unknown as MrsonNode);
const seg = (id: string, models = false, source = "ct"): MrsonNode =>
  ({ type: "segmentation", id, refs: { source: [source] }, ...(models ? { surfaceModels: true } : {}) } as unknown as MrsonNode);

Deno.test("a segmentation is drawn solid by default, with or without its volume", () => {
  const s = scene([ct(), seg("a")]);
  assertEquals(segLookOf(s, s.nodes.get("a")!), "solid");
  const alone = scene([seg("b", false, "gone")]);
  assertEquals(segLookOf(alone, alone.nodes.get("b")!), "solid");
});

Deno.test("there is no Surfaces look any more: a segmentation flagged with surface models is drawn solid", () => {
  assertEquals(LOOKS_3D.includes("surfaces" as never), false);
  const s = scene([ct("surfaces"), seg("with", true), seg("without")]);
  assertEquals(segLookOf(s, s.nodes.get("with")!), "solid");
  assertEquals(segLookOf(s, s.nodes.get("without")!), "solid");
  const alone = scene([seg("b", true, "gone")]);
  assertEquals(segLookOf(alone, alone.nodes.get("b")!), "solid");
});

Deno.test("a look stored as surfaces by an older scene is read as Colored (solid)", () => {
  assertEquals(look3DOf(scene([ct("surfaces"), seg("a")]), "ct"), "solid");
  assertEquals(look3DOf(scene([ct("surfaces"), seg("a", true)]), "ct"), "solid");
  assertEquals(looksOn(scene([ct("surfaces"), seg("a", true)]), "ct"), ["solid"]);
});

Deno.test("off and volume hide the segmentations in 3D", () => {
  for (const look of ["off", "volume"]) {
    const s = scene([ct(look), seg("a", true)]);
    assertEquals(segLookOf(s, s.nodes.get("a")!), "hidden");
  }
});

Deno.test("Scene lights every look that is on: the volume rendering and the solid segmentations together", () => {
  const vr = { type: "volumeRenderingDisplay", id: "vr", refs: { volume: ["ct"] }, visible: true } as unknown as MrsonNode;
  assertEquals(looksOn(scene([ct("solid"), seg("a"), vr]), "ct"), ["volume", "solid"]);
  assertEquals(looksOn(scene([ct("solid"), seg("a")]), "ct"), ["solid"]);
  assertEquals(looksOn(scene([ct("off")]), "ct"), ["off"]);
});

Deno.test("a sequence member follows its frame's look: hidden under Off and Volume, solid otherwise", () => {
  const frame = (id: string, look: string) => ({ type: "image", id, sequence: "seq", look3D: look } as unknown as MrsonNode);
  const member = (id: string, src: string, models: boolean) =>
    ({ type: "segmentation", id, sequence: "segseq", hidden: true, refs: { source: [src] }, ...(models ? { surfaceModels: true } : {}) } as unknown as MrsonNode);
  for (const look of ["off", "volume"]) {
    const s = scene([frame("f0", look), frame("f1", look), member("m0", "f0", true), member("m1", "f1", true)]);
    assertEquals(segLookOf(s, s.nodes.get("m1")!), "hidden", look);
  }
  const s = scene([frame("f0", "surfaces"), frame("f1", "surfaces"), member("m0", "f0", true), member("m1", "f1", true)]);
  assertEquals(segLookOf(s, s.nodes.get("m1")!), "solid");
});

Deno.test("a time series lights one look: its rendering decides (round 2, finding 5)", () => {
  const f = (id: string) => ({ type: "image", id, sequence: "seq", look3D: "solid" } as unknown as MrsonNode);
  const m = { type: "segmentation", id: "m0", sequence: "segseq", hidden: true, refs: { source: ["f0"] } } as unknown as MrsonNode;
  const vr = (colorize: boolean | undefined, visible = true) => ({ type: "volumeRenderingDisplay", id: "vr", refs: { volume: ["f0"] }, visible, ...(colorize === undefined ? {} : { colorize }) } as unknown as MrsonNode);
  assertEquals(looksOn(scene([f("f0"), f("f1"), m, vr(false)]), "f1"), ["volume"]);
  assertEquals(looksOn(scene([f("f0"), f("f1"), m, vr(undefined)]), "f1"), ["solid"]);
  assertEquals(looksOn(scene([f("f0"), f("f1"), m, vr(undefined, false)]), "f1"), ["off"]);
  // a single CT with its segmentation colorized into the rendering: Colored
  assertEquals(looksOn(scene([ct("solid"), seg("a"), { type: "volumeRenderingDisplay", id: "v", refs: { volume: ["ct"] }, visible: true, colorize: true } as unknown as MrsonNode]), "ct"), ["solid"]);
});
