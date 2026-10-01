// A COPY OF THE DATA IS HELD ONLY WHILE SOMETHING IS READING IT.
//
// Three memory incidents in one day, 2026-09-22, all the same shape and none visible until the
// window died: the CT's samples kept by two managers at once (1.6 GB each, float32, for a volume
// already on the GPU); a decoded labelmap left in a cache that was its last owner; and a colorize
// field published by a build that finished after the look had moved on. Ron: "we have had now
// several incidents when unneeded data was clogging the ducts ... Are there rules for checking at
// implementation and running tests to prevent this in the future."
//
// The rule, in three parts, and what enforces each:
//
//   1. SAMPLES THAT HAVE BECOME A TEXTURE ARE DROPPED, in the same function that uploaded them.
//      Guarded here: a reader of the zarr store must slim or forget what it read.
//   2. A CACHE IS A CONVENIENCE, NEVER THE LAST OWNER. Guarded here: `forgetDecoded` exists and is
//      called from the upload paths.
//   3. WORK THAT TAKES SECONDS CHECKS, BEFORE PUBLISHING, THAT ITS RESULT IS STILL WANTED.
//      Guarded here: the colorize build tests the slot before it publishes.
//
// And at RUN time, `__memoryCheck()` writes a line into the session log after every load, naming
// anything over 100 MB that is a copy of something already on the GPU. A regression shows up as a
// sentence in Ron's own log rather than as a window that disappears.
import { assert } from "jsr:@std/assert";

const src = Deno.readTextFileSync(new URL("./livescene.ts", import.meta.url));
const zarr = Deno.readTextFileSync(new URL("./zarr.ts", import.meta.url));

Deno.test("every volume read in the renderer gives its samples back", () => {
  // Each call site of the two readers, read to the END OF THE METHOD it sits in: somewhere in
  // there the samples must be slimmed, forgotten, or released with the slot that held them.
  const lines = src.split("\n");
  const methodStart = /^  (private |public |static |async |\*|[A-Za-z_$][\w$]*\s*[(<])/;
  const offenders: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (!/\bfetchZarrVolume(Native)?\(/.test(line)) continue;
    let end = i + 1;
    while (end < lines.length && !methodStart.test(lines[end])) end++;
    const body = lines.slice(i, end).join("\n");
    // A helper whose whole job is to READ and hand the samples straight back to its caller is not
    // a holder; the caller it returns to is, and that caller is checked on its own line.
    const passesThrough = /^\s*return await fetchZarrVolume/.test(line);
    const gives = passesThrough || /\bslim\(|forgetDecoded\(|nativeLab = undefined|segZv = undefined/.test(body);
    if (!gives) offenders.push(`livescene.ts:${i + 1}  ${line.trim().slice(0, 90)}`);
  }
  assert(offenders.length === 0, "a volume is read and its samples are never given back:\n" + offenders.join("\n"));
});

Deno.test("the decoded caches can be emptied, and the renderer empties them", () => {
  assert(/export function forgetDecoded\(/.test(zarr), "zarr.ts no longer lets a caller forget a decoded volume");
  assert(/export function decodedCacheReport\(/.test(zarr), "the decoded caches can no longer be measured");
  const calls = (src.match(/forgetDecoded\(/g) ?? []).length;
  assert(calls >= 3, `the renderer forgets a decoded volume in only ${calls} place(s); the upload paths are the slice manager, the volume rendering and the segmentation`);
});

Deno.test("a colorize build that is no longer wanted does not publish itself", () => {
  const i = src.indexOf("private async buildColorize");
  assert(i > 0, "buildColorize is gone; this test needs rewriting against whatever replaced it");
  const body = src.slice(i, src.indexOf("private reLUT", i));
  assert(/if \(!slot\.visible \|\| !slot\.colorize\)[\s\S]{0,200}decolorize/.test(body),
    "buildColorize no longer checks, before publishing, that the rendering is still on — the 1,196 MB leak of 2026-09-22");
});

Deno.test("the window can say what it is holding, and say whether it should be", () => {
  const views = Deno.readTextFileSync(new URL("./moduleserver/live-views.ts", import.meta.url));
  assert(/__memoryReport: \(\) =>/.test(views), "__memoryReport is gone: nothing can measure what is held");
  assert(/__memoryCheck: \(\) =>/.test(views), "__memoryCheck is gone: nothing writes the check into the session log");
  const load = Deno.readTextFileSync(new URL("./demos/load-panel.ts", import.meta.url));
  assert((load.match(/__memoryCheck/g) ?? []).length >= 2, "a load no longer records what the window is holding afterwards");
});
