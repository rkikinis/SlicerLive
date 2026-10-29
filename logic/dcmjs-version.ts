// THE dcmjs VERSION, IN ONE PLACE. Ron, 2026-09-25: "When our infrastructure changes we need to update quickly. We need to
// organize what we are doing in such a way that it is not prohibitive or painful to constantly update." dcmjs reads and
// writes every DICOM file here; the page and the workers load the vendored UMD build (dcmjsUrl below), and the Deno side
// (the server's copy converter, the tests) imports the vendored ESM build of the same commit through logic/dcmjs.ts; a test
// holds both files to the sha256 below (desktop/duckn-copy-code.test.ts). An update is the two files, the lines below,
// and the test suite.
// No import of dcmjs itself here: this file goes into the page's bundle. It imports only render/build-id.ts, which is
// page-safe (no DOM), for the build id every runtime code load carries.
import { workerUrl } from "../render/build-id.ts";
// STEVE PIEPER'S BUILD SINCE 2026-10-28 (Ron: "Why not move to his build?"): dcmjs's mrcom-integration branch, commit
// b02ee51 (master at aee06e4, the DS fix #610 that our issue #531 asked for, plus his five open pull requests #622, #624-627
// for the MRCOM scene bundle), vendored by him in render/vendor/dcmjs/ (README.md there: what it is, what was checked).
// 0.41.0 before it, from 2026-09-25 night (qa/2026-09-25-night-copy-and-dcmjs.md): of the three reasons for holding it,
// the UN-sequence misread is gone in this build; GE's (7FD1,0010) is still named as a retired attribute (the TCGA-UCEC
// CTs; workspace upstream-issues-dcmjs.md, item 10), and the writer is still slower on a large header (11.8 s against
// 1.25 s on the Philips fMRI; Albula's own writers measured in the README). The version is a label: the files are
// pinned by their sha256 below, and desktop/duckn-copy-code.test.ts holds the files to it.
export const DCMJS_VERSION = "0.49.2+mrcom-integration.b02ee51";
/** sha256 of the two builds of that one commit: the UMD the page and the workers load, the ESM the Deno side imports. */
export const DCMJS_SHA256 = {
  "dcmjs.min.js": "199b181bf942cfc4714f17ee167eb220a18c2e4bb6376a9040ccb52db961474f",
  "dcmjs.es.js": "1ce83476e02069b2832018a3dca5696cac5a140326df149917bbd64f756dfea7",
} as const;

/**
 * Where the page and the workers load dcmjs from: the vendored UMD build beside the bundle (render/vendor/dcmjs/dcmjs.min.js,
 * which the rebuild copies to webgpu/vendor/dcmjs/). Every bundle is an ES module in webgpu/, so `import.meta.url` is the
 * bundle's own address. Until 2026-09-28 this was jsdelivr then unpkg, at run time (critic, 2026-09-28, finding 1):
 * no network meant no DICOM, and the file asked for (`dcmjs.min.js`) is not in the package -- unpkg answered 404 and
 * jsdelivr served a copy it minified on request.
 */
export function dcmjsUrl(): string {
  return workerUrl("./vendor/dcmjs/dcmjs.min.js", import.meta.url).href;   // carries the build id (render/build-id.test.ts)
}
