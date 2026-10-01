// One entry point for a compressed frame: which decoder, and the samples as the series reader
// takes them. RLE and JPEG lossless are ours and run inline; the rest go to the vendored
// WebAssembly codecs -- in a worker in the application (algorithms/codec-worker.ts), directly
// under Deno (the tests), through the same instantiateCodec.
import { decodeRleFrame } from "./rle.ts";
import { decodeJpegLossless } from "./jpeg-lossless.ts";
import { JPEG_LOSSLESS, RLE } from "./encapsulated.ts";
import { CODEC_FILES, type CodecModule, type CodecName, decodeWith, instantiateCodec } from "./wasm.ts";
import { workerUrl } from "../../render/build-id.ts";

export interface FrameMeta { rows: number; columns: number; samplesPerPixel: number; bitsAllocated: number; bitsStored: number; signed: boolean }
export interface DecodedFrame { samples: Uint8Array | Uint16Array; bitsPerSample: number; componentCount: number }

/** The vendored codec a transfer syntax needs, or null when the decoder is ours or none exists. */
export function wasmCodecFor(syntax: string): CodecName | null {
  switch (syntax) {
    case "1.2.840.10008.1.2.4.50": return "jpeg8";
    case "1.2.840.10008.1.2.4.51": return "jpeg12";
    case "1.2.840.10008.1.2.4.80": case "1.2.840.10008.1.2.4.81": return "jpegls";
    case "1.2.840.10008.1.2.4.90": case "1.2.840.10008.1.2.4.91": return "j2k";
    case "1.2.840.10008.1.2.4.201": case "1.2.840.10008.1.2.4.202": case "1.2.840.10008.1.2.4.203": return "htj2k";
    default: return null;
  }
}
export const canDecode = (syntax: string): boolean => syntax === RLE || JPEG_LOSSLESS.has(syntax) || wasmCodecFor(syntax) !== null;

/** Decode one frame of an encapsulated instance. Throws with a plain reason. */
export async function decodeFrame(syntax: string, frame: Uint8Array, m: FrameMeta): Promise<DecodedFrame> {
  if (syntax === RLE) {
    const bytes = decodeRleFrame(frame, m.rows, m.columns, m.samplesPerPixel, m.bitsAllocated / 8);
    if (m.bitsAllocated === 8) return { samples: bytes, bitsPerSample: 8, componentCount: m.samplesPerPixel };
    if (m.bitsAllocated === 16) return { samples: new Uint16Array(bytes.buffer, 0, bytes.byteLength / 2), bitsPerSample: m.bitsStored, componentCount: m.samplesPerPixel };
    throw new Error(`${m.bitsAllocated}-bit RLE samples are not read as a volume`);
  }
  if (JPEG_LOSSLESS.has(syntax)) {
    const j = decodeJpegLossless(frame);
    return { samples: j.pixels, bitsPerSample: j.precision, componentCount: j.components };
  }
  const codec = wasmCodecFor(syntax);
  if (!codec) throw new Error("no decoder for this transfer syntax");
  const r = await runWasm(codec, frame);
  return { samples: r.samples, bitsPerSample: r.info.bitsPerSample, componentCount: r.info.componentCount };
}

/**
 * The samples a decoder returned, as the reader's 16-bit little-endian pixels: masked to
 * BitsStored and sign-extended from it when the data is signed. A 14-bit signed CT out of
 * OpenJPEG carried a set bit 15 above its 14 two's-complement bits, and a 15-bit signed JPEG-LS
 * file sign-extends from bit 14 -- neither is "read it as Int16".
 */
export function toReaderPixels(d: DecodedFrame, m: FrameMeta): Uint16Array {
  const out = d.samples instanceof Uint16Array ? d.samples : Uint16Array.from(d.samples);
  const bits = Math.min(m.bitsStored || 16, 16);
  if (bits < 16 || m.signed) {
    const full = 1 << bits, mask = full - 1, half = full >> 1;
    for (let i = 0; i < out.length; i++) {
      let v = out[i] & mask;
      if (m.signed && v >= half) v = (v - full) & 0xffff;   // two's complement in 16 bits, as the raw path stores it
      out[i] = v;
    }
  }
  return out;
}

// ---- the WebAssembly side: a worker in the app, direct under Deno ----
type WasmResult = { samples: Uint8Array | Uint16Array; info: { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean } };
const isDeno = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined";
const direct = new Map<CodecName, Promise<CodecModule>>();
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: WasmResult) => void; reject: (e: Error) => void }>();

async function runWasm(codec: CodecName, frame: Uint8Array): Promise<WasmResult> {
  if (isDeno) {
    let p = direct.get(codec);
    if (!p) {
      const f = CODEC_FILES[codec];
      const dir = new URL("../../render/vendor/codecs/", import.meta.url);
      const D = (globalThis as unknown as { Deno: { readTextFile(p: URL): Promise<string>; readFile(p: URL): Promise<Uint8Array> } }).Deno;
      p = Promise.all([D.readTextFile(new URL(f.js, dir)), D.readFile(new URL(f.wasm, dir))]).then(([g, w]) => instantiateCodec(g, w));
      direct.set(codec, p);
    }
    return decodeWith(await p, CODEC_FILES[codec].cls, frame);
  }
  if (!worker) {
    worker = new Worker(workerUrl("./codec-worker.js"), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; samples?: ArrayBuffer; bytesPerSample?: number; info?: WasmResult["info"]; error?: string }>) => {
      const w = pending.get(e.data.id); if (!w) return;
      pending.delete(e.data.id);
      if (e.data.error || !e.data.samples || !e.data.info) w.reject(new Error(e.data.error ?? "the codec worker returned nothing"));
      else w.resolve({ samples: e.data.bytesPerSample === 2 ? new Uint16Array(e.data.samples) : new Uint8Array(e.data.samples), info: e.data.info });
    };
    worker.onerror = (ev) => {
      const msg = (ev as ErrorEvent).message ?? "the codec worker failed";
      for (const w of pending.values()) w.reject(new Error(msg));
      pending.clear();
      worker?.terminate(); worker = null;                    // the next frame starts a fresh one
    };
  }
  const id = nextId++;
  // A COPY goes to the worker: the fragment is a view into the instance's buffer, which the
  // reader still needs, so it cannot be transferred.
  const bytes = frame.slice().buffer as ArrayBuffer;
  return await new Promise<WasmResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, codec, bytes }, [bytes]);
  });
}
