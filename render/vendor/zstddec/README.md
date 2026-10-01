# Vendored zstd decoder (WebAssembly)

`zstddec` 0.3.1 by Don McCurdy (https://github.com/donmccurdy/zstddec), copied from the npm package's
`dist/` at that pinned version and never fetched at runtime. Its WebAssembly is the Zstandard
reference decoder (Yann Collet, Facebook), compiled from zstd's single-file build and embedded in
`zstddec.mjs` as base64. `LICENSE` holds both: the wrapper is MIT, the decoder BSD-3-Clause.

Used by `render/zarr-copy-worker.ts` to unpack the pieces of a series' duckn working copy (the
workspace brief: Contents/docs/DUCKN-WORKING-COPY.md). Chosen on 2026-09-23 by measurement on 432
real pieces (906 MB): 714–878 MB/s on one core in JavaScriptCore, the app's engine; the pure
JavaScript alternative (fzstd) ran at 42–64 MB/s.

| file | sha256 |
|---|---|
| `zstddec.mjs` | `0757a0bb9bfbc5ae968f7eae0d6cdd6083da1e2e45d23e3af34d1a27e062fb80` |

To update: take `dist/zstddec.mjs`, `dist/zstddec.d.mts` and `LICENSE` from the package tarball,
change the version and hash here, and in the browser pane run `await __compareDucknCopy(<SeriesInstanceUID>)` on a series with a copy: it reads the series from the copy and from DICOM and compares every voxel and piece.
