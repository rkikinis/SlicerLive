// THE ONE PLACE ALBULA'S CODE REACHES dcmjs.
//
// Ron, 2026-09-25: keep things "as modular as possible so that in the future we can swap if needed". dcmjs reads and
// writes every DICOM file here, and until 2026-09-28 fourteen of our files called it directly (critic,
// qa/2026-09-28-dependencies.md, finding 6; Ron: "yes"). Now every reader and writer asks this module for a DicomIO
// and uses its functions; `logic/dicom-io.test.ts` fails when any other file reaches into dcmjs. Swapping dcmjs
// means reimplementing what is below, nothing else.
//
// Where the library comes from: in the page, the vendored copy (logic/dcmjs-version.ts, dcmjsUrl), loaded once with a
// script tag; in a worker or under Deno, whatever was injected with setDicomLibrary (the SEG-decode worker fetches the
// same vendored file; the tests and the copy converter inject the same commit's ESM build through logic/dcmjs.ts).
//
// No import of dcmjs itself here: this file goes into the page's bundle.
import { dcmjsUrl } from "./dcmjs-version.ts";
import { dicomLabToRgb as labToRgbV1 } from "./dicom-lab.ts";

/** A dataset in DICOM JSON form, keyed by tag ("00100010"), as dcmjs reads and writes it. */
export type DicomJson = Record<string, { vr: string; Value?: unknown[]; InlineBinary?: string; BulkDataURI?: string }>;
/** A "naturalized" dataset: keywords as keys (PatientName), sequences as arrays of datasets. */
export type Dataset = Record<string, unknown>;

/** A parsed Part-10 file: the dataset and its file meta information. */
export interface ParsedFile { dict: DicomJson; meta: DicomJson }
/** A dataset ready to be written as a Part-10 file. `dict` and `meta` may be edited before `write()`. */
export interface WritableFile { dict: DicomJson; meta: DicomJson; write(): ArrayBuffer }

/**
 * dcmjs's segmentation builder (derivations.Segmentation), which export-dicom-seg.ts drives. The two underscore
 * methods are dcmjs internals the writer uses to pack pixels as it goes; it checks for them and falls back to the
 * public path when absent. The one part of dcmjs that is more than reading and writing: replacing dcmjs means
 * replacing this builder too.
 */
export interface SegmentationBuilder {
  dataset: Dataset & { NumberOfFrames?: number; PixelData?: ArrayBuffer[] | ArrayBuffer; PerFrameFunctionalGroupsSequence?: unknown[] };
  isBitpacked?: boolean;
  setNumberOfFrames(n: number): void;
  addSegment(meta: Dataset, pixelData: Uint8Array, referencedFrameNumbers: number[]): void;
  bitPackPixelData(): void;
  _addSegmentMetadata?(meta: Dataset): number;
  _addPerFrameFunctionalGroups?(segmentNumber: number, referencedFrameNumbers: number[]): void;
}

/** Everything Albula does with a DICOM library. */
export interface DicomIO {
  /** Parse a Part-10 file. */
  readFile(bytes: ArrayBuffer): ParsedFile;
  /** DICOM JSON -> keywords. */
  naturalize(dict: unknown): Dataset;
  /** Keywords -> DICOM JSON. */
  denaturalize(ds: Dataset): DicomJson;
  /** File meta information with keyword names (dcmjs's namifyDataset). */
  namify(dict: unknown): Dataset;
  /** A new UID (2.25 form). */
  newUid(): string;
  /** A writable file from a naturalized dataset (its `_meta` becomes the file meta). */
  toFile(ds: Dataset): WritableFile;
  /** A writable file from file meta information alone; set `dict` before writing. */
  fileWithMeta(meta: DicomJson): WritableFile;
  /** DICOM's CIELab (0-65535) to RGB (0-1). */
  dicomLabToRgb(lab: number[]): number[];
  /** Single-frame instances of one series -> one multiframe dataset (for the SEG builder). */
  toMultiframe(datasets: Dataset[]): Dataset;
  /** A segmentation builder over a multiframe source. */
  segmentationBuilder(multiframe: Dataset): SegmentationBuilder;
}

