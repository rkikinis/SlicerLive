// The duckn copy's code must be the fingerprint of the sources as they are now, or copies made by
// changed code would still pass as current (critic, 2026-09-23, finding 4).
//
//   deno test -A --no-check desktop/duckn-copy-code.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { computeCopyCode } from "./make-copy-code.ts";
import { COPY_SOURCE_CODE } from "./duckn-copy-code.generated.ts";

Deno.test("the duckn copy code matches the sources (run: deno run -A desktop/make-copy-code.ts; the rebuild does)", async () => {
  assertEquals(COPY_SOURCE_CODE, await computeCopyCode());
});

// THE PAGE AND THE CONVERTER READ DICOM WITH THE SAME dcmjs (critic, 2026-09-23, finding 2): a copy is only the page's
// own reading if the two are one version. Since 2026-10-28 both are Steve Pieper's build of one dcmjs commit, vendored in
// render/vendor/dcmjs/: the page and the workers load the UMD build (dcmjsUrl), the converter and the tests import the
// ESM build (logic/dcmjs.ts). So: both files are the ones pinned in logic/dcmjs-version.ts, logic/dcmjs.ts imports the
// vendored ESM file, and no source reaches dcmjs through npm or a CDN.
Deno.test("the page's and the converter's dcmjs are the pinned builds of one commit, and nothing loads another", async () => {
  const { DCMJS_SHA256 } = await import("../logic/dcmjs-version.ts");
  for (const [file, want] of Object.entries(DCMJS_SHA256)) {
    const bytes = await Deno.readFile(new URL(`../render/vendor/dcmjs/${file}`, import.meta.url));
    const got = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    assertEquals(got, want, `render/vendor/dcmjs/${file}`);
  }
  const loader = await Deno.readTextFile(new URL("../logic/dcmjs.ts", import.meta.url));
  assertEquals(/from "\.\.\/render\/vendor\/dcmjs\/dcmjs\.es\.js"/.test(loader), true, "logic/dcmjs.ts imports the vendored ESM build");
  // Every TypeScript source of the app (not the vendored folders, whose gallery worker idc-worker.js is not Albula's path).
  const offenders: string[] = [];
  const root = new URL("../", import.meta.url).pathname;
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { if (![".git", "node_modules", "vendor", "live"].includes(e.name)) await walk(p); continue; }
      if (!/\.ts$/.test(e.name) || p.endsWith("duckn-copy-code.test.ts")) continue;
      const text = await Deno.readTextFile(p);
      if (/npm:dcmjs|https?:\/\/[^"'`\s]*(jsdelivr|unpkg)[^"'`\s]*dcmjs/.test(text)) offenders.push(p.slice(root.length));
    }
  };
  await walk(root.replace(/\/$/, ""));
  assertEquals(offenders, [], "sources that load dcmjs from npm or a CDN");
});

// A COMMENT IS NOT CODE (critic, 2026-09-24 evening, finding 1): a spelling sweep over comments moved the fingerprint
// and retired all 116 working copies. Two sources that differ only in comments and layout must print the same.
Deno.test("the copy fingerprint ignores comments and layout, and keeps strings", async () => {
  const { codeOf } = await import("./make-copy-code.ts");
  const dir = await Deno.makeTempDir();
  const a = `${dir}/a.ts`, b = `${dir}/b.ts`, c = `${dir}/c.ts`;
  await Deno.writeTextFile(a, "// the colour of it\nexport const x = 1; /* centre */\nexport const s = `// wgsl colour`;\n");
  await Deno.writeTextFile(b, "// the color of it\nexport const x  =  1;   /* center */\n\nexport const s = `// wgsl colour`;\n");
  await Deno.writeTextFile(c, "// the colour of it\nexport const x = 1; /* centre */\nexport const s = `// wgsl color`;\n");
  const [ha, hb, hc] = await Promise.all([a, b, c].map(async (f) => new TextDecoder().decode(await codeOf(f))));
  assertEquals(ha, hb, "comments and layout differ, the code does not");
  assertEquals(ha === hc, false, "a string that changes is code");
  const { stop } = await import("npm:esbuild"); await stop();
});
