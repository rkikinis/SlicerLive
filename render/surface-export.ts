// SURFACE MODELS, MADE ON DEMAND WHEN SAVING, AND NOTHING KEPT.
//
// Ron, 2026-10-21 (option B): "Generate Surface Models" was stale for display -- the anatomy is drawn solid from the
// labels by ray casting (Contents/docs/SOLID-LOOK.md), surface models had been behind a firewall since 2026-09-24
// and no database held any. So the module, the Surfaces look and the drawing of surface models are gone, and surface
// models stay ONLY AS AN EXPORT: Save › Files offers, for every segmentation, "STL (surfaces)", "OBJ (surfaces, named
// and colored)" (and until 2026-10-22 "DICOM surfaces (into the database)", removed: only segmentations go into the
// database). Each click makes them here, writes them, and lets go.
//
// The extraction is the one that has always run (algorithms/surface-nets.ts, in its worker, so the window keeps
// drawing: 2.5 s on a brain, about 15-17 s on a whole-body CT, measured 2026-09). The labels come from the graphics
// card (SegmentationDisplayableManager.readLabelmap, through the page hook `__segmentationLabels`), which holds the
// only copy and the one on screen, Segment Editor edits included. The working banner says what is being made and
// counts the scan's slices; Stop ends the worker and nothing is saved.
//
// Pure of the DOM: the hook and the worker are injectable, so render/surface-export.test.ts runs the real worker in
// Deno against a small labelmap.

import type { LiveScene } from "./livescene.ts";
import { mergedColours, type MergedGroup } from "./livescene.ts";
import { BUILD_ID, workerUrl } from "./build-id.ts";
import { sizeClass, startWork } from "./working.ts";
import type { LabelMesh } from "../algorithms/surface-nets.ts";
import type { NetsProgress, NetsReply, NetsRequest } from "../algorithms/surface-nets-worker.ts";
import { objHead, plainFileStem, stlHead, surfaceFileName } from "../logic/writers/surface-files.ts";
import { padLabels } from "../algorithms/close-labels.ts";

export type SurfaceFileFormat = "stl" | "obj";

/** One structure of a segmentation, as the node lists it. */
export interface ExportSegment { labelValue: number; name?: string; color?: number[]; visible?: boolean }

/** The labels of a segmentation and their grid, or null when it is not on the card. */
export type LabelReader = (segId: string, opts?: { pad?: boolean }) => Promise<{ labels: Uint8Array; dims: [number, number, number]; ijkToRAS: number[]; /** read back inside one voxel of background */ padded?: boolean } | null>;

const pageLabels: LabelReader = (segId) => {
  const g = globalThis as unknown as { __segmentationLabels?: LabelReader };
  if (!g.__segmentationLabels) return Promise.reject(new Error("this window cannot read a segmentation's labels"));
  return g.__segmentationLabels(segId);
};
const pageWorker = () => new Worker(workerUrl("./surface-nets-worker.js"), { type: "module" });

/**
 * WHICH STRUCTURES GO INTO A FILE: the ones shown (the eye in Segmentations), or all of them when none is shown --
 * a file of nothing is never what was meant. Labels outside 1..255 are not structures of a label map.
 */
export function structuresToExport(segments: readonly ExportSegment[]): ExportSegment[] {
  const all = segments.filter((s) => s.labelValue > 0 && s.labelValue < 256);
  const shown = all.filter((s) => s.visible !== false && ((s as { opacity?: number }).opacity ?? 1) > 0);   // opacity 0 is not shown (critic 2026-10-22, finding 6)
  return shown.length ? shown : all;
}

/** What the export is made of: the meshes (RAS millimeters, as the extraction gives them) and their structures --
 *  or, when a file was asked for, the file's chunks instead of the meshes. */
export interface MadeSurfaces {
  meshes: LabelMesh[];
  file?: { chunks: Uint8Array[]; structures: number; triangles: number; vertices: number };
  /** The structures asked for, by label; a structure with no voxels has no mesh. */
  structures: ExportSegment[];
  ms: number;
}

