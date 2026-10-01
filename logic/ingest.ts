// Local volume ingest (W1): turn a Volume (typed array + geometry) into ordinary LiveScene nodes — an `image`
// node whose voxels are content-addressed zarr chunks (the SAME layout Slicer's serializer writes:
// chunks (64,128,128) of the C-order (nz,ny,nx) array, zlib-deflated, named "sha256-<hex>" of the compressed
// bytes), a `scalarVolumeDisplay`, and the slice composites pointing at it. Chunks are served to the
// existing DisplayableManagers through the pluggable blob fetch (render/zarr.ts setBlobFetch), so a file
// dropped on the page renders through exactly the same code path as a volume streamed from Slicer, and a
// session can cache the chunks like any other blob. Pure TS (no DOM); the panel is render/demos/load-panel.ts.
import type { ZarrDesc } from "../render/zarr.ts";
import { cacheDecodedVolume, rememberRange } from "../render/zarr.ts";
import { getBlobFetch, setBlobFetch, setLocalChunk } from "../render/zarr.ts";
import type { Volume } from "./readers/nifti.ts";
import type { LiveScene } from "../render/livescene.ts";
import type { MrsonNode } from "../render/mrson.ts";
import { histogramPercentiles } from "./window-level.ts";
import { workerUrl } from "../render/build-id.ts";

export const CHUNK_MAX: [number, number, number] = [64, 128, 128];   // (cz, cy, cx) — Slicer's _write_zarr rule

export interface ZarrBlobs {
  desc: ZarrDesc;
  blobs: Map<string, Uint8Array>;
  /**
   * Which values occur in the volume (256 flags), when the caller asked for a census.
   *
   * Counted in the workers while they already hold each chunk's bytes, instead of by a second pass
   * over the whole volume on the main thread: 0.8 s per whole-body labelmap, and the callers that
   * need it need it for correctness (a segment with no voxels must not be listed).
   */
  seen?: Uint8Array;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");                                   // zlib-wrapped, like Python zlib.compress
  return new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(cs)).arrayBuffer());
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return "sha256-" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A worker per core (capped), or none when workers are unavailable.
 *
 * The worker bundle sits beside the page bundle, so it is addressed relative to the DOCUMENT rather
 * than to this module: after bundling, this module's own URL is the page bundle's, and a sibling
 * lookup from it lands in the right place either way. Construction failure is not fatal -- the
 * caller falls back to doing the work on this thread.
 */
function chunkWorkers(): Worker[] {
  const g = globalThis as unknown as { Worker?: typeof Worker; navigator?: { hardwareConcurrency?: number }; document?: unknown };
  if (!g.Worker || !g.document) return [];
  const n = Math.max(1, Math.min(8, (g.navigator?.hardwareConcurrency ?? 4) - 1));
  const out: Worker[] = [];
  try {
    for (let i = 0; i < n; i++) out.push(new Worker(workerUrl("./ingest-worker.js"), { type: "module" }));
  } catch {
    for (const w of out) w.terminate();
    return [];
  }
  return out;
}

/** Chunk + compress + hash a volume's voxels. `data` is C-order (z,y,x) with dims [nx,ny,nz]. */
/**
 * Where the most recent {@linkcode volumeToZarr} spent its time.
 *
 * A module-level last-value rather than a callback threaded through `volumeNodes` and
 * `loadVolumeObj`: this is a diagnostic read immediately after the call that produced it, and three
 * layers of plumbing would be more machinery than the measurement is worth. Not for anything but
 * reporting — concurrent ingests would overwrite each other, and nothing depends on it.
 *
 * `codecMs` is 0 when workers ran, because the deflate and the digest happen off this thread.
 */
export let lastIngestPhases: {
  materializeMs: number;
  codecMs: number;
  chunks: number;
  workers: number;
  compressor: "deflate" | "raw";
} | null = null;

