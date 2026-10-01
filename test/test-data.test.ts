// The test-data list (Contents/data/test-data.json) and the tests agree: every collection a test asks for by name is in
// the list, every collection says how to get it and how often it is checked, and no test names a data path directly.
import { assert } from "jsr:@std/assert@1";
import { collections, DATA_ROOT } from "./test-data.ts";

const tests = (() => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of Deno.readDirSync(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) { if (!["node_modules", ".git", "vendor"].includes(e.name)) walk(p); }
      else if (e.name.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(new URL("..", import.meta.url).pathname.replace(/\/$/, ""));
  return out;
})();
const have = Object.keys(collections()).length > 0;

Deno.test({ name: "test data: every collection a test asks for is in the list", ignore: !have, fn: () => {
  const all = collections(), missing: string[] = [];
  for (const f of tests) for (const m of Deno.readTextFileSync(f).matchAll(/testData\("([^"]+)"/g)) if (!all[m[1]]) missing.push(`${f.split("/").slice(-2).join("/")}: ${m[1]}`);
  assert(!missing.length, `not in ${DATA_ROOT}test-data.json: ${missing.join("; ")}`);
} });

Deno.test({ name: "test data: every collection has a policy, and a way to get it", ignore: !have, fn: () => {
  for (const [id, c] of Object.entries(collections())) {
    assert(["frozen", "watch", "derived"].includes(c.policy), `${id}: policy "${c.policy}"`);
    assert(c.fetch || c.policy === "derived", `${id}: no fetch command`);
    if (c.policy !== "derived") assert(c.source && c.license && c.pins, `${id}: source, license and pins are required`);
  }
} });

Deno.test("test data: no test names a data folder by path (ask test-data.ts by name)", () => {
  const offenders = tests.filter((f) => Deno.readTextFileSync(f).split("\n").some((l) => !l.trim().startsWith("//") && /\.\.\/data\/(dicom|openneuro|dwi-vendors)/.test(l)));
  assert(!offenders.length, offenders.join(", "));
});
