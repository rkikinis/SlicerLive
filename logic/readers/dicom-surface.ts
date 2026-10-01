/**
 * Read a DICOM Surface Segmentation (SOP class 1.2.840.10008.5.1.4.1.1.66.5) back into meshes.
 *
 * The other half of `logic/export-dicom-surface.ts`. Ron asked for it directly: "Is there a
 * meaningful way to round trip the surfaces through the dicom data base, so I don't need to recreate
 * everytime I am starting a new version." Extraction is 15 s on a whole-body study and 3.6 s on a
 * brain -- not painful any more, but not worth paying on every load either, and a stored surface is
 * the same geometry rather than a recomputation of it.
 *
 * WHAT COMES BACK, and what does not. The writer stores each surface's points, normals and triangle
 * indices, its name, and its color. It does NOT store the labelmap value the surface came from:
 * Surface Number and Segment Number are sequence positions, which the standard wants contiguous from
 * 1, and a label value is neither. So a caller that needs label values matches by NAME against the
 * segmentation the surfaces belong to -- the same way a stored SEG comes back to the right place, and
 * for the same reason: names survive the dense renumbering that label values do not.
 */
import type { LabelMesh } from "../../algorithms/surface-nets.ts";
import { utf8InsideSequence } from "./dicom-series.ts";

/** One surface as stored, before it is matched to a segment. */
export interface StoredSurface {
  /** Sequence position, 1-based, as written. Not a label value. */
  number: number;
  /** The segment name the writer put in Surface Comments and Segment Label. */
  name: string;
  /** 0-1 RGB from Recommended Display CIELab, or undefined if none was stored. */
  color?: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface DecodedSurfaces {
  surfaces: StoredSurface[];
  /** The SEG these surfaces were derived from, if the writer recorded one. */
  derivedFromSeriesUID?: string;
  frameOfReferenceUID?: string;
}

// deno-lint-ignore no-explicit-any
type Ds = Record<string, any>;

/** dcmjs hands binary back as an ArrayBuffer, or a one-element array holding one. */
function buf(v: unknown): ArrayBuffer | null {
  if (v instanceof ArrayBuffer) return v;
  if (Array.isArray(v) && v[0] instanceof ArrayBuffer) return v[0] as ArrayBuffer;
  // Exactly the view's bytes, not its whole underlying buffer (second critic, 2026-09-17, finding 17).
  if (ArrayBuffer.isView(v)) { const u = v as ArrayBufferView; return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; }
  return null;
}

/** A sequence attribute, as an array however dcmjs presents it. */
function seq(v: unknown): Ds[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]) as Ds[];
}

/**
 * CIELab as DICOM stores it (three uint16 over 0..65535) back to 0-1 sRGB.
 *
 * The inverse of `rgbToDicomLab` in the writer. Done here rather than via dcmjs's own helper so the
 * reader does not depend on which of its color utilities exist in a given version -- the OL finding
 * (dcmjs-org/dcmjs#509) is a standing reminder that they vary.
 */
function dicomLabToRgb(v: readonly number[]): [number, number, number] | undefined {
  if (!v || v.length < 3) return undefined;
  const L = (v[0] / 65535) * 100;
  const a = (v[1] / 65535) * 255 - 128;
  const b = (v[2] / 65535) * 255 - 128;
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fx), Y = 1.0 * inv(fy), Z = 1.08883 * inv(fz);
  const lin = [
    X * 3.2406 + Y * -1.5372 + Z * -0.4986,
    X * -0.9689 + Y * 1.8758 + Z * 0.0415,
    X * 0.0557 + Y * -0.204 + Z * 1.057,
  ];
  const g = (c: number) => {
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, s));
  };
  return [g(lin[0]), g(lin[1]), g(lin[2])];
}

/** Is this dataset a Surface Segmentation? Cheap enough to ask before decoding. */
export function isSurfaceSegmentation(ds: Ds): boolean {
  return String(ds?.SOPClassUID ?? "") === "1.2.840.10008.5.1.4.1.1.66.5";
}

/**
 * Decode a naturalized Surface Segmentation dataset.
 *
 * Takes the dataset rather than bytes so the caller owns the dcmjs dependency and the parse -- the
 * readers here are already split that way, and it keeps this testable without a file.
 */