export async function volumeToZarr(
  data: Volume["data"],
  dims: [number, number, number],
  dtype: string,
  // `census`: which values occur, counted in the workers while the bytes are already being read.
  // BYTE-WISE, so it is for `|u1` volumes only -- on anything wider it answers about bytes, not
  // about values (critic, 2026-09-22, finding 8). Its one caller today is the labelmap ingest.
  opts: { compressor?: "deflate" | "raw"; census?: boolean } = {},
): Promise<ZarrBlobs> {
  // Default deflate, so every existing caller and every stored descriptor is unaffected. The load
  // path asks for "raw" explicitly -- see volumeNodes.
  const compressor = opts.compressor ?? "deflate";
  // Phase accounting. Raw ingest of a 300 MB series still costs 0.6s, and SHA-256 alone measures
  // ~2 GB/s, so most of that is materializing padded chunks rather than hashing them. Worth knowing
  // before trying to remove it: a pre-shaped store would avoid the copy, and that is a bigger change
  // than a flag.
  let msMaterialize = 0, msCodec = 0;
  const [nx, ny, nz] = dims;
  const shape: [number, number, number] = [nz, ny, nx];
  const chunks: [number, number, number] = [Math.min(CHUNK_MAX[0], nz), Math.min(CHUNK_MAX[1], ny), Math.min(CHUNK_MAX[2], nx)];
  const grid: [number, number, number] = [Math.ceil(nz / chunks[0]), Math.ceil(ny / chunks[1]), Math.ceil(nx / chunks[2])];
  const [cz, cy, cx] = chunks;
  const Ctor = data.constructor as new (n: number) => Volume["data"];
  const bpe = (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
  const blobs = new Map<string, Uint8Array>();
  const chunkHashes: Record<string, string> = {};
  let bytes = 0;

  // Chunks are compressed and hashed with BOUNDED CONCURRENCY, not one after another. Each chunk
  // costs a CompressionStream (via a Blob and a Response) plus a SubtleCrypto digest, both async and
  // both dominated by setup rather than by the work: awaited in sequence, a 993-slice series spent
  // 11.1s here -- more than thirty times the cost of reading and parsing the DICOM that produced it.
  //
  // Each chunk's payload is materialized INSIDE its task, not up front: holding all 192 padded
  // chunks of a large series at once would cost hundreds of megabytes for no benefit.
  const tasks: Array<[number, number, number]> = [];
  for (let kk = 0; kk < grid[0]; kk++) for (let jj = 0; jj < grid[1]; jj++) for (let ii = 0; ii < grid[2]; ii++) tasks.push([kk, jj, ii]);

  /** Materialize one chunk's padded payload. */
  const payload = (kk: number, jj: number, ii: number): Uint8Array => {
    const sub = new Ctor(cz * cy * cx);                                          // zero-padded full chunk
    const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
    const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
    for (let z = 0; z < zw; z++) for (let y = 0; y < yw; y++) {
      const src = ((z0 + z) * ny + (y0 + y)) * nx + x0, dst = (z * cy + y) * cx;
      (sub as unknown as { set(a: ArrayLike<number>, o: number): void }).set((data as unknown as { subarray(a: number, b: number): ArrayLike<number> }).subarray(src, src + xw), dst);
    }
    return new Uint8Array(sub.buffer, sub.byteOffset, sub.length * bpe);
  };

  const record = (kk: number, jj: number, ii: number, comp: Uint8Array, h: string) => {
    // has() and set() run together with no await between them, so identical chunks cannot double-count.
    if (!blobs.has(h)) { blobs.set(h, comp); bytes += comp.byteLength; }
    chunkHashes[`${kk}.${jj}.${ii}`] = h;
  };

  /** The merged census, when one was asked for (see ZarrBlobs.seen). */
  let seenAll: Uint8Array | undefined;
  const pool = chunkWorkers();
  if (pool.length) {
    // One task in flight per worker; each finishes and takes the next.
    let next = 0;
    // TERMINATED WHATEVER HAPPENS. This stood after the await, so one worker's error rejected the
    // Promise.all and left all eight alive for the session (critic, 2026-09-22, finding 11).
    try {
    await Promise.all(pool.map((w) =>
      new Promise<void>((resolve, reject) => {
        const send = () => {
          const t = next++;
          if (t >= tasks.length) { resolve(); return; }
          const [kk, jj, ii] = tasks[t];
          const tm = performance.now();
          const raw = payload(kk, jj, ii);
          const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
          msMaterialize += performance.now() - tm;   // the copy, on this thread; the codec is in the worker
          w.onmessage = (e: MessageEvent<{ id: number; comp: ArrayBuffer; hash: string; seen?: ArrayBuffer }>) => {
            const [k2, j2, i2] = tasks[e.data.id];
            record(k2, j2, i2, new Uint8Array(e.data.comp), e.data.hash);
            if (e.data.seen) { const s8 = new Uint8Array(e.data.seen); seenAll ??= new Uint8Array(256); for (let v = 0; v < 256; v++) if (s8[v]) seenAll[v] = 1; }
            send();
          };
          w.onerror = (err: unknown) => reject(err);
          // The real extent of this chunk, so an edge chunk's zero padding is not counted as data.
          const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
          const real: [number, number, number, number, number] = [cx, cy, Math.min(cx, nx - x0), Math.min(cy, ny - y0), Math.min(cz, nz - z0)];
          w.postMessage({ id: t, raw: buf, compressor, census: !!opts.census, ...(opts.census ? { real } : {}) }, [buf]);
        };
        send();
      })
    ));
    } finally { for (const w of pool) w.terminate(); }
  } else {
    // No workers (a non-browser context, or construction failed): do it here. Correct, just slower.
    for (const [kk, jj, ii] of tasks) {
      let t = performance.now();
      const p = payload(kk, jj, ii);
      msMaterialize += performance.now() - t;
      t = performance.now();
      const comp = compressor === "raw" ? p : await deflate(p);
      const hash = await sha256(comp);
      msCodec += performance.now() - t;
      record(kk, jj, ii, comp, hash);
    }
  }
  lastIngestPhases = {
    materializeMs: msMaterialize,
    codecMs: msCodec,
    chunks: tasks.length,
    workers: pool.length,
    compressor,
  };
  // NO POOL, NO FREE CENSUS: the fallback path compresses on this thread, so it counts here too
  // rather than leaving the caller to walk the volume again.
  if (opts.census && !seenAll) {
    seenAll = new Uint8Array(256);
    const bytes8 = new Uint8Array((data as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }).buffer, (data as unknown as { byteOffset: number }).byteOffset, (data as unknown as { byteLength: number }).byteLength);
    for (let i = 0; i < bytes8.length; i++) seenAll[bytes8[i]] = 1;
  }
  return { desc: { shape, chunks, chunkGrid: grid, dtype, bytes, chunkHashes, compressor }, blobs, ...(seenAll ? { seen: seenAll } : {}) };
}

