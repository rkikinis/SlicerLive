// Two dynamic routes the AI segmentations panel needs from the native side.
//
// `/_haversack/*` -> haversack's REST server at 127.0.0.1:<port>/v1/*
//
// WHY PROXY RATHER THAN FETCH IT FROM THE PAGE. Two reasons, and either alone would be enough.
//
// The page is served from 127.0.0.1:4180 and haversack listens on 8790, so a direct fetch is
// cross-origin — and haversack sends no `Access-Control-Allow-Origin`, which was checked rather
// than assumed: `curl -i -H "Origin: http://127.0.0.1:4180" .../v1/health` returns 200 with no CORS
// header at all, so a browser would refuse the response.
//
// And its compute endpoints need a bearer token, which haversack writes to a file readable only by
// the user. A page must never hold that: anything the page holds is one XSS away from being
// somebody else's, and a token that can spend GPU time is worth having. The server reads the file
// and attaches the header, so the token stays on this side of the boundary and the page never sees
// it.
//
// `/_open?url=` -> the URL in the DEFAULT BROWSER, not in the webview.
//
// Ron wants the paper for a network to open "in the default browser". The webview cannot do it:
// window.open is a silent no-op there, because the bundled libwebview implements only
// `webView:runOpenPanelWithParameters:` on its UI delegate. So the native side shells out. Only
// https is accepted, and the URL is passed as an argument rather than through a shell, so there is
// nothing to inject into and no way to reach a local file.
import { join } from "jsr:@std/path@1";

/** Where haversack listens by default. Overridable, because a user may run it elsewhere. */
/**
 * 8790 unless HAVERSACK_PORT says otherwise. The variable exists for one purpose: running the
 * application against a second haversack on another port -- a new release under test beside the
 * one in use -- without touching the one in use (docs/DEPENDING-ON-OTHER-PEOPLE.md, "test the
 * upgrade against the surface you use").
 */
