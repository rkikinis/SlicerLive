// Read an existing ctkDICOMDatabase (the DICOM database 3D Slicer keeps) directly, instead of
// rescanning a directory tree. Slicer already built an index of every patient/study/series and the
// file each instance lives in; ctkDICOM.sql is a plain SQLite file, so we can list the whole
// database instantly and parse ONLY the files of the series actually opened.
//
// This is the difference between reading 66,000 files to browse a database and reading the ~70
// belonging to the one series you clicked (dicom-local.ts's indexDirectory does the former, and
// keeps every parsed instance — pixels included — in memory).
//
// ctkDICOMDatabase records each instance's path either relative to the database directory (files
// copied into the database) or absolute (files indexed in place, wherever they live on that
// machine). Only the relative ones are reachable through a granted directory handle, so a series
// whose files are external is listed but marked unavailable rather than silently missing.
import { type FrameTiming, groupSeries, lastSkipReasons, parseInstances, reconstructSeries, volumesOfSeries } from "./dicom-series.ts";
import type { Volume } from "./nifti.ts";

// THE SERVER READS THE INDEX, the page asks it (2026-10-14; Ron: fewer dependencies). Until then the page downloaded the
// whole ctkDICOM.sql (15 MB for the main database) on every open and read it with sql.js; the server has SQLite inside it
// now (desktop/sqlite.ts) and answers the same three questions: the series list, the counts, one series' files
// (desktop/db-listing.ts, the same SQL). sql.js is gone.

export interface DbSeriesEntry {
  seriesInstanceUID: string;
  studyInstanceUID?: string;
  patientName?: string;
  patientID?: string;
  studyDescription?: string;
  studyDate?: string;
  seriesNumber?: number;
  /** `SeriesDate`/`SeriesTime`, as DICOM writes them (YYYYMMDD / HHMMSS).
   *
   *  WHEN THIS SERIES WAS MADE, which for a derived one is the only thing that tells three of them
   *  apart. Ron, after saving several crops of the same study: "How do I know which one it is? Date
   *  and time of the creation would help." The columns were always in the index; nothing selected
   *  them, so the browser's Date column was blank on every series row. */
  seriesDate?: string;
  seriesTime?: string;
  modality?: string;
  description?: string;
  /** DICOM Body Part Examined, as the file says it (often empty): the Segment Editor's region default. */
  bodyPart?: string;
  count: number;
  /** false when some/all instances are recorded as absolute paths outside this folder. */
  available: boolean;
  externalCount: number;
}

export interface DbProgress { note: string; done?: number; total?: number }

/** What to do when the window is newer than the server it talks to. */
const OLDER_SERVER = "Albula's server is older than this window (it was rebuilt while Albula was running): quit Albula and start it again.";

/** A row of the server's series list (desktop/db-listing.ts; its own type there -- keep the two alike). */
export interface ListedSeries {
  uid: string; num: number | string | null; modality: string | null; description: string | null;
  /** Absent from a server older than 2026-10-31. */
  bodyPart?: string | null;
  seriesDate: string | null; seriesTime: string | null;
  studyUID: string | null; studyDescription: string | null; studyDate: string | null;
  patientName: string | null; patientID: string | null;
  n: number; nExternal: number;
}

/**
 * Where a database is read from: what it holds (its series, one series' files -- asked of the server) and one
 * file by path relative to the database directory (and its head). This is the whole seam.
 *
 * There are two implementations because the File System Access API is not universal:
 * `showDirectoryPicker` exists in Chromium but NOT in the WKWebView that the native SlicerLive app
 * runs, which is why browsing a database used to require launching the browser build. The native
 * app is itself a local HTTP server, so the database can simply be served and fetched instead.
 */
