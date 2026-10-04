// THE ALBULA SDK -- the one door from an extension into core (Contents/docs/EXTENSIONS.md in the workspace; Ron,
// 2026-09-30: "We need a scalable architecture. There will be more extensions."). An extension imports `albula` (this
// file; a name in core's deno.jsonc and an alias in the rebuild) and nothing else of core. Core never imports an
// extension (sdk/boundary.test.ts). What an extension may use is listed here -- functions, and the objects a module is
// handed (ModuleContext: the shell, the scene, the store, the device) with their types -- so a change in core that
// would break an extension shows HERE, and SDK_VERSION says which surface an extension was written against.
//
// Version 1 (2026-09-30): what the diffusion extension uses -- the template for the ones after it.
// Version 2 (2026-10-01, critic finding 4): the scene's and the shell's types, the DICOM files of a series, starting
// placement, and an extension's own files by name -- what the module had reached through globals or by convention.
// Version 3 (2026-10-01): the Diffusion module's checklist face -- open the database, open Load / Save, make a
// segmentation and its segments, paint into one, grow an outline, save it to DICOM, a button that says what it did.
// Version 4 (2026-10-01, evening): rows in the data probe (registerProbeRows) and the Segmentations module's Show / Hide
// all decision (showHideAllState), and what an extension draws opaque in 3D for the 3D probe (registerRayHits). Each
// version only adds; an extension written for an earlier one still builds.

export const SDK_VERSION = 5;

// ── joining the app ──────────────────────────────────────────────────────────────────────────────────────────────
/** A module (a panel in the module menu): registered when the app is ready, with the shell, scene, store and device. */
export { queueModule, type ModuleContext } from "../render/demos/extension-modules.ts";
/** The URL of a file shipped beside the bundle (an extension's assets land in vendor/<extension>/), stamped with the build. */
export { workerUrl } from "../render/build-id.ts";
import { workerUrl } from "../render/build-id.ts";
/** A file an extension ships (its manifest's "assets": group/file), as the rebuild places it: vendor/<extension>/<group>/. */
export const assetUrl = (extension: string, path: string): URL => workerUrl(`./vendor/${extension}/${path}`);
/** The objects a module is handed, by type (what ModuleContext's `shell` and `live` are). */
export type { AppShell } from "../render/demos/app-shell.ts";
export type { LiveScene } from "../render/livescene.ts";

/** The DICOM files of a series in the open database, as the app read them (null: the series is not from the database). */
export async function seriesDicomFiles(seriesInstanceUID: string): Promise<ArrayBuffer[] | null> {
  const g = globalThis as unknown as { __dicomSourceInstances?: (uid: string) => Promise<ArrayBuffer[] | null> };
  return g.__dicomSourceInstances ? await g.__dicomSourceInstances(seriesInstanceUID) : null;
}
/** Start placing a markup in the views, as the Markups module does (false: placement is not available in this app). */
export function startPlacing(markupType: "fiducial" | string, persistent = false): boolean {
  const g = globalThis as unknown as { __startPlace?: (type: string, persistent: boolean) => void };
  if (!g.__startPlace) return false;
  g.__startPlace(markupType, persistent);
  return true;
}

// ── getting a patient's scans in, and outlining on them (SDK 3, 2026-10-01: the Diffusion module's checklist) ──────────
/** Open the DICOM database window (the default database), as Load / Save's "DICOM database…" does. False: not in this app. */
export function openDicomDatabase(): boolean {
  const g = globalThis as unknown as { __openDicomDatabase?: () => void };
  if (!g.__openDicomDatabase) return false;
  g.__openDicomDatabase();
  return true;
}
/** Show Load / Save at "From disk" (files, a folder, a drop; "Also add to" a database). False: not in this app. */
export function openLoadFromDisk(): boolean {
  const g = globalThis as unknown as { __openLoadFromDisk?: () => void };
  if (!g.__openLoadFromDisk) return false;
  g.__openLoadFromDisk();
  return true;
}
export { addSegment, createSegmentation, growIntoSegmentation } from "../logic/segmentation-editor.ts";
/**
 * Save a segmentation into the DICOM database under the series it was drawn on -- what AI Segmentations' "Save to
 * DICOM" does (Ron, 2026-10-01: the tumor outline is saved with "same behavior and appearance as with the haversack
 * functionality"). Rejects, in words, when it was not saved.
 */
