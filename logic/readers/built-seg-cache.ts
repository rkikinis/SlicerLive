// THE SEGMENTATION AS THE APPLICATION HOLDS IT, kept between sessions.
//
// Ron, 2026-09-22, having watched two of four segmentations arrive free from a cache while the other
// two were decoded again: "we should take every advantage that we can take."
//
// WHAT IS CACHED, AND WHY THIS IS NOT THE THING THAT WAS REJECTED. The decoded labelmap is 418 MB
// and storing it was measured and rejected on 2026-09-18 -- writing it cost more than decoding it.
// This stores what comes out the OTHER end: the deflated chunks the application actually holds, plus
// the segment list built from the file. Measured on Ron's scene: 0.04, 0.4, 0.7 and 2.2 MB for
// segmentations of 2, 4, 22 and 111 structures over 418 million voxels. Three megabytes for four.
//
// WHAT A HIT SAVES: the decode (1.2-2.5 s each) and the compression into the store (0.5-1.7 s each)
// -- the two largest phases of a load.
//
// IDENTITY, NOT FRESHNESS. The key carries the SEG object's own SOP instance UID, its length, the
// reference grid it was placed on, and a code fingerprint of the build that produced it; a record
// that does not match on all four is not a record for this question. There is no timestamp and no
// invalidation, because nothing can change underneath a key like that -- the same lesson as the
// surfaces cache, where the server validates the object against the files it was made from.
import type { Segment } from "../segmentation-editor.ts";

/** What a built segmentation is, minus the ids and the names the caller chooses. */
export interface BuiltSeg {
  /** The zarr descriptor the node carries: shape, chunk grid, dtype and the chunk hashes. */
  desc: Record<string, unknown>;
  /** The chunks themselves, by hash — what `LocalBlobStore.add` takes. */
  chunks: Record<string, Uint8Array>;
  /** The segments as the build kept them: empty ones already dropped, colors settled. */
  segments: Segment[];
  /** The build that wrote it (BUILD_CODE below), so a changed build cannot read an old record. */
  code: string;
  /**
   * The series the SEG names as the one it was drawn on, and the instances within it.
   *
   * WITHOUT THESE A HIT SKIPS THE PLACEMENT CHECK. The key says which grid the record was built on,
   * and two series can share a grid: the five phases of a gated study are one series of identical
   * geometry, and the decode path re-places a SEG onto the frame its instances name for exactly
   * that reason. A record that cannot answer "which volume is this for" is not usable on a hit —
   * found by the critic, 2026-09-22, within the hour this cache was written.
   */
  referencedSeriesUID?: string;
  referencedSOPInstanceUIDs?: string[];
  /**
   * The network that made the SEG, as the object names it.
   *
   * It decides the presentation the segmentation arrives with, and a hit never decodes the file, so
   * without it here a second load LOOKED different from the first (2026-09-23).
   */
  algorithmName?: string;
  /** The file's SOP class and algorithm type, so a re-save after a hit writes them as the file had them: a
   *  merged (SEMIAUTOMATIC) or hand-drawn segmentation came back AUTOMATIC on its second load (code review
   *  2026-09-24, A5). */
  sopClassUID?: string;
  algorithmType?: string;
}

const DB = "slicerlive-seg-cache", STORE = "built";
/**
 * Bump when what is stored changes shape, or when the code that builds a segmentation changes what
 * it produces. Everything written before becomes a miss, once, and is evicted by the bound below.
 */
export const BUILD_CODE = "built-3";   // built-2: the network's name; built-3: the SOP class and algorithm type
/** Records kept, oldest out first. Three megabytes each on a whole-body study; 60 is comfortable. */
const KEEP = 60;

interface Req<T> { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T }
interface Store { get(k: string): Req<unknown>; put(v: unknown, k: string): Req<unknown>; delete(k: string): Req<unknown>; getAllKeys(): Req<string[]> }
interface Tx { objectStore(n: string): Store; onabort: (() => void) | null; onerror: (() => void) | null }
interface Db { transaction(n: string, m: "readonly" | "readwrite"): Tx; close(): void; objectStoreNames: { contains(n: string): boolean }; createObjectStore(n: string): unknown }
type Factory = { open(name: string, v: number): Req<Db> & { onupgradeneeded: (() => void) | null; onblocked: (() => void) | null } };

/** Never throws and never hangs: a cache that cannot answer is a miss, not a failure. */
function orNull<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

let dbPromise: Promise<Db | null> | null = null;
function idb(): Promise<Db | null> {
  const g = globalThis as { indexedDB?: Factory };
  if (!g.indexedDB) return Promise.resolve(null);
  // VERSION 2, because the decoded-form store came first and both live in one database. The upgrade
  // creates whichever store is missing, so a browser holding either one opens cleanly.
  if (!dbPromise) {
    dbPromise = orNull(new Promise<Db>((resolve, reject) => {
      // VERSION 2 IS THIS STORE'S DOING: the decoded-form store came first, at version 1, and both
      // live in one database. The other reader opens without a version so this upgrade cannot break
      // it; the upgrade creates whichever store is missing.
      const req = g.indexedDB!.open(DB, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("decoded")) db.createObjectStore("decoded");
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("indexedDB refused"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    }), 8000);
  }
  return dbPromise;
}

function tx<T>(db: Db, mode: "readonly" | "readwrite", fn: (s: Store) => Req<unknown>): Promise<T | null> {
  return orNull(new Promise<T>((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      t.onabort = () => resolve(null as unknown as T);
      t.onerror = () => resolve(null as unknown as T);
      const r = fn(t.objectStore(STORE));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(null as unknown as T);
    } catch {
      resolve(null as unknown as T);
    }
  }), mode === "readwrite" ? 20000 : 4000);
}

/** The built segmentation for this key, or null. A record from another build is not a hit. */
export async function getBuiltSeg(key: string | null): Promise<BuiltSeg | null> {
  if (!key) return null;
  const db = await idb();
  if (!db) return null;
  const got = await tx<BuiltSeg>(db, "readonly", (s) => s.get(key));
  if (!got || got.code !== BUILD_CODE) return null;
  return got;
}

/** Store one. Failures are swallowed: a load that has succeeded must not fail on the way out. */
export async function putBuiltSeg(key: string | null, built: BuiltSeg): Promise<void> {
  if (!key) return;
  const db = await idb();
  if (!db) return;
  const keys = await tx<string[]>(db, "readonly", (s) => s.getAllKeys());
  await tx(db, "readwrite", (s) => s.put(built, key));
  if (keys && keys.length >= KEEP) {
    const drop = keys.slice(0, keys.length - KEEP + 1);
    for (const k of drop) await tx(db, "readwrite", (s) => s.delete(k));
  }
}
