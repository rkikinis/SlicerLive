// Loading a vendored Emscripten codec (render/vendor/codecs/) the same way everywhere.
//
// The glue files are UMD (a global, CommonJS, AMD): no ES export, so a plain `import` yields
// nothing. Evaluated here as a function body with a `module` object handed in, which is the
// CommonJS branch -- and works identically under Deno (the tests) and in a worker (the app),
// neither of which has `document`. The wasm bytes are handed to Emscripten as `wasmBinary`, so
// the glue never has to locate a file: whoever calls has already fetched or read it.
export interface CodecFrameInfo { width: number; height: number; bitsPerSample: number; componentCount: number; isSigned: boolean }
export interface CodecDecoder {
  getEncodedBuffer(n: number): Uint8Array;
  decode(): void;
  getFrameInfo(): CodecFrameInfo;
  getDecodedBuffer(): Uint8Array | Uint16Array;
  delete?(): void;
}
export interface CodecModule { [cls: string]: new () => CodecDecoder }

export const CODEC_FILES = {
  jpeg8: { js: "libjpegturbowasm_decode.js", wasm: "libjpegturbowasm_decode.wasm", cls: "JPEGDecoder" },
  jpeg12: { js: "libjpegturbo12wasm.js", wasm: "libjpegturbo12wasm.wasm", cls: "JPEGDecoder" },
  jpegls: { js: "charlswasm_decode.js", wasm: "charlswasm_decode.wasm", cls: "JpegLSDecoder" },
  j2k: { js: "openjpegwasm_decode.js", wasm: "openjpegwasm_decode.wasm", cls: "J2KDecoder" },
  htj2k: { js: "openjphjs.js", wasm: "openjphjs.wasm", cls: "HTJ2KDecoder" },
} as const;
export type CodecName = keyof typeof CODEC_FILES;

/** Instantiate a codec from its glue source and wasm bytes. */
export async function instantiateCodec(glueSource: string, wasm: Uint8Array): Promise<CodecModule> {
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  // The glue's own `_scriptName` probe reads `document.currentScript`; there is no document here
  // and the check is guarded. Its Node branch (Deno defines `process`, so it is taken there)
  // requires `fs` and `path` to read the wasm from disk; with `wasmBinary` given it never reads,
  // so a `require` that answers with nothing is enough. A worker takes the web branch.
  // NOT NODE, whatever the runtime says: Deno defines `process`, and the glue's Node branch then
  // reaches for `require("fs")` and `__dirname` to read the wasm from disk. Shadowing `process`
  // sends it down the plain branch, which with `wasmBinary` given touches no file and no network.
  new Function("module", "exports", "process", "require", glueSource)(mod, mod.exports, undefined, undefined);
  const factory = (mod.exports.default ?? mod.exports) as (arg: Record<string, unknown>) => Promise<CodecModule>;
  if (typeof factory !== "function") throw new Error("the codec glue did not export a factory");
  return await factory({ wasmBinary: wasm });
}

/** Decode one codestream with an instantiated codec: interleaved samples and the frame's shape. */
export function decodeWith(mod: CodecModule, cls: string, bytes: Uint8Array): { info: CodecFrameInfo; samples: Uint8Array | Uint16Array } {
  const d = new mod[cls]();
  try {
    const enc = d.getEncodedBuffer(bytes.length);
    enc.set(bytes);
    d.decode();
    const info = d.getFrameInfo();
    const out = d.getDecodedBuffer();
    // COPIED OUT of the wasm heap: the view is invalid once the decoder is deleted or the heap grows.
    const bytesPer = info.bitsPerSample > 8 ? 2 : 1;
    const n = info.width * info.height * info.componentCount;
    // Most wrappers return a byte view; the 12-bit libjpeg one returns a Uint16Array. Measure in bytes.
    const outBytes = out.byteLength;
    if (outBytes < n * bytesPer) throw new Error(`the codec returned ${outBytes} bytes for ${n} samples of ${bytesPer} byte(s)`);
    const copy = new Uint8Array(out.buffer, out.byteOffset, n * bytesPer).slice();
    const samples = bytesPer === 2 ? new Uint16Array(copy.buffer) : copy;
    return { info: { width: info.width, height: info.height, bitsPerSample: info.bitsPerSample, componentCount: info.componentCount, isSigned: !!info.isSigned }, samples };
  } finally {
    d.delete?.();
  }
}
