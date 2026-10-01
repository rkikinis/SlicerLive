// A throwaway database for the duckn copy's tests: synthetic series (logic/test-dicom.ts), their
// files on disk, and the Series and Images rows that name them. None of it can see a real database.
import dcmjs from "../logic/dcmjs.ts";
import { setDcmjs } from "../logic/readers/dicom-series.ts";
import { makeCtSeries, type SyntheticSeries } from "../logic/test-dicom.ts";

setDcmjs(dcmjs);

async function sql(dbFile: string, text: string): Promise<void> {
  const p = new Deno.Command("/usr/bin/sqlite3", { args: [dbFile], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(text));
  await w.close();
  const { code, stderr } = await p.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
}

// EVERY THROWAWAY DATABASE GOES WHEN THE TEST PROCESS ENDS (critic, 2026-09-23, finding 11: 140 of
// them, 21 MB, were left in the temp folder after a day of runs).
const made: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const d of made) try { Deno.removeSync(d, { recursive: true }); } catch { /* already gone */ }
});

/** An empty database folder with the two tables the copy's code reads. */
export async function emptyDb(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "albula-duckn-" });
  made.push(dir);
  await sql(`${dir}/ctkDICOM.sql`, `
    CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY, StudyInstanceUID TEXT, Modality TEXT);
    CREATE TABLE Images (SOPInstanceUID TEXT PRIMARY KEY, Filename TEXT, URL TEXT, SeriesInstanceUID TEXT, InsertTimestamp TEXT);`);
  return dir;
}

/**
 * One synthetic CT series added to `dir`: its files under `files/<n>/`, one of them with a space in
 * its name (real databases have them), and its rows. `extra` goes into every instance, as
 * makeCtSeries takes it.
 */
export async function addSeries(dir: string, nx: number, ny: number, nz: number, opts: { extra?: Record<string, unknown> } = {}): Promise<{ series: SyntheticSeries; files: string[] }> {
  const series = await makeCtSeries(nx, ny, nz, opts);
  const sub = `files/${series.seriesInstanceUID}`;
  await Deno.mkdir(`${dir}/${sub}`, { recursive: true });
  const rows: string[] = [], files: string[] = [];
  for (const [i, b] of series.instances.entries()) {
    const rel = `${sub}/${i === 1 ? "slice 1 2" : `slice-${i}`}.dcm`;
    await Deno.writeFile(`${dir}/${rel}`, new Uint8Array(b));
    rows.push(`('${series.seriesInstanceUID}.${i}', '${rel}', '${series.seriesInstanceUID}')`);
    files.push(`${dir}/${rel}`);
  }
  await sql(`${dir}/ctkDICOM.sql`,
    `INSERT INTO Series (SeriesInstanceUID, StudyInstanceUID, Modality) VALUES ('${series.seriesInstanceUID}', '${series.studyInstanceUID}', 'CT');
     INSERT INTO Images (SOPInstanceUID, Filename, SeriesInstanceUID) VALUES ${rows.join(",")};`);
  return { series, files };
}

/** A database folder holding one synthetic series. */
export async function dbWithSeries(nx: number, ny: number, nz: number, opts: { extra?: Record<string, unknown> } = {}) {
  const dir = await emptyDb();
  const { series, files } = await addSeries(dir, nx, ny, nz, opts);
  return { dir, series, files };
}
