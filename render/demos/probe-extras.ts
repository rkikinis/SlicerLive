// MORE ROWS FOR THE DATA PROBE, from whoever knows something about a point that core does not -- an extension's own
// objects (Ron, 2026-10-01: "the tracts are not in the data probe"). A provider is asked on every probe reading with the
// point in patient RAS and answers with a few rows; one that throws is skipped, never the probe.

export interface ProbeExtraRow { /** A swatch, 0..1 RGB. */ color?: [number, number, number]; text: string; source: string }
export type ProbeProvider = (ras: [number, number, number]) => ProbeExtraRow[];

const providers = new Set<ProbeProvider>();

/** Add a provider; the returned function removes it. */
export function registerProbeRows(p: ProbeProvider): () => void {
  providers.add(p);
  return () => { providers.delete(p); };
}

export function probeExtraRows(ras: [number, number, number]): ProbeExtraRow[] {
  const out: ProbeExtraRow[] = [];
  for (const p of providers) { try { out.push(...p(ras)); } catch { /* a provider's fault is not the probe's */ } }
  return out;
}

/**
 * WHAT STANDS IN FRONT IN 3D, from whoever draws it (2026-10-01: a fiber tube in front of a tumor was probed at the
 * tumor's surface, so the tract was not named). The 3D probe asks every provider for the distance along its ray
 * (origin and unit direction in RAS, mm) to the first thing the provider draws there, or null; a nearer answer than the
 * structure core found wins. Only things a provider draws OPAQUE belong here: the volume rendering's 50% point stays a
 * fallback, so the probe's answer does not change with an opacity slider (the 3D probe's recorded decision).
 */
export type RayHitProvider = (origin: [number, number, number], dir: [number, number, number]) => number | null;

const rayHits = new Set<RayHitProvider>();

/** Add a provider; the returned function removes it. */
export function registerRayHits(p: RayHitProvider): () => void {
  rayHits.add(p);
  return () => { rayHits.delete(p); };
}

/** The nearest provider hit along the ray, mm, or null. */
export function nearestRayHit(origin: [number, number, number], dir: [number, number, number]): number | null {
  let best: number | null = null;
  for (const p of rayHits) {
    try { const t = p(origin, dir); if (t !== null && Number.isFinite(t) && t >= 0 && (best === null || t < best)) best = t; } catch { /* skipped */ }
  }
  return best;
}
