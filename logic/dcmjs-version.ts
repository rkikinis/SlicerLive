// THE dcmjs VERSION, IN ONE PLACE. Ron, 2026-09-25: "When our infrastructure changes we need to update quickly. We need to
// organize what we are doing in such a way that it is not prohibitive or painful to constantly update." dcmjs reads and
// writes every DICOM file here; the page and the workers load the vendored copy (dcmjsUrl below), and the Deno side (the server's
// copy converter, the tests) imports it through logic/dcmjs.ts, whose npm version a test holds to this one
// (desktop/duckn-copy-code.test.ts). An update is this line, the import in logic/dcmjs.ts, and the test suite.
// No import of dcmjs itself here: this file goes into the page's bundle. It imports only render/build-id.ts, which is
// page-safe (no DOM), for the build id every runtime code load carries.
import { workerUrl } from "../render/build-id.ts";
// BACK TO 0.41.0 (2026-09-25 night, the critic's round on the update, qa/2026-09-25-night-copy-and-dcmjs.md): 0.52.0
// misreads a sequence sent with VR UN -- a public CT slice that 0.41 loads came back with a 909 MB value -- and names
// GE's private creator (7FD1,0010) as a retired standard attribute. 0.52's only gain for us was UV. Moving up again
// waits on those two, drafted in the workspace's upstream-issues-dcmjs.md. The open fix for the first (dcmjs #492, and
// #496, its copy) is NOT enough as it stands: it takes any UN value starting FE FF for a sequence, and a private -2
// then makes the file unreadable (qa/2026-09-26-dcmjs-pr-tests.md). Before moving, also time the writers: dcmjs's
// writer from 0.44 on is about 9x slower on a large header.
export const DCMJS_VERSION = "0.41.0";

/**
 * Where the page and the workers load dcmjs from: the vendored copy beside the bundle (render/vendor/dcmjs/, which the
 * rebuild copies to webgpu/vendor/dcmjs/). Every bundle is an ES module in webgpu/, so `import.meta.url` is the
 * bundle's own address. Until 2026-09-28 this was jsdelivr then unpkg, at run time (critic, 2026-09-28, finding 1):
 * no network meant no DICOM, and the file asked for (`dcmjs.min.js`) is not in the package -- unpkg answered 404 and
 * jsdelivr served a copy it minified on request.
 */
export function dcmjsUrl(): string {
  return workerUrl("./vendor/dcmjs/dcmjs.js", import.meta.url).href;   // carries the build id (render/build-id.test.ts)
}
