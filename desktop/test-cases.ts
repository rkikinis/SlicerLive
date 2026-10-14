// "GET THE BRAIN TUMOR TEST CASES" -- a public dataset, downloaded and made into a DICOM database by Albula itself.
//
// Ron, 2026-10-01: "that is a good feature to have, with a warning about the size. We got the test cases off the web,
// other people can too." And "Albula has to be selfcontained": a resident learning the Diffusion module needs cases that
// are not patients, and must not need Claude or a command line to get them.
//
// The dataset is OpenNeuro ds001226 ("Brain Tumor Connectomics", pre-operative; CC0; Aerts and Marinazzo), the one the
// diffusion work was built and measured on. Per subject, from OpenNeuro's public bucket: the T1, the diffusion scan and
// its reversed-phase pair with their sidecars, and the tumor outline (patients only) -- the same files as
// Contents/tools/fetch-openneuro-dmri.sh, about 64 MB a subject. Each subject is converted to DICOM as soon as it is in
// (desktop/bids-import.ts, the code the command-line import uses) and its downloaded files are removed; a marker says it
// is done, so a run that stopped (a closed lid, a lost network) picks up where it was. A subject whose files are not all
// there is skipped and said.
import dcmjs from "../logic/dcmjs.ts";
import { setDicomLibrary } from "../logic/dicom-io.ts";
import { readBidsDataset } from "../logic/import/bids.ts";
import { importBidsSubject } from "./bids-import.ts";
import { loadExtensionHooks } from "./extension-hooks.ts";
import { seriesFileNames } from "./db-listing.ts";

export const TEST_CASES = {
  dataset: "ds001226",
  base: "https://s3.amazonaws.com/openneuro.org/ds001226",
  name: "Brain tumor test cases",
  holds: "Public and anonymous MRI of people with brain tumors (gliomas and meningiomas) and of healthy volunteers: for each, a T1, a diffusion MRI with its reversed-phase pair, and, for the patients, the tumor outlined. For learning and testing without patient data.",
  // The files come from the bucket's current tree (the dataset's latest version), not a frozen snapshot (critic, finding
  // 16); 5.0.1 was the latest when this was written and first run.
  source: "OpenNeuro ds001226 (Brain Tumor Connectomics, pre-operative; Aerts and Marinazzo), CC0, latest version (5.0.1 on 2026-10-01, doi:10.18112/openneuro.ds001226.v5.0.1)",
  /** Said before it starts, MEASURED (2026-10-01, the first run from the app): 36 people, 2.25 GB downloaded, a 4.7 GB
   *  database (the DICOM copy is uncompressed), 2 min 55 s from the first file to the last person converted. */
  approxBytes: 2.25e9,
  diskBytes: 4.7e9,
  minutesOnFastConnection: 3,
  session: "preop",
  masks: ["tumor_masks"],
  maskAlgorithm: "manual delineation and disconnectome",
  agency: "IEC" as const,
  agencyReason: "acquired at Ghent University Hospital, Belgium (EU: IEC 60601-2-33)",
};

export const DOWNLOAD_FOLDER = "SlicerAlbula-Download";
/** Written when a run ended with every person converted or permanently skipped: the offer to continue goes away then. */
export const COMPLETE_MARKER = ".complete";

export interface TestCaseProgress {
  phase: "starting" | "downloading" | "converting" | "done";
  subject: string; done: number; subjects: number; bytes: number;
  added: number; already: number; skipped: string[]; failed: string[];
  /** People converted by an earlier run (their marker was there): counted in `done`, not added again. */
  earlier: number;
}

const filesOf = (p: string) => {
  const s = `sub-${p}/ses-preop`;
  const f = [`${s}/anat/sub-${p}_ses-preop_T1w.nii.gz`, `${s}/anat/sub-${p}_ses-preop_T1w.json`];
  for (const d of ["AP", "PA"]) for (const x of ["nii.gz", "bval", "bvec", "json"]) f.push(`${s}/dwi/sub-${p}_ses-preop_acq-${d}_dwi.${x}`);
  if (!p.startsWith("CON")) f.push(`derivatives/tumor_masks/sub-${p}/anat/sub-${p}_space_T1_label-tumor.nii`);
  return f;
};

/**
 * Fetch one file into `dest` (a `.part` beside it until complete), from the bucket or, for testing, from a local copy
 * (ALBULA_TEST_CASES_SOURCE: a folder laid out as the bucket; set on the server, never by a page). False: not there.
 */
async function fetchFile(rel: string, dest: string, onBytes: (n: number) => void): Promise<boolean> {
  if (await Deno.stat(dest).then(() => true, () => false)) return true;
  await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
  const local = Deno.env.get("ALBULA_TEST_CASES_SOURCE");
  if (local) {
    try { await Deno.copyFile(`${local}/${rel}`, dest); onBytes((await Deno.stat(dest)).size); return true; }
    catch { return false; }
  }
  const r = await fetch(`${TEST_CASES.base}/${rel.split("/").map(encodeURIComponent).join("/")}`);
  if (r.status === 404 || r.status === 403) { await r.body?.cancel(); return false; }
  if (!r.ok || !r.body) throw new Error(`OpenNeuro answered ${r.status} for ${rel}`);
  const part = `${dest}.part`;
  using f = await Deno.open(part, { write: true, create: true, truncate: true });
  for await (const chunk of r.body) { await f.write(chunk); onBytes(chunk.byteLength); }
  await Deno.rename(part, dest);
  return true;
}

