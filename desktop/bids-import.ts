// ONE BIDS SUBJECT INTO A DICOM DATABASE -- the body of Contents/tools/bids-to-dicom.ts, so the application can do it too.
//
// Ron, 2026-10-01: Albula offers the public brain tumor test cases itself ("We got the test cases off the web, other
// people can too"), and "Albula has to be selfcontained" -- so the conversion the command-line tool did (BIDS NIfTI to
// DICOM, logic/import/bids.ts) runs in the application's server as well. Both call this; the tool adds its dciodvfy
// check through `check`, and its --replace-older on top.
//
// Per object (the T1, each diffusion scan, a SEG per mask): written under <database>/OpenNeuro/<dataset>/<subject>/
// [<session>/]<role>/ and indexed in one transaction (desktop/db-index.ts). An object already in the index (same UIDs:
// they are derived from the dataset, subject, file and writer rule) is left alone; one the index refuses has its files
// taken back out; a segmentation whose image did not make it is not written. Nothing is left half-done.
import { buildBidsSubject, type BidsDataset } from "../logic/import/bids.ts";
import { indexFilesIntoDatabase } from "./db-index.ts";

export interface BidsImportOptions {
  session?: string;
  masks?: string[];
  maskAlgorithm?: string;
  agency?: "IEC" | "FDA" | "MHW";
  agencyReason?: string;
  dryRun?: boolean;
  /** A check on an object's first file before it is written: errors refuse the object (the tool's dciodvfy). */
  check?: (bytes: Uint8Array) => { errors: string[]; said: string } | undefined;
  onProgress?: (line: string) => void;
}

export interface BidsObjectResult { role: string; description: string; seriesInstanceUID: string; files: number; result: "added" | "already" | "refused" | "checked" ; why?: string }

export interface BidsImportResult {
  objects: BidsObjectResult[];
  skipped: { file: string; why: string }[];
  /** Where the subject's objects went, relative to the database. */
  rel: string;
  studyInstanceUID?: string;
  failed: number;
  ms: number;
}

function knownSeries(db: string, uids: string[]): Set<string> {
  if (!uids.length) return new Set();
  try {
    const q = new Deno.Command("/usr/bin/sqlite3", { args: ["-readonly", `${db}/ctkDICOM.sql`, `SELECT SeriesInstanceUID FROM Series WHERE SeriesInstanceUID IN (${uids.map((u) => `'${u.replace(/'/g, "")}'`).join(",")});`], stdout: "piped", stderr: "null" }).outputSync();
    return new Set(new TextDecoder().decode(q.stdout).split("\n").map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }   // no index yet: everything is new
}

/** Build one subject's DICOM objects from `ds` and put them in the database at `db`. Throws only when nothing could be built. */
export async function importBidsSubject(db: string, ds: BidsDataset, subject: string, o: BidsImportOptions = {}): Promise<BidsImportResult> {
  const t0 = performance.now();
  const say = o.onProgress ?? (() => {});
  const { objects, skipped } = await buildBidsSubject(ds, subject, o.session, {
    masks: o.masks ?? [], maskAlgorithm: o.maskAlgorithm, safetyStandardAgency: o.agency, safetyReason: o.agencyReason, onProgress: say,
  });
  const present = knownSeries(db, objects.map((x) => x.seriesInstanceUID));
  const sub = subject.startsWith("sub-") ? subject : `sub-${subject}`;
  const ses = o.session ? (o.session.startsWith("ses-") ? o.session : `ses-${o.session}`) : "";
  const rel = `OpenNeuro/${ds.id}/${sub}${ses ? `/${ses}` : ""}`;
  const results: BidsObjectResult[] = [];
  const failedSeries = new Set<string>();
  for (const x of objects) {
    const r: BidsObjectResult = { role: x.role, description: x.description, seriesInstanceUID: x.seriesInstanceUID, files: x.files.length, result: "added" };
    results.push(r);
    if (present.has(x.seriesInstanceUID)) { r.result = "already"; continue; }
    const parent = x.files[0].index.derivedFrom?.parentSeriesUID;
    if (parent && failedSeries.has(parent)) { r.result = "refused"; r.why = "the series it is drawn on did not make it"; failedSeries.add(x.seriesInstanceUID); continue; }
    const c = o.check?.(x.files[0].bytes);
    if (c) say(`  ${x.role}: ${c.said}`);
    if (c?.errors.length) { r.result = "refused"; r.why = c.errors.join("; "); failedSeries.add(x.seriesInstanceUID); continue; }
    if (o.dryRun) { r.result = "checked"; continue; }
    const dir = `${db}/${rel}/${x.role}`;
    await Deno.mkdir(dir, { recursive: true });
    const rows: { file: string; meta: typeof x.files[0]["index"] }[] = [], written: string[] = [];
    try {
      for (const f of x.files) {
        const path = `${dir}/${f.name}`;
        await Deno.writeFile(path, f.bytes);
        written.push(path);
        rows.push({ file: path.slice(db.length + 1), meta: f.index });   // the index takes paths relative to the database folder
      }
      const ir = await indexFilesIntoDatabase(db, rows);
      if (ir.indexed) { say(`  ${x.role}: ${x.description}, ${ir.instances} instance(s) indexed`); continue; }
      r.why = ir.error ?? ir.warning ?? "no reason given";
    } catch (e) { r.why = (e as Error).message; }
    // Refused: the files go back out, so nothing sits in the database folder that the index does not list.
    for (const w of written) await Deno.remove(w).catch(() => {});
    await Deno.remove(dir).catch(() => {});        // only if now empty
    r.result = "refused"; failedSeries.add(x.seriesInstanceUID);
    say(`  ${x.role}: NOT indexed (${r.why}); its files removed again`);
  }
  return { objects: results, skipped, rel, studyInstanceUID: objects[0]?.files[0]?.index.studyInstanceUID, failed: results.filter((r) => r.result === "refused").length, ms: Math.round(performance.now() - t0) };
}
