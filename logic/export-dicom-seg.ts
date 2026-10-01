// Write a segmentation back out as a DICOM SEG object, referencing the series it was drawn on.
//
// WHY DICOM AND NOT ANOTHER NRRD: a segmentation that leaves this application has to be findable
// next to the images it belongs to, and DICOM SEG is the only encoding the archive, Slicer's DICOM
// database and IDC all already understand. The UID hierarchy and the referenced-instance sequence
// are what make "this is a segmentation OF that series" survive the trip.
//
// THE SAFE ROUTE, deliberately: this produces a FILE. It does not touch ctkDICOM.sql. Writing rows
// into a SQLite index that Slicer may have open, for a database holding ~18 GB of patient imaging,
// is a bad trade for saving one click -- so the file is written where Slicer can import it, and
// Slicer does the indexing with the code that owns it.
//
// TWO FORMS, SINCE 2026-09-18. The LABEL MAP object (Supplement 243, a SOP class of its own) is
// the default: one 8-bit frame per slice whose value is the segment number, the dataset deflated --
// on Ron's whole-body result 978 MB of one-bit planes became 3.1 MB, and the read loses the 6.5 s
// of unpacking bit planes. Ron, 2026-09-18: "the time lost creating the labelmaps is offset by the
// improved speed of uploading. The only caveat is that we don't know whether overlap will occur in
// the future" -- so the BINARY form (one bit plane per segment per slice) stays, for a caller that
// has overlapping structures to write; this function takes one byte labelmap and cannot overlap.
// See `form` and `compress` in the options.
//
// Pure over its inputs (labels + source instance bytes); the panel supplies both.
import { dicomIO } from "./dicom-io.ts";
import { deflateDicomFile } from "./dicom-deflate.ts";
import { mappingVersions } from "./anatomy/catalogue.ts";

export interface SegExportSegment {
  labelValue: number;
  name: string;
  /** 0..1 RGB, as the scene holds it. */
  color?: [number, number, number];
  /**
   * The coded concept for what this segment IS, as `SCHEME:VALUE` — e.g. `SCT:10200004` for liver.
   *
   * This is the field that makes a SEG mean something to a machine. `SegmentLabel` is free text and
   * only a human reads it; the coded Type is what a search across an archive matches on, so a
   * segmentation whose segments are only labeled is findable by eye and by nothing else.
   */
  code?: string;
  /**
   * The coded type's own MEANING ("Kidney"), which is what goes in the type sequence's CodeMeaning.
   * Without it the readable name stands in, and "Kidney, right" is not the meaning of 64033007.
   */
  type?: string;
  /** "Left" | "Right" -- laterality, written as the type MODIFIER, where DICOM puts it. */
  mod?: string;
  /** The SNOMED category when it is not an anatomical structure: a cyst, an implant, a tissue. */
  category?: string;
}

export interface DicomSegExport {
  bytes: Uint8Array;
  /** The object's SOP class: the label map's (…66.7) or the binary form's (…66.4). */
  sopClassUID: string;
  filename: string;
  frames: number;
  segments: number;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  /** The row a DICOM index needs to make this file visible. */
  index: {
    sopInstanceUID: string;
    seriesInstanceUID: string;
    studyInstanceUID: string;
    modality: string;
    seriesNumber: number;
    seriesDescription: string;
    frameOfReferenceUID: string;
    displayedSize: string;
    numberOfFrames: number;
    /** The series this SEG was drawn on — what the browser indents it under. */
    derivedFrom?: { parentSeriesUID: string; kind: string; label: string };
  };
}

/** RGB (0..1) -> the DICOM PCS-Values CIELab triple SEG stores for a segment's display color. */
export function rgbToDicomLab(rgb: [number, number, number]): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map((c) => lin(Math.max(0, Math.min(1, c))));
  // sRGB -> XYZ (D65), then XYZ -> Lab against the D65 white point. FULL PRECISION constants, and
  // the white point taken from the matrix itself: with the usual 4-digit ones the rows do not sum to
  // the white point, so neutral gray comes out with a degree or two of chroma -- a "gray" segment
  // that is faintly green. Cheap to get exactly right, so it is.
  const x = (0.4123907992659595 * r + 0.35758433938387796 * g + 0.1804807884018343 * b) / 0.9504559270516716;
  const y = (0.21263900587151036 * r + 0.7151686787677559 * g + 0.07219231536073371 * b) / 1.0;
  const z = (0.019330818715591851 * r + 0.11919477979462599 * g + 0.9505321522496606 * b) / 1.0890577507598784;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  const L = 116 * fy - 16, A = 500 * (fx - fy), B = 200 * (fy - fz);
  // DICOM stores L in 0..0xFFFF over 0..100, and a/b in 0..0xFFFF over -128..127.
  const enc = (v: number, lo: number, hi: number) =>
    Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 0xFFFF);
  return [enc(L, 0, 100), enc(A, -128, 127), enc(B, -128, 127)];
}

