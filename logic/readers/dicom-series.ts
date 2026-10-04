// DICOM series -> a single Volume (W1). Two layers, split so the geometry is testable without dcmjs:
//   reconstructSeries(instances)  — PURE: subseries split by orientation, sort by IPP·normal, ijkToRAS with
//                                   LPS->RAS, per-slice rescale, assemble. Ported from render/vendor/idc_tools
//                                   (idc-worker.js) so a local file series and an IDC series reconstruct the same.
//   parseInstances / loadDicomSeries — use dcmjs, through logic/dicom-io.ts (the vendored copy in the page), to fill DicomInstance.
// Matches Slicer's DICOMScalarVolumePlugin geometry: IJK->RAS from IOP/IPP/PixelSpacing, subseries by orientation.
import type { GeometrySource, Volume } from "./nifti.ts";
import { canDecode, decodeFrame, toReaderPixels } from "../codecs/decode.ts";
import { codecName, framesOf, RLE } from "../codecs/encapsulated.ts";
import { zarrDtype } from "./registry.ts";
import { type DicomJson, toDicomJson, toDucknTags } from "./dicom-tags.ts";

export interface DicomInstance {
  seriesInstanceUID: string;
  sopInstanceUID?: string;
  rows: number;                 // Rows (ny)
  columns: number;              // Columns (nx)
  pixelSpacing: [number, number];             // [between-rows (y), between-columns (x)] mm — DICOM order
  imageOrientationPatient: number[];          // 6: rowDir(3), colDir(3), LPS
  imagePositionPatient: [number, number, number];  // LPS mm
  sliceThickness?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
  pixelRepresentation?: 0 | 1;  // 0 unsigned, 1 signed
  instanceNumber?: number;
  /** ImageComments (0020,4000): on a gated CT the scanner writes the phase here ("86bpm, 250ms, ..."). */
  imageComments?: string;
  acquisitionTime?: string;
  windowCenter?: number;
  windowWidth?: number;
  modality?: string;
  pixels: Int16Array | Uint16Array;           // rows*columns, row-major
  patientName?: string;
  patientID?: string;
  studyInstanceUID?: string;
  seriesDescription?: string;
  /**
   * Have these values ever been through lossy compression? True for a lossy transfer syntax or for
   * LossyImageCompression "01" (PS3.3 C.7.6.1.1.5: the fact survives decompression). Absent when
   * neither says so. duckn's DICOM extension carries it as `lossy_compressed`.
   */
  lossy?: boolean;
  /**
   * AN IMAGE FROM A MULTI-FRAME FILE (Enhanced MR / CT / PET): which frame of that file, 1-based. The file's
   * one SOPInstanceUID names every frame in it, so a reference to one image needs both (a SEG's
   * ReferencedFrameNumber). Absent for an ordinary one-image-per-file series.
   */
  frameNumber?: number;
  /** Where this frame's VOLUME comes in acquisition order, from an enhanced file's dimension index: its index values
   *  without the slice-position dimensions (e.g. Philips' "Private DiffusionOrder"). Absent: the file does not say. */
  volumeOrder?: number[];
  /** Frame Content › TemporalPositionIndex: which time point this frame belongs to (fMRI, dynamic contrast). */
  temporalIndex?: number;
  /** What the registered interpreters say separates this image's volume from others (volume-interpreters.ts), by
   *  interpreter name -- e.g. "diffusion": its b-value and gradient direction. */
  volumeKeys?: Record<string, VolumeKey>;
  /** MR Echo › EffectiveEchoTime, ms: which echo of a multi-echo acquisition this frame is. */
  echoTime?: number;
  /** Frame Content › StackID: which stack of a multi-stack file this frame belongs to. */
  stackId?: string;
  /** The instance's (or the frame's) whole header, when parseInstances was asked for it: `json` the record in the DICOM
   *  JSON Model (every attribute, private and binary ones included), `tags` Michael Halle's keyword view of it. */
  header?: { json: DicomJson; tags: Record<string, unknown> };
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lps2ras = (v: number[]) => [-v[0], -v[1], v[2]];
const orientKey = (iop: number[]) => iop.map((v) => Math.round(v * 1000) / 1000).join(",");

export interface Series {
  seriesInstanceUID: string;
  description?: string;
  modality?: string;
  instances: DicomInstance[];
  /**
   * One frame of a series that holds several volumes in time: which frame, of how many, and what
   * the scanner wrote about it (the R-wave delay from ImageComments, or the acquisition time).
   * Absent for an ordinary series.
   */
  temporal?: FrameTiming;
  /** A part of a multi-frame series that is NOT a whole volume (slices missing), left out with the reason. */
  leftOutWhy?: string;
}

/**
 * When a frame IS, as far as the scanner said. `delayMs` and `bpm` come from ImageComments on a
 * gated CT ("86bpm, 250ms, ..."), `timeSec` from AcquisitionTime (seconds of the day, median over
 * the frame's instances) -- the bolus-monitoring series has only that. Playback at the true rate
 * needs one of the two; the module works it out (logic/sequences.ts realTimeSchedule).
 */
export interface FrameTiming {
  index: number;
  count: number;
  label: string;
  bpm?: number;
  delayMs?: number;
  timeSec?: number;
  /** What the interpreters keep for this volume, by interpreter name (volume-interpreters.ts): e.g. keys.diffusion =
   *  { bValue, gradient }. */
  keys?: Record<string, Record<string, unknown>>;
}

/**
 * Group instances into series, then split each series by ImageOrientationPatient (Slicer's
 * subseries rule), then split a series that holds SEVERAL VOLUMES IN TIME into its frames.
 *
 * THE TIME SPLIT. A retrospectively gated coronary CTA writes every slice position k times, once
 * per cardiac phase, into ONE series (a gated coronary CTA study: 533 positions x 5 phases = 2,665
 * instances; 438 x 6 = 2,628); a bolus-tracking "Monitoring" series writes one position 10 times.
 * The phase is not in TriggerTime or NominalPercentageOfCardiacPhase on this scanner -- both
 * absent -- and AcquisitionNumber counts scan passes, not phases. What is reliable is the SHAPE:
 * each position appears k times, and the scanner numbers the instances phase-major, so at each
 * position the j-th instance by InstanceNumber is phase j. That is the split used here, with the
 * scanner's own words as the frame's label: ImageComments carries "86bpm, 250ms, 66ms, ..." and
 * the delay after the R-wave names the phase to a cardiologist better than "3 of 5" does. A
 * position that appears a different number of times than the others is not a frame of anything;
 * the series is left whole. Nothing else guards that case: the repeated positions show only as uneven
 * slice spacing (meta.irregularSpacing), which the load reports (critic, 2026-09-25, finding 16).
 * Multi-frame files are split by what their frames say instead (splitByVolumeKey).
 */
export function groupSeries(instances: DicomInstance[]): Series[] {
  const byUid = new Map<string, DicomInstance[]>();
  for (const i of instances) { const k = i.seriesInstanceUID; if (!byUid.has(k)) byUid.set(k, []); byUid.get(k)!.push(i); }
  const out: Series[] = [];
  for (const [uid, list] of byUid) {
    const byOrient = new Map<string, DicomInstance[]>();
    for (const i of list) { const k = orientKey(i.imageOrientationPatient); if (!byOrient.has(k)) byOrient.set(k, []); byOrient.get(k)!.push(i); }
    let idx = 0;
    for (const g of byOrient.values()) {
      const base = byOrient.size > 1 ? `${uid}#${idx++}` : uid;
      const frames = splitFrames(g);
      if (!frames) { out.push({ seriesInstanceUID: base, description: g[0].seriesDescription, modality: g[0].modality, instances: g }); continue; }
      const kept = frames.filter((f) => !f.leftOutWhy);
      frames.filter((f) => f.leftOutWhy).forEach((f, j) => out.push({
        seriesInstanceUID: `${base}#x${j}`, description: g[0].seriesDescription, modality: g[0].modality, instances: f.instances, leftOutWhy: f.leftOutWhy,
      }));
      kept.forEach((f, j) => out.push({
        seriesInstanceUID: `${base}#t${j}`,
        description: g[0].seriesDescription,
        modality: g[0].modality,
        instances: f.instances,
        temporal: { index: j, count: kept.length, ...f.timing },
      }));
    }
  }
  return out;
}

/** The frames of a series whose positions repeat, or null when it is a plain stack. */
function splitFrames(g: DicomInstance[]): { instances: DicomInstance[]; timing: Omit<FrameTiming, "index" | "count">; leftOutWhy?: string }[] | null {
  const keyed = splitByVolumeKey(g);
  if (keyed !== undefined) return keyed;
  const posKey = (i: DicomInstance) => i.imagePositionPatient.map((v) => v.toFixed(2)).join(",");
  const byPos = new Map<string, DicomInstance[]>();
  for (const i of g) { const k = posKey(i); if (!byPos.has(k)) byPos.set(k, []); byPos.get(k)!.push(i); }
  const counts = new Set([...byPos.values()].map((l) => l.length));
  if (counts.size !== 1) return null;
  const k = [...counts][0];
  if (k < 2) return null;
  const frames: DicomInstance[][] = Array.from({ length: k }, () => []);
  for (const list of byPos.values()) {
    list.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || (a.frameNumber ?? 0) - (b.frameNumber ?? 0));
    list.forEach((inst, j) => frames[j].push(inst));
  }
  return frames.map((instances, j) => ({ instances, timing: frameTiming(instances, j, k) }));
}

