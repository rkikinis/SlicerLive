// A SCENE IS A LIST OF VERSIONS (Ron, 2026-11-08, Contents/docs/SCENE-SAVING-2026-11-08.md in the workspace: "1 yes 2 yes 3
// yes 4 by hand", then "1 ask at save 2 keep as draft 3 yes"). Save adds a version and never overwrites; old versions go
// only by hand; underneath, the work is saved continuously (the "nightlies", Ron: "continous sving until the user saves a
// view. At that point the continous viws leading up to the saved view can be removed"), kept one step behind (until the
// next save) and as a draft when the window closes without saving; a series stays while any version or continuous state
// names it.
//
// On disk, beside the scene's own file `SlicerAlbula-Scenes/<uid>.mrson.json` (the newest version, as before, so every
// reader of a scene is unchanged):
//   SlicerAlbula-Scenes/<uid>.versions/v0004.mrson.json   every saved version (the file as saved; about 0.1 MB)
//   SlicerAlbula-Scenes/<uid>.versions/v0004.jpg          its picture, taken at the save (small; the row's and the look's)
//   SlicerAlbula-Scenes/<uid>.work/<UTC stamp>.mrson.json  the continuous states since the version before the last
// A scene saved before versions existed has only its own file: it is copied in as its version the first time it is saved
// again, so nothing it was is lost.
import { seriesNamed } from "../logic/scene/check.ts";

export const SCENES_FOLDER = "SlicerAlbula-Scenes";
const UID = /^2\.25\.\d{1,40}$/;
const pad = (v: number) => String(v).padStart(4, "0");
export const versionsDir = (dbDir: string, uid: string) => `${dbDir}/${SCENES_FOLDER}/${uid}.versions`;
export const workDir = (dbDir: string, uid: string) => `${dbDir}/${SCENES_FOLDER}/${uid}.work`;
const versionPath = (dbDir: string, uid: string, v: number) => `${versionsDir(dbDir, uid)}/v${pad(v)}.mrson.json`;
export const picturePath = (dbDir: string, uid: string, v: number) => `${versionsDir(dbDir, uid)}/v${pad(v)}.jpg`;

export interface VersionInfo { v: number; name: string; description?: string; producedAt?: string; bytes: number; picture?: boolean }

// WHAT THE VERSIONS USE, REMEMBERED per database until a scene, version or state of it is written or removed (critic
// 2026-11-08, step 1, finding 14: every delete read every file, 2.9 s for 7,550 of them). Every writer is in this server and
// calls `changed`.
const useCache = new Map<string, Map<string, UseOfSeries[]>>();
export const changed = (dbDir: string) => { useCache.delete(dbDir); };

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>; } catch { return null; }
}
async function writeAtomically(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;   // two writers never share a temporary file (finding 5)
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}
const producedAt = (doc: Record<string, unknown> | null) => ((doc?.source as Record<string, unknown> | undefined)?.producedAt as string | undefined);

