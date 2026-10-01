// Decode one DICOM SEG onto a reference grid, off the main thread.
//
// WHY THIS EXISTS. The decode is the largest single-threaded phase of a load: 3.6 s for the four
// segmentations of Ron's scene, measured with the load profiler on 2026-09-22, on a machine with
// ten cores where the chunking, the compression and the surface extraction are already in workers.
// It is a parse of the object and then a placement of every frame onto the volume's grid — CPU
// work with no DOM and no GPU in it, which is exactly what a worker is for.
//
// The file goes in as bytes and the labelmap comes back TRANSFERRED, so a 418 MB result is moved,
// not copied. Everything else in the reply is small.
import { decodeSegmentation, type SegReference } from "../logic/readers/dicom-seg.ts";
import { dcmjsUrl } from "../logic/dcmjs-version.ts";
import { setDicomLibrary } from "../logic/dicom-io.ts";

/**
 * dcmjs IN A WORKER. The parser is a UMD bundle that the page loads with a script tag, which a
 * worker does not have -- the first attempt at this failed with "dcmjs is only available in a
 * browser (no document)" on all four segmentations (2026-09-22). Fetched and evaluated here
 * instead, the same way the codec worker instantiates its WebAssembly glue, and handed to the
 * reader through the injection point that already exists for the tests.
 */
let ready: Promise<void> | null = null;
function dcmjsReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // The vendored copy beside this worker; no network (critic, 2026-09-28, finding 1).
      const url = dcmjsUrl();
      try {
        const src = await fetch(url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
        const g = self as unknown as Record<string, unknown>;
        new Function(src)();                         // UMD: assigns self.dcmjs
        if (!g.dcmjs) throw new Error("the bundle defined no dcmjs");
        setDicomLibrary(g.dcmjs);
      } catch (e) {
        ready = null;
        throw new Error(`dcmjs could not be loaded in the worker from ${url}: ${(e as Error)?.message ?? e}`);
      }
    })();
  }
  return ready;
}

interface Request { id: number; bytes: ArrayBuffer; ref: SegReference }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e) => {
  const { id, bytes, ref } = e.data;
  try {
    await dcmjsReady();
    let phases: unknown;
    const seg = await decodeSegmentation(bytes, ref, (p) => { phases = p; });
    // `lab` is the only large field; the rest are counts, names and codes.
    const lab = seg.lab;
    ctx.postMessage({ id, seg: { ...seg, lab: lab.buffer }, phases }, [lab.buffer as ArrayBuffer]);
  } catch (err) {
    // THE FILE GOES BACK WITH THE ERROR. It was transferred in, so the page no longer has it, and
    // the page's fallback to a main-thread decode needs it (critic, 2026-09-22, finding 10). If the
    // failure detached it, say so without it rather than throwing from the error path.
    const message = (err as Error)?.message ?? String(err);
    try {
      ctx.postMessage({ id, error: message, bytes }, [bytes]);
    } catch {
      ctx.postMessage({ id, error: message });
    }
  }
};