/**
 * THE VOLUMES OF A MULTI-FRAME FILE, BY WHAT THE SCANNER SAYS SEPARATES THEM. An enhanced multi-frame file states per
 * frame which time point it belongs to (TemporalPositionIndex: an fMRI run, a dynamic contrast series), which echo
 * (EffectiveEchoTime), which stack (StackID), and for diffusion its b-value and gradient direction. Frames alike in all
 * of these are one volume -- unless they repeat a slice position: two b=0 volumes, a direction acquired twice, carry the
 * same key, so a group is split by occurrence (the first frame at each position into the first volume, the second into
 * the second). Critic, 2026-09-25, finding 1: they had been merged into one volume of 858 slices at 0.13 mm.
 * A volume that does not cover every slice position (a frame without its position, a partial acquisition) is LEFT OUT
 * and named, and the rest load (finding 2: one damaged frame had turned a whole 4D series into one mixed volume).
 * Returns undefined when the frames do not say (the position-repeat rule below then applies).
 */
function splitByVolumeKey(g: DicomInstance[]): { instances: DicomInstance[]; timing: Omit<FrameTiming, "index" | "count">; leftOutWhy?: string }[] | undefined {
  if (!g.every((i) => i.frameNumber !== undefined)) return undefined;
  const key = (i: DicomInstance) => `${i.temporalIndex ?? ""}|${i.echoTime ?? ""}|${i.stackId ?? ""}|${volumeKeyString(i.volumeKeys)}`;
  const posKey = (i: DicomInstance) => i.imagePositionPatient.map((v) => v.toFixed(2)).join(",");
  // ACQUISITION ORDER: the file's instance number first, then the frame within it. For an enhanced file every frame
  // shares one instance number, so this is frame order as before; for a Siemens MOSAIC every file numbers its tiles
  // 1..n, and frame order alone interleaved the files -- the volumes came out in file-listing order, and two b=0
  // mosaics could mix their slices (found 2026-09-29 against dcm2niix on the Prisma set).
  const order = (i: DicomInstance) => (i.instanceNumber ?? 0) * 1e6 + i.frameNumber!;
  // The file's own statement of the order, where it makes one (an enhanced file's dimension index): compared first.
  const byDim = (a: DicomInstance, b: DicomInstance) => {
    const x = a.volumeOrder, y = b.volumeOrder;
    // Total, so the sort is consistent in a series that mixes files with and without a dimension index: those with one first.
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    for (let q = 0; q < Math.min(x.length, y.length); q++) if (x[q] !== y[q]) return x[q] - y[q];
    return 0;
  };
  const byKey = new Map<string, DicomInstance[]>();
  for (const i of [...g].sort((a, b) => order(a) - order(b))) { const k = key(i); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k)!.push(i); }
  // Split each group that repeats positions. By OCCURRENCE (the n-th time a position appears goes to volume n) only when
  // every position appears equally often: that works whatever the frame order. When one does not -- a frame missing
  // from one of two b=0 acquisitions -- occurrence mixed the acquisitions (critic, 2026-09-25 night, finding 3: a volume
  // of [10, 10, 40] from two b=0s), so then by FRAME ORDER: a new volume starts where a position repeats, which keeps
  // each acquisition's frames together and leaves out the incomplete one.
  const candidates: DicomInstance[][] = [];
  for (const list of byKey.values()) {
    const count = new Map<string, number>();
    for (const i of list) count.set(posKey(i), (count.get(posKey(i)) ?? 0) + 1);
    const even = new Set(count.values()).size === 1;
    const parts: DicomInstance[][] = [];
    if (even) {
      const seen = new Map<string, number>();
      for (const i of list) { const p = posKey(i); const n = seen.get(p) ?? 0; seen.set(p, n + 1); (parts[n] ??= []).push(i); }
    } else {
      let run: DicomInstance[] = [], inRun = new Set<string>();
      for (const i of list) {                                  // list is in frame order
        const p = posKey(i);
        if (inRun.has(p)) { parts.push(run); run = []; inRun = new Set(); }
        run.push(i); inRun.add(p);
      }
      if (run.length) parts.push(run);
    }
    candidates.push(...parts);
  }
  if (candidates.length < 2) return undefined;
  const all = new Set(g.map(posKey));
  const whole = (c: DicomInstance[]) => c.length === all.size;
  const first = (l: DicomInstance[]) => Math.min(...l.map(order));
  // Acquisition order: the file's dimension index when it gives one (Philips enhanced diffusion keeps its b=0 volumes at
  // the END of the file but acquired them between the directions -- found against dcm2niix, 2026-09-29), else time
  // point, echo, and where the volume's first frame sits.
  const vols = candidates.filter(whole).sort((a, b) => byDim(a[0], b[0]) || (a[0].temporalIndex ?? 0) - (b[0].temporalIndex ?? 0) || (a[0].echoTime ?? 0) - (b[0].echoTime ?? 0) || first(a) - first(b));
  const partial = candidates.filter((c) => !whole(c));
  const hasTime = vols.some((v) => v[0].temporalIndex !== undefined) && new Set(vols.map((v) => v[0].temporalIndex)).size > 1;
  const hasEcho = new Set(vols.map((v) => v[0].echoTime)).size > 1;
  const out: { instances: DicomInstance[]; timing: Omit<FrameTiming, "index" | "count">; leftOutWhy?: string }[] = vols.map((instances, j) => {
    const i0 = instances[0];
    const timing = frameTiming(instances, j, vols.length);
    const parts: string[] = [];
    if (hasTime) parts.push(`t ${i0.temporalIndex}`);
    if (hasEcho) parts.push(`TE ${i0.echoTime} ms`);
    const vk = Object.keys(i0.volumeKeys ?? {}).sort().map((n) => [n, i0.volumeKeys![n]] as const);
    for (const [, k] of vk) if (k.label) parts.push(k.label);
    const labeled = vk.some(([, k]) => k.label);
    return {
      instances,
      // A time point left out: the others carry their own time point ("t 1", "t 3"), not "1 of 2" (night finding 10).
      timing: { ...timing, ...(parts.length && (hasEcho || labeled || (hasTime && partial.length > 0)) ? { label: parts.join(" · ") } : {}), ...(vk.length ? { keys: Object.fromEntries(vk.map(([n, k]) => [n, k.meta])) } : {}) },
    };
  });
  for (const c of partial) out.push({ instances: c, timing: { label: "" }, leftOutWhy: `${c.length} image${c.length === 1 ? "" : "s"} of a volume that has ${c.length} of ${all.size} slices (a frame without its position, or a partial acquisition)` });
  return out;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/** DICOM TM ("HHMMSS.ffffff", or HHMM, or HH) as seconds of the day; undefined when not a time. */