/**
 * Write one frame's voxels into the packed bit stream.
 *
 * THE BIT INDEX OVERFLOWS 32 BITS AND JavaScript'S BITWISE OPERATORS DO NOT SURVIVE IT.
 *
 * This was `packed[bit >> 3] |= 1 << (bit & 7)` with `bit` running over the whole stream. `>>` and
 * `&` coerce their operand to a SIGNED 32-BIT integer, so once the stream passes 2^31 bits the index
 * wraps and voxels are written essentially at random. On a 768 x 768 series that threshold is frame
 * 3,641 -- fine for every test I had (172 frames, then 430), and catastrophic on Ron's ts:total run
 * of 13,167 frames, where roughly the last two thirds of every segment was scattered across the
 * volume. It looked like anatomy orbiting the torso; the giveaway was a liver whose bounding box
 * covered the entire field of view.
 *
 * The fix is to never let a value above 2^31 reach a bitwise operator. When a frame is a whole
 * number of bytes -- which it is whenever rows x columns is a multiple of 8, so for every square
 * matrix in practice -- the frame's BYTE base is computed in ordinary double arithmetic (exact to
 * 2^53) and only the offset WITHIN the frame, always below the frame size, is shifted. The general
 * path below covers the odd matrix where frames straddle byte boundaries, and it too keeps the
 * division in doubles.
 */
export function setFrameBits(
  packed: Uint8Array,
  labels: Uint8Array,
  srcOffset: number,
  labelValue: number,
  frameIndex: number,
  sliceLen: number,
): void {
  if (sliceLen % 8 === 0) {
    const base = frameIndex * (sliceLen / 8);          // exact: both factors are integers
    for (let i = 0; i < sliceLen; i++) {
      if (labels[srcOffset + i] === labelValue) packed[base + (i >> 3)] |= 1 << (i & 7);
    }
    return;
  }
  const bitBase = frameIndex * sliceLen;
  for (let i = 0; i < sliceLen; i++) {
    if (labels[srcOffset + i] !== labelValue) continue;
    const bit = bitBase + i;
    packed[Math.floor(bit / 8)] |= 1 << (bit % 8);     // no 32-bit operator sees `bit`
  }
}

type Ds = Record<string, unknown>;

/** The run's provenance, as the AI Segmentations module records it on the node (origin.run). */
export interface RunProvenance {
  server?: string;            // "haversack"
  haversack?: string;         // its version
  task?: string;
  engine?: string;            // nnunetv2, fastsurfer…
  device?: string;            // mps | cuda | cpu
  dtype?: string;
  cached?: boolean;
  models?: { folder?: string; version?: string; folds?: string[]; sha256?: string }[];
  input?: string[];           // sha256:… of the input volume
  timings?: Record<string, number>;
  job?: string;
  at?: string;
}

/**
 * ALBULA'S PRIVATE BLOCK (PS3.5 §7.8), for what no standard attribute of the SEG can hold: the whole provenance line.
 * ContentDescription (0070,0081) is LO, 64 characters (dciodvfy, 2026-09-25); the line is longer on any real network run.
 * Ron, 2026-09-26: "Segmentation provenance: Yes. Standards compliance" -- a 64-character summary in ContentDescription,
 * the full line here. The creator string carries the layout's version (CLAUDE.md, "modular and versioned").
 */
export const ALBULA_PRIVATE = { creatorTag: "00770010", creator: "SlicerAlbula provenance 1", lineTag: "00771001" } as const;
/** An LO value: 64 characters, cut with "..." when longer. */
const lo = (s: string) => s.length <= 64 ? s : `${s.slice(0, 61)}...`;

/** One line a person can read: the whole run (Albula's private block keeps it; ContentDescription gets 64 characters). */
export function describeRun(r: RunProvenance): string {
  const parts: string[] = [];
  if (r.task) parts.push(`task ${r.task}`);
  if (r.server || r.haversack) parts.push(`${r.server ?? "server"}${r.haversack ? " " + r.haversack : ""}`);
  if (r.engine) parts.push(`engine ${r.engine}`);
  for (const m of r.models ?? []) parts.push(`weights ${m.folder ?? "?"}${m.version ? " v" + m.version : ""}${m.folds?.length ? " folds " + m.folds.join("+") : ""}`);
  if (r.device) parts.push(`device ${r.device}${r.dtype ? " " + r.dtype : ""}`);
  if (r.input?.length) parts.push(`input ${r.input.join(",")}`);
  if (r.timings?.total !== undefined) parts.push(`${r.timings.total.toFixed(1)} s${r.cached ? " (cached)" : ""}`);
  if (r.at) parts.push(r.at);
  return parts.join("; ");
}

/**
 * WHAT THIS SEGMENT IS, in codes.
 *
 * DICOM requires two coded concepts per segment and they answer different questions. The CATEGORY is
 * the broad kind of thing -- anatomical structure, tissue, physical object, morphologically abnormal
 * structure. The TYPE is the specific thing: liver, aorta, L3 vertebra. Together they are what makes
 * a SEG searchable across an archive; SegmentLabel beside them is free text that only a person reads,
 * so a segmentation with placeholder codes looks perfectly fine and is findable by nothing.
 *
 * The type code comes from the caller, which takes it from the harmonized SNOMED mapping
 * (logic/anatomy/catalogue.ts: the IDC segmentation-comparison workbook over the TotalSegmentator
 * extension's table). Laterality goes in the type MODIFIER sequence, as the mapping and DICOM both
 * have it, so "kidney_right" is Kidney (64033007) modified by Right (24028007). Where
 * there is no code -- an unrecognized structure, or one drawn by hand -- the generic "Anatomical
 * structure" stands in, and that is the honest answer: a specific code invented from a label string
 * is a clinical claim nobody made.
 */
/** SNOMED's laterality concepts, the two the mapping uses. */
const LATERALITY: Record<string, string> = { Left: "7771000", Right: "24028007" };

