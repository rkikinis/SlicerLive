// THE FIREWALL AROUND SURFACE MODELS, against the real SegmentationDisplayableManager (render/livescene.ts).
//
// Ron, 2026-09-24: "remove the surface models as a 'first class' citizen … But I would firewall it." A
// segmentation has surface models only when its node says `surfaceModels: true` (set by the Generate Surface
// Models module). The critic found the claim untested and broken in four places (Contents/docs/qa/
// 2026-09-24-surface-firewall.md, findings 3, 4, 11, 14, and round 2's 1 and 2); each case below is one of its reproductions,
// turned into a test. Small labelmaps on the card; the extraction itself is stubbed where it would start.
//
//   deno test -A --no-check --unstable-webgpu render/test/surface-firewall.gpu.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { ColorizeBaker, makeLabelPaletteTexture } from "../bake.ts";
import { SegmentationDisplayableManager, setStoredSurfaceLoader, setSurfaceProgressReporter } from "../livescene.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// deno-lint-ignore no-explicit-any
type Any = any;

function sceneOf(nodes: [string, Record<string, unknown>][], drawn: string[] = []): Any {
  const map = new Map<string, Any>(nodes);
  return {
    nodes: map,
    write(op: Any) { if (op.op === "patch") map.get(op.id)[op.path.replace("#/", "")] = op.value; },
    view: { setMeshGroup(k: string, l: unknown[]) { drawn.push(`${k}:${l.length}`); }, redraw() {}, removeField() {}, segments3DDrawnByVolume: () => false },
  };
}
function cube(n: number): Uint8Array {
  const lab = new Uint8Array(n * n * n);
  for (let k = n / 4; k < (3 * n) / 4; k++) for (let j = n / 4; j < (3 * n) / 4; j++) for (let i = n / 4; i < (3 * n) / 4; i++) lab[(k * n + j) * n + i] = 1;
  return lab;
}
const tri = () => [{ label: 1, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }];
const opts = { ignore: !hasGpu, sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...opts,
  name: "a segmentation without surface models: nothing is built, asked for, or held",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const scene = sceneOf([["seg1", { type: "segmentation", id: "seg1", name: "s" }]]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, cube(16), [16, 16, 16]), dims: [16, 16, 16], ijkToRAS: ID, palette: new Float32Array(1024), added: false };
    dm.slots.set("seg1", slot);
    let started = 0;
    dm.buildSurfacesInWorker = () => { started++; return false; };
    assertEquals(dm.ensureSurfaces("seg1", scene), false);
    assertEquals(dm.buildSurfaces(slot, scene), false);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(started, 0);
    assertEquals(slot.meshing, undefined);
    assertEquals(slot.nativeLab, undefined, "no labelmap copy");
    assertEquals(dm.surfaceState("seg1", scene).held, false);
    slot.baker.destroy(); dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "Remove while the labelmap is read back: no extraction starts and nothing is held (finding 3)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const scene = sceneOf([["seg1", { type: "segmentation", id: "seg1", name: "s" }]]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, cube(32), [32, 32, 32]), dims: [32, 32, 32], ijkToRAS: ID, palette: new Float32Array(1024), added: false, zarrSig: "a" };
    dm.slots.set("seg1", slot);
    let started = 0;
    dm.buildSurfacesInWorker = () => { started++; return false; };
    dm.generateSurfaces("seg1", scene);
    assertEquals(scene.nodes.get("seg1").surfaceModels, true);
    assert(dm.surfaceState("seg1", scene).building, "the read-back is under way");
    dm.removeSurfaces("seg1", scene);
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(scene.nodes.get("seg1").surfaceModels, false);
    assertEquals(started, 0, "the extraction did not start after Remove");
    assertEquals(slot.nativeLab, undefined, "the read-back labelmap was not kept");
    assertEquals(dm.surfaceState("seg1", scene).held, false);
    slot.baker.destroy(); dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "the read-back gives the extraction exactly the labels on the card",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const scene = sceneOf([["seg1", { type: "segmentation", id: "seg1", name: "s" }]]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    // 30 wide: rows padded to 256 bytes on the way back.
    const n = 30, lab = new Uint8Array(n * n * n).map((_, i) => (i * 7) % 5);
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, lab, [n, n, n]), dims: [n, n, n], ijkToRAS: ID, palette: new Float32Array(1024), added: false, zarrSig: "a" };
    dm.slots.set("seg1", slot);
    let got: Uint8Array | undefined;
    dm.buildSurfacesInWorker = (s: Any) => { got = s.nativeLab; return false; };
    dm.generateSurfaces("seg1", scene);
    await new Promise((r) => setTimeout(r, 500));
    assert(got, "the extraction was started with a labelmap");
    assertEquals(got!.length, lab.length);
    assertEquals(got!.findIndex((v, i) => v !== lab[i]), -1);
    slot.baker.destroy(); dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "a build that lands is drawn only under the Surfaces look with the segmentation on in 3D (finding 4)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    for (const [look, on3D, want] of [["off", true, 0], ["volume", true, 0], ["solid", true, 0], ["surfaces", false, 0], ["surfaces", true, 1]] as const) {
      const drawn: string[] = [];
      const scene = sceneOf([
        ["ct", { type: "image", id: "ct", look3D: look }],
        ["seg1", { type: "segmentation", id: "seg1", name: "s", surfaceModels: true, visible3D: on3D, refs: { source: ["ct"] } }],
      ], drawn);
      const dm = new SegmentationDisplayableManager(dev) as Any;
      const pal = new Float32Array(1024); pal[4 + 3] = 1;
      const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, new Uint8Array(512), [8, 8, 8]), dims: [8, 8, 8], ijkToRAS: ID, palette: pal, added: false, lastDisp: scene.nodes.get("seg1"), surfaces: tri() };
      dm.slots.set("seg1", slot);
      dm.pushSurfaces(slot, scene);
      assertEquals(drawn.at(-1), `seg:seg1:${want}`, `look ${look}, 3D ${on3D}`);
      slot.baker.destroy();
    }
    dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "a build that lands after an edit is dropped and made again from the current labels (finding 1)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const scene = sceneOf([["seg1", { type: "segmentation", id: "seg1", name: "s", surfaceModels: true }]]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, cube(16), [16, 16, 16]), dims: [16, 16, 16], ijkToRAS: ID, palette: new Float32Array(1024), added: false, zarrSig: "after-the-edit", surfaces: tri() };
    dm.slots.set("seg1", slot);
    let again = 0;
    dm.buildSurfaces = () => { again++; return false; };
    assertEquals(dm.landed(slot, scene, "before-the-edit"), false);
    assertEquals(slot.surfaces, undefined, "the old geometry is not kept");
    assertEquals(again, 1, "built again");
    assertEquals(dm.landed(slot, scene, "after-the-edit"), true);
    slot.baker.destroy(); dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "every structure hidden is not a failure: nothing is said (finding 11)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const said: string[] = [];
    setSurfaceProgressReporter((m: string) => said.push(m));
    const scene = sceneOf([
      ["ct", { type: "image", id: "ct", look3D: "surfaces" }],
      ["seg1", { type: "segmentation", id: "seg1", name: "liver vessels", surfaceModels: true, refs: { source: ["ct"] } }],
    ]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, new Uint8Array(512), [8, 8, 8]), dims: [8, 8, 8], ijkToRAS: ID, palette: new Float32Array(1024), added: false, lastDisp: scene.nodes.get("seg1"), surfaces: tri() };
    dm.slots.set("seg1", slot);
    dm.showSurfaces3D(slot, scene);
    assertEquals(said, []);
    // No stand-in can be drawn: the segmentation manager has no volume field left to hand the view at all.
    assertEquals(typeof (dm as Any).buildPresenceVolume, "undefined", "the blurred stand-in is back");
    setSurfaceProgressReporter(() => {});
    slot.baker.destroy(); dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "ONE EXTRACTION AT A TIME: five flagged phases arriving together build one after the other (round 2, finding 1)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const nodes = new Map<string, Any>();
    const dm = new SegmentationDisplayableManager(dev) as Any;
    // A patch hands the node back to the manager, as LiveScene.applied does.
    const scene: Any = {
      nodes,
      write(op: Any) {
        if (op.op !== "patch") return;
        const n = { ...nodes.get(op.id) }; n[op.path.replace("#/", "")] = op.value; nodes.set(op.id, n);
        if (n.type === "segmentation" || n.type === "image") void dm.onNodeAdded(n, scene);
      },
      view: { setMeshGroup() {}, setSegmentationLabelOverlays() {}, redraw() {}, removeField() {}, setField() {}, segments3DDrawnByVolume: () => false, setVolume3D() {} },
      blobBase: () => "",
    };
    dm.scheduleSolid = () => {};
    let running = 0, most = 0;
    const order: string[] = [];
    dm.buildSurfacesInWorker = (slot: Any) => {
      running++; most = Math.max(most, running); order.push(slot.id); slot.meshing = true;
      setTimeout(() => { running--; slot.meshing = false; slot.surfaces = tri(); dm.releaseIfIdle(slot, scene); }, 30);
      return false;
    };
    setStoredSurfaceLoader(async () => null);           // nothing stored
    for (let k = 0; k < 5; k++) {
      const f = `frame${k}`, m = `member${k}`;
      nodes.set(f, { type: "image", id: f, sequence: "seq", look3D: "solid" });
      const zarr = { k };
      const node = { type: "segmentation", id: m, name: "chambers", sequence: "segseq", hidden: true, refs: { source: [f] }, zarr, visible: k === 0, visible3D: k === 0, segments: [{ labelValue: 1, color: [1, 0, 0] }] };
      nodes.set(m, node);
      const lab = new Uint8Array(16 * 16 * 16); lab.fill(1, 1000, 3000);
      dm.slots.set(m, { id: m, baker: new ColorizeBaker(dev, lab, [16, 16, 16]), paletteTex: makeLabelPaletteTexture(dev), dims: [16, 16, 16], ijkToRAS: ID, palette: new Float32Array(1024).fill(1), added: false, zarrSig: JSON.stringify(zarr), palKey: "", lastDisp: node });
    }
    for (let k = 0; k < 5; k++) scene.write({ op: "patch", id: `member${k}`, path: "#/surfaceModels", value: true });
    const inFlight = [...dm.slots.values()].filter((sl: Any) => dm.inFlight(sl)).length;
    assertEquals(inFlight, 5, "all five are on their way (one building, four waiting)");
    assertEquals([...dm.slots.values()].filter((sl: Any) => sl.meshing).length, 1, "but only one is building");
    for (let i = 0; i < 100 && order.length < 5 || running; i++) await new Promise((r) => setTimeout(r, 30));
    assertEquals(most, 1, "never two extractions at once");
    assertEquals(order.length, 5, "every phase got its turn");
    assertEquals([...dm.slots.values()].every((sl: Any) => sl.surfaces), true);
    setStoredSurfaceLoader(null as Any);
    for (const sl of dm.slots.values()) sl.baker.destroy();
    dev.destroy();
  },
});

