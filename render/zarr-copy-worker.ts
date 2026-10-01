// Fetch one piece of a series' duckn working copy, unpack it (zstd), and check it is the piece its
// name says it is -- off the page's thread.
//
// The page keeps a few of these busy (render/zarr-copy.ts); each piece is its own zstd frame and its
// own file, so they never wait on one another. Measured 2026-09-23 on NEPHROGENIC's 432 pieces in the
// browser pane: 8 workers bring the whole 906 MB in 0.47-0.50 s.
//
// THE NAME IS CHECKED, not only the size. zstd without its checksum decodes a flipped bit to the
// right size with wrong bytes most of the time (312 of 400 single-bit flips in one real piece), and
// a swapped piece is the right size by construction; both loaded as "the same images" and were
// filed under the right piece's name, which the scene digest and the caches trust (critic,
// 2026-09-23, finding 2). A piece whose sha256 is not its name ends the read, and the series loads
// from DICOM.
import { ZSTDDecoder } from "./vendor/zstddec/zstddec.mjs";

const zd = new ZSTDDecoder();
const ready = zd.init();

// The worker's own scope, typed as what it is (as render/zarr-assemble-worker.ts does).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; url: string; rawSize: number; hash: string }>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

ctx.onmessage = async (e) => {
  const { id, url, rawSize, hash } = e.data;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for a piece`);
    const packed = new Uint8Array(await r.arrayBuffer());
    await ready;
    const out = zd.decode(packed, rawSize);
    if (out.byteLength !== rawSize) throw new Error(`a piece unpacked to ${out.byteLength} bytes, not ${rawSize}`);
    const got = "sha256-" + hex(await crypto.subtle.digest("SHA-256", out));
    if (got !== hash) throw new Error("a piece is not the piece its name says (damaged or replaced)");
    ctx.postMessage({ id, out: out.buffer, packed: packed.byteLength }, [out.buffer]);
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
