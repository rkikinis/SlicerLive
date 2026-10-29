import { assert, assertEquals } from "jsr:@std/assert";
import { writeScene } from "./write.ts";
import { liveNodes } from "./fixture.ts";
import { ENVELOPE_NODE_ID, mrcomToScene, nodesToScene, referencedSeries, sceneToMrcom, sceneToNodes } from "./mrcom-scene.ts";
import { readMrcomBundle } from "../mrcom/read.ts";
import { errorsOnly, validateMrcomManifest, validateScene } from "../../mrson/validate.ts";

const opts = { producer: "SlicerAlbula test", origin: "w1", name: "the cardiac scene", now: () => "2026-10-29T12:00:00Z", layout: { arrangement: 16 } };
const reference = { PatientName: "Test^Person", PatientID: "T1", StudyInstanceUID: "1.2.3", StudyDate: "20261029", SOPClassUID: "1.2.840.10008.5.1.4.1.1.2", SOPInstanceUID: "1.2.3.4.0.1" };
const withExtension = async () => {
  const doc = (await writeScene(liveNodes(), { ...opts, extensions: { extensions: { "albula-diffusion": { v: 1, state: { scans: [{ series: "9.9", tracts: "9.9.1" }] } } }, used: ["albula-diffusion/1"] } })).doc;
  return { ...doc, uid: "2.25.1" } as Record<string, unknown>;
};

Deno.test("a scene file goes into MRCOM and comes back as the same text, its own fields and the extensions' state included", async () => {
  const doc = await withExtension();
  const w = await sceneToMrcom(doc, reference, "test", { "1.2.3.4": "1.2.840.10008.5.1.4.1.1.2" });
  assertEquals(w.mode, "reference");
  assertEquals(w.studyInstanceUID, "1.2.3", "the scene's own study");
  const back = await mrcomToScene(w.bytes);
  assertEquals(JSON.stringify(back), JSON.stringify(doc));
});

Deno.test("Steve's reader and validators accept the bundle; the envelope is one node his validator only notes", async () => {
  const doc = await withExtension();
  const w = await sceneToMrcom(doc, reference, "test", { "1.2.3.4": "1.2.840.10008.5.1.4.1.1.2" });
  const b = await readMrcomBundle(w.bytes, { verify: true });
  assertEquals(errorsOnly(validateMrcomManifest(b.manifest)), []);
  assertEquals(errorsOnly(validateScene({ mrson: 0, nodes: b.nodes })), []);
  assert(b.nodes[ENVELOPE_NODE_ID], "the envelope travels as a node");
});

Deno.test("every referenced series carries its SOP class when one is known", async () => {
  const doc = await withExtension();
  const w = await sceneToMrcom(doc, reference, "test", { "1.2.3.4": "1.2.840.10008.5.1.4.1.1.2" });
  const refs = (w.manifest as unknown as { sources?: { sopClassUID?: string; seriesInstanceUID?: string }[] }).sources ?? [];
  for (const r of refs) if (r.seriesInstanceUID) assert(r.sopClassUID, `series ${r.seriesInstanceUID} has a class`);
});

Deno.test("nodes without the envelope are not an Albula scene; a scene with a node of the envelope's id is refused", () => {
  assertEquals(nodesToScene({}), undefined);
  let threw = false;
  try { sceneToNodes({ nodes: { [ENVELOPE_NODE_ID]: { id: ENVELOPE_NODE_ID, type: "x" } } }); } catch { threw = true; }
  assert(threw);
});

Deno.test("a series holding several volumes is referenced with every instance the scene names (the critic, 2026-10-29, finding 1)", async () => {
  const doc = await withExtension();
  const refs = referencedSeries(doc);
  const ct = refs.find((r) => r.seriesInstanceUID === "1.2.3.4")!;
  assertEquals(ct.instances, ["1.2.3.4.0.1", "1.2.3.4.0.2", "1.2.3.4.1.1", "1.2.3.4.1.2"], "both frames' instances, in the scene's order");
  assertEquals(refs[0].seriesInstanceUID, "1.2.3.4", "the first scan is the primary parent");
});
