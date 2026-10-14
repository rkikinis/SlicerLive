// OPENING A PACKAGED SCENE (`<name>.albula/`, written by desktop/scenes.ts "_package") OR TAKING IN A WHOLE DATABASE
// FOLDER, in one window (Ron, 2026-10-13, mockups/albula-import-2026-10-13.html, after the Mac mini test of 2026-10-13:
// three steps in three places and five confusing messages). This module answers "what is this folder?" before anything
// is added; the adding itself is the routes that already exist (make a database, add a folder, import a scene), called
// in order by the page (render/demos/package-window.ts).
//
// Ron's answers, 2026-10-13: databases live in "SlicerAlbulaDatabases" in the home folder, one folder each ("Test Data",
// "Tumor Data", …); "Public data" is ticked from the package's own record; a whole database folder is moved or copied
// into "SlicerAlbulaDatabases" -- the person decides, move is the default.
import { statfsSync } from "node:fs";
import { readDicomHead } from "../logic/readers/dicom-head.ts";
import { seriesNamed } from "../logic/scene/check.ts";
import { defaultDatabasesFolder, readDescription } from "./db-create.ts";
import { filesUnder } from "./db-import.ts";
import { provenancePathFor } from "./db-index.ts";
import { PROVENANCE_SCHEMA, SCENES_SCHEMA } from "./scenes.ts";
import { fromStored, isInside, isSameFolder } from "./paths.ts";
import { join } from "jsr:@std/path@1";
import { copy } from "jsr:@std/fs@1/copy";

import { realDbPath, sqliteScript } from "./sqlite.ts";
/** One series in the package, read from the first file of its folder. */
export interface PackageSeries { uid: string; modality: string; description: string; files: number; bytes: number }
/** Which of the package's series a registered database already holds, and whether it has the scene (and at which save). */
export interface PackageInDatabase { id: string; name: string; public: boolean | null; current: boolean; series: number; sceneV: number | null;
  /** Free space on the disk that holds this database; whether the package lies on that same disk (a move then needs none). */
  freeBytes: number | null; sameDisk: boolean | null }

export type Inspected =
  | { kind: "package"; name: string; sceneUid: string; sceneV: number; patientID: string; studyDate: string; studyDescription: string;
      series: PackageSeries[]; sceneSeries: number; sceneSeriesUids: string[]; missingSeries: string[]; files: number; bytes: number;
      public: boolean; collection: string; license: string; databases: PackageInDatabase[]; freeBytes: number | null; defaultParent: string }
  | { kind: "database"; name: string; path: string; bytes: number; inParent: boolean; registeredAs: string | null; defaultParent: string; freeBytes: number | null }
  | { kind: "neither"; name: string };

async function sqliteRows(dbFile: string, sql: string): Promise<string[]> {
  // Albula's own SQLite (desktop/sqlite.ts), not the sqlite3 program: Windows has none (2026-10-13).
  try { return (await sqliteScript(dbFile, ".timeout 5000\n" + sql, true)).split("\n").map((l) => l.replace(/\r$/, "")).filter(Boolean); } catch { return []; }
}
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

/** Free space on the disk that holds `path` (or its nearest existing parent), in bytes; null when it cannot be read. */
export async function freeBytes(path: string): Promise<number | null> {
  // Asked of the system through Deno itself (`statfs`), on every system -- not the `df` program, which Windows does not
  // have (2026-10-14; checked: the same answer as `df -k`). A folder not made yet is asked through its nearest parent.
  let p = path;
  for (let i = 0; i < 8; i++) { if (await Deno.stat(p).then(() => true, () => false)) break; const up = join(p, ".."); if (up === p) break; p = up; }
  try {
    const s = statfsSync(p);
    const free = Number(s.bavail) * Number(s.bsize);
    return Number.isFinite(free) ? free : null;
  } catch { return null; }
}

async function folderBytes(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      if (e.isDirectory) await walk(join(d, e.name));
      else if (e.isFile) n += (await Deno.stat(join(d, e.name)).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir).catch(() => {});
  return n;
}

