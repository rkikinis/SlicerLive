// RoiBoxField — an ROI box drawn as a wireframe FRAME, ray-marched in the
// same pass as the volume so the box occludes and is occluded correctly (no separate
// widget pass). It pairs with SceneRenderer.setClipBox: the box shows WHERE the volume is
// cropped, and one syncUniforms updates both the wireframe and the clip planes together —
// the event→state→render tight loop of ARCHITECTURE-2026-07-24 §6.4.
//
// Not clippable (clippable=false): the frame lies on the clip planes, so it must not be
// cropped by them. Provides a skip: the box-frame SDF is extremely sparse, so a ray leaps
// between edges (the case empty-space skipping was built for), making the widget near-free.
//
// The bars are drawn flat/unlit (the Slicer widget look) as a crisp opaque frame via the
// exact box-frame signed distance (Inigo Quilez's sdBoxFrame).

import type { Field } from "./fields.ts";
import type { Vec3 } from "./mat4.ts";

export interface RoiBoxOpts {
  color?: [number, number, number];
  opacity?: number;
  barHalfMm?: number;    // half-thickness of the wireframe bars (mm); default 1.5
  /**
   * The box's own axes in world space: row-major 3x3, COLUMNS are the axes. Omitted means
   * world-aligned, and the field then behaves exactly as it always did.
   *
   * WHY A BOX NEEDS AXES AT ALL. A crop box aligned to the patient is useless on an oblique volume:
   * measured on a 0.67 mm T1 whose grid is tilted ~10 degrees, a patient-aligned box around the head
   * maps back onto that grid as 274x384x384 -- the entire volume -- while a box on the VOLUME's axes
   * around the same anatomy is 274x330x301. Ron: "The cropped volume is not cropped."
   *
   * The axes are not the box's own state, though, and that is the point of taking them here rather
   * than building them into `center`/`half`: the box stays axis-aligned IN ITS OWN FRAME, so the
   * widget's face and corner drags keep meaning "move this face" and "resize the two axes you can
   * see", and the whole of roi-widget.ts works unchanged. Ron: "would a transform help? There are
   * linear transforms in Albula" -- yes, and this is where such a transform lands. In this
   * application the data supplies it: the volume's normalized direction cosines.
   *
   * MUST BE ORTHONORMAL. The shader inverts the rotation by transposing it, which is the inverse
   * only for an orthonormal basis. Direction cosines are; a scaled or sheared matrix is not.
   */
  axes?: number[];
}

export class RoiBoxField implements Field {
  readonly kind = "roi";
  readonly bindingCount = 0;         // procedural — all state in the uniform block
  readonly clippable = false;        // the frame sits on the clip planes; never clip it
  readonly providesSkip = true;      // sparse SDF -> cheap via empty-space skipping
  private center: Vec3;
  private half: Vec3;
  private color: [number, number, number];
  private opacity: number;
  private bar: number;
  /** Columns are the box axes in world; identity when the caller gave none. */
  private axes: number[];

