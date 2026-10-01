/**
 * DICOM PICTURES: instances that are images but not slices. A Siemens gated CT writes its ECG
 * documentation as RGB secondary captures ("CT_SOM ECGDOC": the trace, the beats it used marked in
 * green) in a series named "ECG " + the reconstruction's own description. They have no image plane
 * -- no position, no orientation -- so parseInstances rightly refuses them; this reads them as what
 * they are: pixels to look at, in instance order.
 *
 * Uncompressed 8-bit only, RGB (interleaved or planar) or one-sample gray. Anything else is skipped
 * and named in `skipped`, as the slice reader does.
 */
import { dicomIO } from "../dicom-io.ts";
import type { DbSeriesEntry } from "./dicom-db.ts";

export interface Picture {
  width: number;
  height: number;
  /** RGBA, row-major, alpha 255: what a canvas wants. */
  rgba: Uint8ClampedArray;
  instanceNumber?: number;
  seriesDescription?: string;
  seriesInstanceUID?: string;
  imageType?: string[];
}

const num = (v: unknown, d = 0) => { const n = Array.isArray(v) ? Number(v[0]) : Number(v); return Number.isFinite(n) ? n : d; };

/** The pictures among `buffers`, in instance order; `skipped` says why the others were not. */
export async function parsePictures(buffers: ArrayBuffer[]): Promise<{ pictures: Picture[]; skipped: string[] }> {
  const dcm = await dicomIO();
  const pictures: Picture[] = [];
  const skipped: string[] = [];
  for (const buf of buffers) {
    let ds: Record<string, unknown>;
    let meta: Record<string, unknown> = {};
    try {
      const parsed = dcm.readFile(buf);
      ds = dcm.naturalize(parsed.dict);
      meta = dcm.naturalize(parsed.meta);
    } catch (e) { skipped.push(`unreadable (${(e as Error).message.slice(0, 60)})`); continue; }
    const r = pictureFromDataset(ds, String(meta.TransferSyntaxUID ?? ""));
    if (typeof r === "string") skipped.push(r); else pictures.push(r);
  }
  pictures.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
  return { pictures, skipped };
}

/** The pure part: a naturalized dataset to RGBA, or the reason it is not a picture this reads. */
export function pictureFromDataset(ds: Record<string, unknown>, transferSyntax = ""): Picture | string {
  let pd = ds.PixelData as ArrayBuffer | ArrayBuffer[] | undefined;
  if (Array.isArray(pd)) pd = pd[0];
  if (!pd) return "no pixel data (not an image object)";
  const width = num(ds.Columns), height = num(ds.Rows);
  const samples = num(ds.SamplesPerPixel, 1);
  const bits = num(ds.BitsAllocated, 8);
  if (bits !== 8) return `${bits}-bit samples (only 8-bit pictures are read)`;
  if (samples !== 1 && samples !== 3) return `${samples} samples per pixel`;
  const expected = width * height * samples;
  if (pd.byteLength < expected) {
    return transferSyntax && transferSyntax !== "1.2.840.10008.1.2" && transferSyntax !== "1.2.840.10008.1.2.1"
      ? `compressed pixel data this application cannot decode (transfer syntax ${transferSyntax})`
      : "pixel data shorter than the image it declares";
  }
  const src = new Uint8Array(pd, 0, expected);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const n = width * height;
  const planar = num(ds.PlanarConfiguration, 0) === 1;
  const inverted = String(ds.PhotometricInterpretation ?? "") === "MONOCHROME1";
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number;
    if (samples === 1) { r = g = b = inverted ? 255 - src[i] : src[i]; }
    else if (planar) { r = src[i]; g = src[n + i]; b = src[2 * n + i]; }
    else { r = src[3 * i]; g = src[3 * i + 1]; b = src[3 * i + 2]; }
    rgba[4 * i] = r; rgba[4 * i + 1] = g; rgba[4 * i + 2] = b; rgba[4 * i + 3] = 255;
  }
  const imageType = Array.isArray(ds.ImageType) ? (ds.ImageType as unknown[]).map(String) : typeof ds.ImageType === "string" ? ds.ImageType.split("\\") : undefined;
  return {
    width, height, rgba,
    instanceNumber: ds.InstanceNumber != null ? num(ds.InstanceNumber) : undefined,
    seriesDescription: ds.SeriesDescription as string | undefined,
    seriesInstanceUID: ds.SeriesInstanceUID as string | undefined,
    imageType,
  };
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The series that DOCUMENT a reconstruction: same study, described as "ECG " + its description.
 * That is how a Siemens NAEOTOM names them (an "ECG Cardiac  200ms - 400ms" series beside the reconstruction
 * "Cardiac  200ms - 400ms"); the rule is the description, not the series number, because the numbers
 * only happen to line up. Nothing found is the ordinary case for every other series.
 */
export function documentSeriesFor(entry: Pick<DbSeriesEntry, "seriesInstanceUID" | "studyInstanceUID" | "description">, all: DbSeriesEntry[]): DbSeriesEntry[] {
  const own = norm(entry.description);
  if (!own || !entry.studyInstanceUID) return [];
  return all.filter((e) =>
    e.seriesInstanceUID !== entry.seriesInstanceUID &&
    e.studyInstanceUID === entry.studyInstanceUID &&
    /^ecg\b/.test(norm(e.description)) &&
    norm(e.description).replace(/^ecg\s*/, "") === own
  );
}
