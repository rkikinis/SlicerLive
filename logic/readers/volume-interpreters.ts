// WHAT SEPARATES ONE VOLUME FROM THE NEXT, as told by an extension -- a hook of the DICOM series reader
// (dicom-series.ts). Core reads the geometry, the pixels and the generic dimensions (time point, echo, stack); an
// interpreter reads what its kind of acquisition keeps per image (diffusion: the b-value and gradient direction, from
// the standard attributes or a vendor's private ones) and returns it as a KEY. Images with different keys are
// different volumes; the key's label names the volume ("b 1000 · 0.71, 0.71, 0.00"); its meta travels with the
// volume, under the interpreter's name (volume.meta[name]). Core never knows what the values mean.
// Contents/docs/EXTENSIONS.md in the workspace: extensions register, core calls whatever is registered and works with
// none. Registration must happen in every place DICOM is read (the page, and the server that writes working copies).

/** What an interpreter says about one image (or one frame of a multi-frame file). */
export interface VolumeKey {
  /** Equal keys = the same volume (with the other dimensions equal too). */
  key: string;
  /** How the volume is named in the sequence's frame list; absent: not named by this interpreter. */
  label?: string;
  /** Kept with the volume, as volume.meta[interpreter name]. */
  meta: Record<string, unknown>;
  /** Weak evidence, to be confirmed or dropped by the interpreter's `finish` once the whole parse is seen. */
  weak?: boolean;
}

/** An image as `finish` sees it: its series and its keys, by interpreter name. */
export interface KeyedImage { seriesInstanceUID: string; volumeKeys?: Record<string, VolumeKey> }

export interface VolumeInterpreter {
  /** Its name: the key under which its values are kept (image.volumeKeys[name], volume.meta[name]). */
  name: string;
  /** A fingerprint of its code (the extension's build makes it): recorded in every working copy, so a copy made by
   *  another version of this interpreter is not used (desktop/duckn-copy.ts, render/zarr-copy.ts). */
  code?: string;
  /** A single-frame file: `ds` the naturalized dataset, `raw` its DICOM JSON form (private elements by tag). */
  instance?(ds: Record<string, unknown>, raw: Record<string, unknown>): VolumeKey | undefined;
  /** One frame of an enhanced multi-frame file: `group(name)` is the frame's functional-group item of that name
   *  (per-frame, else shared); `top` the file's top-level dataset (naturalized, and its DICOM JSON form with private
   *  elements by tag) for what is not per frame (2026-10-03: a private block of the whole object). */
  frame?(group: (name: string) => Record<string, unknown> | undefined, top?: { ds: Record<string, unknown>; raw?: Record<string, unknown> }): VolumeKey | undefined;
  /** After a whole parse: confirm or drop weak keys (changes the images in place). */
  finish?(images: KeyedImage[]): void;
}

const KEY = "__albulaVolumeInterpreters";
const list = (): VolumeInterpreter[] => ((globalThis as Record<string, unknown>)[KEY] ??= []) as VolumeInterpreter[];

/** An extension registers its interpreter; registering the same name again replaces it. */
export function registerVolumeInterpreter(i: VolumeInterpreter): void {
  const l = list(), at = l.findIndex((x) => x.name === i.name);
  if (at >= 0) l[at] = i; else l.push(i);
}
export const volumeInterpreters = (): readonly VolumeInterpreter[] => list();
/** Each registered interpreter's code fingerprint, by name (sorted), as a working copy records it. */
export const interpreterCodes = (): Record<string, string> =>
  Object.fromEntries(list().map((i) => [i.name, i.code ?? "unversioned"] as const).sort((a, b) => a[0] < b[0] ? -1 : 1));
/** Take one out again (tests). */
export function unregisterVolumeInterpreter(name: string): void {
  const l = list(), at = l.findIndex((x) => x.name === name);
  if (at >= 0) l.splice(at, 1);
}

/** Every registered interpreter's key for a single-frame image. */
export function keysOfInstance(ds: Record<string, unknown>, raw: Record<string, unknown>): Record<string, VolumeKey> | undefined {
  let out: Record<string, VolumeKey> | undefined;
  for (const i of list()) { const k = i.instance?.(ds, raw); if (k) (out ??= {})[i.name] = k; }
  return out;
}
/** Every registered interpreter's key for one frame of a multi-frame file. */
export function keysOfFrame(group: (name: string) => Record<string, unknown> | undefined, top?: { ds: Record<string, unknown>; raw?: Record<string, unknown> }): Record<string, VolumeKey> | undefined {
  let out: Record<string, VolumeKey> | undefined;
  for (const i of list()) { const k = i.frame?.(group, top); if (k) (out ??= {})[i.name] = k; }
  return out;
}
/** After a parse: each interpreter settles its weak keys; then no key is left marked weak. */
export function finishKeys(images: KeyedImage[]): void {
  for (const i of list()) i.finish?.(images);
  for (const im of images) for (const k of Object.values(im.volumeKeys ?? {})) delete k.weak;
}
/** The part of the grouping key that comes from the interpreters, in a fixed order. */
export const volumeKeyString = (keys: Record<string, VolumeKey> | undefined): string =>
  keys ? Object.keys(keys).sort().map((n) => `${n}=${keys[n].key}`).join("|") : "";