Deno.test({
  ...opts,
  name: "Generate, Remove, Generate: one extraction, and Remove stops it (round 2, finding 2)",
  async fn() {
    const dev = await (await navigator.gpu.requestAdapter())!.requestDevice();
    const scene = sceneOf([["seg1", { type: "segmentation", id: "seg1", name: "s" }]]);
    const dm = new SegmentationDisplayableManager(dev) as Any;
    const slot: Any = { id: "seg1", baker: new ColorizeBaker(dev, cube(32), [32, 32, 32]), dims: [32, 32, 32], ijkToRAS: ID, palette: new Float32Array(1024), added: false, zarrSig: "a" };
    dm.slots.set("seg1", slot);
    const started: string[] = [];
    let n = 0;
    dm.buildSurfacesInWorker = (sl: Any) => { const w = `worker${++n}`; started.push(w); sl.worker = { terminate() { started.push(`${w} terminated`); } }; sl.meshing = true; return false; };
    dm.generateSurfaces("seg1", scene);
    dm.removeSurfaces("seg1", scene);
    dm.generateSurfaces("seg1", scene);
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(started, ["worker1"], "the first read-back was dropped; one extraction");
    dm.removeSurfaces("seg1", scene);
    assertEquals(started, ["worker1", "worker1 terminated"]);
    assertEquals(dm.surfaceState("seg1", scene).building, false);
    slot.baker.destroy(); dev.destroy();
  },
});
