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
// Version 5 (2026-10-03): holdDrawing / drawingHeld (the 3D view waits while an extension's long GPU work runs).
// Version 6 (2026-10-04): synthstripBrainMask -- the brain on an MRI of the anatomy, from SynthStrip on the haversack
// server (the diffusion extension's tracking rule 3) -- and startSegmentationServer, the AI panel's start, for a module
// that needs the server.
// Version 7 (2026-10-05): rgbToDicomLab -- a display color in DICOM's CIELab, as the SEG writer stores it (the diffusion
// extension's Tractography Results writer).
// Version 8 (2026-10-05): `albula/server` (sdk/server.ts), the door for a program beside the server -- an extension's
// import-time job: the database index read-only, a series' files, the DICOM library to inject, the NRRD writer.
// Version 9 (2026-10-06): the open database for a module that lists cases itself (the diffusion extension's Tract
// review) -- databaseSeries (its series and provenance edges), loadDatabaseSeries (as the browser's Load does),
// databaseFileUrl (a file in its folder, e.g. the import job's cached Color FA) and writeDatabaseFile (a module's own
// small file, e.g. the review's verdicts); restartSegmentationServer, for a server stuck with queued jobs (reason "stuck"); and the views for a module that sets
// them up itself -- setLayout (LAYOUT), orientView, setSliceOffset / sliceOffset, lookFrom3D, closeScene, sliceOrientation.
// Version 10 (2026-10-06): a module that has the person draw a line and takes it (the Tract review's crus border) --
// placingMarkupId (the markup being placed, while placement lasts) and endPlacing.
// Version 11 (2026-10-06): setSlicePlane -- a slice view on any plane (its sliceToRAS), for a module that shows the head
// in its own frame rather than the scanner's (the Tract review).

export const SDK_VERSION = 21;   // 21 (2026-10-26, Ron: "fix"): the BIDS import's frameOf / frameRule -- each series of a
// BIDS session its own frame of reference (logic/import/bids.ts FRAME_RULE), so a kind no longer stamps the session's one.
// 20 (2026-10-21, the critic's round): onAskedDerived (a set asked for a scan already on
// screen reaches the module) and forgetAskedDerivedFor (an ask lasts while its scan is in the scene).
// 19 (2026-10-21): askDerived / askedDerived (logic/asked-derived.ts) -- the tract set ticked in the
// DICOM browser (or recorded in a scene) for a scan, so the module shows that one and not the newest (Ron: "when I loaded the tracts it did not
// load its parent"; the browser now brings the scan too).
// 18 (2026-10-21, Ron: "yes, build the scene state for extensions"): registerSceneState --
// an extension's own state in a saved scene, under its name and version (logic/scene/extensions.ts); a window without
// the extension carries the block unchanged.
// 17 (2026-10-20, the critic's round on the after-load rules): loadDatabaseSeries takes
// `{ afterLoad: false }` for a module's load for its own purpose (finding 14); and a module's database calls for a scan
// in the scene find that scan's own database, not only the one this window has open now (finding 10) -- no call changes.
// 16 (2026-10-19): registerAfterLoad and MAJOR_TRACTS -- an extension's say in what the 3D
// view shows after a load (render/after-load.ts), and the major tracts of the rules' version.
// 15 (2026-10-17): startWork -- the app's one working banner (render/working.ts), shared with
// every module: stacked with the others, the same line once, Stop, a measured time. viewBanner stays for a module's own
// strip (a prompt with its own buttons).
// 14 (2026-10-16): viewBanner and pickRectangle -- what is going on, shown across the 3D view; a rectangle drawn in a view
// 12 (2026-10-14): openDatabaseId exported (the import-time jobs, which database is open)

/** Work past a few seconds, said on the 3D view (render/working.ts): what, how far, Stop, the usual time when measured. */
export { startWork, type Work, type WorkOptions } from "../render/working.ts";
/** What the 3D view shows after a load (render/after-load.ts): a handler that shows the load returns true. */
export { AFTER_LOAD_VERSION, MAJOR_TRACTS, registerAfterLoad, type AfterLoadHandler, type Loaded } from "../render/after-load.ts";
export { registerSceneState, type RestoredExtension, type SceneStateHandler } from "../logic/scene/extensions.ts";
export { askDerived, askedDerived, forgetAskedDerivedFor, onAskedDerived } from "../logic/asked-derived.ts";

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

