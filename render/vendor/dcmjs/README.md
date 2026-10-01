# Vendored dcmjs (the page's and the workers' copy)

`dcmjs` 0.41.0 (dcmjs-org, MIT, `License.txt`), the UMD build `build/dcmjs.js` copied from the npm package on
2026-09-28, the tarball checked against the registry's sha512 integrity. sha256 of `dcmjs.js`: `fe4a232d731d51e6…`.

Why here: until 2026-09-28 the page and the SEG-decode worker loaded dcmjs from jsdelivr, then unpkg, at run time
(critic, qa/2026-09-28-dependencies.md, finding 1): no network and an empty cache meant no DICOM at all, and nothing
checked the code that came back. The URL asked for `build/dcmjs.min.js`, which the package does not contain — unpkg
answered 404, and jsdelivr served a copy it minified itself on request (Terser), i.e. code nobody pinned.

The version is `DCMJS_VERSION` in `logic/dcmjs-version.ts`; the Deno side (the copy converter, the tests) imports the
same version from npm through `logic/dcmjs.ts`, and `desktop/duckn-copy-code.test.ts` holds all three equal. The
rebuild copies this folder to `webgpu/vendor/dcmjs/`. To update: replace `dcmjs.js` and `License.txt` from the new
package's `build/`, change the version in those two files, run the tests.
