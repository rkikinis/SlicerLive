// T1: local ingest produces Slicer-compatible chunks and round-trips through the production zarr loader.
import { chunkCensus } from "./chunk-census.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CHUNK_MAX, LocalBlobStore, percentileWindowLevel, volumeNodes, volumeToZarr } from "./ingest.ts";
import { fetchZarrVolumeNative, setBlobFetch } from "../render/zarr.ts";

function phantom(nx = 70, ny = 50, nz = 9): Int16Array {
  const d = new Int16Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) d[(z * ny + y) * nx + x] = x * 3 - y * 2 + z * 100 - 400;
  return d;
}

Deno.test("volumeToZarr: Slicer's chunk rule, sha256- names, zlib-deflated payloads", async () => {
  const data = phantom(300, 140, 70);
  const { desc, blobs } = await volumeToZarr(data, [300, 140, 70], "<i2");
  assertEquals(desc.shape, [70, 140, 300]);
  assertEquals(desc.chunks, [Math.min(CHUNK_MAX[0], 70), 128, 128]);
  assertEquals(desc.chunkGrid, [2, 2, 3]);
  assertEquals(Object.keys(desc.chunkHashes!).length, 12);
  for (const h of Object.values(desc.chunkHashes!)) { assert(/^sha256-[0-9a-f]{64}$/.test(h)); assert(blobs.has(h)); }
  const first = blobs.get(desc.chunkHashes!["0.0.0"])!;
  assertEquals(first[0] & 0x0f, 8, "zlib header (CM=8) — Python zlib.compress compatible");
});

Deno.test("round-trip: chunks served through the blob fetch reassemble byte-identically", async () => {
  const data = phantom();
  const { desc, blobs } = await volumeToZarr(data, [70, 50, 9], "<i2");
  const store = new LocalBlobStore();
  store.add(blobs);
  const zv = await fetchZarrVolumeNative("http://blobs/", desc);
  assertEquals(zv.dims, [70, 50, 9]);
  assert(zv.data instanceof Int16Array);
  assertEquals(Array.from(zv.data as Int16Array), Array.from(data));
  setBlobFetch(null);
});

Deno.test("percentileWindowLevel + volumeNodes: sensible defaults, Slicer node shapes", async () => {
  const data = phantom();
  const wl = percentileWindowLevel(data);
  assert(wl.window > 0 && wl.level > wl.range[0] && wl.level < wl.range[1]);
  const built = await volumeNodes({ dims: [70, 50, 9], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], data, dtype: "<i2", name: "P" });
  const img = built.nodes.find((n) => n.type === "image")!, disp = built.nodes.find((n) => n.type === "scalarVolumeDisplay")!;
  assertEquals(img.dims, [70, 50, 9]); assertEquals((img.refs as { display: string[] }).display, [disp.id]);
  assert(typeof disp.window === "number" && typeof disp.level === "number");
});

// The compressor field, which is what makes a mixed store possible without a format migration.
Deno.test("volumeToZarr: raw stores the bytes as they are, and says so", async () => {
  const n = 70 * 50 * 9;
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) data[i] = i % 977;          // not compressible to nothing

  const deflated = await volumeToZarr(data, [9, 50, 70], "<i2");
  const raw = await volumeToZarr(data, [9, 50, 70], "<i2", { compressor: "raw" });

  assertEquals(deflated.desc.compressor, "deflate", "the default is unchanged");
  assertEquals(raw.desc.compressor, "raw");

  // Raw chunk payloads are exactly the padded chunk, byte for byte — no zlib header, no framing.
  const rawTotal = [...raw.blobs.values()].reduce((a, b) => a + b.byteLength, 0);
  const defTotal = [...deflated.blobs.values()].reduce((a, b) => a + b.byteLength, 0);
  assertEquals(rawTotal, raw.desc.bytes, "raw bytes are the chunk bytes");
  assertEquals(defTotal < rawTotal, true, "and deflate is genuinely smaller on this data");

  // Content addressing still holds: the hash is of what is stored, so the two differ and neither
  // can be mistaken for the other.
  const rawHashes = new Set(Object.values(raw.desc.chunkHashes!));
  const defHashes = new Set(Object.values(deflated.desc.chunkHashes!));
  assertEquals([...rawHashes].some((h) => defHashes.has(h)), false, "raw and deflated chunks cannot collide");
});