/** The first megabyte of a file's header, read. */
async function headOf(file: string): Promise<Map<string, string> | null> {
  try {
    const f = await Deno.open(file);
    try {
      const buf = new Uint8Array(1 << 20);
      const n = (await f.read(buf)) ?? 0;
      return readDicomHead(buf.slice(0, n).buffer);
    } finally { f.close(); }
  } catch { return null; }
}

/**
 * What the chosen folder is: a packaged scene, a database, or neither -- and for a package, what is in it, whether it is
 * public (its record names a collection and a license, as public data from IDC or OpenNeuro does), and which registered
 * databases already hold which of its series and the scene.
 */
export async function inspectFolder(path: string, name: string, databases: { id: string; path: string; exists: boolean; current?: boolean; description?: { name?: string; patientData?: boolean } }[]): Promise<Inspected> {
  const parent = defaultDatabasesFolder();
  if (await Deno.stat(join(path, "ctkDICOM.sql")).then((s) => s.isFile, () => false)) {
    const d = await readDescription(path);
    let registeredAs: string | null = null;
    for (const r of databases) if (await isSameFolder(r.path, path)) registeredAs = r.description?.name ?? r.id;
    return { kind: "database", name: d?.name ?? name, path, bytes: await folderBytes(path), inParent: await isInside(path, parent), registeredAs, defaultParent: parent, freeBytes: await freeBytes(parent) };
  }
  let scene: Record<string, unknown>;
  try { scene = JSON.parse(await Deno.readTextFile(join(path, "scene.mrson.json"))); } catch { return { kind: "neither", name }; }
  const prov = await Deno.readTextFile(join(path, "provenance.json")).then((t) => JSON.parse(t) as { attributes?: { uid: string; key: string; value: string }[] }, () => ({} as { attributes?: { uid: string; key: string; value: string }[] }));
  // The package's series: one folder each under dicom/ (scenes.ts writes them so), counted and read from a first file.
  const series: PackageSeries[] = [];
  let patientID = "", studyDate = "", studyDescription = "";
  const dicomDir = join(path, "dicom");
  const dirs: string[] = [];
  try { for await (const e of Deno.readDir(dicomDir)) if (e.isDirectory) dirs.push(e.name); } catch { /* no dicom/ folder: no series */ }
  for (const name of dirs.sort()) {
    const e = { name };
    const { files } = await filesUnder(join(dicomDir, e.name)).catch(() => ({ files: [] as string[] }));
    let bytes = 0;
    for (const f of files) bytes += (await Deno.stat(f).catch(() => ({ size: 0 }))).size;
    const h = files.length ? await headOf(files[0]) : null;
    patientID ||= h?.get("00100020") ?? ""; studyDate ||= h?.get("00080020") ?? ""; studyDescription ||= h?.get("00081030") ?? "";
    series.push({ uid: e.name, modality: h?.get("00080060") ?? "", description: h?.get("0008103E") ?? "", files: files.length, bytes });
  }
  const inPackage = new Set(series.map((s) => s.uid));
  const facts = await packageFacts(scene, prov, databases, path);
  return {
    ...facts, name: facts.name || name.replace(/\.albula$/, ""), patientID, studyDate, studyDescription, series,
    missingSeries: facts.sceneSeriesUids.filter((u) => !inPackage.has(u)),
    files: series.reduce((n, s) => n + s.files, 0), bytes: series.reduce((n, s) => n + s.bytes, 0),
  };
}

/**
 * The part of a package's facts that its two documents and the registered databases give -- all a DROPPED folder can
 * offer the server (the page holds its files; their place on disk is not known): name, public or not, which databases
 * hold which of its series and the scene. The page counts the dropped files itself.
 */