/** The Load / Save panel's database handles exist once it is mounted; mounted here, unseen, when a module asks first. */
async function databaseHandles(): Promise<void> {
  const g = globalThis as unknown as { __dicomSourceInstances?: unknown; __shell?: { mountPanel?: (id: string) => Promise<void> } };
  if (!g.__dicomSourceInstances) await g.__shell?.mountPanel?.("add-data");
}
/** The DICOM files of a series in the open database, as the app read them (null: the series is not from the database). */
export async function seriesDicomFiles(seriesInstanceUID: string): Promise<ArrayBuffer[] | null> {
  await databaseHandles();
  const g = globalThis as unknown as { __dicomSourceInstances?: (uid: string) => Promise<ArrayBuffer[] | null> };
  return g.__dicomSourceInstances ? await g.__dicomSourceInstances(seriesInstanceUID) : null;
}
/** A series of the open database, as its index knows it (SDK 9). */
export interface DatabaseSeries { seriesInstanceUID: string; studyInstanceUID?: string; patientName?: string; patientID?: string; studyDescription?: string; studyDate?: string; seriesNumber?: number; seriesDate?: string; seriesTime?: string; modality?: string; description?: string; count: number }
/** SDK 9: the open database's series and how they derive from each other (kind "tracts", "surface", "algorithm", …);
 *  null when no database is served. For a module that lists cases itself. SDK 17: with them, those of every database a
 *  scan in the scene came from, so what a module asks about a loaded scan is there after a switch of databases. */
export async function databaseSeries(opts: { /** Read the index again (a list made while an import job writes). */ fresh?: boolean } = {}): Promise<{ series: DatabaseSeries[]; edges: { child: string; parent: string; kind: string }[] } | null> {
  await databaseHandles();
  const g = globalThis as unknown as { __databaseSeries?: (o: { fresh?: boolean }) => Promise<{ series: DatabaseSeries[]; edges: { child: string; parent: string; kind: string }[] } | null> };
  return g.__databaseSeries ? await g.__databaseSeries(opts) : null;
}
/** The registered database this window has open: a module's files are read and written beside THAT one, not the
 *  machine-wide current one, which another window may switch (critic 2026-10-06, finding 7). */
export async function openDatabaseId(): Promise<string | null> {
  await databaseHandles();
  const g = globalThis as unknown as { __openDatabaseId?: () => Promise<string | null> };
  return g.__openDatabaseId ? await g.__openDatabaseId() : null;
}
/** WHERE A MODULE'S FILE IS (SDK 17; critic 2026-10-20, finding 10): named after a series of a scan the scene holds from
 *  another database, that database -- a diffusion case keeps finding its maps after the person switched databases;
 *  otherwise the one this window has open. */
async function databaseIdFor(path: string): Promise<string | null> {
  await databaseHandles();
  const g = globalThis as unknown as { __databaseIdFor?: (p: string) => Promise<string | null> };
  return g.__databaseIdFor ? await g.__databaseIdFor(path) : await openDatabaseId();
}
/** SDK 9: load series of the open database into the scene, as the DICOM browser's Load does -- and, as it does, what the
 *  3D view shows after a load (render/after-load.ts). SDK 17: `{ afterLoad: false }` leaves the views as they are, for a
 *  module that loads a scan for its own purpose and sets the views up itself (the Tract review's T1). */
export async function loadDatabaseSeries(seriesInstanceUIDs: string[], onProgress?: (line: string) => void, opts: { afterLoad?: boolean } = {}): Promise<{ loaded: number; failures: string[] }> {
  await databaseHandles();
  const g = globalThis as unknown as { __loadDatabaseSeries?: (u: string[], p?: (l: string) => void, o?: { afterLoad?: boolean }) => Promise<{ loaded: number; failures: string[] }> };
  return g.__loadDatabaseSeries ? await g.__loadDatabaseSeries(seriesInstanceUIDs, onProgress, opts) : { loaded: 0, failures: ["loading from the database is not available in this app"] };
}
/** SDK 9: the view layout, by its id in logic/layouts.ts (16 Conventional Widescreen, 2 Conventional, 3 Four-Up, …). */
export const LAYOUT = { conventional: 2, fourUp: 3, conventionalWidescreen: 16 } as const;
export function setLayout(id: number): boolean {
  const g = globalThis as unknown as { __setLayout?: (id: number) => void };
  if (!g.__setLayout) return false;
  g.__setLayout(id);
  return true;
}
/** SDK 9: a slice view ("Red", "Yellow", "Green") turned to an orientation, as its own orientation menu does. */
export function orientView(cell: string, orientation: "axial" | "coronal" | "sagittal"): boolean {
  const g = globalThis as unknown as { __reformatCell?: (c: string, o: string) => void };
  if (!g.__reformatCell) return false;
  g.__reformatCell(cell, orientation);
  return true;
}
/** SDK 11: put a slice view on any plane -- `sliceToRAS` (16 numbers, row-major) has the slice's x axis, y axis and
 *  normal as columns and its origin last, as the views' own nodes hold it; `label` is shown as its orientation. */
