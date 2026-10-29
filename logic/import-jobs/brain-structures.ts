// THE BRAIN'S STRUCTURES WHEN A T1 IS ADDED (Ron, 2026-10-20: "yes" to running FastSurfer as part of adding a case, and
// to the MR shown as its brain, solid, when it is loaded). Measured on CON07's T1 the same morning: 45-48 s on this Mac's
// graphics card through haversack's command line, 68 s through the app -- past the minute a person waits, so it is done
// in the background, when the scan arrives, by the server's import-time jobs (desktop/extension-jobs.ts).
//
// What it makes is what the AI Segmentations panel makes and Save writes, from the same code: the server's answer read
// by logic/ai-result.ts (names, colors, the FreeSurfer numbering), coded by the catalog (logic/segment-naming.ts),
// written by logic/export-dicom-seg.ts, with the run's provenance; stored and indexed by the server's write route, under
// the T1 it was made from. A T1 that already has one (made here or saved from the panel) is left alone: what an earlier
// version made is kept (Ron, 2026-10-14, on reproducibility).
//
// The library; the program is desktop/brain-structures-job-main.ts.
import type { IndexSeries } from "../../desktop/series-files.ts";
import { seriesFilePaths } from "../../desktop/series-files.ts";
import type { ProvenanceEdge } from "../../desktop/db-index.ts";
import { parseInstances, volumesOfSeries } from "../readers/dicom-series.ts";
import type { Volume } from "../readers/nifti.ts";
import { writeNrrd } from "../writers/nrrd.ts";
import { runHaversackTask } from "../haversack-run.ts";
import { serverStatus } from "../haversack.ts";
import { restartSegmentationServer, startSegmentationServer } from "../brain-mask.ts";
import { runProvenanceOf, segmentationFromResult } from "../ai-result.ts";
import { codesFor } from "../segment-naming.ts";
import { segmentationToDicomSeg } from "../export-dicom-seg.ts";

import { BRAIN_JOB_KEY, BRAIN_JOB_VERSION, BRAIN_TASK, brainDescription, isBrainResult } from "./brain-structures-rule.ts";
export { BRAIN_JOB_KEY, BRAIN_JOB_VERSION, BRAIN_TASK, brainDescription };
// WHICH SCANS ARE A T1, AND WHICH T1 OF A STUDY FIRST: in the pure rule file, so the page's after-load rules
// (render/after-load.ts, version 3) choose the same T1 as this job does.
export { NOT_T1_IMAGE, studyOrder, T1_NAME, t1Candidates } from "./brain-structures-rule.ts";

/** A HEAD SCAN, by what its files say (Ron's main database holds abdominal "T1FS 3D BH" scans, BodyPartExamined ABDOMEN,
 *  which FastSurfer must not be given): BodyPartExamined HEAD / BRAIN / SKULL; or, where the files do not say, a study
 *  described as of the brain or head (Slicer's "BRAIN^ROUTINE"); not one described as of the body; else a study with a
 *  scan beside the T1 that is made of heads -- diffusion, a FLAIR, a T2, SWI, a time-of-flight angiogram (critic
 *  2026-10-20, finding 5: the main database's "Preop" study, a brain tumor case with 2D_AX_T2_FLAIR and 2D_AX_T2 and no
 *  body part, was skipped; and a liver study's DWI made it a head). */
export function isHeadScan(bodyPart: string, studyDescription: string, studyRows: IndexSeries[]): boolean {
  const bp = bodyPart.trim().toUpperCase();
  if (bp) return /^(HEAD|BRAIN|SKULL|HEADNECK|HEAD_NECK|NEURO)/.test(bp);
  if (/brain|head|neuro|cereb|skull/i.test(studyDescription)) return true;
  if (BODY_STUDY.test(studyDescription)) return false;
  return studyRows.some((r) => r.modality === "MR" && HEAD_SIGN.test(r.description));
}
/** A study described as of the body, not the head. */
const BODY_STUDY = /abdom|liver|hepat|pancrea|kidney|renal|pelvi|prostat|uterus|uterine|ovar|rectum|rectal|bowel|enterogr|chest|thora|lung|breast|cardi|heart|spine|spinal|lumbar|cervical|sacr|knee|\bhips?\b|shoulder|ankle|wrist|elbow|extremit|whole[\s_-]*body|mrcp|\bbody\b/i;
/** A series that is (almost always) of the head, beside a T1 of a study that does not say: diffusion, FLAIR, T2, SWI, TOF. */
const HEAD_SIGN = /dti|dwi|diffusion|dmri|flair|(^|[^a-z0-9])t2([^0-9]|$)|t2w|(^|[^a-z])swi([^a-z]|$)|swan|susceptib|(^|[^a-z])tof([^a-z]|$)/i;

