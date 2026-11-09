// THE SCENE STORE (SCENE-DESIGN-2026-09-20.md §6): a scene is a file beside the database,
// `SlicerAlbula-Scenes/<uid>.mrson.json`, and a row in the provenance store's `Scenes` table --
// the browser lists it under its study from the row, the loader reads the file. Not a DICOM
// object (Ron: "apply the KISS principle"), so nothing in ctkDICOM.sql.
//
//   GET    /_db/<id>/_scenes            every scene: uid, study, name, producer, producedAt, v, bytes
//   GET    /_db/<id>/_scene/<uid>       the document
//   PUT    /_db/<id>/_scene/<uid>       write one (the body is the document; checked first);
//                                       a new uid is minted when <uid> is "new"; a `v` behind the
//                                       row's is refused with 409 (two windows on one study)
//   DELETE /_db/<id>/_scene/<uid>       the file and the row -- the person's command, never ours
//   POST   /_db/<id>/_scene/<uid>/_package   the transport folder (§7): `<name>.albula/` in the
//                                       pictures folder -- the scene file, every DICOM file it
//                                       names (the series, the SEGs, their surfaces, the ECG
//                                       pictures), the provenance rows, a README; copies, never moves
//   POST   /_db/<id>/_scene/_import     the other end: the body is `{ scene, provenance }` read
//                                       from such a folder. Every series it names must already be
//                                       in this database (the one-step way in, desktop/package-open.ts,
//                                       adds the package's DICOM first); then the provenance rows and
//                                       the scene row are added and the scene's row appears under its study.
import { checkScene, seriesNamed } from "../logic/scene/check.ts";
import { provenancePathFor, provenanceEdges, seriesAttributes, type ProvenanceEdge, type SeriesAttribute } from "./db-index.ts";

import { sqliteScript } from "./sqlite.ts";
import { sceneObjects, type SyncResult, syncSceneMrcom } from "./scene-mrcom.ts";
import { ArchiveRefusal, refuseArchived, toTrash } from "./archive.ts";
import { seriesFilePaths } from "./series-files.ts";
import { changed, discardDraft, keepCurrentAsVersion, keepVersion, listVersions, NoSuchScene, picturePath, putPicture, putWork, readDraft, readPicture, readVersion, removeWorkBetween, SCENES_FOLDER, versionsDir, workDir } from "./scene-versions.ts";
export { SCENES_FOLDER };
const UID = /^2\.25\.\d{1,40}$/;

export interface SceneRow { uid: string; study: string; name: string; producer: string; producedAt: string; v: number; origin: string; bytes: number; path: string; series?: number; /** Every study the file names (one patient); `study` is the first. */ studies?: string[] }

