// Caching a decoded DICOM SEG, so reopening a series does not re-decode it.
//
// Measured on the 347 MB, 17,957-frame SEG in the working database: dcmjs `readFile` 416 ms,
// `naturalizeDataset` 97 ms, placement 130 ms — about 640 ms of work whose output is the same every
// time, because the input is an immutable archived object. Caching deletes all of it.
//
// **The key is the identity DICOM already guarantees, not a hash of the bytes.** `(0002,0003)
// MediaStorageSOPInstanceUID` is globally unique for the object by definition, lives in the file meta
// group — which is always explicit VR little-endian, near the start — and can therefore be read
// without parsing the object at all. Measured: 0.311 ms against 163 ms to SHA-256 the whole file,
// and the hash would be paid on every cache *hit* as well as every miss. Reading a UID out of the
// meta group without a DICOM parser is the same trick `Slicer/database/verify-relocation.py` uses to
// prove a relocation matched the right files.
//
// The reference geometry is part of the key because it has to be: the same SEG placed on a different
// grid decodes to a different labelmap, so a cache keyed on the SEG alone would serve a wrong answer
// rather than miss.
import { decodeSegmentation, type DecodedSeg, type DecodePhases, type SegReference } from "./dicom-seg.ts";

// Re-exported so a consumer importing only this module can name the types in these signatures.
export type { DecodedSeg, DecodePhases, SegGeometry, SegReference } from "./dicom-seg.ts";

/** How many decoded segmentations to keep on disk. Each is ~149 MB for a 993-slice series. */
const KEEP = 3;
/**
 * How many BYTES of decoded label maps to keep in memory. Three whole-body ones (399 MB each on a
 * 768×768×709 CT) pinned for the life of the page were 1.2 GB of the ceiling a page died at
 * (critic, 2026-09-18 evening, finding 3); the scene has its own copy in zarr chunks by then.
 */
const KEEP_BYTES = 512 * 1024 * 1024;
const LABEL_MAP_SOP = "1.2.840.10008.5.1.4.1.1.66.7";
/** A promise that settles as `null` after `ms` if the storage never answers (a wedged IndexedDB server process). */
const orNull = <T>(p: Promise<T | null>, ms = 8000): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * Read `MediaStorageSOPInstanceUID` from the file meta group without parsing the object.
 *
 * The meta group is defined to be explicit VR little-endian regardless of the transfer syntax of
 * what follows, which is what makes this safe to do by hand. Returns `null` for anything that is not
 * a Part 10 file with a readable meta group — a caller that gets `null` must simply not cache.
 */
export function metaSopInstanceUid(bytes: Uint8Array): string | null {
  // 132 for the preamble and magic, plus at least one 8-byte element header. A real SEG is hundreds
  // of megabytes, but the bound belongs to the format rather than to the expected size — a stricter
  // guess here silently refused a valid minimal file, which a test caught.
  if (bytes.length < 140) return null;
  if (String.fromCharCode(bytes[128], bytes[129], bytes[130], bytes[131]) !== "DICM") return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 132;
  // The meta group is short; stop well before the object proper rather than scanning a 347 MB file.
  while (p + 8 <= bytes.length && p < 4096) {
    const group = dv.getUint16(p, true), elem = dv.getUint16(p + 2, true);
    if (group !== 0x0002) return null;                 // out of the meta group without finding it
    const vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
    // The VRs that carry a 32-bit length after two reserved bytes.
    const long = vr === "OB" || vr === "OW" || vr === "OF" || vr === "SQ" || vr === "UT" || vr === "UN";
    const len = long ? dv.getUint32(p + 8, true) : dv.getUint16(p + 6, true);
    const valueAt = long ? p + 12 : p + 8;
    if (elem === 0x0003) {
      return new TextDecoder().decode(bytes.subarray(valueAt, valueAt + len)).replace(/\0+$/, "");
    }
    p = valueAt + len;
  }
  return null;
}

/**
 * A cache key for this SEG placed on this reference, or `null` when the object cannot be identified.
 *
 * `byteLength` rides along as a cheap tripwire. A SOPInstanceUID identifies an object, and an object
 * whose bytes changed while keeping its UID is a specification violation — but a truncated download
 * is not, and this catches that for free.
 */
export function segCacheKey(bytes: Uint8Array, ref: SegReference): string | null {
  return keyFrom(metaSopInstanceUid(bytes), bytes.byteLength, ref);
}

