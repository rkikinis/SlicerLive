// The slice in 3D is drawn ONLY from its view's paint, where the renderer holds that view's current layers and plane.
// Drawn from anywhere else after the slice scheduler came in (Steve's, 2026-09-24), it drew the previous plane, and
// after a scene close it drew destroyed textures: nine false "The views have stopped drawing" dialogs (critic,
// 2026-09-24, steve-merge finding 1). The browser tests that would exercise this cannot run in the rebuild, so the
// rule is checked on the source.
//
//   deno test -A --no-check render/moduleserver/slice-in-3d-order.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("renderSliceIn3D is called from one place only, inside paintSlice", () => {
  const src = Deno.readTextFileSync(new URL("./live-views.ts", import.meta.url));
  const calls = [...src.matchAll(/renderSliceIn3D\(/g)].map((m) => m.index!);
  const defs = [...src.matchAll(/const renderSliceIn3D = /g)].length;
  assertEquals(defs, 1);
  assertEquals(calls.length, 1, "renderSliceIn3D is called from more than one place");
  const paint = src.indexOf("const paintSlice = ");
  const paintEnd = src.indexOf("\n  };", paint);
  assert(paint > 0 && calls[0] > paint && calls[0] < paintEnd, "the one call is not inside paintSlice");
});