/**
 * MAKE THE SURFACES of one segmentation: the structures given (by default, the ones shown), with the extraction
 * worker, saying so on the working banner. Rejects with a plain sentence when it cannot, or when Stop was pressed.
 */
export async function makeSurfaces(
  live: LiveScene,
  segId: string,
  status: (m: string) => void = () => {},
  o: { structures?: ExportSegment[]; readLabels?: LabelReader; makeWorker?: () => Worker; file?: NetsRequest["file"]; /** caps where the scan cuts a structure off */ closed?: boolean } = {},
): Promise<MadeSurfaces> {
  // ONE AT A TIME (critic 2026-10-21, surfaces export, finding 6): each export reads its own copy of the labels (418 MB
  // for a whole body) and runs its own extraction. The drawing path had this rule; it went with it and is back here.
  const before = lane;
  let release!: () => void;
  lane = new Promise<void>((r) => { release = r; });
  inLine++;
  try {
    if (inLine > 1) status("waiting for the surfaces already being made to finish");
    await before;
    return await makeSurfacesNow(live, segId, status, o);
  } finally { inLine--; release(); }
}
let lane: Promise<void> = Promise.resolve();
let inLine = 0;   // exports asked for and not finished, this one included

async function makeSurfacesNow(
  live: LiveScene,
  segId: string,
  status: (m: string) => void,
  o: { structures?: ExportSegment[]; readLabels?: LabelReader; makeWorker?: () => Worker; file?: NetsRequest["file"]; closed?: boolean },
): Promise<MadeSurfaces> {
  const node = live.nodes.get(segId);
  if (!node || node.type !== "segmentation") throw new Error("there is no such segmentation in the scene");
  const name = String(node.name ?? "the segmentation");
  const structures = o.structures ?? structuresToExport((node.segments as ExportSegment[] | undefined) ?? []);
  if (!structures.length) throw new Error(`"${name}" has no structures to make surfaces of`);
  const dims0 = (node.dims as number[] | undefined) ?? [];
  // STOP, whenever it is pressed: before the worker runs, the labels are dropped when they arrive; after, the worker ends.
  let stopped = false;
  let stopWorker: (() => void) | undefined;
  const work = startWork({
    title: `Making the surfaces of ${name}`,
    unit: "slices",                                      // the worker counts the scan's planes (surface-nets.ts)
    timeKey: `export:surfaces:${sizeClass(dims0.reduce((a, b) => a * b, 1))}`,
    stop: () => { stopped = true; stopWorker?.(); },
    stopTitle: "Stop making the surfaces; nothing is saved",
  });
  let ok = false;
  try {
    status(`making the surfaces of ${name} — reading its labels`);
    // CLOSED, FOR 3D PRINTING: the labels inside one voxel of background (algorithms/close-labels.ts) -- read back that
    // way from the card at no cost; a reader that cannot pads them here.
    const read = await (o.readLabels ?? pageLabels)(segId, o.closed ? { pad: true } : undefined);
    const padded = read && o.closed && !read.padded ? padLabels(read.labels, read.dims, read.ijkToRAS) : null;
    const got = padded ? { labels: padded.lab, dims: padded.dims, ijkToRAS: padded.ijkToRAS } : read;
    if (stopped) throw new Error("stopped; nothing was saved");
    if (!got) throw new Error(`"${name}" is not loaded on the graphics card yet; try again in a moment`);
    const t0 = performance.now();
    let file: MadeSurfaces["file"];
    const meshes = await new Promise<LabelMesh[]>((resolve, reject) => {
      const worker = (o.makeWorker ?? pageWorker)();
      let settled = false;
      const end = (f: () => void) => { if (settled) return; settled = true; worker.terminate(); f(); };
      stopWorker = () => end(() => reject(new Error("stopped; nothing was saved")));
      worker.onmessage = (e: MessageEvent<NetsReply | NetsProgress>) => {
        if ("progress" in e.data) {
          const { done, total } = e.data.progress;
          // Every slice counted, the rest (smoothing, normals) is not: a moving bar, not a full one for seconds
          // (critic 2026-10-17, finding 8, on the same count when this was the drawing path).
          if (done >= total) work.uncounted(); else work.step(done, total);
          status(`making the surfaces of ${name} — ${Math.round(100 * done / total)}%`);
          return;
        }
        const r = e.data;
        // A WORKER FROM ANOTHER BUILD (a cached one under a fresh page) would make the files with old code and not say
        // so (critic 2026-10-21, finding 11): refused, with what to do. A worker that reports no build (a test) is not.
        if (r.build && BUILD_ID && r.build !== BUILD_ID) {
          end(() => reject(new Error(`the surface worker is from another build (${r.build}, this window is ${BUILD_ID}); reload the window and save again`)));
          return;
        }
        if (r.file) file = { chunks: r.file.chunks.map((b) => new Uint8Array(b)), structures: r.file.structures, triangles: r.file.triangles, vertices: r.file.vertices };
        end(() => resolve(r.meshes.map((m) => ({
          label: m.label, positions: new Float32Array(m.positions), normals: new Float32Array(m.normals), indices: new Uint32Array(m.indices),
        }))));
      };
      worker.onerror = (ev: ErrorEvent) => { ev.preventDefault?.(); end(() => reject(new Error(`the surfaces could not be made: ${ev.message || "the worker failed"}`))); };
      // TRANSFERRED, not copied: the read-back is this call's own array, and a whole-body labelmap is 418 MB.
      const lab = got.labels.byteOffset === 0 && got.labels.byteLength === got.labels.buffer.byteLength ? got.labels : got.labels.slice();
      const msg: NetsRequest = {
        id: 1, lab: lab.buffer as ArrayBuffer, dims: got.dims, ijkToRAS: got.ijkToRAS,
        // `only` crosses as an array (surface-nets-worker.ts makes the Set).
        opts: { only: structures.map((s) => s.labelValue) as unknown as Set<number> },
        ...(o.file ? { file: o.file } : {}),
      };
      worker.postMessage(msg, [lab.buffer as ArrayBuffer]);
    });
    const ms = performance.now() - t0;
    ok = true;
    return { meshes, structures, ms, ...(file ? { file } : {}) };
  } finally {
    work.done(ok);
  }
}

