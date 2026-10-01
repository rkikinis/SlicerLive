// Minimal OME-Zarr volume loader — a TS port of the viewer's fetchZarrVolume.
// Pulls all chunks in parallel, gunzips each with DecompressionStream("deflate")
// (native in both Deno and browsers — no bundled zlib), and assembles them into
// one typed array in C-order (z,y,x). The rotated IJK->RAS geometry is carried
// separately in the scene json (attrs.ijkToRAS), not in the zarr.

import { assembleChunk, inflateDeflate, ZDT } from "./zarr-assemble.ts";
import { workerUrl } from "./build-id.ts";
export { assembleChunk };

export interface ZarrDesc {
  dir?: string;                // legacy positional layout: "<id>.zarr"
  dataset?: string;            // legacy: "0"
  shape: [number, number, number];   // (nz, ny, nx)  C-order
  chunks: [number, number, number];  // (cz, cy, cx)
  chunkGrid: [number, number, number]; // (ncz, ncy, ncx)
  dtype: string;               // e.g. "<i2"
  bytes?: number;
  chunkHashes?: Record<string, string>; // "k.j.i" -> content hash; chunk fetched at blobBase + hash
  /**
   * How the chunks are stored. **Absent means `"deflate"`**, so every existing descriptor keeps
   * working untouched.
   *
   * The reason this is a field rather than a constant: a store had to be entirely compressed or
   * entirely raw, so mixing them — hot data raw for speed, cold data compressed for size — would
   * have needed a format migration rather than a flag. One field now, and an aging policy stays
   * possible later.
   *
   * `"raw"` exists because compressing data that is about to be decompressed is pure loss. Ingesting
   * a 300 MB volume cost 2.0s of a 3.5s load, almost all of it deflating chunks that the renderer
   * inflates again moments later.
   */
  compressor?: "deflate" | "raw";
}



export interface ZarrVolume {
  data: Float32Array;                 // scalars as f32, ready for an r32float 3D texture
  dims: [number, number, number];     // (nx, ny, nz) — i,j,k extents (texture upload order)
  range: [number, number];            // observed [min, max] scalar value
}

/** Like ZarrVolume but keeps the stored NATIVE dtype (e.g. Uint8Array for "<u1") — 4× less host
 *  RAM and GPU upload than expanding to f32, so a matching-format texture (r8unorm) is cheap. */
export interface ZarrVolumeNative {
  data: Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
  dtype: string;
  dims: [number, number, number];
  range: [number, number];
  /**
   * The chunks that hold anything, unpacked, each at its place in the grid -- when asked for.
   *
   * For uploading a labelmap to the card: 70 to 97% of a segmentation's chunks are all zeros (Ron's
   * four, 2026-09-23), and a new texture on the card already is zeros, so only these need sending.
   */
  chunks?: { shape: [number, number, number]; nonEmpty: { at: [number, number, number]; bytes: ArrayBuffer }[] };
}


/** Pluggable blob fetch: a SessionStore installs one that serves content-addressed blobs from its
 *  blobs/ cache and tees network fetches into it. Default = plain fetch. */
export type BlobFetch = (url: string) => Promise<Response>;
let blobFetch: BlobFetch = (url) => fetch(url);
export function setBlobFetch(f: BlobFetch | null): void { blobFetch = f ?? ((url) => fetch(url)); }
export function getBlobFetch(): BlobFetch { return blobFetch; }

/**
 * A CHUNK THAT IS ALREADY IN THE PAGE, handed over directly. The local store installs this
 * (logic/ingest.ts). Going through `blobFetch` wraps each chunk in a Response and reads it back
 * out -- three waits per chunk, 432 chunks per whole-body labelmap, each one queued behind whatever
 * else the page is doing. For data that is sitting in a Map that is pure delay.
 */
let localChunk: ((hash: string) => Uint8Array | undefined) | null = null;
export function setLocalChunk(fn: ((hash: string) => Uint8Array | undefined) | null): void { localChunk = fn; }

/** Where the unpacking says how long it took, so the load profile can show the two parts apart. */
let noteTiming: ((name: string, ms: number) => void) | null = null;
export function setZarrTimings(fn: ((name: string, ms: number) => void) | null): void { noteTiming = fn; }

