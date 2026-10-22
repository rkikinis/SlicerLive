// slicer-app — the stock 3D Slicer interface hosted by SlicerLive: the Qt chrome and module panels
// are streamed from a headless ModuleServer/AppServer (region PNGs + synthetic events, WS B), while
// the slice/3D views in the layout area are SlicerLive's own WebGPU views kept in sync over the
// mrson channel + LiveSync (WS A). Query params: ?host=, ?gui=ws://..., ?ws=ws://..., ?http=...,
// ?nativeMenus=1 (host provides menus; hide the streamed menubar).
import { sizeClass, startWork } from "../working.ts";
import { initSceneControl, keyLabel, markSceneClean, SHORTCUTS, sceneControl, sceneDirty, sceneIdentityChanged } from "./scene-control.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { schemeAtStart, setPaletteVersion } from "../../logic/anatomy/palettes.ts";
import { setShadingVersion, shadingVersion } from "../shading-versions.ts";
import { initDevice } from "../device.ts";
import { type AuditResult, auditWords } from "./audit-words.ts";
import { LegacyGui, type Menu } from "../moduleserver/legacy-gui.ts";
import { mountLiveViews } from "../moduleserver/live-views.ts";
import { mountProbeBox } from "./probe-box.ts";
import { keepScroll } from "./panel-scroll.ts";
import { mountSessionUI } from "../moduleserver/session-ui.ts";
import { installIntrospection, type SlicerLiveHook } from "../introspect.ts";
import { expect, registerSelfTest } from "../selftest.ts";
import { type AppShell, mountAppShell } from "./app-shell.ts";
import { cellsFor, DEFAULT_LAYOUT, layoutList, splitBoundary } from "../../logic/layouts.ts";
import { openSettings, type SettingsStore } from "../../logic/settings.ts";
import { registerLoadPanel } from "./load-panel.ts";
import { keepPageAwakeWhileHidden } from "./keep-awake.ts";
import { registerSampleDataPanel } from "./sample-data-panel.ts";
import { SAMPLE_DATA } from "../../logic/sample-data.ts";
import { registerVolumesPanel } from "./volumes-panel.ts";
import { registerTfEditor } from "./tf-editor.ts";
import { registerMarkupsPanel } from "./markups-panel.ts";
import { registerCropPanel } from "./crop-panel.ts";
import { registerSegEditorPanel } from "./seg-editor-panel.ts";
import { registerTransformsPanel } from "./transforms-panel.ts";
import { registerSequencesPanel } from "./sequences-panel.ts";
import { mountJobsLine } from "./jobs-line.ts";
import { mountSequenceToolbar } from "./sequence-toolbar.ts";
import { SequencePlayer } from "../../logic/playback.ts";
import { currentFrames } from "../../logic/sequences.ts";
import { EVERYTHING_3D, renderSavePane } from "./save-panel.ts";
import { registerAiSegPanel } from "./ai-seg-panel.ts";
import { registerQueuedModules } from "./extension-modules.ts";
import { registerSegmentationsPanel } from "./segmentations-panel.ts";
import { exportVolume, exportSegmentation, type ExportFormat } from "../../logic/export.ts";
import { worldMatrix, hardenImageIjkToRAS, hardenPoints, withTranslation, IDENTITY4 } from "../../logic/transforms.ts";
import { createSegmentation, addSegment, applyEffect, computeStats, paintStroke, commitPaint, drawFill, markEdited } from "../../logic/segmentation-editor.ts";
import { LocalBlobStore, loadVolumeIntoScene, setIngestTimers } from "../../logic/ingest.ts";
import { parseNifti } from "../../logic/readers/nifti.ts";
import { type RunProvenance, segmentationToDicomSeg } from "../../logic/export-dicom-seg.ts";
import { sceneSurfaceFile, surfaceFile, type ExportSegment } from "../surface-export.ts";
import { plainFileStem } from "../../logic/writers/surface-files.ts";
import { type ExportSubject, toStoredPixels, volumeToDicomSeries } from "../../logic/export-dicom-image.ts";
import { looksLikeHounsfield } from "../window-level-preset.ts";
import type { MrsonNode } from "../mrson.ts";
import { codesFor } from "../../logic/segment-naming.ts";
import { recallExportDir, rememberExportDir } from "../../logic/export-dir.ts";
import type { LiveScene as LiveSceneT } from "../livescene.ts";
import { setLoadTimers } from "../livescene.ts";
import { fetchZarrVolumeNative } from "../zarr.ts";
import { makeNifti, SYNTHETIC_DIMS } from "../../logic/readers/synthetic.ts";
import type { SegmentCodes } from "../../logic/readers/dicom-seg.ts";
import { openSettingsDialog, pictureDefaults, SETTING_DEFAULTS } from "./settings-dialog.ts";
import { writeScene } from "../../logic/scene/write.ts";
import { collectExtensionState, restoreExtensionState } from "../../logic/scene/extensions.ts";
import { applySceneState } from "./scene-restore.ts";
import { BUILD_ID } from "../build-id.ts";
import { noteMs, span, spanSync } from "./load-profile.ts";
import { hasSharedTexture, COLOR_MAP_REFUSAL, isColorMap } from "../fields.ts";
import { descKey, setZarrTimings, warmAssemblyWorkers, type ZarrDesc } from "../zarr.ts";
import { decodeSegInWorker } from "./seg-decoder.ts";
import { setSegDecoder } from "../../logic/readers/seg-cache.ts";
import { createClickOutline } from "../click-outline-tool.ts";

// Mirrored to the session log like the shell's setStatus: the save messages went through this one
// and never reached the log, so no save had a recorded time (critic's target, 2026-09-17).
const status = (m: string) => {
  const e = document.getElementById("status"); if (e) e.textContent = m;
  try { void fetch("/_log", { method: "POST", body: m, keepalive: true }).catch(() => {}); } catch { /* no server */ }
};

/**
 * Put a volume that exists only in the scene INTO the DICOM database, as its own series.
 *
 * Ron, after his first crop: "how do I know as a naive user that the cropped volume lives in the
 * scene only and I have to save it to the dicom db if I want it to be more permanent? That should be
 * an option offered." Before this there was no such option: a derived volume could be downloaded as
 * a NRRD and nothing else, so the crop that makes a FastSurfer run possible on his 0.67 mm study
 * died on the next reload -- and so did any segmentation made on it, because a DICOM SEG has to
 * reference instances that exist.
 *
 * IT LOOKS FOR AN ANCESTOR IN THE DATABASE, following `refs.source` up: the patient, the study,
 * the frame of reference and the attribution are copied from the series this volume descends
 * from (logic/export-dicom-image.ts). A volume with no such ancestor -- a NIfTI from the desktop,
 * a sample -- is, since 2026-09-20, asked about: the person names its patient and study in a
 * dialog and the series is written under them (`ExportSubject`; the indexer makes the rows).
 *
 * ONE INDEX OPERATION for the whole series: every instance is written first, then all of them are
 * indexed in a single transaction with a single backup and a single audit. A per-instance loop would
 * back up a 240 MB index a few hundred times and could leave half a series indexed.
 */
