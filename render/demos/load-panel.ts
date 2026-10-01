// "Data" panel (W1): open local volume files (NRRD / NIfTI, gzipped or not), drag-and-drop onto the views,
// and Slicer's Sample Data catalog with SHA-256 verification. Everything goes through logic/ingest.ts, so a
// loaded file is an ordinary `image` node in the LiveScene. Plain DOM in the app-shell style (theme.css tokens).
import { renameCurrentScene, sceneControl } from "./scene-control.ts";
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import { auditWords } from "./audit-words.ts";
import { VolumeLayersDisplayableManager } from "../livescene.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { loadVolumeIntoScene, LocalBlobStore, lastIngestPhases, percentileWindowLevel, removeVolumeFromScene, volumeToZarr } from "../../logic/ingest.ts";
import { readVolume, sniff } from "../../logic/readers/registry.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { indexDirectory, indexFiles, loadEntry, type SeriesEntry } from "../../logic/readers/dicom-local.ts";
import { dicomLibraryForDebugging } from "../../logic/dicom-io.ts";
import { checkScene } from "../../logic/scene/check.ts";
import { applySceneState } from "./scene-restore.ts";
import { directorySource, httpSource, openDicomDatabase, recallDatabaseDir, rememberDatabaseDir, type DbProgress, type DbSeriesEntry, type DbSource, type DicomDatabase } from "../../logic/readers/dicom-db.ts";
import { decodeSegmentationLazy, segCacheKeyFromHead } from "../../logic/readers/seg-cache.ts";
import { BUILD_CODE, getBuiltSeg, putBuiltSeg } from "../../logic/readers/built-seg-cache.ts";
import { describeProfile, describeProfilePhases, endLoadProfileWhenQuiet, mark, noteMs, span, spanSync, startLoadProfile } from "./load-profile.ts";
import { loadSequenceFromCopy } from "../zarr-copy.ts";
import { volumeForSeg } from "../../logic/seg-placement.ts";
import { createSegmentationFromBuilt, createSegmentationFromLabelmap } from "../../logic/segmentation-editor.ts";
import { keepScroll } from "./panel-scroll.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { chooseFolder, dbName, listDatabases, openDatabasesWindow } from "./databases-window.ts";
import { addFilesToDatabase, addFolderToDatabase, describeImport, filesOfChosenFolder, type ImportResult } from "./add-to-database.ts";
import { freesurferStructureByName, lookupStructure, usesFreesurferNumbering } from "../../logic/segment-naming.ts";
import { segmentationsOffScheme, useCurrentColors } from "../../logic/scheme-colors.ts";
import { paletteVersion } from "../../logic/anatomy/palettes.ts";
import { presentationFor, presentationParams } from "../../logic/presentation.ts";
import { setColorizeParams } from "./tf-editor.ts";
import { downloadSample } from "../../logic/sample-data.ts";
import { setLook3D, setVolumeRenderingOn } from "./tf-editor.ts";
import { hasSurfaceModels, look3DOf, type Look3D, LOOKS_3D, looksOn, segmentationsOf } from "../look3d.ts";
import { orderScene } from "./scene-order.ts";
import { parseTerminology } from "../../logic/anatomy/terminology.ts";
import { companionItem, currentFrames, loadSequenceIntoScene, type SequenceDocument } from "../../logic/sequences.ts";
import { documentSeriesFor, parsePictures } from "../../logic/readers/dicom-picture.ts";
import { readDicomHead } from "../../logic/readers/dicom-head.ts";
import { explainSeries } from "../../logic/series-explain.ts";

/**
 * The pictures that document a sequence (logic/readers/dicom-picture.ts), as PNG data URLs the
 * Sequences module can show: small (two 512x512 ECG traces are ~60 KB), so they live on the
 * sequence node itself and travel with the scene. A series that cannot be read is reported and
 * skipped; the sequence is loaded either way.
 */
async function loadSequenceDocuments(db: DicomDatabase, entry: DbSeriesEntry, note: (p: DbProgress) => void): Promise<SequenceDocument[]> {
  const out: SequenceDocument[] = [];
  for (const d of documentSeriesFor(entry, db.series)) {
    try {
      note({ note: `reading ${d.description ?? "pictures"} (${d.count})…` });
      const { pictures, skipped } = await parsePictures(await db.readSeriesFiles(d));
      if (skipped.length) note({ note: `${d.description}: ${skipped.length} not read (${[...new Set(skipped)].join("; ")})` });
      if (!pictures.length) continue;
      const images = pictures.map((p, i) => {
        const c = document.createElement("canvas"); c.width = p.width; c.height = p.height;
        c.getContext("2d")!.putImageData(new ImageData(p.rgba, p.width, p.height), 0, 0);
        return { dataUrl: c.toDataURL("image/png"), width: p.width, height: p.height, caption: `${i + 1} of ${pictures.length}` };
      });
      out.push({ name: realDescription(d.description) || "ECG", seriesInstanceUID: d.seriesInstanceUID, images });
    } catch (e) { note({ note: `${d.description}: ${(e as Error).message}` }); }
  }
  return out;
}

export interface LoadPanelOpts {
  live: LiveScene;
  store: LocalBlobStore;
  dropTarget?: HTMLElement;                 // where a drag-and-drop overlay appears (default: shell.main)
  onLoaded?: (info: { name: string; imageId: string; source: string; rasLo: [number, number, number]; rasHi: [number, number, number]; ijkToRAS: number[] }) => void;
  onStatus?: (s: string) => void;
}

/** RAS bounding box of a volume from its ijkToRAS + dims (the 8 corners). */
function rasBounds(dims: [number, number, number], m: number[]): { lo: [number, number, number]; hi: [number, number, number] } {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const i = (c & 1) ? dims[0] - 1 : 0, j = (c & 2) ? dims[1] - 1 : 0, k = (c & 4) ? dims[2] - 1 : 0;
    for (let r = 0; r < 3; r++) { const v = m[r * 4] * i + m[r * 4 + 1] * j + m[r * 4 + 2] * k + m[r * 4 + 3]; if (v < lo[r]) lo[r] = v; if (v > hi[r]) hi[r] = v; }
  }
  return { lo, hi };
}

/**
 * A name that says WHICH DATASET this is, for the scene.
 *
 * Ron, having loaded an NLST case: "There is a number at the top level, but there is nothing below.
 * How do I find out which data set I loaded? Again, a failure from a user interface perspective."
 * And before that, a TCIA case whose every node read "= NONE =".
 *
 * The name was `description || last 12 of the series uid`, which is the DICOM browser's label -- and
 * there it is fine, because the browser shows it nested under the patient and the study that identify
 * it. The scene has no such nesting: the volume sits at the top with nothing above it, so whatever it
 * is called is the ONLY thing naming what is loaded. SeriesDescription alone is not that. NLST writes
 * a bare reconstruction number, several TCIA collections write the literal string "= NONE =", and
 * plenty of series carry none at all.
 *
 * So the name carries the patient, then what the series is, then when it was taken -- the three things
 * someone asks when they cannot tell which of two loaded studies they are looking at. Anything absent
 * is left out rather than filled with a placeholder; a name of "unknown · unknown" identifies nothing.
 */
/**
 * A series description, or "" when what is there is a placeholder.
 *
 * "= NONE =" is what TCIA writes where a site left the field empty. Treating it as a name is how
 * every node in one study came to be called that, in the scene AND in the browser row.
 */
/**
 * A LOADED SEGMENTATION'S ORIGIN, the same whether it was decoded or came from the built cache: which series
 * it is, its study, and the file's SOP class, network and algorithm type, so a re-save writes them as the file
 * had them. The two paths built it separately and the cache path dropped the last three (code review, A5).
 */
function segOrigin(entry: DbSeriesEntry, f: { sopClassUID?: string; task?: string; algorithmType?: string }): Record<string, string> {
  return {
    seriesInstanceUID: entry.seriesInstanceUID,
    ...(entry.studyInstanceUID ? { studyInstanceUID: entry.studyInstanceUID } : {}),
    ...(f.sopClassUID ? { sopClassUID: f.sopClassUID } : {}),
    ...(f.task ? { task: f.task } : {}),
    ...(f.algorithmType ? { algorithmType: f.algorithmType } : {}),
  };
}

export function realDescription(d?: string): string {
  const raw = (d ?? "").trim();
  return /^(=?\s*none\s*=?|n\/?a|unknown|\^|-+)$/i.test(raw) ? "" : raw;
}

/**
 * What this series is, WITHOUT the patient and the date.
 *
 * For naming things derived from it. The full label identifies a series when it is the top of a
 * tree and nothing above it says who or when -- and it is exactly wrong inside another name, because
 * the patient and the date come along and are then repeated by whatever nests that name in turn.
 * Ron's segmentation had been through it twice: a volume called "R_180 · CT series 2 · 1996-03-22"
 * became "ts:total of R_180 · CT series 2 · 1996-03-22", was stored under that description, and came
 * back as "R_180 · SEG ts:total of R_180 · CT series 2 · 1996-03-22 · 1996-03-22" -- which the
 * subject hierarchy then truncated, so the one word that mattered was the part cut off.
 */
export function seriesLabelShort(e: { description?: string; modality?: string; seriesNumber?: number }): string {
  const what = realDescription(e.description) || (e.seriesNumber !== undefined ? `series ${e.seriesNumber}` : "");
  return [e.modality, what].filter(Boolean).join(" ") || "series";
}

export function seriesLabel(e: {
  description?: string; modality?: string; seriesNumber?: number;
  patientID?: string; patientName?: string; studyDate?: string; seriesDate?: string;
  seriesInstanceUID?: string;
}): string {
  const desc = realDescription(e.description);
  const what = desc || (e.seriesNumber !== undefined ? `series ${e.seriesNumber}` : "");
  const kind = [e.modality, what].filter(Boolean).join(" ");
  // A patient NAME when there is one worth showing, else the ID. De-identified public collections
  // generally have only the ID, and it is the identifier people actually quote.
  const who = (e.patientID ?? "").trim() || (e.patientName ?? "").replace(/\^+$/, "").replace(/\^/g, " ").trim();
  const d = (e.studyDate ?? e.seriesDate ?? "").trim();
  const when = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : "";
  const parts = [who, kind, when].filter(Boolean);
  // Nothing identifying at all: the uid tail, which is what this did before and is still better than
  // an empty string.
  return parts.length ? parts.join(" · ") : (e.seriesInstanceUID ?? "").slice(-12) || "DICOM series";
}

