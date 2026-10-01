// dcmjs FOR DENO: the server's copy converter and the tests import it from here and nowhere else, so its version is
// named once for all of them. Its npm version must equal DCMJS_VERSION in logic/dcmjs-version.ts (what the page loads);
// desktop/duckn-copy-code.test.ts fails otherwise. Not for the page's bundle -- the page loads the same version itself.
import dcmjs from "npm:dcmjs@0.41.0";
export default dcmjs;
