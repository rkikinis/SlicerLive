// The app's server answers only its own page and this machine (code review 2026-09-24, A10).
//
//   deno test -A --no-check desktop/server-origin.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { refuseForeign } from "./server-worker.ts";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:4180/_db", { method: "POST", headers });

Deno.test("the app's own page and local tools are served; other sites and other hosts are refused", () => {
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", origin: "http://127.0.0.1:4180" }), 4180), null);
  assertEquals(refuseForeign(req({ host: "localhost:4180" }), 4180), null);                      // curl, scripts
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", origin: "https://example.com" }), 4180)?.status, 403);
  assertEquals(refuseForeign(req({ host: "evil.example:4180" }), 4180)?.status, 403);            // DNS rebinding
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", origin: "null" }), 4180)?.status, 403);
  // An <img> or a link from another site: no Origin, but the browser says where it came from.
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", "sec-fetch-site": "cross-site" }), 4180)?.status, 403);
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", "sec-fetch-site": "same-origin" }), 4180), null);
  assertEquals(refuseForeign(req({ host: "127.0.0.1:4180", "sec-fetch-site": "none" }), 4180), null);   // typed in the address bar
});
