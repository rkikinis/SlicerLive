// Serving DICOM databases the user has registered, by setting rather than by symlink.
//
// Ron: "Albula should remember what data base I was working with last time. It should also
// display the full path. The subject data base should not be hardwired anywhere."
//
// The third is the one that changes the design. Until now the gallery contained
// `src/live/dicomdb`, a SYMLINK into one particular database, and the page asked for `/dicomdb/`.
// That is a hardwiring in the worst place: a path to a specific person's data, baked into the
// served tree, invisible unless you run `ls -la`, and impossible to change without touching the
// checkout. It also meant the app could only ever see one database.
//
// So: registered databases live in the settings file, which is human-readable and hand-editable,
// and this serves whichever the user selected:
//
//   [Database]
//   current=albula
//   albula=/Users/somebody/Desktop/SlicerAlbula/Slicer/SlicerDICOMDatabase
//   project2=/Volumes/scratch/another-database
//
// Any key other than `current` is a database: its name on the left, its FULL PATH on the right.
// That shape is also the answer to a requirement Ron recorded earlier -- several databases, one per
// project, where Slicer itself has only one global setting and switches it by mutating it in place.
//
// GET /_db            what is registered, with full paths, and which is current
// PUT /_db            change the current one, or register a path
// GET /_db/<id>/<rel> a file from that database, Range honored so a header read stays a header read
import { serveDir } from "jsr:@std/http@1/file-server";
import { COPY_FOLDER } from "./duckn-copy-code.ts";
import { copyStatus } from "./duckn-copy-check.ts";
import { auditDatabase, cohorts, createCohort, deleteCohort, deleteSeriesFromDatabase, setCohortMembers, type CohortLevel, indexFilesIntoDatabase, provenanceEdges, seriesAttributes, setSeriesAttribute, seriesSizes, type IndexMeta } from "./db-index.ts";
import { handleSceneRoutes } from "./scenes.ts";
import { picturesFolder } from "./pictures.ts";
import { isAbsolute, join, normalize } from "jsr:@std/path@1";
import { parseIni } from "../logic/settings.ts";
import { readSettings, resolveSettingsPath, writeSettings } from "./settings-file.ts";

const SECTION = "Database";

export interface RegisteredDb {
  id: string;
  /** The full path, which is what the user is shown. */
  path: string;
  exists: boolean;
  current: boolean;
}

async function ini(galleryRoot?: string) {
  const p = resolveSettingsPath(galleryRoot);
  return { path: p, ini: parseIni(await readSettings(p)) };
}

/**
 * What is registered.
 *
 * A database whose directory has gone is still listed, marked `exists: false`, because a disk that
 * is not mounted today is not the same thing as a database the user never registered — and silently
 * dropping it would lose the path they would need to put it back.
 */
export async function registeredDatabases(galleryRoot?: string): Promise<RegisteredDb[]> {
  const { ini: cfg } = await ini(galleryRoot);
  const sec = cfg.get(SECTION) ?? new Map<string, string>();
  const current = sec.get("current") ?? "";
  const out: RegisteredDb[] = [];
  for (const [id, path] of sec) {
    if (id === "current" || !path) continue;
    let exists = false;
    try {
      exists = Deno.statSync(join(path, "ctkDICOM.sql")).isFile;
    } catch { /* not there, or not readable */ }
    out.push({ id, path, exists, current: id === current });
  }
  // A single registered database is current whether or not anything said so.
  if (out.length === 1) out[0].current = true;
  return out;
}

/** Register a path, or change which is current. Returns the list as it now stands. */
export async function updateDatabases(
  galleryRoot: string | undefined,
  change: { register?: { id: string; path: string }; current?: string },
): Promise<RegisteredDb[]> {
  const { path: file, ini: cfg } = await ini(galleryRoot);
  const sec = cfg.get(SECTION) ?? new Map<string, string>();
  cfg.set(SECTION, sec);
  if (change.register) sec.set(change.register.id, change.register.path);
  if (change.current) sec.set("current", change.current);
  // Written through the same store as everything else, so one file holds the whole application's
  // state and a person can read it.
  const { formatIni } = await import("../logic/settings.ts");
  await writeSettings(file, formatIni(cfg));
  return await registeredDatabases(galleryRoot);
}

/**
 * `/_db` and `/_db/<id>/<rel>`, or null if this is not one.
 *
 * A registered path is a directory the user named, so a request under it is confined to it: the
 * relative part is normalized and rejected if it climbs out. The server holds the only mapping from
 * an id to a path, so a page cannot ask for a directory nobody registered.
 */
