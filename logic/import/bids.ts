// A BIDS SUBJECT AS A DICOM STUDY -- the import Ron asked for on 2026-09-28 ("convert to proper dicom"; "we are likely
// to need the conversion to dicom repeatedly. Make sure that you have a reasonable tool"), first for the OpenNeuro
// diffusion MRI cases (Contents/docs/dmri-review-2026-09-28.md in the workspace).
//
// BIDS (bids.neuroimaging.io) is how OpenNeuro and most public neuroimaging data are laid out: NIfTI files per
// subject and session, a JSON "sidecar" per scan saying how it was acquired, .bval/.bvec beside a diffusion scan,
// dataset_description.json (name, license, DOI, authors) and participants.tsv at the top, derived data under
// derivatives/. This module reads one subject/session and BUILDS the DICOM objects, touching no database:
//   - each anatomical scan (anat/*_T1w, *_T2w, *_FLAIR ...) -> an MR image series (logic/export-dicom-image.ts);
//   - each diffusion scan (dwi/*_dwi + .bval/.bvec) -> ONE Enhanced MR Image object (logic/export-dicom-dwi.ts);
//   - each label mask named in `masks` (derivatives/<name>/sub-X/anat/*_space_T1_label-<what>.nii) -> a label-map SEG
//     on the T1 series, the mask's fractional values cut at one half.
// The caller writes the files and indexes them (Contents/tools/bids-to-dicom.ts does both).
//
// IDENTITY. Every UID is DERIVED (a name-based UUID, PS3.5 B.2) from the dataset's DOI (or name), the subject, the
// session and the object's source file, so importing the same subject twice WITH THE SAME CODE gives the same UIDs: the
// database already has them, and the tool says so instead of making a duplicate. Each kind of object also carries its
// writer's rule number (IMAGE_RULE, DWI_RULE, MASK_RULE): when a fix changes what an object holds, bumping its rule gives
// the corrected object new series and instance UIDs under the SAME study, and the tool can then remove the older one
// (--replace-older). The study and frame-of-reference UIDs never carry a rule. PatientName "<dataset name> <subject>", PatientID "<accession>-<subject>". The dataset's
// attribution goes where DICOM keeps it for public data (the Clinical Trial Subject module: sponsor, protocol, subject)
// and into PatientComments (DOI, license, authors). Sex and age come from participants.tsv when it has them.
// Nothing is invented: what BIDS does not say is left empty, as the standard allows for Type 2 attributes -- including
// the study date and time, which BIDS does not keep (the import's clock is not the scan's). Each diffusion scan's sidecar
// is kept in the object's private block (PS3.5 §7.8) minus the fields in SIDECAR_LEFT_OUT (who and where: institution,
// address, station, serial number), the same rule as for the anatomical series.
//
// ONE SCAN THAT CANNOT BE WRITTEN is skipped and named (`skipped`), not the end of the subject: e.g. a NIfTI whose value
// scale makes its voxels fractional (DICOM image pixels are whole numbers; writing the stored integers with their scale
// is still to do).
import { parseNiftiVolumes, type Volume } from "../readers/nifti.ts";
import { bidsKinds, type BidsKindContext } from "./bids-kinds.ts";
import { volumeToDicomSeries } from "../export-dicom-image.ts";
import { segmentationToDicomSeg } from "../export-dicom-seg.ts";
import { codesFor, lookupStructure } from "../segment-naming.ts";
import { paletteRgb } from "../anatomy/palettes.ts";

export const BIDS_IMPORT_VERSION = 2;
/** WHAT EACH KIND OF OBJECT BECOMES -- part of its series and instance UIDs, so a change in what is written gives a new
 *  object rather than a second, different object under an old UID. Bump one whenever its content changes.
 *  Mask 1 -> 2, 2026-09-28: the NIfTI reader applies scl_slope (version 1 took every voxel above zero).
 *  All 2 -> 3 (mask) / 1 -> 2 (image, diffusion), 2026-09-29, the critic's round (qa/2026-09-28-dmri-import.md): no
 *  invented study dates, the sidecar's who-and-where left out, ISOTROPIC for a direction-less b > 0, UUID-form UIDs. */
