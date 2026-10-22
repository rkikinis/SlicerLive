// A STEP OF A PLAYING SERIES REBINDS; IT DOES NOT RE-COMPOSE THE 3D VIEW (CINE-RETHINK.md step 1). The rebind falls back to
// the full rebuild only when what the volumes draw changed, which it tells by comparing the key rebuild3d last announced.
// On 2026-10-16 that key grew a second half (the set a volume rendering colors) and the rebind kept comparing the first
// half alone: every step re-composed the view (Ron's log, 2026-10-17: "8 series steps rebound, 8 3D view compositions").
// Both sides must use the one function.
//
//   deno test -A --no-check render/moduleserver/rebind-key.test.ts
import { assert } from "jsr:@std/assert@1";

const src = Deno.readTextFileSync(new URL("./live-views.ts", import.meta.url));

Deno.test("the rebind compares the same key the 3D view announces", () => {
  const rebind = src.slice(src.indexOf("rebind3d() {"), src.indexOf("swapVolume3D(prevId"));
  assert(/colorizedKeyOf\(colorizedSets\(\)\) !== colorizedLast/.test(rebind), "rebind3d no longer compares colorizedKeyOf(...) with colorizedLast");
  assert(/const colorizedKey = colorizedKeyOf\(/.test(src), "rebuild3d0 no longer makes its key with colorizedKeyOf");
});
