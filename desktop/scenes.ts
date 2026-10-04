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
//                                       in this database (Albula does not import DICOM; Slicer's
//                                       DICOM module does); then the provenance rows and the scene
//                                       row are added and the scene's row appears under its study.
import { checkScene, seriesNamed } from "../logic/scene/check.ts";
import { provenancePathFor, provenanceEdges, seriesAttributes, type ProvenanceEdge, type SeriesAttribute } from "./db-index.ts";

export const SCENES_FOLDER = "SlicerAlbula-Scenes";
const UID = /^2\.25\.\d{1,40}$/;

export interface SceneRow { uid: string; study: string; name: string; producer: string; producedAt: string; v: number; origin: string; bytes: number; path: string; series?: number; /** Every study the file names (one patient); `study` is the first. */ studies?: string[] }

async function sqlite(dbPath: string, sql: string, readonly = true): Promise<string> {
  const cmd = new Deno.Command("sqlite3", { args: readonly ? ["-readonly", dbPath] : [dbPath], stdin: "piped", stdout: "piped", stderr: "piped" });
  const p = cmd.spawn();
  // Waits up to five seconds for a busy file, as db-index.ts does: both write provenance.sqlite, and this one
  // gave up at once when a save indexed at the same moment (critic, 2026-09-24, review-bugfixes finding 3).
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(".timeout 5000\n" + sql)); await w.close();
  const out = await p.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || "sqlite failed");
  return new TextDecoder().decode(out.stdout);
}
const q = (s: unknown) => "'" + String(s ?? "").replace(/'/g, "''") + "'";
/** The provenance store's own two tables, as db-index.ts makes them -- an import on a machine that never had a store creates them (critic, finding 3). */
const PROVENANCE_SCHEMA = "CREATE TABLE IF NOT EXISTS ProvenanceEdges (id INTEGER PRIMARY KEY, child_series_uid TEXT NOT NULL, parent_series_uid TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, author TEXT, created_at TEXT NOT NULL);\n" +
  "CREATE TABLE IF NOT EXISTS SeriesAttributes (SeriesInstanceUID TEXT NOT NULL, Key TEXT NOT NULL, Value TEXT NOT NULL, Source TEXT NOT NULL, Recorded TEXT NOT NULL, PRIMARY KEY (SeriesInstanceUID, Key));\n";
const SCHEMA = "CREATE TABLE IF NOT EXISTS Scenes (uid TEXT PRIMARY KEY, study TEXT NOT NULL, name TEXT NOT NULL, producer TEXT NOT NULL, producedAt TEXT NOT NULL, v INTEGER NOT NULL, origin TEXT NOT NULL, bytes INTEGER NOT NULL, path TEXT NOT NULL);\n";

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

export interface PutResult { uid: string; v: number; path: string; bytes: number }

/** Write a scene. `uid` "new" mints one. Refuses a document the checker rejects, and a `v` that is not the row's + 1. */
export async function putScene(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<PutResult | { error: string; status: number; problems?: unknown; rowV?: number; code?: string }> {
  const problems = checkScene(doc);
  if (problems.length) return { error: "the scene does not pass the checker", status: 400, problems };
  if (uid === "new") uid = "2.25." + crypto.getRandomValues(new BigUint64Array(2)).reduce((a, b) => a * 18446744073709551616n + b, 0n).toString();
  if (!UID.test(uid)) return { error: "not a scene uid", status: 400 };
  const rows = await listScenes(dbDir);
  const row = rows.find((r) => r.uid === uid);
  const v = Number(doc.v);
  if (row && v !== row.v + 1) return { error: `this scene is at save ${row.v} on disk and this window has ${v - 1}: another window saved it since — overwrite, save as a new scene, or cancel`, status: 409, rowV: row.v };
  if (!row && v !== 1) return { error: `this scene is no longer in the store (deleted?); it would have to be saved as a new scene`, status: 400, code: "gone" };
  // A uid whose row is another database's (the shared store): never written over from here.
  if (!row && await sceneRowExists(dbDir, uid)) return { error: "that scene belongs to another database; save it as a new scene", status: 409, code: "elsewhere" };
  const dir = `${dbDir}/${SCENES_FOLDER}`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${uid}.mrson.json`;
  // The uid travels in the file: a file dropped in alone is then recognized (critic, finding 12).
  const text = JSON.stringify({ ...doc, uid }, null, 1);
  const bytes = new TextEncoder().encode(text).byteLength;
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, text);
  // THE ROW FIRST, THEN THE FILE IN PLACE: a row that cannot be written leaves no file behind that no list shows
  // (it did: the file was renamed into place before the row failed).
  const src = (doc.source as Record<string, unknown> | undefined) ?? {};
  try {
    await sqlite(provenancePathFor(dbDir), SCHEMA +
      `INSERT OR REPLACE INTO Scenes VALUES (${q(uid)}, ${q((doc.study as Record<string, unknown>)?.studyInstanceUID)}, ${q(doc.name)}, ${q(src.producer)}, ${q(src.producedAt)}, ${v}, ${q(src.origin)}, ${bytes}, ${q(`${SCENES_FOLDER}/${uid}.mrson.json`)});`, false);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
  await Deno.rename(tmp, path);
  return { uid, v, path, bytes };
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
  await sqlite(provenancePathFor(dbDir), SCHEMA + `UPDATE Scenes SET name=${q(n)}, bytes=${new TextEncoder().encode(text).byteLength} WHERE uid=${q(uid)};`, false);
  return { ok: true, name: n };
}

export async function deleteScene(dbDir: string, uid: string): Promise<boolean> {
  if (!UID.test(uid)) return false;
  // Only a scene this database holds: the row of one beside it is not this database's to remove (finding 2).
  if (!(await Deno.remove(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`).then(() => true, () => false))) return false;
  const prov = provenancePathFor(dbDir);
  try { await sqlite(prov, SCHEMA + `DELETE FROM Scenes WHERE uid=${q(uid)};`, false); } catch { return false; }
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
    `scene.mrson.json   what was on screen: which series, which instances, the views, the window/level, the camera (mrson, profile albula-scene/1)`,
    `dicom/             every DICOM file the scene needs, one folder per series: ${reached.length - missing.length} series, ${files} files, ${(bytes / 1e6).toFixed(0)} MB`,
    `provenance.json    what SlicerAlbula knows about those series beyond DICOM: which was made from which, collection and license`,
    ``,
    `To open it on another machine: import the dicom/ folder into the DICOM database (3D Slicer's DICOM module, or any importer), then drop scene.mrson.json and provenance.json onto SlicerAlbula; the scene appears under its study in the DICOM browser and opens with one click.`,
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
  if (stmts.length) await sqlite(prov, stmts.join("\n"), false);
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
  const src = (doc.source as Record<string, unknown> | undefined) ?? {};
  await sqlite(provenancePathFor(dbDir), SCHEMA +
    `INSERT OR REPLACE INTO Scenes VALUES (${q(uid)}, ${q((doc.study as Record<string, unknown>)?.studyInstanceUID)}, ${q(doc.name)}, ${q(src.producer)}, ${q(src.producedAt)}, ${v}, ${q(src.origin)}, ${bytes}, ${q(`${SCENES_FOLDER}/${uid}.mrson.json`)});`, false);
  return { uid, v, name: String(doc.name ?? ""), replaced: !!row };
}

/** The routes, mounted by db-serve.ts once the database is resolved. */
export async function handleSceneRoutes(req: Request, url: URL, dbId: string, dbDir: string, picturesFolder?: () => Promise<string>): Promise<Response | null> {
  const noStore = { "cache-control": "no-store" };
  if (url.pathname === `/_db/${dbId}/_scenes` && req.method === "GET") return Response.json({ scenes: await listScenes(dbDir) }, { headers: noStore });
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
  if (req.method === "DELETE") return Response.json({ removed: await deleteScene(dbDir, uid) });
  return null;
}
