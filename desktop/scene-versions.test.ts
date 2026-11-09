// A scene is a list of versions (scene-versions.ts; Ron, 2026-11-08): kept, listed, pruned one step behind, and what they
// use found. On a temporary folder shaped as a database's scenes; nothing of a real database is touched.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { carryVersions, changed, discardDraft, keepCurrentAsVersion, keepVersion, listVersions, putPicture, putWork, readDraft, readPicture, readVersion, SCENES_FOLDER, seriesInUse, usedByWords } from "./scene-versions.ts";

const UID = "2.25.123456789";
const doc = (v: number, at: string, series: string[]) => ({
  name: `scene v${v}`, v, source: { producedAt: at },
  nodes: Object.fromEntries(series.map((s, i) => [`n${i}`, { type: "image", dicom: { kind: "dicom-series", seriesInstanceUID: s } }])),
});

async function db(): Promise<string> {
  const d = await Deno.makeTempDir({ prefix: "scene-versions-" });
  await Deno.mkdir(`${d}/${SCENES_FOLDER}`);
  return d;
}
/** The scene's own file, as a save writes it (the newest version). */
const current = (d: string, x: Record<string, unknown>) => Deno.writeTextFile(`${d}/${SCENES_FOLDER}/${UID}.mrson.json`, JSON.stringify(x));

Deno.test("a scene from before versions keeps its file as its version on the next save", async () => {
  const d = await db();
  await current(d, doc(4, "2026-10-29T12:58:45Z", ["1.2.3"]));
  assertEquals((await listVersions(d, UID)).map((x) => x.v), [4], "its own file is its one version");
  await keepCurrentAsVersion(d, UID);
  await keepVersion(d, UID, doc(5, "2026-11-08T10:00:00Z", ["1.2.3", "1.2.4"]));
  assertEquals((await listVersions(d, UID)).map((x) => x.v), [4, 5]);
  assertEquals((await readVersion(d, UID, 4))?.name, "scene v4");
  await keepCurrentAsVersion(d, UID);
  assertEquals((await listVersions(d, UID)).length, 2, "kept once");
  await Deno.remove(d, { recursive: true });
});

Deno.test("the draft is the newest continuous state after the newest version, and states go one step behind", async () => {
  const d = await db();
  await current(d, doc(1, "2000-01-01T00:00:00Z", ["1.2.3"]));
  await keepVersion(d, UID, doc(1, "2000-01-01T00:00:00Z", ["1.2.3"]));
  assertEquals(await readDraft(d, UID), null);
  const w1 = await putWork(d, UID, doc(1, "", ["1.2.3", "1.2.9"]));
  assert("at" in w1);
  assertEquals((await readDraft(d, UID))?.at, w1.at);
  assertEquals(await putWork(d, UID, doc(1, "", ["1.2.3", "1.2.9"])), { skipped: "same" }, "the same state is not written twice");
  await keepVersion(d, UID, doc(2, new Date(Date.parse(w1.at) + 1000).toISOString(), ["1.2.3"]));
  assertEquals(await readDraft(d, UID), null);
  assertEquals([...(await seriesInUse(d)).keys()].sort(), ["1.2.3", "1.2.9"], "the work still names 1.2.9 (one step behind)");
  await keepVersion(d, UID, doc(3, new Date(Date.parse(w1.at) + 2000).toISOString(), ["1.2.3"]));
  assertEquals([...(await seriesInUse(d)).keys()], ["1.2.3"], "at the next save it goes");
  await Deno.remove(d, { recursive: true });
});

