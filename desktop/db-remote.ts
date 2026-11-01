// A DATABASE ON ANOTHER MAC -- this Mac's side (desktop/db-share.ts is the other Mac's; Ron, 2026-10-26: "Databases can
// be either local or remote"). A remote database is listed beside the local ones; every request for it --
// /_db/<id>/... -- goes to the Mac that holds it, over its encrypted connection, with the key pairing gave. That Mac is
// the only writer of its index. Nothing here reads or writes a folder: the remote ones live in a settings section of
// their own ([RemoteDatabase]), so no code that works on database folders (imports from a folder, transfers, the
// import-time jobs, Remove's Trash) ever sees them. The critic's round: Contents/docs/qa/2026-10-26-remote-database.md.
//
// PAIRING, LIKE A BLUETOOTH HEADSET (Ron, 2026-10-28; db-share.ts says why it is safe): POST /_db/_pair-remote {host,
// port} reads the other Mac's certificate, commits to a random number, gets that Mac's number, and answers at once with
// the SIX DIGITS for this screen; in the background it reveals its number and waits (two minutes) for the person there to
// allow it with Touch ID. GET /_db/_pair-remote/<id> says how it went. The key that comes back is kept in this Mac's
// key file (only this user can read it), the certificate beside the settings.
//
// WHAT IS CHECKED ABOUT THE CERTIFICATE: Deno's client trusts the pinned certificate IN ADDITION to the public
// authorities (the critic, finding 7). So only names no public authority certifies are accepted -- a ".local" name,
// "localhost", or a private address (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8) -- and for those the pinned
// certificate is the only one that can answer.
import { formatIni, parseIni } from "../logic/settings.ts";
import { readSettings, resolveSettingsPath, withSettingsLock, writeSettings } from "./settings-file.ts";
import { certFingerprint, computerName, shareDir } from "./db-share-cert.ts";
import { cleanName, newToken, pairingCommit, pairingDigits } from "./db-share.ts";

export const REMOTE_SECTION = "RemoteDatabase";
export interface RemoteDb { id: string; host: string; port: number; remoteId: string }
const DEFAULT_PORT = 8443;
/** An id as local ids are written: letters, digits, dot, dash, underscore; up to 80 (the critic, finding 3: a crafted id
 *  from the other Mac rewrote this Mac's settings). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** A name no public certificate authority certifies (see the header). */
