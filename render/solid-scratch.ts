// SCRATCH SHARED BY THE MERGE AND THE SMOOTHING of the solid look (solid-merge.ts, solid-smooth.ts).
//
// Each is a byte per voxel, row-padded: 418 MB on the 768x768x709 whole-body case. The merge used one and
// the smoothing two, each made fresh and destroyed after its submit -- and a buffer destroyed after submit is
// freed only when the card has run the work, so on a load the merge's was still alive when the smoothing
// made its two: 1.25 GB for a moment, in the process that the system ends somewhere above 4 GB (Ron's window
// was reset loading a CT with four segmentations, 2026-09-24). Now the smoothing reuses the merge's buffer:
// 836 MB at the peak -- for one voxel grid: two grids of different sizes remake the buffers for each, and
// save nothing. Work is submitted in order on one queue, so a reuse after a submit is safe.
//
// A buffer is kept only until the card has finished the work submitted with it; nothing is held between
// merges.

const pool = new WeakMap<GPUDevice, Map<string, { buf: GPUBuffer; gen: number }>>();

/** The scratch buffer `name` of exactly `size` bytes (STORAGE | COPY_SRC), made or reused. */
export function solidScratch(dev: GPUDevice, name: "a" | "b", size: number): GPUBuffer {
  let m = pool.get(dev);
  if (!m) pool.set(dev, m = new Map());
  const e = m.get(name);
  if (e && e.buf.size === size) { e.gen++; return e.buf; }
  e?.buf.destroy();
  const buf = dev.createBuffer({ label: `solid look scratch (${name})`, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  m.set(name, { buf, gen: 0 });
  return buf;
}

/** Call after the submit that used the scratch: each buffer is let go once the card is done, unless it has
 *  been taken again meanwhile (then that user lets it go). */
export function releaseSolidScratch(dev: GPUDevice): void {
  const m = pool.get(dev);
  if (!m) return;
  const snap = [...m.entries()].map(([k, e]) => ({ k, gen: e.gen, buf: e.buf }));
  const drop = () => { for (const s of snap) { const e = m.get(s.k); if (e && e.buf === s.buf && e.gen === s.gen) { s.buf.destroy(); m.delete(s.k); } } };
  const done = (dev.queue as { onSubmittedWorkDone?: () => Promise<void> }).onSubmittedWorkDone?.();
  if (done) void done.then(drop, drop); else drop();
}

/** Bytes held in scratch now (for the tests; the page's memory report does not read it). */
export function solidScratchBytes(dev: GPUDevice): number {
  let n = 0;
  for (const e of pool.get(dev)?.values() ?? []) n += e.buf.size;
  return n;
}
