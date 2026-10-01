// Notes and color flags on the archive, as DICOM Key Object Selection documents.
//
// "C3N-01524 is not very descriptive. Is there a way to add some notes by me and to have them shown?
// Or some color flags ala mac os?" -- and, on how: "DICOM compliant and as simple as possible."
//
// DICOM already has the object. A KEY OBJECT SELECTION DOCUMENT (KOS) references instances, carries
// a coded DOCUMENT TITLE from a standard list, and a free-text description. That is a flag plus a
// note, so the flags here are not invented colors: they are the standard titles, and the color is
// only how Albula draws them. A note written here is readable by any DICOM system; the color is
// ours alone.
//
// Storage reuses the segmentation path exactly -- the file goes through the app's _write route and
// the rows through _index, with its backup / transaction / audit discipline. Nothing new is invented
// to hold an annotation, which is the "as simple as possible" half.
import { dicomIO } from "./dicom-io.ts";

/** DICOM's own title codes (DCM, context group 7010), each given a color for display. */
export const FLAGS = [
  { id: "interest", code: "113000", meaning: "Of Interest", color: "#f0d24a" },
  { id: "quality", code: "113010", meaning: "Quality Issue", color: "#f05a5a" },
  { id: "teaching", code: "113003", meaning: "For Teaching", color: "#5ad07a" },
  { id: "research", code: "113006", meaning: "For Research", color: "#78aae6" },
  { id: "conference", code: "113004", meaning: "For Conference", color: "#a98be8" },
  { id: "surgery", code: "113005", meaning: "For Surgery", color: "#e0954a" },
] as const;

export type FlagId = typeof FLAGS[number]["id"];
export const flagOf = (id: string) => FLAGS.find((f) => f.id === id);

export interface AnnotationTarget {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  /** One instance of that series. A KOS references instances, not series, so it needs at least one. */
  sopInstanceUID: string;
  sopClassUID?: string;
}

export interface Annotation {
  /** What it is attached to. A patient flag attaches to their earliest study; the browser shows it up. */
  studyInstanceUID: string;
  seriesInstanceUID: string;
  flag?: FlagId;
  note?: string;
  author?: string;
  created?: string;
  /** The KOS instance carrying it, so it can be replaced or removed. */
  sopInstanceUID: string;
}

const KOS_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.88.59";
const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";
const uid = () => `2.25.${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e15)}`;
const dcmDate = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const dcmTime = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export interface KosResult {
  bytes: Uint8Array;
  filename: string;
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
  };
}

/**
 * Build the KOS for one annotation.
 *
 * Deliberately minimal: title, description, and the evidence sequence naming what is being
 * annotated. A KOS may carry a whole content tree; none of it is needed to say "this is of interest,
 * and here is why", and every part not written is a part that cannot be written wrongly.
 */
export async function buildAnnotationKos(
  target: AnnotationTarget,
  opts: { flag?: FlagId; note?: string; author?: string; patientName?: string; patientID?: string },
): Promise<KosResult> {
  const dcm = await dicomIO();
  const flag = opts.flag ? flagOf(opts.flag) : undefined;
  const now = new Date();
  const sop = uid(), series = uid();

  const ds: Record<string, unknown> = {
    // UTF-8, DECLARED. DICOM's default character repertoire is ASCII, so a note containing an
    // em-dash, an accent or a name like "Müller" is corrupted on read unless the object says which
    // encoding it used -- the round-trip test caught "—" coming back as "â€”". ISO_IR 192 is
    // DICOM's name for UTF-8 and is what every modern reader expects.
    SpecificCharacterSet: "ISO_IR 192",
    SOPClassUID: KOS_SOP_CLASS,
    SOPInstanceUID: sop,
    StudyInstanceUID: target.studyInstanceUID,
    SeriesInstanceUID: series,
    Modality: "KO",
    // A high series number keeps annotations at the end of a study's list rather than interleaved
    // with acquisitions.
    SeriesNumber: 9000,
    InstanceNumber: 1,
    SeriesDescription: flag ? `Annotation — ${flag.meaning}` : "Annotation — note",
    ContentDate: dcmDate(now),
    ContentTime: dcmTime(now),
    StudyDate: dcmDate(now),
    ...(opts.patientName ? { PatientName: opts.patientName } : {}),
    ...(opts.patientID ? { PatientID: opts.patientID } : {}),
    ValueType: "CONTAINER",
    ContinuityOfContent: "SEPARATE",
    CompletionFlag: "COMPLETE",
    VerificationFlag: "UNVERIFIED",
    // The TITLE is the flag. Without one the document still needs a title, and "Of Interest" is the
    // honest default for "the user wrote a note about this".
    ConceptNameCodeSequence: {
      CodeValue: flag?.code ?? "113000",
      CodingSchemeDesignator: "DCM",
      CodeMeaning: flag?.meaning ?? "Of Interest",
    },
    ContentTemplateSequence: { MappingResource: "DCMR", TemplateIdentifier: "2010" },
    // WHAT IS BEING ANNOTATED, in DICOM's own terms: study -> series -> instance.
    CurrentRequestedProcedureEvidenceSequence: {
      StudyInstanceUID: target.studyInstanceUID,
      ReferencedSeriesSequence: {
        SeriesInstanceUID: target.seriesInstanceUID,
        ReferencedSOPSequence: {
          ReferencedSOPClassUID: target.sopClassUID || "1.2.840.10008.5.1.4.1.1.2",
          ReferencedSOPInstanceUID: target.sopInstanceUID,
        },
      },
    },
    _meta: {
      MediaStorageSOPClassUID: { Value: [KOS_SOP_CLASS], vr: "UI" },
      MediaStorageSOPInstanceUID: { Value: [sop], vr: "UI" },
      TransferSyntaxUID: { Value: [EXPLICIT_VR_LE], vr: "UI" },
    },
  };

  // The NOTE, as a text content item. Author and time ride along in the dataset's own fields rather
  // than being pushed into the prose, so a reader can show "who and when" without parsing English.
  const content: Record<string, unknown>[] = [];
  if (opts.note) {
    content.push({
      RelationshipType: "CONTAINS",
      ValueType: "TEXT",
      ConceptNameCodeSequence: { CodeValue: "113012", CodingSchemeDesignator: "DCM", CodeMeaning: "Key Object Description" },
      TextValue: opts.note,
    });
  }
  if (content.length) ds.ContentSequence = content.length === 1 ? content[0] : content;
  if (opts.author) ds.ContentCreatorName = opts.author;

  const bytes = new Uint8Array(dcm.toFile(ds).write());
  return {
    bytes,
    filename: `${sop}.dcm`,
    index: {
      sopInstanceUID: sop,
      seriesInstanceUID: series,
      studyInstanceUID: target.studyInstanceUID,
      modality: "KO",
      seriesNumber: 9000,
      seriesDescription: String(ds.SeriesDescription),
      frameOfReferenceUID: "",
      displayedSize: "",
      numberOfFrames: 0,
    },
  };
}

