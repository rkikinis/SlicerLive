// The settings store is the single place anything durable is kept, and it is meant to be hand-edited,
// so the parser has to survive what people actually type and the writer has to stay diff-friendly.
//
//   deno test -A --no-check logic/settings.test.ts
import { assertEquals } from "jsr:@std/assert";
import { formatIni, openSettings, parseIni } from "./settings.ts";

Deno.test("parse: sections, keys, and values", () => {
  const ini = parseIni("[Window]\nx=1642\ny=143\n\n[Colorize]\npreset=CT-Bone\n");
  assertEquals(ini.get("Window")?.get("x"), "1642");
  assertEquals(ini.get("Colorize")?.get("preset"), "CT-Bone");
});

// A file people edit by hand collects blank lines, comments and stray spaces. Losing the rest of the
// file over any of them would be the worst possible failure for a preferences store.
Deno.test("parse: tolerates comments, blank lines and whitespace", () => {
  const ini = parseIni([
    "# a comment",
    "; another",
    "",
    "  [ Window ]  ",
    "  x =  1642  ",
    "nonsense-without-equals",
    "=valueless",
    "y=143",
  ].join("\n"));
  assertEquals(ini.get("Window")?.get("x"), "1642");
  assertEquals(ini.get("Window")?.get("y"), "143");
  assertEquals(ini.get("Window")?.size, 2);
});

Deno.test("parse: a key before any section lands in General, as Slicer does", () => {
  assertEquals(parseIni("author=Ron Kikinis\n").get("General")?.get("author"), "Ron Kikinis");
});

Deno.test("parse: a value may contain = and spaces", () => {
  assertEquals(parseIni("[A]\nk=a=b c\n").get("A")?.get("k"), "a=b c");
});

Deno.test("format: sorted, and round-trips", () => {
  const text = formatIni(parseIni("[Z]\nb=2\na=1\n[A]\nk=v\n"));
  assertEquals(text.startsWith("[A]"), true);
  const back = parseIni(text);
  assertEquals(back.get("Z")?.get("a"), "1");
  assertEquals(back.get("Z")?.get("b"), "2");
  assertEquals(back.get("A")?.get("k"), "v");
});

Deno.test("format: an empty section is not written", () => {
  const ini = parseIni("[A]\nk=v\n");
  ini.set("Empty", new Map());
  assertEquals(formatIni(ini).includes("[Empty]"), false);
});

// Exercises the fallback path a browser build takes when the endpoint is absent.
//
// The store is CLEARED first because Deno really does provide localStorage, and it persists between
// runs: without this the test writes on=0, passes, and then fails on every subsequent run by loading
// its own leftovers. A test that passes exactly once is worse than no test.
Deno.test("openSettings: no endpoint still yields a working store", async () => {
  try { globalThis.localStorage?.removeItem("slicerlive-settings-ini"); } catch { /* not available */ }
  const s = await openSettings();
  assertEquals(s.location(), "localStorage");
  assertEquals(s.get("Window", "x"), undefined);
  assertEquals(s.getNumber("Window", "x", 42), 42);
  assertEquals(s.getBool("Window", "on", true), true);

  s.set("Window", "x", 1642);
  s.set("Window", "on", false);
  assertEquals(s.get("Window", "x"), "1642");
  assertEquals(s.getNumber("Window", "x", 0), 1642);
  assertEquals(s.getBool("Window", "on", true), false);

  s.set("Window", "x", undefined);
  assertEquals(s.get("Window", "x"), undefined);
  await s.flush();                     // must not throw with nowhere to write
  try { globalThis.localStorage?.removeItem("slicerlive-settings-ini"); } catch { /* not available */ }
});

Deno.test("openSettings: a served store reports its path and PUTs on flush", async () => {
  const realFetch = globalThis.fetch;
  let put = "";
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/_settings")) return realFetch(input as string, init);
    if (init?.method === "PUT") { put = String(init.body); return Promise.resolve(new Response(null, { status: 204 })); }
    return Promise.resolve(new Response("[Colorize]\npreset=CT-Lung\n", {
      status: 200, headers: { "x-settings-path": "/tmp/settings.ini" },
    }));
  }) as typeof fetch;
  try {
    const s = await openSettings();
    assertEquals(s.location(), "/tmp/settings.ini");
    assertEquals(s.get("Colorize", "preset"), "CT-Lung");
    s.set("Window", "w", 1219);
    await s.flush();
    assertEquals(put.includes("[Window]"), true);
    assertEquals(put.includes("w=1219"), true);
    assertEquals(put.includes("preset=CT-Lung"), true);   // existing values survive a write
  } finally {
    globalThis.fetch = realFetch;
  }
});