export const IMAGE_RULE = 2;
export const MASK_RULE = 3;

/** Sidecar fields NOT kept in an object's private block (a kind of an extension keeps its sidecar there), as they are not written for the anatomical series
 *  either: who and where, not how the scan was made (critic 2026-09-28, finding 2). */
export const SIDECAR_LEFT_OUT = ["InstitutionName", "InstitutionAddress", "InstitutionalDepartmentName", "StationName",
  "DeviceSerialNumber", "ReferringPhysicianName", "PatientName", "PatientID", "PatientBirthDate", "OperatorsName", "PerformingPhysicianName"];

export interface BidsDataset {
  root: string;
  name: string;
  /** The OpenNeuro accession ("ds001226") when the DOI or path names one, else the name. */
  id: string;
  doi?: string;
  license?: string;
  authors: string[];
  participants: Record<string, Record<string, string>>;
}

/** What one import built, and what it could not. */
export interface BidsBuild {
  objects: BuiltObject[];
  /** A file that was looked at and not turned into DICOM, and why -- nothing is passed over silently. */
  skipped: { file: string; why: string }[];
}

/** One object ready to be written: its files (names only; the caller picks the folder), each with the row a DICOM
 *  index needs (desktop/db-index.ts IndexMeta -- the first object of the study carries `newStudy`). */
export interface BuiltObject {
  role: string;
  description: string;
  seriesInstanceUID: string;
  files: { name: string; bytes: Uint8Array; index: IndexRow }[];
  /** What the builder checked or decided, in words, for the record. */
  notes: string[];
}
/** The index row, as the writers return it (structurally desktop/db-index.ts IndexMeta, which logic/ does not import). */
export type IndexRow = {
  sopInstanceUID: string; seriesInstanceUID: string; studyInstanceUID: string; modality: string;
  seriesNumber?: number; seriesDate?: string; seriesTime?: string; seriesDescription?: string; frameOfReferenceUID?: string;
  displayedSize?: string; numberOfFrames?: number;
  derivedFrom?: { parentSeriesUID: string; kind?: string; label?: string };
  newStudy?: { patientName: string; patientID: string; patientComments?: string; studyDescription?: string; studyDate?: string; studyTime?: string; patientSex?: string; patientAge?: string };
};

/** Albula's namespace for the name-based UUIDs below (a fixed random UUID, made once, 2026-09-29). */
const UUID_NAMESPACE = "6f1b7c0e-3d5a-4b8e-9c21-a4e7d0f25b93";

/** 2.25.<decimal of a name-based (version 5, SHA-1) UUID of the parts> -- the same inputs give the same UID, in the
 *  form PS3.5 B.2 defines for 2.25 UIDs (a UUID per ITU-T X.667, version and variant bits set). */
export async function derivedUid(...parts: string[]): Promise<string> {
  const ns = UUID_NAMESPACE.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16));
  const name = new TextEncoder().encode(parts.join("|"));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array([...ns, ...name]))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;      // version 5
  h[8] = (h[8] & 0x3f) | 0x80;      // RFC 4122 variant
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(h[i]);
  return `2.25.${n.toString()}`;
}

async function readText(path: string): Promise<string | undefined> { try { return await Deno.readTextFile(path); } catch { return undefined; } }
async function exists(path: string): Promise<boolean> { try { await Deno.stat(path); return true; } catch { return false; } }

export async function readBidsDataset(root: string): Promise<BidsDataset> {
  const desc = JSON.parse((await readText(`${root}/dataset_description.json`)) ?? "{}");
  const doi = typeof desc.DatasetDOI === "string" ? desc.DatasetDOI.replace(/^doi:/i, "") : undefined;
  const id = /\b(ds\d{6})\b/.exec(`${doi ?? ""} ${root}`)?.[1] ?? String(desc.Name ?? "dataset").replace(/\W+/g, "_");
  const participants: BidsDataset["participants"] = {};
  const tsv = await readText(`${root}/participants.tsv`);
  if (tsv) {
    const [head, ...rows] = tsv.trim().split(/\r?\n/).map((l) => l.split("\t").map((c) => c.trim()));
    for (const r of rows) participants[r[0]] = Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]));
  }
  return { root, name: String(desc.Name ?? id), id, doi, license: desc.License, authors: Array.isArray(desc.Authors) ? desc.Authors.map(String) : [], participants };
}