/** Fetch + assemble a zarr volume into an f32 array (C-order z,y,x). `blobBase`
 *  is the URL prefix that `dir` is relative to. onBytes(n) reports each chunk's
 *  compressed size for a progress bar. */
/**
 * Volumes already decoded in this session, so a just-ingested volume is not compressed and then
 * immediately decompressed again.
 *
 * A locally loaded volume takes a wasteful round trip: reconstructSeries produces the scalars,
 * volumeToZarr compresses them into 192 chunks, and then the displayable manager calls
 * fetchZarrVolume, which fetches those same chunks straight back and inflates every one to rebuild
 * the array that was in hand a moment earlier. For a 300 MB series that second half is tens of
 * seconds of pure duplication.
 *
 * Keyed on the chunk-hash set, which is content-addressed: a different volume cannot collide with
 * it, and an identical volume legitimately hits. Entries are weak-ish by policy -- one volume at a
 * time is kept, since the case this serves is "the volume just loaded", not a general LRU.
 */
const decoded = new Map<string, ZarrVolume>();

/** What the two decoded caches are holding right now, for the memory report. */
export function decodedCacheReport(): { what: string; mb: number }[] {
  const out: { what: string; mb: number }[] = [];
  const mb = (d: { length: number; BYTES_PER_ELEMENT?: number }) => Math.round(d.length * (d.BYTES_PER_ELEMENT ?? 4) / 1048576);
  for (const v of decoded.values()) if (v.data.length) out.push({ what: "last decoded volume, kept for a repeat read (float32)", mb: mb(v.data) });
  for (const v of decodedNative.values()) if (v.data.length) out.push({ what: "last decoded labelmap, kept for a repeat read", mb: mb(v.data as unknown as { length: number; BYTES_PER_ELEMENT?: number }) });
  return out;
}

/**
 * FORGET WHAT IS ON THE GPU. The cache exists so that the manager that decodes a volume and the one
 * that draws it a moment later do not read it twice; once the texture is up, keeping 1.6 GB of
 * float32 samples against a possible repeat is the most expensive guess in the application. Called
 * when a field has been built from them (livescene). A later reader re-reads from the local store.
 */
export function forgetDecoded(z: ZarrDesc): void {
  const k = descKey(z);
  if (!k) return;
  decoded.delete(k);
  decodedNative.delete(k);
}

/** The content key of a stored volume: every chunk hash, so two volumes are the same only when their samples are. */
export function descKey(z: ZarrDesc): string | null {
  if (!z.chunkHashes) return null;
  const keys = Object.keys(z.chunkHashes).sort();
  if (!keys.length) return null;
  // EVERY chunk hash, not the first and the last. Those two are the volume's corner chunks, and in
  // a labelmap the corners are empty: four MOOSE segmentations of one CT all began and ended with
  // the same all-zero chunk (sha256-1e6…), collided on one key, and every fetch of any of them
  // returned whichever had been decoded last. Found when a merge of the four reported that pelvis,
  // right atrium, gallbladder and duodenum shared 557,046 voxels exactly. 2026-09-11.
  return `${z.shape.join("x")}|${z.dtype}|${keys.length}|${keys.map((k) => z.chunkHashes![k]).join(",")}`;
}

/** Register an already-decoded volume, so the next fetch of the same desc is free. */
export function cacheDecodedVolume(z: ZarrDesc, vol: ZarrVolume): void {
  const k = descKey(z);
  if (!k) return;
  decoded.clear();               // keep one: these are hundreds of megabytes each
  decoded.set(k, vol);
}

// The same trick for volumes read in their STORED dtype. A labelmap must be cached this way: a
// 149-million-voxel u8 labelmap widened to Float32 is 596 MB to allocate and convert element by
// element, which costs more than the fetch-and-inflate it was meant to avoid.
const decodedNative = new Map<string, ZarrVolumeNative>();

/** Register an already-decoded volume in its stored dtype (no widening). */
export function cacheDecodedVolumeNative(z: ZarrDesc, vol: ZarrVolumeNative): void {
  const k = descKey(z);
  if (!k) return;
  decodedNative.clear();
  decodedNative.set(k, vol);
}

/** The observed range of a volume whose samples are not kept (a sequence frame): dims and range
 *  are what the display code needs when the texture already exists. Never cleared; a few bytes each. */
