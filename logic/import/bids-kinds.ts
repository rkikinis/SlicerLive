// KINDS OF BIDS DATA AN EXTENSION IMPORTS -- a hook of the BIDS import (bids.ts). Core builds the anatomical series and
// the label masks; an extension registers a kind for its own folder of a BIDS session (diffusion: `dwi/`), and the
// import hands it the session and the study it belongs to. Contents/docs/EXTENSIONS.md in the workspace.
import type { BuiltObject } from "./bids.ts";

/** What a kind is given: where the session is, the study its objects join, and the import's own helpers. */
export interface BidsKindContext {
  /** The session folder (sub-X[/ses-Y]). */
  dir: string;
  /** The file names in one folder of the session, sorted (none when the folder is absent). */
  files(folder: string): Promise<string[]>;
  readText(path: string): Promise<string | undefined>;
  /** The study every object of the session joins (same patient, study and frame of reference). */
  study: {
    patientName: string; patientID: string; studyInstanceUID: string; frameOfReferenceUID: string; studyDescription: string;
    comments: string; extra: Record<string, unknown>; studyDate: string; studyTime: string;
    /** For the index row of the study's first object (desktop/db-index.ts IndexMeta.newStudy). */
    newStudy: unknown;
  };
  /** A UID derived from the dataset, subject, session and these parts: the same on every run with the same code. */
  uid(...parts: string[]): Promise<string>;
  nextSeriesNumber(): number;
  /** Fields of a BIDS sidecar not to keep in an object: who and where, not how the scan was made. */
  sidecarLeftOut: string[];
  /** The caller's options, as given (a kind reads its own). */
  options: Record<string, unknown>;
  skip(file: string, why: string): void;
  say(msg: string): void;
}

export interface BidsKind {
  /** For the record ("diffusion"). */
  name: string;
  /** The session folders this kind reads ("dwi"): a folder no kind reads is named in the import's "skipped". */
  folders: string[];
  /** Checked before anything is built; throws with a sentence a person can act on. */
  check?(ctx: BidsKindContext): Promise<void>;
  /** The objects of this kind in the session, in order. */
  build(ctx: BidsKindContext): Promise<BuiltObject[]>;
}

const KEY = "__albulaBidsKinds";
const list = (): BidsKind[] => ((globalThis as Record<string, unknown>)[KEY] ??= []) as BidsKind[];
/** An extension registers its kind; the same name again replaces it. */
export function registerBidsKind(k: BidsKind): void {
  const l = list(), at = l.findIndex((x) => x.name === k.name);
  if (at >= 0) l[at] = k; else l.push(k);
}
export const bidsKinds = (): readonly BidsKind[] => list();