/**
 * A BIDS sidecar's acquisition fields as the DICOM MR Image module names them (dcm2niix wrote the sidecar from the
 * scanner's own DICOM, so this is putting them back). BIDS keeps times in seconds, DICOM in milliseconds; dcm2niix joins
 * multi-valued fields with "_". The Type 2 attributes are written present and empty when the sidecar is silent.
 * Institution, address and serial number are left out: not needed, and a public dataset is better without them.
 */
export function sidecarToDicom(side: Record<string, unknown>): Record<string, unknown> {
  const multi = (v: unknown) => (typeof v === "string" && v ? v.split("_") : Array.isArray(v) ? v.map(String) : undefined);
  const ms = (v: unknown) => (typeof v === "number" ? Number((v * 1000).toPrecision(8)) : "");
  const out: Record<string, unknown> = {
    ScanningSequence: multi(side.ScanningSequence) ?? ["RM"],     // Type 1; RM (research mode) when the sidecar is silent
    SequenceVariant: multi(side.SequenceVariant) ?? ["NONE"],     // Type 1
    ScanOptions: multi(side.ScanOptions) ?? "",
    MRAcquisitionType: typeof side.MRAcquisitionType === "string" ? side.MRAcquisitionType : "",
    RepetitionTime: ms(side.RepetitionTime),
    EchoTime: ms(side.EchoTime),
    EchoTrainLength: typeof side.EchoTrainLength === "number" ? side.EchoTrainLength : "",
    PatientPosition: typeof side.PatientPosition === "string" ? side.PatientPosition : "",
  };
  if (typeof side.InversionTime === "number") out.InversionTime = ms(side.InversionTime);
  if (typeof side.FlipAngle === "number") out.FlipAngle = side.FlipAngle;
  if (typeof side.MagneticFieldStrength === "number") out.MagneticFieldStrength = side.MagneticFieldStrength;
  if (typeof side.SequenceName === "string") out.SequenceName = side.SequenceName.slice(0, 16);
  if (typeof side.ProtocolName === "string") out.ProtocolName = side.ProtocolName.slice(0, 64);
  // Laterality (Type 2C) is required for a paired body part; with the part named (HEAD) it must be absent, with no part
  // named the condition cannot be settled and dciodvfy asks for it -- so present and empty then (2026-09-28).
  if (typeof side.BodyPartExamined === "string") out.BodyPartExamined = side.BodyPartExamined.slice(0, 16);
  else out.Laterality = "";
  if (typeof side.Manufacturer === "string") out.Manufacturer = side.Manufacturer.slice(0, 64);
  if (typeof side.ManufacturersModelName === "string") out.ManufacturerModelName = side.ManufacturersModelName.slice(0, 64);
  if (typeof side.SoftwareVersions === "string") out.SoftwareVersions = side.SoftwareVersions.slice(0, 64);
  // Value 3 and on of the scanner's Image Type (M, ND, NORM ...): the writer puts DERIVED\SECONDARY in front.
  if (Array.isArray(side.ImageType)) out.ImageType = side.ImageType.map(String);
  return out;
}

/** The mask's values carried onto the T1's grid voxel by voxel (both are in the same patient space; the index order
 *  may differ -- this dataset's masks are LAS, its T1s RAS), cut at one half. Refuses grids that do not coincide: the
 *  same voxel size (a finer mask would be thinned out, critic finding 4a), every T1 voxel center on a mask voxel center,
 *  and every mask voxel at or above the cut inside the T1 (4b). */