const ranges = new Map<string, [number, number]>();
export function rememberRange(z: ZarrDesc, range: [number, number]): void { const k = descKey(z); if (k) ranges.set(k, range); }
export function knownRange(z: ZarrDesc): [number, number] | undefined { return ranges.get(descKey(z) ?? "") ?? decoded.get(descKey(z) ?? "")?.range; }

// ONE FETCH IN FLIGHT PER VOLUME. The slice manager and the volume rendering manager both ask
// for a frame the first time it shows, within the same tick; each fetched and widened the same
// 559 MB (critic, 2026-09-19, finding 4). The second caller now waits for the first's promise.
const inflight = new Map<string, Promise<ZarrVolume>>();

export function fetchZarrVolume(
  blobBase: string,
  z: ZarrDesc,
  onBytes?: (n: number) => void,
  concurrency = 12,
): Promise<ZarrVolume> {
  const key = descKey(z) ?? "";
  const hit = decoded.get(key);
  if (hit) return Promise.resolve(hit);      // just ingested: no need to fetch and inflate it again
  const going = key ? inflight.get(key) : undefined;
  if (going) return going;
  const p = (async () => {
    const zv = await fetchZarrVolumeNative(blobBase, z, onBytes, concurrency);
    const data = zv.data instanceof Float32Array ? zv.data : Float32Array.from(zv.data);
    rememberRange(z, zv.range);
    return { data, dims: zv.dims, range: zv.range };
  })();
  if (key) { inflight.set(key, p); p.finally(() => inflight.delete(key)).catch(() => {}); }
  return p;
}

/**
 * LET THE PAGE BREATHE between chunks. Even with row copies, 432 chunks can come back to back through
 * promise continuations that never let a timer or a fetch reply run -- which is how a request the
 * server answered in a millisecond measured seconds in the page. A macrotask every ~16 ms of work
 * caps any stall at about a frame. MessageChannel rather than setTimeout(0), which the browser clamps
 * to 4 ms and would add seconds over a volume.
 */
let lastYield = 0;
function breathe(): Promise<void> | null {
  const t = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (t - lastYield < 16) return null;
  lastYield = t;
  if (typeof MessageChannel === "undefined") return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });
}

/**
 * WORKERS KEPT, NOT STARTED PER LABELMAP. Measured at both ends of the handover (2026-09-23, build
 * 09:18): starting a new worker per labelmap cost up to 1.32 s before it received its job -- the
 * worker's script fetched and compiled each time -- against 0.57 s for the unpacking itself. So a
 * few are started once, ahead of need (`warmAssemblyWorkers`, called when the application opens),
 * and every read after that hands its job to one that is already running.
 *
 * Requests carry an id and the worker echoes it, so one worker can serve several reads in turn. A
 * worker that dies takes its pending reads with it (they fall back to the page, as before) and is
 * replaced on the next request.
 */
type Pending = { resolve: (r: { data: ArrayBuffer; range: [number, number] | null; nonEmpty?: { at: [number, number, number]; bytes: ArrayBuffer }[] }) => void; reject: (e: Error) => void; tPost: number };
interface PoolWorker { w: Worker; pending: Map<number, Pending> }
const pool: PoolWorker[] = [];
let nextJob = 1, turn = 0;
const clockNow = () => performance.timeOrigin + performance.now();

function startAssemblyWorker(): PoolWorker {
  const pw: PoolWorker = { w: new Worker(workerUrl("./zarr-assemble-worker.js"), { type: "module" }), pending: new Map() };
  pw.w.onmessage = (e: MessageEvent<{ id?: number; data?: ArrayBuffer; range?: [number, number] | null; nonEmpty?: { at: [number, number, number]; bytes: ArrayBuffer }[]; error?: string; ms?: number; began?: number; ended?: number }>) => {
    const job = typeof e.data.id === "number" ? pw.pending.get(e.data.id) : undefined;
    if (!job) return;
    pw.pending.delete(e.data.id!);
    const heard = clockNow();
    if (typeof e.data.began === "number") noteTiming?.("labelmap · worker starting", e.data.began - job.tPost);
    if (typeof e.data.ended === "number") noteTiming?.("labelmap · page hearing back", heard - e.data.ended);
    if (typeof e.data.ms === "number") noteTiming?.("labelmap · unpack in a worker", e.data.ms);
    if (e.data.error || !e.data.data) job.reject(new Error(e.data.error ?? "the worker returned nothing"));
    else job.resolve({ data: e.data.data, range: e.data.range ?? null, ...(e.data.nonEmpty ? { nonEmpty: e.data.nonEmpty } : {}) });
  };
  pw.w.onerror = (ev) => {
    const why = new Error((ev as ErrorEvent).message || "the unpacking worker stopped");
    for (const job of pw.pending.values()) job.reject(why);
    pw.pending.clear();
    const at = pool.indexOf(pw);
    if (at >= 0) pool.splice(at, 1);
    pw.w.terminate();
  };
  pool.push(pw);
  return pw;
}

