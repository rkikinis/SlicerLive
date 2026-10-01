# Vendored sql.js (reads the DICOM database index in the page)

`sql.js` 1.13.0 (MIT, `LICENSE`; SQLite itself is public domain), `dist/sql-wasm.js` and `dist/sql-wasm.wasm` copied
from the npm package on 2026-09-28, the tarball checked against the registry's sha512 integrity. sha256:
`sql-wasm.js` `694ca5b36aa3e6e7…`, `sql-wasm.wasm` `0734155c83e49398…`.

Why here: until 2026-09-28 `logic/readers/dicom-db.ts` loaded it from jsdelivr, then unpkg, at run time (critic,
qa/2026-09-28-dependencies.md, finding 1). The version is `SQLJS_VERSION` in `logic/readers/dicom-db.ts`. The rebuild
copies this folder to `webgpu/vendor/sqljs/`. To update: replace the three files from the new package, change the
version there and here, run the tests.
