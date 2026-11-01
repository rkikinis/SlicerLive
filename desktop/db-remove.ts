// REMOVING A DATABASE (Ron, 2026-10-26: "remove should offer the option to remove from the app or remove and delete").
// Two ways, both from Load / Save's Databases section (the Databases window until 2026-10-29):
//   - from the list only (its In use switch): the folder stays where it is, untouched, and its row stays, switched off;
//   - and its folder to the Trash: macOS's own Trash, so Finder's Put Back works until the Trash is emptied. Nothing is
//     deleted for good here (CLAUDE.md: the Trash over rm).
// The records beside the folder (provenance.sqlite: its scenes, collection and license, what was made from what) are left
// as they are, as a moved database leaves them (package-open.ts carryRecords): a record, and the way back.
// The route is POST /_db/_remove in db-serve.ts; the critic's round: Contents/docs/qa/2026-10-26-database-remove.md.
import { isInside, placeOf } from "./paths.ts";

export interface RemovableDb { id: string; path: string; exists: boolean }

/** Why this folder may NOT go to the Trash, or undefined when it may: it has to be reachable, not the home folder or the
 *  folder that holds every database or a folder above either, and it may not hold another listed database or lie inside
 *  one (one Trash would take part of another). Removing from the list alone is always allowed. */
export async function trashRefusal(d: RemovableDb, registered: RemovableDb[], guarded: string[]): Promise<string | undefined> {
  if (!d.exists) return "its folder cannot be reached (a disk not connected?), so it can only be removed from the list";
  if (!trashOffered()) return "this computer has no Trash Albula can use, so it can only be removed from the list";
  // The home folder, the folder that holds every database, or a folder above either: never one Trash.
  for (const g of guarded) if ((await placeOf(g, d.path)) !== "outside") return "that folder is not a database's own folder";
  for (const o of registered) {
    if (o.id === d.id) continue;
    const where = await placeOf(o.path, d.path);
    if (where === "same") return `the same folder is also in the list as “${o.id}”; remove that one from the list first`;
    if (where === "inside") return `the database “${o.id}” is inside that folder; remove that one first`;
    // ...and the other way round (critic, finding 13): a folder inside another listed database's folder.
    if (await isInside(d.path, o.path)) return `that folder is inside the database “${o.id}”, so it can only be removed from the list`;
  }
  return undefined;
}

/** What a database folder holds besides the database's own parts (docs/DATABASE-LAYOUT.md): the number of other files
 *  and folders at its top, which the Trash would take too and the question has to say (critic, finding 6). */
export async function otherItems(path: string): Promise<number> {
  const own = (n: string) => /^ctkDICOM\.sql/.test(n) || n === "dicom" || /^SlicerAlbula-/.test(n) || /^albula-/.test(n) ||
    n === "OpenNeuro" || n === "provenance.json" || n.startsWith(".");
  let n = 0;
  try { for await (const e of Deno.readDir(path)) if (!own(e.name)) n++; } catch { /* not readable: nothing said */ }
  return n;
}

/** macOS's own `trash` (macOS 15 and later, `man trash`). Elsewhere, and where it is missing, the Trash is not offered
 *  (critic, finding 11). */
const TRASH = "/usr/bin/trash";
function trashAvailable(): boolean {
  if (Deno.build.os !== "darwin") return false;
  try { return Deno.statSync(TRASH).isFile; } catch { return false; }
}
let testAvailable: boolean | undefined;
export const trashOffered = (): boolean => testAvailable ?? trashAvailable();

/** The folder itself to the Trash: a listed path that is a link hands over the folder it points to (critic, finding
 *  7). The error is the system's own; the route says it in plain words and logs this. Replaceable for tests, so a test
 *  never fills the person's Trash. */
let trashImpl = async (path: string): Promise<void> => {
  const r = await new Deno.Command(TRASH, { args: [path], stdout: "null", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr).trim() || `trash exited ${r.code}`);
};
export const moveToTrash = async (path: string) => trashImpl(await Deno.realPath(path));
export function setTrashForTests(fn: (path: string) => Promise<void>, available = true): void { trashImpl = fn; testAvailable = available; }