export function maskOnGrid(mask: Volume, grid: Volume): { labels: Uint8Array; voxels: number } {
  const spacing = (m: number[]) => [0, 1, 2].map((c) => Math.hypot(m[c], m[4 + c], m[8 + c])).sort((a, b) => a - b);
  const sm = spacing(mask.ijkToRAS), sg = spacing(grid.ijkToRAS);
  if (sm.some((x, i) => Math.abs(x - sg[i]) > 1e-3 * sg[i])) {
    throw new Error(`the mask's voxels (${sm.map((x) => x.toFixed(3)).join(" × ")} mm) are not the T1's (${sg.map((x) => x.toFixed(3)).join(" × ")} mm): resampling a label is not this import's job`);
  }
  let marked = 0;
  for (let v = 0; v < mask.data.length; v++) if (mask.data[v] >= 0.5) marked++;
  const inv = (m: number[]) => {
    const A = m[5] * m[10] - m[6] * m[9], B = -(m[4] * m[10] - m[6] * m[8]), C = m[4] * m[9] - m[5] * m[8], det = m[0] * A + m[1] * B + m[2] * C;
    const R = [A, -(m[1] * m[10] - m[2] * m[9]), m[1] * m[6] - m[2] * m[5], B, m[0] * m[10] - m[2] * m[8], -(m[0] * m[6] - m[2] * m[4]), C, -(m[0] * m[9] - m[1] * m[8]), m[0] * m[5] - m[1] * m[4]].map((x) => x / det);
    const t = [m[3], m[7], m[11]];
    return [R[0], R[1], R[2], -(R[0] * t[0] + R[1] * t[1] + R[2] * t[2]), R[3], R[4], R[5], -(R[3] * t[0] + R[4] * t[1] + R[5] * t[2]), R[6], R[7], R[8], -(R[6] * t[0] + R[7] * t[1] + R[8] * t[2])];
  };
  const G = grid.ijkToRAS, Mi = inv(mask.ijkToRAS);
  const [nx, ny, nz] = grid.dims, [mx, my, mz] = mask.dims;
  const labels = new Uint8Array(nx * ny * nz);
  let voxels = 0, off = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = G[0] * i + G[1] * j + G[2] * k + G[3], y = G[4] * i + G[5] * j + G[6] * k + G[7], z = G[8] * i + G[9] * j + G[10] * k + G[11];
    const u = Mi[0] * x + Mi[1] * y + Mi[2] * z + Mi[3], v = Mi[4] * x + Mi[5] * y + Mi[6] * z + Mi[7], w = Mi[8] * x + Mi[9] * y + Mi[10] * z + Mi[11];
    const ri = Math.round(u), rj = Math.round(v), rk = Math.round(w);
    off = Math.max(off, Math.abs(u - ri), Math.abs(v - rj), Math.abs(w - rk));
    if (ri < 0 || rj < 0 || rk < 0 || ri >= mx || rj >= my || rk >= mz) continue;
    if (mask.data[(rk * my + rj) * mx + ri] >= 0.5) { labels[(k * ny + j) * nx + i] = 1; voxels++; }
  }
  if (off > 1e-2) throw new Error(`the mask is not on the T1's grid (its voxels fall ${off.toFixed(2)} of a voxel off): resampling a label is not this import's job`);
  if (voxels !== marked) throw new Error(`${marked - voxels} of the mask's ${marked} voxels lie outside the T1: it was not drawn on this T1`);
  return { labels, voxels };
}

export interface BidsImportOptions {
  /** Derivative folders holding label masks in T1 space (e.g. "tumor_masks"). */
  masks?: string[];
  /** How the masks were made, as the dataset says (ds001226's README: "a combination of manual delineation and
   *  disconnectome"): written SEMIAUTOMATIC with this name. Absent: MANUAL, no name. */
  maskAlgorithm?: string;
  /** Applicable Safety Standard Agency for Enhanced MR objects (the standard requires it; the diffusion extension's kind
   *  writes them): IEC, FDA or MHW, and why.
   *  Required when the session has a diffusion scan; checked before anything is built. */
  safetyStandardAgency?: "IEC" | "FDA" | "MHW";
  safetyReason?: string;
  onProgress?: (msg: string) => void;
}

/** A mask file name: ds001226's own (`sub-X_space_T1_label-tumor.nii`) or the BIDS derivatives form
 *  (`sub-X[_ses-Y]_space-T1w[_...]_label-tumor_mask.nii.gz`). A `_dseg` (several labels, with a lookup table) is not a
 *  mask and is named as skipped. */