/**
 * The CATEGORY concepts the harmonized mapping uses. "Anatomical Structure" is the default;
 * the others are what SNOMED calls a cyst (morphologically altered), an implant (physical object)
 * and fat or muscle taken as a tissue rather than an organ.
 */
//
// THE CODES ARE DICOM'S, from CID 7150 (Segmentation Property Categories), checked against Andrey
// Fedorov's extraction of the 2026c standard (fedorov/dcmterms). "Anatomical Structure" there is
// SCT 91723000. The mapping workbook, the Slicer extension's table and this writer all carried
// 123037004 -- a code that appears in no DICOM context group at all -- under that meaning; Andrey
// corrected MOOSE's own mapping to 91723000 in July 2026, and this follows. The meaning of
// 49755003 is DICOM's spelling too ("Abnormal", not "Altered").
export const CATEGORIES: Record<string, { CodeValue: string; CodeMeaning: string }> = {
  "Anatomical Structure": { CodeValue: "91723000", CodeMeaning: "Anatomical Structure" },
  "Morphologically Altered Structure": { CodeValue: "49755003", CodeMeaning: "Morphologically Abnormal Structure" },
  "Morphologically Abnormal Structure": { CodeValue: "49755003", CodeMeaning: "Morphologically Abnormal Structure" },
  "Physical object": { CodeValue: "260787004", CodeMeaning: "Physical object" },
  "Tissue": { CodeValue: "85756007", CodeMeaning: "Tissue" },
};

function metaFor(s: SegExportSegment, opts: { algorithmName?: string; merged?: boolean; algorithmType?: "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL" }): Ds {
  // Any designator, not only letters: DICOM's private schemes are `99…`, and SlicerHeart writes its
  // own (`SlicerHeart:sh-leaflet-mv-a`) -- a code in another scheme is still a code, and it is what
  // Slicer itself writes for that segment.
  const parsed = /^([A-Za-z0-9_.-]+):(.+)$/.exec(s.code ?? "");
  const category = CATEGORIES[s.category ?? ""] ?? CATEGORIES["Anatomical Structure"];
  const lat = s.mod ? LATERALITY[s.mod] : undefined;
  const type = opts.algorithmType ?? (opts.merged && opts.algorithmName ? "SEMIAUTOMATIC" : opts.algorithmName ? "AUTOMATIC" : "MANUAL");
  return {
    // LO: 64 characters; a longer name goes whole into SegmentDescription (ST, 1024) (second
    // critic, 2026-09-17, finding 10).
    SegmentLabel: s.name.slice(0, 64),
    ...(s.name.length > 64 ? { SegmentDescription: s.name.slice(0, 1024) } : {}),
    // A merge of network results is neither: the networks did the work and a person chose between
    // them where they overlapped, which is what SEMIAUTOMATIC means (critic, 2026-09-17, finding 7).
    // C.8.20.2: the name is required whenever the type is not MANUAL, so a merge of hand-drawn
    // inputs (no network anywhere) is MANUAL, not SEMIAUTOMATIC-without-a-name.
    SegmentAlgorithmType: type,
    // ...and absent when it is MANUAL: C.8.20.2 allows the name only for the other two (dciodvfy, 2026-09-28, on an
    // imported hand-drawn mask given a name and MANUAL).
    ...(opts.algorithmName && type !== "MANUAL" ? { SegmentAlgorithmName: opts.algorithmName } : {}),
    SegmentedPropertyCategoryCodeSequence: { ...category, CodingSchemeDesignator: "SCT" },
    // The modifier is NESTED in the type item -- (0062,0011) is an attribute of the Segmented
    // Property Type Code Sequence item, not of the segment -- and that is also the only place it
    // survives: dcmjs copies a fixed list of segment attributes and would drop it at the segment level.
    SegmentedPropertyTypeCodeSequence: parsed
      ? {
        CodeValue: parsed[2], CodingSchemeDesignator: parsed[1], CodeMeaning: s.type ?? s.name,
        ...(lat ? { SegmentedPropertyTypeModifierCodeSequence: { CodeValue: lat, CodingSchemeDesignator: "SCT", CodeMeaning: s.mod } } : {}),
      }
      : { CodeValue: "91723000", CodingSchemeDesignator: "SCT", CodeMeaning: "Anatomical structure" },
    ...(s.color ? { RecommendedDisplayCIELabValue: rgbToDicomLab(s.color) } : {}),
  } as Ds;
}

/**
 * Build the DICOM SEG for one labelmap over one source series.
 *
 * `labels` is the scene's labelmap in the SAME voxel order the volume was reconstructed in
 * (k slowest), and `dims` is [nx, ny, nz].
 */