/** Start the unpacking workers now, so the first load finds them running. Harmless to call twice. */
export function warmAssemblyWorkers(n = 4): void {
  if (typeof Worker === "undefined" || typeof document === "undefined") return;
  while (pool.length < n) startAssemblyWorker();
}

/** The next worker in turn, starting one if none is running. */
function assemblyWorker(): PoolWorker {
  if (!pool.length) startAssemblyWorker();
  return pool[turn++ % pool.length];
}

/** The compressed chunks to a worker, the finished volume back (render/zarr-assemble-worker.ts). */
async function assembleInWorker(
  jobs: [number, number, number][],
  chunkUrl: (kk: number, jj: number, ii: number) => string,
  z: ZarrDesc,
  shape: [number, number, number],
  chunks: [number, number, number],
  wantRange: boolean,
  onBytes?: (n: number) => void,
  wantChunks = false,
): Promise<ZarrVolumeNative> {
  const tGather = performance.now();
  const hashes = z.chunkHashes;
  const parts = await Promise.all(jobs.map(async (at) => {
    // Straight out of the store when the chunk is there; through blobFetch only when it is not.
    const local = hashes && localChunk ? localChunk(hashes[at[0] + "." + at[1] + "." + at[2]]) : undefined;
    let bytes: ArrayBuffer;
    if (local) {
      bytes = local.slice().buffer as ArrayBuffer;         // a copy, so handing it over takes nothing from the store
    } else {
      const r = await blobFetch(chunkUrl(at[0], at[1], at[2]));
      if (!r.ok) throw new Error(`a chunk could not be read (HTTP ${r.status})`);
      bytes = await r.arrayBuffer();
    }
    onBytes?.(bytes.byteLength);
    return { at, bytes };
  }));
  noteTiming?.("labelmap · gather the chunks", performance.now() - tGather);
  // THE HANDOVER, TIMED AT BOTH ENDS. Ron's load at 08:55: the read took up to 3.2 s while the
  // unpacking itself was 0.5 s at worst and the gathering nothing -- so the rest is either the
  // worker being slow to start or the page being slow to hear back, and those want different
  // fixes. Clock times on both sides (timeOrigin + now), because each thread's performance.now()
  // counts from its own start.
  const pw = assemblyWorker();
  const id = nextJob++;
  const res = await new Promise<{ data: ArrayBuffer; range: [number, number] | null; nonEmpty?: { at: [number, number, number]; bytes: ArrayBuffer }[] }>((resolve, reject) => {
    pw.pending.set(id, { resolve, reject, tPost: clockNow() });
    pw.w.postMessage(
      { id, dtype: z.dtype, shape, chunks, compressor: z.compressor ?? "deflate", wantRange, wantChunks, parts },
      parts.map((p) => p.bytes),
    );
  });
  const Ctor = ZDT[z.dtype] ?? Int16Array;
  const [nz, ny, nx] = shape;
  return {
    data: new Ctor(res.data), dtype: z.dtype, dims: [nx, ny, nz], range: res.range ?? [0, 0],
    ...(res.nonEmpty ? { chunks: { shape: chunks, nonEmpty: res.nonEmpty } } : {}),
  };
}