export function setSlicePlane(cell: string, sliceToRAS: number[], label: string): boolean {
  const g = globalThis as unknown as { __setSlicePlane?: (c: string, m: number[], l: string) => boolean };
  return g.__setSlicePlane ? g.__setSlicePlane(cell, sliceToRAS, label) : false;
}
/** SDK 9: a slice view's position along its normal (mm), set and read, as its slider does. */
export function setSliceOffset(cell: string, mm: number): boolean {
  const g = globalThis as unknown as { __setSliceOffset?: (c: string, mm: number) => void };
  if (!g.__setSliceOffset) return false;
  g.__setSliceOffset(cell, mm);
  return true;
}
/** SDK 9: a slice view's orientation now ("Axial", "Coronal", "Sagittal", or "Reformat"), undefined when there is no such view. */
export function sliceOrientation(cell: string): string | undefined {
  const g = globalThis as unknown as { __sliceNode?: (c: string) => { orientation?: string } | null };
  const o = g.__sliceNode?.(cell)?.orientation;
  return typeof o === "string" ? o : undefined;
}
export function sliceOffset(cell: string): number | undefined {
  const g = globalThis as unknown as { __sliceNode?: (c: string) => { offset?: number } | null };
  const o = g.__sliceNode?.(cell)?.offset;
  return typeof o === "number" ? o : undefined;
}
/** SDK 9: the 3D view seen from a side ("A" the front, "P", "L", "R", "S", "I"), keeping its distance -- the 3D view's own buttons. */
export function lookFrom3D(side: "A" | "P" | "L" | "R" | "S" | "I"): boolean {
  const g = globalThis as unknown as { __views?: { resetCamera3D?: (s: string) => void } };
  if (!g.__views?.resetCamera3D) return false;
  g.__views.resetCamera3D(side);
  return true;
}
/** SDK 9: close the scene, as File › Close Scene does (it asks first when something is not saved); false when kept. */
export async function closeScene(): Promise<boolean> {
  const g = globalThis as unknown as { __closeScene?: () => Promise<boolean> };
  return g.__closeScene ? await g.__closeScene() : false;
}
/** SDK 9: write a small file of a module's own (a review's verdicts, as JSON) into the open database's folder, where the
 *  server puts what Albula writes (SlicerAlbula-SEG/); not indexed (not DICOM). Its address back, for databaseFileUrl. */
export async function writeDatabaseFile(name: string, body: string | Uint8Array): Promise<{ ok: boolean; relativePath?: string; why?: string }> {
  const id = await databaseIdFor(name);
  if (!id) return { ok: false, why: "no DICOM database is open in this window" };
  const r = await fetch(`/_db/${encodeURIComponent(id)}/_write/${encodeURIComponent(name)}`, { method: "POST", body: body as BodyInit }).catch(() => null);
  if (!r?.ok) return { ok: false, why: `the server did not write it (${r?.status ?? "no answer"})` };
  return { ok: true, relativePath: `SlicerAlbula-SEG/${name.replace(/[^A-Za-z0-9._-]/g, "_")}` };
}
/** The address of a file in the open database's folder, as the server serves it (SDK 9) -- a cache file beside a series.
 *  A file named after a series of a scan loaded from another database is in that one (SDK 17). */
export async function databaseFileUrl(relativePath: string): Promise<string | null> {
  const id = await databaseIdFor(relativePath);
  return id ? `/_db/${encodeURIComponent(id)}/${relativePath.split("/").map(encodeURIComponent).join("/")}` : null;
}
/** Start placing a markup in the views, as the Markups module does (false: placement is not available in this app). */
/** SDK 12: a text file (a table) at the top of Downloads, where Albula's pictures go (desktop/pictures.ts): a plain name
 *  ending ".csv"; the answer gives its path. `showInDownloads(name)` opens the Finder on it. */
