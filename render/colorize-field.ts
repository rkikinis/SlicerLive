// ColorizeField — Slicer's "Colorize Volume" (an RGBA volume rendering of a CT tinted by a
// segmentation), except the RGBA is composed IN THE SHADER rather than baked into a texture.
//
// Why not bake. A baked rgba16float volume (what RGBAVolumeField consumes) freezes every
// segment's opacity at bake time: changing one means re-running the bake over the whole volume
// and re-uploading it. Composing per sample instead costs one extra texture fetch and keeps
// each segment's opacity a live uniform — so a slider can fade "all vertebrae" while the ray
// march is running. It also halves the memory: a scalar r16float plus a u8 label volume is
// 3 bytes/voxel against 8 for rgba16float.
//
// The composition, per sample:
//
//     label = textureLoad(labels)           NEAREST — labels must never interpolate
//     if label > 0:  rgb = palette[label].rgb * brightness(ct)     <- segment colour, CT texture
//                    a   = palette[label].a                        <- the group slider
//     else:          rgb, a = ctLUT[ct]                            <- ordinary DVR, for context
//
// So the segment colour carries identity, the CT carries detail, and the two opacity paths are
// independent: group sliders always do something, whatever the CT transfer function is doing.
// Shading normals come from the CT gradient (smooth and detailed) rather than the label field
// (piecewise-constant, so its gradient is a staircase).

import type { Finish } from "../logic/anatomy/palettes.ts";
import { encodeFinish, finishWgsl } from "./shading-versions.ts";
import type { Vec3, Mat4 } from "./mat4.ts";
import {
  patientToTexture, patientToTextureFromIjkToRAS, spacingFromIjkToRAS, volumeAABB,
  volumeAABBFromIjkToRAS,
} from "./mat4.ts";
import { toF16Array } from "./cine-field.ts";
import type { Field } from "./fields.ts";
import { BRICK, BRICK2, BRICK_MIXED, BRICK_THIN, EMPTY_CUTOFF, buildSmoothSolid, makeBrick2Texture, makeBrickTexture, makeSmoothSolidTexture, smoothPasses } from "./solid-smooth.ts";

export interface ColorizeFieldOpts {
  clim: [number, number];                 // HU range the CT LUT spans
  ijkToRAS?: ArrayLike<number>;
  center?: Vec3;
  spacing?: Vec3;
  opacityUnitDistance?: number;
  shade?: [number, number, number, number];
  clippable?: boolean;
  /** Opacity multiplier for UNLABELLED voxels — the surrounding body, drawn by the CT LUT. */
  contextOpacity?: number;
  /** How much the CT modulates a segment's brightness. 0 = flat colour, 1 = full CT texture. */
  ctModulation?: number;
  /** An r16float CT texture of these dims to read instead of uploading `ct`; not destroyed here. */
  adoptCT?: GPUTexture;
  /** An r8uint label texture of these dims to read instead of uploading `labels`; not destroyed here. */
  adoptLabels?: GPUTexture;
  /** The SOLID look: each structure drawn as a hard, lit surface where its labels begin, as the
   *  surface models look, instead of a see-through medium. See `setSolid`. */
  solid?: boolean;
  /** No CT at all: labels only (the solid look over merged segmentations, or a label map loaded
   *  alone). The CT binding is then a single voxel instead of a full-size texture. */
  noCT?: boolean;
}

export class ColorizeField implements Field {
  readonly kind = "clz";
  readonly bindingCount = 6;              // ct (3d f32) + labels (3d u32) + luts (2d) + smoothed solid (3d) + block maps, fine and coarse (3d u32)
  readonly clippable: boolean;
  private dev: GPUDevice;
  private ctTex: GPUTexture;
  private labTex: GPUTexture;
  private lutTex: GPUTexture;             // 256x2: row 0 = CT transfer function, row 1 = palette
  private destroyed = false;
  private p2t: Mat4;
  private box: [Vec3, Vec3];
  private stepMm: number;
  private dims: Vec3;
  private clim: [number, number];
  private shade: [number, number, number, number];
  private unit: number;
  private context: number;
  private ctMod: number;
  /** rgba8 palette rows kept CPU-side so a single segment's alpha can be patched cheaply. */
  private palette = new Uint8Array(256 * 4);
  /** Rows 2 and 3 of the palette texture: each segment's finish (setSegmentMaterial); zeros = none. */
  private material = new Uint8Array(256 * 4 * 2);

  /** Textures this field ADOPTED rather than made; they are someone else's to destroy. */
  private adopted = { ct: false, labels: false };

