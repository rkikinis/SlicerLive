// THE THREE LIGHTING PRESETS, in one place, because two panels offer them.
//
// The 3D view's gear panel applies one to the whole view; the Volume Rendering module applies one to
// the active volume. Same names, same numbers, so a person who learns "Glossy" in one place has
// learned it everywhere. Slicer's own presets differ in exactly this way -- CT-Soft-Tissue is matte,
// CT-AAA glossy -- so the axis is (ambient, diffuse, specular, shininess) and the names say what you
// see rather than which coefficient moved.
import type { Shade } from "./shading.ts";

export interface LightPreset {
  name: string;
  why: string;
  shade: Shade;
}

export const LIGHT_PRESETS: LightPreset[] = [
  // BRIGHTER AND FAR LESS SHINY SINCE 2026-09-23. Ron, on a CT volume rendering: "too dark, too shiny,
  // even standard is very shiny." Chosen from rendered candidates (images/2026-09-23-LC003-presets-and-
  // lighting.png in the workspace). Until then: Matte .30/.70/0, Standard .22/.70/.14/24, Glossy
  // .16/.68/.34/64 -- the surfaces' Glossy default softens with it, the price of one set of numbers.
  { name: "Matte", why: "No highlight. Flat colors, as a FreeSurfer-style map is drawn.", shade: [0.40, 0.70, 0.00, 1] },
  { name: "Standard", why: "A faint highlight: enough to read curvature without shine. The volume rendering's default.", shade: [0.35, 0.70, 0.05, 10] },
  { name: "Glossy", why: "A soft highlight, for bone and other hard surfaces. The surfaces' default.", shade: [0.30, 0.70, 0.15, 20] },
];

/** GLOSSY IS THE DEFAULT, on Ron's instruction. */
export const DEFAULT_LIGHT = 2;

/** Which preset a shade vector is, or -1 if it has been dragged away from all of them. */
export function lightPresetOf(shade: readonly number[]): number {
  return LIGHT_PRESETS.findIndex((p) => p.shade.every((v, i) => Math.abs(v - shade[i]) < 1e-3));
}
