// The SEG decoder that runs in a worker, wired into seg-cache by the application.
//
// One worker, kept: the decodes are already overlapped one ahead by the load (prefetchSeg), and a
// second decoder would put two 418 MB labelmaps in flight, which is the memory the morning of
// 2026-09-22 was spent removing. The win is that the main thread is free while it works.
import type { DecodedSeg, DecodePhases, SegReference } from "../../logic/readers/dicom-seg.ts";
import { workerUrl } from "../build-id.ts";

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (s: DecodedSeg) => void; reject: (e: Error) => void; onPhases?: (p: DecodePhases) => void }>();

/** Decode in the worker. Rejects if the worker cannot be made or answers with an error. */
export function decodeSegInWorker(bytes: ArrayBuffer, ref: SegReference, onPhases?: (p: DecodePhases) => void): Promise<DecodedSeg> {
  if (!worker) {
    worker = new Worker(workerUrl("./seg-decode-worker.js"), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; seg?: DecodedSeg & { lab: ArrayBuffer }; phases?: DecodePhases; error?: string; bytes?: ArrayBuffer }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error || !e.data.seg) {
        // THE FILE COMES BACK WITH THE ERROR. The bytes are TRANSFERRED into the worker, so they are
        // detached here the instant the message is sent -- and the fallback that decodes on this
        // thread instead was being handed an empty buffer, i.e. it could never have worked (critic,
        // 2026-09-22, finding 10). The worker returns them, and the fallback has something to read.
        const err = new Error(e.data.error ?? "the segmentation decoder returned nothing") as Error & { bytes?: ArrayBuffer };
        if (e.data.bytes) err.bytes = e.data.bytes;
        w.reject(err);
        return;
      }
      if (e.data.phases) w.onPhases?.(e.data.phases);
      // The labelmap came back as a transferred buffer: wrap it, no copy.
      w.resolve({ ...e.data.seg, lab: new Uint8Array(e.data.seg.lab) } as DecodedSeg);
    };
    // A worker that dies outright -- a module that will not load, a crash -- cannot give the files
    // back, so these decodes have nothing to fall back to and say so rather than failing obscurely.
    worker.onerror = (ev) => {
      const msg = ((ev as ErrorEvent).message ?? "the segmentation decoder failed") +
        " (the worker stopped, so the files it was holding are gone; the next segmentation decodes on this thread)";
      for (const w of waiting.values()) w.reject(new Error(msg));
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = nextId++;
  return new Promise<DecodedSeg>((resolve, reject) => {
    waiting.set(id, { resolve, reject, onPhases });
    worker!.postMessage({ id, bytes, ref }, [bytes]);     // the file goes over, not a copy of it
  });
}