export function privateHost(h: string): boolean {
  if (/^[A-Za-z0-9-]+\.local$/i.test(h) || h === "localhost") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// ---- where the keys and certificates are kept ------------------------------------------------------------------------
export interface SecretStore { get(account: string): Promise<string | undefined>; set(account: string, secret: string): Promise<void>; remove(account: string): Promise<void> }
/** THE KEYS IN A FILE ONLY THIS USER CAN READ, like SSH's own keys (the critic 2026-10-28, round 2, R2-2): the Keychain
 *  was tried -- through /usr/bin/security any program of the user could read the item without asking, and through the
 *  app's own unsigned helper macOS asks for the password after every update, from a background process. */
const keyFile = () => `${remoteDir()}/keys.json`;
const fileStore: SecretStore = {
  async get(account) { try { return (JSON.parse(await Deno.readTextFile(keyFile())) as Record<string, string>)[account]; } catch { return undefined; } },
  async set(account, secret) {
    let all: Record<string, string> = {};
    try { all = JSON.parse(await Deno.readTextFile(keyFile())); } catch { /* the first */ }
    all[account] = secret;
    await Deno.mkdir(remoteDir(), { recursive: true, mode: 0o700 });
    const tmp = `${keyFile()}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(all), { mode: 0o600 });
    await Deno.rename(tmp, keyFile());
    if ((await this.get(account)) !== secret) throw new Error("the key could not be kept on this Mac");
  },
  async remove(account) {
    try { const all = JSON.parse(await Deno.readTextFile(keyFile())) as Record<string, string>; delete all[account]; await Deno.writeTextFile(keyFile(), JSON.stringify(all), { mode: 0o600 }); } catch { /* none */ }
  },
};
let secrets: SecretStore = fileStore;
export function setSecretStoreForTests(s: SecretStore): void { secrets = s; tokens.clear(); }
/** The key, read once from its file and then kept in memory (the critic, 2026-10-26, finding 8: a read per file). */
const tokens = new Map<string, string>();
async function tokenFor(acc: string): Promise<string | undefined> {
  let t = tokens.get(acc);
  if (!t) { t = await secrets.get(acc); if (t) tokens.set(acc, t); }
  return t;
}
const remoteDir = () => shareDir().replace(/\/share$/, "/remote");
const certPath = (host: string, port: number) => `${remoteDir()}/${host.replace(/[^A-Za-z0-9.-]/g, "_")}-${port}.pem`;
const account = (host: string, port: number) => `${host}:${port}`;

// ---- the list --------------------------------------------------------------------------------------------------------
export async function remoteDatabases(galleryRoot?: string): Promise<RemoteDb[]> {
  const ini = parseIni(await readSettings(resolveSettingsPath(galleryRoot)));
  const sec = ini.get(REMOTE_SECTION) ?? new Map<string, string>();
  const out: RemoteDb[] = [];
  for (const [id, v] of sec) {
    const m = /^([^:|]+):(\d+)\|(.+)$/.exec(v);
    if (m && ID.test(id) && ID.test(m[3]) && privateHost(m[1])) out.push({ id, host: m[1], port: Number(m[2]), remoteId: m[3] });
  }
  return out;
}
async function changeRemote(galleryRoot: string | undefined, change: { add?: RemoteDb[]; remove?: string }): Promise<void> {
  for (const r of change.add ?? []) if (!ID.test(r.id) || !ID.test(r.remoteId) || !privateHost(r.host)) throw new Error("that Mac sent a database name this Mac does not accept");
  const file = resolveSettingsPath(galleryRoot);
  await withSettingsLock(file, async () => {
    const ini = parseIni(await readSettings(file));
    const sec = ini.get(REMOTE_SECTION) ?? new Map<string, string>();
    ini.set(REMOTE_SECTION, sec);
    for (const r of change.add ?? []) sec.set(r.id, `${r.host}:${r.port}|${r.remoteId}`);
    if (change.remove) sec.delete(change.remove);
    const db = ini.get("Database");
    if (change.remove && db?.get("current") === change.remove) db.delete("current");
    await writeSettings(file, formatIni(ini));
  });
}

// ---- the connection --------------------------------------------------------------------------------------------------
const clients = new Map<string, Deno.HttpClient>();
async function clientFor(host: string, port: number): Promise<Deno.HttpClient> {
  const k = `${host}:${port}`;
  let c = clients.get(k);
  if (!c) { c = Deno.createHttpClient({ caCerts: [await Deno.readTextFile(certPath(host, port))] }); clients.set(k, c); }
  return c;
}
/** A request to the other Mac; it fails within `waitMs` if no answer has begun (the critic, finding 4: 75 s before an
 *  asleep laptop was said), but a long download, once begun, is not cut. */
async function call(r: { host: string; port: number }, path: string, init: RequestInit & { waitMs?: number } = {}): Promise<Response> {
  const token = await tokenFor(account(r.host, r.port));
  if (!token) throw new Error("no key");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), init.waitMs ?? 10_000);
  try {
    return await fetch(`https://${r.host}:${r.port}${path}`, { ...init, headers, client: await clientFor(r.host, r.port), signal: ctl.signal,
      ...(init.body ? { duplex: "half" } : {}) } as RequestInit);
  } finally { clearTimeout(t); }
}
const shortHost = (h: string) => h.replace(/\.local$/, "");
/** Why a request to the other Mac failed, in words (the critic, finding 13). */
function whyNot(host: string, e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (m === "no key") return `This Mac's key for ${shortHost(host)} is missing; pair with it again (Load / Save › Databases › More › Open a database on another Mac…).`;
  if (/certificate|UnknownIssuer|NotValidForName|InvalidCertificate/i.test(m)) return `${shortHost(host)} answered with a different certificate than when you paired. If that Mac made a new one, pair again; otherwise something else is answering in its name.`;
  return `That database is on ${shortHost(host)}, which cannot be reached just now (asleep, sharing stopped, or on another network?).`;
}

/** The remote databases as the list shows them: reachable or not (asked with a short wait, remembered ten seconds), the
 *  other Mac's description (its name and what it holds only, limited in size), "on <that Mac>" where the folder would be. */