// dcmjs's own shape, as far as the functions above use it. Only this file knows it.
interface Dcmjs {
  data: {
    DicomMessage: { readFile(b: ArrayBuffer): { dict: DicomJson; meta: DicomJson } };
    DicomMetaDictionary: {
      naturalizeDataset(d: unknown): Dataset;
      denaturalizeDataset(d: unknown): DicomJson;
      namifyDataset(d: unknown): Dataset;
      uid(): string;
      nameMap: Record<string, { vr?: string }>;
      dictionary: Record<string, { name?: string }>;
      punctuateTag(tag: string): string;
    };
    datasetToDict(ds: Dataset): WritableFile;
    DicomDict: new (meta: DicomJson) => WritableFile;
    Colors: { dicomlab2RGB(lab: number[]): number[] };
  };
  normalizers: { Normalizer: { normalizeToDataset(datasets: Dataset[]): Dataset } };
  derivations: { Segmentation: new (datasets: Dataset[]) => SegmentationBuilder };
}

/**
 * A number as a Decimal String of at most 16 characters (PS3.5 §6.2, DS), the closest one that fits.
 *
 * WHY THIS EXISTS: dcmjs 0.41 turns every number into `String(n)` before writing, then CUTS any DS string longer than 16
 * characters -- so 3.5163338899999997e-10, an orientation component that is zero in all but rounding, was written
 * "3.51633388999999": a unit vector with a z of 3.5. Found by dciodvfy on the first BIDS import (2026-09-28, a T1 whose
 * NIfTI affine carries 1e-10 noise). dcmjs's own DS formatter does this right, but the early String() means it never
 * sees a number. Upstream: https://github.com/dcmjs-org/dcmjs/issues/531 (filed 2026-09-29).
 * STILL NEEDED with Steve Pieper's build (2026-10-28), which has the fix (#610): a top-level number and a sequence given
 * as an array now keep their exponent, but a one-item sequence given as a plain object -- the form dcmjs's own normalizer
 * builds, and so the Enhanced MR and SEG writers' -- is still cut ("3.51633388999999"; logic/dicom-io.test.ts).
 * Remove when a dcmjs we use formats DS numbers in that form too.
 */
export function dsString(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`a DICOM decimal cannot hold ${x}`);
  if (Object.is(x, -0)) return "0";
  const plain = String(x);
  if (plain.length <= 16) return plain;
  for (let p = 16; p >= 1; p--) {
    const t = x.toPrecision(p).replace(/(\.\d*?)0+(e|$)/, "$1$2").replace(/\.(e|$)/, "$1");
    if (t.length <= 16) return t;
  }
  return x.toExponential(0);
}

/** Every DS number in a naturalized dataset (sequences included) as dsString, before dcmjs sees it. A new object. */
function formatDecimals(ds: Dataset, nameMap: Record<string, { vr?: string }>): Dataset {
  const out: Dataset = {};
  for (const [k, v] of Object.entries(ds)) {
    const vr = nameMap[k]?.vr;
    if (vr === "DS") {
      out[k] = typeof v === "number" ? dsString(v) : Array.isArray(v) ? v.map((x) => (typeof x === "number" ? dsString(x) : x)) : v;
    } else if (vr === "SQ" && Array.isArray(v)) {
      out[k] = v.map((item) => (item && typeof item === "object" && !ArrayBuffer.isView(item) ? formatDecimals(item as Dataset, nameMap) : item));
    } else if (vr === "SQ" && v && typeof v === "object" && !ArrayBuffer.isView(v)) {
      // A one-item sequence given as a plain object (dcmjs's normalizer builds these; critic 2026-09-28, finding 7).
      out[k] = formatDecimals(v as Dataset, nameMap);
    } else out[k] = v;
  }
  return out;
}