export async function saveToDownloads(name: string, text: string): Promise<{ ok: boolean; path?: string; why?: string }> {
  const r = await fetch(`/_picture/${encodeURIComponent(name)}`, { method: "POST", body: text }).catch(() => null);
  if (!r?.ok) return { ok: false, why: r ? ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the server said ${r.status}` : "no server" };
  return { ok: true, path: ((await r.json()) as { path?: string }).path };
}
export function showInDownloads(name: string): void { void fetch(`/_picture/${encodeURIComponent(name)}?reveal=1`).catch(() => {}); }
/** SDK 12: the module template's names and row actions (render/demos/row-actions.ts; PALETTE.md "Names and row actions"). */
export { addRowMenu, makeNameEditable, startEditing, type RowAction } from "../render/demos/row-actions.ts";
/** SDK 13: a list in a module as tall as its rows and the column allow, with a grip to drag (MODULE-DESIGN-RULES.md). */
export { fitList } from "../render/demos/fit-list.ts";

/** SDK 14: a banner across the top of the 3D view -- a title, a progress bar (0..1; null: under way, no fraction),
 *  a hint and buttons -- for work the person is waiting on, or a mode they are in. Update it as the work goes; close it
 *  when done. Null outside the application. */
export interface ViewBannerOpts { title: string; hint?: string; progress?: number | null; actions?: { label: string; primary?: boolean; title?: string; onClick: () => void }[] }
export function viewBanner(opts: ViewBannerOpts): { update(o: Partial<ViewBannerOpts>): void; close(): void } | null {
  const g = globalThis as unknown as { __viewBanner?: (o: ViewBannerOpts) => { update(o: Partial<ViewBannerOpts>): void; close(): void } };
  return g.__viewBanner ? g.__viewBanner(opts) : null;
}
/** SDK 14: the person drags ONE rectangle in the 3D view or a slice view (Escape, or `signal` aborted: null).
 *  `inside(ras)`: a point lies in it as that view shows it (in a slice view, within the slice's slab);
 *  `insideSegment(a, b)`: a line's piece is in it -- in a slice view, where the piece CROSSES the plane (the dot drawn).
 *  `onDrag` is told what the rectangle being dragged would hold, for a preview (null: not a rectangle). Not the 3D view
 *  while the glasses show it. */
export interface PickedRectangle { view: string; inside: (ras: number[]) => boolean; insideSegment: (a: number[], b: number[]) => boolean }
export function pickRectangle(opts: { signal?: AbortSignal; onDrag?: (p: PickedRectangle | null) => void } = {}): Promise<PickedRectangle | null> {
  const g = globalThis as unknown as { __pickRectangle?: (o: typeof opts) => Promise<PickedRectangle | null> };
  return g.__pickRectangle ? g.__pickRectangle(opts) : Promise.resolve(null);
}

export function startPlacing(markupType: "fiducial" | string, persistent = false): boolean {
  const g = globalThis as unknown as { __startPlace?: (type: string, persistent: boolean) => void };
  if (!g.__startPlace) return false;
  g.__startPlace(markupType, persistent);
  return true;
}

/** The markup being placed right now (its node id), or undefined when nothing is being placed (SDK 10). */
export function placingMarkupId(): string | undefined {
  const g = globalThis as unknown as { __placeState?: () => { mode?: string; placeNodeId?: string } | null };
  const s = g.__placeState?.();
  return s?.mode === "place" && s.placeNodeId ? s.placeNodeId : undefined;
}
/** End placing, as Escape or the Markups module's Done does (SDK 10). */
export function endPlacing(): void {
  (globalThis as unknown as { __endPlace?: () => void }).__endPlace?.();
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
/** SDK 6: the brain on an MRI of the anatomy (SynthStrip, through the haversack server), on that volume's own grid. */
export { restartSegmentationServer, startSegmentationServer, synthstripBrainMask, type BrainMask, type BrainMaskResult } from "../logic/brain-mask.ts";
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
/** SDK 7: RGB (0..1) to the DICOM CIELab triple (0..65535) a display color is stored as. */
export { rgbToDicomLab } from "../logic/export-dicom-seg.ts";

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
