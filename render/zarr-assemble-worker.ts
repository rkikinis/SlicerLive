// Unpacking a compressed volume and putting it back together, OFF THE PAGE'S THREAD.
//
// Ron's load of 2026-09-23 at build 08:21: once the voxel-by-voxel copy was gone, reading the four
// labelmaps back out of the store still came to 17.6 s summed, and every small thing that ran at the
// same time -- reading the built cache, asking which series, waiting for a reply the server had
// already sent -- measured seconds, because the page's thread was busy. What is left in that read is
// unpacking: 1.7 GB of output from a few megabytes of compressed chunks, for four segmentations.
//
// So the compressed chunks come here (they are small -- 0.04 to 2.2 MB for a whole-body labelmap),
// are unpacked and assembled here, and the finished volume goes back TRANSFERRED, not copied.
import { assembleChunk, inflateDeflate, ZDT } from "./zarr-assemble.ts";

interface Request {
  /** Echoed back, so one kept worker can serve several reads in turn. */
  id?: number;
  dtype: string;
  shape: [number, number, number];
  chunks: [number, number, number];
  compressor: string;
  wantRange: boolean;
  /** Hand back the chunks that hold anything, unpacked -- for an upload that skips the empty ones. */
  wantChunks?: boolean;
  parts: { at: [number, number, number]; bytes: ArrayBuffer }[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

const clock = () => performance.timeOrigin + performance.now();
ctx.onmessage = async (e) => {
  const t0 = performance.now();
  const began = clock();
  try {
    const { id, dtype, shape, chunks, compressor, wantRange, wantChunks, parts } = e.data;
    const nonEmpty: { at: [number, number, number]; bytes: ArrayBuffer }[] = [];
    const Ctor = ZDT[dtype] ?? Int16Array;
    const [nz, ny, nx] = shape;
    const out = new Ctor(nz * ny * nx);
    let lo = Infinity, hi = -Infinity, next = 0;
    // Several unpackings in flight at once: each is a stream that waits on itself, so one at a time
    // would leave this thread idle between them.
    const lane = async () => {
      while (next < parts.length) {
        const p = parts[next++];
        const raw = compressor === "raw" ? p.bytes : await inflateDeflate(p.bytes);
        const r = assembleChunk(out as never, new Ctor(raw) as never, shape, chunks, p.at, wantRange);
        if (r) { if (r[0] < lo) lo = r[0]; if (r[1] > hi) hi = r[1]; }
        // AN ALL-ZERO CHUNK IS NOT SENT. Checked a word at a time; the first non-zero word ends it.
        if (wantChunks) {
          const words = raw.byteLength % 4 === 0 ? new Uint32Array(raw) : new Uint8Array(raw);
          let any = false;
          for (let i = 0; i < words.length; i++) if (words[i]) { any = true; break; }
          if (any) nonEmpty.push({ at: p.at, bytes: raw });
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, lane));
    // Its own time, measured here: the page's clock would include waiting to hear back.
    ctx.postMessage(
      { id, data: out.buffer, range: wantRange ? [lo, hi] : null, ...(wantChunks ? { nonEmpty } : {}), ms: performance.now() - t0, began, ended: clock() },
      [out.buffer as ArrayBuffer, ...nonEmpty.map((c) => c.bytes)],
    );
  } catch (err) {
    ctx.postMessage({ id: e.data.id, error: (err as Error)?.message ?? String(err) });
  }
};