export function tmToSeconds(tm: string | undefined): number | undefined {
  const m = /^(\d{2})(\d{2})?(\d{2}(?:\.\d+)?)?/.exec((tm ?? "").trim());
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * What the scanner says a frame is: the R-wave delay when ImageComments carries one, else its
 * ordinal -- and when it was, for playing at the true rate.
 */
function frameTiming(instances: DicomInstance[], j: number, k: number): Omit<FrameTiming, "index" | "count"> {
  const delays = new Map<number, number>();
  const bpms: number[] = [];
  const times: number[] = [];
  for (const i of instances) {
    const c = i.imageComments ?? "";
    const m = /(\d+(?:\.\d+)?)\s*ms/.exec(c);
    if (m) delays.set(Number(m[1]), (delays.get(Number(m[1])) ?? 0) + 1);
    const b = /(\d+(?:\.\d+)?)\s*bpm/i.exec(c);
    if (b) bpms.push(Number(b[1]));
    const t = tmToSeconds(i.acquisitionTime);
    if (t !== undefined) times.push(t);
  }
  const when: Omit<FrameTiming, "index" | "count" | "label"> = {};
  if (times.length) when.timeSec = median(times);
  if (bpms.length) when.bpm = median(bpms);
  if (delays.size) {
    // The pass that covers the most slices names the frame; a phase assembled from several passes
    // carries delays a few ms apart (208/212/213/217 for a nominal 200) and the median tells it.
    const mid = Math.round(median([...delays.keys()]));
    return { label: `${mid} ms`, delayMs: mid, ...when };
  }
  return { label: `${j + 1} of ${k}`, ...when };
}

/** Reconstruct ONE geometrically consistent series (single orientation) into a Volume. Pure. */
export function reconstructSeries(instances: DicomInstance[]): Volume {
  if (instances.length === 0) throw new Error("empty DICOM series");
  const iop = instances[0].imageOrientationPatient.map(Number);
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
  const slices = [...instances].sort((a, b) => dot(a.imagePositionPatient as number[], normal) - dot(b.imagePositionPatient as number[], normal));
  const s0 = slices[0], nz = slices.length, ny = s0.rows, nx = s0.columns;
  const ps = s0.pixelSpacing;                             // [rowSpacing(y), colSpacing(x)]
  // ONE GEOMETRY OR NONE. A slice with another orientation, size or pixel spacing cannot be a
  // plane of this volume, and building one anyway does two wrong things at once: it draws that
  // picture at a plane where it does not belong, and -- worse, because it is invisible -- the
  // through-plane spacing derived from first-to-last position takes in the stray position and
  // stretches the whole volume. Seen on C3L-03960 (cptac_sar), where every reformatted series
  // carries the axial reference picture as instance 1: 3.43 mm instead of 3.0 mm, 14% too long.
  // The caller splits by orientation first (groupSeries); this is the guard behind it.
  for (const s of slices) {
    if (orientKey(s.imageOrientationPatient) !== orientKey(iop)) throw new Error(`a slice in this series has a different orientation (${s.imageOrientationPatient.map((v) => (+v).toFixed(2)).join(",")} vs ${iop.map((v) => v.toFixed(2)).join(",")}) — split the series by orientation first`);
    if (s.rows !== ny || s.columns !== nx) throw new Error(`a slice in this series is ${s.columns}×${s.rows} where the others are ${nx}×${ny}`);
    if (Math.abs(s.pixelSpacing[0] - ps[0]) > 1e-4 || Math.abs(s.pixelSpacing[1] - ps[1]) > 1e-4) throw new Error(`a slice in this series has ${s.pixelSpacing.join("×")} mm pixels where the others have ${ps.join("×")} mm`);
  }
  const p0 = slices[0].imagePositionPatient as number[], p1 = slices[nz - 1].imagePositionPatient as number[];
  // Through-plane spacing is DERIVED, from the positions of the first and last slice. This is the
  // correct source and not the obvious one: `SliceThickness` is a different, acquired number — the
  // slab each slice integrates over — and substituting it distorts the volume wherever the series
  // has a gap or an overlap. That mistake is one of the oldest sources of quietly wrong geometry in
  // medical imaging, so the reader records which it used rather than leaving it to be inferred.
  // DICOM's pixel positions name the center of a pixel: cell centering, as duckn writes for DICOM.
  const spacingFrom: GeometrySource = nz > 1
    ? { origin: "derived", mechanism: "slice positions", spaceUnit: "mm", anatomical: true, centering: "cell",
        slicePositions: slices.map((s) => dot(s.imagePositionPatient as number[], normal)) }
    : s0.sliceThickness
    ? { origin: "acquired", mechanism: "SliceThickness (single slice, no positions to difference)", spaceUnit: "mm", anatomical: true, centering: "cell" }
    : { origin: "assumed", mechanism: "1 mm (single slice, no SliceThickness)", spaceUnit: "mm", anatomical: true, centering: "cell" };
  const sliceSpacing = nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (s0.sliceThickness || 1);
  // AND EVERY SLICE IN BETWEEN IS CHECKED against that grid. First-to-last gives the right spacing
  // for a regular series and a wrong VOLUME for one with a gap or an overlap: the slices in between
  // land off their true positions, and a SEG written from such a volume is wrong in every reader
  // but this one (critic, 2026-09-17, finding 10: 0,1,2,3,10,11,12 mm became a 2 mm grid and 22
  // voxels changed slices on the round trip). Slicer warns on this and offers to resample; here the
  // worst deviation is recorded in `meta.irregularSpacing` and the loader says it.
  let irregularSpacing: { worstMm: number; atSlice: number } | undefined;
  if (nz > 2 && sliceSpacing > 0) {
    let worst = 0, at = 0;
    for (let k = 1; k < nz - 1; k++) {
      const d = Math.abs(dot(sub(slices[k].imagePositionPatient as number[], p0), normal) - k * sliceSpacing);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst > 0.25 * sliceSpacing) irregularSpacing = { worstMm: worst, atSlice: at };
  }
  const c0 = lps2ras(rowDir.map((v) => v * ps[1]));       // i (columns, x-fastest) uses COLUMN spacing
  const c1 = lps2ras(colDir.map((v) => v * ps[0]));       // j (rows) uses ROW spacing
  const c2 = lps2ras(normal.map((v) => v * sliceSpacing));
  const o = lps2ras(p0);
  const ijkToRAS = [c0[0], c1[0], c2[0], o[0], c0[1], c1[1], c2[1], o[1], c0[2], c1[2], c2[2], o[2], 0, 0, 0, 1];
  const signed = slices.some((s) => (s.rescaleIntercept ?? 0) !== 0 || (s.pixelRepresentation === 1) || (s.modality === "CT"));
  // A RESCALE THAT DOES NOT GIVE WHOLE NUMBERS (Philips MR: slope 0.7038, 1.0733) is kept in 32-bit floats, exactly.
  // Written into 16-bit integers it lost the fraction -- up to 1 in every voxel, found on 2026-09-25 against pydicom
  // on Philips' public fMRI and diffusion files. Ron: "Yes" (keep the values exact; twice the memory for these only).
  const fractional = slices.some((s) => !Number.isInteger(s.rescaleSlope ?? 1) || !Number.isInteger(s.rescaleIntercept ?? 0));
  // AND THE RANGE DECIDES TOO (critic, 2026-09-25, finding 11): a whole-number rescale can still leave 16 bits -- MR
  // slope 2 on a stored 40000 is 80000, an unsigned CT with intercept -1024 reaches 64511 -- and a 16-bit array wrapped
  // those silently (14464, -1025). The real values' range, from each slice's stored range and its rescale, picks the
  // smallest type that holds them, float32 when no 16-bit one does.
  let lo = Infinity, hi = -Infinity;
  for (const sl of slices) {
    let a = Infinity, b = -Infinity; const px = sl.pixels;
    for (let p = 0; p < px.length; p++) { const v = px[p]; if (v < a) a = v; if (v > b) b = v; }
    const m = sl.rescaleSlope ?? 1, c = sl.rescaleIntercept ?? 0;
    lo = Math.min(lo, a * m + c, b * m + c); hi = Math.max(hi, a * m + c, b * m + c);
  }
  const fitsI16 = lo >= -32768 && hi <= 32767, fitsU16 = lo >= 0 && hi <= 65535;
  const kind = fractional ? "f32" : signed ? (fitsI16 ? "i16" : fitsU16 ? "u16" : "f32") : (fitsU16 ? "u16" : fitsI16 ? "i16" : "f32");
  const data = kind === "f32" ? new Float32Array(nx * ny * nz) : kind === "i16" ? new Int16Array(nx * ny * nz) : new Uint16Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const s = slices[k], slope = s.rescaleSlope ?? 1, inter = s.rescaleIntercept ?? 0, off = k * nx * ny, px = s.pixels;
    if (slope === 1 && inter === 0) (data as { set(a: ArrayLike<number>, o: number): void }).set(px, off);
    else for (let p = 0; p < nx * ny; p++) data[off + p] = px[p] * slope + inter;
  }
  const dtype = zarrDtype(data);
  const name = s0.seriesDescription || s0.modality || "DICOM";
  const meta: Record<string, unknown> = { seriesInstanceUID: s0.seriesInstanceUID, studyInstanceUID: s0.studyInstanceUID, modality: s0.modality, patientName: s0.patientName, ...(s0.patientID ? { patientID: s0.patientID } : {}) };
  if (typeof s0.windowCenter === "number" && typeof s0.windowWidth === "number") { meta.windowCenter = s0.windowCenter; meta.windowWidth = s0.windowWidth; }
  // WHICH INSTANCES THIS VOLUME IS, in slice order. A series can hold more than one volume -- the
  // five phases of a gated CTA in one series, or a second orientation -- and a SEG drawn on one of
  // them must reference that one's images, not the whole series (the writer refused: "the series
  // has 2665 frames but the segmentation has 533 slices"). Instance numbers are unique within a
  // series and small; 533 of them are 3 KB on the node.
  if (slices.every((s) => typeof s.instanceNumber === "number")) meta.instanceNumbers = slices.map((s) => s.instanceNumber);
  if (irregularSpacing) meta.irregularSpacing = irregularSpacing;
  // And their SOP instance UIDs, which is what a SEG's ReferencedInstanceSequence names: a SEG
  // loaded back finds the frame it was drawn on by these, not by the series (all five phases
  // share one series, and by series alone every phase's SEG landed on the first).
  if (slices.every((s) => typeof s.sopInstanceUID === "string")) meta.sopInstanceUIDs = slices.map((s) => s.sopInstanceUID);
  // From a multi-frame file every slice shares that one uid; which frame of it each slice is completes the reference.
  if (slices.every((s) => typeof s.frameNumber === "number")) meta.frameNumbers = slices.map((s) => s.frameNumber);
  // The rule and its version travel with the values (critic, 2026-09-29, finding 11): a person or a later step can see
  // where a direction came from, or why there is none.
  for (const [n, k] of Object.entries(s0.volumeKeys ?? {})) meta[n] = k.meta;
  const sliceHeaders = slices.every((s) => s.header) ? { sliceHeaders: slices.map((s) => s.header!) } : {};
  return { dims: [nx, ny, nz], ijkToRAS, data, dtype, name, meta, geometry: spacingFrom, ...sliceHeaders };
}

