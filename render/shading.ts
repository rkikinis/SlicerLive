// Volume-rendering shading coefficients, in one place.
//
// (ka, kd, ks, shininess) — ambient, diffuse, specular, specular power.
//
// These match 3D Slicer's own CT volume-rendering presets, which carry ks between 0.0 and 0.2 with
// a power of 1 to 10 (see examples/colorize/ct-presets.ts, transcribed from Slicer). SlicerLive had
// been using ks 0.5 at power 24-28 — two and a half times Slicer's strongest specular with a much
// tighter highlight, which reads as a wet, plastic sheen — and kd 0.75 against Slicer's 0.9, which
// darkens the mid-tones. Together that is why the same data looked darker and shinier here than in
// Slicer.
//
// The values live here rather than being repeated at each field construction: they were duplicated
// at four sites with three slightly different tunings, so no single edit could fix the look.

export type Shade = [number, number, number, number];

/** Slicer's usual CT look: soft, broad highlight, bright diffuse. */
export const SLICER_VR_SHADE: Shade = [0.1, 0.9, 0.2, 10];

/** Shading off: fully ambient, as Slicer renders when a volume property disables shading. */
export const UNSHADED: Shade = [1, 0, 0, 1];
