// TRAINED MODELS THE PAGE RUNS ITSELF, FETCHED ONCE AND KEPT (Ron, 2026-10-03: nnLive as a Segment Editor tool, "yes,
// and follow the totalsegementator template"; the download approved the same day).
//
// The page runs nnLive (Steve Pieper's github.com/pieper/nnLive, a distilled nnInteractive) on the graphics card. Its
// files are not in the app: the decode weights are 188 MB on a public bucket and carry the model's own license (CC BY-NC-SA
// 4.0, logic/model-license.ts). So the first use fetches them, here, into the per-user store, and every later use reads
// them from disk -- no second download, and no copy in the web view's own cache.
//
// PINNED. Each file has the address it comes from and its sha256 as measured on 2026-10-03; a file that does not match is
// refused and removed, so a model changed upstream is a decision (a new line here), not a surprise. One place: an update
// is these lines and the test suite.
//
// Routes:
//   GET /_models/<model>/_ensure        fetch what is missing; NDJSON lines {file, loaded, total} then {ok} or {error}
//   GET|HEAD /_models/<model>/<file>    a kept file (404 until fetched)
//   GET /_models/nnlive/perclick_192.parts.json   the weights as a one-part manifest: nnLive's worker then reads them
//                                       without putting a second 188 MB copy into the web view's Cache Storage
import { join } from "jsr:@std/path@1";
import { encodeHex } from "jsr:@std/encoding@1/hex";
import { crypto as stdCrypto } from "jsr:@std/crypto@1";

/** Where models are kept: the per-user store, ~/.config/slicerlive/models. NOT under SLICERLIVE_CONFIG_DIR: a test
 *  server gets its own settings folder (Contents/tools/headless-server.ts), and a model is a copy of public files, not a
 *  setting -- under it, every test server would fetch the 188 MB again. Tests set ALBULA_MODELS_DIR. */
export const modelsDir = () => Deno.env.get("ALBULA_MODELS_DIR") ?? `${Deno.env.get("HOME")}/.config/slicerlive/models`;

export interface ModelFile { url: string; bytes: number; sha256: string }
const NNLIVE_PAGES = "https://pieper.github.io/nnLive/models/pathA/faithful";
export const MODELS: Record<string, Record<string, ModelFile>> = {
  nnlive: {
    "trunk8_192.graph.json": { url: `${NNLIVE_PAGES}/trunk8_192.graph.json`, bytes: 15491, sha256: "f74287c1c1d9c53dd1c9e498166998abb49b1b5c6f2e5abf09d047f0814ccd10" },
    "trunk8_192.weights.bin": { url: `${NNLIVE_PAGES}/trunk8_192.weights.bin`, bytes: 1348160, sha256: "e5bc46528b31af9106a16e92a70883d2093464ae551320fc1a4d3d3b74a770c2" },
    "perclick_192.graph.json": { url: `${NNLIVE_PAGES}/perclick_192.graph.json`, bytes: 98460, sha256: "8ac043d8d56540252234cd3484624e58bf4c9d6a61b477ed515597aa0e3a46fe" },
    "perclick_192.weights.bin": { url: "https://js2.jetstream-cloud.org:8001/swift/v1/nnlive-models/perclick_192.weights.bin", bytes: 188475492, sha256: "72f6b243c801dbc271230911f9b623504261065ce08f793c736da8207e2caeb2" },
  },
};

const sha256File = async (path: string) => {
  const f = await Deno.open(path);
  try { return encodeHex(await stdCrypto.subtle.digest("SHA-256", f.readable)); }   // the standard library's digest reads a stream
  catch { try { f.close(); } catch { /* closed */ } return ""; }
};
/** Whether a kept file is there and whole (its size; the checksum is checked once, when it is fetched). */
const kept = (model: string, file: string) => {
  try { return Deno.statSync(join(modelsDir(), model, file)).size === MODELS[model][file].bytes; } catch { return false; }
};
export const modelReady = (model: string) => !!MODELS[model] && Object.keys(MODELS[model]).every((f) => kept(model, f));