/** As fetchZarrVolume, but the assembled array keeps the stored dtype (no f32 expansion). */
export async function fetchZarrVolumeNative(
  blobBase: string,
  z: ZarrDesc,
  onBytes?: (n: number) => void,
  concurrency = 12,
  /** Whether to compute the value range. A labelmap's is never read; a scalar volume's sets window/level. */
  wantRange = true,
  /** Whether to hand back the non-empty chunks as well (see ZarrVolumeNative.chunks). */
  wantChunks = false,
): Promise<ZarrVolumeNative> {
  const hitNative = decodedNative.get(descKey(z) ?? "");
  if (hitNative) return hitNative;           // just ingested: no need to fetch and inflate it again
  const Ctor = ZDT[z.dtype] ?? Int16Array;
  const [nz, ny, nx] = z.shape, [cz, cy, cx] = z.chunks, [ncz, ncy, ncx] = z.chunkGrid;
  // Content-addressed chunks (chunkHashes: "k.j.i" -> hash, fetched flat at blobBase+hash) or
  // the legacy positional layout (blobBase + dir/dataset/k.j.i).
  const hashes = z.chunkHashes;
  const posBase = blobBase + z.dir + "/" + z.dataset + "/";
  const chunkUrl = (kk: number, jj: number, ii: number) =>
    hashes ? blobBase + hashes[kk + "." + jj + "." + ii] : posBase + kk + "." + jj + "." + ii;
  const out = new Ctor(nz * ny * nx);   // NATIVE dtype (e.g. Uint8Array) — no f32 blow-up
  let lo = Infinity, hi = -Infinity;

  const jobs: [number, number, number][] = [];
  for (let kk = 0; kk < ncz; kk++) for (let jj = 0; jj < ncy; jj++) for (let ii = 0; ii < ncx; ii++) jobs.push([kk, jj, ii]);

  // COMPRESSED CHUNKS ARE UNPACKED IN A WORKER, when there is a page whose thread is worth keeping
  // free. Only compressed ones: they are small to hand over and the unpacking is the work. A raw
  // volume (the CT) is already its own size, and moving 864 MB to a worker would cost more than the
  // copy it saves. If the worker cannot do it, this thread still can, and says so.
  if (z.compressor !== "raw" && typeof document !== "undefined" && typeof Worker !== "undefined") {
    try {
      return await assembleInWorker(jobs, chunkUrl, z, [nz, ny, nx], [cz, cy, cx], wantRange, onBytes, wantChunks);
    } catch (e) {
      console.warn(`the volume could not be unpacked in a worker (${(e as Error)?.message ?? e}); unpacking it on the page instead`);
    }
  }

  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const [kk, jj, ii] = jobs[idx++];
      // Stream the body so onBytes reports progress DURING the download — with
      // large (even single-chunk) volumes on a throttled store, an arrayBuffer()
      // wait looks like a hang to the user.
      const resp = await blobFetch(chunkUrl(kk, jj, ii));
      // A REFUSED PIECE IS AN ERROR, NOT DATA (critic, 2026-09-23, round 2, finding 5): the store answers
      // an unknown piece with 404 "Not Found", and those nine bytes were read as voxels -- a one-byte
      // volume came back with "Not Found" in its first row and no error at all.
      if (!resp.ok) throw new Error(`piece ${kk}.${jj}.${ii} could not be read (HTTP ${resp.status})`);
      let gz: ArrayBuffer;
      if (resp.body && onBytes) {
        const parts: Uint8Array[] = [];
        const rd = resp.body.getReader();
        let total = 0;
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          parts.push(value);
          total += value.byteLength;
          onBytes(value.byteLength);
        }
        const all = new Uint8Array(total);
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.byteLength; }
        gz = all.buffer;
      } else {
        gz = await resp.arrayBuffer();
        onBytes?.(gz.byteLength);
      }
      // Absent compressor means deflate: every descriptor written before the field existed is
      // compressed, and must keep loading.
      const raw = z.compressor === "raw" ? gz : await inflateDeflate(gz);
      const chunk = new Ctor(raw);                        // (cz,cy,cx) C-order, padded to full chunk shape
      const r = assembleChunk(out as never, chunk as never, [nz, ny, nx], [cz, cy, cx], [kk, jj, ii], wantRange);
      if (r) { if (r[0] < lo) lo = r[0]; if (r[1] > hi) hi = r[1]; }
      const pause = breathe();
      if (pause) await pause;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  // Without a range asked for, [0, 0] -- no caller of that form reads it, and a made-up range would be
  // worse than an obviously empty one if one ever did.
  return { data: out, dtype: z.dtype, dims: [nx, ny, nz], range: wantRange ? [lo, hi] : [0, 0] };
}