async function exportVolumeAsDicom(live: LiveSceneT, imageId: string, onStatus: (m: string) => void = () => {}, askSubject?: (img: MrsonNode) => Promise<ExportSubject | null>): Promise<{ filename: string; size: number; note?: string }> {
  const img = live.nodes.get(imageId);
  if (!img) throw new Error("no such volume");
  if (img.labelmap) throw new Error("this is a labelmap — save it as a DICOM SEG from the segmentation it belongs to");

  // The nearest ancestor that came from DICOM. A crop of a crop is still a descendant of the series.
  let src: typeof img | undefined = img, hops = 0;
  const seen = new Set<string>([imageId]);
  while (src && !(src.origin as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID) {
    const next = ((src.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
    if (!next || seen.has(next)) { src = undefined; break; }
    seen.add(next);
    src = live.nodes.get(next);
    hops++;
  }
  // An ancestor counts only if it was READ FROM THE DATABASE: DICOM files opened from disk carry a series UID too,
  // and their instances are not in the database to be re-read -- such a volume is asked "whose is it?" like a
  // NIfTI (critic, 2026-09-24, review-bugfixes finding 5).
  const srcOrigin = src?.origin as { seriesInstanceUID?: string; inDatabase?: boolean } | undefined;
  const seriesUID = srcOrigin?.inDatabase ? srcOrigin.seriesInstanceUID : undefined;
  // NO DICOM ANCESTOR -- a file, a sample, a download. Since 2026-09-20 that is not a refusal but
  // a question: whose is it? The person names the patient and the study (the file's name is the
  // default), and the series is written under them with the origin in the patient's comments.
  // Ron: "Data that is not dicom comes from somewhere ... finally needs to be stored somewhere
  // so it can be recovered next time I want to work on it." Only on save, never on load.
  let subject: ExportSubject | undefined;
  let instances: ArrayBuffer[] = [];
  const savedAs = (img.origin as { savedSeriesInstanceUID?: string } | undefined)?.savedSeriesInstanceUID;
  if (savedAs) throw new Error(`"${img.name}" is already in the DICOM database (series …${savedAs.slice(-8)}); it is not saved twice`);   // critic, finding 3
  // AN ORIGINAL IS NOT SAVED AGAIN: a volume loaded from the database is its own nearest DICOM ancestor (no hop),
  // and "Save all" wrote it once more as a new series "derived from" itself (code review 2026-09-24, A4). Not so
  // for DICOM files opened from disk (not in the database) or a volume whose geometry was hardened since.
  const own = img.origin as { inDatabase?: boolean; hardened?: boolean } | undefined;
  if (seriesUID && hops === 0 && own?.inDatabase && !own.hardened) throw new Error(`"${img.name}" is already in the DICOM database (series …${seriesUID.slice(-8)}); it is not saved again`);
  if (!seriesUID) {
    if (!askSubject) throw new Error(`"${img.name}" does not descend from anything in the DICOM database, so there is no patient or study to attach it to — save it as a NRRD instead`);
    // THE VALUES ARE CHECKED BEFORE THE PERSON IS ASKED: a float volume cannot be a DICOM image,
    // and filling in a dialog to be refused afterwards is the dead end the critic hit (finding 7).
    const probe = await fetchZarrVolumeNative(live.blobBase(), img.zarr as Parameters<typeof fetchZarrVolumeNative>[1]);
    const pc = toStoredPixels(probe.data as unknown as ArrayLike<number>);
    if (!pc.ok) throw new Error(`${pc.reason}. Save it as a NRRD instead; the scene can be saved without it.`);
    const sub = await askSubject(img);
    if (!sub) throw new Error("not saved — no patient named for it");
    subject = sub;
  } else {
    const g = globalThis as unknown as { __dicomSourceInstances?: (uid: string) => Promise<ArrayBuffer[] | null> };
    instances = await g.__dicomSourceInstances?.(seriesUID) ?? [];
    if (!instances.length) throw new Error("the series this volume came from could not be read from the DICOM database, so the new series has no patient and study to copy");
  }

  const dbs = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
  const cur = (dbs?.databases ?? []).find((d: { current?: boolean; exists?: boolean }) => d.current && d.exists) ??
    (dbs?.databases ?? []).find((d: { exists?: boolean }) => d.exists);
  if (!cur) throw new Error("no DICOM database is reachable from here, so there is nowhere to put it");
  // CAN THIS SERVER FINISH WHAT WE ARE ABOUT TO START? Asked BEFORE writing anything.
  //
  // The page reloads with the window; the server side is compiled into the .app and changes only
  // when someone recompiles it. On 2026-09-07 those two were five days apart, so this wrote 258
  // instances -- 39 MB -- to a server that had the write route but not the batch index route, and
  // was refused at the last step. Ron: "so save to dicom failed silently! That is bad." Two things
  // came out of that: the failure now takes its own files back (below), and it does not begin at
  // all when the route it needs is missing.
  const features: string[] = dbs?.features ?? [];
  for (const need of ["index-batch", "write-kind", "write-delete"]) {
    if (!features.includes(need)) {
      throw new Error(
        `this application's server side is older than its interface (no "${need}"), so a volume ` +
        `cannot be saved yet — quit SlicerAlbula and run "Rebuild SlicerAlbula App.command", ` +
        `which recompiles and reinstalls it`,
      );
    }
  }

  if (isColorMap(img)) throw new Error(`"${String(img.name ?? "this volume")}" ${COLOR_MAP_REFUSAL}`);
  onStatus("reading the volume…");
  const zv = await fetchZarrVolumeNative(live.blobBase(), img.zarr as Parameters<typeof fetchZarrVolumeNative>[1]);
  // The window and level it is being LOOKED at with, so the series looks the same when it comes back.
  const dispId = ((img.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
  const disp = dispId ? live.nodes.get(dispId) : undefined;
  const window = typeof disp?.window === "number" && typeof disp?.level === "number"
    ? { center: disp.level as number, width: disp.window as number }
    : undefined;
  const parentName = (src?.name as string) ?? "the original";
  // WHEN it was made is in the series' date and time columns (SeriesDate / SeriesTime, set by export-dicom-image.ts),
  // not in its name (692e5ec: "the date belongs in the date column").
  const out = await volumeToDicomSeries(
    zv.data as unknown as ArrayLike<number>,
    zv.dims as [number, number, number],
    img.ijkToRAS as number[],
    instances,
    {
      // NO DATE IN THE NAME. It went in when the browser had no date column; the browser has one
      // now, so the name repeated it -- and the separator was a middle dot, which came back through
      // DICOM as "Â·" because a dataset with no SpecificCharacterSet is ASCII and nothing said
      // otherwise. Ron: "The date was in the wrong place in the listing." The date belongs in the
      // date column, and a DICOM string written by us stays ASCII.
      ...(subject ? { subject } : {}),
      seriesDescription: (img.name as string) ?? "Derived volume",
      derivation: subject ? `${subject.comments ?? "Loaded from a file"} into SlicerAlbula and written as DICOM unchanged: the same voxel grid, the same values.` : `Derived in SlicerAlbula from "${parentName}": a sub-box of the original voxel grid, taken on the grid itself with no resampling, so the voxel values are unchanged and the geometry stays aligned with the original.`,
      window,
      onProgress: (p) => onStatus(p.total ? `DICOM — ${p.phase} (${p.done}/${p.total})` : `DICOM — ${p.phase}…`),
    },
  );

  const files: { file: string; meta: unknown }[] = [];
  const written: string[] = [];
  /** Take every file back. A save that half-happened must not leave the database dirty. */
  const rollBack = async () => {
    onStatus(`DICOM — the save failed; removing the ${written.length} files it had written…`);
    for (const name of written) {
      await fetch(`/_db/${encodeURIComponent(cur.id)}/_write/${encodeURIComponent(name)}?kind=image`, { method: "DELETE" })
        .catch(() => {});
    }
  };
  try {
    for (let i = 0; i < out.instances.length; i++) {
      const inst = out.instances[i];
      if (i % 16 === 0) onStatus(`DICOM — writing files (${i}/${out.instances.length})`);
      const res = await fetch(`/_db/${encodeURIComponent(cur.id)}/_write/${encodeURIComponent(inst.filename)}?kind=image`, {
        method: "POST", body: inst.bytes,
      });
      if (!res.ok) throw new Error(`could not write ${inst.filename}: ${res.status}`);
      const w = await res.json();
      written.push(inst.filename);
      files.push({ file: w.rel ?? `SlicerAlbula-Volumes/${inst.filename}`, meta: inst.index });
    }
  } catch (e) {
    await rollBack();
    throw e;
  }
  // WRITTEN IS NOT THE SAME AS FINDABLE: the browser lists what the index holds, so a file beside it
  // is invisible. Ron hit that three times with segmentations, and once more here -- 258 instances on
  // disk that nothing could see, because the index step was refused after every file was written.
  onStatus("DICOM — adding the series to the database index…");
  const ix = await fetch(`/_db/${encodeURIComponent(cur.id)}/_index`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  }).then((r) => r.json()).catch((e) => ({ error: (e as Error).message }));
  // NOT INDEXED IS NOT A PARTIAL SUCCESS, it is a failure with litter. The files come back off the
  // disk and the caller is told, rather than being handed a filename and a note nobody reads.
  if (!ix?.indexed) {
    await rollBack();
    throw new Error(`the series could not be added to the database index, so nothing was kept: ${ix?.error ?? "unknown reason"}`);
  }

  // WHAT THE SCENE NOW KNOWS: this volume has a series of its own in the database. Deliberately
  // NOT `origin.seriesInstanceUID`, which everywhere else means "was loaded from these instances"
  // and would have the SEG exporter re-read a series the open database snapshot has never heard of.
  // A separate, honestly named field: it was SAVED there, and the panels can say so.
  if (ix?.indexed) {
    live.write({
      op: "patch", id: imageId, path: "#/origin",
      value: { ...((img.origin as Record<string, unknown>) ?? {}), savedSeriesInstanceUID: out.seriesInstanceUID, savedStudyInstanceUID: out.studyInstanceUID, savedSopInstanceUIDs: out.instances.map((i) => i.index.sopInstanceUID), ...(subject ? { patientName: subject.patientName, patientID: subject.patientID } : {}) },
    });
  }
  // AND THE APPLICATION RE-READS ITS OWN DATABASE, so what was just written is usable now rather
  // than after the user reopens the browser. The SEG exporter reads the same snapshot, so this is
  // what turns "crop, save, reopen the database, load the series, segment, save" into "crop, save,
  // segment, save".
  const refreshed = await (globalThis as unknown as { __refreshDicomDb?: () => Promise<number | null> })
    .__refreshDicomDb?.() ?? null;

  const size = out.bytes;
  const where = `${out.slices} slices of ${out.columns}x${out.rows} in ${cur.path}/SlicerAlbula-Volumes`;
  // "Under the original series" only when the link to it was recorded (critic, review-bugfixes finding 7).
  if (ix.audit?.ok && !ix.warning) {
    return { filename: `${out.slices} DICOM files`, size,
      note: `${where} — saved in the DICOM database, under the original series. ` +
        (refreshed
          ? `It is permanent now, and a segmentation of it can be saved too.`
          : `Reopen the database in Load to see it.`) };
  }
  return { filename: `${out.slices} DICOM files`, size,
    note: savedNote(where, ix.audit, ix.backup, ix.warning) };
}

/**
 * WHAT THE PERSON IS TOLD AFTER A SAVE, in words a first-time user can act on.
 *
 * The check that runs after every write looks for two things: index entries whose file is gone, and
 * files in the database folder that the index does not list. Those were reported as "0 zombie(s)
 * and 155 orphan(s)" -- Ron, 2026-09-22: "Not helpful for a novice user." They are also not a
 * failure: the save worked, and the count is about the rest of the folder.
 *
 * So the sentence leads with what happened to THE PERSON'S data, and the housekeeping follows in plain words
 * only when there is something to say.
 */
function savedNote(what: string, audit: AuditResult | undefined, backup?: unknown, warning?: unknown): string {
  const words = auditWords(audit);
  // A lost parent link is said (code review 2026-09-24, A8): the series then shows as a top-level row.
  const warn = typeof warning === "string" && warning ? ` Note: ${warning}.` : "";
  if (!words) return `${what} — saved in the DICOM database${warn ? "." + warn : ""}`;
  return `${what} — saved in the DICOM database. Housekeeping: ${words}${backup ? " (the backup made before this save was kept)" : ""}.${warn}`;
}

/**
 * Build the DICOM SEG for one segmentation node and put the file where Slicer can import it.
 *
 * The SEG references the SOURCE SERIES' own instances, so this re-reads them from the open DICOM
 * database rather than reconstructing anything: a SEG's frames name the images they segment by SOP
 * Instance UID, and only the originals carry those.
 *
 * THE SAFE ROUTE, deliberately: a FILE, and ctkDICOM.sql is not touched. Inserting rows into a
 * SQLite index Slicer may have open, for a database holding ~18 GB of patient imaging, is a bad
 * trade for saving a click -- so the SEG lands in a folder inside the database directory and
 * Slicer's own DICOM Import does the indexing, with the code that owns it.
 *
 * "As little clicking as absolutely needed" means no file dialog: the database folder is already
 * granted (it is how the volume was loaded), so the file goes into a subfolder of it. At most one
 * permission prompt, once, because reading a folder does not carry the right to write to it.
 */
async function exportSegAsDicom(live: LiveSceneT, segId: string, onStatus: (m: string) => void = () => {}): Promise<{ filename: string; size: number; note?: string }> {
  const seg = live.nodes.get(segId);
  if (!seg) throw new Error("no such segmentation");
  const srcId = ((seg.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
  const src = srcId ? live.nodes.get(srcId) : undefined;
  if (!src) throw new Error("this segmentation names no source volume, so there is nothing for a SEG to reference");
  // EITHER the series this volume was LOADED from, or the one this application SAVED it as.
  //
  // A crop is a scene-only volume: it has no seriesInstanceUID, so a segmentation drawn on it could
  // not be saved at all -- "did not come from DICOM" -- and that was true even after the crop had
  // been written into the database, because the field recording that is a different one on purpose
  // (`savedSeriesInstanceUID` means "saved as", not "loaded from"). But once the series is in the
  // database its instances exist and can be referenced, which is all a SEG needs. So both count
  // here, and the crop → segment → save loop no longer needs a trip through the browser.
  const org = src.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
  const seriesUID = org?.seriesInstanceUID ?? org?.savedSeriesInstanceUID;
  if (!seriesUID) {
    throw new Error(
      `"${src.name}" is not in the DICOM database, so there is no series for a segmentation to ` +
      `reference — put the volume in the database first (Crop Volume › Result › Save to DICOM)`,
    );
  }

  const g = globalThis as unknown as {
    __dicomSourceInstances?: (uid: string) => Promise<ArrayBuffer[] | null>;
    __dicomDbDir?: () => FileSystemDirectoryHandle | null;
  };
  const instances = await g.__dicomSourceInstances?.(seriesUID) ?? null;
  if (!instances) throw new Error("the series this segmentation was drawn on could not be read from the DICOM database (a SEG has to reference its images)");

  const zv = await fetchZarrVolumeNative(live.blobBase(), seg.zarr as Parameters<typeof fetchZarrVolumeNative>[1]);
  // A byte labelmap, or a refusal: Uint8Array.from on a wider array wraps 256 to 0 and 257 to 1
  // without a word (critic, 2026-09-17, finding 16). Every labelmap here is a byte today; the
  // guard is for the day one is not.
  if (!(zv.data instanceof Uint8Array)) {
    let max = 0;
    for (const v of zv.data as ArrayLike<number>) if (v > max) max = v;
    if (max > 255) throw new Error(`this segmentation uses label values up to ${max}; a DICOM SEG from this application holds at most 255 structures`);
  }
  const labels = zv.data instanceof Uint8Array ? zv.data : Uint8Array.from(zv.data as ArrayLike<number>);
  const segments = ((seg.segments as { labelValue: number; name?: string; structure?: string; color?: number[]; fileCodes?: SegmentCodes }[] | undefined) ?? [])
    .map((sg) => ({
      labelValue: sg.labelValue,
      name: sg.name ?? `Segment ${sg.labelValue}`,
      color: sg.color ? [sg.color[0], sg.color[1], sg.color[2]] as [number, number, number] : undefined,
      // The harmonized SNOMED code where the structure is one the catalog knows, with the type's
      // own meaning, its laterality and its category beside it, so the SEG says "Kidney, Right"
      // in codes and not only in its label. The names in the scene are already the readable forms
      // the catalog produced, so the lookup resolves both ways. A structure the catalog does
      // NOT know keeps the codes it arrived with (`fileCodes`, read by the SEG reader since
      // 2026-09-20) rather than the writer's generic "Anatomical structure": nothing is invented,
      // and nothing the file carried is lost on a round trip (the 09-17 critic's finding 2, the
      // way Mike asked for it on 09-19/20).
      // BY THE STRUCTURE'S KEY when the segment has one (a FastSurfer result's third ventricle is not TotalSegmentator's,
      // whatever the two are called; critic 2026-10-20, finding 6), else by its name.
      ...codesFromCatalogueOrFile(sg.structure ?? sg.name, seg.terminology as string | undefined, sg.fileCodes),
    }));
  const out = await segmentationToDicomSeg(labels, zv.dims as [number, number, number], segments, instances, {
    seriesDescription: (seg.name as string) ?? "Segmentation",
    algorithmName: (seg.origin as { task?: string } | undefined)?.task,
    merged: !!(seg.origin as { merged?: unknown } | undefined)?.merged,
    algorithmType: (seg.origin as { algorithmType?: "AUTOMATIC" | "SEMIAUTOMATIC" | "MANUAL" } | undefined)?.algorithmType,
    run: (seg.origin as { run?: RunProvenance } | undefined)?.run,
    // A frame of a sequence: its own images out of a series that holds every frame.
    instanceNumbers: (src.origin as { instanceNumbers?: number[] } | undefined)?.instanceNumbers,
    sopInstanceUIDs: (src.origin as { sopInstanceUIDs?: string[] } | undefined)?.sopInstanceUIDs,
    // From a multi-frame file: which frame of it each slice is.
    frameNumbers: (src.origin as { frameNumbers?: number[] } | undefined)?.frameNumbers,
    onProgress: (p) => onStatus(
      p.total ? `DICOM SEG — ${p.phase} (${p.done}/${p.total})` : `DICOM SEG — ${p.phase}…`,
    ),
  });
  const saved = await saveDicomArtefactAndForget(
    { bytes: out.bytes, filename: out.filename, index: out.index, kind: "DICOM SEG",
      intoDb: decodeURIComponent(/\/_db\/([^/]+)\//.exec((src.origin as { fromDatabase?: string } | undefined)?.fromDatabase ?? "")?.[1] ?? "") || undefined,
      what: `${out.segments} segments, ${out.frames} frames${out.unlistedVoxels ? ` — NOTE: ${out.unlistedVoxels.toLocaleString()} voxels carry a label no structure is named for and are not in the file` : ""}`, subdir: "SlicerAlbula-SEG" },
    onStatus,
  );
  // WHAT THE SCENE NOW KNOWS: this segmentation has a series of its own in the database. The image
  // save has done this since it was written; the SEG save never did, and the omission is what broke
  // the surface round trip. surfaceParentSeries asks the segmentation for its series, got nothing,
  // and fell through to the IMAGES -- so the provenance edge was written from the CT rather than
  // from the SEG, while the load (in a later session, where the SEG has been loaded from DICOM and
  // does know its series) looked under the SEG. Confirmed in the edge table before fixing:
  //   surface | parent 1.3.6.1.4.1.14519...  <- the CT
  //   algorithm | child 2.25.4721825...      <- the SEG, which is what the parent should have been
  // Named the same way as the image's, and for the same reason: SAVED as, not LOADED from.
  if (saved.indexed) {
    live.write({
      op: "patch", id: segId, path: "#/origin",
      value: {
        ...((seg.origin as Record<string, unknown>) ?? {}),
        savedSeriesInstanceUID: out.index.seriesInstanceUID,
        savedStudyInstanceUID: out.index.studyInstanceUID,
        savedSopInstanceUID: out.index.sopInstanceUID,
        savedSopClassUID: out.sopClassUID,
      },
    });
    // Saved: the dirty mark comes off (segmentation-editor.ts markEdited).
    live.write({ op: "patch", id: segId, path: "#/edited", value: false });
    // THE RUN, IN THE PROVENANCE STORE TOO: the same record the SEG carries in ContentDescription,
    // as JSON against the new series, source "haversack", so it can be asked for without opening
    // the file. The store is Ron's own database beside Slicer's index (SeriesAttributes).
    const run = (seg.origin as { run?: RunProvenance } | undefined)?.run;
    if (run && saved.dbId) {
      fetch(`/_db/${encodeURIComponent(saved.dbId)}/_attribute`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ uid: out.index.seriesInstanceUID, key: "run", value: JSON.stringify(run), source: "haversack" }),
      }).catch(() => { /* the SEG itself carries it; the store is the second copy */ });
    }
  }
  return saved;
}


// (surfaceParentSeries, where stored surfaces hung under their SEG, went with the DICOM surfaces save, 2026-10-22.)

// THE READ-BACK OF STORED SURFACES FOR DRAWING (loadStoredSurfaces) IS GONE with the drawing of surface models (Ron,
// 2026-10-21, option B). The reader stays, for DICOM parity: logic/readers/dicom-surface.ts.

// THE DICOM SURFACES SAVE IS GONE TOO (Ron, 2026-10-22: "For now only segmentations go into the db. stl are exports
// only"): surface models leave Albula as STL or OBJ files only. The writer and the reader stay in logic/ (DICOM parity),
// with their tests; no app path calls them.

/**
 * SAVE A SEGMENTATION TO THE DICOM DATABASE: the SEG, and nothing else.
 *
 * ONE FUNCTION BECAUSE THERE ARE SEVERAL SAVE BUTTONS: the Save panel (`__exportNode`), the dialog the AI module
 * raises after a run (`__exportSegAsDicom`) and the Segment Editor's save all come here.
 *
 * It wrote the segmentation's surfaces as well, once (Ron, 2026-09-17: "By default, the user should just say save
 * segmentation and that should save everything"), and from 2026-09-24 only for a segmentation given surface models,
 * waiting up to 90 s for them to be built. Since 2026-10-21 (Ron, option B) surface models are an export of their
 * own, made on demand as STL or OBJ files in Save › Files (and since 2026-10-22 never into the database): the SEG save
 * waits for nothing.
 */
// ON THE 3D VIEW while it saves (render/working.ts; Ron, 2026-10-17: "tell the user that you are working"): which
// segmentation, and the usual time of a save on this Mac once measured.
async function saveSegmentation(
  live: LiveSceneT,
  id: string,
  status: (m: string) => void,
): Promise<{ filename: string; size: number; note?: string }> {
  // Timed per size of segmentation: a whole-body one and a vessel tree are not the same work (critic 2026-10-17, finding 6).
  const dims = (live.nodes.get(id)?.dims as number[] | undefined) ?? [];
  const work = startWork({ title: `Saving ${String(live.nodes.get(id)?.name ?? "the segmentation")} to the DICOM database`, timeKey: `save:segmentation:${sizeClass(dims.reduce((a, b) => a * b, 1))}` });
  let ok = false;
  try { const r = await saveSegmentation0(live, id, status); ok = !/NOT (saved|indexed)/.test(r.note ?? ""); return r; }
  finally { work.done(ok); }
}
async function saveSegmentation0(
  live: LiveSceneT,
  id: string,
  status: (m: string) => void,
): Promise<{ filename: string; size: number; note?: string }> {
  // TIMED into the status line and so the session log: Ron, 2026-09-17, "it's more the speed of loading, viewing and
  // saving" -- and no save had ever been timed.
  const t0 = performance.now();
  const seg = await exportSegAsDicom(live, id, status);
  // "NOT indexed" IS THE SAME REFUSAL AS "NOT saved" (critic 2026-09-22, 1.7): both sentences are caught.
  if (seg.indexed === false || /NOT (saved|indexed)/.test(seg.note ?? "")) status(`not saved — ${seg.note ?? "the segmentation was refused"}`);
  else status(`saved in ${((performance.now() - t0) / 1000).toFixed(1)}s — the segmentation (${(seg.size / 1048576).toFixed(0)} MB)`);
  return seg;
}

/**
 * A FILE AT THE TOP OF DOWNLOADS (critic 2026-10-21, surfaces export, finding 3): the app's window has no working blob
 * download (dicom-architecture.md, step 2), so Save › Files handed the bytes to a download that went nowhere and said
 * "Saved ✓". The app's server writes them where pictures go (desktop/pictures.ts, streamed); a browser with no such
 * route (the headless server) gets the ordinary download. A refusal throws: nothing is said to be saved that was not.
 */
async function toDownloads(filename: string, parts: readonly Uint8Array[], mime: string): Promise<{ name: string; path?: string }> {
  const ext = /\.(surfaces\.stl|surfaces\.obj|stl|obj|seg\.nrrd|nrrd|nii\.gz|nii|png|csv)$/i.exec(filename)?.[0] ?? "";
  const name = `${plainFileStem(filename.slice(0, filename.length - ext.length))}${ext.toLowerCase()}`;
  const body = new Blob(parts as BlobPart[], { type: mime });
  const r = await fetch(`/_picture/${encodeURIComponent(name)}`, { method: "POST", body }).catch(() => null);
  // The name written: "<name> 2" when one of that name was there already (desktop/pictures.ts).
  if (r?.ok) { const path = ((await r.json().catch(() => ({}))) as { path?: string }).path; return { name: path?.split("/").pop() ?? name, path }; }
  if (r && r.status !== 404 && r.status !== 405) throw new Error(`${name} was not saved: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? `the server said ${r.status}`}`);
  // No such route here: the browser's own download.
  if (typeof document === "undefined") throw new Error(`${name} could not be saved: this window has no way to write a file`);
  const url = URL.createObjectURL(body); const a = document.createElement("a"); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { name };
}

/**
 * Put one finished DICOM object where it can be found, whatever this build can actually write.
 *
 * Shared by the SEG save and the surface save. It was written for the SEG and is the subtle part of
 * both: the native write route, then the index insert, then the audit -- and three fallbacks behind
 * it, one of which cannot report its own success. Duplicating it for a second object would have meant
 * two copies of every lesson in it, and the lessons were expensive.
 */
/** The app's own write route answered and refused: the reason is the message, not a download. */
class NativeSaveRefused extends Error {}

/** The save, with the browser's provenance memo dropped on the way out as well as on the way in:
 *  a lookup that raced the write would otherwise have refilled it with the table as it was before
 *  (critic, 2026-09-22, finding 6). */
async function saveDicomArtefactAndForget(
  art: { bytes: Uint8Array; filename: string; index: unknown; kind: string; what: string; subdir: string; /** the database id to write into (the source's own), when it is registered */ intoDb?: string },
  onStatus: (m: string) => void,
): Promise<{ filename: string; size: number; note?: string; indexed?: boolean; dbId?: string }> {
  try {
    return await saveDicomArtefact(art, onStatus);
  } finally {
    (globalThis as unknown as { __forgetProvenance?: () => void }).__forgetProvenance?.();
  }
}

async function saveDicomArtefact(
  art: { bytes: Uint8Array; filename: string; index: unknown; kind: string; what: string; subdir: string; /** the database id to write into (the source's own), when it is registered */ intoDb?: string },
  onStatus: (m: string) => void,
  // `indexed` is reported as a FIELD and not left to be read out of `note`. Callers act on it -- a
  // SEG that reached the index has a series of its own and the scene has to be told -- and parsing
  // a sentence to find that out is how the next caller gets it wrong.
): Promise<{ filename: string; size: number; note?: string; indexed?: boolean; dbId?: string }> {
  const g = globalThis as unknown as { __dicomDbDir?: () => FileSystemDirectoryHandle | null; __forgetProvenance?: () => void };
  // WHAT IS ABOUT TO BE WRITTEN CHANGES WHAT THE ANSWERS ARE. The browser holds the provenance
  // table for a minute, and the save that writes a surfaces edge did not drop it -- so the
  // segmentation just saved reported no surfaces for the next minute, and the next load extracted
  // them again from scratch (critic, 2026-09-22, finding 6). Dropped before the write, not after,
  // so a lookup that races the save still refetches.
  g.__forgetProvenance?.();

  // THE NATIVE APP'S OWN WRITE ROUTE FIRST, when there is one.
  //
  // WKWebView has no File System Access API and no working `<a download>` for a blob, so in the
  // native app every branch below fails — and the download branch fails SILENTLY, reporting "saved"
  // for a file that was never written. Ron lost a whole load-segment-save-import cycle to that.
  // `/_db/<id>/_write/<name>` is served by the app itself and writes into the database directory,
  // which is both the no-click path and the one place Slicer will be pointed at anyway.
  try {
    const dbs = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
    // BESIDE ITS SOURCE (critic 2026-10-15, render-audit-fixes finding 2): a segmentation drawn on a scan from one database is
    // written into that database even when the window shows another, so the SEG and the images it references stay together.
    const cur = (art.intoDb ? (dbs?.databases ?? []).find((d: { id?: string; exists?: boolean }) => d.id === art.intoDb && d.exists) : undefined) ??
      (dbs?.databases ?? []).find((d: { current?: boolean; exists?: boolean }) => d.current && d.exists) ??
      (dbs?.databases ?? []).find((d: { exists?: boolean }) => d.exists);
    if (cur) {
      // THE INDEX RECORD TRAVELS WITH THE BYTES (server feature "write-index"), so the server writes
      // and indexes in one go and a page that dies after sending -- 2026-09-18, a whole-body
      // surfaces save in a 4 GB renderer -- leaves no orphan. An older server ignores the header
      // and answers without `indexed`; the second request below then does what it always did.
      const withIndex = ((dbs?.features ?? []) as string[]).includes("write-index");
      const res = await fetch(`/_db/${encodeURIComponent(cur.id)}/_write/${encodeURIComponent(art.filename)}`, {
        method: "POST", body: art.bytes as unknown as BodyInit,
        // Percent-encoded: a header value must be Latin-1, and the record carries the series'
        // description (a study named in Greek or with an em dash would have failed the save).
        ...(withIndex ? { headers: { "x-albula-index": encodeURIComponent(JSON.stringify(art.index)) } } : {}),
      });
      // THE NATIVE ROUTE'S ANSWER IS THE ANSWER. A 500 (disk full, a read-only database) or a 400
      // used to fall through to the browser paths and end as a blob download that does nothing,
      // with the server's reason swallowed (critic, 2026-09-18 evening, finding 7).
      if (!res.ok && res.status !== 409) {
        const why = await res.json().catch(() => null) as { error?: string } | null;
        throw new NativeSaveRefused(`the app could not write the file: ${why?.error ?? `HTTP ${res.status}`}`);
      }
      {
        const w = await res.json();
        if (w.error && !w.path) throw new NativeSaveRefused(String(w.error));
        if (w.indexed === false) {
          return { filename: String(w.path), size: art.bytes.byteLength, indexed: false, note: `${art.what} — NOT saved: ${w.error ?? "the index refused it"}` };
        }
        if (w.indexed && w.audit) {
          return { filename: w.path, size: art.bytes.byteLength, indexed: true, dbId: cur.id,
            note: w.audit.ok
              ? savedNote(art.what, w.audit, undefined, w.warning)
              // `w.backup`, not `ix.backup`: `ix` is declared below this block, so reading it here
              // was a ReferenceError -- caught by the catch-all as "no native side", and the save
              // fell through to a blob download with the file ALREADY in the database. The recorded
              // "save path falls through to browser download after a 200"; found by the flow Ron
              // asked for on 2026-09-20 ("I say save my scene. You take care of everything else").
              : savedNote(art.what, w.audit, w.backup, w.warning) };
        }
        // WRITTEN IS NOT THE SAME AS FINDABLE. The browser lists what the index holds, so a file
        // beside it is invisible -- which is exactly what Ron hit three times: "the segmentation
        // still does not show up." So the write is followed by an index insert, and the insert is
        // followed by an audit for zombies and orphans, and the pre-write backup is kept only if
        // that audit is unhappy. Failing to index is not failing to save: the file is on disk
        // either way, and the message says which of the two happened.
        const rel = String(w.path).startsWith(String(w.dir))
          ? `${art.subdir}/${String(w.path).slice(String(w.dir).length + 1)}`
          : art.filename;
        onStatus(`${art.kind} — adding it to the database index…`);
        const ix = await fetch(`/_db/${encodeURIComponent(cur.id)}/_index`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ file: rel, meta: art.index }),
        }).then((r) => r.json()).catch((e) => ({ error: (e as Error).message }));
        if (ix?.indexed && ix.audit?.ok) {
          return { filename: w.path, size: art.bytes.byteLength, indexed: true, dbId: cur.id,
            note: savedNote(art.what, ix.audit, undefined, ix.warning) };
        }
        if (ix?.indexed) {
          return { filename: w.path, size: art.bytes.byteLength, indexed: true, dbId: cur.id,
            note: savedNote(art.what, ix.audit, ix.backup, ix.warning) };
        }
        return { filename: w.path, size: art.bytes.byteLength,
          note: `${art.what} — written to ${w.dir}, but NOT indexed: ${ix?.error ?? "unknown reason"}` };
      }
    }
  } catch (e) {
    if (e instanceof NativeSaveRefused) throw e;               // the app answered; say so and stop
    /* no native side: fall through to the browser paths below */
  }

  // WHERE IT GOES, in order of least clicking:
  //   1. the database folder, when the database was opened FROM one (its handle is already granted);
  //   2. a folder chosen once and remembered — the usual case, because the database is normally
  //      SERVED over the app's own /_db route and there is no handle to inherit;
  //   3. a download, when neither is available.
  // (2) costs one folder chooser, ever. This runs from the Save click, which is the user gesture the
  // picker requires.
  let dir = g.__dicomDbDir?.() ?? null;
  let sub = art.subdir;
  if (dir) {
    const perm = dir as unknown as { queryPermission?: (o: unknown) => Promise<string>; requestPermission?: (o: unknown) => Promise<string> };
    let state = await perm.queryPermission?.({ mode: "readwrite" }) ?? "granted";
    if (state !== "granted") state = await perm.requestPermission?.({ mode: "readwrite" }) ?? "denied";
    if (state !== "granted") dir = null;
  }
  if (!dir) {
    dir = await recallExportDir({ prompt: true });
    sub = "";                                   // a folder the user picked FOR this needs no subfolder
    if (!dir) {
      const picker = (globalThis as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (picker) {
        try {
          dir = await picker({ id: "albula-dicom", mode: "readwrite" });
          await rememberExportDir(dir);
        } catch { dir = null; }                 // canceled: fall through to the download
      }
    }
  }
  if (dir) {
    const target = sub ? await dir.getDirectoryHandle(sub, { create: true }) : dir;
    const fh = await target.getFileHandle(art.filename, { create: true });
    const w = await fh.createWritable();
    await w.write(art.bytes);
    await w.close();
    return { filename: `${sub ? sub + "/" : ""}${art.filename}`, size: art.bytes.byteLength,
      note: `${art.what} — in Slicer: DICOM module → Import → ${dir.name}` };
  }
  const blob = new Blob([art.bytes as unknown as BlobPart], { type: "application/dicom" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = art.filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  // A blob download is the LAST resort and the only one whose success we cannot observe: the anchor
  // click either starts a download or does nothing, and the page is told neither. So this says what
  // was attempted rather than asserting it landed.
  return { filename: art.filename, size: art.bytes.byteLength,
    note: `${art.what} — sent to your browser's downloads; if nothing appears there, this build cannot write files (use the Edge launcher, which can)` };
}


let appSettingsNow: SettingsStore | null = null;
const appSettings = openSettings().then((s) => { appSettingsNow = s; return s; });


/** The catalog's codes for a segment, else the codes its file carried, else nothing (the writer's generic). */
function codesFromCatalogueOrFile(name: string | undefined, context: string | undefined, fileCodes?: SegmentCodes): { code?: string; type?: string; mod?: string; category?: string } {
  const c = codesFor(name, context);
  if (c.code) return c;
  if (!fileCodes?.type) return c;
  return {
    code: `${fileCodes.type.scheme}:${fileCodes.type.value}`,
    ...(fileCodes.type.meaning ? { type: fileCodes.type.meaning } : {}),
    ...(fileCodes.modifier?.meaning ? { mod: fileCodes.modifier.meaning } : {}),
    ...(fileCodes.category?.meaning ? { category: fileCodes.category.meaning } : {}),
  };
}

async function main() {
  if (!(navigator as unknown as { gpu?: unknown }).gpu) { status("WebGPU not available"); return; }
  await appSettings.catch(() => null);           // the store is small; the defaults below read it
  // Settings › For developers: the step-by-step controls (theme.css, .sl-dev-step).
  document.documentElement.classList.toggle("sl-dev", appSettingsNow?.getBool("Developer", "steps", SETTING_DEFAULTS.Developer.steps) ?? false);
  // Settings › General › Colors: the color scheme version new colors come from (logic/anatomy/palettes.ts).
  {
    const saved = appSettingsNow?.getNumber("Colors", "scheme", SETTING_DEFAULTS.Colors.scheme) ?? SETTING_DEFAULTS.Colors.scheme;
    const at = schemeAtStart(saved);
    if (at.moved) { appSettingsNow?.set("Colors", "scheme", at.version); status(`Colors: version ${saved} was for a picture; back to version ${at.version}`); }
    else if (at.unknown) status(`Colors: version ${saved} is not one this Albula knows; it shows version ${at.version} and keeps your setting`);
    setPaletteVersion(at.version);
  }
  setShadingVersion(appSettingsNow?.getNumber("View3D", "shading", SETTING_DEFAULTS.View3D.shading) ?? SETTING_DEFAULTS.View3D.shading);
  // For the pane and the critic: set the shading version in this window, or ask it.
  (globalThis as unknown as { __shading?: (v?: number) => number }).__shading = (v?: number) => { if (typeof v === "number") setShadingVersion(v); return shadingVersion(); };
  // Settings › Loading › "Load images from their fast copy" (render/zarr-copy.ts), the same way.
  (globalThis as unknown as { __zarrCopies?: boolean }).__zarrCopies =
    appSettingsNow?.getBool("Loading", "fromCopy", SETTING_DEFAULTS.Loading.fromCopy) ?? SETTING_DEFAULTS.Loading.fromCopy;
  const p = new URLSearchParams(location.search);
  const host = p.get("host") ?? "localhost";
  // Remote servers (S13): ?host=… picks ws/http, ?secure (or an https page) picks wss/https; ?token=… is
  // appended to both WebSockets; ?gui/?ws/?http override the URLs entirely (proxied paths, tunnels).
  const secure = p.has("secure") || location.protocol === "https:";
  const withToken = (u: string) => (p.get("token") ? u + (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(p.get("token")!) : u);
  const guiUrl = withToken(p.get("gui") ?? `${secure ? "wss" : "ws"}://${host}:2133/`);
  const wsUrl = withToken(p.get("ws") ?? `${secure ? "wss" : "ws"}://${host}:2132/`);
  const httpBase = p.get("http") ?? `${secure ? "https" : "http"}://${host}:2131/mrson/`;
  const nativeMenus = p.has("nativeMenus");
  // Native-first: SlicerLive runs STANDALONE by default. Connect to a ModuleServer peer only when explicitly
  // asked (?ws=, ?peers=, ?host=, or ?connect) so a stray ModuleServer never hijacks the native session.
  const wantPeer = p.has("ws") || p.has("peers") || p.has("host") || p.has("connect") || p.has("gui");

  const gpu = await initDevice();
  // Two modes. Default = the NATIVE shell (SlicerLive is the app; a ModuleServer, if any, is just a peer).
  // ?legacy = the streamed stock-Slicer chrome hosting SlicerLive views (backwards compatibility).
  const legacy = p.has("legacy");
  const appEl = document.getElementById("app")!;
  let shell: AppShell | null = null;
  let viewsEl: HTMLElement;
  if (legacy) {
    document.body.classList.add("legacy");
    appEl.innerHTML = '<div id="gui"></div><div id="views"></div>';
    viewsEl = document.getElementById("views")!;
  } else {
    // THE SETTINGS STORE, opened once here so the shell's module restore, the 3D view's defaults
    // and the Settings dialog read the same one. `appSettings` resolves before anything asks.
    shell = mountAppShell(appEl, { title: "SlicerAlbula", restoreModule: () => appSettingsNow?.getBool("Launch", "restoreModule", SETTING_DEFAULTS.Launch.restoreModule) ?? true });

    // SAY IT WHEN THE GPU STOPS. render/device.ts detects a lost device and an uncaptured error;
    // without this they reach only the console, and the console is not where someone whose images
    // have just vanished is looking. Ron lost an evening to exactly that silence.
    let gpuCensusSaid = false;
    (globalThis as unknown as { __onGpuFailure?: (w: string, d: string) => void }).__onGpuFailure =
      (what, detail) => {
        const sh = shell;
        if (!sh) return;
        sh.setStatus(`${what} — the views have stopped drawing. Reload the window. (${detail})`);
        // WHICH SURFACE, once (2026-10-16: the first glasses failure with the series field could not be placed).
        if (!gpuCensusSaid) { gpuCensusSaid = true; const cc = (globalThis as unknown as { __canvasCensus?: () => string }).__canvasCensus?.(); if (cc) void fetch("/_log", { method: "POST", body: `at the first graphics failure, canvases: ${cc}` }).catch(() => {}); }
        void sh.confirm({
          title: "The views have stopped drawing",
          ok: "Reload now",
          cancel: "Stay",
          body: `<p>Something failed while updating the views: <b>${what}</b>.</p>
            <p class="sl-hint">${detail}</p>
            <p>Two causes are known: running out of graphics memory, usually after loading a second
            large segmentation; and the graphics card being too busy for too long, which macOS stops
            (for example the colored volume turned while an AI network runs on the same card).</p>
            <p><b>Reload now</b> puts back what is on screen. Anything never saved is named afterwards;
            a finished AI run stays under AI Segmentations → Recent results.</p>`,
        }).then(async (yes) => {
          if (!yes) return;
          // A RELOAD THE PERSON CHOSE is not a crash: the next start must not say "the page process
          // ended out of memory" (Ron, 2026-09-23, after pressing Reload now on this very notice).
          try { sessionStorage.setItem("albula-reload-chosen", what); } catch { /* no storage */ }
          // AND WHAT WAS ON SCREEN COMES BACK. After the 17:10 device loss (2026-09-23) the reloaded
          // window was empty and Ron loaded the scene again by hand. The scene is written here as a
          // document -- the same one Save scene writes, but kept in this session, not the database
          // -- and the restarted page loads it. What was never saved cannot be in it and is named.
          try {
            const v = (globalThis as unknown as { __views?: { live: { nodes: Map<string, MrsonNode>; origin: string } } }).__views;
            if (v) {
              const w = await writeScene(v.live.nodes.values(), {
                producer: `SlicerAlbula ${BUILD_ID}`, origin: v.live.origin, name: "what was on screen",
                layout: { arrangement: (globalThis as unknown as { __layoutId?: number }).__layoutId ?? 0 }, extensions: collectExtensionState(),
              });
              const scene = (globalThis as unknown as { __currentScene?: () => unknown }).__currentScene?.() ?? null;
              if (!w.empty) sessionStorage.setItem("albula-restore-scene", JSON.stringify({ doc: w.doc, notSaved: w.fixable.map((f) => f.name), scene }));
            }
          } catch (e) { console.warn("the scene could not be kept for the reload:", e); }
          location.reload();
        });
      };
    viewsEl = document.createElement("div"); viewsEl.id = "views"; viewsEl.style.cssText = "position:absolute;inset:0";
    shell.main.appendChild(viewsEl);
  }
  const peers = (p.get("peers") ?? "").split(",").map((x) => x.trim()).filter(Boolean);   // extra ModuleServers (ws urls)
  let hook: SlicerLiveHook | null = null;
  const store = new LocalBlobStore();
  // So the memory report can see the largest holder on the page (live-views, __memoryReport).
  /**
   * GIVE A GRAYSCALE VOLUME'S CHUNKS BACK once its texture is up, and read them again if anything
   * needs the voxels.
   *
   * Ron chose this over compressing them (2026-09-22), with the numbers in front of him: the CT
   * sat in the store as 864 MB of uncompressed blocks beside the 798 MB texture made from them —
   * the same voxels twice, in a window whose ceiling is about 4 GB. Compressing would have cost
   * 2.5 s of every load to save 564 MB; giving them back saves 864 MB and costs 2.1 s only when
   * something asks for voxels again (the colorized volume, statistics, a crop, an edit, a re-save).
   *
   * WHAT IS NOT TOUCHED: labelmaps (they are already deflated, 3 MB for four whole-body
   * segmentations, and the colorize path reads them constantly), and any volume whose texture is
   * not up — the chunks are what the texture is made FROM, so they go only once it exists.
   */
  // WHEN VOXELS WERE LAST READ BACK: nothing is given back within READ_BACK_HOLD_MS of it, so a tool working on a volume
  // (Grow from seeds, a threshold, an export) is not made to read it again between two of its steps.
  let lastReadBack = -Infinity;
  const READ_BACK_HOLD_MS = 30_000;
  store.setOnMiss(async (hash) => {
    const g = globalThis as unknown as { __restoreVolumeChunks?: (h: string) => Promise<boolean> };
    const ok = await g.__restoreVolumeChunks?.(hash) ?? false;
    if (ok) lastReadBack = performance.now();
    return ok;
  });
  // A VOLUME READ BACK IS GIVEN BACK AGAIN (critic 2026-10-15, render-audit-fixes finding 4: the store gave a volume back
  // once, so after the first statistics or edit the 864 MB stayed for the session). The question each time is whether
  // its pieces are in the store, not whether it was ever given back; `said` only keeps the status line to once a volume.
  let said = new Set<string>();
  const trimStore = () => {
    if (performance.now() - lastReadBack < READ_BACK_HOLD_MS) return;
    const keptPieces = () => {
      const k = new Set<string>();
      for (const m of views.live.nodes.values()) {
        const mz = (m.zarr as { chunkHashes?: Record<string, string> } | undefined)?.chunkHashes;
        if (!mz || (m.type === "image" && !m.labelmap && (m.origin as { fromCopy?: boolean } | undefined)?.fromCopy)) continue;
        for (const h of Object.values(mz)) k.add(h);
      }
      return k;
    };
    let keep: Set<string> | undefined;
    for (const n of views.live.nodes.values()) {
      if (n.type !== "image" || n.labelmap) continue;
      const z = n.zarr as { chunkHashes?: Record<string, string>; compressor?: string } | undefined;
      if (!z?.chunkHashes) continue;
      const hashes = Object.values(z.chunkHashes);
      if (!hashes.some((h) => store.has(h))) continue;
      // ONLY A VOLUME THAT CAME FROM A CURRENT WORKING COPY (2026-10-15, checked in the pane: a CT whose copy was out of
      // date was given back, and getting its voxels again rebuilt the series from DICOM -- the 09-22 path, the page past
      // 7 GB). Its pieces come back from the copy in about a second; anything else keeps them.
      if (!(n.origin as { fromCopy?: boolean } | undefined)?.fromCopy) continue;
      // Only when the texture exists: `hasSharedTexture` is the same question the field asks
      // before it decides it needs no samples at all.
      if (!hasSharedTexture(descKey(n.zarr as ZarrDesc) ?? undefined)) continue;
      // NOT a piece that something which keeps its pieces names as well (an all-zero edge piece of a CT has the same name
      // as one of a cropped volume or a labelmap, which are never given back and could not be read again).
      const kept = keep ??= keptPieces();
      const freed = store.release(hashes.filter((h) => !kept.has(h)));
      const first = !said.has(n.id as string);
      said.add(n.id as string);
      if (first && freed > 8 * 1048576) {
        status(`gave back ${Math.round(freed / 1048576)} MB: ${String(n.name ?? n.id)} is on the GPU, and its voxels come back from the database if they are wanted`);
      }
    }
    // A volume that has gone takes its entry with it, or this set grows for the session.
    said = new Set([...said].filter((id) => views.live.nodes.has(id)));
  };
  // NOT AUTOMATIC YET, and the measurement is why. Giving the chunks back is instant and frees
  // 864 MB (store 867 MB -> 3 MB, measured 2026-09-22). Getting them back is not the 2.1 s I
  // estimated from the load's own timings: `__restoreVolumeChunks` re-reads the whole series and
  // rebuilds every chunk, and on a page already holding a gigabyte it ran past 45 s with the heap
  // at 6.8 GB -- worse than the problem. A colorized volume asked for voxels and never got them.
  //
  // What it needs before it can be switched on: a recovery that rebuilds only the chunks asked
  // for, from the slices they cover, instead of reconstructing the series. Until then the store
  // keeps the volume, and `__trimStore()` does it by hand for whoever measures the next attempt.
  //
  // SWITCHED ON 2026-10-15 (render-audit, finding 2: 868 MB of C3N-01524's CT held for the whole session beside the same
  // voxels on the card): every grayscale series now has a duckn working copy, and the recovery takes its pieces as they
  // are -- the whole CT back in about a second, not the 45 s of a rebuild from DICOM.
  const TRIM_AUTOMATICALLY = true;

  if (TRIM_AUTOMATICALLY) setInterval(trimStore, 5000);

  Object.assign(globalThis, {
    __trimStore: trimStore,                        // for measuring: trim now rather than in five seconds
    __blobStoreBytes: () => store.bytes(),
    // One chunk by its hash, for measuring what the store holds and what it would cost to hold it
    // differently — the CT is kept uncompressed and is the largest thing in the window.
    __blobChunk: (hash: string) => store.get(hash) ?? null,
  });
  const views = mountLiveViews(gpu, viewsEl, { httpBase, wsUrl, peers, connect: wantPeer, onStatus: status, onNotify: (n) => { shell?.notify({ title: n.title, body: n.body, actions: n.actions }); }, startup: () => ({ drawing: appSettingsNow?.getBool("View3D", "drawing", SETTING_DEFAULTS.View3D.drawing), lighting: appSettingsNow?.get("View3D", "lighting") ?? SETTING_DEFAULTS.View3D.lighting }), onFrame: () => hook?.frameRendered(),
    onNativePaint: (segId, segment, points, mode, radiusMm, sphere, normal) => { void paintStroke(views.live, segId, points, { segment, radiusMm, mode, sphere, normal }); },
    onNativePaintCommit: (segId) => { void commitPaint(views.live, store, segId).then((v) => { if (v >= 0) status(`painted: ${v} voxels`); }); },
    // DRAW: the outline drawn on a slice, filled into the structure being edited, then saved into the scene as a stroke is.
    onNativeDraw: (segId, segment, points, normal) => { void drawFill(views.live, segId, points, { segment, normal }).then(async (n) => { await commitPaint(views.live, store, segId); const m = n ? `Draw: ${n.toLocaleString()} voxels filled` : "Draw: the outline holds no voxel centers on this slice"; status(m); shell?.setStatus(m); }); },
    // CLICK TO OUTLINE (render/click-outline-tool.ts): a click outlines; null (a right-click, Esc) ends the tool.
    onClickOutline: (ras, sign) => { if (ras) void clickOutline.click(ras, sign); else endClickOutline(); } });
  const clickOutline = createClickOutline({
    // The status bar where the person looks (shell.setStatus), and the session log (status).
    live: views.live, store, status: (m) => { status(m); shell?.setStatus(m); },
    confirm: (o) => shell ? shell.confirm(o) : Promise.resolve(false),
    marks: (points) => (globalThis as unknown as { __setClickMarks?: (p: typeof points) => void }).__setClickMarks?.(points),
  });

  // WHAT PLAY DOES, every 2 s while a sequence plays, into the session log (Ron, 2026-10-16, build 12:32: "it takes like
  // 30 sec until the beating heart stabilizes. Then it was steady" -- and the log had nothing to say what those 30 s
  // were): the steps made, the longest wait between two, and what was built meanwhile -- colored 3D fields of frames
  // (the volume rendering's, render/livescene.ts) and colored slice overlays (render/bake.ts bakeInto).
  {
    let steps = 0, worst = 0, lastAt = 0, lastSel = -1, fields0 = 0, bakes0 = 0, quiet = 0;
    const g = globalThis as unknown as { __colorizeFields?: number; __colorizeBakes?: number };
    const fieldsBuilt = () => g.__colorizeFields ?? 0;
    views.live.subscribe((c) => {
      if (c.type !== "sequenceBrowser" || c.kind !== "upsert") return;
      const n = views.live.nodes.get(c.id);
      if (n?.playbackActive !== true || n.selectedItemNumber === lastSel) return;
      lastSel = n.selectedItemNumber as number;
      const now = performance.now();
      if (lastAt) worst = Math.max(worst, now - lastAt);
      lastAt = now; steps++;
    });
    setInterval(() => {
      if (!steps) { if (++quiet > 1) lastAt = 0; fields0 = fieldsBuilt(); bakes0 = g.__colorizeBakes ?? 0; const gs0 = (globalThis as unknown as { __gpuScope?: { takePictureTimes(): string; takeCounts(): string } }).__gpuScope; gs0?.takeCounts(); gs0?.takePictureTimes(); return; }
      quiet = 0;
      const f = fieldsBuilt(), b = g.__colorizeBakes ?? 0;
      // AND WHAT THE CARD DID MEANWHILE (render/gpu-scope.ts): series steps rebound against 3D compositions, and the time of
      // each kind of picture on the card -- the 3D view, the slices, the glasses.
      const gs = (globalThis as unknown as { __gpuScope?: { takePictureTimes(): string; takeCounts(): string } }).__gpuScope;
      const cnt = gs?.takeCounts() ?? "", pics = gs?.takePictureTimes() ?? "";
      void fetch("/_log", { method: "POST", body: `play: ${steps} steps in 2 s, the longest ${Math.round(worst)} ms between two · built meanwhile: ${f - fields0} colored 3D fields of frames, ${b - bakes0} colored slice overlays${cnt ? ` · ${cnt}` : ""}${pics ? ` · ${pics}` : ""}` }).catch(() => {});
      fields0 = f; bakes0 = b; steps = 0; worst = 0;
    }, 2000);
  }
  /** The tool off: the outline stays as an ordinary edit, the marks go, the editor's button is no longer yellow. */
  const endClickOutline = () => {
    clickOutline.stop();
    const ed = views.live.nodes.get("local-segmentEditor");
    if (ed && String(ed.activeEffect ?? "").toLowerCase() === "clickoutline") views.live.write({ op: "patch", id: ed.id, path: "#/activeEffect", value: "" });
    status("Click to outline ended — the outline stays; Save keeps it");
    (globalThis as unknown as { __segEditorRender?: () => void }).__segEditorRender?.();
  };
  Object.assign(globalThis, {
    __clickOutlineLicense: () => clickOutline.license(),
    __clickOutlineStart: (segId: string, target: number, made?: boolean) => clickOutline.start(segId, target, made),
    __clickOutlineEnd: endClickOutline,
    __clickOutlineAt: (ras: [number, number, number], sign: 1 | -1) => clickOutline.click(ras, sign),
    __clickOutlineLast: () => clickOutline.last,
  });
  // The data probe readout, appended AFTER the module panels so it sits at the bottom of the sidebar
  // and survives a module switch (Ron: "a box at the bottom of the module space").
  if (shell) mountProbeBox(shell.sidebar);
  // window.__slicerlive: numeric state + settle detection + in-page self-tests (tiers T3/T5, docs/HARNESS.md)
  hook = installIntrospection({
    getCamera: () => { const c = views.camera(); return { azimuth: 0, elevation: 0, distance: Math.hypot(c.position[0] - c.focalPoint[0], c.position[1] - c.focalPoint[1], c.position[2] - c.focalPoint[2]), ...c }; },
    setCamera: () => { /* camera edits go through LiveScene ops (setCameraPose) */ },
    render: () => views.resize(),
    extra: () => ({ nodes: views.live.nodes.size, cells: views.cells(), syncOpen: views.sync.transport.isOpen }),
  });
  registerSelfTest("scene: LiveScene has the view-state nodes (when a peer is connected)", async () => {
    // the snapshot streams in after connect; give it a moment, and don't fail a standalone page with no peer
    const has = () => { const types = new Set([...views.live.nodes.values()].map((n) => n.type)); return ["layout", "camera", "view"].every((t) => types.has(t)); };
    for (let i = 0; i < 25 && !has(); i++) await new Promise((r) => setTimeout(r, 200));
    if (!views.sync.transport.isOpen && views.live.nodes.size === 0) return;   // standalone, nothing to check
    expect(has(), `missing view-state node types; have ${[...new Set([...views.live.nodes.values()].map((n) => n.type))].join(",")}`);
  });
  // A PANEL REBUILD MUST NOT MOVE THE PERSON. Ron: "Every time I changed visibility it jumped to
  // the top of the list." The first fix restored the SIDEBAR's scroll, which had never been the
  // thing lost -- the tree scrolls itself and is destroyed by `innerHTML = ""`. So the guard runs in
  // a real DOM, on the same structure the Segmentations panel builds, and checks the naive rebuild
  // still fails: a test that cannot see the bug is what let the first fix ship.
  registerSelfTest("panels: a rebuild keeps the inner scroll and a dragged height", () => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-9999px;top:0;width:260px;height:200px;overflow:auto";
    const root = document.createElement("div");
    host.appendChild(root);
    document.body.appendChild(host);
    try {
      const build = () => {
        root.innerHTML = "";
        const tree = document.createElement("div");
        tree.className = "sl-anat-tree";
        tree.style.cssText = "height:140px;overflow:auto";
        for (let i = 0; i < 120; i++) {
          const r = document.createElement("div");
          r.className = "sl-anat-row";
          r.style.height = "20px";
          r.textContent = "Segment_" + (i + 1);
          tree.appendChild(r);
        }
        root.appendChild(tree);
      };
      const tree = () => root.querySelector(".sl-anat-tree") as HTMLElement;
      build();
      tree().scrollTop = 900;
      tree().style.height = "220px";
      build();                                     // the old behavior
      expect(tree().scrollTop === 0, "the naive rebuild no longer loses the scroll — this test is now blind");
      tree().scrollTop = 900;
      tree().style.height = "220px";
      keepScroll(root, build);                     // the current behavior
      expect(tree().scrollTop === 900, `scroll not restored: ${tree().scrollTop}`);
      expect(tree().style.height === "220px", `dragged height not restored: ${tree().style.height || "(none)"}`);
    } finally {
      host.remove();
    }
  });
  registerSelfTest("views: every layout cell has a canvas", () => {
    expect(views.cells().length > 0, "no view cells");
    expect(document.querySelectorAll("#views canvas").length >= views.cells().length, "fewer canvases than cells");
  });
  if (shell) {
    const sh = shell;
    // W2 layout picker: Slicer's catalog (logic/layouts.ts) drives the view cells. The picker sits in the
    // toolbar; re-laid out on resize. (When a Slicer peer streams a layout it also calls setCells; the last
    // one wins — a native picker and a peer layout are the same setCells path.)
    // Slicer remembers the last layout across launches -- QSettings, [MainWindow] layout=<id>,
    // beside the window geometry rather than in the scene. Ron asked whether it does; it does, and
    // his own Slicer.ini reads layout=3. So this remembers too, and remembers the view split with
    // it: having dragged the boundary, finding it back at the catalog's half next launch would be
    // the same annoyance in a smaller place.
    //
    // Through logic/settings.ts, which calls itself "SlicerLive's single persistence store" and
    // until now had no callers. A private localStorage key here would have made that sentence false
    // and left two stores to keep in step -- Ron's point about Slicer.ini and this one not being at
    // cross purposes applies inside the application too. The two files never meet: Slicer keeps
    // ~/.config/slicer.org/Slicer.ini, this keeps ~/.config/slicerlive/settings.ini, and neither
    // reads the other's. The shared convention is the FORMAT, deliberately -- sectioned INI, so the
    // launcher scripts and the Slicer Python module can read it with configparser.
    //
    // Loaded asynchronously and applied when it arrives: the views must come up at the catalog
    // default rather than wait on a file read, so this restores over a working layout instead of
    // gating one. Nothing is trusted on the way in -- a stored id can outlive the layout it names.
    const splits = new Map<number, number>();
    let settings: SettingsStore | null = null;
    let layoutId = DEFAULT_LAYOUT;

    const savePrefs = () => {
      settings?.set("Layout", "id", layoutId);
      const at = splits.get(layoutId);
      settings?.set("Layout", `split.${layoutId}`, at === undefined ? undefined : at.toFixed(4));
    };

    // W2b: the boundary between the 3D view and the slice views is draggable.
    //
    // Ron: "Having a grab bar allowing to change the border between 3d view and slice viewers would
    // be great." The model was already here and already general -- splitBoundary() finds the
    // division and cellsFor() rescales each band around it, keeping the three stacked slices in
    // equal thirds of whatever they are given. It handles a row boundary (Conventional) and a
    // column one (Conventional Widescreen) alike, so ONE handle serves both and there is no special
    // case to write. What was missing was something to grab.
    //
    // Kept per layout rather than globally: the boundary means a different thing in each, and a
    // width dragged in Widescreen is not a height in Conventional. Layouts with no clean two-band
    // division -- a single view, an even grid -- have no boundary and the handle hides itself.
    // `splits` and `layoutId` are declared with the settings store above, which restores into them.
    const handle = document.createElement("div");
    handle.className = "sl-view-split";
    handle.setAttribute("role", "separator");
    handle.title = "Drag to resize the views · double-click to restore the layout's own split";
    sh.main.appendChild(handle);

    const placeHandle = () => {
      const b = splitBoundary(layoutId);
      if (!b) { handle.style.display = "none"; return; }
      const r = sh.main.getBoundingClientRect();
      const at = splits.get(layoutId) ?? b.at;
      handle.dataset.axis = b.axis;
      // Centered ON the boundary, not beside it: the 10 px target straddles the seam, so the cursor
      // is over the thing it moves. Same width and the same center grip as the sidebar splitter --
      // a 5 px target is hard to hit and gives nothing to aim at.
      handle.style.cssText = b.axis === "row"
        ? `display:block;left:0;width:100%;height:10px;top:${at * r.height - 5}px;cursor:row-resize`
        : `display:block;top:0;height:100%;width:10px;left:${at * r.width - 5}px;cursor:col-resize`;
    };

    const relayout = (r: DOMRect) => {
      views.setCells(cellsFor(layoutId, r.width, r.height, r.left, r.top, splits.get(layoutId)).map((c) => ({ id: c.view, kind: c.kind, name: c.view, view: c.px })));
      placeHandle();
    };

    // Move and up on the WINDOW, not the handle: binding them on a 10 px element depends on pointer
    // capture holding, and a webview will drop it -- which is exactly why the sidebar splitter
    // appeared grabbable but would not move.
    let splitDrag = false;
    const applySplit = (e: PointerEvent) => {
      const b = splitBoundary(layoutId);
      if (!b) return;
      const r = sh.main.getBoundingClientRect();
      const f = b.axis === "row" ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      splits.set(layoutId, f);       // cellsFor clamps to 0.1..0.9; no view can be dragged away
      relayout(r);
    };
    handle.addEventListener("pointerdown", (e) => {
      splitDrag = true;
      // Any selection made before user-select took hold stays highlighted -- the blue wash over the
      // views that the sidebar splitter produced.
      try { globalThis.getSelection?.()?.removeAllRanges(); } catch { /* not fatal */ }
      document.body.style.userSelect = "none";
      document.body.style.cursor = splitBoundary(layoutId)?.axis === "row" ? "row-resize" : "col-resize";
      (e as PointerEvent).preventDefault();
    });
    globalThis.addEventListener("pointermove", (e) => { if (splitDrag) applySplit(e as PointerEvent); });
    const endSplit = () => {
      if (!splitDrag) return;
      splitDrag = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      savePrefs();                   // once the drag ends, not on every pointermove
    };
    globalThis.addEventListener("pointerup", endSplit);
    globalThis.addEventListener("pointercancel", endSplit);
    // Double-click restores the catalog's own boundary, so a drag is never a one-way door.
    handle.addEventListener("dblclick", () => { splits.delete(layoutId); relayout(sh.main.getBoundingClientRect()); savePrefs(); });
    // The LAYOUT chooser is the same searchable picker as the module list, for the same reason: a
    // native <select> popup is placed by macOS over the current item, so near the top of the screen
    // it opens upwards and off the display. Two controls sitting side by side in one toolbar should
    // not behave differently, which is Ron's point generalized: "All buttons of this kind should
    // look and behave the same."
    const layoutHost = document.createElement("div");
    layoutHost.className = "sl-module-picker";
    layoutHost.title = "Layout";
    sh.toolbar.appendChild(layoutHost);
    let layoutOpen = false, layoutFilter = "";
    const drawLayoutPicker = () => {
      layoutHost.innerHTML = "";
      sh.searchablePicker(layoutHost, {
        options: layoutList().map((l) => ({ value: String(l.id), label: l.name })),
        selected: String(layoutId),
        open: layoutOpen,
        filter: layoutFilter,
        placeholder: "",
        onOpenChange: (open) => { layoutOpen = open; if (!open) layoutFilter = ""; drawLayoutPicker(); },
        onFilterChange: (f) => { layoutFilter = f; drawLayoutPicker(); },
        onSelect: (v) => {
          layoutOpen = false; layoutFilter = "";
          layoutId = Number(v);
          drawLayoutPicker();
          relayout(sh.main.getBoundingClientRect()); savePrefs();
          (globalThis as unknown as { __layoutId?: number }).__layoutId = layoutId;
        },
      });
    };
    drawLayoutPicker();
    (globalThis as unknown as { __setLayout?: (id: number) => void; __layoutId?: number }).__setLayout = (id: number) => { layoutId = id; drawLayoutPicker(); relayout(sh.main.getBoundingClientRect()); savePrefs(); (globalThis as unknown as { __layoutId?: number }).__layoutId = id; };
    (globalThis as unknown as { __layoutId?: number }).__layoutId = layoutId;
    sh.onMainResize((r) => relayout(r));

    // Restore the remembered layout and split. After onMainResize, so the first relayout has run and
    // there is something to restore ONTO.
    openSettings().then((store) => {
      settings = store;
      const known = new Set(layoutList().map((l) => l.id));
      for (const l of layoutList()) {
        const at = store.getNumber("Layout", `split.${l.id}`, NaN);
        if (at > 0.1 && at < 0.9) splits.set(l.id, at);      // NaN fails both, as it should
      }
      const id = store.getBool("Launch", "restoreLayout", SETTING_DEFAULTS.Launch.restoreLayout) ? store.getNumber("Layout", "id", DEFAULT_LAYOUT) : DEFAULT_LAYOUT;
      if (known.has(id)) { layoutId = id; drawLayoutPicker(); }
      relayout(sh.main.getBoundingClientRect());
      (globalThis as unknown as { __layoutId?: number }).__layoutId = layoutId;
    }).catch((e) => {
      // Preferences are a convenience, but a PROGRAMMING error in here is not, and this catch used
      // to swallow both alike. It hid a stale `sel.value` — left behind when the layout <select>
      // became a picker — so the saved layout, the saved splits and the FIRST relayout were all
      // skipped in silence. The window came up unconfigured and only sorted itself out when a resize
      // happened to fire the ResizeObserver. Ron: "albula came up but was not configured. When I
      // resize it configures."
      console.error("[layout preferences]", e);
      relayout(sh.main.getBoundingClientRect());   // the layout must be applied either way
    });
    sh.registerPanel({
      id: "welcome",
      title: "Welcome",
      order: 0,
      tip: "What this application is and how to start",
      help: `<p>What Albula is, what you can do with it, and where to start.</p>`,
      // No acknowledgments here: this belongs to the APPLICATION, not to the Welcome module, and
      // app-shell already prints it under every module's Help & Acknowledgment. Putting it here too
      // printed it twice on this panel.
      mount(el) {
      // SLICER'S OWN WORDS, not a paraphrase. Ron: "for the not intended for clinical use: Use what the
      // popup says in slicer". The second sentence it had, "Slicer is NOT an FDA approved medical
      // device", was removed on 2026-10-02 -- Ron: Albula is used in other countries, and the label
      // "shouldn't build in one country's law" (docs/CONSTRAINTS.md). The upstream sources:
      //
      //   CMake/SlicerApplicationOptions.cmake -- the startup popup default:
      //     "Thank you for using %1!<br><br>This software is not intended for clinical use."
      //   Base/QTCore/qSlicerCoreApplication.cxx -- acknowledgment(), whose first sentence is the one
      //     used here. The rest of that string is a funder list and it is NOT reproduced: most of
      //     those programs have ended, so copying it would credit support that no longer exists.
      //     Funding is stated once, in the README, and no funder is named or characterized anywhere
      //     else. See docs/CONSTRAINTS.md.
      //
      // The popup's "Thank you for using %1!" greeting is framing the heading below already does. So
      // what is kept is the statement.
      //
      // Large and ABOVE the heading rather than in a footnote: this renders real patient studies
      // convincingly enough that someone could reach for it at the wrong moment, and a disclaimer
      // that has to be scrolled to is not one. A standing requirement, see docs/CONSTRAINTS.md.
      //
      // AND THE REST WRITTEN FOR A CLINICAL READER. Ron, on what was here: "not useful for a user
      // with biology or clinical background." It was: it described which modules had been PORTED, a
      // headless ModuleServer appearing "as a peer", and a `?legacy` URL. All true, all about the
      // implementation, and none of it answers what the thing does or what to do next.
      //
      // So: what it is, what you can do with it, and how to start -- in that order. The developer
      // detail is not deleted, it is demoted into a collapsed section, because it is still the right
      // answer for the person who needs it.
      el.innerHTML = `<p class="sl-not-clinical">This software is not intended for clinical use.</p>
        <div class="sl-welcome-logo" role="img" aria-label="SlicerAlbula"></div>
        <p><button class="sl-primary" data-act="welcome-load" title="Opens Load / Save: the DICOM database, saved scenes, or files from disk">Load data…</button>
          <button data-act="welcome-keys" title="The keyboard shortcuts, as in 3D Slicer, in a small window">Keyboard shortcuts…</button></p>
        <h2>SlicerAlbula</h2>
        <p>A viewer for medical images and their segmentations. It reads studies from a DICOM
        database, runs automatic segmentation on them, and shows the result as slices and in
        3D &mdash; on this machine, on its own graphics card, with nothing sent anywhere.</p>

        <h3>What you can do in Albula</h3>
        <ul>
          <li><b>Open a case</b> from a DICOM database (Load / Save). Scans from a disc, a USB stick or
              an export go into a database in one step, and so does a scene packaged on another computer
              (a folder ending in <i>.albula</i>). NRRD and NIfTI files open too.</li>
          <li><b>Segment it automatically</b> &mdash; TotalSegmentator, MOOSE and others (AI
              Segmentations) &mdash; or <b>by hand</b>: paint, erase, threshold, grow from seeds, or
              click on a structure to outline it (Segment Editor).</li>
          <li><b>Read the result</b>: every structure named and grouped by anatomy, following
              <i>Terminologia Anatomica</i>, so a 111-structure body scan is a tree you can open
              rather than a list you have to search.</li>
          <li><b>See it in 3D</b>: the anatomy solid, as an illustration or realistic, straight from
              its segmentation; the scan itself as a volume rendering; vessels inside their organs.
              With VITURE glasses plugged in, the VR/AR button in the 3D view shows it in the glasses, following your head.</li>
          <li><b>Point at anything</b> and the probe names it, in the slices and in 3D, with the
              image value at that point. <b>Mark and measure</b> with points, lines, angles,
              curves, closed curves, boxes and name cards (Markups).</li>
          <li><b>Play a time series</b>: a gated cardiac CT as a beating heart (Sequences).</li>
          <li><b>Diffusion MRI</b> of a brain tumor patient: the nerve fiber tracts near the tumor,
              named (Diffusion).</li>
          <li><b>Keep it</b>: save to the DICOM database &mdash; segmentations recorded as made from
              the scan they came from &mdash; or as files; save the scene, so a case comes back as it
              was on screen; package a scene to take it to another computer.</li>
        </ul>

        <h3>Views and navigation</h3>
        <p>Three slice views and one 3D view. <b>Wheel</b> scrolls through slices,
        <b>drag</b> orbits the 3D view, <b>shift + move</b> puts the crosshair where the pointer is.
        Each view has its own controls along the top, and the gear in the 3D view sets lighting and
        what the scene shows.</p>

        <h3>The name</h3>
        <p>The <a href="https://en.wikipedia.org/wiki/Albula_Pass">Albula Pass</a> joins the Rhine
        valley to the Engadin. Mules crossed it in Roman times, grain and wine going up and cheese,
        honey and hides coming back, and the bishops of Chur took a toll on it for centuries. What
        prevented the building of a road was never the summit: it was the gorge below Bergün, first
        blasted open with gunpowder in 1695. The railway of 1903 goes through the mountain instead. The road in the
        logo leads to that pass.</p>

        <details class="sl-welcome-dev"><summary>For developers</summary>
          <p>Albula is built on Steve Pieper's SlicerLive: the scene and its views come from there, and
          everything is drawn with WebGPU on this computer's graphics card. Its server is written for
          Deno. The source is on GitHub: <a href="https://github.com/rkikinis/SlicerAlbula">rkikinis/SlicerAlbula</a>
          (the workspace), the <i>albula</i> branch of <a href="https://github.com/rkikinis/SlicerLive/tree/albula">rkikinis/SlicerLive</a>
          (the application), and <a href="https://github.com/rkikinis/albula-diffusion">rkikinis/albula-diffusion</a>
          (the diffusion extension). The published copies are updated from time to time, so they can be a little behind this application.</p>
        </details>`;
      // THE FIRST THING ANYONE WANTS, on the first panel they see. Ron: "I would like to minimize the
      // clicks and travel distance with the mouse. Put a button Load data to scene on the welcome
      // module." Reaching data used to mean finding "Add data to the scene" in the module selector.
      // AND IT SITS UNDER THE LOGO, not at the foot of the panel, so that it lands just below where
      // Load Data's "DICOM database…" button appears after the click: the next click is a short
      // move up, not a trip across the window (docs/RULES-3-AND-4-MEASURED.md had 934 px for the
      // old position). Just below rather than on top of it, so nobody opens the database by
      // double-clicking here. Ron: "closer to the one in add data but not overlapping."
      el.querySelector('[data-act="welcome-load"]')?.addEventListener("click", () => void sh.showPanel("add-data"));
      // THE SHORTCUTS, in a small window from here (Ron, 2026-09-25: "there should be a popup somewhere for shortcuts.
      // Again, space is at premium. Perhaps delegate to the welcome module?"). Slicer's own keys, ⌘ on a Mac.
      el.querySelector('[data-act="welcome-keys"]')?.addEventListener("click", () => {
        const { box } = openFloatingWindow({ title: "Keyboard shortcuts", size: { w: 460, h: 260 } });
        const body = document.createElement("div"); body.style.cssText = "padding:10px 14px;overflow:auto;";
        body.innerHTML = `<table class="sl-keys"><tr><th></th><th>Key</th><th>In 3D Slicer</th></tr>${SHORTCUTS.map((k) =>
          `<tr><td>${k.what}</td><td class="sl-kbd">${keyLabel(k.key, k.shift)}</td><td>${k.slicer}</td></tr>`).join("")}</table>
          <p class="sl-hint">The same keys as 3D Slicer, which writes them with Ctrl; on a Mac that is ⌘. The menus show each key beside its item.</p>`;
        box.appendChild(body);
      });
    } });
    // W1: local data — chunks from files are served to the DisplayableManagers like any other blob
    // A HIDDEN PAGE KEEPS ITSELF AWAKE (render/demos/keep-awake.ts): silence on a loop while
    // hidden, so WebKit never lowers this process's memory limit to 4 GB.
    keepPageAwakeWhileHidden((why) => status(`Note: ${why}.`));
    // SAY WHEN THE PAGE WAS RESTARTED, AND WHAT WAS LOST. WebKit ends a page that has been hidden
    // for eight minutes and holds more than 4 GB (its limit for an inactive process; 16 GB for a
    // visible one); the shell reloads the page and the user comes back to a fresh Welcome with no
    // word of why. Ron, 2026-09-14, after a
    // 6-minute CADS run: "I was multitasking and was on a different desktop" -- the result was
    // computed, then the page was gone. sessionStorage survives a reload of the same page and not
    // a relaunch, so a record here at startup means exactly a restart. Data in the database is
    // safe; a finished run is a checkpoint (Recent results -> Restore); what was merely loaded is
    // named so it can be loaded again.
    let restoreAfterReload: { doc: Record<string, unknown>; notSaved: string[]; scene?: unknown } | null = null;
    try {
      const prev = sessionStorage.getItem("albula-page");
      const chosen = sessionStorage.getItem("albula-reload-chosen");
      sessionStorage.removeItem("albula-reload-chosen");
      if (prev && chosen !== null) {
        // Reloaded on purpose, from "The views have stopped drawing": said as that, with what was loaded.
        const { loaded } = JSON.parse(prev) as { loaded: string[] };
        const kept = sessionStorage.getItem("albula-restore-scene");
        sessionStorage.removeItem("albula-restore-scene");
        restoreAfterReload = kept ? JSON.parse(kept) as { doc: Record<string, unknown>; notSaved: string[]; scene?: unknown } : null;
        const notSaved = restoreAfterReload?.notSaved ?? [];
        status(`Reloaded after the views stopped drawing (${chosen}). ${restoreAfterReload ? "Putting back what was on screen" : `What was loaded: ${loaded.join("; ") || "nothing"}`}${notSaved.length ? `; not saved, so not put back: ${notSaved.join("; ")}` : ""}.`);
        if (!restoreAfterReload || notSaved.length) void sh.confirm({
          title: "The window was reloaded",
          ok: "OK", cancel: restoreAfterReload ? "" : "Load data",
          body: restoreAfterReload
            ? `<p>The window was reloaded after the views stopped drawing (<b>${chosen}</b>), and what was on screen is being loaded again.</p>
              <p>Not put back, because it was never saved: ${notSaved.map((n) => `<b>${n}</b>`).join(", ")}.</p>
              <p class="sl-hint">A finished AI run is kept as a temporary copy under AI Segmentations → Recent results → Restore.</p>`
            : `<p>You reloaded the window after the views stopped drawing (<b>${chosen}</b>). Everything that was only in the window is gone.</p>
              <p>What was loaded: ${loaded.length ? loaded.map((n) => `<b>${n}</b>`).join(", ") : "nothing"}.</p>
              <p class="sl-hint">Anything saved to the DICOM database is unaffected. A finished AI run is kept as a temporary copy under AI Segmentations → Recent results → Restore.</p>`,
        }).then((ok) => { if (!ok && !restoreAfterReload) void sh.showPanel("add-data"); });
      } else if (prev && sessionStorage.getItem("albula-left") === null) {
        const { at, loaded, start, hidden, gpuMB } = JSON.parse(prev) as { at: string; loaded: string[]; start?: string; hidden?: boolean; gpuMB?: number };
        const when = new Date(at);
        // `at` IS THE LAST DATA CHANGE, NOT THE START OF THE WINDOW. Reporting it as "it had been
        // running N minutes" said "0 minutes" for a window that had been open for hours and had
        // just loaded something (Ron, 2026-09-22). Both numbers are kept now, and the sentence
        // does not claim a cause the record cannot support: the window that died on 09-22 was on
        // screen and out of memory, not hidden for eight minutes.
        const open = Math.round((Date.now() - new Date(start ?? at).getTime()) / 60000);
        const ago = Math.round((Date.now() - when.getTime()) / 60000);
        const why = hidden
          ? "It was hidden (minimized, or the application hidden) — WebKit ends a hidden page that holds a lot of memory after about eight minutes."
          : "It was on screen, so this was the memory limit itself: a page holding much more than 4 GB is ended whatever it is doing.";
        const held = gpuMB ? ` Its colorized volumes alone held about ${gpuMB >= 1024 ? `${(gpuMB / 1024).toFixed(1)} GB` : `${gpuMB} MB`}.` : "";
        status(`The window was reset at ${new Date().toLocaleTimeString()} — the page process ended out of memory${hidden ? " while hidden" : " while on screen"}${gpuMB ? `, with ${gpuMB} MB in colorized volumes` : ""}; open ${open} min, last change ${ago} min before. What was loaded (${loaded.length}): ${loaded.join("; ") || "nothing"}. Saved data is unaffected; a finished run is under AI Segmentations → Recent results.`);
        void sh.confirm({
          title: "The window was reset",
          ok: "OK", cancel: "Load data",
          body: `<p>The page process ended and was restarted, and everything that was only in the window is gone. ${why}${held}</p>
            <p class="sl-hint">The window had been open ${open} minute${open === 1 ? "" : "s"}; the last thing loaded or changed was ${ago} minute${ago === 1 ? "" : "s"} ago.</p>
            <p>What was loaded: ${loaded.length ? loaded.map((n) => `<b>${n}</b>`).join(", ") : "nothing"}.</p>
            <p class="sl-hint">Anything saved to the DICOM database is unaffected. A finished AI run is kept as a temporary copy under AI Segmentations → Recent results → Restore.</p>`,
        }).then((ok) => { if (!ok) void sh.showPanel("add-data"); });
      }
    } catch { /* no storage: nothing to say */ }
    // A PAGE THAT LEFT ON ITS OWN SAID GOODBYE. A process the system ends never runs `pagehide`; a reload,
    // a navigation or a quit does -- and every one of those was reported as "The window was reset … the
    // memory limit itself" (seen in the test browser, 2026-09-24, after a plain reload). The mark is
    // cleared at each start, so it speaks only for the page just before this one.
    try { sessionStorage.removeItem("albula-left"); } catch { /* no storage */ }
    addEventListener("pagehide", () => { try { sessionStorage.setItem("albula-left", "1"); } catch { /* no storage */ } });
    const pageStart = new Date().toISOString();
    const notePage = () => {
      try {
        const loaded = [...views.live.nodes.values()].filter((n) => (n.type === "image" || n.type === "segmentation") && !(n as { hidden?: boolean }).hidden).map((n) => String(n.name ?? n.id));
        const g = globalThis as unknown as { __gpuMB?: number };
        sessionStorage.setItem("albula-page", JSON.stringify({
          at: new Date().toISOString(),
          start: pageStart,                                  // when THIS page began, kept across updates
          hidden: document.visibilityState === "hidden",     // which of the two limits it hit
          gpuMB: g.__gpuMB ?? 0,                             // what it was holding when last measured
          loaded,
        }));
      } catch { /* private mode */ }
    };
    notePage();
    let noteTimer = 0;
    views.live.subscribe((c) => { if (c.type === "image" || c.type === "segmentation" || c.kind === "remove" || c.kind === "reset") { clearTimeout(noteTimer); noteTimer = setTimeout(notePage, 500) as unknown as number; } });
    registerLoadPanel(sh, { live: views.live, store, onStatus: status, onLoaded: (i) => { views.fitVolume(i.rasLo, i.rasHi, i.ijkToRAS); (globalThis as unknown as { __lastLoad?: unknown }).__lastLoad = i; } });
    // What was on screen before a chosen reload, loaded back (see "AND WHAT WAS ON SCREEN COMES BACK").
    if (restoreAfterReload) {
      const { doc, scene } = restoreAfterReload;
      void (async () => {
        const g = globalThis as unknown as { __loadSceneDoc?: (d: Record<string, unknown>) => Promise<{ ok: boolean; loaded?: number; seconds?: number; error?: string }>; __setCurrentScene?: (s: unknown) => void };
        // The loader exists once the Load panel has mounted -- the same step __openScene takes.
        for (let i = 0; i < 50 && !(globalThis as unknown as { __setCurrentScene?: unknown }).__setCurrentScene; i++) await new Promise((r) => setTimeout(r, 100));
        if (!g.__loadSceneDoc) { const was = sh.activePanel(); await sh.showPanel("add-data"); await new Promise((r) => setTimeout(r, 50)); if (was) void sh.showPanel(was); }
        const r = await g.__loadSceneDoc?.(doc).catch((e) => ({ ok: false, error: String((e as Error)?.message ?? e) }));
        // THE SAME SAVED SCENE, if it was one: the next Save scene is its next version, not a copy.
        if (r?.ok && scene) g.__setCurrentScene?.(scene);
        status(r?.ok ? `Put back what was on screen before the reload: ${r.loaded ?? 0} series in ${(r.seconds ?? 0).toFixed(1)} s.` : `What was on screen could not be put back: ${r?.error ?? "the scene loader was not ready"}. Load data or Load scene… brings it back.`);
      })();
    }
    registerSampleDataPanel(sh, { onStatus: status });
    registerVolumesPanel(sh, { live: views.live, onStatus: status });
    registerTfEditor(sh, { live: views.live, onStatus: status });
    registerMarkupsPanel(sh, { live: views.live, onStatus: status });
    registerCropPanel(sh, { live: views.live, store, status });
    registerSegEditorPanel(sh, { live: views.live, store, onStatus: status });
    registerTransformsPanel(sh, { live: views.live, onStatus: status });
    // One player for the scene; its transport lives in the top bar, in every module.
    const player = new SequencePlayer(views.live);
    mountSequenceToolbar(sh, { live: views.live, player });
    mountJobsLine(sh);   // the extensions' import-time work, while it runs (jobs-line.ts)
    registerSequencesPanel(sh, { live: views.live, player, onStatus: status });
    // Segmentations is WHAT YOU HAVE; AI segmentations is one way to make it. So the tree comes
    // first and the producer after, and Save last -- it saves what the tree lists.
    registerSegmentationsPanel(sh, { live: views.live, store, onStatus: status });
    // AI segmentations sits before Save: it produces something to save.
    registerAiSegPanel(sh, { live: views.live, store, onStatus: status });
    // EXTENSIONS' MODULES (render/demos/extension-modules.ts): whatever an extension queued, registered now, after the
    // app's own, with the same scene, store and status line -- and the graphics device, for their own GPU work.
    // Their status goes to the VISIBLE bar too: `status()` alone writes an element the native page hides (critic,
    // 2026-09-29, diffusion module, finding 6).
    registerQueuedModules({ shell: sh, live: views.live, store, device: gpu.device, status: (t: string) => { status(t); sh.setStatus(t); } });
    // The Save panes live in the Load / Save module (load-panel.ts) since 2026-09-22.
    (globalThis as unknown as { __renderSavePane?: typeof renderSavePane }).__renderSavePane = renderSavePane;
      /**
   * WHOSE IS THIS VOLUME? Asked once, when a volume that came from a file is saved to DICOM. The
   * name and the ID default to the file's name; the kind of image is guessed from the values
   * (Hounsfield-looking is CT) and can be changed. Nothing is written until the person says so.
   */
  const askSubjectFor = (img: MrsonNode): Promise<ExportSubject | null> => new Promise((resolve) => {
    const org = (img.origin as Record<string, unknown> | undefined) ?? {};
    const from = String(org.fileName ?? org.file ?? org.sample ?? img.name ?? "a file");
    const base = from.replace(/\.(nii\.gz|nii|nrrd|nhdr|gz)$/i, "").slice(0, 64) || "volume";
    // The observed range lives on the display node's threshold (ingest.ts), as applyVrPreset
    // reads it; a sample says its modality itself. (Critic, finding 4: the guess read fields that
    // do not exist and offered every CT as MR.)
    const dispNode = [...views.live.nodes.values()].find((n) => n.type === "scalarVolumeDisplay" && ((img.refs as Record<string, string[]> | undefined)?.display ?? []).includes(n.id));
    const range = dispNode?.threshold as [number, number] | undefined;
    const sampleModality = typeof org.sample === "string" ? SAMPLE_DATA.find((d) => d.name === org.sample)?.modality : undefined;
    const guess = sampleModality ?? (looksLikeHounsfield(range, org.modality as string | undefined) ? "CT" : "MR");
    // A UNIQUE ID BY DEFAULT: two subjects' T1.nrrd must not become one patient, and the sample's
    // file name must not land a stranger's study under an existing patient (critic, finding 9).
    const now = new Date(); const p2 = (n: number) => String(n).padStart(2, "0");
    const idDefault = `${base}-${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const back = document.createElement("div"); back.className = "sl-modal-back";
    const box = document.createElement("div"); box.className = "sl-modal";
    box.innerHTML = `<h3>Save this volume to the DICOM database</h3>
      <div class="sl-modal-body">
        <p>It came from <b>${esc(from)}</b>, not from the DICOM database. To keep it there it needs a patient and a study of its own.</p>
        <p class="sl-row"><label style="flex:0 0 120px">Patient name</label><input class="sl-subj-name" style="flex:1" value="${esc(base)}"></p>
        <p class="sl-row"><label style="flex:0 0 120px">Patient ID</label><input class="sl-subj-id" style="flex:1" value="${esc(idDefault)}" title="Unique by default (the file's name and the time). Type an existing ID to add this study to that patient."></p>
        <p class="sl-row"><label style="flex:0 0 120px">Study</label><input class="sl-subj-study" style="flex:1" value="Loaded from ${esc(from)}"></p>
        <p class="sl-row"><label style="flex:0 0 120px">Kind of image</label><select class="sl-subj-mod"><option${guess === "MR" ? " selected" : ""}>MR</option><option${guess === "CT" ? " selected" : ""}>CT</option><option>PT</option><option>NM</option></select></p>
        <p class="sl-hint">The file's name goes into the patient's comments, so the series says where it came from.</p>
      </div>
      <div class="sl-row sl-modal-actions"><button class="sl-subj-cancel">Cancel</button><button class="sl-primary sl-subj-ok">Save to DICOM</button></div>`;
    back.appendChild(box); document.body.appendChild(back);
    const v = (c: string) => (box.querySelector(c) as HTMLInputElement | HTMLSelectElement).value;
    const done = (ok: boolean) => {
      const sub: ExportSubject | null = ok ? { patientName: v(".sl-subj-name").trim() || base, patientID: v(".sl-subj-id").trim() || idDefault, comments: `Loaded from ${from}`, studyDescription: v(".sl-subj-study").trim() || `Loaded from ${from}`, modality: v(".sl-subj-mod") } : null;
      back.remove(); document.removeEventListener("keydown", key); resolve(sub);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
    document.addEventListener("keydown", key);
    box.querySelector(".sl-subj-cancel")!.addEventListener("click", () => done(false));
    box.querySelector(".sl-subj-ok")!.addEventListener("click", () => done(true));
    (box.querySelector(".sl-subj-name") as HTMLInputElement).focus();
  });
Object.assign(globalThis, {
      // A sequence's frames: the one on screen stands for it, as in the Scene list (five rows of
      // one series were a list to get lost in, and the frames came from the database anyway).
      // WHAT IS SHOWN IN 3D, for Save › Files › "Everything shown in 3D" (Ron, 2026-10-22): the segmentations the solid
      // look DRAWS, read from its own list (critic 2026-10-22, finding 6: the same test written again here missed a third
      // voxel grid, more than 255 structures on a scan, and opacity 0) -- a series by its current frame only -- each with
      // the structures it shows (visible, opacity above 0).
      __segmentationsShownIn3D: () => {
        const current = currentFrames(views.live);
        const drawn = new Set(((globalThis as unknown as { __solidGroups?: () => { segmentations: string[] }[] }).__solidGroups?.() ?? []).flatMap((gr) => gr.segmentations));
        return [...views.live.nodes.values()]
          .filter((n) => n.type === "segmentation" && drawn.has(n.id as string) && (!n.sequence || current.has(n.id)))
          // Structures SHOWN, strictly: a segmentation whose structures are all hidden shows nothing (structuresToExport's
          // "all when none is shown" is for a file of one segmentation, asked for by name).
          .map((n) => ({ id: n.id as string, structures: ((n.segments as (ExportSegment & { opacity?: number })[] | undefined) ?? []).filter((sg) => sg.labelValue > 0 && sg.labelValue < 256 && sg.visible !== false && (sg.opacity ?? 1) > 0).length }))
          .filter((x) => x.structures > 0);
      },
      __savableNodes: () => {
        const current = currentFrames(views.live);
        return [...views.live.nodes.values()]
          .filter((n) => (n.type === "image" || n.type === "segmentation") && n.zarr && (!n.sequence || current.has(n.id)))
          .map((n) => ({ id: n.id, name: current.get(n.id) ?? n.name as string, type: n.type }));
      },
      /**
       * Write a segmentation back out as DICOM SEG, beside the images it was drawn on.
       *
       * THE SAFE ROUTE, chosen deliberately: this writes a FILE and does not touch ctkDICOM.sql.
       * Inserting rows into a SQLite index Slicer may have open, for a database holding ~18 GB of
       * patient imaging, is a bad trade for saving a click -- so the SEG lands in a folder inside the
       * database directory and Slicer's own DICOM Import does the indexing, with the code that owns
       * it. Ron: "Lets go the safe route. Automate so there is as little clicking as absolutely
       * needed."
       *
       * As little clicking as possible means: no file dialog. The database folder is already granted
       * (that is how the volume was loaded), so the file goes into a subfolder of it -- at most one
       * permission prompt the first time, because reading a folder does not carry the right to write
       * to it. With no granted folder at all it falls back to an ordinary download.
       */
      // The AI module's after-the-run dialog. Same function as the Save panel: see saveSegmentation.
      __exportSegAsDicom: (id: string) => saveSegmentation(views.live, id, status),
      // THE SEGMENT EDITOR'S SAVE (seg-editor-panel.ts; Ron, 2026-09-25). Never over the original: the first save of an
      // edited segmentation writes a new series "…, edited <date time>"; later saves update THAT copy (the older copy is
      // removed from the database -- unless a saved scene lists it, then it stays and is said); "Save as a new series"
      // keeps the copy and writes another. Only copies this window wrote are ever removed.
      __saveEditedSegmentation: async (id: string, o: { asNew?: boolean } = {}) => {
        const live = views.live;
        const n = live.nodes.get(id);
        if (!n) return { ok: false, error: "no such segmentation" };
        const org = ((n.origin as Record<string, unknown> | undefined) ?? {});
        const priorCopy = typeof org.editedCopy === "string" ? org.editedCopy : "";
        const original = (org.editedFrom as string | undefined) ?? (org.savedSeriesInstanceUID as string | undefined) ?? (org.seriesInstanceUID as string | undefined) ?? "";
        const fresh = !original && !priorCopy;            // made in the editor: saved under its own name, updated later
        const p2 = (x: number) => String(x).padStart(2, "0");
        const d = new Date();
        const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
        const base = String(n.name ?? "Segmentation").replace(/, edited \d{4}-\d\d-\d\d \d\d:\d\d$/, "");
        const name = fresh ? base : `${base}, edited ${stamp}`;
        live.write({ op: "patch", id, path: "#/name", value: name });
        const saved = await saveSegmentation(live, id, status) as { indexed?: boolean; dbId?: string; note?: string };
        const after = live.nodes.get(id);
        const newUid = ((after?.origin as Record<string, unknown> | undefined)?.savedSeriesInstanceUID as string | undefined) ?? "";
        if (saved.indexed === false || !newUid) return { ok: false, error: saved.note ?? "the segmentation was not saved" };
        live.write({ op: "patch", id, path: "#/origin", value: { ...((after?.origin as Record<string, unknown>) ?? {}), editedCopy: newUid, ...(original ? { editedFrom: original } : {}) } });
        const dbs = await fetch("/_db", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { databases?: { id: string; current?: boolean; exists?: boolean }[] } | null;
        const dbId = saved.dbId ?? (dbs?.databases ?? []).find((x) => x.current && x.exists)?.id ?? "";
        // WHERE IT CAME FROM, in the provenance store beside the file (source "albula").
        if (original && dbId) void fetch(`/_db/${encodeURIComponent(dbId)}/_attribute`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: newUid, key: "editedFrom", value: original, source: "albula" }) }).catch(() => {});
        let kept: string | undefined;
        if (priorCopy && !o.asNew && priorCopy !== newUid && dbId) {
          // A saved scene that lists the older copy would lose it: keep it then, and say which scene.
          const list = await fetch(`/_db/${encodeURIComponent(dbId)}/_scenes`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({ scenes: [] })) as { scenes?: { uid: string; name: string }[] };
          let usedBy = "";
          for (const sc of list.scenes ?? []) {
            const doc = await fetch(`/_db/${encodeURIComponent(dbId)}/_scene/${encodeURIComponent(sc.uid)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { nodes?: Record<string, { dicom?: { seriesInstanceUID?: string } }> } | null;
            if (Object.values(doc?.nodes ?? {}).some((x) => x.dicom?.seriesInstanceUID === priorCopy)) { usedBy = sc.name; break; }
          }
          if (usedBy) kept = `the earlier copy stays: the scene “${usedBy}” uses it`;
          else {
            await fetch(`/_db/${encodeURIComponent(dbId)}/_series/${encodeURIComponent(priorCopy)}`, { method: "DELETE" }).catch(() => {});
            kept = "the earlier copy was replaced";
          }
          (globalThis as unknown as { __refreshDicomDb?: () => Promise<number | null> }).__refreshDicomDb?.();
        }
        return { ok: true, name, kept };
      },
      /** A scene-only volume into the DICOM database as its own series — see exportVolumeAsDicom. */
      __exportVolumeAsDicom: (id: string) => exportVolumeAsDicom(views.live, id, status, askSubjectFor),
      /** Does this volume descend from a series in the DICOM database? What the offer to save one
       *  hangs on: without an ancestor there is no study to attach it to. */
      __dicomAncestorOf: (id: string) => {
        let n = views.live.nodes.get(id);
        const seen = new Set<string>();
        while (n && !(n.origin as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID) {
          const next = ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
          if (!next || seen.has(next)) return null;
          seen.add(next);
          n = views.live.nodes.get(next);
        }
        return n ? { id: n.id, name: n.name as string, seriesInstanceUID: (n.origin as { seriesInstanceUID?: string }).seriesInstanceUID } : null;
      },
      __exportNode: async (id: string, format: string, opts?: { closed?: boolean }) => {
        // EVERYTHING SHOWN IN 3D, one STL or OBJ (Ron, 2026-10-22).
        if (id === EVERYTHING_3D && (format === "stl" || format === "obj")) {
          const shown = ((globalThis as unknown as { __segmentationsShownIn3D?: () => { id: string }[] }).__segmentationsShownIn3D?.() ?? []).map((x) => x.id);
          const f = await sceneSurfaceFile(views.live, shown, format, status, { closed: opts?.closed !== false });
          const where = await toDownloads(f.filename, f.chunks, f.mime);
          return { filename: where.name, size: f.size, note: `${f.note}${where.path ? ` · in ${where.path}` : ""}` };
        }
        const n = views.live.nodes.get(id);
        if (n?.type === "segmentation" && format === "dicom-seg") return await saveSegmentation(views.live, id, status);
        // SURFACE MODELS, MADE FOR THIS SAVE (render/surface-export.ts; Ron, 2026-10-21, option B). "STL (the surfaces)"
        // fell through to the .seg.nrrd below and saved one, named .seg.nrrd: there was no STL writer.
        if (n?.type === "segmentation" && (format === "stl" || format === "obj")) {
          const f = await surfaceFile(views.live, id, format, status, { closed: opts?.closed !== false });
          const where = await toDownloads(f.filename, f.chunks, f.mime);
          return { filename: where.name, size: f.size, note: `${f.note}${where.path ? ` · in ${where.path}` : ""}` };
        }
        if (n?.type === "segmentation" && format !== "nrrd" && format !== "nrrd-gz") throw new Error(`a segmentation cannot be saved as "${format}"`);
        // With the question "whose is it?" for a volume from a file, as Crop and Save scene ask (A14).
        if (n?.type === "image" && format === "dicom") return await exportVolumeAsDicom(views.live, id, status, askSubjectFor);
        const r = n?.type === "segmentation" ? await exportSegmentation(views.live, id, format === "nrrd-gz" ? "nrrd-gz" : "nrrd") : await exportVolume(views.live, id, format as ExportFormat);
        const where = await toDownloads(r.filename, [r.bytes], r.mime);
        return { filename: where.name, size: r.bytes.byteLength, ...(where.path ? { note: `in ${where.path}` } : {}) };
      },
    });
    {
      let tfSeq = 0;
      const L = views.live;
      const nodeTransform = (nodeId: string): string | null => ((L.nodes.get(nodeId)?.refs as Record<string, string[]> | undefined)?.transform ?? [])[0] ?? null;
      Object.assign(globalThis, {
        __createTransform: () => { const id = `local-transform-${++tfSeq}`; L.write({ op: "put", id, node: { type: "transform", id, name: `Transform ${tfSeq}`, matrix: IDENTITY4.slice(), refs: {}, source: { mrmlClass: "vtkMRMLLinearTransformNode" }, origin: { local: true } } }); return id; },
        __applyTransformTo: (nodeId: string, transformId: string) => { const n = L.nodes.get(nodeId); if (!n) return; L.write({ op: "patch", id: nodeId, path: "#/refs", value: { ...(n.refs as Record<string, unknown> ?? {}), transform: [transformId] } }); },
        __translateTransform: (transformId: string, dx: number, dy: number, dz: number) => { const t = L.nodes.get(transformId); if (!t) return; L.write({ op: "patch", id: transformId, path: "#/matrix", value: withTranslation(t.matrix as number[], [dx, dy, dz]) }); },
        __identityTransform: (transformId: string) => L.write({ op: "patch", id: transformId, path: "#/matrix", value: IDENTITY4.slice() }),
        __transforms: () => [...L.nodes.values()].filter((n) => n.type === "transform").map((n) => ({ id: n.id, name: n.name, matrix: n.matrix as number[] })),
        __nodeTransform: nodeTransform,
        __nodeWorldMatrix: (nodeId: string) => worldMatrix(nodeTransform(nodeId) ?? undefined, L.nodes),
        __hardenTransform: (nodeId: string) => {
          const n = L.nodes.get(nodeId); const tid = nodeTransform(nodeId); if (!n || !tid) return;
          const world = worldMatrix(tid, L.nodes);
          // A hardened volume is no longer the series it was read from: its geometry changed, so it is saved as
          // a new series (critic, review-bugfixes finding 5).
          if (n.type === "image") { L.write({ op: "patch", id: nodeId, path: "#/ijkToRAS", value: hardenImageIjkToRAS(n.ijkToRAS as number[], world) }); L.write({ op: "patch", id: nodeId, path: "#/origin", value: { ...(n.origin as Record<string, unknown> ?? {}), hardened: true } }); }
          else if (n.type === "markup") { const cps = ((n.controlPoints as { position: [number, number, number] }[]) ?? []); const moved = hardenPoints(cps.map((c) => c.position), world); L.write({ op: "patch", id: nodeId, path: "#/controlPoints", value: cps.map((c, i) => ({ ...c, position: moved[i] })) }); }
          const refs = { ...(n.refs as Record<string, unknown> ?? {}) }; delete (refs as Record<string, unknown>).transform; L.write({ op: "patch", id: nodeId, path: "#/refs", value: refs });
        },
      });
    }
    Object.assign(globalThis, {
      __createSegmentation: (srcId: string, name?: string) => createSegmentation(views.live, store, srcId, name ? { name } : {}),
      __addSegment: (segId: string) => addSegment(views.live, segId),
      __applyEffect: (segId: string, effect: string, params: Record<string, unknown>) => applyEffect(views.live, store, segId, effect as Parameters<typeof applyEffect>[3], params as Parameters<typeof applyEffect>[4]),
      __segmentations: () => [...views.live.nodes.values()].filter((n) => n.type === "segmentation").map((n) => ({ segId: n.id, name: n.name, segments: (n.segments ?? []) })),
      __setSegmentProp: (segId: string, labelValue: number, prop: string, value: unknown) => { const n = views.live.nodes.get(segId); if (!n) return; const segs = ((n.segments as { labelValue: number }[]) ?? []).map((s) => s.labelValue === labelValue ? { ...s, [prop]: value } : s); views.live.write({ op: "patch", id: segId, path: "#/segments", value: segs }); if (prop === "name") markEdited(views.live, segId); },
      __segmentStats: (segId: string) => computeStats(views.live, segId),
      __setSegTool: (segId: string, tool: string, params: { diameterMm?: number; sphere?: boolean; segment?: number }) => {
        const id = "local-segmentEditor";
        const node = { type: "segmentEditor", id, name: "Segment Editor", activeEffect: tool, selectedSegmentId: params.segment ?? 1, params: { BrushAbsoluteDiameter: String(params.diameterMm ?? 8), BrushSphere: params.sphere ? "1" : "0" }, refs: { segmentation: [segId] }, origin: { local: true } };
        if (views.live.nodes.has(id)) { views.live.write({ op: "patch", id, path: "#/activeEffect", value: tool }); views.live.write({ op: "patch", id, path: "#/selectedSegmentId", value: params.segment ?? 1 }); views.live.write({ op: "patch", id, path: "#/params", value: node.params }); views.live.write({ op: "patch", id, path: "#/refs", value: { segmentation: [segId] } }); }
        else views.live.write({ op: "put", id, node });
      },
      __segTool: () => { const n = views.live.nodes.get("local-segmentEditor"); return n ? { activeEffect: n.activeEffect, diameterMm: Number((n.params as Record<string,string>)?.BrushAbsoluteDiameter ?? 8), sphere: (n.params as Record<string,string>)?.BrushSphere === "1" } : { activeEffect: "", diameterMm: 8, sphere: false }; },
    });
    registerSelfTest("volumes: auto W/L gives window>0 and level in range; presets + threshold + color table apply", async () => {
      const vol = await parseNifti(makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }), "wl-selftest");
      const r = await loadVolumeIntoScene(views.live, store, vol, { name: "wl-selftest" });
      const g = globalThis as unknown as { __volumeDisplay: (id: string) => { window: number; level: number; autoWindowLevel: boolean; applyThreshold: boolean; threshold: [number, number]; colorTableId: string } | null; __wlPreset: (id: string, n: string) => void; __setThreshold: (id: string, on: boolean, lo?: number, hi?: number) => void; __setColorTable: (id: string, t: string) => void };
      const d0 = g.__volumeDisplay(r.imageId); expect(!!d0 && d0.window > 0 && d0.autoWindowLevel, "auto W/L: window>0 and autoWindowLevel");
      g.__wlPreset(r.imageId, "CT Bone"); const dp = g.__volumeDisplay(r.imageId); expect(!!dp && dp.window === 1800 && dp.level === 400 && dp.autoWindowLevel === false, "CT Bone preset -> 1800/400, auto off");
      g.__setThreshold(r.imageId, true, 10, 90); const dt = g.__volumeDisplay(r.imageId); expect(!!dt && dt.applyThreshold && dt.threshold[0] === 10 && dt.threshold[1] === 90, "threshold applied");
      g.__setColorTable(r.imageId, "vtkMRMLColorTableNodeRainbow"); const dc = g.__volumeDisplay(r.imageId); expect(!!dc && dc.colorTableId === "vtkMRMLColorTableNodeRainbow" && views.live.nodes.has("vtkMRMLColorTableNodeRainbow"), "color table attached");
      // leave the scene as found
      const comps = [...views.live.nodes.values()].filter((n) => n.type === "sliceComposite");
      const others = [...views.live.nodes.values()].filter((n) => n.type === "image" && n.id !== r.imageId);
      for (const c of comps) views.live.write(others.length ? { op: "patch", id: c.id, path: "#/refs/background", value: [others[others.length - 1].id] } : { op: "del", id: c.id });
      for (const n of r.nodes) views.live.write({ op: "del", id: n.id });
    });
    registerSelfTest("ingest: a synthetic NIfTI becomes an image node the slices can show", async () => {
      const vol = await parseNifti(makeNifti({ sform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }), "selftest");
      const before = views.live.nodes.size;
      const r = await loadVolumeIntoScene(views.live, store, vol, { name: "selftest" });
      const img = views.live.nodes.get(r.imageId);
      expect(!!img && JSON.stringify(img.dims) === JSON.stringify(SYNTHETIC_DIMS), "image node missing or wrong dims");
      expect(views.live.nodes.size > before, "no nodes added");
      const comps = [...views.live.nodes.values()].filter((n) => n.type === "sliceComposite");
      expect(comps.length >= 3 && comps.every((c) => (c.refs as { background?: string[] }).background?.[0] === r.imageId), "composites do not point at the new volume");
      // put the previous background back so a mirrored scene is left as found
      const others = [...views.live.nodes.values()].filter((n) => n.type === "image" && n.id !== r.imageId);
      for (const c of comps) views.live.write(others.length ? { op: "patch", id: c.id, path: "#/refs/background", value: [others[others.length - 1].id] } : { op: "del", id: c.id });
      for (const n of r.nodes) views.live.write({ op: "del", id: n.id });
    });
    // THE DECODE IN A WORKER IS MEASURABLY SLOWER, so it is not installed. Built and tried on
    // 2026-09-22 (Ron: the decode was the largest single-threaded phase, so a worker was the
    // obvious move): the decode went from 3.6 s to 8.3 s for four segmentations and the whole load
    // from 11.8 s to 14.1 s, measured twice, the second time with dcmjs already loaded in the
    // worker so the one-off cost was not in it. The worker and its injection point stay for the
    // investigation of WHY -- the candidates are the UMD parser evaluated with `new Function`
    // (never JIT-warmed the way the page's copy is), the 418 MB transfer, and macOS scheduling a
    // worker on an efficiency core -- but an unexplained 2.3× is not shipped.
    //   setSegDecoder(decodeSegInWorker);
    //
    // A SWITCH, so the comparison is a one-liner rather than a rebuild: __useWorkerDecode(true)
    // turns the worker decoder on for the next load, and the decoder's own phase breakdown (parse ·
    // naturalize · place) comes back in the load's timings either way. Measured tonight and ruled
    // out as causes: a worker is NOT slower for sustained CPU work on this machine (377 ms against
    // 384 ms for the same loop), and handing back 418 MB costs 4-6 ms transferred against 122 ms
    // copied -- the code transfers. What is left to explain the 2.3x is the parser itself.
    Object.assign(globalThis, { __useWorkerDecode: (on: boolean) => setSegDecoder(on ? decodeSegInWorker : null) });
    setLoadTimers(span, spanSync);                 // and the labelmap's: read, upload, color, show
    setZarrTimings(noteMs);                        // and inside the read: gathering the chunks, unpacking them
    setIngestTimers(spanSync);                     // and inside the ingest: which part of it costs what
    warmAssemblyWorkers();                         // started now, so the first load finds them running
    sh.setStatus(wantPeer ? "SlicerLive — connected to ModuleServer" : "SlicerLive — native shell (standalone)");
    // theme self-tests: the dark theme keeps readable contrast and Slicer's view colours
    const rgb = (c: string) => { const m = c.match(/\d+(\.\d+)?/g) ?? []; return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0]; };
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (a: string, b: string) => { const la = lum(rgb(a)), lb = lum(rgb(b)); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const token = (name: string) => { const probe = document.createElement("span"); probe.style.color = `var(${name})`; document.body.appendChild(probe); const v = getComputedStyle(probe).color; probe.remove(); return v; };
    registerSelfTest("theme: text on surfaces meets WCAG AA (4.5:1)", () => {
      for (const [fg, bg] of [["--sl-fg", "--sl-surface"], ["--sl-fg", "--sl-surface-2"], ["--sl-fg", "--sl-bg"], ["--sl-accent-fg", "--sl-accent"]]) {
        const c = contrast(token(fg), token(bg)); expect(c >= 4.5, `${fg} on ${bg}: ${c.toFixed(2)}:1`);
      }
      expect(contrast(token("--sl-fg-muted"), token("--sl-surface")) >= 3, "muted text below 3:1");
    });
    registerSelfTest("theme: slice cells carry Slicer's view colors", () => {
      for (const [cell, tok] of [["Red", "--sl-view-red"], ["Yellow", "--sl-view-yellow"], ["Green", "--sl-view-green"]]) {
        const el = document.querySelector(`.lv-cell[data-cell="${cell}"]`) as HTMLElement | null;
        expect(!!el, `no ${cell} cell`);
        if (el!.style.display === "none") continue;            // not in the current layout
        const bar = getComputedStyle(el!, "::before").backgroundColor;
        expect(bar === token(tok), `${cell} bar ${bar} ≠ ${tok} ${token(tok)}`);
      }
    });
  }
  // Sessions: ⌘Z/⌘⇧Z undo/redo, ⌘S export, ⌘B bookmark; ?session=opfs auto-opens browser storage
  const session = mountSessionUI(views.live, { onStatus: status, blobBase: () => views.live.blobBase() });
  if (p.get("session") === "opfs") void session.openOPFS();

  let menus: Menu[] = [];
  if (!legacy) {
    // SETTINGS: the application menu's "Settings… ⌘," (desktop/macmenu.ts) calls __sllShowSettings;
    // the page also takes ⌘, itself, for the browser build and for a window the menu cannot reach.
    const showSettings = async () => {
      const st = await appSettings;
      openSettingsDialog({
        settings: st,
        databases: () => fetch("/_db", { cache: "no-store" }).then((r) => r.json()).then((j: { databases?: { id: string; dir?: string; path?: string; current?: boolean; exists?: boolean }[] }) => j.databases ?? []),
        switchDatabase: async (id) => {
          await fetch("/_db", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: id }) });
          await (globalThis as unknown as { __refreshDicomDb?: () => Promise<number | null> }).__refreshDicomDb?.();
        },
        layouts: () => layoutList().map((l) => ({ id: l.id, name: l.name })),
        onPictureDefaults: (d) => (globalThis as unknown as { __setPictureDefaults?: (d: { only3d: boolean; panel: boolean; scale: number }) => void }).__setPictureDefaults?.(d),
        notify: (n) => { shell?.notify({ title: n.title, body: n.body }); },
      });
    };
    (globalThis as unknown as { __sllShowSettings?: () => void }).__sllShowSettings = () => { void showSettings(); };

    // SAVE THE SCENE (SCENE-DESIGN-2026-09-20.md §2-6). The document from the live scene
    // (logic/scene/write.ts), checked, then PUT to the current database's scene store
    // (desktop/scenes.ts): a file beside the database and a row the browser lists. The window
    // remembers which scene it holds (uid, v, name) so a second save updates it; a save the store
    // refuses because another window saved since is said, not overwritten.
    let currentScene_: { uid: string; v: number; name: string } | null = null;
    /**
     * WHICH SCENE THIS WINDOW IS IN, published for the modules.
     *
     * Ron, 2026-09-22, having saved from the Scene module and stayed there: "the saved scene is not
     * listed." It WAS saved -- in the database, with five series -- and nothing on the screen he was
     * looking at said so. A save is not finished when the file is written; it is finished when the
     * person can see that it was.
     */
    const sceneChanged = () => { (globalThis as unknown as { __onSceneIdentity?: () => void }).__onSceneIdentity?.(); sceneIdentityChanged(); };

    // THE NAME A FIRST SAVE PROPOSES, shown in the Scene menu's edit field before the save (Ron, 2026-09-25: "propose a
    // name and enable direct editing"): the volume's short label, and the first segmentation's network when there is one.
    const proposedSceneName = (): string => {
      const nodes = [...views.live.nodes.values()];
      const vol = nodes.find((n) => n.type === "image" && (n.origin as { shortLabel?: string } | undefined)?.shortLabel)
        ?? nodes.find((n) => n.type === "image" && !n.labelmap && !(n as { hidden?: boolean }).hidden);
      const base = (vol?.origin as { shortLabel?: string } | undefined)?.shortLabel ?? (vol?.name as string | undefined) ?? "Scene";
      const seg = nodes.find((n) => n.type === "segmentation" && !(n as { hidden?: boolean }).hidden);
      const task = ((seg?.origin as { task?: string } | undefined)?.task ?? "").split(":").pop()?.replace(/_/g, " ");
      return task ? `${base} — ${task}` : base;
    };
    const saveScene = async (o: { name?: string; asNew?: boolean; withoutRefused?: boolean; buttonSays?: boolean } = {}): Promise<{ uid?: string; v?: number; refused?: string[]; error?: string }> => {
      const dbs = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { databases?: { id: string; current?: boolean; exists?: boolean }[]; features?: string[] } | null;
      const cur = (dbs?.databases ?? []).find((d) => d.current && d.exists) ?? (dbs?.databases ?? []).find((d) => d.exists);
      if (!cur || !(dbs?.features ?? []).includes("scenes")) { shell?.notify({ title: "The scene cannot be saved here", body: "No DICOM database with a scene store is served by this window." }); return { error: "no store" }; }
      const defaultName = proposedSceneName();
      const name = o.name ?? (o.asNew || !currentScene_ ? defaultName : currentScene_.name);
      const previousV = o.asNew ? 0 : (currentScene_?.v ?? 0);
      // THE EXTENSIONS' OWN STATE (logic/scene/extensions.ts): the Diffusion module's tracts and maps, which no node holds.
      const ext = collectExtensionState();
      if (ext.failed.length) shell?.notify({ title: "Part of what an extension shows is not in the scene", body: ext.failed.map((f) => f.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>") });
      const w = await writeScene(views.live.nodes.values(), {
        producer: `SlicerAlbula ${BUILD_ID}`, origin: views.live.origin, name, previousV,
        layout: { arrangement: (globalThis as unknown as { __layoutId?: number }).__layoutId ?? 0 }, extensions: ext,
      });
      const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // NOTHING LOADED NAMES A STUDY: views and a camera are not a scene, and a file like that lists
      // under no study in the browser (critic, 2026-09-20, findings 2 and 8).
      // WHAT CAN BE PUT RIGHT IS OFFERED, NOT ONLY REFUSED. A volume from a file, a segmentation
      // never saved or edited since: one click saves them to DICOM in the right order (the volume
      // first, then what was drawn on it) and then saves the scene. Ron, 2026-09-20: "Data that is
      // not dicom ... finally needs to be stored somewhere so it can be recovered next time." On
      // save, at the person's word -- never on load.
      const saveThenScene = async () => {
        const g = globalThis as unknown as { __exportVolumeAsDicom?: (id: string) => Promise<unknown>; __exportSegAsDicom?: (id: string) => Promise<unknown>; __refreshDicomDb?: () => Promise<number | null>; __dicomSourceInstances?: unknown };
        // The database hooks live in the Load Data panel; mount it once if it never was, and come
        // back to where the person is. They said "save"; where the database is is our business.
        if (!g.__dicomSourceInstances && shell) { const was = shell.activePanel(); await shell.showPanel("add-data"); await new Promise((r) => setTimeout(r, 50)); if (was) void shell.showPanel(was); }
        const failed: string[] = [];
        for (const f of w.fixable) {
          try {
            if (f.type === "image") { await g.__exportVolumeAsDicom?.(f.id); await g.__refreshDicomDb?.(); }
            else await g.__exportSegAsDicom?.(f.id);
          } catch (e) { failed.push(`${f.name}: ${(e as Error).message}`); }
        }
        // What could not be saved is said once, and the scene is still offered without it
        // (critic, finding 7: a float volume was a dead end).
        if (failed.length) {
          shell?.notify({ title: `${failed.length === 1 ? "One thing" : `${failed.length} things`} could not be saved to DICOM`, body: failed.map(esc).join("<br>"),
            actions: [{ label: "Save the scene without them", primary: true, onClick: () => { void saveScene({ ...o, withoutRefused: true }); } }, { label: "Cancel", onClick: () => {} }] });
          return;
        }
        await saveScene(o);
      };
      if (w.empty && w.fixable.length && !o.withoutRefused) {
        shell?.notify({ title: "Nothing here is in the DICOM database yet", body: `A scene lists what is in the database. Save ${w.fixable.length === 1 ? "this" : "these"} to DICOM first, then the scene:<br><b>${w.fixable.map((f) => esc(f.name)).join("</b><br><b>")}</b>`,
          actions: [{ label: "Save to DICOM, then the scene", primary: true, onClick: () => { void saveThenScene(); } }, { label: "Cancel", onClick: () => {} }] });
        return { refused: w.refused };
      }
      if (w.empty) { shell?.notify({ title: "Nothing is loaded to save", body: w.refused.length ? esc(w.refused.join("; ")) : "Load a study first; a scene is what is on screen." }); return { error: "nothing loaded" }; }
      if (w.refused.length && !o.withoutRefused) {
        shell?.notify({ title: `${w.refused.length === 1 ? "One thing" : `${w.refused.length} things`} cannot go into the scene`, body: w.refused.map(esc).join("<br>"),
          actions: [
            ...(w.fixable.length ? [{ label: "Save to DICOM, then the scene", primary: true, onClick: () => { void saveThenScene(); } }] : []),
            { label: "Save the scene without them", primary: !w.fixable.length, onClick: () => { void saveScene({ ...o, withoutRefused: true }); } },
          ] });
        return { refused: w.refused };
      }
      if (w.problems.length) { shell?.notify({ title: "The scene did not pass its check", body: w.problems.slice(0, 6).map((p) => esc(`${p.where}: ${p.what}`)).join("<br>") }); return { error: "check failed" }; }
      const uid = o.asNew || !currentScene_ ? "new" : currentScene_.uid;
      const res = await fetch(`/_db/${encodeURIComponent(cur.id)}/_scene/${uid}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(w.doc) });
      const r = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { uid?: string; v?: number; bytes?: number; error?: string; rowV?: number; code?: string };
      if (res.status === 409) {
        // Overwrite saves as the row's v + 1 in ONE step; the 409 says what the row is at (critic, finding 6).
        const rowV = r.rowV ?? (currentScene_?.v ?? 0) + 1;
        shell?.notify({ title: "Another window saved this scene since", body: esc(r.error ?? ""), actions: [
          { label: "Save as a new scene", primary: true, onClick: () => { void saveScene({ ...o, asNew: true }); } },
          { label: "Overwrite", onClick: () => { currentScene_ = currentScene_ ? { ...currentScene_, v: rowV } : null; sceneChanged(); void saveScene(o); } },
        ] });
        return { error: r.error };
      }
      // The scene this window held was deleted from the store: the save is a new scene (critic, finding 13).
      if (res.status === 400 && r.code === "gone" && !o.asNew) return await saveScene({ ...o, asNew: true, name });
      if (!res.ok || !r.uid) { shell?.notify({ title: "The scene was not saved", body: esc(r.error ?? `HTTP ${res.status}`) }); return { error: r.error }; }
      currentScene_ = { uid: r.uid, v: r.v ?? 1, name }; sceneChanged();
      markSceneClean(800);   // HERE, not in one caller: a save from a notice's button is a save too (critic round 2, finding 3)
      const nodesN = Object.keys(w.doc.nodes as object).length;
      // THE RESULT LANDS WHERE THE PERSON IS. Saving the scene is done from Load / Save or from the
      // Scene module, and in both the button itself says "Saved ✓" and the module's own line says
      // the rest -- so a card in the far corner of the window is a second, more distant copy of an
      // answer already in front of them. Ron, 2026-09-22: "Save scene popup is still in upper
      // right." The card stays for the case it was made for: the save was started somewhere else
      // and the answer would otherwise be missed. Same rule as a finished AI run (CONSTRAINTS).
      const here = shell?.activePanel?.();
      if (here !== "add-data" && here !== "data" && !o.buttonSays) {
        shell?.notify({ title: `Scene saved — "${esc(name)}"`, body: `${nodesN} things, ${((r.bytes ?? 0) / 1024).toFixed(1)} KB, save ${r.v}${w.refused.length ? `<br>Without: ${esc(w.refused.join("; "))}` : ""}`, ttl: 8000 });
      }
      const said = `Scene saved: "${name}" — ${nodesN} things, ${((r.bytes ?? 0) / 1024).toFixed(1)} KB, save ${r.v}`;
      (globalThis as unknown as { __sceneSaidLast?: string }).__sceneSaidLast = said;
      status(said);
      (globalThis as unknown as { __refreshDicomDb?: () => Promise<number | null> }).__refreshDicomDb?.();
      return { uid: r.uid, v: r.v };
    };
    // LOADING a scene lives in the Load Data panel (it owns the open database); that panel mounts
    // when first shown, so the hook is not there until then. Show it once, then call.
    const loadScene = async (uid: string) => {
      const g = globalThis as unknown as { __loadScene?: (uid: string) => Promise<{ ok: boolean; error?: string; v?: number; name?: string }> };
      if (!g.__loadScene) { await shell?.showPanel("add-data"); await new Promise((r) => setTimeout(r, 50)); }
      if (!g.__loadScene) return { ok: false, error: "the Load Data panel did not mount" };
      const r = await g.__loadScene(uid);
      // The loaded scene is now the current one: the next save is its v + 1 under its name. A load
      // that failed is not (a save after it would replace the file with an empty scene; critic, finding 2).
      // Clean HERE, for every way in -- Load / Save's scene rows, All scenes, a notice's "Open it" (critic round 2, finding 3).
      if (r.ok) { currentScene_ = { uid, v: r.v ?? 1, name: r.name ?? "Scene" }; sceneChanged(); markSceneClean(); }
      return r;
    };
    // CLOSE THE SCENE. Asks first when something loaded is not saved anywhere; then the data goes
    // and no scene is current, so the next save is a new one.
    const closeScene = async (): Promise<boolean> => {
      const g = globalThis as unknown as { __closeSceneData?: () => number; __unsavedWork?: () => string[] };
      if (!g.__closeSceneData) return false;
      const unsaved = g.__unsavedWork?.() ?? [];
      // Frames of a sequence and companion segmentations are hidden nodes, so "loaded" is any data node at all.
      const loaded = [...views.live.nodes.values()].some((n) => ["image", "segmentation", "sequence", "markup", "model", "transform"].includes(n.type as string));
      if (!loaded) { shell?.notify({ title: "Nothing is loaded" }); return false; }
      const changed = !!currentScene_ && sceneDirty();
      if (unsaved.length || changed) {
        const ok = await shell?.confirm({
          title: "Close the scene?",
          ok: "Close anyway", destructive: true, cancel: "Cancel",
          body: (changed ? `<p>The scene “${(currentScene_?.name ?? "").replace(/</g, "&lt;")}” has changes that are not saved.</p>` : "") +
            (unsaved.length ? `<p>${unsaved.length === 1 ? "This is" : "These are"} not saved and would be lost:</p><p><b>${unsaved.map((s) => s.replace(/</g, "&lt;")).join("</b>, <b>")}</b></p>` : "") +
            `<p class="sl-hint">Save to DICOM keeps a segmentation; Scene › Save keeps the scene, its markups and name cards.</p>`,
        });
        if (!ok) return false;
      }
      const n = g.__closeSceneData();
      currentScene_ = null; sceneChanged();
      shell?.setStatus(`Scene closed — ${n} thing${n === 1 ? "" : "s"} unloaded; the database is unchanged`);
      return true;
    };
    // THE GLASSES WINDOW'S SCENE (desktop/headset.ts; render/moduleserver/live-views.ts, VR/AR): this window's scene as
    // the document a saved scene is, without saving it anywhere -- null when nothing from the database is loaded.
    (globalThis as unknown as { __sceneForGlasses?: () => Promise<Record<string, unknown> | null> }).__sceneForGlasses = async () => {
      const w = await writeScene(views.live.nodes.values(), { producer: `SlicerAlbula ${BUILD_ID}`, origin: views.live.origin, name: "glasses", previousV: 0,
        layout: { arrangement: (globalThis as unknown as { __layoutId?: number }).__layoutId ?? 0 }, extensions: collectExtensionState() });
      return w.empty ? null : w.doc as unknown as Record<string, unknown>;
    };
    // THIS IS THE GLASSES WINDOW (?glasses; desktop/main.ts --glasses-window): open the main window's scene, then the
    // 3D view alone, full screen in the glasses, following the head. Each new scene from the main window is applied as
    // it comes -- display changes in place; when the data itself changed (a series added or removed), loaded again.
    if (p.has("glasses")) void (async () => {
      type G = { __loadSceneDoc?: (d: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>; __closeSceneData?: () => number;
        __glassesStart?: (screen: string) => Promise<void>; __glassesScene?: (d: Record<string, unknown>) => void };
      const g = globalThis as unknown as G;
      const seriesOf = (d: Record<string, unknown>) => new Set(Object.values((d.nodes as Record<string, Record<string, unknown>>) ?? {})
        .filter((n) => n.type === "image" || n.type === "segmentation")
        .map((n) => (n.dicom as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID).filter((u): u is string => !!u));
      const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
      const r = await fetch("/_headset/scene", { cache: "no-store" }).then((x) => x.json()).catch(() => null) as { scene?: Record<string, unknown> | null } | null;
      if (!r?.scene) { shell?.notify({ title: "Nothing to show in the glasses", body: "The main window has no case loaded." }); return; }
      // The loader exists once the Load / Save panel has mounted, and in the app that mount reads the database first --
      // seconds, not the 50 ms a browser tab needed (Ron, 2026-10-13: the glasses stayed black; nothing had been loaded).
      if (!g.__loadSceneDoc && shell) await shell.showPanel("add-data");
      for (let i = 0; i < 300 && !g.__loadSceneDoc; i++) await new Promise((res) => setTimeout(res, 100));
      if (!g.__loadSceneDoc) { shell?.setStatus("glasses window: the Load / Save panel did not come up, so the scene could not be opened"); return; }
      // And the database: the panel finds the one the server serves a moment after it mounts (Ron, 2026-10-13: "the scene
      // did not open (no DICOM database is open or served here)"). Asked again until it is there, up to 20 s.
      let loadedNow = await g.__loadSceneDoc(r.scene);
      for (let i = 0; i < 40 && !loadedNow.ok && /no DICOM database/i.test(loadedNow.error ?? ""); i++) {
        await new Promise((res) => setTimeout(res, 500));
        loadedNow = await g.__loadSceneDoc(r.scene);
      }
      shell?.setStatus(loadedNow.ok ? "glasses window: the scene is open" : `glasses window: the scene did not open (${loadedNow.error ?? "no reason given"})`);
      if (!loadedNow.ok) return;
      let loaded = seriesOf(r.scene), loadedExt = JSON.stringify(r.scene.extensions ?? null), busy = Promise.resolve();
      g.__glassesScene = (d) => {
        busy = busy.then(async () => {
          const want = seriesOf(d);
          // What an extension shows (its block in the document: the Diffusion module's tracts, names and map) follows too
          // (critic 2026-10-21, finding 2) -- only when that block changed: a restore adds tracts and may track again.
          const ext = JSON.stringify(d.extensions ?? null);
          if (same(want, loaded)) { applySceneState(views.live, d); if (ext !== loadedExt) await restoreExtensionState(d); }
          else { g.__closeSceneData?.(); await g.__loadSceneDoc?.(d); loaded = want; }
          loadedExt = ext;
        }).catch(() => {});
      };
      await g.__glassesStart?.(p.get("screen") ?? "");
    })();
    Object.assign(globalThis, { __saveScene: saveScene, __currentScene: () => currentScene_, __openScene: loadScene, __closeScene: closeScene, __proposedSceneName: proposedSceneName,
      // "All scenes…": the Scenes window lives in the Load / Save panel, which mounts when first shown.
      __showScenesWindow: async () => {
        const gg = globalThis as unknown as { __scenesWindow?: () => Promise<void> };
        if (!gg.__scenesWindow && shell) { const was = shell.activePanel(); await shell.showPanel("add-data"); await new Promise((r) => setTimeout(r, 50)); if (was) void shell.showPanel(was); }
        await gg.__scenesWindow?.();
      },
      __setCurrentScene: (sc: typeof currentScene_) => { currentScene_ = sc; sceneChanged(); } });

    // WHERE THE WINDOW IS, told to the app that remembers it (desktop/window-frame.ts), so a start
    // from the Dock comes back in the same place and size. Ron, 2026-09-23: "Improve the dock start
    // experience and I will use it exclusively." Only in the app's own window -- the binding below is
    // injected by the app and exists nowhere else -- and only while the window is on screen: a
    // minimized one is not where it is meant to be. Outer size and top-left corner, the convention the
    // launcher used, so the file keeps its meaning.
    const remember = (globalThis as unknown as { slicerliveRememberWindow?: () => Promise<string> }).slicerliveRememberWindow;
    if (typeof remember === "function") {
      // The app reads its own window from macOS (desktop/main.ts); the page only says when (2026-10-01: the report
      // below never arrived from the app's window, and nothing had been saved since 2026-09-23).
      // Not while the window is widened across the glasses (the critic, 2026-10-13, finding 3: it was saved as the
      // window's own size, and the next start came up that way).
      setInterval(() => { if (document.visibilityState === "visible" && !(globalThis as unknown as { __glassesSpan?: boolean }).__glassesSpan) void remember().catch(() => {}); }, 2000);
    } else if (typeof (globalThis as unknown as { slicerliveOpenExternal?: unknown }).slicerliveOpenExternal === "function") {
      let lastFrame = "";
      setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (window.outerWidth < 640 || window.outerHeight < 480) return;
        // Filed under the display it is on (its size): the office's external screen and the laptop's
        // own each keep their window (Ron, 2026-09-23).
        const f = `${Math.round(screen.width)}x${Math.round(screen.height)} ${Math.round(window.screenX)} ${Math.round(window.screenY)} ${Math.round(window.outerWidth)} ${Math.round(window.outerHeight)}`;
        if (f === lastFrame) return;
        lastFrame = f;
        void fetch("/_window", { method: "POST", body: f }).catch(() => {});
      }, 2000);
    }

    // THE SCENE, BESIDE THE MODULE PICKER, in a zone of its own. Ron, 2026-09-23: "can you add a load/save scene
    // button to the top of the window? … close to the module panel, so my mouse travels less"; 2026-09-25: one control,
    // "just scene with the triangle there and everything else in the pop up", and "give the bar area an underlying color
    // to remind people that the area has a different meaning" (render/demos/scene-control.ts).
    if (shell) {
      initSceneControl(views.live, shell);
      // THE ZONE RUNS FROM "Scene ▾" TO THE LAYOUT BUTTON and holds what belongs to the scene, the sequence transport
      // included (Ron, 2026-09-25: "the highlight surrounding the scene button in the top bar should span the entire area
      // all the way to the layout button"). It is in the shell's own markup (app-shell.ts), so the transport, mounted
      // earlier, is already in it.
      document.querySelector(".sl-scene-zone")?.prepend(sceneControl());
    }
    document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "," ) { e.preventDefault(); void showSettings(); } });
    // The 3D view's picture defaults come from the store at start.
    (globalThis as unknown as { __setPictureDefaults?: (d: { only3d: boolean; panel: boolean; scale: number }) => void }).__setPictureDefaults?.(pictureDefaults(await appSettings));
    Object.assign(globalThis, { __views: views, __session: session, __shell: shell });
    return;
  }
  const gui = new LegacyGui(document.getElementById("gui")!, guiUrl, {
    onStats: (st) => { const el = document.getElementById("link"); if (el) el.textContent = `${st.rttMs} ms · ${(st.bytesPerS / 1024).toFixed(0)} KB/s · ${st.codec}${st.codec === "png" ? "" : " q" + st.quality}`; },
    hideKinds: nativeMenus ? ["menubar"] : [],
    onViewport: (v) => {
      // the views container spans the whole window so cells can be placed in window coordinates
      viewsEl.style.left = "0px"; viewsEl.style.top = "0px"; viewsEl.style.width = "100%"; viewsEl.style.height = "100%";
      viewsEl.style.pointerEvents = "none";
      void v;
    },
    onCells: (cells) => { views.setCells(cells); for (const el of viewsEl.querySelectorAll<HTMLElement>(".lv-cell")) el.style.pointerEvents = "auto"; },
    onBlocked: (info) => { let b = document.getElementById("blocked"); if (!b) { b = document.createElement("div"); b.id = "blocked"; b.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2000;background:var(--sl-blocked-bg);color:var(--sl-blocked-fg);padding:6px 14px;border-radius:8px;font:13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,.25)"; document.body.appendChild(b); } b.hidden = !info; if (info) b.textContent = `Slicer is waiting on a dialog: ${info.title || info.className}`; },
    onMenus: (m) => { menus = m; (globalThis as unknown as { __menus?: unknown }).__menus = m; (globalThis as unknown as { slicerliveMenus?: (m: Menu[]) => void }).slicerliveMenus?.(m); },
    onTitle: (t) => { document.title = t; },
    onStatus: status,
  });
  gui.connect();
  // host hooks (the Deno shell drives native menus through these)
  Object.assign(globalThis, { __gui: gui, __views: views, __session: session, __triggerAction: (id: string) => gui.triggerAction(id), __menuTree: () => menus });
}
main().catch((e) => status("error: " + (e as Error).message));