/** A structure's color as the views show it: a folded branch's color (Segmentations' tree) first, then its own. */
function colorOf(s: ExportSegment, merged: Map<number, number[]>): number[] | undefined {
  return merged.get(s.labelValue) ?? s.color;
}

/**
 * THE FILE: STL (the structures shown, as one surface set, the header naming the segmentation) or OBJ (one named,
 * colored object per structure). Coordinates in LPS millimeters (logic/writers/surface-files.ts). Returned as chunks
 * for `new Blob(chunks)`; the meshes are not kept.
 */
/** What a closed file says, in words (the status line and the save's note). */
const closedNote = (closed: boolean | undefined) => closed ? " · closed where the scan cuts a structure off" : "";

/**
 * THE FILE OF ONE SEGMENTATION: STL (the structures shown, as one surface set, the header naming the segmentation) or
 * OBJ (one named, colored object per structure). Coordinates in LPS millimeters (logic/writers/surface-files.ts).
 * `closed` (ticked by default in Save › Files; Ron, 2026-10-22, "Caps only"): caps where the scan cuts a structure off
 * (algorithms/close-labels.ts).
 */
export async function surfaceFile(
  live: LiveScene,
  segId: string,
  format: SurfaceFileFormat,
  status: (m: string) => void = () => {},
  o: { readLabels?: LabelReader; makeWorker?: () => Worker; closed?: boolean } = {},
): Promise<{ chunks: Uint8Array[]; filename: string; mime: string; size: number; note: string }> {
  const node = live.nodes.get(segId);
  const segName = String(node?.name ?? "Segmentation");
  const part = await segmentationPart(live, segId, format, status, o, null, segName);
  if (!part) throw new Error(`"${segName}" has no voxels in the structures shown, so there are no surfaces to save`);
  const chunks = [format === "stl" ? stlHead(segName, part.triangles) : objHead(segName), ...part.chunks];
  return {
    chunks,
    filename: surfaceFileName(segName, format),
    mime: format === "stl" ? "model/stl" : "model/obj",
    size: chunks.reduce((n, c) => n + c.byteLength, 0),
    note: `${part.structures} ${part.structures === 1 ? "structure" : "structures"}, ${part.triangles.toLocaleString()} triangles, made in ${(part.ms / 1000).toFixed(1)} s${closedNote(o.closed)}`,
  };
}

