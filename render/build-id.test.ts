import { assertEquals } from "jsr:@std/assert";
import { BUILD_ID, workerUrl } from "./build-id.ts";

Deno.test("workerUrl carries the build id", () => {
  const u = workerUrl("./surface-nets-worker.js", "http://x/webgpu/page.html");
  assertEquals(u.pathname, "/webgpu/surface-nets-worker.js");
  assertEquals(u.searchParams.get("v"), BUILD_ID);
});

// EVERY RUNTIME CODE LOAD IS VERSIONED, checked by reading the source rather than by remembering.
//
// The page has been cache-busted since long before this: the rebuild script rewrites slicer-app.js
// and theme.css with ?v=<build>, and its own comment says why -- "a reload came up on the previous
// build and only the on-screen stamp caught it." What it could not reach was code loaded FROM
// JavaScript: workers and dynamic imports, which carried no version at all.
//
// That gap is worse than an unversioned page, because the on-screen build stamp comes from the page.
// A stale worker reports as the new build. Ron, on a rebuild that doubled the geometry smoothing and
// quadrupled the normal smoothing: "19:23 version. Nothing changes in a noticable way, once the
// algorithm runs" -- same look, same 118s, from a worker file that had both changes on disk.
//
// Ron: "versioning should be pervasive." A list of call sites fixed by hand is not pervasive; it is
// pervasive until the next one is written. This fails the moment one is.
Deno.test("no runtime code load skips the build id", async () => {
  const offenders: string[] = [];
  const roots = ["render", "logic", "examples"];
  const here = new URL(".", import.meta.url).pathname.replace(/\/render\/$/, "");
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try { entries = [...Deno.readDirSync(dir)]; } catch { return; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { if (e.name !== "node_modules" && e.name !== "vendor") await walk(p); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || e.name === "build-id.ts") continue;
      const src = await Deno.readTextFile(p);
      src.split("\n").forEach((line, i) => {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
        const at = `${p.slice(here.length + 1)}:${i + 1}`;
        // A worker built from anything but workerUrl(), and any URL constructed for a .js file.
        if (/new Worker\(/.test(line) && !/workerUrl/.test(line) && !/opts\.|\?\?/.test(line)) {
          offenders.push(`${at}  new Worker without workerUrl()`);
        }
        if (/new URL\(\s*["'][^"']*\.js["']/.test(line)) {
          offenders.push(`${at}  new URL(...js) — use workerUrl()`);
        }
      });
    }
  };
  for (const root of roots) await walk(`${here}/${root}`);
  assertEquals(offenders, [], `unversioned runtime code loads:\n  ${offenders.join("\n  ")}`);
});
