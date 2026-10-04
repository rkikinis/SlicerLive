// The model store (model-store.ts): a missing file is fetched once and kept, checked against its pinned sha256; a file
// that is not the pinned one is refused and removed; the routes serve what is kept and the one-part weights manifest.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { encodeHex } from "jsr:@std/encoding@1/hex";

const dir = Deno.makeTempDirSync({ prefix: "albula-models-" });
Deno.env.set("ALBULA_MODELS_DIR", `${dir}/models`);
const { MODELS, ensureModel, handleModelRequest, modelReady } = await import("./model-store.ts");

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
async function withFakeModel(fn: (files: Record<string, Uint8Array>) => Promise<void>) {
  const files: Record<string, Uint8Array> = { "a.json": new TextEncoder().encode('{"x":1}'), "b.bin": bytes(5000, 7) };
  MODELS.fake = {};
  for (const [name, data] of Object.entries(files)) MODELS.fake[name] = { url: `https://example.invalid/${name}`, bytes: data.length, sha256: encodeHex(await crypto.subtle.digest("SHA-256", data)) };
  try { await fn(files); } finally { delete MODELS.fake; }
}
const fakeFetch = (files: Record<string, Uint8Array>, count: { n: number }) => ((url: string) => {
  count.n++;
  const name = String(url).split("/").pop()!;
  return Promise.resolve(new Response(files[name], { headers: { "content-length": String(files[name].length) } }));
}) as unknown as typeof fetch;

Deno.test("nnLive's four files are pinned: address, size and sha256", () => {
  assertEquals(Object.keys(MODELS.nnlive).sort(), ["perclick_192.graph.json", "perclick_192.weights.bin", "trunk8_192.graph.json", "trunk8_192.weights.bin"]);
  for (const f of Object.values(MODELS.nnlive)) { assert(f.url.startsWith("https://")); assert(f.bytes > 0); assertEquals(f.sha256.length, 64); }
});

Deno.test("a missing model is fetched once and kept; the files are served from disk", async () => {
  await withFakeModel(async (files) => {
    const count = { n: 0 };
    assert(!modelReady("fake"));
    await ensureModel("fake", fakeFetch(files, count));
    assertEquals(count.n, 2);
    assert(modelReady("fake"));
    await ensureModel("fake", fakeFetch(files, count));
    assertEquals(count.n, 2, "nothing fetched the second time");
    const r = await handleModelRequest(new Request("http://127.0.0.1/_models/fake/b.bin"));
    assertEquals(new Uint8Array(await r!.arrayBuffer()), files["b.bin"]);
    const h = await handleModelRequest(new Request("http://127.0.0.1/_models/fake/b.bin", { method: "HEAD" }));
    assertEquals(h!.headers.get("content-length"), "5000");
    const e = await handleModelRequest(new Request("http://127.0.0.1/_models/fake/_ensure"));
    assertEquals(JSON.parse((await e!.text()).trim()), { ok: true, kept: true });
  });
});

Deno.test("a file that is not the pinned one is refused and not kept", async () => {
  await withFakeModel(async (files) => {
    const wrong = { ...files, "b.bin": bytes(5000, 8) };
    await Deno.remove(`${dir}/models/fake`, { recursive: true }).catch(() => {});
    await assertRejects(() => ensureModel("fake", fakeFetch(wrong, { n: 0 })), Error, "not the pinned file");
    assert(!modelReady("fake"));
    const r = await handleModelRequest(new Request("http://127.0.0.1/_models/fake/b.bin"));
    assertEquals(r!.status, 404);
  });
});

Deno.test("the weights manifest names the one part; unknown models and files are 404; other paths pass by", async () => {
  const m = await handleModelRequest(new Request("http://127.0.0.1/_models/nnlive/perclick_192.parts.json"));
  assertEquals(await m!.json(), { bytes: MODELS.nnlive["perclick_192.weights.bin"].bytes, parts: ["perclick_192.weights.bin"] });
  assertEquals((await handleModelRequest(new Request("http://127.0.0.1/_models/nope/x.bin")))!.status, 404);
  assertEquals((await handleModelRequest(new Request("http://127.0.0.1/_models/nnlive/evil.bin")))!.status, 404);
  assertEquals(await handleModelRequest(new Request("http://127.0.0.1/_models/nnlive/../x")), undefined);
  assertEquals(await handleModelRequest(new Request("http://127.0.0.1/_db")), undefined);
});