/** Download and convert, subject by subject, into the database at `db`. Says what it is doing through `onProgress`. */
/** Whether a run into `db` finished (every person converted or permanently skipped). */
export const testCasesComplete = (db: string) => Deno.stat(`${db}/${DOWNLOAD_FOLDER}/${TEST_CASES.dataset}/${COMPLETE_MARKER}`).then(() => true, () => false);

export async function getTestCases(db: string, onProgress: (p: TestCaseProgress) => void): Promise<TestCaseProgress> {
  setDicomLibrary(dcmjs);
  await loadExtensionHooks();          // the diffusion extension reads dwi/ (logic/import/bids-kinds.ts)
  const root = `${db}/${DOWNLOAD_FOLDER}/${TEST_CASES.dataset}`;
  const p: TestCaseProgress = { phase: "starting", subject: "", done: 0, subjects: 0, bytes: 0, added: 0, already: 0, skipped: [], failed: [], earlier: 0 };
  const tick = () => onProgress({ ...p, skipped: [...p.skipped], failed: [...p.failed] });
  for (const f of ["dataset_description.json", "participants.tsv", "README"]) {
    if (!(await fetchFile(f, `${root}/${f}`, (n) => { p.bytes += n; }))) throw new Error(`OpenNeuro does not have ${f} for ${TEST_CASES.dataset}`);
  }
  const subjects = (await Deno.readTextFile(`${root}/participants.tsv`)).split("\n").slice(1)
    .map((l) => l.split("\t")[0]?.trim()).filter((s): s is string => !!s && /^sub-[A-Za-z0-9]+$/.test(s)).map((s) => s.slice(4));
  p.subjects = subjects.length; tick();
  for (const s of subjects) {
    p.subject = s;
    const marker = `${root}/.done-${s}`;
    if (await Deno.stat(marker).then(() => true, () => false)) { p.done++; p.earlier++; tick(); continue; }
    p.phase = "downloading"; tick();
    let complete = true;
    try {
      for (const rel of filesOf(s)) {
        if (!(await fetchFile(rel, `${root}/${rel}`, (n) => { p.bytes += n; if (p.bytes % (8 << 20) < n) tick(); }))) { complete = false; break; }
      }
    } catch (e) {
      // A NETWORK FAILURE ENDS THIS PERSON, NOT THE RUN (critic, 2026-10-01, finding 3); a later run tries again.
      p.failed.push(`${s}: the download failed (${(e as Error).message})`); p.done++; tick(); continue;
    }
    if (!complete) {
      p.skipped.push(`${s} (not all of its files are on OpenNeuro)`);
      // Its partial download goes (finding 14: no orphans in the database folder).
      for (const dir of [`sub-${s}`, `derivatives/tumor_masks/sub-${s}`]) await Deno.remove(`${root}/${dir}`, { recursive: true }).catch(() => {});
      p.done++; tick(); continue;
    }
    p.phase = "converting"; tick();
    try {
      const ds = await readBidsDataset(root);
      const r = await importBidsSubject(db, ds, s, { session: TEST_CASES.session, masks: s.startsWith("CON") ? [] : TEST_CASES.masks, maskAlgorithm: TEST_CASES.maskAlgorithm, agency: TEST_CASES.agency, agencyReason: TEST_CASES.agencyReason });
      p.added += r.objects.filter((o) => o.result === "added").length;
      p.already += r.objects.filter((o) => o.result === "already").length;
      if (r.failed) p.failed.push(`${s}: ${r.objects.filter((o) => o.result === "refused").map((o) => `${o.role} (${o.why})`).join("; ")}`);
      else {
        await Deno.writeTextFile(marker, new Date().toISOString());
        // The DICOM copy is the record now: the subject's downloaded files, and their folders, go.
        for (const dir of [`sub-${s}`, `derivatives/tumor_masks/sub-${s}`]) await Deno.remove(`${root}/${dir}`, { recursive: true }).catch(() => {});
      }
    } catch (e) { p.failed.push(`${s}: ${(e as Error).message}`); }
    p.done++; tick();
  }
  if (!p.failed.length) await Deno.writeTextFile(`${root}/${COMPLETE_MARKER}`, new Date().toISOString());
  p.phase = "done"; p.subject = ""; tick();
  return p;
}

// ---- THE DIFFUSION SAMPLE: one healthy volunteer of the same dataset ----------------------------------------------------
//
// Ron, 2026-10-14: "I would like to have a data set with T1 and color by orientation as a sample"; "let's go with the con03
// case"; "DB of its own"; the button "Brain with DTI" (mockup `sample-diffusion-2026-10-14.html` in the workspace). The same
// download and conversion as the test cases, for CON03 alone, into a database of its own, so samples never mix with a
// patient database. Measured: the conversion 1.4 s, 133 MB in the database; the download about 51 MB.
export const DTI_SAMPLE = {
  subject: "CON03",
  name: "Sample data",
  holds: "Sample scans to try Albula on: public and anonymous",
  source: "OpenNeuro ds001226 (Brain Tumor Connectomics; Aerts and Marinazzo), CC0: CON03, a healthy volunteer -- a T1 and a diffusion MRI with its reversed-phase pair",
  approxBytes: 54.3e6,             // 54,225,430 bytes measured (critic 2026-10-14, 11)
};

