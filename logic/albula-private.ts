/**
 * ALBULA'S PRIVATE BLOCK (PS3.5 §7.8), for what no standard attribute of the SEG can hold: the whole provenance line.
 * ContentDescription (0070,0081) is LO, 64 characters (dciodvfy, 2026-09-25); the line is longer on any real network run.
 * Ron, 2026-09-26: "Segmentation provenance: Yes. Standards compliance" -- a 64-character summary in ContentDescription,
 * the full line here. The creator string carries the layout's version (CLAUDE.md, "modular and versioned").
 *
 * Its own module so the writer (export-dicom-seg.ts) and the reader (readers/dicom-seg.ts, which runs in a worker) share
 * the one definition without the reader pulling in the writer.
 */
export const ALBULA_PRIVATE = { creatorTag: "00770010", creator: "SlicerAlbula provenance 1", lineTag: "00771001" } as const;

/**
 * A FILE ALBULA WROTE says so: its SoftwareVersions (0018,1020) names SlicerAlbula, or it carries Albula's private block
 * (any version of the creator string). Critic 2026-10-20, finding 3: matching colors alone took a FreeSurfer or
 * TotalSegmentator result colored from the same public tables for Albula's own, and recolored it on load.
 * `softwareVersions` as dcmjs naturalizes it (a string, or a list for several values); `dict` the raw dataset.
 */
export function writtenByAlbula(softwareVersions: unknown, dict?: Record<string, { Value?: unknown[] } | undefined>): boolean {
  const sv = Array.isArray(softwareVersions) ? softwareVersions : softwareVersions === undefined ? [] : [softwareVersions];
  if (sv.some((v) => /\bSlicerAlbula\b/.test(String(v)))) return true;
  const creator = dict?.[ALBULA_PRIVATE.creatorTag]?.Value?.[0];
  return typeof creator === "string" && creator.trim().startsWith("SlicerAlbula provenance");
}
