// A SAVED SCENE INTO ITS DATABASE AS AN MRCOM OBJECT (Ron, 2026-10-29: the three scenes he keeps "must be converted to
// the new format ... thoroughly test the conversion and then convert now"). The scene (profile albula-scene/2) becomes one
// DICOM Secondary Capture in reference mode (logic/scene/mrcom-scene.ts, on Steve Pieper's writer), written to
// `SlicerAlbula-Scenes/MRCOM/` in the database folder and indexed in the scene's study like any DICOM object, its first
// scan recorded as what it was made from. The mrson file in the scene store stays what Albula opens today; this object is
// the scene's DICOM record, the form a hospital system keeps and sends.
//
// Writes go through the index's own writer (indexFilesIntoDatabase: one transaction, the audit, no orphans).
import { deleteSeriesFromDatabase, indexFilesIntoDatabase, type IndexMeta, provenancePathFor, seriesAttributes, setSeriesAttribute } from "./db-index.ts";
import { sqliteScript } from "./sqlite.ts";
import { sceneToMrcom, uidsInExtensions } from "../logic/scene/mrcom-scene.ts";
import { dicomIO, setDicomLibrary } from "../logic/dicom-io.ts";
import dcmjs from "../logic/dcmjs.ts";

// THE DICOM LIBRARY, HANDED OVER HERE: in the server there is no page to load it from, and dicomIO() refuses without it
// (logic/dicom-io.ts). The tests hand it over themselves, so they passed while the app's server wrote 26 objects and
// indexed none (2026-10-29, the first conversion; the same handover as desktop/brain-structures-job-main.ts).
setDicomLibrary(dcmjs);

type Obj = Record<string, unknown>;

/** Where the objects go, inside the database folder. */
export const MRCOM_FOLDER = "SlicerAlbula-Scenes/MRCOM";

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

async function firstFileOf(dbDir: string, seriesUID: string): Promise<string | undefined> {
  const raw = (await sqliteScript(`${dbDir}/ctkDICOM.sql`, `.mode json\nSELECT Filename AS file FROM Images WHERE SeriesInstanceUID=${q(seriesUID)} ORDER BY Filename LIMIT 1;`)).trim();
  const f = raw ? (JSON.parse(raw) as { file: string }[])[0]?.file : undefined;
  return f ? (f.startsWith("/") ? f : `${dbDir}/${f}`) : undefined;
}

async function fileOfInstance(dbDir: string, sop: string): Promise<string | undefined> {
  const raw = (await sqliteScript(`${dbDir}/ctkDICOM.sql`, `.mode json\nSELECT Filename AS file FROM Images WHERE SOPInstanceUID=${q(sop)};`)).trim();
  const f = raw ? (JSON.parse(raw) as { file: string }[])[0]?.file : undefined;
  return f ? (f.startsWith("/") ? f : `${dbDir}/${f}`) : undefined;
}

/**
 * A file's SOP class (the index does not keep it), from its file meta information: the group (0002) every Part 10 file
 * starts with, always explicit VR little endian, so it is read here from the first few hundred bytes without parsing the
 * file (a diffusion file is hundreds of megabytes). Media Storage SOP Class UID (0002,0002) is Type 1 in it.
 */
export async function sopClassOf(path: string): Promise<string | undefined> {
  const f = await Deno.open(path);
  try {
    const head = new Uint8Array(4096);
    const n = await f.read(head) ?? 0;
    if (n < 132 || String.fromCharCode(...head.subarray(128, 132)) !== "DICM") return undefined;
    const v = new DataView(head.buffer, 0, n);
    let at = 132;
    while (at + 8 <= n && v.getUint16(at, true) === 0x0002) {
      const el = v.getUint16(at + 2, true), vr = String.fromCharCode(head[at + 4], head[at + 5]);
      const long = ["OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UN", "UR", "UT", "OV"].includes(vr);
      const len = long ? v.getUint32(at + 8, true) : v.getUint16(at + 6, true);
      const start = at + (long ? 12 : 8);
      if (el === 0x0002) return new TextDecoder().decode(head.subarray(start, Math.min(start + len, n))).replace(/[\0 ]+$/, "");
      at = start + len;
    }
    return undefined;
  } finally { f.close(); }
}

