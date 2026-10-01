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

// THE PAGE AND THE CONVERTER READ DICOM WITH THE SAME dcmjs (critic, 2026-09-23, finding 2): the page
// loads the vendored copy (render/vendor/dcmjs/dcmjs.js, since 2026-09-28; a CDN before), the converter
// imports it from npm. A copy is only the page's own reading if the two are one version -- so the
// vendored file must be byte for byte the build/dcmjs.js of the npm package the converter imports, and
// that package's version must be DCMJS_VERSION.
Deno.test("the page's vendored dcmjs is the converter's npm dcmjs, byte for byte, at DCMJS_VERSION", async () => {
  const { DCMJS_VERSION } = await import("../logic/dcmjs-version.ts");
  const converter = /npm:dcmjs@([0-9.]+)/.exec(await Deno.readTextFile(new URL("../logic/dcmjs.ts", import.meta.url)))?.[1];
  assertEquals(converter, DCMJS_VERSION);
  await import("../logic/dcmjs.ts");                       // the package is in Deno's cache once imported
  const info = await new Deno.Command(Deno.execPath(), { args: ["info", "--json"], stdout: "piped" }).output();
  const npmCache = JSON.parse(new TextDecoder().decode(info.stdout)).npmCache as string;
  const fromNpm = await Deno.readFile(`${npmCache}/registry.npmjs.org/dcmjs/${converter}/build/dcmjs.js`);
  const vendored = await Deno.readFile(new URL("../render/vendor/dcmjs/dcmjs.js", import.meta.url));
  assertEquals(vendored.length, fromNpm.length);
  assertEquals(vendored, fromNpm);
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
