// THE IMPORT-TIME JOBS' MARKER FILE, `.albula-jobs.json` beside a database's index: the one module that reads and writes
// it (single access point). Per job (an extension's name, or the core's "core-brain"):
//   { mr, pinned, at }   what the last finished run began with: the MR series' stamp and the job's version
//                        (desktop/extension-jobs.ts: the startup sweep skips a database where both are the same)
//   failed: { <SeriesInstanceUID>: { version, at } }
//                        a scan the job could not make its result from, with the job's version then (critic 2026-10-20,
//                        finding 9): not tried again at every start -- a failure there cost a minute of the graphics card
//                        and a server restart at each launch -- but tried again when the job's version changes.
// Written whole, through a temporary file and a rename, so a reader never sees half of it. The server writes after a run
// ends and the job while it runs; the two never write at once (one run at a time).

export interface MarkerEntry { mr?: string; pinned?: string; at?: string; failed?: Record<string, { version: string; at: string }> }
type Marker = Record<string, MarkerEntry>;

export const markerPath = (dbPath: string) => `${dbPath.replace(/\/+$/, "")}/.albula-jobs.json`;

export async function readMarker(dbPath: string): Promise<Marker> {
  try { const m = JSON.parse(await Deno.readTextFile(markerPath(dbPath))); return m && typeof m === "object" ? m as Marker : {}; }
  catch { return {}; }
}

/** Change one job's entry, keeping everything else the file holds. */
export async function updateMarker(dbPath: string, job: string, change: (e: MarkerEntry) => MarkerEntry): Promise<void> {
  const m = await readMarker(dbPath);
  m[job] = change(m[job] ?? {});
  const file = markerPath(dbPath), tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(m, null, 1) + "\n").then(() => Deno.rename(tmp, file)).catch(() => {});
}

/** When this scan failed under this version of the job, or undefined (never, or under another version). */
export async function failedBefore(dbPath: string, job: string, seriesUID: string, version: string): Promise<string | undefined> {
  const f = (await readMarker(dbPath))[job]?.failed?.[seriesUID];
  return f && f.version === version ? f.at : undefined;
}

export function rememberFailure(dbPath: string, job: string, seriesUID: string, version: string): Promise<void> {
  return updateMarker(dbPath, job, (e) => ({ ...e, failed: { ...(e.failed ?? {}), [seriesUID]: { version, at: new Date().toISOString() } } }));
}