export interface DbSource {
  /** Shown to the user: a folder name, or the served path. */
  readonly label: string;
  /** Every series with its study and patient, and the counts (the server's GET /_db/<id>/_series). */
  listSeries(): Promise<{ series: ListedSeries[]; patients: number; studies: number }>;
  /** One series' files as the index records them: relative to the database folder, or absolute. */
  seriesFiles(seriesUID: string): Promise<string[]>;
  /** One file, by path relative to the database directory. */
  readFile(relPath: string): Promise<ArrayBuffer>;
  /**
   * The first `maxBytes` of a file, plus its full length.
   *
   * Exists so a decision that depends only on a file's header does not have to pay for its body. A
   * DICOM object's identity lives in the file meta group, in the first few hundred bytes, so a cache
   * key can be computed from a 4 KB read instead of a 347 MB one.
   *
   * Optional: a source without it simply cannot take that shortcut.
   */
  readHead?(relPath: string, maxBytes: number): Promise<FileHead>;
  /** Present only when opened from a picked directory. */
  readonly directory?: FileSystemDirectoryHandle;
}

/** Read a database from a picked directory (Chromium's File System Access API). */
/**
 * WHY, not just THAT, when a series yields no image. A SEG or SR is a legitimate series with no
 * image instances and the advice to load it as a segmentation is right for those; for a CT whose
 * pixels are JPEG Lossless it is wrong twice, since it IS an image series and the segmentation
 * path would fail on the same bytes. parseInstances records the reason it skipped each instance.
 * One function for both loaders: the sequence loader used to say only "none could be read", and
 * Ron's JPEG Lossless series got that (2026-09-14) instead of the reason.
 */
function emptySeriesError(entry: Pick<DbSeriesEntry, "modality">, n: number): Error {
  const reasons = [...lastSkipReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([why, k]) => `${k} × ${why}`)
    .join("; ");
  const isImage = entry.modality && !["SEG", "SR", "PR", "RTSTRUCT", "KO"].includes(entry.modality);
  return new Error(
    `none of the ${n} instances could be read as images` +
    (reasons ? ` — ${reasons}` : "") +
    (isImage ? "" : " — load it as a segmentation instead of a volume"),
  );
}

export function directorySource(dir: FileSystemDirectoryHandle): DbSource {
  return {
    label: dir.name,
    directory: dir,
    // The index is read by Albula's server (it has SQLite; the page no longer carries a copy). A folder picked in a
    // plain browser, with no server behind it, can therefore not be listed -- the app never had this path (WKWebView
    // has no folder picker); Steve's static pages did.
    listSeries: () => Promise.reject(new Error("Opening a database folder directly needs Albula's server: add it in Load / Save › Databases instead.")),
    seriesFiles: () => Promise.reject(new Error("Opening a database folder directly needs Albula's server.")),
    readFile: async (rel) => (await fileAt(dir, rel)).arrayBuffer(),
    readHead: async (rel, maxBytes) => {
      const f = await fileAt(dir, rel);
      return { head: new Uint8Array(await f.slice(0, maxBytes).arrayBuffer()), totalBytes: f.size };
    },
  };
}

/**
 * Read a database served over HTTP — the `/_db/<id>/` route, whose path comes from the settings
 * file rather than from anything baked into the served tree.
 *
 * Each path segment is encoded separately: real database paths contain spaces (a folder like
 * "2020-01-01 Chest CT"), and encoding the whole path would also escape the separators.
 */
