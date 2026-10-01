// THE EXTENSIONS' HOOKS, FOR A PROGRAM THAT READS DATA OUTSIDE THE PAGE (the copy writer and its sweep, the workspace's
// tools): each extension's `hooks` entry (its DICOM interpreters, its BIDS kinds) imported by path from the workspace's
// list, Contents/extensions/extensions.json (Contents/docs/EXTENSIONS.md). Core names no extension: the list is data,
// read at run time. Without a list (this repository on its own) nothing is loaded and core reads what it reads.
// ALBULA_EXTENSIONS=<path to a list> points elsewhere; ALBULA_EXTENSIONS=none loads nothing.
// The page loads the same hooks through its generated entry (the rebuild).
// No jsr imports: the copy writer imports this file, and its fingerprint covers only local files (make-copy-code.ts).
const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));
const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
export const DEFAULT_LIST = new URL("../../../extensions/extensions.json", import.meta.url).pathname;

export interface LoadedHooks { list: string; loaded: string[] }

/** The hooks entries of the extensions that are on: their files, in the list's order. */
export function hookFiles(list = Deno.env.get("ALBULA_EXTENSIONS") ?? DEFAULT_LIST): string[] {
  if (list === "none") return [];
  let text: string;
  try { text = Deno.readTextFileSync(list); } catch { return []; }
  let parsed: { extensions?: { path: string; on: boolean }[] };
  try { parsed = JSON.parse(text); } catch { console.warn(`extension list ${list} is not JSON: no extensions loaded`); return []; }
  if (!Array.isArray(parsed.extensions)) { console.warn(`${list} is not an Albula extension list: no extensions loaded`); return []; }
  const out: string[] = [];
  for (const e of parsed.extensions) {
    if (!e.on) continue;
    const dir = join(dirname(list), e.path);
    const m = JSON.parse(Deno.readTextFileSync(join(dir, "extension.json"))) as { entries?: { hooks?: string } };
    if (m.entries?.hooks) out.push(join(dir, m.entries.hooks));
  }
  return out;
}

const done = new Map<string, Promise<LoadedHooks>>();
/** Import every hooks entry of a list once (per list); safe to call from several places. */
export function loadExtensionHooks(list = Deno.env.get("ALBULA_EXTENSIONS") ?? DEFAULT_LIST): Promise<LoadedHooks> {
  if (done.has(list)) return done.get(list)!;
  const p = (async () => {
    const files = hookFiles(list);
    for (const f of files) await import(`file://${f}`);
    return { list, loaded: files };
  })();
  done.set(list, p);
  return p;
}