export async function packageFacts(scene: Record<string, unknown>, prov: { attributes?: { uid: string; key: string; value: string }[] }, databases: { id: string; path: string; exists: boolean; current?: boolean; description?: { name?: string; patientData?: boolean } }[], packagePath?: string) {
  const packageDev = packagePath ? await diskOf(packagePath) : null;
  const sceneSeries = [...new Set(seriesNamed(scene).map((s) => s.uid))];
  const attrs = prov.attributes ?? [];
  const attr = (key: string) => attrs.find((a) => a.key === key && sceneSeries.includes(a.uid))?.value ?? "";
  const collection = attr("collection"), license = attr("license");
  const uid = String(scene.uid ?? "");
  const parent = defaultDatabasesFolder();
  const out: PackageInDatabase[] = [];
  for (const d of databases) {
    if (!d.exists) continue;
    const held = sceneSeries.length
      ? (await sqliteRows(join(d.path, "ctkDICOM.sql"), `select count(*) from Series where SeriesInstanceUID in (${sceneSeries.map(q).join(",")});`))[0]
      : "0";
    const v = uid ? (await sqliteRows(provenancePathFor(d.path), `select v from Scenes where uid = ${q(uid)};`))[0] : undefined;
    out.push({ id: d.id, name: d.description?.name ?? d.id, public: d.description?.patientData === undefined ? null : !d.description.patientData,
      current: !!d.current, series: Number(held) || 0, sceneV: v === undefined ? null : Number(v),
      freeBytes: await freeBytes(d.path), sameDisk: packageDev === null ? null : (await diskOf(d.path)) === packageDev });
  }
  return {
    kind: "package" as const, name: String(scene.name ?? ""), sceneUid: uid, sceneV: Number(scene.v ?? 0) || 0,
    sceneSeries: sceneSeries.length, sceneSeriesUids: sceneSeries,
    public: !!(collection && license), collection, license, databases: out, freeBytes: await freeBytes(parent), defaultParent: parent,
    /** Whether the package lies on the disk of the default parent folder (a new database goes there). */
    sameDiskAsParent: packageDev === null ? null : (await diskOf(parent)) === packageDev,
  };
}

/** The disk a path (or its nearest existing parent) is on, as the system numbers it; null when unknown. */
async function diskOf(path: string): Promise<number | null> {
  let p = path;
  for (let i = 0; i < 8; i++) {
    const st = await Deno.stat(p).catch(() => null);
    if (st) return st.dev ?? null;
    const up = join(p, ".."); if (up === p) break; p = up;
  }
  return null;
}

/**
 * A WHOLE DATABASE FOLDER INTO "SlicerAlbulaDatabases" (Ron, 2026-10-13: "move or copy into the albula databases folder.
 * User decides, move is the default"). Moved by renaming when it is on the same disk, else copied and -- for a move --
 * the original removed only after the copy is complete. Never over an existing folder: a number is added to the name.
 * Returns where it now is.
 */
export async function bringDatabase(from: string, name: string, move: boolean): Promise<string> {
  const parent = defaultDatabasesFolder();
  await Deno.mkdir(parent, { recursive: true });
  // A name every system accepts as a folder name: none of < > : " / \ | ? *, no leading dot, no trailing dot or space.
  const base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/^\.+/, "").replace(/[. ]+$/, "").trim() || "Database";
  let to = join(parent, base);
  for (let i = 2; await Deno.stat(to).then(() => true, () => false); i++) to = join(parent, `${base} ${i}`);
  if (await isSameFolder(from, to) || await isInside(to, from)) throw new Error("the database cannot go inside itself");
  if (move) {
    try { await Deno.rename(from, to); return to; }
    catch (e) {
      // ONLY ANOTHER DISK leads to copy-then-remove (the critic, 2026-10-13, A6): on Windows a folder another program
      // has open (Slicer holding ctkDICOM.sql) cannot be renamed either, and copying then removing it half-deleted the
      // original while it was in use. Anything else is said, and nothing is touched.
      if (!crossDevice(e)) throw new Error(`the database could not be moved (${(e as Error).message}); is another program, such as Slicer, using it? Nothing was changed.`);
    }
  }
  try { await copy(from, to, { preserveTimestamps: true }); }
  catch (e) { await Deno.remove(to, { recursive: true }).catch(() => {}); throw new Error(`the copy failed: ${(e as Error).message}`); }
  if (move) {
    // The original out of the way in ONE step before it is removed: a folder that cannot be renamed (in use) is left
    // whole, and the copy stands; a partial removal is never the result.
    const aside = `${from}.moved-to-SlicerAlbulaDatabases`;
    try { await Deno.rename(from, aside); } catch { return to; }
    await Deno.remove(aside, { recursive: true }).catch(() => {});
  }
  return to;
}

