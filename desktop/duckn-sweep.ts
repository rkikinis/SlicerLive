// THE SWEEP: a duckn working copy for every image series in a database that does not have a valid one.
//
// Ron, 2026-09-23: "that conversion should happen when moving a data set into the db. The current db
// is a onetime sweep that could run in the background", and "permanent". The workspace brief is
// Contents/docs/DUCKN-WORKING-COPY.md, step 3.
//
// One series at a time; a valid copy is left alone (desktop/duckn-copy-check.ts, the same verdict
// the route gives the page), a stale one -- or a store under that name Albula did not write -- is
// REPLACED, and a series the converter will not copy ("refused": not a volume, a rescale it will
// not round) or the reader cannot read ("unreadable") is recorded with the reason and loads from
// DICOM as before. A copy is written aside and renamed into place. Resumable: stop it anywhere and
// run it again -- the next run first removes what a killed run left half-written (`.part-` and
// `.old-` folders; no other program writes copies), and the report is rewritten after every series,
// so a killed run leaves a record of how far it got (critic, 2026-09-23, findings 4 and 10).
//
// IT REFUSES TO RUN FROM SOURCES THAT DIFFER FROM THE FINGERPRINT IT WOULD STAMP (finding 1): run
// from edited sources before the rebuild regenerates desktop/duckn-copy-code.generated.ts, it
// would file the edited reader's output under the old reader's code, and the installed server
// would serve those copies as current. It says to run desktop/make-copy-code.ts (the rebuild does).
//
//   deno run -A desktop/duckn-sweep.ts <database folder> [--dry-run]
//
// The report: <database>/SlicerAlbula-Zarr/sweep-report.json -- every series, what happened, why.
import { COPY_FOLDER } from "./duckn-copy-code.ts";
import { COPY_SOURCE_CODE } from "./duckn-copy-code.generated.ts";
import { computeCopyCode } from "./make-copy-code.ts";
import { copyStatus } from "./duckn-copy-check.ts";
import { writeDucknCopy } from "./duckn-copy.ts";

/** Not images: never read for a copy. Anything else is tried, and a refusal is recorded. */
const NOT_IMAGES = new Set(["SEG", "SR", "PR", "KO", "RTSTRUCT", "RTPLAN", "RTDOSE", "RTRECORD", "REG", "DOC", "PLAN", "AU", "ECG"]);

export interface SweepEntry {
  seriesInstanceUID: string;
  modality: string;
  outcome: "copied" | "valid" | "refused" | "unreadable" | "failed" | "to copy";
  why?: string;
  seconds?: number;
  dicomBytes?: number;
  copyBytes?: number;
}
export interface SweepReport {
  database: string; startedAt: string; seconds: number; entries: SweepEntry[];
  /** False while the run is going: a killed run's report says so. */
  finished: boolean;
  /** Half-written folders a killed earlier run left, removed (or, in a dry run, found). */
  leftovers: string[];
}

/** The converter's "no files could be read as images" is a refusal when every file lacks what makes a
 *  slice of a volume (localizers, screenshots); any other reason -- a parse error, an undecodable
 *  pixel format -- is the reader failing, and is said as that. */
export function outcomeOf(msg: string): "refused" | "unreadable" | "failed" {
  const none = /could be read as images -- (.*)$/.exec(msg);
  if (none) {
    const reasons = none[1].split("; ").map((r) => r.replace(/^\d+ x /, ""));
    // A multi-frame file whose frames lack geometry is the same case, said per frame (2026-09-25).
    // So is a multi-frame file without per-frame positions, refused with its frame count (2026-09-26).
    return reasons.every((r) => r.startsWith("no image plane attributes") || r.startsWith("a multi-frame image whose frames have no") || r.startsWith("a multi-frame image without per-frame positions")) ? "refused" : "unreadable";
  }
  return /does not give whole numbers|will not guess|declared nothing|different orientation|slice in this series|none of the volumes in this series is complete/.test(msg) ? "refused" : "failed";
}

async function listSeries(dbPath: string): Promise<{ uid: string; modality: string }[]> {
  const p = new Deno.Command("/usr/bin/sqlite3", { args: ["-readonly", "-json", `${dbPath}/ctkDICOM.sql`, "SELECT SeriesInstanceUID AS uid, COALESCE(Modality,'') AS modality FROM Series ORDER BY SeriesInstanceUID;"], stdout: "piped", stderr: "piped" });
  const out = await p.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  const text = new TextDecoder().decode(out.stdout).trim();
  return text ? JSON.parse(text) : [];
}

/**
 * Copy what needs copying. `onEntry` hears each series as it is decided. `dryRun` decides and
 * reports without writing anything.
 */