/** Serves locally produced blobs to the DisplayableManagers (chained in front of whatever fetch was installed). */
export class LocalBlobStore {
  private blobs = new Map<string, Uint8Array>();
  private installed = false;
  private onStore?: (hash: string, bytes: Uint8Array) => void;
  constructor(opts: { onStore?: (hash: string, bytes: Uint8Array) => void } = {}) { this.onStore = opts.onStore; }
  add(blobs: Map<string, Uint8Array>): void {
    for (const [h, b] of blobs) { if (!this.blobs.has(h)) { this.blobs.set(h, b); this.onStore?.(h, b); } }
    this.install();
  }
  has(hash: string): boolean { return this.blobs.has(hash); }
  get(hash: string): Uint8Array | undefined { return this.blobs.get(hash); }
  size(): number { return this.blobs.size; }
  /**
   * What the store is holding, in bytes — the chunks of every volume and labelmap in the session.
   *
   * MISSING FROM THE MEMORY REPORT UNTIL NOW, and it is not small: the critic measured 867 MB here
   * on a page the report called "438 MB, all of it drawn" (2026-09-22). A report that cannot see
   * the largest holder is worse than no report, because it is believed.
   */
  bytes(): number { let n = 0; for (const b of this.blobs.values()) n += b.byteLength; return n; }
  /**
   * GIVE BACK A VOLUME'S CHUNKS once its texture is up.
   *
   * The store is not an archive: it is the box the renderer reads from, and for a grayscale volume
   * the renderer has read it exactly once, into a texture. A whole-body CT sat here as 864 MB of
   * uncompressed blocks for the rest of the session, beside the 798 MB texture made from them —
   * two copies of the same voxels, in a window whose ceiling is about 4 GB (2026-09-22).
   *
   * Anything that wants the voxels again — the colorized volume, statistics, a crop, an edit, a
   * re-save — gets them through `onMiss` below, which reads the series from the DICOM database
   * again: 2.1 s measured, against 864 MB held all session.
   */
  release(hashes: Iterable<string>): number {
    let freed = 0;
    for (const h of hashes) { const b = this.blobs.get(h); if (b) { freed += b.byteLength; this.blobs.delete(h); } }
    return freed;
  }
  /**
   * What to do when a chunk is asked for and is not here: rebuild it, and say whether it worked.
   *
   * Registered by the application (it is the part that knows about the DICOM database). Returning
   * false means the caller falls through to the network as before, so a store with no rebuilder
   * behaves exactly as it always did.
   */
  private onMiss?: (hash: string) => Promise<boolean>;
  setOnMiss(fn: (hash: string) => Promise<boolean>): void { this.onMiss = fn; }
  private install(): void {
    if (this.installed) return;
    this.installed = true;
    // The direct way in, for code that only wants the bytes (render/zarr.ts, setLocalChunk).
    setLocalChunk((h) => this.blobs.get(h));
    const prev = getBlobFetch();
    setBlobFetch(async (url) => {
      const h = url.slice(url.lastIndexOf("/") + 1);
      const b = this.blobs.get(h);
      if (b) return new Response(b as BlobPart, { status: 200 });
      // Released after its texture was made (see `release`): read it back from the database, once.
      if (this.onMiss && await this.onMiss(h)) {
        const again = this.blobs.get(h);
        if (again) return new Response(again as BlobPart, { status: 200 });
      }
      return await prev(url);
    });
  }
}

