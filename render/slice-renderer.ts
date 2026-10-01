// MPR slice renderer — an ANATOMICALLY CORRECT orthographic reslice of a scalar
// volume (+ optional colored overlay). The plane is defined in RAS (patient) space;
// each output pixel maps view(u,v) -> RAS -> texture[0,1] via the volume's
// patientToTexture, which folds in the real ijkToRAS (rotation + anisotropic spacing).
// This is the WebGPU equivalent of Slicer's vtkImageReslice / the legacy viewer's
// xyToIJK = inv(ijkToRAS)*xyToRAS. Voxel-index (IJK) planes are NOT anatomical planes
// for an oblique/anisotropic acquisition, so we never slice in texture space directly.
//
// Aspect: the view is isotropic in mm (letterboxed) so proportions are never distorted;
// a plane axis with fewer/thicker slices (e.g. a sagittally-acquired volume's R axis)
// still shows at its true physical size. One draw = one plane; the 4-up uses three.

import type { Gpu } from "./device.ts";
import { applyMat4, type Mat4, type Vec3 } from "./mat4.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";

export type Orientation = "axial" | "coronal" | "sagittal";

const SHADER = /* wgsl */ `
struct U {
  p2t : mat4x4<f32>,     // RAS -> texture[0,1] (folds in ijkToRAS: rotation + anisotropy)
  origin : vec4<f32>,    // RAS of the plane center (for the current scrub offset)
  uvec : vec4<f32>,      // RAS vector spanning the view width  (isotropic mm)
  vvec : vec4<f32>,      // RAS vector spanning the view height (isotropic mm)
  params : vec4<f32>,    // win, lev, fillOpacity, outlineOpacity
  size : vec4<f32>,      // sizeX, sizeY, labelOverlayMode, bgLutMode (0 gray, 1 LUT row 0)
  // ── Slicer slice-composite layers (vtkMRMLSliceCompositeNode): a FOREGROUND volume blended over the
  //    background with its own geometry, W/L and LUT, and a LABEL volume coloured through a colour table.
  p2tFg : mat4x4<f32>,   // RAS -> foreground texture[0,1]
  fgParams : vec4<f32>,  // win, lev, opacity (0 = no foreground), compositing (0 alpha,1 reverse alpha,2 add,3 subtract)
  p2tLabel : mat4x4<f32>,// RAS -> label texture[0,1]
  labelParams : vec4<f32>, // opacity (0 = no label layer), lutEntries, fgLutMode (0 gray, 1 LUT row 1), _
  // ── A SECOND segmentation overlay, so two networks' results can be read against each other in one
  //    slice instead of by toggling between them. Each slot carries its OWN RAS->texture matrix: a
  //    specialized network (ts:abdominal_muscles) segments only part of the study, so its labelmap
  //    shares neither the dims nor the origin of the background volume, and addressing it through
  //    the background's matrix would draw it in the wrong place.
  p2tSegA : mat4x4<f32>,   // RAS -> overlay A texture[0,1]
  p2tSegB : mat4x4<f32>,   // RAS -> overlay B texture[0,1]
  segParams : vec4<f32>,   // modeB (0 = no second overlay), fillB, outlineB, transparentOutside
  // ── MORE THAN TWO SEGMENTATIONS. The pass is drawn again per further pair, over the frame already
  //    drawn, in overlay-only mode: no background, no foreground, no label layer, just the two
  //    overlays as premultiplied color + alpha for the blend. mode.x = 1 selects it.
  mode : vec4<f32>,        // overlayOnly, _, _, _
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_scalar : texture_3d<f32>;
@group(0) @binding(3) var t_overlay : texture_3d<f32>;
@group(0) @binding(4) var s_nn : sampler;   // NEAREST — labelmap overlay is per-voxel crisp (matches Slicer)
// Label-overlay mode (size.z > 0.5): instead of a pre-coloured rgba volume, take the segment
// number from a u8 label volume and its colour+opacity from the same 256x2 palette the
// ColorizeField uses. A coloured overlay of a 509x365x299 CT would be 222 MB; label + palette
// is 55 MB and, because it shares the palette, hiding an organ group in 3D hides it here too.
@group(0) @binding(5) var t_labels : texture_3d<u32>;
@group(0) @binding(6) var t_palette : texture_2d<f32>;
@group(0) @binding(7) var t_fg : texture_3d<f32>;       // foreground scalar volume
@group(0) @binding(8) var t_lut : texture_2d<f32>;      // 256x2 colour LUTs: row 0 background, row 1 foreground (sampled over the W/L ramp)
@group(0) @binding(9) var t_labelVol : texture_3d<f32>; // label volume (integer values stored as float)
@group(0) @binding(10) var t_labelLut : texture_2d<f32>;// Nx1 colour table indexed by label value
@group(0) @binding(11) var t_labelsB : texture_3d<u32>;  // second segmentation's labelmap
@group(0) @binding(12) var t_paletteB : texture_2d<f32>; // and its own 256x2 palette

struct V { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> V {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : V; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92; let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
/** Overlay A at a RAS point: label mode reads its own labelmap through its own matrix, otherwise
 *  the pre-colored rgba volume through the background's. 0 outside that volume. */
fn ovA_at(ras : vec3<f32>) -> vec4<f32> {
  if (u.size.z > 0.5) {
    let t = (u.p2tSegA * vec4<f32>(ras, 1.0)).xyz;
    if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
    let d = vec3<f32>(textureDimensions(t_labels));
    let vi = vec3<i32>(clamp(floor(t * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
    let lab = i32(textureLoad(t_labels, vi, 0).r);
    if (lab == 0) { return vec4<f32>(0.0); }
    return textureLoad(t_palette, vec2<i32>(lab, 1), 0);
  }
  let t = (u.p2t * vec4<f32>(ras, 1.0)).xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  return textureSampleLevel(t_overlay, s_nn, t, 0.0);
}
/** Overlay B: label mode only — the rgba form was never more than one binding. */
fn ovB_at(ras : vec3<f32>) -> vec4<f32> {
  if (u.segParams.x < 0.5) { return vec4<f32>(0.0); }
  let t = (u.p2tSegB * vec4<f32>(ras, 1.0)).xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
  let d = vec3<f32>(textureDimensions(t_labelsB));
  let vi = vec3<i32>(clamp(floor(t * d), vec3<f32>(0.0), d - vec3<f32>(1.0)));
  let lab = i32(textureLoad(t_labelsB, vi, 0).r);
  if (lab == 0) { return vec4<f32>(0.0); }
  return textureLoad(t_paletteB, vec2<i32>(lab, 1), 0);
}
/** Slicer-style 2D segmentation: a semi-transparent per-voxel FILL plus a brighter boundary OUTLINE
 *  with independent opacities. The outline is screen-space (constant pixel width under zoom), drawn
 *  in the segment's own color along its inner edge, at both label<->label and label<->background
 *  boundaries -- hence the four neighbor samples the caller passes in. */
fn seg_alpha(c : vec4<f32>, n0 : vec4<f32>, n1 : vec4<f32>, n2 : vec4<f32>, n3 : vec4<f32>, fillO : f32, outO : f32) -> f32 {
  let fillA = clamp(c.a * fillO, 0.0, 1.0);
  var outA = 0.0;
  if (outO > 0.0) {
    let e = max(max(distance(n0.rgb, c.rgb) + abs(n0.a - c.a), distance(n1.rgb, c.rgb) + abs(n1.a - c.a)),
                max(distance(n2.rgb, c.rgb) + abs(n2.a - c.a), distance(n3.rgb, c.rgb) + abs(n3.a - c.a)));
    let edge = clamp((e - 0.03) * 12.0, 0.0, 1.0);   // 0 in the interior, 1 at a colour/label edge
    outA = clamp(c.a * outO * edge, 0.0, 1.0);
  }
  return max(fillA, outA);
}
fn blend_seg(col : vec3<f32>, c : vec4<f32>, n0 : vec4<f32>, n1 : vec4<f32>, n2 : vec4<f32>, n3 : vec4<f32>, fillO : f32, outO : f32) -> vec3<f32> {
  return mix(col, c.rgb, seg_alpha(c, n0, n1, n2, n3, fillO, outO));
}
@fragment
fn fs_main(v : V) -> @location(0) vec4<f32> {
  let uv = v.position.xy / u.size.xy;                 // [0,1], y down
  let ras = u.origin.xyz + u.uvec.xyz * (uv.x - 0.5) + u.vvec.xyz * (0.5 - uv.y);
  let t4 = u.p2t * vec4<f32>(ras, 1.0);
  let tex = t4.xyz;
  // OUTSIDE THE VOLUME. A 2D view wants opaque black -- it is the view's own background. The texture
  // for the 3D slice quad wants alpha 0, so the quad's empty corners can be discarded instead of
  // standing in front of the volume as a black rectangle. segParams.w picks which.
  if (u.mode.x > 0.5) {
    // OVERLAY-ONLY: the two overlays as premultiplied color and alpha, B over A, to be blended
    // over the frame that is already there. Outside the volume nothing is drawn.
    if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0); }
    let du2 = u.uvec.xyz / u.size.x * 1.5;
    let dv2 = u.vvec.xyz / u.size.y * 1.5;
    var rgb = vec3<f32>(0.0);
    var alpha = 0.0;
    let a2 = ovA_at(ras);
    if (a2.a > 0.0) {
      alpha = seg_alpha(a2, ovA_at(ras + du2), ovA_at(ras - du2), ovA_at(ras + dv2), ovA_at(ras - dv2), u.params.z, u.params.w);
      rgb = a2.rgb * alpha;
    }
    if (u.segParams.x > 0.5) {
      let b2 = ovB_at(ras);
      if (b2.a > 0.0) {
        let ab = seg_alpha(b2, ovB_at(ras + du2), ovB_at(ras - du2), ovB_at(ras + dv2), ovB_at(ras - dv2), u.segParams.y, u.segParams.z);
        rgb = b2.rgb * ab + rgb * (1.0 - ab);
        alpha = ab + alpha * (1.0 - ab);
      }
    }
    return vec4<f32>(srgb2physical(rgb), alpha);
  }
  if (any(tex < vec3<f32>(0.0)) || any(tex > vec3<f32>(1.0))) { return vec4<f32>(0.0, 0.0, 0.0, 1.0 - u.segParams.w); }
  let s4 = textureSampleLevel(t_scalar, s_lin, tex, 0.0);
  let val = s4.r;
  let win = max(u.params.x, 1e-6);
  let g = clamp((val - (u.params.y - win * 0.5)) / win, 0.0, 1.0);
  var col = vec3<f32>(g);
  if (u.size.w > 1.5) { col = s4.rgb; }                               // a color background (setBackgroundRGB)
  else if (u.size.w > 0.5) { col = textureLoad(t_lut, vec2<i32>(i32(g * 255.0), 0), 0).rgb; }
  // ── foreground layer (Slicer's vtkImageBlend semantics per compositing mode) ──
  if (u.fgParams.z > 0.0) {
    let tf = (u.p2tFg * vec4<f32>(ras, 1.0)).xyz;
    if (all(tf >= vec3<f32>(0.0)) && all(tf <= vec3<f32>(1.0))) {
      let f4 = textureSampleLevel(t_fg, s_lin, tf, 0.0);
      let fv = f4.r;
      let fwin = max(u.fgParams.x, 1e-6);
      let fg = clamp((fv - (u.fgParams.y - fwin * 0.5)) / fwin, 0.0, 1.0);
      var fcol = vec3<f32>(fg);
      if (u.labelParams.z > 1.5) { fcol = f4.rgb; }                  // a color foreground (setForegroundRGB)
      else if (u.labelParams.z > 0.5) { fcol = textureLoad(t_lut, vec2<i32>(i32(fg * 255.0), 1), 0).rgb; }
      let a = u.fgParams.z;
      let mode = i32(u.fgParams.w + 0.5);
      if (mode == 0) { col = mix(col, fcol, a); }                       // alpha: fg over bg
      else if (mode == 1) { col = mix(fcol, col, a); }                  // reverse alpha: bg over fg
      else if (mode == 2) { col = clamp(col + fcol * a, vec3<f32>(0.0), vec3<f32>(1.0)); }   // add
      else { col = clamp(col - fcol * a, vec3<f32>(0.0), vec3<f32>(1.0)); }                   // subtract
    }
  }
  // ── label layer: integer label -> colour table entry, blended at labelOpacity (label 0 = transparent) ──
  if (u.labelParams.x > 0.0) {
    let tl = (u.p2tLabel * vec4<f32>(ras, 1.0)).xyz;
    if (all(tl >= vec3<f32>(0.0)) && all(tl <= vec3<f32>(1.0))) {
      let lv = i32(textureSampleLevel(t_labelVol, s_nn, tl, 0.0).r + 0.5);
      let nEntries = i32(u.labelParams.y);
      if (lv > 0 && lv < nEntries) {
        let lc = textureLoad(t_labelLut, vec2<i32>(lv, 0), 0);
        col = mix(col, lc.rgb, clamp(lc.a * u.labelParams.x, 0.0, 1.0));
      }
    }
  }
  // ── segmentation overlays: A first, then B over it, each with its own opacities. Drawing them in
  //    order rather than letting one win means a structure that only the second network found reads
  //    against the first one's neighbors instead of replacing them.
  let du = u.uvec.xyz / u.size.x * 1.5;   // ~1.5 px right, in RAS
  let dv = u.vvec.xyz / u.size.y * 1.5;   // ~1.5 px up
  // A transparent center contributes neither fill nor outline (both scale by c.a), so the four
  // neighbor samples are only worth taking inside a segment.
  let a = ovA_at(ras);
  if (a.a > 0.0) {
    col = blend_seg(col, a, ovA_at(ras + du), ovA_at(ras - du), ovA_at(ras + dv), ovA_at(ras - dv), u.params.z, u.params.w);
  }
  if (u.segParams.x > 0.5) {
    let b = ovB_at(ras);
    if (b.a > 0.0) {
      col = blend_seg(col, b, ovB_at(ras + du), ovB_at(ras - du), ovB_at(ras + dv), ovB_at(ras - dv), u.segParams.y, u.segParams.z);
    }
  }
  return vec4<f32>(srgb2physical(col), 1.0);
}
`;

