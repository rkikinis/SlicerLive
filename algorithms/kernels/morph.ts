// Binary morphology + median (W5) — the kernels under the Segment Editor's Smoothing effect (Median /
// Opening / Closing) and Margin (grow/shrink). Replaces vtkImageOpenClose3D / vtkImageMedian3D /
// vtkImageDilateErode3D for labelmaps. Structuring element = a Euclidean ball of a given voxel radius
// (di^2+dj^2+dk^2 <= r^2), matching scipy.ndimage with the same footprint. C-order, dims [nx,ny,nz].
//
//   deno test -A --no-check algorithms/kernels/morph.test.ts
export type Mask = { length: number; [i: number]: number };

/** Offsets of a Euclidean ball of radius r (voxels). r=1 -> 6-neighborhood + center (a plus in 3D). */
export function ballOffsets(r: number): [number, number, number][] {
  const R = Math.floor(r), r2 = r * r, out: [number, number, number][] = [];
  for (let dk = -R; dk <= R; dk++) for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    if (di * di + dj * dj + dk * dk <= r2) out.push([di, dj, dk]);
  }
  return out;
}

/**
 * THE SQUARED DISTANCE, IN VOXELS, FROM EVERY VOXEL TO THE NEAREST VOXEL WHOSE MASK VALUE IS `on` (SPEED-2026-10-28.md in
 * the Albula workspace, A6; Ron, 2026-10-28: "do all including the non gpu optimization"). Exact: Felzenszwalb and
 * Huttenlocher's separable lower envelope of parabolas (Theory of Computing 8:415-428, 2012), one pass per axis, as
 * render/edt-cpu.ts. Squared distances between voxel centers are whole numbers, held exactly, so a
 * test "within r" gives the same voxels as the ball offsets above. Infinity where no such voxel exists. Typed arrays and
 * plain loops only: it runs in JavaScriptCore in the window.
 */
export function squaredDistanceTo(mask: Mask, dims: [number, number, number], on: boolean): Float32Array {
  // 32-bit storage: a squared distance is a whole number below 2^24 on any grid under about 2,300 voxels a side, exact
  // there; the envelope's arithmetic is in 64-bit locals.
  const [nx, ny, nz] = dims, n = nx * ny * nz, d = new Float32Array(n);
  for (let v = 0; v < n; v++) d[v] = (mask[v] ? 1 : 0) === (on ? 1 : 0) ? 0 : Infinity;
  const L = Math.max(nx, ny, nz), f = new Float64Array(L), g = new Float64Array(L), vv = new Int32Array(L), z = new Float64Array(L + 1);
  // One axis: `count` lines of `len` voxels, `stride` apart along the line, starting where `start(line)` says.
  const pass = (len: number, stride: number, lines: number, start: (q: number) => number) => {
    for (let q = 0; q < lines; q++) {
      const o = start(q);
      let any = false;
      for (let i = 0; i < len; i++) { f[i] = d[o + i * stride]; if (f[i] !== Infinity) any = true; }
      if (!any) continue;
      let k = 0, first = 0;
      while (f[first] === Infinity) first++;
      vv[0] = first; z[0] = -Infinity; z[1] = Infinity;
      for (let i = first + 1; i < len; i++) {
        if (f[i] === Infinity) continue;
        let sx = ((f[i] + i * i) - (f[vv[k]] + vv[k] * vv[k])) / (2 * (i - vv[k]));
        while (sx <= z[k]) { k--; sx = ((f[i] + i * i) - (f[vv[k]] + vv[k] * vv[k])) / (2 * (i - vv[k])); }
        k++; vv[k] = i; z[k] = sx; z[k + 1] = Infinity;
      }
      k = 0;
      for (let i = 0; i < len; i++) { while (z[k + 1] < i) k++; const dq = i - vv[k]; g[i] = dq * dq + f[vv[k]]; }
      for (let i = 0; i < len; i++) d[o + i * stride] = g[i];
    }
  };
  pass(nx, 1, ny * nz, (q) => q * nx);
  pass(ny, nx, nx * nz, (q) => (q % nx) + Math.floor(q / nx) * nx * ny);
  pass(nz, nx * ny, nx * ny, (q) => q);
  return d;
}