let seq = 0;
export const nextLocalId = (kind: string) => `local-${kind}-${++seq}-${Date.now().toString(36)}`;

/**
 * Timing hook the application installs (render/demos/load-profile.ts `spanSync`), so the load profile
 * can say which part of an ingest costs what. Ron's load on 2026-09-23 spent 1.6 s in "volume onto
 * the GPU (ingest)" with no cutting, hashing or histogram left in it; this names what remains. A
 * no-op elsewhere.
 */
let timedSync: <T>(name: string, fn: () => T) => T = (_n, fn) => fn();
export function setIngestTimers(s: typeof timedSync): void { timedSync = s; }

/** Slicer's default W/L for a new volume is the 0.1..99.9 percentile range (vtkMRMLScalarVolumeDisplayNode::CalculateAutoLevels);
 *  W3 lands the exact histogram; this is the same idea on a subsample so W1 shows something sensible. */
export function percentileWindowLevel(data: Volume["data"], lo = 0.001, hi = 0.999): { window: number; level: number; range: [number, number] } {
  // W3: the exact vtkImageHistogramStatistics-style histogram (logic/window-level.ts), not the old subsample sort.
  const [a, b] = histogramPercentiles(data as Parameters<typeof histogramPercentiles>[0], lo, hi);
  let mn = Infinity, mx = -Infinity;
  const n = data.length, step = Math.max(1, Math.floor(n / 500000));
  for (let i = 0; i < n; i += step) { const v = data[i] as number; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { window: Math.max(1e-6, b - a), level: (a + b) / 2, range: [mn, mx] };
}

export interface LoadedVolume { imageId: string; displayId: string; nodes: MrsonNode[] }

/** Build the mrson nodes for a local volume (no scene side effects; testable). */
export async function volumeNodes(vol: Volume, opts: { name?: string; labelmap?: boolean; /** false: the samples are not handed to the reader's cache (a sequence frame not on screen). */ place?: boolean } = {}): Promise<{ nodes: MrsonNode[]; blobs: Map<string, Uint8Array>; imageId: string; displayId: string }> {
  // Grayscale volumes are stored RAW; labelmaps stay deflated.
  //
  // Not a preference — the two compress completely differently and are read completely differently.
  // A labelmap is mostly zeros and deflates by more than an order of magnitude, so compressing it is
  // nearly free and saves a great deal of space. A CT gets about 2:1 for real work: ingesting a
  // 300 MB series cost 2.0s of a 3.5s load, deflating chunks that the line below then makes
  // unnecessary by handing the scalars straight to the reader's cache. Compressing bytes that
  // nothing decompresses is pure loss, and disk is the cheap resource here.
  //
  // FROM A DUCKN WORKING COPY the pieces, their names and the display arrive made (Volume.prebuilt,
  // render/zarr-copy.ts): the converter cut and hashed them with volumeToZarr and took this same
  // histogram, so nothing is redone here. Used once, then dropped, so the volume object does not
  // keep a second hold on pieces the store may later release.
  const pre = !opts.labelmap ? vol.prebuilt : undefined;
  if (vol.prebuilt) delete vol.prebuilt;
  const { desc, blobs } = pre
    ? (lastIngestPhases = null, { desc: pre.desc as ZarrBlobs["desc"], blobs: pre.blobs })
    : await volumeToZarr(vol.data, vol.dims, vol.dtype, {
      compressor: opts.labelmap ? "deflate" : "raw",
    });
  const imageId = nextLocalId("image"), displayId = nextLocalId("display");
  const wl = pre ? { window: pre.display.window, level: pre.display.level, range: pre.display.range } : percentileWindowLevel(vol.data);
  // The scalars are in hand RIGHT NOW. Hand them to the reader's cache so the displayable manager
  // does not fetch the chunks we just wrote and inflate every one to rebuild this same array.
  // NOT FOR A FRAME THAT IS NOT PLACED: the cache keeps one volume, so for frames 2-5 of a
  // sequence this made a 559 MB float copy each that was dropped at once (critic, 2026-09-19,
  // finding 4). Their range is remembered instead, which is all a frame needs when its texture
  // is built later from the stored chunks.
  if (opts.place !== false) {
    timedSync("volume · ingest: floating-point copy for the decode cache", () => cacheDecodedVolume(desc, {
      data: vol.data instanceof Float32Array ? vol.data : Float32Array.from(vol.data),
      dims: vol.dims,
      range: [wl.range[0], wl.range[1]],
    }));
  } else rememberRange(desc, [wl.range[0], wl.range[1]]);
  const name = opts.name ?? vol.name ?? "Volume";
  const image: MrsonNode = {
    type: "image", id: imageId, name, frame: "RAS", dims: vol.dims, comps: 1, ijkToRAS: vol.ijkToRAS, zarr: desc,
    labelmap: !!opts.labelmap, refs: { display: [displayId] }, source: { mrmlClass: opts.labelmap ? "vtkMRMLLabelMapVolumeNode" : "vtkMRMLScalarVolumeNode" },
    origin: { local: true, dtype: vol.dtype, ...(vol.meta ?? {}) },
  };
  const display: MrsonNode = opts.labelmap
    ? { type: "labelMapDisplay", id: displayId, name: `${name} display`, frame: "RAS", visible: true, interpolate: false, refs: {}, source: { mrmlClass: "vtkMRMLLabelMapVolumeDisplayNode" }, origin: { local: true } }
    : { type: "scalarVolumeDisplay", id: displayId, name: `${name} display`, frame: "RAS", visible: true, window: wl.window, level: wl.level, autoWindowLevel: true,
        interpolate: true, applyThreshold: false, threshold: [wl.range[0], wl.range[1]], color: [1, 1, 1, 1], refs: {}, source: { mrmlClass: "vtkMRMLScalarVolumeDisplayNode" }, origin: { local: true } };
  return { nodes: [display, image], blobs, imageId, displayId };
}

/** Put the volume into the LiveScene as background of every slice composite (creating Red/Yellow/Green composites
 *  for a standalone scene that has none), so it shows exactly the way a Slicer-loaded volume would. */
export async function loadVolumeIntoScene(live: LiveScene, store: LocalBlobStore, vol: Volume, opts: { name?: string; labelmap?: boolean; layer?: "background" | "foreground" | "label"; /** false: into the scene but not into the slice views -- a frame of a sequence other than the one shown. */ place?: boolean; /** extra fields on the image node (a sequence's frames carry `hidden` and `sequence`). */ extra?: Record<string, unknown> } = {}): Promise<LoadedVolume> {
  const built = await volumeNodes(vol, { ...opts, place: opts.place });
  timedSync("volume · ingest: keep the pieces", () => store.add(built.blobs));
  timedSync("volume · ingest: into the scene", () => {
    for (const n of built.nodes) live.write({ op: "put", id: n.id, node: n.id === built.imageId && opts.extra ? { ...n, ...opts.extra } : n });
  });
  if (opts.place === false) return { imageId: built.imageId, displayId: built.displayId, nodes: built.nodes };
  const layer = opts.layer ?? (opts.labelmap ? "label" : "background");
  const composites = [...live.nodes.values()].filter((n) => n.type === "sliceComposite");
  if (composites.length === 0) {
    for (const ln of ["Red", "Yellow", "Green"]) {
      const id = `local-sliceComposite-${ln}`;
      live.write({ op: "put", id, node: { type: "sliceComposite", id, name: `${ln} composite`, layoutName: ln, refs: { [layer]: [built.imageId] }, foregroundOpacity: 0, labelOpacity: 1, compositing: 0, linkedControl: false, hotLinkedControl: false, source: { mrmlClass: "vtkMRMLSliceCompositeNode" }, origin: { local: true } } });
    }
  } else {
    timedSync("volume · ingest: into the slice views", () => {
      for (const c of composites) live.write({ op: "patch", id: c.id, path: `#/refs/${layer}`, value: [built.imageId] });
    });
  }
  return { imageId: built.imageId, displayId: built.displayId, nodes: built.nodes };
}

/**
 * Take a volume out of the scene, and re-point every slice composite that was showing it.
 *
 * A composite names its layers BY NODE ID. Deleting the volume a composite has as its background
 * leaves that reference dangling -- and a dangling reference is not the same as no reference. The
 * layer resolves to nothing while the composite still claims to have one, so the per-view "hidden
 * in this view" note does not apply either: the slice views just go empty, with a full 3D rendering
 * beside them and nothing on screen connecting the two. Ron, with four datasets loaded and one
 * deleted: "showing the slices still does not work."
 *
 * The replacement is another loaded volume of the same kind -- a labelmap for the label layer, a
 * scalar volume for background/foreground -- or the layer is dropped when nothing is left to show.
 * Dropping it matters: an ABSENT background is a state the slice views can explain, a dangling one
 * is not.
 *
 * The volume's display node goes with it. Nothing else references it, and leaving it behind is what
 * makes a later volume inherit a window/level that was never set for it.
 */
export function removeVolumeFromScene(live: LiveScene, imageId: string): void {
  const node = live.nodes.get(imageId);
  live.write({ op: "del", id: imageId });
  for (const d of ((node?.refs as Record<string, string[]> | undefined)?.display ?? [])) {
    if (live.nodes.get(d)) live.write({ op: "del", id: d });
  }
  const left = [...live.nodes.values()].filter((n) => n.type === "image" && n.id !== imageId);
  const pick = (labelmap: boolean) => left.filter((n) => !!n.labelmap === labelmap).map((n) => n.id).pop();
  for (const c of [...live.nodes.values()]) {
    if (c.type !== "sliceComposite") continue;
    const refs = { ...((c.refs as Record<string, string[]> | undefined) ?? {}) };
    let changed = false;
    for (const role of ["background", "foreground", "label"] as const) {
      if (refs[role]?.[0] !== imageId) continue;
      const rep = pick(role === "label");
      if (rep) refs[role] = [rep]; else delete refs[role];
      changed = true;
    }
    if (changed) live.write({ op: "patch", id: c.id, path: "#/refs", value: refs });
  }
}
