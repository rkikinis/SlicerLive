// The codec worker: the vendored WebAssembly codecs (render/vendor/codecs/) instantiated once
// each, off the main thread, answering decode requests one frame at a time. The glue and the
// wasm are fetched from ./vendor/codecs/ beside this worker; the page never touches them.
import { BUILD_ID } from "../render/build-id.ts";
import { CODEC_FILES, type CodecModule, type CodecName, decodeWith, instantiateCodec } from "../logic/codecs/wasm.ts";

interface Request { id: number; codec: CodecName; bytes: ArrayBuffer }
interface Reply { id: number; samples?: ArrayBuffer; bytesPerSample?: number; info?: { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean }; error?: string; ms: number; build: string }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(m: Reply, t?: Transferable[]): void; location: { href: string } };
const modules = new Map<CodecName, Promise<CodecModule>>();

function load(name: CodecName): Promise<CodecModule> {
  let p = modules.get(name);
  if (!p) {
    const f = CODEC_FILES[name];
    const base = new URL("./vendor/codecs/", ctx.location.href);
    p = (async () => {
      const [glue, wasm] = await Promise.all([
        fetch(new URL(f.js, base)).then((r) => { if (!r.ok) throw new Error(`${f.js}: HTTP ${r.status}`); return r.text(); }),
        fetch(new URL(f.wasm, base)).then((r) => { if (!r.ok) throw new Error(`${f.wasm}: HTTP ${r.status}`); return r.arrayBuffer(); }),
      ]);
      return await instantiateCodec(glue, new Uint8Array(wasm));
    })();
    modules.set(name, p);
    p.catch(() => modules.delete(name));                    // a failed load is retried next time, not cached
  }
  return p;
}

ctx.onmessage = async (e) => {
  const { id, codec, bytes } = e.data;
  const t0 = performance.now();
  try {
    const mod = await load(codec);
    const r = decodeWith(mod, CODEC_FILES[codec].cls, new Uint8Array(bytes));
    const buf = r.samples.buffer as ArrayBuffer;
    ctx.postMessage({ id, samples: buf, bytesPerSample: r.samples.BYTES_PER_ELEMENT, info: r.info, ms: performance.now() - t0, build: BUILD_ID }, [buf]);
  } catch (err) {
    ctx.postMessage({ id, error: (err as Error).message, ms: performance.now() - t0, build: BUILD_ID });
  }
};
