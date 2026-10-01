// THE ROUND TRIP (SCENE-DESIGN §8, item 4): save → load → save yields the same file up to
// `producedAt` and `v`. The "load" here is what the loader does after the data has arrived --
// a fresh live scene with new session-local ids and the arrival defaults (auto window/level,
// frame 1, the default camera, axial slices, every segment visible, the drawing look off) --
// and `applySceneState` putting the saved state back. Ids are session-local, so the two files
// are compared under a canonical renumbering by identity, not by id.
import { assertEquals } from "jsr:@std/assert";
import { writeScene } from "../../logic/scene/write.ts";
import { liveNodes } from "../../logic/scene/fixture.ts";
import { applySceneState } from "./scene-restore.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";

type Obj = Record<string, unknown>;

/** The least of a LiveScene the restore needs: the nodes, and a put that lands. */
function fakeLive(nodes: MrsonNode[]): LiveScene {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { nodes: map, write: (op: { op: string; id: string; node?: MrsonNode }) => { if (op.op === "put" && op.node) map.set(op.id, op.node); } } as unknown as LiveScene;
}

/** The same scene as it ARRIVES from the loader: other ids, the arrival defaults, nothing of what the person set. */
function arrivedNodes(): MrsonNode[] {
  const rename = (id: string) => id.replace(/^local-(\w+)-(\d+)/, (_m, t, n) => `local-${t}-${Number(n) + 40}-zz`).replace(/-display$/, "-display");
  const out: MrsonNode[] = [];
  for (const n0 of liveNodes()) {
    const n = JSON.parse(JSON.stringify(n0)) as Obj;
    if (n.type === "interaction") continue;
    n.id = rename(n.id as string);
    if (n.refs) n.refs = Object.fromEntries(Object.entries(n.refs as Record<string, string[]>).map(([k, v]) => [k, v.map(rename)]));
    if (typeof n.sequence === "string") n.sequence = rename(n.sequence);
    if (n.type === "sequence") n.items = (n.items as Obj[]).map((it) => ({ ...it, node: rename(it.node as string) }));
    if (n.type === "sequenceBrowser") { n.sequences = (n.sequences as Obj[]).map((s) => ({ ...s, sequence: rename(s.sequence as string), proxy: rename(s.proxy as string) })); n.selectedItemNumber = 0; n.playbackRateFps = 4; }
    if (n.type === "scalarVolumeDisplay") { n.autoWindowLevel = true; n.window = 2000; n.level = 0; }
    if (n.type === "transferFunction") { n.preset = "CT-Bone"; n.shade = [0.1, 0.9, 0.3, 10]; }
    if (n.type === "segmentation") { n.visible3D = false; n.zOrder = 0; delete n.mergedGroups; n.segments = (n.segments as Obj[]).map((s) => ({ ...s, color: [0.5, 0.5, 0.5], visible: true, opacity: 1 })); }
    if (n.type === "view" && n.kind === "slice") { n.orientation = "axial"; n.offset = 0; n.fieldOfView = [250, 250, 1]; }
    if (n.type === "view" && n.kind === "3d") { n.drawingLook = false; n.lighting = "Matte"; }
    if (n.type === "camera") { n.position = [0, 500, 0]; n.focalPoint = [0, 0, 0]; n.viewUp = [0, 0, 1]; }
    if (n.type === "sliceComposite") { n.foregroundOpacity = 0.5; n.linkedControl = true; }
    out.push(n as unknown as MrsonNode);
  }
  return out;
}