/**
 * The same key, from a file's HEAD and its total length.
 *
 * This is the point of the whole exercise. A cache placed after the read cannot help what the read
 * already cost: on a hit we were fetching 347 MB purely to compute a key from its first few hundred
 * bytes, which measured 0.6 s of a 4.0 s load. The identity is in the file meta group, so a 4 KB
 * range request answers the question and the body is never fetched at all.
 *
 * `totalBytes` must be the length of the WHOLE file — an HTTP `Content-Range` gives it — because
 * {@linkcode segCacheKey} uses the same, and a key that disagreed would turn every hit into a miss.
 */
export function segCacheKeyFromHead(head: Uint8Array, totalBytes: number, ref: SegReference): string | null {
  return keyFrom(metaSopInstanceUid(head), totalBytes, ref);
}

/**
 * The record's shape, in the key: bump it when a decode starts carrying something the stored
 * records lack, and every old record becomes a miss once. 2: `referencedSOPInstanceUIDs`
 * (2026-09-13), without which a SEG cannot find its frame in a sequence.
 */
const RECORD_VERSION = 5;   // 5: the codes the file carries (`fileCodes`) and the algorithm name past the background segment (2026-09-20); 4: the label map form decoded as such (2026-09-18); 3: overlapVoxels, UTF-8 names
function keyFrom(uid: string | null, totalBytes: number, ref: SegReference): string | null {
  if (!uid) return null;
  const geom = `${ref.dims.join("x")}|${ref.ijkToRAS.map((v) => v.toFixed(6)).join(",")}`;
  return `${uid}|${totalBytes}|${geom}|v${RECORD_VERSION}`;
}

/**
 * Where decoded segmentations live.
 *
 * IndexedDB when there is one, because the win Ron actually feels is across sessions — he closes the
 * app and opens the same series again — and an in-memory map only helps within one. A plain map is
 * the fallback, which is also what runs under `deno test`.
 */
const memory = new Map<string, DecodedSeg>();
const DB = "slicerlive-seg-cache", STORE = "decoded";

// Just enough of IndexedDB to use it. Declared here rather than pulling in the whole DOM lib, which
// this module does not otherwise need — and the surrounding codebase already carries a great deal of
// DOM-type noise under `deno check`, which once hid a real regression, so this file adds none.
type Req<T> = { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null };
type Tx = { objectStore(n: string): Store; onabort: (() => void) | null; onerror: (() => void) | null };
interface Store {
  get(k: string): Req<unknown>;
  getAllKeys(): Req<string[]>;
  put(v: unknown, k: string): Req<unknown>;
  delete(k: string): Req<unknown>;
  clear(): Req<unknown>;
}
interface Db {
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(n: string): unknown;
  transaction(n: string, mode: "readonly" | "readwrite"): Tx;
  close(): void;
}
type Factory = { open(name: string, v: number): Req<Db> & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null } };

function idb(): Promise<Db | null> {
  const g = globalThis as { indexedDB?: Factory };
  if (!g.indexedDB) return Promise.resolve(null);
  return orNull(new Promise((resolve) => {
    // NO VERSION NUMBER. This database gained a second store ("built", built-seg-cache.ts) and with
    // it version 2; asking for version 1 against a version 2 database is a VersionError, and this
    // cache would have gone quietly dead -- a decode cache that always misses looks exactly like a
    // slow application, which is the worst kind of regression to leave behind. Opening without a
    // version takes whatever is there, and creates it at version 1 when there is nothing.
    const req = g.indexedDB!.open(DB);
    req.onupgradeneeded = () => {                    // only when the database does not exist yet
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);         // a cache that cannot open is a cache miss, not an error
    req.onblocked = () => resolve(null);       // another window holds it: a miss, not a wait
  }));
}

// EVERY WAY A REQUEST CAN END settles the promise. A 418 MB put that runs the storage out of quota
// aborts the TRANSACTION, and the request's own onerror does not always fire for that -- so a load
// sat at "decoding segmentation…" forever, with nothing said (2026-09-18, a whole-body label map in
// a browser with a small quota). The transaction's abort and error are caught here as a miss.
function tx<T>(db: Db, mode: "readonly" | "readwrite", fn: (s: Store) => Req<unknown>): Promise<T | null> {
  return orNull(new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      t.onabort = () => resolve(null);
      t.onerror = () => resolve(null);
      const r = fn(t.objectStore(STORE));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }), mode === "readwrite" ? 60000 : 8000);
}

/** The decoded segmentation for this key, or `null`. Never throws: a broken cache is a miss. */
export async function getCachedSeg(key: string | null): Promise<DecodedSeg | null> {
  if (!key) return null;
  const hit = memory.get(key);
  if (hit) return hit;
  const db = await idb();
  if (!db) return null;
  const stored = await tx<DecodedSeg>(db, "readonly", (s) => s.get(key));
  db.close();
  if (stored) memory.set(key, stored);
  return stored ?? null;
}

