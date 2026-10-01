// PUTTING A LABELMAP BACK TOGETHER FROM ITS CHUNKS, in both JS engines.
//
// Ron's load on 2026-09-23: the page's own thread was blocked for 8.3 s of a 13.0 s load, in stalls of
// about 1.1 s -- one per segmentation -- and the stored surfaces waited behind them. The stall is the
// assembly in render/zarr.ts (fetchZarrVolumeNative): each chunk, once inflated, was copied into the
// 418-million-voxel array one voxel at a time, with a min/max comparison per voxel.
//
// This measures that loop against a row copy (typed-array `set`, i.e. memcpy) with and without the
// range, on a volume the size of Ron's. Run it in both engines, as surface-nets.engine-bench.ts says:
//
//   deno run -A npm:esbuild render/zarr-assemble.engine-bench.ts \
//     --bundle --format=iife --target=es2020 --outfile=/tmp/za.js
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc /tmp/za.js
//   printf 'globalThis.print=console.log;\n' | cat - /tmp/za.js > /tmp/za-v8.js && deno run -A /tmp/za-v8.js
//
// JavaScriptCore is the engine the application runs; V8 is Deno's. They have disagreed by 7x on a
// loop like this before (Greased Lightning), which is why a V8-only number is not evidence.
import { assembleChunk } from "./zarr-assemble.ts";

declare const print: ((s: string) => void) | undefined;
const say: (s: string) => void = typeof print === "function" ? print : console.log;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const [nx, ny, nz] = [768, 768, 709];
const [cz, cy, cx] = [64, 128, 128];
const grid = [Math.ceil(nz / cz), Math.ceil(ny / cy), Math.ceil(nx / cx)];

// Chunks as the store holds them: full-size, zero-padded at the edges, mostly background with a
// few labels -- the shape of a segmentation, not of noise.
const chunks: Uint8Array[] = [];
for (let kk = 0; kk < grid[0]; kk++) {
  for (let jj = 0; jj < grid[1]; jj++) {
    for (let ii = 0; ii < grid[2]; ii++) {
      const c = new Uint8Array(cz * cy * cx);
      for (let t = 0; t < c.length; t += 97) c[t] = ((kk + jj + ii + t) % 23) + 1;
      chunks.push(c);
    }
  }
}

function run(name: string, mode: "voxel" | "rows" | "rows+range") {
  const out = new Uint8Array(nx * ny * nz);
  const t0 = now();
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let kk = 0; kk < grid[0]; kk++) {
    for (let jj = 0; jj < grid[1]; jj++) {
      for (let ii = 0; ii < grid[2]; ii++) {
        const chunk = chunks[n++];
        if (mode === "voxel") {
          // The loop as it was.
          const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
          const zw = Math.min(cz, nz - z0), yw = Math.min(cy, ny - y0), xw = Math.min(cx, nx - x0);
          for (let zz = 0; zz < zw; zz++) {
            for (let yy = 0; yy < yw; yy++) {
              const src = (zz * cy + yy) * cx;
              const dst = ((z0 + zz) * ny + (y0 + yy)) * nx + x0;
              for (let xx = 0; xx < xw; xx++) {
                const v = chunk[src + xx];
                out[dst + xx] = v;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
            }
          }
        } else {
          const r = assembleChunk(out, chunk, [nz, ny, nx], [cz, cy, cx], [kk, jj, ii], mode === "rows+range");
          if (r) { if (r[0] < lo) lo = r[0]; if (r[1] > hi) hi = r[1]; }
        }
      }
    }
  }
  const ms = now() - t0;
  say(`${name.padEnd(34)} ${(ms / 1000).toFixed(2)} s   range ${mode === "rows" ? "not computed" : `${lo}..${hi}`}`);
  return ms;
}

say(`${nx} x ${ny} x ${nz} = ${(nx * ny * nz / 1e6).toFixed(0)}M voxels in ${chunks.length} chunks of ${cz}x${cy}x${cx}`);
for (let rep = 0; rep < 2; rep++) {
  run("voxel by voxel, with the range", "voxel");
  run("row copies, with the range", "rows+range");
  run("row copies, no range", "rows");
}