/**
 * THE VOLUMES A SERIES HOLDS, as the DICOM browser loads them: every frame of the largest family in
 * time (the phases of a gated CT), or else the largest group of one orientation. What is not loaded
 * is named in `leftOut`, not silently dropped.
 *
 * One function for both places that make volumes from a series -- the page's load (dicom-db.ts,
 * `loadSequence`) and the server's duckn working copy (desktop/duckn-copy.ts) -- so the copy is the
 * same volume as the load by construction, not by keeping two copies of this logic in step.
 */
export function volumesOfSeries(instances: DicomInstance[], onFrame?: (i: number, n: number, slices: number) => void): { frames: Volume[]; labels: string[]; timing: FrameTiming[]; leftOut: string[]; leftOutImages: NotRead[]; reconMs: number } {
  const groups = groupSeries(instances);
  // The frames of the largest temporal family; anything else in the series is reported.
  const temporal = groups.filter((g) => g.temporal).sort((a, b) => a.temporal!.index - b.temporal!.index);
  const candidates = groups.filter((g) => !g.leftOutWhy);
  const why = (g: typeof groups[number]) => g.leftOutWhy ?? `${g.instances.length} image${g.instances.length === 1 ? "" : "s"} in another orientation`;
  // NOTHING COMPLETE (critic, 2026-09-25 night, finding 4: it crashed on the empty list): said, with each reason.
  if (!temporal.length && !candidates.length) throw new Error(`none of the volumes in this series is complete -- ${groups.map(why).join("; ")}`);
  const chosen = temporal.length ? temporal : [candidates.sort((a, b) => b.instances.length - a.instances.length)[0]];
  const leftOut = groups.filter((g) => !chosen.includes(g)).map(why);
  // Which images, by SOPInstanceUID and frame number (critic, 2026-09-25, finding 7).
  const leftOutImages: NotRead[] = groups.filter((g) => !chosen.includes(g)).flatMap((g) =>
    g.instances.map((i) => ({ sopInstanceUID: i.sopInstanceUID, ...(i.frameNumber ? { frameNumber: i.frameNumber } : {}), why: why(g) })));
  const t = performance.now();
  const frames = chosen.map((g, i) => { onFrame?.(i, chosen.length, g.instances.length); return reconstructSeries(g.instances); });
  return {
    frames,
    labels: chosen.map((g, i) => g.temporal?.label ?? `${i + 1} of ${chosen.length}`),
    timing: chosen.map((g, i) => g.temporal ?? { index: i, count: chosen.length, label: `${i + 1} of ${chosen.length}` }),
    leftOut,
    leftOutImages,
    reconMs: performance.now() - t,
  };
}

// ---- dcmjs parse (browser) ------------------------------------------------------------------
// The library is reached only through logic/dicom-io.ts (the one place; critic, 2026-09-28, finding 6).
import { mosaicTile, siemensMosaic } from "./siemens-mosaic.ts";
import { finishKeys, keysOfFrame, keysOfInstance, volumeKeyString, type VolumeKey } from "./volume-interpreters.ts";
import { dicomIO, setDicomLibrary } from "../dicom-io.ts";
/** Inject a dcmjs (tests, the copy converter, the SEG-decode worker). The name the callers already use. */
export const setDcmjs = setDicomLibrary;

/**
 * A string dcmjs read from INSIDE a sequence item, decoded as the file meant it.
 *
 * dcmjs 0.41.0 applies SpecificCharacterSet to top-level strings and decodes strings inside sequence
 * items as Latin-1, so a segment named "Ünïcode · name" came back as "ÃœnÃ¯code Â· name" while the
 * series description of the same file read correctly (critic, 2026-09-17, finding 6). The bytes are
 * intact -- each Latin-1 character IS one byte of the UTF-8 -- so they are re-read as UTF-8 when that
 * parses; a genuine Latin-1 string that is not valid UTF-8 is left alone.
 *
 * UPSTREAM: dcmjs-org/dcmjs#508 (filed from here, 2026-09-05) and #503; fixed by dcmjs PR #520 (not merged on
 * 2026-09-26). Remove this when Albula moves to a dcmjs release that has it -- which also needs the UN-sequence misread
 * fixed (Contents/docs/upstream-issues-dcmjs.md in the workspace, item 9) before Albula can leave 0.41.0.
 */
export function utf8InsideSequence(s: string, specificCharacterSet?: unknown): string {
  // Only when the file declares UTF-8: a genuine Latin-1 name from an ISO_IR 100 file that happens
  // to parse as UTF-8 ("Ã©") must stay what it is (second critic, 2026-09-17, finding 19).
  if (specificCharacterSet !== undefined && !/ISO_IR 192|ISO 2022 IR 192/.test(String(specificCharacterSet))) return s;
  if (!/[^\u0000-\u007f]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // dcmjs decodes as Windows-1252, not Latin-1: bytes 0x80-0x9F come back as the characters of
    // that code page (0x9C as "œ"), so those are mapped back before the UTF-8 read.
    const b = c <= 0xff ? c : CP1252_BACK.get(c);
    if (b === undefined) return s;        // beyond both: not the case this handles
    bytes[i] = b;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return s; }
}
const CP1252_BACK = new Map<number, number>(
  [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
   0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178]
    .map((cp, i) => [cp, 0x80 + i] as [number, number]),
);


