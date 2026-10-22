// THE IMPORT-TIME JOBS' MARKER FILE (job-marker.ts): a failure is remembered per scan and version of the job, and what
// the server writes after a run keeps it.
//   deno test -A --no-check desktop/job-marker.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { failedBefore, readMarker, rememberFailure, updateMarker } from "./job-marker.ts";

Deno.test("a scan that failed is remembered under the job's version, and kept when the run's marker is written", async () => {
  const dir = await Deno.makeTempDir({ prefix: "albula-marker-" });
  try {
    assertEquals(await failedBefore(dir, "core-brain", "1.2.3", "brain-structures v2"), undefined);
    await rememberFailure(dir, "core-brain", "1.2.3", "brain-structures v2");
    // Not tried again under the same rules; tried again under new ones; another scan is not touched.
    assertEquals(typeof await failedBefore(dir, "core-brain", "1.2.3", "brain-structures v2"), "string");
    assertEquals(await failedBefore(dir, "core-brain", "1.2.3", "brain-structures v3"), undefined);
    assertEquals(await failedBefore(dir, "core-brain", "1.2.4", "brain-structures v2"), undefined);
    // The server's record of the finished run (extension-jobs.ts remember) keeps the failures, and another job's entry.
    await updateMarker(dir, "diffusion", (e) => ({ ...e, mr: "aa", pinned: "abc" }));
    await updateMarker(dir, "core-brain", (e) => ({ ...e, mr: "bb", pinned: "brain-structures v2" }));
    const m = await readMarker(dir);
    assertEquals(Object.keys(m["core-brain"].failed ?? {}), ["1.2.3"]);
    assertEquals([m["core-brain"].mr, m.diffusion.mr], ["bb", "aa"]);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
