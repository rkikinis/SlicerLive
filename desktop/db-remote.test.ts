// A database on another Mac (desktop/db-share.ts, db-share-cert.ts, db-remote.ts): both sides in one process, each with
// its own settings, over real TLS on this Mac. The keychain is replaced, so a test never writes the person's. The
// critic's round (Contents/docs/qa/2026-10-26-remote-database.md) is pinned here finding by finding.
//
//   deno test -A --no-check desktop/db-remote.test.ts
import { assert, assertEquals } from "jsr:@std/assert";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const { handleDbRequest } = await import("./db-serve.ts");
const { writeSettings, readSettings } = await import("./settings-file.ts");
const { shareHandler, allowedRequest, pairingCommit, pairingDigits, readClients, writeClients, RECONFIRM_MS } = await import("./db-share.ts");
const { ensureCertificate, certFingerprint } = await import("./db-share-cert.ts");
const { setSecretStoreForTests, privateHost } = await import("./db-remote.ts");

const laptop = `${home}/laptop/src/live`, mini = `${home}/mini/src/live`;
for (const g of [laptop, mini]) { await Deno.mkdir(g, { recursive: true }); await writeSettings(`${g}/settings.ini`, "[Database]\n"); }
const kept = new Map<string, string>();
setSecretStoreForTests({ get: (a) => Promise.resolve(kept.get(a)), set: (a, s) => { kept.set(a, s); return Promise.resolve(); }, remove: (a) => { kept.delete(a); return Promise.resolve(); } });

const callOn = async (g: string, method: string, path: string, body?: unknown) => {
  const r = await handleDbRequest(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), g);
  return { status: r!.status, j: await r!.json().catch(() => ({})) as Record<string, unknown> };
};
const shared = (await callOn(laptop, "POST", "/_db/_create", { name: "Lymph nodes", patientData: false })).j as { id: string; path: string };
const privateDb = (await callOn(laptop, "POST", "/_db/_create", { name: "Not shared", patientData: false })).j as { id: string; path: string };