export interface StoredScene { sopInstanceUID: string; seriesInstanceUID: string; rel: string; bytes: number; indexed: boolean; error?: string }

/** Write the scene as an MRCOM object into the database at `dbDir` and index it. */
export async function storeSceneAsMrcom(dbDir: string, doc: Obj, producerVersion: string): Promise<StoredScene> {
  const nodes = Object.values((doc.nodes as Record<string, Obj>) ?? {});
  const image = nodes.find((n) => n.type === "image");
  const first = ((image?.dicom as Obj | undefined)?.instances as string[] | undefined)?.[0];
  if (!image || !first) throw new Error("the scene names no scan by its instances (profile albula-scene/2 is needed)");
  const refPath = await fileOfInstance(dbDir, first);
  if (!refPath) throw new Error(`the scene's first scan (instance ${first}) is not in this database`);
  const classes: Record<string, string> = {};
  for (const n of nodes) {
    const uid = (n.dicom as Obj | undefined)?.seriesInstanceUID as string | undefined;
    if (!uid || classes[uid]) continue;
    const f = await firstFileOf(dbDir, uid);
    const c = f ? await sopClassOf(f) : undefined;
    if (c) classes[uid] = c;
  }
  // The build stamp as the software version, within LO's 64 characters (dciodvfy: "Length invalid for this VR = 67";
  // the full stamp stays in the scene, source.producer).
  const version = producerVersion.replace(/^SlicerAlbula\s+/, "").replace(/\s*·.*$/, "").slice(0, 64);
  // The series the extensions' state names and this database holds (a tract set), referenced with every instance.
  const extra: { seriesInstanceUID: string; sopClassUID?: string; instances: string[] }[] = [];
  const named = new Set(nodes.map((n) => (n.dicom as Obj | undefined)?.seriesInstanceUID as string | undefined));
  for (const uid of uidsInExtensions(doc)) {
    if (named.has(uid)) continue;
    const raw = (await sqliteScript(`${dbDir}/ctkDICOM.sql`, `.mode json\nSELECT SOPInstanceUID AS sop, Filename AS file FROM Images WHERE SeriesInstanceUID=${q(uid)} ORDER BY SOPInstanceUID;`)).trim();
    const rows = raw ? JSON.parse(raw) as { sop: string; file: string }[] : [];
    if (!rows.length) continue;   // not a series here (another UID the state carries)
    const f = rows[0].file.startsWith("/") ? rows[0].file : `${dbDir}/${rows[0].file}`;
    extra.push({ seriesInstanceUID: uid, sopClassUID: await sopClassOf(f), instances: rows.map((r) => r.sop) });
  }
  const w = await sceneToMrcom(doc, Deno.readFileSync(refPath), version, classes, extra);
  const dir = `${dbDir}/${MRCOM_FOLDER}`;
  await Deno.mkdir(dir, { recursive: true });
  const name = `${w.sopInstanceUID}.dcm`;
  const tmp = `${dir}/.${name}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try { await Deno.writeFile(tmp, w.bytes); await Deno.rename(tmp, `${dir}/${name}`); }
  catch (e) { await Deno.remove(tmp).catch(() => {}); throw e; }
  const rel = `${MRCOM_FOLDER}/${name}`;
  // FROM HERE ON A FAILURE TAKES THE FILE BACK: a file on disk that the index does not list is an orphan (it happened).
  try {
  const ds = (await dicomIO()).readFile(w.bytes.slice().buffer as ArrayBuffer).dict;
  const v = (tag: string) => (ds[tag]?.Value?.[0] as string | number | undefined);
  const primary = (image.dicom as Obj).seriesInstanceUID as string;
  const meta: IndexMeta = {
    sopInstanceUID: w.sopInstanceUID, seriesInstanceUID: w.seriesInstanceUID, studyInstanceUID: w.studyInstanceUID,
    modality: String(v("00080060") ?? "OT"), seriesNumber: v("00200011"), seriesDate: v("00080021") as string | undefined,
    seriesTime: v("00080031") as string | undefined, seriesDescription: v("0008103E") as string | undefined,
    displayedSize: `${w.pixels.columns}x${w.pixels.rows}`,
    derivedFrom: { parentSeriesUID: primary, kind: "scene", label: String(doc.name ?? "scene") },
  };
  const r = await indexFilesIntoDatabase(dbDir, [{ file: rel, meta }]);
  if (!r.indexed) await Deno.remove(`${dir}/${name}`).catch(() => {});
  return { sopInstanceUID: w.sopInstanceUID, seriesInstanceUID: w.seriesInstanceUID, rel, bytes: w.bytes.byteLength, indexed: r.indexed, ...(r.error ? { error: r.error } : {}) };
  } catch (e) {
    await Deno.remove(`${dir}/${name}`).catch(() => {});
    throw e;
  }
}

/** The series fact that ties an object to its scene: the scene's uid. */
export const SCENE_UID_KEY = "sceneUID";

/** The scene objects this database holds for one scene (normally one; more only after an interrupted save). */
async function objectsOf(dbDir: string, sceneUid: string): Promise<string[]> {
  let attrs: { uid: string; key: string; value: string }[] = [];
  try { attrs = await seriesAttributes(provenancePathFor(dbDir)); } catch { return []; }
  const named = attrs.filter((a) => a.key === SCENE_UID_KEY && a.value === sceneUid).map((a) => a.uid);
  if (!named.length) return [];
  const list = named.map(q).join(",");
  const raw = (await sqliteScript(`${dbDir}/ctkDICOM.sql`, `.mode json\nSELECT SeriesInstanceUID AS uid FROM Series WHERE SeriesInstanceUID IN (${list});`)).trim();
  return raw ? (JSON.parse(raw) as { uid: string }[]).map((r) => r.uid) : [];
}

export interface SyncResult { stored?: StoredScene; removed: string[]; error?: string }

/**
 * KEEP THE SCENE'S DICOM OBJECT IN STEP WITH ITS FILE (Ron, 2026-10-29: archive "only the final version, if there is more
 * than one of the same thing"; "conversion everything, period"). `doc` is the scene as just saved (null: the scene was
 * deleted). The object or objects this database holds for the scene go, files and index rows, and the new one is written
 * and tied to the scene by the series fact `sceneUID`. A version 1 file gets no object (it names no instances). A failure
 * here never fails the scene's own save: it is returned for the caller to say.
 */
export async function syncSceneMrcom(dbDir: string, sceneUid: string, doc: Obj | null, producerVersion: string): Promise<SyncResult> {
  const removed: string[] = [];
  try {
    for (const uid of await objectsOf(dbDir, sceneUid)) {
      await deleteSeriesFromDatabase(dbDir, uid);
      await setSeriesAttribute(provenancePathFor(dbDir), uid, SCENE_UID_KEY, "", "albula-scene");
      removed.push(uid);
    }
    const v2 = Array.isArray(doc?.extensionsUsed) && (doc!.extensionsUsed as string[]).includes("albula-scene/2");
    if (!doc) return { removed };
    // A VERSION 1 FILE (saved by an older Albula, over sharing or from an older package) names no instances, so no object
    // can be written for it; the old object went with the old version, and that is SAID, not silent (the critic,
    // 2026-10-29, data architecture finding 4).
    if (!v2) {
      const error = "saved in the older scene form (profile albula-scene/1, an older Albula): its DICOM copy was removed and is written again the next time this version saves the scene";
      console.error(`scene ${sceneUid}: ${error}`);
      return { removed, error };
    }
    const stored = await storeSceneAsMrcom(dbDir, { ...doc, uid: sceneUid }, producerVersion);
    if (stored.indexed) await setSeriesAttribute(provenancePathFor(dbDir), stored.seriesInstanceUID, SCENE_UID_KEY, sceneUid, "albula-scene");
    return { stored, removed, ...(stored.indexed ? {} : { error: stored.error ?? "the scene's DICOM object was not indexed" }) };
  } catch (e) {
    console.error(`scene ${sceneUid}: its DICOM copy: ${(e as Error).message}`);
    return { removed, error: (e as Error).message };
  }
}