const num = (v: unknown, d = 0): number => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? n : d; };

/**
 * Why an instance was skipped, when a whole series comes back empty.
 *
 * A caller that gets nothing needs to say something better than "no image instances": the reason is
 * knowable and it decides what the user should do next. Ron, trying to load a CT: "0 loaded; 1
 * failed — this series has no image instances (it is CT) — load it as a segmentation instead of a
 * volume", which is wrong twice over -- it IS an image series, and loading it as a segmentation
 * would fail for the same reason.
 */
export const lastSkipReasons = new Map<string, number>();
/** WHICH images were dropped, one entry per file or frame (critic, 2026-09-25, finding 7: the copy said "1 image in another
 *  orientation" and nobody could tell which): the file's SOPInstanceUID when it could be read, the frame number for a frame
 *  of a multi-frame file, `frames` when a whole multi-frame file went, and the reason. Cleared with `lastSkipReasons`. */
export interface NotRead { sopInstanceUID?: string; frameNumber?: number; frames?: number; file?: string; why: string }
export const lastSkipped: NotRead[] = [];
/** The first element (by tag, at any depth) whose binary value claims more bytes than the file has, or undefined. */
export function valueLongerThan(dict: Record<string, unknown>, fileBytes: number, depth = 0): string | undefined {
  if (depth > 16) return undefined;
  for (const [tag, e] of Object.entries(dict)) {
    const v = (e as { vr?: string; Value?: unknown[] }).Value;
    if (!Array.isArray(v)) continue;
    for (const x of v) {
      if ((x instanceof ArrayBuffer || ArrayBuffer.isView(x)) && x.byteLength > fileBytes) return tag;
      if ((e as { vr?: string }).vr === "SQ" && x && typeof x === "object") { const t = valueLongerThan(x as Record<string, unknown>, fileBytes, depth + 1); if (t) return t; }
    }
  }
  return undefined;
}
/** How long the last `parseInstances` spent converting headers (`headers: true`), in ms: the converter names it in its
 *  timing report (critic, 2026-09-25, finding 13: three quarters of a multi-frame conversion went unnamed). */
export let lastHeaderMs = 0;

/** Parse DICOM instance buffers into DicomInstance[] (drops non-image objects — SEG/SR/PR handled
 *  elsewhere). Anything dropped is counted in `lastSkipReasons`, with the reason. */
/** `names`: each buffer's file, relative to where it lives (the database), so a file that could not be read is named
 *  in `lastSkipped` (critic, 2026-09-25 night, finding 6: an unreadable file had no identity at all). */
