import { assert, assertEquals } from "jsr:@std/assert";
import { deleteScene, importScene, listScenes, packageScene, putScene, readScene } from "./scenes.ts";
import { PROFILE_ID } from "../logic/scene/profile.ts";

const doc = (v: number, name = "a scene") => ({
  mrson: 0, extensionsUsed: [PROFILE_ID], v, name,
  source: { producer: "test build", producedAt: `2026-09-20T13:0${v}:00Z`, origin: "w1" },
  study: { studyInstanceUID: "1.2.3" },
  nodes: { n1: { id: "n1", type: "camera", position: [0, -500, 0], focalPoint: [0, 0, 0], viewUp: [0, 0, 1] } },
});

Deno.test("a scene is written, listed, read back, versioned and removed", async () => {
  const root = await Deno.makeTempDir();
  const dbDir = `${root}/db`; await Deno.mkdir(dbDir);
  const first = await putScene(dbDir, "new", doc(1));
  assert(!("error" in first), JSON.stringify(first));
  assert(/^2\.25\.\d+$/.test(first.uid));
  const rows = await listScenes(dbDir);
  assertEquals(rows.length, 1); assertEquals(rows[0].name, "a scene"); assertEquals(rows[0].v, 1); assertEquals(rows[0].study, "1.2.3");
  const back = await readScene(dbDir, first.uid) as { v: number };
  assertEquals(back.v, 1);
  // the next save must be v 2
  const stale = await putScene(dbDir, first.uid, doc(1));
  assert("error" in stale && stale.status === 409, "a save behind the row is refused");
  const second = await putScene(dbDir, first.uid, doc(2, "renamed"));
  assert(!("error" in second));
  assertEquals((await listScenes(dbDir))[0].name, "renamed");
  // a bad document is refused by the checker
  const bad = await putScene(dbDir, "new", { mrson: 0, nodes: {} } as Record<string, unknown>);
  assert("error" in bad && bad.status === 400 && Array.isArray(bad.problems));
  assert(await deleteScene(dbDir, first.uid));
  assertEquals(await listScenes(dbDir), []);
  assertEquals(await readScene(dbDir, first.uid), null);
});

