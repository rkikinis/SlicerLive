// SHARING A DATABASE WITH YOUR OTHER MACS, IN THE APP (the workspace's DATABASE-SHARING.md and its mockup; Ron,
// 2026-10-28: sharing "in the regular app"; the other Mac may "read and write"; it stays "on across restarts", which
// "still require presence on the same network"). The one place that decides whether this Mac shares: which databases
// ([Sharing] in the settings file), on which networks, and whether it listens now. db-share.ts answers the other Mac's
// requests; db-remote.ts is the other Mac's side; mac-helper.ts reaches Touch ID, the Keychain and Bonjour.
//
// WHEN IT LISTENS: some database is switched on, this build has the helper, and this Mac is on a network that was
// allowed (with Touch ID, the first time sharing was switched on there). A network is known by its router's hardware
// address (the default gateway's, from the system's own `route` and `arp`; a Wi-Fi name would need the location
// permission). macOS shows that address only to an app it allows on the local network (System Settings › Privacy &
// Security › Local Network; measured 2026-10-28: from a process without it, `arp` says "no entry"); without it this Mac
// does not share, and says why -- never a weaker sign such as the router's address alone, which many networks share.
// Anywhere else nothing listens and nothing is announced; checked every 20 seconds and on every change.
//
// ROUTES (the page on this Mac only; the server refuses other hosts and origins):
//   GET  /_db/_sharing                  what is shared, the network, the Macs allowed, whether it listens now
//   POST /_db/_sharing {id, on}         a database's switch (the first time on a network: Touch ID allows the network)
//   POST /_db/_sharing/open-pairing     let one new Mac connect, for five minutes (the critic 2026-10-28, finding 4)
//   POST /_db/_sharing/forget {id}      a paired Mac no longer comes in (by its key, not its name: finding 7)
//   POST /_db/_sharing/forget-networks  the networks allowed so far forgotten (finding 10)
//   GET  /_db/_nearby                   the Macs on this network that share databases (Bonjour; while the page asks)
import { formatIni, parseIni } from "../logic/settings.ts";
import { readSettings, resolveSettingsPath, withSettingsLock, writeSettings } from "./settings-file.ts";
import { certFingerprint, computerName, ensureCertificate, localHostName, shareDir } from "./db-share-cert.ts";
import { readClients, sha256Hex, shareHandler, writeClients, type ShareOptions } from "./db-share.ts";
import { advertise, browse, canConfirmOwner, confirmOwner, helperPath, type SeenMac } from "./mac-helper.ts";
import { registeredDatabases } from "./db-serve.ts";

export const SHARING_SECTION = "Sharing";
export const SHARING_PORT = 8443;
interface Shared { ids: string[]; networks: string[] }

