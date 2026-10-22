// FASTSURFER'S RELEASE IN THE SEG COMES FROM HAVERSACK'S OWN IDENTITY (critic 2026-10-20, finding 7): the job's
// `fastsurfer_version` said "unknown" on every result of that night; the task's record says 2.5.4.
//
//   deno test -A --no-check logic/haversack-run.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { runHaversackTask } from "./haversack-run.ts";
import { runProvenanceOf } from "./ai-result.ts";
import type { HaversackJob, HaversackTransport } from "./haversack.ts";

/** A server that knows one task, runs one job at once and answers it: haversack 0.15.0's FastSurfer, as its routes read. */
function fakeServer(identity: unknown): HaversackTransport {
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  return {
    base: "/_haversack/",
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("tasks/fastsurfer%3Aasegdkt")) return Promise.resolve(json({ name: "asegdkt", ecosystem: "fastsurfer", engine: "fastsurfer", ...(identity ? { weights_installed: identity } : {}) }));
      if (url.endsWith("/_haversack/jobs")) return Promise.resolve(json({ id: "j1" }));
      if (url.endsWith("jobs/j1")) return Promise.resolve(json({ state: "succeeded", result: { provenance: { engine: "fastsurfer", fastsurfer_version: "unknown", network: "FastSurferVINN (2.5D view aggregation)", device: "mps" } } }));
      if (url.endsWith("jobs/j1/result")) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      return Promise.resolve(json({}, 404));
    },
  };
}
const run = (identity: unknown) => runHaversackTask({ task: "fastsurfer:asegdkt", what: "finding the brain's structures", transport: fakeServer(identity), pollMs: 1,
  upload: () => Promise.resolve({ bytes: new Uint8Array(4), filename: "t1.nrrd" }) });

Deno.test("the run hands back the task's weights as the server describes them", async () => {
  const r = await run([{ id: "fastsurfer", version: "2.5.4" }]);
  assertEquals(r.ok && r.weights, [{ id: "fastsurfer", version: "2.5.4" }]);
  const none = await run(undefined);
  assertEquals(none.ok && none.weights, undefined);
});

Deno.test("FastSurfer's release: haversack's identity when the job says 'unknown'; no version rather than 'unknown'", async () => {
  const r = await run([{ id: "fastsurfer", version: "2.5.4" }]);
  if (!r.ok) throw new Error(r.message);
  const pv = runProvenanceOf("fastsurfer:asegdkt", r.job, r.job.id, { haversack: "0.15.0", weights: r.weights })!;
  assertEquals(pv.models, [{ folder: "FastSurferVINN", version: "2.5.4" }]);
  // No identity at all: the model is named without a version, never as "unknown".
  const bare = runProvenanceOf("fastsurfer:asegdkt", r.job, r.job.id, { haversack: "0.15.0" })!;
  assertEquals(bare.models, [{ folder: "FastSurferVINN", version: undefined }]);
  // The job's own answer, when it is one, wins.
  const told = { ...r.job, provenance: { ...r.job.provenance, fastsurfer_version: "2.6.0" } } as HaversackJob;
  assertEquals(runProvenanceOf("fastsurfer:asegdkt", told, "j1", { weights: r.weights })!.models?.[0].version, "2.6.0");
});