/** The file with its ids renumbered by identity, so two saves from different sessions compare. */
function canonical(doc: Obj): Obj {
  const nodes = doc.nodes as Record<string, Obj>;
  const key = new Map<string, string>();
  const intrinsic = (n: Obj): string | undefined => {
    const d = n.dicom as Obj | undefined;
    if (n.type === "image") return `image|${(d?.sopInstanceUIDs as string[])?.[0]}`;
    if (n.type === "segmentation") return `segmentation|${d?.seriesInstanceUID}|${n.name}`;
    if (n.type === "view" || n.type === "sliceComposite") return `${n.type}|${n.kind ?? ""}|${n.layoutName ?? ""}`;
    if (n.type === "camera" || n.type === "layout" || n.type === "sequenceBrowser") return `${n.type}`;
    if (n.type === "sequence") return `sequence|${n.indexName}`;
    return undefined;
  };
  for (const [id, n] of Object.entries(nodes)) { const k = intrinsic(n); if (k) key.set(id, k); }
  for (const [id, n] of Object.entries(nodes)) {                      // displays: by what they belong to
    const refs = (n.refs as Record<string, string[]> | undefined) ?? {};
    if (n.type === "scalarVolumeDisplay") { const owner = Object.entries(nodes).find(([, m]) => ((m.refs as Obj)?.display as string[] | undefined)?.includes(id)); if (owner) key.set(id, `display of ${key.get(owner[0])}`); }
    if (n.type === "volumeRenderingDisplay") { key.set(id, `vr of ${key.get(refs.volume?.[0] ?? "")}`); if (refs.transferFunction?.[0]) key.set(refs.transferFunction[0], `tf of ${key.get(refs.volume?.[0] ?? "")}`); }
  }
  const order = [...Object.keys(nodes)].sort((a, b) => (key.get(a) ?? a) < (key.get(b) ?? b) ? -1 : 1);
  const cid = new Map(order.map((id, i) => [id, `c${i + 1}`]));
  const map = (v: unknown): unknown => typeof v === "string" && cid.has(v) ? cid.get(v) : v;
  const out: Record<string, Obj> = {};
  for (const id of order) {
    const n = JSON.parse(JSON.stringify(nodes[id])) as Obj;
    n.id = cid.get(id);
    if (n.refs) n.refs = Object.fromEntries(Object.entries(n.refs as Record<string, string[]>).map(([k, v]) => [k, v.map(map)]));
    for (const f of ["sequence", "referenceImage", "companionOf"]) if (f in n) n[f] = map(n[f]);
    if (Array.isArray(n.items)) n.items = (n.items as Obj[]).map((it) => ({ ...it, node: map(it.node) }));
    if (Array.isArray(n.sequences)) n.sequences = (n.sequences as Obj[]).map((s) => ({ ...s, sequence: map(s.sequence), ...(s.proxy ? { proxy: map(s.proxy) } : {}) }));
    out[n.id as string] = n;
  }
  const { source: _s, v: _v, ...rest } = doc;
  return { ...rest, nodes: out };
}

const opts = { producer: "SlicerAlbula test", origin: "w1", name: "the cardiac scene", now: () => "2026-09-20T13:00:00Z", layout: { arrangement: 16, splits: { "16": 0.73 } } };

Deno.test("save → load → save: the same file, up to producedAt and v", async () => {
  const first = await writeScene(liveNodes(), opts);
  assertEquals(first.problems, []);
  const live = fakeLive(arrivedNodes());
  const layouts: number[] = [], offsets: [string, number][] = [];
  const report = applySceneState(live, first.doc, { setLayout: (a) => layouts.push(a), setSliceOffset: (c, mm) => offsets.push([c, mm]) });
  assertEquals(report.missing, []);
  assertEquals(layouts, [16]);
  assertEquals(offsets, [["Red", 288.7]]);
  // What the loader could not know is back: the frame, the camera, the look.
  const browser = [...live.nodes.values()].find((n) => n.type === "sequenceBrowser")!;
  assertEquals(browser.selectedItemNumber, 1);
  assertEquals([...live.nodes.values()].find((n) => n.type === "camera")!.position, [0, -500, 0]);
  assertEquals([...live.nodes.values()].find((n) => n.type === "view" && n.kind === "3d")!.lighting, "Glossy");
  const second = await writeScene([...live.nodes.values()], { ...opts, previousV: 1, now: () => "2026-09-20T14:00:00Z" });
  assertEquals(second.problems, []);
  assertEquals(second.refused, []);
  assertEquals(canonical(second.doc), canonical(first.doc));
});