export function registerLoadPanel(shell: AppShell, opts: LoadPanelOpts): void {
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  /**
   * Series that hold STORED SURFACES rather than a labelmap.
   *
   * Both are `Modality: "SEG"` in the index -- correctly: a Surface Segmentation is a segmentation --
   * and the index carries no SOP class, so nothing in a row distinguishes them. The provenance edge
   * does (`kind: "surface"`), and the browser reads those edges anyway to nest the tree, so the set
   * is filled there and read here. Ron, selecting one and pressing Load: "2 loaded; 1 failed ... the
   * SEG has no pixel data" -- true, and useless: it never had pixels and was never going to.
   */
  const surfaceSeries = new Set<string>();
/** A name into a notice's HTML. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  /** child series uid -> the series it was derived from, from the provenance edges. */
  const derivedFrom = new Map<string, string>();

  /**
   * HOW LONG THAT TOOK, on the line that says it is done.
   *
   * Rule 5 is the reason: "I have ADD. Make your algorithm fast", and this project holds itself to
   * 33 s target / 66 s limit. None of that could be checked from the screen -- the SEG path reported
   * its phases, but opening a plain series reported only the voxel count, so every load figure ever
   * quoted here was measured by hand and none of them was reproducible by anyone else. A number
   * nobody can read is a number nobody can hold you to.
   *
   * Wall clock from the user's click, not from the start of the decode: what is being measured is
   * the wait, and the wait includes everything.
   */
  const took = (startedAt: number) => {
    const s = (performance.now() - startedAt) / 1000;
    return s < 10 ? ` in ${s.toFixed(2)}s` : ` in ${s.toFixed(1)}s`;
  };

  async function loadBytes(bytes: Uint8Array, fileName: string, source: string): Promise<void> {
    const t0 = performance.now();
    const fmt = sniff(bytes, fileName);
    status(`reading ${fileName} (${fmt}, ${(bytes.byteLength / 1048576).toFixed(1)} MB)…`);
    const vol = await readVolume(bytes, fileName);
    // WHERE IT CAME FROM, on the node: the file's name and, for a sample, which one -- what a
    // later save to DICOM writes into the patient's comments (Ron, 2026-09-20: data that is not
    // DICOM "comes from somewhere ... finally needs to be stored somewhere so it can be recovered").
    (vol as { meta?: Record<string, unknown> }).meta = { ...((vol as { meta?: Record<string, unknown> }).meta ?? {}), fileName, ...(source.startsWith("sampleData:") ? { sample: source.slice("sampleData:".length) } : {}) };
    const r = await loadVolumeIntoScene(opts.live, opts.store, vol, { name: vol.name ?? fileName });
    status(`loaded ${vol.name ?? fileName}: ${vol.dims.join("×")} voxels${took(t0)}`);
    const b = rasBounds(vol.dims, vol.ijkToRAS);
    opts.onLoaded?.({ name: vol.name ?? fileName, imageId: r.imageId, source, rasLo: b.lo, rasHi: b.hi, ijkToRAS: vol.ijkToRAS });
  }
  // FOR EXTENSIONS (sdk/albula.ts openDicomDatabase, openLoadFromDisk): the Diffusion module's checklist sends the resident
  // here rather than repeating these controls (Ron, 2026-10-01: "load save module has all that is needed"). Registered
  // when the app starts, not when this panel is first shown: a resident who goes straight to Diffusion has never opened
  // Load / Save (found in the browser pane, 2026-10-01). They show the panel first, which mounts it.
  let openDatabaseFromOutside: (() => void) | undefined, showLoadFromDisk: (() => void) | undefined;
  (globalThis as unknown as { __openDicomDatabase?: () => void }).__openDicomDatabase = () => { void shell.showPanel("add-data").then(() => openDatabaseFromOutside?.()); };
  (globalThis as unknown as { __openLoadFromDisk?: () => void }).__openLoadFromDisk = () => { void shell.showPanel("add-data").then(() => showLoadFromDisk?.()); };
  /** DICOM files that arrived (a dropped folder): viewed, and added to the database when "Also add to" is ticked. Set by the panel. */
  let dicomFilesArrived: ((files: File[]) => Promise<void>) | undefined;
  async function loadFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    // A SCENE FILE DROPPED IN -- `scene.mrson.json` out of a transport folder (SCENE-DESIGN §7), with
    // its `provenance.json` beside it when both were dropped -- is imported into the current
    // database's scene store, not loaded: its series must already be in the database (the
    // folder's README says how), and then its row appears under its study. A `.mrson.json` saved
    // by another window of this database works the same way.
    const sceneFile = list.find((f) => /\.mrson\.json$/i.test(f.name));
    if (sceneFile) {
      const provFile = list.find((f) => /^provenance\.json$/i.test(f.name));
      try {
        const scene = JSON.parse(await sceneFile.text()) as Record<string, unknown>;
        const provenance = provFile ? JSON.parse(await provFile.text()) as Record<string, unknown> : undefined;
        const reg = await fetch("/_db", { cache: "no-store" }).then((x) => x.ok ? x.json() : null) as { databases?: { id: string; current?: boolean; exists?: boolean }[] } | null;
        const cur = (reg?.databases ?? []).find((d) => d.current && d.exists) ?? (reg?.databases ?? []).find((d) => d.exists);
        if (!cur) { shell.notify({ title: "The scene cannot be imported here", body: "No DICOM database is served by this window." }); return; }
        const r = await fetch(`/_db/${encodeURIComponent(cur.id)}/_scene/_import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene, provenance }) })
          .then((x) => x.json()) as { uid?: string; v?: number; name?: string; edges?: number; attributes?: number; replaced?: boolean; kept?: boolean; error?: string; missing?: string[]; problems?: { where: string; what: string }[] };
        if (r.error) {
          shell.notify({ title: "The scene was not imported", body: esc(r.error) + (r.missing?.length ? `<br>${r.missing.length} series to import first: ${esc(r.missing.map((u) => `…${u.slice(-10)}`).join(", "))}` : "") + (r.problems?.length ? `<br>${esc(r.problems.slice(0, 3).map((p) => `${p.where}: ${p.what}`).join("; "))}` : "") });
          return;
        }
        (globalThis as unknown as { __forgetProvenance?: () => void }).__forgetProvenance?.();   // the import writes edges
        if (r.kept) {
          status(`Scene "${r.name}" is already here at save ${r.v}; nothing changed`);
          shell.notify({ title: `Already here — "${esc(r.name ?? "")}"`, body: `The store has this scene at save ${r.v}, the same or newer than the file. Nothing was changed.`, ttl: 10000 });
          return;
        }
        status(`Scene "${r.name}" imported (save ${r.v}${r.replaced ? ", replacing an older copy" : ""}) · ${r.edges} provenance edge${r.edges === 1 ? "" : "s"}, ${r.attributes} attribute${r.attributes === 1 ? "" : "s"} added`);
        shell.notify({ title: `Scene imported — "${esc(r.name ?? "")}"`, body: `It is listed under its study in the DICOM browser now.`,
          actions: [{ label: "Open it", primary: true, onClick: () => { void (globalThis as unknown as { __openScene?: (uid: string) => Promise<unknown> }).__openScene?.(r.uid ?? ""); } }, { label: "Later", onClick: () => {} }] });
      } catch (e) { shell.notify({ title: "The scene was not imported", body: esc((e as Error).message) }); }
      return;
    }
    for (const f of list) {
      try { await loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, "file"); }
      catch (e) { status(`${f.name}: ${(e as Error).message}`); }
    }
  }

  async function loadVolumeObj(
    vol: Awaited<ReturnType<typeof readVolume>>,
    source: string,
    // Defaults to now, so a caller that does not know when the user clicked still reports something
    // true -- just narrower than the whole wait.
    startedAt: number = performance.now(),
  ): Promise<void> {
    // A VOLUME READ FROM THE DICOM DATABASE SAYS SO on its origin: DICOM files opened from disk carry the same
    // series UID and are not in the database (critic, 2026-09-24, review-bugfixes finding 5).
    if (source === "dicom-db") (vol as { meta?: Record<string, unknown> }).meta = { ...((vol as { meta?: Record<string, unknown> }).meta ?? {}), inDatabase: true };
    const r = await span("volume · ingest: build the nodes", () => loadVolumeIntoScene(opts.live, opts.store, vol, { name: vol.name ?? "Volume" }));
    status(`loaded ${vol.name}: ${vol.dims.join("×")} voxels${took(startedAt)}`);
    const b = rasBounds(vol.dims, vol.ijkToRAS);
    spanSync("volume · ingest: fit the views", () => opts.onLoaded?.({ name: vol.name ?? "Volume", imageId: r.imageId, source, rasLo: b.lo, rasHi: b.hi, ijkToRAS: vol.ijkToRAS }));
  }

  // ADD DATA and DATA ARE TWO MODULES, because they answer two different questions.
  //
  // Ron, 2026-09-05: "Our current Data module covers two things: how to access data and what data is
  // currently available. This mixes concepts. In my mind, I would like to split this into I/O and
  // the data that is present. That is closer to Slicer." It is: Slicer's Data module shows the
  // scene, the archive browser is its own module, and Add Data is a dialog. Here the seam already
  // existed -- a Load section of buttons and a Subject Hierarchy under one heading -- so the split
  // is where the file was already divided, not a rewrite.
  //
  // Work in progress. The grouping this files them under is a working draft
  // (docs/module-list-organization.md), to be revisited with Steve and Andrey.
  /** What is loaded and not saved anywhere: a segmentation edited since its save, or never saved. Named, for the person to decide. */
  const unsavedWork = (): string[] => {
    // Members of a sequence family are hidden nodes and count too (critic, 2026-09-20, finding 4);
    // a family is named once.
    const names = [...opts.live.nodes.values()].filter((n) => n.type === "segmentation").filter((n) => {
      const org = n.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
      return n.edited === true || !(org?.savedSeriesInstanceUID || org?.seriesInstanceUID);
    }).map((n) => String(n.name ?? n.id));
    return [...new Set(names)];
  };
  /**
   * CLOSE THE SCENE: every volume (its displays, its rendering, its transfer function), every
   * sequence and browser, every segmentation, markup, model and transform -- the session's data,
   * not the views, the camera or the layout, which stay as they are for the next thing loaded.
   * Ron, 2026-09-20: "we need a close scene button." The caller has asked about unsaved work.
   */
  const closeScene = (): number => {
    const all = [...opts.live.nodes.values()];
    let n = 0;
    for (const x of all) if (x.type === "sequenceBrowser") { opts.live.write({ op: "del", id: x.id }); n++; }
    for (const x of all) if (x.type === "sequence") { opts.live.write({ op: "del", id: x.id }); n++; }
    for (const x of all) if (x.type === "segmentation" || x.type === "markup" || x.type === "model" || x.type === "transform") { opts.live.write({ op: "del", id: x.id }); n++; }
    for (const x of all) if (x.type === "volumeRenderingDisplay" || x.type === "transferFunction") { opts.live.write({ op: "del", id: x.id }); }
    for (const x of all) if (x.type === "image") { removeVolumeFromScene(opts.live, x.id); n++; }
    return n;
  };

  // Eager, not in a panel's mount: the Scene module's "Close scene" button and the app's own
  // close need them on a page where Load Data has never been shown.
  Object.assign(globalThis, {
    /** Close the scene's data (the views, camera and layout stay). Returns how many things went. The caller asks about unsaved work first. */
    __closeSceneData: (): number => closeScene(),
    /** The segmentations that are edited since their save, or never saved: what closing would lose. */
    __unsavedWork: (): string[] => unsavedWork(),
  });

  shell.registerPanel({
    id: "add-data",
    // ONE MODULE AROUND THE GRAPH (2026-09-22). Ron, on a graph of scene / DICOM database / files
    // with Load and Save arrows: "I love it. Perhaps we should reverse the two module decision.
    // Adjust the colors, make the two Load and two Save clickable (remember, I am fine motor
    // challenged) with proper visual feedback and pop up the appropriate additional stuff in a
    // section below." Name: "Load/Save" (Q1); opens with no arrow chosen (Q2); Save the scene in
    // the database pane (Q3). The id stays "add-data" -- __openScene mounts it by that name.
    title: "Load / Save",
    groups: ["Data"],
    order: 1,
    tip: "Bring things into the scene, or keep them: the DICOM database or files, both ways",
    help: `<p>Brings data into the session. Drag files onto the views from anywhere in the
      application, or use the buttons here.</p>
      <p><b>What arrives where.</b> A volume file (NRRD, NIfTI) and a DICOM series both land in the
      <b>scene</b> — they show up under Data, and they are gone when the application restarts.
      Loading is not importing: nothing here writes to the DICOM database. The database is written
      only when you save a result into it.</p>
      <p><b>DICOM</b> is read as a series, not as a file, so individual DICOM files cannot simply be
      dropped: use <i>DICOM files…</i> or <i>DICOM folder…</i>, which group the files into series
      first, or <i>DICOM database…</i> for what is already indexed.</p>
      <p><b>Deleting from the database</b> is done in the <i>DICOM database…</i> window: tick the
      series and press <b>Delete…</b>, then press it again once it says what it is about to destroy.
      That removes the files, the index rows and the derivation edge, backs the index up first and
      audits afterwards. It is not the same as removing something from the scene, which only unloads
      it. Ron asked how — and until 2026-09-07 there was no way at all.</p>`,
    acknowledgements: [
      "dcmjs — DICOM parsing and writing in JavaScript (dcmjs-org)",
      "ctkDICOMDatabase — the SQLite index this reads, from the Common Toolkit / 3D Slicer",
    ],
    mount(el) {
    el.innerHTML = `<h2>Load / Save</h2>`;
    // THE GRAPH IS THE FACE. Three boxes, four arrows; the arrows are the buttons -- big targets,
    // hover fills, pressed goes dark, the chosen one is yellow while its pane is open. The boxes'
    // explanations are their tooltips. Everything that used to be Load Data or Save is in a pane.
    const graphSec = shell.section(el, "Where things go", { open: true, band: "yellow" });
    graphSec.innerHTML = `
      <svg class="sl-io" viewBox="0 0 376 240" xmlns="http://www.w3.org/2000/svg">
        <rect class="sl-io-box sl-io-scene" x="98" y="8" width="180" height="52" rx="8"><title>The scene: what is on screen now. It is gone when the application closes; what you want to keep goes below.</title></rect>
        <text class="sl-io-lbl" x="188" y="30" text-anchor="middle">Scene</text><text class="sl-io-sub" x="188" y="48" text-anchor="middle">what is on screen now</text>
        <g class="sl-io-arrow" data-pane="load-db" tabindex="0" role="button"><title>Load from the local DICOM database: the usual way. A study comes back with its segmentations and its scenes.</title>
          <line class="sl-io-line" x1="72" y1="176" x2="150" y2="64"/><rect class="sl-io-pill" x="66" y="104" width="64" height="26" rx="13"/><text class="sl-io-word" x="98" y="121" text-anchor="middle">Load</text></g>
        <g class="sl-io-arrow" data-pane="save-db" tabindex="0" role="button"><title>Save to the local DICOM database: kept, and it all comes back together.</title>
          <line class="sl-io-line" x1="168" y1="64" x2="100" y2="176"/><rect class="sl-io-pill" x="118" y="140" width="64" height="26" rx="13"/><text class="sl-io-word" x="150" y="157" text-anchor="middle">Save</text></g>
        <g class="sl-io-arrow" data-pane="load-files" tabindex="0" role="button"><title>Load a file from disk, one thing at a time: NRRD, NIfTI, DICOM files or a folder.</title>
          <line class="sl-io-line" x1="304" y1="176" x2="226" y2="64"/><rect class="sl-io-pill" x="246" y="104" width="64" height="26" rx="13"/><text class="sl-io-word" x="278" y="121" text-anchor="middle">Load</text></g>
        <g class="sl-io-arrow" data-pane="save-files" tabindex="0" role="button"><title>Save as a file on disk, one thing at a time: NRRD, NIfTI, STL. The file goes to your Downloads folder.</title>
          <line class="sl-io-line" x1="208" y1="64" x2="276" y2="176"/><rect class="sl-io-pill" x="194" y="140" width="64" height="26" rx="13"/><text class="sl-io-word" x="226" y="157" text-anchor="middle">Save</text></g>
        <rect class="sl-io-box sl-io-db" x="8" y="180" width="176" height="52" rx="8"><title>The DICOM database: local, kept. Images, segmentations, surfaces and scenes stay here between sessions and come back together.</title></rect>
        <text class="sl-io-lbl" x="96" y="202" text-anchor="middle">DICOM database</text><text class="sl-io-sub" x="96" y="220" text-anchor="middle">local, kept</text>
        <rect class="sl-io-box sl-io-files" x="192" y="180" width="176" height="52" rx="8"><title>Files on disk: one thing at a time, in the formats other programs read.</title></rect>
        <text class="sl-io-lbl" x="280" y="202" text-anchor="middle">Files</text><text class="sl-io-sub" x="280" y="220" text-anchor="middle">NRRD · NIfTI · STL · DICOM</text>
      </svg>`;
    // THE PANES. The two load panes are the old Load Data blocks; the two save panes are drawn by
    // save-panel.ts. One at a time, under the graph.
    const panes = document.createElement("div");
    panes.className = "sl-io-panes";
    panes.innerHTML = `
      <div data-pane="load-db" hidden></div>
      <div data-pane="save-db" hidden></div>
      <div data-pane="load-files" hidden></div>
      <div data-pane="save-files" hidden></div>
      <div class="sl-load-disk" hidden>
      <div class="sl-dropzone" title="Drop volumes or DICOM files here, or anywhere on the views.">
        <strong>Drop files here</strong>
        <span class="sl-hint">or anywhere on the views — NRRD, NIfTI, DICOM</span>
      </div>
      <div class="sl-row">
        <button class="sl-primary" data-act="open" title="Open a single volume file already on disk: NRRD or NIfTI, gzipped or not.">Volume file…</button>
        <button data-act="dicom-files" title="Pick individual DICOM files — useful for one series, or when a folder holds more than you want.">DICOM files…</button>
        <button data-act="dicom-dir" title="A folder of DICOM scans (from a disc, a USB stick, an export): the scans in it are listed to look at, and added to the database below when that is ticked.">DICOM folder…</button>
      </div>
      <div class="sl-row sl-add-row" title="DICOM scans loaded from disk are also copied into this database, so they are there next time, after the disc or stick is gone. Volume files (NRRD, NIfTI) are not DICOM and are not added.">
        <label><input type="checkbox" class="sl-add-db" checked> Also add to</label>
        <select class="sl-add-db-which" style="min-width:0;flex:1"></select>
      </div>
      </div>
      <div class="sl-load-db" hidden>
      <div class="sl-row">
        <button class="sl-primary" data-act="dicom-db" title="Browse the indexed DICOM database and load a series. This is the usual way in when working on a study.">DICOM database…</button>
        <button data-act="databases" title="Which databases there are, what each holds, which one opens by default; make a new one.">Databases…</button>
        <span class="sl-scene-slot"></span>
      </div>
      <div class="sl-row"><span class="sl-hint sl-db-hint">reopens the last database</span></div>
      </div>
      <div class="sl-series" hidden><h3>Series</h3><div class="sl-series-list"></div></div>
      <input type="file" multiple accept=".nrrd,.nhdr,.nii,.nii.gz,.gz" hidden>
      <input type="file" multiple data-dicom hidden>`;
    el.appendChild(panes);
    const adv = shell.section(el, "Advanced", { open: false, band: "none" });
    adv.innerHTML = `<div class="sl-row">
        <button data-act="terminology" title="Load a terminology: the names, codes and colors a lab or an extension uses for its structures. Slicer's .term.json or a color-table CSV. Once loaded, segmentations can be named in it (Segmentations → Advanced).">Terminology…</button>
        <span class="sl-hint">.term.json, color-table .csv</span>
      </div>
      <p class="sl-hint">What you load is not permanently stored until you save it — to the DICOM database or as a file.</p>`;
    // The load panes: sections drawn from the old blocks, green (what exists comes in).
    for (const [cls, pane, title] of [["sl-load-disk", "load-files", "Load from files"], ["sl-load-db", "load-db", "Load from the DICOM database"]] as const) {
      const block = panes.querySelector(`.${cls}`) as HTMLElement;
      const holder = panes.querySelector(`[data-pane="${pane}"]`) as HTMLElement;
      const body = shell.section(holder, title, { open: true, band: "green" });
      while (block.firstChild) body.appendChild(block.firstChild);
      block.remove();
    }
    for (const [pane, title] of [["save-db", "Save to the DICOM database"], ["save-files", "Save as files"]] as const) {
      const holder = panes.querySelector(`[data-pane="${pane}"]`) as HTMLElement;
      shell.section(holder, title, { open: true, band: "yellow" });
    }
    const g2 = globalThis as unknown as { __renderSavePane?: (shell: AppShell, live: LiveScene, root: HTMLElement, mode: "db" | "files", onStatus?: (s: string) => void) => void };
    let chosenPane: string | null = null;
    const showPane = (name: string | null) => {
      chosenPane = name;
      for (const a of el.querySelectorAll<SVGGElement>(".sl-io-arrow")) a.classList.toggle("sl-io-on", a.dataset.pane === name);
      for (const p of panes.querySelectorAll<HTMLElement>("[data-pane]")) {
        const on = p.dataset.pane === name;
        p.hidden = !on;
        if (on && (name === "save-db" || name === "save-files")) {
          const body = p.querySelector(".sl-section-body") as HTMLElement;
          g2.__renderSavePane?.(shell, opts.live, body, name === "save-db" ? "db" : "files", (s) => status(s));
        }
      }
    };
    for (const a of el.querySelectorAll<SVGGElement>(".sl-io-arrow")) {
      const act = () => showPane(a.classList.contains("sl-io-on") ? null : a.dataset.pane ?? null);
      a.addEventListener("click", act);
      a.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    }
    void chosenPane;
    const input = el.querySelector("input[type=file]") as HTMLInputElement;
    const openBtn = el.querySelector('[data-act="open"]') as HTMLButtonElement;
    openBtn.addEventListener("click", async () => {
      const picker = (globalThis as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
      if (picker) {
        try {
          const handles = await picker({ multiple: true, types: [{ description: "Volumes", accept: { "application/octet-stream": [".nrrd", ".nhdr", ".nii", ".gz"] } }] });
          await loadFiles(await Promise.all(handles.map((h) => h.getFile())));
        } catch (e) { if ((e as Error).name !== "AbortError") status((e as Error).message); }
      } else input.click();
    });
    input.addEventListener("change", () => { if (input.files) void loadFiles(input.files); input.value = ""; });

    // ---- a terminology, into the scene as a node ----
    // Ron, 2026-09-12, on SlicerHeart and a lab's own terms: loading a terminology has to be a
    // thing a person does at runtime, not a build step. The file is parsed here and stored parsed,
    // so the session carries it and every peer reads the same terms.
    const termInput = document.createElement("input"); termInput.type = "file"; termInput.multiple = true; termInput.hidden = true; termInput.accept = ".json,.csv";
    el.appendChild(termInput);
    const loadTerminologyFiles = async (files: FileList | File[]) => {
      for (const f of files) {
        try {
          const id = `terminology-${Date.now().toString(36)}-${f.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
          const src = parseTerminology(await f.text(), id, f.name);
          opts.live.write({ op: "put", id, node: { type: "terminology", id, ...src } as unknown as MrsonNode });
          status(`terminology loaded: ${src.name} — ${Object.keys(src.entries).length} terms, scheme${src.schemes.length === 1 ? "" : "s"} ${src.schemes.join(", ") || "none"}`);
        } catch (e) { status(`${f.name}: ${(e as Error).message}`); }
      }
    };
    (el.querySelector('[data-act="terminology"]') as HTMLButtonElement).addEventListener("click", async () => {
      const picker = (globalThis as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
      if (picker) {
        try {
          const handles = await picker({ multiple: true, types: [{ description: "Terminologies", accept: { "application/json": [".json"], "text/csv": [".csv"] } }] });
          await loadTerminologyFiles(await Promise.all(handles.map((h) => h.getFile())));
        } catch (e) { if ((e as Error).name !== "AbortError") status((e as Error).message); }
      } else termInput.click();
    });
    termInput.addEventListener("change", () => { if (termInput.files) void loadTerminologyFiles(termInput.files); termInput.value = ""; });

    // ---- DICOM ----
    const seriesBox = el.querySelector(".sl-series") as HTMLElement, seriesList = el.querySelector(".sl-series-list") as HTMLElement;
    const dicomInput = el.querySelector("[data-dicom]") as HTMLInputElement;
    const showSeries = (entries: SeriesEntry[]) => {
      seriesList.innerHTML = "";
      if (!entries.length) { seriesBox.hidden = false; seriesList.innerHTML = "<p>No DICOM image series found.</p>"; return; }
      seriesBox.hidden = false;
      for (const e of entries) {
        const row = document.createElement("div"); row.className = "sl-series-row";
        const b = document.createElement("button");
        b.textContent = `${e.modality ?? "?"} · ${e.description || e.seriesInstanceUID.slice(-12)} · ${e.count} img`;
        b.title = `${e.patientName ?? ""} · ${e.seriesInstanceUID}`;
        b.addEventListener("click", async () => {
          const t0 = performance.now();
          try { status(`reconstructing ${e.count} slices…`); await loadVolumeObj(loadEntry(e), "dicom", t0); }
          catch (err) { status(`DICOM: ${(err as Error).message}`); }
        });
        row.appendChild(b); seriesList.appendChild(row);
      }
    };
    const indexProgress = (p: { scanned: number; dicom: number; note?: string }) => status(`scanning: ${p.dicom} DICOM / ${p.scanned} files${p.note ? " — " + p.note : ""}`);
    (el.querySelector('[data-act="dicom-dir"]') as HTMLButtonElement).addEventListener("click", async () => {
      // THE APPLICATION'S WAY: macOS's folder dialog through the server (the web view has no folder picker), then the
      // server adds the folder to the database, or serves its files to look at when "Also add to" is unticked.
      if ((await listDatabases()).features.includes("choose-folder")) {
        try {
          const c = await chooseFolder("Choose the folder with the scans (a disc, a USB stick, an export)");
          if (!c) return;
          const target = addTarget();
          if (target) { await reportImport(target, () => addFolderToDatabase(target.id, c.token, target.name, status)); return; }
          showSeries(await indexFiles(await filesOfChosenFolder(c.token, status), indexProgress));
        } catch (e) { status((e as Error).message); }
        return;
      }
      const picker = (globalThis as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) { status("directory picker unavailable — use ‘DICOM files…’"); return; }
      try { const dir = await picker({ id: "slicerlive-dicom" }); status("scanning folder…"); showSeries(await indexDirectory(dir, indexProgress)); }
      catch (e) { if ((e as Error).name !== "AbortError") status((e as Error).message); }
    });
    (el.querySelector('[data-act="dicom-files"]') as HTMLButtonElement).addEventListener("click", () => dicomInput.click());

    // ---- DICOM database (an existing ctkDICOM.sql) ----
    // Listing comes from the SQL index, so the whole database appears at once and only the series
    // actually opened is read off disk. Shown in a window-sized dialog as a patient > study > series
    // tree (collapsed), because one patient with many series would otherwise fill the view.
    /**
     * WHICH VOLUME A SEG LANDS ON — the same answer loadSegSeries reaches, and it has to be the
     * same, or a prefetch decodes onto the wrong grid and warms the cache with garbage nobody can
     * use. One loaded volume from the SEG's own study is the answer; otherwise the last loaded one.
     */
    const targetForSeg = (entry: DbSeriesEntry): MrsonNode | undefined => {
      const images = [...opts.live.nodes.values()].filter((nd) => nd.type === "image" && !nd.labelmap);
      if (!images.length) return undefined;
      const sameStudy = entry.studyInstanceUID
        ? images.filter((im) => (im.origin as Record<string, unknown> | undefined)?.studyInstanceUID === entry.studyInstanceUID)
        : [];
      return sameStudy.length === 1 ? sameStudy[0] : (sameStudy[sameStudy.length - 1] ?? images[images.length - 1]);
    };

    /**
     * DECODE THE NEXT SEGMENTATION WHILE THIS ONE IS BEING BUILT.
     *
     * Ron, on a scene of five series, 2026-09-22: "waiting for everything to appear and configure.
     * Once it was done, rendering was zippy." Measured from his log: 18.7 s from the click, of
     * which the four segmentations decoded strictly one after another — 1.2 + 1.2 + 1.4 + 2.8 s —
     * while the GPU work between them left the worker idle.
     *
     * So the next one's decode starts as soon as this one's decode is done, and lands in the decode
     * cache (`seg-cache.ts`, bounded by count AND bytes, so this cannot become the memory problem
     * of this morning). ONE AHEAD, never more: two 400 MB labelmaps in flight is the ceiling.
     * Nothing waits on it and nothing fails if it loses the race — a prefetch that misses is a
     * decode that would have happened anyway.
     */
    const prefetchSeg = (db: DicomDatabase, entry: DbSeriesEntry | undefined): void => {
      if (!entry || entry.modality !== "SEG" || surfaceSeries.has(entry.seriesInstanceUID)) return;
      const t = targetForSeg(entry);
      if (!t) return;
      const ref = { dims: t.dims as [number, number, number], ijkToRAS: t.ijkToRAS as number[] };
      void (async () => {
        // NOT WHEN THE BUILT CACHE HAS IT. This read-ahead predates that cache, and it went on
        // decoding every segmentation of a scene -- on the page's own thread, 1 to 2.5 s for a
        // whole-body one -- only for the load to take the built form and never look at the result.
        // Ron's loads of 2026-09-23 were blocked 9.5 and 11.0 s, each block starting the moment a
        // series appeared, i.e. when the next one's read-ahead began; and the memory check after a
        // load whose four segmentations ALL came from the built cache still said "399 MB
        // segmentations kept decoded". The same key the load uses: the file's head, and the grid.
        const head = await db.readSeriesFileHead(entry, 4096).catch(() => null);
        if (head) {
          const k = segCacheKeyFromHead(head.head, head.totalBytes, ref);
          if (k && await getBuiltSeg(`${k}|${BUILD_CODE}`)) return;
        }
        await decodeSegmentationLazy(ref, async () => head, async () => (await db.readSeriesFiles(entry))[0]);
      })().catch(() => {});                               // a prefetch that fails costs nothing
    };

    const loadSegSeries = async (db: DicomDatabase, entry: DbSeriesEntry, label: string, note: (p: DbProgress) => void, timings: string[], arrival?: { visible3D?: boolean }) => {
      note({ note: "decoding segmentation…" });
      const tDecode = performance.now();

      const images = [...opts.live.nodes.values()].filter((nd) => nd.type === "image" && !nd.labelmap);
      if (!images.length) {
        throw new Error("load the grayscale series first — a segmentation needs the volume it was drawn on");
      }
      // Which volume a SEG's frames land on has to be decided BEFORE placing them: frame byte
      // layout is computed from the target's own row width, so the wrong target reads every frame
      // at the wrong stride -- not a slightly-off overlay but voxel-scrambled garbage. Ron,
      // loading two CT series and a SEG together: "I got garbage."
      //
      // The SEG names its volume in ReferencedSeriesSequence, but that is inside the object, and
      // reading it would mean parsing a 347 MB file twice -- once to ask, once to place. The
      // study is free: it is on the database row already, and a SEG is always in the same study
      // as the series it was drawn on. With one loaded volume from that study, that IS the answer
      // and no verification costs anything. Ron, after a version that placed first and re-placed
      // on finding out: "loading took forever" -- that re-decode is a 347 MB parse the cache
      // cannot help, since its key includes the reference geometry that just changed.
      const sameStudy = entry.studyInstanceUID
        ? images.filter((im) => (im.origin as Record<string, unknown> | undefined)?.studyInstanceUID === entry.studyInstanceUID)
        : [];
      let target = sameStudy.length === 1 ? sameStudy[0] : (sameStudy[sameStudy.length - 1] ?? images[images.length - 1]);

      // ALREADY BUILT ONCE? The chunks and the settled segment list are three megabytes and they
      // are what a second load would otherwise decode (1.2-2.5 s) and compress (0.5-1.7 s) all over
      // again. Ron, 2026-09-22, watching two of four arrive free from the decode cache: "we should
      // take every advantage that we can take." The key is the SEG object's identity and the grid
      // it is placed on, so a record cannot be for anything else.
      const headForKey = await db.readSeriesFileHead(entry, 4096).catch(() => null);
      const builtKey = headForKey
        ? segCacheKeyFromHead(headForKey.head, headForKey.totalBytes, { dims: target.dims as [number, number, number], ijkToRAS: target.ijkToRAS as number[] })
        : null;
      const alreadyBuilt = builtKey ? await span("segmentation · read the built cache", () => getBuiltSeg(`${builtKey}|${BUILD_CODE}`)) : null;
      // A RECORD IS ONLY USABLE IF IT IS FOR THIS VOLUME. The key carries the grid, and a grid does
      // not identify a volume: a sequence's frames share one. So the record carries what the SEG
      // said about its own series and instances, and the same `volumeForSeg` that the decode path
      // uses has to agree that `target` is the right one. Anything else falls through and decodes.
      const builtFits = alreadyBuilt && (() => {
        if (!alreadyBuilt.referencedSeriesUID) return true;         // the SEG named no series: the guess stands, as on the decode path
        const correct = volumeForSeg(images, { referencedSeriesUID: alreadyBuilt.referencedSeriesUID, referencedSOPInstanceUIDs: alreadyBuilt.referencedSOPInstanceUIDs });
        return !!correct && correct.id === target.id;
      })();
      if (alreadyBuilt && builtFits) {
        // THE SAME ARRIVAL AS A COLD LOAD, which this did not do. A hit returned here and skipped
        // three things the slow path does further down, so a segmentation behaved differently on
        // its second load than on its first (found 2026-09-23, reading Ron's 11.0 s load):
        //
        //  * the volume rendering was left ON while the segmentation arrived, so the arrival built
        //    a colorize field -- 1,196 MB on this study -- for the instant before something turned
        //    it off again. That is the cost the slow path moves this call above the creation for.
        //  * the presentation the network expects was never applied: same data, different look.
        //  * nothing asked for the stored surfaces. In that load three of four segmentations got
        //    theirs, and only because something else happened to draw them.
        const cachedTask = alreadyBuilt.algorithmName ?? "";
        // THE FILE'S COLORS, as a decode now keeps them (Ron, 2026-09-25: what arrives with its own colors keeps
        // them; "Use the current colors" is one click away). The record keeps the file's beside the colors of the
        // build; the file's are the ones that arrived.
        type CachedSeg = { labelValue: number; color?: number[]; fileColor?: number[] };
        const builtNow = { ...alreadyBuilt, segments: (alreadyBuilt.segments as unknown as CachedSeg[]).map((sg) =>
          sg.fileColor ? { ...sg, color: sg.fileColor } : sg) } as typeof alreadyBuilt;
        setVolumeRenderingOn(opts.live, target.id as string, !!target.sequence);
        const made = createSegmentationFromBuilt(opts.live, opts.store, target.id as string, builtNow, {
          name: label,
          ...(cachedTask ? { task: cachedTask } : {}),
          ...(arrival?.visible3D === false ? { hiddenIn3D: true } : {}),
          origin: segOrigin(entry, { sopClassUID: alreadyBuilt.sopClassUID, task: cachedTask, algorithmType: alreadyBuilt.algorithmType }),
        });
        opts.live.write({ op: "patch", id: made.segId, path: "#/colorScheme", value: "file" });
        if (cachedTask) setColorizeParams(opts.live, target.id as string, presentationParams(presentationFor(cachedTask)));
        // No surfaces asked for: a loaded segmentation has none unless given them (the firewall, 2026-09-24).
        timings.push(`${label}: from the built cache — nothing decoded or compressed`);
        note({ note: `${made.segments} segments on ${(target.name as string) ?? "the volume"} (from the built cache)` });
        status(`${label}: ${made.segments} segments on ${(target.name as string) ?? "the volume"} (from the built cache)`);
        return;
      }

      // The decode's own phase breakdown goes into the timing line. The browser spends far longer
      // here than the same work takes in Deno, and attributing that needs the phases visible where
      // the numbers are actually read rather than in a console nobody opens.
      let segDetail = "";
      const decodeOnto = (t: typeof target) =>
        // The body is read INSIDE this call, and only if the cache misses. Reading it first --
        // which is what this did -- cost 0.6s of a 4.0s load fetching 347 MB purely so a key could
        // be computed from its first few hundred bytes. The identity is in the file meta group, so
        // a 4 KB range request settles it and the body is never requested on a hit.
        decodeSegmentationLazy(
          { dims: t.dims as [number, number, number], ijkToRAS: t.ijkToRAS as number[] },
          () => db.readSeriesFileHead(entry, 4096),
          async () => (await db.readSeriesFiles(entry, note))[0],
          (r) => {
            if (r.cached) {
              const mb = r.skippedBodyBytes ? ` — ${(r.skippedBodyBytes / 1e6).toFixed(0)} MB not read` : "";
              segDetail = ` (from cache${mb})`;
              return;
            }
            const p = r.phases;
            const bits = p
              ? [
                p.loadDcmjsMs > 1 ? `dcmjs ${(p.loadDcmjsMs / 1000).toFixed(1)}s` : "",
                `parse ${(p.readFileMs / 1000).toFixed(1)}s`,
                `naturalize ${(p.naturalizeMs / 1000).toFixed(1)}s`,
                `place ${(p.placeMs / 1000).toFixed(1)}s${p.fastPath ? "" : " SLOW PATH"}`,
              ].filter(Boolean)
              : [];
            if (r.storedMs !== undefined) bits.push(`${r.keyed ? `cached in ${(r.storedMs / 1000).toFixed(1)}s` : "NOT CACHEABLE"}`);
            segDetail = bits.length ? ` [${bits.join(" · ")}]` : "";
          },
        );
      let seg = await span("segmentation decode", () => decodeOnto(target));

      // The decode itself names the series it was actually drawn on (SEG's own
      // ReferencedSeriesSequence) -- checked only now, against the guess, because getting it
      // upfront would mean parsing the SEG twice even in the ordinary one-volume case. Wrong AND
      // fixable (that series is loaded too): redo the placement on the right grid. Wrong and not
      // loaded: leave the guess in place and say so, rather than fail a load that might still be
      // what was wanted.
      // NOT ON ANOTHER PATIENT'S VOLUME. With nothing loaded from this SEG's study, the fallback
      // above is "whatever was loaded last" -- and with ONE loaded volume the check below was
      // skipped, so a segmentation of one patient was decoded onto another's head, listed as
      // its segmentation and saved into a scene as such (critic, 2026-09-20 evening, finding 2).
      // A SEG whose series is not loaded is refused by name; the person loads the series first.
      if (!sameStudy.length && seg.referencedSeriesUID && !volumeForSeg(images, seg)) {
        throw new Error(`drawn on a series that is not loaded here (…${seg.referencedSeriesUID.slice(-8)}) — load that series first`);
      }
      if (seg.referencedSeriesUID) {
        // The volume it names: by the instances it references when the frame records its
        // instances (a sequence's frames all share one series; only the instances tell them
        // apart), else by series. Ron: "The gray scales move, the segmentations and models
        // don't" -- all five phases' SEGs had landed on the first phase.
        const correct = volumeForSeg(images, seg);
        if (correct && correct.id !== target.id) {
          target = correct;
          note({ note: `this segmentation belongs to ${(target.name as string) ?? "another loaded volume"} — re-placing…` });
          seg = await decodeOnto(target);
        } else if (!correct) {
          segDetail += ` (drawn on a series not loaded here — placed on ${(target.name as string) ?? "the most recently loaded volume"} instead)`;
        }
      }
      const decodeSecs = (performance.now() - tDecode) / 1000;
      note({ note: `decoded in ${decodeSecs.toFixed(1)}s — building segmentation…` });
      const tSegIngest = performance.now();
      // WHAT THE NETWORK SAID, WHERE THE FILE IS SILENT. `SegmentAlgorithmName` tells us which
      // family produced this, and for the FreeSurfer family that is enough to restore the naming
      // and the colors the project itself publishes -- the SEG's own hues are dcmqi's generated
      // ones, and a segment whose label the writer never knew comes back as `label_2035`. Ron:
      // "The settings and organization should survive a round trip to the dicom db."
      const task = seg.algorithmName ?? "";
      const byValue = task ? usesFreesurferNumbering(task) : false;
      // LOOK EVERY SEGMENT UP: what each one IS (its catalog key), whatever color it keeps.
      const looked = seg.colors.map(([value, r, g, b]) => {
        const name = seg.names[value] ?? `Segment ${value}`;
        // BY NAME ONLY. The label VALUE here is not FreeSurfer's -- the labelmap was renumbered
        // densely to fit a byte when the result was first loaded, so value 2 is "the second
        // structure in this file" and not the left cerebral white matter. Looking a dense index up
        // in FreeSurfer's numbering would return a confident, wrong answer for every segment.
        // LOOK IT UP FOR EVERY SEGMENTATION, not only the FreeSurfer-numbered ones.
        //
        // This was `byValue ? (...) : null`, so a TotalSegmentator SEG got no structure and no
        // catalog color at all -- it fell straight through to the RGB stored in the file, which
        // is the segmenter's own and is where the common iliac artery is GOLD. Ron: "Iliac is back
        // to gold." The vessel rule lives in lookupStructure, so skipping the lookup skipped the
        // rule; the unit test passed because it called lookupStructure directly, which the app did
        // not.
        //
        // `byValue` still decides the ORDER, which is what it is actually for: three display names
        // live in both catalogs (Brainstem, Third and Fourth ventricle), so consulting
        // FreeSurfer first for a TotalSegmentator result would file those three in the brain.
        const known = byValue
          ? (freesurferStructureByName(name) ?? lookupStructure(name))
          : lookupStructure(name);
        return { value, r, g, b, name, known };
      });
      // THE FILE'S COLORS ARE KEPT (Ron, 2026-09-25): the lookup above still says WHAT each segment is; its color is
      // the one it arrived with. "Use the current colors" (logic/scheme-colors.ts) applies the scheme on request.
      const segments = looked.map(({ value, r, g, b, name, known }) => {
        return {
          labelValue: value,
          // WHICH structure, not just what to call it -- the same fix the fresh-run path already
          // carries. Three display names live in both catalogs (Brainstem, Third and Fourth
          // ventricle), so a segment stored with only its name resolves to TotalSegmentator's
          // entry and lands outside the brain. A SEG that round-trips through the database must
          // come back in the same place it went in. Ron: "The settings and organization should
          // survive a round trip to the dicom db."
          ...(known?.key ? { structure: known.key } : {}),
          name: known?.name ?? name,
          color: [r, g, b] as [number, number, number],
          // WHAT THE FILE SAID, kept beside the catalog's answer and never used as authority:
          // its codes and its color (Mike Halle, 2026-09-19/20: the catalog is the one place
          // every mapping comes from; a file's code is a cached statement of unknown authorship).
          // A re-save writes the catalog's codes where it knows the structure and these
          // where it does not (slicer-app.ts, the save).
          ...(seg.fileCodes?.[value] ? { fileCodes: seg.fileCodes[value] } : {}),
          fileColor: [r, g, b] as [number, number, number],
          ...(seg.names[value] ? { fileLabel: seg.names[value] } : {}),
        };
      });
      let buildDetail = "";
      // THE RENDERING GOES OFF BEFORE THE SEGMENTATION ARRIVES, not after (the block below says
      // why it goes off at all). After, the arrival found the rendering on and built its colorize
      // field -- 1196 MB at 768x768x709 -- for the instant before this switched it off and freed
      // it again: three seconds and a gigabyte per segmentation of a scene, for nothing (2026-09-21).
      setVolumeRenderingOn(opts.live, target.id as string, !!target.sequence);
      const made = await span("segmentation onto the GPU", () => createSegmentationFromLabelmap(
        opts.live, opts.store, target.id as string, seg.lab, segments,
        {
          name: label,
          ...(task ? { task } : {}),
          // WHICH SERIES THIS IS. Without it the segmentation does not know its own identity, and
          // the stored-surface lookup asks the database with the CT's series instead of the SEG's
          // -- so surfaces saved against this very segmentation are not found and are extracted
          // again. Ron, loading it back: "It recomputed the surfaces."
          // The type as the file said it, written back as it was: a SEMIAUTOMATIC or a
          // MANUAL-with-a-name file was re-saved as AUTOMATIC (second critic, finding 8).
          origin: segOrigin(entry, { sopClassUID: seg.sopClassUID, task, algorithmType: seg.algorithmType }),
          // 3D ON AS IT LOADS. Ron: "If a surface is loaded show it in 3d upon loading", part of
          // "I would like to minimize the clicks and travel distance with the mouse."
          //
          // This said `hiddenIn3D: true` with the note "loading a stored SEG is a review action;
          // 3D is a click away", and on 2026-09-08 Ron asked for exactly that: "by default the 3d
          // of label maps should be off when loading from the dicom db." That was when 3D meant the
          // coarse SDF -- slow to build and, in his words, looking like a quarry. Surfaces now
          // extract in 3.6 s on a brain and 15 s on a whole-body CT and he has accepted how they
          // look, so the reason for the default is gone and the click is not worth it.
          //
          // The cost is that extraction now runs unasked on load. That is the trade he is asking
          // for; if a big study makes it unwelcome, this line is where to put it back.
          //
          // EXCEPT WHEN A SCENE SAYS OTHERWISE. A scene being opened knows whether this
          // segmentation was in 3D; arriving in 3D and then being put back showed the surfaces for
          // a moment before the volume rendering took over (Ron, 2026-09-20: "briefly showed a
          // surface and then switched to volume rendering"). The saved state arrives with it.
          ...(arrival?.visible3D === false ? { hiddenIn3D: true } : {}),
          onPhases: (p) => {
            buildDetail = ` [histogram ${(p.histogramMs / 1000).toFixed(1)}s · deflate ${(p.ingestMs / 1000).toFixed(1)}s]`;
            // Into the profile as their own phases: this is where "segmentation onto the GPU"
            // actually goes, and the two halves answer different questions (one is a pass over
            // 418 million voxels, the other is compression that already runs in the worker pool).
            noteMs("labelmap · count the voxels (histogram)", p.histogramMs);
            noteMs("labelmap · compress into the store (deflate)", p.ingestMs);
          },
        },
      ));
      // KEEP THE BUILD. Failures are swallowed inside putBuiltSeg: a load that has succeeded must
      // not fail on the way out, and a cache that cannot write is only a slower next load.
      if (builtKey && made.built) {
        void putBuiltSeg(`${builtKey}|${BUILD_CODE}`, {
          desc: made.built.desc, chunks: Object.fromEntries(made.built.chunks), segments: made.built.segments, code: BUILD_CODE,
          ...(task ? { algorithmName: task } : {}),
          ...(seg.sopClassUID ? { sopClassUID: seg.sopClassUID } : {}),
          ...(seg.algorithmType ? { algorithmType: seg.algorithmType } : {}),
          // Kept so a later hit can answer "which volume is this for" (see BuiltSeg).
          ...(seg.referencedSeriesUID ? { referencedSeriesUID: seg.referencedSeriesUID } : {}),
          ...(seg.referencedSOPInstanceUIDs ? { referencedSOPInstanceUIDs: seg.referencedSOPInstanceUIDs } : {}),
        });
      }

      // The appearance its family expects, restored. Applied only when the SEG names the network
      // that made it -- guessing a presentation for an anonymous SEG would be worse than leaving
      // the default, which is at least a stated choice.
      if (task) setColorizeParams(opts.live, target.id as string, presentationParams(presentationFor(task)));

      // NO SURFACES ASKED FOR. They were, on every load, until the firewall (Ron, 2026-09-24: surface models
      // no longer first-class; stored ones come back "only via the new module"). A segmentation loaded
      // here has none; Generate Surface Models gives them, and a scene that had them brings the flag back
      // (scene-restore), which the display manager then honors on its own.

      // AND THE GRAYSCALE STEPS OUT OF THE WAY IN 3D. Ron: "after loading, the volume 3d is on. I
      // have to go to scene data to turn it off ... On load, it should turn surface on and 3D in
      // volume off. That saves a few module hops."
      //
      // The Volume Rendering module switches 3D on for the first scalar volume that loads, which is
      // right when a volume is all there is. It stops being right the moment a segmentation of that
      // volume arrives: what you opened it to see is the structures, and the volume render sits in
      // front of them. So loading a SEG hands the 3D view to the segmentation -- which is not a
      // change to the data, and the volume's own 3D button turns it back on in one click.
      // setVolumeRenderingOn, NOT a patch to `visible3D`. That field is the SEGMENTATION's 3D
      // toggle; a volume's 3D rendering is `volumeRenderingDisplay.visible`, which is what
      // livescene reads (`slot.visible = !!node.visible`) and what the Subject Hierarchy's own 3D
      // button sets for an image. Patching the image's `visible3D` writes a field nothing consults
      // for a volume, which is why Ron saw the volume render still in front of the surfaces after
      // two attempts at this: "volume 3d is on."
      // Except on a sequence: there the colorized volume rendering is the moving picture, and
      // the surfaces are one still mesh (see the same choice in ai-seg-panel). Done above, before
      // the segmentation is created.
      const segIngestSecs = (performance.now() - tSegIngest) / 1000;
      const onName = (target.name as string) ?? "the loaded volume";
      const skipped = seg.emptySegments.length ? `, ${seg.emptySegments.length} empty skipped` : "";
      // SAID, NOT SWALLOWED: a SEG whose segments overlap (Slicer's nnInteractive writes them as
      // layers) loses the overlaps to a labelmap, last frame wins. The count goes into the load
      // message the way contested voxels are reported in a merge (critic, 2026-09-17, finding 3).
      const overlapped = seg.overlapVoxels
        ? `; ${seg.overlapVoxels.toLocaleString()} voxels were claimed by two segments and the later one was kept — a save from here writes them that way`
        : "";
      const outside = seg.framesOutside
        ? `; ${seg.framesOutside.toLocaleString()} of its frames fall outside this volume and are not shown — the file holds more than the volume can place`
        : "";
      timings.push(`SEG decode ${decodeSecs.toFixed(1)}s${segDetail}, build ${segIngestSecs.toFixed(1)}s${buildDetail}`);
      opts.live.write({ op: "patch", id: made.segId, path: "#/colorScheme", value: "file" });
      status(`${label}: ${made.segments} segments on ${onName}${skipped}${overlapped}${outside}`);
    };

    /**
     * The provenance edges, cached for a moment: which series was derived from which, and how.
     *
     * Two fetches (the registry and the table) that every surfaces lookup repeated. The table is
     * written only by a save or a delete, and both go through the app, so a short life plus an
     * explicit drop is enough — and a stale answer here would mean surfaces not found, which the
     * caller already handles as "none stored".
     */
    let provenanceCache: { at: number; edges: { child: string; parent: string; kind: string; createdAt?: string }[] } | null = null;
    // DROPPED BY EVERY WRITER, not by one of them. This was cleared only by `__refreshDicomDb`, and
    // the main writer of surface edges -- saving a segmentation with its surfaces -- does not call
    // it: the memo then answered "no surfaces" for a full minute and the next load re-extracted
    // them, 15 s on a whole-body study, silently (critic, 2026-09-22, finding 6). Every save now
    // calls it through the global, and every reopening of the database snapshot drops it too, since
    // an answer about series that are no longer the ones in hand is not an answer.
    const forgetProvenance = () => { provenanceCache = null; };
    (globalThis as unknown as { __forgetProvenance?: () => void }).__forgetProvenance = forgetProvenance;
    const provenanceEdges = async (): Promise<{ child: string; parent: string; kind: string; createdAt?: string }[] | null> => {
      if (provenanceCache && performance.now() - provenanceCache.at < 60000) return provenanceCache.edges;   // a write drops it; see forgetProvenance
      const reg = await fetch("/_db", { cache: "no-store" }).then((x) => x.ok ? x.json() : null).catch(() => null);
      const list = (reg?.databases ?? []) as { id: string; current?: boolean; exists?: boolean }[];
      const cur = list.find((d) => d.current && d.exists) ?? list.find((d) => d.exists);
      if (!cur) return null;
      const r = await fetch(`/_db/${encodeURIComponent(cur.id)}/_provenance`, { cache: "no-store" }).catch(() => null);
      if (!r?.ok) return null;
      const edges = ((await r.json()).edges ?? []) as { child: string; parent: string; kind: string; createdAt?: string }[];
      provenanceCache = { at: performance.now(), edges };
      return edges;
    };

    const withAncestors = (chosen: DbSeriesEntry[]): DbSeriesEntry[] => {
      const byUid = new Map((openDb?.series ?? []).map((s) => [s.seriesInstanceUID, s]));
      const out: DbSeriesEntry[] = [];
      const placed = new Set<string>();
      const add = (s: DbSeriesEntry, guard: Set<string>) => {
        const uid = s.seriesInstanceUID;
        if (placed.has(uid) || guard.has(uid)) return;
        guard.add(uid);
        // A SEGMENTATION needs the image it was drawn on; a derived IMAGE (a cropped volume)
        // stands on its own. Bringing a cropped CT's parent along made the load fail on a
        // parent the user never asked for (a JPEG Lossless original) and the window stay
        // open on the failure -- Ron: "Load and close loaded but did not close."
        const par = s.modality === "SEG" ? derivedFrom.get(uid) : undefined;
        const parent = par ? byUid.get(par) : undefined;
        if (parent) add(parent, guard);            // the thing it is derived FROM goes in first
        if (!placed.has(uid)) { placed.add(uid); out.push(s); }
      };
      for (const s of chosen) add(s, new Set());
      return out;
    };

    /** An image in the scene that came from this very series (a sequence's frames included). */
    const alreadyLoaded = (entry: DbSeriesEntry) =>
      [...opts.live.nodes.values()].some((nd) => {
        const org = nd.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
        // A volume by its series; a segmentation by the SEG series it was read from or saved as
        // (opening a scene over the same study must find its segmentations, not load them twice).
        return (nd.type === "image" && org?.seriesInstanceUID === entry.seriesInstanceUID) ||
          (nd.type === "segmentation" && (org?.savedSeriesInstanceUID === entry.seriesInstanceUID || org?.seriesInstanceUID === entry.seriesInstanceUID));
      });


    /**
     * LOAD A LIST OF SERIES FROM THE OPEN DATABASE -- the browser's own loop, hoisted so a saved
     * scene loads through exactly the path a tick in the browser takes (SCENE-DESIGN §5): images
     * before segmentations, ancestors first, a series already in the scene not loaded twice, the
     * frames of a sequence prepared, the surfaces fetched with their segmentation. `setBusy` is
     * where progress goes; `timings` and `failures` come back filled.
     */
    /** Surfaces series ticked in the last load (loadDbEntries fills it; the browser offers the module). */
    let surfacesTicked: string[] = [];
    const loadDbEntries = async (db: DicomDatabase, list: DbSeriesEntry[], setBusy: (s: string) => void, timings: string[], failures: string[], arrivalFor?: (seriesInstanceUID: string) => { visible3D?: boolean } | undefined, onEach?: () => void): Promise<void> => {
    for (const [n, entry] of list.entries()) {
      // The SCENE name, which is the only thing identifying what was loaded once the browser
      // has closed. Not the browser's own row label, which is nested under a patient and a study.
      let label = seriesLabel(entry);
      try {
        // The timing lines are captured, not just displayed: the final "loaded" message would
        // otherwise overwrite them within milliseconds and the measurement would be unreadable.
        const note = (p: DbProgress) => {
          if (p.note.startsWith("read ") || p.note.startsWith("parsed ")) timings.push(p.note);
          setBusy(`(${n + 1}/${list.length}) ${label}: ${p.note}`);
        };
        setBusy(`(${n + 1}/${list.length}) ${label}: ${""}`);
        // ONCE. A series already in the scene is not loaded again: a cardiac
        // sequence loaded twice, the Sequences module then played one copy while the 3D showed the
        // other, and nothing moved -- "No beating heart." Loaded is loaded; the row says so.
        if (!surfaceSeries.has(entry.seriesInstanceUID) && alreadyLoaded(entry)) {
          timings.push(`${label}: already loaded — not loaded again`);
          continue;
        }
        // STORED SURFACES ARE NOT LOADED HERE, AND NOT WITH THEIR SEGMENTATION EITHER. Since the firewall
        // (Ron, 2026-09-24: stored surfaces come back "only via the new module") they come back only when
        // Generate Surface Models is asked; `withAncestors` has put the segmentation earlier in this list,
        // and the browser offers that module when the load ends (surfacesTicked). This line said "loaded
        // … as its 3D surfaces" when nothing was (critic, 2026-09-24, finding 9).
        if (surfaceSeries.has(entry.seriesInstanceUID)) {
          surfacesTicked.push(label);
          timings.push(`${label}: stored surface models, not loaded — Generate Surface Models brings them back`);
        } // A SEG is not a volume: it is a set of 1-bit masks placed on ANOTHER series' grid, so
        // it is decoded onto a loaded volume rather than reconstructed on its own.
        else if (entry.modality === "SEG") {
          // A SEGMENTATION WE WROTE ALREADY HAS A NAME. Its SeriesDescription is the scene name
          // it was saved under ("ts:total of CT series 2"), so wrapping it in the patient and the
          // date a second time produces the doubled label the hierarchy then truncates. An
          // acquired SEG from elsewhere has no such name and still gets the full label.
          const own = realDescription(entry.description);
          if (own && /\bof\b/.test(own)) label = own;
          prefetchSeg(db, list[n + 1]);                 // the next one decodes while this one is built
          await loadSegSeries(db, entry, label, note, timings, arrivalFor?.(entry.seriesInstanceUID));
        }
        else {
          // A SERIES IN TIME comes as its frames. A gated coronary CTA holds five cardiac
          // phases in one series and a bolus-monitoring series holds ten frames of one slice;
          // both arrive here as a sequence (logic/sequences.ts), the first frame in the views.
          //
          // FROM THE DUCKN WORKING COPY when Settings › Loading says so and the series has a valid
          // one (render/zarr-copy.ts; the workspace brief Contents/docs/DUCKN-WORKING-COPY.md): one
          // description and the pieces instead of every file. The same volumes either way; without
          // a copy, or with one the server will not vouch for, the DICOM files as always -- and the
          // status line says which, so a measurement is never of the path it was not.
          const dbBase = /\/_db\/[^/]+\/$/.test(db.label) ? db.label : null;
          const copy = (globalThis as unknown as { __zarrCopies?: boolean }).__zarrCopies && dbBase && entry.modality !== "SEG"
            ? await span("volume · from the duckn copy", () => loadSequenceFromCopy(dbBase, entry.seriesInstanceUID)).catch((e) => ({ missing: String((e as Error)?.message ?? e) }))
            : null;
          if (copy && "missing" in copy) timings.push(`no duckn copy used (${copy.missing}) — read from DICOM`);
          const fromCopy = copy && !("missing" in copy) ? copy : null;
          const seq = fromCopy ?? await db.loadSequence(entry, note);
          if (fromCopy) {
            noteMs("volume · copy: the description", fromCopy.ms.describe);
            noteMs("volume · copy: fetch and unpack the pieces", fromCopy.ms.pieces);
            noteMs("volume · copy: put the pieces in place (on the page)", fromCopy.ms.place);
            const mb = fromCopy.packedBytes / 1e6;
            timings.push(`from the duckn copy: ${fromCopy.pieces} pieces, ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`);
          } else if ("phasesMs" in seq && seq.phasesMs) {
            noteMs("volume · read the files", seq.phasesMs.read);
            noteMs("volume · parse and decode", seq.phasesMs.parse);
            noteMs("volume · assemble the volume", seq.phasesMs.reconstruct);
          }
          if (seq.frames.length > 1) {
            const tIngest = performance.now();
            const meta = { shortLabel: seriesLabelShort(entry), leftOut: seq.leftOut, inDatabase: true };
            const r = await loadSequenceIntoScene(opts.live, opts.store, seq.frames, seq.labels, {
              name: label, meta, timing: seq.timing, onFrame: (i, n) => setBusy(`${label}: storing frame ${i + 1} of ${n}…`),
            });
            // EVERY FRAME READY BEFORE THE FIRST PLAY. Frames 2-5 used to be built the first
            // time each showed -- during the first loop of Play, each a fetch, a conversion and
            // a 279 MB upload on the main thread while the play timer kept firing: the stutter
            // before the heart beat (critic, 2026-09-19, finding 4). Built here, with the
            // status line saying so; the samples were just written, so this is the chunks
            // read back once per frame and nothing else.
            const layers = opts.live.managers.find((m): m is VolumeLayersDisplayableManager => m instanceof VolumeLayersDisplayableManager);
            const tPrep = performance.now();
            await layers?.prepare(r.frameIds.slice(1), opts.live, (i, n) => setBusy(`${label}: preparing frame ${i + 2} of ${n + 1}…`));
            timings.push(`frames prepared ${((performance.now() - tPrep) / 1000).toFixed(1)}s`);
            // THE SCANNER'S OWN PICTURES OF THIS RECONSTRUCTION -- the ECG it gated on -- come
            // with the sequence, not as a series to tick: on their own they mean nothing.
            const docs = await loadSequenceDocuments(db, entry, note);
            if (docs.length) {
              opts.live.write({ op: "patch", id: r.sequenceId, path: "#/documents", value: docs });
              timings.push(`${docs.reduce((n, d) => n + d.images.length, 0)} ECG picture${docs.length === 1 && docs[0].images.length === 1 ? "" : "s"} with it`);
            }
            const first = seq.frames[0];
            const b = rasBounds(first.dims, first.ijkToRAS);
            opts.onLoaded?.({ name: label, imageId: r.frameIds[0], source: "dicom-db", rasLo: b.lo, rasHi: b.hi, ijkToRAS: first.ijkToRAS });
            timings.push(`${seq.frames.length} frames (${seq.labels[0]} … ${seq.labels[seq.labels.length - 1]}) · ingest ${((performance.now() - tIngest) / 1000).toFixed(1)}s`);
            continue;
          }
          const vol = seq.frames[0];
          if (seq.leftOut.length) (vol as { meta?: Record<string, unknown> }).meta = { ...((vol as { meta?: Record<string, unknown> }).meta ?? {}), leftOut: seq.leftOut };
          const named = vol as { name?: string; meta?: Record<string, unknown> };
          // Carried into `origin` by the ingest, for whatever gets named after this volume.
          named.meta = { ...(named.meta ?? {}), shortLabel: seriesLabelShort(entry) };
          // ALWAYS THE IDENTIFYING LABEL, not only when the reader left the name empty. It never
          // does: dicom-series.ts sets `seriesDescription || modality || "DICOM"`, so the
          // fallback here could not fire and the scene went on showing "= NONE =" after this was
          // supposedly fixed. Ron, looking at it: "it is still called none."
          //
          // Nothing is lost by overriding. The reader's name IS the series description, which is
          // the first thing `seriesLabel` uses; what the label adds is the patient and the date,
          // which the reader has no way to know because it is handed instances, not an index row.
          named.name = label;
          // Timed separately: this is where the volume is compressed into zarr and stored, and
          // with parsing at 0.2s it is the remaining candidate for the long wait.
          const tIngest = performance.now();
          await span("volume onto the GPU (ingest)", () => loadVolumeObj(vol, "dicom-db"));
          const ip = lastIngestPhases;
          // The part of the ingest that runs on the page's own thread: copying the volume into
          // padded chunks for the workers.
          if (ip) noteMs("volume · cut into chunks (on the page)", ip.materializeMs);
          const ingestDetail = ip
            ? ` [${ip.compressor} · copy ${(ip.materializeMs / 1000).toFixed(1)}s · ${ip.workers ? `${ip.workers} workers` : `codec ${(ip.codecMs / 1000).toFixed(1)}s`} · ${ip.chunks} chunks]`
            : "";
          timings.push(`ingest ${((performance.now() - tIngest) / 1000).toFixed(1)}s${ingestDetail}`);
          // A GAP OR AN OVERLAP IN THE SLICE POSITIONS, said where it survives: the first version
          // of this warning sat on a path the browser never takes and was overwritten by the
          // next progress line where it did (second critic, 2026-09-17, finding 4). The volume is
          // shown on a regular grid anyway, so a structure near the gap lands on the wrong slice
          // and a segmentation saved from it would too.
          const irr = (vol as { meta?: { irregularSpacing?: { worstMm: number; atSlice: number } } }).meta?.irregularSpacing;
          if (irr) {
            const warning = `WARNING: the slices of ${label} are not evenly spaced — slice ${irr.atSlice + 1} is ${irr.worstMm.toFixed(1)} mm off a regular grid (a gap or an overlap in the acquisition). Positions near there are wrong on screen, and a segmentation saved from this volume would be too`;
            timings.push(warning);
            shell.notify({ title: "Uneven slice spacing", body: warning, actions: [{ label: "OK", primary: true, onClick: () => {} }] });
          }
        }
        onEach?.();                    // paint what is here before the next series starts
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`);
        // THE STACK, to the console and the session log: the message alone ("Cannot read properties of
        // undefined") cost a round of guessing on 2026-09-24.
        console.error(`load of ${label} failed:`, e);
        void fetch("/_log", { method: "POST", body: `load of ${label} failed: ${(e as Error)?.stack ?? e}`, keepalive: true }).catch(() => {});
      }
    }
    };

    const showDatabaseBrowser = async (db: DicomDatabase, dirName: string, reopen: (pick: boolean) => void) => {
      // Whether this runtime can even show a folder chooser. WKWebView cannot: the File System
      // Access API is not there, so `showDirectoryPicker` is undefined and "Change…" can never
      // succeed in the native app.
      const canPick = typeof (globalThis as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
      // THE WINDOW ITSELF IS SHARED. Its chrome -- title bar, drag, resize, the traffic lights, Escape --
      // lives in floating-window.ts, lifted from here unchanged, so the network browser and every window
      // after it quit the same way. Ron: "quitting the window should be the same as the dicom window and
      // future windows."
      // The FULL PATH in the title, not the folder name. Ron: "It should also display the full path." Two
      // databases can end in the same folder name, and the one thing he needed to know when the wrong
      // one was open was which one it was.
      const { box, head, close } = openFloatingWindow({ title: `DICOM database — ${dirName}`, titleTip: dirName });
      const changeBtn = document.createElement("button");
      changeBtn.textContent = "Change…";
      changeBtn.title = "Open a different DICOM database";
      // Do NOT close first. Ron: "when I click on Open a different database, the dicom window
      // disappears" -- and that is exactly what it did: close() ran, then reopen(true) found no
      // folder picker, wrote one line to the status bar at the bottom of the window, and returned.
      // The dialog was already gone, so the only explanation went somewhere nobody was looking.
      //
      // A modal must not close on an action that may not succeed. Where picking is impossible the
      // reason is said HERE, in the dialog, and the dialog stays.
      changeBtn.addEventListener("click", async () => {
        // Switching databases does not need a folder picker: the registered ones are in the
        // settings file, so this offers them. The picker is only for adding one that is not
        // registered yet, and WKWebView not having it is therefore a limit on ADDING rather than on
        // changing -- which is what the previous message got wrong, along with naming a /dicomdb
        // route that no longer exists.
        const list = await fetch("/_db", { cache: "no-store" })
          .then((r) => r.ok ? r.json() : { databases: [] })
          .then((j) => (j.databases ?? []) as { id: string; path: string; exists: boolean; current: boolean }[])
          .catch(() => []);
        const others = list.filter((d) => !d.current);

        if (others.length) {
          setBusy("choose a database:");
          const box = document.createElement("div");
          box.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:6px 0;";
          for (const d of others) {
            const b = document.createElement("button");
            b.textContent = `${d.id} — ${d.path}${d.exists ? "" : "  (not reachable)"}`;
            b.disabled = !d.exists;
            b.style.cssText = "text-align:left;font:11px ui-monospace,Menlo,monospace;";
            b.addEventListener("click", async () => {
              await fetch("/_db", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ current: d.id }),
              });
              close();
              reopen(false);   // the newly-current one, no picker involved
            });
            box.appendChild(b);
          }
          if (canPick) {
            const add = document.createElement("button");
            add.textContent = "Choose a folder…";
            add.addEventListener("click", () => { close(); reopen(true); });
            box.appendChild(add);
          }
          msg.after(box);
          return;
        }

        if (canPick) { close(); reopen(true); return; }

        // Nothing else registered and no picker: say where to register one, by full path, because
        // that file is the only place this is configured.
        const where = await fetch("/_settings", { method: "HEAD" })
          .then((r) => r.headers.get("x-settings-path") ?? "the settings file")
          .catch(() => "the settings file");
        setBusy(
          `Only one database is registered. Add another under [Database] in ${where} ` +
            `— one line, name=/full/path — then press Change again. ` +
            `(Choosing a folder interactively needs Edge or Chrome; WKWebView has no folder picker.)`,
        );
      });
      const counts = document.createElement("span");
      counts.style.cssText = "opacity:.65;";
      const filter = document.createElement("input");
      filter.placeholder = "";
      filter.classList.add("sl-search");
      filter.title = "Type a patient, study or series to narrow the list";
      filter.style.cssText = "margin-left:auto;min-width:240px;padding:5px 8px;border-radius:6px;" +
        "border:1px solid var(--sl-line-strong);background:var(--sl-fill-hover);color:inherit;font:inherit;";
      const expandBtn = document.createElement("button");
      expandBtn.textContent = "Expand all";
      expandBtn.title = "Open every patient and study";
      const collapseBtn = document.createElement("button");
      collapseBtn.textContent = "Collapse all";
      collapseBtn.title = "Close every patient and study";

      // No separate Close button: the red light closes, and Escape still does too.
      // Credit for the zarr working-copy format the series cache is built on.
      const credit = document.createElement("span");
      credit.style.cssText = "color:var(--sl-warn);font-size:11px;white-space:nowrap;opacity:.9;";
      const duckn = document.createElement("a");
      duckn.textContent = "duckn";
      duckn.href = "https://github.com/mhalle/duckn";
      duckn.target = "_blank";
      duckn.rel = "noopener";
      duckn.title = "duckn: a Zarr-based imaging format with DICOM round-trip (Apache-2.0)";
      duckn.style.cssText = "color:inherit;text-decoration:underline;";
      credit.append("powered by ", duckn, " — Michael Halle");
      head.append(changeBtn, counts, filter, expandBtn, collapseBtn, credit);

      // --- tree model: patient > study > series ---
      // Group rows carry TOTALS, not row counts: the "Images" column means instances everywhere, so
      // a patient or study must sum its instances rather than report how many children it has.
      interface StudyGroup { key: string; description: string; date: string; series: DbSeriesEntry[]; images: number; mods: Set<string> }
      interface PatientGroup { key: string; id: string; name: string; studies: StudyGroup[]; images: number; mods: Set<string>; dates: string[] }
      const patients: PatientGroup[] = [];
      const pIndex = new Map<string, PatientGroup>();
      for (const s of db.series) {
        const pKey = s.patientID || s.patientName || "(unknown)";
        let p = pIndex.get(pKey);
        if (!p) {
          p = { key: pKey, id: s.patientID ?? "", name: s.patientName || s.patientID || "(unknown patient)", studies: [], images: 0, mods: new Set(), dates: [] };
          pIndex.set(pKey, p);
          patients.push(p);
        }
        const stKey = s.studyInstanceUID || "(unknown study)";
        let st = p.studies.find((x) => x.key === stKey);
        if (!st) {
          st = { key: stKey, description: s.studyDescription || "(no study description)", date: s.studyDate || "", series: [], images: 0, mods: new Set() };
          p.studies.push(st);
        }
        st.series.push(s);
        st.images += s.count;
        if (s.modality) st.mods.add(s.modality);
        p.images += s.count;
        if (s.modality) p.mods.add(s.modality);
        if (s.studyDate) p.dates.push(s.studyDate);
      }

      // DERIVATION, from the provenance database beside this DICOM database.
      //
      // A series can be made FROM another one -- a cropped volume from the original, a segmentation
      // from the volume it was drawn on -- and the flat patient/study/series tree could not say so:
      // "Series E" sat as a sibling of the volume it segments.
      // DICOM only carries half of this (a SEG references its source series; a derived CT generally
      // does not), and reading even that means opening every file. Slicer/DICOMProvenance already
      // records the whole chain as edges, so the browser asks for them.
      //
      // Absent or unreachable provenance is not an error: the tree simply stays flat, which is what
      // it was before.
      const parentOf = new Map<string, string>();
      // What KIND of derivation, which is how a stored-surface series is told from a labelmap SEG:
      // both are Modality "SEG" in the index, and the index carries no SOP class.
      const kindOf = new Map<string, string>();
      // WHAT ELSE IS KNOWN ABOUT A SERIES, and how big it is. Ron: "we should add Collection and
      // total size to the dicom database." Neither is in the DICOM files or Slicer's index. The
      // collection comes from the provenance store (looked up from IDC, or recorded at fetch, or
      // typed by a person -- and a person's word outranks the other two); the size is the server
      // adding up the files the index names. Both ride the same round trip as the edges.
      let paintSizes: () => void = () => {};          // assigned once the rows exist
      let paintCollections: () => void = () => {};
      const collectionOf = new Map<string, { value: string; source: string }>();
      const licenseOf = new Map<string, string>();
      // COHORTS (desktop/db-index.ts): the person's own grouping of patients and studies.
      interface CohortRow { name: string; created: string; patients: string[]; studies: string[] }
      let cohortList: CohortRow[] = [];
      const studyOwner = new Map<string, string>();     // study UID -> patient ID, for "a patient in a cohort brings its studies"
      const seriesByUid = new Map(db.series.map((se) => [se.seriesInstanceUID, se]));
      // SAVED SCENES, by study (SCENE-DESIGN §6): rows in the provenance store, listed by the server.
      interface SceneRow { uid: string; study: string; name: string; producer: string; producedAt: string; v: number; bytes: number; series?: number; studies?: string[] }
      const scenesOf = new Map<string, SceneRow[]>();
      const sizeOf = new Map<string, number>();
      let dbId: string | null = null;
      try {
        const reg = await fetch("/_db", { cache: "no-store" }).then((x) => x.ok ? x.json() : null);
        const list = (reg?.databases ?? []) as { id: string; current?: boolean; exists?: boolean }[];
        const cur = list.find((d) => d.current && d.exists) ?? list.find((d) => d.exists);
        dbId = cur?.id ?? null;
        const r = cur
          ? await fetch(`/_db/${encodeURIComponent(cur.id)}/_provenance`, { cache: "no-store" })
          : new Response(null, { status: 404 });
        if (cur) {
          try {
            const co = await fetch(`/_db/${encodeURIComponent(cur.id)}/_cohorts`, { cache: "no-store" }).then((x) => x.ok ? x.json() : null) as { cohorts?: CohortRow[] } | null;
            cohortList = co?.cohorts ?? [];
          } catch { cohortList = []; }
          try {
            const sc = await fetch(`/_db/${encodeURIComponent(cur.id)}/_scenes`, { cache: "no-store" }).then((x) => x.ok ? x.json() : null) as { scenes?: SceneRow[] } | null;
            // Under EVERY study the scene names: a ReMIND case's pre-op, intra-op MRI and intra-op US are three studies of one patient.
            for (const row of sc?.scenes ?? []) for (const st of new Set(row.studies?.length ? row.studies : [row.study])) { const list = scenesOf.get(st) ?? []; list.push(row); scenesOf.set(st, list); }
          } catch { /* no scene store here: no scene rows */ }
          void fetch(`/_db/${encodeURIComponent(cur.id)}/_sizes`, { cache: "no-store" })
            .then((x) => x.ok ? x.json() : null)
            .then((j) => { for (const [uid, b] of Object.entries((j?.sizes ?? {}) as Record<string, number>)) sizeOf.set(uid, b); paintSizes(); })
            .catch(() => {});
        }
        if (r.ok) {
          const body = await r.json();
          const edges = (body.edges ?? []) as { child: string; parent: string; kind: string }[];
          for (const a of (body.attributes ?? []) as { uid: string; key: string; value: string; source: string }[]) {
            if (a.key === "collection") collectionOf.set(a.uid, { value: a.value, source: a.source });
            if (a.key === "license") licenseOf.set(a.uid, a.value);
          }
          // A "note" is an annotation, not a derivation; only edges that MAKE one series from
          // another shape the tree.
          for (const e of edges) {
            if (e.kind === "note" || !e.child || !e.parent) continue;   // a note annotates; it does not derive
            parentOf.set(e.child, e.parent);
            kindOf.set(e.child, e.kind);
            if (e.kind === "surface") surfaceSeries.add(e.child);
            derivedFrom.set(e.child, e.parent);
          }
        }
      } catch { /* no provenance here: the tree stays flat */ }

      const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
      const mods = (s: Set<string>) => [...s].sort().join("/");
      /**
       * A series' own date and time, readable. DICOM writes them as 20260906 / 194707.
       *
       * The TIME is the point of it: several crops of one study are made on the same day, and Ron
       * has to be able to tell them apart before discarding two of them -- "If I create three on the
       * same day and eventually discard two of them, I want to ensure that I dont have a mess."
       */
      const seriesWhen = (d?: string, t?: string) => {
        const day = /^\d{8}$/.test(d ?? "") ? `${d!.slice(0, 4)}-${d!.slice(4, 6)}-${d!.slice(6, 8)}` : (d ?? "");
        const clock = /^\d{4,6}/.test(t ?? "") ? ` ${t!.slice(0, 2)}:${t!.slice(2, 4)}` : "";
        return day ? day + clock : "";
      };
      /** A patient spans studies, so the Date column shows the range (or the single date). */
      const dateSpan = (ds: string[]) => {
        if (!ds.length) return "";
        const lo = ds.reduce((a, b) => (a < b ? a : b)), hi = ds.reduce((a, b) => (a > b ? a : b));
        return lo === hi ? lo : `${lo} – ${hi}`;
      };

      const scroll = document.createElement("div");
      // min-width:0 is load-bearing. A flex item defaults to min-width:auto, so this pane grew to
      // its content's width instead of scrolling, and the dialog's overflow:hidden then clipped the
      // right-hand columns with no scrollbar anywhere to reach them.
      scroll.style.cssText = "flex:1 1 auto;min-width:0;overflow:auto;";
      const table = document.createElement("table");
      // table-layout:fixed so the declared column widths are honored (auto layout let the name
      // column push the others off the edge); min-width keeps them legible, scrolling below that.
      table.style.cssText = "width:100%;min-width:760px;table-layout:fixed;border-collapse:collapse;";
      const th = (h: string, extra = "") =>
        `<th style="position:sticky;top:0;background:var(--sl-bg);text-align:left;padding:6px 10px;` +
        `border-bottom:1px solid var(--sl-line);font-size:11px;text-transform:uppercase;` +
        `letter-spacing:.6px;opacity:.7;${extra}">${h}</th>`;
      // The name column has a width of its own; the LAST column, the count note, is the one
      // without, so a wide window widens the note's slack and not the names. Ron, on a full-screen
      // browser: "The first column is too wide." Draggable like the rest.
      table.innerHTML = "<thead><tr>" + th("Patient / Study / Series", "width:460px") +
        th("Date", "width:132px") + th("Modality", "width:96px") +
        th("Images", "text-align:right;width:92px") + th("Size", "text-align:right;width:84px") +
        th("Collection", "width:190px") + th("Cohorts", "width:200px") + th("") + "</tr></thead>";

      // Drag the divider at a header's right edge to resize that column. With table-layout:fixed the
      // header's width IS the column width, so this is a single style write. Per-dialog, not saved.
      for (const [i, h] of [...table.querySelectorAll("th")].entries()) {
        const head = h as HTMLTableCellElement;
        if (i === 6) continue;                       // nothing to drag against past the last column
        // A WIDE hit area (16px) with a small visible double line inside it. The line says the
        // divider is grabbable at all; the generous target means it does not have to be hit
        // precisely. Only the marker is 3px — the grab zone is five times that.
        const grip = document.createElement("div");
        grip.style.cssText = "position:absolute;top:0;right:-8px;width:16px;height:100%;cursor:col-resize;" +
          "user-select:none;display:flex;align-items:center;justify-content:center;";
        grip.title = "Drag to resize this column";
        const mark = document.createElement("div");
        mark.style.cssText = "width:3px;height:60%;border-left:1px solid currentColor;" +
          "border-right:1px solid currentColor;opacity:.45;transition:opacity 90ms;";
        grip.appendChild(mark);
        grip.addEventListener("click", (e) => e.stopPropagation());   // a resize is not a sort
        grip.addEventListener("mouseenter", () => { mark.style.opacity = "1"; });
        grip.addEventListener("mouseleave", () => { mark.style.opacity = ".45"; });
        head.appendChild(grip);
        grip.addEventListener("mousedown", (e: MouseEvent) => {
          e.preventDefault(); e.stopPropagation();   // the header row is not a sort/toggle target
          const x0 = e.clientX, w0 = head.getBoundingClientRect().width;
          mark.style.opacity = "1";                  // stays lit for the whole drag, not just hover
          const move = (m: MouseEvent) => { head.style.width = `${Math.max(40, w0 + m.clientX - x0)}px`; };
          const up = () => {
            mark.style.opacity = ".45";
            globalThis.removeEventListener("mousemove", move); globalThis.removeEventListener("mouseup", up);
          };
          globalThis.addEventListener("mousemove", move);
          globalThis.addEventListener("mouseup", up);
        });
      }
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      scroll.appendChild(table);

      // --- footer ---
      const foot = document.createElement("div");
      foot.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:8px 14px;" +
        "border-top:1px solid var(--sl-line);";
      const msg = document.createElement("span");
      msg.style.cssText = "opacity:.8;flex:1 1 auto;";
      // Two actions, bottom-right where a dialog's confirming actions belong, with the one that
      // ENDS the task carrying the accent -- theme.css's --sl-accent is Slicer's blue lifted for
      // dark. "Load" keeps the browser open so several series can be pulled in without reopening it.
      const loadBtn = document.createElement("button");
      loadBtn.disabled = true;
      loadBtn.title = "Load the selected series and keep browsing";
      const loadCloseBtn = document.createElement("button");
      loadCloseBtn.className = "sl-primary";
      loadCloseBtn.disabled = true;
      loadCloseBtn.textContent = "Load and close";
      loadCloseBtn.title = "Load the selected series and close this window";
      // TAKING SOMETHING OUT OF THE ARCHIVE. Ron: "One thing that I still don't know: how to delete
      // a data set in the dicom data base." The answer was genuinely "you cannot" -- the audited
      // delete existed with no route and no button. It belongs here, where the series are: the Data
      // panel owns the SCENE and unloading is its job, and nothing owned the database.
      //
      // Two clicks, not a modal: this window is `position:fixed; z-index:9000` and the shell's
      // confirm dialog is an absolute overlay inside the app at z-index 50, so it would open BEHIND
      // this one. The second click is on a button that has changed its own label to say exactly what
      // will be destroyed, which is a stronger confirmation than a dialog nobody reads anyway.
      const delBtn = document.createElement("button");
      delBtn.disabled = true;
      delBtn.className = "sl-danger";
      delBtn.textContent = "Delete…";
      delBtn.style.cssText = "margin-right:auto;";
      delBtn.title = "Remove the selected series from the DICOM database — files, index rows and all";
      let armed = false;
      foot.append(msg, delBtn, loadBtn, loadCloseBtn);
      const setBusy = (s: string) => { msg.textContent = s; status(s); };

      // --- selection ---
      const selected = new Set<DbSeriesEntry>();
      const disarm = () => {
        armed = false;
        delBtn.textContent = "Delete…";
        delBtn.className = "sl-danger";
        delBtn.style.cssText = "margin-right:auto;";
      };
      const refreshSelection = () => {
        loadBtn.textContent = selected.size > 1 ? `Load ${selected.size} series` : "Load series";
        loadBtn.disabled = loadCloseBtn.disabled = selected.size === 0;
        delBtn.disabled = selected.size === 0;
        // A CHANGED SELECTION DISARMS IT. Arming the button and then ticking another series must not
        // leave a primed delete pointing at something else.
        if (armed) disarm();
        if (selected.size) setBusy(`${selected.size} selected`);
      };

      /**
       * Load a DICOM SEG onto a volume already in the scene.
       *
       * A SEG names the series it was drawn on (ReferencedSeriesSequence) but the scene's image
       * nodes do not carry SeriesInstanceUIDs, so the match is made on GEOMETRY: a SEG's frames are
       * placed by patient position into a specific grid, and a volume with different dims is
       * simply the wrong target. Where several volumes match, the most recently loaded wins, and
       * the status line says which one was used so a wrong guess is visible rather than silent.
       */

      /**
       * What was ticked, plus whatever it needs, parents first.
       *
       * Ron: "If I only click on the surface in the db, it should drag the segmentation with it."
       * Quite -- and the same was true one level up and has been an outright error since the
       * beginning: ticking a SEG on its own gave "load the grayscale series first — a segmentation
       * needs the volume it was drawn on", which is a correct description of a requirement the
       * browser could have met itself. It knows the chain: it draws the tree from these very edges.
       *
       * Nothing is loaded twice (a study already in the scene is simply skipped downstream), and a
       * cycle in the edges cannot hang this.
       */
      const loadSelected = async (closeAfter: boolean) => {
        // Images BEFORE segmentations, whatever order they were ticked in: a SEG is decoded onto a
        // loaded volume, so selecting both and loading the SEG first would fail on a missing target.
        // The sort is stable, so the ancestor order above survives it among the SEGs -- which is what
        // keeps a stored-surfaces series after the segmentation it belongs to.
        const list = withAncestors([...selected])
          .sort((a, b) => Number(a.modality === "SEG") - Number(b.modality === "SEG"));
        loadBtn.disabled = loadCloseBtn.disabled = true;
        const failures: string[] = [];
        const timings: string[] = [];
        // Wall clock from the click to the window going away: the number actually experienced, as
        // opposed to the sum of whichever phases happen to be instrumented.
        const tClick = performance.now();
        surfacesTicked = [];
        await loadDbEntries(db, list, setBusy, timings, failures);
        // A BUTTON, NOT A SENTENCE (the first-time user does not read): stored surface models were ticked,
        // and they come back only through Generate Surface Models.
        if (surfacesTicked.length && !failures.length) {
          shell.notify({
            title: surfacesTicked.length === 1 ? "Stored surface models were not loaded" : `${surfacesTicked.length} sets of stored surface models were not loaded`,
            body: "The segmentation is loaded and drawn solid. Surface models come back only when you ask for them, in the module Generate Surface Models.",
            actions: [
              { label: "Open Generate Surface Models", primary: true, onClick: () => { void shell.showPanel("surface-models"); } },
              { label: "Not now", onClick: () => {} },
            ],
          });
        }
        // AFTER EVERY LOAD, WHAT THIS WINDOW IS HOLDING GOES IN THE LOG. A memory regression is
        // invisible until the page dies; this makes it a line anyone can read afterwards.
        setTimeout(() => (globalThis as unknown as { __memoryCheck?: () => string }).__memoryCheck?.(), 4000);
        // A failure keeps the window open whichever button was used: the message names what went
        // wrong, and closing over it would hide the only report of it.
        if (failures.length) {
          setBusy(`${list.length - failures.length} loaded; ${failures.length} failed — ${failures[0]}`);
          // AND A CARD. The status line is small type at the bottom of the window; Ron, on a
          // series whose compression the app could not read: "The failure display is very
          // discrete: tiny font at the bottom. Easy to overlook. How about a popup?"
          shell.notify({
            title: failures.length === 1 ? "This series could not be loaded" : `${failures.length} of ${list.length} series could not be loaded`,
            body: failures.slice(0, 3).join("\n") + (failures.length > 3 ? `\n… and ${failures.length - 3} more` : ""),
            actions: [{ label: "OK", primary: true, onClick: () => {} }],
          });
          loadBtn.disabled = loadCloseBtn.disabled = false;
          return;
        }
        const total = `TOTAL ${((performance.now() - tClick) / 1000).toFixed(1)}s`;
        if (closeAfter) {
          status([...timings, total].join(" · "));
          close();
          // AND SHOW WHAT WAS LOADED. Ron: "When I load and close the dicom db, take me to the scene
          // data module." Closing the browser used to leave you wherever you started, which is
          // usually the Add Data panel -- one more click, and a guess about where the result went.
          void shell.showPanel("data");
        }
        else {
          setBusy([...timings, total].join(" · "));
          selected.clear();
          for (const el of scroll.querySelectorAll("input[type=checkbox]")) (el as HTMLInputElement).checked = false;
          refreshSelection();
          loadBtn.disabled = loadCloseBtn.disabled = true;
        }
      };
      // The button carries the wait, not only the status line at the foot of the window: a 709-slice
      // series with its segmentations is half a minute. (Ron, 2026-09-22, on a save that said nothing:
      // "If I click them they should give me immediate visual feedback.")
      // THE SWALLOWED REASON. `.catch(() => {})` here meant that a load which threw before it got
      // anywhere -- while the button's failure word was up for two seconds and gone -- left nothing
      // behind to read, in the window or in the log. Whatever went wrong is now said in both.
      const loadFailed = (e: unknown) => {
        const why = (e as Error)?.message ?? String(e);
        if (/^stopped$/i.test(why)) return;                 // a cancel is not a failure
        setBusy(`the load did not start: ${why}`);
        shell.notify({ title: "Nothing was loaded", body: esc(why), actions: [{ label: "OK", primary: true, onClick: () => {} }] });
      };
      loadBtn.addEventListener("click", () => void runAction(loadBtn, () => loadSelected(false), { busyLabel: "Loading…", doneLabel: "Loaded ✓", failedLabel: "Not loaded" }).catch(loadFailed));
      loadCloseBtn.addEventListener("click", () => void runAction(loadCloseBtn, () => loadSelected(true), { busyLabel: "Loading…", failedLabel: "Not loaded" }).catch(loadFailed));

      /** Which registered database this browser is looking at, for the delete route. */
      const currentDbId = async (): Promise<string | null> => {
        const j = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null);
        const list = (j?.databases ?? []) as { id: string; current?: boolean; exists?: boolean }[];
        if (!(j?.features ?? []).includes("delete-series")) return null;
        return (list.find((d) => d.current && d.exists) ?? list.find((d) => d.exists))?.id ?? null;
      };
      delBtn.addEventListener("click", () => void (async () => {
        const list = [...selected];
        if (!list.length) return;
        const dbId = await currentDbId();
        if (!dbId) {
          setBusy("this application's server side cannot delete from the database yet — quit it and run \"Rebuild SlicerAlbula App.command\"");
          return;
        }
        if (!armed) {
          // SAY WHAT WILL GO, including what is derived FROM it: those series survive, but they stop
          // being drawn under a parent, and a person deleting an original should know that.
          const instances = list.reduce((n, s) => n + s.count, 0);
          const uids = new Set(list.map((s) => s.seriesInstanceUID));
          const orphaned = db.series.filter((s) => !uids.has(s.seriesInstanceUID) && uids.has(parentOf.get(s.seriesInstanceUID) ?? "")).length;
          armed = true;
          delBtn.className = "sl-danger";
          delBtn.style.cssText = "margin-right:auto;background:var(--sl-danger-fill);border-color:var(--sl-danger-fill);color:#fff;font-weight:600;";
          delBtn.textContent = `Delete ${list.length} series (${instances} images) permanently`;
          setBusy(
            `This removes ${list.length === 1 ? `"${list[0].description || list[0].seriesInstanceUID}"` : `${list.length} series`} ` +
            `from the DICOM database — ${instances} files and their index rows. It cannot be undone.` +
            (orphaned ? ` ${orphaned} series derived from it will stay, no longer indented under it.` : "") +
            ` Click again to confirm, or change the selection to cancel.`,
          );
          return;
        }
        disarm();
        delBtn.disabled = loadBtn.disabled = loadCloseBtn.disabled = true;
        let gone = 0, files = 0;
        const failures: string[] = [];
        let kept = 0;
        for (const s of list) {
          setBusy(`deleting ${s.description || s.seriesInstanceUID}…`);
          const r = await fetch(`/_db/${encodeURIComponent(dbId)}/_series/${encodeURIComponent(s.seriesInstanceUID)}`, { method: "DELETE" })
            .then((x) => x.json()).catch((e) => ({ error: (e as Error).message }));
          if (r?.error && !r?.series) { failures.push(`${s.description || s.seriesInstanceUID}: ${r.error}`); continue; }
          gone++;
          files += (r.files ?? []).length;
          kept += (r.leftInPlace ?? []).length;
          if (r.audit && !r.audit.ok) failures.push(`after deleting ${s.description}: ${auditWords(r.audit)}`);
        }
        // Files a row named outside the database folder are the person's own and stay; said where it is seen
        // (critic, review-bugfixes finding 8), not only in the server's console.
        const keptWords = kept ? `; ${kept} file${kept === 1 ? "" : "s"} outside the database folder left where ${kept === 1 ? "it is" : "they are"}` : "";
        const said = `deleted ${gone} series, ${files} files${keptWords}${failures.length ? ` — ${failures[0]}` : ", and the database checks out"}`;
        status(said);
        setBusy(said);
        selected.clear();
        // REOPENED, not patched: the list, the tree and the derivation edges all come from one read
        // of the index, and re-deriving them in place after a delete is how a browser starts lying.
        close();
        reopen(false);
      })());

      // --- rows ---
      interface Row {
        el: HTMLTableRowElement; level: number; parent?: Row; hay: string; open?: boolean; uids?: string[]; scene?: true;
        /** A series row: its entry, for the tooltip that says what it is (explainRow). */
        entry?: DbSeriesEntry; explained?: boolean;
        /** Who this row belongs to, for the facets and the cohorts: the patient's ID and the study's UID. */
        patient?: string; study?: string;
      }
      const rows: Row[] = [];
      // WHAT A SERIES IS, ON ITS ROW. Ron, 2026-09-24: "the chest CT has many acquisitions with cryptic
      // shorthand descriptions. Having tooltips with more per row information would be helpful." The name's
      // shorthand decoded where it is known (logic/series-explain.ts) and the first file's header (the first
      // 64 KB, logic/readers/dicom-head.ts): kind, size, filter, kV and dose, position, who made it. Read when
      // a study is opened, four at a time, and on hovering a row not yet read.
      const explainRow = async (r: Row) => {
        if (r.explained || !r.entry) return;
        r.explained = true;
        const e = r.entry;
        const cell = r.el.firstElementChild as HTMLElement | null;
        if (!cell) return;
        const head = e.available && e.modality !== "SEG" ? await db.readSeriesFileHead(e, 65536).catch(() => null) : null;
        const extra = r.el.title ? `\n${r.el.title}` : "";   // "derived from: …", or why it cannot be read
        cell.title = explainSeries(realDescription(e.description) || "", e.count, head ? readDicomHead(head.head.buffer.slice(head.head.byteOffset, head.head.byteOffset + head.head.byteLength) as ArrayBuffer) : null, e.modality) + extra;
      };
      const explainUnder = async (st: Row) => {
        const todo = rows.filter((r) => r.entry && !r.explained && (() => { for (let a = r.parent; a; a = a.parent) if (a === st) return true; return false; })());
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => { while (i < todo.length) await explainRow(todo[i++]); }));
      };
      // -----------------------------------------------------------------------------------------
      // FACETS. Ron, 2026-09-22: "The dicom db is a mess. Can we add faceted search as a filter?
      // Initially, I would like to separate the different data sets that you imported for testing."
      // Four facets over the snapshot already in hand -- Cohort (his), Collection (the provenance
      // store's per-series attribute), Modality, Has (segmentations / scenes / surfaces) -- each a
      // menu with counts; a choice becomes a chip in the bar; chips combine; the search works
      // within them. Remembered between openings (Ron: "it should open like I left last time").
      // -----------------------------------------------------------------------------------------
      type FacetKey = "cohort" | "collection" | "modality" | "scenes" | "segmentations";
      /** Modalities a person filters by: the imaging ones. SEG, SR, PR and the like are what a study HAS, not what it is. */
      const IMAGING = (m: string | undefined) => !!m && !/^(SEG|SR|PR|OT|KO|DOC|RTSTRUCT|RTDOSE|RTPLAN|REG|FID)$/.test(m);
      const NO_COHORT = "Not in any cohort";
      const FACET_MEMORY = "albula.dicom-browser.facets";
      let facets: Partial<Record<FacetKey, string>> = {};
      try { facets = JSON.parse(localStorage.getItem(FACET_MEMORY) ?? "{}") as typeof facets; } catch { facets = {}; }
      const rememberFacets = () => { try { localStorage.setItem(FACET_MEMORY, JSON.stringify(facets)); } catch { /* private window */ } };
      /** The series rows under a patient or study row (a series row is its own). */
      const seriesUnder = (r: Row): string[] => r.uids ?? [];
      const cohortsOfRow = (r: Row): string[] => cohortList.filter((c) => (r.patient && c.patients.includes(r.patient)) || (r.study && c.studies.includes(r.study)) || (!r.study && r.patient && c.studies.some((su) => studyOwner.get(su) === r.patient))).map((c) => c.name);
      const hasScenes = (r: Row): boolean => {
        if (r.study) return (scenesOf.get(r.study)?.length ?? 0) > 0;
        if (r.patient) for (const [st, list] of scenesOf) if (list.length && studyOwner.get(st) === r.patient) return true;
        return false;
      };
      const hasSegmentations = (r: Row): boolean => seriesUnder(r).some((u) => seriesByUid.get(u)?.modality === "SEG");
      const YES = "with", NO = "without";
      const rowMatchesFacets = (r: Row): boolean => {
        // A FACET IS ABOUT DATA SETS: patients and studies. A series or scene row goes with its
        // study -- "Modality: CT" and "with segmentations" together described a study that has
        // both, and applied to each series row they hid every one of them (no series is a CT and
        // a segmentation at once), so an opened study showed nothing (Ron, 2026-09-22, 05:40:
        // "where is the data in the screen shot above?").
        if (r.level >= 2) { let st: Row | undefined = r.parent; while (st && st.level > 1) st = st.parent; return st ? rowMatchesFacets(st) : true; }
        if (facets.cohort) {
          const names = cohortsOfRow(r);
          if (facets.cohort === NO_COHORT ? names.length > 0 : !names.includes(facets.cohort)) return false;
        }
        if (facets.collection && !seriesUnder(r).some((u) => collectionOf.get(u)?.value === facets.collection)) return false;
        if (facets.modality && !seriesUnder(r).some((u) => seriesByUid.get(u)?.modality === facets.modality)) return false;
        if (facets.scenes && hasScenes(r) !== (facets.scenes === YES)) return false;
        if (facets.segmentations && hasSegmentations(r) !== (facets.segmentations === YES)) return false;
        return true;
      };
      const applyVisibility = () => {
        const q = filter.value.trim().toLowerCase();
        let shownSeries = 0;
        const shownPatients = new Set<string>(), shownStudies = new Set<string>();
        const facetOn = Object.values(facets).some(Boolean);
        for (const r of rows) {
          const matches = (!q || r.hay.includes(q)) && rowMatchesFacets(r);
          // With a filter, show every matching row and its ancestors; without one, obey collapse state.
          let visible: boolean;
          if (q) {
            visible = matches || rows.some((o) => o.hay.includes(q) && rowMatchesFacets(o) && isAncestor(r, o));
          } else if (facetOn) {
            // A facet hides whole data sets: a patient or study that does not match goes with
            // everything under it; a matching one keeps its collapse state.
            visible = rowMatchesFacets(r);
            for (let a = r.parent; a && visible; a = a.parent) if (a.open !== true || !rowMatchesFacets(a)) visible = false;
          } else {
            // Visible when EVERY ancestor is open. This was written for exactly three levels
            // (`r.parent.open && r.parent.parent.open`), so once a series could itself have
            // children -- a derived volume, a segmentation -- those rows were built correctly and
            // then hidden by a condition that could not see past the depth it was written for.
            visible = true;
            for (let a = r.parent; a; a = a.parent) if (a.open !== true) { visible = false; break; }
          }
          r.el.hidden = !visible;
          if (visible && r.level === 2 && !r.scene) shownSeries++;
          if (facetOn && r.level === 0 && rowMatchesFacets(r) && r.patient) shownPatients.add(r.patient);
          if (facetOn && r.level === 1 && rowMatchesFacets(r) && r.study) shownStudies.add(r.study);
        }
        // A PATIENT'S ROW SAYS HOW MANY OF ITS STUDIES A FILTER HIDES. It said "3 studies" over the one study
        // "with segmentations" left showing, and the chest CT and the liver MRI read as missing (Ron,
        // 2026-09-24: "where are my data?"). With a filter on: "1 of 3 studies shown", in the filter's color.
        for (const r of rows) {
          if (r.level !== 0) continue;
          const td = r.el.lastElementChild as HTMLElement | null;
          if (!td) continue;
          td.dataset.all ??= td.textContent ?? "";
          const studies = rows.filter((o) => o.level === 1 && o.parent === r);
          const shown = facetOn && !q ? studies.filter((o) => rowMatchesFacets(o)).length : studies.length;
          const hidden = shown < studies.length;
          td.textContent = hidden ? `${shown} of ${studies.length} studies shown` : td.dataset.all;
          td.title = hidden ? `${studies.length - shown} hidden by the filter above — Clear filters to see them` : td.dataset.all;
          td.style.color = hidden ? "var(--sl-accent)" : "";
          td.style.opacity = hidden ? "1" : "";
        }
        counts.textContent = filter.value.trim()
          ? `${shownSeries} series match`
          : facetOn
          ? `${shownPatients.size} of ${rows.filter((r) => r.level === 0).length} patients · ${shownStudies.size} of ${rows.filter((r) => r.level === 1).length} studies shown`
          : `${db.patients} patients · ${db.studies} studies · ${db.series.length} series · ` +
            `${db.series.filter((s) => s.available).length} readable here`;
      };
      /**
       * AFTER OPENING A ROW, ITS CHILDREN MUST BE ON SCREEN. Ron, 2026-09-20, on a study at the
       * bottom of the list: "When I click on the triangle to see the child, it's not visible.
       * After clicking, I have to scroll down. Click and scroll. Repeat until I get to the
       * bottom. Not ergonomic." So: when the opened row's last visible descendant is below the
       * fold, the list scrolls so the opened row sits at the top and as many children as fit
       * show under it; when they already fit, nothing moves.
       */
      const showChildren = (r: Row) => {
        if (!r.open) return;
        const box = scroll; const kids = rows.filter((o) => !o.el.hidden && isAncestor(r, o));
        const last = kids[kids.length - 1]; if (!last) return;
        const bottom = last.el.getBoundingClientRect().bottom, fold = box.getBoundingClientRect().bottom;
        if (bottom <= fold) return;
        const top = r.el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
        box.scrollTo({ top: Math.max(0, top - 4), behavior: "smooth" });
      };
      const isAncestor = (maybeAncestor: Row, of: Row): boolean => {
        for (let p = of.parent; p; p = p.parent) if (p === maybeAncestor) return true;
        return false;
      };

      // Marker (the ▶/▼ toggle, or a series' checkbox) and label share ONE cell, indented together
      // as a unit -- Ron: "children are indented relative to their parents, who might be indented
      // as well. That does not show." It used to: a separate, fixed 28px column held the marker at
      // the same x on every row regardless of depth, so only the label text shifted right and the
      // tree read as flat. It could not simply grow with depth either -- the table is
      // table-layout:fixed, so a level-2 marker would clip against a level-0 column's width rather
      // than widen it. One cell means one padding-left carries both, so a deeper row's marker AND
      // label both start further right than its parent's.
      // `level` is a NUMBER, not 0|1|2. A series can itself have children -- a cropped volume under
      // the series it was cropped from, a segmentation under the volume it was drawn on -- and that
      // chain is arbitrarily deep. Ron: "nnInteractive segmentation is still not indented relative
      // to its parent ... What is the cropped data derived from and why are they not grouped and
      // cropped indented?"
      const mkRow = (level: number, parent: Row | undefined, marker: string, label: string, rest: string[], hay: string): Row => {
        const tr = document.createElement("tr");
        tr.style.cssText = "border-bottom:1px solid var(--sl-line-faint);";
        const row: Row = { el: tr, level, parent, hay: hay.toLowerCase(), open: marker ? false : undefined };

        const nameTd = document.createElement("td");
        nameTd.style.cssText = `padding:5px 10px 5px ${10 + level * 20}px;white-space:nowrap;max-width:52ch;` +
          "overflow:hidden;text-overflow:ellipsis;" + (level < 2 ? "font-weight:600;" : "");
        const markerEl = document.createElement("span");
        markerEl.className = "dbb-marker";
        // Sized deliberately rather than inherited: this marker is the control the whole browser is
        // driven by, and it was rendering at the table's own font. Ron: "the triangles in the dicom
        // db need the same." Same reasoning as the segmentations tree -- the glyph is now the
        // full-size triangle (U+25B6/U+25BC, not the SMALL variants) and the target grew with it.
        markerEl.style.cssText = "display:inline-block;min-width:22px;font-size:16px;line-height:1;";
        markerEl.textContent = marker;
        nameTd.append(markerEl, document.createTextNode(label));
        if (label) nameTd.title = label;
        tr.appendChild(nameTd);

        // Cells: date, modality, images, size, collection, extra. Size and collection are filled
        // in afterwards by uid (paintSizes / paintCollection), because the sizes arrive on their
        // own request and a collection can be edited in place.
        rest.forEach((c, i) => {
          const td = document.createElement("td");
          td.style.cssText = "padding:5px 10px;white-space:nowrap;max-width:52ch;overflow:hidden;text-overflow:ellipsis;" +
            (i === 2 || i === 3 ? "text-align:right;font-variant-numeric:tabular-nums;" : "") +
            (i === 6 ? "opacity:.7;font-size:11px;" : "");
          if (i === 3) td.className = "dbb-size";
          if (i === 4) td.className = "dbb-collection";
          if (i === 5) td.className = "dbb-cohorts";
          td.textContent = c;
          if (c) td.title = c;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
        rows.push(row);
        return row;
      };

      for (const p of patients) {
        // The ID is shown, not just the name: this database holds four patients-of-record that all
        // display the same name under two different MRNs, which is indistinguishable by name alone.
        // (The name that used to be quoted here was the real one, in a tracked file. It is a
        // comment, so it was outside every DICOM de-identification pass -- and a comment is exactly
        // where a name survives a cleanup unnoticed.)
        const pLabel = p.id && p.id !== p.name ? `${p.name}  ·  ${p.id}` : p.name;
        const pRow = mkRow(0, undefined, "▶", pLabel, [dateSpan(p.dates), mods(p.mods), String(p.images), "", "", "", plural(p.studies.length, "study", "studies")],
                            `${p.name} ${p.key}`);
        pRow.uids = p.studies.flatMap((st) => st.series.map((x) => x.seriesInstanceUID));
        pRow.patient = p.id || p.key;
        const toggleP = () => {
          pRow.open = !pRow.open;
          pRow.el.querySelector(".dbb-marker")!.textContent = pRow.open ? "▼" : "▶";
          applyVisibility(); showChildren(pRow);
        };
        pRow.el.style.cursor = "pointer";
        pRow.el.addEventListener("click", toggleP);

        for (const st of p.studies) {
          const stRow = mkRow(1, pRow, "▶", st.description, [st.date, mods(st.mods), String(st.images), "", "", "", plural(st.series.length, "series", "series")],
                               `${p.name} ${st.description} ${st.date}`);
          stRow.uids = st.series.map((x) => x.seriesInstanceUID);
          stRow.patient = p.id || p.key; stRow.study = st.key; studyOwner.set(st.key, stRow.patient);
          const toggleS = () => {
            stRow.open = !stRow.open;
            stRow.el.querySelector(".dbb-marker")!.textContent = stRow.open ? "▼" : "▶";
            applyVisibility(); showChildren(stRow);
            if (stRow.open) void explainUnder(stRow);
          };
          stRow.el.style.cursor = "pointer";
          stRow.el.addEventListener("click", toggleS);

          // THE SCENES OF THIS STUDY, FIRST -- Ron, 2026-09-20, on the mockup: "yes, where a first
          // time no reader looks" -- each with its Open button on the left ("Button, but on the
          // left"), where the series' checkboxes are. Open loads the scene: the data, the views, the
          // window/level, the frame, the camera. Package… writes the transport folder (§7);
          // Delete… removes the scene file and its row, never a series.
          for (const sc of scenesOf.get(st.key) ?? []) {
            const when = sc.producedAt ? new Date(sc.producedAt) : null;
            const whenText = when && !isNaN(when.getTime()) ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}` : "";
            const scRow = mkRow(2, stRow, "", `Scene · ${sc.name}`, [whenText, "Scene", sc.series ? `${sc.series} series` : "", "", "", "", `save ${sc.v}`],
                                 `${p.name} ${st.description} scene ${sc.name}`);
            scRow.scene = true;
            scRow.el.style.background = "var(--sl-accent-wash)";
            // RENAME, in place. Ron, 2026-09-22: "I would like to be able to edit scene names."
            // Double-click the name (the collection cell already works this way); the file and
            // the row change, nothing else.
            const nameCell = scRow.el.firstElementChild as HTMLElement;
            nameCell.title = `${sc.name} — double-click to rename`;
            nameCell.addEventListener("dblclick", async (e) => {
              e.stopPropagation();
              const v = await shell.prompt({ title: "Name of this scene", value: sc.name });
              if (v === null || !v.trim() || v.trim() === sc.name) return;
              const r = await fetch(`/_db/${encodeURIComponent(dbId ?? "")}/_scene/${encodeURIComponent(sc.uid)}/_name`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: v.trim() }) })
                .then((x) => x.json()).catch((err) => ({ error: (err as Error).message })) as { ok?: boolean; name?: string; error?: string };
              if (r.error) { setBusy(`the scene was not renamed: ${r.error}`); return; }
              sc.name = r.name ?? v.trim();
              // The cell is the marker (holding Open) and a text node; only the text changes.
              for (const n of [...nameCell.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.textContent = `Scene · ${sc.name}`;
              nameCell.title = `${sc.name} — double-click to rename`;
              scRow.hay = `${p.name} ${st.description} scene ${sc.name}`.toLowerCase();
              setBusy(`renamed to "${sc.name}"`);
            });
            scRow.el.title = `${sc.name} — saved ${whenText} by ${sc.producer}. Open puts back what was on screen: the data, the views, the window/level, the frame, the camera.`;
            // A SCENE ROW IS ONE STRIP, NOT SEVEN COLUMNS.
            //
            // Its facts and its two buttons used to sit in the LAST column, which is the one with no
            // declared width: it takes whatever the other seven leave, and in a window narrower than
            // their sum that is nothing. Ron, 2026-09-22, with the scene row reading "save 3 …":
            // "I am confused. No delete button in the row." The buttons were there and clipped.
            //
            // So the scene keeps its name cell (the double-click rename) and everything else becomes
            // one cell across the remaining columns, laid out with flex: the facts at the left, the
            // buttons pinned right, visible at any width.
            const strip = document.createElement("td");
            strip.colSpan = 7;
            // NO `overflow` HERE: an overflow other than visible makes this cell the scroll box the
            // sticky buttons stick inside, and this cell never scrolls — so they stayed out at the
            // table's right edge. The buttons must stick against the window that DOES scroll.
            strip.style.cssText = "padding:5px 10px;";
            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;align-items:center;gap:12px;white-space:nowrap;";
            const fact = (t: string) => { const sp = document.createElement("span"); sp.style.cssText = "opacity:.7;font-size:11px;"; sp.textContent = t; return sp; };
            // An empty fact is not a fact: appending it left a 24 px hole where a scene has no
            // series count or an unreadable date (critic 2026-09-22, 5.2).
            for (const t of [whenText, sc.series ? `${sc.series} series` : "",
              sc.bytes >= 1e6 ? `${(sc.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(sc.bytes / 1e3))} KB`,
              `save ${sc.v}`]) if (t) bar.appendChild(fact(t));
            const gap = document.createElement("span");
            gap.style.cssText = "flex:1 1 auto;min-width:8px;";
            bar.appendChild(gap);
            strip.appendChild(bar);
            for (const c of [...scRow.el.children].slice(1)) c.remove();
            scRow.el.appendChild(strip);
            const openBtn = document.createElement("button");
            openBtn.textContent = "Open";
            openBtn.className = "sl-primary";
            openBtn.style.cssText = "font-size:11px;padding:1px 9px;margin-right:6px;cursor:pointer;";
            openBtn.title = "Load this scene: its series, and everything as it was on screen";
            openBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void runAction(openBtn, async () => {
                close();
                const g = globalThis as unknown as { __openScene?: (uid: string) => Promise<{ ok: boolean; error?: string }> };
                const r = await g.__openScene?.(sc.uid);
                if (r && !r.ok && r.error && r.error !== "stopped") shell.notify({ title: "The scene did not open", body: r.error });
              }, { busyLabel: "Opening…" }).catch(() => {});
            });
            const marker = scRow.el.querySelector(".dbb-marker") as HTMLElement;
            marker.textContent = "";
            marker.appendChild(openBtn);
            // The two rarer things, at the right end of the strip.
            const packBtn = document.createElement("button");
            packBtn.textContent = "Package…";
            packBtn.style.cssText = "font-size:11px;padding:0 7px;margin-left:8px;cursor:pointer;";
            packBtn.title = "Write a folder with this scene and every DICOM file it needs, to take to another machine — into the pictures folder set in Settings (on this machine that may be iCloud Drive)";
            packBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void runAction(packBtn, async () => {
              setBusy(`packaging "${sc.name}"…`);
              try {
                const r = await fetch(`/_db/${encodeURIComponent(dbId ?? "")}/_scene/${encodeURIComponent(sc.uid)}/_package`, { method: "POST" }).then((x) => x.json()) as { path?: string; series?: number; files?: number; bytes?: number; missing?: string[]; error?: string };
                // A refusal is a failure, not a quiet return: the button must not say "Packaged ✓"
                // under a notice that says it was not (critic 2026-09-22, 1.4).
                if (r.error) { shell.notify({ title: "The scene was not packaged", body: r.error }); setBusy(""); throw new Error(r.error); }
                setBusy(`packaged: ${r.path}`);
                shell.notify({ title: `Packaged — "${esc(sc.name)}"`, body: `${r.series} series, ${r.files} files, ${((r.bytes ?? 0) / 1e6).toFixed(0)} MB<br>${esc(r.path ?? "")}${r.missing?.length ? `<br>Not included: ${r.missing.length} series not in this database` : ""}`,
                  actions: [{ label: "Show in Finder", primary: true, onClick: () => { void fetch(`/_picture/${encodeURIComponent((r.path ?? "").split("/").pop() ?? "")}?reveal=1`); } }, { label: "OK", onClick: () => {} }] });
              } catch (e) { shell.notify({ title: "The scene was not packaged", body: (e as Error).message }); throw e; }
              }, { busyLabel: "Packaging…", doneLabel: "Packaged ✓", failedLabel: "Not packaged" }).catch(() => {});
            });
            const delBtn = document.createElement("button");
            delBtn.textContent = "Delete…";
            delBtn.style.cssText = "font-size:11px;padding:0 7px;margin-left:6px;cursor:pointer;";
            delBtn.title = "Delete this scene file and its row. No series is touched.";
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              void (async () => {
              const ok = await shell.confirm({ title: `Delete the scene "${sc.name}"?`, ok: "Delete", cancel: "Cancel", destructive: true, body: `<p>The scene file and its row go. The series it names stay in the database.</p>` });
              if (!ok) return;
              await runAction(delBtn, async () => {
                const r = await fetch(`/_db/${encodeURIComponent(dbId ?? "")}/_scene/${encodeURIComponent(sc.uid)}`, { method: "DELETE" }).then((x) => x.ok).catch(() => false);
                if (!r) { shell.notify({ title: "The scene was not deleted" }); throw new Error("not deleted"); }
                setBusy(`Scene "${sc.name}" deleted`);
                setTimeout(() => { scRow.el.remove(); rows.splice(rows.indexOf(scRow), 1); }, 1200);   // after the button has said so
              }, { busyLabel: "Deleting…", doneLabel: "Deleted ✓", failedLabel: "Not deleted" }).catch(() => {});
              })();
            });
            // PINNED TO THE VISIBLE PANE, NOT TO THE TABLE. The table is 1394 px of declared column
            // widths; in any window narrower than that it scrolls sideways, and buttons pinned to
            // ITS right edge are off-screen exactly as they were when they were clipped — the same
            // "no delete button in the row", measured at five widths (critic 2026-09-22, 5.1).
            // `position: sticky` keeps them against the right edge of what is on screen, whatever
            // the window is doing.
            const pin = document.createElement("span");
            pin.style.cssText = "position:sticky;right:6px;display:inline-flex;gap:6px;align-items:center;background:var(--sl-accent-wash);padding-left:8px;";
            pin.append(packBtn, delBtn);
            bar.appendChild(pin);
          }

          // Series in derivation order: a source, then everything made from it, one level deeper,
          // recursively. A series whose parent is not in this study stays at the top level -- the
          // parent may be in another study, or no longer in the database, and hiding a series under
          // something absent would be worse than showing it flat.
          const inStudy = new Set(st.series.map((x) => x.seriesInstanceUID));
          const kids = new Map<string, DbSeriesEntry[]>();
          const roots: DbSeriesEntry[] = [];
          for (const x of st.series) {
            const par = parentOf.get(x.seriesInstanceUID);
            if (par && par !== x.seriesInstanceUID && inStudy.has(par)) {
              const list = kids.get(par) ?? [];
              list.push(x);
              kids.set(par, list);
            } else roots.push(x);
          }
          const ordered: { s: DbSeriesEntry; depth: number }[] = [];
          const walk = (x: DbSeriesEntry, depth: number, seen: Set<string>) => {
            if (seen.has(x.seriesInstanceUID)) return;      // a cycle in the edges must not hang the browser
            seen.add(x.seriesInstanceUID);
            ordered.push({ s: x, depth });
            for (const c of kids.get(x.seriesInstanceUID) ?? []) walk(c, depth + 1, seen);
          };
          const seen = new Set<string>();
          for (const x of roots) walk(x, 0, seen);
          for (const x of st.series) walk(x, 0, seen);      // anything a cycle left out still appears

          const rowOf = new Map<string, Row>();
          for (const { s, depth } of ordered) {
            // Same placeholder rule as the scene name: a row reading "= NONE =" names nothing.
            const label = realDescription(s.description) || `${s.modality ?? ""} series ${s.seriesNumber ?? ""}`.trim();
            const derived = depth > 0;
            const sRow = mkRow(2 + depth, derived ? rowOf.get(parentOf.get(s.seriesInstanceUID)!) ?? stRow : stRow,
                                "", label, [seriesWhen(s.seriesDate, s.seriesTime), s.modality ?? "", String(s.count),
                                            "", "", "", s.available ? "" : "external"],
                                `${p.name} ${st.description} ${label} ${s.modality ?? ""}`);
            sRow.uids = [s.seriesInstanceUID];
            sRow.patient = p.id || p.key; sRow.study = st.key;
            sRow.entry = s;
            sRow.el.addEventListener("mouseenter", () => { void explainRow(sRow); });
            rowOf.set(s.seriesInstanceUID, sRow);
            // A series with derived children gets its own disclosure, OPEN by default: the reason to
            // nest a segmentation under its volume is to see that it exists, so hiding it behind a
            // closed triangle would undo the point.
            if ((kids.get(s.seriesInstanceUID) ?? []).length) {
              sRow.open = true;
              const tri = document.createElement("span");
              tri.textContent = "▼";
              tri.style.cssText = "cursor:pointer;display:inline-block;width:14px;";
              tri.title = "show or hide what was made from this series";
              tri.addEventListener("click", (e) => {
                e.stopPropagation();                      // the row click selects; the triangle does not
                sRow.open = !sRow.open;
                tri.textContent = sRow.open ? "▼" : "▶";
                applyVisibility(); showChildren(sRow);
              });
              sRow.el.querySelector(".dbb-marker")!.prepend(tri);
            }
            if (derived) sRow.el.title = `derived from: ${st.series.find((y) => y.seriesInstanceUID === parentOf.get(s.seriesInstanceUID))?.description ?? "another series"}`;
            if (!s.available) {
              sRow.el.style.opacity = ".45";
              sRow.el.title = s.count === 0
                ? "no instances recorded for this series"
                : `${s.externalCount} of ${s.count} files are stored outside this folder (absolute paths) — not reachable from the browser`;
              continue;
            }
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.style.cssText = "cursor:pointer;";
            sRow.el.querySelector(".dbb-marker")!.appendChild(cb);
            const setSel = (on: boolean) => {
              cb.checked = on;
              if (on) selected.add(s); else selected.delete(s);
              sRow.el.style.background = on ? "var(--sl-accent-wash)" : "transparent";
              refreshSelection();
            };
            cb.addEventListener("click", (e) => { e.stopPropagation(); setSel(cb.checked); });
            sRow.el.style.cursor = "pointer";
            sRow.el.addEventListener("click", () => setSel(!cb.checked));
            sRow.el.addEventListener("dblclick", () => { setSel(true); void loadSelected(true); });   // double-click = load this one and close
          }
        }
      }

      expandBtn.addEventListener("click", () => {
        for (const r of rows) if (r.open !== undefined) { r.open = true; r.el.querySelector(".dbb-marker")!.textContent = "▼"; }
        applyVisibility();
      });
      collapseBtn.addEventListener("click", () => {
        for (const r of rows) if (r.open !== undefined) { r.open = false; r.el.querySelector(".dbb-marker")!.textContent = "▶"; }
        applyVisibility();
      });
      filter.addEventListener("input", applyVisibility);

      // SIZE AND COLLECTION, per row, rolled up. A patient's size is the sum of its series; its
      // collection is the set of its series' collections, which is normally one name.
      const fmtBytes = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.round(b / 1e3)} KB` : "";
      paintSizes = () => {
        for (const r of rows) {
          const td = r.el.querySelector(".dbb-size") as HTMLElement | null;
          if (!td || !r.uids) continue;
          const b = r.uids.reduce((n, u) => n + (sizeOf.get(u) ?? 0), 0);
          td.textContent = fmtBytes(b); td.title = b ? `${b.toLocaleString()} bytes on disk` : "";
        }
      };
      paintCollections = () => {
        for (const r of rows) {
          const td = r.el.querySelector(".dbb-collection") as HTMLElement | null;
          if (!td || !r.uids) continue;
          const found = r.uids.map((u) => collectionOf.get(u)).filter((c): c is { value: string; source: string } => !!c);
          const names = [...new Set(found.map((c) => c.value))];
          const lic = [...new Set(r.uids.map((u) => licenseOf.get(u)).filter(Boolean))];
          td.textContent = names.join(", ");
          const src = [...new Set(found.map((c) => c.source))];
          td.title = names.length
            ? `${names.join(", ")}${lic.length ? ` · ${lic.join(", ")}` : ""} · from ${src.map((s) => s === "idc" ? "IDC's index" : s === "fetch" ? "the fetch" : "you").join(", ")}. Double-click to change.`
            : "no collection recorded. Double-click to set one.";
          td.style.cursor = "text";
        }
      };
      // A PERSON'S WORD, in place. Double-click a collection cell, type the name; it is written
      // to the provenance store with source "user", which the IDC lookup never overwrites. On a
      // patient or study row it applies to every series beneath. Empty removes it.
      for (const r of rows) {
        const td = r.el.querySelector(".dbb-collection") as HTMLElement | null;
        if (!td || !r.uids?.length || !dbId) continue;
        td.addEventListener("dblclick", async (e) => {
          e.stopPropagation();                        // the row's own click toggles the disclosure
          const cur = collectionOf.get(r.uids![0])?.value ?? "";
          const v = await shell.prompt({ title: `Collection for ${r.uids!.length === 1 ? "this series" : `these ${r.uids!.length} series`}`, body: "<p>IDC's name, e.g. cptac_ccrcc; empty to clear.</p>", value: cur });
          if (v === null) return;
          for (const u of r.uids!) {
            const res = await fetch(`/_db/${encodeURIComponent(dbId!)}/_attribute`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ uid: u, key: "collection", value: v }) });
            if (!res.ok) { setBusy(`could not save the collection: ${(await res.json().catch(() => ({}))).error ?? res.status}`); return; }
            if (v.trim()) collectionOf.set(u, { value: v.trim(), source: "user" }); else collectionOf.delete(u);
          }
          paintCollections();
          setBusy(v.trim() ? `collection set to ${v.trim()}` : "collection cleared");
        });
      }
      paintCollections();
      paintSizes();

      // SORT BY A COLUMN. Click a header: patients reorder by that column, and within each patient
      // its studies, and within each study its series -- the tree keeps its shape, siblings change
      // places. A second click reverses. Ron, 2026-09-19: "It would be good to sort the columns."
      // Keyed on what the cell SHOWS, so what you sort is what you see; sizes by their bytes.
      const heads = [...table.querySelectorAll("th")] as HTMLTableCellElement[];
      const labels = heads.map((h) => h.childNodes[0]?.textContent ?? "");
      let sortCol = -1, sortDir = 1;
      const keyOf = (r: Row, col: number): string | number => {
        if (col === 4) return r.uids?.reduce((n, u) => n + (sizeOf.get(u) ?? 0), 0) ?? 0;
        const td = r.el.children[col] as HTMLElement | undefined;
        const text = (td?.textContent ?? "").trim();
        if (col === 3) return Number(text.replace(/[^0-9]/g, "")) || 0;
        return text.toLowerCase();
      };
      const resort = () => {
        const cmp = (a: Row, b: Row) => {
          const ka = keyOf(a, sortCol), kb = keyOf(b, sortCol);
          // Empty cells sort last whichever way, so a column of blanks does not bury the values.
          if (ka === "" && kb !== "") return 1; if (kb === "" && ka !== "") return -1;
          return (ka < kb ? -1 : ka > kb ? 1 : 0) * sortDir;
        };
        const out: Row[] = [];
        const visit = (parent: Row | undefined) => {
          const kids = rows.filter((r) => r.parent === parent);
          if (sortCol >= 0) kids.sort(cmp);
          for (const k of kids) { out.push(k); visit(k); }
        };
        visit(undefined);
        for (const r of out) tbody.appendChild(r.el);
        rows.splice(0, rows.length, ...out);
        for (const [i, h] of heads.entries()) {
          if (!labels[i]) continue;
          h.childNodes[0]!.textContent = labels[i] + (i === sortCol ? (sortDir > 0 ? " ▲" : " ▼") : "");
        }
        applyVisibility();
      };
      for (const [i, h] of heads.entries()) {
        if (!labels[i]) continue;
        h.style.cursor = "pointer";
        h.title = `Sort by ${labels[i].toLowerCase()}; click again to reverse`;
        h.addEventListener("click", () => {
          if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; }
          resort();
        });
      }

      // ---- the facet bar --------------------------------------------------------------------
      const bar = document.createElement("div");
      bar.className = "dbb-facets";
      const facetLabel: Record<FacetKey, string> = { cohort: "Cohort", collection: "Collection", modality: "Modality", scenes: "Scenes", segmentations: "Segmentations" };
      /** Every value a facet can take, with how many patients carry it. */
      const facetValues = (k: FacetKey): { value: string; n: number }[] => {
        const pats = rows.filter((r) => r.level === 0);
        const count = new Map<string, number>();
        const add = (v: string) => count.set(v, (count.get(v) ?? 0) + 1);
        for (const r of pats) {
          const vs = new Set<string>();
          if (k === "cohort") { const names = cohortsOfRow(r); for (const st of rows.filter((x) => x.level === 1 && x.parent === r)) for (const nm of cohortsOfRow(st)) names.push(nm); if (names.length) for (const nm of new Set(names)) vs.add(nm); else vs.add(NO_COHORT); }
          if (k === "collection") for (const u of seriesUnder(r)) { const c = collectionOf.get(u)?.value; if (c) vs.add(c); }
          if (k === "modality") for (const u of seriesUnder(r)) { const m = seriesByUid.get(u)?.modality; if (IMAGING(m)) vs.add(m!); }
          if (k === "scenes") vs.add(hasScenes(r) ? YES : NO);
          if (k === "segmentations") vs.add(hasSegmentations(r) ? YES : NO);
          for (const v of vs) add(v);
        }
        const out = [...count.entries()].map(([value, n]) => ({ value, n }));
        if (k === "cohort") { for (const c of cohortList) if (!count.has(c.name)) out.push({ value: c.name, n: 0 }); }
        return out.sort((a, b) => a.value === NO_COHORT ? 1 : b.value === NO_COHORT ? -1 : b.n - a.n || a.value.localeCompare(b.value));
      };
      let openMenu: HTMLElement | null = null;
      const closeMenu = () => { openMenu?.remove(); openMenu = null; };
      // Gone with this browser: it was added at every opening and never removed, keeping each earlier
      // browser's rows alive (code review 2026-09-24, A16).
      const onDocClick = () => { if (!tbody.isConnected) { document.removeEventListener("click", onDocClick); return; } closeMenu(); };
      document.addEventListener("click", onDocClick);
      const menuAt = (anchor: HTMLElement, items: { label: string; note?: string; on?: boolean; act: () => void }[]) => {
        closeMenu();
        const m = document.createElement("div");
        m.className = "dbb-menu";
        for (const it of items) {
          const d = document.createElement("div");
          d.className = "dbb-menu-item" + (it.on ? " dbb-menu-on" : "");
          d.innerHTML = `<span>${esc(it.label)}</span><span class="sl-netb-dim">${esc(it.note ?? "")}</span>`;
          d.addEventListener("click", (e) => { e.stopPropagation(); it.act(); closeMenu(); });
          m.appendChild(d);
        }
        const r = anchor.getBoundingClientRect();
        m.style.left = `${r.left}px`; m.style.top = `${r.bottom + 4}px`;
        m.addEventListener("click", (e) => e.stopPropagation());
        document.body.appendChild(m);
        openMenu = m;
      };
      const chipText = (k: FacetKey, v: string) => k === "scenes" || k === "segmentations" ? `${v} ${facetLabel[k].toLowerCase()}` : `${facetLabel[k]}: ${v}`;
      /** The facets, one menu: each facet a heading with its values and counts; the chosen value marked. */
      // A LIMITED SELECTION FIRST, the rest behind one more click. Ron, 2026-09-22, on this menu:
      // "remember the philosophy behind the advanced button in the settings for the 3d viewer:
      // present a limited selection with reasonable initial values, that the user can modify. All
      // the complexity gets stored under advanced." The collections are the long list (30 today,
      // 24 of them codec samples of one patient each): the ones shared by more than one patient
      // show, the tail folds under "… and N more".
      let showAllCollections = false;
      const openFacets = (anchor: HTMLElement) => {
        closeMenu();
        const m = document.createElement("div");
        m.className = "dbb-menu dbb-menu-wide";
        for (const k of ["cohort", "modality", "scenes", "segmentations", "collection"] as FacetKey[]) {
          const h = document.createElement("div"); h.className = "dbb-menu-head"; h.textContent = facetLabel[k]; m.appendChild(h);
          let vals = facetValues(k);
          let folded = 0;
          if (k === "collection" && !showAllCollections) {
            const keep = vals.filter((v) => v.n > 1 || v.value === facets.collection);
            if (keep.length && keep.length < vals.length) { folded = vals.length - keep.length; vals = keep; }
          }
          if (!vals.length) { const d = document.createElement("div"); d.className = "dbb-menu-item sl-netb-dim"; d.textContent = "none"; m.appendChild(d); }
          for (const v of vals) {
            const d = document.createElement("div");
            const on = facets[k] === v.value;
            d.className = "dbb-menu-item" + (on ? " dbb-menu-on" : "");
            d.innerHTML = `<span>${esc(v.value)}</span><span class="sl-netb-dim">${v.n} patient${v.n === 1 ? "" : "s"}</span>`;
            d.addEventListener("click", (e) => { e.stopPropagation(); facets[k] = on ? undefined : v.value; rememberFacets(); paintBar(); applyVisibility(); openFacets(anchor); });
            m.appendChild(d);
          }
          if (k === "cohort") {
            const d = document.createElement("div"); d.className = "dbb-menu-item dbb-menu-new"; d.textContent = "New cohort…";
            d.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); void newCohort(); });
            m.appendChild(d);
          }
          if (folded) {
            const d = document.createElement("div"); d.className = "dbb-menu-item sl-netb-dim"; d.textContent = `… and ${folded} more (one patient each)`;
            d.addEventListener("click", (e) => { e.stopPropagation(); showAllCollections = true; openFacets(anchor); });
            m.appendChild(d);
          }
        }
        const r = anchor.getBoundingClientRect();
        m.style.left = `${r.left}px`; m.style.top = `${r.bottom + 4}px`;
        m.addEventListener("click", (e) => e.stopPropagation());
        document.body.appendChild(m);
        openMenu = m;
      };
      const paintBar = () => {
        bar.replaceChildren();
        const icon = document.createElement("button");
        icon.className = "dbb-facet dbb-funnel";
        icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg> Filters`;
        icon.title = "Show only some of the database: by cohort, collection, modality, scenes, segmentations";
        icon.addEventListener("click", (e) => { e.stopPropagation(); if (openMenu) closeMenu(); else openFacets(icon); });
        bar.appendChild(icon);
        for (const k of Object.keys(facets) as FacetKey[]) {
          if (!facets[k]) continue;
          const chip = document.createElement("span");
          chip.className = "dbb-chip";
          chip.innerHTML = `${esc(chipText(k, facets[k]!))} <span class="dbb-chip-x" title="Remove this filter">×</span>`;
          chip.querySelector(".dbb-chip-x")!.addEventListener("click", () => { facets[k] = undefined; rememberFacets(); paintBar(); applyVisibility(); });
          bar.appendChild(chip);
        }
        if (Object.values(facets).some(Boolean)) {
          const clr = document.createElement("button"); clr.className = "dbb-facet"; clr.textContent = "Clear filters";
          clr.addEventListener("click", () => { facets = {}; rememberFacets(); paintBar(); applyVisibility(); });
          bar.appendChild(clr);
        } else {
          const hint = document.createElement("span"); hint.className = "sl-netb-dim"; hint.textContent = "showing everything"; bar.appendChild(hint);
        }
      };
      // ---- cohorts: the column and its + ----------------------------------------------------
      const cohortCall = async (name: string, add: { level: "patient" | "study"; uid: string }[], remove: { level: "patient" | "study"; uid: string }[]) => {
        const r = await fetch(`/_db/${encodeURIComponent(dbId ?? "")}/_cohort/${encodeURIComponent(name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ add, remove }) })
          .then((x) => x.json()).catch((e) => ({ error: (e as Error).message })) as { error?: string; cohorts?: CohortRow[] };
        if (r.error) { setBusy(`cohort not saved: ${r.error}`); return false; }
        cohortList = r.cohorts ?? cohortList;
        paintCohorts(); paintBar(); applyVisibility();
        return true;
      };
      const newCohort = async (forRow?: Row) => {
        const name = await shell.prompt({ title: "Name of the new cohort", placeholder: "e.g. Keynote pictures" });
        if (!name?.trim()) return;
        const member = forRow ? [forRow.study ? { level: "study" as const, uid: forRow.study } : { level: "patient" as const, uid: forRow.patient! }] : [];
        if (await cohortCall(name.trim(), member, [])) setBusy(forRow ? `"${name.trim()}" made, with ${forRow.study ? "this study" : "this patient"} in it` : `"${name.trim()}" made — the + on a patient or study row adds to it`);
      };
      const paintCohorts = () => {
        for (const r of rows) {
          const td = r.el.querySelector(".dbb-cohorts") as HTMLElement | null;
          if (!td || r.level > 1 || !r.patient) continue;
          td.replaceChildren();
          const own = cohortList.filter((c) => (r.study ? c.studies.includes(r.study) : c.patients.includes(r.patient!)));
          const inherited = r.study ? cohortList.filter((c) => c.patients.includes(r.patient!) && !own.includes(c)) : [];
          for (const c of own) { const t = document.createElement("span"); t.className = "dbb-tag"; t.textContent = c.name; t.title = `In "${c.name}"`; td.appendChild(t); }
          for (const c of inherited) { const t = document.createElement("span"); t.className = "dbb-tag dbb-tag-dim"; t.textContent = c.name; t.title = `In "${c.name}" through the patient`; td.appendChild(t); }
          const plus = document.createElement("button");
          plus.className = "dbb-plus"; plus.textContent = "+";
          plus.title = cohortList.length ? "Add this to a cohort, or take it out of one" : "Make a cohort with this in it";
          plus.addEventListener("click", (e) => {
            e.stopPropagation();
            const member = r.study ? { level: "study" as const, uid: r.study } : { level: "patient" as const, uid: r.patient! };
            const items = cohortList.map((c) => {
              const on = own.includes(c);
              return { label: c.name, note: on ? "in — click to take out" : inherited.includes(c) ? "through the patient" : "click to add", on, act: () => { void cohortCall(c.name, on ? [] : [member], on ? [member] : []); } };
            });
            items.push({ label: "New cohort…", act: () => { void newCohort(r); } });
            menuAt(plus, items);
          });
          td.appendChild(plus);
        }
      };
      paintCohorts();
      paintBar();

      applyVisibility();
      refreshSelection();
      setBusy("select one or more series (double-click loads immediately)");
      box.append(bar, scroll, foot);
      filter.focus();
    };

    // The remembered handle is recalled up front, NOT inside the click handler: showDirectoryPicker
    // and requestPermission both require a live user gesture, and awaiting anything first (an
    // IndexedDB read, say) lets that activation expire — the picker then throws instead of opening,
    // which looks like the button doing nothing.
    let rememberedDir: FileSystemDirectoryHandle | null = null;
    let openDb: DicomDatabase | null = null;
    /**
     * The source the open database was read from, so it can be RE-read without the browser.
     *
     * `openDb` is a snapshot of ctkDICOM.sql taken when the database was opened, and everything that
     * needs a series' instances goes through it -- including the DICOM SEG exporter, which has to
     * re-read the very files a segmentation was drawn on. So a series saved from inside the
     * application was invisible to the application until someone reopened the browser by hand. That
     * is one of the two steps between cropping a volume and being able to save a segmentation of it.
     */
    let lastSource: DbSource | null = null;
    // Writing a segmentation back out as DICOM needs two things this block owns: the source series'
    // own instances (a SEG references them) and the folder to write into. Exposed here, beside the
    // state, rather than plumbed through the panel's options.
    Object.assign(globalThis, {
      /** The raw instances of one series in the open database — what a DICOM SEG must reference. */
      __dicomSourceInstances: async (seriesInstanceUID: string): Promise<ArrayBuffer[] | null> => {
        // THE PERSON SAID "SAVE"; the rest is ours. No database open in this window yet -- open
        // the served one; the series not in the snapshot -- a volume saved a moment ago -- re-read
        // it once. Ron, 2026-09-20, on "open the DICOM database this volume came from first":
        // "What first time user will know what they need to do? I say save my scene. You take care
        // of everything else."
        if (!openDb) {
          if (!servedDb) await loadRegistered();
          if (!lastSource && servedDb) lastSource = httpSource(servedDb);
          if (lastSource) { try { openDb = await openDicomDatabase(lastSource, (p) => status(p.note)); forgetProvenance(); } catch { return null; } }
        }
        if (!openDb) return null;
        let entry = openDb.series.find((se) => se.seriesInstanceUID === seriesInstanceUID);
        if (!entry && lastSource) { try { openDb = await openDicomDatabase(lastSource); forgetProvenance(); } catch { /* keep the old snapshot */ } entry = openDb.series.find((se) => se.seriesInstanceUID === seriesInstanceUID); }
        if (!entry) return null;
        return await openDb.readSeriesFiles(entry);
      },
      /**
       * IS THE DUCKN COPY THE SAME AS THE DICOM? One series read both ways, nothing put into the
       * scene, and every field the scene takes from a volume compared: dims, ijkToRAS, dtype, meta,
       * labels, every voxel, and every piece under the name the ingest would give it. For the pane,
       * for the critic, and for a later session -- the check behind "the same images" in Settings.
       */
      __compareDucknCopy: async (seriesInstanceUID: string): Promise<{ same: boolean; differences: string[]; volumes: number; voxels: number; pieces: number; ms: { copy: number; dicom: number }; cannotSee: string }> => {
        if (!openDb) {
          if (!servedDb) await loadRegistered();
          if (!lastSource && servedDb) lastSource = httpSource(servedDb);
          if (lastSource) openDb = await openDicomDatabase(lastSource, (p) => status(p.note));
        }
        const entry = openDb?.series.find((se) => se.seriesInstanceUID === seriesInstanceUID);
        if (!openDb || !entry || !servedDb) throw new Error("that series is not in the served database");
        let t = performance.now();
        const copy = await loadSequenceFromCopy(servedDb, seriesInstanceUID);
        const copyMs = performance.now() - t;
        if ("missing" in copy) throw new Error(`no copy to compare: ${copy.missing}`);
        t = performance.now();
        const dicom = await openDb.loadSequence(entry);
        const dicomMs = performance.now() - t;
        const differences: string[] = [];
        const same = (what: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`${what}: copy ${JSON.stringify(a)?.slice(0, 120)} / DICOM ${JSON.stringify(b)?.slice(0, 120)}`); };
        same("number of volumes", copy.frames.length, dicom.frames.length);
        same("labels", copy.labels, dicom.labels);
        same("frame timing", copy.timing, dicom.timing);
        same("left out", copy.leftOut, dicom.leftOut);
        let voxels = 0, pieces = 0;
        for (let f = 0; f < Math.min(copy.frames.length, dicom.frames.length); f++) {
          const a = copy.frames[f], b = dicom.frames[f];
          for (const k of ["name", "dims", "ijkToRAS", "dtype", "meta", "geometry"] as const) same(`volume ${f} ${k}`, a[k], b[k]);
          if (a.data.length !== b.data.length) { differences.push(`volume ${f}: ${a.data.length} voxels / ${b.data.length}`); continue; }
          let bad = 0, first = -1;
          for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) { bad++; if (first < 0) first = i; }
          if (bad) differences.push(`volume ${f}: ${bad} voxels differ, the first at index ${first}`);
          voxels += a.data.length;
          // The pieces under the ingest's own names: what the scene digest and the caches key on.
          const z = await volumeToZarr(b.data, b.dims, b.dtype, { compressor: "raw" });
          // As sets of (position, name): the page's own cut finishes its pieces in whatever order its
          // workers do, so the two objects list the same entries in different orders.
          const sorted = (o?: Record<string, string>) => Object.entries(o ?? {}).sort((x, y) => (x[0] < y[0] ? -1 : 1));
          same(`volume ${f} piece names`, sorted(a.prebuilt?.desc.chunkHashes), sorted(z.desc.chunkHashes));
          // The rest of what the ingest takes from the copy instead of computing it (critic, 2026-09-23, finding 11).
          const d = a.prebuilt?.desc;
          same(`volume ${f} piece grid`, d && [d.shape, d.chunks, d.chunkGrid, d.dtype, d.bytes], [z.desc.shape, z.desc.chunks, z.desc.chunkGrid, z.desc.dtype, z.desc.bytes]);
          const wl = percentileWindowLevel(b.data);
          same(`volume ${f} window, level and range`, a.prebuilt?.display, { window: wl.window, level: wl.level, range: wl.range });
          for (const [h, bytes] of z.blobs) {
            const mine = a.prebuilt?.blobs.get(h);
            if (!mine || mine.byteLength !== bytes.byteLength || mine.some((v, i) => v !== bytes[i])) differences.push(`volume ${f}: piece ${h.slice(0, 20)}… differs or is missing`);
            pieces++;
          }
        }
        return {
          same: differences.length === 0, differences, volumes: copy.frames.length, voxels, pieces, ms: { copy: Math.round(copyMs), dicom: Math.round(dicomMs) },
          cannotSee: "a fault in the reader itself: both sides are made by the same reader functions, so this checks storage and transfer, not reading",
        };
      },
      /**
       * The instances of a series DERIVED from `parentSeriesUID` with this `kind`, or null.
       *
       * The other half of the save: `saveDicomArtefact` records `derivedFrom` when it writes, which
       * `db-index.ts` turns into a row in provenance.sqlite. This asks that store the question the
       * DICOM index cannot answer -- the index has modality and a description, neither of which
       * says "these are the surfaces of THAT segmentation" without guessing from a string.
       *
       * PROVENANCE OR NOTHING, deliberately. A database served without the `_provenance` route, or
       * one that has never had an edge written, returns null and the caller extracts, which is what
       * it did before. The alternative -- scanning series whose description happens to start
       * "surfaces of" -- can return the surfaces of a DIFFERENT segmentation, and a mesh drawn under
       * the wrong labels takes their colors and their visibility. A silent wrong answer is worse
       * than the 15 seconds this exists to save.
       */
      __dicomDerivedSeries: async (parentSeriesUID: string, kind: string): Promise<ArrayBuffer[] | null> => {
        const g2 = globalThis as unknown as { __dicomDerivedSeriesUID?: (p: string, k: string) => Promise<string | null> };
        const uid = await g2.__dicomDerivedSeriesUID?.(parentSeriesUID, kind);
        const row = uid ? openDb?.series.find((se) => se.seriesInstanceUID === uid) : undefined;
        if (!row || !openDb) return null;
        const files = await openDb.readSeriesFiles(row);
        // The series chosen travels with the files (a property on the array), so the caller can key
        // a cache on it without a second lookup.
        (files as ArrayBuffer[] & { seriesInstanceUID?: string }).seriesInstanceUID = row.seriesInstanceUID;
        return files;
      },
      /** WHICH series is derived from `parentSeriesUID` with this `kind` -- the uid alone, no bytes
       *  moved: the mesh cache is asked about it before the object is fetched. */
      __dicomDerivedSeriesUID: async (parentSeriesUID: string, kind: string): Promise<string | null> => {
        if (!openDb || !parentSeriesUID) return null;
        // THE SAME TWO REQUESTS, ONCE. This asked the server which databases there are and then for
        // the WHOLE provenance table -- per call. Loading a scene with four segmentations asked four
        // times for the same unchanging table: measured at 4.1 s of a 15 s load (the load profiler,
        // 2026-09-22), as much as reading the surfaces themselves.
        //
        // Held for one minute, and dropped by every save and every reopening of the database
        // snapshot (see `forgetProvenance`), so a save followed by a lookup sees its own edge.
        const edges = await provenanceEdges();
        if (!edges) return null;
        // NEWEST WINS. Re-saving surfaces writes a new series and a new edge; the old one is still
        // in the database and still correctly parented, so both match. `openDb.series` carries the
        // series date and time for exactly this -- Ron, on telling several derived series apart:
        // "Date and time of the creation would help." The edge's own createdAt is the tie-break
        // when the series row is undated: every surface series was, and a stable sort of equal
        // keys over an unordered SELECT returned the OLDEST (critic, 2026-09-17, finding 4).
        const matches = edges.filter((e) => e.parent === parentSeriesUID && e.kind === kind);
        const when = new Map(matches.map((e) => [e.child, e.createdAt ?? ""]));
        const rows = matches
          .map((e) => openDb!.series.find((se) => se.seriesInstanceUID === e.child))
          .filter((se): se is NonNullable<typeof se> => !!se && se.available)
          .sort((a, b) => {
            const ka = `${a.seriesDate ?? ""}${a.seriesTime ?? ""}`, kb = `${b.seriesDate ?? ""}${b.seriesTime ?? ""}`;
            return kb.localeCompare(ka) || (when.get(b.seriesInstanceUID) ?? "").localeCompare(when.get(a.seriesInstanceUID) ?? "");
          });
        return rows[0]?.seriesInstanceUID ?? null;
      },
      /** The database folder, when one was opened from disk: where an exported SEG is written. */
      __dicomDbDir: () => rememberedDir,
      /**
       * Re-read the open database's index, in the background, without showing the browser.
       *
       * Called after the application itself writes a series into the database, so what it just wrote
       * is immediately visible to everything that reads the snapshot -- above all the SEG exporter.
       * Returns the number of series now known, or null when no database is open.
       */
      /**
       * READ A VOLUME'S VOXELS BACK FROM THE DATABASE, and put its chunks in the store again.
       *
       * The other half of `LocalBlobStore.release`: the store gives a grayscale volume's chunks
       * back once its texture is made, and anything that wants the voxels afterwards comes here.
       * The rebuild is deterministic — the same samples, the same chunking, the same compressor —
       * so the chunks land under the same hashes they had, which is what makes this invisible to
       * every reader.
       */
      __restoreVolumeChunks: async (hash: string): Promise<boolean> => {
        const image = [...opts.live.nodes.values()].find((n) =>
          n.type === "image" && !!(n.zarr as ZarrDesc | undefined)?.chunkHashes &&
          Object.values((n.zarr as ZarrDesc).chunkHashes!).includes(hash)
        );
        const uid = (image?.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined);
        const series = uid?.seriesInstanceUID ?? uid?.savedSeriesInstanceUID;
        if (!image || !series || !openDb) return false;
        const entry = openDb.series.find((se) => se.seriesInstanceUID === series);
        if (!entry) return false;
        const z = image.zarr as ZarrDesc;
        try {
          const t0 = performance.now();
          const seq = await openDb.loadSequence(entry);
          const frameLabel = (image.origin as { frameLabel?: string } | undefined)?.frameLabel;
          const i = frameLabel ? Math.max(0, seq.labels.indexOf(frameLabel)) : 0;
          const vol = seq.frames[i] ?? seq.frames[0];
          if (!vol) return false;
          const { blobs } = await volumeToZarr(vol.data, vol.dims, z.dtype, { compressor: (z.compressor as "deflate" | "raw" | undefined) ?? "deflate" });
          opts.store.add(blobs);
          const secs = ((performance.now() - t0) / 1000).toFixed(1);
          status(`read ${(image.name as string) ?? "the volume"} back from the database in ${secs}s — its voxels were needed again`);
          return opts.store.has(hash);
        } catch {
          return false;                                  // the caller falls through to the network
        }
      },
      __refreshDicomDb: async (): Promise<number | null> => {
        forgetProvenance();                          // a save has just written an edge, probably
        if (!lastSource) { if (!servedDb) await loadRegistered(); if (servedDb) lastSource = httpSource(servedDb); }
        if (!lastSource) return null;
        try {
          openDb = await openDicomDatabase(lastSource);
          forgetProvenance();
          return openDb.series.length;
        } catch {
          return null;                      // a re-read that fails leaves the old snapshot in place
        }
      },
      /**
       * LOAD A SAVED SCENE (SCENE-DESIGN §5): open the served database if none is open, resolve every
       * series the file names, say what is missing and ask, load what is there through the browser's
       * own loop (`loadDbEntries`), then put the saved state back (scene-restore.ts) and report.
       */
      __loadSceneDoc: async (doc: Record<string, unknown>): Promise<{ ok: boolean; loaded?: number; missing?: string[]; seconds?: number; applied?: string[]; error?: string; timings?: string[]; failures?: string[]; v?: number; name?: string }> => {
        const t0 = performance.now();
        if (!openDb) {
          if (!lastSource && servedDb) lastSource = httpSource(servedDb);
          if (!lastSource) return { ok: false, error: "no DICOM database is open or served here" };
          openDb = await openDicomDatabase(lastSource, (p) => status(p.note));
          forgetProvenance();
        }
        const problems = checkScene(doc);
        if (problems.length) {
          shell.notify({ title: "This scene file did not pass its check", body: problems.slice(0, 5).map((p) => `${p.where}: ${p.what}`).join("\n") });
          return { ok: false, error: "check failed" };
        }
        const src = doc.source as { producer?: string } | undefined;
        const nodes = (doc.nodes as Record<string, Record<string, unknown>>) ?? {};
        // The series to load: every volume's and every segmentation's, once each (the five phases
        // are one series and come as a sequence); a surfaces series comes with its segmentation.
        const wanted = new Map<string, string>();
        for (const n of Object.values(nodes)) {
          const uid = (n.dicom as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID;
          if (typeof uid === "string" && (n.type === "image" || n.type === "segmentation") && !wanted.has(uid)) wanted.set(uid, n.type === "image" ? "a volume" : `${n.name ?? "a segmentation"}`);
        }
        let byUid = new Map(openDb.series.map((se) => [se.seriesInstanceUID, se]));
        if ([...wanted.keys()].some((u) => !byUid.has(u))) { await (globalThis as unknown as { __refreshDicomDb?: () => Promise<number | null> }).__refreshDicomDb?.(); byUid = new Map(openDb!.series.map((se) => [se.seriesInstanceUID, se])); }
        const missing = [...wanted].filter(([u]) => !byUid.has(u)).map(([, what]) => what);
        const entries = [...wanted.keys()].filter((u) => byUid.has(u)).map((u) => byUid.get(u)!);
        if (missing.length) {
          const go = await new Promise<boolean>((resolve) => shell.notify({
            title: `${missing.length === 1 ? "One thing" : `${missing.length} things`} in this scene ${missing.length === 1 ? "is" : "are"} not in the database`,
            body: missing.join("\n") + (src?.producer ? `\n\nSaved by ${src.producer}.` : ""),
            actions: [{ label: "Load what is here", primary: true, onClick: () => resolve(true) }, { label: "Stop", onClick: () => resolve(false) }],
          }));
          if (!go) return { ok: false, missing };
        }
        if (!entries.length) return { ok: false, error: "nothing in this scene is in the database", missing };
        // SOMETHING ELSE IS LOADED. Ron, 2026-09-20: "Let the user decide, but only if needed" --
        // so the question is asked only when the scene would land beside data it does not name;
        // opening a scene over its own study, or into an empty window, just opens. Unsaved work is
        // named in the question, because closing is what would lose it.
        const loadedElsewhere = [...opts.live.nodes.values()].filter((n) => (n.type === "image" || n.type === "segmentation") && !(n as { hidden?: boolean }).hidden).filter((n) => {
          const org = n.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
          return !wanted.has(org?.seriesInstanceUID ?? "") && !wanted.has(org?.savedSeriesInstanceUID ?? "");
        });
        if (loadedElsewhere.length) {
          const unsaved = unsavedWork();
          const choice = await new Promise<"close" | "keep" | "stop">((resolve) => shell.notify({
            title: `${loadedElsewhere.length === 1 ? "One thing is" : `${loadedElsewhere.length} things are`} loaded that this scene does not include`,
            body: `<b>${loadedElsewhere.slice(0, 4).map((n) => esc(String(n.name ?? n.id))).join("</b><br><b>")}</b>` + (loadedElsewhere.length > 4 ? `<br>… and ${loadedElsewhere.length - 4} more` : "") +
              (unsaved.length ? `<br><br>Not saved: <b>${unsaved.map(esc).join("</b>, <b>")}</b> — closing loses ${unsaved.length === 1 ? "it" : "them"}.` : ""),
            actions: [
              { label: "Close them, then open the scene", primary: !unsaved.length, onClick: () => resolve("close") },
              { label: "Keep them and add the scene", primary: !!unsaved.length, onClick: () => resolve("keep") },
              { label: "Stop", onClick: () => resolve("stop") },
            ],
          }));
          if (choice === "stop") return { ok: false, error: "stopped" };
          if (choice === "close") { closeScene(); await new Promise((r) => setTimeout(r, 100)); }
        }
        // Images before segmentations, ancestors with them -- the browser's own order.
        const list = withAncestors(entries).sort((a, b) => Number(a.modality === "SEG") - Number(b.modality === "SEG"));
        const timings: string[] = [], failures: string[] = [];
        // What the scene says about each segmentation's 3D, handed to the load so it arrives that way.
        const arrivalFor = (uid: string) => {
          const n = Object.values(nodes).find((x) => x.type === "segmentation" && (x.dicom as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID === uid);
          return n ? { visible3D: n.visible3D as boolean | undefined } : undefined;
        };
        // THE SCENE PAINTS AS IT ARRIVES, instead of appearing all at once at the end.
        //
        // Ron, on an 18.7 s open, asked for exactly this order: "first the grayscale slices, then a
        // volume rendering, then the abdominal muscles…". The saved state used to be applied once,
        // after every series had landed, so for the whole load the views showed the ARRIVAL
        // defaults — a volume at the wrong window, slices in the wrong place, the camera elsewhere
        // — and only snapped into the saved scene at the end. That is the waiting he felt.
        //
        // `applySceneState` only writes what differs, so calling it again as each series lands is
        // cheap and idempotent: the slices are right the moment the volume is there, and each
        // segmentation takes its saved colors and visibility as it arrives, not minutes later.
        startLoadProfile(`scene "${String(doc.name ?? "scene")}" · ${list.length} series`);
        const gg = globalThis as unknown as { __setLayout?: (id: number) => void; __setSliceOffset?: (cell: string, mm: number) => void; __cardiacReformat?: (cell: string, view: string) => Promise<boolean>; __setSliceIn3D?: (cell: string, on: boolean) => void; __sliceIn3D?: () => string[]; __holdCardiacDefaults?: (on: boolean) => void };
        const sceneHooks = () => ({ setLayout: (a: number) => gg.__setLayout?.(a), setSliceOffset: (c: string, mm: number) => gg.__setSliceOffset?.(c, mm), cardiacReformat: gg.__cardiacReformat, setSliceIn3D: gg.__setSliceIn3D, sliceIn3D: gg.__sliceIn3D });
        // The scene's own planes, not the heart default's, when its chambers arrive (live-views.ts, cardiacHeld).
        if (Object.values(nodes).some((x) => x.type === "view" && x.kind === "slice")) gg.__holdCardiacDefaults?.(true);
        let painted = 0;
        const paintWhatIsHere = () => {
          painted++;
          mark(`series ${painted} on screen`);
          try { spanSync("put the saved state back", () => applySceneState(opts.live, doc, sceneHooks())); } catch { /* the full pass at the end is the one that must hold */ }
        };
        await loadDbEntries(openDb, list, status, timings, failures, arrivalFor, paintWhatIsHere);
        setTimeout(() => (globalThis as unknown as { __memoryCheck?: () => string }).__memoryCheck?.(), 4000);
        // A LOAD WITH FAILURES IS NOT "LOADED" (critic, finding 2): it says so, it does not become
        // the current scene, and the saved state is applied to what did arrive.
        if (failures.length) shell.notify({ title: `${failures.length} of ${list.length} could not be loaded — the scene is not open`, body: failures.slice(0, 3).map(esc).join("<br>") });
        // THE SAVED STATE, after the data and after the arrival defaults have had their say: what
        // the file says is what the views show (SCENE-DESIGN §5, step 4).
        await new Promise((r) => setTimeout(r, 250));
        const report = spanSync("put the saved state back", () => applySceneState(opts.live, doc, sceneHooks()));
        gg.__holdCardiacDefaults?.(false);   // the scene's planes are in; a heart added from now on gets the default
        // WHAT THIS LOAD SPENT, in the session log, every time. Ron: "loading is a very important
        // function ... instrument the scene loading process so you can analyze where time is spent.
        // Are there duplications or inefficiencies?" The counts are the half that answers the
        // second question.
        // NOT AWAITED: the scene is open and the person can work; the profile closes when the
        // surfaces have finished arriving and the picture stands still (Ron: "loading ... until I
        // have a stable display"), and writes its line then.
        void endLoadProfileWhenQuiet(list.length).then((profile) => {
          if (!profile) return;
          const line = describeProfile(profile);
          status(line);
          void fetch("/_log", { method: "POST", body: describeProfilePhases(profile), keepalive: true }).catch(() => {});
          (globalThis as unknown as { __lastLoadProfile?: unknown }).__lastLoadProfile = profile;
        });
        const seconds = (performance.now() - t0) / 1000;
        const name = String(doc.name ?? "scene");
        const surfacesFollow = [...opts.live.nodes.values()].some((n) => n.type === "segmentation" && n.surfaceModels === true && n.visible3D !== false && !(n as { hidden?: boolean }).hidden);
        if (failures.length) return { ok: false, error: `${failures.length} of ${list.length} series could not be loaded`, loaded: list.length - failures.length, missing: [...missing, ...report.missing], seconds, applied: report.applied, timings, failures };
        status(`Scene "${name}" loaded in ${seconds.toFixed(1)} s · ${list.length} series · ${report.applied.length} settings put back${surfacesFollow ? " · the 3D surfaces follow" : ""}${report.missing.length ? ` · not restored: ${report.missing.join(", ")}` : ""}`);
        // Colors other than the scheme's are KEPT (Ron, 2026-09-25: "yes as default so people do not need to click on
        // it"); the notice says so and offers the one button (logic/scheme-colors.ts).
        const off = segmentationsOffScheme(opts.live);
        const offLine = off.length ? `<br>${off.length === 1 ? "One segmentation keeps its" : `${off.length} segmentations keep their`} saved colors, not those of colors v${paletteVersion()}.` : "";
        shell.notify({ title: `Scene loaded — "${esc(name)}"`, body: `${list.length} series in ${seconds.toFixed(1)} s${surfacesFollow ? "; the 3D surfaces follow" : ""}${missing.length ? `<br>Not in the database: ${esc(missing.join(", "))}` : ""}${report.missing.length ? `<br>Not restored: ${esc(report.missing.join(", "))}` : ""}${offLine}`, ttl: off.length ? 15000 : 8000,
          ...(off.length ? { offerOnly: true, actions: [
            { label: "Use the current colors", onClick: () => { const n = off.reduce((k, o) => k + useCurrentColors(opts.live, o.id), 0); status(`Colors: ${n} structures now in the colors of v${paletteVersion()}`); } },
            { label: "Keep", primary: true, onClick: () => {} },
          ] } : {}) });
        // SEGMENTATIONS, WHEN THE SCENE HAS ANY. Ron, 2026-09-23: "when I hit load scene you change
        // from welcome to scene. I would prefer to have segmentations up at that point." A scene with
        // no segmentation in it still goes to Scene: an empty Segmentations module shows nothing.
        // (Loading from the DICOM browser still goes to Scene, as he asked for on its own.)
        const hasSegs = [...opts.live.nodes.values()].some((n) => n.type === "segmentation" && !(n as { hidden?: boolean }).hidden);
        void shell.showPanel(hasSegs ? "segmentations" : "data");
        return { ok: true, loaded: list.length, missing: [...missing, ...report.missing], seconds, applied: report.applied, timings, failures, v: typeof doc.v === "number" ? doc.v : 1, name };
      },
      /** Load a saved scene by its uid from the current database's store. */
      __loadScene: async (uid: string) => {
        const cur = registered.find((d) => d.current && d.exists) ?? registered.find((d) => d.exists);
        if (!cur) return { ok: false, error: "no database" };
        const res = await fetch(`/_db/${encodeURIComponent(cur.id)}/_scene/${encodeURIComponent(uid)}`, { cache: "no-store" });
        if (!res.ok) return { ok: false, error: `no such scene (HTTP ${res.status})` };
        return await (globalThis as unknown as { __loadSceneDoc: (d: Record<string, unknown>) => Promise<unknown> }).__loadSceneDoc(await res.json());
      },
    });
    void recallDatabaseDir().then((d) => { rememberedDir = d; });

    // A database SERVED over HTTP, which is what makes this work at all in the WKWebView the native
    // app runs: that has no showDirectoryPicker, so the folder route is unavailable there entirely.
    // A served database needs no picker, no permission and no user gesture.
    // Databases come from the SETTINGS FILE, not from a symlink in the served tree.
    //
    // This used to be `/dicomdb/`, which the gallery satisfied with a symlink into one particular
    // database. Ron: "The subject data base should not be hardwired anywhere" -- and that was the
    // hardwiring: a path to a specific person's data, baked into the checkout, invisible without
    // `ls -la`, unchangeable without editing the tree, and capable of naming only one database ever.
    //
    // `/_db` reports what is registered with each FULL PATH, which is what gets displayed, and which
    // one is current. Remembering the last one used is then the settings file's job rather than a
    // directory handle in IndexedDB that no one can inspect.
    let servedDb: string | null = null;
    let servedLabel = "";
    let registered: { id: string; path: string; exists: boolean; current: boolean }[] = [];
    const loadRegistered = async () => {
      try {
        const res = await fetch("/_db", { cache: "no-store" });
        if (!res.ok) return;
        registered = (await res.json()).databases ?? [];
        const cur = registered.find((d) => d.current && d.exists) ?? registered.find((d) => d.exists);
        if (cur) {
          servedDb = new URL(`/_db/${encodeURIComponent(cur.id)}/`, location.href).href;
          servedLabel = cur.path;   // the full path, per Ron
        }
      } catch { /* no native side: a browser build has no /_db */ }
    };
    void loadRegistered().then(() => {
      const hint = el.querySelector(".sl-db-hint") as HTMLElement | null;
      if (!hint) return;
      const cur = registered.find((d) => d.current) ?? registered[0];
      hint.textContent = !registered.length
        ? "no database registered — add one under [Database] in settings.ini"
        : cur.exists
        ? cur.path
        : `${cur.path} (not reachable)`;
      hint.title = registered.map((d) => `${d.current ? "→ " : "  "}${d.id}: ${d.path}${d.exists ? "" : "  (missing)"}`).join("\n");
    });

    const failed = (e: unknown) => {
      const err = e as Error;
      if (err?.name === "AbortError") return;                 // user canceled the picker
      console.error("[DICOM database]", err);
      status(`DICOM database: ${err?.message ?? String(e)}`);
    };

    const browseSource = async (source: DbSource, title: string) => {
      status("opening database…");
      const db = await openDicomDatabase(source, (p) => status(p.note));
      openDb = db;
      forgetProvenance();
      lastSource = source;
      status(`${title}: ${db.series.length} series`);
      await showDatabaseBrowser(db, title, (again) => openDatabase(again));
    };

    /**
     * The database currently open, and the folder it came from.
     *
     * Held so a segmentation can be written back OUT as DICOM: a SEG has to reference the source
     * series' own instances, so the exporter needs to re-read the very files the volume was built
     * from, and the folder is where the written SEG lands for Slicer to import.
     */
    const browseDatabase = async (dir: FileSystemDirectoryHandle) => {
      rememberedDir = dir;
      void rememberDatabaseDir(dir);
      await browseSource(directorySource(dir), dir.name);
    };

    /** `pick` forces the folder chooser; otherwise the served or remembered database is reopened. */
    const openDatabase = (pick: boolean) => {
      // A served database is the direct route and needs no permission, so it wins unless the user
      // explicitly asked to choose a folder.
      // The label passed through is the full path, so the browser's title names the database
      // unambiguously rather than repeating the word "database" back at the user.
      if (!pick && servedDb) { browseSource(httpSource(servedDb), servedLabel || "DICOM database").catch(failed); return; }

      const picker = (globalThis as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) {
        status(servedDb
          ? "no folder picker here — using the served database instead"
          : "no DICOM database is served here, and this browser has no folder picker");
        return;
      }

      const remembered = pick ? null : rememberedDir;
      if (remembered) {
        // requestPermission is the FIRST await here, so the click's activation is still valid.
        const h = remembered as unknown as { requestPermission?: (d: { mode: string }) => Promise<PermissionState> };
        (h.requestPermission?.({ mode: "read" }) ?? Promise.resolve("granted" as PermissionState))
          .then((state) => {
            if (state === "granted") return browseDatabase(remembered);
            status("permission for the remembered folder was declined — use “Change…” to pick it again");
          })
          .catch(failed);
        return;
      }
      // No remembered handle: open the picker immediately, before any await.
      picker({ id: "slicerlive-dicom-db" }).then(browseDatabase).catch(failed);
    };
    (el.querySelector('[data-act="dicom-db"]') as HTMLButtonElement).addEventListener("click", () => openDatabase(false));

    // ---- "Also add to [database]" and the Databases window (Ron, 2026-10-01; desktop/db-import.ts) ----
    const addBox = el.querySelector(".sl-add-db") as HTMLInputElement, addWhich = el.querySelector(".sl-add-db-which") as HTMLSelectElement;
    const afterDatabasesChanged = async (madeId?: string) => {
      await loadRegistered();
      await fillAddWhich(madeId);
    };
    const fillAddWhich = async (select?: string) => {
      const { databases, features } = await listDatabases();
      const keep = select ?? addWhich.value;
      addWhich.innerHTML = "";
      const usable = databases.filter((d) => d.exists);
      for (const d of usable) {
        const o = document.createElement("option");
        o.value = d.id; o.textContent = dbName(d) + (d.description?.patientData ? " (patient data)" : "");
        addWhich.appendChild(o);
      }
      if (features.includes("create")) {
        const n = document.createElement("option"); n.value = "_new"; n.textContent = "New database…"; addWhich.appendChild(n);
      }
      const all = document.createElement("option"); all.value = "_all"; all.textContent = "All databases…"; addWhich.appendChild(all);
      addWhich.value = usable.some((d) => d.id === keep) ? keep : (usable.find((d) => d.current) ?? usable[0])?.id ?? "_new";
      (el.querySelector(".sl-add-row") as HTMLElement).hidden = !features.includes("import");
    };
    addWhich.addEventListener("change", () => {
      if (addWhich.value !== "_new" && addWhich.value !== "_all") return;
      const startWithNew = addWhich.value === "_new";
      void fillAddWhich();   // back to a real database while the window is open
      openDatabasesWindow({ startWithNew, onChanged: (id) => void afterDatabasesChanged(id) });
    });
    void fillAddWhich();
    (el.querySelector('[data-act="databases"]') as HTMLButtonElement).addEventListener("click", () => openDatabasesWindow({ onChanged: (id) => void afterDatabasesChanged(id) }));
    /** The database DICOM loaded from disk is added to, or null when "Also add to" is unticked. */
    const addTarget = (): { id: string; name: string } | null =>
      addBox.checked && addWhich.value && !addWhich.value.startsWith("_") ? { id: addWhich.value, name: addWhich.selectedOptions[0]?.textContent ?? addWhich.value } : null;
    /** Run an import, then say what happened where the person looks, with a button to see the result. */
    const reportImport = async (target: { id: string; name: string }, run: () => Promise<ImportResult>) => {
      let r: ImportResult;
      try { r = await run(); }
      catch (e) { shell.notify({ title: "The scans were not added", body: esc((e as Error).message) }); status((e as Error).message); return; }
      const { title, lines } = describeImport(r, target.name);
      status(lines[0] ?? title);
      (globalThis as unknown as { __forgetProvenance?: () => void }).__forgetProvenance?.();
      shell.notify({ title, body: lines.map(esc).join("<br>"), actions: r.series.length || r.already ? [{ label: "Open the DICOM database", primary: true, onClick: async () => {
        const cur = registered.find((d) => d.current);
        if (cur?.id !== target.id) await fetch("/_db", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: target.id }) });
        await loadRegistered();
        openDatabase(false);
      } }] : [] });
    };
    // LOAD SCENE: the store's list in its own window, one Open per row (Ron, 2026-09-20: "Can you
    // add a Load scene button which provides a listing of the scenes available in the db?"). The
    // same rows the DICOM browser files under their studies, here in one place, newest first.
    // THE SCENE CONTROL, the same as on the bar (render/demos/scene-control.ts); its "All scenes…" is the window below.
    el.querySelector(".sl-scene-slot")?.replaceWith(sceneControl());
    (globalThis as unknown as { __scenesWindow?: () => Promise<void> }).__scenesWindow = showScenesWindow;
    async function showScenesWindow() {
      const reg = await fetch("/_db", { cache: "no-store" }).then((x) => x.ok ? x.json() : null) as { databases?: { id: string; current?: boolean; exists?: boolean; path?: string }[] } | null;
      const cur = (reg?.databases ?? []).find((d) => d.current && d.exists) ?? (reg?.databases ?? []).find((d) => d.exists);
      if (!cur) { shell.notify({ title: "No scenes here", body: "No DICOM database is served by this window." }); return; }
      const scenes = (await fetch(`/_db/${encodeURIComponent(cur.id)}/_scenes`, { cache: "no-store" }).then((x) => x.ok ? x.json() : { scenes: [] }).catch(() => ({ scenes: [] })) as { scenes: { uid: string; study: string; studies?: string[]; name: string; producer: string; producedAt: string; v: number; bytes: number; series?: number }[] }).scenes;
      // The study's patient and description, from the open database when there is one.
      if (!openDb && servedDb) { try { lastSource = httpSource(servedDb); openDb = await openDicomDatabase(lastSource, (p) => status(p.note)); forgetProvenance(); } catch { /* the list still shows */ } }
      const studyLabel = (uid: string) => { const se = openDb?.series.find((x) => x.studyInstanceUID === uid); return se ? `${(se.patientID ?? "").trim() || se.patientName || ""} · ${realDescription(se.studyDescription) || "study"}${se.studyDate ? ` · ${se.studyDate}` : ""}` : `study …${uid.slice(-8)}`; };
      const { box, close } = openFloatingWindow({ title: `Scenes — ${cur.path ?? cur.id}`, titleTip: cur.path ?? cur.id, size: { w: 760, h: 420 } });
      const body = document.createElement("div"); body.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;padding:6px 10px;";
      if (!scenes.length) body.innerHTML = `<p class="sl-hint">No scene has been saved in this database yet. Save one with Scene ▾ › Save, on the bar at the top.</p>`;
      const th = (t: string, right = false) => `<th style="text-align:${right ? "right" : "left"};padding:4px 8px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--sl-fg-muted)">${t}</th>`;
      const table = document.createElement("table"); table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;";
      table.innerHTML = `<tr>${th("")}${th("Scene")}${th("Study")}${th("Saved")}${th("Series", true)}${th("")}</tr>`;
      for (const sc of scenes) {
        const tr = document.createElement("tr"); tr.style.cssText = "border-top:1px solid var(--sl-line-faint);";
        const when = new Date(sc.producedAt); const p2 = (n: number) => String(n).padStart(2, "0");
        const whenText = isNaN(when.getTime()) ? "" : `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())} ${p2(when.getHours())}:${p2(when.getMinutes())}`;
        const tdOpen = document.createElement("td"); tdOpen.style.cssText = "padding:4px 8px;width:1%;";
        const openBtn = document.createElement("button"); openBtn.className = "sl-primary"; openBtn.textContent = "Open"; openBtn.title = "Load this scene: its series, and everything as it was on screen";
        openBtn.addEventListener("click", async () => { openBtn.disabled = true; close(); const g = globalThis as unknown as { __openScene?: (uid: string) => Promise<{ ok: boolean; error?: string }> }; const r = await g.__openScene?.(sc.uid); if (r && !r.ok && r.error && r.error !== "stopped") shell.notify({ title: "The scene did not open", body: esc(r.error) }); });
        tdOpen.appendChild(openBtn);
        const cell = (t: string, right = false) => { const td = document.createElement("td"); td.style.cssText = `padding:4px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch;${right ? "text-align:right;" : ""}`; td.textContent = t; td.title = t; return td; };
        const studies = sc.studies?.length ? sc.studies : [sc.study];
        // DELETE, HERE AND ONLY HERE among the scene controls (Ron, 2026-09-25: "Only in the window"). It asks first; the
        // series the scene lists stay in the database.
        const tdDel = document.createElement("td"); tdDel.style.cssText = "padding:4px 8px;width:1%;";
        const delBtn = document.createElement("button"); delBtn.textContent = "Delete"; delBtn.title = "Delete this scene from the database. Its series stay.";
        delBtn.addEventListener("click", async () => {
          const ok = await shell.confirm({ title: "Delete the scene?", ok: "Delete", destructive: true, cancel: "Cancel", body: `<p>“${esc(sc.name)}” is removed from the database. The series it lists stay.</p>` });
          if (!ok) return;
          void runAction(delBtn, async () => {
            const done = await fetch(`/_db/${encodeURIComponent(cur.id)}/_scene/${encodeURIComponent(sc.uid)}`, { method: "DELETE" }).then((x) => x.ok).catch(() => false);
            if (!done) throw new Error("not deleted");
            const gg = globalThis as unknown as { __currentScene?: () => { uid: string } | null; __setCurrentScene?: (c: null) => void };
            if (gg.__currentScene?.()?.uid === sc.uid) gg.__setCurrentScene?.(null);   // the open one: the next save is a new scene
            setTimeout(() => tr.remove(), 900);
          }, { busyLabel: "Deleting…", doneLabel: "Deleted", failedLabel: "Not deleted" }).catch(() => {});
        });
        tdDel.appendChild(delBtn);
        tr.append(tdOpen, cell(`${sc.name}  ·  save ${sc.v}`), cell(studies.map(studyLabel).join(" + ")), cell(whenText), cell(sc.series ? String(sc.series) : "", true), tdDel);
        table.appendChild(tr);
      }
      if (scenes.length) body.appendChild(table);
      box.appendChild(body);
    }
    // "Change…" LEFT THIS PANEL on 2026-09-20 (Ron: "review this panel for redundancies and
    // compliance with the rule of where to put boxes"): which database is current is chosen in
    // Settings › General, and in the native app the folder picker this button needed does not
    // exist, so all it ever did here was offer the same registered list. Loading is this panel's
    // business; choosing a database is a setting. `openDatabase(true)` stays for the browser build.
    (globalThis as unknown as { __pickDatabase?: () => void }).__pickDatabase = () => openDatabase(true);
    openDatabaseFromOutside = () => { void (servedDb ? Promise.resolve() : loadRegistered()).then(() => openDatabase(false)); };   // a fresh panel has not yet asked which database is current
    showLoadFromDisk = () => showPane("load-files");
    dicomFilesArrived = async (files: File[]) => {
      status("scanning files…");
      showSeries(await indexFiles(files, indexProgress));
      const target = addTarget();
      if (target) await reportImport(target, () => addFilesToDatabase(target.id, files, target.name, status));
    };
    dicomInput.addEventListener("change", async () => { const files = Array.from(dicomInput.files ?? []); dicomInput.value = ""; if (files.length) await dicomFilesArrived?.(files); });
  } });

  // DATA — what is currently in the scene, and nothing about how it got there.
  //
  // Pinned as well as filed under Files: it is where a session lives, and it is also the archive's
  // near neighbor. Both, without registering it twice — see PanelSpec.groups.
  shell.registerPanel({
    id: "data",
    title: "Scenes",
    // "Scenes", the bar's control "Scene" (Ron, 2026-09-25). DATA, beside Load / Save and Segmentations: the Subject Hierarchy organizes what is loaded;
    // its per-view buttons are how each thing is shown, but the module's subject is the things.
    // Moved with Segmentations on 2026-09-22 (the module list review); Ron may move it back.
    groups: ["Data"],
    order: 2,
    tip: "What is loaded, and which view shows it; rename or remove",
    help: `<p>Everything currently in the scene — volumes, segmentations, markups, transforms — as a
      Subject Hierarchy, with what is shown in which view. Rename with a double-click, delete with a
      right-click.</p>
      <p>This is the session, not the archive: what is listed here came from a file or from the
      DICOM database, and closing the application ends it. Use Save to keep a result.</p>`,
    mount(el) {
    el.innerHTML = `
      <h2>Scenes</h2>
      <div class="sl-scene-id sl-hint" title="The scene this window is in. Click its name to rename it."></div>
      <div class="sl-row sl-sh-head"><h3>Subject Hierarchy</h3><label class="sl-sh-link" title="Off: R/Y/G switch one view. On: all three together."><input type="checkbox" class="sl-sh-link-cb"> Link slice views</label><span class="sl-scene-slot"></span></div>
      <div class="sl-sh"></div>`;

    // Subject Hierarchy: every data node (any type) unless hidden.
    //
    // Rename and delete used to sit here as two more buttons on every row, alongside visibility --
    // Ron: "a listing that is in a box that does not spill over into a second line and is not
    // overloaded." With no layout CSS of its own, a row was plain inline spans that wrapped exactly
    // like paragraph text once four buttons and a name did not fit the sidebar, which is what
    // "spill over" was. Fixed here two ways: real flexbox with a non-wrapping, ellipsis-truncated
    // name (so a long name shortens instead of breaking the row), and two of the three actions
    // moved OFF the row entirely -- rename is now a double-click on the name and delete a
    // right-click on the row, both Ron: "like in Mac Finder" / "delete is a right click". Only the
    // visibility toggle, the one used constantly, stays as a persistent control.
    const shEl = el.querySelector(".sl-sh") as HTMLElement;
    const DATA_TYPES = new Set(["image", "segmentation", "markup", "model", "transform", "sequence"]);
    const ICON: Record<string, string> = { image: "🧊", segmentation: "🎨", markup: "📍", model: "🧩", transform: "⭮" };

    // One shared right-click menu for every row, built once. Ron: "delete is a right click."
    const shMenu = document.createElement("div");
    shMenu.className = "sl-sh-menu";
    shMenu.hidden = true;
    // "REMOVE FROM SCENE", not "Delete". Ron deleted a saved segmentation here and found it still in
    // the archive: "I deleted the lungvessel from the data module, but is still there when I bring up
    // the dicom db." This module owns the SESSION -- unloading is the right thing for it to do -- but
    // a verb that does not name the place it acts on invites exactly that. The rule now applies
    // everywhere: Remove from scene, Save to DICOM database, Delete from DICOM database, Delete
    // autosave. Every destructive verb says where.
    shMenu.innerHTML = `<button class="sl-sh-menu-item" data-menu-del title="Unloads it from this session. Anything saved to the DICOM database stays there.">Remove from scene</button>`;
    document.body.appendChild(shMenu);
    let shMenuTarget: string | null = null;
    const hideShMenu = () => { shMenu.hidden = true; shMenuTarget = null; };
    shMenu.querySelector("[data-menu-del]")!.addEventListener("click", () => {
      if (shMenuTarget) {
        // A VOLUME is not just its node: the slice composites name it as a layer, and a plain
        // `del` leaves them pointing at an id that is gone -- three blank slice views and no way
        // to tell why. removeVolumeFromScene re-points them (see logic/ingest.ts).
        const n = opts.live.nodes.get(shMenuTarget);
        if (n?.type === "image") removeVolumeFromScene(opts.live, shMenuTarget);
        else opts.live.write({ op: "del", id: shMenuTarget });
      }
      hideShMenu();
    });
    document.addEventListener("click", hideShMenu);
    document.addEventListener("contextmenu", (e) => { if (!shMenu.contains(e.target as Node)) hideShMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideShMenu(); });

    // R/Y/G/3D visibility. Ron: "visibility should be per viewer and not global... each view
    // independently, with the option to link all the slice viewers... two layers: gray scale and
    // segmentations... the ability to display each of them in the 3D viewer."
    //
    // What actually differs per node type, and why the controls below are not identical for every
    // row: an "image" (grayscale background OR a labelmap layer, both the same node type) sits in a
    // separate sliceComposite per Red/Yellow/Green already -- VolumeLayersDisplayableManager now
    // reads a `hiddenViews` list per node there, so R/Y/G are genuinely three independent switches.
    // A "segmentation" (the AI-run, colorized kind) has only ONE 2D overlay shared across every
    // slice view today -- splitting THAT per view would mean threading a layoutName through the
    // WebGPU compositing pass itself, which is a materially larger change deferred for now. It does
    // already split cleanly from 3D, which is its own field (SegmentationDisplayableManager.apply),
    // so a segmentation row offers 2D / 3D, not R/Y/G. Markups, models and transforms keep the one
    // eye button they always had -- nothing here proposed splitting those.
    const SLICE_VIEWS: { name: string; token: string }[] = [
      { name: "Red", token: "--sl-view-red" }, { name: "Yellow", token: "--sl-view-yellow" }, { name: "Green", token: "--sl-view-green" },
    ];
    // Off by default. Linked, ONE click on any of R/Y/G hid the volume in all three views at once --
    // and since the only feedback was a dimmed button, that reads as "the slice views broke", not as
    // "I just switched this off everywhere". Ron hit exactly that: "did you notice that there were
    // no cross sections?" Unlinked, a click costs one view and the other two show what happened.
    /**
     * WHICH VOLUME A SLICE VIEW IS SHOWING, and how R/Y/G change it.
     *
     * A slice view has ONE background layer, named by its sliceComposite. With a single volume
     * loaded that is invisible -- R/Y/G read as a plain per-view on/off. With TWO, half the buttons
     * did nothing: clicking R on the volume the Red view was not showing flipped the button to its
     * off style and changed nothing on screen, because the composite still named the other volume.
     * Ron loaded four datasets, "just clicked on the buttons for slices and 3d", and reported the
     * slice views not working.
     *
     * So R/Y/G mean "show THIS volume in that view" -- click one that is off and the view switches
     * to it; click the one that is on and the view goes empty (and says so). That is Slicer's model:
     * you choose a background per slice view, and every button now does something.
     *
     * A labelmap occupies the LABEL layer, not the background, so it is switched there instead --
     * otherwise showing a segmentation would replace the anatomy underneath it.
     */
    const compFor = (ln: string) =>
      [...opts.live.nodes.values()].find((c) => c.type === "sliceComposite" && c.layoutName === ln);
    const roleOf = (n: MrsonNode) => (n as { labelmap?: boolean }).labelmap ? "label" : "background";
    const layerOf = (ln: string, role: string) =>
      (((compFor(ln)?.refs as Record<string, string[]> | undefined) ?? {})[role] ?? [])[0];
    const shownIn = (n: MrsonNode, ln: string) =>
      layerOf(ln, roleOf(n)) === n.id && !new Set((n.hiddenViews as string[] | undefined) ?? []).has(ln);

    let linkSlices = false;
    const linkCb = el.querySelector(".sl-sh-link-cb") as HTMLInputElement;
    linkCb.addEventListener("change", () => linkSlices = linkCb.checked);
    // SAVE, SAVE AS, OPEN, CLOSE: the one Scene control, as on the bar (render/demos/scene-control.ts).
    el.querySelector(".sl-scene-slot")?.replaceWith(sceneControl());

    // The listing as a hierarchy -- each segmentation under its volume, in drawing order -- comes
    // from scene-order.ts, shared with the 3D view's own panel so the two lists never disagree.
    const ordered = orderScene;

    // WHICH SCENE THIS IS, at the top of the module that saves it. Ron, having saved from here and
    // stayed: "the saved scene is not listed." The scene was in the database; this module said
    // nothing about it. It says it now, and it changes the moment a save, an open or a close does.
    const sceneIdEl = el.querySelector(".sl-scene-id") as HTMLElement;
    const paintSceneId = () => {
      const g = globalThis as unknown as { __currentScene?: () => { name: string; v: number } | null };
      const cur = g.__currentScene?.();
      sceneIdEl.textContent = "";
      if (!cur) { sceneIdEl.textContent = "No scene saved yet — Scene ▾ › Save writes what is on screen into the DICOM database"; return; }
      // THE NAME IS EDITED WHERE IT IS SHOWN (Ron, 2026-09-25): a click turns it into a field; Return or leaving keeps it,
      // Escape does not.
      const nm = document.createElement("span"); nm.className = "sl-scene-name-inline"; nm.textContent = cur.name; nm.title = "Click to rename";
      nm.addEventListener("click", () => {
        const input = document.createElement("input"); input.className = "sl-sh-rename"; input.value = cur.name;
        let done = false;
        const finish = (keep: boolean) => { if (done) return; done = true; if (keep) void renameCurrentScene(input.value).then(paintSceneId); else paintSceneId(); };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
        input.addEventListener("blur", () => finish(true));
        nm.replaceWith(input); input.focus(); input.select();
      });
      sceneIdEl.append("Scene: ", nm, ` ✎ — save ${cur.v}, in the DICOM database`);
    };
    paintSceneId();
    (globalThis as unknown as { __onSceneIdentity?: () => void }).__onSceneIdentity = () => { try { paintSceneId(); } catch { /* panel gone */ } };

    // keepScroll: the rows carry the view toggles, so clicking one rebuilds the list underneath the
    // pointer -- the same jump-to-top Ron hit in the Segmentations module.
    // "IN 3D" UNDER EACH VOLUME: Off · Volume · Colored · Surfaces (render/look3d.ts). Ron, 2026-09-23: "in
    // the scene module I need presets for: surface rendering, colorized volume, volume rendering of the
    // gray scale. We use default behavior when loading, and the user can override with the presets."
    // What is highlighted is read back from what is on, not from what was last clicked here.
    // "Solid", not "Colored" (Ron, 2026-09-25): Slicer's "colorized volume" (the Colorize Volume module) is the see-through
    // tinted rendering, which is not this. Stored as "solid" too; the saved scenes were rewritten (a file from elsewhere
    // that says "colored" is read as "solid", look3d.ts).
    const LOOK_LABEL: Record<Look3D, string> = { off: "Off", volume: "Volume", solid: "Solid", surfaces: "Surfaces" };
    const LOOK_TIP: Record<Look3D, string> = {
      off: "Nothing of this scan in 3D.",
      volume: "Volume: the scan itself in 3D, see-through by tissue density (a CT starts as flesh; other presets in Volume Rendering). Its segmentations are not shown.",
      solid: "Solid: the anatomy of its segmentations as solid shapes, each structure in its own color. Appears at once. How it looks (Illustration or Realistic) is chosen with the Look button in the 3D view's panel. The scan itself is not shown.",
      surfaces: "Surfaces: the anatomy as surface models, for the segmentations given them in Generate Surface Models; the others are shown solid. The scan itself is not shown.",
    };
    const IN3D_TIP = "What this scan shows in 3D. Volume: the scan itself. Solid: the anatomy of its segmentations as solid shapes. Surfaces: the anatomy as surface models. How the anatomy looks (Illustration or Realistic) is set with the Look button in the 3D view's panel.";
    const NEEDS_SEG = "Needs a segmentation of this volume: run one in AI Segmentation, or load one from the DICOM browser.";
    const lookRow = (imageId: string): string => {
      const cur = look3DOf(opts.live, imageId);
      const on = looksOn(opts.live, imageId);           // what is on screen: may be two (see looksOn)
      const hasSegs = segmentationsOf(opts.live, imageId).length > 0;
      // "Surfaces" appears only once surface models have been generated for one of its segmentations
      // (Generate Surface Models) -- Ron: "at which time the proper controls would appear in the scene".
      const withSurfaces = hasSurfaceModels(opts.live, imageId);
      return `<div class="sl-sh-look" data-look-for="${imageId}"><span class="sl-sh-look-l" title="${IN3D_TIP}">In 3D</span>` +
        LOOKS_3D.filter((l) => l !== "surfaces" || withSurfaces || cur === "surfaces").map((l) => {
          const na = (l === "solid" || l === "surfaces") && !hasSegs;
          return `<button class="sl-sh-look-b${on.includes(l) ? " sl-on" : ""}${na ? " sl-sh-look-na" : ""}" data-look="${l}" aria-pressed="${on.includes(l)}" title="${na ? NEEDS_SEG : LOOK_TIP[l]}">${LOOK_LABEL[l]}</button>`;
        }).join("") + `</div>`;
    };
    const paintLooks = () => {
      shEl.querySelectorAll<HTMLElement>(".sl-sh-look").forEach((row) => {
        const id = row.dataset.lookFor!;
        if (!opts.live.nodes.get(id)) return;
        const on = looksOn(opts.live, id);
        const hasSegs = segmentationsOf(opts.live, id).length > 0;
        row.querySelectorAll<HTMLButtonElement>("[data-look]").forEach((b) => {
          const l = b.dataset.look as Look3D;
          const na = (l === "solid" || l === "surfaces") && !hasSegs;
          b.classList.toggle("sl-on", on.includes(l)); b.setAttribute("aria-pressed", String(on.includes(l)));
          b.classList.toggle("sl-sh-look-na", na); b.title = na ? NEEDS_SEG : LOOK_TIP[l];
        });
      });
    };
    const refresh = () => keepScroll(shEl, () => {
      // A SEQUENCE IS ONE ROW: its frames are hidden image nodes, and the row stands for the frame on
      // screen -- the view buttons act on that frame, the name is the sequence's, so five phases do
      // not become five rows and the row still does what an image row does.
      const current = currentFrames(opts.live);
      const frameOf = new Map<string, string>();   // sequence id -> its current member (frame, or the segmentation for it)
      for (const b of opts.live.nodes.values()) {
        if (b.type !== "sequenceBrowser") continue;
        const synced = (b.sequences as { sequence: string }[] | undefined) ?? [];
        const first = synced[0];
        const seq = first ? opts.live.nodes.get(first.sequence) : undefined;
        const items = (seq?.items as { node: string }[] | undefined) ?? [];
        const f = items[(b.selectedItemNumber as number | undefined) ?? 0];
        if (seq && f) frameOf.set(seq.id, f.node);
        for (let k = 1; k < synced.length; k++) { const m = companionItem(opts.live, b.id, k); if (m) frameOf.set(synced[k].sequence, m.node); }
      }
      const nodes = [...opts.live.nodes.values()]
        .filter((n) => DATA_TYPES.has(n.type as string) && !(n as { hidden?: boolean }).hidden)
        .map((n) => {
          if (n.type !== "sequence") return n;
          // Stand the current frame in for the sequence: its id drives the buttons, the name says
          // which sequence and which frame.
          const fid = frameOf.get(n.id);
          const frame = fid ? opts.live.nodes.get(fid) : undefined;
          return frame ? { ...frame, name: `${n.name} (${((n.items as unknown[] | undefined) ?? []).length} frames · ${current.get(fid!)?.split(" · ").pop() ?? ""})` } : n;
        });
      shEl.innerHTML = nodes.length ? ordered(nodes).map(({ node: n, depth }) => {
        const isLabelmap = n.type === "image" && (n as { labelmap?: boolean }).labelmap;
        const kind = isLabelmap ? "labelmap" : n.type;
        const detail = n.type === "image" ? ((n.dims as number[] | undefined)?.join("×") ?? "") : n.type === "markup" ? `${((n.controlPoints as unknown[] | undefined) ?? []).length} pts` : "";
        // The detail used to be its own column; it is now the tooltip, so the visible row is only
        // ever icon + name + a small cluster of view toggles -- what "not overloaded" meant as much
        // as the wrap did.
        const title = detail ? `${kind} — ${detail}` : String(kind);

        let controls: string;
        if (n.type === "image") {
          const views = SLICE_VIEWS.map((v) => {
            const on = shownIn(n, v.name);
            return `<button class="sl-sh-view${on ? "" : " sl-sh-view-off"}" data-view="${v.name}" style="--sl-vc:var(${v.token})" title="${on ? `Showing in ${v.name} — click to clear` : `Show in ${v.name}`}">${v.name[0]}</button>`;
          }).join("");
          // THE 3D BUTTON IS NOW THE "IN 3D" ROW UNDER THE VOLUME (lookRow below): one choice of four.
          controls = views;
        } else if (n.type === "segmentation") {
          const visible2D = n.visible !== false;
          const visible3D = (n.visible3D as boolean | undefined) ?? visible2D;
          controls = `<button class="sl-sh-order" data-up title="Draw this one under the one above it">▲</button>` +
            `<button class="sl-sh-order" data-down title="Draw this one over the one below it">▼</button>` +
            `<button class="sl-sh-view${visible2D ? "" : " sl-sh-view-off"}" data-vis2d title="2D (slices)">2D</button>` +
            `<button class="sl-sh-view sl-sh-view-3d${visible3D ? "" : " sl-sh-view-off"}" data-view3d title="3D">3D</button>`;
        } else {
          controls = `<button class="sl-sh-vis" data-vis="${n.id}" title="Show/hide">${(n.visible === false) ? "🚫" : "👁"}</button>`;
        }
        return `<div class="sl-sh-row${depth ? " sl-sh-child" : ""}" data-id="${n.id}"${(n as { sequence?: string }).sequence ? ` data-sequence="${(n as { sequence?: string }).sequence}"` : ""} title="${escapeHtml(title)}">` +
          `<span class="sl-sh-icon">${ICON[n.type as string] ?? "•"}</span>` +
          `<span class="sl-sh-name">${escapeHtml(n.name ?? n.id)}</span>` +
          `<span class="sl-sh-views">${controls}</span>` +
          // VISIBLE, not only on right-click. Ron, 2026-09-22: "the remove scene function is
          // completely hidden. This needs to get better." The × unloads it from this session; the
          // DICOM database is untouched, and unsaved work asks first.
          `<button class="sl-sh-remove" data-remove="${n.id}" title="Remove from the scene. Unloads it from this session; anything saved to the DICOM database stays there.">×</button>` +
          `</div>` + (n.type === "image" && !isLabelmap ? lookRow(n.id as string) : "");
      }).join("") : `<p class="sl-hint">No data yet — open a file or load sample data.</p>`;

      shEl.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = (b as HTMLElement).dataset.remove!;
        const n = opts.live.nodes.get(id);
        if (!n) return;
        const org = n.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string; local?: boolean } | undefined;
        const unsaved = n.type === "segmentation" && !(org?.savedSeriesInstanceUID || org?.seriesInstanceUID);
        if (unsaved) {
          const ok = await shell.confirm({ title: `Remove "${n.name}" from the scene?`, ok: "Remove", cancel: "Keep", destructive: true, body: `<p>It is not saved to the DICOM database. Removing it from the scene loses it, except for the temporary copy under AI Segmentations → Advanced → Recent results, if there is one.</p>` });
          if (!ok) return;
        }
        if (n.type === "image") removeVolumeFromScene(opts.live, id);
        else opts.live.write({ op: "del", id });
      }));
      shEl.querySelectorAll("[data-vis]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b as HTMLElement).dataset.vis!;
        const n = opts.live.nodes.get(id);
        opts.live.write({ op: "patch", id, path: "#/visible", value: n?.visible === false });
      }));
      shEl.querySelectorAll("[data-vis2d]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest(".sl-sh-row") as HTMLElement).dataset.id!;
        const n = opts.live.nodes.get(id);
        opts.live.write({ op: "patch", id, path: "#/visible", value: n?.visible === false });
      }));
      shEl.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest(".sl-sh-row") as HTMLElement).dataset.id!;
        const n = opts.live.nodes.get(id);
        if (!n) return;
        const view = b.dataset.view!;
        // Linked: every slice view follows the clicked one together.
        const targets = linkSlices ? SLICE_VIEWS.map((v) => v.name) : [view];
        const showing = shownIn(n, view);
        const role = roleOf(n);
        const hidden = new Set((n.hiddenViews as string[] | undefined) ?? []);
        for (const ln of targets) {
          if (showing) { hidden.add(ln); continue; }        // it is on here: clear the view
          hidden.delete(ln);                                 // it is off here: show it
          const c = compFor(ln);
          if (c && layerOf(ln, role) !== id) opts.live.write({ op: "patch", id: c.id, path: `#/refs/${role}`, value: [id] });
        }
        opts.live.write({ op: "patch", id, path: "#/hiddenViews", value: [...hidden] });
        refresh();   // sliceComposite is not a DATA_TYPES node, so its change would not refresh the rows
      }));
      // ▲▼: swap zOrder with the neighbor among this volume's segmentations. Both rows get an
      // explicit zOrder, so the swap holds whatever the arrival order was.
      shEl.querySelectorAll<HTMLButtonElement>("[data-up], [data-down]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest(".sl-sh-row") as HTMLElement).dataset.id!;
        const rows = ordered([...opts.live.nodes.values()].filter((n) => DATA_TYPES.has(n.type as string) && !(n as { hidden?: boolean }).hidden));
        const me = rows.findIndex((r) => r.node.id === id);
        const other = me + (b.hasAttribute("data-up") ? -1 : 1);
        if (me < 0 || other < 0 || other >= rows.length || rows[other].depth !== 1) return;   // the edge of this volume's list
        const a = rows[me].node, o = rows[other].node;
        const src = (n: MrsonNode) => ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
        if (src(a) !== src(o)) return;
        // Positions within the siblings, made explicit, then swapped.
        const sibs = rows.filter((r) => r.depth === 1 && src(r.node) === src(a)).map((r) => r.node);
        sibs.forEach((n, i) => { if (typeof n.zOrder !== "number") opts.live.write({ op: "patch", id: n.id as string, path: "#/zOrder", value: i }); });
        const za = sibs.indexOf(a), zo = sibs.indexOf(o);
        opts.live.write({ op: "patch", id: a.id as string, path: "#/zOrder", value: zo });
        opts.live.write({ op: "patch", id: o.id as string, path: "#/zOrder", value: za });
        refresh();
      }));
      shEl.querySelectorAll<HTMLButtonElement>("[data-view3d]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest(".sl-sh-row") as HTMLElement).dataset.id!;
        const n = opts.live.nodes.get(id);
        if (!n) return;
        // Only segmentation rows have a 3D button: a volume's 3D is the "In 3D" row.
        if (n.type === "segmentation") {
          const on = (n.visible3D as boolean | undefined) ?? (n.visible !== false);
          opts.live.write({ op: "patch", id, path: "#/visible3D", value: !on });
        }
        refresh();   // volumeRenderingDisplay is not a DATA_TYPES node, so its own change would not
      }));           // otherwise trigger the subscription below and this row would go stale.
      shEl.querySelectorAll<HTMLButtonElement>("[data-look]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = (b.closest(".sl-sh-look") as HTMLElement).dataset.lookFor!;
        const look = b.dataset.look as Look3D;
        if ((look === "solid" || look === "surfaces") && !segmentationsOf(opts.live, id).length) { status(NEEDS_SEG); return; }
        setLook3D(opts.live, id, look);
        refresh();
      }));

      shEl.querySelectorAll<HTMLElement>(".sl-sh-row").forEach((row) => {
        const id = row.dataset.id!;
        const nameEl = row.querySelector(".sl-sh-name") as HTMLElement;

        // Finder-style rename: double-click turns the name into a text field in place -- Enter or
        // clicking away commits, Escape reverts.
        nameEl.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          const current = (opts.live.nodes.get(id)?.name as string) ?? id;
          const input = document.createElement("input");
          input.className = "sl-sh-rename";
          input.value = current;
          nameEl.replaceWith(input);
          input.focus();
          input.select();
          const commit = () => {
            const val = input.value.trim();
            input.replaceWith(nameEl);
            if (val && val !== current) opts.live.write({ op: "patch", id, path: "#/name", value: val });
          };
          input.addEventListener("keydown", (ke) => {
            if (ke.key === "Enter") { ke.preventDefault(); commit(); }
            else if (ke.key === "Escape") { ke.preventDefault(); input.replaceWith(nameEl); }
          });
          input.addEventListener("blur", commit);
          input.addEventListener("click", (ce) => ce.stopPropagation());
        });

        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          shMenuTarget = id;
          shMenu.style.left = `${e.clientX}px`;
          shMenu.style.top = `${e.clientY}px`;
          shMenu.hidden = false;
        });
      });
    });
    // Also "volumeRenderingDisplay", not just DATA_TYPES: it drives every image row's 3D button, and
    // changes to it without this went unnoticed here -- silently, since the Volume Rendering module
    // auto-enables 3D on the first scalar volume that loads (its own feature, elsewhere), and its own
    // "Show in 3D" checkbox can also flip it. Either one left a row's 3D button showing stale state
    // until something else happened to trigger a refresh, which is what "the 3D toggle gets
    // confused with more than one grayscale" was: not the toggle lying, the indicator being stale.
    /**
     * A PLAYING SEQUENCE MUST NOT REBUILD THE LIST. Every frame step used to redraw the whole
     * hierarchy with innerHTML, at the playback rate -- and a click on a button that is replaced
     * between the press and the release never becomes a click. Ron, with the movie running: "the
     * scene panel seems non functional. I can click on 3d as much as I want." So a frame step, and
     * the volume-rendering display following it, only touch what changed: the sequence row's frame
     * (its id, its name) and the 3D buttons' state. Nothing under the pointer is replaced.
     */
    const updateInPlace = () => {
      const current = currentFrames(opts.live);
      const byFrame = new Map<string, string>();
      for (const b of opts.live.nodes.values()) {
        if (b.type !== "sequenceBrowser") continue;
        const first = ((b.sequences as { sequence: string }[] | undefined) ?? [])[0];
        const seq = first ? opts.live.nodes.get(first.sequence) : undefined;
        const items = (seq?.items as { node: string }[] | undefined) ?? [];
        const f = items[(b.selectedItemNumber as number | undefined) ?? 0];
        if (seq && f) byFrame.set(seq.id, f.node);
      }
      shEl.querySelectorAll<HTMLElement>(".sl-sh-row").forEach((row) => {
        const seqId = row.dataset.sequence;
        if (seqId) {
          const fid = byFrame.get(seqId);
          const seq = opts.live.nodes.get(seqId);
          if (fid && seq) {
            row.dataset.id = fid;
            const name = row.querySelector(".sl-sh-name");
            if (name) name.textContent = `${seq.name} (${((seq.items as unknown[] | undefined) ?? []).length} frames · ${current.get(fid)?.split(" · ").pop() ?? ""})`;
          }
        }
      });
      paintLooks();
    };
    // COALESCED TO ONE REBUILD PER FRAME. A sequence step writes several nodes at once (the
    // member leaving, the member arriving, per companion), and each write rebuilt the whole Scene
    // list -- eight times a step with two companions (critic, 2026-09-19, finding 3). One rebuild
    // on the next animation frame shows the same final state.
    let refreshQueued = false;
    const refreshSoon = () => {
      if (refreshQueued) return;
      refreshQueued = true;
      // A timer behind the frame: a hidden window runs no animation frames (see tf-editor renderSoon).
      let done = false;
      const go = () => { if (done) return; done = true; refreshQueued = false; refresh(); };
      requestAnimationFrame(go);
      setTimeout(go, 250);
    };
    opts.live.subscribe((c) => {
      if (c.type === "sequenceBrowser" || (c.type === "volumeRenderingDisplay" && c.kind !== "remove")) { updateInPlace(); return; }
      if (DATA_TYPES.has(c.type as string) || c.kind === "remove") refreshSoon();
    });
    refresh();
  } });

  // drag-and-drop over the views
  const target = opts.dropTarget ?? shell.main;
  const overlay = document.createElement("div");
  overlay.className = "sl-drop"; overlay.textContent = "Drop volume files to load"; overlay.hidden = true;
  target.appendChild(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  target.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; overlay.hidden = false; });
  target.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
  target.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.hidden = true; } });
  target.addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; overlay.hidden = true; void dropped(e.dataTransfer!); });
  /**
   * A DROPPED FOLDER. The first-time user drops the `.albula` folder itself, not the two files
   * inside it (critic, 2026-09-20, finding 19); `files` then holds one unreadable entry. The
   * directory API gives the folder's entries: the two scene files are picked out and the rest --
   * the DICOM tree, which Albula does not import -- is left to the README's instruction.
   */
  async function dropped(dt: DataTransfer): Promise<void> {
    const entries = Array.from(dt.items ?? []).map((it) => (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null);
    const dirs = entries.filter((en): en is FileSystemDirectoryEntry => !!en && en.isDirectory);
    if (!dirs.length) { await loadFiles(dt.files); return; }
    const picked: File[] = [];
    for (const dir of dirs) {
      const list = await new Promise<FileSystemEntry[]>((resolve) => dir.createReader().readEntries((r) => resolve(r), () => resolve([])));
      for (const en of list) {
        if (!en.isFile || !/^(scene\.mrson\.json|provenance\.json)$/i.test(en.name)) continue;
        const f = await new Promise<File | null>((resolve) => (en as FileSystemFileEntry).file((x) => resolve(x), () => resolve(null)));
        if (f) picked.push(f);
      }
    }
    if (picked.some((f) => /\.mrson\.json$/i.test(f.name))) { await loadFiles(picked); return; }
    // NOT A SCENE: a folder of scans (a disc, a stick). Every file in it, viewed and -- with "Also add to" ticked --
    // added to the database (Ron, 2026-10-01: "Drag and drop?").
    const all: File[] = [];
    const walk = async (dir: FileSystemDirectoryEntry) => {
      const reader = dir.createReader();
      for (;;) {   // readEntries answers in batches; an empty batch is the end
        const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries((r) => resolve(r), () => resolve([])));
        if (!batch.length) return;
        for (const en of batch) {
          if (en.name.startsWith(".")) continue;
          if (en.isDirectory) await walk(en as FileSystemDirectoryEntry);
          else { const f = await new Promise<File | null>((resolve) => (en as FileSystemFileEntry).file((x) => resolve(x), () => resolve(null))); if (f) all.push(f); }
        }
      }
    };
    for (const dir of dirs) await walk(dir);
    if (all.length && dicomFilesArrived) { await dicomFilesArrived(all); return; }
    shell.notify({ title: "Nothing to load in that folder", body: "It holds no files Albula can read." });
  }
  // programmatic entry for tests and the desktop shell
  /** Numeric oracle for parity tests: dims, ijkToRAS and the exact voxel sum of an image node (re-read from its chunks). */
  const volumeStats = async (imageId: string) => {
    const n = opts.live.nodes.get(imageId); if (!n || !n.zarr) throw new Error("no such image " + imageId);
    const zv = await fetchZarrVolumeNative(opts.live.blobBase(), n.zarr as ZarrDesc);
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < zv.data.length; i++) { const v = zv.data[i] as number; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; }
    return { dims: n.dims, ijkToRAS: n.ijkToRAS, sum, min: mn, max: mx, count: zv.data.length, dtype: (n.zarr as ZarrDesc).dtype };
  };
  Object.assign(globalThis, {
    __loadVolumeBytes: (bytes: Uint8Array, name: string) => loadBytes(bytes, name, "api"),
    __loadFiles: loadFiles,
    __loadSample: (name: string) => downloadSample(name).then((r) => loadBytes(r.bytes, r.dataset.fileName, "sampleData:" + name)),
    __volumeStats: volumeStats,
    // DICOM: index raw buffers -> pick a series -> load. Returns the series list (for tests/automation).
    __dcmjs: () => dicomLibraryForDebugging(),   // the raw library, for the console and harness/dicom.browser.test.ts
    __indexDicom: (buffers: ArrayBuffer[]) => indexFiles(buffers.map((b, i) => new File([b], "i" + i + ".dcm"))),
    __loadDicomSeries: async (buffers: ArrayBuffer[], which = 0) => {
      const entries = await indexFiles(buffers.map((b, i) => new File([b], "i" + i + ".dcm")));
      if (!entries[which]) throw new Error("no series " + which);
      const r = await loadVolumeIntoScene(opts.live, opts.store, loadEntry(entries[which]), { name: seriesLabel(entries[which]) });
      return { imageId: r.imageId, series: entries.map((e) => ({ uid: e.seriesInstanceUID, count: e.count, modality: e.modality })) };
    },
  });
}
