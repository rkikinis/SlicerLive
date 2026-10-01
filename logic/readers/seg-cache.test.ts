// The cache key is the interesting part: it has to identify the object *and* the grid it was placed
// on, and it has to be cheap enough to pay on every hit. Measured on the working 347 MB SEG, reading
// MediaStorageSOPInstanceUID out of the file meta group takes 0.311 ms against 163 ms to SHA-256 the
// whole file — and the hash would be paid on hits too.
//
//   deno test -A --no-check logic/readers/seg-cache.test.ts
import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { clearSegCache, decodeSegmentationCached, decodeSegmentationLazy, getCachedSeg, metaSopInstanceUid, putCachedSeg, segCacheKey, segCacheKeyFromHead, setSegDecoder } from "./seg-cache.ts";
import type { DecodedSeg, SegReference } from "./seg-cache.ts";

/** A Part 10 preamble + meta group carrying one MediaStorageSOPInstanceUID. */
function part10(uid: string, extraLeadingElement = false): Uint8Array {
  const parts: number[] = [];
  for (let i = 0; i < 128; i++) parts.push(0);                       // preamble
  for (const c of "DICM") parts.push(c.charCodeAt(0));
  const el = (group: number, elem: number, vr: string, value: string) => {
    const v = value.length % 2 ? value + "\0" : value;               // DICOM values are even-length
    parts.push(group & 0xff, group >> 8, elem & 0xff, elem >> 8);
    parts.push(vr.charCodeAt(0), vr.charCodeAt(1));
    parts.push(v.length & 0xff, v.length >> 8);
    for (const c of v) parts.push(c.charCodeAt(0));
  };
  // A real meta group has other elements before (0002,0003); the parser must walk past them.
  if (extraLeadingElement) el(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.66.4");
  el(0x0002, 0x0003, "UI", uid);
  return new Uint8Array(parts);
}

const UID = "2.25.9000000001";
const REF: SegReference = { dims: [452, 332, 993], ijkToRAS: [0.5, 0, 0, -128, 0, 0.5, 0, -128, 0, 0, 0.5, -100, 0, 0, 0, 1] };
const decoded = (n: number): DecodedSeg => ({
  lab: new Uint8Array([n]), colors: [[1, 1, 0, 0]], names: { 1: "liver" }, emptySegments: [], overlapVoxels: 0, framesOutside: 0,
  geometry: { orientation: "acquired", spacing: "acquired", onReferenceGrid: true },
});

Deno.test("uid: read from the meta group without parsing the object", () => {
  assertEquals(metaSopInstanceUid(part10(UID)), UID);
  assertEquals(metaSopInstanceUid(part10(UID, true)), UID, "walks past earlier meta elements");
});

// Anything that is not a Part 10 file with a readable meta group must yield null, and a null key must
// simply mean "do not cache" rather than an error.
Deno.test("uid: unidentifiable input yields null, and null keys are inert", async () => {
  assertEquals(metaSopInstanceUid(new Uint8Array(10)), null, "too short");
  assertEquals(metaSopInstanceUid(new Uint8Array(300)), null, "no DICM magic");
  assertEquals(segCacheKey(new Uint8Array(10), REF), null);
  await putCachedSeg(null, decoded(1));                 // must not throw
  assertEquals(await getCachedSeg(null), null);
});

// The key has to include the grid. The same SEG on a different reference decodes to a different
// labelmap, so a key that ignored the reference would serve a wrong answer rather than miss.
Deno.test("key: the reference geometry is part of it", () => {
  const a = segCacheKey(part10(UID), REF);
  const b = segCacheKey(part10(UID), { ...REF, dims: [452, 332, 500] });
  const c = segCacheKey(part10(UID), { ...REF, ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  assertNotEquals(a, b, "different dims must not collide");
  assertNotEquals(a, c, "different ijkToRAS must not collide");
  assertEquals(a, segCacheKey(part10(UID), { ...REF }), "the same object and grid must hit");
});

// A SOPInstanceUID identifies an object, and an object whose bytes changed while keeping its UID is
// a spec violation — but a truncated file is not, so length rides along as a tripwire.
Deno.test("key: byte length is part of it, to catch a truncated file", () => {
  const full = part10(UID);
  const padded = new Uint8Array(full.length + 16);
  padded.set(full);
  assertNotEquals(segCacheKey(full, REF), segCacheKey(padded, REF));
});

Deno.test("store: put then get returns the same decoded segmentation", async () => {
  await clearSegCache();
  const key = segCacheKey(part10(UID), REF)!;
  assertEquals(await getCachedSeg(key), null, "cold");
  await putCachedSeg(key, decoded(7));
  assertEquals((await getCachedSeg(key))?.lab[0], 7);
});

// Bounded, because these are ~149 MB each: unbounded it would fill a quota and then fail silently,
// which is worse than missing.
Deno.test("store: bounded to a few entries, oldest evicted", async () => {
  await clearSegCache();
  const keys = ["a", "b", "c", "d"].map((s) => segCacheKey(part10(`1.2.3.${s}`), REF)!);
  for (const [i, k] of keys.entries()) await putCachedSeg(k, decoded(i));
  assertEquals(await getCachedSeg(keys[0]), null, "the oldest is gone");
  assertEquals((await getCachedSeg(keys[3]))?.lab[0], 3, "the newest is there");
});

// The invariant the whole shortcut rests on: a key computed from a file's HEAD must equal the key
// computed from the WHOLE file. If it did not, every hit would become a miss and the 347 MB read
// would come back while looking like it had been avoided.
Deno.test("key: head-only and whole-file keys are identical", () => {
  const full = part10(UID);
  const padded = new Uint8Array(4096);          // as a range request would return
  padded.set(full);
  const whole = new Uint8Array(500_000);        // a "body" the shortcut must never need
  whole.set(full);

  assertEquals(
    segCacheKeyFromHead(padded, whole.byteLength, REF),
    segCacheKey(whole, REF),
    "a 4 KB head plus the total length must key the same as the entire file",
  );
});

Deno.test("lazy: a hit reads the head and never the body", async () => {
  await clearSegCache();
  const full = part10(UID);
  const whole = new Uint8Array(500_000);
  whole.set(full);
  await putCachedSeg(segCacheKey(whole, REF)!, decoded(42));

  let bodyReads = 0;
  const seg = await decodeSegmentationLazy(
    REF,
    () => Promise.resolve({ head: full, totalBytes: whole.byteLength }),
    () => { bodyReads++; return Promise.resolve(whole.buffer as ArrayBuffer); },
  );
  assertEquals(seg.lab[0], 42);
  assertEquals(bodyReads, 0, "the body must not be fetched on a hit");
});

// And when the shortcut cannot work — no partial reads, or an unidentifiable header — it must fall
// back rather than fail.
Deno.test("lazy: no head available falls back to reading the body", async () => {
  await clearSegCache();
  let bodyReads = 0;
  await decodeSegmentationLazy(
    REF,
    () => Promise.resolve(null),
    () => { bodyReads++; return Promise.reject(new Error("body read attempted")); },
  ).catch(() => {});
  assertEquals(bodyReads, 1, "it must try the body when there is no head");
});

// ONE DECODE, NOT TWO, when the same object is asked for twice at once.
//
// The load asks for the next segmentation while the current one is still being built, and then the
// load itself asks for that same object — before the first decode has finished and been stored. The
// cache could only see finished decodes, so the second asker missed and decoded it again, in
// parallel: two ~400 MB labelmaps of one segmentation in memory at the same time, on the day that
// memory was the problem (critic, 2026-09-22, finding 4).
Deno.test("two askers for one segmentation share a single decode", async () => {
  await clearSegCache();
  const whole = new Uint8Array(500_000);
  whole.set(part10(UID));
  let decodes = 0;
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  setSegDecoder(async () => { decodes++; await held; return decoded(7); });
  try {
    const a = decodeSegmentationCached(whole.buffer as ArrayBuffer, REF);
    const b = decodeSegmentationCached(whole.buffer as ArrayBuffer, REF);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assertEquals(decodes, 1, "the same object was decoded twice at once");
    assertEquals(ra.lab[0], 7);
    assertEquals(rb.lab[0], 7);
  } finally { setSegDecoder(null); }
});

// And the lazy path joins it too, so the body of a file already being decoded is not read again.
Deno.test("the lazy path joins a decode already in flight, and reads no body", async () => {
  await clearSegCache();
  const full = part10(UID);
  const whole = new Uint8Array(500_000);
  whole.set(full);
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  setSegDecoder(async () => { await held; return decoded(9); });
  try {
    const first = decodeSegmentationCached(whole.buffer as ArrayBuffer, REF);
    let bodyReads = 0;
    const second = decodeSegmentationLazy(
      REF,
      () => Promise.resolve({ head: full, totalBytes: whole.byteLength }),
      () => { bodyReads++; return Promise.resolve(whole.buffer as ArrayBuffer); },
    );
    release();
    await first;
    assertEquals((await second).lab[0], 9);
    assertEquals(bodyReads, 0, "the body was read for a decode that was already running");
  } finally { setSegDecoder(null); }
});
