// The drawing copies, off the main thread.
//
// Decimating every structure of a whole-body result is about three seconds of WebAssembly (Ron's
// log, 2026-09-18: 3.2 s for ts:total in the app; 1.7 s for a 95-structure brain under V8); on
// the thread that draws it would be three seconds of frozen window. Positions are COPIED in (the main thread keeps its own; 72 MB on a whole body),
// the index lists transferred back. See logic/decimate.ts for what the copy is and is not.
import { decimateForDrawing, decimatorReady } from "../logic/decimate.ts";
import { BUILD_ID } from "../render/build-id.ts";

export interface DecimateRequest {
  id: number;
  meshes: { label: number; positions: ArrayBuffer; normals: ArrayBuffer; indices: ArrayBuffer }[];
  /** In mesh units: DRAW_ERROR_VOXELS times the smallest voxel edge. */
  errorLimit: number;
  /** The smallest voxel edge, in mesh units: the thinness test is in voxels. */
  voxel: number;
}
export interface DecimateReply {
  id: number;
  results: { label: number; drawIndices: ArrayBuffer; error: number; locked: number }[];
  ms: number;
  build: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DecimateRequest>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e) => {
  const { id, meshes, errorLimit, voxel } = e.data;
  const t0 = performance.now();
  await decimatorReady();
  const results = meshes.map((m) => {
    const r = decimateForDrawing(new Float32Array(m.positions), new Float32Array(m.normals), new Uint32Array(m.indices), errorLimit, voxel);
    // A copy when the simplifier handed back the input itself (a tiny mesh), so the transfer list
    // never names a buffer twice.
    const out = r.drawIndices.buffer === m.indices ? r.drawIndices.slice() : r.drawIndices;
    return { label: m.label, drawIndices: out.buffer as ArrayBuffer, error: r.error, locked: r.locked };
  });
  ctx.postMessage({ id, results, ms: performance.now() - t0, build: BUILD_ID } satisfies DecimateReply, results.map((r) => r.drawIndices));
};