export function decodeSurfaces(ds: Ds): DecodedSurfaces {
  if (!isSurfaceSegmentation(ds)) throw new Error(`not a Surface Segmentation: SOP class ${ds?.SOPClassUID}`);

  // Segment Sequence carries the names; Surface Sequence the geometry. They are joined by
  // Referenced Surface Number, NOT by position -- the writer emits them in step today, but a file
  // from anywhere else need not, and reading position-for-position would silently mislabel meshes.
  const nameOfSurface = new Map<number, string>();
  for (const sg of seq(ds.SegmentSequence)) {
    const label = sg.SegmentLabel ? utf8InsideSequence(String(sg.SegmentLabel), ds.SpecificCharacterSet) : undefined;
    for (const rs of seq(sg.ReferencedSurfaceSequence)) {
      const n = Number(rs.ReferencedSurfaceNumber);
      if (Number.isFinite(n) && label) nameOfSurface.set(n, label);
    }
  }

  const surfaces: StoredSurface[] = [];
  for (const s of seq(ds.SurfaceSequence)) {
    const number = Number(s.SurfaceNumber);
    const pts = buf(seq(s.SurfacePointsSequence)[0]?.PointCoordinatesData);
    const idx = buf(seq(s.SurfaceMeshPrimitivesSequence)[0]?.LongTrianglePointIndexList);
    // A surface with no points or no triangles is not a surface. Skipped rather than thrown on: one
    // malformed item must not cost the reader the rest of the file.
    if (!pts || !idx) continue;
    const nrm = buf(seq(s.SurfacePointsNormalsSequence)[0]?.VectorCoordinateData);
    // THE FILE IS IN PATIENT SPACE (LPS) WITH 1-BASED INDICES, as C.27.2.1 asks; the scene is RAS
    // and 0-based. Files this application wrote before 2026-09-17 were RAS and 0-based (the
    // critic's finding 1); a 1-based list never contains 0, so an index list with a 0 in it is one
    // of those and is taken as it is. See the note at the top of logic/export-dicom-surface.ts.
    const rawIdx = new Uint32Array(idx);
    const legacy = rawIdx.some((v) => v === 0);
    const positions = new Float32Array(pts);
    const normals = nrm ? new Float32Array(nrm) : new Float32Array(0);
    if (!legacy) {
      for (let i = 0; i + 1 < positions.length; i += 3) { positions[i] = -positions[i]; positions[i + 1] = -positions[i + 1]; }
      for (let i = 0; i + 1 < normals.length; i += 3) { normals[i] = -normals[i]; normals[i + 1] = -normals[i + 1]; }
      for (let i = 0; i < rawIdx.length; i++) rawIdx[i] -= 1;
    }
    surfaces.push({
      number,
      name: nameOfSurface.get(number) ?? (s.SurfaceComments ? utf8InsideSequence(String(s.SurfaceComments), ds.SpecificCharacterSet) : `surface ${number}`),
      color: dicomLabToRgb(s.RecommendedDisplayCIELabValue as number[]),
      positions,
      // Normals are optional in the standard. Absent, the mesh shader falls back to the face normal,
      // which is what an imported model without normals already does.
      normals,
      indices: rawIdx,
    });
  }

  // WHICH SEGMENTATION THESE CAME FROM, if the writer said.
  //
  // Common Instance Reference carries one item per referenced series, and this object references
  // two: the images it sits in, and the SEG it was extracted from. They are told apart by the SOP
  // class of what each item references -- 66.4 is a SEG -- and NOT by position, which is the same
  // rule the segment/surface join above follows and for the same reason.
  //
  // DerivationImageSequence is read as a fallback because it is where this looked before, and a
  // file written by something else may well use it. Files this application wrote before the series
  // uid was recorded have neither, and come back undefined -- which is why every caller treats an
  // absent value as "no claim" rather than as a mismatch.
  const SEG_CLASSES = new Set(["1.2.840.10008.5.1.4.1.1.66.4", "1.2.840.10008.5.1.4.1.1.66.7", "1.2.840.10008.5.1.4.1.1.66.5"]);   // binary, label map, surface
  const fromSeg = seq(ds.ReferencedSeriesSequence).find((s) =>
    seq(s?.ReferencedInstanceSequence).some((i) => SEG_CLASSES.has(String(i?.ReferencedSOPClassUID ?? "")))
  );
  const derived = seq(ds.DerivationImageSequence)[0];
  const ref = seq(derived?.SourceImageSequence)[0];
  const derivedSeries = fromSeg?.SeriesInstanceUID ?? ref?.ReferencedSeriesInstanceUID;
  return {
    surfaces,
    derivedFromSeriesUID: derivedSeries ? String(derivedSeries) : undefined,
    frameOfReferenceUID: ds.FrameOfReferenceUID ? String(ds.FrameOfReferenceUID) : undefined,
  };
}