  constructor(center: Vec3, half: Vec3, opts: RoiBoxOpts = {}) {
    this.center = [...center] as Vec3;
    this.half = [...half] as Vec3;
    this.color = opts.color ?? [1, 0.85, 0.25];
    this.opacity = opts.opacity ?? 1;
    this.bar = opts.barHalfMm ?? 1.5;
    this.axes = opts.axes && opts.axes.length === 9 ? [...opts.axes] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  /** Column `k` of the axes matrix: the box's k-th axis, in world. */
  private axis(k: 0 | 1 | 2): Vec3 { return [this.axes[k], this.axes[3 + k], this.axes[6 + k]]; }

  /** Re-orient the box (e.g. when its transform changes). */
  setAxes(axes?: number[]) {
    this.axes = axes && axes.length === 9 ? [...axes] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  /** Update the box (a drag) — caller does scene.syncUniforms() + redraw. */
  setBox(center: Vec3, half: Vec3) { this.center = [...center] as Vec3; this.half = [...half] as Vec3; }
  get boxCenter(): Vec3 { return [...this.center] as Vec3; }
  get boxHalf(): Vec3 { return [...this.half] as Vec3; }

  uniformFloats() { return 28; }     // center(4) + half(4) + color(4) + params(4) + 3 axis rows(12)
  sampleStep(): number { return Math.max(0.5 * this.bar, 0.25); }
  /**
   * The world box that bounds the frame. For an oriented box that is the extent of its eight
   * corners, not center-plus-half -- and it has to be right or the empty-space skip would cut the
   * ray short of bars it should have hit.
   */
  aabb(): [Vec3, Vec3] {
    const m = this.bar + 0.5;
    const [u, v, w] = [this.axis(0), this.axis(1), this.axis(2)];
    const lo: Vec3 = [Infinity, Infinity, Infinity];
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let n = 0; n < 8; n++) {
      const a = (n & 1 ? 1 : -1) * this.half[0];
      const b = (n & 2 ? 1 : -1) * this.half[1];
      const c = (n & 4 ? 1 : -1) * this.half[2];
      for (let k = 0; k < 3; k++) {
        const p = this.center[k] + u[k] * a + v[k] * b + w[k] * c;
        if (p < lo[k]) lo[k] = p;
        if (p > hi[k]) hi[k] = p;
      }
    }
    return [[lo[0] - m, lo[1] - m, lo[2] - m], [hi[0] + m, hi[1] + m, hi[2] + m]];
  }

  structMembers(s: number): string {
    return [
      `  roi${s}_center : vec4<f32>,`,   // cx,cy,cz,_
      `  roi${s}_half : vec4<f32>,`,     // hx,hy,hz,_
      `  roi${s}_color : vec4<f32>,`,    // rgb, opacity
      `  roi${s}_params : vec4<f32>,`,   // bar_half, _, _, _
      `  roi${s}_ax : vec4<f32>,`,       // box axis 0 in world (unit)
      `  roi${s}_ay : vec4<f32>,`,       // box axis 1
      `  roi${s}_az : vec4<f32>,`,       // box axis 2
    ].join("\n");
  }

  declareBindings(): string { return ""; }
  bindEntries(): GPUBindGroupEntry[] { return []; }

  samplingWGSL(s: number): string {
    return /* wgsl */ `
fn sd_box_frame${s}(p0 : vec3<f32>, b : vec3<f32>, e : f32) -> f32 {
  let p = abs(p0) - b;
  let q = abs(p + vec3<f32>(e)) - vec3<f32>(e);
  return min(min(
    length(max(vec3<f32>(p.x, q.y, q.z), vec3<f32>(0.0))) + min(max(p.x, max(q.y, q.z)), 0.0),
    length(max(vec3<f32>(q.x, p.y, q.z), vec3<f32>(0.0))) + min(max(q.x, max(p.y, q.z)), 0.0)),
    length(max(vec3<f32>(q.x, q.y, p.z), vec3<f32>(0.0))) + min(max(q.x, max(q.y, p.z)), 0.0));
}
fn sd_roi${s}(wp : vec3<f32>) -> f32 {
  // Into the box's own frame first: project the offset onto each box axis. For an orthonormal basis
  // that IS the inverse rotation, so the exact box-frame SDF below needs no other change -- and with
  // the default identity axes it reduces to the subtraction it used to be.
  let d = wp - u_material.roi${s}_center.xyz;
  let q = vec3<f32>(
    dot(d, u_material.roi${s}_ax.xyz),
    dot(d, u_material.roi${s}_ay.xyz),
    dot(d, u_material.roi${s}_az.xyz));
  return sd_box_frame${s}(q, u_material.roi${s}_half.xyz, u_material.roi${s}_params.x);
}
fn skip_roi${s}(wp : vec3<f32>) -> f32 {
  // exact exterior distance to the bars, minus a bar-width margin (stays conservative)
  return max(sd_roi${s}(wp) - u_material.roi${s}_params.x, 0.0);
}
fn sample_field_roi${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let op0 = u_material.roi${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let sd = sd_roi${s}(wp);
  // crisp opaque bar: ~1 inside, AA-ramp to 0 across ~half a sample step at the surface
  let op = clamp(0.5 - sd / max(u_material.scene.x, 1e-3), 0.0, 1.0) * op0;
  if (op <= 0.0) { return vec4<f32>(0.0); }
  // Shaded, not flat. Unlit bars read as pasted-on strokes next to the ray-marched, lit content
  // around them. The frame SDF is cheap and already evaluated, so a central-difference normal and
  // a headlight give the bars form for a handful of extra SDF taps on the few samples that hit one.
  let e = max(u_material.scene.x, 1e-3) * 0.5;
  let n = normalize(vec3<f32>(
    sd_roi${s}(wp + vec3<f32>(e, 0.0, 0.0)) - sd_roi${s}(wp - vec3<f32>(e, 0.0, 0.0)),
    sd_roi${s}(wp + vec3<f32>(0.0, e, 0.0)) - sd_roi${s}(wp - vec3<f32>(0.0, e, 0.0)),
    sd_roi${s}(wp + vec3<f32>(0.0, 0.0, e)) - sd_roi${s}(wp - vec3<f32>(0.0, 0.0, e))));
  let l = normalize(-rd);
  let diff = 0.55 + 0.45 * max(dot(n, l), 0.0);
  let spec = pow(max(dot(reflect(-l, n), -rd), 0.0), 24.0) * 0.35;
  let col = srgb2physical(u_material.roi${s}_color.rgb) * diff + vec3<f32>(spec);
  return vec4<f32>(col * op, op);
}`;
  }

  skipWGSL(s: number): string { return ""; }   // skip_roi<s> is emitted by samplingWGSL above

  fillUniforms(out: Float32Array, off: number) {
    out[off + 0] = this.center[0]; out[off + 1] = this.center[1]; out[off + 2] = this.center[2];
    out[off + 4] = this.half[0]; out[off + 5] = this.half[1]; out[off + 6] = this.half[2];
    out[off + 8] = this.color[0]; out[off + 9] = this.color[1]; out[off + 10] = this.color[2]; out[off + 11] = this.opacity;
    out[off + 12] = this.bar;
    const [u, v, w] = [this.axis(0), this.axis(1), this.axis(2)];
    out[off + 16] = u[0]; out[off + 17] = u[1]; out[off + 18] = u[2];
    out[off + 20] = v[0]; out[off + 21] = v[1]; out[off + 22] = v[2];
    out[off + 24] = w[0]; out[off + 25] = w[1]; out[off + 26] = w[2];
  }
}
