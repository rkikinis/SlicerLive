// THE PAGE'S SIDE OF THE DUCKN WORKING COPY: a series' volumes read from its copy instead of from
// its DICOM files -- the one description the server validates, then the pieces, fetched and
// unpacked by workers and put into place here as they arrive.
//
// Ron, 2026-09-23: "only reading one header instead of 700+". The copy is written by the server
// (desktop/duckn-copy.ts) from the same functions the DICOM load uses, so what comes back here is
// the same volume: same voxels, same ijkToRAS, same meta, and pieces under the page's own sha256
// names, which the ingest takes as they are (Volume.prebuilt). The workspace brief is
// Contents/docs/DUCKN-WORKING-COPY.md.
//
// Anything short of a valid copy -- none, stale, another converter's, a piece that fails -- returns
// `{ missing }` and the caller reads the DICOM files as always. Nothing depends on a copy existing.
import { workerUrl } from "./build-id.ts";
import { COPY_CODE } from "../desktop/duckn-copy-code.ts";
import { interpreterCodes } from "../logic/readers/volume-interpreters.ts";
import { assembleChunk } from "./zarr-assemble.ts";
import type { Volume } from "../logic/readers/nifti.ts";
import type { FrameTiming } from "../logic/readers/dicom-series.ts";

interface ArrayDesc {
  attributes: { duckn: { extensions: { albula: {
    volume: { name?: string; dims: [number, number, number]; ijkToRAS: number[]; dtype: string; meta?: Record<string, unknown>; geometry?: Volume["geometry"] };
    frame: { index: number; label: string; timing: FrameTiming };
    display: { window: number; level: number; range: [number, number] };
    zarr: { shape: [number, number, number]; chunks: [number, number, number]; chunkGrid: [number, number, number]; dtype: string; bytes?: number; chunkHashes: Record<string, string> };
  } } } };
}
interface CopyAnswer { group: { code?: string; frames: string[]; labels: string[]; leftOut: string[]; instances: number }; arrays: ArrayDesc[]; base: string }

export interface CopySequence {
  frames: Volume[];
  labels: string[];
  timing: FrameTiming[];
  leftOut: string[];
  /** Where the time went: the one description, fetching and unpacking the pieces, putting them in place (on the page). */
  ms: { describe: number; pieces: number; place: number };
  packedBytes: number;
  pieces: number;
}

type Ctor = new (b: ArrayBuffer) => Volume["data"];
const TYPED: Record<string, { ctor: Ctor; bpe: number }> = {
  "<i2": { ctor: Int16Array as unknown as Ctor, bpe: 2 },
  "<u2": { ctor: Uint16Array as unknown as Ctor, bpe: 2 },
  "|u1": { ctor: Uint8Array as unknown as Ctor, bpe: 1 },
  "|i1": { ctor: Int8Array as unknown as Ctor, bpe: 1 },
  "<f4": { ctor: Float32Array as unknown as Ctor, bpe: 4 },
};

type Reply = { id: number; out?: ArrayBuffer; packed?: number; error?: string };
type PoolWorker = { w: Worker; pending: Map<number, (m: Reply) => void> };

/**
 * A few workers, started once and kept; 8 measured as fast as 10 on a 10-core machine.
 *
 * SHARED BY EVERY READ, SO EVERY REPLY IS ROUTED BY ITS OWN NUMBER to whoever asked. Each read used
 * to set the workers' message handler itself, so a second read started while the first was running
 * took the first read's pieces: one read never finished, the other finished early or crashed
 * (critic, 2026-09-23, finding 1 -- the Load button, a scene and the comparison check can all start
 * one). A worker that fails -- its script missing, a crash -- ends every request waiting on it with
 * an error, so a read falls back to DICOM instead of waiting for ever (finding 7), and the pool is
 * started afresh next time.
 */
let pool: PoolWorker[] | null = null;
let nextId = 0;
let makeWorker = (): Worker => new Worker(workerUrl("./zarr-copy-worker.js"), { type: "module" });
/** For the tests: workers made another way (from source under Deno), the pool started afresh. */
export function setCopyWorkerFactory(f: () => Worker): void {
  if (pool) for (const o of pool) o.w.terminate();
  pool = null;
  makeWorker = f;
}
function workers(): PoolWorker[] {
  if (pool) return pool;
  const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 2));
  const made: PoolWorker[] = [];
  for (let i = 0; i < n; i++) {
    const pw: PoolWorker = { w: makeWorker(), pending: new Map() };
    pw.w.onmessage = (e: MessageEvent) => {
      const m = e.data as Reply;
      const done = pw.pending.get(m.id);
      if (done) { pw.pending.delete(m.id); done(m); }
    };
    pw.w.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      const why = `the unpacking worker failed (${ev.message || "it did not load"})`;
      for (const [id, done] of pw.pending) done({ id, error: why });
      pw.pending.clear();
      if (pool === made) { pool = null; for (const o of made) o.w.terminate(); }
    };
    made.push(pw);
  }
  pool = made;
  return pool;
}

