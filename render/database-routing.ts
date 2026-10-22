// WHICH DATABASE A MODULE'S CALL GOES TO (critic 2026-10-20, qa/2026-10-20-after-load-brain-codes.md, finding 10).
//
// Ron's own sequence: a diffusion case from the brain tumor test cases on screen, then Change… to the main database for
// the beating heart. The window's open database follows the person's choice (cab94c6: a scene loads from the database
// that is open), and from then on every module call went there -- the Diffusion module asked the main database for
// PAT24's stored tracts and maps, found none, and called the case "not made". A scan in the scene came from ONE
// database (its origin says which, `fromDatabase`, as reading a volume back uses since 2026-10-15); a module's question
// about that scan is answered there.
//
// So, with no change to a module's calls:
//   - the database's series and edges (databaseSeries) are the open database's AND those of every database a scan in
//     the scene came from -- what the module asks about is in the list whichever database is open now;
//   - a file named after a series (the import job's maps: `SlicerAlbula-Cache/fa-<series>.nrrd`) is looked for in the
//     database whose index lists that series, the scene's scans' own databases first;
//   - anything else (a module's own file with no series in its name) stays with the open database.
//
// Pure functions, tested (database-routing.test.ts); the load panel holds the databases and calls these.
import type { MrsonNode } from "./mrson.ts";

/** The registered database's id in an address of it ("/_db/<id>/", absolute or not); null when it is not one (a folder
 *  opened by hand in a browser build). */
export function dbIdOf(address: string | null | undefined): string | null {
  const m = /\/_db\/([^/]+)\/?$/.exec(address ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

/** The databases the scene's scans came from, each once, in the scene's order. */
export function scanDatabases(nodes: Iterable<MrsonNode>): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const id = dbIdOf((n.origin as { fromDatabase?: string } | undefined)?.fromDatabase);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The series named in a path (a DICOM UID: groups of digits joined by dots, at least three -- "2.25.<number>" has three). */
export function seriesNamedIn(path: string): string[] {
  return path.match(/\d+(?:\.\d+){2,}/g) ?? [];
}

/**
 * WHERE A FILE IS: the first database, scans' own first, whose index lists a series the path names; the open database
 * when the path names none, or none of them lists it (a file the module writes beside the open one).
 */
export function databaseForPath(path: string, open: string | null, scans: readonly string[], lists: (db: string) => ((uid: string) => boolean) | undefined): string | null {
  const named = seriesNamedIn(path);
  if (!named.length) return open;
  const order = [...scans, ...(open && !scans.includes(open) ? [open] : [])];
  for (const db of order) {
    const has = lists(db);
    if (has && named.some((u) => has(u))) return db;
  }
  return open;
}

/** Several databases' series and edges as one list: a series once (the first database's row), an edge once. */
export function mergeListings<S extends { seriesInstanceUID: string }, E extends { child: string; parent: string; kind: string }>(
  listings: readonly { series: readonly S[]; edges: readonly E[] }[],
): { series: S[]; edges: E[] } {
  const series: S[] = [], edges: E[] = [];
  const seen = new Set<string>(), seenEdge = new Set<string>();
  for (const l of listings) {
    for (const s of l.series) if (!seen.has(s.seriesInstanceUID)) { seen.add(s.seriesInstanceUID); series.push(s); }
    for (const e of l.edges) { const k = `${e.child}|${e.parent}|${e.kind}`; if (!seenEdge.has(k)) { seenEdge.add(k); edges.push(e); } }
  }
  return { series, edges };
}

/**
 * THE WINDOW'S OPEN DATABASE, each time the registered list is read again. `current`: the machine-wide current database
 * now; `seen`: as this window last read it; `own`: one opened in this window only (Sample Data's Brain with DTI, critic
 * 2026-10-14, 3); `open`: what the window has open (a served database's address, or a folder's name).
 *
 * The window follows the person's switch (cab94c6: Change… to the main database, then the beating heart's scene) -- but
 * only a switch: a database opened in this window only stays until the machine-wide one changes (cab94c6 had made every
 * call follow the machine-wide one, so the sample's own load asked the main database for its scans), and a folder
 * opened by hand in a browser build stays until the person opens another (critic 2026-10-20, finding 16).
 */
export function windowDatabase(s: { open?: string; current: string | null; seen: string | null; own: string | null }): { use: string | null; own: string | null } {
  if (s.own && (s.seen === null || s.current === s.seen)) return { use: s.own, own: s.own };
  if (s.open !== undefined && dbIdOf(s.open) === null) return { use: s.open, own: null };
  return { use: s.current ?? s.open ?? null, own: null };
}
