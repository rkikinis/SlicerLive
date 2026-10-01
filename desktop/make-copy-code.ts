// THE CODE THAT WRITES A DUCKN COPY, as a fingerprint of everything that could change what it writes.
//
// A copy is the reader's output frozen on disk. Until 2026-09-23 the code that marked a copy as
// current was kept by hand ("albula-duckn-1"), so a fix to the reader, a codec or dcmjs would have
// left every old copy looking valid -- and the reader changed five times in the twelve days before
// (critic, 2026-09-23, finding 4). Now the rebuild computes it from the converter's whole import
// graph as Deno reports it -- the modules it RUNS: every import followed except type-only ones, which
// vanish at run time -- plus the codecs it loads at run time from render/vendor/codecs/ and the
// versions of the npm packages it uses. Automatic, on purpose: a hand-picked list is how the old code
// went stale. Type-only imports are left out because the whole graph reached the 3D code through the
// ingest's `import type { LiveScene }`: a fix to colorizing (2026-09-23 13:39) retired all 107 copies.
//
//   deno run -A desktop/make-copy-code.ts          # writes desktop/duckn-copy-code.generated.ts
//
// `desktop/duckn-copy-code.test.ts` fails when the generated file no longer matches the sources.
import { dirname, fromFileUrl, join, relative } from "jsr:@std/path@1";
import * as esbuild from "npm:esbuild";

/**
 * THE CODE, NOT ITS COMMENTS. A TypeScript or JavaScript source is hashed as esbuild prints it with the comments and
 * the layout taken out, so what is hashed is what runs. It was the raw text: on 2026-09-24 a spelling sweep changed
 * comments in 19 of these files ("color" -> "color"), the fingerprint moved (dd38e1790930 -> 879f8e23a9db), and the
 * page refused all 116 working copies -- every CT read from DICOM again, 1.1-1.6 s instead of 0.48 s -- for a change
 * that altered no line that runs (critic, 2026-09-24 evening, finding 1). esbuild's version is pinned and hashed, so
 * a different printer cannot move the fingerprint unnoticed. Strings are kept as they are, so a WGSL shader inside a
 * template literal is still hashed whole.
 */
export async function codeOf(path: string): Promise<Uint8Array> {
  const raw = await Deno.readFile(path);
  const loader = path.endsWith(".ts") ? "ts" : path.endsWith(".js") || path.endsWith(".mjs") ? "js" : null;
  if (!loader) return raw;
  const r = await esbuild.transform(new TextDecoder().decode(raw), { loader, minifyWhitespace: true, legalComments: "none", target: "esnext" });
  return new TextEncoder().encode(r.code);
}

const HERE = dirname(fromFileUrl(import.meta.url));
const ROOT = dirname(HERE);
const GENERATED = join(HERE, "duckn-copy-code.generated.ts");

