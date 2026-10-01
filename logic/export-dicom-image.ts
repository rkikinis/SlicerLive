// Write a volume that only exists in the scene back out as a DICOM image series.
//
// Ron, after cropping: "how do I know as a naive user that the cropped volume lives in the scene
// only and I have to save it to the dicom db if I want it to be more permanent? That should be an
// option offered." Until now the only thing that could go INTO the DICOM database was a
// segmentation; a derived volume could be downloaded as a NRRD and nothing more, so the crop that
// makes a FastSurfer run possible died on the next reload -- and any segmentation made on it went
// with it, because a SEG has to reference instances that exist.
//
// SINGLE-FRAME INSTANCES, one file per slice, not one multi-frame object. A multi-frame MR would be
// one write and one index row instead of a few hundred, and it is what the SEG path does -- but this
// application's own reader (readers/dicom-series.ts) treats a file as ONE slice: it reads Rows,
// Columns, PixelData and ImagePositionPatient and never looks at NumberOfFrames. A save that cannot
// be loaded back is not a save, so the format is the one the reader on the other side actually
// reads, which is also the one every archive and every version of Slicer reads.
//
// THE TEMPLATE IS THE SOURCE SERIES' OWN FIRST INSTANCE. Everything that identifies the patient, the
// study and the acquisition is copied rather than re-invented -- including the Clinical Trial
// attribution attributes that carry where public data came from, which Ron asked for by name
// ("proper acknowlegement and URL stashed away in the proper DICOM location"). Only what the
// derivation actually changes is overwritten: the geometry, the pixels, the UIDs, and the fields
// that say this image was DERIVED and from what.
//
// Pure over its inputs (voxels + geometry + the source instance bytes); the caller supplies all three.
import { type DicomJson, dicomIO } from "./dicom-io.ts";
import { PRIVATE_RULE_VERSION, privateToCarry } from "./private-attributes.ts";

/** The single-frame storage class for each modality this can write. */
const LEGACY_SOP_CLASS: Record<string, string> = {
  MR: "1.2.840.10008.5.1.4.1.1.4",
  CT: "1.2.840.10008.5.1.4.1.1.2",
  PT: "1.2.840.10008.5.1.4.1.1.128",
  NM: "1.2.840.10008.5.1.4.1.1.20",
};
const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";

/** `2.25.<random>` — the UID form for locally generated objects (UUID-derived root). */
const newUid = () => `2.25.${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e15)}`;

export interface DicomImageInstance {
  filename: string;
  bytes: Uint8Array;
  /** The row a DICOM index needs to make this instance visible (desktop/db-index.ts IndexMeta). */
  index: {
    sopInstanceUID: string;
    seriesInstanceUID: string;
    studyInstanceUID: string;
    modality: string;
    seriesNumber?: number;
    seriesDate?: string;
    seriesTime?: string;
    seriesDescription?: string;
    frameOfReferenceUID?: string;
    displayedSize?: string;
    numberOfFrames?: number;
    derivedFrom?: { parentSeriesUID: string; kind?: string; label?: string };
  };
}

export interface DicomImageExport {
  instances: DicomImageInstance[];
  seriesInstanceUID: string;
  studyInstanceUID: string;
  /** Bytes over the whole series, for a message that says how much was written. */
  bytes: number;
  slices: number;
  rows: number;
  columns: number;
  /** The source's private attributes, carried slice by slice (logic/private-attributes.ts, rule `privateRule`):
   *  how many elements went into the new files in all, and which tags were left out as private image data. */
  privateCarried: number;
  privateLeftOut: string[];
  privateRule: number;
}

/** A source's ImageType values from the third on (DICOM's value 3 and after), whatever form the dataset holds them in. */
const imageTypeFrom3 = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split("\\") : []).slice(2).filter((x) => x !== "");
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: number[]) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** RAS -> LPS, which is a 180 degree turn about z: orientation-preserving, so cross products carry over. */
const ras2lps = (v: number[]) => [-v[0], -v[1], v[2]];

