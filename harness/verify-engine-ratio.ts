// THE GUARD ON GREASED LIGHTNING: is the shipping JS engine still close to V8 on the hot phases?
//
// The webview runs JavaScriptCore; `deno` and the app's server process run V8. On the surface-nets
// extraction loop JSC was 6.9x slower than V8, and that one ratio was the whole of the application's
// 118 s. The fix -- flat corner/edge tables, no closures or iterators in the inner loop -- is
// INVISIBLE in V8, which optimises the readable version just as well, so no ordinary test or bench
// can catch a regression that costs the shipping engine a factor of seven.
//
// `algorithms/surface-nets.engine-bench.ts` is the measurement. Until now nothing ran it:
// CLAUDE.md called it "one standing requirement" and enforcement was a sentence in a document.
// This is the sentence turned into an exit code, wired into test/run.ts's SCRIPTS table.
//
//   deno run -A harness/verify-engine-ratio.ts
//
// THE THRESHOLD IS MEASURED, NOT GUESSED (SlicerAlbula docs/WORKING-STATE.md, the loose-ends audit
// of 2026-09-10). Three runs on Ron's Mac with the fix in place:
//
//     phases 1-2   JSC 0.32-0.37 s   V8 0.25-0.26 s   ratio 1.28x / 1.32x / 1.42x
//     phases 3-4   JSC 0.70 s        V8 0.93 s        0.75x  (JSC faster)
//     total        JSC 1.03 s        V8 1.18 s        0.87x  (JSC faster)
//
// Gate at 3x ON PHASES 1-2 ONLY: better than 2x headroom over the worst sample, and it still catches
// anything heading back toward 7x. Deliberately NOT on the total -- JSC is AHEAD there, so a
// total-based threshold measures the wrong thing and drifts with the phase mix.
//
// SKIPS, RATHER THAN FAILS, WITHOUT jsc. CI runs on Linux where there is no JavaScriptCore, and a
// guard that fails for being on the wrong machine gets disabled. The gate is real where the shipping
// engine is real: Ron's Mac.
const JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc";
const MAX_RATIO = 3.0;
const HERE = new URL(".", import.meta.url).pathname;          // path-relative, like everything here
const BENCH = `${HERE}../algorithms/surface-nets.engine-bench.ts`;

async function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).spawn();
  const r = await p.output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

/** "  phases 1-2 0.32s   phases 3-4 0.70s   TOTAL 1.03s" -> 0.32 */
function phase12(out: string): number | null {
  const m = out.match(/phases 1-2\s+([\d.]+)s/);
  return m ? Number(m[1]) : null;
}

if (!(await Deno.stat(JSC).then(() => true).catch(() => false))) {
  console.log(`SKIP: no jsc at ${JSC} (not a Mac, or JavaScriptCore is not installed).`);
  console.log("      The engine gate only means something where the app's engine lives.");
  Deno.exit(0);
}

const tmp = await Deno.makeTempDir();
const bundle = `${tmp}/eb.js`;
const bundled = await run("deno", ["run", "-A", "npm:esbuild", BENCH, "--bundle", "--format=iife", "--target=es2020", `--outfile=${bundle}`]);
if (bundled.code !== 0) {
  console.log(`XX could not bundle the engine bench:\n${bundled.out}`);
  Deno.exit(1);
}
// The same bundle runs under both: the bench aliases `print` (jsc's console) to console.log when
// `print` is absent, so V8 needs no shim beyond being handed the file.
const jsc = await run(JSC, [bundle]);
const v8 = await run("deno", ["run", "-A", bundle]);
const tJ = phase12(jsc.out), tV = phase12(v8.out);
if (jsc.code !== 0 || v8.code !== 0 || tJ === null || tV === null) {
  console.log(`XX the bench did not report a phases 1-2 time in both engines.\n--- jsc ---\n${jsc.out}\n--- v8 ---\n${v8.out}`);
  Deno.exit(1);
}
const ratio = tJ / tV;
console.log(`  phases 1-2   jsc ${tJ.toFixed(2)}s   v8 ${tV.toFixed(2)}s   ratio ${ratio.toFixed(2)}x   (gate ${MAX_RATIO.toFixed(1)}x)`);
await Deno.remove(tmp, { recursive: true });
if (ratio > MAX_RATIO) {
  console.log(`XX MISMATCH: JavaScriptCore is ${ratio.toFixed(2)}x V8 on phases 1-2, over the ${MAX_RATIO.toFixed(1)}x gate.`);
  console.log("   Something in the surface-nets inner loop has stopped being JSC-friendly -- a closure");
  console.log("   called per element, an array-of-arrays index, a for-of over pairs, a per-iteration");
  console.log("   array literal. V8 forgives all four; the engine that ships does not. Before the fix");
  console.log("   this ratio was 6.9x and the application took 118 s.");
  Deno.exit(1);
}
console.log("  OK  the shipping engine is still close to V8 where it has to be.");
