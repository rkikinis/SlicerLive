// TEST DATA BY NAME, NOT BY PATH. Every collection a test reads is listed once in the workspace's
// Contents/data/test-data.json (where it lands, its source, pins, license, how to fetch it, how often it is checked for
// updates). A test asks for a collection by its id; when it is absent the test skips and says what to run to get it.
// Moving a collection is one line in that list, not a sweep through the tests.
//
//   const dir = testData("dcm_qa", "dcm_qa_canon");   // absolute path with a trailing slash, or undefined
//   Deno.test({ name: "...", ignore: !dir, fn: ... });
//
// ALBULA_TEST_DATA overrides the data folder (another checkout, a shared disk). Outside the workspace layout (Steve's
// clone), no list is found and every collection reads as absent, so the tests that need one skip.

export interface Collection {
  path: string; what: string; policy: "frozen" | "watch" | "derived";
  source?: string; license?: string; pins?: string; fetch?: string; subfolders?: string[];
}

/** The data folder: $ALBULA_TEST_DATA, or Contents/data of the workspace this clone sits in. */
export const DATA_ROOT = (() => {
  const env = (() => { try { return Deno.env.get("ALBULA_TEST_DATA"); } catch { return undefined; } })();
  const root = env ?? new URL("../../../data/", import.meta.url).pathname;
  return root.endsWith("/") ? root : root + "/";
})();

let list: Record<string, Collection> | undefined;
/** The list, read once; empty when there is none (not the workspace layout). */
export function collections(): Record<string, Collection> {
  if (!list) {
    try { list = JSON.parse(Deno.readTextFileSync(`${DATA_ROOT}test-data.json`)).collections ?? {}; }
    catch { list = {}; }
  }
  return list!;
}

const told = new Set<string>();
/**
 * The absolute folder of collection `id` (and `sub` inside it), ending in "/", or undefined when it is not on this
 * machine -- said once per collection, with the command that fetches it. An id missing from the list THROWS: that is
 * a mistake in the test, not absent data.
 */
export function testData(id: string, sub = ""): string | undefined {
  const all = collections();
  if (!Object.keys(all).length) return undefined;
  const c = all[id];
  if (!c) throw new Error(`test data "${id}" is not in ${DATA_ROOT}test-data.json -- add it there first`);
  const dir = `${DATA_ROOT}${c.path}/${sub ? sub.replace(/^\/+|\/+$/g, "") + "/" : ""}`;
  try { if (Deno.statSync(dir).isDirectory) return dir; } catch { /* absent */ }
  if (!told.has(id)) { told.add(id); console.log(`  (test data "${id}" is not here; fetch it with: ${c.fetch ?? "see test-data.json"})`); }
  return undefined;
}

/** A path that never exists: `testData(...) ?? ABSENT` keeps a test's own "is it there?" check working unchanged. */
export const ABSENT = "/nonexistent-albula-test-data/";
