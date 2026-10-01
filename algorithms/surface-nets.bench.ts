// THE MEASUREMENT THAT JUSTIFIES GREASED LIGHTNING, committed so it can be re-run rather than quoted.
//
// The 34.2 s standalone figure in docs/GREASED-LIGHTNING.md came from a scratch script that was
// thrown away, which in a repo whose CLAUDE.md opens with "If it is not in writing it does not
// exist" is not defensible. This is that script.
//
//   deno run -A --v8-flags=--max-old-space-size=12000 algorithms/surface-nets.bench.ts <labelmap.nrrd>
//
// Defaults to the NEPHROGENIC ts:total checkpoint in Ron's working folder. Needs the raised heap:
// the labelmap alone is 418 MB and the meshes are ~290 MB more.
//
// Reported per phase, because that split is the whole diagnostic. `onProgress` fires once per
// z-plane and the last one marks the end of extraction, so extraction-versus-everything-else costs
// one timestamp. If the app is uniformly slower, suspect memory; if extraction alone is far slower,
// that is an engine signature.
import { parseNrrd } from "../render/nrrd.ts";
import { DEFAULT_NORMAL_SMOOTH, DEFAULT_SMOOTH_ITERS, surfaceNets } from "./surface-nets.ts";

// PATH-RELATIVE, like everything else here. Albula has been portable from the start -- the folder
// can be moved or renamed and the launchers still resolve themselves -- and the first draft of this
// file hardcoded a home folder path, which would have been the only absolute path in the repo.
const DEFAULT_CASE = new URL(
  "../../../Slicer/SlicerDICOMDatabase/SlicerAlbula-Checkpoints/2026-09-08T21-46-02-107Z-ts_total.seg.nrrd",
  import.meta.url,
).pathname;

const file = Deno.args[0] ?? DEFAULT_CASE;
let raw: Uint8Array;
try {
  raw = await Deno.readFile(file);
} catch {
  console.error(
    `no labelmap at ${file}\n\n` +
      `Pass one as an argument, or populate the DICOM database first. Any multi-label segmentation\n` +
      `NRRD works; the triangle count quoted in docs/GREASED-LIGHTNING.md is specific to the\n` +
      `NEPHROGENIC ts:total case named above.`,
  );
  Deno.exit(1);
}
const n = await parseNrrd(raw);
const dims = n.dims as [number, number, number];
const m = n.ijkToRAS as number[];
const lab = n.data as unknown as Uint8Array;

const sp = [0, 1, 2].map((c) => Math.hypot(m[c], m[4 + c], m[8 + c]));
console.log(file.split("/").pop());
console.log(`  ${dims.join(" x ")} = ${(dims[0] * dims[1] * dims[2] / 1e6).toFixed(0)}M voxels`);
console.log(`  ${sp.map((v) => v.toFixed(2)).join(" x ")} mm, anisotropy ${(Math.max(...sp) / Math.min(...sp)).toFixed(2)}x\n`);

const t0 = performance.now();
let tExtract = 0;
const meshes = surfaceNets(lab, dims, m, {
  onProgress: (done, total) => { if (done === total) tExtract = performance.now() - t0; },
});
const total = performance.now() - t0;
const tris = meshes.reduce((s, x) => s + x.indices.length / 3, 0);

// Shading discontinuity: the angle between the normals at the two ends of every mesh edge. This is
// what the eye reads as terracing, and it needs no ground truth, so it works on any real labelmap.
const e: number[] = [];
for (const mesh of meshes) {
  const { normals: nr, indices: ix } = mesh;
  for (let t = 0; t < ix.length; t += 3) {
    for (let c = 0; c < 3; c++) {
      const a = ix[t + c] * 3, b = ix[t + (c + 1) % 3] * 3;
      if (a > b) continue;
      const d = nr[a] * nr[b] + nr[a + 1] * nr[b + 1] + nr[a + 2] * nr[b + 2];
      e.push(Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI);
    }
  }
}
e.sort((a, b) => a - b);

console.log(`settings: smoothIters ${DEFAULT_SMOOTH_ITERS}, normalSmooth ${DEFAULT_NORMAL_SMOOTH}`);
console.log(`labels ${meshes.length}, triangles ${tris.toLocaleString()}`);
console.log(`  extraction (phases 1-2)          ${(tExtract / 1000).toFixed(1)}s`);
console.log(`  smoothing + per-label + normals  ${((total - tExtract) / 1000).toFixed(1)}s`);
console.log(`  TOTAL                            ${(total / 1000).toFixed(1)}s`);
console.log(
  `neighboring-normal disagreement: mean ${(e.reduce((s, v) => s + v, 0) / e.length).toFixed(1)}° ` +
  `p95 ${e[Math.floor(e.length * .95)].toFixed(1)}° p99 ${e[Math.floor(e.length * .99)].toFixed(1)}°`,
);
console.log(`\nbudget: <=33s target, <=66s passes (Ron: "30 sec is ok, 1m is acceptable").`);
console.log(`For the in-app figure and the engine analysis, see docs/GREASED-LIGHTNING.md.`);
