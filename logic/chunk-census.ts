/**
 * WHICH VALUES OCCUR IN ONE CHUNK, counted where the bytes already are.
 *
 * Its own file because both the chunk worker and the test need it, and the worker module installs
 * an `onmessage` handler the moment it is imported — so a test that wanted this function would be
 * starting a worker's message loop to get at it. The bug this pins was invisible for exactly that
 * reason: the test that was supposed to cover the padding could only reach the other path
 * (critic, 2026-09-22, finding 8).
 *
 * BYTE-WISE: for `|u1` volumes (labelmaps). On anything wider it answers about bytes.
 *
 * `real` is `[cx, cy, xw, yw, zw]` — the chunk's own width and height, then the part of it that is
 * inside the volume. An edge chunk is padded with zeros to a full chunk, and counting the padding
 * reports label 0 as present in a volume that contains none.
 */
export function chunkCensus(bytes: Uint8Array, real?: [number, number, number, number, number]): Uint8Array {
  const seen = new Uint8Array(256);
  if (!real) {
    for (let i = 0; i < bytes.length; i++) seen[bytes[i]] = 1;
    return seen;
  }
  const [cx, cy, xw, yw, zw] = real;
  for (let z = 0; z < zw; z++) {
    for (let y = 0; y < yw; y++) {
      const row = (z * cy + y) * cx;
      for (let x = 0; x < xw; x++) seen[bytes[row + x]] = 1;
    }
  }
  return seen;
}