  constructor(
    dev: GPUDevice,
    ct: ArrayLike<number> | null,        // HU, z-major (nz*ny*nx); null = fill in later via setCT

    labels: ArrayLike<number> | null,    // segment numbers, same grid; null with opts.adoptLabels
    dims: Vec3,
    ctLut: Uint8Array,                   // 256*4 rgba8 from lutFromTransferFunctions
    opts: ColorizeFieldOpts,
  ) {
    this.dev = dev;
    this.dims = dims;
    const size = dims as [number, number, number];

    // r16float, not r32float: half the bytes and filterable in core WebGPU. float16 is exact
    // for integers to 2048, which covers every HU that matters (bone tops out well below).
    //
    // OR ADOPTED: the frames of a sequence already hold their CT as an r16float texture (the
    // slice views and the plain volume rendering share it), and a colorize field over a frame
    // reads that one rather than uploading the CT a second time -- five frames colorized would
    // otherwise be five more 280 MB copies, in a page that has already been killed for memory.
    if (opts.adoptCT) {
      this.ctTex = opts.adoptCT; this.adopted.ct = true;
    } else if (opts.noCT) {
      this.ctTex = dev.createTexture({
        size: [1, 1, 1], dimension: "3d", format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    } else {
      this.ctTex = dev.createTexture({
        size, dimension: "3d", format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      if (ct) this.setCT(ct);
    }

    // r8uint: integer labels, sampled with textureLoad. A filterable format would let the
    // hardware blend segment 5 and segment 40 into segment 22 at every boundary.
    // Adopted likewise: one label texture serves every frame of a sequence the segmentation covers.
    if (opts.adoptLabels) {
      this.labTex = opts.adoptLabels; this.adopted.labels = true;
    } else {
      this.labTex = dev.createTexture({
        size, dimension: "3d", format: "r8uint",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      if (labels) ColorizeField.writeLabels(dev, this.labTex, labels, dims);
    }

    // Four rows: 0 the CT transfer function, 1 each segment's color and opacity, 2 and 3 its finish (setSegmentMaterial).
    this.lutTex = dev.createTexture({
      size: [256, 4], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.setCtLUT(ctLut);

    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      this.stepMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
      this.maxStepMm = Math.max(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      const sp = opts.spacing ?? [1, 1, 1];
      this.p2t = patientToTexture(dims, sp, opts.center ?? [0, 0, 0]);
      this.box = volumeAABB(dims, sp, opts.center ?? [0, 0, 0]);
      this.stepMm = Math.min(...sp);
      this.maxStepMm = Math.max(...sp);
    }
    this.clim = opts.clim;
    this.shade = opts.shade ?? [0.25, 0.80, 0.30, 18];
    this.unit = opts.opacityUnitDistance ?? this.stepMm;
    this.clippable = opts.clippable ?? true;
    this.context = opts.contextOpacity ?? 1;
    this.ctMod = opts.ctModulation ?? 0.55;
    this.smoothTex = makeSmoothSolidTexture(dev, [1, 1, 1]);
    this.brickTex = makeBrickTexture(dev, [1, 1, 1]);
    this.brick2Tex = makeBrick2Texture(dev, [1, 1, 1]);
    this.solid = false;
    if (opts.solid) this.setSolid(true);
  }
  private solid: boolean;
  /**
   * THE SOLID LOOK (Ron, 2026-09-23): "Steve likes the fuzziness as it provides information about the
   * internal structure. I prefer a hard look like the surface rendering. If we get it right, we can
   * get rid of the humongous surface nets and reserve those for models of robots or needles and
   * such. I went down the surface model route because I hated the look of the colorized volumes."
   *
   * What made the colored volume soft, all three at once: (1) a structure's opacity accumulates over
   * depth (per 10 mm), so a thin or grazed structure is partly transparent; (2) its shading normal
   * comes from the CT's gradient, which inside an organ is noise and at the boundary between two
   * organs of similar density is nearly zero -- so the lighting is grainy where there is no edge and
   * flat where there is one; (3) the CT modulates each structure's brightness, which adds the grain.
   *
   * Solid replaces all three with what a surface model does: the structure begins where the
   * smoothed indicator of the visible labels crosses one half (the same 0.5 level surface extraction
   * uses), the ray stops there (or passes on with the structure's own opacity if it is see-through),
   * the normal is the gradient of that indicator, and the color is the label's own, flat. No CT is
   * read for a labeled sample, so it looks the same on any modality.
   */
  /**
   * Turn the solid look on or off. Returns true when the field's TEXTURES changed (the smoothed copy
   * made or released), which the caller must republish so the view rebinds.
   */
  /** The labels hold only visible structures (a hidden one was never written): see fillUniforms. */
  onlyVisibleLabels = false;
  setSolid(on: boolean): boolean {
    this.solid = on;
    if (on && !this.smoothReal) {
      this.smoothTex.destroy();
      this.smoothTex = makeSmoothSolidTexture(this.dev, this.dims as [number, number, number]);
      this.brickTex.destroy();
      this.brickTex = makeBrickTexture(this.dev, this.dims as [number, number, number]);
      this.brick2Tex.destroy();
      this.brick2Tex = makeBrick2Texture(this.dev, this.dims as [number, number, number]);
      this.smoothReal = true;
      this.rebuildSmooth();
      return true;
    }
    if (!on && this.smoothReal) {
      this.smoothTex.destroy();
      this.smoothTex = makeSmoothSolidTexture(this.dev, [1, 1, 1]);
      this.brickTex.destroy();
      this.brickTex = makeBrickTexture(this.dev, [1, 1, 1]);
      this.brick2Tex.destroy();
      this.brick2Tex = makeBrick2Texture(this.dev, [1, 1, 1]);
      this.smoothReal = false;
      return true;
    }
    return false;
  }
  /** The smoothed solid (solid-smooth.ts): one byte per voxel while the solid look is on, a single
   *  voxel otherwise -- the binding has to exist either way. */
  private smoothTex!: GPUTexture;
  /** The block map (solid-smooth.ts, BRICK_WGSL) the solid pass leaps with; one texel when off. */
  private brickTex!: GPUTexture;
  private brick2Tex!: GPUTexture;
  private smoothReal = false;
  private smoothPending = false;
  /** Which labels were visible when the smoothed copy was last made (flushPalette). */
  private visibleMask = "";
  /** The labels' voxels changed (an edit): the smoothed copy must be made again whatever is visible. */
  labelsChanged() { this.visibleMask = ""; }
  /** Visibility decides what is solid, so a palette change rebuilds it -- once per task, however
   *  many segments a slider touched. */
  private rebuildSmooth() {
    if (!this.smoothReal || this.smoothPending) return;
    this.smoothPending = true;
    queueMicrotask(() => {
      this.smoothPending = false;
      if (this.destroyed || !this.smoothReal) return;
      buildSmoothSolid(this.dev, this.labTex, this.lutTex, this.dims as [number, number, number], this.smoothTex, smoothPasses, this.brickTex, this.brick2Tex);
    });
  }
  private maxStepMm = 1;
  /** How wide the solid look's normal is taken, in voxels (of the coarsest spacing). */
  private readonly normalRadius = 1.0;
  isSolid(): boolean { return this.solid; }

  /** A label texture of the shape a ColorizeField adopts, filled from `labels`; the caller owns it. */
  static makeLabelTexture(dev: GPUDevice, labels: ArrayLike<number>, dims: Vec3): GPUTexture {
    const tex = dev.createTexture({
      size: dims as [number, number, number], dimension: "3d", format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    ColorizeField.writeLabels(dev, tex, labels, dims);
    return tex;
  }

  private static writeLabels(dev: GPUDevice, tex: GPUTexture, labels: ArrayLike<number>, dims: Vec3): void {
    // Copy BY VALUE into a real Uint8Array rather than trusting the caller's array type.
    // fetchZarrVolume returns a Float32Array whatever the stored dtype is — its `dtype` only
    // decodes the chunk — so a "|u1" label volume arrives as floats. Handing that straight to
    // writeTexture reinterprets 4-byte floats as 4 separate label bytes and the labelmap comes
    // out as scattered noise, while every value-based read of the same array looks correct.
    // A plain loop, NOT Uint8Array.from(labels, fn): the callback form measured 3979 ms for this
    // volume's 55.5 M elements against 80 ms here. Same trap as f32tof16 — per-element function
    // call overhead at this scale is seconds of blocked main thread.
    let lab8: Uint8Array;
    if (labels instanceof Uint8Array) {
      lab8 = labels;
    } else {
      lab8 = new Uint8Array(labels.length);
      for (let i = 0; i < labels.length; i++) lab8[i] = labels[i];
    }
    dev.queue.writeTexture({ texture: tex }, lab8, { bytesPerRow: dims[0], rowsPerImage: dims[1] }, dims as [number, number, number]);
  }

  /** Upload (or replace) the CT scalars. Separated from the constructor so the label volume —
   *  which compresses to under a megabyte — can be shown as flat coloured surfaces while the
   *  60 MB CT is still streaming. */
  setCT(ct: ArrayLike<number>) {
    this.dev.queue.writeTexture({ texture: this.ctTex }, toF16Array(ct),
      { bytesPerRow: this.dims[0] * 2, rowsPerImage: this.dims[1] }, this.dims as [number, number, number]);
    this.hasCt = true;
  }
  private hasCt = false;
  get ctLoaded(): boolean { return this.hasCt; }
  /** 0 = flat segment colour (surface look), 1 = full CT brightness modulation. */
  setCtModulation(m: number) { this.ctMod = m; }

  /** The 256x2 palette texture (row 1 = segment colour + opacity), shared with the 2D slice
   *  overlay so one group slider governs both views. */
  paletteTexture(): GPUTexture { return this.lutTex; }

  /** Swap the CT transfer function (row 0). Segment colours and opacities are untouched. */
  /**
   * Release the GPU textures. WITHOUT THIS THEY LEAK, and they are not small.
   *
   * At Ron's 768x768x709 volume this object holds 836 MB (ctTex, r16float) plus 418 MB (labTex,
   * r8uint) -- about 1.25 GB apiece. `slot.colorField = new ColorizeField(...)` replaced the old one
   * by assignment, and a GPUTexture is not reclaimed by the garbage collector, so every rebuild
   * added another 1.25 GB that nothing could ever free. The rebuild ran on EVERY segmentation
   * upsert, including each visibility toggle.
   *
   * Ron, loading a volume and two segmentations at once and then touching nothing: "The coarse image
   * came up and stayed up for 10-20 seconds ... But the image went away." That is the second
   * labelmap finishing its fetch and the second field being allocated on top of the first.
   *
   * Idempotent: destroying twice is a no-op, because the teardown paths that call it are not the
   * only ones that could.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.adopted.ct) this.ctTex.destroy();
    if (!this.adopted.labels) this.labTex.destroy();
    this.lutTex.destroy();
    this.smoothTex.destroy();
    this.brickTex.destroy();
    this.brick2Tex.destroy();
  }

  setCtLUT(lut: Uint8Array) {
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 0] }, lut, { bytesPerRow: 256 * 4 }, [256, 1]);
  }

  /** Set a segment's display colour (0..1 rgb). Call flushPalette() after a batch. */
  setSegmentColor(num: number, rgb: [number, number, number]) {
    const o = num * 4;
    this.palette[o] = Math.round(rgb[0] * 255);
    this.palette[o + 1] = Math.round(rgb[1] * 255);
    this.palette[o + 2] = Math.round(rgb[2] * 255);
  }
  /** Set a segment's opacity (0..1) — this is what a group slider drives. */
  setSegmentOpacity(num: number, a: number) {
    this.palette[num * 4 + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
  getSegmentOpacity(num: number): number { return this.palette[num * 4 + 3] / 255; }
  /**
   * A SEGMENT'S FINISH under the shading version in use (render/shading-versions.ts finishFor), or none -- then it is lit as
   * every structure is under v1. Rows 2 and 3 of the palette texture, packed by encodeFinish. Call flushPalette()
   * after a batch.
   */
  setSegmentMaterial(num: number, f: Finish | undefined) {
    const e = encodeFinish(f);                                   // render/shading-versions.ts: the packing is the shading's
    this.material.set(e.subarray(0, 4), num * 4);
    this.material.set(e.subarray(4, 8), 256 * 4 + num * 4);
  }
  /** Upload the palette row and the finish rows. 3 KB — cheap enough to call on every slider tick. */
  flushPalette() {
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 1] }, this.palette, { bytesPerRow: 256 * 4 }, [256, 1]);
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 2] }, this.material, { bytesPerRow: 256 * 4 }, [256, 2]);
    // Only WHICH structures are visible changes the smoothed copy; a color or an opacity is this 1 KB
    // write. Rebuilding on every change cost ~0.44 s and 1.25 GB of scratch at 768x768x709 (critic,
    // finding 7).
    let mask = "";
    for (let l = 0; l < 256; l++) mask += this.palette[l * 4 + 3] > 0 ? "1" : "0";
    if (mask !== this.visibleMask) { this.visibleMask = mask; this.rebuildSmooth(); }
  }

  setContextOpacity(v: number) { this.context = v; }
  getContextOpacity(): number { return this.context; }
  setClim(lo: number, hi: number) { this.clim = [lo, hi]; }
  getClim(): [number, number] { return [this.clim[0], this.clim[1]]; }
  setShade(s: [number, number, number, number]) { this.shade = s; }
  /** The CT scalar texture, so a SliceRenderer can show the same voxels in the 2D views. */
  volumeTexture(): GPUTexture { return this.ctTex; }
  /** RAS(patient) -> texture[0,1], the same matrix the 2D slice renderer needs. */
  patientToTexture(): Mat4 { return this.p2t; }
  labelTexture(): GPUTexture { return this.labTex; }

  /**
   * EMPTY-SPACE SKIPPING for the trace. With the solid look on and no surrounding body shown, the
   * solid pass has already drawn everything this field draws, so the trace has nothing to find in it:
   * without this every pixel still marched the whole volume at a fraction of a voxel per step, sampled
   * nothing, and paid for it (the bench, 2026-09-23). Otherwise the distance to the field's box, the
   * renderer's own default.
   */
  readonly providesSkip = true;
  skipWGSL(s: number): string {
    const [lo, hi] = this.box;
    const f = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(6);
    return /* wgsl */ `
fn skip_clz${s}(wp : vec3<f32>) -> f32 {
  if (g_solid_prepass && u_material.clz${s}_params.w > 0.5 && u_material.clz${s}_params.y <= 0.0) { return 1.0e6; }
  let q = max(vec3<f32>(${f(lo[0])}, ${f(lo[1])}, ${f(lo[2])}) - wp, wp - vec3<f32>(${f(hi[0])}, ${f(hi[1])}, ${f(hi[2])}));
  return length(max(q, vec3<f32>(0.0)));
}`;
  }

  uniformFloats() { return 32; }          // mat4(16) + clim(4) + shade(4) + params(4) + dims(4)
  aabb(): [Vec3, Vec3] { return this.box; }
  sampleStep(): number { return this.stepMm; }

  structMembers(s: number): string {
    return [
      `  clz${s}_p2t : mat4x4<f32>,`,
      `  clz${s}_clim : vec4<f32>,`,      // lo, hi, coarsest spacing (mm), solid normal radius (x that)
      `  clz${s}_shade : vec4<f32>,`,     // ka, kd, ks, shininess
      `  clz${s}_params : vec4<f32>,`,    // opacity_unit_distance, contextOpacity, ctModulation, solid
      `  clz${s}_dims : vec4<f32>,`,      // nx, ny, nz, smallest voxel spacing (mm)
    ].join("\n");
  }

  declareBindings(s: number, base: number): string {
    return [
      `@group(0) @binding(${base}) var t_ct_clz${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 1}) var t_lab_clz${s} : texture_3d<u32>;`,
      `@group(0) @binding(${base + 2}) var t_lut_clz${s} : texture_2d<f32>;`,
      `@group(0) @binding(${base + 3}) var t_smooth_clz${s} : texture_3d<f32>;`,
      `@group(0) @binding(${base + 4}) var t_brick_clz${s} : texture_3d<u32>;`,
      `@group(0) @binding(${base + 5}) var t_brick2_clz${s} : texture_3d<u32>;`,
    ].join("\n");
  }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn tex_clz${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.clz${s}_p2t * vec4<f32>(transform_point_clz${s}(wp), 1.0);
  return t4.xyz;
}
fn ct_clz${s}(wp : vec3<f32>) -> f32 {
  let t = clamp(tex_clz${s}(wp), vec3<f32>(0.0), vec3<f32>(1.0));
  return textureSampleLevel(t_ct_clz${s}, s_lin, t, 0.0).r;
}
/** Normalised CT position in the LUT, 0..1 across clim. */
fn ctnorm_clz${s}(hu : f32) -> f32 {
  let lo = u_material.clz${s}_clim.x; let hi = u_material.clz${s}_clim.y;
  return clamp((hu - lo) / max(hi - lo, 1e-6), 0.0, 1.0);
}
/** The scalar used for the shading gradient: the normalised CT itself.
 *
 *  NOT the LUT alpha. Most CT presets are near step functions in opacity (CT-Soft-Tissue is
 *  flat 1.0 above -160 HU), so the alpha gradient is zero through the whole interior and
 *  enormous on one noisy isosurface — shading then flips between ambient-only and fully lit
 *  from voxel to voxel and the volume renders as banded moire. The CT scalar is smooth
 *  everywhere and its gradient is the real anatomical surface normal. */
fn galpha_clz${s}(wp : vec3<f32>) -> f32 {
  return ctnorm_clz${s}(ct_clz${s}(wp));
}
/** Trilinear occupancy of the given segment around a texture coordinate: the fraction of the eight
 *  surrounding voxels carrying that label, weighted as trilinear interpolation would.
 *
 *  Labels cannot be interpolated by the hardware (blending 5 and 40 gives 22), so the label
 *  fetch is NEAREST — which makes every organ boundary a voxel staircase. At 1.25 mm slice
 *  spacing a rib is only a few voxels thick, and marching a ray through hard 0/1 opacity across
 *  those steps produces the moire banding you see on thin structures. Interpolating the
 *  INDICATOR of the nearest label instead is exact at voxel centres, smooth in between, and
 *  antialiases the surface without ever inventing a label that is not there. */
fn occupancy_clz${s}(tex : vec3<f32>, d : vec3<f32>, lab : i32) -> f32 {
  let p = tex * d - vec3<f32>(0.5);
  let b = floor(p);
  let f = p - b;
  var occ = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let c = vec3<f32>(f32(i & 1), f32((i >> 1) & 1), f32((i >> 2) & 1));
    let w = ((1.0 - c.x) + (2.0 * c.x - 1.0) * f.x)
          * ((1.0 - c.y) + (2.0 * c.y - 1.0) * f.y)
          * ((1.0 - c.z) + (2.0 * c.z - 1.0) * f.z);
    let vi = vec3<i32>(clamp(b + c, vec3<f32>(0.0), d - vec3<f32>(1.0)));
    if (i32(textureLoad(t_lab_clz${s}, vi, 0).r) == lab) { occ = occ + w; }
  }
  return occ;
}
/** SOLID LOOK: at a patient-space point, the trilinear occupancy of ALL VISIBLE labels together (x)
 *  and the visible label holding the most of it (y). "Visible" is the palette's opacity, so hiding
 *  a structure removes it from the solid, exactly as it removes its surface. */
fn visocc_clz${s}(wp : vec3<f32>) -> vec2<f32> {
  // OUTSIDE THE SCAN THERE IS NOTHING. The voxel reads below clamp to the edge, so without this the
  // last slice repeated outward and the femurs ran on as tubes past the end of the scan (Ron,
  // 2026-09-23: "There is an artifact at the bottom end of the rendering"). With it, a structure
  // cut by the edge is closed there by a flat end, as a surface model is.
  let t0 = tex_clz${s}(wp);
  if (any(t0 < vec3<f32>(0.0)) || any(t0 > vec3<f32>(1.0))) { return vec2<f32>(0.0); }
  let d = u_material.clz${s}_dims.xyz;
  let p = t0 * d - vec3<f32>(0.5);
  let b = floor(p);
  let f = p - b;
  var labs : array<i32, 8>;
  var ws : array<f32, 8>;
  var n = 0;
  var occ = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let c = vec3<f32>(f32(i & 1), f32((i >> 1) & 1), f32((i >> 2) & 1));
    let w = ((1.0 - c.x) + (2.0 * c.x - 1.0) * f.x)
          * ((1.0 - c.y) + (2.0 * c.y - 1.0) * f.y)
          * ((1.0 - c.z) + (2.0 * c.z - 1.0) * f.z);
    let vi = vec3<i32>(clamp(b + c, vec3<f32>(0.0), d - vec3<f32>(1.0)));
    let lab = i32(textureLoad(t_lab_clz${s}, vi, 0).r);
    if (lab <= 0) { continue; }
    if (u_material.clz${s}_params.w < 1.5 && textureLoad(t_lut_clz${s}, vec2<i32>(lab, 1), 0).a <= 0.001) { continue; }
    occ = occ + w;
    var found = false;
    for (var j = 0; j < n; j = j + 1) { if (labs[j] == lab) { ws[j] = ws[j] + w; found = true; break; } }
    if (!found) { labs[n] = lab; ws[n] = w; n = n + 1; }
  }
  var best = 0; var bw = -1.0;
  for (var j = 0; j < n; j = j + 1) { if (ws[j] > bw) { bw = ws[j]; best = labs[j]; } }
  return vec2<f32>(occ, f32(best));
}
/** SOLID LOOK: the smoothed solid at a patient-space point, 0..1, filtered by the card. */
fn smooth_clz${s}(wp : vec3<f32>) -> f32 {
  let t = tex_clz${s}(wp);
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }   // nothing outside the scan
  return textureSampleLevel(t_smooth_clz${s}, s_lin, t, 0.0).r;
}
/** SOLID LOOK: the nearest voxel's label if it is visible, else 0. One fetch (two with the palette). */
fn vislab_clz${s}(wp : vec3<f32>) -> i32 {
  let d = u_material.clz${s}_dims.xyz;
  let vi = vec3<i32>(clamp(floor(tex_clz${s}(wp) * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
  let lab = i32(textureLoad(t_lab_clz${s}, vi, 0).r);
  if (lab <= 0) { return 0; }
  if (u_material.clz${s}_params.w < 1.5 && textureLoad(t_lut_clz${s}, vec2<i32>(lab, 1), 0).a <= 0.001) { return 0; }
  return lab;
}
/** SOLID LOOK: the outward normal of the whole visible solid, from the smoothed copy (solid-smooth.ts).
 *  Taken from the labels themselves it follows every step between slices and the organ shows
 *  contour lines like wood grain (first render, 2026-09-23); the blurred copy smooths them away, as
 *  surface nets does when it builds a mesh. One coarsest voxel either side (times a tuning factor). */
fn solid_nrm_smooth_clz${s}(hit : vec3<f32>, rd : vec3<f32>) -> vec3<f32> {
  let h = max(u_material.clz${s}_clim.z, 1e-3) * max(u_material.clz${s}_clim.w, 0.25);
  let g = vec3<f32>(
    smooth_clz${s}(hit + vec3<f32>(h,0,0)) - smooth_clz${s}(hit - vec3<f32>(h,0,0)),
    smooth_clz${s}(hit + vec3<f32>(0,h,0)) - smooth_clz${s}(hit - vec3<f32>(0,h,0)),
    smooth_clz${s}(hit + vec3<f32>(0,0,h)) - smooth_clz${s}(hit - vec3<f32>(0,0,h)));
  let glen = length(g);
  if (glen > 1e-6) { return -g / glen; }
  return -rd;
}
/** SOLID LOOK: the normal of the wall between two structures, from ONE label's occupancy. The smoothed
 *  copy is of all visible structures together and is flat across such a wall. */
fn solid_nrm_label_clz${s}(hit : vec3<f32>, lab : i32, rd : vec3<f32>) -> vec3<f32> {
  // WIDE, like the smoothed copy's: one voxel either side follows the label's steps and a contact
  // seen through a see-through structure showed a fine grid (2026-09-23). Two and a half coarsest
  // voxels either side (one radius: two cost twice the reads for no visible difference).
  let d = u_material.clz${s}_dims.xyz;
  let c = max(u_material.clz${s}_clim.z, 1e-3);
  var g = vec3<f32>(0.0);
  {
    let h = c * 2.5;
    g = vec3<f32>(
      occupancy_clz${s}(tex_clz${s}(hit + vec3<f32>(h,0,0)), d, lab) - occupancy_clz${s}(tex_clz${s}(hit - vec3<f32>(h,0,0)), d, lab),
      occupancy_clz${s}(tex_clz${s}(hit + vec3<f32>(0,h,0)), d, lab) - occupancy_clz${s}(tex_clz${s}(hit - vec3<f32>(0,h,0)), d, lab),
      occupancy_clz${s}(tex_clz${s}(hit + vec3<f32>(0,0,h)), d, lab) - occupancy_clz${s}(tex_clz${s}(hit - vec3<f32>(0,0,h)), d, lab));
  }
  let glen = length(g);
  if (glen > 1e-6) { return -g / glen; }
  return -rd;
}
/** SOLID LOOK: structure lab lit at a surface with normal n, premultiplied by its own opacity.
 *
 *  LIT EXACTLY AS THE SURFACE MODELS ARE (scene-renderer.ts, fs_mesh), both ways they can be lit.
 *  Plain: a headlight, ambient plus diffuse on |n.l|, the highlight as |n.l| to the shininess.
 *  Drawing look (on by default): a sky/ground hemisphere on the camera's up plus a key light from
 *  the upper left -- which is why the light seemed to come from elsewhere on the colored volume
 *  (Ron, 2026-09-23: "the light source is in a different position ... Look at stomach and small
 *  bowel"): it was a headlight beside meshes lit from the upper left. Either way the color is
 *  raised to the surfaces' gamma (1.6) and the highlight added after it, in linear light. */
fn solid_shade_clz${s}(lab : i32, n : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  if (lab <= 0) { return vec4<f32>(0.0); }
  let pal = textureLoad(t_lut_clz${s}, vec2<i32>(lab, 1), 0);
  let ka = u_material.clz${s}_shade.x; let kd = u_material.clz${s}_shade.y;
  let ks = u_material.clz${s}_shade.z; let sh = u_material.clz${s}_shade.w;
  let l = -rd;
  // THE STRUCTURE'S OWN FINISH, when it has one (rows 2 and 3; setSegmentMaterial): its highlight is physically based
  // and its own, and subsurface light softens where its surface turns from the light.
  let m1 = textureLoad(t_lut_clz${s}, vec2<i32>(lab, 3), 0);
  let fin = m1.a > 0.5;
  let wrap = select(0.0, 0.5 * m1.r, fin);
  var key = l;
  var body : f32;
  var hilite : f32;
  if (u_cam.look.w > 0.5) {
    let up = u_cam.look.xyz;
    let right = normalize(cross(l, up));
    key = normalize(l * 0.5 + up * 0.8 - right * 0.35);
    let hemi = 0.5 + 0.5 * dot(n, up);
    let ndk = abs(dot(n, key));
    let gloss = clamp(ks, 0.0, 1.0);
    let keyMix = 0.45 + 0.25 * gloss;
    body = ka + kd * ((1.0 - keyMix) * hemi + keyMix * (ndk + wrap) / (1.0 + wrap));
    hilite = select(0.0, 1.5 * gloss * pow(ndk, max(sh * 0.35, 1.0)), gloss > 0.0);
  } else {
    let ndl = abs(dot(n, l));
    body = ka + kd * (ndl + wrap) / (1.0 + wrap);
    hilite = select(0.0, ks * pow(ndl, max(sh, 1.0)), ks > 0.0);
  }
  // 1.6 = SURFACE_COLOUR_GAMMA in scene-renderer.ts (fs_mesh): change both together.
  let base = pow(clamp(pal.rgb * body, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.6));
  var lit : vec3<f32>;
  // A metal has no body color of its own; what it shows is its surroundings, tinted -- here the same light the body
  // gets, so an implant keeps its color instead of going black away from its highlight.
  // THE LIGHTING PRESET STILL GOVERNS THE HIGHLIGHT (Ron, 2026-09-25: "lighting has little effect: matte is still
  // glossy"). The finish decides the highlight's shape and color; the preset's strength scales it, relative to
  // Glossy's 0.15 (light-presets.ts), the default the finishes were chosen under: Matte none, Standard a third.
  let fk = clamp(ks / 0.15, 0.0, 3.0);
  if (fin) { lit = clamp(base * (1.0 - 0.1 * m1.b) + fk * finish_spec_clz${s}(n, l, key, pal.rgb, textureLoad(t_lut_clz${s}, vec2<i32>(lab, 2), 0), m1), vec3<f32>(0.0), vec3<f32>(1.0)); }
  else { lit = clamp(base + vec3<f32>(hilite), vec3<f32>(0.0), vec3<f32>(1.0)); }
  return vec4<f32>(lit * pal.a, pal.a);
}
${finishWgsl(`finish_spec_clz${s}`)}/** SOLID LOOK: does the block map mark this point's block as holding a structure too thin for the blur? */
fn solid_thin_block_clz${s}(wp : vec3<f32>) -> bool {
  let t0 = tex_clz${s}(wp);
  if (any(t0 < vec3<f32>(0.0)) || any(t0 > vec3<f32>(1.0))) { return false; }
  let bt = t0 * u_material.clz${s}_dims.xyz;
  let bdim = vec3<f32>(textureDimensions(t_brick_clz${s}));
  return textureLoad(t_brick_clz${s}, vec3<i32>(clamp(floor(bt / ${BRICK}.0), vec3<f32>(0.0), bdim - vec3<f32>(1.0))), 0).r == ${BRICK_THIN}u;
}
/**
 * SOLID LOOK: which structure a point is in, 0 for none, given the one the ray is in now (cur).
 *
 * INSIDE IS DECIDED ON THE SMOOTHED COPY, which has no voxel steps. Decided on the labels, a ray
 * grazing a see-through structure, or the contact between two, crossed the steps in and out again
 * and again, every crossing added a wall, and the result was a fine grid of dots (Ron's screenshot,
 * 2026-09-23, reproduced on the liver lying over the stomach). The labels still decide in one case:
 * a structure too thin to reach one half in the smoothed copy (a small vessel) -- inside by the
 * labels, and no large structure's smooth surface within a voxel and a half.
 *
 * WHICH structure changes only when the new one clearly holds the point: the one the ray is in is
 * kept while it still has a third of the neighborhood, so a ray running along a contact does not
 * flicker between the two.
 */
fn solid_class_clz${s}(wp : vec3<f32>, cur : i32, rd : vec3<f32>) -> i32 {
  let sm = smooth_clz${s}(wp);
  let d = u_material.clz${s}_dims.xyz;
  let coarse = max(u_material.clz${s}_clim.z, 1e-3);
  // Under the cut-off is outside: half what a lone labeled voxel reaches under the blur
  // (solid-smooth.ts EMPTY_CUTOFF), so no single voxel falls under it (critic, finding 12).
  if (sm < ${EMPTY_CUTOFF.toFixed(5)}) { return 0; }
  if (sm >= 0.5) {
    let nl = vislab_clz${s}(wp);
    if (cur > 0) {
      if (nl == cur || nl == 0) { return cur; }
      if (occupancy_clz${s}(tex_clz${s}(wp), d, cur) >= 0.35) { return cur; }
      return nl;
    }
    if (nl > 0) { return nl; }
    // In the smoothed copy's margin, where no voxel is labeled: the structure just ahead.
    let v = visocc_clz${s}(wp);
    if (v.y > 0.0) { return i32(v.y); }
    let a1 = vislab_clz${s}(wp + rd * coarse);
    if (a1 > 0) { return a1; }
    return vislab_clz${s}(wp + rd * (2.0 * coarse));
  }
  // Between the smoothed copy's edge and its half-level: only a structure too thin for the blur can
  // be inside here, and the block map marks the blocks that hold one (BRICK_THIN). Elsewhere this
  // is outside without reading a label -- most of the reads near surfaces were this check.
  if (!solid_thin_block_clz${s}(wp)) { return 0; }
  let v = visocc_clz${s}(wp);
  if (v.x < 0.5) { return 0; }
  // A step of a LARGE structure (its smoothed surface is within a voxel and a half, and it is the SAME
  // structure there) defers to the smooth surface. Asked of any structure, this cut a thin vessel off
  // for a voxel and a half next to the organ it leaves -- 5.6 mm with 5 mm slices (critic, finding 3).
  let lv = i32(v.y);
  let r = coarse * 1.5;
  var mx = 0.0;
  for (var a = 0; a < 6; a = a + 1) {
    var o = vec3<f32>(0.0);
    o[a / 2] = select(-r, r, (a & 1) == 0);
    let q = wp + o;
    if (vislab_clz${s}(q) == lv) { mx = max(mx, smooth_clz${s}(q)); }
  }
  if (mx >= 0.5) { return 0; }
  if (cur > 0 && occupancy_clz${s}(tex_clz${s}(wp), d, cur) >= 0.35) { return cur; }
  return i32(v.y);
}
/**
 * SOLID LOOK: the wall between pw (in structure la, 0 = none) and wp (in lb), lit and premultiplied:
 * a surface model's face, BOTH sides -- where the ray enters a structure, where it leaves it, and
 * between two the back of one and the front of the other. A see-through surface model shows its
 * front and its back; drawing only the entries made the lungs half as opaque (Ron, 2026-09-23).
 * Placed at the crossing, found by bisection: on the step grid, its distance jumped from pixel to
 * pixel and the drawing look's outline pass drew the jumps.
 */
fn solid_wall_clz${s}(pw : vec3<f32>, wp : vec3<f32>, la : i32, lb : i32, rd : vec3<f32>) -> vec4<f32> {
  // THE CROSSING BY BISECTION, one read a step (a sixteenth of a step in four): the smoothed copy
  // for a wall into or out of the solid (the labels' occupancy where the structure is too thin for
  // the smoothed copy to reach one half), the nearest label for a wall between two structures. The
  // full classifier here cost up to sixteen reads a step, and a ray through the see-through lungs
  // meets several walls (the bench, 2026-09-23: see-through structures doubled the frame).
  var lo = pw; var hi = wp;
  if (la > 0 && lb > 0) {
    for (var k = 0; k < 4; k = k + 1) {
      let mid = 0.5 * (lo + hi);
      if (vislab_clz${s}(mid) == lb) { hi = mid; } else { lo = mid; }
    }
  } else {
    let inside = select(pw, wp, lb > 0);
    let bySmooth = smooth_clz${s}(inside) >= 0.5;
    for (var k = 0; k < 4; k = k + 1) {
      let mid = 0.5 * (lo + hi);
      var inMid : bool;
      if (bySmooth) { inMid = smooth_clz${s}(mid) >= 0.5; } else { inMid = visocc_clz${s}(mid).x >= 0.5; }
      if (inMid == (la > 0)) { lo = mid; } else { hi = mid; }
    }
  }
  var n : vec3<f32>;
  if (la > 0 && lb > 0) { n = solid_nrm_label_clz${s}(hi, lb, rd); }
  else { n = solid_nrm_smooth_clz${s}(hi, rd); }
  let cb = solid_shade_clz${s}(lb, n, rd);
  // Into an OPAQUE structure from a see-through one, only the front of the one entered: in the
  // merged segmentations a vessel is carved out of the lung around it, and the lung's inner wall
  // there -- which the surface models do not have, the whole-body lung including its vessels --
  // laid a second veil over every vessel (2026-09-23, the first merged picture).
  var ca = vec4<f32>(0.0);
  if (!(la > 0 && lb > 0 && cb.a >= 0.99)) { ca = solid_shade_clz${s}(la, n, rd); }
  g_solid_p = hi; g_solid_n = n;                            // for the solid pass's distance and normal
  return ca + (1.0 - ca.a) * cb;
}
/** SOLID LOOK: how far the ray may leap from wp without meeting a wall, given the structure it is in
 *  (0 = none): to the far side of the current 8-voxel block when the block map says that block is
 *  empty (and the ray is outside) or all one structure (and the ray is in it); 0 otherwise. The
 *  texture mapping is affine, so the block's far side is a straight division per axis. */
fn solid_skip_clz${s}(wp : vec3<f32>, rd : vec3<f32>, lab : i32) -> f32 {
  let t0 = tex_clz${s}(wp);
  let d = u_material.clz${s}_dims.xyz;
  let v = t0 * d;
  let vd = (tex_clz${s}(wp + rd) - t0) * d;                // voxels per millimeter along the ray
  // OUTSIDE THIS VOLUME there is nothing of it: the leap is to where the ray enters it (a margin of one
  // voxel short), or past everything if it never does. Answering 0 here stopped every leap outside a
  // second, small volume, and the frame cost three times as much (critic, finding 6).
  if (any(t0 < vec3<f32>(0.0)) || any(t0 > vec3<f32>(1.0))) {
    var tIn = -1e30; var tOut = 1e30;
    for (var a = 0; a < 3; a = a + 1) {
      if (abs(vd[a]) < 1e-9) { if (v[a] < 0.0 || v[a] > d[a]) { return 1e6; } continue; }
      let t1 = (0.0 - v[a]) / vd[a]; let t2 = (d[a] - v[a]) / vd[a];
      tIn = max(tIn, min(t1, t2)); tOut = min(tOut, max(t1, t2));
    }
    if (tOut < max(tIn, 0.0)) { return 1e6; }
    let perVoxel = 1.0 / max(length(vd), 1e-6);
    return max(tIn - perVoxel, 0.0);
  }
  // Coarse block first (64 voxels), then the fine one (8): the first that allows it sets the leap.
  var size = 0.0;
  var bi = vec3<f32>(0.0);
  let bd2 = vec3<f32>(textureDimensions(t_brick2_clz${s}));
  let b2i = clamp(floor(v / ${BRICK * BRICK2}.0), vec3<f32>(0.0), bd2 - vec3<f32>(1.0));
  let b2 = textureLoad(t_brick2_clz${s}, vec3<i32>(b2i), 0).r;
  if ((b2 == 0u && lab == 0) || (b2 != 0u && b2 < ${BRICK_THIN}u && i32(b2) == lab)) { size = ${BRICK * BRICK2}.0; bi = b2i; }
  else {
    let bd = vec3<f32>(textureDimensions(t_brick_clz${s}));
    let b1i = clamp(floor(v / ${BRICK}.0), vec3<f32>(0.0), bd - vec3<f32>(1.0));
    let b = textureLoad(t_brick_clz${s}, vec3<i32>(b1i), 0).r;
    if ((b == 0u && lab == 0) || (b != 0u && b < ${BRICK_THIN}u && i32(b) == lab)) { size = ${BRICK}.0; bi = b1i; }
  }
  if (size == 0.0) { return 0.0; }
  let lo = bi * size; let hi = lo + vec3<f32>(size);
  var te = 1e30;
  for (var a = 0; a < 3; a = a + 1) {
    if (vd[a] > 1e-6) { te = min(te, (hi[a] - v[a]) / vd[a]); }
    else if (vd[a] < -1e-6) { te = min(te, (lo[a] - v[a]) / vd[a]); }
  }
  return max(te, 0.0);
}
/** SOLID LOOK, for the pick only (the jittered trace, no state): a wall between two steps back and
 *  here, or -1 outside every structure. The solid pass (fs_solid) walks the ray with state instead. */
fn solid_clz${s}(wp : vec3<f32>, rd : vec3<f32>, back : f32) -> vec4<f32> {
  // Names the block map, which only the solid pass reads: every entry point's layout must hold
  // every binding the renderer supplies, or the bind group is refused (2026-09-23).
  if (textureDimensions(t_brick_clz${s}).x == 0u || textureDimensions(t_brick2_clz${s}).x == 0u) { return vec4<f32>(0.0); }
  let pw = wp - rd * back;
  let lb = solid_class_clz${s}(wp, 0, rd);
  let la = solid_class_clz${s}(pw, 0, rd);
  if (lb == 0 && la == 0) { return vec4<f32>(-1.0); }
  if (la == lb) { return vec4<f32>(0.0); }
  return solid_wall_clz${s}(pw, wp, la, lb, rd);
}
fn sample_field_clz${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let tex = tex_clz${s}(wp);
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  if (u_material.clz${s}_params.w > 0.5) {
    // The structures themselves are drawn by the renderer's solid pass (fs_solid), into the
    // surfaces' targets; the trace draws only what is around them. The pick still finds them here.
    if (g_solid_prepass) {
      if (u_material.clz${s}_params.y <= 0.0) { return vec4<f32>(0.0); }   // no body shown: nothing left to draw
      if (visocc_clz${s}(wp).x >= 0.5) { return vec4<f32>(0.0); }
    } else {
      let sc = solid_clz${s}(wp, rd, 2.0 * max(u_material.scene.x, 1e-3));
      if (sc.a >= 0.0) { return sc; }
    }
    // outside every structure: the unlabeled body, if it is shown at all
    let ctx = u_material.clz${s}_params.y;
    if (ctx <= 0.0) { return vec4<f32>(0.0); }
  }
  let hu = textureSampleLevel(t_ct_clz${s}, s_lin, tex, 0.0).r;
  let tn = ctnorm_clz${s}(hu);
  let ctc = textureSampleLevel(t_lut_clz${s}, s_lin, vec2<f32>(tn, 0.125), 0.0);   // the middle of row 0 of 4

  // NEAREST label fetch. textureLoad takes voxel indices, so scale out of [0,1].
  let d = u_material.clz${s}_dims.xyz;
  let vi = vec3<i32>(clamp(floor(tex * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
  let lab = i32(textureLoad(t_lab_clz${s}, vi, 0).r);

  var rgb : vec3<f32>;
  var dens : f32;
  if (lab > 0 && u_material.clz${s}_params.w <= 0.5) {
    let pal = textureLoad(t_lut_clz${s}, vec2<i32>(lab, 1), 0);
    // CT modulates BRIGHTNESS so organs keep their internal texture, but not opacity — the
    // group slider alone owns that, so it still works under a bone-only transfer function.
    let m = u_material.clz${s}_params.z;
    rgb = pal.rgb * ((1.0 - m) + m * (0.35 + 1.30 * tn));
    dens = pal.a * occupancy_clz${s}(tex, d, lab);
  } else {
    rgb = ctc.rgb;
    dens = ctc.a * u_material.clz${s}_params.y;
  }
  if (dens <= 0.001) { return vec4<f32>(0.0); }

  let step = u_material.scene.x;
  let unit = max(u_material.clz${s}_params.x, 1e-3);
  let opacity = clamp(1.0 - pow(1.0 - clamp(dens, 0.0, 1.0), step / unit), 0.0, 1.0);
  if (opacity <= 0.001) { return vec4<f32>(0.0); }

  let h = step * 2.0;
  let g = vec3<f32>(
    galpha_clz${s}(wp + vec3<f32>(h,0,0)) - galpha_clz${s}(wp - vec3<f32>(h,0,0)),
    galpha_clz${s}(wp + vec3<f32>(0,h,0)) - galpha_clz${s}(wp - vec3<f32>(0,h,0)),
    galpha_clz${s}(wp + vec3<f32>(0,0,h)) - galpha_clz${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  let ka = u_material.clz${s}_shade.x; let kd = u_material.clz${s}_shade.y;
  let ks = u_material.clz${s}_shade.z; let sh = u_material.clz${s}_shade.w;
  var lit_srgb = rgb * ka;
  if (glen > 1e-6) {
    var n = g / glen;
    if (dot(n, -rd) < 0.0) { n = -n; }
    let view_dir = normalize(-rd);
    let ldotn = dot(view_dir, n);
    if (ldotn > 0.0) {
      let refl = normalize(2.0 * ldotn * n - view_dir);
      let rdotv = max(0.0, dot(refl, view_dir));
      lit_srgb = rgb * (ka + kd * ldotn) + vec3<f32>(ks * pow(rdotv, sh));
    }
  }
  let lit = srgb2physical(clamp(lit_srgb, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * opacity, opacity);
}`;
  }

  fillUniforms(out: Float32Array, off: number) {
    out.set(this.p2t, off);
    out[off + 16] = this.clim[0]; out[off + 17] = this.clim[1];
    out[off + 18] = this.maxStepMm; out[off + 19] = this.normalRadius;
    out[off + 20] = this.shade[0]; out[off + 21] = this.shade[1];
    out[off + 22] = this.shade[2]; out[off + 23] = this.shade[3];
    out[off + 24] = this.unit; out[off + 25] = this.context; out[off + 26] = this.ctMod;
    // 2 = solid over labels that hold only visible structures (the merged segmentations): the per-voxel
    // visibility read can be skipped, which halves the label reads near surfaces.
    out[off + 27] = this.solid ? (this.onlyVisibleLabels ? 2 : 1) : 0;
    out[off + 28] = this.dims[0]; out[off + 29] = this.dims[1]; out[off + 30] = this.dims[2];
    out[off + 31] = this.stepMm;
  }

  bindEntries(_s: number, base: number): GPUBindGroupEntry[] {
    return [
      { binding: base, resource: this.ctTex.createView() },
      { binding: base + 1, resource: this.labTex.createView() },
      { binding: base + 2, resource: this.lutTex.createView() },
      { binding: base + 3, resource: this.smoothTex.createView() },
      { binding: base + 4, resource: this.brickTex.createView() },
      { binding: base + 5, resource: this.brick2Tex.createView() },
    ];
  }
}
