// Static file server for the gallery checkout, run in a Worker because the
// webview's native run loop blocks the main thread's event loop.
// Receives { root, port } and replies { port } with the port actually bound
// (falls back to the next few ports if the preferred one is taken).
import { serveDir } from "jsr:@std/http@1/file-server";
import { handleSettingsRequest } from "./settings-file.ts";
import { handleHaversackRequest, handleOpenRequest } from "./haversack-proxy.ts";
import { handleDbRequest } from "./db-serve.ts";
import { handleLogRequest, startSessionLog } from "./session-log.ts";
import { handleWindowRequest } from "./window-frame.ts";
import { handlePictureRequest } from "./pictures.ts";
import { handleModelRequest } from "./model-store.ts";

// The application's own code must never be served stale.
//
// `serveDir` sets an ETag and Last-Modified but no Cache-Control, and a client is then free to apply
// heuristic freshness and skip revalidation entirely — which WKWebView does. The effect is that a
// rebuild lands on disk, the webview keeps serving the previous bundle, and a measurement taken
// afterwards silently describes old code. That happened twice while timing a segmentation decode:
// the bundle on disk contained the change, the app did not, and the numbers looked like the
// optimisation had done nothing.
//
// So: no-store for code, and leave everything else alone. Data files — the DICOM series read over
// HTTP from the database — are large, unchanging and worth caching; the observed 2171 MB/s read on a
// warm run is that cache working, and taking it away would make loads slower for no benefit.
const CODE = /\.(js|mjs|html|css|webmanifest|map)$/i;

// The DICOM index must REVALIDATE, and this is not the same case as code above.
//
// ctkDICOM.sql was covered by the "large, unchanging and worth caching" reasoning, and it is not
// unchanging: de-identifying the database rewrote every patient row, and a client holding the old
// copy goes on showing the old names with no sign that it is stale. That is the bundle mistake
// again, in the one file where being stale is a disclosure rather than an inconvenience.
//
// `no-cache` rather than `no-store`: it means "ask before using", not "never keep". The file is
// 37 MB and serveDir already sets an ETag, so an unchanged index costs a 304 and no transfer, while
// a changed one can never be served from a cache.
const MUST_REVALIDATE = /\.(sql|sqlite|db)$/i;

async function serveCode(req: Request, root: string): Promise<Response> {
  const res = await serveDir(req, { fsRoot: root, quiet: true });
  const path = new URL(req.url).pathname;
  const policy = CODE.test(path)
    ? "no-store, must-revalidate"
    : MUST_REVALIDATE.test(path)
    ? "no-cache"
    : null;
  if (!policy) return res;
  const headers = new Headers(res.headers);
  headers.set("cache-control", policy);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * ONLY THE APP'S OWN PAGE AND THIS MACHINE. The server answered any web page: a site open in Safari or Chrome
 * while Albula ran could register "/" as a database and switch to it, write into the database folder, or start
 * the segmentation server (simple POSTs need no permission), and a DNS-rebinding page could read the answers
 * (code review 2026-09-24, A10). A request must be addressed to this machine on this port (Host); when it
 * carries an Origin it must be the app's own; and when the browser says it came from another site
 * (Sec-Fetch-Site: cross-site or same-site -- sent on an <img>, a link or a script, which carry no Origin: the
 * critic reached /_open and /_picture that way) it is refused. Tools on this machine (curl, the scripts) send
 * neither header and are served as before.
 */
export function refuseForeign(req: Request, port: number): Response | null {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const ours = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!ours.includes(host)) return new Response("not for this host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin !== null && !ours.map((h) => `http://${h}`).includes(origin.toLowerCase())) return new Response("not from this app", { status: 403 });
  const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return new Response("not from this app", { status: 403 });
  return null;
}

self.onmessage = (e: MessageEvent<{ root: string; port: number; windowFile?: string }>) => {
  const { root, port, windowFile } = e.data;
  const log = startSessionLog(`serving ${root}`);
  if (log) console.log(`session log: ${log}`);
  for (let p = port; p < port + 10; p++) {
    let listening = p;
    try {
      Deno.serve(
        {
          port: p,
          hostname: "127.0.0.1",
          onListen: (addr) => { listening = addr.port; (self as unknown as Worker).postMessage({ port: addr.port }); },
        },
        // Three dynamic routes; everything else is the static gallery.
        //   /_settings    the single persistence store (settings-file.ts)
        //   /_db, /_db/*  DICOM databases the user registered, by setting rather than by symlink
        //   /_haversack/* segmentation server, proxied so the page needs no CORS and holds no token
        //   /_open        a paper URL in the default browser, which the webview cannot do itself
        //   /_log         one session's status messages, so they survive being overwritten
        //   /_picture/*   a PNG of the 3D view the page rendered, saved where Ron's downloads go
        //   /_window      where the native window is and how big, so a Dock start puts it back
        //   /_models/*    trained models the page runs itself (nnLive), fetched once and kept (model-store.ts)
        async (req) =>
          refuseForeign(req, listening) ??
            (await handleSettingsRequest(req, root)) ??
            (await handleDbRequest(req, root)) ??
            (await handleHaversackRequest(req)) ??
            (await handleOpenRequest(req)) ??
            (await handleLogRequest(req)) ??
            // Only the native app passes a file; everyone else gets 404 (desktop/window-frame.ts).
            (await handleWindowRequest(req, windowFile)) ??
            (await handlePictureRequest(req, root)) ??
            (await handleModelRequest(req)) ??
            await serveCode(req, root),
      );
      return;
    } catch (err) {
      if (!(err instanceof Deno.errors.AddrInUse)) throw err;
    }
  }
  throw new Error(`no free port in ${port}..${port + 9}`);
};
