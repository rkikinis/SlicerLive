// Which links leave the application, and which are the application talking to itself.
//
// This matters more than it looks. In the native shell there is no browser chrome, so a link that
// is wrongly treated as internal navigates the app away from itself and the only way back is
// relaunching it -- and a link wrongly treated as EXTERNAL hands the app's own legacy mode to the
// system browser, which is what the previous rule did: it tested `a.href` against /^https?:/, and
// `a.href` is the RESOLVED absolute URL, so `<a href="?legacy">` came back as
// "http://localhost:8080/slicer-app.html?legacy" and matched. It never fired only because the one
// place the rule was applied happened to contain no relative links; adding a Wikipedia link to the
// Welcome panel put the rule on a path where relative links do exist.
//
// The rule is ORIGIN, not scheme.
import { assertEquals } from "jsr:@std/assert@1";
import { isExternalHref } from "./app-shell.ts";

const PAGE = "http://localhost:8080/slicer-app.html?v=3";

Deno.test("links that leave the app are handed to the system browser", () => {
  for (const href of [
    "https://en.wikipedia.org/wiki/Albula_Pass",   // the Welcome panel's origin note
    "https://github.com/pieper/SlicerLive",          // the footer's attributions
    "https://github.com/mhalle/haversack",
    "http://example.org/plain-http",
    "//example.org/protocol-relative",
  ]) assertEquals(isExternalHref(href, PAGE), true, href);
});

Deno.test("links back into the app are left to the app", () => {
  for (const href of [
    "?legacy",                                        // the developer section's legacy mode
    "#section",
    "slicer-app.html",
    "/slicer-app.html?legacy",
    "http://localhost:8080/other.html",               // same origin spelled absolutely
  ]) assertEquals(isExternalHref(href, PAGE), false, href);
});

Deno.test("a scheme that is not http(s) is not something to hand to a browser", () => {
  // mailto: and tel: belong to the OS handler, javascript: and data: are not navigation at all.
  // None of them should be routed through /_open, and an unparseable href must not throw mid-click.
  for (const href of ["mailto:someone@example.org", "tel:+41", "javascript:void 0", "data:text/plain,x", "", "::::"]) {
    assertEquals(isExternalHref(href, PAGE), false, href);
  }
});