// THE FOLDED BRANCHES ARE PART OF THE PICTURE. A branch folded in the Segmentations tree paints as
// one color in the views (`mergedGroups`), and the restore left that field out -- so a scene saved
// with the ribs folded came back with 24 rib colors. Ron, 2026-09-22: "The scene does not fully
// recover the segmentations settings that I had at save time."
Deno.test("a scene saved with folded branches comes back folded", async () => {
  const nodes = liveNodes().map((n) => n.type === "segmentation" ? { ...n, mergedGroups: [{ labels: [1, 2], color: [0.4, 0.4, 0.4] }] } : n);
  const first = await writeScene(nodes, opts);
  const saved = Object.values(first.doc.nodes as Record<string, Obj>).find((n) => n.type === "segmentation")!;
  assertEquals((saved.mergedGroups as unknown[]).length, 1, "the file carries the folded branch");
  const live = fakeLive(arrivedNodes());                       // arrives with none, as a fresh load does
  applySceneState(live, first.doc);
  const back = [...live.nodes.values()].find((n) => n.type === "segmentation")!;
  assertEquals((back as unknown as { mergedGroups?: unknown[] }).mergedGroups?.length, 1);
});

// THE 3D LOOK AND THE SURFACE MODELS ARE SAVED CHOICES. The restore patched neither, so every scene came
// back Colored and without its surface models, and so did the automatic Reload (critic, 2026-09-24,
// finding 2).
Deno.test("a scene saved with a 3D look and surface models comes back with both", async () => {
  const nodes = liveNodes().map((n) =>
    n.type === "segmentation" ? { ...n, surfaceModels: true } : n.type === "image" ? { ...n, look3D: "surfaces" } : n);
  const first = await writeScene(nodes, opts);
  const live = fakeLive(arrivedNodes());                       // arrives without either, as a fresh load does
  applySceneState(live, first.doc);
  const seg = [...live.nodes.values()].find((n) => n.type === "segmentation")!;
  assertEquals((seg as unknown as { surfaceModels?: boolean }).surfaceModels, true);
  const imgs = [...live.nodes.values()].filter((n) => n.type === "image");
  assertEquals(imgs.every((n) => (n as unknown as { look3D?: string }).look3D === "surfaces"), true);
});

Deno.test("what has no live counterpart is listed, not silently skipped", async () => {
  const first = await writeScene(liveNodes(), opts);
  const live = fakeLive(arrivedNodes().filter((n) => n.type !== "segmentation"));
  const report = applySceneState(live, first.doc);
  assertEquals(report.missing, ["chambers"]);
});

// Ron, 2026-09-24: a scene saved with the coronal slice shown in 3D came back without it -- the restore never
// put visibleIn3D back. It is asked for through the hook, and only when the view differs.
Deno.test("a slice view saved as shown in 3D is shown in 3D again", async () => {
  const nodes = liveNodes().map((n) => n.type === "view" && n.kind === "slice" && n.layoutName === "Red" ? { ...n, visibleIn3D: true } : n);
  const first = await writeScene(nodes, opts);
  const live = fakeLive(arrivedNodes());
  const shown = new Set<string>(), asked: string[] = [];
  const hooks = { setSliceIn3D: (c: string, on: boolean) => { asked.push(`${c} ${on}`); if (on) shown.add(c); else shown.delete(c); }, sliceIn3D: () => [...shown] };
  const report = applySceneState(live, first.doc, hooks);
  assertEquals(asked, ["Red true"]);
  assertEquals(report.applied.includes("Red slice shown in 3D"), true);
  applySceneState(live, first.doc, hooks);                     // the next pass: already so, nothing asked
  assertEquals(asked, ["Red true"]);
});
