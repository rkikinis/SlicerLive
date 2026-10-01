// Compress + hash one zarr chunk, off the main thread.
//
// WHY THIS EXISTS. volumeToZarr spends its time in CompressionStream and SubtleCrypto, both of which
// are CPU-bound. Running them concurrently on the main thread changes nothing -- measured 11.1s ->
// 10.6s for a 993-slice series, because concurrent tasks on one thread merely interleave. Real
// parallelism needs real threads, and this is the smallest unit worth handing to one: raw chunk in,
// compressed bytes and their hash out.
//
// Chunk buffers are TRANSFERRED, not copied, in both directions -- a 2 MB chunk copied twice per
// chunk would give back much of what the threads win.

/** `census` counts which byte values occur in this chunk. `real` is the part of the chunk that is
 *  inside the volume -- `[cx, cy, xw, yw, zw]`, chunk widths first -- for an edge chunk whose
 *  remainder is zero padding. Without it the padding is counted and label 0 is reported as present
 *  in a volume that has none (critic, 2026-09-22, finding 8). */
import { chunkCensus } from "./chunk-census.ts";

export interface ChunkRequest { id: number; raw: ArrayBuffer; compressor?: "deflate" | "raw"; census?: boolean; real?: [number, number, number, number, number] }
export interface ChunkReply { id: number; comp: ArrayBuffer; hash: string; seen?: ArrayBuffer }

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");                                   // zlib-wrapped, as the reader expects
  return new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(cs)).arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return "sha256-" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The worker global is not typed as one here (the same gap desktop/server-worker.ts has), so the
// scope is described explicitly rather than left as Window.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ChunkRequest>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e) => {
  const { id, raw, compressor, census, real } = e.data;
  // WHICH LABEL VALUES OCCUR, counted while the bytes are already here and already being read.
  //
  // The caller needs this to drop segments with no voxels, and did it with its own pass over the
  // whole volume on the main thread -- 0.8 s per whole-body labelmap, 3.25 s for the four of Ron's
  // scene, measured 2026-09-22. The same pass in these workers is eight ways parallel and lands in
  // time the compression was going to spend anyway. 256 bytes come back per chunk.
  //
  // The padding of an edge chunk is NOT counted: it is zeros the volume does not contain.
  const seen = census ? chunkCensus(new Uint8Array(raw), real) : undefined;
  // "raw" skips the deflate entirely and hashes the bytes as they are. The hash is still of what
  // gets stored, so content addressing is unchanged -- it is simply a different byte stream.
  const comp = compressor === "raw" ? new Uint8Array(raw) : await deflate(new Uint8Array(raw));
  const hash = await sha256(comp);
  const reply: ChunkReply = { id, comp: comp.buffer as ArrayBuffer, hash, ...(seen ? { seen: seen.buffer as ArrayBuffer } : {}) };
  ctx.postMessage(reply, seen ? [reply.comp, reply.seen!] : [reply.comp]);
};
