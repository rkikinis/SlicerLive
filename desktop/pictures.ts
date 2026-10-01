// A PICTURE OF THE 3D VIEW, AS A FILE. The page renders the 3D view off screen at any size
// (`__savePicture` in render/moduleserver/live-views.ts, on SceneRenderer.renderToRGBA) and POSTs
// the PNG here; this writes it where Ron finds his downloads. Nothing in the app wrote a picture
// file before this: a screenshot of the window was the only way to get one, at window size, with
// the chrome around it. Ron, 2026-09-20: "I would like to see the 6th right rib in all the
// algorithms" -- a comparison is pictures, and pictures have to be files.
//
// WHERE. Ron's downloads live in iCloud ("Please use the icloud downloads", 2026-09-20), so the
// folder is ~/Library/Mobile Documents/com~apple~CloudDocs/Downloads/ when iCloud Drive is there,
// else ~/Downloads/ -- THE TOP OF DOWNLOADS, no subfolder. It was SlicerAlbula/ inside it for an
// hour, and Ron did not find his picture: "We would like the first time user not to get lost. They
// don't read." A person looks where every download goes; the file's name says what it is. The name
// comes from the caller; anything that is not a plain file name is refused rather than resolved.
//
//   POST /_picture/<name>.png   body: the PNG bytes   -> 200 { path }
import { join } from "jsr:@std/path@1";
import { parseIni } from "../logic/settings.ts";
import { readSettings, resolveSettingsPath } from "./settings-file.ts";

/** The folders a person can choose in Settings › General › Pictures: a name, not a typed path. */
export const PICTURE_PLACES = ["downloads", "desktop", "pictures"] as const;
export type PicturePlace = typeof PICTURE_PLACES[number];

function placeFolder(place: PicturePlace): string {
  const home = Deno.env.get("HOME") ?? ".";
  if (place === "desktop") return join(home, "Desktop");
  if (place === "pictures") return join(home, "Pictures");
  const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Downloads");
  try {
    if (Deno.statSync(icloud).isDirectory) return icloud;
  } catch { /* no iCloud Drive on this machine */ }
  return join(home, "Downloads");
}

/** Where pictures go: `[Pictures] folder=downloads|desktop|pictures` in settings.ini, Downloads by default. */
export async function picturesFolder(galleryRoot?: string): Promise<string> {
  let place: PicturePlace = "downloads";
  try {
    const ini = parseIni(await readSettings(resolveSettingsPath(galleryRoot)));
    const v = ini.get("Pictures")?.get("folder");
    if (v && (PICTURE_PLACES as readonly string[]).includes(v)) place = v as PicturePlace;
  } catch { /* no settings yet */ }
  return placeFolder(place);
}

export function handlePictureRequest(req: Request, galleryRoot?: string): Promise<Response> | null {
  const url = new URL(req.url);
  if (url.pathname === "/_picture" && req.method === "GET") {
    // The folder as it resolves right now, for the Settings dialog to show.
    return picturesFolder(galleryRoot).then((folder) => Response.json({ folder }, { headers: { "cache-control": "no-store" } }));
  }
  if (!url.pathname.startsWith("/_picture/")) return null;
  const name = decodeURIComponent(url.pathname.slice("/_picture/".length));
  // SHOW IN THE FINDER: the notice's button. Only a name inside the pictures folder, never a path
  // (Ron, 2026-09-20: "the downloads folder does not show the screenshot" -- it was in the
  // SlicerAlbula subfolder; the button takes a person there instead of naming it).
  if (req.method === "GET" && url.searchParams.has("reveal")) {
    // A picture's name, or a scene's transport folder (`<name>.albula`, desktop/scenes.ts) --
    // which carries the scene's name as typed, so only the path separators are refused.
    const plain = /^[A-Za-z0-9][A-Za-z0-9 ._()+,-]{0,120}\.png$/.test(name) || (/^[^/\\\0-\x1f]{1,140}\.albula$/.test(name) && !name.includes(".."));
    if (!plain) return Promise.resolve(Response.json({ error: "not a plain picture name" }, { status: 400 }));
    return (async () => {
      const path = join(await picturesFolder(galleryRoot), name);
      try { await Deno.stat(path); } catch { return Response.json({ error: "no such picture" }, { status: 404 }); }
      const cmd = Deno.build.os === "darwin" ? new Deno.Command("open", { args: ["-R", path] })
        : Deno.build.os === "windows" ? new Deno.Command("explorer", { args: ["/select,", path] })
        : new Deno.Command("xdg-open", { args: [await picturesFolder(galleryRoot)] });
      await cmd.output();
      return Response.json({ revealed: path });
    })();
  }
  if (req.method !== "POST") return Promise.resolve(new Response("POST only", { status: 405 }));
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+,-]{0,120}\.png$/.test(name)) {
    return Promise.resolve(Response.json({ error: `not a plain picture name: ${name}` }, { status: 400 }));
  }
  return req.arrayBuffer().then(async (bytes) => {
    const folder = await picturesFolder(galleryRoot);
    await Deno.mkdir(folder, { recursive: true });
    const path = join(folder, name);
    await Deno.writeFile(path, new Uint8Array(bytes));
    return Response.json({ path, bytes: bytes.byteLength });
  });
}
