// The brain on an MRI of the anatomy (brain-mask.ts): the round trip to the haversack server, with a stand-in server --
// the task is asked for first, the job polled to the end, the mask read from the .seg.nrrd it returns on the volume's
// own grid, and the second ask answered without the server. A server without the task is said in words.
//   deno test -A --no-check logic/brain-mask.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { synthstripBrainMask } from "./brain-mask.ts";
import { writeNrrd } from "./writers/nrrd.ts";
import type { LiveScene } from "../render/livescene.ts";

const nodes = new Map<string, Record<string, unknown>>([["t1-node", { dims: [4, 3, 2], ijkToRAS: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], zarr: { ref: "a" } }]]);
const live = { nodes } as unknown as LiveScene;
const upload = () => Promise.resolve({ bytes: new Uint8Array(8), filename: "t1.nrrd" });

Deno.test("SynthStrip's mask comes back on the volume's grid, and a second ask is answered without the server", async () => {
  const dims: [number, number, number] = [4, 3, 2], ijkToRAS = [-1, 0, 0, 10, 0, 1, 0, -5, 0, 0, 2, 3, 0, 0, 0, 1];
  const labels = new Uint8Array(24); labels[5] = labels[17] = 1;
  const seg = await writeNrrd({ dims, ijkToRAS, data: labels, dtype: "|u1", name: "mask" }, { encoding: "gzip", segmentation: { segments: [{ labelValue: 1, name: "brain", color: [1, 1, 1] }] } });
  const asked: string[] = [];
  let polls = 0;
  const fakeFetch = (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); asked.push(`${init?.method ?? "GET"} ${u}`);
    const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200 }));
    if (u.endsWith("tasks/synthstrip%3Amask")) return json({ task: "synthstrip:mask" });
    if (u.endsWith("/jobs") && init?.method === "POST") return json({ id: "j1" });
    if (u.endsWith("jobs/j1")) return json(++polls < 2 ? { state: "running", progress: { fraction: 0.5, stage: "predict" } } : { state: "succeeded" });
    if (u.endsWith("jobs/j1/result")) return Promise.resolve(new Response(seg as unknown as BodyInit, { status: 200 }));
    return Promise.resolve(new Response("", { status: 404 }));
  };
  const lines: string[] = [];
  const r = await synthstripBrainMask(live, "t1-node", (l) => lines.push(l), { transport: { fetch: fakeFetch as typeof fetch, base: "/_haversack/" }, upload, pollMs: 1 });
  if (!r.ok) throw new Error(r.message);
  assertEquals(r.mask.dims, dims);
  assertEquals(r.mask.ijkToRAS.map((x) => Math.round(x * 1e6) / 1e6), ijkToRAS);
  assertEquals([...r.mask.data].map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [5, 17]);
  assertEquals(asked[0], "GET /_haversack/tasks/synthstrip%3Amask");
  assertEquals(lines.some((l) => l.includes("running 50%")), true);
  const again = await synthstripBrainMask(live, "t1-node", undefined, { transport: { fetch: (() => { throw new Error("asked the server again"); }) as typeof fetch }, upload });
  assertEquals(again.ok && again.cached, true);
  // Hardened: the same node id, another geometry -- the kept mask is not served, the server is asked again.
  nodes.get("t1-node")!.ijkToRAS = [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let askedAgain = false;
  await synthstripBrainMask(live, "t1-node", undefined, { transport: { fetch: (() => { askedAgain = true; return Promise.resolve(new Response("", { status: 503 })); }) as typeof fetch }, upload });
  assertEquals(askedAgain, true);
});

Deno.test("a server that is not running, and one that stops answering mid-job, end the wait in plain words", async () => {
  const down = await synthstripBrainMask(live, "x", undefined, { transport: { fetch: (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch }, upload });
  assertEquals(!down.ok && down.reason, "no-server");
  let n = 0;
  const dies = (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("tasks/")) return Promise.resolve(new Response("{}", { status: 200 }));
    if (init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ id: "j2" }), { status: 200 }));
    n++; return Promise.reject(new TypeError("connection refused"));
  };
  const t0 = performance.now();
  const r = await synthstripBrainMask(live, "y", undefined, { transport: { fetch: dies as typeof fetch, base: "/_haversack/" }, upload, pollMs: 5, goneMs: 100 });
  assertEquals(!r.ok && r.reason, "no-server");
  assertEquals(!r.ok && r.message, "the segmentation server stopped answering");
  assertEquals(performance.now() - t0 < 2000 && n > 1, true);
});

Deno.test("a server without SynthStrip is said in words, and nothing is uploaded", async () => {
  let uploaded = false;
  const r = await synthstripBrainMask(live, "other-node", undefined, { transport: { fetch: (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch }, upload: () => { uploaded = true; return upload(); } });
  assertEquals(!r.ok && r.reason, "no-synthstrip");
  assertEquals(!r.ok && r.message.includes("SynthStrip"), true);
  assertEquals(uploaded, false);
});

Deno.test("a job the server never starts, while it runs nothing else, ends the wait as a stuck server (Ron's demo, 2026-10-06)", async () => {
  const server = (running: boolean, ours: () => string) => (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("tasks/")) return Promise.resolve(new Response("{}", { status: 200 }));
    if (init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ id: "j3" }), { status: 200 }));
    if (u.endsWith("/jobs")) return Promise.resolve(new Response(JSON.stringify({ jobs: [{ id: "j3", state: "queued" }, ...(running ? [{ id: "long", state: "running" }] : [])] }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ state: ours() }), { status: 200 }));
  };
  const lines: string[] = [];
  const idle = await synthstripBrainMask(live, "z", (l) => lines.push(l), { transport: { fetch: server(false, () => "queued") as typeof fetch, base: "/_haversack/" }, upload, pollMs: 5, queuedStuckMs: 100 });
  assertEquals(!idle.ok && idle.reason, "stuck");
  assertEquals(lines.includes("waiting for the segmentation server: it is busy with another job"), true);
  // Another job running (a long FastSurfer): not stuck, the wait goes on -- here until our job ends on its own.
  const t0 = performance.now();
  const busy = await synthstripBrainMask(live, "w", undefined, { transport: { fetch: server(true, () => (performance.now() - t0 > 400 ? "failed" : "queued")) as typeof fetch, base: "/_haversack/" }, upload, pollMs: 5, queuedStuckMs: 100 });
  assertEquals(!busy.ok && busy.reason, "failed");
});
