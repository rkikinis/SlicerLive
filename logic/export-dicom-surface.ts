// THE EXTRACTED SURFACES AS A DICOM OBJECT: Surface Segmentation Storage, 1.2.840.10008.5.1.4.1.1.66.5.
//
// Ron: "Is this a once per data set? If yes can it be saved in dicom format as a child?" It is once
// per dataset -- the geometry depends on the labelmap and nothing else -- and this is the standard's
// own object for it: a Surface Mesh module carrying points, normals and a triangle index list,
// alongside the same Segment Sequence a SEG has, with the same coded identities.
//
// A CHILD BY REFERENCE, not by containment: DICOM has no parent-child between series. The surface
// names the SEG it was derived from in SegmentSurfaceSourceInstanceSequence, and the source images
// for the frame of reference. Pointing at the images alone would be untrue -- the surface comes from
// the labelmap, and if the segmentation is re-run the surface is stale, which is exactly what the
// reference lets a reader work out.
//
// SLICER CANNOT READ THIS, checked rather than assumed: the SOP class appears nowhere in Slicer 5.13
// except inside bundled libraries' UID tables, and none of its eleven DICOM plugins handles surfaces.
// Ron, on that: "There needs to be a path from slicer to albula but the reverse is not true." So
// this is written correctly and their gap stays theirs.
//
// ONE DEVIATION, AND IT IS FORCED -- measured 2026-09-10, not inferred from a warning.
// (0066,0041) Long Triangle Point Index List is VR OL in the standard. Asking dcmjs 0.41.0 to write
// OL produces, on disk and read back:
//
//   asked OL -> on disk "UN"   read back: vr=UL, 0 values   <- THE DATA IS GONE
//   asked OB -> on disk "OB"   read back: vr=OB, all values intact
//   asked OW -> on disk "OW"   read back: vr=OW, all values intact
//
// So OL is not a stricter option that costs nothing; it silently discards every triangle. OB is
// written instead: the bytes are correct and a reader that takes the VR for a known tag from the
// data dictionary (as it must) reads them correctly. A byte-level VR checker will flag it.
//
// The conformant alternative is the 16-bit list, which caps a surface at 65,535 points and would
// mean chopping every structure into chunks to work around a library gap.
// UPSTREAM: dcmjs-org/dcmjs#509 (filed from here, 2026-09-08: OL, OV, SV and UV not implemented); fixed by PR #511
// (open on 2026-09-28). Write OL here when Albula moves to a dcmjs release with it (Contents/docs/upstream-issues-dcmjs.md
// in the workspace, item 8), and drop the OB exception from the dciodvfy test.
//
// PATIENT SPACE AND 1-BASED INDICES -- found by the critic on 2026-09-17, after every surface file
// in the database had been written the other way. C.27.2.1: the points "are in the coordinate
// system identified by the Frame of Reference UID", the DICOM patient system, LPS; C.27.2.1.1: "the
// index of the first point shall be 1". This writer had written the scene's RAS millimeters and
// 0-based indices under the CT's Frame of Reference UID: self-consistent inside Albula, and every
// one of the 29 files' points lay OUTSIDE its own CT when read as the file said -- any other reader
// would draw them rotated 180 degrees about the patient's long axis, each triangle from the wrong
// three points. Now: x and y negated on the way out (normals too; they are vectors in the same
// frame), indices +1; the reader does the inverse, and tells a file of the old kind by an index
// list that contains 0, which a 1-based list never does. The 29 existing files were rewritten in
// place by Contents/tools/surfaces-to-patient-space.py the same day.
//
// A structure validator sees neither of these; `validate_iods` (dicom-validator, DICOM 2026c)
// reports no errors against the Surface Segmentation IOD before or after. Four things it DID find
// on 2026-09-10, all genuine and all fixed here:
// (0062,000C) Recommended Display Grayscale Value missing (type 1), the six sibling primitive
// containers in C.27-4 missing rather than present-and-empty (type 2), (0066,002A) Surface Count
// missing (type 1), and (0062,0009) Segment Algorithm Name present where this module does not define
// it. See render/../logic/export-dicom-surface.conformance.test.ts, which pins them without needing
// the external tool.
import { dicomIO } from "./dicom-io.ts";
import { rgbToDicomLab } from "./export-dicom-seg.ts";