export async function parseInstances(buffers: ArrayBuffer[], opts: { headers?: boolean; names?: string[] } = {}): Promise<DicomInstance[]> {
  const dcm = await dicomIO();
  const out: DicomInstance[] = [];
  lastSkipReasons.clear(); lastSkipped.length = 0; lastHeaderMs = 0;
  const skipped = (why: string, where: Omit<NotRead, "why"> = {}) => { lastSkipReasons.set(why, (lastSkipReasons.get(why) ?? 0) + 1); lastSkipped.push({ ...where, why }); };
  for (const [bi, buf] of buffers.entries()) {
    const fileName = opts.names?.[bi] ? { file: opts.names[bi] } : {};
    let ds: Record<string, unknown>;
    let meta: Record<string, unknown> = {};
    let rawDict: Record<string, { vr: string; Value?: unknown[] }> = {};
    let rawMeta: Record<string, { vr: string; Value?: unknown[] }> = {};
    try {
      const parsed = dcm.readFile(buf);
      rawDict = parsed.dict as typeof rawDict;
      rawMeta = ((parsed as { meta?: unknown }).meta ?? {}) as typeof rawMeta;
      ds = dcm.naturalize(parsed.dict);
      meta = dcm.naturalize(parsed.meta);
      // A VALUE LONGER THAN THE FILE is a misread, not data: dcmjs 0.52 read a sequence sent with VR UN as explicit VR
      // and returned a 909 MB value from a 184 KB CT slice that DCMTK and dcmjs 0.41 read correctly (critic, 2026-09-25
      // night, finding 1). Albula is back on 0.41; this stays as a guard, and says what it is: the reader's misread.
      const tooLong = valueLongerThan(parsed.dict, buf.byteLength);
      if (tooLong) throw new Error(`the DICOM library misread ${tooLong} (a value longer than the file)`);
    } catch (e) {
      // A Japanese or Korean character set (ISO 2022 code extensions) stops dcmjs; said as such (critic, 2026-09-25,
      // finding 15), since "unreadable" sends the reader looking for a damaged file.
      const m = (e as Error).message;
      skipped(/multiple character sets/i.test(m) ? "uses a Japanese or Korean character set (ISO 2022 code extensions), which this reader cannot read yet" : `unreadable (${m.slice(0, 60)})`, fileName);
      continue;
    }
    // THE WHOLE HEADER, for the duckn copy (logic/readers/dicom-tags.ts), when asked: a frame of a multi-frame file gets
    // the file's header with only its own per-frame item.
    // The file's part is converted once; a frame adds only its own item (a 4,725-frame fMRI file would otherwise
    // convert the same header 4,725 times).
    let fileHeader: { json: DicomJson; tags: Record<string, unknown> } | undefined;
    const headerOfUntimed = opts.headers ? (frame?: { item: unknown; index: number }) => {
      if (frame === undefined) return { json: toDicomJson(rawDict, rawMeta), tags: toDucknTags(ds, meta) };
      if (!fileHeader) {
        const { PerFrameFunctionalGroupsSequence: _pf, ...rest } = ds;
        const { "52009230": _rpf, ...rawRest } = rawDict;
        fileHeader = { json: toDicomJson(rawRest, rawMeta), tags: toDucknTags(rest, meta) };
      }
      const rawItem = (rawDict["52009230"]?.Value ?? [])[frame.index] as Record<string, { vr: string; Value?: unknown[] }>;
      return {
        json: { ...fileHeader.json, "52009230": { vr: "SQ", Value: [toDicomJson(rawItem)] } },
        tags: { ...fileHeader.tags, ...toDucknTags({ PerFrameFunctionalGroupsSequence: [frame.item] }) },
      };
    } : undefined;
    const headerOf = headerOfUntimed ? (frame?: { item: unknown; index: number }) => {
      const t0 = performance.now();
      try { return headerOfUntimed(frame); } finally { lastHeaderMs += performance.now() - t0; }
    } : undefined;
    // THE FILE'S OWN UIDs: dcmjs drops every character of a UI that is not a digit or a dot, and a SEG written from this
    // volume would reference instances no archive holds (critic, 2026-09-25, finding 12). Taken from the file's text.
    // UPSTREAM, drafted, not filed yet: Contents/docs/upstream-issues-dcmjs.md in the workspace, new issue 3. Remove when a
    // dcmjs release keeps a UI as the file writes it.
    const rawUid = (tag: string) => { const r = (rawDict[tag] as { _rawValue?: unknown[] } | undefined)?._rawValue?.[0]; return typeof r === "string" ? r.replace(/^[ \u0000]+|[ \u0000]+$/g, "") || undefined : undefined; };
    for (const [tag, key] of [["00080018", "SOPInstanceUID"], ["0020000E", "SeriesInstanceUID"], ["0020000D", "StudyInstanceUID"]] as const) { const u = rawUid(tag); if (u) ds[key] = u; }
    const nFrames = Number(ds.NumberOfFrames ?? 1);
    const here = { ...fileName, sopInstanceUID: typeof ds.SOPInstanceUID === "string" ? ds.SOPInstanceUID : undefined, ...(nFrames > 1 ? { frames: nFrames } : {}) };
    if (!ds.PixelData) { skipped("no pixel data (not an image object)", here); continue; }
    if (ENHANCED_IMAGE_CLASSES.has(String(ds.SOPClassUID ?? "")) && ds.PerFrameFunctionalGroupsSequence) {
      out.push(...await enhancedFrames(ds, String(meta.TransferSyntaxUID ?? ""), skipped, headerOf, rawDict));
      continue;
    }
    if (String(ds.SOPClassUID ?? "").startsWith("1.2.840.10008.5.1.4.1.1.66") || ds.Modality === "SEG") {
      skipped("a segmentation, not an image (it loads as a segmentation)", here);
      continue;
    }
    if (ds.PerFrameFunctionalGroupsSequence && Number(ds.NumberOfFrames ?? 1) > 1) {
      // Multi-frame, but a kind the frame reader is not open to yet: said as that, not as missing geometry (finding 15).
      skipped(`a multi-frame image of a kind this reader does not read yet (SOP class ${String(ds.SOPClassUID ?? "?")})`, { ...here, frames: Number(ds.NumberOfFrames) });
      continue;
    }
    // A MULTI-FRAME FILE WITHOUT PER-FRAME GEOMETRY (legacy multi-frame MR/CT, NM, multi-frame secondary capture): this
    // path reads one image, so frame 1 was taken and frames 2-N silently dropped, or the whole file overflowed one slice
    // (critic, 2026-09-25 night, finding 5). Refused, with its frame count, until such files are read frame by frame.
    if (nFrames > 1) {
      skipped(`a multi-frame image without per-frame positions (${nFrames} frames), which this reader does not read yet`, here);
      continue;
    }
    // Mike's keyword view and the record, taken HERE, before the decode below changes BitsAllocated (finding 14).
    const hdr = headerOf ? headerOf() : undefined;
    if (!ds.ImageOrientationPatient || !ds.ImagePositionPatient || !ds.PixelSpacing) {
      skipped(`no image plane attributes (no ${[!ds.ImagePositionPatient && "position", !ds.ImageOrientationPatient && "orientation", !ds.PixelSpacing && "pixel spacing"].filter(Boolean).join(", ")})`, here);
      continue;
    }
    let pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
    const syntax0 = String(meta.TransferSyntaxUID ?? "");
    // COMPRESSED PIXEL DATA, decoded per instance into the same 16-bit samples the raw path
    // yields (logic/codecs/decode.ts): RLE and JPEG lossless by our own code, the rest by the
    // vendored WebAssembly codecs in a worker. Ron, 2026-09-19: "let's go with the low hanging
    // fruit … investing in our own RLE and lossless JPEG" and then "yes, go ahead with the rest".
    if (Array.isArray(pd) && canDecode(syntax0)) {
      try {
        const frags = pd.map((b) => new Uint8Array(b));
        const frame = framesOf(frags, num(ds.NumberOfFrames, 1), syntax0 === RLE ? "rle" : "jpeg")[0];
        const fm = { rows: num(ds.Rows), columns: num(ds.Columns), samplesPerPixel: num(ds.SamplesPerPixel, 1), bitsAllocated: num(ds.BitsAllocated, 16), bitsStored: num(ds.BitsStored, num(ds.BitsAllocated, 16)), signed: ds.PixelRepresentation === 1 };
        const d = await decodeFrame(syntax0, frame, fm);
        if (d.componentCount !== 1) throw new Error("color pixel data is not read as a volume");
        if (d.samples.length !== fm.rows * fm.columns) throw new Error(`the codestream holds ${d.samples.length} samples for a ${fm.rows}x${fm.columns} image`);
        const wide = toReaderPixels(d, fm);
        pd = wide.buffer.slice(wide.byteOffset, wide.byteOffset + wide.byteLength) as ArrayBuffer;
        ds.BitsAllocated = 16;
      } catch (e) { skipped(`compressed pixel data (${codecName(syntax0)}) could not be decoded: ${(e as Error).message.slice(0, 80)}`, here); continue; }
    }
    if (Array.isArray(pd)) pd = pd[0];
    // dcmjs hands back an ARRAY of fragments for ENCAPSULATED pixel data -- the DICOM wrapper for
    // compressed transfer syntaxes (JPEG, JPEG 2000, RLE...) -- and taking pd[0] above is only
    // correct when that fragment IS the whole uncompressed frame. There is no decoder here for any
    // of those; reading a JPEG bitstream as raw samples does not throw, it produces a plausible
    // Uint16Array that is actually the compressed bytes -- structured, non-random static, easy to
    // mistake for real (if odd-looking) data. Ron, looking at exactly that in the 3D view: "some
    // text and the bytes are swapped". Caught here by size alone rather than an allow-list of
    // transfer syntaxes to maintain: compressed data is essentially always smaller than the raw
    // frame it decodes to, so a short fragment is the tell regardless of which codec produced it.
    const bitsAllocated = num(ds.BitsAllocated, 16);
    const samplesPerPixel = num(ds.SamplesPerPixel, 1);
    const expectedBytes = num(ds.Rows) * num(ds.Columns) * samplesPerPixel * Math.ceil(bitsAllocated / 8);
    if (!pd || (pd as ArrayBuffer).byteLength < expectedBytes) {
      // The tell for COMPRESSED pixel data, for which there is no decoder here. Named, because
      // "this series has no image instances" sends the reader looking in the wrong place entirely.
      const syntax = String(meta.TransferSyntaxUID ?? "");
      skipped(
        syntax && syntax !== "1.2.840.10008.1.2" && syntax !== "1.2.840.10008.1.2.1"
          ? `the pixel data is compressed as ${codecName(syntax)} (${syntax}), which this application cannot decode`
          : "pixel data shorter than the image it declares",
        here,
      );
      continue;
    }
    const signed = ds.PixelRepresentation === 1;
    pd = littleEndianPixels(pd as ArrayBuffer, syntax0, bitsAllocated);
    // WHAT SEPARATES THIS IMAGE'S VOLUME, as the registered interpreters read it (volume-interpreters.ts; diffusion: the
    // diffusion extension's).
    const volumeKeys = keysOfInstance(ds, rawDict);
    const diffFields = volumeKeys ? { volumeKeys } : {};
    const allPixels = signed ? new Int16Array(pd as ArrayBuffer) : new Uint16Array(pd as ArrayBuffer);
    // A SIEMENS MOSAIC holds many slices tiled into one image: each tile becomes an instance of its own, at its own
    // position (siemens-mosaic.ts), so grouping and reconstruction treat it like any other series.
    const mosaic = siemensMosaic(ds, rawDict);
    const tiles = mosaic ? Array.from({ length: mosaic.n }, (_, k) => k) : [-1];
    for (const k of tiles) {
    out.push({
      seriesInstanceUID: String(ds.SeriesInstanceUID ?? "series"),
      sopInstanceUID: ds.SOPInstanceUID as string | undefined,
      ...(mosaic ? { frameNumber: k + 1 } : {}),
      ...diffFields,
      rows: mosaic ? mosaic.rows : num(ds.Rows), columns: mosaic ? mosaic.columns : num(ds.Columns),
      pixelSpacing: (ds.PixelSpacing as number[]).map(Number) as [number, number],
      imageOrientationPatient: (ds.ImageOrientationPatient as number[]).map(Number),
      imagePositionPatient: mosaic ? mosaic.positions[k] : (ds.ImagePositionPatient as number[]).map(Number) as [number, number, number],
      // THE FILE'S TEXT decides: dcmjs reads a malformed DS such as "1,5" as 15 (critic, 2026-09-25, finding 5). The
      // standard's decimal mark is a period; anything else is not a thickness this reader will guess at.
      sliceThickness: (() => {
        const r = (rawDict["00180050"] as { _rawValue?: unknown[] } | undefined)?._rawValue?.[0];
        if (typeof r === "string") { const t = r.trim(); return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : undefined; }
        return ds.SliceThickness != null ? num(ds.SliceThickness) : undefined;
      })(),
      rescaleSlope: ds.RescaleSlope != null ? num(ds.RescaleSlope, 1) : 1,
      rescaleIntercept: ds.RescaleIntercept != null ? num(ds.RescaleIntercept) : 0,
      pixelRepresentation: signed ? 1 : 0,
      instanceNumber: ds.InstanceNumber != null ? num(ds.InstanceNumber) : undefined,
      imageComments: typeof ds.ImageComments === "string" ? ds.ImageComments : undefined,
      acquisitionTime: typeof ds.AcquisitionTime === "string" ? ds.AcquisitionTime : undefined,
      windowCenter: ds.WindowCenter != null ? num(ds.WindowCenter) : undefined,
      windowWidth: ds.WindowWidth != null ? num(ds.WindowWidth) : undefined,
      modality: ds.Modality as string | undefined,
      pixels: mosaic ? mosaicTile(allPixels, mosaic, num(ds.Columns), k) : allPixels,
      patientName: typeof ds.PatientName === "object" ? (ds.PatientName as { Alphabetic?: string }).Alphabetic : ds.PatientName as string | undefined,
      patientID: typeof ds.PatientID === "string" ? ds.PatientID : undefined,
      studyInstanceUID: ds.StudyInstanceUID as string | undefined,
      seriesDescription: ds.SeriesDescription as string | undefined,
      ...(LOSSY_SYNTAXES.has(syntax0) || String(ds.LossyImageCompression ?? "") === "01" ? { lossy: true } : {}),
      ...(hdr ? { header: hdr } : {}),
    });
    }
  }
  finishKeys(out);
  return out;
}


