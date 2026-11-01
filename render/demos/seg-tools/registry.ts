// THE SEGMENT EDITOR'S TOOLS AS PIECES (Ron, 2026-10-30, on the architecture comparison: Slicer's structure, "Good start
// point"; the shape "yes": tool buttons in one row, only the chosen tool's controls under them, "Paint … over …" on top).
// Each tool brings its button, its controls, its help and its own remembered values; the editor (render/demos/
// seg-editor-panel.ts) shows the row, the chosen tool's area, and gives the tool what it acts on through SegToolContext.
// One list, which the editor's own tools join and which an extension can join later (through the SDK, not yet exported).
import type { LiveScene } from "../../livescene.ts";
import type { LocalBlobStore } from "../../../logic/ingest.ts";
import type { OverwriteMode } from "../../../logic/segment-effects.ts";

/** A tool's edit in progress, shown before it is written: one per segmentation, owned by the editor (undo, Cancel). */
export interface EditSession {
  /** The segmentation's labels as they were before the tool began (its first call begins the session). */
  begin(): Promise<Uint8Array | null>;
  /** Show these labels in the views, as they would be written (not an edit yet; no undo step). */
  show(labels: Uint8Array): Promise<void>;
  /** Write them as an edit: one undo step back to how it was before begin(). */
  commit(labels: Uint8Array): Promise<void>;
  /** Put the segmentation back as it was before begin(). */
  cancel(): void;
  /** Whether something is shown and not written. */
  open(): boolean;
}

export interface SegToolContext {
  live: LiveScene;
  store: LocalBlobStore;
  /** The segmentation the tools change; "" when none is chosen. */
  segId(): string;
  /** The structure painted: its label value, name and color (0..1). */
  structure(): { labelValue: number; name: string; color: number[] };
  /** What a tool may write over (the "over" picker) and which structures are shown (for "visible structures"). */
  over(): { overwrite: OverwriteMode; visibleSegments: number[]; overSegment?: number };
  /** The scan the segmentation was drawn on. */
  source(): { id: string; node: Record<string, unknown> } | null;
  edits: EditSession;
  /** Ask the views for clicks (the tool's pick()), or give them back. */
  takeClicks(on: boolean): void;
  status(s: string): void;
  /** Draw the editor again (the tool's area included). */
  rerender(): void;
}

export type ToolStroke = { kind: "slice"; points: [number, number, number][]; normal: [number, number, number] } | { kind: "3d"; points: [number, number][]; vp: Float32Array };

/** One line of a tool's cheatsheet: the mouse or key action, what it does in a few words, and a tooltip in plain words. */
export interface CheatLine { keys: string; does: string; tip: string; }

export interface SegTool {
  id: string;
  /** The button's word and symbol; the tooltip says what it does. */
  label: string; icon: string; tip: string;
  /** Place in the row. */
  order: number;
  /** A single letter that chooses it when no text field has the focus, or none. */
  shortcut?: string;
  /** Pressed in the row (or by its letter). */
  chosen?(ctx: SegToolContext): void | Promise<void>;
  /** Fill the tool's area under the row; called on every redraw while it is chosen, so it draws from its own state. */
  mount(el: HTMLElement, ctx: SegToolContext): void;
  /** Another tool was chosen or the segmentation changed. `keep`: write what the tool shows (Ron, 2026-10-30: a threshold,
   *  a click, then Scissors -- "the entire segmentation disappearing": leaving had thrown the preview away); false only for
   *  Undo while a preview is shown, which drops it as Cancel does. */
  left?(ctx: SegToolContext, keep: boolean): void | Promise<void>;
  /** The structure or the "over" choice changed while it is chosen. */
  retarget?(ctx: SegToolContext): void;
  /** A click in a view while it takes clicks. A click keeps the piece under it; Shift-click (sign -1) keeps one more;
   *  Option-click (`remove`) removes the piece under it (Ron, 2026-10-30: "so click means keep in all effects"; "yes,
   *  option-click removes"). */
  pick?(ras: [number, number, number], sign: 1 | -1, ctx: SegToolContext, remove?: boolean): void;
  /** An outline drawn on a view while it takes clicks (Scissors): on a slice, its points in the scanner's coordinates and
   *  the slice's normal; on the 3D view, its points as fractions of the view (u right, v down) and the camera's matrix
   *  from the world to the view (column-major). Shift held at the release gives sign -1. */
  stroke?(stroke: ToolStroke, sign: 1 | -1, ctx: SegToolContext): void;
  /** THE TOOL'S CHEATSHEET (Ron, 2026-10-31: "we should have cheatsheets in every effect to remind the user of
   *  modifiers, with tool tips explaining in layperson's terms"): shown by the editor under the tool's controls, the same
   *  way in every tool. */
  cheats?(ctx: SegToolContext): CheatLine[];
  /** A key while it is chosen and no text field has the focus; true when it used the key. */
  onKey?(e: KeyboardEvent, ctx: SegToolContext): boolean;
}

const tools = new Map<string, SegTool>();
/** Add a tool to the editor's row (a second with the same id replaces the first). */
export function registerSegTool(t: SegTool): void { tools.set(t.id, t); }
/** The tools in their row order. */
export function segTools(): SegTool[] { return [...tools.values()].sort((a, b) => a.order - b.order); }
