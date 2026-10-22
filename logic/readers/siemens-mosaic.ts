// SIEMENS MOSAIC: many slices tiled into one image (diffusion and fMRI scans of Siemens' older software). Generic image
// geometry, so it is core's (moved out of diffusion-vendors.ts on 2026-09-30, Contents/docs/EXTENSIONS.md).
import { at, bytesOf, num, parseCsa, privateNumbers, type Raw } from "./private-tags.ts";

export interface Mosaic {
  /** Number of slices in the tiles, the tile size, and the tiles per row of the mosaic. */
  n: number; rows: number; columns: number; perRow: number;
  /** Each slice's ImagePositionPatient (LPS), in tile order. */
  positions: [number, number, number][];
  /** True when the file declares neither SpacingBetweenSlices nor SliceThickness, so the slices were put 1 mm apart:
   *  a guess, carried to the volume's geometry as "assumed" rather than laundered into positions that look measured. */
  spacingNotDeclared?: true;
}

/**
 * A Siemens mosaic's slices (ImageType contains MOSAIC; the count in the CSA header's NumberOfImagesInMosaic, else
 * (0019,100A)). The file's ImagePositionPatient is the corner of the WHOLE mosaic seen as one big slice; the first
 * tile's true corner is shifted by half the difference between the mosaic and a tile, along the row and column
 * directions, and each next tile steps one slice spacing along the CSA SliceNormalVector (the published geometry of
 * the format, as NiBabel's documentation of it describes). Checked against dcm2niix's geometry in the tests.
 */
export function siemensMosaic(ds: Record<string, unknown>, raw: Raw): Mosaic | undefined {
  const type = (Array.isArray(ds.ImageType) ? ds.ImageType : String(ds.ImageType ?? "").split("\\")).map(String);
  if (!type.includes("MOSAIC")) return undefined;
  const csa = bytesOf(raw, at(raw, "0029", "SIEMENS CSA HEADER", "10"));
  const t = csa ? parseCsa(csa) : new Map<string, string[]>();
  const n = num(t.get("NumberOfImagesInMosaic")?.[0]) ?? privateNumbers(raw, at(raw, "0019", "SIEMENS MR HEADER", "0A"), "US")[0];
  if (!n || n < 1) return undefined;
  const perRow = Math.ceil(Math.sqrt(n));
  const R = Number(ds.Rows), C = Number(ds.Columns);
  const rows = Math.floor(R / perRow), columns = Math.floor(C / perRow);
  const iop = (ds.ImageOrientationPatient as number[]).map(Number), ipp = (ds.ImagePositionPatient as number[]).map(Number);
  const ps = (ds.PixelSpacing as number[]).map(Number);                    // [between rows, between columns]
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6);
  // The CSA's own normal when it holds three numbers; the image's normal otherwise (the syngo 2004 CSA lists the tag
  // with empty items, which gave NaN positions: critic, 2026-09-29, finding 7).
  const csaNormal = t.get("SliceNormalVector")?.map(Number);
  const normal = (csaNormal && csaNormal.length >= 3 && csaNormal.slice(0, 3).every(Number.isFinite) ? csaNormal : [rowDir[1] * colDir[2] - rowDir[2] * colDir[1], rowDir[2] * colDir[0] - rowDir[0] * colDir[2], rowDir[0] * colDir[1] - rowDir[1] * colDir[0]]);
  // THE SPACING IS THE FILE'S, OR SAID TO BE A GUESS. It was 1 mm silently: the positions below then looked measured, and
  // the series reader reported a spacing "derived from slice positions" that nobody had declared ("absent means
  // unknown", DUCKN-WORKING-COPY.md; Ron: "People use slicer from microscopy to astrophysics"). A 0 is not a spacing.
  const declared = [num(ds.SpacingBetweenSlices), num(ds.SliceThickness)].find((x) => x !== undefined && x !== 0);
  const spacing = declared ?? 1;
  const dc = ps[1] * (C - columns) / 2, dr = ps[0] * (R - rows) / 2;
  const p0 = [0, 1, 2].map((k) => ipp[k] + rowDir[k] * dc + colDir[k] * dr);
  const positions = Array.from({ length: n }, (_, s) => [0, 1, 2].map((k) => p0[k] + s * spacing * normal[k]) as [number, number, number]);
  return { n, rows, columns, perRow, positions, ...(declared === undefined ? { spacingNotDeclared: true as const } : {}) };
}

/** Tile s of a mosaic's pixels. */
export function mosaicTile(pixels: Int16Array | Uint16Array, m: Mosaic, mosaicColumns: number, s: number): Int16Array | Uint16Array {
  const out = pixels instanceof Int16Array ? new Int16Array(m.rows * m.columns) : new Uint16Array(m.rows * m.columns);
  const tr = Math.floor(s / m.perRow), tc = s % m.perRow;
  for (let r = 0; r < m.rows; r++) {
    const src = (tr * m.rows + r) * mosaicColumns + tc * m.columns;
    out.set(pixels.subarray(src, src + m.columns), r * m.columns);
  }
  return out;
}