const seen = new Map<string, { at: number; list: { id: string; exists: boolean; description?: Record<string, unknown> }[] | null; why?: string }>();
const clean = (d: unknown): { name?: string; holds?: string; patientData?: boolean; source?: string } | undefined => {
  if (!d || typeof d !== "object") return undefined;
  const x = d as Record<string, unknown>, s = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : undefined;
  return { name: s(x.name, 80), holds: s(x.holds, 1000), source: s(x.source, 300), ...(typeof x.patientData === "boolean" ? { patientData: x.patientData } : {}) };
};
export async function remoteEntries(galleryRoot?: string): Promise<{ id: string; path: string; exists: boolean; current: boolean; remote: { host: string; why?: string }; description?: unknown }[]> {
  const cur = parseIni(await readSettings(resolveSettingsPath(galleryRoot))).get("Database")?.get("current");
  const out = [];
  for (const r of await remoteDatabases(galleryRoot)) {
    const k = `${r.host}:${r.port}`;
    let s = seen.get(k);
    if (!s || Date.now() - s.at > 10_000) {
      // WHY NOT, IN WORDS (the critic 2026-10-28, finding 3: the weekly Touch ID read as "asleep?"): waiting for Touch ID
      // there, not allowed there this week, or not reachable.
      let why: string | undefined;
      const list = await call(r, "/_db", { waitMs: 1500 }).then(async (x) => {
        if (x.ok) return x.json();
        const j = await x.json().catch(() => ({})) as { waiting?: boolean; refused?: boolean };
        why = j.waiting ? `waiting for Touch ID on ${shortHost(r.host)} (asked there once a week)` : j.refused ? `not allowed on ${shortHost(r.host)} this week` : x.status === 401 ? `${shortHost(r.host)} no longer lets this Mac in; connect again` : undefined;
        return null;
      }).then((j) => Array.isArray(j?.databases) ? j.databases : null).catch(() => null);
      s = { at: Date.now(), list, why };
      seen.set(k, s);
    }
    const there = s.list?.find((d) => d?.id === r.remoteId);
    const desc = clean(there?.description);
    out.push({ id: r.id, path: `on ${shortHost(r.host)}`, exists: !!there?.exists, current: cur === r.id, remote: { host: shortHost(r.host), ...(s.why ? { why: s.why } : {}) },
      ...(desc ? { description: desc } : {}) });
  }
  return out;
}

// ---- the requests ----------------------------------------------------------------------------------------------------
const remoteJobs = new Map<string, RemoteDb>();
const PASS = ["content-type", "range", "x-albula-index", "x-albula-job", "accept"];
/** What the other Mac's answers may be served as, on this Mac's own address (the critic, finding 16: a page from there
 *  would have run here). Anything else goes out as plain bytes, never rendered. */
const SAFE_TYPES = /^(application\/(json|dicom|octet-stream|zip|gzip|x-nrrd|zstd)|image\/(png|jpeg)|text\/plain)\b/i;

export async function handleRemoteRequest(req: Request, galleryRoot?: string): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/_db")) return null;
  const json = (o: unknown, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });

  if (url.pathname === "/_db/_pair-remote" && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as { host?: string; port?: number };
    try { return json(await pairRemote(galleryRoot, String(b.host ?? ""), b.port)); }
    catch (e) { return json({ error: (e as Error).message }, 400); }
  }
  const pr = /^\/_db\/_pair-remote\/([0-9a-f]{64})$/.exec(url.pathname);
  if (pr && req.method === "GET") return json(pairings.get(pr[1]) ?? { state: "unknown" });
  if (pr && req.method === "POST") {
    const st = pairings.get(pr[1]), b = await req.json().catch(() => ({})) as { same?: boolean };
    if (!st || st.state !== "waiting") return json({ error: "no pairing waiting" }, 404);
    st.same = b.same === true;
    if (!st.same) Object.assign(st, { state: "refused", why: "the numbers were not the same on both Macs; nothing was kept" });
    else await pairingKeep.get(pr[1])?.();
    return json(st);
  }
  const remotes = await remoteDatabases(galleryRoot);
  if (!remotes.length) return null;

  if (url.pathname === "/_db/_remove" && req.method === "POST") {
    const b = await req.clone().json().catch(() => ({})) as { id?: string; dry?: boolean };
    const r = remotes.find((x) => x.id === b.id);
    if (!r) return null;
    const e = (await remoteEntries(galleryRoot)).find((x) => x.id === r.id)!;
    const name = (e.description as { name?: string } | undefined)?.name ?? r.id;
    if (b.dry) return json({ id: r.id, name, exists: e.exists, current: e.current, remote: { host: shortHost(r.host) }, trash: { ok: false, why: `it is kept on ${shortHost(r.host)}; only its entry on this Mac goes` }, otherItems: 0, busy: null });
    await changeRemote(galleryRoot, { remove: r.id });
    if (!remotes.some((x) => x.id !== r.id && x.host === r.host && x.port === r.port)) {
      await secrets.remove(account(r.host, r.port));
      tokens.delete(account(r.host, r.port));
      await Deno.remove(certPath(r.host, r.port)).catch(() => {});
      clients.get(`${r.host}:${r.port}`)?.close(); clients.delete(`${r.host}:${r.port}`);
    }
    return json({ removed: r.id, name, trashed: false, wasCurrent: e.current, current: null });
  }
  const ij = /^\/_db\/_import\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (ij && remoteJobs.has(ij[1])) return await forward(req, remoteJobs.get(ij[1])!, url.pathname + url.search);

  const m = /^\/_db\/([^/]+)(\/.*)?$/.exec(url.pathname);
  let id = "";
  try { id = m ? decodeURIComponent(m[1]) : ""; } catch { /* not a database id */ }
  const r = remotes.find((x) => x.id === id);
  if (!r) return null;
  const res = await forward(req, r, `/_db/${encodeURIComponent(r.remoteId)}${m![2] ?? ""}${url.search}`);
  if ((m![2] ?? "") === "/_import" && res.ok) {
    const j = await res.clone().json().catch(() => null) as { job?: string } | null;
    if (j?.job) remoteJobs.set(j.job, r);
  }
  return res;
}