/**
 * WHAT THIS SERVER CAN DO, so a page never starts work it cannot finish.
 *
 * The page and the binary are built by two different commands. The JS reloads with the window; the
 * server is compiled into the .app and only changes when someone recompiles it -- and for five days
 * nobody did. So the crop tool's "Put it in the DICOM database" POSTed 258 files to a server that
 * had the write route but not the batch index route, wrote 39 MB, and was refused at the last step.
 * Ron: "so save to dicom failed silently! That is bad."
 *
 * A version number would not have helped: the two halves legitimately differ in age. What the page
 * needs to know is whether the ROUTE IT IS ABOUT TO USE exists, and that is a question this server
 * can answer about itself. Names are added here when a route gains a capability; a page checks for
 * the one it needs and says what to do when it is missing.
 */
const FEATURES = [
  "write",         // POST /_db/<id>/_write/<name>
  "write-kind",    // ...?kind=image, choosing the volumes folder over the SEG one
  "write-delete",  // DELETE /_db/<id>/_write/<name>, so a failed save can take its files back
  "index",         // POST /_db/<id>/_index  { file, meta }
  "write-index",   // POST /_db/<id>/_write/<name> with an x-albula-index header: written AND indexed in one request
  "index-batch",   // POST /_db/<id>/_index  { files: [...] } -- one series, one transaction
  "delete-series",  // DELETE /_db/<id>/_series/<uid>
  "provenance",
  "attributes",    // _provenance carries attributes; PUT /_db/<id>/_attribute sets one
  "sizes",         // GET /_db/<id>/_sizes -- bytes per series
  "zarrcopy",      // GET /_db/<id>/_zarr/<uid> -- a grayscale series' duckn working copy, validated; pieces through /_db/<id>/<rel>
  "scenes",        // GET /_db/<id>/_scenes, GET/PUT/DELETE /_db/<id>/_scene/<uid> -- saved scenes (desktop/scenes.ts)
  "cohorts",       // GET /_db/<id>/_cohorts; PUT /_db/<id>/_cohort/<name> {add, remove}; DELETE /_db/<id>/_cohort/<name>
  "audit",
  "checkpoints",
];

