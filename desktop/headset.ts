// HEADSETS FOR THE 3D VIEW: VR / AR glasses (2026-10-12, Ron: "Now that everything is working, is there a way to
// streamline the workflow? Right now it would be confusing for our use case user"; "How about VR/AR? We are now playing
// with Viture. Other devices are likely in the future"). Albula's server finds the headset, runs its head tracking and
// switches its 3D mode; the page (render/moduleserver/live-views.ts, the 3D view's VR/AR button) does the rest. No helper
// started from a terminal. One driver per maker (desktop/headset-viture.ts today); the page sees a headset, not a brand.
//
// Routes:
//   GET  /_headset           what is there: the maker's software (found or not), the headset plugged in, its mode
//   GET  /_headset/ws        the head's pose, 60 times a second: {"pose":[px,py,pz,qw,qx,qy,qz]} (meters, OpenGL axes),
//                            {"status":"…"}, {"recenter":true} when a headset (re)starts, {"mode":"2d"|"3d"}
//   POST /_headset/mode      {"mode":"3d"|"2d"}: the headset's own one-picture-per-eye mode, or back
//   POST /_headset/find      the person picks the folder where they put the maker's software (macOS's folder dialog)
//   GET/POST /_headset/scene THE GLASSES WINDOW'S SCENE (Ron, 2026-10-12: two windows -- the full Albula on the desk's
//                            screen, the 3D view alone in the glasses): the main window posts its scene document (the
//                            one a saved scene is, logic/scene/write.ts) whenever it changes; the glasses window loads
//                            it and is sent each new one as {"scene": …}
//   POST /_headset/end       either window ends the glasses: {"end": true} to every page listening
//
// The maker's software is never part of Albula (VITURE's is proprietary); its folder is remembered in headset.json beside
// the settings file -- this module is that file's one writer.
import { dirname } from "jsr:@std/path@1";
import { userSettingsPath } from "./settings-file.ts";
import { chooseFolder } from "./choose-folder.ts";
import { findVitureLibrary, vitureDriver, vitureOnUsb, type HeadsetDriver } from "./headset-viture.ts";

const HOME = Deno.env.get("HOME") ?? "";
const configFile = () => `${dirname(userSettingsPath())}/headset.json`;
const readConfig = (): { vitureFolder?: string } => { try { return JSON.parse(Deno.readTextFileSync(configFile())); } catch { return {}; } };
function writeConfig(c: { vitureFolder?: string }): void {
  Deno.mkdirSync(dirname(configFile()), { recursive: true });
  const tmp = `${configFile()}.tmp`; Deno.writeTextFileSync(tmp, JSON.stringify(c, null, 1) + "\n"); Deno.renameSync(tmp, configFile());
}

/** Where VITURE's software is: the folder the person chose, then the usual places. `lib-albula` first: a fresh copy of
 *  Domenico Riggio's lib folder made because macOS held a stale security decision on the original (2026-09-25). */
const vitureFolder = () => findVitureLibrary([readConfig().vitureFolder ?? "", `${HOME}/Viture/slicerviture_arm_dev/lib-albula`,
  `${HOME}/Viture`, `${HOME}/Applications`, `${HOME}/Downloads`]);

/** Where to get the maker's software, for the page's "How to get it". */
const VITURE_HELP = {
  maker: "VITURE",
  url: "https://www.viture.com/developer",
  steps: [
    "Open VITURE's developer page (the link below) in a browser.",
    "Under \"Glasses SDK\", download the SDK for macOS.",
    "Unpack it into a folder of your choice, for example \"VITURE\" in your home folder.",
    "In Albula, press \"Find it on this Mac…\" and choose that folder.",
  ],
};

let current: HeadsetDriver | null = null, streaming = false, mode: "2d" | "3d" = "2d", lastLook = -Infinity, lastPose = "", lastStatus = "";
const clients = new Set<WebSocket>();
let loop: ReturnType<typeof setInterval> | undefined;
const send = (o: unknown) => { const m = JSON.stringify(o); for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(m); };
const say = (s: string) => { if (s !== lastStatus) { lastStatus = s; send({ status: s }); } };

/** What is plugged in, and its driver when the maker's software is there. */
function find(): { plugged: boolean; folder?: string; driver: HeadsetDriver | null; loadError?: string } {
  const pid = vitureOnUsb();
  if (pid === undefined) return { plugged: false, driver: null };
  const folder = vitureFolder();
  if (!folder) return { plugged: true, driver: null };
  // A library that macOS will not load is not "glasses it does not know" (the critic, 2026-10-13, finding 6).
  try { return { plugged: true, folder, driver: vitureDriver(folder, pid) }; } catch (e) { return { plugged: true, folder, driver: null, loadError: (e as Error).message }; }
}

/** Whether macOS will load the maker's library from this folder: undefined when it will, else why not. */
function loadsHere(folder: string): string | undefined {
  try { Deno.dlopen(`${folder}/libglasses.dylib`, {}).close(); return undefined; } catch (e) { return (e as Error).message; }
}

/** Whenever nothing streams, once a second: what is plugged in, started (a swap is an unplug and a plug). The driver's
 *  start and stop run off this loop (headset-viture.ts, "nonblocking"); `busy` keeps one of them under way at a time. */
