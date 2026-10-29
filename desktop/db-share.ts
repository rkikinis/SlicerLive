// SHARING A DATABASE WITH ANOTHER MAC -- the laptop's side (Ron, 2026-10-26: "Databases can be either local or remote. In
// the remote case the database lives on the laptop and the client lives on the mac mini. Access to the database is
// through a secure port ... after proper authentication"; "I don't want to allow just anybody to access the database on
// the laptop. One time handshake is ok but there has to be a password ... I do not want random people in starbucks to be
// able to access the database"). A TRIAL, first version: a program the person starts (desktop/share-databases-main.ts),
// not yet a button; DICOMweb and scenes inside DICOM wait for the conversation with Steve (2026-10-27). The critic's
// round on the first draft: Contents/docs/qa/2026-10-26-remote-database.md.
//
// WHAT PROTECTS IT, in the order it works:
//   1. Nothing listens unless the person starts it, naming the databases it shares; it stops when the program stops.
//   2. Encrypted (TLS) with a certificate made on this Mac the first time (desktop/db-share-cert.ts).
//   3. PAIRING, LIKE A BLUETOOTH HEADSET (Ron, 2026-10-28: "Can we do better and more convenient without compromising
//      security? E.g using the local authentication"; the workspace's DATABASE-SHARING.md; it replaces the trial's
//      one-time code and password). The other Mac commits to a random number of its own (sends only its digest), this Mac
//      answers with a random number of its own, then the other Mac reveals its number. Both compute SIX DIGITS from the
//      two numbers and THIS Mac's certificate fingerprint -- the other Mac from the certificate it actually reached
//      (`pairingDigits`). The person checks the digits are the same on both screens and allows it here with Touch ID
//      (or the login password): macOS's own dialog shows the other Mac's name and the digits. A Mac in between would
//      present another certificate, or would have to choose its numbers before seeing the other side's, so the two
//      screens would show different digits (one chance in a million to match). One pairing at a time; after "Don't
//      allow", a minute's pause; after ten, pairing closes until sharing restarts.
//   4. Every request carries the key pairing gave; only its digest is kept here (clients.json, this user only). ONCE A
//      WEEK (Ron: "once a week") the first request of a paired Mac waits for Touch ID here again.
//      share-databases-main.ts --list / --unpair <name> show and revoke them.
//   5. Only the shared databases' own routes, and only these (ALLOW below): reading the list, files (never through a
//      link out of the folder), working copies, scenes, and the records of THEIR series; storing a new object, a scene,
//      an attribute of one of their series; adding scans by upload; taking back a file saved in this sharing session.
//      Not: other databases, making / removing / renaming databases, folders on this Mac, transfers, settings, cohorts,
//      index rows written directly, the segmentation server.
import { handleDbRequest, registeredDatabases } from "./db-serve.ts";
import { isInside } from "./paths.ts";
import { runScript } from "./sqlite.ts";

export interface ShareClient { name: string; tokenHash: string; pairedAt: string; /** The last Touch ID for it here (ISO). */ confirmedAt?: string;
  /** Paired the app's way (2026-10-28). An entry without it -- the 10-26 trial's typed code and password -- is not let in
   *  (the critic, round 2, R2-11): that Mac pairs again. */ v?: 3;
  /** False until the other Mac has said, with this key, that its person saw the same number too (R2-4). */ active?: boolean;
  /** A weekly "no" holds until then (ms; kept here, so a restart does not ask again at once: R2-12). */ weeklyNoUntil?: number }
/** PAIRING IS OPEN ONLY WHEN THE PERSON HERE OPENED IT (the critic 2026-10-28, finding 4: open whenever sharing ran, anyone
 *  on the network raised Touch ID dialogs, held pairing or closed it): this Mac's certificate fingerprint, and until when. */
export interface Pairing { certFingerprint: string; until: number }
/** How long a Touch ID for a paired Mac lasts (Ron: "once a week"). */
export const RECONFIRM_MS = 7 * 24 * 3600_000;
export interface ShareOptions {
  /** The database ids (as this Mac's list names them) that are shared. */
  ids: string[];
  galleryRoot?: string;
  /** Where the certificate, its key and the paired clients are kept (desktop/db-share-cert.ts shareDir). */
  dir: string;
  /** Pairing, while the person here has it open (unset: only Macs paired before come in). */
  pairing?: Pairing;
  /** Asks the person here (Touch ID, or the login password; the helper gives up after a minute); true when confirmed.
   *  Unset: nothing is asked, so nobody new is let in and the weekly question is answered no. */
  confirm?: (reason: string) => Promise<boolean>;
  log?: (line: string) => void;
}

