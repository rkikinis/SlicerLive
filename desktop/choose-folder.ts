import { basename } from "jsr:@std/path@1";
// A FOLDER CHOSEN BY THE PERSON, in macOS's own dialog -- for a page that cannot ask for one.
//
// Load / Save's "DICOM folder…" did nothing in the application: it needs the browser's folder picker
// (showDirectoryPicker), which the Mac web view does not have, and the bundled web view's file chooser takes files
// only. A resident's scans are a folder (a disc, a stick, an export), so the server asks macOS: `osascript` shows the
// standard "choose folder" dialog and prints the path. No Apple Events permission is involved (the script talks to
// no other application). The page never sends a path; it gets a TOKEN for the folder the person chose, and the
// routes that read a folder (desktop/db-serve.ts: view its files, add them to a database, register it as a database)
// take only tokens -- so these routes cannot be made to read a folder nobody chose. (The older PUT /_db {id, path},
// for hand registration, still takes a path; the description route writes only where a database already is.)

export interface ChosenFolder { token: string; path: string; name: string }

const chosen = new Map<string, ChosenFolder>();

/** Shows the dialog; undefined when the person cancels. `prompt` is the dialog's line of text. */
export async function chooseFolder(prompt: string): Promise<ChosenFolder | undefined> {
  const safe = prompt.replace(/["\\]/g, "").slice(0, 200);
  const { code, stdout, stderr } = await new Deno.Command("/usr/bin/osascript", {
    args: ["-e", "tell me to activate", "-e", `POSIX path of (choose folder with prompt "${safe}")`],
    stdout: "piped", stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) {
    if (/-128|User canceled/i.test(err)) return undefined;
    throw new Error(`the folder dialog failed: ${err.trim()}`);
  }
  const path = new TextDecoder().decode(stdout).trim().replace(/\/+$/, "");
  return remember(path);
}

// FILES OR FOLDERS IN ONE PANEL (Ron, 2026-11-07: "can we have one button for both? I can select a file or folder once a
// finder window comes up"; tried with him the same day). macOS's own open panel (NSOpenPanel) takes files and folders
// together, which neither AppleScript's "choose file" nor "choose folder" does; JavaScript for Automation reaches it. The
// process must be a REGULAR app first: as a background process the panel closed at the first click on a file (Ron: "when I
// try to click a file the panel closes"). Windows' and Linux's standard dialogs pick files OR a folder, never both
// (FOS_PICKFOLDERS; GTK's SELECT_FOLDER; the portal's `directory`), so this is macOS only and the server offers it there only.
const PANEL = `ObjC.import("AppKit");
function run(argv) {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  app.activateIgnoringOtherApps(true);
  const p = $.NSOpenPanel.openPanel;
  p.canChooseFiles = true; p.canChooseDirectories = true; p.allowsMultipleSelection = true;
  p.message = argv[0] || ""; p.prompt = "Open";
  if (p.runModal !== $.NSModalResponseOK) return "";
  const urls = p.URLs, out = [];
  for (let i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  return out.join("\\n");
}`;

/** Files the person chose, by token; only these are ever served (db-serve's GET /_db/_files/<token>/<n>). */
export interface ChosenFiles { token: string; paths: string[]; names: string[] }
const chosenFileSets = new Map<string, ChosenFiles>();
export const chosenFiles = (token: string): ChosenFiles | undefined => chosenFileSets.get(token);

/** The one panel: folders come back as chosen folders (the routes that read a folder take their tokens), files as one set. */
export async function chooseFilesOrFolders(prompt: string): Promise<{ folders: ChosenFolder[]; files: ChosenFiles | null } | undefined> {
  const { code, stdout, stderr } = await new Deno.Command("/usr/bin/osascript", {
    args: ["-l", "JavaScript", "-e", PANEL, prompt.slice(0, 200)], stdout: "piped", stderr: "piped",
  }).output();
  if (code !== 0) throw new Error(`the open panel failed: ${new TextDecoder().decode(stderr).trim()}`);
  const paths = new TextDecoder().decode(stdout).split("\n").map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!paths.length) return undefined;
  const folders: ChosenFolder[] = [], files: string[] = [];
  for (const p of paths) ((await Deno.stat(p).catch(() => null))?.isDirectory ? folders.push(remember(p)) : files.push(p));
  let set: ChosenFiles | null = null;
  if (files.length) { set = { token: crypto.randomUUID(), paths: files, names: files.map((f) => basename(f)) }; chosenFileSets.set(set.token, set); }
  return { folders, files: set };
}

/** A folder the person chose by other means (a test, the desktop shell). */
export function remember(path: string): ChosenFolder {
  for (const c of chosen.values()) if (c.path === path) return c;
  // The folder's own name, the system's way (the critic, 2026-10-13, A8: on Windows it was the whole path).
  const c = { token: crypto.randomUUID(), path, name: basename(path) || path };
  chosen.set(c.token, c);
  return c;
}

export const chosenFolder = (token: string): ChosenFolder | undefined => chosen.get(token);