/**
 * Store a decoded segmentation.
 *
 * Bounded to {@linkcode KEEP} entries, oldest first, because these are ~149 MB each: unbounded, this
 * would fill a disk quota and then start failing silently, which is worse than missing. Storage
 * failures are swallowed for the same reason — a cache that cannot write must not break a load that
 * has already succeeded.
 */
/** What the decoded segmentations in memory are holding, for the memory report. Up to 512 MB of
 *  labelmaps that the report could not see (critic, 2026-09-22, finding 2). */
export function segCacheBytes(): number {
  return [...memory.values()].reduce((n, v) => n + v.lab.byteLength, 0);
}

export async function putCachedSeg(key: string | null, seg: DecodedSeg, opts: { disk?: boolean } = {}): Promise<void> {
  if (!key) return;
  memory.set(key, seg);
  const bytes = () => [...memory.values()].reduce((n, v) => n + v.lab.byteLength, 0);
  while (memory.size > KEEP || (memory.size > 1 && bytes() > KEEP_BYTES)) memory.delete(memory.keys().next().value as string);
  if (opts.disk === false) return;

  const db = await idb();
  if (!db) return;
  const keys = await tx<string[]>(db, "readonly", (s) => s.getAllKeys());
  const stored = await tx(db, "readwrite", (s) => s.put(seg, key));
  // Prune only when the put landed: a put the storage refused (Chromium's 127 MB value limit)
  // must not shrink the store by one on every failed try.
  if (keys && stored !== null) {
    for (const k of keys.filter((k) => k !== key).slice(0, Math.max(0, keys.length + 1 - KEEP))) {
      await tx(db, "readwrite", (s) => s.delete(k));
    }
  }
  db.close();
}

/** Forget everything. For tests, and for a caller that has just deleted the underlying series. */
export async function clearSegCache(): Promise<void> {
  memory.clear();
  const db = await idb();
  if (!db) return;
  await tx(db, "readwrite", (s) => s.clear());
  db.close();
}

/**
 * Decode a SEG, or return the decoded form from a previous run.
 *
 * The wrapper rather than a flag inside {@linkcode decodeSegmentation}, so the decoder stays pure and
 * stays testable without a storage backend — the caching concern lives entirely in this file.
 *
 * A SEG in an archive is immutable: the same object placed on the same grid yields the same labelmap
 * every time, which is what makes this safe rather than merely fast. On a miss the decode runs and
 * the result is stored; a storage failure is not surfaced, because a load that has already succeeded
 * must not fail on the way out.
 */
/**
 * Where the decode runs. The application installs a worker-backed one; everything else uses the
 * direct call. A decoder that fails is not caught here: a load must fail loudly, not silently
 * fall back to a slower path that may fail the same way.
 */
export let segDecoder: ((bytes: ArrayBuffer, ref: SegReference, onPhases?: (p: DecodePhases) => void) => Promise<DecodedSeg>) | null = null;
export function setSegDecoder(fn: typeof segDecoder): void { segDecoder = fn; }

/**
 * DECODES IN FLIGHT, so the same object is never decoded twice at once.
 *
 * `getCachedSeg` only sees decodes that have finished and been stored. The load's own prefetch asks
 * for the next segmentation while the current one is still being built, and the real load then asks
 * for that same object before the prefetch has stored it -- a miss, and a second concurrent decode
 * of the same file, two ~400 MB labelmaps of one segmentation in memory at once (critic,
 * 2026-09-22, finding 4). The second asker joins the first instead.
 */
const inFlight = new Map<string, Promise<DecodedSeg>>();

