import { assert, assertEquals } from "jsr:@std/assert";
import { checkScene, seriesNamed } from "./check.ts";
import { PROFILE_ID, toStructureFile } from "./profile.ts";

const good = () => ({
  mrson: 0, extensionsUsed: [PROFILE_ID], v: 1, name: "test",
  source: { producer: "SlicerAlbula test", producedAt: "2026-09-20T13:00:00Z", origin: "w1" },
  study: { studyInstanceUID: "1.2.3" },
  nodes: {
    ct: { id: "ct", type: "image", dims: [4, 4, 2], ijkToRAS: Array(16).fill(0), dicom: { seriesInstanceUID: "1.2.3.4", sopInstanceUIDs: ["1.2.3.4.1", "1.2.3.4.2"] }, digest: "abc" },
    seg: { id: "seg", type: "segmentation", referenceImage: "ct", segments: [{ id: "s1", labelValue: 1, name: "Liver", color: [1, 0, 0, 1] }], dicom: { seriesInstanceUID: "2.25.9" } },
    cam: { id: "cam", type: "camera", position: [0, -500, 0], focalPoint: [0, 0, 0], viewUp: [0, 0, 1], viewAngle: 30 },
    v3: { id: "v3", type: "view", kind: "3d", refs: { camera: ["cam"] }, drawingLook: true },
    seq: { id: "seq", type: "sequence", items: [{ index: "1", node: "ct", time: 0 }] },
    br: { id: "br", type: "sequenceBrowser", sequences: [{ sequence: "seq", proxy: "ct", playback: true }], selectedItemNumber: 0 },
  },
});

Deno.test("a well-formed scene has no problems", () => { assertEquals(checkScene(good()), []); });

Deno.test("the checker names what is wrong, one line each", () => {
  const d = good() as Record<string, unknown>;
  const nodes = d.nodes as Record<string, Record<string, unknown>>;
  delete (d.source as Record<string, unknown>).producer;
  nodes.seg.referenceImage = "nowhere";
  nodes.v3.refs = { camera: ["gone"] };
  nodes.odd = { id: "odd", type: "stream" };
  nodes.cam.position = [1, 2];
  (nodes.seg.segments as Record<string, unknown>[])[0].id = undefined;
  (nodes.ct.dicom as Record<string, unknown>).sopInstanceUIDs = [];
  d.extensionsUsed = ["something-else/1"];
  const p = checkScene(d).map((x) => `${x.where}: ${x.what}`);
  for (const want of [
    "file: source.producer (the build that wrote it) is missing",
    "file: extensionsUsed does not name albula-scene/1",
    'node seg: referenceImage points at "nowhere", which is not in the file',
    'node v3: refs.camera points at "gone", which is not in the file',
    'node odd: type "stream" is not in the profile',
    "node cam: position is not a vec3",
    "node seg: segments[0] has no id (the core requires one)",
    "node ct: dicom.sopInstanceUIDs is empty: a frame of a sequence cannot be told from the others",
  ]) assert(p.includes(want), `expected: ${want}\ngot:\n${p.join("\n")}`);
});

Deno.test("the series a scene names are listed for the database check", () => {
  assertEquals(seriesNamed(good()).map((s) => s.uid).sort(), ["1.2.3.4", "2.25.9"]);
});

Deno.test("the structure file names every type the checker knows, and the envelope", () => {
  const f = toStructureFile() as { definitions: Record<string, unknown> };
  for (const t of ["ImageNode", "SequenceNode", "SequenceBrowserNode", "SliceCompositeNode", "CameraNode", "LayoutNode", "Scene", "AnyNode"]) assert(f.definitions[t], t);
});

Deno.test("an empty optional text is a value: a sequence whose index has no unit saves (a diffusion scan's volumes)", () => {
  const d = good() as Record<string, unknown>;
  const nodes = d.nodes as Record<string, Record<string, unknown>>;
  nodes.seq.indexUnit = "";
  nodes.seq.indexName = "";
  assertEquals(checkScene(d), []);
  nodes.seq.indexUnit = 3;                                   // not text at all: still caught
  assert(checkScene(d).some((x) => x.what === "indexUnit is not a string"));
});
