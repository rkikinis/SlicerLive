// THE BRUSH'S RESIDENT LABELMAPS, one per segmentation being painted (logic/segment-tools.ts paintStroke / drawFill /
// commitPaint). Its own module (2026-10-30) so that code which changes a segmentation underneath -- an effect, a grown
// outline (logic/segmentation-editor.ts growIntoSegmentation), Click to outline -- can drop the stale copy without
// importing the editor's tools. The one writer of this map is segment-tools.ts; the others only invalidate.
import type { Vec3 } from "../render/mat4.ts";

export interface PaintCache { labelmap: Uint8Array; dims: [number, number, number]; ijkToRAS: number[]; invIjk: number[]; spacing: Vec3; dirty: boolean; uploading: boolean; }
export const paintCaches = new Map<string, PaintCache>();

/** Drop the resident labelmap (call when the segmentation changes underneath, e.g. after a discrete effect). */
export function invalidatePaintCache(segId?: string) { if (segId) paintCaches.delete(segId); else paintCaches.clear(); }
