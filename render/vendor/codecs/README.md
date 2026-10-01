# Vendored image codecs (WebAssembly)

The four real codecs a DICOM reader needs, as the WebAssembly builds the Cornerstone project
maintains (https://github.com/cornerstonejs/codecs, Chris Hafey's Emscripten builds), copied here
at pinned versions and never fetched at runtime. Each is one glue `.js` (Emscripten, MODULARIZE,
UMD) and one `.wasm`; the decode-only builds where the package offers them. Loaded by
`logic/codecs/wasm.ts` (the same way under Deno and in the codec worker), used by
`logic/codecs/decode.ts`. Ron, 2026-09-19: "yes, go ahead with the rest" — after RLE and JPEG
lossless were written by hand (they do not change; these are real codecs and are not ours to
maintain).

| files | package | version | wrapper license | codec inside |
|---|---|---|---|---|
| `libjpegturbowasm_decode.*` | @cornerstonejs/codec-libjpeg-turbo-8bit | 1.2.8 | ISC | libjpeg-turbo (IJG / BSD-3 / zlib) — JPEG baseline 8-bit (.50) |
| `libjpegturbo12wasm.*` | @cornerstonejs/codec-libjpeg-turbo-12bit | 0.4.7 | ISC | libjpeg-turbo, 12-bit — JPEG extended (.51) |
| `charlswasm_decode.*` | @cornerstonejs/codec-charls | 1.2.7 | MIT | CharLS (BSD-3) — JPEG-LS (.80, .81) |
| `openjpegwasm_decode.*` | @cornerstonejs/codec-openjpeg | 1.3.6 | MIT | OpenJPEG (BSD-2) — JPEG 2000 (.90, .91) |
| `openjphjs.*` | @cornerstonejs/codec-openjph | 2.4.11 | MIT | OpenJPH (BSD-2) — HTJ2K (.201, .202, .203) |

All five expose the same shape: `new mod.<X>Decoder()`, `getEncodedBuffer(n)` (a view to fill),
`decode()`, `getFrameInfo()` → `{width, height, bitsPerSample, componentCount, isSigned}`,
`getDecodedBuffer()` → interleaved samples, 1 or 2 bytes each, little-endian.

To update: download the package tarball from the npm registry, copy the two files, change the
version here, run `deno test -A --no-check logic/codecs/` — every sample in
`Contents/data/codecs` (the workspace) must still decode bit-exact against the independent
truths.

License texts of the codecs inside the builds (critic, 2026-10-01, working-line privacy finding 10): CharLS (`LICENSE-charls.md`), OpenJPH (`LICENSE-openjph.md`), libjpeg-turbo (`LICENSE-libjpeg-turbo.md`, from libjpeg-turbo's repository: IJG, BSD-3 and zlib terms) and OpenJPEG (`LICENSE-openjpeg.txt`, from OpenJPEG's repository: BSD-2), both fetched 2026-10-01 from the projects' default branches.