export interface DicomGeometry {
  /** ImageOrientationPatient: row direction then column direction, in LPS. */
  imageOrientationPatient: number[];
  /** [between rows, between columns] mm — DICOM's order, which is the transpose of the obvious one. */
  pixelSpacing: [number, number];
  sliceSpacing: number;
  /** The plane normal in LPS, cross(row, column). */
  normal: number[];
  /** ImagePositionPatient of slice k, in LPS. */
  positionOf(k: number): [number, number, number];
}

/**
 * The DICOM Image Plane attributes for an `ijkToRAS`, or the reason there are none.
 *
 * DICOM describes a slice by two in-plane direction cosines and a position per slice, so it can only
 * express a grid whose i and j axes are perpendicular and whose k step is along the plane normal. A
 * volume that breaks either could still be WRITTEN -- and would come back a different shape, because
 * the reader derives the through-plane spacing by projecting the first and last positions onto the
 * normal (readers/dicom-series.ts). Silently changing someone's geometry on the way into an archive
 * is the one outcome worth refusing, so this reports instead of rounding.
 *
 * Pure, so the arithmetic is testable without dcmjs.
 */
export function dicomGeometryFor(
  dims: [number, number, number],
  ijkToRAS: number[],
): { ok: true; geom: DicomGeometry } | { ok: false; reason: string } {
  if (!ijkToRAS || ijkToRAS.length < 16) return { ok: false, reason: "the volume has no ijkToRAS" };
  const colOf = (k: number) => [ijkToRAS[k], ijkToRAS[4 + k], ijkToRAS[8 + k]];
  const iv = colOf(0), jv = colOf(1), kv = colOf(2);
  const si = len(iv), sj = len(jv), sk = len(kv);
  if (!(si > 0 && sj > 0 && sk > 0)) return { ok: false, reason: "the volume's axes have no length" };
  const iu = unit(iv), ju = unit(jv), ku = unit(kv);
  const skew = Math.abs(dot(iu, ju));
  if (skew > 1e-3) {
    return { ok: false, reason: `the voxel grid is sheared (its in-plane axes are ${(90 - Math.acos(skew) * 180 / Math.PI).toFixed(1)}° from square), which DICOM cannot describe` };
  }
  const n = cross(iu, ju);
  const alongNormal = dot(ku, n);
  if (Math.abs(alongNormal) < 1 - 1e-3) {
    return { ok: false, reason: `the slices are sheared through-plane (the slice step is ${(Math.acos(Math.min(1, Math.abs(alongNormal))) * 180 / Math.PI).toFixed(1)}° off the plane normal), which DICOM cannot describe` };
  }
  // i indexes COLUMNS (x fastest) and j indexes ROWS, so PixelSpacing -- [between rows, between
  // columns] -- takes them in the other order. Getting this backwards is invisible on the square
  // matrices that are almost everything and wrong on the rest.
  const rowDir = ras2lps(iu), colDir = ras2lps(ju);
  const origin = [ijkToRAS[3], ijkToRAS[7], ijkToRAS[11]];
  return {
    ok: true,
    geom: {
      imageOrientationPatient: [...rowDir, ...colDir],
      pixelSpacing: [sj, si],
      sliceSpacing: sk,
      normal: ras2lps(n),
      positionOf: (k: number) => ras2lps([origin[0] + kv[0] * k, origin[1] + kv[1] * k, origin[2] + kv[2] * k]) as [number, number, number],
    },
  };
}

/**
 * The voxels as DICOM stored values, or the reason they cannot be.
 *
 * DICOM image pixels are integers. The scene holds whatever the volume was loaded as -- a NIfTI can
 * be float, and a reader that applied RescaleSlope has already turned stored values into real ones.
 * Writing floats by scaling them would put different numbers in the archive than the ones on screen,
 * so a volume whose values are not whole is refused and said so. Ron's rule: leave the data as is.
 */