const MASK_NAME = /_space[-_]T1w?(?:_[a-zA-Z]+-[A-Za-z0-9]+)*?_label-([A-Za-z0-9]+)(_mask)?\.nii(\.gz)?$/;

/** Build every DICOM object of one subject (and session) of a BIDS dataset. */
export async function buildBidsSubject(ds: BidsDataset, subject: string, session: string | undefined, opts: BidsImportOptions): Promise<BidsBuild> {
  const say = opts.onProgress ?? (() => {});
  const sub = subject.startsWith("sub-") ? subject : `sub-${subject}`;
  const ses = session ? (session.startsWith("ses-") ? session : `ses-${session}`) : undefined;
  const dir = `${ds.root}/${sub}${ses ? `/${ses}` : ""}`;
  if (!(await exists(dir))) throw new Error(`no such subject/session in the dataset: ${dir}`);
  const files = async (d: string) => (await exists(d)) ? [...Deno.readDirSync(d)].map((x) => x.name).sort() : [];
  const skipped: BidsBuild["skipped"] = [];
  const skip = (file: string, why: string) => { skipped.push({ file, why }); say(`skipped ${file}: ${why}`); };


  const key = ds.doi ?? ds.name;
  const studyUID = await derivedUid(key, sub, ses ?? "", "study");
  const forUID = await derivedUid(key, sub, ses ?? "", "frame of reference");
  const p = ds.participants[sub] ?? {};
  const col = (...names: string[]) => { for (const n of names) { const v = (p[n] ?? "").trim(); if (v && v.toLowerCase() !== "n/a") return v; } return ""; };
  const sexRaw = col("sex").toUpperCase().slice(0, 1);
  const sex = sexRaw === "M" || sexRaw === "F" || sexRaw === "O" ? sexRaw : "";
  const ageNum = Number(col("age"));
  const age = Number.isFinite(ageNum) && ageNum > 0 ? `${String(Math.round(ageNum)).padStart(3, "0")}Y` : "";
  const height = Number(col("height (cm)", "height")), weight = Number(col("weight (kg)", "weight"));
  const diagnosis = col("tumor type & grade", "diagnosis");
  // As the first OpenNeuro import did (ds000113, 2026-09-16: "studyforrest sub-01", "ds000113-sub-01").
  const patientName = `${ds.name} ${sub}`, patientID = `${ds.id}-${sub}`;
  const comments = [`BIDS dataset "${ds.name}"`, ds.doi && `doi:${ds.doi}`, ds.license && `license ${ds.license}`, ds.authors.length && `authors ${ds.authors.join("; ")}`,
    `imported by SlicerAlbula (bids import ${BIDS_IMPORT_VERSION})`].filter(Boolean).join(" · ");
  const extra: Record<string, unknown> = {
    ...(sex ? { PatientSex: sex } : {}),
    ...(age ? { PatientAge: age } : {}),
    // Patient Study module: size in meters, weight in kilograms; the dataset's diagnosis column as the admitting diagnosis.
    ...(height > 0 ? { PatientSize: Number((height / 100).toFixed(2)) } : {}),
    ...(weight > 0 ? { PatientWeight: weight } : {}),
    ...(diagnosis && diagnosis.toLowerCase() !== "none" ? { AdmittingDiagnosesDescription: diagnosis.slice(0, 64) } : {}),
    ClinicalTrialSponsorName: ds.doi?.includes("openneuro") ? "OpenNeuro" : ds.name,
    ClinicalTrialProtocolID: ds.id, ClinicalTrialProtocolName: ds.name,
    ClinicalTrialSiteID: "", ClinicalTrialSiteName: "", ClinicalTrialSubjectID: sub,
  };
  const studyDescription = `${ds.name}${ses ? ` ${ses.slice(4)}` : ""}`;
  // No study date or time: BIDS keeps none, and every series of the study must say the same (critic finding 3).
  const studyDate = "", studyTime = "";
  const newStudy = { patientName, patientID, patientComments: comments, studyDescription, studyDate, studyTime, patientSex: sex, patientAge: age };
  const uid = (...role: string[]) => derivedUid(key, sub, ses ?? "", ...role);
  const objects: BuiltObject[] = [];
  let seriesNumber = 1;
  const kindCtx: BidsKindContext = {
    dir, files: (folder) => files(`${dir}/${folder}`), readText,
    study: { patientName, patientID, studyInstanceUID: studyUID, frameOfReferenceUID: forUID, studyDescription, comments, extra, studyDate, studyTime, newStudy },
    uid, nextSeriesNumber: () => seriesNumber++, sidecarLeftOut: SIDECAR_LEFT_OUT, options: opts as unknown as Record<string, unknown>, skip, say,
  };
  // Checked before anything is built (critic finding 8), each kind its own conditions.
  for (const k of bidsKinds()) await k.check?.(kindCtx);

  // ANATOMICAL SCANS -> MR image series, one file per slice.
  const anat = `${dir}/anat`;
  const t1s: { volume: Volume; instances: ArrayBuffer[]; seriesUID: string; file: string }[] = [];
  for (const e of await files(anat)) {
    const m = /^(.*_(T1w|T2w|FLAIR|PDw|T2starw))\.nii(\.gz)?$/.exec(e);
    if (!m) continue;
    say(`reading ${e}`);
    try {
      const vols = await parseNiftiVolumes(await Deno.readFile(`${anat}/${e}`), e);
      if (vols.length !== 1) { skip(e, `${vols.length} volumes (a 4D anatomical scan is not handled)`); continue; }
      const v = vols[0];
      const side = JSON.parse((await readText(`${anat}/${m[1]}.json`)) ?? "{}");
      const desc = String(side.SeriesDescription ?? m[2]).slice(0, 64);
      const sops = await Promise.all(Array.from({ length: v.dims[2] }, (_, k) => uid(m[1], `image rule ${IMAGE_RULE}`, "slice", String(k))));
      const exp = await volumeToDicomSeries(v.data as ArrayLike<number>, v.dims, v.ijkToRAS, [], {
        subject: { patientName, patientID, comments, studyDescription, modality: "MR", studyInstanceUID: studyUID, frameOfReferenceUID: forUID, studyDate, studyTime, extra: { ...extra, ...sidecarToDicom(side) } },
        seriesDescription: desc, seriesNumber: seriesNumber++,
        uids: { series: await uid(m[1], `image rule ${IMAGE_RULE}`, "series"), sops },
      });
      objects.push({
        role: m[2], description: `${m[2]}: ${e}, ${v.dims.join("×")}`, seriesInstanceUID: exp.seriesInstanceUID,
        // Every row of a subject-made series carries newStudy; the index takes it once (with sex and age for the
        // patient row the browser shows, critic finding 16).
        files: exp.instances.map((i) => ({ name: i.filename, bytes: i.bytes, index: { ...(i.index as IndexRow), newStudy } })),
        notes: [`${exp.slices} slices`],
      });
      if (m[2] === "T1w") t1s.push({ volume: v, seriesUID: exp.seriesInstanceUID, file: e, instances: exp.instances.map((i) => i.bytes.slice().buffer as ArrayBuffer) });
    } catch (err) { skip(e, (err as Error).message); }
  }

  // THE KINDS EXTENSIONS REGISTER (bids-kinds.ts): diffusion scans, and whatever comes next.
  for (const k of bidsKinds()) objects.push(...await k.build(kindCtx));
  // A FOLDER NO INSTALLED EXTENSION READS is named, not passed over (diffusion without the diffusion extension, say).
  const read = new Set(["anat", ...bidsKinds().flatMap((k) => k.folders)]);
  for (const f of await files(dir)) {
    if (read.has(f) || f.startsWith(".") || !Deno.statSync(`${dir}/${f}`).isDirectory) continue;
    for (const e of await files(`${dir}/${f}`)) skip(`${f}/${e}`, `no installed extension imports the ${f}/ folder`);
  }

  // LABEL MASKS IN T1 SPACE -> a label-map SEG drawn on the T1 series.
  const sessions = (await files(`${ds.root}/${sub}`)).filter((x) => x.startsWith("ses-"));
  for (const name of opts.masks ?? []) {
    // With the session in the path, or without it (ds001226's masks: derivatives/tumor_masks/sub-PAT16/anat/) -- the
    // latter only when the subject has ONE session; with several it is unknown which T1 it was drawn on (finding 5).
    const withSes = `${ds.root}/derivatives/${name}/${sub}${ses ? `/${ses}` : ""}/anat`;
    const without = `${ds.root}/derivatives/${name}/${sub}/anat`;
    let mdir = withSes;
    if (!(await exists(withSes))) {
      if (sessions.length > 1) {
        for (const e of await files(without)) skip(`${name}/${e}`, `stored without a session, and ${sub} has ${sessions.length} sessions: which T1 it was drawn on is unknown`);
        continue;
      }
      mdir = without;
    }
    for (const e of await files(mdir)) {
      if (!/\.nii(\.gz)?$/.test(e)) continue;
      const m = MASK_NAME.exec(e);
      if (!m) { skip(`${name}/${e}`, /_dseg\.nii/.test(e) ? "a multi-label segmentation (_dseg) is not handled yet" : "not a mask in T1 space by its name (…_space-T1w_label-<what>[_mask].nii)"); continue; }
      if (!t1s.length) { skip(`${name}/${e}`, "no T1 series to draw it on"); continue; }
      if (t1s.length > 1) { skip(`${name}/${e}`, `${t1s.length} T1 scans (${t1s.map((t) => t.file).join(", ")}): which one it was drawn on is unknown`); continue; }
      const t1 = t1s[0];
      say(`reading ${e}`);
      try {
        const mask = (await parseNiftiVolumes(await Deno.readFile(`${mdir}/${e}`), e))[0];
        const { labels, voxels } = maskOnGrid(mask, t1.volume);
        const what = m[1], label = what.charAt(0).toUpperCase() + what.slice(1);
        // WHAT THE SEGMENT IS, from the one place codes and colors live (logic/segment-naming.ts, logic/anatomy/; Mike
        // Halle's rule, enforced by logic/anatomy/one-place.test.ts): the mask's own label first, and for a tumor with no
        // entry of its own, the catalog's "neoplasm" (today SNOMED CT Neoplasm, the liver tumor's concept and color). A
        // finer term (glioma, astrocytoma) is the semantics line's decision, not this import's.
        const isTumor = /tumou?r|neoplasm/i.test(what);
        const found = lookupStructure(what) ?? (isTumor ? lookupStructure("neoplasm") : null);
        const codes = codesFor(found ? (found.key ?? what) : what);
        const rgb = paletteRgb(found?.key);
        const seg = await segmentationToDicomSeg(labels, t1.volume.dims, [{
          labelValue: 1, name: label, ...codes, ...(rgb ? { color: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] as [number, number, number] } : {}),
        }], t1.instances, {
          seriesDescription: `${label} (${name})`.slice(0, 64),
          ...(opts.maskAlgorithm ? { algorithmType: "SEMIAUTOMATIC" as const, algorithmName: opts.maskAlgorithm.slice(0, 64) } : { algorithmType: "MANUAL" as const }),
          uids: { series: await uid(e, `mask rule ${MASK_RULE}`, "series"), sop: await uid(e, `mask rule ${MASK_RULE}`, "instance") },
        });
        objects.push({
          role: `seg-${what}`, description: `${label}: ${e}, ${voxels} voxels at 0.5 or more`, seriesInstanceUID: seg.seriesInstanceUID,
          files: [{ name: seg.filename, bytes: seg.bytes, index: { ...seg.index, seriesNumber: seriesNumber++ } as IndexRow }],
          notes: [`the mask's fractional values cut at 0.5: ${voxels} voxels`, codes.code ? `coded ${codes.code} ${codes.type ?? ""} (from the catalog's "${found?.key}"; a finer term is the semantics line's decision)` : "no code: the catalog has no entry for this label"],
        });
      } catch (err) { skip(`${name}/${e}`, (err as Error).message); }
    }
  }
  if (!objects.length) throw new Error(`nothing to import in ${dir}${skipped.length ? `: ${skipped.map((x) => `${x.file} (${x.why})`).join("; ")}` : " (no anat/*_T1w..., and no folder an installed extension imports)"}`);
  return { objects, skipped };
}
