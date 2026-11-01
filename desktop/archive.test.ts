// The archive's guard and the Trash (desktop/archive.ts), on a real database made the way Albula makes one: a file the
// archive lists is never removed and a refusal changes nothing; everything else removed goes to the Trash (here the
// fallback folder beside the database, because tests' databases sit in the temporary folder); a list that cannot be
// read stops a removal rather than letting it through.
//
//   deno test -A --no-check desktop/archive.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { runScript } from "./sqlite.ts";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const dcmjs = (await import("../logic/dcmjs.ts")).default;
(await import("../logic/readers/dicom-series.ts")).setDcmjs(dcmjs);
const { makeCtSeries } = await import("../logic/test-dicom.ts");
const { createDatabase } = await import("./db-create.ts");
const { filesUnder, importFiles } = await import("./db-import.ts");
const { deleteSeriesFromDatabase, auditDatabase } = await import("./db-index.ts");
const { putScene, deleteScene } = await import("./scenes.ts");
const { ArchiveRefusal, archivedPaths, manifestPath, FALLBACK_TRASH, ARCHIVE_FOLDER } = await import("./archive.ts");
const { handleDbRequest } = await import("./db-serve.ts");
const { resolveSettingsPath, writeSettings } = await import("./settings-file.ts");
const { transferSeries, removeTransferred } = await import("./db-transfer.ts");
const { seriesFilePaths } = await import("./series-files.ts");
const { PROFILE_ID } = await import("../logic/scene/profile.ts");

const sql = (file: string, q: string) => runScript(file, q, { readonly: true }).trim();
const exists = (p: string) => Deno.lstat(p).then(() => true, () => false);