/** RAS (the scene) to LPS (the DICOM patient system): x and y negated. A COPY of exactly the view's
 *  bytes -- `.buffer` of a view that does not start at 0 would have written the whole underlying
 *  buffer (critic, finding 13). */
export function rasToLps(v: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i + 2 < v.length; i += 3) { out[i] = -v[i]; out[i + 1] = -v[i + 1]; out[i + 2] = v[i + 2]; }
  return out;
}
/** 0-based (the renderer) to 1-based (C.27.2.1.1). */
export function oneBased(idx: Uint32Array): Uint32Array {
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) out[i] = idx[i] + 1;
  return out;
}

/** One structure's surface, as `surfaceNets` produces it. */
export interface SurfaceIn {
  label: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** What the segment is, for the Segment Sequence: the same identity the SEG carries. */
export interface SurfaceSegment {
  labelValue: number;
  name: string;
  color?: [number, number, number];
  /** SNOMED or similar, as `CODE^SCHEME^MEANING` is NOT used -- these are the parts. */
  categoryCode?: { code: string; scheme: string; meaning: string };
  typeCode?: { code: string; scheme: string; meaning: string };
  algorithmName?: string;
}

export interface SurfaceExport {
  bytes: Uint8Array;
  sopInstanceUID: string;
  seriesInstanceUID: string;
  /**
   * The study and frame of reference this landed in, taken from the source images.
   *
   * RETURNED BECAUSE THE INDEX NEEDS THEM AND THE CALLER CANNOT INVENT THEM. The save passed an
   * empty string for both, and `indexInstances` rejects a non-UID outright -- so every attempt to
   * put surfaces in the DICOM database threw, fell back to writing a bare file, and reported
   * something that was not a failure. Ron: "No surface mesh listed in the dicom db, none loaded."
   * They were written and never indexed, so nothing could ever find them again.
   */
  studyInstanceUID: string;
  frameOfReferenceUID: string;
  surfaces: number;
  triangles: number;
  points: number;
}

type Ds = Record<string, unknown>;

// The same codes the SEG writer uses (CID 7150): "Anatomical Structure" is 91723000, not 123037004,
// and a segment nobody coded is a generic anatomical structure -- it was "Morphologically Altered
// Structure" here, which claims a pathology no one asserted.
const CATEGORY_ANATOMY = { code: "91723000", scheme: "SCT", meaning: "Anatomical Structure" };
const TYPE_UNKNOWN = { code: "91723000", scheme: "SCT", meaning: "Anatomical structure" };

/**
 * (0062,000C) Recommended Display Grayscale Value: a P-Value over 16 bits.
 *
 * Relative luminance of the sRGB color, which is what a grayscale-only reader should show for it.
 * Type 1 in C.27.1 and it was simply absent -- found by running the object past the standard's own
 * IOD tables rather than by reading them.
 */
function pValueOf(rgb: readonly [number, number, number] | number[]): number {
  const lin = (v: number) => (v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92);
  const y = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return Math.max(0, Math.min(65535, Math.round(y * 65535)));
}

const code = (c: { code: string; scheme: string; meaning: string }) => ({
  CodeValue: c.code, CodingSchemeDesignator: c.scheme, CodeMeaning: c.meaning,
});

/**
 * Build a Surface Segmentation instance.
 *
 * `sourceInstances` are the images the segmentation was drawn on -- one is enough, since all that is
 * taken from them is the patient, the study and the frame of reference. `derivedFrom` names the SEG.
 */
export async function surfacesToDicomSurface(
  surfaces: readonly SurfaceIn[],
  segments: readonly SurfaceSegment[],
  sourceInstances: ArrayBuffer[],
  opts: {
    seriesDescription?: string;
    algorithmName?: string;
    derivedFrom?: { sopClassUID: string; sopInstanceUID: string; seriesInstanceUID: string };
    onProgress?: (p: { phase: string; done?: number; total?: number }) => void;
  } = {},
): Promise<SurfaceExport> {
  if (!surfaces.length) throw new Error("no surfaces to write");
  if (!sourceInstances.length) throw new Error("no source instances: a surface has to say where it sits in space");
  const dcm = await dicomIO();

  opts.onProgress?.({ phase: "reading the source geometry" });
  const src = dcm.naturalize(dcm.readFile(sourceInstances[0]).dict) as Ds & {
    PatientName?: string; PatientID?: string; PatientBirthDate?: string; PatientSex?: string;
    StudyInstanceUID?: string; StudyID?: string; StudyDate?: string; StudyTime?: string;
    AccessionNumber?: string; ReferringPhysicianName?: string; FrameOfReferenceUID?: string;
    SeriesInstanceUID?: string; SOPClassUID?: string; SOPInstanceUID?: string;
  };

  const seriesUID = dcm.newUid();
  const sopUID = dcm.newUid();
  const now = new Date();
  const dt = (d: Date) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("");
  const tm = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");

  const byLabel = new Map(segments.map((s) => [s.labelValue, s]));
  let points = 0, triangles = 0;

  // ── the Surface Mesh module ──
  // Surface numbers are 1-based and are what the Segment Sequence refers to, so the two lists are
  // built together rather than zipped afterwards.
  const surfaceSeq: Ds[] = [];
  const segmentSeq: Ds[] = [];
  surfaces.forEach((s, i) => {
    const n = i + 1;
    const seg = byLabel.get(s.label);
    const nPts = s.positions.length / 3;
    points += nPts;
    triangles += s.indices.length / 3;
    const lab = rgbToDicomLab(seg?.color ?? [0.8, 0.8, 0.8]);
    surfaceSeq.push({
      SurfaceNumber: n,
      SurfaceComments: (seg?.name ?? `label ${s.label}`).slice(0, 1024),     // LT: 10240; kept short
      // THE MESH WAS SMOOTHED (Taubin), which is what C.27.1.1.2 calls surface processing; "NO"
      // was a false claim next to an algorithm name that said otherwise (second critic, 2026-09-17,
      // finding 5). YES asks for the ratio (2C) and the algorithm (2C); the ratio is 1.0 -- every
      // point was processed and none removed -- and the algorithm is the same identification the
      // segment's surface-generation sequence carries.
      SurfaceProcessing: "YES",
      SurfaceProcessingRatio: 1.0,
      SurfaceProcessingAlgorithmIdentificationSequence: [{
        AlgorithmFamilyCodeSequence: [code({ code: "123109", scheme: "DCM", meaning: "Manual Processing" })],
        AlgorithmName: "Taubin smoothing", AlgorithmVersion: "1",
      }],
      // TYPE 1, AND IT WAS MISSING. (0062,000C) is required non-empty in C.27.1 alongside the CIELab
      // value, and only the CIELab value was written -- caught by validate_iods against the 2026c
      // standard, not by reading. It is a P-Value, so it is the color's luminance over 16 bits:
      // a grayscale-only reader gets a sensible shade instead of nothing.
      RecommendedDisplayGrayscaleValue: pValueOf(seg?.color ?? [0.8, 0.8, 0.8]),
      RecommendedDisplayCIELabValue: [lab[0], lab[1], lab[2]],
      RecommendedPresentationOpacity: 1,
      RecommendedPresentationType: "SURFACE",
      // NOT CLAIMED. Surface nets on a labelmap gives a closed manifold on a sphere, which is what the
      // test checks -- and on real data a structure cut by the field of view has an open boundary,
      // and two voxels touching only along an edge give an edge used four times: three files on
      // disk said YES to both and had 313, 246 and 80 open edges, and non-manifold ones (second
      // critic, 2026-09-17, finding 5). Counting edges over 12 million triangles is seconds and
      // hundreds of megabytes on the save path, so the file says UNKNOWN, which the standard offers
      // for exactly this, rather than a property it does not check.
      FiniteVolume: "UNKNOWN",
      Manifold: "UNKNOWN",
      SurfacePointsSequence: [{ NumberOfSurfacePoints: nPts, PointCoordinatesData: rasToLps(s.positions).buffer }],
      SurfacePointsNormalsSequence: [{
        NumberOfVectors: nPts, VectorDimensionality: 3, VectorCoordinateData: rasToLps(s.normals).buffer,
      }],
      // The index list is inserted after denaturalization -- see the VR note at the top.
      SurfaceMeshPrimitivesSequence: [{}],
    });
    segmentSeq.push({
      SegmentNumber: n,
      SegmentLabel: (seg?.name ?? `label ${s.label}`).slice(0, 64),          // LO: 64 (second critic, finding 10)
      ...((seg?.name?.length ?? 0) > 64 ? { SegmentDescription: seg!.name.slice(0, 1024) } : {}),
      // What made the SEGMENTATION these surfaces trace: a network (AUTOMATIC), hands (MANUAL).
      // The network's name has no field in this module's Segment Sequence (the validator says
      // so), so it goes into ContentDescription below; it was accepted and dropped before
      // (critic, 2026-09-17, finding 14).
      SegmentAlgorithmType: opts.algorithmName ? "AUTOMATIC" : "MANUAL",
      // SEGMENT ALGORITHM NAME IS NOT IN THIS MODULE, and the validator says so: "unexpected".
      // C.8.23.1's Segment Sequence carries Surface Count and Referenced Surface Sequence, and the
      // algorithm belongs in (0066,002D) Segment Surface Generation Algorithm Identification
      // Sequence -- which is written below and already names it. This was the pixel-SEG habit
      // (C.8.20.2) applied to a surface object.
      //
      // SURFACE COUNT is type 1 here and was missing. One surface per segment, by construction:
      // surfaceNets emits one mesh per label and each becomes one surface.
      SurfaceCount: 1,
      SegmentedPropertyCategoryCodeSequence: [code(seg?.categoryCode ?? CATEGORY_ANATOMY)],
      SegmentedPropertyTypeCodeSequence: [code(seg?.typeCode ?? TYPE_UNKNOWN)],
      ReferencedSurfaceSequence: [{
        ReferencedSurfaceNumber: n,
        SegmentSurfaceGenerationAlgorithmIdentificationSequence: [{
          AlgorithmFamilyCodeSequence: [code({ code: "123109", scheme: "DCM", meaning: "Manual Processing" })],
          AlgorithmName: "surface nets + Taubin smoothing",
          AlgorithmVersion: "1",
        }],
        // WHAT THIS SURFACE CAME FROM. The SEG, not the images: re-run the segmentation and this
        // surface is stale, and this reference is how a reader can tell.
        // TYPE 2, so it is present either way -- empty when this was not derived from a stored
        // segmentation, rather than absent.
        SegmentSurfaceSourceInstanceSequence: opts.derivedFrom
          ? [{
            ReferencedSOPClassUID: opts.derivedFrom.sopClassUID,
            ReferencedSOPInstanceUID: opts.derivedFrom.sopInstanceUID,
          }]
          : [],
      }],
    });
  });

  const ds: Ds = {
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.66.5",
    SOPInstanceUID: sopUID,
    Modality: "SEG",
    SeriesInstanceUID: seriesUID,
    SeriesNumber: 1000,
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
    SeriesDescription: (opts.seriesDescription ?? "Surfaces").slice(0, 64),     // LO: 64 characters (finding 8)
    InstanceNumber: 1,
    // SeriesDate/Time AS WELL as ContentDate/Time: the loader's "newest wins" among several surface
    // sets sorts on the series date, and the SEG writer sets both (2026-09-10); this one set only
    // the content date, so every surface series was undated and the tie went to the OLDEST
    // (critic, 2026-09-17, finding 4). The files on disk were dated by the sweep the same day.
    SeriesDate: dt(now), SeriesTime: tm(now),
    ContentDate: dt(now), ContentTime: tm(now),
    ContentLabel: "SURFACES",
    // LO, 64 CHARACTERS AT MOST (0070,0081; dciodvfy, 2026-09-25: this was a 66-character sentence). What made the
    // surfaces is in SurfaceProcessingAlgorithmIdentificationSequence and each segment's algorithm, not here.
    ContentDescription: `${opts.seriesDescription ?? "Extracted surfaces"}${opts.algorithmName ? ` (${opts.algorithmName})` : ""}`.slice(0, 64),
    ContentCreatorName: "SlicerAlbula",
    Manufacturer: "SlicerAlbula",
    ManufacturerModelName: "surface nets",
    DeviceSerialNumber: "1",
    SoftwareVersions: "1",
    // Patient, study and the frame of reference come from the images: a surface with a different
    // frame of reference from the volume it was drawn on is in the wrong place by definition.
    PatientName: src.PatientName ?? "", PatientID: src.PatientID ?? "",
    PatientBirthDate: src.PatientBirthDate ?? "", PatientSex: src.PatientSex ?? "",
    StudyInstanceUID: src.StudyInstanceUID ?? "", StudyID: src.StudyID ?? "",
    StudyDate: src.StudyDate ?? "", StudyTime: src.StudyTime ?? "",
    AccessionNumber: src.AccessionNumber ?? "", ReferringPhysicianName: src.ReferringPhysicianName ?? "",
    FrameOfReferenceUID: src.FrameOfReferenceUID ?? "",
    PositionReferenceIndicator: "",
    NumberOfSurfaces: surfaces.length,
    SurfaceSequence: surfaceSeq,
    SegmentSequence: segmentSeq,
    // The images, so a reader can find the series this describes without going through the SEG.
    //
    // AND, AS A SECOND ITEM, THE SEG ITSELF. Common Instance Reference is one item per series, which
    // is what makes this the right place for both. The SEG's SERIES uid is the thing a loader needs
    // and the only place it was written was nowhere: `derivedFrom` went into each segment's
    // SegmentSurfaceSourceInstanceSequence as a SOP class and a SOP instance, with the series uid
    // dropped, while the reader looked for it under DerivationImageSequence -- a path this writer
    // has never written. So `decodeSurfaces().derivedFromSeriesUID` was ALWAYS undefined, and the
    // check that is meant to stop one segmentation's surfaces being drawn on another could never
    // fire. Caught by a test asking for exactly that refusal, not by reading either file.
    //
    // Which item is which is read from the SOP class, not from the order: 66.4 is the SEG.
    ReferencedSeriesSequence: [
      {
        SeriesInstanceUID: src.SeriesInstanceUID ?? "",
        ReferencedInstanceSequence: [{
          ReferencedSOPClassUID: src.SOPClassUID ?? "", ReferencedSOPInstanceUID: src.SOPInstanceUID ?? "",
        }],
      },
      ...(opts.derivedFrom
        ? [{
          SeriesInstanceUID: opts.derivedFrom.seriesInstanceUID,
          ReferencedInstanceSequence: [{
            ReferencedSOPClassUID: opts.derivedFrom.sopClassUID,
            ReferencedSOPInstanceUID: opts.derivedFrom.sopInstanceUID,
          }],
        }]
        : []),
    ],
  };

  opts.onProgress?.({ phase: "encoding", total: surfaces.length });
  const den = dcm.denaturalize(ds) as Record<string, { vr: string; Value: unknown[] }>;

  // The index lists, as raw tags so the VR is ours. (0066,0013) is the primitives sequence and
  // (0066,0041) the long index list; see the VR note at the top of this file.
  const surfSeq = den["00660002"] as unknown as { vr: string; Value: Record<string, unknown>[] };
  surfaces.forEach((s, i) => {
    const item = surfSeq.Value[i];
    // EVERY PRIMITIVE CONTAINER IS TYPE 2 in C.27-4, which means PRESENT and possibly empty -- not
    // absent. We use triangles, so the other six are written zero-length, and a reader can tell
    // "there are no strips" from "this writer forgot about strips". The validator listed all six as
    // missing and it was right about every one.
    item["00660013"] = {
      vr: "SQ",
      Value: [{
        "00660041": { vr: "OB", Value: [oneBased(s.indices).buffer] },   // Long Triangle Point Index List, 1-based
        "00660026": { vr: "SQ", Value: [] },                      // Triangle Strip Sequence
        "00660027": { vr: "SQ", Value: [] },                      // Triangle Fan Sequence
        "00660028": { vr: "SQ", Value: [] },                      // Line Sequence
        "00660034": { vr: "SQ", Value: [] },                      // Facet Sequence
        "00660042": { vr: "OB", Value: [] },                      // Long Edge Point Index List
        "00660043": { vr: "OB", Value: [] },                      // Long Vertex Point Index List
      }],
    };
  });

  const meta = dcm.denaturalize({
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: "1.2.840.10008.5.1.4.1.1.66.5",
    MediaStorageSOPInstanceUID: sopUID,
    TransferSyntaxUID: "1.2.840.10008.1.2.1",
    ImplementationClassUID: "1.2.826.0.1.3680043.10.1338.1",
    ImplementationVersionName: "SlicerAlbula",
  });
  const dd = dcm.fileWithMeta(meta);
  dd.dict = den;
  const bytes = new Uint8Array(dd.write());
  opts.onProgress?.({ phase: "done", done: surfaces.length, total: surfaces.length });
  return {
    bytes, sopInstanceUID: sopUID, seriesInstanceUID: seriesUID,
    studyInstanceUID: String(ds.StudyInstanceUID ?? ""), frameOfReferenceUID: String(ds.FrameOfReferenceUID ?? ""),
    seriesDate: dt(now), seriesTime: tm(now),
    surfaces: surfaces.length, triangles, points,
  };
}
