// Putting a volume back together from its chunks: the dtype table, unpacking one chunk, and copying
// it into place. Its own module, with nothing of the page in it, so the worker that does this off the
// page's thread (zarr-assemble-worker.ts) and the page itself share one copy of it.

export type TypedArrayCtor =
  | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor
  | Int32ArrayConstructor | Uint32ArrayConstructor | Float32ArrayConstructor | Float64ArrayConstructor;

export const ZDT: Record<string, TypedArrayCtor> = {
  "<f4": Float32Array, "<f8": Float64Array, "<i4": Int32Array, "<u4": Uint32Array,
  "<i2": Int16Array, "<u2": Uint16Array, "|i1": Int8Array, "|u1": Uint8Array, "<i1": Int8Array, "<u1": Uint8Array,
};

export async function inflateDeflate(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream("deflate");
  return await new Response(new Response(buf).body!.pipeThrough(ds)).arrayBuffer();
}

/**
 * Copy one inflated chunk into the assembled volume, ROW BY ROW, and optionally say its range.
 *
 * WHY ROWS. This was a loop over every voxel -- copy, compare with the minimum, compare with the
 * maximum -- and for a 418-million-voxel labelmap that is about a second on the page's own thread,
 * once per segmentation. In Ron's load of 2026-09-23 the thread was blocked for 8.3 s of 13.0 s in
 * stalls of that size, and the stored surfaces waited behind them. A row is contiguous in both the
 * chunk and the volume, so `set` copies it as one block. The range is a separate pass, and only for
 * callers that use it: window/level on a scalar volume does, a labelmap does not.
 * `render/zarr-assemble.engine-bench.ts` measures the two in both engines.
 */
export function assembleChunk<T extends { set(a: ArrayLike<number>, o: number): void; subarray(a: number, b: number): ArrayLike<number> & { length: number } } & ArrayLike<number>>(
  out: T,
  chunk: T,
  shape: [number, number, number],
  chunks: [number, number, number],
  at: [number, number, number],
  wantRange: boolean,
): [number, number] | null {
  const [nz, ny, nx] = shape, [cz, cy, cx] = chunks, [kk, jj, ii] = at;
  const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
  const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
  let lo = Infinity, hi = -Infinity;
  for (let zz = 0; zz < zw; zz++) {
    for (let yy = 0; yy < yw; yy++) {
      const src = (zz * cy + yy) * cx;
      out.set(chunk.subarray(src, src + xw), ((z0 + zz) * ny + (y0 + yy)) * nx + x0);
      if (wantRange) {
        for (let xx = src, e = src + xw; xx < e; xx++) {
          const v = chunk[xx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
  }
  return wantRange ? [lo, hi] : null;
}