async function forward(req: Request, r: RemoteDb, path: string): Promise<Response> {
  const headers = new Headers();
  for (const h of PASS) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  try {
    const res = await call(r, path, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body });
    const out = new Headers({ "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
    const type = res.headers.get("content-type") ?? "";
    out.set("content-type", SAFE_TYPES.test(type) ? type : "application/octet-stream");
    for (const h of ["content-length", "content-range", "accept-ranges", "cache-control"]) { const v = res.headers.get(h); if (v) out.set(h, v); }
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    console.warn("remote database:", r.host, (e as Error).message);
    return Response.json({ error: whyNot(r.host, e) }, { status: 502 });
  }
}

/** Pairings under way or done, by id, for the page to follow (kept ten minutes). */
/** BOTH MACS CONFIRM (the critic 2026-10-28, finding 5: this Mac kept whatever key came back, so a machine answering in
 *  the laptop's name was paired with no one asked): the key is kept only once the person here says the other Mac shows
 *  the same digits (`same`), whichever comes first, their word or the other Mac's key. */
export interface PairingState { state: "waiting" | "paired" | "refused"; digits: string; host: string; same?: boolean; laptopSaid?: boolean; databases?: { id: string; name: string }[]; why?: string }
const pairings = new Map<string, PairingState>();
/** The step that keeps the key, once both the other Mac's key and this person's word are in. */
const pairingKeep = new Map<string, () => Promise<void>>();
/** Start pairing with another Mac: the six digits for this screen at once; the rest follows in the background. */
export async function pairRemote(galleryRoot: string | undefined, hostIn: string, portIn?: number): Promise<{ pairing: string; digits: string }> {
  const hm = /^\s*([A-Za-z0-9.-]+?)\.?\s*$/.exec(hostIn);
  if (!hm) throw new Error("that Mac's name is not one this Mac can reach");
  const host = hm[1].includes(".") || hm[1] === "localhost" ? hm[1] : `${hm[1]}.local`, port = Number(portIn ?? DEFAULT_PORT);
  if (!privateHost(host) || !(port > 1024 && port < 65535)) throw new Error("only a Mac on this local network can be paired (a name ending in .local, or a private address)");
  // 1. Its certificate (not trusted yet: its fingerprint goes into the six digits, so a different one shows different digits).
  const pem = await fetch(`http://${host}:${port + 1}/_share/cert`, { signal: AbortSignal.timeout(5000) }).then((x) => x.ok ? x.text() : Promise.reject(new Error(`status ${x.status}`)))
    .catch(() => { throw new Error(`${shortHost(host)} did not answer: is it sharing, on this network?`); });
  if (!/^-----BEGIN CERTIFICATE-----[\s\S]{100,8000}-----END CERTIFICATE-----\s*$/.test(pem)) throw new Error(`${shortHost(host)} did not send a certificate`);
  const fp = await certFingerprint(pem);
  const client = Deno.createHttpClient({ caCerts: [pem] });
  const post = async (path: string, body: unknown, waitMs: number) => {
    let res: Response;
    try {
      res = await fetch(`https://${host}:${port}${path}`, { method: "POST", client, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(waitMs) } as RequestInit);
    } catch (e) {
      throw new Error(/certificate|NotValidForName/i.test(String(e)) ? `${shortHost(host)} is not the name that Mac's certificate carries` : /timed? ?out|abort/i.test(String(e)) ? "no answer in time on that Mac" : `${shortHost(host)} did not answer`);
    }
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(j.error ?? `pairing failed (${res.status})`));
    return j;
  };
  // 2. A random number of ours, committed to; theirs; the six digits.
  const mine = newToken();
  let start: Record<string, unknown>;
  try { start = await post("/_share/pair/start", { client: computerName(), commit: await pairingCommit(mine) }, 10_000); }
  catch (e) { client.close(); throw e; }
  const theirs = String(start.number ?? ""), session = String(start.session ?? "");
  if (!/^[0-9a-f]{64}$/.test(theirs) || !/^[0-9a-f]{64}$/.test(session)) { client.close(); throw new Error("that Mac did not answer as Albula does"); }
  const digits = await pairingDigits(fp, mine, theirs), id = newToken();
  const state: PairingState = { state: "waiting", digits, host: shortHost(host) };
  pairings.set(id, state);
  setTimeout(() => pairings.delete(id), 10 * 60_000);
  // 3. In the background: our number revealed; the person there allows it (or not). The key is kept only when the person
  //    here has also said the numbers are the same.
  let got: { token: string; dbs: { id: string; exists: boolean; description?: unknown }[] } | undefined;
  const keep = async () => {
    if (!got || state.same !== true || state.state !== "waiting") return;
    const { token, dbs } = got;
    try {
      // The laptop lets the key in only now (R2-4): this Mac's person saw the same number, said with that key.
      const c = await fetch(`https://${host}:${port}/_share/pair/confirm`, { method: "POST", client, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) } as RequestInit);
      await c.body?.cancel();
      if (!c.ok) throw new Error("that Mac did not take the confirmation; connect again");
      const tag = shortHost(host).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) + (port === DEFAULT_PORT ? "" : `-${port}`);
      const add = dbs.map((d) => ({ id: `${d.id}-on-${tag}`.slice(0, 80), host, port, remoteId: d.id }));
      await Deno.mkdir(remoteDir(), { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(certPath(host, port), pem);
      await secrets.set(account(host, port), token);
      tokens.set(account(host, port), token);
      clients.get(`${host}:${port}`)?.close(); clients.delete(`${host}:${port}`);
      await changeRemote(galleryRoot, { add });
      seen.delete(`${host}:${port}`);
      Object.assign(state, { state: "paired", databases: dbs.map((d, i) => ({ id: add[i].id, name: clean(d.description)?.name ?? d.id })) });
    } catch (e) { Object.assign(state, { state: "refused", why: (e as Error).message }); }
    finally { got = undefined; pairingKeep.delete(id); client.close(); }
  };
  pairingKeep.set(id, keep);
  (async () => {
    try {
      const j = await post("/_share/pair/finish", { session, number: mine }, 150_000) as { token?: string; databases?: { id: string; exists: boolean; description?: unknown }[] };
      if (typeof j.token !== "string" || !/^[0-9a-f]{64}$/.test(j.token)) throw new Error("that Mac did not send a key");
      if (state.state !== "waiting") return;   // the person here said "not the same" meanwhile
      got = { token: j.token, dbs: (Array.isArray(j.databases) ? j.databases : []).filter((d) => typeof d?.id === "string" && ID.test(d.id)).slice(0, 50) };
      state.laptopSaid = true;
      await keep();
    } catch (e) { if (state.state === "waiting") Object.assign(state, { state: "refused", why: (e as Error).message }); pairingKeep.delete(id); client.close(); }
  })();
  // Given up after three minutes when the person here has not said the numbers are the same.
  setTimeout(() => { if (state.state === "waiting") { got = undefined; pairingKeep.delete(id); client.close(); Object.assign(state, { state: "refused", why: "the numbers were not confirmed here in time; nothing was kept" }); } }, 180_000);
  return { pairing: id, digits };
}