async function readShared(galleryRoot?: string): Promise<Shared> {
  const sec = parseIni(await readSettings(resolveSettingsPath(galleryRoot))).get(SHARING_SECTION);
  const list = (k: string) => (sec?.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { ids: list("databases"), networks: list("networks") };
}
async function changeShared(galleryRoot: string | undefined, f: (s: Shared) => void): Promise<Shared> {
  const file = resolveSettingsPath(galleryRoot);
  return await withSettingsLock(file, async () => {
    const ini = parseIni(await readSettings(file));
    const sec = ini.get(SHARING_SECTION) ?? new Map<string, string>();
    const s: Shared = { ids: (sec.get("databases") ?? "").split(",").filter(Boolean), networks: (sec.get("networks") ?? "").split(",").filter(Boolean) };
    f(s);
    sec.set("databases", [...new Set(s.ids)].join(","));
    sec.set("networks", [...new Set(s.networks)].join(","));
    ini.set(SHARING_SECTION, sec);
    await writeSettings(file, formatIni(ini));
    return s;
  });
}

/** Why the network is not known, when it is not (said on the page). */
let networkWhy = "";
let contacted = "";
/** Router hardware addresses that many networks share, so they cannot tell one network from another: the virtual
 *  routers of VRRP (00:00:5e:00:01/02:xx) and HSRP (00:00:0c:07:ac:xx, 00:00:0c:9f:fx), common in hospitals and hotels
 *  (the critic 2026-10-28, finding 6). */
const SHARED_ROUTER = /^(00:00:5e:00:0[12]|00:00:0c:07:ac|00:00:0c:9f:f)/;
export interface Network { id: string; iface: string; address: string }
/** This network: by its router's hardware address and its own address (a digest), the interface it is reached on, and
 *  this Mac's address there (where sharing listens; finding 6: it listened on every connection). Undefined when there
 *  is no router, macOS does not show it to Albula, or it cannot be told from others -- `networkWhy` says which. */
export async function currentNetwork(): Promise<Network | undefined> {
  const out = async (cmd: string, args: string[]) => {
    const r = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output().catch(() => null);
    return r?.success ? new TextDecoder().decode(r.stdout) : "";
  };
  const route = await out("/sbin/route", ["-n", "get", "default"]);
  const gw = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1], iface = /interface:\s*(\S+)/.exec(route)?.[1];
  if (!gw || !iface) { networkWhy = "this Mac is not on a network just now"; return undefined; }
  const address = (await out("/usr/sbin/ipconfig", ["getifaddr", iface])).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) { networkWhy = "this Mac has no address on this network just now"; return undefined; }
  const macOf = async () => / at ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}) /i.exec(await out("/usr/sbin/arp", ["-n", gw]))?.[1];
  let mac = await macOf();
  // NOT IN THE CACHE YET: one contact with the router fills it -- and is the step that makes macOS ask about the local
  // network the first time (finding 9: nothing asked, so the switch could never work).
  if (!mac && contacted !== gw) { contacted = gw; await fetch(`http://${gw}/`, { signal: AbortSignal.timeout(1500) }).then((r) => r.body?.cancel()).catch(() => {}); mac = await macOf(); }   // once per router (R2-12)
  if (!mac) { networkWhy = "Albula cannot recognize this network. If macOS asked whether SlicerAlbula may find devices on the local network, the answer has to be Allow (System Settings › Privacy & Security › Local Network)"; return undefined; }
  const norm = mac.toLowerCase().split(":").map((p) => p.padStart(2, "0")).join(":");
  if (SHARED_ROUTER.test(norm)) { networkWhy = "this network's router uses an address that many other networks use too, so Albula cannot tell it apart and does not share on it"; return undefined; }
  networkWhy = "";
  return { id: (await sha256Hex(`albula-network|${norm}|${gw}`)).slice(0, 16), iface, address };
}

// ---- the person here ------------------------------------------------------------------------------------------------
/** EVERY QUESTION THIS MAC PUTS TO ITS PERSON, ONE AT A TIME (the critic, round 2, R2-12: the network's question and a
 *  pairing's could be up together): Touch ID or the login password, gone unanswered after a minute. */
let dialogs: Promise<unknown> = Promise.resolve();
export function askPerson(reason: string): Promise<boolean> {
  const p = dialogs.then(async () => (await confirmOwner(reason).catch(() => ({ ok: false }))).ok);
  dialogs = p.catch(() => {});
  return p;
}

// ---- the listener ---------------------------------------------------------------------------------------------------
let galleryRootOf: string | undefined;
let running: { server: Deno.HttpServer; certServer: Deno.HttpServer; ad?: { stop: () => void }; opts: ShareOptions; handler: ReturnType<typeof shareHandler>; fingerprint: string; address: string; iface: string } | undefined;
/** How long "Let another Mac connect" keeps pairing open. */
export const PAIRING_OPEN_MS = 5 * 60_000;
let lastError = "", network: Network | undefined;
const log = (m: string) => console.log(`sharing: ${m}`);