export async function decodeSegmentationCached(
  bytes: ArrayBuffer,
  ref: SegReference,
  report?: (r: { cached: boolean; keyed: boolean; storedMs?: number; phases?: DecodePhases }) => void,
): Promise<DecodedSeg> {
  const key = segCacheKey(new Uint8Array(bytes), ref);
  const hit = await getCachedSeg(key);
  if (hit) {
    report?.({ cached: true, keyed: true });
    return hit;
  }
  const joined = key ? inFlight.get(key) : undefined;
  if (joined) {
    report?.({ cached: true, keyed: true });
    return await joined;
  }
  let done: (s: DecodedSeg) => void = () => {};
  let failed: (e: unknown) => void = () => {};
  if (key) {
    const shared = new Promise<DecodedSeg>((res, rej) => { done = res; failed = rej; });
    shared.catch(() => {});                         // a rejection nobody joined is not an unhandled one
    inFlight.set(key, shared);
  }
  try {
    return await decodeAndStore();
  } catch (e) { failed(e); throw e; } finally { if (key) inFlight.delete(key); }

  async function decodeAndStore(): Promise<DecodedSeg> {
  let phases: DecodePhases | undefined;
  // IN A WORKER WHEN THE APPLICATION GAVE US ONE (`setSegDecoder`, installed by slicer-app): the
  // decode is the largest single-threaded phase of a load. Everywhere else — tests, benches, the
  // server — it runs here, as before.
  // AND IF THE WORKER CANNOT, THIS THREAD STILL CAN. The decode is not optional: a load that
  // cannot decode its segmentation has failed. The first worker version could not load dcmjs and
  // four segmentations simply did not arrive (2026-09-22); a fallback makes the worker an
  // optimisation rather than a dependency, and the reason is said once.
  let seg: DecodedSeg;
  if (segDecoder) {
    try {
      seg = await segDecoder(bytes, ref, (p) => { phases = p; });
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      console.warn(`the segmentation decoder in the worker failed (${why}); decoding on the main thread instead`);
      try { await fetch("/_log", { method: "POST", body: `segmentation decoded on the main thread: the worker failed — ${why}`, keepalive: true }); } catch { /* no server */ }
      segDecoder = null;                              // one report, not one per segmentation
      // WITH THE FILE THE WORKER GAVE BACK. A worker decoder may transfer the bytes in, which
      // detaches them here; one that does hands them back with its error. If neither is true there
      // is nothing to decode and the failure is the caller's to see, not something to paper over
      // with a decode of an empty buffer (critic, 2026-09-22, finding 10).
      const back = (e as { bytes?: ArrayBuffer }).bytes ?? (bytes.byteLength ? bytes : undefined);
      if (!back) throw new Error(`the segmentation could not be decoded: the worker failed (${why}) and did not return the file`);
      seg = await decodeSegmentation(back, ref, (p) => { phases = p; });
    }
  } else {
    seg = await decodeSegmentation(bytes, ref, (p) => { phases = p; });
  }
  // Timed separately: a 149 MB structured clone into IndexedDB is not obviously cheap, and if it is
  // slow or silently failing then the second load will not be fast and the reason must be visible.
  // THE LABEL MAP FORM IS NOT STORED ON DISK: it decodes from a 4 MB file in ~1.2 s, and storing
  // the 399 MB result took longer than that both ways (Ron's logs: "cached in 1.7s", hits of
  // 1.0-1.9 s on a smaller study; critic, 2026-09-18 evening, finding 3). The decode is the cache.
  // The binary form keeps the store: its slow path was real.
  const t = performance.now();
  done(seg);                                        // whoever joined can have it before it is stored
  await putCachedSeg(key, seg, { disk: seg.sopClassUID !== LABEL_MAP_SOP });
  report?.({ cached: false, keyed: key !== null, storedMs: performance.now() - t, phases });
  return seg;
  }
}

/**
 * Look for a decoded SEG using only a file's header, and read the body only on a miss.
 *
 * The read is the caller's to perform, because only the caller knows where the bytes come from — and
 * that is exactly what lets the body go unread. `readHead` should fetch a few kilobytes; `readAll` is
 * called only if the cache misses.
 *
 * Falls back cleanly: if the head cannot be read, or the object cannot be identified from it, the
 * body is read and the ordinary cached path runs. A shortcut that fails is not an error.
 */
export async function decodeSegmentationLazy(
  ref: SegReference,
  readHead: () => Promise<{ head: Uint8Array; totalBytes: number } | null>,
  readAll: () => Promise<ArrayBuffer>,
  report?: (r: { cached: boolean; keyed: boolean; skippedBodyBytes?: number; storedMs?: number; phases?: DecodePhases }) => void,
): Promise<DecodedSeg> {
  let head: { head: Uint8Array; totalBytes: number } | null = null;
  try {
    head = await readHead();
  } catch { /* no shortcut */ }

  if (head) {
    const key = segCacheKeyFromHead(head.head, head.totalBytes, ref);
    const hit = await getCachedSeg(key);
    if (hit) {
      report?.({ cached: true, keyed: true, skippedBodyBytes: head.totalBytes - head.head.byteLength });
      return hit;
    }
    // Or one that is being decoded right now -- the prefetch, most often. Joining it also means the
    // body is never read a second time.
    const joined = key ? inFlight.get(key) : undefined;
    if (joined) {
      report?.({ cached: true, keyed: true, skippedBodyBytes: head.totalBytes - head.head.byteLength });
      return await joined;
    }
  }
  return await decodeSegmentationCached(await readAll(), ref, report);
}