export function httpSource(baseUrl: string): DbSource {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const urlFor = (rel: string) => base + rel.split("/").map(encodeURIComponent).join("/");
  const get = async (rel: string) => {
    const r = await fetch(urlFor(rel));
    if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
    return await r.arrayBuffer();
  };

  return {
    label: base,
    // `no-store`: a list must never come from a cache. Ron once opened a de-identified database and saw the old
    // patient name, from an index the webview had stored (2026-09); the server sends no-store too.
    async listSeries() {
      const r = await fetch(base + "_series", { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      // A server older than this window has no such route: the Rebuild installs a new page beside a running server
      // (critic 2026-10-14, page asks the server, finding 1). Said as what to do, not as "HTTP 404".
      if (r.status === 404 && !body.error) throw new Error(OLDER_SERVER);
      if (!r.ok) throw new Error(body.error ?? `the database could not be listed (HTTP ${r.status})`);
      return body as { series: ListedSeries[]; patients: number; studies: number };
    },
    async seriesFiles(uid) {
      const r = await fetch(`${base}_files?series=${encodeURIComponent(uid)}`, { cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (r.status === 404 && !body.error) throw new Error(OLDER_SERVER);
      if (!r.ok) throw new Error(body.error ?? `the files of a series could not be listed (HTTP ${r.status})`);
      return (body.files ?? []) as string[];
    },
    readFile: get,
    async readHead(rel, maxBytes) {
      const r = await fetch(urlFor(rel), { headers: { Range: `bytes=0-${maxBytes - 1}` } });
      if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
      const head = new Uint8Array(await r.arrayBuffer());
      // 206 carries "bytes 0-4095/347116544"; a server that ignores Range answers 200 with the whole
      // file, in which case its length IS the total and nothing was wasted beyond this one read.
      const cr = r.headers.get("content-range");
      const total = cr ? Number(cr.split("/")[1]) : head.byteLength;
      return { head, totalBytes: Number.isFinite(total) && total > 0 ? total : head.byteLength };
    },
  };
}

/** The head of a file and the size of the whole thing. */
export interface FileHead {
  head: Uint8Array;
  /** Length of the entire file, not of `head`. */
  totalBytes: number;
}

export interface DicomDatabase {
  /** Where it was opened from: a folder name, or the served path. */
  label: string;
  /** Present only when opened from a picked directory. */
  directory?: FileSystemDirectoryHandle;
  series: DbSeriesEntry[];
  patients: number;
  studies: number;
  /** Read + reconstruct one series by fetching only its own files. */
  loadSeries(entry: DbSeriesEntry, onProgress?: (p: DbProgress) => void): Promise<Volume>;
  /**
   * A series that holds several volumes in time -- a gated coronary CTA, a bolus-monitoring
   * series -- as its frames, each a reconstructed Volume, with the scanner's label per frame. A
   * plain series comes back as one frame, so a caller can always ask this and decide by the count.
   */
  loadSequence(entry: DbSeriesEntry, onProgress?: (p: DbProgress) => void): Promise<{ frames: Volume[]; labels: string[]; timing: FrameTiming[]; leftOut: string[]; phasesMs?: { read: number; parse: number; reconstruct: number } }>;
  /**
   * The raw bytes of a series' instances, unparsed.
   *
   * loadSeries reconstructs a VOLUME, which a SEG or SR is not; those need their own decoding
   * (readers/dicom-seg.ts) and only the bytes from here.
   */
  readSeriesFiles(entry: DbSeriesEntry, onProgress?: (p: DbProgress) => void): Promise<ArrayBuffer[]>;
  /**
   * The head of a series' FIRST instance, for a decision that only needs the header.
   *
   * Returns null when the source cannot do partial reads, or when the series has no reachable file —
   * either way the caller must fall back to reading properly.
   */
  readSeriesFileHead(entry: DbSeriesEntry, maxBytes: number): Promise<FileHead | null>;
  close(): void;
}

/** Resolve a path recorded relative to the database directory into a File. */
async function fileAt(dir: FileSystemDirectoryHandle, relPath: string): Promise<File> {
  const parts = relPath.split("/").filter((p) => p && p !== ".");
  let d = dir;
  for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
  const fh = await d.getFileHandle(parts[parts.length - 1]);
  return fh.getFile();
}

const str = (v: unknown): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));

// ---------------------------------------------------------------------------
// Remember the last database across sessions. FileSystemDirectoryHandles are
// structured-cloneable, so IndexedDB can hold one; re-opening it still needs a
// permission check, which the browser may grant silently or re-prompt for.
// ---------------------------------------------------------------------------

const IDB_NAME = "slicerlive-fs";
const IDB_STORE = "handles";
const DB_KEY = "dicomDatabaseDir";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberDatabaseDir(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dir, DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* remembering is a convenience; never fail the open because of it */ }
}

/** The remembered directory, or null when there is none / permission is refused. */
export async function recallDatabaseDir(opts?: { prompt?: boolean }): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await idb();
    const dir = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const get = tx.objectStore(IDB_STORE).get(DB_KEY);
      get.onsuccess = () => resolve(get.result as FileSystemDirectoryHandle | undefined);
      get.onerror = () => reject(get.error);
    });
    db.close();
    if (!dir) return null;
    const h = dir as unknown as {
      queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
      requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
    };
    const state = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (state === "granted") return dir;
    if (state === "prompt" && opts?.prompt) {
      const granted = await h.requestPermission?.({ mode: "read" });
      if (granted === "granted") return dir;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Open a Slicer DICOM database served by Albula's server: the series list comes from the server, which reads the
 * index; no image file is touched. (A picked folder with no server behind it can no longer be listed.)
 */
export async function openDicomDatabase(
  from: DbSource | FileSystemDirectoryHandle,
  onProgress?: (p: DbProgress) => void,
): Promise<DicomDatabase> {
  // A bare directory handle is still accepted, so existing callers do not change.
  const source: DbSource = "listSeries" in from ? from : directorySource(from as FileSystemDirectoryHandle);

  onProgress?.({ note: "listing series…" });
  const listed = await source.listSeries();
  const seriesRows = listed.series as unknown as Record<string, unknown>[];

  const series: DbSeriesEntry[] = seriesRows.map((r) => {
    const count = Number(r.n ?? 0);
    const externalCount = Number(r.nExternal ?? 0);
    return {
      seriesInstanceUID: String(r.uid),
      studyInstanceUID: str(r.studyUID),
      patientName: str(r.patientName),
      patientID: str(r.patientID),
      studyDescription: str(r.studyDescription),
      studyDate: str(r.studyDate),
      seriesNumber: r.num === null || r.num === undefined ? undefined : Number(r.num),
      seriesDate: str(r.seriesDate),
      seriesTime: str(r.seriesTime),
      modality: str(r.modality),
      description: str(r.description),
      bodyPart: str(r.bodyPart),
      count,
      externalCount,
      available: count > 0 && externalCount === 0,
    };
  });

  return {
    label: source.label,
    directory: source.directory,
    series,
    patients: Number(listed.patients ?? 0),
    studies: Number(listed.studies ?? 0),
    close: () => {},

    async readSeriesFileHead(entry, maxBytes) {
      if (!source.readHead) return null;
      let first: string | undefined;
      try { first = (await source.seriesFiles(entry.seriesInstanceUID)).filter((n) => !n.startsWith("/"))[0]; } catch { return null; }
      if (!first) return null;
      try {
        return await source.readHead(first, maxBytes);
      } catch {
        return null;                 // a failed shortcut is not an error, it is just no shortcut
      }
    },

    async readSeriesFiles(entry, progress) {
      const names = await source.seriesFiles(entry.seriesInstanceUID);
      if (!names.length) throw new Error("that series has no files in the database any more (removed since the list was read?) — reopen the list");

      const external = names.filter((n) => n.startsWith("/"));
      const local = names.filter((n) => !n.startsWith("/"));
      if (!local.length) {
        throw new Error(
          `all ${external.length} files of this series are stored outside this folder ` +
          `(recorded as absolute paths, e.g. ${external[0]}) — they are not reachable from the browser`,
        );
      }

      // Fetched with bounded concurrency, NOT one at a time. A 993-instance series read serially
      // costs 993 sequential round trips -- the dominant cost of opening a series, and why loading
      // felt frozen. Results are kept in index order so the caller sees the same sequence either way.
      //
      // 12 workers: more than a browser will actually run against one HTTP/1.1 origin (~6), which
      // costs nothing when they queue, and helps the directory-handle source where the limit is disk
      // rather than connections.
      const t0 = performance.now();
      const CONCURRENCY = 12;
      const slots: (ArrayBuffer | null)[] = new Array(local.length).fill(null);
      let next = 0, finished = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= local.length) return;
          try {
            slots[i] = await source.readFile(local[i]);
          } catch { /* recorded but missing on disk; skip */ }
          finished++;
          if (finished % 25 === 0 || finished === local.length) {
            progress?.({ note: `reading files… ${finished}/${local.length}`, done: finished, total: local.length });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, local.length) }, worker));

      const buffers = slots.filter((b): b is ArrayBuffer => b !== null);
      if (!buffers.length) throw new Error("none of this series' files could be read from disk");
      // Timed and reported, because "loading is slow" is not actionable without knowing WHICH half
      // is slow: fetching the instances or parsing them.
      const bytes = buffers.reduce((n, b) => n + b.byteLength, 0);
      const secs = (performance.now() - t0) / 1000;
      progress?.({
        note: `read ${buffers.length} files, ${(bytes / 1e6).toFixed(0)} MB in ${secs.toFixed(1)}s ` +
          `(${(bytes / 1e6 / Math.max(secs, 1e-3)).toFixed(0)} MB/s)`,
        done: buffers.length, total: buffers.length,
      });
      return buffers;
    },

    async loadSeries(entry, progress) {
      const buffers = await this.readSeriesFiles(entry, progress);
      progress?.({ note: `parsing ${buffers.length} instances…` });
      const tParse = performance.now();
      const instances = await parseInstances(buffers);
      const parseSecs = (performance.now() - tParse) / 1000;
      if (!instances.length) throw emptySeriesError(entry, buffers.length);
      // SPLIT BY ORIENTATION FIRST, as the local-files path always did and this one did not.
      // A reformatted series from the scanner often carries the axial picture it was planned on
      // as its first instance (every coronal and sagittal series of C3L-03960 does). Fed to the
      // reconstruction with the rest, that picture was placed as a plane of the coronal volume
      // AND its position went into the derived slice spacing, stretching the volume by 14%. The
      // largest group is the series; the rest is reported, not silently dropped, and not loaded.
      // A SERIES IN TIME loads as its FIRST frame here; loadSequence is the call that brings all of
      // them, and the DICOM browser makes that call. Reported, so a person sees why one phase came.
      const groups = groupSeries(instances).sort((a, b) => b.instances.length - a.instances.length);
      const main = groups[0].instances;
      const leftOut = groups.slice(1).filter((g) => !g.temporal).map((g) => `${g.instances.length} image${g.instances.length === 1 ? "" : "s"} in another orientation`);
      if (groups[0].temporal) leftOut.unshift(`${groups[0].temporal.count - 1} more frames in time (${groups[0].temporal.label} loaded)`);
      progress?.({ note: `parsed in ${parseSecs.toFixed(1)}s — reconstructing ${main.length} slices…` });
      const tRecon = performance.now();
      const vol = reconstructSeries(main);
      if (leftOut.length) (vol.meta as Record<string, unknown>).leftOut = leftOut;
      // (The warning about uneven slice spacing is raised where the browser loads, in
      // load-panel.ts, from `meta.irregularSpacing`; a progress note here was overwritten at once.)
      progress?.({
        note: `parsed ${instances.length} in ${parseSecs.toFixed(1)}s, ` +
          `reconstructed ${main.length} in ${((performance.now() - tRecon) / 1000).toFixed(1)}s` +
          (leftOut.length ? ` — left out ${leftOut.join(", ")} (a reference picture, not a slice of this volume)` : ""),
      });
      return vol;
    },

    async loadSequence(entry, progress) {
      // TIMED IN THREE, for the load profile: Ron's scene is on screen in 4.9 s, and the first 4 of
      // them are this -- the CT -- with only its last step (the ingest) ever timed there.
      const tRead = performance.now();
      const buffers = await this.readSeriesFiles(entry, progress);
      const readMs = performance.now() - tRead;
      progress?.({ note: `parsing ${buffers.length} instances…` });
      const tParse = performance.now();
      const instances = await parseInstances(buffers);
      const parseSecs = (performance.now() - tParse) / 1000;
      if (!instances.length) throw emptySeriesError(entry, buffers.length);
      // The same function the server's duckn working copy uses (desktop/duckn-copy.ts).
      const { frames, labels, timing, leftOut, reconMs } = volumesOfSeries(instances, (i, n, slices) =>
        progress?.({ note: `parsed in ${parseSecs.toFixed(1)}s — reconstructing ${n > 1 ? `frame ${i + 1} of ${n} ` : ""}(${slices} slices)…` }));
      progress?.({ note: `parsed ${instances.length} in ${parseSecs.toFixed(1)}s, reconstructed ${frames.length} frame${frames.length === 1 ? "" : "s"} in ${(reconMs / 1000).toFixed(1)}s` });
      return {
        phasesMs: { read: readMs, parse: parseSecs * 1000, reconstruct: reconMs },
        frames,
        labels,
        timing,
        leftOut,
      };
    },
  };
}