const src = await Deno.makeTempDir({ prefix: "albula-archive-" });
const db = `${src}/Archive DB`;
await createDatabase(db, { name: "Archive" });
const index = `${db}/ctkDICOM.sql`;
async function addCt(tag: string) {
  const ct = await makeCtSeries(4, 4, 3, { extra: { PatientID: "PUB-1", PatientName: "PUBLIC^ONE", SeriesDescription: tag } });
  await Deno.mkdir(`${src}/${tag}`);
  for (const [i, x] of ct.instances.entries()) await Deno.writeFile(`${src}/${tag}/IM${i}`, new Uint8Array(x));
  assertEquals((await importFiles(db, (await filesUnder(`${src}/${tag}`)).files)).series.length, 1);
  const files = sql(index, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' ORDER BY Filename;`).split("\n");
  return { ct, files };
}
async function list(entries: Record<string, unknown>[]) {
  await Deno.mkdir(`${db}/${ARCHIVE_FOLDER}`, { recursive: true });
  await Deno.writeTextFile(manifestPath(db), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { append: true });
}

Deno.test("the list is replayed: an add lists a file, a later remove takes it off; no list is an empty one", async () => {
  assertEquals((await archivedPaths(`${src}/nowhere`)).size, 0);
  const d = await Deno.makeTempDir({ prefix: "albula-archive-list-" });
  await Deno.mkdir(`${d}/${ARCHIVE_FOLDER}`);
  await Deno.writeTextFile(manifestPath(d), [{ op: "add", path: "a" }, { op: "add", path: "b" }, { op: "remove", path: "a" }].map((e) => JSON.stringify(e)).join("\n"));
  assertEquals([...await archivedPaths(d)], ["b"]);
});

Deno.test("a series whose file the archive lists is not deleted, and nothing changes", async () => {
  const { ct, files } = await addCt("original");
  await list([{ op: "add", path: files[1], kind: "received", added: "2026-10-29" }]);
  const before = sql(index, "SELECT COUNT(*) FROM Images;");
  const e = await assertRejects(() => deleteSeriesFromDatabase(db, ct.seriesInstanceUID), ArchiveRefusal);
  assert(/archive/.test(e.message) && /Nothing was removed/.test(e.message), e.message);
  assertEquals(sql(index, "SELECT COUNT(*) FROM Images;"), before, "the index is as it was");
  for (const f of files) assert(await exists(`${db}/${f}`), `still there: ${f}`);
  assert(!(await exists(`${src}/${FALLBACK_TRASH}`)), "nothing went to the Trash");
});

Deno.test("a series the archive does not list goes to the Trash, not away", async () => {
  const { ct, files } = await addCt("derived");
  const r = await deleteSeriesFromDatabase(db, ct.seriesInstanceUID);
  assertEquals(r.files.sort(), [...files].sort());
  for (const f of files) assert(!(await exists(`${db}/${f}`)), `gone from the database: ${f}`);
  // Beside the database (not in it, where the audit would call them orphans), under the database's name.
  const trash = `${src}/${FALLBACK_TRASH}`;
  let found = 0;
  const walk = async (d: string) => { for await (const e of Deno.readDir(d)) { if (e.isDirectory) await walk(`${d}/${e.name}`); else found++; } };
  await walk(trash);
  assertEquals(found, files.length, "every file is in the Trash");
  const a = await auditDatabase(db);
  assert(a.ok, `no zombies, no orphans: ${JSON.stringify({ z: a.zombies, o: a.orphans })}`);
});

Deno.test("a list that cannot be read stops the removal", async () => {
  const { ct, files } = await addCt("unreadable");
  await Deno.writeTextFile(manifestPath(db), "not json\n", { append: true });
  await assertRejects(() => deleteSeriesFromDatabase(db, ct.seriesInstanceUID), Error, "cannot be read");
  for (const f of files) assert(await exists(`${db}/${f}`));
  // Put the list right again for the next test: only the good lines.
  const good = (await Deno.readTextFile(manifestPath(db))).split("\n").filter((l) => l.startsWith("{")).join("\n") + "\n";
  await Deno.writeTextFile(manifestPath(db), good);
});

Deno.test("a scene: refused when the archive lists it, to the Trash when not", async () => {
  const { ct, files } = await addCt("for scenes");
  const sops = sql(index, `SELECT SOPInstanceUID FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' ORDER BY SOPInstanceUID;`).split("\n");
  const doc = (name: string) => ({ mrson: 0, extensionsUsed: [PROFILE_ID], source: { producer: "SlicerAlbula test", producedAt: "2026-10-29T12:00:00Z", origin: "w1" }, v: 1, name,
    study: { studyInstanceUID: ct.studyInstanceUID }, studies: [ct.studyInstanceUID],
    nodes: { n1: { id: "n1", type: "image", dims: [4, 4, 3], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], dicom: { kind: "dicom-series", seriesInstanceUID: ct.seriesInstanceUID, studyInstanceUID: ct.studyInstanceUID, instances: sops, instanceCount: sops.length } } } });
  const kept = await putScene(db, "new", doc("Kept")) as { uid: string };
  const loose = await putScene(db, "new", doc("Loose")) as { uid: string };
  await list([{ op: "add", path: `SlicerAlbula-Scenes/${kept.uid}.mrson.json`, kind: "scene" }]);
  await assertRejects(() => deleteScene(db, kept.uid), ArchiveRefusal);
  assert(await exists(`${db}/SlicerAlbula-Scenes/${kept.uid}.mrson.json`));
  assert(await deleteScene(db, loose.uid));
  assert(!(await exists(`${db}/SlicerAlbula-Scenes/${loose.uid}.mrson.json`)));
  assert(files.length > 0);
});