/**
 * PRIVATE TAGS IN THE ODD REPEATING GROUPS KEEP THEIR NUMBER. Curves (50xx), overlays (60xx) and variable pixel data (7Fxx)
 * are repeating groups, and since dcmjs 0.50 (its packed dictionary) an ODD group in those ranges -- a private one, which
 * the repeating attributes never are -- is given the standard attribute's name: GE's private creator (7FD1,0010)
 * "GEIIS", in every TCGA-UCEC CT here, comes back as RETIRED_VariablePixelData, and is written back as (7F00,0010), an
 * attribute that was never in the file; a vendor's (6001,0010) and a real overlay's (6000,0010) both become OverlayRows,
 * and one value is lost. Found 2026-10-28 on Steve Pieper's build (workspace upstream-issues-dcmjs.md, item 10). So these
 * tags are taken out before dcmjs names the dataset and put back under their number, as 0.41 kept them; a writer drops a
 * numbered key, as before, and Albula's private-attribute rule (logic/private-attributes.ts) works from the raw tags.
 * Remove when dcmjs names only the even groups.
 */
const oddRepeating = (tag: string): boolean => {
  const g = parseInt(tag.slice(0, 4), 16);
  return (g & 1) === 1 && ((g >= 0x5001 && g <= 0x50ff) || (g >= 0x6001 && g <= 0x60ff) || (g >= 0x7f01 && g <= 0x7fff));
};
const holdsOddRepeating = (dict: DicomJson): boolean =>
  Object.entries(dict).some(([tag, el]) => oddRepeating(tag) || (el.vr === "SQ" && Array.isArray(el.Value) && el.Value.some((item) => !!item && typeof item === "object" && holdsOddRepeating(item as DicomJson))));

function naturalizeKeepingOdd(D: Dcmjs["data"]["DicomMetaDictionary"], dict: DicomJson): Dataset {
  if (!holdsOddRepeating(dict)) return D.naturalizeDataset(dict);
  const split = (dj: DicomJson): { clean: DicomJson; put: (nat: Dataset) => void } => {
    const clean: DicomJson = {};
    const kept: [string, unknown][] = [];
    const inner: [string, ((nat: Dataset) => void)[]][] = [];
    for (const [tag, el] of Object.entries(dj)) {
      if (oddRepeating(tag)) { kept.push([tag, el.Value?.length === 1 ? el.Value[0] : el.Value]); continue; }
      if (el.vr === "SQ" && Array.isArray(el.Value)) {
        const parts = el.Value.map((item) => split((item ?? {}) as DicomJson));
        clean[tag] = { ...el, Value: parts.map((p) => p.clean) };
        inner.push([tag, parts.map((p) => p.put)]);
      } else clean[tag] = el;
    }
    return {
      clean,
      put: (nat) => {
        for (const [tag, v] of kept) nat[tag] = v;
        for (const [tag, puts] of inner) {
          const v = nat[D.dictionary[D.punctuateTag(tag)]?.name ?? tag];
          const items = (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []) as Dataset[];
          puts.forEach((put, i) => { if (items[i]) put(items[i]); });
        }
      },
    };
  };
  const { clean, put } = split(dict);
  const nat = D.naturalizeDataset(clean);
  put(nat);
  return nat;
}

/**
 * The same naming, in an Implicit VR file: there the VR comes from the dictionary, so a private creator in one of those odd
 * groups -- GE's (7FD1,0010) -- is read as the standard attribute's OW, not LO (a private creator is LO, PS3.5 §7.8.1;
 * DCMTK's dcm2json says LO; logic/readers/dicom-tags.corpus.test.ts found it, 2026-10-28). Put back as the LO it is.
 * Only the creators: they are text by definition. Remove with naturalizeKeepingOdd.
 */