/**
 * Attach label values by NAME, giving back exactly what the renderer consumes.
 *
 * `segments` is the segmentation these surfaces belong to. A surface whose name matches no segment is
 * dropped rather than guessed at: a mesh drawn under the wrong label takes that label's color and
 * that label's visibility, which is a silent and confusing wrong answer.
 */
export function surfacesToMeshes(
  stored: readonly StoredSurface[],
  segments: readonly { labelValue: number; name?: string }[],
): LabelMesh[] {
  // BY NAME, AND BY ORDER AMONG EQUAL NAMES. A merge keeps its inputs' names, so a merged
  // segmentation can hold "aorta" twice; a map from name to one label would send both surfaces to
  // the later segment and leave the earlier one bare (critic, 2026-09-17, finding 5). The writer
  // emits surfaces in segment order, so the k-th stored "aorta" is the k-th "aorta" segment, in
  // both directions; a name with more stored surfaces than segments drops the extras rather than
  // guessing, the same rule as a name that matches nothing.
  const labelsByName = new Map<string, number[]>();
  for (const s of segments) {
    if (!s.name) continue;
    const key = s.name.toLowerCase();
    (labelsByName.get(key) ?? labelsByName.set(key, []).get(key)!).push(s.labelValue);
  }
  const taken = new Map<string, number>();
  const out: LabelMesh[] = [];
  for (const s of stored) {
    const key = s.name.toLowerCase();
    const labels = labelsByName.get(key);
    if (!labels) continue;
    const nth = taken.get(key) ?? 0;
    if (nth >= labels.length) continue;
    taken.set(key, nth + 1);
    out.push({ label: labels[nth], positions: s.positions, normals: s.normals, indices: s.indices });
  }
  return out;
}

/**
 * The whole read side of the round trip, over however many datasets a stored series turned out to
 * hold: keep the ones that really are surfaces of `parentSeriesUID`, and return their meshes.
 *
 * Separated from the application's DICOM plumbing so the DECISIONS are testable without a file, a
 * database or dcmjs. Each of the three is a way to draw the wrong geometry:
 *
 * - **Not a Surface Segmentation.** The caller finds this series through a provenance edge, which is
 *   our own bookkeeping: it records that a series was derived from this segmentation as "surface",
 *   not that the file is one. A future writer that mislabels a crop puts it on this path.
 * - **Derived from something else.** When the object names the SEG it came from, that beats the
 *   edge -- the edge is what we wrote down, the reference is the object's own claim about itself.
 *   They disagree if a database is copied, an edge is hand-edited, or a UID is reused.
 * - **A name that matches no segment**, which `surfacesToMeshes` drops, because a mesh under the
 *   wrong label takes that label's color and visibility: a wrong answer that looks like a right one.
 *
 * Silent skipping is right here. Every one of these means "this is not the thing we are looking
 * for", and the caller's answer to finding nothing is to extract the surfaces afresh -- which is
 * what it did before any of this existed.
 */
export function meshesFromStoredSeries(
  datasets: readonly Ds[],
  segments: readonly { labelValue: number; name?: string }[],
  parentSeriesUID?: string,
): LabelMesh[] {
  const out: LabelMesh[] = [];
  for (const ds of datasets) {
    if (!isSurfaceSegmentation(ds)) continue;
    const decoded = decodeSurfaces(ds);
    if (parentSeriesUID && decoded.derivedFromSeriesUID && decoded.derivedFromSeriesUID !== parentSeriesUID) continue;
    out.push(...surfacesToMeshes(decoded.surfaces, segments));
  }
  return out;
}