let busy = false;
async function look(): Promise<void> {
  const f = find();
  if (!f.plugged) { say("no glasses plugged in"); return; }
  if (!f.driver) { say(f.loadError ? "the maker's software is on this Mac but could not be loaded" : f.folder ? "these glasses are not known to the maker's software" : "the maker's software is not on this Mac"); return; }
  if (f.driver !== current) { await current?.stop(); current = f.driver; }
  const ok = await current.start();
  if (!clients.size) { await current.stop(); return; }   // the last page left while it started
  streaming = ok;
  if (streaming) { mode = "2d"; send({ recenter: true, glasses: current.name }); say(`following the ${current.name}`); }
  else say(`the ${current.name} did not start -- unplug them and plug them in again`);
}

function tick(): void {
  if (busy) return;
  if (!streaming) {
    const t = performance.now();
    if (t - lastLook >= 1000) { lastLook = t; busy = true; void look().catch(() => {}).finally(() => { busy = false; }); }
    return;
  }
  if (!current!.active()) {
    streaming = false; mode = "2d"; send({ mode }); say("the glasses were unplugged");
    busy = true; void current!.stop().catch(() => {}).finally(() => { busy = false; });
    return;
  }
  const pose = current!.pose();
  if (!pose) return;
  const key = pose.join(",");
  if (key === lastPose) return;
  lastPose = key;
  send({ pose, t: Date.now() });   // when the pose reached Albula: the page measures how old it is when drawn
}

/** The glasses are released when the last page stops listening, so other programs may use them. */
function startLoop(): void { if (!loop) { lastLook = -Infinity; loop = setInterval(tick, 16); } }
function stopLoop(): void {
  if (clients.size) return;
  clearInterval(loop); loop = undefined;
  const was = streaming && current ? current : null, was3d = mode === "3d";
  streaming = false; mode = "2d"; lastStatus = "";
  // Off the loop, in turn (finding 1): the glasses to 2D, then stopped.
  if (was) void (async () => { if (was3d) await was.set3d(false); await was.stop(); })().catch(() => {});
}

/** macOS's "Displays have separate Spaces" is OFF (com.apple.spaces spans-displays = 1): one window can then lie across
 *  two screens, which the glasses view needs. Its default is on (the key absent). Read, never written: it is the person's. */
function spansDisplays(): boolean | undefined {
  if (Deno.build.os !== "darwin") return undefined;
  try {
    const o = new Deno.Command("/usr/bin/defaults", { args: ["read", "com.apple.spaces", "spans-displays"], stdout: "piped", stderr: "null" }).outputSync();
    return o.success && new TextDecoder().decode(o.stdout).trim() === "1";
  } catch { return undefined; }
}

let lastScene: unknown = null;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export async function handleHeadsetRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/_headset")) return null;
  if (url.pathname === "/_headset/ws") {
    if (req.headers.get("upgrade") !== "websocket") return new Response("a WebSocket", { status: 400 });
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => { clients.add(socket); startLoop(); if (lastStatus) socket.send(JSON.stringify({ status: lastStatus })); };
    socket.onclose = () => { clients.delete(socket); stopLoop(); };
    return response;
  }
  if (url.pathname === "/_headset" && req.method === "GET") {
    const f: ReturnType<typeof find> = streaming && current ? { plugged: true, folder: vitureFolder(), driver: current } : find();
    return json({
      plugged: f.plugged, software: f.folder ?? vitureFolder() ?? null, help: VITURE_HELP,
      headset: f.driver ? { name: f.driver.name, rotationOnly: f.driver.rotationOnly } : null,
      streaming, mode, maker: VITURE_HELP.maker, spansDisplays: spansDisplays(), loadError: f.loadError ?? null,
    });
  }
  if (url.pathname === "/_headset/mode" && req.method === "POST") {
    const want = ((await req.json().catch(() => ({}))) as { mode?: string }).mode === "3d";
    if (!streaming || !current) return json({ ok: false, why: "no glasses streaming" }, 409);
    const code = await current.set3d(want);
    if (code === 0) { mode = want ? "3d" : "2d"; send({ mode }); }
    return json({ ok: code === 0, code, mode });
  }
  if (url.pathname === "/_headset/scene") {
    if (req.method === "GET") return json({ scene: lastScene });
    if (req.method === "POST") { lastScene = await req.json().catch(() => null); if (lastScene) send({ scene: lastScene }); return json({ ok: !!lastScene }); }
  }
  if (url.pathname === "/_headset/end" && req.method === "POST") { send({ end: true }); return json({ ok: true }); }
  if (url.pathname === "/_headset/find" && req.method === "POST") {
    const c = await chooseFolder("Choose the folder where you put VITURE's Glasses SDK");
    if (!c) return json({ ok: false, why: "cancelled" });
    const lib = findVitureLibrary([c.path]);
    if (!lib) return json({ ok: false, why: `no VITURE software (libglasses.dylib) in ${c.name} or the folders inside it` });
    const refused = loadsHere(lib);
    if (refused) return json({ ok: false, why: `VITURE's software is in ${c.name}, but macOS would not load it (${refused.split("\n")[0].slice(0, 160)})` });
    writeConfig({ ...readConfig(), vitureFolder: c.path });
    return json({ ok: true, software: lib });
  }
  return new Response("not found", { status: 404 });
}