// Standard anatomical plane bases (RAS), matching Slicer's default Axial/Coronal/Sagittal
// sliceToRAS presets EXACTLY (RADIOLOGICAL convention). uDir = screen-right in RAS,
// vDir = screen-up, nAxis = the RAS axis the plane scrubs along:
//   Axial    screen-right = -R (patient LEFT on the right),   up = +A   (sliceToRAS col0=-R, col1=+A)
//   Coronal  screen-right = -R,                               up = +S   (col0=-R, col1=+S)
//   Sagittal screen-right = -A (posterior on the right),      up = +S   (col0=-A, col1=+S)
// These signs are NOT a free display preference: RAS data shown with +R-to-the-right reads
// as a left-right (LPS/RAS) flip vs every Slicer view. Never diverge from Slicer's presets.
//
// The three anatomical presets are the DEFAULT basis, not the only one: a basis is just a
// (uDir, vDir, nDir) triple in RAS, and setBasis() accepts an arbitrary one so a view can be
// resliced along a volume's own acquisition axes (see PlaneBasis / setBasis). Everything
// downstream — span, scrub, projection — works off those vectors, so the anatomical cases
// reduce to exactly the arithmetic they always used.
export interface PlaneBasis { uDir: Vec3; vDir: Vec3; nDir: Vec3 }

