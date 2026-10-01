/**
 * WHICH LOADED VOLUME A SEG WAS DRAWN ON. A SEG names its series and, within it, the instances
 * it references. The series alone does not settle it: the five phases of a gated CTA share one
 * series, and by series alone every phase's SEG landed on the first phase (Ron: "The gray scales
 * move, the segmentations and models don't"). So: the volume of that series whose instances
 * include the SEG's first referenced one; else, when no volume records its instances or the
 * SEG names none, the first volume of the series; else nothing, and the caller says so.
 */
import { holdsInstance } from "./instance-key.ts";
import type { MrsonNode } from "../render/mrson.ts";

export function volumeForSeg(
  images: MrsonNode[],
  seg: { referencedSeriesUID?: string; referencedSOPInstanceUIDs?: string[]; referencedFrames?: { uid: string; frame: number }[] },
): MrsonNode | undefined {
  if (!seg.referencedSeriesUID) return undefined;
  const origin = (im: MrsonNode) => (im.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string; sopInstanceUIDs?: string[]; frameNumbers?: number[] } | undefined) ?? {};
  // A crop put in the database holds its series under savedSeriesInstanceUID; the SEG writer
  // references that series, so the read must accept it too (critic, 2026-09-17, finding 19).
  const ofSeries = images.filter((im) => origin(im).seriesInstanceUID === seg.referencedSeriesUID || origin(im).savedSeriesInstanceUID === seg.referencedSeriesUID);
  if (!ofSeries.length) return undefined;
  // By the frame too when the SEG names one (a SEG on a multi-frame source: logic/instance-key.ts).
  const named = seg.referencedFrames?.[0] ?? (seg.referencedSOPInstanceUIDs?.[0] ? { uid: seg.referencedSOPInstanceUIDs[0] } : undefined);
  if (named) {
    const byInstance = ofSeries.find((im) => holdsInstance(origin(im), named));
    if (byInstance) return byInstance;
  }
  return ofSeries[0];
}