// A descriptor written before the field existed must keep loading, which is the whole reason the
// field is optional rather than required.
Deno.test("volumeToZarr: an absent compressor means deflate", async () => {
  const { desc } = await volumeToZarr(new Int16Array(8 * 8 * 8), [8, 8, 8], "<i2");
  assertEquals(desc.compressor, "deflate");
});

// THE CENSUS COMES BACK WITH THE CHUNKS, and it must agree with a plain pass over the volume —
// the segments that get listed depend on it. Ron's load profile, 2026-09-22: that plain pass was
// 0.8 s per whole-body labelmap on the main thread, and the chunking reads every voxel anyway.
Deno.test("volumeToZarr can report which values occur, and reports them exactly", async () => {
  const dims: [number, number, number] = [37, 19, 11];                  // not a multiple of the chunk size
  const data = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (const [i, v] of [[0, 3], [1, 3], [500, 200], [1001, 7], [data.length - 1, 255]] as [number, number][]) data[i] = v;
  const { seen } = await volumeToZarr(data, dims, "|u1", { census: true });
  assert(seen, "no census came back");
  const expected = new Uint8Array(256);
  for (const v of data) expected[v] = 1;
  assertEquals([...seen!], [...expected]);
  // And the padding a chunk adds must not invent a value: every chunk is zero-padded, and 0 is
  // already present here, so the check that matters is that nothing ELSE appears.
  assertEquals([...seen!].reduce((n, x) => n + x, 0), [...expected].reduce((n, x) => n + x, 0));
});

// THE CENSUS THE WORKERS DO, on the padded chunk they are actually given.
//
// The test above reaches only the fallback: `chunkWorkers()` returns none without a `document`, so
// under `deno test` the worker path — the one that runs in the application, on chunks padded out to
// a full chunk — was never executed, and it counted the padding. A volume with no background voxel
// in it reported label 0 as present (critic, 2026-09-22, finding 8). This runs the same function
// the worker runs, on the same bytes, and compares it with a plain pass over the volume.
Deno.test("the chunk census ignores an edge chunk's zero padding", () => {
  const [nx, ny, nz] = [200, 140, 70];
  const [cx, cy, cz] = [128, 128, 64];                                  // a partial chunk in every axis
  const data = new Uint8Array(nx * ny * nz).fill(7);                    // no background voxel anywhere
  data[data.length - 1] = 9;
  const seen = new Uint8Array(256);
  for (let kk = 0; kk * cz < nz; kk++) {
    for (let jj = 0; jj * cy < ny; jj++) {
      for (let ii = 0; ii * cx < nx; ii++) {
        const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
        const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
        const chunk = new Uint8Array(cz * cy * cx);                     // zero-padded, as volumeToZarr makes it
        for (let z = 0; z < zw; z++) {
          for (let y = 0; y < yw; y++) {
            chunk.set(data.subarray(((z0 + z) * ny + (y0 + y)) * nx + x0, ((z0 + z) * ny + (y0 + y)) * nx + x0 + xw), (z * cy + y) * cx);
          }
        }
        const part = chunkCensus(chunk, [cx, cy, xw, yw, zw]);
        for (let v = 0; v < 256; v++) if (part[v]) seen[v] = 1;
      }
    }
  }
  const expected = new Uint8Array(256);
  for (const v of data) expected[v] = 1;
  assertEquals(seen[0], 0, "the padding was counted: label 0 reported in a volume that has none");
  assertEquals([...seen], [...expected]);
  // Without the extent it counts the padding, which is what it used to do: a half-filled chunk,
  // every real voxel a 7, reports 0 as present.
  const padded = new Uint8Array(cz * cy * cx);
  padded.fill(7, 0, padded.length / 2);
  assertEquals(chunkCensus(padded)[0], 1);
});