/** The first file's BodyPartExamined and StudyDescription (only that file is read). */
export async function headFacts(dbDir: string, row: IndexSeries): Promise<{ bodyPart: string; studyDescription: string; images: number }> {
  const paths = await seriesFilePaths(dbDir, row.seriesUID);
  if (!paths.length) return { bodyPart: "", studyDescription: "", images: 0 };
  const b = await Deno.readFile(paths[0]);
  const [i] = await parseInstances([b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer], { headers: true });
  const json = (i?.header?.json ?? {}) as Record<string, { Value?: unknown[] }>;
  return { bodyPart: String(json["00180015"]?.Value?.[0] ?? ""), studyDescription: String(json["00081030"]?.Value?.[0] ?? ""), images: paths.length };
}

/** THE STUDY HAS ITS BRAIN when any series of it -- a crop of the T1 included (the studyforrest scan, too large for this
 *  Mac's card whole, was given its brain on a crop in September) -- has the brain's structures made from it. */
export function madeForStudy(studyUID: string, rows: IndexSeries[], edges: ProvenanceEdge[]): string | undefined {
  for (const r of rows) if (r.studyUID === studyUID) { const m = madeFor(r.seriesUID, rows, edges); if (m) return m; }
  return undefined;
}

/** The brain's structures already made for a T1 (by this job or saved from the panel): a SEG of this index made from it. */
export function madeFor(t1UID: string, rows: IndexSeries[], edges: ProvenanceEdge[]): string | undefined {
  const byUID = new Map(rows.map((r) => [r.seriesUID, r]));
  for (const e of edges) {
    if (e.parent !== t1UID || e.kind !== "algorithm") continue;
    const child = byUID.get(e.child);
    if (child && child.modality === "SEG" && isBrainResult(child.description)) return child.seriesUID;
  }
  return undefined;
}

/** THE GRID FASTSURFER WORKS ON, modeled as haversack follows it -- this version (the pinned `HAVERSACK_VERSION`; a
 *  test holds the two together), read in its source (engines/fastsurfer.py) and in FastSurfer 2.5.4's conform.py:
 *   - the voxel: the scan's finest, to 4 decimals, capped at 1 mm and snapped to 1 above 0.95 (FastSurfer's "min"), and
 *     RAISED TO 0.7 mm when finer (haversack's VOX_FLOOR_MM: FastSurferVINN is validated at 0.7-1.0 mm);
 *   - the cube ("auto"): 256 voxels a side at 1 mm; otherwise as many voxels of that size as cover the widest extent;
 *   - the 79-class field over the cube (2 bytes a value) on the graphics card, unless it passes one Metal buffer (8 GiB,
 *     MPS_MAX_BUFFER_BYTES) -- then haversack moves it to the Mac's memory: slower, the same result.
 *  So the size alone never refuses a scan (critic 2026-10-20, finding 4: the studyforrest T1, 274x384x384 voxels at
 *  0.700x0.667x0.667 mm, conforms to 366 voxels a side at 0.7 mm, not 384; why it failed twice is not known).
 *  Re-read for v0.16.0 (2026-10-26): engines/fastsurfer.py and FastSurferCNN (2.5.4+lean4) identical to v0.15.0's. */
export const CONFORM_FOLLOWS = "v0.16.0";
/** The largest cube FastSurfer is known to have worked on through this Mac's graphics card (voxels a side; 2026-10-20). */
export const LARGEST_CUBE_ON_CARD = 306;
const VOX_FLOOR_MM = 0.7, THRESHOLD_1MM = 0.95, CLASSES = 79, MPS_MAX_BUFFER_BYTES = 8 * 2 ** 30;
export function conformedGrid(v: Volume): { voxelMm: number; side: number; floored: boolean; fieldBytes: number; onHost: boolean } {
  const M = v.ijkToRAS, sp = [0, 1, 2].map((c) => Math.hypot(M[c], M[4 + c], M[8 + c]));
  let vox = Math.min(Math.round(Math.min(...sp) * 1e4) / 1e4, 1);
  if (vox > THRESHOLD_1MM) vox = 1;
  const floored = vox < VOX_FLOOR_MM;
  if (floored) vox = VOX_FLOOR_MM;
  // FastSurfer's own rounding: the voxel count to 4 decimals, then up.
  const side = Math.abs(vox - 1) <= 1 - THRESHOLD_1MM + 1e-5 ? 256
    : Math.max(...v.dims.map((d, i) => Math.ceil(Math.trunc(d * sp[i] / vox * 1e4) / 1e4)));
  const fieldBytes = side ** 3 * CLASSES * 2;
  return { voxelMm: vox, side, floored, fieldBytes, onHost: fieldBytes >= MPS_MAX_BUFFER_BYTES };
}

