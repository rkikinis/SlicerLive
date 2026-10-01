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

/** A folder the person chose by other means (a test, the desktop shell). */
export function remember(path: string): ChosenFolder {
  for (const c of chosen.values()) if (c.path === path) return c;
  const c = { token: crypto.randomUUID(), path, name: path.slice(path.lastIndexOf("/") + 1) || path };
  chosen.set(c.token, c);
  return c;
}

export const chosenFolder = (token: string): ChosenFolder | undefined => chosen.get(token);
