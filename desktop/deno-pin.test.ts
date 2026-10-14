// Every path that runs the tests runs under the pinned Deno (critic, 2026-10-13, finding 3): the Rebuild, the Package
// script, a hand-run `deno test`, a Windows machine. The application IS this Deno -- its server compiled with it, its
// SQLite the one inside it -- so a test pass under another version says nothing about the app.
import { assertEquals } from "jsr:@std/assert@1";
import { denoWanted } from "./versions.ts";

Deno.test("Deno is the version pinned in DENO_VERSION", () => {
  assertEquals(Deno.version.deno, denoWanted(), "change DENO_VERSION only after the tests pass under the new Deno");
});
