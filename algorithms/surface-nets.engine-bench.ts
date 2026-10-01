// THE SAME EXTRACTION IN BOTH JS ENGINES -- the harness that found the application's 118 s.
//
// The webview runs JavaScriptCore; `deno` and the app's server process run V8. They are not close on
// this workload, and the difference was the entire problem: measured here, phases 1-2 took 3.09 s
// under JSC against 0.45 s under V8, while phases 3-4 were the same speed in both.
//
// Run it in both and compare:
//
//   deno run -A npm:esbuild algorithms/surface-nets.engine-bench.ts \
//     --bundle --format=iife --target=es2020 --outfile=/tmp/eb.js
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc /tmp/eb.js
//   printf 'globalThis.print=console.log;\n' | cat - /tmp/eb.js > /tmp/eb-v8.js && deno run -A /tmp/eb-v8.js
//
// A SYNTHETIC labelmap on purpose: jsc has no file I/O worth using, and the point is the engine
// ratio rather than absolute numbers. Use surface-nets.bench.ts on real data for those.
//
// KEEP THIS PASSING BOTH WAYS. The optimisation it justified -- flat corner/edge tables and no
// closures or iterators in the inner loop -- is invisible in V8, which optimises the readable version
// just as well. Only this harness shows whether a change has quietly cost the shipping engine 7x.
import { surfaceNets } from "./surface-nets.ts";

// `print` is jsc's console. Declared rather than assumed so this file typechecks in CI, and aliased
// so the SAME bundle runs under deno without the caller having to inject a shim.
declare const print: ((s: string) => void) | undefined;
const say: (s: string) => void = typeof print === "function" ? print : console.log;

const nx = 260, ny = 260, nz = 180;                 // 12M voxels: big enough to be representative
const lab = new Uint8Array(nx * ny * nz);
let L = 1;
for (let bz = 0; bz < 3; bz++) for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
  const cx = 32 + bx * 64, cy = 32 + by * 64, cz = 30 + bz * 60, r = 24, l = L++;
  for (let k = cz - r; k <= cz + r; k++) for (let j = cy - r; j <= cy + r; j++) for (let i = cx - r; i <= cx + r; i++) {
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
    if ((i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2 < r * r) lab[(k * ny + j) * nx + i] = l;
  }
}
const eye = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const t0 = Date.now();
let tX = 0;
const meshes = surfaceNets(lab, [nx, ny, nz], eye, { onProgress: (d, t) => { if (d === t) tX = Date.now() - t0; } });
const total = Date.now() - t0;
const tris = meshes.reduce((s, m) => s + m.indices.length / 3, 0);
say(`${(nx*ny*nz/1e6).toFixed(0)}M voxels, ${meshes.length} labels, ${tris} triangles`);
say(`  phases 1-2 ${(tX/1000).toFixed(2)}s   phases 3-4 ${((total-tX)/1000).toFixed(2)}s   TOTAL ${(total/1000).toFixed(2)}s`);