export async function handleDbRequest(req: Request, galleryRoot?: string): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/_db" && !url.pathname.startsWith("/_db/")) return null;

  if (url.pathname === "/_db") {
    if (req.method === "PUT" || req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { id?: string; path?: string; current?: string };
      if (body.path && !isAbsolute(body.path)) {
        return Response.json({ error: "a database path must be absolute" }, { status: 400 });
      }
      const list = await updateDatabases(galleryRoot, {
        register: body.id && body.path ? { id: body.id, path: body.path } : undefined,
        current: body.current ?? (body.id && body.path ? body.id : undefined),
      });
      return Response.json({ databases: list, features: FEATURES }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ databases: await registeredDatabases(galleryRoot), features: FEATURES }, {
      headers: { "cache-control": "no-store" },
    });
  }

  // POST /_db/<id>/_write/<name> — write one file into a registered database directory.
  //
  // The DICOM SEG export had no way to put a file anywhere in the native app: WKWebView has neither
  // the File System Access API nor a working `<a download>` for a blob, so a 950 MB segmentation was
  // "saved" to nowhere and the page had no way to tell. Ron ran the whole loop -- load, segment,
  // save, import -- and the database was unchanged: "No segmentation".
  //
  // Confined the same way reads are: into `SlicerAlbula-SEG/` under the registered directory, with
  // a name stripped of anything but the characters a DICOM SOP instance UID filename needs, so a
  // page cannot choose the path. Deliberately a SUBFOLDER, not the database's own `dicom/` tree:
  // adding files there without the matching ctkDICOM.sql rows is the half-state we chose to avoid.
  const write = /^\/_db\/([^/]+)\/_write\/(.+)$/.exec(url.pathname);
  if (write && (req.method === "POST" || req.method === "DELETE")) {
    const wid = decodeURIComponent(write[1]);
    const wdb = (await registeredDatabases(galleryRoot)).find((d) => d.id === wid);
    if (!wdb) return Response.json({ error: `no database registered as "${wid}"` }, { status: 404 });
    const name = decodeURIComponent(write[2]).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!name || name.startsWith(".")) return Response.json({ error: "bad filename" }, { status: 400 });
    // WHICH of the two folders, chosen from a fixed pair rather than from the caller's text: a
    // derived IMAGE series is a few hundred instances and does not belong in a folder called SEG,
    // and the folder is still not something a page can name. `rel` is handed back so the caller does
    // not have to reconstruct the index's relative path by slicing strings.
    const sub = url.searchParams.get("kind") === "image" ? "SlicerAlbula-Volumes" : "SlicerAlbula-SEG";
    const dir = `${wdb.path}/${sub}`;
    // TAKING ONE BACK. A save that writes a few hundred instances and then fails to index them has
    // left that many orphans in a database whose standing rule is "no orphans, no zombies" -- and
    // they are invisible, because the browser lists what the INDEX holds. So the writer can undo its
    // own writes: same confined folder, same sanitized name, and a file that is already gone is a
    // success rather than an error, since the caller's goal is that it not be there.
    if (req.method === "DELETE") {
      try {
        await Deno.remove(`${dir}/${name}`);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) return Response.json({ error: (e as Error).message }, { status: 500 });
      }
      return Response.json({ removed: `${sub}/${name}` });
    }
    // WRITE AND INDEX IN ONE REQUEST when the page sends the index record along (the
    // `x-albula-index` header, JSON). The page used to write, get the answer, then ask for the
    // index in a second request -- and on 2026-09-18 the page died between the two (a 291 MB
    // whole-body surfaces object in a browser with a 4 GB renderer), leaving the file on disk,
    // unindexed, invisible to the browser and an orphan to the audit. With the record in the
    // same request the server finishes the job whether or not the page lives to hear the answer.
    // A record that fails to index takes the file back out, so a failed save leaves nothing.
    const indexHeader = req.headers.get("x-albula-index");
    try {
      await Deno.mkdir(dir, { recursive: true });
      const bytes = new Uint8Array(await req.arrayBuffer());
      await Deno.writeFile(`${dir}/${name}`, bytes);
      const written = { path: `${dir}/${name}`, dir, rel: `${sub}/${name}`, bytes: bytes.byteLength };
      if (!indexHeader) return Response.json(written);
      let meta: IndexMeta;
      try { meta = JSON.parse(decodeURIComponent(indexHeader)) as IndexMeta; } catch { await Deno.remove(`${dir}/${name}`).catch(() => {}); return Response.json({ error: "the index record is not JSON" }, { status: 400 }); }
      try {
        const r = await indexFilesIntoDatabase(wdb.path, [{ file: written.rel, meta }]);
        return Response.json({ ...written, ...r });
      } catch (e) {
        await Deno.remove(`${dir}/${name}`).catch(() => {});
        return Response.json({ ...written, indexed: false, error: `written, then refused by the index and taken back: ${(e as Error).message}` }, { status: 409 });
      }
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // CHECKPOINTS — a result put on disk the moment it arrives, before anything can lose it.
  //
  // Ron, 2026-09-05, after a TotalSegmentator run vanished: "The TS segmentation for nephrogenic ran
  // and I was about to go to save, when all the data disappeared." A result lived only in the page
  // until someone pressed Save, so a reloaded renderer took the whole run with it. Twenty-eight
  // seconds is cheap to redo; the same loss on a long run is not.
  //
  // Its own directory, NOT SlicerAlbula-SEG: what lands here is the segmenter's raw output, not a
  // DICOM object, and the audit's orphan scan should never have to reason about it. A checkpoint is
  // a file plus a `.json` sidecar naming what it is; nothing is indexed and the database itself is
  // never touched, which is what makes writing one unconditionally safe.
  const CHECKPOINTS = "SlicerAlbula-Checkpoints";
  /**
   * How many results are kept, and for how long. Ron: "Having a buffer of 1N sounds like a
   * reasonable approach, perhaps with time based deletion after 24 hours."
   *
   * A ts:total is around 150 MB, so an unbounded folder is a slow disk leak on a workspace that
   * already holds ~18 GB of imaging. Both limits apply, whichever bites first: the newest few
   * survive, and nothing survives a day. A checkpoint is a safety net for the hours between a run
   * finishing and it being saved — past that, keeping it is hoarding, and Save is what makes a
   * result permanent.
   */
  const KEEP_NEWEST = 5;
  const KEEP_MS = 24 * 60 * 60 * 1000;

  /**
   * Delete what is past either limit. Never touches `keep`, the file just written: a clock that is
   * wrong, or a run longer than the window, must not delete the result it was protecting.
   */
  async function pruneCheckpoints(dir: string, keep: string): Promise<void> {
    const found: { file: string; at: number }[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        try {
          const m = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`)) as { file?: string; at?: string };
          if (m.file) found.push({ file: m.file, at: Date.parse(m.at ?? "") || 0 });
        } catch { /* unreadable sidecar: left alone rather than guessed at */ }
      }
    } catch {
      return;
    }
    found.sort((a, b) => b.at - a.at);
    const now = Date.now();
    const doomed = found.filter((f, i) => f.file !== keep && (i >= KEEP_NEWEST || now - f.at > KEEP_MS));
    for (const d of doomed) {
      await Deno.remove(`${dir}/${d.file}`).catch(() => {});
      await Deno.remove(`${dir}/${d.file}.json`).catch(() => {});
    }
  }

  // THE SCENE STORE: /_db/<id>/_scenes and /_db/<id>/_scene/<uid> (desktop/scenes.ts).
  const sc = /^\/_db\/([^/]+)\/_scenes?(?:\/|$)/.exec(url.pathname);
  if (sc) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(sc[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const r = await handleSceneRoutes(req, url, encodeURIComponent(db.id), db.path, () => picturesFolder(galleryRoot));
    if (r) return r;
  }

  // THE DUCKN WORKING COPY of a grayscale series (desktop/duckn-copy.ts; the workspace brief is
  // Contents/docs/DUCKN-WORKING-COPY.md): its group and array descriptions in one answer, or 404 with
  // the reason. Valid only when this code wrote it and the series' files are what they were -- the
  // same stamp for every derived copy (desktop/series-files.ts). A copy that is not valid is left where it is (rebuilding
  // is the sweep's job, step 3) and the page reads the DICOM files instead. The pieces themselves
  // come through the ordinary file route, /_db/<id>/SlicerAlbula-Zarr/<uid>.zarr/<frame>/c/k/j/i.
  const zc = /^\/_db\/([^/]+)\/_zarr\/([0-9][0-9.]{0,63})$/.exec(url.pathname);
  if (zc && req.method === "GET") {
    const no = (error: string) => Response.json({ error }, { status: 404, headers: { "cache-control": "no-store" } });
    try {
      const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(zc[1]));
      if (!db) return no("no such database");
      const uid = zc[2];
      // The same verdict the sweep uses (desktop/duckn-copy-check.ts).
      const st = await copyStatus(db.path, uid);
      if (!st.valid) return no(st.why);
      const { group, dir } = st;
      // THE PAGE GETS WHAT IT READS (critic, 2026-09-25, finding 13): Albula's part and the array's own fields. The DICOM
      // tags and each slice's keyword view (Michael Halle's layout, kept in the copy for his readers) are left out of what
      // is sent -- 16 MB of the 16.8 MB for the public Philips fMRI.
      const forPage = (a: { attributes?: { duckn?: { extensions?: { albula?: unknown } } } }) =>
        ({ ...a, attributes: { ...a.attributes, duckn: { extensions: { albula: a.attributes?.duckn?.extensions?.albula } } } });
      const arrays = await Promise.all(group.frames.map(async (f) => forPage(JSON.parse(await Deno.readTextFile(`${dir}/${f}/zarr.json`)))));
      return Response.json({ group, arrays, base: `${COPY_FOLDER}/${uid}.zarr` }, { headers: { "cache-control": "no-store" } });
    } catch (e) {
      return no(`the copy could not be read: ${(e as Error).message}`);
    }
  }

  const cpList = /^\/_db\/([^/]+)\/_checkpoints$/.exec(url.pathname);
  if (cpList) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(cpList[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const dir = `${db.path}/${CHECKPOINTS}`;
    const out: Record<string, unknown>[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        try {
          const meta = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`)) as Record<string, unknown>;
          const st = await Deno.stat(`${dir}/${meta.file}`).catch(() => null);
          if (st) {
            out.push({ ...meta, bytes: st.size, url: `/_db/${encodeURIComponent(db.id)}/${CHECKPOINTS}/${meta.file}` });
          }
        } catch { /* a half-written sidecar is not a reason to fail the whole listing */ }
      }
    } catch { /* no checkpoints yet: an empty list, not an error */ }
    out.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    return Response.json({ checkpoints: out });
  }

  const cp = /^\/_db\/([^/]+)\/_checkpoint\/(.+)$/.exec(url.pathname);
  if (cp && (req.method === "POST" || req.method === "DELETE")) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(cp[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const name = decodeURIComponent(cp[2]).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!name || name.startsWith(".")) return Response.json({ error: "bad filename" }, { status: 400 });
    const dir = `${db.path}/${CHECKPOINTS}`;
    try {
      if (req.method === "DELETE") {
        await Deno.remove(`${dir}/${name}`).catch(() => {});
        await Deno.remove(`${dir}/${name}.json`).catch(() => {});
        return Response.json({ removed: name });
      }
      await Deno.mkdir(dir, { recursive: true });
      const meta = req.headers.get("x-checkpoint-meta");
      const bytes = new Uint8Array(await req.arrayBuffer());
      await Deno.writeFile(`${dir}/${name}`, bytes);
      // The sidecar is written SECOND and names the payload, so a listing can never offer a
      // checkpoint whose bytes are still being written.
      if (meta) {
        await Deno.writeTextFile(`${dir}/${name}.json`, JSON.stringify({ ...JSON.parse(meta), file: name }, null, 2));
      }
      // Pruned AFTER the new one is safely on disk, so a failure here leaves too many rather than
      // too few — and never before, which would make room by deleting the older result first.
      await pruneCheckpoints(dir, name);
      return Response.json({
        path: `${dir}/${name}`,
        dir,
        bytes: bytes.byteLength,
        keepNewest: KEEP_NEWEST,
        keepHours: KEEP_MS / 3600000,
      });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // POST /_db/<id>/_index  { file, meta } or { files: [{file, meta}] }  — put already-written
  //                        file(s) INTO the index. A list is one series, indexed in one transaction.
  // GET  /_db/<id>/_audit             — zombies and orphans, the two failure modes the audit names.
  const idx = /^\/_db\/([^/]+)\/_index$/.exec(url.pathname);
  if (idx && req.method === "POST") {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(idx[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const body = await req.json().catch(() => null) as
      { file?: string; meta?: IndexMeta; files?: { file: string; meta: IndexMeta }[] } | null;
    const list = body?.files ?? (body?.file && body?.meta ? [{ file: body.file, meta: body.meta }] : null);
    if (!list?.length) return Response.json({ error: "file and meta, or files, are required" }, { status: 400 });
    try {
      const r = await indexFilesIntoDatabase(db.path, list);
      return Response.json(r);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 409 });
    }
  }
  // DELETE /_db/<id>/_series/<uid> — take one series out: rows, files and derivation edge.
  //
  // Ron: "One thing that I still don't know: how to delete a data set in the dicom data base."
  // Nothing owned the archive. `deleteSeriesFromDatabase` was written on 2026-09-05 -- backup,
  // one transaction, files only when no surviving row references them, then an audit -- and had zero
  // callers, so the answer to his question was genuinely "you cannot". This is the route; the DICOM
  // browser is the caller.
  const del = /^\/_db\/([^/]+)\/_series\/([0-9][0-9.]{0,63})$/.exec(url.pathname);
  if (del && req.method === "DELETE") {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(del[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    try {
      return Response.json(await deleteSeriesFromDatabase(db.path, del[2]));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 409 });
    }
  }

  // GET /_db/<id>/_provenance — the derivation chain for the series in this database.
  //
  // provenance.sqlite is the DICOM database directory's SIBLING, not a file inside it, so it cannot
  // come through the confined file route above (and should not: that confinement is what stops a
  // page naming arbitrary paths). It gets its own route, which reads one known filename next to a
  // registered database and returns edges — never a path the caller chose.
  const prov = /^\/_db\/([^/]+)\/_provenance$/.exec(url.pathname);
  if (prov) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(prov[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const path = `${db.path.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/provenance.sqlite`;
    try {
      await Deno.stat(path);
    } catch {
      return Response.json({ edges: [], note: "no provenance.sqlite beside this database" });
    }
    try {
      // Attributes ride along with the edges: one round trip, one file, and the browser already asks.
      return Response.json({ edges: await provenanceEdges(path), attributes: await seriesAttributes(path) });
    } catch (e) {
      return Response.json({ edges: [], attributes: [], error: (e as Error).message });
    }
  }

  // COHORTS (db-index.ts): a person's grouping of patients and studies, in the provenance store.
  const coh = /^\/_db\/([^/]+)\/_cohorts$/.exec(url.pathname);
  const cohOne = /^\/_db\/([^/]+)\/_cohort\/([^/]+)$/.exec(url.pathname);
  if ((coh && req.method === "GET") || (cohOne && (req.method === "PUT" || req.method === "DELETE"))) {
    const id = decodeURIComponent((coh ?? cohOne)![1]);
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === id);
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const path = `${db.path.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/provenance.sqlite`;
    try {
      if (coh) return Response.json({ cohorts: await cohorts(path) });
      const name = decodeURIComponent(cohOne![2]);
      if (req.method === "DELETE") { await deleteCohort(path, name); return Response.json({ ok: true }); }
      const body = await req.json().catch(() => ({})) as { add?: { level: CohortLevel; uid: string }[]; remove?: { level: CohortLevel; uid: string }[] };
      if (!body.add?.length && !body.remove?.length) await createCohort(path, name);
      else await setCohortMembers(path, name, body.add ?? [], body.remove ?? []);
      return Response.json({ ok: true, cohorts: await cohorts(path) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // PUT /_db/<id>/_attribute  {uid, key, value}  -- a person's word on a series, e.g. its collection.
  // An empty value removes the row. Written to the provenance store, never to Slicer's index.
  const attr = /^\/_db\/([^/]+)\/_attribute$/.exec(url.pathname);
  if (attr && req.method === "PUT") {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(attr[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const path = `${db.path.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/provenance.sqlite`;
    const body = await req.json().catch(() => ({})) as { uid?: string; key?: string; value?: string; source?: string };
    if (!body.uid || !body.key) return Response.json({ error: "uid and key required" }, { status: 400 });
    try {
      // `source` says who is speaking: a person (the default, and the only one the lookup never
      // overwrites) or the application recording what a server reported ("haversack").
      await setSeriesAttribute(path, body.uid, body.key, body.value ?? "", body.source === "haversack" ? "haversack" : "user");
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // GET /_db/<id>/_sizes -- bytes per series, from the files. Cached against the index's mtime.
  const sz = /^\/_db\/([^/]+)\/_sizes$/.exec(url.pathname);
  if (sz) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(sz[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    try {
      return Response.json({ sizes: await seriesSizes(db.path) });
    } catch (e) {
      return Response.json({ sizes: {}, error: (e as Error).message });
    }
  }

  const aud = /^\/_db\/([^/]+)\/_audit$/.exec(url.pathname);
  if (aud) {
    const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === decodeURIComponent(aud[1]));
    if (!db) return Response.json({ error: "no such database" }, { status: 404 });
    const scope = url.searchParams.get("scope") === "written-folder" ? "written-folder" as const : "whole-database" as const;
    try {
      return Response.json(await auditDatabase(db.path, { scope }));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  const rest = url.pathname.slice("/_db/".length);
  const slash = rest.indexOf("/");
  const id = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
  const rel = slash < 0 ? "" : rest.slice(slash + 1);
  const db = (await registeredDatabases(galleryRoot)).find((d) => d.id === id);
  if (!db) return Response.json({ error: `no database registered as "${id}"` }, { status: 404 });

  // Confine to the registered directory. `normalize` collapses any .. before it is joined, so a
  // request cannot walk out of the database the user named.
  const safe = normalize("/" + rel).slice(1);
  if (!safe || safe.startsWith("..")) return Response.json({ error: "bad path" }, { status: 400 });

  // serveDir handles Range, which is what keeps readHead a 4 KB read against a 347 MB file. The
  // INDEX must not be cached -- a de-identified database that still shows the old names is the bug
  // this note exists to prevent -- while the image files are large, unchanging and worth caching.
  //
  // AND THE IMAGE FILES MUST BE ASKED ABOUT BEFORE A CACHED ONE IS USED ("no-cache": revalidate, a
  // short 304 when nothing changed). With no directive a browser keeps them by its own rule of
  // thumb, and a file rewritten on disk was served from the cache: the DICOM load showed the old
  // image, and the check that compares a duckn copy with its DICOM said "same" against a stale file
  // (critic, 2026-09-23, finding 11). The copies' pieces carry their own name in the address and
  // are unaffected either way.
  const res = await serveDir(new Request(new URL("/" + safe, url.origin), req), { fsRoot: db.path, quiet: true });
  const headers = new Headers(res.headers);
  headers.set("cache-control", /\.(sql|sqlite|db)$/i.test(safe) ? "no-store" : "no-cache");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