export function toStoredPixels(
  data: ArrayLike<number>,
  /** The source's own rescale, when the values are real values made from whole stored ones (Philips MR): undone
   *  here, exactly, and written back into the header, so the stored numbers are the scanner's again. */
  rescale?: { slope: number; intercept: number },
): { ok: true; pixels: Int16Array | Uint16Array; signed: boolean } | { ok: false; reason: string } {
  let lo = Infinity, hi = -Infinity, fractional = false;
  const stored = rescale ? (v: number) => (v - rescale.intercept) / rescale.slope : (v: number) => v;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) return { ok: false, reason: "the volume holds values that are not numbers (NaN or infinity)" };
    const s = stored(v);
    // A whole stored number, put back through the rescale, must give this value to float32's precision (a relative
    // check: a fixed 0.01 stored units refused slope 0.001 with intercept 1000 -- critic, 2026-09-25, finding 10).
    const w = rescale ? Math.round(s) : s;
    if (rescale ? Math.abs(w * rescale.slope + rescale.intercept - v) > Math.abs(v) * 1e-6 + 1e-9 : !Number.isInteger(s)) { fractional = true; break; }
    if (w < lo) lo = w;
    if (w > hi) hi = w;
  }
  if (fractional) {
    return { ok: false, reason: "the volume holds fractional values, and DICOM image pixels are whole numbers — saving it here would change the data" };
  }
  const signed = lo < 0;
  if (signed ? (lo < -32768 || hi > 32767) : hi > 65535) {
    return { ok: false, reason: `the volume's values run from ${lo} to ${hi}, past what a 16-bit DICOM pixel holds` };
  }
  const pixels = signed ? new Int16Array(data.length) : new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) pixels[i] = Math.round(stored(data[i]));
  return { ok: true, pixels, signed };
}

type Ds = Record<string, unknown>;

/**
 * WHO AND WHAT, for a volume that has no DICOM parent -- a NRRD or NIfTI from a file, a sample.
 * Ron, 2026-09-20: "Data that is not dicom comes from somewhere, gets loaded into albula, gets
 * worked with and finally needs to be stored somewhere so it can be recovered next time." The
 * series is written under a NEW patient and study named here, with the file it came from in the
 * patient's comments, the way the studyforrest case was imported by hand on 2026-09-06.
 */
export interface ExportSubject {
  patientName: string;
  patientID: string;
  /** Where it came from, in words: the file's name, a URL, a DOI. Goes into PatientComments. */
  comments?: string;
  studyDescription?: string;
  /** MR, CT, PT or NM: the kind of image, which a NRRD does not say. */
  modality: string;
  /** To join a study already made (several files of one session: a T1 and its diffusion scan), its UID; else a new one. */
  studyInstanceUID?: string;
  /** The session's patient space, shared by the series acquired in it; else a new one. */
  frameOfReferenceUID?: string;
  /** The study's date and time, the same for every series of one study; "" = unknown (Type 2). Omitted: now. */
  studyDate?: string;
  studyTime?: string;
  /** Further attributes of the patient and study, as the source states them (sex, age, a public dataset's
   *  attribution in the Clinical Trial Subject module). Written as given. */
  extra?: Record<string, unknown>;
}

export interface ImageExportOpts {
  /** For a volume with no source series: the patient and study to create. */
  subject?: ExportSubject;
  seriesDescription?: string;
  /** Free text for DerivationDescription: what was done, in words a person reads. */
  derivation?: string;
  seriesNumber?: number;
  /** The display window to store, so the series looks the way it looked here. */
  window?: { center: number; width: number };
  onProgress?: (p: { phase: string; done?: number; total?: number }) => void;
  /** Stable UIDs, for an import that must give the same series the same identity every time it runs (logic/import/
   *  bids.ts): the series, and one SOP instance UID per slice in slice order. Omitted: new UIDs, as for any save. */
  uids?: { series: string; sops: string[] };
}

/**
 * Build a single-frame DICOM series for `data` on the grid `dims`/`ijkToRAS`.
 *
 * `sourceInstances` are the bytes of the series this volume was derived from: the template for
 * everything about the patient and the study, and the target of the per-slice SourceImageSequence.
 */