function creatorsAsText(dict: DicomJson): DicomJson {
  for (const [tag, el] of Object.entries(dict)) {
    if (el.vr === "SQ" && Array.isArray(el.Value)) { for (const item of el.Value) if (item && typeof item === "object") creatorsAsText(item as DicomJson); continue; }
    const element = parseInt(tag.slice(4), 16);
    if (!oddRepeating(tag) || element < 0x10 || element > 0xff || el.vr === "LO") continue;
    const v = el.Value?.[0];
    if (v instanceof ArrayBuffer) dict[tag] = { vr: "LO", Value: [new TextDecoder("latin1").decode(v).replace(/[\0 ]+$/, "")] };
  }
  return dict;
}

function wrap(d: Dcmjs): DicomIO {
  const { DicomMessage, DicomMetaDictionary } = d.data;
  const names = DicomMetaDictionary.nameMap ?? {};
  return {
    readFile: (bytes) => { const f = DicomMessage.readFile(bytes); creatorsAsText(f.dict); return f; },
    naturalize: (dict) => naturalizeKeepingOdd(DicomMetaDictionary, dict as DicomJson),
    denaturalize: (ds) => DicomMetaDictionary.denaturalizeDataset(formatDecimals(ds, names)),
    namify: (dict) => DicomMetaDictionary.namifyDataset(dict),
    newUid: () => DicomMetaDictionary.uid(),
    toFile: (ds) => d.data.datasetToDict(formatDecimals(ds, names)),
    fileWithMeta: (meta) => new d.data.DicomDict(meta),
    dicomLabToRgb: (lab) => labToRgbV1(lab),   // Albula's own, versioned (logic/dicom-lab.ts), not dcmjs's (D50 since #598)
    toMultiframe: (datasets) => d.normalizers.Normalizer.normalizeToDataset(datasets),
    segmentationBuilder: (multiframe) => new d.derivations.Segmentation([multiframe]),
  };
}

/**
 * An explicitly supplied dcmjs, used in place of the script tag.
 *
 * THIS IS WHAT MAKES THE DICOM WRITER TESTABLE. The page's loader reaches for `document`, so every test of the SEG
 * export had to be driven through a browser by hand -- which is exactly why all of them were toys, and why a 2^31
 * overflow that corrupts any export past ~8,000 frames shipped. Under Deno the same library is one import
 * away (logic/dcmjs.ts, the vendored ESM build), so the tests inject it and the whole path runs headless.
 */
let injected: Dcmjs | null = null;
let io: DicomIO | null = null;
let loading: Promise<DicomIO> | null = null;

export function setDicomLibrary(d: unknown): void {
  injected = d as Dcmjs;
  io = wrap(injected);
}

/** The DicomIO: the injected library, or (in the page) the vendored dcmjs loaded once. */
export function dicomIO(): Promise<DicomIO> {
  if (io) return Promise.resolve(io);
  const w = globalThis as unknown as { dcmjs?: Dcmjs; document?: { createElement(t: string): { src: string; onload: () => void; onerror: () => void; remove(): void }; head: { appendChild(e: unknown): void } } };
  if (w.dcmjs) { io = wrap(w.dcmjs); return Promise.resolve(io); }
  if (!w.document) return Promise.reject(new Error("dcmjs is only available in a browser (no document) unless injected with setDicomLibrary"));
  if (!loading) loading = new Promise((resolve, reject) => {
    // The vendored copy beside the bundle; no network (critic, 2026-09-28, finding 1).
    const s = w.document!.createElement("script"); s.src = dcmjsUrl();
    s.onload = () => {
      if (!w.dcmjs) { reject(new Error("dcmjs: the vendored bundle defined no dcmjs")); return; }
      io = wrap(w.dcmjs); resolve(io);
    };
    s.onerror = () => { s.remove(); loading = null; reject(new Error(`dcmjs could not be loaded from ${dcmjsUrl()}`)); };
    w.document!.head.appendChild(s);
  });
  return loading;
}

/** The raw library, for the console hook `__dcmjs` and the browser harness only. Not for application code. */
export async function dicomLibraryForDebugging(): Promise<unknown> {
  await dicomIO();
  return injected ?? (globalThis as unknown as { dcmjs?: unknown }).dcmjs;
}