/** A scene that names one series, with a tiny DICOM index holding that series and its surfaces child. */
Deno.test("the transport folder: package on one side, import on the other", async () => {
  const root = await Deno.makeTempDir();
  const dbDir = `${root}/db`; await Deno.mkdir(`${dbDir}/dicom/s1`, { recursive: true }); await Deno.mkdir(`${dbDir}/dicom/s2`, { recursive: true });
  await Deno.writeTextFile(`${dbDir}/dicom/s1/a.dcm`, "AAAA"); await Deno.writeTextFile(`${dbDir}/dicom/s1/b.dcm`, "BBBBBB"); await Deno.writeTextFile(`${dbDir}/dicom/s2/c.dcm`, "CC");
  const sql = (db: string, text: string) => new Deno.Command("sqlite3", { args: [db], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const run = async (db: string, text: string) => { const p = sql(db, text); const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(text)); await w.close(); const o = await p.output(); assert(o.success, new TextDecoder().decode(o.stderr)); return new TextDecoder().decode(o.stdout); };
  await run(`${dbDir}/ctkDICOM.sql`, `CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY); CREATE TABLE Images (SOPInstanceUID TEXT, Filename TEXT, SeriesInstanceUID TEXT);
    INSERT INTO Series VALUES ('1.2.3.4'); INSERT INTO Series VALUES ('1.2.3.5');
    INSERT INTO Images VALUES ('i1','dicom/s1/a.dcm','1.2.3.4'); INSERT INTO Images VALUES ('i2','dicom/s1/b.dcm','1.2.3.4'); INSERT INTO Images VALUES ('i3','dicom/s2/c.dcm','1.2.3.5');`);
  await run(`${root}/provenance.sqlite`, `CREATE TABLE ProvenanceEdges (id INTEGER PRIMARY KEY, child_series_uid TEXT NOT NULL, parent_series_uid TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, author TEXT, created_at TEXT NOT NULL);
    CREATE TABLE SeriesAttributes (SeriesInstanceUID TEXT NOT NULL, Key TEXT NOT NULL, Value TEXT NOT NULL, Source TEXT NOT NULL, Recorded TEXT NOT NULL, PRIMARY KEY (SeriesInstanceUID, Key));
    INSERT INTO ProvenanceEdges (child_series_uid, parent_series_uid, kind, label, created_at) VALUES ('1.2.3.5','1.2.3.4','surface','surfaces','2026-09-20T10:00:00Z');
    INSERT INTO SeriesAttributes VALUES ('1.2.3.4','collection','cptac_ccrcc','idc','2026-09-20T10:00:00');`);
  const scene = { ...doc(1, "one series"), nodes: { n1: { id: "n1", type: "segmentation", name: "seg", dicom: { seriesInstanceUID: "1.2.3.4" }, referenceImage: "n2", segments: [] }, n2: { id: "n2", type: "image", dims: [2, 2, 2], ijkToRAS: Array(16).fill(0), dicom: { seriesInstanceUID: "1.2.3.6", studyInstanceUID: "1.2.3", sopInstanceUIDs: ["1.2.3.6.1"], instanceCount: 1 } } } };
  const put = await putScene(dbDir, "new", scene);
  assert(!("error" in put), JSON.stringify(put));
  // package
  const dest = `${root}/out`; await Deno.mkdir(dest);
  const pk = await packageScene(dbDir, put.uid, dest);
  assert(!("error" in pk), JSON.stringify(pk));
  assertEquals(pk.path, `${dest}/one series.albula`);
  assertEquals([pk.series, pk.files, pk.bytes, pk.missing], [2, 3, 12, ["1.2.3.6"]]);   // the SEG and its surfaces; the volume's series is not in this index and is said so
  const names = []; for await (const e of Deno.readDir(pk.path)) names.push(e.name);
  assertEquals(names.sort(), ["README.txt", "dicom", "provenance.json", "scene.mrson.json"]);
  const prov = JSON.parse(await Deno.readTextFile(`${pk.path}/provenance.json`)) as { edges: unknown[]; attributes: unknown[]; scene: { uid: string } };
  assertEquals([prov.edges.length, prov.attributes.length, prov.scene.uid], [1, 1, put.uid]);
  assert((await Deno.stat(`${pk.path}/dicom/1.2.3.5/c.dcm`)).isFile);
  // a second package of the same scene gets its own folder
  assertEquals((await packageScene(dbDir, put.uid, dest) as { path: string }).path, `${dest}/one series 2.albula`);
  // import into another database: refused while the series is missing, then added with the provenance
  const other = `${root}/other/db`; await Deno.mkdir(other, { recursive: true });
  await run(`${other}/ctkDICOM.sql`, `CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY);`);
  // No provenance.sqlite at all on the other machine (it imported dicom/ with Slicer): the import makes the tables (critic, finding 3).
  const file = JSON.parse(await Deno.readTextFile(`${pk.path}/scene.mrson.json`)) as Record<string, unknown>;
  const refused = await importScene(other, { ...file, uid: prov.scene.uid }, prov as never);
  assert("error" in refused && refused.status === 409 && refused.missing?.length === 2, JSON.stringify(refused));
  await run(`${other}/ctkDICOM.sql`, `INSERT INTO Series VALUES ('1.2.3.4'); INSERT INTO Series VALUES ('1.2.3.6');`);
  const imp = await importScene(other, { ...file, uid: prov.scene.uid }, prov as never);
  assert(!("error" in imp), JSON.stringify(imp));
  assertEquals([imp.uid, imp.v, imp.edges, imp.attributes, imp.replaced], [put.uid, 1, 1, 1, false]);
  assertEquals((await listScenes(other)).map((r) => [r.uid, r.name, r.v]), [[put.uid, "one series", 1]]);
  // importing it again adds nothing and replaces nothing, and says it kept what it had
  const again = await importScene(other, { ...file, uid: prov.scene.uid }, prov as never);
  assert(!("error" in again)); assertEquals([again.edges, again.attributes, again.replaced, again.kept], [0, 0, false, true]);
  // the file alone (no provenance.json) is recognized by the uid the store wrote into it
  assertEquals(file.uid, put.uid);
  const alone = await importScene(other, file);
  assert(!("error" in alone)); assertEquals([alone.uid, alone.kept], [put.uid, true]);
  assertEquals((await listScenes(other)).length, 1);
  // the row's bytes are bytes, and it counts the series the file names
  const row = (await listScenes(other))[0];
  assertEquals(row.bytes, new TextEncoder().encode(await Deno.readTextFile(`${other}/SlicerAlbula-Scenes/${put.uid}.mrson.json`)).byteLength);
  assertEquals(row.series, 2);
});
