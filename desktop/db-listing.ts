// WHAT A DATABASE HOLDS, FOR THE PAGE: the series list and one series' files, asked of the server.
//
// Until 2026-10-14 the page downloaded the whole index file (ctkDICOM.sql, 15 MB for the main database) every time it
// opened a database, and read it with its own copy of SQLite (sql.js, 704 KB of WebAssembly). The server has had SQLite
// inside it since 2026-10-13 (desktop/sqlite.ts), so the page now asks it the three questions it used to ask its copy
// (Ron, 2026-10-14: fewer dependencies -- "Do 1,2,4"; `ALBULA-DATABASE.md` in the workspace: "the page asking the
// server instead of downloading the file"). One dependency fewer, no 15 MB download, and never a stale copy.
//
// The SQL is the page's own, unchanged (logic/readers/dicom-db.ts before 2026-10-14), so the browser shows the same rows.
// This file is NOT in the working copy's fingerprint (series-files.ts is): listing series cannot change a copy.
//
//   GET /_db/<id>/_series                  { series: [...], patients, studies }
//   GET /_db/<id>/_files?series=<uid>      { files: ["relative/path.dcm", "/absolute/path.dcm", ...] }
import { join } from "jsr:@std/path@1";
import { sqliteScript } from "./sqlite.ts";

/** One row of the series list, as the page's DbSeriesEntry is built from it. */
export interface ListedSeries {
  uid: string; num: number | null; modality: string | null; description: string | null;
  seriesDate: string | null; seriesTime: string | null;
  studyUID: string | null; studyDescription: string | null; studyDate: string | null;
  patientName: string | null; patientID: string | null;
  n: number; nExternal: number;
}

const index = (dbDir: string) => join(dbDir, "ctkDICOM.sql");
const json = <T>(text: string): T[] => (text.trim() ? JSON.parse(text) as T[] : []);

export async function listSeries(dbDir: string): Promise<{ series: ListedSeries[]; patients: number; studies: number }> {
  // ONE READ TRANSACTION for the rows and the counts, so an import committing between them cannot make them disagree.
  // TEXT COLUMNS AS TEXT (CAST): a binary value in any of them would otherwise make the whole list refuse
  // (desktop/sqlite.ts prints no BLOB); sql.js listed such a row (critic 2026-10-14, page asks the server, 3, 7).
  const out = await sqliteScript(index(dbDir), `.timeout 5000
.mode json
BEGIN;
SELECT CAST(se.SeriesInstanceUID AS TEXT) AS uid, se.SeriesNumber AS num, CAST(se.Modality AS TEXT) AS modality,
       CAST(se.SeriesDescription AS TEXT) AS description,
       CAST(se.SeriesDate AS TEXT) AS seriesDate, CAST(se.SeriesTime AS TEXT) AS seriesTime,
       CAST(st.StudyInstanceUID AS TEXT) AS studyUID, CAST(st.StudyDescription AS TEXT) AS studyDescription,
       CAST(st.StudyDate AS TEXT) AS studyDate,
       CAST(p.DisplayedPatientsName AS TEXT) AS patientName, CAST(p.PatientID AS TEXT) AS patientID,
       COUNT(i.SOPInstanceUID) AS n,
       SUM(CASE WHEN i.Filename LIKE '/%' THEN 1 ELSE 0 END) AS nExternal
  FROM Series se
  JOIN Studies st ON st.StudyInstanceUID = se.StudyInstanceUID
  JOIN Patients p ON p.UID = st.PatientsUID
  LEFT JOIN Images i ON i.SeriesInstanceUID = se.SeriesInstanceUID
 GROUP BY se.SeriesInstanceUID
 ORDER BY p.DisplayedPatientsName, st.StudyDate, se.SeriesNumber;
SELECT (SELECT COUNT(*) FROM Patients) AS p, (SELECT COUNT(*) FROM Studies) AS s;
COMMIT;`, true);
  // Two JSON arrays, one a SELECT, printed one after the other; rows inside an array are separated by ",\n".
  const parts = out.trim() ? out.trim().split(/\]\n\[/).map((x, k, all) => JSON.parse((k > 0 ? "[" : "") + x + (k < all.length - 1 ? "]" : ""))) : [];
  const series = (parts.length === 2 ? parts[0] : []) as ListedSeries[];
  const counts = (parts.length === 2 ? parts[1] : parts[0] ?? [])[0] as { p: number; s: number } | undefined;
  return { series, patients: Number(counts?.p ?? 0), studies: Number(counts?.s ?? 0) };
}

export async function seriesFileNames(dbDir: string, seriesUID: string): Promise<string[]> {
  const q = seriesUID.replace(/'/g, "''");
  return json<{ fn: string }>(await sqliteScript(index(dbDir), `.timeout 5000\n.mode json\nSELECT CAST(Filename AS TEXT) AS fn FROM Images WHERE SeriesInstanceUID = '${q}';`, true))
    .map((r) => String(r.fn ?? "")).filter(Boolean);
}