/** One segmentation's structures shown, as a part of a file (no header): its chunks and what is in them. */
async function segmentationPart(
  live: LiveScene, segId: string, format: SurfaceFileFormat, status: (m: string) => void,
  o: { readLabels?: LabelReader; makeWorker?: () => Worker; closed?: boolean }, prefix: string | null, fileName: string, vertexOffset = 0,
) {
  const node = live.nodes.get(segId);
  const merged = mergedColours((node as { mergedGroups?: MergedGroup[] } | undefined)?.mergedGroups);
  const chosen = structuresToExport(((node as { segments?: ExportSegment[] } | undefined)?.segments) ?? []);
  if (!chosen.length) return null;
  // The file is written in the worker, inside the working banner (finding 5): names and colors go with the request.
  const made = await makeSurfaces(live, segId, status, { readLabels: o.readLabels, makeWorker: o.makeWorker, structures: chosen, closed: o.closed, file: {
    format, name: fileName, part: { vertexOffset },
    structures: chosen.map((s) => {
      const nm = s.name ?? `Segment ${s.labelValue}`;
      return { label: s.labelValue, name: prefix ? `${prefix} · ${nm}` : nm, ...(colorOf(s, merged) ? { color: colorOf(s, merged) } : {}) };
    }),
  } });
  const f = made.file;
  if (!f || !f.structures) return null;
  return { chunks: f.chunks, structures: f.structures, triangles: f.triangles, vertices: f.vertices, ms: made.ms };
}

/**
 * EVERYTHING SHOWN IN 3D, ONE FILE (Ron, 2026-10-22: "offer both"; the mockup surface-export-2026-10-22.html): the
 * structures shown of every segmentation given, one after the other, in one STL or one OBJ. In the OBJ each structure
 * is named "segmentation · structure". Each segmentation is made in turn (one at a time, its own banner); the file
 * holds them all, in the order given.
 */
export async function sceneSurfaceFile(
  live: LiveScene,
  segIds: readonly string[],
  format: SurfaceFileFormat,
  status: (m: string) => void = () => {},
  o: { readLabels?: LabelReader; makeWorker?: () => Worker; closed?: boolean; name?: string } = {},
): Promise<{ chunks: Uint8Array[]; filename: string; mime: string; size: number; note: string }> {
  if (!segIds.length) throw new Error("nothing is shown in 3D: show a segmentation in 3D first");
  const name = o.name ?? "Everything shown in 3D";
  const chunks: Uint8Array[] = [];
  let triangles = 0, vertices = 0, structures = 0, ms = 0, parts = 0;
  for (const id of segIds) {
    const segName = String(live.nodes.get(id)?.name ?? "Segmentation");
    const part = await segmentationPart(live, id, format, status, o, segName, name, vertices);
    if (!part) continue;
    chunks.push(...part.chunks);
    triangles += part.triangles; vertices += part.vertices; structures += part.structures; ms += part.ms; parts++;
  }
  if (!parts) throw new Error("the segmentations shown in 3D have no voxels in the structures shown, so there are no surfaces to save");
  chunks.unshift(format === "stl" ? stlHead(name, triangles) : objHead(name));
  return {
    chunks,
    filename: `${plainFileStem(name)}.surfaces.${format}`,
    mime: format === "stl" ? "model/stl" : "model/obj",
    size: chunks.reduce((n, c) => n + c.byteLength, 0),
    note: `${parts} segmentation${parts === 1 ? "" : "s"}, ${structures} structures, ${triangles.toLocaleString()} triangles, made in ${(ms / 1000).toFixed(1)} s${closedNote(o.closed)}`,
  };
}