/** A failure said in one plain sentence for the person; the detail goes to the session log (critic 2026-10-14, 12). */
export class SampleError extends Error {
  constructor(readonly plain: string, readonly detail: string) { super(`${plain} (${detail})`); }
}

export interface DtiSampleProgress { phase: "starting" | "downloading" | "converting" | "done"; bytes: number }
/** What the sample put in the database: its series by role (T1w, dwi-AP, dwi-PA), for the page to open. */
export interface DtiSampleResult { series: { role: string; seriesInstanceUID: string }[] }

export async function getDtiSample(db: string, onProgress: (p: DtiSampleProgress) => void): Promise<DtiSampleResult> {
  setDicomLibrary(dcmjs);
  await loadExtensionHooks();          // the diffusion extension reads dwi/ (logic/import/bids-kinds.ts)
  const root = `${db}/${DOWNLOAD_FOLDER}/${TEST_CASES.dataset}`;
  const s = DTI_SAMPLE.subject;
  const p: DtiSampleProgress = { phase: "starting", bytes: 0 };
  const tick = () => onProgress({ ...p });
  // PRESSED AGAIN: no download when the series it put in the database are still there (the mockup: "Pressed again
  // later: no download; it opens from the database"). The record is what the conversion reported last time.
  const record = `${root}/.sample-${s}.json`;
  try {
    const was = JSON.parse(await Deno.readTextFile(record)) as DtiSampleResult;
    // Its files there, not only its index rows (critic 2026-10-14, 14): the first file of each series is looked at.
    const there = await Promise.all(was.series.map((x) => seriesFileNames(db, x.seriesInstanceUID)
      .then(async (f) => f.length > 0 && await Deno.stat(f[0].startsWith("/") ? f[0] : `${db}/${f[0]}`).then(() => true, () => false), () => false)));
    if (was.series.length >= 3 && there.every(Boolean)) { p.phase = "done"; tick(); return was; }
  } catch { /* no record, or not readable: fetch it */ }
  for (const f of ["dataset_description.json", "participants.tsv", "README"]) {
    if (!(await fetchFile(f, `${root}/${f}`, (n) => { p.bytes += n; }))) throw new Error(`OpenNeuro does not have ${f} for ${TEST_CASES.dataset}`);
  }
  p.phase = "downloading"; tick();
  try {
    for (const rel of filesOf(s)) {
      if (!(await fetchFile(rel, `${root}/${rel}`, (n) => { p.bytes += n; if (p.bytes % (4 << 20) < n) tick(); }))) {
        throw new SampleError("OpenNeuro does not have all of the sample's files right now; try again later", `${rel} is missing`);
      }
    }
  } catch (e) {
    // Whatever stopped the download, its files go (critic 2026-10-14, 9: no NIfTI left in the database folder).
    await Deno.remove(`${root}/sub-${s}`, { recursive: true }).catch(() => {});
    if (e instanceof SampleError) throw e;
    throw new SampleError("the download from OpenNeuro stopped (is this computer online?); press again to continue", (e as Error).message);
  }
  p.phase = "converting"; tick();
  try {
    const ds = await readBidsDataset(root);
    const r = await importBidsSubject(db, ds, s, { session: TEST_CASES.session, masks: [], maskAlgorithm: TEST_CASES.maskAlgorithm, agency: TEST_CASES.agency, agencyReason: TEST_CASES.agencyReason });
    if (r.failed) throw new SampleError("the sample could not be converted to DICOM", r.objects.filter((o) => o.result === "refused").map((o) => `${o.role} (${o.why})`).join("; "));
    const result: DtiSampleResult = { series: r.objects.filter((o) => o.result === "added" || o.result === "already").map((o) => ({ role: o.role, seriesInstanceUID: o.seriesInstanceUID })) };
    // ALL THREE OR NOTHING (critic 2026-10-14, 8): without the diffusion extension only the T1 converts; that is a failure,
    // said so, and no record is written (else every press would download again and "succeed" with the T1 alone).
    const roles = new Set(result.series.map((x) => x.role));
    if (!["T1w", "dwi-AP", "dwi-PA"].every((x) => roles.has(x))) {
      throw new SampleError("the diffusion part of the sample could not be read (the diffusion extension is not loaded here)", `converted: ${[...roles].join(", ") || "nothing"}`);
    }
    await Deno.writeTextFile(record, JSON.stringify(result));
    p.phase = "done"; tick();
    return result;
  } finally {
    // The DICOM copy is the record: the downloaded files go either way (no orphans in the database folder).
    await Deno.remove(`${root}/sub-${s}`, { recursive: true }).catch(() => {});
  }
}
