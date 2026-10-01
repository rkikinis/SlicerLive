// Slicer's layout catalog as data (vtkMRMLLayoutNode ids + vtkMRMLLayoutLogic arrangements), replacing the
// hard-coded LAYOUTS tables. A cell is a fractional rectangle over the view area; the app places renderers
// into them. Names/colours follow Slicer's layout XML (Red/Yellow/Green + 3D "1").
export type ViewKind = "slice" | "3d";
export interface LayoutCell { view: string; kind: ViewKind; x: number; y: number; w: number; h: number; orientation?: "Axial" | "Sagittal" | "Coronal" }
export interface Layout { id: number; name: string; cells: LayoutCell[] }

const cell = (view: string, kind: ViewKind, x: number, y: number, w: number, h: number, orientation?: LayoutCell["orientation"]): LayoutCell => ({ view, kind, x, y, w, h, orientation });

// vtkMRMLLayoutNode::SlicerLayout ids
export const LAYOUTS: Record<number, Layout> = {
  // Transcribed from `conventionalWidescreenView` in vtkMRMLLayoutLogic.cxx: an outer HORIZONTAL
  // split, 3D on the left at splitSize 500, and a vertical stack of three slices on the right at
  // splitSize 300 -- so 500/800 = 0.625. Note the slice ORDER differs from Conventional: top to
  // bottom it is Red/Axial, Green/Coronal, Yellow/Sagittal, where Conventional runs Red, Yellow,
  // Green left to right. Copied rather than tidied, because a layout people know by muscle memory is
  // not improved by being made consistent.
  16: {
    id: 16,
    name: "Conventional Widescreen",
    cells: [
      cell("1", "3d", 0, 0, 0.625, 1),
      cell("Red", "slice", 0.625, 0, 0.375, 1 / 3, "Axial"),
      cell("Green", "slice", 0.625, 1 / 3, 0.375, 1 / 3, "Coronal"),
      cell("Yellow", "slice", 0.625, 2 / 3, 0.375, 1 / 3, "Sagittal"),
    ],
  },
  2: { id: 2, name: "Conventional", cells: [cell("1", "3d", 0, 0, 1, 0.5), cell("Red", "slice", 0, 0.5, 1 / 3, 0.5, "Axial"), cell("Yellow", "slice", 1 / 3, 0.5, 1 / 3, 0.5, "Sagittal"), cell("Green", "slice", 2 / 3, 0.5, 1 / 3, 0.5, "Coronal")] },
  3: { id: 3, name: "Four-Up", cells: [cell("Red", "slice", 0, 0, 0.5, 0.5, "Axial"), cell("1", "3d", 0.5, 0, 0.5, 0.5), cell("Yellow", "slice", 0, 0.5, 0.5, 0.5, "Sagittal"), cell("Green", "slice", 0.5, 0.5, 0.5, 0.5, "Coronal")] },
  4: { id: 4, name: "One-Up 3D", cells: [cell("1", "3d", 0, 0, 1, 1)] },
  6: { id: 6, name: "One-Up Red", cells: [cell("Red", "slice", 0, 0, 1, 1, "Axial")] },
  7: { id: 7, name: "One-Up Yellow", cells: [cell("Yellow", "slice", 0, 0, 1, 1, "Sagittal")] },
  8: { id: 8, name: "One-Up Green", cells: [cell("Green", "slice", 0, 0, 1, 1, "Coronal")] },
  15: { id: 15, name: "Dual 3D", cells: [cell("1", "3d", 0, 0, 0.5, 1), cell("2", "3d", 0.5, 0, 0.5, 1)] },
  21: { id: 21, name: "Three-Over-Three", cells: [cell("Red", "slice", 0, 0, 1 / 3, 0.5, "Axial"), cell("Yellow", "slice", 1 / 3, 0, 1 / 3, 0.5, "Sagittal"), cell("Green", "slice", 2 / 3, 0, 1 / 3, 0.5, "Coronal"), cell("Slice4", "slice", 0, 0.5, 1 / 3, 0.5, "Axial"), cell("Slice5", "slice", 1 / 3, 0.5, 1 / 3, 0.5, "Sagittal"), cell("Slice6", "slice", 2 / 3, 0.5, 1 / 3, 0.5, "Coronal")] },
  29: { id: 29, name: "Two-Over-Two", cells: [cell("Red", "slice", 0, 0, 0.5, 0.5, "Axial"), cell("Yellow", "slice", 0.5, 0, 0.5, 0.5, "Sagittal"), cell("Green", "slice", 0, 0.5, 0.5, 0.5, "Coronal"), cell("Slice4", "slice", 0.5, 0.5, 0.5, 0.5, "Axial")] },
};

