// ONE FIELD FOR A SERIES IN TIME (the beating heart's phases): Steve's cine design (docs/SEQUENCES-CINE.md, CineField)
// carried to Albula's own frame fields. Ron, 2026-10-16, on 20-time-point series: "Steve architecture is superior";
// the workspace brief is Contents/docs/CINE-RETHINK.md (step 1).
//
// Each frame keeps the field it already has (its colored field, or its plain one -- both read the frame's CT texture
// on the card); this stands in the 3D view for all of them and shows one at a time. A step points it at another
// frame's field: when that field's shader code is the same as the one shown (same kind, same bindings, same uniform
// block -- the frames of a series normally are), the view only rebuilds its bind group (SceneRenderer.refreshBindings)
// and re-sends the uniforms: no field swapped, no view re-composed, no shader compiled, nothing uploaded. When it is
// not the same (a frame not yet colored beside colored ones), `show` says so and the caller re-composes the view.

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

/** What makes two fields interchangeable under one compiled shader and one bind-group layout. */
export function shaderSignature(f: Field): string {
  return [
    f.kind, f.bindingCount, f.uniformFloats(), f.usesSampler ?? f.bindingCount > 0, !!f.providesSkip, !!f.intervalSampling,
    f.clippable ?? true, !!f.ghost, f.structMembers(0), f.declareBindings(0, 100), f.samplingWGSL(0), f.providesSkip ? f.skipWGSL?.(0) ?? "" : "",
  ].join("\u0001");
}

export class SeriesField implements Field {
  private current: Field;
  private sig: string;
  private transformAll: Field | null | undefined;
  constructor(first: Field) { this.current = first; this.sig = shaderSignature(first); }

  /** Show `f` (another frame's field). True when the shader changed, so the view must be re-composed; false when a
   *  rebind is enough. */
  show(f: Field): boolean {
    if (f === this.current) return false;
    const sig = shaderSignature(f);
    const changed = sig !== this.sig;
    this.current = f; this.sig = sig;
    if (this.transformAll !== undefined) f.transform = this.transformAll;
    return changed;
  }
  /** The shown field changed in place (its owner replaced its textures or its shader): take its signature again. */
  recheck(): void { this.sig = shaderSignature(this.current); }
  /** The frame field shown now. */
  get shown(): Field { return this.current; }

  get kind(): string { return this.current.kind; }
  get bindingCount(): number { return this.current.bindingCount; }
  get modifier(): boolean | undefined { return this.current.modifier; }
  get transform(): Field | null | undefined { return this.current.transform; }
  set transform(t: Field | null | undefined) { this.transformAll = t; this.current.transform = t; }
  get providesSkip(): boolean | undefined { return this.current.providesSkip; }
  get clippable(): boolean | undefined { return this.current.clippable; }
  get ghost(): boolean | undefined { return this.current.ghost; }
  get intervalSampling(): boolean | undefined { return this.current.intervalSampling; }
  get usesSampler(): boolean | undefined { return this.current.usesSampler; }
  skipWGSL(slot: number): string { return this.current.skipWGSL?.(slot) ?? ""; }
  uniformFloats(): number { return this.current.uniformFloats(); }
  structMembers(slot: number): string { return this.current.structMembers(slot); }
  declareBindings(slot: number, base: number): string { return this.current.declareBindings(slot, base); }
  samplingWGSL(slot: number): string { return this.current.samplingWGSL(slot); }
  fillUniforms(out: Float32Array, off: number): void { this.current.fillUniforms(out, off); }
  bindEntries(slot: number, base: number): GPUBindGroupEntry[] { return this.current.bindEntries(slot, base); }
  aabb(): [Vec3, Vec3] { return this.current.aabb(); }
  sampleStep(): number { return this.current.sampleStep(); }
  voxel(): number | undefined { return this.current.voxel?.(); }
  /** The rest of a frame field's surface that the 3D view calls (lighting, texture format, the shared CT). */
  setShade(s: [number, number, number, number]): void { (this.current as { setShade?: (s: [number, number, number, number]) => void }).setShade?.(s); }
  textureFormat(): GPUTextureFormat | undefined { return (this.current as { textureFormat?: () => GPUTextureFormat }).textureFormat?.(); }
  volumeTexture(): GPUTexture | undefined { return (this.current as { volumeTexture?: () => GPUTexture }).volumeTexture?.(); }
  /** The solid look (colorize-field.ts): the renderer's solid pass runs when a placed field says so. */
  isSolid(): boolean { return (this.current as { isSolid?: () => boolean }).isSolid?.() === true; }
  /** Never destroys a frame's field: the frames own them. */
  destroy(): void { /* nothing of its own */ }
}