export async function computeCopyCode(): Promise<string> {
  // `--no-lock`: WITH deno.lock (2026-09-28), `npmPackages` lists every package in the lock -- esbuild, pngjs -- not only
  // those the converter reaches, and the fingerprint moved (64b1130303aa -> fc68a7a7cc68) with no converter code changed.
  // The import map in deno.jsonc still applies.
  // CORE ONLY. What an extension adds to reading DICOM (a volume interpreter) carries its own fingerprint, made by the
  // extension's build, and a copy records it beside this one (volume-interpreters.ts `code`, duckn-copy.ts): so an edit to
  // an extension retires only what it could change, and this repository's fingerprint does not depend on any extension.
  const roots = [join(HERE, "duckn-copy.ts")];
  const allowed = [ROOT];
  type Mod = { specifier: string; local?: string; dependencies?: { code?: { specifier: string } }[] };
  type Info = { roots: string[]; modules: Mod[]; redirects?: Record<string, string>; npmPackages?: Record<string, unknown> };
  const info: Info = { roots: [], modules: [], redirects: {}, npmPackages: {} };
  for (const root of roots) {
    const out = await new Deno.Command(Deno.execPath(), { args: ["info", "--no-lock", "--json", root], cwd: ROOT, stdout: "piped", stderr: "piped" }).output();
    if (!out.success) throw new Error(`deno info failed: ${new TextDecoder().decode(out.stderr)}`);
    const one = JSON.parse(new TextDecoder().decode(out.stdout)) as Info;
    info.roots.push(...one.roots); info.modules.push(...one.modules);
    Object.assign(info.redirects!, one.redirects ?? {}); Object.assign(info.npmPackages!, one.npmPackages ?? {});
  }
  const bySpec = new Map(info.modules.map((m) => [m.specifier, m]));
  const resolve = (sp: string) => info.redirects?.[sp] ?? sp;
  // From the converter, following only imports that exist at run time.
  const files = new Set<string>();
  const seen = new Set<string>();
  const walk = (sp: string) => {
    sp = resolve(sp);
    if (seen.has(sp)) return;
    seen.add(sp);
    const m = bySpec.get(sp);
    if (!m) return;
    // A MODULE THE HASH CANNOT SEE STOPS THE GENERATOR (critic, 2026-09-23, finding 9): a `jsr:` or
    // `https:` import lives in Deno's cache, outside this tree, and a version range can resolve to new
    // code without any hashed text changing. Local files, npm packages (their versions are hashed
    // below) and Deno's own `node:` modules are what the fingerprint covers.
    const local = !!m.local && allowed.some((a) => m.local!.startsWith(a + "/"));
    const kind = (m as { kind?: string }).kind;
    if (!local && kind !== "npm" && kind !== "node") {
      throw new Error(`the converter imports ${sp}, which the copy fingerprint cannot cover -- vendor it into the tree or extend desktop/make-copy-code.ts`);
    }
    if (local && m.local !== GENERATED) files.add(m.local!);
    for (const d of m.dependencies ?? []) if (d.code?.specifier) walk(d.code.specifier);
  };
  for (const r of info.roots) walk(r);
  const vendor = join(ROOT, "render/vendor/codecs");
  for (const e of Deno.readDirSync(vendor)) if (/\.(js|wasm)$/.test(e.name)) files.add(join(vendor, e.name));
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const f of [...files].sort()) {
    parts.push(enc.encode(`\n--- ${relative(ROOT, f)}\n`));
    parts.push(await codeOf(f));
  }
  parts.push(enc.encode(`\n--- npm\n${Object.keys(info.npmPackages ?? {}).sort().join("\n")}\n`));
  parts.push(enc.encode(`\n--- printed by esbuild ${esbuild.version}\n`));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * AN EXTENSION'S INTERPRETER FINGERPRINT: its entry file and every file of the extension it imports (paths relative to
 * the extension, so the same code gives the same fingerprint wherever the folder sits), whitespace and comments not
 * counted, as above. Core files it reaches through the SDK are core's fingerprint's business, not this one's.
 * `exclude`: the generated file holding the result (relative path).
 */
export async function interpreterFingerprint(extensionRoot: string, entry: string, exclude: string[] = []): Promise<string> {
  const rootDir = extensionRoot.replace(/\/$/, "");
  const out = await new Deno.Command(Deno.execPath(), { args: ["info", "--no-lock", "--json", join(rootDir, entry)], cwd: ROOT, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`deno info failed: ${new TextDecoder().decode(out.stderr)}`);
  const info = JSON.parse(new TextDecoder().decode(out.stdout)) as { modules: { local?: string }[] };
  const files = info.modules.map((m) => m.local).filter((f): f is string => !!f && f.startsWith(rootDir + "/"))
    .map((f) => relative(rootDir, f)).filter((f) => !exclude.includes(f)).sort();
  const enc = new TextEncoder(), parts: Uint8Array[] = [];
  for (const f of files) { parts.push(enc.encode(`\n--- ${f}\n`)); parts.push(await codeOf(join(rootDir, f))); }
  parts.push(enc.encode(`\n--- printed by esbuild ${esbuild.version}\n`));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (import.meta.main) {
  const code = await computeCopyCode();
  await esbuild.stop();
  const text = `// GENERATED by desktop/make-copy-code.ts (the rebuild runs it) -- do not edit.\n` +
    `// A fingerprint of everything that could change what desktop/duckn-copy.ts writes.\n` +
    `export const COPY_SOURCE_CODE = "${code}";\n`;
  const before = await Deno.readTextFile(GENERATED).catch(() => "");
  if (before !== text) await Deno.writeTextFile(GENERATED, text);
  console.log(`duckn copy code ${code}${before === text ? " (unchanged)" : " (written)"}`);
}
