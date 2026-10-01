// Surface extraction, off the main thread.
//
// WHY THIS EXISTS. `surfaceNets` is synchronous and it is not fast: measured 2.5 s on a 16.6M-voxel
// brain and 17.3 s on a 418M-voxel whole-body CT. Run on the thread that draws, the second of those
// is a seventeen-second freeze with nothing on screen able to say so -- Ron: "There is no indication
// that something is happening. Albula is frozen." No amount of optimisation makes a job of that
// size safe on the drawing thread; it belongs on another one.
//
// The labelmap is TRANSFERRED in, and every mesh buffer transferred back. A 418 MB labelmap copied
// into the worker and 291 MB of meshes copied out would cost more than the extraction.
import { DEFAULT_NORMAL_SMOOTH, DEFAULT_SMOOTH_ITERS, surfaceNets, type SurfaceNetsOpts } from "./surface-nets.ts";
import { BUILD_ID } from "../render/build-id.ts";
import type { Vec3 } from "../render/mat4.ts";

export interface NetsRequest {
  id: number;
  lab: ArrayBuffer;
  dims: Vec3;
  ijkToRAS: number[];
  opts?: SurfaceNetsOpts;
}
export interface NetsReply {
  id: number;
  meshes: { label: number; positions: ArrayBuffer; normals: ArrayBuffer; indices: ArrayBuffer }[];
  ms: number;
  /**
   * WHICH WORKER RAN, AND WITH WHAT. Reported rather than assumed, because assuming it cost two
   * rounds of debugging: the page is cache-busted and the workers were not, so a stale worker ran
   * under a fresh page and the on-screen stamp -- which comes from the page -- reported the new
   * build. A settings change that looked like it did nothing had simply never executed.
   */
  build: string;
  settings: { smoothIters: number; normalSmooth: number };
}
/** Sent while the extraction runs, so the window can say it is running. */
export interface NetsProgress {
  id: number;
  progress: { done: number; total: number };
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<NetsRequest>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, lab, dims, ijkToRAS, opts } = e.data;
  const t0 = performance.now();
  // `only` crosses as an array: a Set does not survive structured clone in every runtime, and losing
  // it silently would extract every label instead of the ones asked for.
  const o: SurfaceNetsOpts = { ...opts, only: opts?.only ? new Set(opts.only as unknown as number[]) : undefined };
  // SAY THAT IT IS RUNNING. Seventeen seconds of silence reads as a hang -- Ron, twice: "There is no
  // indication that something is happening." Posted at most every 200 ms, because a message a plane
  // over 709 planes would be its own load on the thread receiving them.
  let lastPost = 0;
  o.onProgress = (done, total) => {
    const now = performance.now();
    if (done < total && now - lastPost < 200) return;
    lastPost = now;
    ctx.postMessage({ id, progress: { done, total } } satisfies NetsProgress);
  };
  const settings = {
    smoothIters: o.smoothIters ?? DEFAULT_SMOOTH_ITERS,
    normalSmooth: o.normalSmooth ?? DEFAULT_NORMAL_SMOOTH,
  };
  const meshes = surfaceNets(new Uint8Array(lab), dims, ijkToRAS, o);
  const transfer: Transferable[] = [];
  const out = meshes.map((m) => {
    transfer.push(m.positions.buffer as ArrayBuffer, m.normals.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer);
    return {
      label: m.label,
      positions: m.positions.buffer as ArrayBuffer,
      normals: m.normals.buffer as ArrayBuffer,
      indices: m.indices.buffer as ArrayBuffer,
    };
  });
  const reply: NetsReply = { id, meshes: out, ms: performance.now() - t0, build: BUILD_ID, settings };
  ctx.postMessage(reply, transfer);
};
