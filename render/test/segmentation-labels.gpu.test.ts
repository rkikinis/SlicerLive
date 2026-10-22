// THE SEGMENTATION MANAGER AFTER SURFACE MODELS (render/livescene.ts), against real textures on the card.
//
// Ron, 2026-10-21 (option B): surface models are not drawn in Albula any more -- the anatomy is drawn solid from the
// labels -- and are made only as an export, on demand, from Save › Files (render/surface-export.ts). This file was
// the firewall's (2026-09-24: "remove the surface models as a 'first class' citizen … But I would firewall it.");
// what it guards now:
//   - a segmentation that still says `surfaceModels: true` (a scene saved before) draws no mesh and builds nothing,
//     whatever its volume's stored look says;
//   - the export's labels, read back from the card, are exactly the labels the card holds (rows padded to 256
//     bytes on the way back), and nothing of them is kept by the manager.
//
//   deno test -A --no-check --unstable-webgpu render/test/segmentation-labels.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { ColorizeBaker, makeLabelPaletteTexture } from "../bake.ts";
import { LABEL_READ_SLAB, SegmentationDisplayableManager } from "../livescene.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// deno-lint-ignore no-explicit-any
type Any = any;
const opts = { ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false };

function sceneOf(nodes: [string, Record<string, unknown>][], meshCalls: string[], solid: string[] = []): Any {
  const map = new Map<string, Any>(nodes);
  return {
    nodes: map,
    write(op: Any) { if (op.op === "patch") map.get(op.id)[op.path.replace("#/", "")] = op.value; },
    view: {
      setMeshGroup(k: string, l: unknown[]) { meshCalls.push(`${k}:${l.length}`); },
      setSegmentationLabelOverlays() {}, redraw() {}, removeField() {},
      setVolume3D(k: string, v: { drawsSegs?: string[] } | null) { solid.push(`${k.split(":")[0]}:${v ? (v.drawsSegs ?? []).join(",") : "off"}`); },
      segments3DDrawnByVolume: () => false, segmentColoredByVolumeRendering: () => false,
    },
  };
}

Deno.test({
  ...opts,
  name: "a segmentation saved with surface models, under the old Surfaces look: drawn solid, no mesh, nothing built",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const meshCalls: string[] = [], solid: string[] = [];
    const scene = sceneOf([
      ["ct", { type: "image", id: "ct", look3D: "surfaces" }],
      ["seg1", { type: "segmentation", id: "seg1", name: "s", surfaceModels: true, refs: { source: ["ct"] }, segments: [{ labelValue: 1, name: "box", color: [1, 0, 0] }] }],
    ], meshCalls, solid);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const lab = new Uint8Array(16 * 16 * 16).fill(1, 1000, 3000);
    const pal = new Float32Array(1024); pal[4 + 3] = 1;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, lab, [16, 16, 16]), paletteTex: makeLabelPaletteTexture(dev), dims: [16, 16, 16], ijkToRAS: ID, palette: pal, zarrSig: "a" };
    dm.slots.set("seg1", slot);
    dm.apply(slot, scene.nodes.get("seg1"), scene);
    await new Promise((r) => setTimeout(r, 100));        // the solid look's pass is a microtask; anything started would be in flight
    assertEquals(meshCalls, [], "no surface mesh is handed to the view");
    assertEquals(solid, ["solid:seg1"], "it is drawn by the solid look");
    // The surface machinery is gone, not merely idle: nothing can ask for it.
    for (const m of ["ensureSurfaces", "generateSurfaces", "removeSurfaces", "surfaceState", "surfacesOf", "buildSurfaces", "pushSurfaces"]) {
      assertEquals(typeof dm[m], "undefined", `${m} is back`);
    }
    assertEquals(Object.keys(slot).filter((k) => /surfaces|nativeLab|meshing|worker/.test(k)), [], "the slot holds nothing for surfaces");
    dm.onSceneClosed(scene);
    dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "the export's labels are read back from the card exactly, and not kept",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const dm = new SegmentationDisplayableManager(dev) as Any;
    // 30 wide: rows padded to 256 bytes on the way back.
    const n = 30, lab = new Uint8Array(n * 31 * 7).map((_, i) => (i * 7) % 5);
    const ijk = [0.7, 0, 0, -10, 0, 0.7, 0, 5, 0, 0, 2.5, -40, 0, 0, 0, 1];
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, lab, [n, 31, 7]), dims: [n, 31, 7], ijkToRAS: ijk, palette: new Float32Array(1024), zarrSig: "a" };
    dm.slots.set("seg1", slot);
    const got = await dm.readLabelmap("seg1");
    assert(got, "the labels came back");
    assertEquals(got.dims, [n, 31, 7]);
    assertEquals(got.ijkToRAS, ijk);
    assertEquals(got.labels.length, lab.length);
    assertEquals(got.labels.findIndex((v: number, i: number) => v !== lab[i]), -1);
    got.labels[0] = 99;                                   // the caller's own copy
    assertEquals((await dm.readLabelmap("seg1")).labels[0], lab[0]);
    assertEquals(await dm.readLabelmap("nope"), null);
    // IN SLABS (critic 2026-10-21, finding 14): one slice per slab, and two -- the same labels.
    for (const bytes of [256 * 31, 256 * 31 * 2]) {
      LABEL_READ_SLAB.bytes = bytes;
      const s = await dm.readLabelmap("seg1");
      assertEquals(s.labels.findIndex((v: number, i: number) => v !== lab[i]), -1, `slab of ${bytes} bytes`);
    }
    // PADDED (Save › Files › "Closed, for 3D printing"): one voxel of background around, read straight into the larger
    // array -- in one slab and in many.
    for (const bytes of [32 << 20, 256 * 31]) {
      LABEL_READ_SLAB.bytes = bytes;
      const pd = await dm.readLabelmap("seg1", { pad: true });
      assertEquals(pd.dims, [n + 2, 33, 9]);
      assertEquals(pd.padded, true);
      let frame = 0, bad = -1;
      for (let k = 0; k < 9; k++) for (let j = 0; j < 33; j++) for (let i = 0; i < n + 2; i++) {
        const v = pd.labels[(k * 33 + j) * (n + 2) + i];
        if (i === 0 || j === 0 || k === 0 || i === n + 1 || j === 32 || k === 8) frame += v;
        else if (bad < 0 && v !== lab[((k - 1) * 31 + j - 1) * n + i - 1]) bad = i;
      }
      assertEquals([frame, bad], [0, -1], `slab of ${bytes} bytes`);
    }
    LABEL_READ_SLAB.bytes = 32 << 20;
    slot.baker.destroy(); dev.destroy();
  },
});
