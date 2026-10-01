// What names a duckn working copy and decides whether it is still valid: shared by the converter
// (desktop/duckn-copy.ts) and the route that hands copies to the page (desktop/db-serve.ts), which
// must not pull the converter -- and dcmjs with it -- into every request.
import { COPY_SOURCE_CODE } from "./duckn-copy-code.generated.ts";

/** Where the copies live, inside the database folder: `<database>/SlicerAlbula-Zarr/<uid>.zarr/`. */
export const COPY_FOLDER = "SlicerAlbula-Zarr";
/**
 * WHICH CONVERTER WROTE A COPY: the copy's layout version and a fingerprint of every source the
 * converter imports (desktop/make-copy-code.ts, run by the rebuild). A copy written by any other code
 * is not used. The layout version moves by hand when what a copy contains changes shape; the
 * fingerprint moves by itself whenever the reader, the codecs, dcmjs or the converter change.
 */
export const COPY_CODE = `albula-duckn-3-${COPY_SOURCE_CODE}`;   // 3 since 2026-09-25: notHeld

/** The group's `attributes.albula`, as the converter writes it. */
export interface CopyGroup {
  version: string;
  code: string;
  seriesInstanceUID: string;
  source: { files: number; bytes: number; mtimeMs: number; digest?: string };
  frames: string[];
  labels: string[];
  leftOut: string[];
  /** Since 0.3: the images the copy does not hold, by SOPInstanceUID (and frame number), with the reason. */
  notHeld?: { sopInstanceUID?: string; frameNumber?: number; frames?: number; why: string }[];
  instances: number;
  writtenAt: string;
  /** The volume interpreters that read the series (by name: their code fingerprints; volume-interpreters.ts). A page
   *  with other interpreters (another version of an extension, or one more or fewer) reads the DICOM instead. */
  interpreters?: Record<string, string>;
}
