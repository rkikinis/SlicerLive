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
import { objVertexCount, writeObj, writeStl } from "../logic/writers/surface-files.ts";
import type { Vec3 } from "../render/mat4.ts";

export interface NetsRequest {
  id: number;
  lab: ArrayBuffer;
  dims: Vec3;
  ijkToRAS: number[];
  opts?: SurfaceNetsOpts;
  /**
   * WRITE THE FILE HERE (critic 2026-10-21, surfaces export, finding 5): an OBJ of a whole body took 5-8 s to write on
   * the drawing thread, after the banner had gone, and the page then held the meshes and the file. Asked for, the
   * worker writes the STL or OBJ itself and sends back only the file's chunks.
   */
  file?: {
    format: "stl" | "obj"; name: string; structures: { label: number; name: string; color?: number[] }[];
    /** A part of a larger file (Save › Files › "Everything shown in 3D"): no header; OBJ vertices numbered from here. */
    part?: { vertexOffset: number };
  };
}
export interface NetsReply {
  id: number;
  meshes: { label: number; positions: ArrayBuffer; normals: ArrayBuffer; indices: ArrayBuffer }[];
  /** The file, when one was asked for (then `meshes` is empty), and what is in it. */
  file?: { chunks: ArrayBuffer[]; structures: number; triangles: number; vertices: number };
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
  // "Closed, for 3D printing" arrives here already padded (algorithms/close-labels.ts): nothing to do but extract.
  const f = e.data.file;
  const meshes = surfaceNets(new Uint8Array(lab), dims, ijkToRAS, o);
  const transfer: Transferable[] = [];
  if (f) {
    const byLabel = new Map(f.structures.map((x) => [x.label, x]));
    const header = !f.part;
    const named = meshes.map((m) => ({ name: byLabel.get(m.label)?.name ?? `Segment ${m.label}`, color: byLabel.get(m.label)?.color, mesh: m }));
    const chunks = f.format === "stl" ? writeStl(meshes, { name: f.name, header })
      : writeObj(named, { name: f.name, header, vertexOffset: f.part?.vertexOffset ?? 0 });
    // Each chunk's own buffer, transferred (a chunk that is a view into a larger buffer is copied out first).
    const bufs = chunks.map((c) => c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c.buffer as ArrayBuffer : c.slice().buffer as ArrayBuffer);
    transfer.push(...bufs);
    const reply: NetsReply = { id, meshes: [], file: { chunks: bufs, structures: meshes.length, triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0), vertices: objVertexCount(named) }, ms: performance.now() - t0, build: BUILD_ID, settings };
    ctx.postMessage(reply, transfer);
    return;
  }
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
