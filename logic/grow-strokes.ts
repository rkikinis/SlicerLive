// WHAT THE PERSON PAINTED, KEPT APART FROM WHAT GROW FROM SEEDS MADE (critic 2026-11-06, findings 1, 2, 3, 8, 9, 11).
//
// Grow writes its result into the same label the strokes are painted in, so the label cannot say which voxels are strokes.
// Slicer keeps its seeds apart until Apply (AbstractScriptedSegmentEditorAutoCompleteEffect.py, onApply). Here the record
// is kept beside the label map: a list of what each stroke touched, by voxel index, looked up BY THE STATE OF THE LABEL MAP
// (its zarr description), so Undo and Redo, which put an earlier description back, get the record that belonged to it
// with nothing to tell them. Effects that change the labels without painting (Margin, Smoothing, a tool's result) carry
// the record to their new state.
//
// Kept in the page only: a saved segmentation holds no strokes. Opened again, the structure as saved counts as strokes
// (the Grow tool's cheatsheet says so). Sparse on purpose: a list of voxels for each stroke, shared between states, not a
// copy of the grid per state or per structure ("A copy of the data is held only while something is reading it").

export interface StrokeChunk {
  /** The structure painted or erased. */
  label: number;
  erase: boolean;
  /** The voxels the stroke touched, in order of index. */
  at: Uint32Array;
  /** The structure being grown when this was painted: says which structure a stroke of Outside belongs to. */
  forStructure?: number;
}

export interface StrokeRecord {
  chunks: readonly StrokeChunk[];
  /** The structures Grow has written into: the rest of their label is its result, not strokes. */
  grown: ReadonlySet<number>;
}

export const NO_STROKES: StrokeRecord = { chunks: [], grown: new Set() };

/** More states than Undo's 40 steps can reach: one step is several states, since a stroke is written on a throttle. */
const MAX_STATES = 400;
const bySeg = new Map<string, Map<string, StrokeRecord>>();

const keyOf = (zarr: unknown): string => JSON.stringify(zarr);

/** The record of the label map's state `zarr`; undefined when nothing is known of that state (opened from a file, a reload). */
export function strokesAt(segId: string, zarr: unknown): StrokeRecord | undefined {
  return bySeg.get(segId)?.get(keyOf(zarr));
}

export function rememberStrokes(segId: string, zarr: unknown, record: StrokeRecord): void {
  let states = bySeg.get(segId);
  if (!states) bySeg.set(segId, states = new Map());
  const key = keyOf(zarr);
  states.delete(key);        // to the end of the order: the oldest goes first
  states.set(key, record);
  if (states.size > MAX_STATES) states.delete(states.keys().next().value!);
}

/** An effect changed the labels without painting: the new state has the same strokes. */
export function carryStrokes(segId: string, from: unknown, to: unknown): void {
  const record = strokesAt(segId, from);
  if (record) rememberStrokes(segId, to, record);
}

/** The segmentation is gone. */
export function forgetStrokes(segId: string): void { bySeg.delete(segId); }

export function withChunks(record: StrokeRecord, chunks: readonly StrokeChunk[]): StrokeRecord {
  return chunks.length ? { chunks: [...record.chunks, ...chunks], grown: record.grown } : record;
}

export function withGrown(record: StrokeRecord, target: number): StrokeRecord {
  return record.grown.has(target) ? record : { chunks: record.chunks, grown: new Set([...record.grown, target]) };
}

/** The voxels marked in `mark` (one byte per voxel), as a chunk. */
export function chunkOfMark(mark: Uint8Array, label: number, erase: boolean, forStructure?: number): StrokeChunk | null {
  let n = 0;
  for (let i = 0; i < mark.length; i++) if (mark[i]) n++;
  if (!n) return null;
  const at = new Uint32Array(n);
  for (let i = 0, k = 0; i < mark.length; i++) if (mark[i]) at[k++] = i;
  return { label, erase, at, forStructure };
}

/**
 * The voxels that are strokes of `target` now, the chunks replayed in order: its own erasing takes a voxel out, and painting
 * another structure over it does too. Erasing another structure leaves it, since the Erase tool takes away only the
 * structure chosen.
 */
export function strokesOf(record: StrokeRecord, target: number): Uint32Array {
  const on = new Set<number>();
  for (const c of record.chunks) {
    if (c.label === target) { if (c.erase) for (const at of c.at) on.delete(at); else for (const at of c.at) on.add(at); }
    else if (!c.erase) for (const at of c.at) on.delete(at);
  }
  return Uint32Array.from(on);
}

/** Outside's strokes painted while growing `target`: undefined when no stroke of Outside is on record at all. */
export function outsideStrokesFor(record: StrokeRecord, rejection: ReadonlySet<number>, target: number): Uint32Array | undefined {
  const mine = new Set<number>();
  let any = false;
  for (const c of record.chunks) {
    if (!rejection.has(c.label)) continue;
    any = true;
    if (c.erase) for (const at of c.at) mine.delete(at);
    else if (c.forStructure === target) for (const at of c.at) mine.add(at);
  }
  return any ? Uint32Array.from(mine) : undefined;
}

/** Which structure the strokes of Outside belong to just now, per segmentation: set by the Grow tool, the one writer. */
const growing = new Map<string, number>();
export function setGrowing(segId: string, structure: number | undefined): void {
  if (structure === undefined) growing.delete(segId); else growing.set(segId, structure);
}
export function growingOf(segId: string): number | undefined { return growing.get(segId); }
