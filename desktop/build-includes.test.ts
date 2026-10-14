// EVERY WORKER FILE THE SERVER STARTS IS IN THE COMPILED APP (critic 2026-10-13, SQLite round 3, finding 5): `deno
// compile` bundles what is imported, not what is named in `new Worker(new URL("./x.ts", import.meta.url))`, so each such
// file must be `--include`d by the builders. Without it a build answers every database query with "Cannot find module".
import { assert } from "jsr:@std/assert@1";

const here = new URL(".", import.meta.url);
const read = (f: string) => Deno.readTextFileSync(new URL(f, here));

Deno.test("both builders --include every worker file the server's code starts", () => {
  const workers = new Set<string>();
  for (const e of Deno.readDirSync(here)) {
    if (!e.isFile || !e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || e.name.startsWith("make-")) continue;
    for (const m of read(e.name).matchAll(/new (?:Worker|NodeWorker)\(\s*new URL\("\.\/([\w-]+\.ts)", import\.meta\.url\)/g)) workers.add(m[1]);
  }
  assert(workers.has("sqlite-worker.ts") && workers.has("server-worker.ts"), `found: ${[...workers].join(", ")}`);
  for (const builder of ["make-app.ts", "make-win.ts"]) {
    const text = read(builder);
    for (const w of workers) assert(text.includes(`join(here, "${w}")`), `${builder} does not --include ${w}`);
  }
});