async function sqlite(dbPath: string, sql: string, readonly = true): Promise<string> {
  // Waits up to five seconds for a busy file, as db-index.ts does: both write provenance.sqlite, and this one
  // gave up at once when a save indexed at the same moment (critic, 2026-09-24, review-bugfixes finding 3).
  // Albula's own SQLite (desktop/sqlite.ts), not the sqlite3 program: Windows has none (2026-10-13).
  return await sqliteScript(dbPath, ".timeout 5000\n" + sql, readonly);
}
const q = (s: unknown) => "'" + String(s ?? "").replace(/'/g, "''") + "'";
/** The provenance store's own two tables, as db-index.ts makes them -- an import on a machine that never had a store creates them (critic, finding 3). */
export const PROVENANCE_SCHEMA = "CREATE TABLE IF NOT EXISTS ProvenanceEdges (id INTEGER PRIMARY KEY, child_series_uid TEXT NOT NULL, parent_series_uid TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, author TEXT, created_at TEXT NOT NULL);\n" +
  "CREATE TABLE IF NOT EXISTS SeriesAttributes (SeriesInstanceUID TEXT NOT NULL, Key TEXT NOT NULL, Value TEXT NOT NULL, Source TEXT NOT NULL, Recorded TEXT NOT NULL, PRIMARY KEY (SeriesInstanceUID, Key));\n";
export const SCENES_SCHEMA = "CREATE TABLE IF NOT EXISTS Scenes (uid TEXT PRIMARY KEY, study TEXT NOT NULL, name TEXT NOT NULL, producer TEXT NOT NULL, producedAt TEXT NOT NULL, v INTEGER NOT NULL, origin TEXT NOT NULL, bytes INTEGER NOT NULL, path TEXT NOT NULL);\n";

export async function listScenes(dbDir: string): Promise<SceneRow[]> {
  const prov = provenancePathFor(dbDir);
  try { await Deno.stat(prov); } catch { return []; }
  const has = (await sqlite(prov, "SELECT name FROM sqlite_master WHERE type='table' AND name='Scenes';")).trim();
  if (!has) return [];
  const raw = (await sqlite(prov, ".mode json\nSELECT uid, study, name, producer, producedAt, v, origin, bytes, path FROM Scenes ORDER BY producedAt DESC;")).trim();
  // A SCENE BELONGS TO THE DATABASE WHOSE FOLDER HOLDS ITS FILE. Databases in one folder share this store, and without
  // this a new, empty database listed (and could delete) the scenes of the one beside it (critic, 2026-10-02, finding 2).
  const all = raw ? JSON.parse(raw) as SceneRow[] : [];
  const rows: SceneRow[] = [];
  for (const r of all) if (await Deno.stat(`${dbDir}/${r.path}`).then(() => true, () => false)) rows.push(r);
  // How many series each names, from the file (a few KB each): the browser's Images column.
  for (const r of rows) {
    try {
      const doc = JSON.parse(await Deno.readTextFile(`${dbDir}/${r.path}`)) as Record<string, unknown>;
      r.series = new Set(seriesNamed(doc).map((x) => x.uid)).size;
      r.studies = Array.isArray(doc.studies) && doc.studies.length ? doc.studies as string[] : [r.study];
    } catch { r.studies = [r.study]; }
  }
  return rows;
}

export async function readScene(dbDir: string, uid: string): Promise<unknown | null> {
  if (!UID.test(uid)) return null;
  try { return JSON.parse(await Deno.readTextFile(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`)); } catch { return null; }
}

export interface PutResult { uid: string; v: number; path: string; bytes: number; /** The scene's DICOM object, kept in step (desktop/scene-mrcom.ts). */ dicom?: SyncResult }

/** The build that wrote a scene, for its DICOM object's SoftwareVersions. */
const producerOf = (doc: Record<string, unknown>) => String((doc.source as Record<string, unknown> | undefined)?.producer ?? "SlicerAlbula");

/** Write a scene. `uid` "new" mints one. Refuses a document the checker rejects, and a `v` that is not the row's + 1. */
// ONE SAVE AT A TIME PER SCENE (critic 2026-11-08, step 1, finding 5: two saves at once left the file and its version
// disagreeing): the check of the save number and the writes are one step.
const sceneLocks = new Map<string, Promise<unknown>>();
function withSceneLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sceneLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  sceneLocks.set(key, next.catch(() => {}));
  return next;
}

export function putScene(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<PutResult | { error: string; status: number; problems?: unknown; rowV?: number; code?: string }> {
  return withSceneLock(`${dbDir}|${uid}`, () => putSceneLocked(dbDir, uid, doc));
}
async function putSceneLocked(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<PutResult | { error: string; status: number; problems?: unknown; rowV?: number; code?: string }> {
  const problems = checkScene(doc);
  if (problems.length) return { error: "the scene does not pass the checker", status: 400, problems };
  if (uid === "new") uid = "2.25." + crypto.getRandomValues(new BigUint64Array(2)).reduce((a, b) => a * 18446744073709551616n + b, 0n).toString();
  if (!UID.test(uid)) return { error: "not a scene uid", status: 400 };
  const rows = await listScenes(dbDir);
  const row = rows.find((r) => r.uid === uid);
  const v = Number(doc.v);
  // WHY THE NUMBERS DIFFER, said rightly (finding 12): behind is another window's save, ahead is a version deleted since.
  if (row && v !== row.v + 1) return { error: v - 1 > row.v
      ? `the newest version of this scene was deleted since this window opened it (the scene is at version ${row.v}): this save adds a version after it`
      : `another window saved this scene since (it is at version ${row.v}; this window has ${v - 1}): this save adds a version after it, or saves as a new scene`, status: 409, rowV: row.v };
  if (!row && v !== 1) return { error: `this scene is no longer in the store (deleted?); it would have to be saved as a new scene`, status: 400, code: "gone" };
  // A uid whose row is another database's (the shared store): never written over from here.
  if (!row && await sceneRowExists(dbDir, uid)) return { error: "that scene belongs to another database; save it as a new scene", status: 409, code: "elsewhere" };
  const dir = `${dbDir}/${SCENES_FOLDER}`;
  await Deno.mkdir(dir, { recursive: true });
  // SAVE ADDS A VERSION, NEVER OVERWRITES (scene-versions.ts; Ron, 2026-11-08): what the file holds now is kept as its version
  // first (a scene from before versions), the new one after it is written.
  if (row) await keepCurrentAsVersion(dbDir, uid);
  const path = `${dir}/${uid}.mrson.json`;
  // The uid travels in the file: a file dropped in alone is then recognized (critic, finding 12).
  const text = JSON.stringify({ ...doc, uid }, null, 1);
  const bytes = new TextEncoder().encode(text).byteLength;
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, text);
  // THE ROW FIRST, THEN THE FILE IN PLACE: a row that cannot be written leaves no file behind that no list shows
  // (it did: the file was renamed into place before the row failed).
  const src = (doc.source as Record<string, unknown> | undefined) ?? {};
  try {
    await sqlite(provenancePathFor(dbDir), SCENES_SCHEMA +
      `INSERT OR REPLACE INTO Scenes VALUES (${q(uid)}, ${q((doc.study as Record<string, unknown>)?.studyInstanceUID)}, ${q(doc.name)}, ${q(src.producer)}, ${q(src.producedAt)}, ${v}, ${q(src.origin)}, ${bytes}, ${q(`${SCENES_FOLDER}/${uid}.mrson.json`)});`, false);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  await Deno.rename(tmp, path);
  changed(dbDir);
  await keepVersion(dbDir, uid, { ...doc, uid });
  // THE SCENE IN DICOM TOO: its one MRCOM object, replaced (Ron, 2026-10-29: the archive keeps "only the final version").
  const dicom = await syncSceneMrcom(dbDir, uid, { ...doc, uid }, producerOf(doc));
  return { uid, v, path, bytes, dicom };
}

/** Is there a row for this uid in the store, whichever database's it is? */
async function sceneRowExists(dbDir: string, uid: string): Promise<boolean> {
  const prov = provenancePathFor(dbDir);
  try { await Deno.stat(prov); } catch { return false; }
  const has = (await sqlite(prov, "SELECT name FROM sqlite_master WHERE type='table' AND name='Scenes';")).trim();
  if (!has) return false;
  return (await sqlite(prov, `SELECT COUNT(*) FROM Scenes WHERE uid=${q(uid)};`)).trim() !== "0";
}

/** A new name for a scene: the file and the row, nothing else (Ron, 2026-09-22: "I would like to be able to edit scene names"). */
export async function renameScene(dbDir: string, uid: string, name: string): Promise<{ ok: true; name: string } | { error: string; status: number }> {
  if (!UID.test(uid)) return { error: "not a scene uid", status: 400 };
  const n = name.trim();
  if (!n) return { error: "a scene needs a name", status: 400 };
  const path = `${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>; } catch { return { error: "no such scene", status: 404 }; }
  const text = JSON.stringify({ ...doc, name: n }, null, 1);
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, text); await Deno.rename(tmp, path);
  await sqlite(provenancePathFor(dbDir), SCENES_SCHEMA + `UPDATE Scenes SET name=${q(n)}, bytes=${new TextEncoder().encode(text).byteLength} WHERE uid=${q(uid)};`, false);
  // THE NAME IS THE SCENE'S, in every version (critic 2026-11-08, step 1, finding 13: deleting the newest took a rename back).
  for (const x of await listVersions(dbDir, uid)) {
    const vp = `${versionsDir(dbDir, uid)}/v${String(x.v).padStart(4, "0")}.mrson.json`;
    try { const d = JSON.parse(await Deno.readTextFile(vp)); const t = `${vp}.${crypto.randomUUID()}.tmp`; await Deno.writeTextFile(t, JSON.stringify({ ...d, name: n }, null, 1)); await Deno.rename(t, vp); } catch { /* a scene from before versions: its file is its version */ }
  }
  changed(dbDir);
  await syncSceneMrcom(dbDir, uid, { ...doc, name: n }, producerOf(doc));   // the object carries the name; a failure is logged there
  return { ok: true, name: n };
}

/**
 * DELETE ONE VERSION, by hand (Ron, 2026-11-08: old versions "by hand"), to the Trash. Not the only one: that is deleting
 * the scene. The newest: the scene becomes the version before it (its file, its row, its DICOM object).
 */
export async function deleteVersion(dbDir: string, uid: string, v: number): Promise<{ ok: true; newest: number } | { error: string; status: number }> {
  if (!UID.test(uid)) return { error: "not a scene uid", status: 400 };
  const vs = await listVersions(dbDir, uid);
  if (!vs.some((x) => x.v === v)) return { error: "no such version", status: 404 };
  if (vs.length === 1) return { error: "the scene's only version: delete the scene instead", status: 409 };
  const newest = vs.at(-1)!.v;
  const gone = vs.find((x) => x.v === v)!, before = vs.filter((x) => x.v < v).at(-1);
  const prev = v === newest ? await readVersion(dbDir, uid, vs.at(-2)!.v) : null;
  if (v === newest && !prev) return { error: "the version before it cannot be read", status: 500 };
  // TO THE TRASH FIRST (critic, nit): a version the Trash refuses is not deleted, and nothing else changes.
  const t = await toTrash(dbDir, [`${versionsDir(dbDir, uid)}/v${String(v).padStart(4, "0")}.mrson.json`]);
  if (t.trashed.length !== 1) return { error: "the version could not be put in the Trash; nothing was changed", status: 500 };
  // Its picture with it (to the Trash as well; a version without one is fine).
  // One the Trash refuses is removed: left there, it would become the picture of the next version with that number (critic
  // 2026-11-08, step 2, nit; a picture is derived, Ron 2026-09-23: "anything but the original data can be deleted").
  if (await Deno.stat(picturePath(dbDir, uid, v)).then(() => true, () => false) && (await toTrash(dbDir, [picturePath(dbDir, uid, v)])).trashed.length !== 1) {
    await Deno.remove(picturePath(dbDir, uid, v)).catch(() => {});
  }
  // The continuous states that led to it go with it (finding 10).
  if (gone.producedAt) await removeWorkBetween(dbDir, uid, before?.producedAt ?? "", gone.producedAt);
  changed(dbDir);
  if (v === newest && prev) {
    const path = `${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`;
    const text = JSON.stringify(prev, null, 1);
    await Deno.writeTextFile(`${path}.tmp`, text);
    const src = (prev.source as Record<string, unknown> | undefined) ?? {};
    await sqlite(provenancePathFor(dbDir), SCENES_SCHEMA +
      `UPDATE Scenes SET name=${q(prev.name)}, producer=${q(src.producer)}, producedAt=${q(src.producedAt)}, v=${Number(prev.v)}, bytes=${new TextEncoder().encode(text).byteLength} WHERE uid=${q(uid)};`, false);
    await Deno.rename(`${path}.tmp`, path);
    await syncSceneMrcom(dbDir, uid, prev, producerOf(prev));
  }
  return { ok: true, newest: v === newest ? vs.at(-2)!.v : newest };
}

export async function deleteScene(dbDir: string, uid: string): Promise<boolean> {
  if (!UID.test(uid)) return false;
  // Only a scene this database holds: the row of one beside it is not this database's to remove (finding 2).
  // Never a scene the archive lists (ArchiveRefusal, shown by the route), and to the Trash (desktop/archive.ts).
  const rel = `${SCENES_FOLDER}/${uid}.mrson.json`;
  if (!(await Deno.stat(`${dbDir}/${rel}`).then(() => true, () => false))) return false;
  // ITS DICOM OBJECT TOO: a listed object refuses the scene's delete before anything goes (the critic, finding 2).
  const objectFiles: string[] = [];
  for (const u of await sceneObjects(dbDir, uid)) objectFiles.push(...await seriesFilePaths(dbDir, u));
  await refuseArchived(dbDir, [rel, ...objectFiles], "the scene");
  if ((await toTrash(dbDir, [`${dbDir}/${rel}`])).trashed.length !== 1) return false;
  // Its versions and continuous states go with it, to the Trash too (scene-versions.ts).
  const present: string[] = [];
  for (const d of [versionsDir(dbDir, uid), workDir(dbDir, uid)]) if (await Deno.stat(d).then(() => true, () => false)) present.push(d);
  if (present.length) await toTrash(dbDir, present);
  changed(dbDir);
  const prov = provenancePathFor(dbDir);
  try { await sqlite(prov, SCENES_SCHEMA + `DELETE FROM Scenes WHERE uid=${q(uid)};`, false); } catch { return false; }
  await syncSceneMrcom(dbDir, uid, null, "");   // its DICOM object goes with it
  return true;
}

// ── the transport folder (§7) ──

/** Every series a scene reaches: the ones it names, their surfaces (a provenance child of kind "surface"), the sequence's document series (the ECG pictures). */
async function seriesReached(dbDir: string, doc: Record<string, unknown>): Promise<string[]> {
  const named = new Set(seriesNamed(doc).map((s) => s.uid));      // the volumes, the SEGs, the sequence's documents
  const prov = provenancePathFor(dbDir);
  let edges: ProvenanceEdge[] = [];
  try { await Deno.stat(prov); edges = await provenanceEdges(prov); } catch { /* no store: no surfaces to add */ }
  for (const e of edges) if (e.kind === "surface" && named.has(e.parent)) named.add(e.child);
  return [...named];
}

/** A folder name from a scene's name: what a person typed, minus what a file system refuses. */
const folderName = (name: string) => (name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "scene").slice(0, 80);

/** Local time, `2026-09-20 14:25`, for a README a person reads. */
const localStamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

export interface PackageResult { path: string; series: number; files: number; bytes: number; missing: string[] }

/**
 * Write `<dest>/<name>.albula/`: the scene file, the DICOM files of every series it reaches under
 * `dicom/<series uid>/`, the provenance rows that concern them and the scene's own row, and a README.
 * Copies; the database is not touched. A series in the file but not in the database is listed in
 * `missing`, not silently left out.
 */
export async function packageScene(dbDir: string, uid: string, dest: string): Promise<PackageResult | { error: string; status: number }> {
  const doc = await readScene(dbDir, uid) as Record<string, unknown> | null;
  if (!doc) return { error: "no such scene", status: 404 };
  const row = (await listScenes(dbDir)).find((r) => r.uid === uid);
  let dir = `${dest}/${folderName(String(doc.name ?? "scene"))}.albula`;
  for (let i = 2; await Deno.stat(dir).then(() => true).catch(() => false); i++) dir = `${dest}/${folderName(String(doc.name ?? "scene"))} ${i}.albula`;
  await Deno.mkdir(`${dir}/dicom`, { recursive: true });
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  const reached = await seriesReached(dbDir, doc);
  const missing: string[] = [];
  let files = 0, bytes = 0;
  for (const series of reached) {
    const raw = (await sqlite(dbPath, `.mode json\nSELECT Filename AS f FROM Images WHERE SeriesInstanceUID=${q(series)};`)).trim();
    const rows = raw ? JSON.parse(raw) as { f: string }[] : [];
    if (!rows.length) { missing.push(series); continue; }
    await Deno.mkdir(`${dir}/dicom/${series}`, { recursive: true });
    for (const { f } of rows) {
      const src = f.startsWith("/") ? f : `${dbDir}/${f}`;
      const to = `${dir}/dicom/${series}/${f.split("/").pop()}`;
      try { await Deno.copyFile(src, to); files++; bytes += (await Deno.stat(to)).size; } catch (e) { missing.push(`${series}: ${(e as Error).message}`); }
    }
  }
  // The provenance that concerns these series, and the scene's own row, as plain JSON.
  const prov = provenancePathFor(dbDir);
  const set = new Set(reached);
  let edges: ProvenanceEdge[] = [], attributes: SeriesAttribute[] = [];
  try { await Deno.stat(prov); edges = (await provenanceEdges(prov)).filter((e) => set.has(e.child)); /* what each packaged series was made from; not the CT's other children */ attributes = (await seriesAttributes(prov)).filter((a) => set.has(a.uid)); } catch { /* none */ }
  await Deno.writeTextFile(`${dir}/provenance.json`, JSON.stringify({ edges, attributes, scene: row ?? null }, null, 1));
  const text = JSON.stringify(doc, null, 1);
  await Deno.writeTextFile(`${dir}/scene.mrson.json`, text);
  const src = (doc.source as Record<string, unknown> | undefined) ?? {};
  await Deno.writeTextFile(`${dir}/README.txt`, [
    `${doc.name}`,
    ``,
    `A SlicerAlbula scene, packaged ${localStamp()} by ${src.producer ?? "SlicerAlbula"} (saved ${src.producedAt ?? "?"}, save ${doc.v ?? "?"}).`,
    ``,
    `scene.mrson.json   what was on screen: which series, which instances, the views, the window/level, the camera (mrson, profile albula-scene/2)`,
    `dicom/             every DICOM file the scene needs, one folder per series: ${reached.length - missing.length} series, ${files} files, ${(bytes / 1e6).toFixed(0)} MB`,
    `provenance.json    what SlicerAlbula knows about those series beyond DICOM: which was made from which, collection and license`,
    ``,
    `To open it on another machine: drop this whole folder onto SlicerAlbula, or choose it with Load / Save › From disk… › Choose…. One window asks which database to keep it in; the scans, the records and the scene arrive together and the scene opens. (3D Slicer: add the dicom/ folder with its DICOM module.)`,
    missing.length ? `\nNot included (not in the database this was packaged from): ${missing.join(", ")}` : ``,
  ].join("\n"));
  return { path: dir, series: reached.length - missing.length, files, bytes, missing };
}

export interface ImportResult { uid: string; v: number; name: string; edges: number; attributes: number; replaced: boolean; kept?: boolean }

/**
 * The other end. Every series the scene names must be in this database already; then the
 * provenance rows (edges that are not there yet, attributes that are not there yet -- a person's
 * own "user" rows are never overwritten) and the scene row are added, the file written under its
 * own uid and v. A scene with the same uid already here is replaced only by a higher v.
 */
export async function importScene(dbDir: string, scene: Record<string, unknown>, provenance?: { edges?: ProvenanceEdge[]; attributes?: SeriesAttribute[] }): Promise<ImportResult | { error: string; status: number; missing?: string[]; problems?: unknown }> {
  const problems = checkScene(scene);
  if (problems.length) return { error: "the scene file does not pass the checker", status: 400, problems };
  const uid = String(scene.uid ?? "");                          // in the file since 2026-09-20 (putScene writes it); older files carry it in provenance.json's row
  const dbPath = `${dbDir}/ctkDICOM.sql`;
  const missing: string[] = [];
  for (const series of new Set(seriesNamed(scene).map((s) => s.uid))) {
    const n = (await sqlite(dbPath, `SELECT COUNT(*) FROM Series WHERE SeriesInstanceUID=${q(series)};`)).trim();
    if (n === "0") missing.push(series);
  }
  if (missing.length) return { error: `${missing.length} of the series this scene needs ${missing.length === 1 ? "is" : "are"} not in this database — import the dicom/ folder first`, status: 409, missing };
  const { edges, attributes } = provenance ? await mergeProvenance(provenancePathFor(dbDir), provenance) : { edges: 0, attributes: 0 };
  return { ...(await writeSceneAsIs(dbDir, uid, scene)), edges, attributes };
}

/**
 * Add provenance rows to a store: edges it does not have yet (same child, parent and kind), attributes it does not have
 * yet -- a person's own "user" rows are never overwritten. Used by a scene's import and by a transfer between databases.
 */
export async function mergeProvenance(prov: string, provenance: { edges?: ProvenanceEdge[]; attributes?: SeriesAttribute[] }): Promise<{ edges: number; attributes: number }> {
  let edges = 0, attributes = 0;
  await sqlite(prov, PROVENANCE_SCHEMA, false);            // a machine that never had a store
  const have = await provenanceEdges(prov).catch(() => [] as ProvenanceEdge[]);
  const seen = new Set(have.map((e) => `${e.child}|${e.parent}|${e.kind}`));
  const stmts: string[] = [];
  for (const e of provenance.edges ?? []) {
    if (seen.has(`${e.child}|${e.parent}|${e.kind}`)) continue;
    seen.add(`${e.child}|${e.parent}|${e.kind}`);
    const x = e as ProvenanceEdge & { detail?: string; author?: string };
    stmts.push(`INSERT INTO ProvenanceEdges (child_series_uid, parent_series_uid, kind, label, detail, author, created_at) VALUES (${q(e.child)}, ${q(e.parent)}, ${q(e.kind)}, ${q(e.label)}, ${x.detail ? q(x.detail) : "NULL"}, ${x.author ? q(x.author) : "NULL"}, ${q(e.createdAt ?? new Date().toISOString())});`);
    edges++;
  }
  const haveAttr = new Set((await seriesAttributes(prov).catch(() => [] as SeriesAttribute[])).map((a) => `${a.uid}|${a.key}`));
  for (const a of provenance.attributes ?? []) {
    if (haveAttr.has(`${a.uid}|${a.key}`)) continue;
    stmts.push(`INSERT OR IGNORE INTO SeriesAttributes VALUES (${q(a.uid)}, ${q(a.key)}, ${q(a.value)}, ${q(a.source)}, ${q(new Date().toISOString().slice(0, 19))});`);
    attributes++;
  }
  // One transaction: a failure part-way leaves none of them, not some (critic, 2026-10-13, finding 6).
  if (stmts.length) await sqlite(prov, "BEGIN IMMEDIATE;\n" + stmts.join("\n") + "\nCOMMIT;", false);
  return { edges, attributes };
}

/** Write a scene file under its own uid and v -- an import, not a save; a same-uid row is replaced only by a higher v. */
async function writeSceneAsIs(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<{ uid: string; v: number; name: string; replaced: boolean; /** The store already had this save or a newer one; nothing was written. */ kept?: boolean }> {
  if (!UID.test(uid)) uid = "2.25." + crypto.getRandomValues(new BigUint64Array(2)).reduce((a, b) => a * 18446744073709551616n + b, 0n).toString();
  const v = Number(doc.v) || 1;
  const row = (await listScenes(dbDir)).find((r) => r.uid === uid);
  if (row && row.v >= v) return { uid, v: row.v, name: row.name, replaced: false, kept: true };
  const dir = `${dbDir}/${SCENES_FOLDER}`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${uid}.mrson.json`;
  const text = JSON.stringify({ ...doc, uid }, null, 1);
  const bytes = new TextEncoder().encode(text).byteLength;
  await Deno.writeTextFile(`${path}.tmp`, text); await Deno.rename(`${path}.tmp`, path);
  await syncSceneMrcom(dbDir, uid, { ...doc, uid }, producerOf(doc));   // an imported scene gets its DICOM object here
  const src = (doc.source as Record<string, unknown> | undefined) ?? {};
  await sqlite(provenancePathFor(dbDir), "BEGIN IMMEDIATE;\n" + SCENES_SCHEMA +
    `INSERT OR REPLACE INTO Scenes VALUES (${q(uid)}, ${q((doc.study as Record<string, unknown>)?.studyInstanceUID)}, ${q(doc.name)}, ${q(src.producer)}, ${q(src.producedAt)}, ${v}, ${q(src.origin)}, ${bytes}, ${q(`${SCENES_FOLDER}/${uid}.mrson.json`)});\nCOMMIT;`, false);
  changed(dbDir);
  return { uid, v, name: String(doc.name ?? ""), replaced: !!row };
}

/** The routes, mounted by db-serve.ts once the database is resolved. */
export async function handleSceneRoutes(req: Request, url: URL, dbId: string, dbDir: string, picturesFolder?: () => Promise<string>): Promise<Response | null> {
  const noStore = { "cache-control": "no-store" };
  // Each row says whether its newest version has a picture (the Scenes module's rows show it).
  if (url.pathname === `/_db/${dbId}/_scenes` && req.method === "GET") {
    const scenes = await listScenes(dbDir);
    const withPic = await Promise.all(scenes.map(async (sc) => ({ ...sc, picture: await Deno.stat(picturePath(dbDir, sc.uid, Number(sc.v))).then((x) => x.isFile, () => false) })));
    return Response.json({ scenes: withPic }, { headers: noStore });
  }
  const esc = dbId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (url.pathname === `/_db/${dbId}/_scene/_import` && req.method === "POST") {
    const body = await req.json().catch(() => null) as { scene?: Record<string, unknown>; provenance?: { edges?: ProvenanceEdge[]; attributes?: SeriesAttribute[]; scene?: { uid?: string } } } | null;
    if (!body?.scene) return Response.json({ error: "the body needs the scene file as `scene`" }, { status: 400 });
    const scene = { ...body.scene, ...(body.provenance?.scene?.uid ? { uid: body.provenance.scene.uid } : {}) };
    try {
      const r = await importScene(dbDir, scene, body.provenance);
      return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r, { headers: noStore });
    } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  }
  const pk = new RegExp(`^/_db/${esc}/_scene/([A-Za-z0-9.]+)/_package$`).exec(url.pathname);
  if (pk && req.method === "POST") {
    try {
      const dest = picturesFolder ? await picturesFolder() : `${Deno.env.get("HOME")}/Downloads`;
      const r = await packageScene(dbDir, pk[1], dest);
      return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r, { headers: noStore });
    } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  }
  // VERSIONS AND THE CONTINUOUS STATES (scene-versions.ts): GET .../_versions; GET or DELETE .../_version/<v>; PUT .../_work (a
  // continuous state, the body the scene document); GET .../_draft (the unsaved work after the newest version, or null).
  // PICTURES: GET .../_picture (the newest version's), GET or PUT .../_picture/<v> (a JPEG, the body).
  const pr = new RegExp(`^/_db/${esc}/_scene/([A-Za-z0-9.]+)/_picture(?:/(\\d+))?$`).exec(url.pathname);
  if (pr) {
    const uid = pr[1], n = pr[2] ? Number(pr[2]) : undefined;
    if (req.method === "GET") {
      const b = await readPicture(dbDir, uid, n);
      return b ? new Response(b, { headers: { "content-type": "image/jpeg", ...noStore } }) : Response.json({ error: "no picture" }, { status: 404 });
    }
    if (req.method === "PUT" && n && Number(req.headers.get("content-length") ?? 0) > 2_000_000) return Response.json({ error: "the picture is larger than 2 MB" }, { status: 413 });
    if (req.method === "PUT" && n) { const r = await putPicture(dbDir, uid, n, new Uint8Array(await req.arrayBuffer())); return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r); }
    return null;
  }
  const vr = new RegExp(`^/_db/${esc}/_scene/([A-Za-z0-9.]+)/(_versions|_version/(\\d+)|_work|_draft)$`).exec(url.pathname);
  if (vr) {
    const uid = vr[1], what = vr[2], n = Number(vr[3]);
    if (what === "_versions" && req.method === "GET") return Response.json({ versions: await listVersions(dbDir, uid) }, { headers: noStore });
    if (what.startsWith("_version/") && req.method === "GET") { const d = await readVersion(dbDir, uid, n); return d ? Response.json(d, { headers: noStore }) : Response.json({ error: "no such version" }, { status: 404 }); }
    if (what.startsWith("_version/") && req.method === "DELETE") { const r = await deleteVersion(dbDir, uid, n); return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r); }
    // PUT, and POST for the last state a closing window sends (sendBeacon can only POST; finding 9).
    if (what === "_work" && (req.method === "PUT" || req.method === "POST")) {
      try { return Response.json(await putWork(dbDir, uid, await req.json() as Record<string, unknown>)); }
      catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof NoSuchScene ? 404 : 400 }); }
    }
    if (what === "_draft" && req.method === "GET") return Response.json({ draft: await readDraft(dbDir, uid) }, { headers: noStore });
    if (what === "_draft" && req.method === "DELETE") return Response.json({ discarded: await discardDraft(dbDir, uid) });
  }
  const rn = new RegExp(`^/_db/${esc}/_scene/([A-Za-z0-9.]+)/_name$`).exec(url.pathname);
  if (rn && req.method === "PUT") {
    const body = await req.json().catch(() => null) as { name?: string } | null;
    const r = await renameScene(dbDir, rn[1], body?.name ?? "");
    return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r, { headers: noStore });
  }
  const m = new RegExp(`^/_db/${esc}/_scene/([A-Za-z0-9.]+)$`).exec(url.pathname);
  if (!m) return null;
  const uid = m[1];
  if (req.method === "GET") { const d = await readScene(dbDir, uid); return d ? Response.json(d, { headers: noStore }) : Response.json({ error: "no such scene" }, { status: 404 }); }
  if (req.method === "PUT") {
    const doc = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!doc) return Response.json({ error: "the body is not JSON" }, { status: 400 });
    const r = await putScene(dbDir, uid, doc);
    return "error" in r ? Response.json(r, { status: r.status }) : Response.json(r, { headers: noStore });
  }
  if (req.method === "DELETE") {
    try { return Response.json({ removed: await deleteScene(dbDir, uid) }); }
    catch (e) { if (e instanceof ArchiveRefusal) return Response.json({ removed: false, error: e.message }, { status: 409 }); throw e; }
  }
  return null;
}