/**
 * Windows-1252's upper half, as code point -> byte.
 *
 * The mis-decode is cp1252, NOT Latin-1, and the difference is what a first attempt at this got
 * wrong: 0x80..0x9F are control codes in Latin-1 but printable characters in cp1252, so a UTF-8
 * em-dash (E2 80 94) arrives as "\u00e2\u20ac\u201d" -- and \u20ac is above 255, which a
 * "every character is a byte" test rejects as not-mojibake. These 27 code points are exactly the
 * ones that cannot be recovered by charCodeAt alone.
 */
const CP1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/**
 * Undo dcmjs's cp1252 reading of UTF-8 text inside a nested sequence item.
 *
 * dcmjs honors SpecificCharacterSet at the TOP level of a dataset but not within a sequence, so a
 * note living in ContentSequence -- which is where DICOM puts it -- comes back with every non-ASCII
 * character expanded into its UTF-8 bytes read as Latin-1: "—" arrives as "â€”". The FILE is
 * correct; only this reader is wrong, so the repair is here rather than in what we write.
 *
 * Applied narrowly. Only when the object declares UTF-8, only when every character is one a single
 * byte could have produced, and only when those bytes are in fact valid UTF-8 -- `fatal` makes
 * ordinary text fail the decode and keep its original form.
 */
export function repairNestedUtf8(text: string, charset: string | undefined): string {
  if (!/ISO_IR 192/i.test(charset ?? "")) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const b = cp < 0x100 ? cp : CP1252_REVERSE.get(cp);
    if (b === undefined) return text;          // a character no single byte produced: not mojibake
    bytes[i] = b;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return text;                               // genuinely Latin-1 text, or nothing we can improve
  }
}

/** Pull the flag, note, author and target back out of a KOS instance. */
export async function readAnnotation(bytes: ArrayBuffer): Promise<Annotation | null> {
  const dcm = await dicomIO();
  let ds: Record<string, unknown>;
  try {
    ds = dcm.naturalize(dcm.readFile(bytes).dict);
  } catch {
    return null;
  }
  if (ds.Modality !== "KO") return null;
  const one = <T,>(v: T | T[] | undefined): T | undefined => Array.isArray(v) ? v[0] : v;
  const title = one(ds.ConceptNameCodeSequence as { CodeValue?: string } | { CodeValue?: string }[]);
  const flag = FLAGS.find((f) => f.code === String(title?.CodeValue ?? ""));
  const ev = one(ds.CurrentRequestedProcedureEvidenceSequence as Record<string, unknown> | Record<string, unknown>[]);
  const refSeries = one(ev?.ReferencedSeriesSequence as Record<string, unknown> | Record<string, unknown>[]);
  const content = ([] as Record<string, unknown>[]).concat((ds.ContentSequence ?? []) as Record<string, unknown>[]);
  const rawText = content.find((c) => c.ValueType === "TEXT")?.TextValue;
  const charset = ds.SpecificCharacterSet ? String(ds.SpecificCharacterSet) : undefined;
  const text = rawText === undefined ? undefined : repairNestedUtf8(String(rawText), charset);

  return {
    studyInstanceUID: String(ev?.StudyInstanceUID ?? ds.StudyInstanceUID ?? ""),
    seriesInstanceUID: String(refSeries?.SeriesInstanceUID ?? ""),
    flag: flag?.id,
    note: text || undefined,
    author: ds.ContentCreatorName ? String(ds.ContentCreatorName) : undefined,
    created: ds.ContentDate ? `${ds.ContentDate}${ds.ContentTime ? " " + String(ds.ContentTime) : ""}` : undefined,
    sopInstanceUID: String(ds.SOPInstanceUID ?? ""),
  };
}