export async function sweep(dbPath: string, opts: { dryRun?: boolean; onEntry?: (e: SweepEntry, i: number, n: number) => void } = {}): Promise<SweepReport> {
  const root = dbPath.replace(/\/+$/, "");
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  if (!opts.dryRun) {
    const running = await computeCopyCode();
    if (running !== COPY_SOURCE_CODE) {
      throw new Error(`the converter's sources have changed since their fingerprint was made (${COPY_SOURCE_CODE}; the sources are ${running}) -- copies written now would carry the old code. Run \`deno run -A desktop/make-copy-code.ts\` (the rebuild does) and then the sweep.`);
    }
  }
  const folder = `${root}/${COPY_FOLDER}`;
  const leftovers: string[] = [];
  try {
    for (const e of Deno.readDirSync(folder)) {
      if (e.isFile && e.name === "sweep-report.json.tmp") { if (!opts.dryRun) await Deno.remove(`${folder}/${e.name}`); continue; }
      if (!e.isDirectory || !/\.zarr\.(part|old)-[0-9a-f]{8}$/.test(e.name)) continue;
      leftovers.push(e.name);
      if (!opts.dryRun) await Deno.remove(`${folder}/${e.name}`, { recursive: true });
    }
  } catch { /* no copies folder yet */ }
  const all = (await listSeries(root)).filter((s) => !NOT_IMAGES.has(s.modality.toUpperCase()));
  const entries: SweepEntry[] = [];
  const writeReport = async (finished: boolean) => {
    if (opts.dryRun) return;
    await Deno.mkdir(folder, { recursive: true });
    const r: SweepReport = { database: root, startedAt, seconds: (performance.now() - t0) / 1000, entries, finished, leftovers };
    await Deno.writeTextFile(`${folder}/sweep-report.json.tmp`, JSON.stringify(r, null, 1));
    await Deno.rename(`${folder}/sweep-report.json.tmp`, `${folder}/sweep-report.json`);
  };
  for (const [i, s] of all.entries()) {
    // AN IDENTIFIER THAT IS NOT A DICOM UID (one row in Ron's index is a 64-character hash, another
    // is "31"): said as what it is, not as "not in the index".
    if (!/^[0-9][0-9.]{0,63}$/.test(s.uid)) {
      const e: SweepEntry = { seriesInstanceUID: s.uid, modality: s.modality, outcome: "refused", why: "its series identifier is not a DICOM UID, which a copy is filed under" };
      entries.push(e); opts.onEntry?.(e, i, all.length); continue;
    }
    const st = await copyStatus(root, s.uid);
    let e: SweepEntry;
    if (st.valid) e = { seriesInstanceUID: s.uid, modality: s.modality, outcome: "valid" };
    else if (opts.dryRun) e = { seriesInstanceUID: s.uid, modality: s.modality, outcome: "to copy", why: st.why };
    else {
      const t = performance.now();
      try {
        const r = await writeDucknCopy(root, s.uid);
        e = { seriesInstanceUID: s.uid, modality: s.modality, outcome: "copied", why: st.absent ? undefined : st.why, seconds: (performance.now() - t) / 1000, dicomBytes: r.dicomBytes, copyBytes: r.copyBytes };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err).replace(`${s.uid}: `, "");
        e = { seriesInstanceUID: s.uid, modality: s.modality, outcome: outcomeOf(msg), why: msg, seconds: (performance.now() - t) / 1000 };
      }
    }
    entries.push(e);
    opts.onEntry?.(e, i, all.length);
    await writeReport(false);
  }
  await writeReport(true);
  return { database: root, startedAt, seconds: (performance.now() - t0) / 1000, entries, finished: true, leftovers };
}

if (import.meta.main) {
  const db = Deno.args.find((a) => !a.startsWith("--"));
  const dryRun = Deno.args.includes("--dry-run");
  if (!db) { console.error("usage: deno run -A desktop/duckn-sweep.ts <database folder> [--dry-run]"); Deno.exit(2); }
  const r = await sweep(db, {
    dryRun,
    onEntry: (e, i, n) => console.log(`${String(i + 1).padStart(4)}/${n}  ${e.outcome.padEnd(8)} ${e.modality.padEnd(3)} ${e.seriesInstanceUID}${e.seconds ? `  ${e.seconds.toFixed(1)} s` : ""}${e.why ? `  -- ${e.why.slice(0, 140)}` : ""}`),
  });
  const count = (o: string) => r.entries.filter((e) => e.outcome === o).length;
  const gb = (k: "dicomBytes" | "copyBytes") => (r.entries.reduce((a, e) => a + (e[k] ?? 0), 0) / 1e9).toFixed(2);
  console.log(dryRun
    ? `\n(dry run, nothing written) ${r.entries.length} image series: ${count("to copy")} to copy, ${count("valid")} already valid`
    : `\n${r.entries.length} image series: ${count("copied")} copied, ${count("valid")} already valid, ${count("refused")} refused, ${count("unreadable")} unreadable, ${count("failed")} failed; ${r.seconds.toFixed(0)} s`);
  if (r.leftovers.length) console.log(`${dryRun ? "found" : "removed"} ${r.leftovers.length} half-written folder(s) from a killed run: ${r.leftovers.join(", ")}`);
  if (!dryRun) console.log(`copied: ${gb("dicomBytes")} GB of DICOM -> ${gb("copyBytes")} GB of copies; report: ${db}/${COPY_FOLDER}/sweep-report.json`);
}
