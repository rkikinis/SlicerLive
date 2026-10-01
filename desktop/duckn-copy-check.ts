// IS A SERIES' DUCKN COPY VALID? One answer for the route that hands copies to the page
// (desktop/db-serve.ts) and for the sweep that decides which series to copy (desktop/duckn-sweep.ts),
// so the two can never disagree about what counts as current.
import { COPY_CODE, COPY_FOLDER, type CopyGroup } from "./duckn-copy-code.ts";
import { seriesFileStamp } from "./series-files.ts";

export type CopyStatus = { valid: true; group: CopyGroup; dir: string } | { valid: false; why: string; absent?: boolean };

export async function copyStatus(dbPath: string, uid: string): Promise<CopyStatus> {
  const dir = `${dbPath.replace(/\/+$/, "")}/${COPY_FOLDER}/${uid}.zarr`;
  const groupText = await Deno.readTextFile(`${dir}/zarr.json`).catch(() => null);
  if (!groupText) return { valid: false, why: "no copy of this series", absent: true };
  let group: CopyGroup | undefined;
  try { group = (JSON.parse(groupText) as { attributes?: { albula?: CopyGroup } }).attributes?.albula; } catch { /* below */ }
  if (!group) return { valid: false, why: "the copy's description is not Albula's" };
  if (group.seriesInstanceUID !== uid) return { valid: false, why: `the copy in this series' folder is of another series (${group.seriesInstanceUID})` };
  if (group.code !== COPY_CODE) return { valid: false, why: `the copy was made by other code (${group.code}; this server is ${COPY_CODE})` };
  if (!Array.isArray(group.frames) || !group.frames.length || !group.frames.every((f) => /^[0-9]{1,4}$/.test(f))) return { valid: false, why: "the copy names its volumes in a way this server does not accept" };
  const now = await seriesFileStamp(dbPath, uid);
  if (!now) return { valid: false, why: "the series is no longer in the index" };
  // WHAT changed, said: the count, the bytes, the newest time, or -- when those three agree -- a
  // file's own size or time (critic, 2026-09-23, finding 3: a same-size file with an older time).
  const was = group.source;
  const changed = now.files !== was.files ? `${was.files} files then, ${now.files} now`
    : now.bytes !== was.bytes ? `${was.bytes} bytes then, ${now.bytes} now`
    : now.mtimeMs !== was.mtimeMs ? `newest file ${new Date(was.mtimeMs).toISOString()} then, ${new Date(now.mtimeMs).toISOString()} now`
    : !was.digest ? "the copy predates the per-file check"
    : now.digest !== was.digest ? "a file's size or time changed, though the totals did not"
    : null;
  if (changed) return { valid: false, why: `the series' files changed since the copy was made (${changed})` };
  return { valid: true, group, dir };
}