Deno.test("the list is strict: an entry it cannot read stops the guard rather than passing", async () => {
  for (const bad of [`{"op":"Add","path":"x"}`, `{"path":"x"}`, `{"op":"add","file":"x"}`, `[1,2]`]) {
    const d = await Deno.makeTempDir({ prefix: "albula-archive-bad-" });
    await Deno.mkdir(`${d}/${ARCHIVE_FOLDER}`);
    await Deno.writeTextFile(manifestPath(d), bad + "\n");
    await assertRejects(() => archivedPaths(d), Error, "cannot be read", bad);
  }
  // Paths compare as the index writes them: "./a//b" and an absolute path under the database are "a/b".
  const d = await Deno.makeTempDir({ prefix: "albula-archive-norm-" });
  await Deno.mkdir(`${d}/${ARCHIVE_FOLDER}`);
  await Deno.writeTextFile(manifestPath(d), [{ op: "add", path: "./a//b" }, { op: "add", path: `${d}/c/d` }].map((e) => JSON.stringify(e)).join("\n"));
  assertEquals([...await archivedPaths(d)].sort(), ["a/b", "c/d"]);
});

// The server's routes, with this database registered the way Albula registers one.
const gallery = `${src}/gallery/src/live`;
await Deno.mkdir(gallery, { recursive: true });
await writeSettings(resolveSettingsPath(gallery), `[Database]\nadb=${db}\ncurrent=adb\n`);
const route = (path: string, init?: RequestInit) => handleDbRequest(new Request(`http://x${path}`, init), gallery);

Deno.test("the write route never removes an archived or an indexed file (the critic's finding 1)", async () => {
  // Its own unindexed write it may take back.
  assertEquals((await route("/_db/adb/_write/mine.dcm", { method: "POST", body: new Uint8Array([1, 2, 3]) }))!.status, 200);
  assertEquals((await route("/_db/adb/_write/mine.dcm", { method: "DELETE" }))!.status, 200);
  assert(!(await exists(`${db}/SlicerAlbula-SEG/mine.dcm`)));
  // A listed one: neither removed nor written over.
  await Deno.mkdir(`${db}/SlicerAlbula-SEG`, { recursive: true });
  await Deno.writeFile(`${db}/SlicerAlbula-SEG/kept.dcm`, new Uint8Array([9]));
  await list([{ op: "add", path: "SlicerAlbula-SEG/kept.dcm", kind: "person" }]);
  assertEquals((await route("/_db/adb/_write/kept.dcm", { method: "DELETE" }))!.status, 409);
  assertEquals((await route("/_db/adb/_write/kept.dcm", { method: "POST", body: new Uint8Array([7, 7]) }))!.status, 409);
  assertEquals([...await Deno.readFile(`${db}/SlicerAlbula-SEG/kept.dcm`)], [9]);
  // An indexed one (a series' file): Delete is the way, not this route.
  const { files } = await addCt("indexed for the route");
  const name = files[0].split("/").pop()!;
  const sub = files[0].split("/")[0];
  if (sub === "SlicerAlbula-SEG") assertEquals((await route(`/_db/adb/_write/${name}`, { method: "DELETE" }))!.status, 409);
  assert(await exists(`${db}/${files[0]}`));
});

const sceneDoc = (ct: { seriesInstanceUID: string; studyInstanceUID: string }, sops: string[], name: string, v = 1) => ({ mrson: 0, extensionsUsed: [PROFILE_ID], source: { producer: "SlicerAlbula test", producedAt: "2026-10-29T12:00:00Z", origin: "w1" }, v, name,
  study: { studyInstanceUID: ct.studyInstanceUID }, studies: [ct.studyInstanceUID],
  nodes: { n1: { id: "n1", type: "image", dims: [4, 4, 3], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], dicom: { kind: "dicom-series", seriesInstanceUID: ct.seriesInstanceUID, studyInstanceUID: ct.studyInstanceUID, instances: sops, instanceCount: sops.length } } } });
const objectOf = (sceneUid: string) => sql(provenancePathFor(db), `SELECT SeriesInstanceUID FROM SeriesAttributes WHERE Key='sceneUID' AND Value='${sceneUid}';`);
const { provenancePathFor } = await import("./db-index.ts");

