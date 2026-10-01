// DICOM SEG -> a labelmap on the REFERENCE volume's grid.
//
// A SEG is a multi-frame object whose frames are 1-bit masks, each carrying its own
// ImagePositionPatient and a ReferencedSegmentNumber. Frames are NOT in any particular order, are
// not one-per-slice, and there is no promise they cover the whole volume: a 68-segment SEG over a
// 993-slice series holds only the frames that actually contain something. So decoding means placing
// every frame into the reference grid by position rather than by index.
//
// The decode itself is ported from render/vendor/idc_tools/idc-worker.js, which does exactly this
// for IDC downloads. That copy is welded to IDC's fetching; this one takes bytes and a geometry, so
// the same logic serves a SEG that came from a local database, a file, or anywhere else.
//
// Segment numbers are written as VALUES into the labelmap, so overlapping segments do not survive:
// the last frame written wins. That matches the vendored behavior and the usual labelmap model. A
// SEG whose segments genuinely overlap (the nnInteractive kind can) loses the overlaps -- and SAYS
// SO: `overlapVoxels` counts every voxel a later frame took from an earlier segment, and the loader
// puts the count in the load message. Measured by the critic (2026-09-17, finding 3) on a Slicer
// nnInteractive SEG: 185,933 voxels, 0.65% of the set, were being dropped without a word.
import { utf8InsideSequence } from "./dicom-series.ts";
import { dicomIO } from "../dicom-io.ts";
import { invertRowMajor } from "../transforms.ts";

/** Geometry of the volume a SEG is being placed onto. */
export interface SegReference {
  /** Sample counts of the volume the SEG is being placed onto, [nx, ny, nz]. */
  dims: [number, number, number];
  /** row-major 4x4, IJK -> RAS */
  ijkToRAS: number[];
  /** ImageOrientationPatient / PixelSpacing fallbacks, used only if the SEG omits its own. */
  iop?: number[];
  /** PixelSpacing fallback. @see iop */
  ps?: number[];
}

/** A SEG placed onto the reference grid, with what each label means. */
/** A coded entry as DICOM writes it: (0008,0100) value, (0008,0102) scheme, (0008,0104) meaning. */
interface CodeItem { CodeValue?: string | number; CodingSchemeDesignator?: string; CodeMeaning?: string }
export interface Code { scheme: string; value: string; meaning?: string }
export interface SegmentCodes { category?: Code; type?: Code; modifier?: Code }
const one = <T,>(v: T | T[] | undefined): T | undefined => Array.isArray(v) ? v[0] : v;
const code = (c: CodeItem | undefined): Code | undefined =>
  c && c.CodeValue !== undefined && c.CodingSchemeDesignator ? { scheme: String(c.CodingSchemeDesignator), value: String(c.CodeValue), ...(c.CodeMeaning ? { meaning: String(c.CodeMeaning) } : {}) } : undefined;
function readSegmentCodes(s: NonNullable<SegDataset["SegmentSequence"]>[number]): SegmentCodes | undefined {
  const category = code(one(s.SegmentedPropertyCategoryCodeSequence));
  const typeItem = one(s.SegmentedPropertyTypeCodeSequence);
  const type = code(typeItem);
  const modifier = code(one(typeItem?.SegmentedPropertyTypeModifierCodeSequence));
  if (!category && !type) return undefined;
  return { ...(category ? { category } : {}), ...(type ? { type } : {}), ...(modifier ? { modifier } : {}) };
}

