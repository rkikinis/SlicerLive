// HOW A VOLUME AND ITS SEGMENTATIONS APPEAR IN 3D: one choice per volume, made in the Scene module.
//
// Ron, 2026-09-23: "So in the scene module I need presets for: surface rendering, colorized volume,
// volume rendering of the gray scale. We use default behavior when loading, and the user can override
// with the presets. Everything else goes into the advanced." And for the default: "solid colored volume,
// but keep the surfaces until we know for sure that it works."
//
//   off       nothing of this volume in 3D
//   volume    the volume rendered (its preset: flesh for CT, gray from the window for anything else);
//             its segmentations not drawn in 3D
//   solid     its segmentations drawn solid (render/solid-merge.ts, colorize-field.ts setSolid); the
//             volume itself not rendered. A sequence (the beating heart) keeps the colored volume, solid.
//   surfaces  its segmentations drawn as surface models; the volume not rendered. ONLY FOR SEGMENTATIONS
//             GIVEN SURFACE MODELS in the Generate Surface Models module (Ron, 2026-09-24: surface models
//             behind a firewall); the Scene module offers it only for a volume that has some, and a
//             segmentation without them is drawn solid under it.
//
// The choice is stored on the image node as `look3D`. What the Scene module SHOWS is read back from what
// is actually on (the volume rendering may be switched on elsewhere: the Volume Rendering module, a crop,
// an AI result), so the control never claims a look that is not on screen. This file only reads; the
// writer, which touches the volume rendering, is setLook3D in render/demos/tf-editor.ts.

import type { LiveScene } from "./livescene.ts";
import type { MrsonNode } from "./mrson.ts";

export type Look3D = "off" | "volume" | "solid" | "surfaces";
export const LOOKS_3D: readonly Look3D[] = ["off", "volume", "solid", "surfaces"];

const refs = (n: MrsonNode | undefined, k: string): string[] => ((n?.refs as Record<string, string[]> | undefined)?.[k] ?? []);

/** The volume-rendering display node drawing this image (or, for a frame, its sequence's). */
export function vrNodeOf(live: LiveScene, imageId: string): MrsonNode | undefined {
  const seq = live.nodes.get(imageId)?.sequence;
  for (const n of live.nodes.values()) {
    if (n.type !== "volumeRenderingDisplay") continue;
    const v = refs(n, "volume")[0];
    if (v === imageId || (seq && v && live.nodes.get(v)?.sequence === seq)) return n;
  }
  return undefined;
}

/** The segmentations drawn on this image (their `source`), or on another frame of its sequence. */
export function segmentationsOf(live: LiveScene, imageId: string): MrsonNode[] {
  const seq = live.nodes.get(imageId)?.sequence;
  return [...live.nodes.values()].filter((n) => {
    if (n.type !== "segmentation") return false;
    const src = refs(n, "source")[0];
    return src === imageId || (!!seq && !!src && live.nodes.get(src)?.sequence === seq);
  });
}

/** The look as stored, or the default for this volume: solid when it has a segmentation, else off
 *  (a volume alone is switched on by its load, as before). */
export function storedLook3D(live: LiveScene, imageId: string): Look3D {
  // "colored" was the stored name until 2026-09-25; the database's scenes were rewritten, a file from elsewhere is read.
  const raw = live.nodes.get(imageId)?.look3D as string | undefined;
  const s = (raw === "colored" ? "solid" : raw) as Look3D | undefined;
  if (s && LOOKS_3D.includes(s)) return s;
  return segmentationsOf(live, imageId).length ? "solid" : "off";
}

/** The look on screen now, for the Scene module's control: the volume rendering is the evidence for
 *  "volume" (and, for a sequence colorizing, for "solid"); otherwise the stored choice. */
export function look3DOf(live: LiveScene, imageId: string): Look3D {
  const vr = vrNodeOf(live, imageId);
  const img = live.nodes.get(imageId);
  if (vr?.visible) {
    if (img?.sequence && vr.colorize !== false && segmentationsOf(live, imageId).length) return "solid";
    return "volume";
  }
  const s = storedLook3D(live, imageId);
  if ((s === "solid" || s === "surfaces") && !segmentationsOf(live, imageId).length) return "off";
  // "Surfaces" without any surface models is what is drawn: solid.
  if (s === "surfaces" && !hasSurfaceModels(live, imageId)) return "solid";
  return s === "volume" ? "off" : s;
}

/**
 * EVERYTHING OF THIS VOLUME THAT IS ON in 3D, for the Scene module to light up: the volume rendering
 * ("volume") and the look its segmentations are drawn in ("solid" / "surfaces"), which can both be on
 * when the volume rendering was switched on elsewhere (Volume Rendering, a crop, an older scene). One
 * lit button there claimed one of the two while the other was on screen too (critic, 2026-09-24,
 * finding 13). "off" when neither.
 */
export function looksOn(live: LiveScene, imageId: string): Look3D[] {
  const vr = vrNodeOf(live, imageId);
  const img = live.nodes.get(imageId);
  const segs = segmentationsOf(live, imageId);
  // A TIME SERIES is drawn in 3D by its rendering alone (its members are not in the solid look): colorizing
  // is Colored, not colorizing is Volume, off is the stored Surfaces if it has models, else nothing. It lit
  // Volume and Colored for a gray rendering (critic, 2026-09-24, round 2, finding 5).
  if (img?.sequence) {
    if (vr?.visible) return [vr.colorize !== false && segs.length ? "solid" : "volume"];
    return storedLook3D(live, imageId) === "surfaces" && hasSurfaceModels(live, imageId) ? ["surfaces"] : ["off"];
  }
  // A SINGLE VOLUME rendered with its segmentations colorized into it (the AI panel's see-through colored
  // volume) draws them: Colored, not Volume ("its segmentations are not drawn").
  if (vr?.visible && vr.colorize === true && segs.length) return ["solid"];
  const out: Look3D[] = [];
  if (vr?.visible) out.push("volume");
  const s = storedLook3D(live, imageId);
  if (segs.length && (s === "solid" || s === "surfaces")) out.push(s === "surfaces" && hasSurfaceModels(live, imageId) ? "surfaces" : "solid");
  return out.length ? out : ["off"];
}

/** How a segmentation is drawn in 3D under its volume's look: solid, surface models, or not at all.
 *  A segmentation whose volume is not in the scene (a label map loaded alone) is solid, the default. */
export function segLookOf(live: LiveScene, seg: MrsonNode): "solid" | "surfaces" | "hidden" {
  const src = refs(seg, "source")[0];
  const img = src ? live.nodes.get(src) : undefined;
  if (!img || img.type !== "image") return seg.surfaceModels === true ? "surfaces" : "solid";
  const s = storedLook3D(live, img.id as string);
  if (s === "off" || s === "volume") return "hidden";
  return s === "surfaces" && seg.surfaceModels === true ? "surfaces" : "solid";
}

/** Has any segmentation of this volume been given surface models (Generate Surface Models)? The Scene
 *  module shows its "Surfaces" choice only then. */
export function hasSurfaceModels(live: LiveScene, imageId: string): boolean {
  return segmentationsOf(live, imageId).some((n) => n.surfaceModels === true);
}