Deno.test("a scene whose DICOM object is listed: its delete is refused whole; its save replaces the object and lists the new one (findings 2 and 3)", async () => {
  const { ct } = await addCt("for the scene object");
  const sops = sql(index, `SELECT SOPInstanceUID FROM Images WHERE SeriesInstanceUID='${ct.seriesInstanceUID}' ORDER BY SOPInstanceUID;`).split("\n");
  const s = await putScene(db, "new", sceneDoc(ct, sops, "First")) as { uid: string };
  const obj1 = objectOf(s.uid);
  assert(obj1, "it has its object");
  const objFiles = (await seriesFilePaths(db, obj1)).map((f) => f.slice(db.length + 1));
  await list(objFiles.map((path) => ({ op: "add", path, kind: "scene" })));
  // Delete: refused, and nothing went (the scene file, its row, its object).
  await assertRejects(() => deleteScene(db, s.uid), ArchiveRefusal);
  assert(await exists(`${db}/SlicerAlbula-Scenes/${s.uid}.mrson.json`));
  assertEquals(objectOf(s.uid), obj1);
  // Save again: the object is replaced, and the archive lists the new one instead of the old.
  const again = await putScene(db, s.uid, sceneDoc(ct, sops, "Second", 2)) as { uid: string; dicom?: { error?: string } };
  assertEquals(again.dicom?.error, undefined);
  const obj2 = objectOf(s.uid);
  assert(obj2 && obj2 !== obj1, `a new object: ${JSON.stringify({ obj1, obj2, again })}`);
  const listed = await archivedPaths(db);
  for (const f of objFiles) assert(!listed.has(f), "the old object is off the list");
  for (const f of (await seriesFilePaths(db, obj2)).map((x) => x.slice(db.length + 1))) assert(listed.has(f), "the new object is on it");
});

Deno.test("a move: a listed scan stays where it is and is named; the others move (finding 4)", async () => {
  const parent = await Deno.makeTempDir({ prefix: "albula-archive-move-" });
  const a = `${parent}/From`, b = `${parent}/To`;
  await createDatabase(a, { name: "From" }); await createDatabase(b, { name: "To" });
  const uids: string[] = [];
  for (const tag of ["keep me", "move me"]) {
    const ct = await makeCtSeries(4, 4, 2, { extra: { PatientID: "PUB-2", PatientName: "PUBLIC^TWO", SeriesDescription: tag } });
    const dir = await Deno.makeTempDir({ prefix: "albula-stick-" });
    for (const [i, x] of ct.instances.entries()) await Deno.writeFile(`${dir}/IM${i}`, new Uint8Array(x));
    await importFiles(a, (await filesUnder(dir)).files);
    uids.push(ct.seriesInstanceUID);
  }
  const keepFiles = sql(`${a}/ctkDICOM.sql`, `SELECT Filename FROM Images WHERE SeriesInstanceUID='${uids[0]}';`).split("\n");
  await Deno.mkdir(`${a}/${ARCHIVE_FOLDER}`, { recursive: true });
  await Deno.writeTextFile(manifestPath(a), JSON.stringify({ op: "add", path: keepFiles[0], kind: "received" }) + "\n", { append: true });
  const side = (id: string, path: string) => ({ id, path, name: id });
  const r = await transferSeries(side("From", a), side("To", b), uids, { move: true });
  const gone = await removeTransferred(side("From", a), side("To", b), r);
  assertEquals(gone.series, 1, "the other one moved");
  assertEquals(gone.kept.map((k) => k.uid), [uids[0]]);
  assert(/archive/.test(gone.kept[0].reason), gone.kept[0].reason);
  assertEquals(sql(`${a}/ctkDICOM.sql`, `SELECT COUNT(*) FROM Series WHERE SeriesInstanceUID='${uids[0]}';`), "1");
});