/** Grow by a ball of radius r (voxels): every voxel within r of the mask. */
function dilateByDistance(mask: Mask, dims: [number, number, number], r: number): Uint8Array {
  const d = squaredDistanceTo(mask, dims, true), r2 = r * r, out = new Uint8Array(d.length);
  for (let v = 0; v < d.length; v++) out[v] = d[v] <= r2 ? 1 : 0;
  return out;
}

/** Shrink by a ball of radius r: the voxels with no background, and no point beyond the grid's faces, within r (the
 *  ball offsets treat outside the grid as background; the nearest such point lies straight across one face). */
function erodeByDistance(mask: Mask, dims: [number, number, number], r: number): Uint8Array {
  const [nx, ny, nz] = dims, d = squaredDistanceTo(mask, dims, false), r2 = r * r, out = new Uint8Array(d.length);
  for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) {
    if (!mask[v] || !(d[v] > r2)) continue;
    const e = Math.min(i + 1, nx - i, j + 1, ny - j, k + 1, nz - k);
    out[v] = e * e > r2 ? 1 : 0;
  }
  return out;
}

/** The ball-offset version: the reference the distance version is tested against (morph.test.ts). */
export function morphByOffsets(mask: Mask, dims: [number, number, number], r: number, mode: "dilate" | "erode"): Uint8Array { return morph(mask, dims, r, mode); }

function morph(mask: Mask, dims: [number, number, number], r: number, mode: "dilate" | "erode"): Uint8Array {
  const [nx, ny, nz] = dims, offs = ballOffsets(r);
  const out = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  const dilate = mode === "dilate";
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let v = dilate ? 0 : 1;
    for (const [di, dj, dk] of offs) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      // erosion treats out-of-bounds as background (0) -> shrinks at borders; dilation ignores them
      const inb = ii >= 0 && ii < nx && jj >= 0 && jj < ny && kk >= 0 && kk < nz;
      const s = inb ? (mask[idx(ii, jj, kk)] ? 1 : 0) : 0;
      if (dilate) { if (s) { v = 1; break; } } else { if (!s) { v = 0; break; } }
    }
    out[idx(i, j, k)] = v;
  }
  return out;
}

// Every radius by the distance map, whose time does not grow with the radius (radius 1 too: by its offsets it was the
// slowest margin, 3.5-7 s on a large CT grid -- the critic, 2026-10-28, speed part A, finding 6; exact there as well).
// A radius that is not a number keeps the old behavior (no offsets: nothing grows, nothing is taken away).
export const binaryDilate = (m: Mask, d: [number, number, number], r = 1): Uint8Array => Number.isFinite(r) ? dilateByDistance(m, d, r) : morph(m, d, r, "dilate");
export const binaryErode = (m: Mask, d: [number, number, number], r = 1): Uint8Array => Number.isFinite(r) ? erodeByDistance(m, d, r) : morph(m, d, r, "erode");
/** Opening = erode then dilate (removes small protrusions / thin bridges). */
export const binaryOpen = (m: Mask, d: [number, number, number], r = 1): Uint8Array => binaryDilate(binaryErode(m, d, r), d, r);
/** Closing = dilate then erode (fills small holes / gaps). */
export const binaryClose = (m: Mask, d: [number, number, number], r = 1): Uint8Array => binaryErode(binaryDilate(m, d, r), d, r);

/** Median (majority vote) over a Euclidean ball — Slicer's Median smoothing. Ties (exactly half) keep on. */
export function median3d(mask: Mask, dims: [number, number, number], r = 1): Uint8Array {
  const [nx, ny, nz] = dims, offs = ballOffsets(r);
  const out = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let on = 0, tot = 0;
    for (const [di, dj, dk] of offs) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny || kk < 0 || kk >= nz) continue;
      tot++; if (mask[idx(ii, jj, kk)]) on++;
    }
    out[idx(i, j, k)] = on * 2 >= tot ? 1 : 0;
  }
  return out;
}