/** A rename refused because source and target are on different disks (EXDEV; Windows' ERROR_NOT_SAME_DEVICE). */
function crossDevice(e: unknown): boolean {
  const m = String((e as Error)?.message ?? "");
  return (e as { code?: string })?.code === "EXDEV" || /cross-device|os error 18\b|not same device|os error 17\b/i.test(m);
}

/**
 * THE DATABASE'S RECORDS GO WITH IT. A database's scene list, its series' collection and license, and which series was
 * made from which live in provenance.sqlite BESIDE its folder (db-index.ts provenancePathFor), shared with any other
 * database in the same parent folder. Moving the folder alone would leave them behind: the rows that belong to this
 * database -- edges and attributes of its series, scenes whose file lies inside it -- are copied
 * into the store beside its new place. The old store is left as it is (a record, and it may serve other databases).
 * Run AFTER the folder has arrived, so its ctkDICOM.sql names its series.
 */
export async function carryRecords(oldDir: string, newDir: string): Promise<{ edges: number; attributes: number; scenes: number }> {
  const oldProv = provenancePathFor(oldDir), newProv = provenancePathFor(newDir);
  if (oldProv === newProv || !(await Deno.stat(oldProv).then(() => true, () => false))) return { edges: 0, attributes: 0, scenes: 0 };
  const tables = new Set(await sqliteRows(oldProv, "SELECT name FROM sqlite_master WHERE type='table';"));
  // A scene row's path is relative to its database's folder (scenes.ts: "SlicerAlbula-Scenes/<uid>.mrson.json"), so the
  // rows that belong to this database are those whose file is in it.
  const sceneUids: string[] = [];
  if (tables.has("Scenes")) for (const line of await sqliteRows(oldProv, "SELECT uid || '|' || path FROM Scenes;")) {
    const [uid, rel] = line.split("|");
    if (uid && rel && await Deno.stat(fromStored(newDir, rel)).then((x) => x.isFile, () => false)) sceneUids.push(uid);
  }
  const series = `(SELECT SeriesInstanceUID FROM c.Series)`;
  const sql = [
    PROVENANCE_SCHEMA, SCENES_SCHEMA,
    `ATTACH ${q(realDbPath(oldProv))} AS s; ATTACH ${q(realDbPath(join(newDir, "ctkDICOM.sql")))} AS c;`,   // real paths: Deno 2.9.7
    "BEGIN IMMEDIATE;",
    tables.has("ProvenanceEdges") ? `INSERT INTO ProvenanceEdges (child_series_uid, parent_series_uid, kind, label, detail, author, created_at)
      SELECT e.child_series_uid, e.parent_series_uid, e.kind, e.label, e.detail, e.author, e.created_at FROM s.ProvenanceEdges e
      WHERE e.child_series_uid IN ${series} AND NOT EXISTS (SELECT 1 FROM ProvenanceEdges x WHERE x.child_series_uid = e.child_series_uid AND x.kind = e.kind AND x.created_at = e.created_at);` : "",
    tables.has("SeriesAttributes") ? `INSERT OR IGNORE INTO SeriesAttributes SELECT * FROM s.SeriesAttributes WHERE SeriesInstanceUID IN ${series};` : "",
    sceneUids.length ? `INSERT OR REPLACE INTO Scenes SELECT * FROM s.Scenes WHERE uid IN (${sceneUids.map(q).join(",")});` : "",
    "COMMIT;",
    `SELECT (SELECT count(*) FROM ProvenanceEdges WHERE child_series_uid IN ${series}), (SELECT count(*) FROM SeriesAttributes WHERE SeriesInstanceUID IN ${series}), (SELECT count(*) FROM Scenes WHERE uid IN (${sceneUids.map(q).join(",") || "''"}));`,
  ].join("\n");
  let printed: string;
  try { printed = await sqliteScript(newProv, ".timeout 5000\n" + sql, false); }
  catch (e) { throw new Error(`the database arrived, but its records could not be carried over: ${(e as Error).message}`); }
  const [edges, attributes, scenes] = printed.trim().split("\n").pop()!.split("|").map(Number);
  return { edges: edges || 0, attributes: attributes || 0, scenes: scenes || 0 };
}