/** Before a save: the scene's file as it is, kept as its version if it is not yet (a scene from before versions). */
export async function keepCurrentAsVersion(dbDir: string, uid: string): Promise<void> {
  if (!UID.test(uid)) return;
  const cur = await readJson(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`);
  const v = Number(cur?.v);
  if (!cur || !(v >= 1)) return;
  const path = versionPath(dbDir, uid, v);
  if (await Deno.stat(path).then(() => true, () => false)) return;
  await Deno.mkdir(versionsDir(dbDir, uid), { recursive: true });
  await writeAtomically(path, JSON.stringify(cur, null, 1));
  changed(dbDir);
}

/** After a save: the new version kept, and the continuous states older than the version before it removed (one step behind). */
export async function keepVersion(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<void> {
  const v = Number(doc.v);
  if (!UID.test(uid) || !(v >= 1)) return;
  await Deno.mkdir(versionsDir(dbDir, uid), { recursive: true });
  await writeAtomically(versionPath(dbDir, uid, v), JSON.stringify({ ...doc, uid }, null, 1));
  changed(dbDir);
  const before = (await listVersions(dbDir, uid)).filter((x) => x.v < v).at(-1);
  if (before?.producedAt) await pruneWork(dbDir, uid, before.producedAt);
}

/** Every version, oldest first. */
export async function listVersions(dbDir: string, uid: string): Promise<VersionInfo[]> {
  if (!UID.test(uid)) return [];
  const out: VersionInfo[] = [];
  try {
    for await (const e of Deno.readDir(versionsDir(dbDir, uid))) {
      const m = /^v(\d+)\.mrson\.json$/.exec(e.name);
      if (!m || !e.isFile) continue;
      const path = `${versionsDir(dbDir, uid)}/${e.name}`;
      const doc = await readJson(path);
      const bytes = await Deno.stat(path).then((s) => s.size, () => -1);   // gone meanwhile: skipped, the others still listed (finding 14)
      if (bytes < 0) continue;
      out.push({ v: Number(m[1]), name: String(doc?.name ?? ""), description: doc?.description as string | undefined, producedAt: producedAt(doc), bytes });
    }
  } catch { /* no versions folder: a scene from before versions, or none saved */ }
  // A SCENE FROM BEFORE VERSIONS: its own file is its one version (C3N-01524's save 4), until the next save copies it in.
  if (!out.length) {
    const path = `${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`, doc = await readJson(path);
    if (doc && Number(doc.v) >= 1) out.push({ v: Number(doc.v), name: String(doc.name ?? ""), description: doc.description as string | undefined, producedAt: producedAt(doc), bytes: (await Deno.stat(path)).size });
  }
  for (const x of out) x.picture = await Deno.stat(picturePath(dbDir, uid, x.v)).then((s) => s.isFile, () => false);
  return out.sort((a, b) => a.v - b.v);
}

// ── the pictures ──

/** THE PICTURE OF A VERSION, taken by the window right after the save (Ron, 2026-11-08: "the screenshot taken at the time the
 *  scene was saved"). Only for a version that exists, only a JPEG, at most 2 MB; a second one for the same version replaces it. */
export async function putPicture(dbDir: string, uid: string, v: number, bytes: Uint8Array): Promise<{ ok: true } | { error: string; status: number }> {
  if (!UID.test(uid) || !(v >= 1)) return { error: "not a scene version", status: 400 };
  if (bytes.byteLength > 2_000_000) return { error: "the picture is larger than 2 MB", status: 413 };
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return { error: "the picture is not a JPEG", status: 400 };
  if (!(await listVersions(dbDir, uid)).some((x) => x.v === v)) return { error: "no such version", status: 404 };
  await Deno.mkdir(versionsDir(dbDir, uid), { recursive: true });
  const path = picturePath(dbDir, uid, v), tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, path);
  return { ok: true };
}
/** A version's picture, or the newest version's when no number is given; null when it has none. */
export async function readPicture(dbDir: string, uid: string, v?: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!UID.test(uid)) return null;
  const n = v ?? (await listVersions(dbDir, uid)).at(-1)?.v;
  if (!n) return null;
  return await Deno.readFile(picturePath(dbDir, uid, n)).catch(() => null);
}

export async function readVersion(dbDir: string, uid: string, v: number): Promise<Record<string, unknown> | null> {
  if (!UID.test(uid)) return null;
  const path = versionPath(dbDir, uid, v);
  // A version file that exists is read as it is, unreadable or not (an unreadable one must not hide behind the scene's file).
  if (await Deno.stat(path).then(() => true, () => false)) return await readJson(path);
  const cur = await readJson(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`);   // a scene from before versions: its file is its version
  return cur && Number(cur.v) === v ? cur : null;
}

/** A MOVE CARRIES THE LIST (critic 2026-11-08, step 1, finding 2): every version of a scene copied into the other database's
 *  scene store, under the uid it has there; the continuous states (unsaved work) are not carried. Returns how many. */
export async function carryVersions(fromDb: string, fromUid: string, toDb: string, toUid: string): Promise<number> {
  if (!UID.test(fromUid) || !UID.test(toUid)) return 0;
  let n = 0;
  for (const x of await listVersions(fromDb, fromUid)) {
    const doc = await readVersion(fromDb, fromUid, x.v);
    if (!doc) continue;
    const to = versionPath(toDb, toUid, x.v);
    if (await Deno.stat(to).then(() => true, () => false)) continue;
    await Deno.mkdir(versionsDir(toDb, toUid), { recursive: true });
    await writeAtomically(to, JSON.stringify({ ...doc, uid: toUid }, null, 1));
    await Deno.copyFile(picturePath(fromDb, fromUid, x.v), picturePath(toDb, toUid, x.v)).catch(() => {});   // its picture too, when it has one
    n++;
  }
  changed(toDb);
  return n;
}
export const hasUnsavedWork = async (dbDir: string, uid: string) => (await readDraft(dbDir, uid)) !== null;

// ── the continuous states ──

/** A continuous state of the work (the window sends one a minute or so while something changes). Its time is the server's. */
export class NoSuchScene extends Error {}
/** What a state shows, for comparing two: its document without when and by what it was written. */
const content = (doc: Record<string, unknown> | null) => doc ? JSON.stringify({ ...doc, uid: undefined, source: undefined, workAt: undefined, capturedAt: undefined, v: undefined }) : "";

export async function putWork(dbDir: string, uid: string, doc: Record<string, unknown>): Promise<{ at: string; bytes: number } | { skipped: "same" | "stale" }> {
  if (!UID.test(uid)) throw new Error("not a scene uid");
  // ONLY FOR A SCENE THIS DATABASE HOLDS (critic 2026-11-08, step 1, finding 1): a state for a deleted scene made a folder no
  // list showed, whose series could then never be deleted.
  const cur = await readJson(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`);
  if (!cur) throw new NoSuchScene("no such scene in this database");
  // TAKEN BEFORE THE NEWEST VERSION: not newer than it (finding 11). `capturedAt` is when the window took it.
  const newest = (await listVersions(dbDir, uid)).at(-1)?.producedAt ?? producedAt(cur) ?? "";
  if (typeof doc.capturedAt === "string" && doc.capturedAt <= newest) return { skipped: "stale" };
  // THE SAME AS THE LAST ONE: not written again (finding 6: an idle window wrote 720 identical states a night).
  const last = (await workStates(dbDir, uid)).at(-1);
  if (last && content(await readJson(last.path)) === content(doc)) return { skipped: "same" };
  await Deno.mkdir(workDir(dbDir, uid), { recursive: true });
  const at = new Date().toISOString();
  const text = JSON.stringify({ ...doc, uid, workAt: at }, null, 1);
  await writeAtomically(`${workDir(dbDir, uid)}/${at.replace(/:/g, "-")}.mrson.json`, text);
  changed(dbDir);
  return { at, bytes: new TextEncoder().encode(text).byteLength };
}

async function workStates(dbDir: string, uid: string): Promise<{ path: string; at: string }[]> {
  const out: { path: string; at: string }[] = [];
  try {
    for await (const e of Deno.readDir(workDir(dbDir, uid))) {
      const m = /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:\.\d+)?Z)\.mrson\.json$/.exec(e.name);
      if (m && e.isFile) out.push({ path: `${workDir(dbDir, uid)}/${e.name}`, at: m[1].replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3") });
    }
  } catch { /* none */ }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The draft: the newest continuous state after the newest version (unsaved work), or none. */
export async function readDraft(dbDir: string, uid: string): Promise<{ at: string; doc: Record<string, unknown> } | null> {
  if (!UID.test(uid)) return null;
  const newest = (await listVersions(dbDir, uid)).at(-1)?.producedAt ?? producedAt(await readJson(`${dbDir}/${SCENES_FOLDER}/${uid}.mrson.json`)) ?? "";
  const last = (await workStates(dbDir, uid)).at(-1);
  if (!last || last.at <= newest) return null;
  const doc = await readJson(last.path);
  if (!doc) return null;
  // The same as the newest version: nothing unsaved (finding 10).
  const vs = await listVersions(dbDir, uid);
  if (vs.length && content(await readVersion(dbDir, uid, vs.at(-1)!.v)) === content(doc)) return null;
  return { at: last.at, doc };
}

/** DISCARD THE DRAFT (the offer's "Discard it"; critic, finding 10): the states after the newest version go. */
export async function discardDraft(dbDir: string, uid: string): Promise<number> {
  if (!UID.test(uid)) return 0;
  const newest = (await listVersions(dbDir, uid)).at(-1)?.producedAt ?? "";
  let n = 0;
  for (const s of await workStates(dbDir, uid)) if (s.at > newest) { await Deno.remove(s.path).catch(() => {}); n++; }
  changed(dbDir);
  return n;
}

/** The states between two versions (those that led to a version deleted by hand) go with it (finding 10). */
export async function removeWorkBetween(dbDir: string, uid: string, after: string, upTo: string): Promise<void> {
  for (const s of await workStates(dbDir, uid)) if (s.at > after && s.at <= upTo) await Deno.remove(s.path).catch(() => {});
  changed(dbDir);
}

/** The continuous states before `before` go (Ron: they "can be removed"); small files, removed outright, not to the Trash. */
export async function pruneWork(dbDir: string, uid: string, before: string): Promise<number> {
  let n = 0;
  for (const s of await workStates(dbDir, uid)) if (s.at < before) { await Deno.remove(s.path).catch(() => {}); n++; }
  if (n) changed(dbDir);
  return n;
}

// ── what the versions use ──

export interface UseOfSeries { scene: string; name: string; v: number | "work" }

/** Every series named by any version or continuous state of any scene in this database, and by which. */
export async function seriesInUse(dbDir: string): Promise<Map<string, UseOfSeries[]>> {
  const hit = useCache.get(dbDir);
  if (hit) return new Map([...hit].map(([k, l]) => [k, [...l]]));
  const use = new Map<string, UseOfSeries[]>();
  const unreadable: string[] = [];
  const dir = `${dbDir}/${SCENES_FOLDER}`;
  const live = new Set<string>();   // scenes this database holds: a folder left by one deleted is not a use (finding 1)
  try { for await (const e of Deno.readDir(dir)) { const m = /^(2\.25\.\d+)\.mrson\.json$/.exec(e.name); if (m && e.isFile) live.add(m[1]); } } catch { /* none */ }
  const note = (doc: Record<string, unknown> | null, scene: string, v: number | "work", path: string) => {
    if (!doc) { unreadable.push(path); return; }
    for (const s of seriesNamed(doc)) {
      const l = use.get(s.uid) ?? []; l.push({ scene, name: String(doc.name ?? ""), v }); use.set(s.uid, l);
    }
  };
  try {
    for await (const e of Deno.readDir(dir)) {
      let m = /^(2\.25\.\d+)\.versions$/.exec(e.name);
      if (m && e.isDirectory) { if (live.has(m[1])) for (const x of await listVersions(dbDir, m[1])) note(await readVersion(dbDir, m[1], x.v), m[1], x.v, `${dir}/${e.name}/v${pad(x.v)}`); continue; }
      m = /^(2\.25\.\d+)\.work$/.exec(e.name);
      if (m && e.isDirectory) { if (live.has(m[1])) for (const s of await workStates(dbDir, m[1])) note(await readJson(s.path), m[1], "work", s.path); continue; }
      m = /^(2\.25\.\d+)\.mrson\.json$/.exec(e.name);
      if (m && e.isFile) { const doc = await readJson(`${dir}/${e.name}`); note(doc, m[1], Number(doc?.v) || 0, `${dir}/${e.name}`); }
    }
  } catch { /* no scenes */ }
  // FAIL CLOSED (finding 14): a version that cannot be read may name the series about to go; nothing is deleted then.
  if (unreadable.length) throw new Error(`a saved scene version cannot be read (${unreadable[0].split("/").slice(-2).join("/")}${unreadable.length > 1 ? ` and ${unreadable.length - 1} more` : ""}): nothing is deleted until it is looked at`);
  useCache.set(dbDir, use);
  return new Map([...use].map(([k, l]) => [k, [...l]]));
}

/** In words, for a refusal: "the scene “CT NEPHROGENIC” (version 3, version 4)". */
export function usedByWords(uses: UseOfSeries[]): string {
  const by = new Map<string, { name: string; vs: Set<string> }>();
  for (const u of uses) { const e = by.get(u.scene) ?? { name: u.name, vs: new Set<string>() }; e.vs.add(u.v === "work" ? "unsaved work" : `version ${u.v}`); by.set(u.scene, e); }
  return [...by.values()].map((e) => `the scene “${e.name}” (${[...e.vs].join(", ")})`).join("; ");
}