// ---- secrets -------------------------------------------------------------------------------------------------------
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s));
}
/** The other Mac's commitment to its random number (hex): only this digest crosses before this Mac has answered. */
export async function pairingCommit(theirs: string): Promise<string> { return await sha256Hex(`albula-pair-commit|${theirs}`); }
/** THE SIX DIGITS both screens show: from this Mac's certificate fingerprint and both random numbers ("123 456"). */
export async function pairingDigits(certFingerprint: string, clientNumber: string, serverNumber: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`albula-pair-v1|${certFingerprint}|${clientNumber}|${serverNumber}`)));
  const n = ((d[0] << 24 >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3]) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
/** A Mac's name as it is shown and kept: letters, digits, spaces and a few signs, up to 60. */
export const cleanName = (s: unknown) => String(s ?? "").normalize("NFC").replace(/[^\p{L}\p{N}_ .()'’-]/gu, "").trim().slice(0, 60) || "another Mac";   // letters of any language (the critic, finding 11: "Jürgen" lost its ü)
export function newToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }

// ---- the paired clients --------------------------------------------------------------------------------------------
/** The Macs allowed. None yet: an empty list. A list that is there but cannot be read: an error, so that sharing stops
 *  rather than the next pairing writing over it (the critic 2026-10-26, finding 9; 2026-10-28, finding 8). */
export async function readClients(dir: string): Promise<ShareClient[]> {
  let text: string;
  try { text = await Deno.readTextFile(`${dir}/clients.json`); } catch (e) { if (e instanceof Deno.errors.NotFound) return []; throw new Error("the list of Macs allowed cannot be read"); }
  const j = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
  if (!Array.isArray(j)) throw new Error("the list of Macs allowed is damaged");
  return j as ShareClient[];
}
export async function writeClients(dir: string, list: ShareClient[]): Promise<void> {
  const tmp = `${dir}/clients.json.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  await Deno.rename(tmp, `${dir}/clients.json`);
}

// ---- what may be asked -----------------------------------------------------------------------------------------------
/** One allowed request: its method, and the path after /_db/<id>/ ("" for the database itself). */
const ALLOW: { method: string; rest: RegExp }[] = [
  { method: "GET", rest: /^_(series|files|scenes|provenance|description|sizes)$/ },
  { method: "GET", rest: /^_scene\/[0-9.]+$/ },
  { method: "GET", rest: /^_zarr\/[0-9.]+$/ },
  { method: "GET", rest: /^(?!_)[^?#]+$/ },                            // a file of the database (checked below: inside it)
  { method: "POST", rest: /^_write\/[^/]+$/ },                        // Save to DICOM: written and indexed in one request
  { method: "DELETE", rest: /^_write\/[^/]+$/ },                      // a failed save takes its files back (this session's only)
  { method: "PUT", rest: /^_scene\/([0-9.]+|new)$/ },                  // a scene saved over, or a new one
  { method: "DELETE", rest: /^_scene\/[0-9.]+$/ },
  { method: "PUT", rest: /^_attribute$/ },                            // of one of the database's own series (checked below)
  // NOT: adding scans by upload and import (the critic 2026-10-28, round 2, R2-1: an import put a slice into an original
  // acquisition's series, around the rule a save keeps). Scans are added on the Mac that holds the database.
];
export function allowedRequest(method: string, pathname: string, ids: string[]): { id: string; rest: string } | null {
  const m = /^\/_db\/([^/]+)(?:\/(.*))?$/.exec(pathname);
  if (!m) return null;
  let id: string, rest: string;
  try { id = decodeURIComponent(m[1]); rest = decodeURIComponent(m[2] ?? ""); } catch { return null; }
  if (!ids.includes(id)) return null;
  if (rest.split("/").some((p) => p === ".." || p === ".") || rest.includes("\\") || rest.includes("//")) return null;
  return ALLOW.some((a) => a.method === method && a.rest.test(rest)) ? { id, rest } : null;
}

/** The series of a database, from its index (for the records it may see). */
async function seriesOf(path: string): Promise<Set<string>> {
  try { return new Set(runScript(`${path}/ctkDICOM.sql`, "SELECT SeriesInstanceUID FROM Series;", { readonly: true }).split("\n").map((l) => l.trim()).filter(Boolean)); }
  catch { return new Set(); }
}

// ---- the handler -------------------------------------------------------------------------------------------------------
/** What the person here may want to know about pairing (desktop/sharing.ts shows it). */
export interface PairingStatus { open: boolean; until?: number; closed?: string; waiting?: string }
/** How long a "no" to a paired Mac's weekly question holds before it is asked again. */
export const WEEKLY_NO_MS = 3600_000;

export function shareHandler(o: ShareOptions): ((req: Request) => Promise<Response>) & { status: () => PairingStatus } {
  /** One pairing at a time: the other Mac's name and commitment, this Mac's number, when it began. */
  let pending: { session: string; client: string; commit: string; number: string; at: number; answering?: boolean } | undefined;
  let refusals = 0, pausedUntil = 0;
  /** ONE DIALOG AT A TIME (finding 3): the pairing question and the weekly ones wait for each other, each limited to a
   *  minute by the helper. Nothing else waits in this queue: state is checked and changed between awaits only. */
  let dialogs: Promise<unknown> = Promise.resolve();
  const oneDialog = (reason: string): Promise<boolean> => {
    const ask = o.confirm;
    const p = dialogs.then(() => ask ? ask(reason).catch(() => false) : false);
    dialogs = p.catch(() => {});
    return p;
  };
  /** What each paired Mac wrote through sharing in this session (by its key's digest and the database): the files (by
   *  folder and name), the series its saves made, the scenes it made. Only these can it take back or save over (the
   *  critic 2026-10-28, finding 2: an earlier save of this Mac's was overwritten, taken back, and an original series'
   *  index row rewritten). */
  // KEPT ON DISK for a week (R2-3: a save under way when sharing restarted was left half in the index, its take-backs
  // refused), in the sharing folder beside the list of Macs.
  const writtenFile = `${o.dir}/written.json`;
  const writtenBy = new Map<string, { files: Set<string>; series: Set<string>; scenes: Set<string>; at: number }>();
  try {
    const j = JSON.parse(Deno.readTextFileSync(writtenFile)) as Record<string, { files: string[]; series: string[]; scenes: string[]; at: number }>;
    for (const [k, v] of Object.entries(j)) if (Date.now() - v.at < RECONFIRM_MS) writtenBy.set(k, { files: new Set(v.files), series: new Set(v.series), scenes: new Set(v.scenes), at: v.at });
  } catch { /* none yet */ }
  let saving: Promise<void> = Promise.resolve();
  const keepWritten = () => {
    const o2: Record<string, unknown> = {};
    for (const [k, v] of writtenBy) o2[k] = { files: [...v.files], series: [...v.series], scenes: [...v.scenes], at: v.at };
    const text = JSON.stringify(o2);
    saving = saving.then(async () => { const tmp = `${writtenFile}.tmp`; await Deno.writeTextFile(tmp, text, { mode: 0o600 }); await Deno.rename(tmp, writtenFile); }).catch(() => {});
    return saving;
  };
  const mineOf = (client: string, id: string) => { const k = `${client}|${id}`; let m = writtenBy.get(k); if (!m) writtenBy.set(k, m = { files: new Set(), series: new Set(), scenes: new Set(), at: Date.now() }); m.at = Date.now(); return m; };
  const say = o.log ?? (() => {});
  const no = (status: number, error: string, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status, headers: { "cache-control": "no-store" } });
  /** A small JSON body, refused while it is read past 4 KB or slower than 5 s (finding 4: 300 MB were read before the
   *  limit, and a body that never ended held pairing). */
  const small = async (req: Request): Promise<Record<string, unknown>> => {
    const reader = req.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let n = 0;
    const deadline = Date.now() + 5000;
    try {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("too slow");
        const r = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("too slow")), left))]);
        if (r.done) break;
        n += r.value.byteLength;
        if (n > 4096) throw new Error("too large");
        chunks.push(r.value);
      }
    } catch (e) { reader.cancel().catch(() => {}); throw e; }
    const all = new Uint8Array(n); let at = 0; for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    const t = new TextDecoder().decode(all);
    return JSON.parse(t || "{}") as Record<string, unknown>;
  };
  /** The weekly question, by the paired Mac's key digest: being asked, or "no" until a time (finding 3). */
  const weekly = new Map<string, { asking?: Promise<void>; noUntil?: number }>();
  const refuse = (what: string) => { refusals++; pausedUntil = Date.now() + 60_000; pending = undefined; say(`pairing refused: ${what} (${refusals})`); };
  const hexOf = (v: unknown, n: number) => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v) ? v : undefined;
  const pairingOpen = () => o.pairing && Date.now() < o.pairing.until ? o.pairing : undefined;

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/_share/hello" && req.method === "GET") return Response.json({ service: "albula-database", v: 3 });

    // PAIRING, STEP 1: the other Mac's name and commitment; this Mac's random number back. Only while the person here has
    // pairing open.
    if (url.pathname === "/_share/pair/start" && req.method === "POST") {
      let b: Record<string, unknown>;
      try { b = await small(req); } catch { return no(400, "bad request"); }
      if (!pairingOpen()) return no(403, "that Mac is not letting a new Mac connect just now; on it: Databases, “Let another Mac connect”");
      if (refusals >= 10) return no(403, "pairing is closed on that Mac after ten refusals; it opens again when sharing restarts there");
      if (Date.now() < pausedUntil) return no(429, "that Mac said no a moment ago; try again in a minute");
      if (pending && Date.now() - pending.at < 120_000) return no(429, "another Mac is pairing with that one just now; try again in two minutes");
      const commit = hexOf(b.commit, 64);
      if (!commit) return no(400, "bad request");
      pending = { session: newToken(), client: cleanName(b.client), commit, number: newToken(), at: Date.now() };
      return Response.json({ session: pending.session, number: pending.number }, { headers: { "cache-control": "no-store" } });
    }
    // PAIRING, STEP 2: the other Mac reveals its number; the six digits; the person here allows it with Touch ID (the
    // answer waits for them, up to a minute); the key goes back.
    if (url.pathname === "/_share/pair/finish" && req.method === "POST") {
      let b: Record<string, unknown>;
      try { b = await small(req); } catch { return no(400, "bad request"); }
      const p = pending, pairing = pairingOpen();
      if (!pairing || !p || p.answering || b.session !== p.session || Date.now() - p.at > 120_000) return no(401, "start pairing again");
      p.answering = true;   // before any await: one reveal per opening (R2-8)
      const theirs = hexOf(b.number, 64);
      if (!theirs || await pairingCommit(theirs) !== p.commit) { refuse("the number did not match its commitment"); return no(401, "start pairing again"); }
      const digits = await pairingDigits(pairing.certFingerprint, theirs, p.number);
      try { await readClients(o.dir); } catch (e) { pending = undefined; return no(503, `sharing stopped on that Mac: ${(e as Error).message}`); }   // before asking anyone (R2-7)
      say(`pairing: ${p.client} asks; the number on both Macs should be ${digits}`);
      const ok = await oneDialog(`allow “${p.client}” to open your shared databases. Only if it shows ${digits}`);
      // A "yes" after the other Mac has given up (150 s) counts as no (finding 7: the key went to no one).
      if (!ok || Date.now() - p.at > 140_000) { refuse(`${p.client}: not allowed here`); o.pairing = undefined; return no(403, "not allowed on that Mac"); }   // a no closes this opening (R2-12)
      pending = undefined;
      const token = newToken(), now = new Date().toISOString();
      // A Mac is known by its key, not its name (finding 7): a new pairing adds; the person removes old ones.
      const list = await readClients(o.dir);
      const taken = new Set(list.map((c) => c.name));
      let name = p.client; for (let i = 2; taken.has(name); i++) name = `${p.client} (${i})`;
      // Not let in until the other Mac confirms with this key that its person saw the same number (R2-4); an entry never
      // confirmed is dropped after ten minutes.
      const fresh = list.filter((c) => c.active !== false || Date.now() - Date.parse(c.pairedAt) < 600_000);
      fresh.push({ name, tokenHash: await sha256Hex(token), pairedAt: now, confirmedAt: now, v: 3, active: false });
      await writeClients(o.dir, fresh);
      o.pairing = undefined;   // one Mac per opening
      say(`pairing: ${name} allowed here; waiting for it to confirm the number there too`);
      return Response.json({ token, databases: await sharedList(o) }, { headers: { "cache-control": "no-store" } });
    }

    // EVERYTHING ELSE NEEDS THE KEY.
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const h = token ? await sha256Hex(token) : "";
    let clients: ShareClient[];
    try { clients = await readClients(o.dir); } catch (e) { return no(503, `sharing stopped on that Mac: ${(e as Error).message}`); }
    const entry = token ? clients.find((c) => c.tokenHash === h && c.v === 3) : undefined;
    // PAIRING, STEP 3: the other Mac's person saw the same number; the key becomes good (R2-4).
    if (url.pathname === "/_share/pair/confirm" && req.method === "POST") {
      if (!entry || entry.active !== false || Date.now() - Date.parse(entry.pairedAt) > 600_000) return no(401, "start pairing again");
      for (const c of clients) if (c.tokenHash === h) c.active = true;
      await writeClients(o.dir, clients);
      say(`paired: ${entry.name}`);
      return Response.json({ paired: true }, { headers: { "cache-control": "no-store" } });
    }
    const who = entry && entry.active !== false ? entry : undefined;
    if (!who) return no(401, "this Mac is not paired with that one");
    // ONCE A WEEK, Touch ID here again before a paired Mac comes in (Ron: "once a week"). The request does not wait for
    // the person (the other Mac would give up after ten seconds): the question is put here, once, and the other Mac is
    // told to wait; a "no" holds for an hour (finding 3: after a no it was asked again at once, 20 dialogs in 5 s).
    if (!who.confirmedAt || Date.now() - Date.parse(who.confirmedAt) > RECONFIRM_MS) {
      const w = weekly.get(h) ?? {};
      weekly.set(h, w);
      if ((w.noUntil && Date.now() < w.noUntil) || (who.weeklyNoUntil && Date.now() < who.weeklyNoUntil)) return no(403, "not allowed on that Mac this week: the answer there was no", { refused: true });
      if (!w.asking) {
        w.asking = oneDialog(`let “${who.name}” open your shared databases this week`).then(async (ok) => {
          if (ok) {
            const list = await readClients(o.dir);
            for (const c of list) if (c.tokenHash === h) { c.confirmedAt = new Date().toISOString(); delete c.weeklyNoUntil; }
            await writeClients(o.dir, list);
            w.noUntil = undefined;
            say(`${who.name}: allowed for another week`);
          } else {
            w.noUntil = Date.now() + WEEKLY_NO_MS;
            const list = await readClients(o.dir);
            for (const c of list) if (c.tokenHash === h) c.weeklyNoUntil = w.noUntil;
            await writeClients(o.dir, list);
            say(`${who.name}: not allowed this week (asked again in an hour)`);
          }
        }).catch(() => { w.noUntil = Date.now() + WEEKLY_NO_MS; }).finally(() => { w.asking = undefined; });
      }
      return no(403, "waiting for Touch ID on that Mac (asked once a week)", { waiting: true });
    }

    if (url.pathname === "/_db" && req.method === "GET") return Response.json({ databases: await sharedList(o) }, { headers: { "cache-control": "no-store" } });
    const ok = allowedRequest(req.method, url.pathname, o.ids);
    if (!ok) { say(`refused: ${req.method} ${url.pathname} (${who.name})`); return no(404, "not available on a shared database"); }
    const db = (await registeredDatabases(o.galleryRoot)).find((d) => d.id === ok.id);
    if (!db?.exists) return no(404, "that database is not reachable on that Mac");
    let fwd = req;
    // A FILE: inside the database's folder once links are resolved (the critic: a link was followed out of it).
    if (req.method === "GET" && !ok.rest.startsWith("_")) {
      const real = await Deno.realPath(`${db.path}/${ok.rest}`).catch(() => "");
      if (!real || !(await isInside(real, await Deno.realPath(db.path)))) return no(404, "not found");
    }
    if (ok.rest === "_attribute") {
      // AN ATTRIBUTE OF ONE OF ITS OWN SERIES (the records store is shared by every database beside it).
      let body: Record<string, unknown>;
      try { body = await small(req); } catch { return no(400, "bad request"); }
      if (!(await seriesOf(db.path)).has(String(body.uid ?? ""))) return no(404, "not a series of this database");
      // ONLY ON A SERIES ITS OWN SAVES MADE (R2-6: an original series' license was cleared from the other Mac).
      if (!mineOf(who.tokenHash, ok.id).series.has(String(body.uid))) return no(403, "only a series this Mac's saves made can be described from here");
      fwd = new Request(req.url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    // A SAVE FROM ANOTHER MAC ADDS; it replaces or takes back only what that Mac wrote here in this session (finding 2).
    const mine = mineOf(who.tokenHash, ok.id);
    let name = "", rel = "", newSeries = "";
    if (ok.rest.startsWith("_write/")) {
      name = ok.rest.slice(7).replace(/[^A-Za-z0-9._-]/g, "_");   // decoded once (allowedRequest), cleaned as db-serve.ts does (R2-5)
      rel = `${url.searchParams.get("kind") === "image" ? "SlicerAlbula-Volumes" : "SlicerAlbula-SEG"}/${name}`;
      if (req.method === "DELETE" && !mine.files.has(rel)) return no(404, "only a file this Mac saved there in this session can be taken back");
      if (req.method === "POST" && !mine.files.has(rel) && await Deno.stat(`${db.path}/${rel}`).then(() => true, () => false)) return no(409, "a file of that name is already there; a save from another Mac adds, it never replaces");
      const ih = req.headers.get("x-albula-index");
      if (req.method === "POST" && ih) {
        let meta: { seriesInstanceUID?: unknown; sopInstanceUID?: unknown };
        try { meta = JSON.parse(decodeURIComponent(ih)); } catch { return no(400, "the index record is not JSON"); }
        const sr = String(meta.seriesInstanceUID ?? ""), sop = String(meta.sopInstanceUID ?? "");
        if (!/^[0-9.]{1,64}$/.test(sr) || !/^[0-9.]{1,64}$/.test(sop)) return no(400, "the index record names no series or instance");
        const q = (sql: string) => { try { return runScript(`${db.path}/ctkDICOM.sql`, sql, { readonly: true }).trim(); } catch { return "error"; } };
        if (q(`SELECT 1 FROM Images WHERE SOPInstanceUID = '${sop}' LIMIT 1;`) !== "") return no(409, "that instance is already in the database; a save from another Mac adds, it never replaces");
        if (!mine.series.has(sr) && q(`SELECT 1 FROM Series WHERE SeriesInstanceUID = '${sr}' LIMIT 1;`) !== "") return no(409, "that series is already in the database and was not made by this Mac's saves; a save adds a new series");
        newSeries = sr;
        mine.series.add(sr);   // before the write: the next instance of the same save may already be on its way
        await keepWritten();
      }
    }
    const sceneM = /^_scene\/([0-9.]+)$/.exec(ok.rest);
    if (sceneM && (req.method === "PUT" || req.method === "DELETE") && !mine.scenes.has(sceneM[1])) return no(403, "only a scene this Mac saved there in this session can be changed or removed from here; save it as a new scene");
    if (req.method !== "GET") say(`${req.method} ${url.pathname} (${who.name})`);
    const res = await handleDbRequest(fwd, o.galleryRoot) ?? no(404, "not found");
    if (req.method === "POST" && rel && res.ok) { mine.files.add(rel); if (newSeries) mine.series.add(newSeries); await keepWritten(); }
    if (req.method === "PUT" && ok.rest === "_scene/new" && res.ok) {
      const j = await res.clone().json().catch(() => null) as { uid?: string } | null;
      if (j?.uid) { mine.scenes.add(j.uid); await keepWritten(); }
    }
    // THE RECORDS OF ITS OWN SERIES ONLY (the critic: every database's edges and attributes came along).
    if (ok.rest === "_provenance" && res.ok) {
      const mine = await seriesOf(db.path);
      const j = await res.json() as { edges?: { child: string; parent: string }[]; attributes?: { uid: string }[] };
      return Response.json({ edges: (j.edges ?? []).filter((e) => mine.has(e.child) || mine.has(e.parent)), attributes: (j.attributes ?? []).filter((a) => mine.has(a.uid)) },
        { headers: { "cache-control": "no-store" } });
    }
    return res;
  };
  return Object.assign(handler, {
    status: (): PairingStatus => {
      const open = !!pairingOpen();
      return { open, ...(open ? { until: o.pairing!.until } : {}),
        ...(refusals >= 10 ? { closed: "after ten refusals; it opens again when sharing restarts" } : {}),
        ...(pending && Date.now() - pending.at < 120_000 ? { waiting: pending.client } : {}) };
    },
  });
}

/** The shared databases as this Mac lists them: id, name, description -- never the folder on this Mac. */
async function sharedList(o: ShareOptions): Promise<{ id: string; exists: boolean; description?: unknown }[]> {
  const all = await registeredDatabases(o.galleryRoot);
  return all.filter((d) => o.ids.includes(d.id)).map((d) => ({ id: d.id, exists: d.exists, ...(d.description ? { description: d.description } : {}) }));
}