export async function volumeToDicomSeries(
  data: ArrayLike<number>,
  dims: [number, number, number],
  ijkToRAS: number[],
  sourceInstances: ArrayBuffer[],
  opts: ImageExportOpts = {},
): Promise<DicomImageExport> {
  if (!sourceInstances.length && !opts.subject) {
    throw new Error("no source DICOM instances: a derived series copies its patient and study from the one it came from -- or name a subject for a volume that has none");
  }
  const [nx, ny, nz] = dims;
  if (nx * ny * nz !== data.length) throw new Error(`${nx}x${ny}x${nz} does not match ${data.length} voxels`);
  const g = dicomGeometryFor(dims, ijkToRAS);
  if (!g.ok) throw new Error(g.reason);
  const { geom } = g;

  const note = (phase: string, done?: number, total?: number) => opts.onProgress?.({ phase, done, total });
  const dcm = await dicomIO();

  note(sourceInstances.length ? `reading ${sourceInstances.length} source instances` : "a new patient and study for this volume");
  const stampNow = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  // A TEMPLATE FROM THE SUBJECT when there is no source: the patient and study modules as the
  // standard wants them, nothing invented beyond what was named, and a new frame of reference.
  const template: Ds = sourceInstances.length
    ? dcm.naturalize(dcm.readFile(sourceInstances[0]).dict) as Ds
    : {
      PatientName: opts.subject!.patientName, PatientID: opts.subject!.patientID, PatientBirthDate: "", PatientSex: "",
      ...(opts.subject!.comments ? { PatientComments: opts.subject!.comments } : {}),
      StudyInstanceUID: opts.subject!.studyInstanceUID ?? newUid(), StudyID: "1", AccessionNumber: "", ReferringPhysicianName: "",
      StudyDate: opts.subject!.studyDate ?? `${stampNow.getFullYear()}${pad2(stampNow.getMonth() + 1)}${pad2(stampNow.getDate())}`,
      StudyTime: opts.subject!.studyTime ?? `${pad2(stampNow.getHours())}${pad2(stampNow.getMinutes())}${pad2(stampNow.getSeconds())}`,
      StudyDescription: opts.subject!.studyDescription ?? "Loaded from a file",
      Modality: opts.subject!.modality, FrameOfReferenceUID: opts.subject!.frameOfReferenceUID ?? newUid(), PositionReferenceIndicator: "",
      Manufacturer: "SlicerAlbula", SeriesDescription: opts.seriesDescription ?? "Volume", SeriesNumber: 1,
      ...(opts.subject!.extra ?? {}),
    };
  // WHICH SOURCE SLICE EACH OUTPUT SLICE CAME FROM, by position along the normal rather than by
  // file order: a crop keeps whole voxels of the same grid, so every output plane coincides with a
  // source plane exactly, and matching on geometry is true regardless of how the instances arrived.
  // Each with its own rescale: an output slice is undone with its own source slice's (PET writes one per slice).
  const sources: { sop: string; sopClass: string; along: number; rescale?: { slope: number; intercept: number }; privates: DicomJson }[] = [];
  const leftOutTags = new Set<string>();
  for (const b of sourceInstances) {
    let ds: Ds;
    let raw: DicomJson;
    try { raw = dcm.readFile(b).dict; ds = dcm.naturalize(raw) as Ds; } catch { continue; /* an unreadable instance is one fewer reference, not a failed save */ }
    // THE SOURCE'S PRIVATE ATTRIBUTES, kept raw: naturalize-then-denaturalize loses every one of them (critic,
    // 2026-09-26, finding 3: 233 -> 0 on a public Philips file). Carried into the slice made from this one, below.
    const { carry, leftOut } = privateToCarry(raw);
    for (const l of leftOut) if (l.why.startsWith("private image data")) leftOutTags.add(l.tag);
    // A MULTI-FRAME SOURCE is refused in plain words, as the SEG writer refuses it (critic, 2026-09-25, finding 9): the
    // new images would lack what the file's per-frame groups say -- the MR attributes, the diffusion b-value and
    // direction, the timing -- and could not name their source frame. Until the writers read the copy's header.
    if (Number(ds.NumberOfFrames ?? 1) > 1 && ds.PerFrameFunctionalGroupsSequence) {
      throw new Error("saving a volume made from a multi-frame image (one file holding all its slices) is not supported yet: the new images would lose what the file says per frame, such as a diffusion b-value, and could not name the frame they came from");
    }
    const ipp = (ds.ImagePositionPatient as number[] | undefined)?.map(Number);
    if (!ipp || ipp.length < 3) continue;
    sources.push({
      sop: String(ds.SOPInstanceUID ?? ""),
      sopClass: String(ds.SOPClassUID ?? ""),
      along: dot(ipp, geom.normal),
      privates: carry,
      ...(ds.RescaleSlope != null ? { rescale: { slope: Number(ds.RescaleSlope), intercept: Number(ds.RescaleIntercept ?? 0) } } : {}),
    });
  }
  const sliceLen = nx * ny;
  const sourceOf = (k: number) => {
    const alongK = dot(geom.positionOf(k), geom.normal);
    const best = sources.reduce<typeof sources[number] | null>((b, s) => (!b || Math.abs(s.along - alongK) < Math.abs(b.along - alongK) ? s : b), null);
    return best && Math.abs(best.along - alongK) <= geom.sliceSpacing * 0.1 ? best : null;
  };
  // Whole values are written as they are. Fractional ones (a Philips MR, a PET, read with their rescale applied) are
  // written as the scanner's stored numbers, each slice with ITS source slice's rescale in its own header -- exact both
  // ways, and a series with a rescale per slice (PET) saves too (critic, 2026-09-25, finding 10).
  let px = toStoredPixels(data);
  let perSlice: ({ slope: number; intercept: number } | undefined)[] | undefined;
  if (!px.ok) {
    const rs = Array.from({ length: nz }, (_, k) => sourceOf(k)?.rescale);
    if (!rs.every((r) => r && r.slope !== 0)) {
      throw new Error("the volume holds fractional values, and not every slice has a source slice whose scaling would turn them back into the scanner's whole numbers — saving it here would change the data");
    }
    const view = (k: number) => (data as unknown as { subarray?(a: number, b: number): ArrayLike<number> }).subarray?.(k * sliceLen, (k + 1) * sliceLen) ?? Array.prototype.slice.call(data, k * sliceLen, (k + 1) * sliceLen);
    const parts = rs.map((r, k) => toStoredPixels(view(k), r));
    const bad = parts.find((q) => !q.ok);
    if (bad && !bad.ok) throw new Error(bad.reason);
    const ok = parts as { ok: true; pixels: Int16Array | Uint16Array; signed: boolean }[];
    const signed = ok.some((q) => q.signed);
    if (signed && ok.some((q) => !q.signed && q.pixels.some((v) => v > 32767))) throw new Error("the slices' stored values need both a signed and an unsigned range, which one DICOM series cannot hold");
    const pixels = signed ? new Int16Array(nz * sliceLen) : new Uint16Array(nz * sliceLen);
    ok.forEach((q, k) => pixels.set(q.pixels, k * sliceLen));
    px = { ok: true, pixels, signed };
    perSlice = rs;
  }
  const modality = String(template.Modality ?? "OT");
  const sopClass = LEGACY_SOP_CLASS[modality];
  if (!sopClass) {
    throw new Error(`this volume's modality is ${modality}, and only MR, CT, PT and NM can be written as a DICOM image series here`);
  }
  const studyInstanceUID = String(template.StudyInstanceUID ?? "");
  const parentSeriesUID = String(template.SeriesInstanceUID ?? "");
  if (opts.uids && opts.uids.sops.length !== nz) throw new Error(`${opts.uids.sops.length} instance UIDs given for ${nz} slices`);
  const seriesInstanceUID = opts.uids?.series ?? newUid();
  const stamp = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}`;
  const time = `${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}`;
  const description = opts.seriesDescription ?? `${template.SeriesDescription ?? "Volume"} (derived)`;
  const seriesNumber = opts.seriesNumber ?? Number(template.SeriesNumber ?? 0) + 1000;

  // EVERYTHING THE SOURCE SAYS, MINUS WHAT IS NO LONGER TRUE.
  //
  // Copying and then deleting, rather than listing what to keep: the attributes worth carrying are
  // the ones nobody thinks of -- the trial sponsor, the protocol, the coil, the sequence parameters,
  // the acknowledgement -- and a keep-list would have dropped every one of them. What must go is
  // what described the OLD pixels or the old object's identity.
  const base: Ds = { ...template };
  for (
    const k of [
      "PixelData", "NumberOfFrames", "PerFrameFunctionalGroupsSequence", "SharedFunctionalGroupsSequence",
      "SmallestImagePixelValue", "LargestImagePixelValue", "PixelPaddingValue", "ICCProfile",
      "LossyImageCompression", "LossyImageCompressionRatio", "LossyImageCompressionMethod",
      "SliceLocation", "InstanceNumber", "SOPInstanceUID", "AcquisitionNumber", "AcquisitionDateTime",
      "ReferencedImageSequence", "SourceImageSequence", "DerivationDescription", "DerivationCodeSequence",
      "_vrMap", "_meta",
    ]
  ) delete base[k];
  // TYPE 2 MEANS PRESENT, POSSIBLY EMPTY (PS3.5 §7.4). A source that leaves one out passed the gap on (dciodvfy,
  // 2026-09-25: PatientSex, StudyTime, AccessionNumber ... on the test series); present and empty adds no information.
  // AcquisitionNumber is deleted above (a derived image is not that acquisition) and is Type 2 in the CT and MR image
  // modules, so it goes back present and empty (dciodvfy on a public TCGA-UCEC crop, 2026-09-28).
  for (const k of ["PatientName", "PatientID", "PatientBirthDate", "PatientSex", "StudyDate", "StudyTime", "ReferringPhysicianName", "StudyID", "AccessionNumber", "PositionReferenceIndicator", "Manufacturer", "AcquisitionNumber"]) {
    if (!(k in base)) base[k] = "";
  }
  // The Clinical Trial Subject module, when the source carries one (a public dataset's attribution): its Type 2 too.
  if (base.ClinicalTrialSponsorName !== undefined || base.ClinicalTrialProtocolID !== undefined) {
    for (const k of ["ClinicalTrialProtocolName", "ClinicalTrialSiteID", "ClinicalTrialSiteName"]) if (!(k in base)) base[k] = "";
  }

  Object.assign(base, {
    SOPClassUID: sopClass,
    SeriesInstanceUID: seriesInstanceUID,
    SeriesNumber: seriesNumber,
    // UTF-8 DECLARED, because the text here comes from node names the user sees and those contain
    // non-ASCII: the interface joins with a middle dot, so a derived volume was written with
    // SeriesDescription "T1w 3D TFE 0.67 mm (cropped) \u00b7 2026-09-07 10:28" -- as raw UTF-8 bytes
    // C2 B7, with SpecificCharacterSet ABSENT.
    //
    // Absent means the DEFAULT REPERTOIRE, so a conforming reader must decode those two bytes as two
    // characters, and Ron saw exactly that in his own subject hierarchy: "Â·". The bytes were never
    // corrupt; the file simply never said what they were, which makes it non-conformant and makes
    // every correct reader -- Slicer, any PACS -- show the mojibake.
    SpecificCharacterSet: "ISO_IR 192",
    SeriesDescription: description,
    SeriesDate: date,
    SeriesTime: time,
    ContentDate: date,
    ContentTime: time,
    // DERIVED and SECONDARY, in the two positions DICOM defines them in: this image was computed
    // from another, and it did not come off the scanner. A derived series labeled ORIGINAL is the
    // kind of quiet untruth that makes an archive untrustworthy. The source's values from the third on stay: the CT
    // Image module requires value 3 (AXIAL or LOCALIZER), and a crop of an axial image is still axial (dciodvfy on a
    // public TCGA-UCEC crop, 2026-09-28: "A value is required for value 3 in CT Images").
    ImageType: ["DERIVED", "SECONDARY", ...imageTypeFrom3(template.ImageType)],
    Rows: ny,
    Columns: nx,
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: px.signed ? 1 : 0,
    SamplesPerPixel: 1,
    PhotometricInterpretation: "MONOCHROME2",
    PixelSpacing: geom.pixelSpacing,
    SliceThickness: geom.sliceSpacing,
    SpacingBetweenSlices: geom.sliceSpacing,
    ImageOrientationPatient: geom.imageOrientationPatient,
  });
  if (opts.derivation) base.DerivationDescription = opts.derivation;
  // The scene's values are REAL values: the reader already applied the source's rescale on the way
  // in, so re-declaring that slope here would apply it twice. Identity for a modality that needs the
  // attributes (CT is in Hounsfield units by definition of them), absent for one that does not.
  if (perSlice) { delete base.RescaleSlope; delete base.RescaleIntercept; }   // each instance states its own, below
  else if (modality === "CT" || modality === "PT") { base.RescaleSlope = 1; base.RescaleIntercept = 0; }
  else { delete base.RescaleSlope; delete base.RescaleIntercept; }
  if (opts.window) { base.WindowCenter = opts.window.center; base.WindowWidth = opts.window.width; }

  const instances: DicomImageInstance[] = [];
  let total = 0;
  let privateCarried = 0;
  for (let k = 0; k < nz; k++) {
    if (k % 32 === 0) {
      note("writing slices", k, nz);
      await new Promise((r) => setTimeout(r, 0));         // let the progress reach the screen
    }
    const sop = opts.uids?.sops[k] ?? newUid();
    const ipp = geom.positionOf(k);
    const alongK = dot(ipp, geom.normal);
    const frame = px.pixels.slice(k * sliceLen, (k + 1) * sliceLen);
    // The source slice on this same plane, within a tenth of a slice: the derivation record, per
    // image, which is what lets a reader ask what this pixel data was made from.
    const from = sourceOf(k);
    const ds: Ds = {
      ...base,
      SOPInstanceUID: sop,
      InstanceNumber: k + 1,
      ImagePositionPatient: [ipp[0], ipp[1], ipp[2]],
      SliceLocation: alongK,
      PixelData: [frame.buffer],
      ...(from?.sop ? { SourceImageSequence: [{ ReferencedSOPClassUID: from.sopClass, ReferencedSOPInstanceUID: from.sop }] } : {}),
      ...(perSlice?.[k] ? { RescaleSlope: perSlice[k]!.slope, RescaleIntercept: perSlice[k]!.intercept } : {}),
      // 16-bit pixels are OW. The template's own _vrMap was dropped above, so this is stated rather
      // than inherited from whatever the source happened to be encoded as.
      _vrMap: { PixelData: "OW" },
      _meta: {
        MediaStorageSOPClassUID: { Value: [sopClass], vr: "UI" },
        MediaStorageSOPInstanceUID: { Value: [sop], vr: "UI" },
        TransferSyntaxUID: { Value: [EXPLICIT_VR_LE], vr: "UI" },
      },
    };
    const file = dcm.toFile(ds);
    // The private attributes of THIS slice's source slice, as they were (a vendor's per-slice values stay with their
    // slice). A slice with no source on its plane carries none.
    if (from) { Object.assign(file.dict, from.privates); privateCarried += Object.keys(from.privates).length; }
    const bytes = new Uint8Array(file.write());
    total += bytes.byteLength;
    instances.push({
      filename: `${sop}.dcm`,
      bytes,
      index: {
        sopInstanceUID: sop,
        seriesInstanceUID,
        studyInstanceUID,
        modality,
        seriesNumber,
        seriesDate: date,
        seriesTime: time,
        seriesDescription: description,
        frameOfReferenceUID: String(template.FrameOfReferenceUID ?? ""),
        displayedSize: `${nx}x${ny}`,
        numberOfFrames: 1,
        derivedFrom: parentSeriesUID ? { parentSeriesUID, kind: "crop", label: description } : undefined,
        ...(opts.subject ? { newStudy: { patientName: opts.subject.patientName, patientID: opts.subject.patientID, patientComments: opts.subject.comments, studyDescription: String(template.StudyDescription ?? ""), studyDate: String(template.StudyDate ?? ""), studyTime: String(template.StudyTime ?? "") } } : {}),
      },
    });
  }
  note("written", nz, nz);
  return {
    instances, seriesInstanceUID, studyInstanceUID, bytes: total, slices: nz, rows: ny, columns: nx,
    privateCarried, privateLeftOut: [...leftOutTags].sort(), privateRule: PRIVATE_RULE_VERSION,
  };
}
