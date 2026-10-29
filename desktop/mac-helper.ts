// THE SERVER'S WAY TO THE MAC'S OWN SERVICES for sharing a database (desktop/native/albula-mac.swift; the workspace's
// DATABASE-SHARING.md): Touch ID or the login password, and Bonjour. The one place that runs the helper;
// everything else calls these functions. Where it is: beside the app's executable in a bundle (Contents/MacOS), else
// desktop/build/ (built by make-app.ts). Absent (not a Mac, or built without Apple's compiler): `helperPath()` is
// undefined and sharing says it is not available on this build.
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

let cached: string | null | undefined;
/** The helper's path, or undefined when this build has none. */
export function helperPath(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const here = dirname(fromFileUrl(import.meta.url));
  for (const p of [join(dirname(Deno.execPath()), "albula-mac"), join(here, "build", "albula-mac")]) {
    try { if (Deno.statSync(p).isFile) { cached = p; return p; } } catch { /* next */ }
  }
  cached = null;
  return undefined;
}

async function run(args: string[], stdin?: Uint8Array): Promise<{ code: number; stdout: Uint8Array }> {
  const h = helperPath();
  if (!h) throw new Error("this build of Albula has no helper for the Mac's own services (Touch ID, the network)");
  const p = new Deno.Command(h, { args, stdin: stdin ? "piped" : "null", stdout: "piped", stderr: "null" }).spawn();
  if (stdin) { const w = p.stdin.getWriter(); await w.write(stdin); await w.close(); }
  const o = await p.output();
  return { code: o.code, stdout: o.stdout };
}

/** What this Mac can use to confirm its owner. Shows nothing. */
export async function canConfirmOwner(): Promise<{ touchID: boolean; owner: boolean }> {
  const r = await run(["can-auth"]);
  return JSON.parse(new TextDecoder().decode(r.stdout));
}

/** Asks the person at this Mac to confirm with Touch ID (or the login password). `reason` completes macOS's sentence
 *  "SlicerAlbula is trying to …"; it is shown in the system's own dialog, which goes away unanswered after `seconds` (a no). */
export async function confirmOwner(reason: string, seconds = 60): Promise<{ ok: boolean; why?: string }> {
  const r = await run(["auth", reason, String(seconds)]);
  try { return JSON.parse(new TextDecoder().decode(r.stdout)); } catch { return { ok: false, why: "no answer from the Mac" }; }
}

/** A long-running helper that ends when we close its standard input. */
function longRunning(args: string[], onLine?: (o: Record<string, unknown>) => void): { stop: () => void; ended: () => boolean } {
  const h = helperPath();
  if (!h) throw new Error("this build of Albula has no helper for the Mac's own services");
  const p = new Deno.Command(h, { args, stdin: "piped", stdout: "piped", stderr: "null" }).spawn();
  const w = p.stdin.getWriter();
  let over = false;
  p.status.then(() => { over = true; }).catch(() => { over = true; });
  if (onLine) (async () => {
    let buf = "";
    for await (const chunk of p.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { onLine(JSON.parse(line)); } catch { /* not ours */ } }
    }
  })().catch(() => {});
  else p.stdout.cancel().catch(() => {});
  return { stop: () => { w.close().catch(() => {}); }, ended: () => over };
}

/** Announces this Mac on one network interface (Bonjour, _albula._tcp) until stop(). */
export function advertise(name: string, port: number, txt: Record<string, string>, iface: string): { stop: () => void; ended: () => boolean } {
  return longRunning(["advertise", name, String(port), JSON.stringify(txt), iface]);
}

export interface SeenMac { event: "up" | "down"; name: string; host?: string; port?: number; txt?: Record<string, string> }
/** Reports Macs that announce shared databases on this network, as they come and go, until stop(). */
export function browse(onEvent: (e: SeenMac) => void): { stop: () => void } {
  return longRunning(["browse"], (o) => onEvent(o as unknown as SeenMac));
}