const BASES: Record<Orientation, PlaneBasis> = {
  axial: { uDir: [-1, 0, 0], vDir: [0, 1, 0], nDir: [0, 0, 1] },
  coronal: { uDir: [-1, 0, 0], vDir: [0, 0, 1], nDir: [0, 1, 0] },
  sagittal: { uDir: [0, -1, 0], vDir: [0, 0, 1], nDir: [1, 0, 0] },
};
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Which IJK axis is most aligned with a given RAS axis, per the volume's ijkToRAS
 *  (row-major). Returns the column index of the 3x3 whose |component| on `rasAxis` is largest. */
function ijkAxisForRasAxis(ijkToRAS: ArrayLike<number>, rasAxis: 0 | 1 | 2): number {
  let best = 0, bestMag = -1;
  for (let c = 0; c < 3; c++) {
    const mag = Math.abs(ijkToRAS[rasAxis * 4 + c]);
    if (mag > bestMag) { bestMag = mag; best = c; }
  }
  return best;
}

/** Slicer's DEFAULT slice position for a freshly-loaded volume, as offset01 in the RAS bbox.
 *
 *  Slicer does not park the slice at the bounding-box centre — it snaps to the voxel-centre
 *  plane at index floor((N-1)/2) on the IJK axis aligned with the slice normal. Verified
 *  against a real Slicer session (MRHead): axial j=127 -> S=-10.2143, coronal i=127 ->
 *  A=6.9286, sagittal k=64 -> R=-3.4452, all exact. The bbox centre is a half-voxel off. */
export function slicerDefaultOffset01(
  orient: Orientation,
  dims: [number, number, number],
  ijkToRAS: ArrayLike<number>,
  rasLo: Vec3,
  rasHi: Vec3,
): number {
  const b = BASES[orient];
  const nAbs = b.nDir.map(Math.abs);
  const n = (nAbs[0] >= nAbs[1] && nAbs[0] >= nAbs[2] ? 0 : nAbs[1] >= nAbs[2] ? 1 : 2) as 0 | 1 | 2;
  const a = ijkAxisForRasAxis(ijkToRAS, n);
  const m = Math.floor((dims[a] - 1) / 2);
  // RAS component along the normal for a voxel with index a = m (other axes at their centres)
  const ijk = [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2];
  ijk[a] = m;
  const ras = ijkToRAS[n * 4 + 0] * ijk[0] + ijkToRAS[n * 4 + 1] * ijk[1] + ijkToRAS[n * 4 + 2] * ijk[2] + ijkToRAS[n * 4 + 3];
  const span = rasHi[n] - rasLo[n];
  return span === 0 ? 0.5 : (ras - rasLo[n]) / span;
}

export class SliceRenderer {
  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private overlayPipeline: GPURenderPipeline;
  private overlayBind?: GPUBindGroup;
  private sampler: GPUSampler;
  private nnSampler: GPUSampler;
  private ubuf: GPUBuffer;
  // p2t(16) origin(4) uvec(4) vvec(4) params(4) size(4) | p2tFg(16) fgParams(4) p2tLabel(16) labelParams(4)
  // | p2tSegA(16) p2tSegB(16) segParams(4) -- 112 floats; every mat4 lands on a 16-byte boundary.
  private u = new Float32Array(116);   // ...+ mode [112..115]
  private bind?: GPUBindGroup;
  // Adaptive downsample (moving frames): render the reslice into a low-res target, then bilinear-blit
  // it up to the view — the 2D analogue of SceneRenderer.renderUpscaled. Lets a slice cell degrade
  // resolution under load to keep interactive latency low, snapping back to native when settled.
  private blitPipeline?: GPURenderPipeline;
  private lowTex?: GPUTexture;
  private lowView?: GPUTextureView;
  private lowW = 0;
  private lowH = 0;
  private blitBind?: GPUBindGroup;
  private overlay?: GPUTexture;
  private labels?: GPUTexture;
  private palette?: GPUTexture;
  private labelsB?: GPUTexture;
  private paletteB?: GPUTexture;
  // Each overlay's own RAS->texture map, or undefined to borrow the background volume's. A
  // segmentation of the whole study shares the background's geometry and can borrow it; one that
  // covers a sub-volume cannot.
  private segAp2t?: Mat4;
  private segBp2t?: Mat4;
  private scalarTex?: GPUTexture;
  private fgTex?: GPUTexture;
  private lutTex?: GPUTexture;       // 256x2 rgba8: row 0 bg LUT, row 1 fg LUT
  private labelVolTex?: GPUTexture;
  private labelLutTex?: GPUTexture;
  // actual in-plane extents (mm) spanned by the LAST rendered viewport, aspect-corrected so
  // pixels stay isotropic on a non-square view (0 until first render → fall back to the square span).
  private uSpanMm = 0;
  private vSpanMm = 0;