/** One fetch at a time per model, shared by every page that asks. */
const running = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<(line: Record<string, unknown>) => void>>();
const say = (model: string, line: Record<string, unknown>) => { for (const l of listeners.get(model) ?? []) l(line); };

/** Fetch every missing file of `model`, checked against its pinned checksum. `fetcher` is for tests. */
export async function ensureModel(model: string, fetcher: typeof fetch = fetch): Promise<void> {
  const spec = MODELS[model]; if (!spec) throw new Error(`no model "${model}"`);
  const dir = join(modelsDir(), model);
  await Deno.mkdir(dir, { recursive: true });
  for (const [file, f] of Object.entries(spec)) {
    if (kept(model, file)) continue;
    const part = join(dir, `${file}.part`), final = join(dir, file);
    const resp = await fetcher(f.url);
    if (!resp.ok || !resp.body) throw new Error(`${file}: the server answered ${resp.status}`);
    const total = Number(resp.headers.get("content-length")) || f.bytes;
    const out = await Deno.open(part, { write: true, create: true, truncate: true });
    let loaded = 0, last = 0;
    try {
      for await (const chunk of resp.body) {
        await out.write(chunk); loaded += chunk.length;
        if (loaded - last > 2_000_000 || loaded === total) { last = loaded; say(model, { file, loaded, total }); }
      }
    } finally { out.close(); }
    const sum = await sha256File(part);
    if (sum !== f.sha256) { await Deno.remove(part).catch(() => {}); throw new Error(`${file} is not the pinned file (sha256 ${sum.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…): the model changed upstream`); }
    await Deno.rename(part, final);
    say(model, { file, loaded: total, total, done: true });
  }
}

export async function handleModelRequest(req: Request): Promise<Response | undefined> {
  const url = new URL(req.url);
  const m = /^\/_models\/([a-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
  if (!m) return undefined;
  const [, model, file] = m;
  const spec = MODELS[model];
  if (!spec) return new Response("no such model", { status: 404 });
  if (file === "_ensure") {
    const enc = new TextEncoder();
    let listener: ((line: Record<string, unknown>) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const send = (line: Record<string, unknown>) => { try { ctl.enqueue(enc.encode(JSON.stringify(line) + "\n")); } catch { /* the page went away */ } };
        if (modelReady(model)) { send({ ok: true, kept: true }); ctl.close(); return; }
        listener = send;
        (listeners.get(model) ?? listeners.set(model, new Set()).get(model)!).add(send);
        let job = running.get(model);
        if (!job) { job = ensureModel(model).finally(() => running.delete(model)); running.set(model, job); }
        job.then(() => send({ ok: true }), (e) => send({ error: String((e as Error).message ?? e) }))
          .finally(() => { listeners.get(model)?.delete(send); try { ctl.close(); } catch { /* closed */ } });
      },
      cancel() { if (listener) listeners.get(model)?.delete(listener); },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }
  // nnLive's worker reads a ".json" weights address as a list of parts and fetches them without caching them again.
  if (model === "nnlive" && file === "perclick_192.parts.json") {
    return Response.json({ bytes: spec["perclick_192.weights.bin"].bytes, parts: ["perclick_192.weights.bin"] }, { headers: { "cache-control": "no-store" } });
  }
  if (!spec[file]) return new Response("no such file", { status: 404 });
  if (!kept(model, file)) return new Response("not fetched yet — GET _ensure first", { status: 404 });
  const path = join(modelsDir(), model, file);
  const size = spec[file].bytes;
  const type = file.endsWith(".json") ? "application/json" : "application/octet-stream";
  if (req.method === "HEAD") return new Response(null, { headers: { "content-length": String(size), "content-type": type } });
  const f = await Deno.open(path);
  return new Response(f.readable, { headers: { "content-length": String(size), "content-type": type, "cache-control": "no-store" } });
}
