// The decoded-volume cache must not confuse two volumes whose corner chunks are identical -- which
// every pair of labelmaps on one CT is, because the corners are empty. 2026-09-11.
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { cacheDecodedVolumeNative, fetchZarrVolumeNative, type ZarrDesc } from "./zarr.ts";

const desc = (middle: string): ZarrDesc => ({
  shape: [4, 4, 4], chunks: [2, 4, 4], chunkGrid: [2, 1, 1], dtype: "|u1",
  // three chunks: the first and the last are the same empty chunk in both volumes
  chunkHashes: { "0.0.0": "sha256-empty", "1.0.0": middle, "2.0.0": "sha256-empty" },
});

Deno.test("zarr cache: two labelmaps with the same empty corner chunks are two entries, not one", async () => {
  const a = new Uint8Array(64).fill(1), b = new Uint8Array(64).fill(2);
  cacheDecodedVolumeNative(desc("sha256-aaa"), { data: a, dtype: "|u1", dims: [4, 4, 4], range: [0, 1] });
  const hitA = await fetchZarrVolumeNative("http://nowhere.invalid/", desc("sha256-aaa"));
  assertEquals(hitA.data, a);
  // A different volume with the same corners: must NOT be served the cached one.
  let served: unknown = null;
  try { served = (await fetchZarrVolumeNative("http://nowhere.invalid/", desc("sha256-bbb"))).data; } catch { served = "fetched"; }
  assertNotEquals(served, a);
  assertEquals(served, "fetched");
  cacheDecodedVolumeNative(desc("sha256-bbb"), { data: b, dtype: "|u1", dims: [4, 4, 4], range: [0, 2] });
  assertEquals((await fetchZarrVolumeNative("http://nowhere.invalid/", desc("sha256-bbb"))).data, b);
});