Deno.test("critic findings 1, 10, 11: no state for a scene that is gone; a stale state skipped; a draft can be discarded", async () => {
  const d = await db();
  await assertRejects(() => putWork(d, UID, doc(1, "", ["1.2.3"])), Error, "no such scene");
  // a folder left by a deleted scene is not a use
  await Deno.mkdir(`${d}/${SCENES_FOLDER}/${UID}.work`);
  await Deno.writeTextFile(`${d}/${SCENES_FOLDER}/${UID}.work/2026-11-08T10-00-00.000Z.mrson.json`, JSON.stringify(doc(1, "", ["9.9.9"])));
  changed(d);
  assertEquals((await seriesInUse(d)).size, 0);
  await current(d, doc(2, "2026-11-08T11:00:00.000Z", ["1.2.3"]));
  assertEquals(await putWork(d, UID, { ...doc(2, "", ["1.2.3", "1.2.5"]), capturedAt: "2026-11-08T10:59:59.000Z" }), { skipped: "stale" });
  const w = await putWork(d, UID, { ...doc(2, "", ["1.2.3", "1.2.5"]), capturedAt: new Date().toISOString() });
  assert("at" in w);
  assert(await readDraft(d, UID));
  assert(await discardDraft(d, UID) >= 1);
  assertEquals(await readDraft(d, UID), null);
  await Deno.remove(d, { recursive: true });
});

Deno.test("critic finding 14: an unreadable version refuses every delete rather than let its series go", async () => {
  const d = await db();
  await current(d, doc(1, "2026-11-01T00:00:00Z", ["1.2.3"]));
  await keepVersion(d, UID, doc(1, "2026-11-01T00:00:00Z", ["1.2.3"]));
  await Deno.writeTextFile(`${d}/${SCENES_FOLDER}/${UID}.versions/v0001.mrson.json`, "{ not json");
  changed(d);
  await assertRejects(() => seriesInUse(d), Error, "cannot be read");
  await Deno.remove(d, { recursive: true });
});

Deno.test("what uses a series is said by scene and version; a move carries the versions", async () => {
  const d = await db();
  await current(d, doc(4, "2026-11-02T00:00:00Z", ["1.2.3", "1.2.4"]));
  await keepVersion(d, UID, doc(3, "2026-11-01T00:00:00Z", ["1.2.3"]));
  await keepVersion(d, UID, doc(4, "2026-11-02T00:00:00Z", ["1.2.3", "1.2.4"]));
  const use = await seriesInUse(d);
  assertEquals(usedByWords(use.get("1.2.4")!), "the scene “scene v4” (version 4)");
  assertEquals(use.get("1.2.3")!.map((u) => u.v).sort(), [3, 4, 4], "versions 3 and 4, and the scene's own file");
  const e = await db();
  assertEquals(await carryVersions(d, UID, e, "2.25.987"), 2);
  assertEquals((await listVersions(e, "2.25.987")).map((x) => x.v), [3, 4]);
  await Deno.remove(d, { recursive: true }); await Deno.remove(e, { recursive: true });
});

Deno.test("a version's picture: kept beside it, only a JPEG, only for a version that exists, carried by a move", async () => {
  const d = await db();
  await current(d, doc(1, "2026-11-01T00:00:00Z", ["1.2.3"]));
  await keepVersion(d, UID, doc(1, "2026-11-01T00:00:00Z", ["1.2.3"]));
  await keepVersion(d, UID, doc(2, "2026-11-02T00:00:00Z", ["1.2.3"]));
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assertEquals(await putPicture(d, UID, 9, jpeg), { error: "no such version", status: 404 });
  assertEquals((await putPicture(d, UID, 2, new Uint8Array([0x89, 0x50, 0x4e, 0x47])) as { status: number }).status, 400, "not a JPEG");
  assertEquals(await putPicture(d, UID, 2, jpeg), { ok: true });
  assertEquals([...(await readPicture(d, UID))!], [...jpeg], "the newest version's");
  assertEquals(await readPicture(d, UID, 1), null);
  assertEquals((await listVersions(d, UID)).map((x) => x.picture), [false, true]);
  const e = await db();
  await carryVersions(d, UID, e, "2.25.987");
  assertEquals([...(await readPicture(e, "2.25.987", 2))!], [...jpeg]);
  await Deno.remove(d, { recursive: true }); await Deno.remove(e, { recursive: true });
});