  // volume geometry + current plane
  private p2t: Mat4 = new Float32Array(16);
  private rasLo: Vec3 = [-1, -1, -1];
  private rasHi: Vec3 = [1, 1, 1];
  private orient: Orientation = "axial";
  private offset01 = 0.5;
  // Per-orientation pan (mm along the plane's uDir/vDir) + zoom (1 = fitted). Slicer-style
  // slice navigation: pan translates the in-plane view centre, zoom scales the field of view.
  private viewState: Record<Orientation, { panU: number; panV: number; zoom: number }> = {
    axial: { panU: 0, panV: 0, zoom: 1 },
    coronal: { panU: 0, panV: 0, zoom: 1 },
    sagittal: { panU: 0, panV: 0, zoom: 1 },
  };
  private cX: Vec3 = [0, 0, 0];   // in-plane centre of the LAST rendered frame (for viewToTex picking)
  // Optional per-orientation basis override (reslice along a volume's own axes). null = the
  // anatomical preset.
  private basisOverride: Partial<Record<Orientation, PlaneBasis | null>> = {};

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    const m = this.dev.createShaderModule({ code: SHADER });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs_main" },
      fragment: { module: m, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    // The overlay-only pipeline: same shader in mode.x = 1, blended over what the frame pass drew.
    // Premultiplied over, so a segment at 50% fill leaves half of the CT beneath it, as in the frame.
    this.overlayPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs_main" },
      fragment: { module: m, entryPoint: "fs_main", targets: [{ format, blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.nnSampler = this.dev.createSampler({ magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.ubuf = this.dev.createBuffer({ size: this.u.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.setWindowLevel(255, 127);
    this.setOverlayOpacity(0.55);
  }

  /** 1x1x1 stand-ins so the label-overlay bindings always exist. The pipeline layout is fixed,
   *  so every caller must bind them even when it only wants a plain MPR. */
  private emptyLabels?: GPUTexture;
  private emptyPalette?: GPUTexture;
  private noLabels(): GPUTexture {
    if (!this.emptyLabels) {
      this.emptyLabels = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyLabels }, new Uint8Array(1), { bytesPerRow: 1, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyLabels;
  }
  private noPalette(): GPUTexture {
    if (!this.emptyPalette) {
      this.emptyPalette = this.dev.createTexture({ size: [256, 2], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyPalette }, new Uint8Array(256 * 2 * 4), { bytesPerRow: 256 * 4 }, [256, 2]);
    }
    return this.emptyPalette;
  }

  private emptyScalar?: GPUTexture;
  private noScalar(): GPUTexture {
    if (!this.emptyScalar) {
      this.emptyScalar = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyScalar }, new Float32Array(1), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyScalar;
  }
  private emptyLut?: GPUTexture;
  private noLut(): GPUTexture {
    if (!this.emptyLut) {
      this.emptyLut = this.dev.createTexture({ size: [256, 2], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyLut }, new Uint8Array(256 * 2 * 4), { bytesPerRow: 256 * 4 }, [256, 2]);
    }
    return this.emptyLut;
  }
  /** Foreground layer: a second scalar volume with its own RAS->texture mapping, W/L, opacity and
   *  compositing mode (Slicer's slice composite node). Pass null to remove. */
  setForeground(tex: GPUTexture | null, p2t: Mat4 | null, win: number, lev: number, opacity: number, compositing = 0) {
    this.fgTex = tex ?? undefined;
    if (p2t) this.u.set(p2t, 36);
    this.u[52] = win; this.u[53] = lev; this.u[54] = tex ? opacity : 0; this.u[55] = compositing;
    if (this.scalarTex) this.rebind();
  }
  /** Colour LUTs over the W/L ramp for the background (row 0) and foreground (row 1): 256 rgba8 entries
   *  each, or null for the grayscale ramp. */
  setLayerLUTs(bg: Uint8Array | null, fg: Uint8Array | null) {
    if (!bg && !fg) { this.lutTex = undefined; this.u[35] = 0; this.u[74] = 0; if (this.scalarTex) this.rebind(); return; }
    if (!this.lutTex) this.lutTex = this.dev.createTexture({ size: [256, 2], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const gray = new Uint8Array(256 * 4); for (let i = 0; i < 256; i++) { gray[i * 4] = gray[i * 4 + 1] = gray[i * 4 + 2] = i; gray[i * 4 + 3] = 255; }
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 0] }, bg ?? gray, { bytesPerRow: 256 * 4 }, [256, 1]);
    this.dev.queue.writeTexture({ texture: this.lutTex, origin: [0, 1] }, fg ?? gray, { bytesPerRow: 256 * 4 }, [256, 1]);
    this.u[35] = bg ? 1 : 0; this.u[74] = fg ? 1 : 0;
    if (this.scalarTex) this.rebind();
  }
  /** A COLOR BACKGROUND (fields.ts ImageFieldOpts.rgb24): its texture's red, green and blue are drawn as they are,
   *  not windowed. Call after setLayerLUTs, which it overrides for the background; false leaves that as it was. */
  setBackgroundRGB(on: boolean) {
    if (!on) return;
    this.u[35] = 2;
    if (this.scalarTex) this.rebind();
  }
  /** A COLOR FOREGROUND, as setBackgroundRGB for the background. Call after setLayerLUTs. */
  setForegroundRGB(on: boolean) {
    if (!on) return;
    this.u[74] = 2;
    if (this.scalarTex) this.rebind();
  }
  /** Label layer: a label volume (integer values in a float texture) coloured through a colour table
   *  (rgba8 entries, index = label value), blended at `opacity`. Pass null to remove. */
  setLabelLayer(tex: GPUTexture | null, p2t: Mat4 | null, table: Uint8Array | null, opacity: number) {
    this.labelVolTex = tex ?? undefined;
    if (p2t) this.u.set(p2t, 56);
    const n = table ? table.length / 4 : 0;
    if (table && n > 0) {
      if (!this.labelLutTex || this.labelLutTex.width !== n) { this.labelLutTex?.destroy(); this.labelLutTex = this.dev.createTexture({ size: [n, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); }
      this.dev.queue.writeTexture({ texture: this.labelLutTex }, table, { bytesPerRow: n * 4 }, [n, 1]);
    }
    this.u[72] = tex && table ? opacity : 0; this.u[73] = n;
    if (this.scalarTex) this.rebind();
  }

  private emptyOverlay?: GPUTexture;
  private transparentOverlay(): GPUTexture {
    if (!this.emptyOverlay) {
      this.emptyOverlay = this.dev.createTexture({ size: [1, 1, 1], dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.dev.queue.writeTexture({ texture: this.emptyOverlay }, new Uint16Array(4), { bytesPerRow: 8, rowsPerImage: 1 }, [1, 1, 1]);
    }
    return this.emptyOverlay;
  }

  /** Reslice this orientation along an arbitrary RAS basis instead of the anatomical preset.
   *  Pass null to restore. The vectors should be unit length and mutually orthogonal; they are
   *  used verbatim, so the caller owns the display convention for a non-anatomical frame. */
  setBasis(orient: Orientation, basis: PlaneBasis | null) { this.basisOverride[orient] = basis; }
  /** offset01 (the setPlane scrub coordinate) for a RAS point, along the plane's current normal — the
   *  inverse of what setPlane does internally, so a caller holding a position in mm (a slice node's
   *  centre, a crosshair) can address the same slice for anatomical AND oblique bases. */
  offset01Along(orient: Orientation, ras: Vec3): number {
    const n = this.basisOf(orient).nDir;
    const { lo, hi } = this.extentAlong(n);
    return Math.max(0, Math.min(1, (dot3(ras, n) - lo) / Math.max(hi - lo, 1e-6)));
  }
  /** Slide a RAS point along the plane's current normal, only if needed, so that its scrub position
   *  lies inside the volume — the mm-space form of setPlane's 0..1 clamp, for a caller stepping a
   *  focus point through the slices of an anatomical OR oblique basis. In-plane coordinates are kept. */
  clampAlongNormal(orient: Orientation, ras: Vec3): Vec3 {
    const n = this.basisOf(orient).nDir;
    const { lo, hi } = this.extentAlong(n);
    const have = dot3(ras, n), want = Math.max(lo, Math.min(hi, have));
    return [ras[0] + n[0] * (want - have), ras[1] + n[1] * (want - have), ras[2] + n[2] * (want - have)];
  }
  basisOf(orient: Orientation): PlaneBasis { return this.basisOverride[orient] ?? BASES[orient]; }

  /** Extent of the volume's RAS bounding box projected onto a direction — the generalisation
   *  of "rasHi[axis] - rasLo[axis]" to an oblique axis. Reduces to exactly that for the
   *  anatomical bases, since projecting an axis-aligned box on its own axis is the axis span. */
  private extentAlong(d: Vec3): { lo: number; hi: number } {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [
        i & 1 ? this.rasHi[0] : this.rasLo[0],
        i & 2 ? this.rasHi[1] : this.rasLo[1],
        i & 4 ? this.rasHi[2] : this.rasLo[2],
      ];
      const t = dot3(c, d);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return { lo, hi };
  }

  /** Volume geometry: patientToTexture (RAS->tex[0,1], encodes ijkToRAS) + the RAS
   *  bounding box (for plane extents/scrub range). Get both from the ImageField. */
  setVolume(p2t: Mat4, rasLo: Vec3, rasHi: Vec3) {
    this.p2t = p2t; this.rasLo = rasLo; this.rasHi = rasHi;
    this.u.set(p2t, 0);
    this.writeSegMats();
  }

  /** Publish both overlay matrices, falling back to the background volume's for an overlay that
   *  did not bring one. Re-run whenever either side changes, so a borrowed matrix stays current. */
  private writeSegMats() {
    this.u.set(this.segAp2t ?? this.p2t, 76);
    this.u.set(this.segBp2t ?? this.p2t, 92);
  }

  /** Set the grayscale scalar (r32float 3d) and, optionally, a colored overlay
   *  (rgba16float 3d) — which MUST share the same geometry (ijkToRAS/dims) so the
   *  same RAS->tex mapping addresses both. Omit overlay for a plain MPR. */
  setTextures(scalar: GPUTexture, overlay?: GPUTexture) {
    this.overlay = overlay ?? this.transparentOverlay();
    this.scalarTex = scalar;
    this.rebind();
  }

  /** Colour the overlay from a u8 label volume + the 256x2 palette (row 1 = colour/opacity),
   *  instead of a pre-coloured rgba volume. Same geometry requirement as setTextures. Pass
   *  nulls to go back to the rgba overlay. */
  setLabelOverlay(labels: GPUTexture | null, palette: GPUTexture | null, p2t?: Mat4 | null) {
    this.labels = labels ?? undefined;
    this.palette = palette ?? undefined;
    this.segAp2t = p2t ?? undefined;
    this.u[34] = labels && palette ? 1 : 0;      // size.z = label-overlay mode
    this.writeSegMats();
    if (this.scalarTex) this.rebind();
  }

  /** A SECOND label overlay, drawn over the first with its own geometry and its own fill/outline
   *  opacities. Two segmentations of one study -- a general network and a specialized one -- are
   *  read against each other, and toggling between them is not reading them against each other.
   *  Pass nulls to clear. Label form only: the rgba overlay was always a single binding. */
  setLabelOverlayB(labels: GPUTexture | null, palette: GPUTexture | null, p2t?: Mat4 | null, fill = 0.5, outline = 1.0) {
    this.labelsB = labels ?? undefined;
    this.paletteB = palette ?? undefined;
    this.segBp2t = p2t ?? undefined;
    this.u[108] = labels && palette ? 1 : 0;    // segParams.x = second overlay present
    this.u[109] = fill;
    this.u[110] = outline;
    this.writeSegMats();
    if (this.scalarTex) this.rebind();
  }

  private rebind() {
    if (!this.scalarTex) return;
    const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.scalarTex.createView() },
        { binding: 3, resource: (this.overlay ?? this.transparentOverlay()).createView() },
        { binding: 4, resource: this.nnSampler },
        { binding: 5, resource: (this.labels ?? this.noLabels()).createView() },
        { binding: 6, resource: (this.palette ?? this.noPalette()).createView() },
        { binding: 7, resource: (this.fgTex ?? this.noScalar()).createView() },
        { binding: 8, resource: (this.lutTex ?? this.noLut()).createView() },
        { binding: 9, resource: (this.labelVolTex ?? this.noScalar()).createView() },
        { binding: 10, resource: (this.labelLutTex ?? this.noPalette()).createView() },
        { binding: 11, resource: (this.labelsB ?? this.noLabels()).createView() },
        { binding: 12, resource: (this.paletteB ?? this.noPalette()).createView() },
      ];
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries });
    this.overlayBind = this.dev.createBindGroup({ layout: this.overlayPipeline.getBindGroupLayout(0), entries });
  }

  // Uniform float layout: p2t[0..15] origin[16..19] uvec[20..23] vvec[24..27] params[28..31] size[32..35]
  //   p2tFg[36..51] fgParams[52..55] p2tLabel[56..71] labelParams[72..75] p2tSegA[76..91] p2tSegB[92..107] segParams[108..111]
  /** Select the anatomical plane and scrub position (0..1 along the plane normal, RAS bbox). */
  setPlane(orient: Orientation, offset01: number) {
    this.orient = orient;
    this.offset01 = Math.max(0, Math.min(1, offset01));
  }
  setWindowLevel(win: number, lev: number) { this.u[28] = win; this.u[29] = lev; }
  /** Overlay FILL opacity (per-voxel coloured regions). 0 hides the fill. */
  setOverlayOpacity(o: number) { this.u[30] = o; }
  /** Overlay OUTLINE opacity (boundary line, composited over the fill). 0 hides the outline. */
  setOutlineOpacity(o: number) { this.u[31] = o; }
  /** Convenience toggle: outline on (opacity 1) / off (0). Composites over the fill. */
  setOverlayOutline(on: boolean) { this.u[31] = on ? 1 : 0; }

  /** Physical size (mm) of the square view for the current plane (isotropic, letterboxed).
   *  Matches Slicer's FitSliceToBackground: the field of view is exactly the volume's
   *  extent along the limiting in-plane axis — NO extra margin. (Verified against
   *  Slicer: Red FOV=[891.78,256] at viewport 634x182 -> vertical FOV == the 256mm
   *  A-extent, horizontal follows viewport aspect.) */
  private viewSpanMm(): number {
    const b = this.basisOf(this.orient);
    const u = this.extentAlong(b.uDir), v = this.extentAlong(b.vDir);
    return Math.max(u.hi - u.lo, v.hi - v.lo);
  }

  /** The fitted in-plane extent (mm) used for a given orientation — the value directly
   *  comparable to a Slicer slice node's fitted fieldOfView. */
  spanMmFor(orient: Orientation): number {
    const prev = this.orient;
    this.orient = orient;
    const s = this.viewSpanMm();
    this.orient = prev;
    return s;
  }

  /** Letterbox fit at zoom=1 (Slicer's FitSliceToVolume): the in-plane FOV (uS0×vS0) that
   *  exactly contains the slice's bounding box in a viewport of the given aspect — the whole
   *  slice is visible and the LIMITING axis touches the window edge (so the largest fitting
   *  axis fills the window, no needless margin). Replaces the old max(uExt,vExt) span, which
   *  under-zoomed whenever the larger extent wasn't on the viewport's limiting axis. */
  private fitUV(orient: Orientation, aspectWH: number): { uS0: number; vS0: number } {
    const b = this.basisOf(orient);
    const u = this.extentAlong(b.uDir), v = this.extentAlong(b.vDir);
    const uExt = u.hi - u.lo, vExt = v.hi - v.lo;
    const uS0 = Math.max(uExt, vExt * aspectWH);
    return { uS0, vS0: uS0 / aspectWH };
  }

  /** The complete in-plane view frame for an orientation at a given viewport aspect, folding
   *  in pan (mm along uDir/vDir) + zoom. Single source of truth shared by drawInto, rasToView,
   *  viewToRas — so the rendered image and the markup projection stay pixel-aligned under
   *  pan/zoom. Returns the plane centre `c` (RAS, incl. scrub offset + pan) and the half-... no:
   *  uS/vS are the FULL in-plane extents mapped across the viewport width/height. */
  private frameFor(orient: Orientation, offset01: number, aspectWH: number): { b: PlaneBasis; c: Vec3; uS: number; vS: number } {
    const b = this.basisOf(orient);
    const vs = this.viewState[orient];
    const { uS0, vS0 } = this.fitUV(orient, aspectWH);
    const uS = uS0 / vs.zoom, vS = vS0 / vs.zoom;
    const c: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    // slide the centre along the plane NORMAL: replace its normal component with the scrubbed
    // one. For an anatomical basis this is identical to assigning c[nAxis] directly.
    const nx = this.extentAlong(b.nDir);
    const want = nx.lo + Math.max(0, Math.min(1, offset01)) * (nx.hi - nx.lo);
    const have = dot3(c, b.nDir);
    c[0] += b.nDir[0] * (want - have);
    c[1] += b.nDir[1] * (want - have);
    c[2] += b.nDir[2] * (want - have);
    c[0] += b.uDir[0] * vs.panU + b.vDir[0] * vs.panV;
    c[1] += b.uDir[1] * vs.panU + b.vDir[1] * vs.panV;
    c[2] += b.uDir[2] * vs.panU + b.vDir[2] * vs.panV;
    return { b, c, uS, vS };
  }

  /** Zoom factor for an orientation (1 = fitted). */
  zoom(orient: Orientation): number { return this.viewState[orient].zoom; }

  /** Pan the in-plane view by a pixel delta (drag): the anatomy under the cursor follows it. */
  panByPixels(orient: Orientation, dxPx: number, dyPx: number, w: number, h: number) {
    const z = this.viewState[orient].zoom;
    const { uS0, vS0 } = this.fitUV(orient, w / h);
    const uS = uS0 / z, vS = vS0 / z;
    this.viewState[orient].panU -= (dxPx / w) * uS;   // drag right -> centre moves left -> image follows
    this.viewState[orient].panV += (dyPx / h) * vS;   // drag down  -> centre moves up   -> image follows
  }

  /** Zoom by `factor` (>1 zooms in) about a pivot (u,v in [0,1]); the pivot point stays fixed. */
  zoomAbout(orient: Orientation, factor: number, pu: number, pv: number, w: number, h: number) {
    const vs = this.viewState[orient];
    const { uS0, vS0 } = this.fitUV(orient, w / h);
    const z = Math.max(0.2, Math.min(50, vs.zoom * factor));
    vs.panU += (pu - 0.5) * (uS0 / vs.zoom - uS0 / z);   // keep the pivot's RAS point under the cursor
    vs.panV += (0.5 - pv) * (vS0 / vs.zoom - vS0 / z);
    vs.zoom = z;
  }

  /** Reset pan/zoom for an orientation to the fitted view. */
  resetView(orient: Orientation) { this.viewState[orient] = { panU: 0, panV: 0, zoom: 1 }; }

  /** Snapshot per-orientation pan+zoom (e.g. to persist a view across reloads). */
  getViewState(): Record<Orientation, { panU: number; panV: number; zoom: number }> {
    return structuredClone(this.viewState);
  }

  /** Restore a (possibly partial) snapshot from getViewState(). */
  setViewState(vs: Partial<Record<Orientation, { panU: number; panV: number; zoom: number }>>): void {
    for (const k of Object.keys(vs) as Orientation[]) {
      const v = vs[k];
      if (v && Number.isFinite(v.zoom) && v.zoom > 0) this.viewState[k] = { ...v };
    }
  }

  /** Mirror Slicer's in-plane navigation for an orientation: drive pan + zoom from the slice
   *  node's RAS centre and field of view (mm). zoom = extent/FOV on the limiting axis (== 1 when
   *  Slicer is fitted, per FitSliceToBackground's no-margin fit), so SlicerLive tracks Slicer's
   *  zoom proportionally; pan is the centre's offset from the volume centre projected onto the
   *  plane's in-plane axes. The out-of-plane offset is applied separately via setPlane. */
  setMirrorFrame(orient: Orientation, centerRAS: Vec3, fovX: number, fovY: number) {
    const b = this.basisOf(orient);
    // invert the SAME fit the interactive display uses (fitUV), so a zoom round-trips without snapping. The
    // node's fovX/fovY carries the aspect (fovX/fovY == uS0/vS0), so recover uS0 at that aspect and divide.
    const aspect = fovX / Math.max(fovY, 1e-6);
    const { uS0 } = this.fitUV(orient, aspect);
    const zoom = Math.max(1e-3, uS0 / Math.max(fovX, 1e-6));
    const volC: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    const d: Vec3 = [centerRAS[0] - volC[0], centerRAS[1] - volC[1], centerRAS[2] - volC[2]];
    const panU = d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2];
    const panV = d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2];
    this.viewState[orient] = { panU, panV, zoom };
  }

  /** The current pan/zoom of a plane expressed the way Slicer's slice node stores it: in-plane centre
   *  (RAS, without the out-of-plane offset which the caller owns) + field of view (mm) — the inverse
   *  of setMirrorFrame, so a local pan/zoom can be written back to the app as a slice frame. */
  mirrorFrame(orient: Orientation, aspectWH: number): { centerRAS: Vec3; fovX: number; fovY: number } {
    const b = this.basisOf(orient);
    const st = this.viewState[orient];
    const { uS0, vS0 } = this.fitUV(orient, aspectWH);          // the SAME base fit the display uses
    const fovX = uS0 / st.zoom, fovY = vS0 / st.zoom;
    const volC: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    const centerRAS: Vec3 = [
      volC[0] + b.uDir[0] * st.panU + b.vDir[0] * st.panV,
      volC[1] + b.uDir[1] * st.panU + b.vDir[1] * st.panV,
      volC[2] + b.uDir[2] * st.panU + b.vDir[2] * st.panV,
    ];
    return { centerRAS, fovX, fovY };
  }

  /** Map a view (u,v) in [0,1] (y down) to normalized texture coords for the current
   *  plane — for click picking. Returns the tex coord; the caller converts to IJK via
   *  ijk = tex*dims - 0.5. Anisotropy/rotation are handled by the same p2t the shader uses. */
  viewToTex(u: number, v: number): Vec3 {
    const b = this.basisOf(this.orient);
    const uS = this.uSpanMm || this.viewSpanMm();   // match the last render's aspect + zoom
    const vS = this.vSpanMm || this.viewSpanMm();
    const c = this.cX;                              // last render's centre (incl. pan + scrub offset)
    const ras: Vec3 = [
      c[0] + b.uDir[0] * (u - 0.5) * uS + b.vDir[0] * (0.5 - v) * vS,
      c[1] + b.uDir[1] * (u - 0.5) * uS + b.vDir[1] * (0.5 - v) * vS,
      c[2] + b.uDir[2] * (u - 0.5) * uS + b.vDir[2] * (0.5 - v) * vS,
    ];
    return applyMat4(this.p2t, ras);
  }

  /** Project a RAS point onto a plane's view: returns u,v in [0,1] (y down, matching the
   *  rendered pixels for a viewport of aspect w/h) and the signed distance (mm) from the
   *  point to the plane along its normal. Inverse of viewToTex; used to place 2D markup
   *  glyphs and hit-test clicks on them. */
  rasToView(orient: Orientation, offset01: number, ras: Vec3, aspectWH: number): { u: number; v: number; distMm: number } {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const d: Vec3 = [ras[0] - c[0], ras[1] - c[1], ras[2] - c[2]];
    const u = 0.5 + (d[0] * b.uDir[0] + d[1] * b.uDir[1] + d[2] * b.uDir[2]) / uS;
    const v = 0.5 - (d[0] * b.vDir[0] + d[1] * b.vDir[1] + d[2] * b.vDir[2]) / vS;
    return { u, v, distMm: dot3(d, b.nDir) };
  }

  /** Map a view (u,v in [0,1], y down) on a plane back to a RAS point ON that plane —
   *  the exact inverse of rasToView (same pan/zoom/aspect). Used to drag a 2D markup:
   *  the point lands on the current slice (its out-of-plane coord becomes the plane offset). */
  viewToRas(orient: Orientation, offset01: number, u: number, v: number, aspectWH: number): Vec3 {
    const { b, c, uS, vS } = this.frameFor(orient, offset01, aspectWH);
    const du = (u - 0.5) * uS, dv = (0.5 - v) * vS;
    return [
      c[0] + b.uDir[0] * du + b.vDir[0] * dv,
      c[1] + b.uDir[1] * du + b.vDir[1] * dv,
      c[2] + b.uDir[2] * du + b.vDir[2] * dv,
    ];
  }

  private drawInto(view: GPUTextureView, w: number, h: number) {
    // Aspect-correct so pixels are ISOTROPIC on a non-square viewport: the fitted span fills
    // the SMALLER dimension, the larger dimension shows more (letterbox). Pan/zoom fold in via
    // frameFor. Square viewports at zoom=1 with no pan reproduce the original fitted view exactly.
    const f = this.frameFor(this.orient, this.offset01, w / h);
    this.uSpanMm = f.uS; this.vSpanMm = f.vS; this.cX = f.c;
    this.drawFrame(view, w, h, f, 0);
  }

  /**
   * Allocate a texture that `renderPatientFrameInto` can draw into.
   *
   * THE CALLER DOES NOT CHOOSE THE FORMAT, because a caller that chooses it can choose wrong: the
   * pipeline is built for one format, and an attachment in another fails validation and takes every
   * view down ("color and depth targets from pass do not match pipeline"). That shipped once -- the
   * app's cells use the canvas's preferred format, bgra8unorm-srgb on a Mac, and the call site had
   * hardcoded rgba8unorm-srgb. A GPU test did not catch it, because the test picked both formats
   * itself and they agreed with each other. So the choice is gone rather than documented.
   */
  makeSliceTarget(w: number, h: number): GPUTexture {
    return this.dev.createTexture({
      size: [w, h], format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  /**
   * The plane's frame in PATIENT space: the volume's own in-plane extent, centered on the scrubbed
   * plane, with no pan and no zoom.
   *
   * This is the frame for the 3D slice quad, and it is deliberately NOT the 2D view's frame. The 2D
   * view shows whatever the user zoomed to; the slice in 3D spans the volume. (Slicer keeps a second
   * reslice/blend stack for its 3D slice model, but that began as a way to run the 3D texture at a
   * lower resolution on the hardware of the time -- the reason here is only that the two have
   * different extents.)
   */
  patientFrame(): { origin: Vec3; uvec: Vec3; vvec: Vec3 } {
    const f = this.patientFrameFor(this.orient, this.offset01);
    return {
      origin: f.c,
      uvec: [f.b.uDir[0] * f.uS, f.b.uDir[1] * f.uS, f.b.uDir[2] * f.uS],
      vvec: [f.b.vDir[0] * f.vS, f.b.vDir[1] * f.vS, f.b.vDir[2] * f.vS],
    };
  }

  private patientFrameFor(orient: Orientation, offset01: number): { b: PlaneBasis; c: Vec3; uS: number; vS: number } {
    const b = this.basisOf(orient);
    const eu = this.extentAlong(b.uDir), ev = this.extentAlong(b.vDir), en = this.extentAlong(b.nDir);
    const c: Vec3 = [(this.rasLo[0] + this.rasHi[0]) / 2, (this.rasLo[1] + this.rasHi[1]) / 2, (this.rasLo[2] + this.rasHi[2]) / 2];
    const want = en.lo + Math.max(0, Math.min(1, offset01)) * (en.hi - en.lo);
    const have = dot3(c, b.nDir);
    for (let i = 0; i < 3; i++) c[i] += b.nDir[i] * (want - have);
    // Re-center in plane on the volume's own extent (frameFor centers on the bbox, which for an
    // oblique basis is not the same point).
    const cu = dot3(c, b.uDir), cv = dot3(c, b.vDir);
    const midU = (eu.lo + eu.hi) / 2, midV = (ev.lo + ev.hi) / 2;
    for (let i = 0; i < 3; i++) c[i] += b.uDir[i] * (midU - cu) + b.vDir[i] * (midV - cv);
    return { b, c, uS: eu.hi - eu.lo, vS: ev.hi - ev.lo };
  }

  /**
   * Render the composite for the 3D slice quad and return the frame it used.
   *
   * ONE call for the picture and its geometry, because they must agree: the quad derives its texture
   * coordinates by projecting world positions onto this same frame, so a frame computed separately
   * is a misregistration waiting to happen.
   */
  renderPatientFrameInto(view: GPUTextureView, w: number, h: number): { origin: Vec3; uvec: Vec3; vvec: Vec3 } {
    const f = this.patientFrameFor(this.orient, this.offset01);
    this.drawFrame(view, w, h, f, 1);
    return {
      origin: f.c,
      uvec: [f.b.uDir[0] * f.uS, f.b.uDir[1] * f.uS, f.b.uDir[2] * f.uS],
      vvec: [f.b.vDir[0] * f.vS, f.b.vDir[1] * f.vS, f.b.vDir[2] * f.vS],
    };
  }

  /** The frame the last draw used, so an overlay-only pass draws exactly over it. */
  private lastFrame?: { frame: { b: PlaneBasis; c: Vec3; uS: number; vS: number }; transparentOutside: number };

  /**
   * MORE THAN TWO SEGMENTATIONS: draw the overlays currently set as A and B again, over the frame
   * the last renderToView / renderPatientFrameInto drew into `view`, and nothing else. The caller
   * sets the next pair with setLabelOverlay / setLabelOverlayB, calls this, and repeats. Ron, with
   * four MOOSE results on one CT and the slices showing two of them: "the segmentations are messed
   * up." The frame pass draws the first two; every further pair is one more of these.
   */
  renderOverlayPassInto(view: GPUTextureView, w: number, h: number) {
    if (!this.lastFrame || !this.bind) return;
    const { b, c, uS, vS } = this.lastFrame.frame;
    this.u.set(this.p2t, 0);
    this.u[16] = c[0]; this.u[17] = c[1]; this.u[18] = c[2]; this.u[19] = 0;
    this.u[20] = b.uDir[0] * uS; this.u[21] = b.uDir[1] * uS; this.u[22] = b.uDir[2] * uS; this.u[23] = 0;
    this.u[24] = b.vDir[0] * vS; this.u[25] = b.vDir[1] * vS; this.u[26] = b.vDir[2] * vS; this.u[27] = 0;
    this.u[32] = w; this.u[33] = h;
    this.u[111] = this.lastFrame.transparentOutside;
    this.u[112] = 1;                                                                           // mode.x = overlay only
    this.dev.queue.writeBuffer(this.ubuf, 0, this.u);
    this.u[112] = 0;
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(this.overlayPipeline);
    // The bind group was made for the main pipeline's layout; both pipelines are `layout: "auto"`
    // over the same shader, so a bind group for the overlay pipeline's layout is made from the same
    // entries. rebind() keeps both current.
    pass.setBindGroup(0, this.overlayBind ?? this.bind); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  private drawFrame(view: GPUTextureView, w: number, h: number, frame: { b: PlaneBasis; c: Vec3; uS: number; vS: number }, transparentOutside: number) {
    this.lastFrame = { frame, transparentOutside };
    const { b, c, uS, vS } = frame;
    this.u.set(this.p2t, 0);                                                                  // p2t   [0..15]
    this.u[16] = c[0]; this.u[17] = c[1]; this.u[18] = c[2]; this.u[19] = 0;                   // origin[16..19]
    this.u[20] = b.uDir[0] * uS; this.u[21] = b.uDir[1] * uS; this.u[22] = b.uDir[2] * uS; this.u[23] = 0; // uvec [20..23]
    this.u[24] = b.vDir[0] * vS; this.u[25] = b.vDir[1] * vS; this.u[26] = b.vDir[2] * vS; this.u[27] = 0; // vvec [24..27]
    // params[28..30] set via setWindowLevel/setOverlayOpacity
    this.u[32] = w; this.u[33] = h;                                                            // size [32..35]
    this.u[111] = transparentOutside;                                                          // segParams.w
    this.dev.queue.writeBuffer(this.ubuf, 0, this.u);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 - transparentOutside } }] });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind!); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
  }

  renderToView(view: GPUTextureView, w: number, h: number) { this.drawInto(view, w, h); }

  /** Bilinear-blit pipeline (fullscreen triangle) that upsamples the low-res reslice to the view. */
  private ensureBlit() {
    if (this.blitPipeline) return;
    const m = this.dev.createShaderModule({
      code: /* wgsl */ `
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var o: VO; o.pos = vec4<f32>(p[i], 0.0, 1.0);
  o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5); return o;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(in: VO) -> @location(0) vec4<f32> { return textureSample(src, samp, in.uv); }`,
    });
    this.blitPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs" },
      fragment: { module: m, entryPoint: "fs", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
  }
  private ensureLow(w: number, h: number) {
    this.ensureBlit();
    if (this.lowTex && this.lowW === w && this.lowH === h) return;
    this.lowTex?.destroy();
    this.lowTex = this.dev.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.lowView = this.lowTex.createView();
    this.lowW = w; this.lowH = h;
    this.blitBind = this.dev.createBindGroup({
      layout: this.blitPipeline!.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.lowView }, { binding: 1, resource: this.sampler }],
    });
  }
  /** Adaptive (moving-frame) render: reslice at `rw×rh` into an off-screen target, then bilinear-blit
   *  up to the `vw×vh` view. Single frame, no accumulation — use while interacting; call renderToView
   *  (native) when the view settles. At rw==vw/rh==vh this is a native render plus a pass-through blit. */
  renderUpscaled(view: GPUTextureView, rw: number, rh: number, vw: number, vh: number) {
    if (rw >= vw && rh >= vh) { this.drawInto(view, vw, vh); return; }   // not downsampling → native, no blit
    this.ensureLow(rw, rh);
    this.drawInto(this.lowView!, rw, rh);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.blitPipeline!); pass.setBindGroup(0, this.blitBind!); pass.draw(3); pass.end();
    this.dev.queue.submit([enc.finish()]);
    // Keep the picking/geometry state (uSpanMm/cX) consistent with the VIEW resolution: drawInto set it
    // from the low-res aspect, which matches (aspect is rw/rh ≈ vw/vh), so no correction is needed.
  }

  /** `after`: more drawing into the same target before it is read (the app's further overlay passes). */
  async renderToRGBA(w: number, h: number, after?: (view: GPUTextureView) => void): Promise<Uint8Array> {
    const target = this.dev.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const tv = target.createView();
    this.drawInto(tv, w, h);
    after?.(tv);
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, [w, h]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(padded.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }
}