/** A piece that has not arrived by then ends the read, which then loads from DICOM. */
const PIECE_TIMEOUT_MS = 30_000;

function askForPiece(pw: PoolWorker, job: { url: string; rawSize: number; hash: string }): Promise<Reply> {
  const id = ++nextId;
  return new Promise<Reply>((resolve) => {
    const timer = setTimeout(() => {
      if (pw.pending.delete(id)) resolve({ id, error: `a piece did not arrive within ${PIECE_TIMEOUT_MS / 1000} s` });
    }, PIECE_TIMEOUT_MS);
    pw.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    pw.w.postMessage({ id, url: job.url, rawSize: job.rawSize, hash: job.hash });
  });
}

const ZARR_TYPE: Record<string, string> = { "<i2": "int16", "<u2": "uint16", "|u1": "uint8", "|i1": "int8", "<f4": "float32" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * THE ZARR DESCRIPTION MUST SAY WHAT ALBULA WROTE. The page reads the grid and the pieces' names from
 * `extensions.albula`; Zarr's own fields are what any other tool reads and rewrites. A tool that
 * rechunks or recompresses keeps unknown extensions unchanged (duckn-spec §3.1), so after such a
 * rewrite `extensions.albula` would name a grid that is no longer there, and pieces of the same byte
 * count in another shape would pass every size check scrambled (critic, 2026-09-23, finding 6).
 * Null when they agree; otherwise what differs.
 */
function zarrDisagrees(arr: ArrayDesc & { shape?: unknown; data_type?: unknown; chunk_grid?: { name?: string; configuration?: { chunk_shape?: unknown } }; chunk_key_encoding?: unknown; codecs?: { name: string; configuration?: Record<string, unknown> }[] }): string | null {
  const z = arr.attributes.duckn.extensions.albula.zarr;
  if (!same(arr.shape, z.shape)) return `its shape (${JSON.stringify(arr.shape)} against ${JSON.stringify(z.shape)})`;
  if (arr.chunk_grid?.name !== "regular" || !same(arr.chunk_grid?.configuration?.chunk_shape, z.chunks)) return "its piece grid";
  if (arr.data_type !== ZARR_TYPE[z.dtype]) return `its data type (${String(arr.data_type)})`;
  if (!same(arr.chunk_key_encoding, { name: "default", configuration: { separator: "/" } })) return "its piece names";
  const c = arr.codecs ?? [];
  if (c.length !== 2 || c[0].name !== "bytes" || c[0].configuration?.endian !== "little" || c[1].name !== "zstd") return "its compression";
  return null;
}

/** Why a copy made by `code` (and read with `interpreters`) is not this page's to use, or null when it is. The
 *  interpreters are the extensions' (volume-interpreters.ts): a copy made with another version of one, or with one more
 *  or fewer, would hold other values per volume (the diffusion b-values, ...). */
export function copyMadeByOtherCode(code: string | undefined, pageCode = COPY_CODE, interpreters?: Record<string, string>, pageInterpreters: Record<string, string> = interpreterCodes()): string | null {
  if (code !== pageCode) return `the copy was made by other code than this page reads with (${code ?? "none named"}; this page is ${pageCode})`;
  const a = JSON.stringify(interpreters ?? {}), b = JSON.stringify(pageInterpreters);
  return a === b ? null : `the copy was read with other extensions than this page has (${a}; this page ${b})`;
}

/**
 * The volumes of one series from its working copy, or `{ missing }` with the reason there is none
 * to use. `dbBase` is the served database, `/_db/<id>/` as a full URL.
 */
export async function loadSequenceFromCopy(dbBase: string, seriesUID: string): Promise<CopySequence | { missing: string }> {
  const t0 = performance.now();
  const r = await fetch(new URL(`_zarr/${encodeURIComponent(seriesUID)}`, dbBase), { cache: "no-store" }).catch(() => null);
  if (!r) return { missing: "the server did not answer" };
  if (!r.ok) {
    const j = await r.json().catch(() => ({})) as { error?: string };
    return { missing: j.error ?? `HTTP ${r.status}` };
  }
  const answer = await r.json() as CopyAnswer;
  const describe = performance.now() - t0;
  // THE COPY MUST BE WHAT THIS PAGE'S READER WOULD MAKE, not only what the server's would (critic,
  // 2026-09-23, finding 2). A rebuild while the app is open installs the new page and leaves the old
  // server running; that server still accepts the old reader's copies. The page carries the code it
  // was bundled with and refuses a copy made by any other -- the series then loads from DICOM.
  const other = copyMadeByOtherCode(answer.group?.code, COPY_CODE, (answer.group as { interpreters?: Record<string, string> } | undefined)?.interpreters);
  if (other) return { missing: other };

  // Every piece of every volume, as one list of jobs, and each volume's array to put them into.
  type Job = { url: string; rawSize: number; hash: string; at: [number, number, number]; v: number };
  const jobs: Job[] = [];
  const built: { vol: Volume; blobs: Map<string, Uint8Array>; t: { ctor: Ctor; bpe: number }; z: ArrayDesc["attributes"]["duckn"]["extensions"]["albula"]["zarr"] }[] = [];
  for (const [f, arr] of answer.arrays.entries()) {
    const a = arr.attributes.duckn.extensions.albula;
    const t = TYPED[a.zarr.dtype];
    if (!t) return { missing: `the copy holds ${a.zarr.dtype}, which this page does not read` };
    const off = zarrDisagrees(arr);
    if (off) return { missing: `the copy's Zarr description no longer matches what Albula wrote: ${off} (rewritten by another tool?)` };
    const [nx, ny, nz] = a.volume.dims;
    const data = new t.ctor(new ArrayBuffer(nx * ny * nz * t.bpe));
    const blobs = new Map<string, Uint8Array>();
    const vol: Volume = {
      name: a.volume.name, dims: a.volume.dims, ijkToRAS: a.volume.ijkToRAS, data, dtype: a.volume.dtype,
      meta: a.volume.meta ? structuredClone(a.volume.meta) : undefined, geometry: a.volume.geometry,
      prebuilt: { desc: { ...a.zarr, compressor: "raw" }, blobs, display: a.display },
    };
    built.push({ vol, blobs, t, z: a.zarr });
    const [cz, cy, cx] = a.zarr.chunks;
    for (const [key, hash] of Object.entries(a.zarr.chunkHashes)) {
      const [kk, jj, ii] = key.split(".").map(Number);
      // The piece's name in the address: a rebuilt copy reuses the paths, and a piece must never
      // come from the browser's cache under a name it no longer has.
      const url = new URL(`${answer.base}/${answer.group.frames[f]}/c/${kk}/${jj}/${ii}?h=${hash.slice(7, 23)}`, dbBase).href;
      jobs.push({ url, rawSize: cz * cy * cx * t.bpe, hash, at: [kk, jj, ii], v: f });
    }
  }

  // Fetch, unpack and check in the workers, two in flight each, and put every piece in place as it
  // lands. This read's own counters: nothing another read does can move them.
  const t1 = performance.now();
  let place = 0, packedBytes = 0, next = 0, failed: string | null = null;
  const lane = async (pw: PoolWorker) => {
    while (!failed && next < jobs.length) {
      const job = jobs[next++];
      const m = await askForPiece(pw, job);
      if (failed) return;
      if (m.error || !m.out) { failed = m.error ?? "a piece did not come back"; return; }
      const b = built[job.v];
      const tp = performance.now();
      const piece = new b.t.ctor(m.out);
      assembleChunk(b.vol.data as unknown as Parameters<typeof assembleChunk>[0], piece as unknown as Parameters<typeof assembleChunk>[0],
        [b.z.shape[0], b.z.shape[1], b.z.shape[2]], b.z.chunks, job.at, false);
      b.blobs.set(job.hash, new Uint8Array(m.out));
      place += performance.now() - tp;
      packedBytes += m.packed ?? 0;
    }
  };
  const ws = workers();
  await Promise.all(ws.flatMap((pw) => [lane(pw), lane(pw)]));
  if (failed) return { missing: `a piece of the copy could not be used: ${failed}` };

  const f0 = answer.arrays.map((a) => a.attributes.duckn.extensions.albula.frame);
  return {
    frames: built.map((b) => b.vol),
    labels: f0.map((f) => f.label),
    timing: f0.map((f) => f.timing),
    leftOut: answer.group.leftOut,
    ms: { describe, pieces: performance.now() - t1 - place, place },
    packedBytes,
    pieces: jobs.length,
  };
}
