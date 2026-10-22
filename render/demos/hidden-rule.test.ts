// An author `display` beats the browser's own [hidden] rule, so `el.hidden = true` can leave an element on screen. It
// happened five times (the 3D panel, its rows, the slice panel, a drop zone, the sequence transport's empty box in the
// top bar, 2026-10-15); theme.css now hides every [hidden] element. This keeps that rule there.
import { assert } from "jsr:@std/assert@1";

Deno.test("theme.css hides every element with the hidden attribute, whatever its display", () => {
  const css = Deno.readTextFileSync(new URL("./theme.css", import.meta.url));
  assert(/(^|\n)\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(css));
});