/** ONE CHECK AT A TIME (R2-10): a check asked while one runs waits for it, and then one more runs. */
let ticking: Promise<void> | undefined, again = false;
async function tick(): Promise<void> {
  if (ticking) { again = true; return await ticking; }
  ticking = (async () => { do { again = false; await tickOnce(); } while (again); })().finally(() => { ticking = undefined; });
  return await ticking;
}
async function tickOnce(): Promise<void> {
  const s = await readShared(galleryRootOf);
  const exists = new Set((await registeredDatabases(galleryRootOf)).filter((d) => d.exists).map((d) => d.id));
  const ids = s.ids.filter((i) => exists.has(i));
  // The network is read only when something is shared (the critic, finding 11: route and arp every 20 s for everyone).
  network = ids.length ? await currentNetwork() : undefined;
  // A DAMAGED LIST OF MACS STOPS SHARING, said on the page (R2-7).
  let listProblem = "";
  if (ids.length) { try { await readClients(shareDir()); } catch (e) { listProblem = (e as Error).message; } }
  const want = ids.length > 0 && !!helperPath() && !!network && s.networks.includes(network.id) && !listProblem;
  if (listProblem) lastError = `sharing stopped: ${listProblem}`;
  // A NEW ADDRESS OR CONNECTION: stop, and start again on the new one (finding 6).
  if (running && want && (running.address !== network!.address || running.iface !== network!.iface)) await stopListening();
  if (running && want && running.ad?.ended()) running.ad = advertise(computerName(), SHARING_PORT, { v: "3" }, running.iface);   // Bonjour restarted (R2-12)
  if (running && !want) {
    await stopListening();
    log(network && s.networks.includes(network.id) ? "stopped" : "paused (not on a network that was allowed)");
  } else if (running) running.opts.ids = ids;   // read per request by db-share.ts
  else if (want) {
    try {
      const dir = shareDir(), { cert, key } = await ensureCertificate(dir, localHostName());
      const opts: ShareOptions = { ids, galleryRoot: galleryRootOf, dir, log, confirm: askPerson };
      const handler = shareHandler(opts);
      const net = network!;
      // On this network's address only, not every connection the Mac has (finding 6).
      const server = Deno.serve({ port: SHARING_PORT, hostname: net.address, cert, key, onListen() {} }, handler);
      // The certificate, unencrypted: its fingerprint goes into the six digits on the other Mac, so it needs no trust.
      const certServer = Deno.serve({ port: SHARING_PORT + 1, hostname: net.address, onListen() {} }, (req) =>
        new URL(req.url).pathname === "/_share/cert" ? new Response(cert, { headers: { "content-type": "application/x-pem-file" } }) : new Response("", { status: 404 }));
      // Announced by this Mac's name only: which databases it shares is said to paired Macs, not to the network.
      running = { server, certServer, ad: advertise(computerName(), SHARING_PORT, { v: "3" }, net.iface), opts, handler, fingerprint: await certFingerprint(cert), address: net.address, iface: net.iface };
      lastError = "";
      log(`listening on port ${SHARING_PORT}`);
    } catch (e) { lastError = (e as Error).message; log(`could not start: ${lastError}`); }
  }
}

/** Stops listening and announcing at once; a request still under way gets three seconds (R2-10: shutdown waited for it,
 *  and the page said "shared" meanwhile). */
async function stopListening(): Promise<void> {
  const r = running;
  if (!r) return;
  running = undefined;
  r.ad?.stop();
  await Promise.race([Promise.allSettled([r.server.shutdown(), r.certServer.shutdown()]), new Promise((res) => setTimeout(res, 3000))]);
}

/** Started once by the server (server-worker.ts). */
export function startSharing(galleryRoot?: string): void {
  galleryRootOf = galleryRoot;
  if (Deno.build.os !== "darwin" || Deno.env.get("ALBULA_SHARING") === "off") return;   // a test server does not share
  const go = () => tick().catch((e) => { lastError = (e as Error).message; });
  go();
  // Every five seconds while something is shared (a change of network is noticed within that; finding 6), every
  // twenty otherwise (only the settings are read then).
  let last = 0;
  setInterval(() => { const busy = !!running || !!network; if (busy || Date.now() - last > 20_000) { last = Date.now(); go(); } }, 5_000);
}

// ---- the Macs nearby (the other Mac's side) ---------------------------------------------------------------------------
let browsing: { stop: () => void; seen: Map<string, SeenMac>; lastAsked: number } | undefined;
function nearby(): SeenMac[] {
  if (!browsing && helperPath()) {
    const seen = new Map<string, SeenMac>();
    browsing = { seen, lastAsked: Date.now(), stop: browse((e) => { if (e.event === "up") seen.set(e.name, e); else seen.delete(e.name); }).stop };
    const idle = setInterval(() => { if (browsing && Date.now() - browsing.lastAsked > 60_000) { browsing.stop(); browsing = undefined; clearInterval(idle); } }, 10_000);
  }
  if (!browsing) return [];
  browsing.lastAsked = Date.now();
  const me = localHostName().toLowerCase();
  return [...browsing.seen.values()].filter((m) => (m.host ?? "").replace(/\.$/, "").toLowerCase() !== me);
}