const PORT = 18543;
const dir = `${userDir}/share`;
const { cert, key } = await ensureCertificate(dir, "localhost");
const fp = await certFingerprint(cert);
/** The person at the laptop, as the tests play them: what macOS's Touch ID dialog would say, and their answer. */
const asked: string[] = [];
let answer = true;
const confirm = (reason: string) => { asked.push(reason); return Promise.resolve(answer); };
/** "Let another Mac connect", as the person at the laptop opens it. */
const open = () => ({ certFingerprint: fp, until: Date.now() + 300_000 });
const opts: Parameters<typeof shareHandler>[0] = { ids: [shared.id], galleryRoot: laptop, dir, pairing: open(), confirm };
const tls = Deno.serve({ port: PORT, hostname: "127.0.0.1", cert, key, onListen() {} }, shareHandler(opts));
const plain = Deno.serve({ port: PORT + 1, hostname: "127.0.0.1", onListen() {} }, (req) => new URL(req.url).pathname === "/_share/cert" ? new Response(cert) : new Response("", { status: 404 }));
const pinned = Deno.createHttpClient({ caCerts: [cert] });
const raw = (path: string, init: RequestInit = {}) => fetch(`https://localhost:${PORT}${path}`, { ...init, client: pinned } as RequestInit);
/** Pairing as the mini's page does it: start (the six digits at once), then follow until it is decided. */
async function pair(port = PORT, same: boolean | null = true): Promise<{ status: number; digits?: string; state?: Record<string, unknown> }> {
  const s = await callOn(mini, "POST", "/_db/_pair-remote", { host: "localhost", port });
  if (s.status !== 200) return { status: s.status, state: s.j };
  if (same !== null) await callOn(mini, "POST", `/_db/_pair-remote/${s.j.pairing}`, { same });   // the person at the mini compares
  for (let i = 0; i < 100; i++) {
    const st = (await callOn(mini, "GET", `/_db/_pair-remote/${s.j.pairing}`)).j;
    if (st.state !== "waiting" || (same === null && st.laptopSaid)) return { status: 200, digits: String(s.j.digits), state: st };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { status: 200, digits: String(s.j.digits), state: { state: "still waiting" } };
}

Deno.test("the allow list: the shared database's reads and saves only; never another database, a folder-level route, cohorts or index rows", () => {
  const ids = ["db"];
  assert(allowedRequest("GET", "/_db/db/_series", ids));
  assert(allowedRequest("GET", "/_db/db/dicom/1/2/3.dcm", ids));
  assert(allowedRequest("POST", "/_db/db/_write/x.dcm", ids));
  assert(allowedRequest("PUT", "/_db/db/_scene/new", ids));
  for (const [m, p] of [["GET", "/_db/other/_series"], ["POST", "/_db/_create"], ["POST", "/_db/_remove"], ["PUT", "/_db/db/_description"],
    ["DELETE", "/_db/db/_series/1.2.3"], ["GET", "/_db/db/../other/ctkDICOM.sql"], ["GET", "/_db/db/%2e%2e/other/x"], ["GET", "/_db/db/a//b"],
    ["GET", "/_db/db/_cohorts"], ["POST", "/_db/db/_index"], ["GET", "/_db/%E0%A4%A/_series"]] as const) assert(!allowedRequest(m, p, ids), `${m} ${p}`);
});

Deno.test("only private network names are accepted (no public authority certifies them)", () => {
  for (const h of ["Rons-MBP.local", "localhost", "192.168.1.20", "10.0.0.5", "172.20.1.1"]) assert(privateHost(h), h);
  for (const h of ["example.com", "8.8.8.8", "rons-mbp.example.org", "172.32.0.1"]) assert(!privateHost(h), h);
});

Deno.test("pairing: the same six digits on both Macs; the person at the laptop allows it with Touch ID, whose dialog names the Mac and the digits", async () => {
  const r = await pair();
  assertEquals(r.state?.state, "paired", JSON.stringify(r.state));
  assert(/^\d{3} \d{3}$/.test(r.digits!), r.digits);
  assertEquals(asked.length, 1);
  assert(asked[0].includes(r.digits!), `the dialog said: ${asked[0]}`);
  assert(/open your shared databases/.test(asked[0]));
  const c = await readClients(dir);
  assertEquals(c.length, 1);
  assert(c[0].confirmedAt && !("token" in c[0]), JSON.stringify(c[0]));   // only the key's digest is kept here
  assertEquals(kept.size, 1);                                             // the key, in the mini's keychain
});

Deno.test("findings 2 and 6: records of the shared database's own series only; earlier saves cannot be taken back; links are not followed out", async () => {
  const r = ((await callOn(mini, "GET", "/_db")).j.databases as { id: string; remote?: unknown }[]).find((d) => d.remote)!;
  // A record of the other database, in the shared store.
  await callOn(laptop, "PUT", `/_db/${privateDb.id}/_attribute`, { uid: "9.9.9", key: "collection", value: "PRIVATE-ONLY", source: "test" });
  const prov = await callOn(mini, "GET", `/_db/${r.id}/_provenance`);
  assert(!JSON.stringify(prov.j).includes("PRIVATE-ONLY"), JSON.stringify(prov.j));
  const attr = await callOn(mini, "PUT", `/_db/${r.id}/_attribute`, { uid: "9.9.9", key: "collection", value: "changed", source: "mini" });
  assertEquals(attr.status, 404);
  // A file saved on the laptop before: the mini cannot delete it.
  await Deno.mkdir(`${shared.path}/SlicerAlbula-SEG`, { recursive: true });
  await Deno.writeTextFile(`${shared.path}/SlicerAlbula-SEG/old.dcm`, "x");
  assertEquals((await callOn(mini, "DELETE", `/_db/${r.id}/_write/old.dcm`)).status, 404);
  assert(await Deno.stat(`${shared.path}/SlicerAlbula-SEG/old.dcm`).then(() => true, () => false));
  // A link inside the shared database, pointing out of it: not followed.
  await Deno.writeTextFile(`${privateDb.path}/secret.txt`, "private");
  await Deno.symlink(`${privateDb.path}/secret.txt`, `${shared.path}/link.txt`);
  const viaLink = await handleDbRequest(new Request(`http://x/_db/${r.id}/link.txt`), mini);
  assertEquals(viaLink!.status, 404);
  await viaLink!.body?.cancel();
});

Deno.test("reads and saves through the pairing reach the laptop; without the key, or for a database not shared: refused", async () => {
  const r = ((await callOn(mini, "GET", "/_db")).j.databases as { id: string; remote?: unknown; exists: boolean; description?: { name: string } }[]).find((d) => d.remote)!;
  assert(r.exists && r.description?.name === "Lymph nodes");
  assertEquals((await callOn(mini, "GET", `/_db/${r.id}/_series`)).j, { series: [], patients: 0, studies: 0 });
  const scene = { mrson: 0, extensionsUsed: ["albula-scene/1"], source: { producer: "test", producedAt: new Date().toISOString(), origin: "local" }, v: 1, name: "From the mini", study: { studyInstanceUID: "1.2.3" }, studies: ["1.2.3"], nodes: {} };
  assertEquals((await callOn(mini, "PUT", `/_db/${r.id}/_scene/new`, scene)).status, 200);
  assert(((await callOn(laptop, "GET", `/_db/${shared.id}/_scenes`)).j.scenes as { name: string }[]).some((s) => s.name === "From the mini"));
  assertEquals((await callOn(mini, "PUT", `/_db/${r.id}/_description`, { name: "renamed" })).status, 404);
  const bare = await raw(`/_db/${shared.id}/_series`);
  assertEquals(bare.status, 401); await bare.body?.cancel();
  const token = [...kept.values()][0];
  const other = await raw(`/_db/${privateDb.id}/_series`, { headers: { authorization: `Bearer ${token}` } });
  assertEquals(other.status, 404); await other.body?.cancel();
});

Deno.test("the critic 2026-10-28, finding 2: another Mac's save adds; it cannot replace, take back or re-index what it did not write", async () => {
  const token = [...kept.values()][0];
  const auth = { authorization: `Bearer ${token}` };
  const send = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    raw(`/_db/${shared.id}${path}`, { method, headers: { ...auth, ...headers }, ...(body !== undefined ? { body } : {}) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  // An earlier save of the laptop's own.
  await Deno.mkdir(`${shared.path}/SlicerAlbula-SEG`, { recursive: true });
  await Deno.writeTextFile(`${shared.path}/SlicerAlbula-SEG/laptops.dcm`, "the laptop's");
  assertEquals((await send("POST", "/_write/laptops.dcm", "the mini's")).status, 409);
  assertEquals(await Deno.readTextFile(`${shared.path}/SlicerAlbula-SEG/laptops.dcm`), "the laptop's");
  // Written into the other folder, then taken back by the same name in the default folder: refused.
  assertEquals((await send("POST", "/_write/laptops.dcm?kind=image", "x")).status, 200);
  assertEquals((await send("DELETE", "/_write/laptops.dcm")).status, 404);
  assert(await Deno.stat(`${shared.path}/SlicerAlbula-SEG/laptops.dcm`).then(() => true, () => false));
  assertEquals((await send("DELETE", "/_write/laptops.dcm?kind=image")).status, 200);   // its own: it may
  // An index record naming a series, or an instance, the database already holds: refused before anything is written.
  const { runScript } = await import("./sqlite.ts");
  runScript(`${shared.path}/ctkDICOM.sql`, "INSERT INTO Series (SeriesInstanceUID, StudyInstanceUID, InsertTimestamp) VALUES ('1.2.3.4.5', '1.2.3', 0); INSERT INTO Images (SOPInstanceUID, Filename, SeriesInstanceUID, InsertTimestamp) VALUES ('1.2.3.4.5.1', 'dicom/x.dcm', '1.2.3.4.5', 0);");
  const meta = (sop: string, series: string) => ({ "x-albula-index": encodeURIComponent(JSON.stringify({ sopInstanceUID: sop, seriesInstanceUID: series, studyInstanceUID: "1.2.3", modality: "SEG" })) });
  const sameInstance = await send("POST", "/_write/new-1.dcm", "a", meta("1.2.3.4.5.1", "9.9.9.1"));
  assertEquals(sameInstance.status, 409); assert(/instance is already/.test(sameInstance.text), sameInstance.text);
  const sameSeries = await send("POST", "/_write/new-2.dcm", "b", meta("9.9.9.2.1", "1.2.3.4.5"));
  assertEquals(sameSeries.status, 409); assert(/series is already/.test(sameSeries.text), sameSeries.text);
  assert(!(await Deno.stat(`${shared.path}/SlicerAlbula-SEG/new-2.dcm`).then(() => true, () => false)));
  // A scene it did not make: not changed or removed from there.
  assertEquals((await send("DELETE", "/_scene/1.2.3.9")).status, 403);
});

Deno.test("finding 3: a crafted database name from the other Mac does not reach this Mac's settings", async () => {
  // A stand-in laptop answering the pairing with a hostile id.
  const evilPort = PORT + 10;
  const evil = Deno.serve({ port: evilPort, hostname: "127.0.0.1", cert, key, onListen() {} }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/_share/pair/start") return Response.json({ session: "e".repeat(64), number: "f".repeat(64) });
    if (u.pathname === "/_share/pair/finish") return Response.json({ token: "a".repeat(64), databases: [{ id: "x\n[Database]\ncurrent=evil\nevil=/Users", exists: true }, { id: "fine-one", exists: true }] });
    if (u.pathname === "/_share/pair/confirm") return Response.json({ paired: true });
    return new Response("", { status: 404 });
  });
  const evilCert = Deno.serve({ port: evilPort + 1, hostname: "127.0.0.1", onListen() {} }, () => new Response(cert));
  const r = await pair(evilPort);
  assertEquals(r.state?.state, "paired", JSON.stringify(r.state));
  const ini = await readSettings(`${mini}/settings.ini`);
  assert(!ini.includes("evil"), ini);
  assert(ini.includes("fine-one-on-localhost-"), ini);
  await evil.shutdown(); await evilCert.shutdown();
});

Deno.test("once a week: a paired Mac's first request waits for Touch ID at the laptop, and passes once it is given", async () => {
  const r = ((await callOn(mini, "GET", "/_db")).j.databases as { id: string; remote?: unknown }[]).find((d) => d.remote && d.id.startsWith(shared.id))!;
  const list = await readClients(dir);
  for (const c of list) c.confirmedAt = new Date(Date.now() - RECONFIRM_MS - 3600_000).toISOString();
  await writeClients(dir, list);
  const n = asked.length;
  const first = await callOn(mini, "GET", `/_db/${r.id}/_series`);
  assertEquals(first.status, 403, JSON.stringify(first.j));
  assert(String(first.j.error).includes("Touch ID"), String(first.j.error));
  for (let i = 0; i < 50 && asked.length === n; i++) await new Promise((res) => setTimeout(res, 20));
  assert(/this week/.test(asked.at(-1)!), asked.at(-1));
  await new Promise((res) => setTimeout(res, 100));
  assertEquals((await callOn(mini, "GET", `/_db/${r.id}/_series`)).status, 200);
});

// A second laptop on its own port and folder, so that refusals here do not pause the one above.
const dir2 = `${userDir}/share2`;
await Deno.mkdir(dir2, { recursive: true });
const PORT2 = PORT + 20;
const opts2: Parameters<typeof shareHandler>[0] = { ids: [shared.id], galleryRoot: laptop, dir: dir2, pairing: open(), confirm };
const tls2 = Deno.serve({ port: PORT2, hostname: "127.0.0.1", cert, key, onListen() {} }, shareHandler(opts2));
const plain2 = Deno.serve({ port: PORT2 + 1, hostname: "127.0.0.1", onListen() {} }, () => new Response(cert));

Deno.test("a Mac in between, with another certificate, makes the two screens show different digits", async () => {
  // The go-between: its own certificate, passing pairing to the real laptop unchanged.
  const { cert: c2, key: k2 } = await ensureCertificate(`${userDir}/between`, "localhost");
  const toLaptop = Deno.createHttpClient({ caCerts: [cert] });
  const RELAY = PORT + 30;
  const relay = Deno.serve({ port: RELAY, hostname: "127.0.0.1", cert: c2, key: k2, onListen() {} }, async (req) => {
    const res = await fetch(`https://localhost:${PORT2}${new URL(req.url).pathname}`, { method: req.method, headers: { "content-type": "application/json" }, body: await req.text(), client: toLaptop } as RequestInit);
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  });
  const relayCert = Deno.serve({ port: RELAY + 1, hostname: "127.0.0.1", onListen() {} }, () => new Response(c2));
  answer = false;                                  // the person sees two different numbers and says no
  const n = asked.length;
  const r = await pair(RELAY);
  assertEquals(r.state?.state, "refused", JSON.stringify(r.state));
  const said = asked.slice(n)[0] ?? "";
  const laptopDigits = /shows (\d{3} \d{3})/.exec(said)?.[1];
  assert(laptopDigits && laptopDigits !== r.digits, `laptop ${laptopDigits}, mini ${r.digits}`);
  assertEquals(await readClients(dir2), []);
  answer = true;
  await relay.shutdown(); await relayCert.shutdown(); toLaptop.close();
});

Deno.test("after a 'Don't allow' the laptop pauses pairing for a minute; a number that does not match its commitment is refused", async () => {
  const again = await callOn(mini, "POST", "/_db/_pair-remote", { host: "localhost", port: PORT2 });
  assertEquals(again.status, 400);
  assert(/a moment ago|try again|not letting a new Mac connect/.test(String(again.j.error)), String(again.j.error));   // a no closes the opening
  // The commitment, straight at a fresh laptop: a revealed number that is not the committed one.
  const PORT3 = PORT + 40;
  const s3 = Deno.serve({ port: PORT3, hostname: "127.0.0.1", cert, key, onListen() {} }, shareHandler({ ids: [shared.id], galleryRoot: laptop, dir: `${userDir}/share3`, pairing: open(), confirm }));
  await Deno.mkdir(`${userDir}/share3`, { recursive: true });
  const post = async (path: string, body: unknown) => { const res = await fetch(`https://localhost:${PORT3}${path}`, { method: "POST", client: pinned, body: JSON.stringify(body) } as RequestInit); return { status: res.status, j: await res.json() }; };
  const mine = "ab".repeat(32), other = "cd".repeat(32);
  const st = await post("/_share/pair/start", { client: "test", commit: await pairingCommit(mine) });
  assertEquals(st.status, 200);
  const n = asked.length;
  const fin = await post("/_share/pair/finish", { session: st.j.session, number: other });
  assertEquals(fin.status, 401);
  assertEquals(asked.length, n);                   // the person was never asked
  assert(await pairingDigits(fp, mine, st.j.number) !== await pairingDigits(fp, other, st.j.number));
  await s3.shutdown();
});

Deno.test("the critic 2026-10-28, findings 4 and 7: pairing only while opened at the laptop; one Mac per opening; the same name twice keeps both", async () => {
  // Closed (the one opening was used by the first pairing): refused before any question.
  const n = asked.length;
  const closed = await callOn(mini, "POST", "/_db/_pair-remote", { host: "localhost", port: PORT });
  assertEquals(closed.status, 400);
  assert(/Let another Mac connect/.test(String(closed.j.error)), String(closed.j.error));
  assertEquals(asked.length, n);
  // Opened again: the same Mac name pairs a second time; the first key still works.
  const before = (await readClients(dir)).length;
  opts.pairing = open();
  const again = await pair();
  assertEquals(again.state?.state, "paired", JSON.stringify(again.state));
  const list = await readClients(dir);
  assertEquals(list.length, before + 1);
  assertEquals(new Set(list.map((c) => c.name)).size, list.length);   // "(2)" added, not replaced
});

Deno.test("the critic 2026-10-28, finding 4: a body too large or too slow is refused at once, not read whole", async () => {
  opts.pairing = open();
  const t0 = Date.now();
  const big = await raw("/_share/pair/start", { method: "POST", body: "x".repeat(200_000) });
  assertEquals(big.status, 400); await big.body?.cancel();
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const slow = new ReadableStream<Uint8Array>({ start(c) { ctl = c; c.enqueue(new TextEncoder().encode("{")); } });   // does not end by itself
  const r = await raw("/_share/pair/start", { method: "POST", body: slow, duplex: "half" } as RequestInit);
  assertEquals(r.status, 400); await r.body?.cancel();
  ctl?.close();   // so that the server can shut down later
  assert(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
  opts.pairing = undefined;
});

Deno.test("the critic 2026-10-28, finding 3: a weekly 'no' holds for an hour; the other Mac is told plainly", async () => {
  const r = ((await callOn(mini, "GET", "/_db")).j.databases as { id: string; remote?: unknown }[]).find((d) => d.remote && d.id.startsWith(shared.id))!;
  const list = await readClients(dir);
  for (const c of list) c.confirmedAt = new Date(Date.now() - RECONFIRM_MS - 3600_000).toISOString();
  await writeClients(dir, list);
  answer = false;
  const n = asked.length;
  assertEquals((await callOn(mini, "GET", `/_db/${r.id}/_series`)).status, 403);
  for (let i = 0; i < 50 && asked.length === n; i++) await new Promise((res) => setTimeout(res, 20));
  await new Promise((res) => setTimeout(res, 50));
  for (let i = 0; i < 5; i++) {
    const again = await callOn(mini, "GET", `/_db/${r.id}/_series`);
    assertEquals(again.status, 403);
  }
  assertEquals(asked.length, n + 1, "asked again after a no");
  answer = true;
});

Deno.test("the critic 2026-10-28, finding 5: the mini keeps no key until its own person says the digits are the same", async () => {
  // A stand-in "laptop" that hands out a key at once, with no one asked.
  const EV = PORT + 50;
  const ev = Deno.serve({ port: EV, hostname: "127.0.0.1", cert, key, onListen() {} }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/_share/pair/start") return Response.json({ session: "e".repeat(64), number: "f".repeat(64) });
    if (u.pathname === "/_share/pair/finish") return Response.json({ token: "b".repeat(64), databases: [{ id: "trap", exists: true }] });
    return new Response("", { status: 404 });
  });
  const evc = Deno.serve({ port: EV + 1, hostname: "127.0.0.1", onListen() {} }, () => new Response(cert));
  const waiting = await pair(EV, null);   // the person at the mini has not answered
  assertEquals(waiting.state?.state, "waiting", JSON.stringify(waiting.state));   // the key came back; not kept
  assert(!(await readSettings(`${mini}/settings.ini`)).includes("trap-on-"));
  const no = await callOn(mini, "POST", `/_db/_pair-remote/${(await callOn(mini, "POST", "/_db/_pair-remote", { host: "localhost", port: EV })).j.pairing}`, { same: false });
  assertEquals(no.j.state, "refused");
  await new Promise((res) => setTimeout(res, 100));
  assert(!(await readSettings(`${mini}/settings.ini`)).includes("trap-on-"));
  await ev.shutdown(); await evc.shutdown();
});

Deno.test("the critic 2026-10-28, round 2, R2-4: the laptop lets a new key in only after the mini has confirmed with it", async () => {
  opts.pairing = open();
  const s0 = await callOn(mini, "POST", "/_db/_pair-remote", { host: "localhost", port: PORT });
  assertEquals(s0.status, 200, JSON.stringify(s0.j));
  // The laptop's person says yes at once (answer = true); the mini's person has not answered yet.
  for (let i = 0; i < 100; i++) { const st = (await callOn(mini, "GET", `/_db/_pair-remote/${s0.j.pairing}`)).j; if (st.laptopSaid) break; await new Promise((r) => setTimeout(r, 30)); }
  const pending = (await readClients(dir)).filter((c) => c.active === false);
  assertEquals(pending.length, 1, "one key waiting for the mini");
  // "a different number" on the mini: the laptop's entry never becomes good.
  assertEquals((await callOn(mini, "POST", `/_db/_pair-remote/${s0.j.pairing}`, { same: false })).j.state, "refused");
  assertEquals((await readClients(dir)).filter((c) => c.active === false).length, 1);
  assertEquals((await readClients(dir)).filter((c) => c.tokenHash === pending[0].tokenHash && c.active !== false).length, 0);
});

Deno.test("the critic 2026-10-28, round 2, R2-1/3/5/6: no adding scans; a save's record survives a restart; one decoding; others' series not described", async () => {
  const token = [...kept.values()][0];
  const auth = { authorization: `Bearer ${token}` };
  // The weekly "no" of the test before is kept on disk now (R2-12): allowed again here.
  const list = await readClients(dir);
  for (const c of list) { c.confirmedAt = new Date().toISOString(); delete c.weeklyNoUntil; }
  await writeClients(dir, list);
  // A second handler on the same folder stands for sharing restarted.
  const PORT4 = PORT + 60;
  const send = (port: number, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    fetch(`https://localhost:${port}/_db/${shared.id}${path}`, { method, client: pinned, headers: { ...auth, ...headers }, ...(body !== undefined ? { body } : {}) } as RequestInit).then(async (r) => ({ status: r.status, text: await r.text() }));
  assertEquals((await send(PORT, "POST", "/_write/across.dcm", "x")).status, 200);
  const s4 = Deno.serve({ port: PORT4, hostname: "127.0.0.1", cert, key, onListen() {} }, shareHandler({ ids: [shared.id], galleryRoot: laptop, dir, confirm }));   // started after the save, as a restart is
  assertEquals((await send(PORT4, "DELETE", "/_write/across.dcm")).status, 200, "taken back after a restart");
  assertEquals((await send(PORT, "POST", "/_import", JSON.stringify({ upload: "u" }), { "content-type": "application/json" })).status, 404);
  await Deno.writeTextFile(`${shared.path}/SlicerAlbula-SEG/seg_41.dcm`, "the laptop's");
  const dbl = await send(PORT, "POST", "/_write/seg%2541.dcm", "the mini's");
  assert(dbl.status !== 200 || (await Deno.readTextFile(`${shared.path}/SlicerAlbula-SEG/seg_41.dcm`)) === "the laptop's", dbl.text);
  assertEquals(await Deno.readTextFile(`${shared.path}/SlicerAlbula-SEG/seg_41.dcm`), "the laptop's");
  assertEquals((await send(PORT, "PUT", "/_attribute", JSON.stringify({ uid: "1.2.3.4.5", key: "license", value: "" }), { "content-type": "application/json" })).status, 403);
  await s4.shutdown();
});

Deno.test("Remove on the mini takes only the entry here; a laptop gone is said plainly", async () => {
  const r = ((await callOn(mini, "GET", "/_db")).j.databases as { id: string; remote?: unknown }[]).find((d) => d.remote && d.id.startsWith(shared.id))!;
  const dry = await callOn(mini, "POST", "/_db/_remove", { id: r.id, dry: true });
  assertEquals((dry.j.trash as { ok: boolean }).ok, false);
  await tls.shutdown();
  const t0 = Date.now();
  const gone = await callOn(mini, "GET", `/_db/${r.id}/_series`);
  assertEquals(gone.status, 502);
  assert(Date.now() - t0 < 12_000);
  assert(String(gone.j.error).includes("cannot be reached"), String(gone.j.error));
  assertEquals((await callOn(mini, "POST", "/_db/_remove", { id: r.id })).status, 200);
  assert(!((await callOn(mini, "GET", "/_db")).j.databases as { id: string }[]).some((d) => d.id === r.id));
  assert(await Deno.stat(`${shared.path}/ctkDICOM.sql`).then(() => true, () => false));
  await plain.shutdown(); await tls2.shutdown(); await plain2.shutdown();
  pinned.close();
  for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
});