/** A 3D T1 FastSurfer can take: one volume (not a series in time), at least 100 slices each way, no voxel coarser than
 *  1.6 mm (a thick-slice scan has no cortex to find). Any size: haversack conforms it (`conformedGrid`). `why` completes
 *  "not run: ___"; `grid` says what FastSurfer will work on. */
export function takes(frames: Volume[]): { ok: true; grid: ReturnType<typeof conformedGrid> } | { ok: false; why: string } {
  if (frames.length !== 1) return { ok: false, why: `the series holds ${frames.length} volumes, not one 3D scan` };
  const v = frames[0], M = v.ijkToRAS;
  const sp = [0, 1, 2].map((c) => Math.hypot(M[c], M[4 + c], M[8 + c]));
  if (Math.min(...v.dims) < 100) return { ok: false, why: `${v.dims.join("×")} voxels: not a 3D scan of the whole brain` };
  if (Math.max(...sp) > 1.6) return { ok: false, why: `voxels of ${sp.map((s) => s.toFixed(1)).join("×")} mm: too coarse for the brain's structures` };
  const grid = conformedGrid(v);
  // THE CARD'S OWN LIMIT IS BELOW HAVERSACK'S 8 GiB RULE (critic 2026-10-20 night, finding 6): the studyforrest T1's
  // 366-voxel cube (3.87e9 values, 7.2 GiB) failed on the card with a class index no network gives
  // ("index 4528451009292753727 is out of bounds for dimension 0 with size 79"); the largest that worked is a 306-voxel
  // cube (2.26e9). Between the two the limit is not known, and a field just under it might come back wrong but in
  // range, so a cube past the largest known to work is not run on the card; a crop of the head works. The question is
  // Mike's (the workspace's Contents/docs/for-mike-2026-10-21-fastsurfer-mps.md).
  if (!grid.onHost && grid.side > LARGEST_CUBE_ON_CARD)
    return { ok: false, why: `FastSurfer would work on a ${grid.side}-voxel cube, larger than this Mac's graphics card is known to handle (${LARGEST_CUBE_ON_CARD}); a crop of the head works` };
  return { ok: true, grid };
}

/** A T1's files and its volume, read as the duckn copy writer reads them. */
export async function readT1(dbDir: string, row: IndexSeries): Promise<{ frames: Volume[]; buffers: ArrayBuffer[] }> {
  const paths = await seriesFilePaths(dbDir, row.seriesUID);
  if (!paths.length) throw new Error("no files in the index");
  if (paths.length > 2000) throw new Error(`${paths.length} files: not a T1 scan`);
  const buffers = await Promise.all(paths.map(async (p) => { const b = await Deno.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; }));
  const instances = await parseInstances(buffers, { headers: true });
  if (!instances.length) throw new Error(`none of its ${paths.length} files could be read as images`);
  return { frames: volumesOfSeries(instances).frames, buffers };
}

/** ONE RESTART OF THE SEGMENTATION SERVER IN A WHOLE RUN of the job, for whatever reason (critic 2026-10-20, findings 1
 *  and 9): a restart stops everything the server holds, and a run is many cases. */
let restartedThisRun = false;

export type BrainOutcome =
  | { state: "made"; seriesUID: string; structures: number; seconds: number; cached: boolean }
  | { state: "waiting" | "cannot" | "failed"; why: string; /** A fault of this scan, not of the moment: remembered, so the
      next start does not try it again under the same rules (critic 2026-10-20, finding 9). */ remember?: true };

/** WAIT WHILE THE PAGE HOLDS THE GRAPHICS CARD (POST /_jobs/hold; the server's `held` in GET /_jobs), saying so once:
 *  asked before each case, so a run of many cases does not go on beside the person's work on the card (critic
 *  2026-10-20, finding 13). An unreadable answer does not hold: the run is not stopped by a server that went. */