const DEFAULT_PORT = Number((globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get("HAVERSACK_PORT")) || 8790;

/**
 * The token from haversack's token file.
 *
 * The file is JSON, not a bare token:
 *
 *   {"token": "...", "pid": 62831, "host": "127.0.0.1", "port": 8790, "started": 1788522183.69}
 *
 * The first version of this read the whole file and sent it as the bearer token, so every compute
 * request came back "this server requires a bearer token for anything beyond cached reads" -- a
 * true statement about a request that did carry a token, just not one that parsed. `port` is
 * checked against the port being called, because a file left behind by a server that has since
 * moved is worse than no file: it produces the same opaque rejection.
 */
function tokenFor(port: number): { token: string | null; reason: "ok" | "missing" | "unreadable" | "wrong-port" } {
  const home = Deno.env.get("HOME");
  if (!home) return { token: null, reason: "missing" };
  let raw: string;
  try {
    raw = Deno.readTextFileSync(join(home, ".cache", "haversack", "serve", `${port}.token`));
  } catch {
    return { token: null, reason: "missing" };   // --no-token, or no server: let haversack decide
  }
  try {
    const j = JSON.parse(raw) as { token?: unknown; port?: unknown };
    if (typeof j.port === "number" && j.port !== port) return { token: null, reason: "wrong-port" };
    return typeof j.token === "string" && j.token ? { token: j.token, reason: "ok" } : { token: null, reason: "unreadable" };
  } catch {
    // Older servers may have written the bare token. Accept that rather than fail on a format that
    // once worked -- but only if it looks like one line of token and not like a truncated document.
    const line = raw.trim();
    return /^[A-Za-z0-9._~-]{16,}$/.test(line) ? { token: line, reason: "ok" } : { token: null, reason: "unreadable" };
  }
}

/** The command a user would type. Shown when the server is not answering, so the panel can say it. */
/**
 * PINNED, DELIBERATELY. Without a version this takes whatever is on Mike's default branch at the
 * moment it runs, so his ordinary work lands in this application on his schedule -- and any bug
 * reported back names a target that has already moved. Ron, 2026-09-10: "Keeping track of version
 * numbers or release numbers of the underlying packages make sense." He also had word that a large
 * change upstream is coming, which turns this from untidy into urgent.
 *
 * v0.6.1 was the pin from 2026-09-10 to 2026-09-14. v0.12.0 (released 2026-09-13) is the move Ron
 * asked for after Mike's note ("lots of stuff has changed"): task names carry their catalog
 * (`ts.v2:total_fast`), attribution is per task, a segments index, the body-envelope crop off by
 * default, CADS, and `--allow-transpose` on serve (which the coronary model needs). It requires
 * Python 3.12, so the command says so. docs/DEPENDING-ON-OTHER-PEOPLE.md has the review.
 *
 * v0.15.0 (released 2026-09-27) since 2026-09-28, Ron: "Yes" to the move. What it brings: MOOSE
 * models fed the orientation they were trained in (0.14.0; the rib model had left and right swapped
 * and the backs of the ribs missing), TotalSegmentator v3 as `ts.v3:total` / `_fast` / `_fastest`
 * (0.13.0), and a round of server fixes (0.15.0). The task and job records Albula reads are the same
 * shape as 0.12.0's (checked field by field on a spare port). FastSurfer is in the core install since
 * 0.14.0, so the `fastsurfer` extra is gone from the command.
 */
export const HAVERSACK_VERSION = "v0.15.0";
/** The extras the application installs haversack with. One place: the start command and the printed one.
 *  `synthstrip` since 2026-10-04 (the diffusion extension's tracking rule 3 asks for SynthStrip's brain mask), but ONLY
 *  on a Mac with Apple's command line developer tools: the extra builds `surfa` from source (PyPI has no wheel for it),
 *  and on a Mac without a compiler that build fails and takes the whole server with it -- AI segmentation included
 *  (critic, 2026-10-04, finding 1). Without the tools the server starts without SynthStrip, and the Diffusion module
 *  says it took the brain from the diffusion scan. */
const developerTools = (() => {
  try { return new Deno.Command("/usr/bin/xcode-select", { args: ["-p"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; }
})();
const HAVERSACK_EXTRAS = developerTools ? "serve,remote,synthstrip" : "serve,remote";
/** Ports with a start in flight, so a second click does not start a second server. */
const starting = new Set<number>();
/** `uvx` where the installers put it -- the Finder launches the app with a bare PATH. */
function findUvx(): string | null {
  const home = Deno.env.get("HOME") ?? "";
  for (const c of [`${home}/.local/bin/uvx`, `${home}/miniconda3/bin/uvx`, `${home}/anaconda3/bin/uvx`, "/opt/homebrew/bin/uvx", "/usr/local/bin/uvx"]) {
    try { if (Deno.statSync(c).isFile) return c; } catch { /* next */ }
  }
  return null;
}
export const START_COMMAND =
  `uvx --python 3.12 --from "haversack[${HAVERSACK_EXTRAS}] @ git+https://github.com/mhalle/haversack@${HAVERSACK_VERSION}" haversack serve --port 8790 --allow-transpose`;

/**
 * Forward one `/_haversack/...` request, or return null if this is not one.
 *
 * A connection failure is reported as 503 with a JSON body naming the command to start the server,
 * because "not running" is the normal state -- Ron: "in general lets assume that people will do it
 * at runtime" -- and a panel that says what to type is more use than a stack trace.
 */
export async function handleHaversackRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/_haversack/")) return null;

  // `_status` is OURS, not forwarded: it answers "is there a server, and can we authenticate to
  // it", which is the question a user actually has. Ron hit the opposite -- a bearer-token refusal
  // with "no indication whether something is running" -- and the panel could not tell him, because
  // health() needs no token and so succeeds even when the token is unusable. The two facts have to
  // be reported together or the failure is unreadable.
  // START IT FROM HERE. Ron, 2026-09-15, after an OS upgrade's reboots: "haversack seems to be
  // down" -- the server was a process somebody had started by hand, and nothing in the
  // application starts it. This route runs the same command the panel prints, as a child of the
  // application (so it ends when the application quits), with its output in
  // ~/.config/slicerlive/haversack.log; the panel then polls _status until the first health
  // answer. `uvx` is looked for where the installers put it, since an app launched from the Finder
  // has a bare PATH.
  if (url.pathname === "/_haversack/_start" && req.method === "POST") {
    const port = Number(url.searchParams.get("_port") ?? DEFAULT_PORT) || DEFAULT_PORT;
    if (starting.has(port)) return Response.json({ started: true, note: "already starting" });
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/v1/health`).catch(() => null);
      if (probe?.ok) return Response.json({ started: false, note: "already running" });
    } catch { /* not running */ }
    const uvx = findUvx();
    if (!uvx) return Response.json({ started: false, error: "uvx was not found (looked in ~/.local/bin, ~/miniconda3/bin, /opt/homebrew/bin, /usr/local/bin). Install uv, or start the server by hand:\n" + START_COMMAND }, { status: 500 });
    const home = Deno.env.get("HOME") ?? "";
    const logDir = `${home}/.config/slicerlive`;
    try { await Deno.mkdir(logDir, { recursive: true }); } catch { /* exists */ }
    const logPath = `${logDir}/haversack.log`;
    try {
      const log = await Deno.open(logPath, { write: true, create: true, append: true });
      const cmd = new Deno.Command(uvx, {
        args: ["--python", "3.12", "--from", `haversack[${HAVERSACK_EXTRAS}] @ git+https://github.com/mhalle/haversack@${HAVERSACK_VERSION}`, "haversack", "serve", "--port", String(port), "--allow-transpose"],
        stdout: "piped", stderr: "piped", stdin: "null",
        env: { ...Deno.env.toObject(), PATH: `${home}/.local/bin:${home}/miniconda3/bin:/opt/homebrew/bin:/usr/local/bin:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}` },
      });
      const child = cmd.spawn();
      starting.add(port);
      // Both streams to the log file, and the child forgotten once it ends (a crash on start is
      // visible in the log; the panel's poll will time out and say where to look).
      const pump = async (r: ReadableStream<Uint8Array>) => { for await (const chunk of r) await log.write(chunk); };
      void Promise.all([pump(child.stdout), pump(child.stderr)]).finally(() => { log.close(); starting.delete(port); });
      void child.status.then(() => starting.delete(port));
      return Response.json({ started: true, log: logPath, command: START_COMMAND });
    } catch (e) {
      return Response.json({ started: false, error: `could not start it: ${(e as Error).message}` }, { status: 500 });
    }
  }

  if (url.pathname === "/_haversack/_status") {
    const port = Number(url.searchParams.get("_port") ?? DEFAULT_PORT) || DEFAULT_PORT;
    const { token, reason } = tokenFor(port);
    let reachable = false;
    let health: unknown = undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      reachable = res.ok;
      health = res.ok ? await res.json() : undefined;
    } catch { /* not reachable */ }
    return Response.json({
      reachable,
      port,
      token: reason,
      hasToken: !!token,
      health,
      // THE VERSION THIS BUILD WAS TESTED WITH, so the panel can say when the running server is another one (critic,
      // qa/2026-09-28-dependencies.md, finding 4; Ron: "yes"). A server started by hand, or left running from before
      // an update, keeps answering; the start route will not replace it.
      expected: HAVERSACK_VERSION.replace(/^v/, ""),
      start: reachable ? undefined : START_COMMAND,
    }, { headers: { "cache-control": "no-store" } });
  }

  const port = Number(url.searchParams.get("_port") ?? DEFAULT_PORT) || DEFAULT_PORT;
  const rest = url.pathname.slice("/_haversack/".length);
  const params = new URLSearchParams(url.searchParams);
  params.delete("_port");
  const target = `http://127.0.0.1:${port}/v1/${rest}${params.toString() ? "?" + params : ""}`;

  const headers = new Headers();
  for (const h of ["content-type", "accept", "range"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const { token } = tokenFor(port);
  if (token) headers.set("authorization", `Bearer ${token}`);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
    // Pass the body through unbuffered: a labels.seg.nrrd is megabytes and there is no reason for
    // this process to hold one in memory.
    const out = new Headers(upstream.headers);
    out.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch (e) {
    return Response.json({
      error: "haversack is not answering",
      port,
      detail: String(e),
      start: START_COMMAND,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

/**
 * Open an https URL in the user's browser.
 *
 * https only. Not because http would break anything here, but because this route hands a URL to the
 * operating system on a page's say-so, and the narrowest thing that satisfies the requirement -- a
 * DOI link -- is the right width. `Deno.Command` takes an argument array, so the URL never reaches
 * a shell.
 */
export async function handleOpenRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname !== "/_open") return null;

  const target = url.searchParams.get("url") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: "not a URL" }, { status: 400 });
  }
  if (parsed.protocol !== "https:") {
    return Response.json({ error: "only https is opened", got: parsed.protocol }, { status: 400 });
  }

  const cmd = Deno.build.os === "darwin" ? "open" : Deno.build.os === "windows" ? "cmd" : "xdg-open";
  const args = Deno.build.os === "windows" ? ["/c", "start", "", parsed.href] : [parsed.href];
  try {
    const out = await new Deno.Command(cmd, { args, stdout: "null", stderr: "piped" }).output();
    if (!out.success) {
      return Response.json({ error: "the browser could not be opened", detail: new TextDecoder().decode(out.stderr) }, { status: 500 });
    }
    return Response.json({ opened: parsed.href });
  } catch (e) {
    return Response.json({ error: "the browser could not be opened", detail: String(e) }, { status: 500 });
  }
}