export async function segmentationToDicomSeg(
  labels: Uint8Array,
  dims: [number, number, number],
  segments: SegExportSegment[],
  sourceInstances: ArrayBuffer[],
  opts: {
    seriesDescription?: string;
    algorithmName?: string;
    /** A merge of several results: SEMIAUTOMATIC, the networks named in algorithmName. */
    merged?: boolean;
    /** The type as a loaded SEG carried it, written back as it was (second critic, finding 8). */
    algorithmType?: "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL";
    /** The instances of the frame this labelmap is on, when the series holds several frames. */
    sopInstanceUIDs?: string[];
    /**
     * HOW THIS WAS MADE, into the object itself. The run's provenance as the segmentation server
     * reported it (see HaversackJob.provenance): the software and its version, the engine, the
     * weights and their version, the device, the input's content hash. Written to DICOM's own
     * places for it -- ContributingEquipmentSequence for the software that made it, SoftwareVersions,
     * and ContentDescription for the one-line account -- so the SEG carries its provenance wherever
     * it goes. Mike Halle: "that metadata, the hardware that runs the pipeline, and the input data
     * all need to be tied together with provenance."
     */
    run?: RunProvenance;
    /**
     * Progress, because a full ts:total SEG is a 150-250 MB file and takes a while to build.
     *
     * Without it the app looks hung at exactly the moment it is doing the most work, which is the
     * same complaint the segmentation run had. Reported per phase, with a count where there is one
     * to count; the caller decides how to show it.
     */
    onProgress?: (p: { phase: string; done?: number; total?: number }) => void;
    /** The InstanceNumbers of the images this segmentation was drawn on, when the series holds
     *  more than that one volume (the frames of a sequence); the others are left out. */
    instanceNumbers?: number[];
    /** Stable UIDs for the new object (an import that must give it the same identity on every run, logic/import/bids.ts);
     *  omitted: dcmjs makes new ones, as for any save. */
    uids?: { series: string; sop: string };
    /**
     * THE FORM OF THE FILE. "labelmap" (the default since 2026-09-18): the Label Map Segmentation
     * object (Supplement 243, SOP class 1.2.840.10008.5.1.4.1.1.66.7) -- one 8-bit frame per
     * slice whose pixel value IS the segment number, 709 frames instead of 13,167 one-bit planes
     * on a whole-body result, and written deflated (Deflated Explicit VR Little Endian) unless
     * `compress` says otherwise: 978 MB became 3.1 MB on Ron's C3N-01524 result, measured. A
     * labelmap can hold no overlap, which is Ron's caveat ("we don't know whether overlap will
     * occur in the future"): this writer takes ONE byte labelmap, so overlap cannot reach it today;
     * the day overlapping layers exist, the caller passes "binary" for those and the old form is
     * written. "binary": the classic one-bit-per-segment-per-slice object, as before.
     * Read back here by pydicom 3.0.2, highdicom 0.28.1 and Slicer 5.13's dcmqi (2026-09-18);
     * the digest's version floors (Slicer 5.11 preview, highdicom 0.24, DCMTK 3.7.0) are from its
     * sources, not re-verified; and by this application's reader.
     */
    form?: "labelmap" | "binary";
    /** Deflate the dataset (Deflated Explicit VR Little Endian). Default: true for the labelmap. */
    compress?: boolean;
  } = {},
): Promise<DicomSegExport> {
  if (!sourceInstances.length) throw new Error("no source DICOM instances: a SEG has to reference the series it segments");
  const dcm = await dicomIO();

  const note = (phase: string, done?: number, total?: number) => opts.onProgress?.({ phase, done, total });
  note(`reading ${sourceInstances.length} source instances`);
  let datasets = sourceInstances.map((b) => {
    const parsed = dcm.readFile(b);
    const ds = dcm.naturalize(parsed.dict) as Ds;
    (ds as { _meta?: Ds })._meta = dcm.namify(parsed.meta) as Ds;
    return ds;
  });
  // A MULTI-FRAME SOURCE (Enhanced MR/CT/PET: one file, many slices, as Siemens' XA scanners write MR) is read
  // since 2026-09-25, but a SEG on it has to name each slice by the file AND its frame number (ReferencedFrameNumber),
  // which this writer does not do yet. Refused in plain words rather than written with wrong references.
  if (datasets.some((ds) => Number(ds.NumberOfFrames ?? 1) > 1 && ds.PerFrameFunctionalGroupsSequence && !String(ds.SOPClassUID ?? "").startsWith("1.2.840.10008.5.1.4.1.1.66"))) {
    throw new Error("saving a segmentation drawn on a multi-frame image (one file holding all its slices) is not supported yet");
  }
  // A SIEMENS MOSAIC (many slices tiled into one image, cut apart on reading since 2026-09-29) has no DICOM address for
  // one slice of it: a SEG could only reference the whole picture. Refused in plain words; without this the check below
  // called a 36-slice volume "a single slice" (critic, 2026-09-29, finding 8).
  if (datasets.some((ds) => (Array.isArray(ds.ImageType) ? ds.ImageType : String(ds.ImageType ?? "").split("\\")).map(String).includes("MOSAIC"))) {
    throw new Error("saving a segmentation drawn on a Siemens mosaic (many slices tiled into one picture, as fMRI and diffusion scans are stored) is not supported yet");
  }
  // ONE FRAME OF A SERIES THAT HOLDS SEVERAL: keep the instances of that frame. By SOP Instance
  // UID when the volume carries them -- the key the reader uses to find the frame again -- and by
  // InstanceNumber otherwise, which DICOM does not make unique (two phases each numbered 1..n
  // exist; critic, 2026-09-17, finding 17). A filter that does not come out at the expected count
  // says so rather than silently taking every instance.
  if (opts.sopInstanceUIDs?.length) {
    const want = new Set(opts.sopInstanceUIDs);
    const mine = datasets.filter((ds) => want.has(String(ds.SOPInstanceUID)));
    if (mine.length !== want.size) throw new Error(`the volume names ${want.size} instances of this series and ${mine.length} of them were found among the ${datasets.length} given`);
    datasets = mine;
  } else if (opts.instanceNumbers?.length) {
    const want = new Set(opts.instanceNumbers);
    const mine = datasets.filter((ds) => want.has(Number(ds.InstanceNumber)));
    if (mine.length !== want.size) throw new Error(`the volume names ${want.size} instance numbers and ${mine.length} instances match among the ${datasets.length} given — instance numbers are not unique in this series; reload the volume so it carries instance uids`);
    datasets = mine;
  }
  // dcmjs's own normalizer turns the single-frame series into the multiframe form its SEG derivation
  // reads per-frame plane positions from. Using it rather than assembling that by hand is the point:
  // the derivation and the normalizer agree about frame order because they are the same library.
  note("assembling the series geometry");
  if (datasets.length < 2) throw new Error("a segmentation on a single slice cannot be saved as DICOM yet: the series geometry needs at least two slices");
  const multiframe = dcm.toMultiframe(datasets) as Ds;

  const [nx, ny, nz] = dims;
  const rows = Number(multiframe.Rows), cols = Number(multiframe.Columns);
  if (rows !== ny || cols !== nx) {
    throw new Error(`the segmentation grid (${nx}x${ny}) does not match the series (${cols}x${rows})`);
  }
  const perFrame = multiframe.PerFrameFunctionalGroupsSequence as { PlanePositionSequence: { ImagePositionPatient: number[] } }[];
  if (!perFrame || perFrame.length !== nz) {
    throw new Error(`the series has ${perFrame?.length ?? 0} frames but the segmentation has ${nz} slices`);
  }

  // FRAME ORDER IS DERIVED, NOT ASSUMED.
  //
  // Our volume orders slices by their position along the plane normal (readers/dicom-series.ts);
  // dcmjs's normalizer sorts too, and the two agree today. "Agree today" is not a property to build
  // a clinical object on: a SEG whose frames are off by one, or reversed, is worse than no SEG,
  // because it looks plausible. So the mapping is computed from the frames' own ImagePositionPatient
  // -- rank frame f by its distance along the normal, and that rank IS our k.
  const iop = (multiframe.SharedFunctionalGroupsSequence as { PlaneOrientationSequence?: { ImageOrientationPatient: number[] } })
    ?.PlaneOrientationSequence?.ImageOrientationPatient ??
    (perFrame[0] as unknown as { PlaneOrientationSequence?: { ImageOrientationPatient: number[] } }).PlaneOrientationSequence?.ImageOrientationPatient;
  if (!iop) throw new Error("the series carries no ImageOrientationPatient; its frame order cannot be established");
  const o = (iop as number[]).map(Number);
  const normal: [number, number, number] = [
    o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3],
  ];
  const along = perFrame.map((fg, f) => {
    const p = fg.PlanePositionSequence.ImagePositionPatient.map(Number);
    return { f, d: p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] };
  }).sort((a, b) => a.d - b.d);
  const kOfFrame = new Array<number>(nz);          // frame index (0-based) -> our slice k
  along.forEach((e, k) => { kOfFrame[e.f] = k; });

  const seg = dcm.segmentationBuilder(multiframe);
  const sliceLen = nx * ny;

  // WHICH SLICES EACH LABEL OCCUPIES, IN ONE PASS.
  //
  // This asked the question per segment -- for each label, scan every voxel -- which on a ts:total
  // result is 117 scans of a 200-million-voxel volume. One pass answers it for every label at once:
  // 256 possible labels x nz slices is a few kilobytes of bookkeeping.
  note("scanning the labelmap");
  const MAX_LABEL = 256;
  const occupies = new Uint8Array(MAX_LABEL * nz);
  for (let k = 0; k < nz; k++) {
    const base = k * sliceLen;
    for (let i = 0; i < sliceLen; i++) {
      const v = labels[base + i];
      if (v) occupies[v * nz + k] = 1;
    }
  }
  // Only segments that actually occupy voxels: an empty one is frames of zeros in the file and a
  // phantom structure in every reader that opens it.
  const present = segments.filter((s) => {
    if (s.labelValue <= 0 || s.labelValue >= MAX_LABEL) return false;
    for (let k = 0; k < nz; k++) if (occupies[s.labelValue * nz + k]) return true;
    return false;
  });
  if (!present.length) throw new Error("the segmentation is empty: nothing to write");
  // LABELS THE LIST DOES NOT NAME ARE NOT WRITTEN -- and that is said, not swallowed (critic,
  // 2026-09-17, finding 15). A labelmap and its segment list disagreeing is a bug upstream; the
  // count in the result lets the caller say so. Labels of 256 and above cannot be in a byte
  // labelmap (finding 16); a wider labelmap is refused at the caller before it gets here.
  const listed = new Set(segments.map((s) => s.labelValue));
  let unlistedVoxels = 0;
  for (let v = 1; v < MAX_LABEL; v++) {
    if (listed.has(v)) continue;
    for (let k = 0; k < nz; k++) if (occupies[v * nz + k]) { unlistedVoxels = -1; break; }
    if (unlistedVoxels) break;
  }
  if (unlistedVoxels) {
    unlistedVoxels = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] && !listed.has(labels[i])) unlistedVoxels++;
  }

  const form = opts.form ?? "labelmap";
  const totalFramesRef = { n: 0 };
  if (form === "labelmap") {
    // THE LABEL MAP OBJECT. One frame per slice, the pixel value is the segment number, background
    // 0 described as a segment of its own (Sup. 243 C.8.20.2.3.3: "every pixel value actually
    // encoded ... is required to be described in an Item of Segment Sequence", and Pixel Padding
    // Value names it as background -- what highdicom writes too). Segment numbers are the label
    // values themselves; LABELMAP does not require them consecutive (C.8.20.2.4). The per-frame
    // groups carry position and frame content only: the Segmentation macro (segment identification
    // per frame) is "required if ... Segmentation Type is not LABELMAP" (A.51.5).
    note("assembling the label map");
    const ds = seg.dataset as Ds & { NumberOfFrames?: number; PixelData?: ArrayBuffer; PerFrameFunctionalGroupsSequence?: unknown[]; SegmentSequence?: unknown[] };
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.66.7";
    ds.SegmentationType = "LABELMAP";
    ds.SegmentsOverlap = "NO";
    ds.BitsAllocated = 8; ds.BitsStored = 8; ds.HighBit = 7; ds.PixelRepresentation = 0;
    ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = "MONOCHROME2";
    ds.PixelPaddingValue = 0;
    const dimUID = (ds.DimensionOrganizationSequence as { DimensionOrganizationUID?: string } | undefined)?.DimensionOrganizationUID ?? dcm.newUid();
    ds.DimensionOrganizationSequence = { DimensionOrganizationUID: dimUID };
    ds.DimensionIndexSequence = [{
      DimensionOrganizationUID: dimUID,
      DimensionIndexPointer: 0x00200032,           // ImagePositionPatient
      FunctionalGroupPointer: 0x00209113,          // PlanePositionSequence
      DimensionDescriptionLabel: "ImagePositionPatient",
    }];
    // The frames in slice order, k = 0..nz-1; the source frame for slice k is the one whose rank is k.
    const frameOfK = new Array<number>(nz);
    kOfFrame.forEach((k, f) => { frameOfK[k] = f; });
    const refSeries = (multiframe as { ReferencedSeriesSequence?: { ReferencedInstanceSequence?: { ReferencedSOPClassUID: string; ReferencedSOPInstanceUID: string }[] } }).ReferencedSeriesSequence;
    const pf: unknown[] = [];
    for (let k = 0; k < nz; k++) {
      const f = frameOfK[k];
      const src = perFrame[f] as unknown as { PlanePositionSequence: unknown; PlaneOrientationSequence?: unknown };
      const inst = refSeries?.ReferencedInstanceSequence?.[f];
      pf.push({
        PlanePositionSequence: JSON.parse(JSON.stringify(src.PlanePositionSequence)),
        ...((seg.dataset.SharedFunctionalGroupsSequence as { PlaneOrientationSequence?: unknown })?.PlaneOrientationSequence ? {} : { PlaneOrientationSequence: JSON.parse(JSON.stringify(src.PlaneOrientationSequence)) }),
        FrameContentSequence: { DimensionIndexValues: [k + 1] },
        ...(inst ? {
          DerivationImageSequence: {
            SourceImageSequence: {
              ReferencedSOPClassUID: inst.ReferencedSOPClassUID, ReferencedSOPInstanceUID: inst.ReferencedSOPInstanceUID,
              PurposeOfReferenceCodeSequence: { CodeValue: "121322", CodingSchemeDesignator: "DCM", CodeMeaning: "Source image for image processing operation" },
            },
            DerivationCodeSequence: { CodeValue: "113076", CodingSchemeDesignator: "DCM", CodeMeaning: "Segmentation" },
          },
        } : {}),
      });
    }
    ds.PerFrameFunctionalGroupsSequence = pf;
    ds.NumberOfFrames = nz;
    // Segments: background first, then every present label under its own value.
    const segs: Ds[] = [{
      SegmentNumber: 0, SegmentLabel: "Background", SegmentAlgorithmType: "AUTOMATIC", SegmentAlgorithmName: "SlicerAlbula",
      SegmentedPropertyCategoryCodeSequence: { CodeValue: "125040", CodingSchemeDesignator: "DCM", CodeMeaning: "Background" },
      SegmentedPropertyTypeCodeSequence: { CodeValue: "125040", CodingSchemeDesignator: "DCM", CodeMeaning: "Background" },
    }];
    // One item per label VALUE (C.8.20.2.4: unique); a list that names a value twice keeps its
    // first entry (critic, 2026-09-18, finding 7).
    const seen = new Set<number>();
    for (const s of present) { if (seen.has(s.labelValue)) continue; seen.add(s.labelValue); const m = metaFor(s, opts); m.SegmentNumber = s.labelValue; segs.push(m); }
    ds.SegmentSequence = segs;
    // The pixel data: the labelmap itself, slice by slice in frame order. Only listed labels are
    // written (an unlisted value would be a pixel value no Segment Sequence item describes).
    const px = new Uint8Array(nz * sliceLen);
    const keep = new Uint8Array(256); for (const s of present) keep[s.labelValue] = 1;
    for (let k = 0; k < nz; k++) {
      const src = k * sliceLen, dst = k * sliceLen;
      for (let i = 0; i < sliceLen; i++) { const v = labels[src + i]; px[dst + i] = keep[v] ? v : 0; }
    }
    ds.PixelData = px.buffer;
    totalFramesRef.n = nz;
  }

  // A SEG stores one frame per (segment, slice) pair, so the frame count is the SUM over segments of
  // the slices each one touches -- not the slice count.
  const framesFor = form === "labelmap" ? [] : present.map((s) => {
    const list: number[] = [];
    for (let f = 0; f < nz; f++) if (occupies[s.labelValue * nz + kOfFrame[f]]) list.push(f + 1);   // DICOM frames are 1-based
    return list;
  });
  const totalFrames = form === "labelmap" ? totalFramesRef.n : framesFor.reduce((n, l) => n + l.length, 0);

  // PACK AS WE GO, rather than filling a byte per voxel and packing at the end.
  //
  // dcmjs's own path allocates NumberOfFrames x Rows x Columns BYTES up front and only bit-packs
  // after the last segment is added. For one structure on a 43-slice series that is 11 MB and nobody
  // notices. For a ts:total run -- 117 structures, each touching tens of slices -- it is 1.8 GB of
  // intermediate for a 230 MB file, and the tab simply dies. Ron: "could not save: Out of memory".
  //
  // So the pixel data is written straight into its final packed form (continuous LSB-first bit
  // stream across frames, which is what the DICOM binary segmentation encoding is), and dcmjs is
  // used only for the metadata sequences. That means calling two underscore-prefixed methods of its
  // Segmentation class; they are checked for first, and the public path is used when they are absent,
  // so a dcmjs upgrade that renames them degrades to "slow and memory-hungry" rather than "broken".
  const packedBytes = Math.ceil((totalFrames * sliceLen) / 8);
  const LIMIT = 1_500_000_000;
  if (packedBytes > LIMIT) {
    throw new Error(
      `this SEG would be ${(packedBytes / 1e6).toFixed(0)} MB (${present.length} segments x ${totalFrames} frames) — too large to build in the browser; export fewer structures`,
    );
  }
  const canStream = typeof seg._addSegmentMetadata === "function" && typeof seg._addPerFrameFunctionalGroups === "function";

  if (form === "labelmap") {
    // written above
  } else if (canStream) {
    const packed = new Uint8Array(packedBytes);
    seg.dataset.NumberOfFrames = totalFrames;
    let frameBase = 0;                                   // frames already written, across segments
    for (let si = 0; si < present.length; si++) {
      const s = present[si], frames = framesFor[si];
      note(`writing ${s.name}`, si + 1, present.length);
      // Yield between segments so the progress actually reaches the screen: this is one long
      // synchronous stretch otherwise, and a progress report nobody can see is not one.
      await new Promise((r) => setTimeout(r, 0));
      frames.forEach((frameNo, idx) => {
        const src = kOfFrame[frameNo - 1] * sliceLen;
        setFrameBits(packed, labels, src, s.labelValue, frameBase + idx, sliceLen);
      });
      const segNumber = seg._addSegmentMetadata(metaFor(s, opts));
      seg._addPerFrameFunctionalGroups(segNumber, frames);
      frameBase += frames.length;
    }
    seg.dataset.PixelData = packed.buffer;
    seg.isBitpacked = true;                              // already packed: nothing more to do
  } else {
    seg.setNumberOfFrames(totalFrames);
    present.forEach((s, si) => {
      const frames = framesFor[si];
      const px = new Uint8Array(frames.length * sliceLen);
      frames.forEach((frameNo, idx) => {
        const src = kOfFrame[frameNo - 1] * sliceLen, out = idx * sliceLen;
        for (let i = 0; i < sliceLen; i++) px[out + i] = labels[src + i] === s.labelValue ? 1 : 0;
      });
      seg.addSegment(metaFor(s, opts), px, frames);
    });
    seg.bitPackPixelData();
  }

  const out = seg.dataset as Ds & { _meta?: Ds; SeriesInstanceUID?: string; SOPInstanceUID?: string; SeriesDescription?: string };
  // LO holds 64 characters. Nine files
  // in the database were over when the critic looked (2026-09-17, finding 8), the merged one at
  // 115; all were cut on disk and in the index the same evening.
  if (opts.seriesDescription) out.SeriesDescription = opts.seriesDescription.slice(0, 64);
  if (opts.uids) { out.SeriesInstanceUID = opts.uids.series; out.SOPInstanceUID = opts.uids.sop; }
  // WHICH MAPPING CODED THE SEGMENTS, always -- a hand-drawn segmentation with a recognized name
  // is coded from the same tables as a network's result. The run, when there was one, comes first.
  const mapping = mappingVersions();
  // The whole line: the run when there was one, then the codes' tables. ContentDescription gets its first 64 characters;
  // the private block below, all of it.
  const provenanceLine = opts.run ? `${describeRun(opts.run)}; codes ${mapping.join(", ")}` : `codes ${mapping.join(", ")}`;
  out.ContentDescription = lo(provenanceLine);
  if (opts.run) {
    const r = opts.run;
    // The software that made the segmentation, as DICOM names it: one item per piece, the
    // server first (it is what ran), the weights as the "model" of that equipment, then the
    // mapping tables the codes came from.
    out.SoftwareVersions = [r.server ? `${r.server} ${r.haversack ?? ""}`.trim() : "SlicerAlbula", ...(r.models ?? []).map((m) => `${m.folder ?? "weights"} ${m.version ?? ""}`.trim()), ...mapping];
    out.ContributingEquipmentSequence = [{
      PurposeOfReferenceCodeSequence: [{ CodeValue: "109102", CodingSchemeDesignator: "DCM", CodeMeaning: "Processing Equipment" }],
      Manufacturer: r.server ?? "SlicerAlbula",
      ManufacturerModelName: (r.engine ?? "").slice(0, 64) || "segmentation",
      SoftwareVersions: r.haversack ?? "",
      ...(r.device ? { DeviceSerialNumber: `${r.device}${r.dtype ? " " + r.dtype : ""}`.slice(0, 64) } : {}),
      ...(r.at ? { ContributionDateTime: r.at.replace(/[-:]/g, "").replace("T", "").slice(0, 14) } : {}),
      ContributionDescription: lo(describeRun(r)),
    }];
  } else {
    out.SoftwareVersions = ["SlicerAlbula", ...mapping];
  }
  // UTF-8 DECLARED. See the note in export-dicom-image.ts: the descriptions come from node names the
  // interface writes with a middle dot, and without this tag those bytes are non-conformant and read
  // back as "Â·" in any correct reader. dcmjs's own generator does not set it.
  (out as { SpecificCharacterSet?: string }).SpecificCharacterSet = "ISO_IR 192";
  // WHEN THIS WAS MADE, on the object and therefore in the index row built from it. The derivation
  // carries the SOURCE series' dates forward, which is a true statement about the images and a false
  // one about the segmentation -- and the browser, which sorts and shows this column, was reading it.
  {
    const now = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
    out.SeriesDate = out.ContentDate = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
    out.SeriesTime = out.ContentTime = `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  }
  // datasetToBuffer() goes through Node's Buffer, which a browser has no reason to have; the dict's
  // own write() returns the ArrayBuffer directly and is what that function wraps anyway.
  note("encoding the file");
  // EXPLICIT VR, WHATEVER THE SOURCE WAS. The output's `_meta` came along from the source instances,
  // so a segmentation made on an Implicit VR CT was written Implicit -- and then labeled Deflated
  // EXPLICIT VR by the compression below. pydicom guesses its way through such a file; dcmjs, and so
  // Albula itself, cannot read it back ("coding.replace is not a function": Ron's lung_vessels on
  // R_180, 2026-09-23, the first saved segmentation made on an Implicit VR CT). A new object states
  // its own encoding -- in the form dcmjs reads (`{ Value: [...] }`): a plain string is ignored by
  // datasetToDict, which then falls back to its own default (critic, 2026-09-23, round 2, finding 8).
  out._meta = {
    ...(out._meta ?? {}), TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" },
    ...(opts.uids ? { MediaStorageSOPInstanceUID: { Value: [opts.uids.sop], vr: "UI" } } : {}),
  };
  const dd = dcm.toFile(out);
  // Albula's private block: its creator, then the whole provenance line (UT: no practical length limit).
  (dd.dict as Record<string, { vr: string; Value: unknown[] }>)[ALBULA_PRIVATE.creatorTag] = { vr: "LO", Value: [ALBULA_PRIVATE.creator] };
  (dd.dict as Record<string, { vr: string; Value: unknown[] }>)[ALBULA_PRIVATE.lineTag] = { vr: "UT", Value: [provenanceLine] };
  // 8-bit pixel data is OB (dcmjs would carry the CT's OW; finding 7).
  if (form === "labelmap") { const px = (dd.dict as Record<string, { vr?: string }>)["7FE00010"]; if (px) px.vr = "OB"; }
  let bytes = new Uint8Array(dd.write());
  if (opts.compress ?? (form === "labelmap")) {
    // DEFLATED, the dataset as one stream (logic/dicom-deflate.ts): on a whole-body label map the
    // 418 MB dataset is mostly zeros and becomes about 3 MB. The header is rewritten to say so.
    note("compressing the file");
    const metaNat = dcm.naturalize(dd.meta) as Ds;
    bytes = await deflateDicomFile(bytes, (ts) => {
      const m = { ...metaNat, TransferSyntaxUID: ts };
      const header = dcm.fileWithMeta(dcm.denaturalize(m));
      header.dict = {};
      return new Uint8Array(header.write());
    });
  }
  const sop = String(out.SOPInstanceUID ?? "");
  return {
    bytes,
    sopClassUID: String((out as { SOPClassUID?: string }).SOPClassUID ?? ""),
    filename: `${sop || "segmentation"}.dcm`,
    frames: totalFrames,
    segments: present.length,
    /** Voxels whose label no segment names; they are not in the file. 0 is the normal case. */
    unlistedVoxels,
    seriesInstanceUID: String(out.SeriesInstanceUID ?? ""),
    sopInstanceUID: sop,
    // Everything the DICOM index needs, taken from the dataset we just built rather than parsed back
    // out of the bytes: the writer is the only place these are known for certain.
    index: {
      sopInstanceUID: sop,
      seriesInstanceUID: String(out.SeriesInstanceUID ?? ""),
      studyInstanceUID: String((out as { StudyInstanceUID?: string }).StudyInstanceUID ?? ""),
      modality: "SEG",
      seriesNumber: Number((out as { SeriesNumber?: number }).SeriesNumber ?? 0),
      seriesDescription: opts.seriesDescription ?? "Segmentation",
      // WHEN IT WAS MADE. The date column was blank for every saved segmentation because these two
      // were never filled in -- the dataset carries them, the index row did not.
      seriesDate: String((out as { SeriesDate?: string }).SeriesDate ?? ""),
      seriesTime: String((out as { SeriesTime?: string }).SeriesTime ?? ""),
      frameOfReferenceUID: String((out as { FrameOfReferenceUID?: string }).FrameOfReferenceUID ?? ""),
      displayedSize: `${cols}x${rows}`,
      numberOfFrames: totalFrames,
      // The source series, taken from the instances this SEG was built from rather than read back
      // out of ReferencedSeriesSequence: same answer, and true even if that sequence is ever written
      // differently. Without it the row lands beside its volume instead of under it.
      derivedFrom: String(datasets[0]?.SeriesInstanceUID ?? "")
        ? {
          parentSeriesUID: String(datasets[0].SeriesInstanceUID),
          kind: "algorithm",
          label: `${opts.seriesDescription ?? "Segmentation"} (${present.length} segments)`,
        }
        : undefined,
    },
  };
}