export interface DecodedSeg {
  /** SegmentNumber per voxel on the reference grid; 0 = no segment. */
  lab: Uint8Array;
  /** [segmentNumber, r, g, b], r/g/b in 0..1 */
  colors: [number, number, number, number][];
  /** Segment number -> its `SegmentLabel`, or a generated name when the SEG omits one. */
  names: Record<number, string>;
  /**
   * WHAT THE FILE SAID a segment is, in codes: the category, the type and the type's modifier
   * (laterality), each `{scheme, value, meaning}`. Read since 2026-09-20 and carried to the
   * segment as `fileCodes`, never used as authority: which concept a model's label maps to is the
   * mapping place's answer (logic/segment-naming.ts, Mike Halle 2026-09-19: "the DICOM SEG process
   * in IDC cheats … an air of legitimacy that isn't the DICOM file's authority to say"). Kept so a
   * re-save of a file the catalog does not know writes the codes it arrived with, not a guess.
   */
  fileCodes: Record<number, SegmentCodes>;
  /** The series this SEG says it was drawn on, when it names one. */
  referencedSeriesUID?: string;
  /** The object's own SOP class (binary …66.4 or label map …66.7), for anything that references it. */
  sopClassUID?: string;
  /**
   * The instances it names within that series. A series can hold several volumes -- the five
   * phases of a gated CTA -- and only these say WHICH one the SEG was drawn on.
   */
  referencedSOPInstanceUIDs?: string[];
  /** The source frames the SEG names per frame (Derivation Image › Source Image, with ReferencedFrameNumber), when its
   *  source is a multi-frame file: which volume of that file it was drawn on (logic/instance-key.ts). */
  referencedFrames?: { uid: string; frame: number }[];
  /** Segments present in SegmentSequence but with no frames placed. */
  emptySegments: number[];
  /** Voxels claimed by two segments, where the later frame won. 0 for a SEG with no overlap. */
  overlapVoxels: number;
  /** Frames that fell entirely outside the reference volume and were not placed. 0 is the normal case. */
  framesOutside: number;
  /**
   * `SegmentAlgorithmName` (0062,0009) -- which network produced this, when the SEG says.
   *
   * The standard's own place for it, and the fact the round trip most needs: it is what lets a
   * reloaded result be named, colored and presented the way its family expects, instead of arriving
   * as an anonymous set of labels. Read from the first segment that carries one, since a SEG this
   * application writes gives every segment the same value.
   */
  algorithmName?: string;
  /** `SegmentAlgorithmType` of the first segment, so a re-save writes the type the file had (second critic, finding 8). */
  algorithmType?: "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL";
  /**
   * How the SEG's own geometry was arrived at.
   *
   * A SEG does not really declare a frame: it is placed onto the reference volume's grid, so its
   * geometry is only ever as good as the reference's. What it *can* contribute is its own
   * `PlaneOrientationSequence` and `PixelMeasuresSequence` — and when those are missing this reader
   * falls back first to the reference's, then to an identity orientation and unit spacing. That last
   * fallback is a guess that can misplace every frame, so it is reported rather than taken silently.
   */
  geometry: SegGeometry;
}

/** Where the time went inside one decode, so the browser's cost can be attributed rather than guessed. */
export interface DecodePhases {
  /** Fetching the dcmjs script. Zero after the first call. */
  loadDcmjsMs: number;
  readFileMs: number;
  naturalizeMs: number;
  /** Placing the frames — the loop the 4-byte skip made 4.5x faster. */
  placeMs: number;
  /** Whether the SEG shares the reference grid, so the fast placement path ran at all. */
  fastPath: boolean;
}

/** What the SEG stated about its own frames, and what had to be substituted. */
export interface SegGeometry {
  /** `acquired` when the SEG stated its orientation; `assumed` when an identity had to be used. */
  orientation: "acquired" | "inherited" | "assumed";
  /** Same, for pixel spacing. */
  spacing: "acquired" | "inherited" | "assumed";
  /** True when the fast path applied: the SEG sits on the reference grid, unflipped, one frame per slice. */
  onReferenceGrid: boolean;
}

// The SEG's own shape, as far as this reader uses it; the library is reached through logic/dicom-io.ts.
interface Fg {
  SegmentIdentificationSequence?: { ReferencedSegmentNumber?: number }[];
  PlanePositionSequence?: { ImagePositionPatient?: number[] }[];
}
interface SegDataset {
  SOPClassUID?: string;
  Modality?: string;
  PixelData?: ArrayBuffer[];
  SegmentationType?: string;
  BitsAllocated?: number;
  PixelPaddingValue?: number;
  SpecificCharacterSet?: string;
  Rows?: number;
  Columns?: number;
  SegmentSequence?: {
    SegmentNumber?: number;
    SegmentLabel?: string;
    RecommendedDisplayCIELabValue?: number[];
    SegmentAlgorithmName?: string;
    SegmentAlgorithmType?: string;
    SegmentedPropertyCategoryCodeSequence?: CodeItem | CodeItem[];
    SegmentedPropertyTypeCodeSequence?: (CodeItem & { SegmentedPropertyTypeModifierCodeSequence?: CodeItem | CodeItem[] }) | (CodeItem & { SegmentedPropertyTypeModifierCodeSequence?: CodeItem | CodeItem[] })[];
  }[];
  SharedFunctionalGroupsSequence?: {
    PlaneOrientationSequence?: { ImageOrientationPatient?: number[] }[];
    PixelMeasuresSequence?: { PixelSpacing?: number[] }[];
  }[];
  PerFrameFunctionalGroupsSequence?: Fg[];
  ReferencedSeriesSequence?: { SeriesInstanceUID?: string; ReferencedInstanceSequence?: { ReferencedSOPInstanceUID?: string }[] }[];
}

