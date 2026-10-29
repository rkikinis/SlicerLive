// dcmjs FOR DENO: the server's copy converter and the tests import it from here and nowhere else. It is the vendored ESM
// build of the same commit as the UMD build the page loads (render/vendor/dcmjs/, logic/dcmjs-version.ts);
// desktop/duckn-copy-code.test.ts holds both files to their pinned sha256. Not for the page's bundle -- the page loads the
// UMD build itself.
import dcmjs from "../render/vendor/dcmjs/dcmjs.es.js";
export default dcmjs;
