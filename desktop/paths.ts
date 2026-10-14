// PATHS THAT HOLD ON EVERY SYSTEM (Ron, 2026-10-13: "keep in mind that eventually we will need to have this on windows
// and linux machines. Design the paths etc. robustly"). One place for the rules the database code needs:
//
//  - folders are joined and compared with Deno's path library, never by gluing "/" between names;
//  - "is this folder inside that one" is asked of the RESOLVED paths (links followed where the folder exists), and
//    without regard to letter case where the disk ignores it -- macOS and Windows by default, not Linux;
//  - a path kept in a record (a scene file's place in its database) is RELATIVE to the database's folder and written
//    with "/", whatever the system; it is turned into the system's form only when read (fromStored).
import { basename, dirname, isAbsolute, join, relative, resolve, SEPARATOR } from "jsr:@std/path@1";

/** Disks that ignore letter case by default: macOS (APFS, HFS+) and Windows (NTFS). Linux's do not. */
const CASE_BLIND = Deno.build.os === "darwin" || Deno.build.os === "windows";

/** The resolved path; for one that does not exist yet, its nearest existing parent resolved and the rest added (on a
 *  Mac a temporary folder's /var is /private/var, and the two must compare equal). */
async function real(p: string): Promise<string> {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(await Deno.realPath(head), ...rest.reverse()); } catch { /* not there: one up */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.push(basename(head)); head = up;
  }
}

/** Where `child` lies relative to `parent`: the same folder, inside it, or neither. */
export async function placeOf(child: string, parent: string): Promise<"same" | "inside" | "outside"> {
  let c = await real(child), p = await real(parent);
  if (CASE_BLIND) { c = c.toLowerCase(); p = p.toLowerCase(); }
  const rel = relative(p, c);
  if (rel === "") return "same";
  // ".." or "../…" is outside; a folder that merely begins with two dots ("..notes") is inside.
  return rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel) ? "outside" : "inside";
}
export const isSameFolder = async (a: string, b: string) => (await placeOf(a, b)) === "same";
export const isInside = async (child: string, parent: string) => (await placeOf(child, parent)) === "inside";

/** A path kept in a record, relative to `base` and written with "/", as this system's path. */
export const fromStored = (base: string, rel: string): string => join(base, ...rel.split("/").filter(Boolean));
