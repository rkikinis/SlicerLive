// The 3D view background, shared by every path that composites over it (Reconstructor,
// SceneRenderer) and by every page that presents one (colorize, slicer-app).
//
// The defaults reproduce 3D Slicer's 3D view: a darker blue-violet above fading to light lavender
// below. The values are vtkMRMLViewNode's own class defaults, read from an installed Slicer
// (5.13.0-2026-08-17) rather than copied from documentation:
//
//     BackgroundColor   0.756863, 0.764706, 0.909804   #C1C3E8
//     BackgroundColor2  0.454902, 0.470588, 0.745098   #7478BE
//
// Which stop goes where is a VTK convention worth stating, because it is easy to invert: with
// GradientBackground on, `SetBackground` is the BOTTOM color and `SetBackground2` is the TOP.
// Verified empirically by rendering a red/blue gradient offscreen in Slicer and sampling rows --
// red (Background) came out at y=0, blue (Background2) at the top row.
//
// INTERPOLATION SPACE. VTK ramps linearly between the two 8-bit sRGB endpoints; sampling Slicer's
// own gradient at t=0.25/0.5/0.75 matches sRGB-space interpolation to within 1/255 (midpoint
// 154,157,211). Shaders here therefore mix the stops in sRGB and convert the RESULT to physical
// (linear) light -- not the other way round. Converting each stop first and mixing in linear light
// lands the midtone roughly 6/255 too light, which is visible as a slightly washed-out band.

export type RGB = readonly [number, number, number];

/** 3D Slicer's 3D view background, top stop (vtkMRMLViewNode BackgroundColor2). */
export const SLICER_BG_TOP: RGB = [0.454902, 0.470588, 0.745098];

/** 3D Slicer's 3D view background, bottom stop (vtkMRMLViewNode BackgroundColor). */
export const SLICER_BG_BOTTOM: RGB = [0.756863, 0.764706, 0.909804];

/**
 * The WGSL the shaders share: `bg_at(y)` returns the sRGB background color for destination row
 * `y`, given an `array<vec4<f32>, 2>` uniform ([0] = top, [1] = bottom) and the full view height.
 *
 * `viewHeightExpr` is how the including shader names that height -- the full VIEW height, never a
 * patch or scissor rect, or each dirty region would paint its own complete gradient.
 *
 * `uniformName` lets a shader that already packs something else into `.w` (the accumulating
 * resolve keeps its blend factor there) supply its own uniform instead of a dedicated `u_bg`.
 */
export function bgAtWgsl(viewHeightExpr: string, uniformName = "u_bg"): string {
  return /* wgsl */ `
fn bg_at(y : f32) -> vec3<f32> {
  let t = clamp(y / max(${viewHeightExpr}, 1.0), 0.0, 1.0);
  return mix(${uniformName}[0].rgb, ${uniformName}[1].rgb, t);
}`;
}

// The explicit ArrayBuffer type parameter matters: returned across a module boundary a plain
// Float32Array widens to Float32Array<ArrayBufferLike>, which WebGPU's BufferSource rejects.
/**
 * Pack two stops into the 32-byte uniform layout the shaders expect.
 *
 * `w0`/`w1` fill the two unused `.w` lanes, which different shaders use for different things: the
 * accumulating resolve keeps its blend factor in `[0].w`, and shaders with no view-size uniform of
 * their own carry the view height in `[1].w` for the gradient. Both default to 1.
 */
export function bgUniform(top: RGB, bottom: RGB, w0 = 1, w1 = 1): Float32Array<ArrayBuffer> {
  return new Float32Array([top[0], top[1], top[2], w0, bottom[0], bottom[1], bottom[2], w1]);
}