/**
 * ENHANCED MULTI-FRAME IMAGES: one file, many frames, each frame's position, orientation, spacing, value scaling
 * and meaning in the functional groups (PS3.3 C.7.6.16) -- a frame's own item where it has one, else the shared
 * one. Siemens' XA software writes every MR series this way (21 series in the database it was built against, all
 * refused before 2026-09-25 because the position is not at the top of the file). Each frame becomes one
 * DicomInstance, so grouping, the volume split and the geometry checks are the ones every other series gets.
 * Michael Halle's duckn reads these files the same way (`_load_multiframe`), and the tests check it.
 * Only these SOP classes: a SEG is multi-frame too, and is not an image to be read as one.
 */
const ENHANCED_IMAGE_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.2.1",    // Enhanced CT
  "1.2.840.10008.5.1.4.1.1.2.2",    // Legacy Converted Enhanced CT
  "1.2.840.10008.5.1.4.1.1.4.1",    // Enhanced MR
  "1.2.840.10008.5.1.4.1.1.4.4",    // Legacy Converted Enhanced MR
  "1.2.840.10008.5.1.4.1.1.128.1",  // Legacy Converted Enhanced PET
  "1.2.840.10008.5.1.4.1.1.130",    // Enhanced PET
  // Geometry in the functional groups too (critic, 2026-09-25, finding 15: the public tomosynthesis sample was refused
  // as having "no position, orientation or spacing"; it has all three, per frame).
  "1.2.840.10008.5.1.4.1.1.13.1.3", // Breast Tomosynthesis
  "1.2.840.10008.5.1.4.1.1.13.1.1", // X-Ray 3D Angiographic
  "1.2.840.10008.5.1.4.1.1.13.1.2", // X-Ray 3D Craniofacial
]);
type Item = Record<string, unknown>;
const item0 = (v: unknown): Item | undefined => (Array.isArray(v) ? v[0] : v) as Item | undefined;
/** A functional group for one frame: its own item, else the shared one. */
const fgroup = (own: Item | undefined, shared: Item | undefined, name: string): Item | undefined => item0(own?.[name]) ?? item0(shared?.[name]);

/**
 * EXPLICIT VR BIG ENDIAN (1.2.840.10008.1.2.2, retired in 2004 but still in old archives -- the GE Signa HDx example in
 * Contents/data/dwi-vendors): dcmjs returns the pixel bytes as stored, so 16-bit samples arrive byte-swapped (a 2 reads
 * as 512). Swapped here into a copy; any other syntax, or 8-bit samples, pass through untouched. WAITS ON: dcmjs #541
 * (filed 2026-09-29; the workspace's Contents/docs/upstream-issues-dcmjs.md, issue 11); if dcmjs starts
 * swapping, the three big-endian sets in the diffusion extension's diffusion-vendors.test.ts fail and show it. 32-bit samples are not handled.
 */