// ---- the page's routes ------------------------------------------------------------------------------------------------
let allowing: Promise<boolean> = Promise.resolve(true);
export async function handleSharingRequest(req: Request, galleryRoot?: string): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/_db/_sharing") && url.pathname !== "/_db/_nearby") return null;
  const json = (o: unknown, status = 200) => Response.json(o, { status, headers: { "cache-control": "no-store" } });
  galleryRootOf ??= galleryRoot;
  const state = async () => {
    const s = await readShared(galleryRoot), net = network ?? (s.ids.length ? await currentNetwork() : undefined);
    const allowedHere = !!net && s.networks.includes(net.id);
    let macs: { id: string; name: string; pairedAt: string; confirmedAt?: string }[] = [], macsError: string | undefined;
    try { macs = (await readClients(shareDir())).map((c) => ({ id: c.tokenHash.slice(0, 12), name: c.name, pairedAt: c.pairedAt, confirmedAt: c.confirmedAt })); }
    catch (e) { macsError = (e as Error).message; }
    return {
      available: !!helperPath(), ...(helperPath() ? await canConfirmOwner().catch(() => ({ touchID: false, owner: false })) : { touchID: false, owner: false }),
      databases: s.ids, network: { known: !!net, allowed: allowedHere, count: s.networks.length, ...(net || !s.ids.length ? {} : { why: networkWhy }) }, listening: !!running,
      error: lastError || macsError || undefined, pairing: running?.handler.status() ?? { open: false },
      name: computerName(), host: localHostName(), macs,
    };
  };
  if (url.pathname === "/_db/_nearby" && req.method === "GET") return json({ macs: nearby().map((m) => ({ name: m.name, host: (m.host ?? "").replace(/\.$/, ""), port: m.port })) });
  if (url.pathname === "/_db/_sharing" && req.method === "GET") return json(await state());
  if (url.pathname === "/_db/_sharing" && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as { id?: string; on?: boolean };
    const id = String(b.id ?? "");
    if (!(await registeredDatabases(galleryRoot)).some((d) => d.id === id && d.exists)) return json({ error: "no such database on this Mac" }, 404);
    if (!helperPath()) return json({ error: "this build of Albula cannot share (it was built without the helper for Touch ID and the network)" }, 400);
    if (b.on) {
      const net = await currentNetwork();
      if (!net) return json({ error: networkWhy || "this Mac is not on a network just now" }, 400);
      // The first time on this network: the person here allows it (Touch ID, or the login password); one question at a time.
      const allowed = await (allowing = allowing.then(async () => {
        if ((await readShared(galleryRoot)).networks.includes(net.id)) return true;
        const ok = await askPerson("share your databases on this network with the Macs you allow");
        if (ok) await changeShared(galleryRoot, (x) => x.networks.push(net.id));
        return ok;
      }));
      if (!allowed) return json({ error: "not shared: this network was not allowed" }, 403);
      await changeShared(galleryRoot, (x) => x.ids.push(id));
    } else await changeShared(galleryRoot, (x) => { x.ids = x.ids.filter((i) => i !== id); });
    await tick();
    return json(await state());
  }
  if (url.pathname === "/_db/_sharing/forget-networks" && req.method === "POST") {
    // Every network allowed so far forgotten: the next switch-on asks again (finding 10: a hotel allowed by mistake stayed).
    await changeShared(galleryRoot, (x) => { x.networks = []; });
    await tick();
    return json(await state());
  }
  if (url.pathname === "/_db/_sharing/open-pairing" && req.method === "POST") {
    if (!running) return json({ error: "this Mac is not sharing on this network just now" }, 400);
    running.opts.pairing = { certFingerprint: running.fingerprint, until: Date.now() + PAIRING_OPEN_MS };
    log("pairing open for five minutes");
    return json(await state());
  }
  if (url.pathname === "/_db/_sharing/forget" && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as { id?: string };
    const list = await readClients(shareDir()), keep = list.filter((c) => c.tokenHash.slice(0, 12) !== b.id);
    if (keep.length === list.length) return json({ error: "no such Mac" }, 404);
    await writeClients(shareDir(), keep);
    return json(await state());
  }
  return json({ error: "not found" }, 404);
}
