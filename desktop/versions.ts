// THE VERSIONS THE APP BUILDERS NEED, FROM WHERE THEY ARE DECIDED -- not written again in each builder (critic,
// Contents/docs/qa/2026-09-28-dependencies.md in the workspace, findings 7 and 13).
//
//  - Albula's own version: the workspace's /VERSION (the build stamp reads it too). SlicerLive used on its own, without
//    the workspace around it, has no such file and says "unversioned".
//  - webview: deno.jsonc's "jsr:@webview/webview" line. The native library the app ships comes from the same release,
//    so the JavaScript binding and the library cannot drift apart; each file is checked against the checksum below.
//    Before 2026-09-28 the library was fetched once and kept under a fixed name with no check, so a version change in
//    the binding would have shipped the old library.
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const here = dirname(fromFileUrl(import.meta.url));
const repo = join(here, "..");

/** Albula's version from the workspace's /VERSION, or "unversioned" outside the workspace. */
export function albulaVersion(): string {
  try { return Deno.readTextFileSync(join(repo, "..", "..", "..", "VERSION")).trim() || "unversioned"; } catch { return "unversioned"; }
}

/** The webview version deno.jsonc pins ("0.9.0"). */
export function webviewVersion(): string {
  const text = Deno.readTextFileSync(join(repo, "deno.jsonc"));
  // deno.jsonc keeps its comments on their own lines, so dropping those leaves plain JSON.
  const json = JSON.parse(text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));
  const m = /@webview\/webview@([0-9][0-9A-Za-z.+-]*)$/.exec(String(json.imports?.["jsr:@webview/webview"] ?? ""));
  if (!m) throw new Error('deno.jsonc does not pin "jsr:@webview/webview" to a version');
  return m[1];
}

export const webviewRelease = (v = webviewVersion()) => `https://github.com/webview/webview_deno/releases/download/${v}`;

/** sha256 of each native file of each webview release we ship, checked 2026-09-28 against the release's own downloads
 *  (the aarch64 library cached here since 2026-09-03 was identical). A new version needs its line here: the builder
 *  refuses a file it has no checksum for. */
const WEBVIEW_SHA256: Record<string, Record<string, string>> = {
  "0.9.0": {
    "libwebview.aarch64.dylib": "1bd58e657fb0a3d1e57b365720cb9c1a1b5cc46749f3c7edd4e06a815f6aa875",
    "libwebview.x86_64.dylib": "2e2fd6f7654bcddd963fca632c152fe4d41bbc9327100ebe4b8251c379180b41",
    "webview.dll": "fec1e559a6ff67e695416b5cf42221eb319ea3ccb6719c05dbd2ae01a3c9810a",
    "WebView2Loader.dll": "184574b9c36b044888644fc1f2b19176e0e76ccc3ddd2f0a5f0d618c88661f86",
  },
};

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One native webview file for the pinned version: kept in `cacheDir` under the version's own name, fetched from the
 * release when missing, and checked against its recorded checksum either way. Returns the file's path.
 */
export async function webviewNativeFile(name: string, cacheDir: string): Promise<string> {
  const v = webviewVersion();
  const want = WEBVIEW_SHA256[v]?.[name];
  if (!want) throw new Error(`no checksum recorded for webview ${v} ${name} -- add it to desktop/versions.ts after checking the release`);
  const path = join(cacheDir, `${v}-${name}`);
  let bytes: Uint8Array;
  try { bytes = Deno.readFileSync(path); } catch {
    const r = await fetch(`${webviewRelease(v)}/${name}`);
    if (!r.ok) throw new Error(`webview ${v} ${name}: download failed (${r.status})`);
    bytes = new Uint8Array(await r.arrayBuffer());
    Deno.writeFileSync(path, bytes);
  }
  const got = await sha256(bytes);
  if (got !== want) throw new Error(`webview ${v} ${name}: checksum ${got.slice(0, 16)}… is not the recorded ${want.slice(0, 16)}… -- not shipping it`);
  return path;
}