export function littleEndianPixels(buf: ArrayBuffer, syntax: string, bitsAllocated: number): ArrayBuffer {
  if (syntax !== "1.2.840.10008.1.2.2" || bitsAllocated !== 16) return buf;
  const b = new Uint8Array(buf.slice(0)), n = b.length & ~1;
  for (let i = 0; i < n; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return b.buffer;
}

async function enhancedFrames(ds: Record<string, unknown>, syntax: string, skipped: (why: string, where?: Omit<NotRead, "why">) => void, headerOf?: (frame: { item: unknown; index: number }) => DicomInstance["header"], raw?: Record<string, unknown>): Promise<DicomInstance[]> {
  const n = num(ds.NumberOfFrames, 1);
  // THE DIMENSIONS the file declares (PS3.3 C.7.6.17): which index values say where a frame's VOLUME comes -- all but
  // the slice-position ones (in-stack position, plane position) and the stack.
  const tagOf = (v: unknown) => (typeof v === "number" ? v.toString(16).padStart(8, "0") : String(v ?? "")).toUpperCase().replace(/[^0-9A-F]/g, "");
  const dimPointers = (Array.isArray(ds.DimensionIndexSequence) ? ds.DimensionIndexSequence : ds.DimensionIndexSequence ? [ds.DimensionIndexSequence] : []).map((d) => tagOf((d as Item).DimensionIndexPointer));
  // Dimensions that state an ORDER (a temporal position, a vendor's own acquisition order such as Philips' "Private
  // DiffusionOrder") order the volumes. Position and stack are not volumes; the standard MR Diffusion macro's b-value
  // (0018,9087) and gradient (0018,9089) are VALUES of a frame, and sorting by them is b-major, not acquisition order
  // (critic, 2026-09-29, finding 9) -- standard DICOM dimension tags, read here as such; their meaning is the
  // diffusion extension's.
  const volumeDims = dimPointers.map((t, q) => (["00209057", "00200032", "00209056", "00189087", "00189089"].includes(t) ? -1 : q)).filter((q) => q >= 0);
  // A FRAME'S SLICE THICKNESS FROM THE FILE'S TEXT (its own PixelMeasures item, else the shared one): a malformed DS such
  // as "1,5" is unknown, not the 15 dcmjs makes of it -- the single-image path's rule (critic, 2026-09-25 night, finding 8).
  type RawIt = Record<string, { Value?: RawIt[]; _rawValue?: unknown[] }>;
  const rawItem = (seq: string, idx: number) => ((raw?.[seq] as { Value?: RawIt[] } | undefined)?.Value ?? [])[idx];
  const rawThick = (it?: RawIt) => it?.["00289110"]?.Value?.[0]?.["00180050"]?._rawValue?.[0];
  const thicknessOf = (f: number, measures?: Item) => {
    const r = rawThick(rawItem("52009230", f)) ?? rawThick(rawItem("52009229", 0));
    if (typeof r === "string") { const t = r.trim(); return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? Number(t) : undefined; }
    return measures?.SliceThickness != null ? num(measures.SliceThickness) : undefined;
  };
  const whole = { sopInstanceUID: ds.SOPInstanceUID as string | undefined, frames: n };   // the whole file dropped
  const frame = (f: number) => ({ sopInstanceUID: ds.SOPInstanceUID as string | undefined, frameNumber: f + 1 });
  const perFrame = ds.PerFrameFunctionalGroupsSequence as Item[];
  const shared = item0(ds.SharedFunctionalGroupsSequence);
  if (!Array.isArray(perFrame) || perFrame.length !== n) { skipped(`a multi-frame image whose per-frame list has ${Array.isArray(perFrame) ? perFrame.length : 0} entries for ${n} frames`, whole); return []; }
  const rows = num(ds.Rows), cols = num(ds.Columns), bits = num(ds.BitsAllocated, 16);
  if (num(ds.SamplesPerPixel, 1) !== 1) { skipped("a multi-frame color image (not read as a volume)", whole); return []; }
  if (bits !== 16) { skipped(`a multi-frame image with ${bits}-bit pixels (only 16-bit pixels are read)`, whole); return []; }
  const signed = ds.PixelRepresentation === 1;
  const frameBytes = rows * cols * 2;
  const pd = ds.PixelData as ArrayBuffer | ArrayBuffer[];
  let frameAt: (f: number) => Promise<ArrayBuffer>;
  if (Array.isArray(pd) && canDecode(syntax)) {
    let frames: Uint8Array[];
    try { frames = framesOf(pd.map((b) => new Uint8Array(b)), n, syntax === RLE ? "rle" : "jpeg"); }
    catch (e) { skipped(`compressed multi-frame pixel data (${codecName(syntax)}) could not be split into frames: ${(e as Error).message.slice(0, 80)}`, whole); return []; }
    const fm = { rows, columns: cols, samplesPerPixel: 1, bitsAllocated: 16, bitsStored: num(ds.BitsStored, 16), signed };
    frameAt = async (f) => {
      const d = await decodeFrame(syntax, frames[f], fm);
      if (d.componentCount !== 1 || d.samples.length !== rows * cols) throw new Error(`frame ${f + 1} decodes to ${d.samples.length} samples for a ${cols}x${rows} image`);
      const w = toReaderPixels(d, fm);
      return w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) as ArrayBuffer;
    };
  } else {
    const all = Array.isArray(pd) ? pd[0] : pd;
    if (!all || all.byteLength < frameBytes * n) {
      skipped(syntax && syntax !== "1.2.840.10008.1.2" && syntax !== "1.2.840.10008.1.2.1"
        ? `the pixel data is compressed as ${codecName(syntax)} (${syntax}), which this application cannot decode`
        : `multi-frame pixel data shorter than the ${n} frames it declares`, whole);
      return [];
    }
    frameAt = (f) => Promise.resolve(littleEndianPixels(all.slice(f * frameBytes, (f + 1) * frameBytes), syntax, bits));
  }
  const patientName = typeof ds.PatientName === "object" ? (ds.PatientName as { Alphabetic?: string }).Alphabetic : ds.PatientName as string | undefined;
  const lossy = LOSSY_SYNTAXES.has(syntax) || String(ds.LossyImageCompression ?? "") === "01";
  const out: DicomInstance[] = [];
  for (let f = 0; f < n; f++) {
    const own = perFrame[f];
    const pos = fgroup(own, shared, "PlanePositionSequence")?.ImagePositionPatient as number[] | undefined;
    const iop = fgroup(own, shared, "PlaneOrientationSequence")?.ImageOrientationPatient as number[] | undefined;
    const measures = fgroup(own, shared, "PixelMeasuresSequence");
    const ps = measures?.PixelSpacing as number[] | undefined;
    if (!pos || !iop || !ps) {
      // WHICH is missing, named (the public tomosynthesis sample has position and orientation per frame, but no pixel
      // spacing anywhere: its PixelMeasures holds only SliceThickness).
      const miss = [!pos && "position", !iop && "orientation", !ps && "pixel spacing"].filter(Boolean).join(" and ");
      skipped(`a multi-frame image whose frames have no ${miss}`, frame(f));
      continue;
    }
    const rescale = fgroup(own, shared, "PixelValueTransformationSequence");
    const voi = fgroup(own, shared, "FrameVOILUTSequence");
    const content = item0(own?.FrameContentSequence);
    const dimValues = (Array.isArray(content?.DimensionIndexValues) ? content!.DimensionIndexValues : content?.DimensionIndexValues != null ? [content.DimensionIndexValues] : []) as unknown[];
    const volumeOrder = volumeDims.length && dimValues.length === dimPointers.length ? volumeDims.map((d) => Number(dimValues[d])) : undefined;
    const frameKeys = keysOfFrame((name) => fgroup(own, shared, name) as Record<string, unknown> | undefined, { ds, raw });
    const fadt = typeof content?.FrameAcquisitionDateTime === "string" ? content.FrameAcquisitionDateTime : undefined;
    const echo = fgroup(own, shared, "MREchoSequence")?.EffectiveEchoTime;
    let pixels: ArrayBuffer;
    try { pixels = await frameAt(f); } catch (e) { skipped(`compressed pixel data (${codecName(syntax)}) could not be decoded: ${(e as Error).message.slice(0, 80)}`, frame(f)); continue; }
    out.push({
      seriesInstanceUID: String(ds.SeriesInstanceUID ?? "series"),
      sopInstanceUID: ds.SOPInstanceUID as string | undefined,
      frameNumber: f + 1,
      ...(headerOf ? { header: headerOf({ item: own, index: f }) } : {}),
      rows, columns: cols,
      pixelSpacing: ps.map(Number) as [number, number],
      imageOrientationPatient: iop.map(Number),
      imagePositionPatient: pos.map(Number) as [number, number, number],
      sliceThickness: thicknessOf(f, measures),
      rescaleSlope: rescale?.RescaleSlope != null ? num(rescale.RescaleSlope, 1) : ds.RescaleSlope != null ? num(ds.RescaleSlope, 1) : 1,
      rescaleIntercept: rescale?.RescaleIntercept != null ? num(rescale.RescaleIntercept) : ds.RescaleIntercept != null ? num(ds.RescaleIntercept) : 0,
      pixelRepresentation: signed ? 1 : 0,
      instanceNumber: ds.InstanceNumber != null ? num(ds.InstanceNumber) : undefined,
      ...(content?.TemporalPositionIndex != null ? { temporalIndex: num(content.TemporalPositionIndex) } : {}),
      ...(echo != null ? { echoTime: num(echo) } : {}),
      ...(content?.StackID != null ? { stackId: String(content.StackID) } : {}),
      ...(frameKeys ? { volumeKeys: frameKeys } : {}),
      ...(volumeOrder && volumeOrder.every(Number.isFinite) ? { volumeOrder } : {}),
      // DT "YYYYMMDDHHMMSS.ffffff": the time of day, for playing a time series at its true rate
      acquisitionTime: fadt && fadt.length >= 10 ? fadt.slice(8) : typeof ds.AcquisitionTime === "string" ? ds.AcquisitionTime : undefined,
      windowCenter: voi?.WindowCenter != null ? num(voi.WindowCenter) : ds.WindowCenter != null ? num(ds.WindowCenter) : undefined,
      windowWidth: voi?.WindowWidth != null ? num(voi.WindowWidth) : ds.WindowWidth != null ? num(ds.WindowWidth) : undefined,
      modality: ds.Modality as string | undefined,
      pixels: signed ? new Int16Array(pixels) : new Uint16Array(pixels),
      patientName,
      patientID: typeof ds.PatientID === "string" ? ds.PatientID : undefined,
      studyInstanceUID: ds.StudyInstanceUID as string | undefined,
      seriesDescription: ds.SeriesDescription as string | undefined,
      ...(lossy ? { lossy: true } : {}),
    });
  }
  return out;
}

/** Transfer syntaxes that can be lossy (PS3.5 Annex A): JPEG baseline and extended, JPEG-LS
 *  near-lossless, JPEG 2000 and HTJ2K without the lossless restriction, JPEG XL. The lossless-only
 *  ones (.57, .70, .80, .90, .201, .202, RLE) are not here. */
const LOSSY_SYNTAXES = new Set([
  "1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.81", "1.2.840.10008.1.2.4.91",
  "1.2.840.10008.1.2.4.203", "1.2.840.10008.1.2.4.110", "1.2.840.10008.1.2.4.112",
]);

/** Parse a set of DICOM buffers and reconstruct each distinct series into a Volume. */
export async function loadDicomSeries(buffers: ArrayBuffer[]): Promise<{ series: Series; volume: Volume }[]> {
  const series = groupSeries(await parseInstances(buffers));
  return series.map((s) => ({ series: s, volume: reconstructSeries(s.instances) }));
}