export const DEFAULT_LAYOUT = 3;
export function layout(id: number): Layout { return LAYOUTS[id] ?? LAYOUTS[DEFAULT_LAYOUT]; }
export function layoutList(): Layout[] { return Object.values(LAYOUTS).sort((a, b) => a.id - b.id); }

/**
 * Where a layout's horizontal split sits, as a fraction of the view area.
 *
 * Slicer's catalog fixes this at 0.5 and so did we, which means the slice views are always exactly
 * half the height whether you are reading them or the 3D view. `rowSplit` moves the boundary: cells
 * whose rows lie above it are scaled into the top band, and those below into the bottom one.
 *
 * Only layouts with a clean top/bottom division have one — Conventional and Four-Up do; a single
 * view or a side-by-side pair has nothing to move.
 */
export function splitBoundary(id: number): { axis: "row" | "column"; at: number } | null {
  const cells = layout(id).cells;
  // A boundary exists when the cells fall into exactly two bands along one axis: some starting at 0,
  // the rest starting together further along. Conventional splits into rows, Conventional Widescreen
  // into columns, and a single view or an even grid into neither.
  const band = (vals: number[]) => {
    const set = new Set(vals);
    const beyond = [...set].filter((v) => v > 0).sort((a, b) => a - b);
    return set.has(0) && beyond.length === 1 ? beyond[0] : null;
  };
  const row = band(cells.map((c) => c.y));
  if (row !== null) return { axis: "row", at: row };
  const col = band(cells.map((c) => c.x));
  if (col !== null) return { axis: "column", at: col };
  return null;
}

/**
 * Cell rectangles in pixel coords over a view area (origin at 0,0 unless given).
 *
 * `rowSplit` overrides the layout's own boundary, so a user can give the slice views more room than
 * the catalog's fixed half. Cells are rescaled rather than translated: the top band keeps its
 * internal proportions and so does the bottom.
 */
export function cellsFor(
  id: number,
  areaW: number,
  areaH: number,
  x0 = 0,
  y0 = 0,
  splitAt?: number,
): (LayoutCell & { px: { x: number; y: number; w: number; h: number } })[] {
  const b = splitBoundary(id);
  const split = b && typeof splitAt === "number" ? Math.max(0.1, Math.min(0.9, splitAt)) : null;
  // Rescale within each band rather than translating the boundary, so the three stacked slices keep
  // their equal thirds of whatever width they are given.
  const remap = (start: number, extent: number, at: number, s: number) =>
    start < at
      ? [(start / at) * s, (extent / at) * s] as const
      : [s + ((start - at) / (1 - at)) * (1 - s), (extent / (1 - at)) * (1 - s)] as const;

  return layout(id).cells.map((c) => {
    let { x, y, w, h } = c;
    if (split !== null && b) {
      if (b.axis === "row") [y, h] = remap(c.y, c.h, b.at, split);
      else [x, w] = remap(c.x, c.w, b.at, split);
    }
    return { ...c, px: { x: x0 + x * areaW, y: y0 + y * areaH, w: w * areaW, h: h * areaH } };
  });
}