export async function waitWhileHeld(server: string, onWait?: (line: string) => void, pollMs = 5000, fetchFn: typeof fetch = fetch): Promise<void> {
  let said = false;
  for (;;) {
    const s = await fetchFn(`${server.replace(/\/+$/, "")}/_jobs`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { held?: boolean } | null;
    if (!s?.held) return;
    if (!said) { onWait?.("waiting: the graphics card is in use in the window; the next scan starts when it is free"); said = true; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** haversack's version as the server reports it, asked once a run (its FastSurfer results do not carry it). */
let haversackVersion: string | undefined;

/** Run the network on one T1 and store its result in the database, under the T1. `albula`: the core's version the
 *  server handed the job (`--core-version`), for the SEG's provenance. */
export async function makeBrainStructures(server: string, dbId: string, row: IndexSeries, t1: { frames: Volume[]; buffers: ArrayBuffer[] }, onProgress?: (line: string) => void, albula?: string): Promise<BrainOutcome> {
  const root = server.replace(/\/+$/, "");
  const transport = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a), base: `${root}/_haversack/` };
  const toRoot = { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(typeof input === "string" && input.startsWith("/") ? `${root}${input}` : input, init), base: transport.base };
  const volume = t1.frames[0];
  // gzip INSIDE the NRRD, as the page sends it (logic/export.ts); haversack's reader does not take ".nrrd.gz".
  const run = () => runHaversackTask({ task: BRAIN_TASK, what: "finding the brain's structures", transport, onProgress,
    upload: async () => ({ bytes: await writeNrrd(volume, { encoding: "gzip" }), filename: "t1.nrrd" }) });
  let r = await run();
  // The server not running: started (the diffusion job's rule, import-job.ts brainOnT1).
  if (!r.ok && r.reason === "no-server") { onProgress?.("starting the segmentation server"); if ((await startSegmentationServer(onProgress, toRoot)).ok) r = await run(); }
  // STUCK (the server answers and runs nothing else: haversack-run.ts) or FAILED: restarted ONCE IN A WHOLE RUN of the
  // job, stuck and failed together, and the case tried again -- this morning's failure from a server up 24 h went away
  // with a restart, but a scan the network cannot take fails every time (the studyforrest T1, 2026-10-20), and a restart
  // for each such scan stops whatever else the server was doing for nothing. A later case that meets the same ends
  // "waiting" (stuck) or "failed", and says why.
  if (!r.ok && (r.reason === "stuck" || r.reason === "failed") && !restartedThisRun) {
    restartedThisRun = true;
    onProgress?.("restarting the segmentation server");
    if ((await restartSegmentationServer(onProgress, toRoot)).ok) r = await run();
  }
  if (!r.ok) return { state: r.reason === "no-task" ? "cannot" : r.reason === "failed" ? "failed" : "waiting", why: r.message, ...(r.ranAndFailed ? { remember: true as const } : {}) };
  haversackVersion ??= (await serverStatus(transport).catch(() => undefined))?.version;
  const seg = await segmentationFromResult(BRAIN_TASK, r.bytes);
  if (!seg.ok) return { state: "failed", why: `the answer could not be read: ${seg.why}`, remember: true };
  if (seg.dims.join() !== volume.dims.join()) return { state: "failed", why: `the answer came back on a ${seg.dims.join("×")} grid, not the scan's ${volume.dims.join("×")}`, remember: true };
  onProgress?.("writing the segmentation");
  // CODED BY THE STRUCTURE'S KEY, which the result knows from FreeSurfer's label value: three display names live in two
  // catalogs ("Third ventricle", "Fourth ventricle", "Brainstem" are TotalSegmentator's too), and a name a correction
  // changed ("Cavum septi pellucidi") finds nothing (critic 2026-10-20, finding 6).
  const segments = seg.segments.map((sg) => ({ labelValue: sg.labelValue, name: sg.name, color: sg.color, ...codesFor(sg.structure ?? sg.name) }));
  const out = await segmentationToDicomSeg(seg.labels, seg.dims, segments, t1.buffers, {
    seriesDescription: brainDescription(row.description), algorithmName: BRAIN_TASK, algorithmType: "AUTOMATIC",
    // THE IMAGES OF THIS VOLUME, slice by slice (a series can hold several; a multi-frame file holds them as frames).
    sopInstanceUIDs: volume.meta?.sopInstanceUIDs as string[] | undefined, frameNumbers: volume.meta?.frameNumbers as number[] | undefined,
    // WHAT MADE IT (critic 2026-10-20, finding 3): haversack's version, FastSurfer's release, Albula's commit, these rules;
    // the code table is named by the writer (codeTablesFor).
    run: runProvenanceOf(BRAIN_TASK, r.job, r.job.id, { haversack: haversackVersion, albula, rules: `brain-structures v${BRAIN_JOB_VERSION}`, weights: r.weights }),
  });
  const res = await fetch(`${root}/_db/${encodeURIComponent(dbId)}/_write/${encodeURIComponent(out.filename)}`, {
    method: "POST", body: out.bytes as unknown as BodyInit,
    headers: { "content-type": "application/dicom", "x-albula-index": encodeURIComponent(JSON.stringify(out.index)), "x-albula-job": "brain-structures" },
  }).catch(() => null);
  if (!res?.ok) return { state: "failed", why: `the server did not store the segmentation (${res?.status ?? "no answer"})` };
  return { state: "made", seriesUID: out.seriesInstanceUID, structures: out.segments, seconds: r.seconds, cached: r.cached };
}
