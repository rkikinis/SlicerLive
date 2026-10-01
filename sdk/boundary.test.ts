// CORE NEVER IMPORTS AN EXTENSION (Contents/docs/EXTENSIONS.md in the workspace). Extensions live outside this
// repository (the workspace's Contents/extensions/<name>/, each its own repository) and reach core only through the
// SDK (sdk/albula.ts); core must build and run with none of them. So no file here imports a path that leaves this
// repository, or an extensions folder. (Reading the workspace's list of extensions as DATA, by path at run time --
// desktop/extension-hooks.ts -- is allowed: that is how programs outside the page find the extensions' hooks.)
//   deno test -A --no-check sdk/boundary.test.ts
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("no core file imports an extension or anything outside this repository", () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries: Deno.DirEntry[];
    try { entries = [...Deno.readDirSync(dir)]; } catch { return; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { if (!["node_modules", "vendor", ".git", "scratchpad", "LiveStory"].includes(e.name)) walk(p); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name)) continue;
      const depth = p.slice(root.length + 1).split("/").length - 1;
      Deno.readTextFileSync(p).split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/g)) {
          const spec = m[1];
          const ups = spec.match(/^(\.\.\/)+/)?.[0].length ?? 0;
          if (/(^|\/)extensions\//.test(spec) || ups / 3 > depth) offenders.push(`${p.slice(root.length + 1)}:${i + 1} ${spec}`);
        }
      });
    }
  };
  walk(root);
  assertEquals(offenders, [], "core files reaching an extension or outside the repository");
});