export async function saveSegmentationToDicom(segId: string): Promise<string> {
  const g = globalThis as unknown as { __exportSegAsDicom?: (id: string) => Promise<{ filename: string; note?: string; indexed?: boolean }> };
  if (!g.__exportSegAsDicom) throw new Error("saving to the DICOM database is not available in this app");
  const r = await g.__exportSegAsDicom(segId);
  const note = r.note ?? r.filename;
  if (r.indexed === false || /NOT indexed|NOT saved|browser's downloads/i.test(note)) throw new Error(note);
  return note;
}
/** A button that says what is happening to it: busy, done, failed (core's, as every module's buttons do). */
export { runAction } from "../render/demos/app-shell.ts";
// Hold the 3D views' drawing while heavy card work runs (2026-10-03: macOS's watchdog, tracking beside the solid anatomy).
export { drawingHeld, holdDrawing } from "../render/demos/accum-loop.ts";
/** The Show / Hide all button's decision, as the Segmentations module makes it (one rule, one wording, tested in core). */
export { showHideAllState } from "../render/demos/segmentations-panel.ts";
/** Rows for the data probe about a point (patient RAS): an extension's objects under the pointer. */
export { registerProbeRows, registerRayHits, type ProbeExtraRow, type RayHitProvider } from "../render/demos/probe-extras.ts";
/** Paint with the brush in the slice views, into one segment of a segmentation (null: brush off). */
export function paintInto(segId: string, segment: number | null, diameterMm = 5): boolean {
  const g = globalThis as unknown as { __setSegTool?: (segId: string, tool: string, p: { diameterMm?: number; sphere?: boolean; segment?: number }) => void };
  if (!g.__setSegTool) return false;
  g.__setSegTool(segId, segment === null ? "" : "paint", segment === null ? {} : { diameterMm, sphere: false, segment });
  return true;
}

// ── reading data: hooks an extension registers into ──────────────────────────────────────────────────────────────
/** DICOM: what separates one volume of a series from the next (the diffusion b-value and direction, ...). */
export { registerVolumeInterpreter, type KeyedImage, type VolumeInterpreter, type VolumeKey } from "../logic/readers/volume-interpreters.ts";
/** BIDS: a kind of data in a session folder (dwi/, ...), imported into DICOM objects. */
export { registerBidsKind, type BidsKind, type BidsKindContext } from "../logic/import/bids-kinds.ts";
export type { BuiltObject } from "../logic/import/bids.ts";

// ── reading data: readers and their pieces ───────────────────────────────────────────────────────────────────────
export { parseNiftiVolumes, type Volume } from "../logic/readers/nifti.ts";
export { decode as nrrdDecode, geometry as nrrdGeometry, parseVectors as nrrdVectors, sampleReader as nrrdSampleReader, spaceFlip as nrrdSpaceFlip, splitHeader as nrrdSplitHeader, TYPE_BYTES as NRRD_TYPE_BYTES } from "../render/nrrd.ts";
/** Vendors' private DICOM elements: where one sits, its numbers, the Siemens CSA header. */
export { at as privateAt, bytesOf, num as dicomNumber, parseCsa, privateNumbers, privateTag, type Raw as DicomJsonRaw } from "../logic/readers/private-tags.ts";
export { siemensMosaic, mosaicTile, type Mosaic } from "../logic/readers/siemens-mosaic.ts";
/** DICOM files to images, grouped into series and volumes (the same reader the app uses). */
export { groupSeries, parseInstances, volumesOfSeries } from "../logic/readers/dicom-series.ts";
/** The one DICOM library (dcmjs), behind the app's own wrapper. */
export { dicomIO } from "../logic/dicom-io.ts";

// ── the scene ────────────────────────────────────────────────────────────────────────────────────────────────────
export type { MrsonNode } from "../render/mrson.ts";
export { loadVolumeIntoScene, removeVolumeFromScene } from "../logic/ingest.ts";
export { IDENTITY4, worldForNode } from "../logic/transforms.ts";
export { browserFrames, sequenceBrowsers } from "../logic/sequences.ts";
export { fetchZarrVolumeNative, type ZarrDesc } from "../render/zarr.ts";

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Streamlines as tubes or lines in the 3D view (Steve's FiberField). */
export { FiberField, type RGBA, type Strand } from "../render/fiber-field.ts";
/** A color per voxel, packed for a color volume (Color FA). */
export { packRGB24 } from "../render/fields.ts";
