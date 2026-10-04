// The ONE place SlicerLive keeps anything that must survive a session.
//
// Modeled on how 3D Slicer does it: a single human-readable INI per user, sectioned by module,
// holding preferences and POINTERS to data (never data itself) --
//
//     ~/.config/slicer.org/Slicer.ini      [General] [Cache] [DICOM] [ColorizeVolume] ...
//
// Slicer keeps that under ~/.config even on macOS, and this follows it rather than inventing a
// second convention. Older Slicer versioned the file per revision (Slicer-27264.ini), so settings
// silently did not survive an upgrade; one stable filename avoids repeating that.
//
// WHY A FILE AND NOT localStorage. SlicerLive had four persistence mechanisms in three places --
// colorize state in localStorage, the DICOM directory handle in IndexedDB, window geometry in a
// dotfile beside the launcher, the provenance author in another dotfile. None was inspectable or
// editable, and localStorage is per-ORIGIN, so nothing carried between the native app and the
// browser build. A plain INI is readable by the page (through the endpoint below), by the launcher
// shell scripts, and by the Slicer Python module via configparser -- one file all three can share.
//
// TWO LOCATIONS, FOLDER FIRST. A settings.ini beside the SlicerLive folder travels with it, which is
// the point of keeping that folder self-contained and movable; ~/.config/slicerlive/settings.ini is
// the per-user default, which survives moving or reinstalling the folder and gives two people on one
// machine their own settings. The folder copy wins WHEN IT EXISTS, and is never created
// automatically -- creating an empty settings.ini in the SlicerLive folder is how you opt in to
// carrying settings with the folder, and deleting it is how you opt back out.
//
// The one thing that CANNOT live here is the picked DICOM directory: a FileSystemDirectoryHandle is
// structured-cloneable but not serializable to text, so it stays in IndexedDB. Its label is mirrored
// here so the UI can still say which database it would reopen.

// SLICERLIVE_CONFIG_DIR redirects the per-user store. Tests must never write the real one -- it is
// the user's only copy of their preferences.
import { formatIni, parseIni } from "../logic/settings.ts";
const CONFIG_DIR = Deno.env.get("SLICERLIVE_CONFIG_DIR") ?? `${Deno.env.get("HOME")}/.config/slicerlive`;
const USER_SETTINGS = `${CONFIG_DIR}/settings.ini`;
const FILE_NAME = "settings.ini";

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where settings are read from and written to, given the gallery being served.
 *
 * The SlicerLive folder is found by walking up from the gallery (…/SlicerLive/src/live), checking
 * each level for a settings.ini. Only an EXISTING file counts: absent one, the per-user path is
 * used, so nothing is ever silently created inside the user's folder.
 */
export function resolveSettingsPath(galleryRoot?: string): string {
  if (galleryRoot) {
    let dir = galleryRoot.replace(/\/+$/, "");
    for (let up = 0; up < 3 && dir && dir !== "/"; up++) {
      const candidate = `${dir}/${FILE_NAME}`;
      if (exists(candidate)) return candidate;
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return USER_SETTINGS;
}

/** The per-user path, used when no folder-local settings.ini exists. */
export function userSettingsPath(): string {
  return USER_SETTINGS;
}

/** Read the settings file. Missing file is not an error -- it just means nothing is stored yet. */
export async function readSettings(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "";
    throw e;
  }
}

/**
 * Replace the settings file.
 *
 * Written to a temporary file and renamed, so an interrupted write cannot leave a half-file: this is
 * the only copy of the user's preferences, and rename is atomic within a filesystem.
 */
export async function writeSettings(path: string, text: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

/**
 * THE SECTIONS THE SERVER OWNS are kept as they are on disk when the page writes the file. The page reads the settings
 * once, when it starts, and writes its whole copy back; the database list ([Database]) is written by the server alone
 * (a database made, added or chosen), and the page's older copy erased it: the test cases registered on 2026-10-01
 * vanished from the list, and only the working database was left (Ron, 2026-10-02: "where is the data base that I have
 * used for the past month? I am confused").
 */
export const SERVER_SECTIONS = ["Database"];

async function keepServerSections(path: string, text: string): Promise<string> {
  const incoming = parseIni(text);
  const disk = parseIni(await readSettings(path).catch(() => ""));
  const same = (sec: string) => JSON.stringify([...(incoming.get(sec) ?? new Map())]) === JSON.stringify([...(disk.get(sec) ?? new Map())]);
  if (SERVER_SECTIONS.every(same)) return text;          // the usual case: written as the page sent it
  for (const sec of SERVER_SECTIONS) {
    const d = disk.get(sec);
    if (d) incoming.set(sec, d); else incoming.delete(sec);
  }
  return formatIni(incoming);
}

/**
 * Serve GET/PUT for the settings file; null for any other request, so the caller serves it.
 *
 * The path is resolved per REQUEST, not once at startup, so creating or deleting a folder-local
 * settings.ini takes effect without relaunching the app.
 */
export async function handleSettingsRequest(req: Request, galleryRoot?: string): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== "/_settings") return null;
  const path = resolveSettingsPath(galleryRoot);

  if (req.method === "GET") {
    return new Response(await readSettings(path), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-settings-path": path,        // so the UI can say WHERE its settings live
      },
    });
  }
  if (req.method === "PUT") {
    const text = await req.text();
    // A settings file is small by nature; a large body means something is wrong upstream, and this
    // endpoint can write anywhere the app can, so it refuses rather than obliges.
    if (text.length > 1_000_000) return new Response("settings too large", { status: 413 });
    await writeSettings(path, await keepServerSections(path, text));
    return new Response(null, { status: 204, headers: { "x-settings-path": path } });
  }
  return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } });
}
