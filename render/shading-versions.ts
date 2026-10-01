// THE SHADING, BY VERSION -- how a structure in the 3D view takes the light. Ron, 2026-09-25: "Please make sure that
// this and everything else is as modular as possible and also versioned." Like the color schemes
// (logic/anatomy/palettes.ts): each version is a number, the old ones stay, Settings chooses, and a saved scene records
// the one it was made with (the 3D view node's `shadingVersion`), so any state can be got back.
//
//   v1  every structure lit alike: one ambient / diffuse / highlight for all (the lighting preset), 2026-09-23.
//   v2  each structure lit as its tissue: Michael Halle's finishes (his tissue palettes, materials.yaml › finishes,
//       per structure in logic/anatomy/palette-v2.json), a physically based highlight -- a GGX base layer and clear
//       coat, sheen, subsurface softening. Mike, 2026-09-25: "consider using a physically based rendering shader and
//       the shader styles that were chosen by Claude for the palette." Ron: "Mikes shading yes, if there is no
//       significant slowdown." Measured on the solid look, 800 x 800, public C3N-00704: 30.9 ms a frame without,
//       32.5 with (five rounds each; the rounds without ranged 28.9-34.3).
//
// Everything a version needs is here: the list, the current one, what a structure's finish is under it, how a finish
// is packed for the graphics card, and the shader function that lights it. The fields that draw structures
// (colorize-field.ts) call these; they hold no shading decisions of their own.
import { type Finish, paletteFinish } from "../logic/anatomy/palettes.ts";

/** `label` and `what` are the words a person sees (the 3D view's Shading row, Settings), what it looks like, not how it is
 *  done (Ron, 2026-09-25: "for the tooltips the what is important not the how"). */
export interface ShadingVersion { version: number; name: string; date: string; label: string; what: string }
export const SHADINGS: readonly ShadingVersion[] = [
  { version: 1, name: "Every structure lit alike", date: "2026-09-23", label: "Uniform",
    what: "Uniform: every structure takes the light the same way." },
  { version: 2, name: "Tissue finishes (Michael Halle's palettes, physically based)", date: "2026-09-25", label: "Per tissue",
    what: "Per tissue: each tissue takes the light as it does in life: a wet sheen on organs, satin on muscle, matte bone." },
];
export const LATEST_SHADING = SHADINGS[SHADINGS.length - 1].version;

/** Which table of finishes a shading version reads (palette-v2.json's for v2). */
const FINISH_TABLE: Record<number, number> = { 2: 2 };

let current = LATEST_SHADING;
const listeners = new Set<() => void>();
export function shadingVersion(): number { return current; }
export function setShadingVersion(v: number): void {
  const next = SHADINGS.some((s) => s.version === v) ? v : LATEST_SHADING;
  if (next === current) return;
  current = next;
  for (const f of listeners) f();
}
export function onShadingVersion(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }

/** A structure's finish under a shading version (catalog key), or undefined: lit as every structure is. */
export function finishFor(key: string | undefined, version = current): Finish | undefined {
  const t = FINISH_TABLE[version];
  return t ? paletteFinish(key, t) : undefined;
}

/**
 * A finish packed as two texels of an rgba8 texture (rows 2 and 3 of a field's palette texture): (roughness, clear
 * coat, coat roughness, sheen) and (subsurface, head-on reflectance x10, metallic, 255 = has a finish). All zeros =
 * no finish. The head-on reflectance is Fresnel's ((ior - 1) / (ior + 1))^2, 0.02-0.06 for tissue.
 */
export function encodeFinish(f: Finish | undefined): Uint8Array {
  const out = new Uint8Array(8);
  if (!f) return out;
  const b = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const f0 = ((f.ior - 1) / (f.ior + 1)) ** 2;
  out.set([b(f.roughness), b(f.coat), b(f.coatRoughness), b(f.sheen), b(f.subsurface), b(f0 * 10), b(f.metallic), 255]);
  return out;
}

/** The WGSL that lights a finish, as a function called `name` (each field names its own copy, so two fields in one
 *  shader do not collide). Returns the highlight to add to the lit body color. */
export function finishWgsl(name: string): string {
  return `/** A FINISH'S HIGHLIGHT, physically based: the base layer and a clear coat (the wet film on living tissue) each a
 *  GGX lobe with Smith shadowing and Schlick's Fresnel, and sheen as a soft rim of the tissue's own color at grazing
 *  angles. m0 = (roughness, coat, coat roughness, sheen), m1 = (subsurface, reflectance x10, metallic, -). Two-sided,
 *  as the rest of the lighting. A roughness floor of 0.35: the normal comes from a smoothed voxel field, and a sharper
 *  highlight shows its slice steps as ridges (0.25 did, on the sternum, 2026-09-25). */
fn ${name}(n0 : vec3<f32>, v : vec3<f32>, k : vec3<f32>, albedo : vec3<f32>, m0 : vec4<f32>, m1 : vec4<f32>) -> vec3<f32> {
  let n = select(-n0, n0, dot(n0, v) >= 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let ndl = max(dot(n, k), 0.0);
  let sheen = m0.a * 0.6 * pow(1.0 - ndv, 3.0) * albedo;
  if (ndl <= 0.0) { return sheen; }
  let h = normalize(k + v);
  let ndh = max(dot(n, h), 0.0);
  let vdh = max(dot(v, h), 0.0);
  let fres = pow(1.0 - vdh, 5.0);
  let f0 = mix(vec3<f32>(m1.g * 0.1), albedo, m1.b);
  let r = max(m0.r, 0.35); let a2 = r * r * r * r;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let kk = (r + 1.0) * (r + 1.0) / 8.0;
  let g = (ndv / (ndv * (1.0 - kk) + kk)) * (ndl / (ndl * (1.0 - kk) + kk));
  let specBase = (a2 / (3.14159265 * dd * dd)) * g * (f0 + (vec3<f32>(1.0) - f0) * fres) / (4.0 * ndv);
  let cr = max(m0.b, 0.35); let ca2 = cr * cr * cr * cr;
  let cd = ndh * ndh * (ca2 - 1.0) + 1.0;
  let kc = (cr + 1.0) * (cr + 1.0) / 8.0;
  let gc = (ndv / (ndv * (1.0 - kc) + kc)) * (ndl / (ndl * (1.0 - kc) + kc));
  let fc = 0.04 + 0.96 * fres;
  let specCoat = m0.g * (ca2 / (3.14159265 * cd * cd)) * gc * fc / (4.0 * ndv);
  return specBase * (1.0 - m0.g * fc) + vec3<f32>(specCoat) + sheen;
}
`;
}
