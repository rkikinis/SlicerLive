// THE WORKER MUST PUT BACK EXACTLY WHAT WENT IN.
//
// The page reaches render/zarr-assemble-worker.ts only when there is a `document`, so no test would
// otherwise run it. This drives the worker directly: a volume that does not divide into whole chunks
// (so the edge chunks are padded), compressed the way the store compresses it, unpacked and
// reassembled in the worker, compared voxel for voxel with the original.
import { assertEquals } from "jsr:@std/assert@1";
import { volumeToZarr } from "../logic/ingest.ts";

async function viaWorker(desc: Record<string, unknown>, blobs: Map<string, Uint8Array>, wantRange: boolean) {
  const shape = desc.shape as [number, number, number];
  const chunks = desc.chunks as [number, number, number];
  const hashes = desc.chunkHashes as Record<string, string>;
  const parts = Object.entries(hashes).map(([k, h]) => {
    const at = k.split(".").map(Number) as [number, number, number];
    const b = blobs.get(h)!;
    return { at, bytes: b.slice().buffer as ArrayBuffer };
  });
  const w = new Worker(new URL("./zarr-assemble-worker.ts", import.meta.url).href, { type: "module" });
  try {
    return await new Promise<{ data: ArrayBuffer; range: [number, number] | null }>((resolve, reject) => {
      w.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
      w.onerror = (e) => { e.preventDefault(); reject(new Error(e.message)); };
      w.postMessage({ dtype: desc.dtype, shape, chunks, compressor: desc.compressor ?? "deflate", wantRange, parts }, parts.map((p) => p.bytes));
    });
  } finally { w.terminate(); }
}

Deno.test("the unpacking worker reassembles a compressed labelmap exactly, padding and all", async () => {
  const dims: [number, number, number] = [150, 140, 70];           // x, y, z: partial chunks in every axis
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < data.length; i += 13) data[i] = (i % 23) + 1;
  const { desc, blobs } = await volumeToZarr(data, dims, "|u1");   // deflated, as the store holds a labelmap
  const got = await viaWorker(desc as unknown as Record<string, unknown>, blobs, true);
  const out = new Uint8Array(got.data);
  assertEquals(out.length, data.length);
  let diff = 0;
  for (let i = 0; i < data.length; i++) if (out[i] !== data[i]) diff++;
  assertEquals(diff, 0, "voxels differ after the round trip through the worker");
  let lo = 255, hi = 0;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assertEquals(got.range, [lo, hi]);
});

Deno.test("the unpacking worker skips the range when none is asked for", async () => {
  const dims: [number, number, number] = [40, 30, 20];
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]).fill(3);
  const { desc, blobs } = await volumeToZarr(data, dims, "|u1");
  const got = await viaWorker(desc as unknown as Record<string, unknown>, blobs, false);
  assertEquals(got.range, null);
  assertEquals(new Uint8Array(got.data).every((v) => v === 3), true);
});

// ONE KEPT WORKER, SEVERAL READS. The page now keeps a few workers running and hands each read to
// one of them, so a worker must answer each job under the id it was given, in whatever order.
Deno.test("one kept worker answers two jobs, each under its own id", async () => {
  const mk = async (fill: number) => {
    const dims: [number, number, number] = [60, 50, 40];
    const data = new Uint8Array(dims[0] * dims[1] * dims[2]).fill(fill);
    const { desc, blobs } = await volumeToZarr(data, dims, "|u1");
    const hashes = desc.chunkHashes as Record<string, string>;
    const parts = Object.entries(hashes).map(([k, h]) => ({ at: k.split(".").map(Number) as [number, number, number], bytes: blobs.get(h)!.slice().buffer as ArrayBuffer }));
    return { desc, parts };
  };
  const a = await mk(5), b = await mk(9);
  const w = new Worker(new URL("./zarr-assemble-worker.ts", import.meta.url).href, { type: "module" });
  try {
    const got = new Map<number, Uint8Array>();
    const done = new Promise<void>((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.error) { reject(new Error(e.data.error)); return; }
        got.set(e.data.id, new Uint8Array(e.data.data));
        if (got.size === 2) resolve();
      };
      w.onerror = (e) => { e.preventDefault(); reject(new Error(e.message)); };
    });
    for (const [id, job] of [[1, a], [2, b]] as const) {
      w.postMessage({ id, dtype: job.desc.dtype, shape: job.desc.shape, chunks: job.desc.chunks, compressor: job.desc.compressor ?? "deflate", wantRange: false, parts: job.parts }, job.parts.map((p) => p.bytes));
    }
    await done;
    assertEquals(got.get(1)!.every((v) => v === 5), true, "job 1 came back as someone else's volume");
    assertEquals(got.get(2)!.every((v) => v === 9), true, "job 2 came back as someone else's volume");
  } finally { w.terminate(); }
});

// THE NON-EMPTY CHUNKS, when asked for: every chunk that holds a label, and none that does not.
Deno.test("the unpacking worker hands back exactly the chunks that hold anything", async () => {
  const dims: [number, number, number] = [150, 140, 70];            // 2 x 2 x 2 chunks of 64x128x128
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  data[5] = 3;                                                      // chunk 0.0.0
  data[data.length - 1] = 7;                                        // the last chunk
  const { desc, blobs } = await volumeToZarr(data, dims, "|u1");
  const hashes = desc.chunkHashes as Record<string, string>;
  const parts = Object.entries(hashes).map(([k, h]) => ({ at: k.split(".").map(Number) as [number, number, number], bytes: blobs.get(h)!.slice().buffer as ArrayBuffer }));
  const w = new Worker(new URL("./zarr-assemble-worker.ts", import.meta.url).href, { type: "module" });
  try {
    const got = await new Promise<{ nonEmpty: { at: number[] }[] }>((resolve, reject) => {
      w.onmessage = (e) => e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
      w.onerror = (e) => { e.preventDefault(); reject(new Error(e.message)); };
      w.postMessage({ id: 1, dtype: desc.dtype, shape: desc.shape, chunks: desc.chunks, compressor: desc.compressor ?? "deflate", wantRange: false, wantChunks: true, parts }, parts.map((p) => p.bytes));
    });
    assertEquals(got.nonEmpty.map((c) => c.at.join(".")).sort(), ["0.0.0", "1.1.1"]);
  } finally { w.terminate(); }
});
