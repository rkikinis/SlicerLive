// A SERIES' FILES AS THE INDEX NAMES THEM, AND WHAT THEY MEASURE ON DISK -- read-only.
//
// In a module of their own so the duckn copy's converter can use them without importing
// desktop/db-index.ts: the copy's code stamp is a fingerprint of every module the converter runs
// (desktop/make-copy-code.ts), and with db-index in it, a one-line change to the audit retired all
// 107 copies (2026-09-23). db-index.ts re-exports both, so its callers are unchanged.

const SQLITE = "/usr/bin/sqlite3";

/** DICOM UIDs are digits and dots and nothing else; anything else never reaches the SQL. */
const UID = /^[0-9][0-9.]{0,63}$/;
/** SQLite string literal: the only escape it has is a doubled single quote. */
const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

async function sqliteRead(dbPath: string, sql: string): Promise<string> {
  const p = new Deno.Command(SQLITE, { args: ["-readonly", dbPath], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(sql));
  await w.close();
  const { code, stdout, stderr } = await p.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr).trim() || `sqlite3 exited ${code}`);
  return new TextDecoder().decode(stdout);
}

/**
 * What the files of one series measure on disk: their count, their bytes and the newest
 * modification time. The mesh cache's key (desktop/db-serve.ts): a series rewritten in place --
 * even to the same size -- moves the time (a copy that preserves it, `cp -p`, does not; no
 * cheaper key than a content hash would catch that). Null when the series is not in the index.
 */
export async function seriesFileStamp(dbDir: string, seriesUID: string): Promise<{ files: number; bytes: number; mtimeMs: number; digest: string } | null> {
  if (!UID.test(seriesUID)) return null;
  const root = dbDir.replace(/\/+$/, "");
  const raw = (await sqliteRead(`${root}/ctkDICOM.sql`, `.mode json\nSELECT Filename AS f FROM Images WHERE SeriesInstanceUID=${q(seriesUID)};`)).trim();
  const rows = raw ? JSON.parse(raw) as { f: string }[] : [];
  if (!rows.length) return null;
  let bytes = 0, mtimeMs = 0, files = 0;
  // EVERY FILE'S NAME, SIZE AND TIME, hashed into one value (`digest`). The three totals alone missed
  // a file rewritten in place at the same size with an older time -- a restore, `cp -p`, `rsync -a`
  // -- and a duckn copy then served the old voxels (critic, 2026-09-23, finding 3). Still not a
  // content hash: a file rewritten at the same size AND given back its exact old time is not seen.
  const lines: string[] = [];
  for (const r of [...rows].sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))) {
    const st = await Deno.stat(r.f.startsWith("/") ? r.f : `${root}/${r.f}`).catch(() => null);
    if (!st) { lines.push(`${r.f}\tmissing`); continue; }
    const t = st.mtime?.getTime() ?? 0;
    files++; bytes += st.size; mtimeMs = Math.max(mtimeMs, t);
    lines.push(`${r.f}\t${st.size}\t${t}`);
  }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join("\n"))));
  return { files, bytes, mtimeMs, digest: [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

/** The files of one series as the index records them, made absolute. Empty when the uid is not in it. */
export async function seriesFilePaths(dbDir: string, seriesUID: string): Promise<string[]> {
  if (!UID.test(seriesUID)) return [];
  const root = dbDir.replace(/\/+$/, "");
  const raw = (await sqliteRead(`${root}/ctkDICOM.sql`, `.mode json\nSELECT Filename AS f FROM Images WHERE SeriesInstanceUID=${q(seriesUID)};`)).trim();
  const rows = raw ? JSON.parse(raw) as { f: string }[] : [];
  return rows.map((r) => r.f.startsWith("/") ? r.f : `${root}/${r.f}`);
}


/** One row of the index per series, with its study: what a program beside the server (an import-time job) needs to find
 *  a study's series without parsing their files. Read-only; empty when the database has no index. */
export interface IndexSeries { seriesUID: string; studyUID: string; patientUID: string; modality: string; seriesNumber: string; description: string; frameOfReferenceUID: string }
export async function indexSeries(dbDir: string): Promise<IndexSeries[]> {
  const root = dbDir.replace(/\/+$/, "");
  const raw = (await sqliteRead(`${root}/ctkDICOM.sql`, `.mode json
SELECT s.SeriesInstanceUID AS seriesUID, s.StudyInstanceUID AS studyUID, COALESCE(st.PatientsUID,'') AS patientUID,
  COALESCE(s.Modality,'') AS modality, COALESCE(s.SeriesNumber,'') AS seriesNumber, COALESCE(s.SeriesDescription,'') AS description,
  COALESCE(s.FrameOfReferenceUID,'') AS frameOfReferenceUID
FROM Series s LEFT JOIN Studies st ON st.StudyInstanceUID = s.StudyInstanceUID ORDER BY s.StudyInstanceUID, s.SeriesNumber;`).catch(() => "")).trim();
  return raw ? (JSON.parse(raw) as IndexSeries[]).map((r) => ({ ...r, seriesNumber: String(r.seriesNumber) })) : [];
}