const lps2ras = (p: number[]): number[] => [-p[0], -p[1], p[2]];
const sub = (a: number[], b: number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** The Surface Segmentation SOP class: a SEG by modality, and not a labelmap by any measure. */
const SURFACE_SEGMENTATION = "1.2.840.10008.5.1.4.1.1.66.5";

/**
 * Does this look like a DICOM SEG -- a segmentation carried as PIXELS?
 *
 * THE MODALITY IS NOT ENOUGH, and the standard is why: a Surface Segmentation (66.5) also has
 * `Modality: "SEG"`, correctly, because it is a segmentation. It just has no pixel data, being
 * triangles. So one of the surface objects this application writes passed this test and then failed
 * inside `placeSeg` with "the SEG has no pixel data" -- a true statement about a file that was never
 * a labelmap and was never going to be one. Ron, loading stored surfaces from the browser:
 * "2 loaded; 1 failed ... the SEG has no pixel data."
 */
export function isSegDataset(ds: { SOPClassUID?: string; Modality?: string }): boolean {
  if (ds.SOPClassUID === SURFACE_SEGMENTATION) return false;
  return ds.SOPClassUID === "1.2.840.10008.5.1.4.1.1.66.4" || ds.SOPClassUID === "1.2.840.10008.5.1.4.1.1.66.7" || ds.Modality === "SEG";
}

/**
 * Place a DICOM SEG onto the reference volume's grid.
 *
 * Pure: the same bytes and the same reference always give the same labelmap, which is what makes
 * `decodeSegmentationCached` in `seg-cache.ts` safe rather than merely fast.
 *
 * @throws if the instance is not a SEG, has no pixel data, or has no per-frame functional groups.
 */
export async function decodeSegmentation(
  bytes: ArrayBuffer,
  ref: SegReference,
  onPhases?: (p: DecodePhases) => void,
): Promise<DecodedSeg> {
  // Phase timings, because the browser spends 3.6 s here on a file that takes ~1.1 s in Deno and
  // guessing which phase owns the difference has been wrong before. Measured under Deno on the real
  // 347 MB SEG: readFile 416 ms, naturalize 97 ms, placement 130 ms.
  const t0 = performance.now();
  const dcm = await dicomIO();
  const tLoad = performance.now();
  const dict = dcm.readFile(bytes);
  const tRead = performance.now();
  const ds = dcm.naturalize(dict.dict) as SegDataset;
  const tNat = performance.now();

  if (!isSegDataset(ds)) {
    // A Surface Segmentation object shares the SEG modality; one whose series lost its link to its
    // segmentation reaches the labelmap decoder through the ordinary SEG path and used to be
    // answered with a message that sent the reader the wrong way (critic, 2026-09-17, finding 11).
    if (String(ds.SOPClassUID ?? "") === "1.2.840.10008.5.1.4.1.1.66.5") {
      throw new Error("this series holds 3D surfaces, not a segmentation, and it is not linked to the segmentation it was extracted from — load that segmentation and its surfaces come with it");
    }
    throw new Error("that instance is not a DICOM SEG");
  }

  const raw = (dict.dict["7FE00010"]?.Value?.[0] ?? ds.PixelData?.[0]) as ArrayBuffer | undefined;
  const bits = new Uint8Array(raw ?? new ArrayBuffer(0));
  if (!bits.length) throw new Error("the SEG has no pixel data");

  const [nx, ny, nz] = ref.dims;
  // THE FRAME'S OWN SIZE, taken from the SEG rather than assumed from the reference volume.
  //
  // Ron, on a FastSurfer brain SEG: "I tried the brainsurfer data set and got bad results" -- the
  // segments came back as thin diagonal streaks in axial and colored horizontal bands in coronal
  // and sagittal. That is the signature of a frame decomposed with the wrong width: `row = pp / nx`
  // shifts every row by the difference, so a frame shears and lands across slices.
  //
  // Rows and Columns are properties of the SEG, and nothing requires them to equal the reference
  // volume's in-plane dims. This decoder took `(nx * ny) >> 3` as the frame size, which is right for
  // a SEG we wrote on that very volume and silently wrong for any other -- there was no check and no
  // complaint, only a picture that looked like noise.
  //
  // Two further assumptions went with it. `>> 3` truncates, and DICOM packs single-bit frames
  // CONTINUOUSLY with no per-frame padding, so a frame whose pixel count is not a multiple of 8
  // starts mid-byte and `f * frameBytes` drifts. And the fastest path below rests on the identity
  // `row * nx + col === pp`, which holds only while the frame is exactly nx wide.
  const segW = Number(ds.Columns) || nx;
  const segH = Number(ds.Rows) || ny;
  const frameBits = segW * segH;
  const frameBytes = frameBits >> 3;
  /** The frame grid matches the reference grid in plane -- what the byte-wise fast paths need. */
  const sameGrid = segW === nx && segH === ny;
  /** Every frame starts on a byte boundary, so a frame can be addressed by byte at all. */
  const byteAligned = (frameBits & 7) === 0;
  // A 32-bit view of the same bytes, for the 4-at-a-time zero skip below. Truncated to whole words;
  // the ragged tail of the last frame is handled a byte at a time.
  const words = new Uint32Array(bits.buffer, bits.byteOffset, bits.byteLength >> 2);
  const lab = new Uint8Array(nx * ny * nz);
  const inv = invertRowMajor(ref.ijkToRAS);
  const toIJK = (lps: number[]): number[] => {
    const r = lps2ras(lps);
    return [
      inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2] + inv[3],
      inv[4] * r[0] + inv[5] * r[1] + inv[6] * r[2] + inv[7],
      inv[8] * r[0] + inv[9] * r[1] + inv[10] * r[2] + inv[11],
    ];
  };

  const shared = ds.SharedFunctionalGroupsSequence?.[0] ?? {};
  const ownIop = shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient;
  const ownPs = shared.PixelMeasuresSequence?.[0]?.PixelSpacing;
  const geometry: SegGeometry = {
    orientation: ownIop ? "acquired" : ref.iop ? "inherited" : "assumed",
    spacing: ownPs ? "acquired" : ref.ps ? "inherited" : "assumed",
    onReferenceGrid: false,     // set below, once the fast-path check has run
  };
  const sIop = (ownIop ?? ref.iop ?? [1, 0, 0, 0, 1, 0]).map(Number);
  const sPs = (ownPs ?? ref.ps ?? [1, 1]).map(Number);
  const colW = sIop.slice(0, 3).map((v: number) => v * sPs[1]);
  const rowW = sIop.slice(3, 6).map((v: number) => v * sPs[0]);

  const colors: [number, number, number, number][] = [];
  const names: Record<number, string> = {};
  const fileCodes: Record<number, SegmentCodes> = {};
  let algorithmName: string | undefined;
  let algorithmType: "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL" | undefined;
  for (const s of (ds.SegmentSequence ?? [])) {
    // The label map's background is a segment of its own (Sup. 243), numbered by Pixel Padding
    // Value -- 0 here; it is not a structure. FIRST, before the algorithm's name is taken from
    // "the first segment": our own writer stamps the background segment "SlicerAlbula", and every
    // label map this application saved came back with that as its model -- the network that made
    // it forgotten, its definitions and its family unfound (2026-09-20).
    if (Number(s.SegmentNumber) === (ds.PixelPaddingValue !== undefined ? Number(ds.PixelPaddingValue) : 0) && String(ds.SegmentationType ?? "").toUpperCase() === "LABELMAP") continue;
    if (!algorithmName && s.SegmentAlgorithmName) algorithmName = String(s.SegmentAlgorithmName);
    if (!algorithmType && ["AUTOMATIC", "SEMIAUTOMATIC", "MANUAL"].includes(String(s.SegmentAlgorithmType))) algorithmType = String(s.SegmentAlgorithmType) as typeof algorithmType;
    const rgb = s.RecommendedDisplayCIELabValue
      ? dcm.dicomLabToRgb(s.RecommendedDisplayCIELabValue)
      : [1, 1, 1];
    colors.push([Number(s.SegmentNumber), rgb[0], rgb[1], rgb[2]]);
    names[Number(s.SegmentNumber)] = s.SegmentLabel ? utf8InsideSequence(String(s.SegmentLabel), ds.SpecificCharacterSet) : `Segment ${s.SegmentNumber}`;
    const codes = readSegmentCodes(s);
    if (codes) fileCodes[Number(s.SegmentNumber)] = codes;
  }

  const perFrame = ds.PerFrameFunctionalGroupsSequence ?? [];
  if (!perFrame.length) throw new Error("the SEG has no per-frame functional groups");

  // Frame axes in IJK, derived once from the first frame: every frame shares the orientation, so
  // only the origin changes per frame.
  const ref0 = (perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient ?? [0, 0, 0]).map(Number);
  const o0 = toIJK(ref0);
  const diCol = sub(toIJK([ref0[0] + colW[0], ref0[1] + colW[1], ref0[2] + colW[2]]), o0);
  const diRow = sub(toIJK([ref0[0] + rowW[0], ref0[1] + rowW[1], ref0[2] + rowW[2]]), o0);

  // Is the SEG on the reference grid, one frame per slice, unflipped? Then the per-voxel matrix
  // multiply is just an offset. Checked rather than assumed -- a row-flipped SEG (the trap the
  // colorize example documents) must still take the general path.
  const near = (v: number, t: number) => Math.abs(v - t) < 1e-6;
  const onGrid = near(diCol[0], 1) && near(diCol[1], 0) && near(diCol[2], 0) &&
    near(diRow[0], 0) && near(diRow[1], 1) && near(diRow[2], 0);
  // The byte-wise paths need the frame to be the reference's own width AND byte-aligned, not merely
  // unrotated. Without those two the general path below is the only correct one.
  const axisAligned = onGrid && sameGrid && byteAligned;
  geometry.onReferenceGrid = onGrid;

  const placed = new Set<number>();
  let overlaps = 0, outside = 0;

  // THE LABEL MAP FORM (Supplement 243; SOP class 1.2.840.10008.5.1.4.1.1.66.7, or Segmentation
  // Type LABELMAP): one 8- or 16-bit frame per slice whose pixel value IS the segment number, no
  // Segment Identification per frame, background as a segment of its own named by Pixel Padding
  // Value. Written by this application since 2026-09-18, by highdicom, dcmqi 1.5.4, Slicer 5.13.
  // Read before 2026-09-18 this would have been unpacked as bit planes: a wrong picture, no error.
  const isLabelMap = String(ds.SegmentationType ?? "").toUpperCase() === "LABELMAP" || String(ds.SOPClassUID ?? "") === "1.2.840.10008.5.1.4.1.1.66.7";
  if (isLabelMap) {
    const bitsAllocated = Number(ds.BitsAllocated ?? 8);
    if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error(`a label map segmentation with ${bitsAllocated} bits per pixel; 8 or 16 expected`);
    const padding = ds.PixelPaddingValue !== undefined ? Number(ds.PixelPaddingValue) : 0;
    const perPixel = bitsAllocated >> 3, frameLen = segW * segH;
    const values = bitsAllocated === 8 ? bits : new Uint16Array(bits.buffer, bits.byteOffset, Math.floor(bits.byteLength / 2));
    for (let f = 0; f < perFrame.length; f++) {
      const fg = perFrame[f];
      const ippLps = fg.PlanePositionSequence?.[0]?.ImagePositionPatient?.map(Number);
      if (!ippLps) continue;
      const o = toIJK(ippLps), base = f * frameLen;
      if (base + frameLen > values.length) throw new Error(`the label map's pixel data ends before frame ${f + 1} of ${perFrame.length}`);
      const k0 = Math.round(o[2]);
      // A frame is "outside" by where it SITS, not by what it holds: an empty slice of a label map
      // is a frame like any other (critic, 2026-09-18, finding 3 -- 213 of 533 were miscounted).
      if (onGrid && (k0 < 0 || k0 >= nz)) { outside++; continue; }
      // THE FAST PATH: 8-bit, on the reference grid, the frame the reference's own size, the
      // background 0 -- the frame IS the slice, copied in one typed-array call. The per-voxel loop
      // below took 8.9 s on Ron's whole-body result (2026-09-18 21:13), slower than unpacking the
      // bit planes it replaced; this is the inflate and a memcpy.
      if (bitsAllocated === 8 && onGrid && sameGrid && padding === 0 && Math.round(o[0]) === 0 && Math.round(o[1]) === 0) {
        const slice = k0 * nx * ny;
        const frame = (values as Uint8Array).subarray(base, base + frameLen);
        // Overlap within the label map's own frames is impossible; another frame on the same slice
        // (a malformed file) would overwrite -- counted by comparing what is already there.
        let already = false;
        for (let q = 0; q < frameLen; q += 4096) if (lab[slice + q]) { already = true; break; }
        if (already) { for (let q = 0; q < frameLen; q++) { const v = frame[q]; if (!v) continue; if (lab[slice + q] && lab[slice + q] !== v) overlaps++; lab[slice + q] = v; placed.add(v); } }
        else {
          lab.set(frame, slice);
          // Which segments this frame placed: a byte histogram is cheaper than a Set per voxel.
          const seen = new Uint8Array(256);
          for (let q = 0; q < frameLen; q++) seen[frame[q]] = 1;
          for (let v = 1; v < 256; v++) if (seen[v]) placed.add(v);
        }
        continue;
      }
      for (let pp = 0; pp < frameLen; pp++) {
        let v = values[base + pp];
        if (v === padding || v === 0) continue;
        if (v > 255) throw new Error(`this label map numbers a segment ${v}; this reader holds at most 255 structures per segmentation`);
        let i: number, j: number, k: number;
        if (onGrid) { const row = (pp / segW) | 0, col = pp - row * segW; i = Math.round(o[0]) + col; j = Math.round(o[1]) + row; k = k0; }
        else {
          const row = (pp / segW) | 0, col = pp - row * segW;
          i = Math.round(o[0] + col * diCol[0] + row * diRow[0]); j = Math.round(o[1] + col * diCol[1] + row * diRow[1]); k = Math.round(o[2] + col * diCol[2] + row * diRow[2]);
        }
        if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) {
          const p = k * nx * ny + j * nx + i;
          if (lab[p] && lab[p] !== v) overlaps++;
          lab[p] = v; placed.add(v);
        }
      }
    }
    void perPixel;
  }
  for (let f = 0; isLabelMap ? false : f < perFrame.length; f++) {
    const fg = perFrame[f];
    const segNum = fg.SegmentIdentificationSequence?.[0]?.ReferencedSegmentNumber;
    const ippLps = fg.PlanePositionSequence?.[0]?.ImagePositionPatient?.map(Number);
    if (!segNum || !ippLps) continue;
    const seg = Number(segNum);
    // THE LABELMAP IS A BYTE. The standard only asks segment numbers to be unique; 300 stored in a
    // Uint8Array is 44, under no segment or under another one (second critic, 2026-09-17,
    // finding 15). Refused with the number, rather than aliased in silence.
    if (seg > 255) throw new Error(`this SEG numbers a segment ${seg}; this reader holds at most 255 structures per segmentation`);
    const o = toIJK(ippLps), fb = f * frameBytes, fbBits = f * frameBits;

    if (axisAligned) {
      // FAST PATH. The SEG shares the reference grid, so a frame maps straight onto one k slice and
      // the per-voxel matrix work disappears. Zero BYTES are skipped eight voxels at a time, which
      // matters because a segmentation is mostly empty: testing every voxel of every frame is
      // 452 x 332 x 17,957 = 2.7 billion bit tests, and that alone cost 19.3s on a real series.
      const k = Math.round(o[2]);
      // A frame off the reference volume is not "placed": counted, so the load message can say the
      // file has more than the volume shows (second critic, finding 16).
      if (k < 0 || k >= nz) { outside++; continue; }
      placed.add(seg);
      const i0 = Math.round(o[0]), j0 = Math.round(o[1]);
      const slice = k * nx * ny;

      if (i0 === 0 && j0 === 0) {
        // FASTEST PATH, and the one that actually runs: the frame starts at the slice origin.
        //
        // Two identities do the work. First, a frame is nx wide and so is a slice, so pixel `pp` of
        // the frame sits at row*nx + col within the slice -- and row*nx + col IS pp. The destination
        // is therefore `slice + pp`, with no division, no multiply and no bounds test (pp < nx*ny by
        // construction, since frameBytes truncates to (nx*ny)>>3).
        //
        // Second, a real segmentation is far emptier than it looks: measured at 1.31% non-zero bytes
        // on a 67-segment SEG over 993 slices. At that density the cost is not setting voxels, it is
        // *scanning past* the ones that are zero -- so read four bytes at a time and skip four at
        // once. Measured on that file, all three forms producing an identical labelmap:
        // 582 ms as written before, 375 ms with the identity alone, 130 ms with the 4-byte skip.
        const head = (4 - (fb & 3)) & 3;          // u32 reads need a 4-aligned offset
        // Each set bit: count a voxel another segment already holds, then take it. The test is
        // on set bits only, so the zero-skipping above keeps its speed.
        const byteAt = (byteIdx: number, b: number) => {
          const p = slice + (byteIdx << 3);
          if (b & 1) { if (lab[p] && lab[p] !== seg) overlaps++; lab[p] = seg; }
          if (b & 2) { if (lab[p + 1] && lab[p + 1] !== seg) overlaps++; lab[p + 1] = seg; }
          if (b & 4) { if (lab[p + 2] && lab[p + 2] !== seg) overlaps++; lab[p + 2] = seg; }
          if (b & 8) { if (lab[p + 3] && lab[p + 3] !== seg) overlaps++; lab[p + 3] = seg; }
          if (b & 16) { if (lab[p + 4] && lab[p + 4] !== seg) overlaps++; lab[p + 4] = seg; }
          if (b & 32) { if (lab[p + 5] && lab[p + 5] !== seg) overlaps++; lab[p + 5] = seg; }
          if (b & 64) { if (lab[p + 6] && lab[p + 6] !== seg) overlaps++; lab[p + 6] = seg; }
          if (b & 128) { if (lab[p + 7] && lab[p + 7] !== seg) overlaps++; lab[p + 7] = seg; }
        };
        for (let byteIdx = 0; byteIdx < head && byteIdx < frameBytes; byteIdx++) {
          const b = bits[fb + byteIdx];
          if (b !== 0) byteAt(byteIdx, b);
        }
        const w0 = (fb + head) >> 2, wEnd = (fb + frameBytes) >> 2;
        for (let w = w0; w < wEnd; w++) {
          const four = words[w];
          if (four === 0) continue;                // the whole point: 32 voxels dismissed at once
          const bi = (w << 2) - fb;
          for (let q = 0; q < 4; q++) {
            const b = (four >>> (q << 3)) & 0xff;
            if (b !== 0) byteAt(bi + q, b);
          }
        }
        for (let byteIdx = Math.max(head, (wEnd << 2) - fb); byteIdx < frameBytes; byteIdx++) {
          const b = bits[fb + byteIdx];
          if (b !== 0) byteAt(byteIdx, b);
        }
        continue;
      }

      // The frame is axis-aligned but offset from the slice origin, so the destination needs the
      // offset and the clip. Left in the straightforward form: it does not occur on the data we have,
      // and an untested fast path is worse than a slow correct one.
      // THE BIT INDEX PASSES 2^31 on a whole-body SEG (13,167 frames of 768x768 is 3.6 x 2^31 bits)
      // and `>> 3` is a 32-bit operation: past the mark it went negative, `bits[negative]` is
      // undefined, and every frame after it read as empty -- silently, on this path and the general
      // one, the same overflow the writer had fixed (second critic, 2026-09-17, finding 2). The byte
      // is found in double arithmetic; only the bit within the byte is shifted.
      for (let pp = 0; pp < frameBits; pp++) {
        const bitIdx = fbBits + pp;
        if (((bits[Math.floor(bitIdx / 8)] >> (bitIdx & 7)) & 1) === 0) continue;   // DICOM packs LSB first
        const row = (pp / segW) | 0, col = pp - row * segW;
        const i = i0 + col, j = j0 + row;
        if (i >= 0 && i < nx && j >= 0 && j < ny) {
          const p = slice + j * nx + i;
          if (lab[p] && lab[p] !== seg) overlaps++;               // counted on this path too (finding 12)
          lab[p] = seg;
        }
      }
      continue;
    }

    // General path: an oblique or flipped SEG, where each voxel needs the full mapping. Zero bytes
    // are still skipped, so an empty region costs one test per eight voxels rather than eight.
    // Bit-addressed and decomposed by the FRAME's width: correct whatever the frame size, whether or
    // not it is byte-aligned, and whether or not it matches the reference grid. The byte-at-a-time
    // zero skip is gone from this path on purpose -- it was only ever valid when a frame began on a
    // byte boundary, and this is the path that runs when it does not.
    let landed = false;
    for (let pp = 0; pp < frameBits; pp++) {
      const bitIdx = fbBits + pp;
      if (((bits[Math.floor(bitIdx / 8)] >> (bitIdx & 7)) & 1) === 0) continue;     // DICOM packs LSB first; the byte in double arithmetic (finding 2)
      const row = (pp / segW) | 0, col = pp - row * segW;
      const i = Math.round(o[0] + col * diCol[0] + row * diRow[0]);
      const j = Math.round(o[1] + col * diCol[1] + row * diRow[1]);
      const k = Math.round(o[2] + col * diCol[2] + row * diRow[2]);
      if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) {
        const p = k * nx * ny + j * nx + i;
        if (lab[p] && lab[p] !== seg) overlaps++;
        lab[p] = seg;
        landed = true;
      }
    }
    if (landed) placed.add(seg); else outside++;
  }

  onPhases?.({
    loadDcmjsMs: tLoad - t0,
    readFileMs: tRead - tLoad,
    naturalizeMs: tNat - tRead,
    placeMs: performance.now() - tNat,
    fastPath: axisAligned,
  });
  const referencedSeriesUID = ds.ReferencedSeriesSequence?.[0]?.SeriesInstanceUID;
  const refInst = ds.ReferencedSeriesSequence?.[0]?.ReferencedInstanceSequence;
  const referencedSOPInstanceUIDs = Array.isArray(refInst) ? refInst.map((r) => r.ReferencedSOPInstanceUID).filter((u): u is string => typeof u === "string") : undefined;
  const referencedFrames: { uid: string; frame: number }[] = [];
  for (const fg of ((ds as { PerFrameFunctionalGroupsSequence?: unknown[] }).PerFrameFunctionalGroupsSequence ?? []).slice(0, 64)) {
    const der = (fg as { DerivationImageSequence?: unknown }).DerivationImageSequence;
    const src = (Array.isArray(der) ? der[0] : der) as { SourceImageSequence?: unknown } | undefined;
    for (const it of (Array.isArray(src?.SourceImageSequence) ? src!.SourceImageSequence : src?.SourceImageSequence ? [src.SourceImageSequence] : []) as { ReferencedSOPInstanceUID?: string; ReferencedFrameNumber?: unknown }[]) {
      const f = Number(Array.isArray(it.ReferencedFrameNumber) ? it.ReferencedFrameNumber[0] : it.ReferencedFrameNumber);
      if (typeof it.ReferencedSOPInstanceUID === "string" && Number.isFinite(f) && f > 0) referencedFrames.push({ uid: it.ReferencedSOPInstanceUID, frame: f });
    }
  }
  const emptySegments = colors.map((c) => c[0]).filter((n) => !placed.has(n));
  return { lab, colors, names, fileCodes, referencedSeriesUID, sopClassUID: String(ds.SOPClassUID ?? ""), ...(referencedSOPInstanceUIDs?.length ? { referencedSOPInstanceUIDs } : {}), ...(referencedFrames.length ? { referencedFrames } : {}), emptySegments, overlapVoxels: overlaps, framesOutside: outside, geometry, algorithmName, ...(algorithmType ? { algorithmType } : {}) };
}
