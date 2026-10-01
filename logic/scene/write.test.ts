import { assert, assertEquals } from "jsr:@std/assert";
import { writeScene } from "./write.ts";
import { liveNodes } from "./fixture.ts";
import type { MrsonNode } from "../../render/mrson.ts";

const opts = { producer: "SlicerAlbula test", origin: "w1", name: "the cardiac scene", now: () => "2026-09-20T13:00:00Z", layout: { arrangement: 16, splits: { "16": 0.73 } } };

Deno.test("the writer keeps what a person did and drops what the database recovers", async () => {
  const w = await writeScene(liveNodes(), opts);
  assertEquals(w.problems, [], "the written scene passes the checker");
  assertEquals(w.refused, []);
  const text = JSON.stringify(w.doc);
  assert(!text.includes("chunkHashes"), "no chunk hashes");
  assert(!text.includes("dataUrl"), "no pictures inlined");
  assert(!text.includes("Someone"), "no patient name");
  assert(!text.includes("autoWindowLevel") && !text.includes("playbackActive") && !text.includes("\"hidden\""), "no runtime flags");
  assert(!text.includes("local-image"), "no session-local ids");
  const nodes = w.doc.nodes as Record<string, Record<string, unknown>>;
  const images = Object.values(nodes).filter((n) => n.type === "image");
  assertEquals(images.length, 2);
  assert(images.every((n) => typeof n.digest === "string" && (n.digest as string).length === 64), "a digest per volume");
  assert(images.every((n) => (n.dicom as { sopInstanceUIDs: string[]; instanceCount: number; instancesDigest: string }).sopInstanceUIDs.length === 1), "one instance names the frame");
  assert(images.every((n) => (n.dicom as { instanceCount: number }).instanceCount === 2 && (n.dicom as { instancesDigest: string }).instancesDigest.length === 64), "the count and a digest name the exact set");
  assert(images.every((n) => n.name === undefined), "an image's name (it carries the patient's label) is not stored");
  assert(Object.values(nodes).every((n) => !["image", "scalarVolumeDisplay", "volumeRenderingDisplay", "sliceComposite", "sequence", "sequenceBrowser"].includes(n.type as string) || n.name === undefined), "no generated name is stored");
  const seg = Object.values(nodes).find((n) => n.type === "segmentation")!;
  assertEquals(seg.model, "ts:heartchambers_highres");
  assertEquals((seg.segments as { id: string; color: number[] }[])[0].id, "s1");
  assertEquals((seg.segments as { id: string; color: number[] }[])[0].color.length, 4, "RGBA");
  assert(typeof seg.referenceImage === "string" && nodes[seg.referenceImage as string].type === "image");
  const tf = Object.values(nodes).find((n) => n.type === "transferFunction")!;
  assertEquals(tf.shading, { ambient: 0.2, diffuse: 1, specular: 0.2, power: 20 });
  const vr = Object.values(nodes).find((n) => n.type === "volumeRenderingDisplay")!;
  assert((vr.refs as Record<string, string[]>).transferFunction, "the edge has Steve's name");
  const br = Object.values(nodes).find((n) => n.type === "sequenceBrowser")!;
  assertEquals(br.selectedItemNumber, 1, "the frame on screen is scene state");
  assert(Object.values(nodes).some((n) => n.type === "layout" && n.arrangement === 16));
  assert(!Object.values(nodes).some((n) => n.type === "interaction"));
  assertEquals((w.doc.study as { studyInstanceUID: string }).studyInstanceUID, "1.2.3");
  assertEquals(w.doc.v, 1);
  assert(text.length < 6000, `a few kilobytes: ${text.length}`);
});

Deno.test("what cannot be named durably is refused, by name and with the reason", async () => {
  const nodes = liveNodes();
  const seg = nodes.find((n) => n.type === "segmentation")!;
  (seg as Record<string, unknown>).edited = true;
  nodes.push({ type: "image", id: "local-image-9", name: "a crop", dims: [2, 2, 2], ijkToRAS: Array(16).fill(0), origin: { local: true } } as unknown as MrsonNode);
  const w = await writeScene(nodes, opts);
  assertEquals(w.refused.length, 2);
  assert(w.refused.some((r) => r.includes("a crop") && r.includes("save it to DICOM first")), w.refused.join(" | "));
  assert(w.refused.some((r) => r.includes("chambers") && r.includes("edited since it was saved")), w.refused.join(" | "));
  assertEquals(w.problems, [], "what remains is a valid scene");
});

Deno.test("two saves of the same scene differ only where the scene does", async () => {
  const a = await writeScene(liveNodes(), opts);
  const b = await writeScene(liveNodes(), { ...opts, previousV: 1, now: () => "2026-09-20T14:00:00Z" });
  const strip = (d: Record<string, unknown>) => JSON.stringify({ ...d, v: 0, source: { ...(d.source as object), producedAt: "" } });
  assertEquals(strip(a.doc), strip(b.doc));
  assertEquals(b.doc.v, 2);
});

Deno.test("nothing loaded is not a scene; another patient's series is refused by name; one patient's studies all go in (critic 2026-09-20, findings 7 and 8; Ron on ReMIND)", async () => {
  const empty = await writeScene(liveNodes().filter((n) => n.type === "camera" || n.type === "view"), opts);
  assert(empty.empty === true);
  const nodes = liveNodes();
  nodes.push({ type: "image", id: "local-image-8", name: "another patient's CT", dims: [2, 2, 2], ijkToRAS: Array(16).fill(0), origin: { seriesInstanceUID: "9.9.9.1", studyInstanceUID: "9.9.9", sopInstanceUIDs: ["9.9.9.1.1"], patientName: "Someone Else" } } as unknown as MrsonNode);
  nodes.push({ type: "image", id: "local-image-9", name: "the same patient's intra-op MRI", dims: [2, 2, 2], ijkToRAS: Array(16).fill(0), origin: { seriesInstanceUID: "1.2.4.1", studyInstanceUID: "1.2.4", sopInstanceUIDs: ["1.2.4.1.1"], patientName: "Someone" } } as unknown as MrsonNode);
  const w = await writeScene(nodes, opts);
  assertEquals(w.refused, ["another patient's CT: another patient's — a scene is one patient's"]);
  assertEquals((w.doc.study as { studyInstanceUID: string }).studyInstanceUID, "1.2.3");
  assertEquals(w.doc.studies, ["1.2.3", "1.2.4"]);
  // a transfer function nothing points at does not go into the file
  const tfs = Object.values(w.doc.nodes as Record<string, { type: string }>).filter((n) => n.type === "transferFunction");
  assertEquals(tfs.length, 1);
});
