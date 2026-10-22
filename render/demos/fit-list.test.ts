// fit-list.ts: the automatic height of a list in a module (Ron, 2026-10-15: "Lots of empty space but still a scroll bar").
import { assertEquals } from "jsr:@std/assert@1";
import { autoHeight } from "./fit-list.ts";

Deno.test("a list as tall as its rows while the column has room, shorter by what the column lacks, never below the minimum", () => {
  assertEquals(autoHeight(300, -400), 300);   // room to spare: all of it, no scroll bar
  assertEquals(autoHeight(300, 0), 300);
  assertEquals(autoHeight(300, 120), 180);    // the column would scroll by 120: the list gives that up
  assertEquals(autoHeight(300, 280, 96), 96); // never below the minimum
  assertEquals(autoHeight(60, 500, 96), 60);  // a short list stays its own height
});