Deno.test("a record (the tract review's verdicts): listed at its first save; its next save puts the old version in the Trash; it cannot be deleted", async () => {
  const { listRecordFiles } = await import("./archive.ts");
  const rel = "SlicerAlbula-SEG/tract-review.json";
  assertEquals((await route("/_db/adb/_write/tract-review.json", { method: "POST", body: '{"v":1}' }))!.status, 200);
  assert((await archivedPaths(db)).has(rel), "listed at its first save");
  assertEquals(await listRecordFiles(db), [], "listed once, not twice");
  assertEquals((await route("/_db/adb/_write/tract-review.json", { method: "POST", body: '{"v":2}' }))!.status, 200);
  assertEquals(await Deno.readTextFile(`${db}/${rel}`), '{"v":2}');
  // The version it replaced is in the Trash (here the folder beside the database), dated.
  const found: string[] = [];
  const walk = async (d: string) => { for await (const e of Deno.readDir(d)) { if (e.isDirectory) await walk(`${d}/${e.name}`); else if (e.name.startsWith("tract-review (replaced ")) found.push(`${d}/${e.name}`); } };
  await walk(`${src}/${FALLBACK_TRASH}`);
  assertEquals(found.length, 1);
  assertEquals(await Deno.readTextFile(found[0]), '{"v":1}');
  assertEquals((await route("/_db/adb/_write/tract-review.json", { method: "DELETE" }))!.status, 409, "the route cannot delete it");
  assert(await exists(`${db}/${rel}`));
});

Deno.test("records: saves at the same moment all land, each old version in the Trash; an index header is refused; an unreadable list stops no new file (record findings 1-3)", async () => {
  const rel = "SlicerAlbula-SEG/tract-review.json";
  const before = await Deno.readTextFile(`${db}/${rel}`);
  const rs = await Promise.all([3, 4, 5, 6].map((v) => route("/_db/adb/_write/tract-review.json", { method: "POST", body: `{"v":${v}}` })));
  assertEquals(rs.map((r) => r!.status), [200, 200, 200, 200]);
  assertEquals(await Deno.readTextFile(`${db}/${rel}`), '{"v":6}', "the last save is the file");
  const copies: string[] = [];
  const walk = async (d: string) => { for await (const e of Deno.readDir(d)) { if (e.isDirectory) await walk(`${d}/${e.name}`); else if (e.name.startsWith("tract-review (replaced ")) copies.push(await Deno.readTextFile(`${d}/${e.name}`)); } };
  await walk(`${src}/${FALLBACK_TRASH}`);
  for (const v of [before, '{"v":3}', '{"v":4}', '{"v":5}']) assert(copies.includes(v), `the version ${v} is in the Trash`);
  // A record is never indexed: a save that says otherwise is refused and the record stays.
  assertEquals((await route("/_db/adb/_write/tract-review.json", { method: "POST", body: "{}", headers: { "x-albula-index": "not json" } }))!.status, 400);
  assertEquals(await Deno.readTextFile(`${db}/${rel}`), '{"v":6}');
  // An unreadable list: a new file is still written; an existing one is not touched.
  const good = await Deno.readTextFile(manifestPath(db));
  await Deno.writeTextFile(manifestPath(db), "not json\n", { append: true });
  assertEquals((await route("/_db/adb/_write/new-one.dcm", { method: "POST", body: new Uint8Array([1]) }))!.status, 200);
  assertEquals((await route("/_db/adb/_write/new-one.dcm", { method: "DELETE" }))!.status, 409);
  await Deno.writeTextFile(manifestPath(db), good);
});

Deno.test("the database's description: Describe puts the version it replaces in the Trash and lists the file (record finding 4)", async () => {
  const { writeDescription, readDescription } = await import("./db-create.ts");
  const d0 = await readDescription(db);
  await writeDescription(db, { ...d0, name: "Archive, renamed" } as Parameters<typeof writeDescription>[1]);
  assert((await archivedPaths(db)).has("albula-database.json"));
  const names: string[] = [];
  const walk = async (d: string) => { for await (const e of Deno.readDir(d)) { if (e.isDirectory) await walk(`${d}/${e.name}`); else names.push(e.name); } };
  await walk(`${src}/${FALLBACK_TRASH}`);
  assert(names.some((n) => n.startsWith("albula-database (replaced ")), "the old description is in the Trash");
});
