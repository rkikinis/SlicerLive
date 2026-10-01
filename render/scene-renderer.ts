// SceneRenderer — composes N fields into one ray-march pipeline. Assigns per-kind
// slots, lays out the material UBO (scene block + per-field blocks), generates WGSL
// (struct + bindings + per-field sampling fns + the dispatch loop), and renders.
// TS/WebGPU port of slicer_wgpu.scene_renderer's build_for_fields.

import type { Gpu } from "./device.ts";
import type { Field } from "./fields.ts";
import { bgAtWgsl, bgUniform, type RGB, SLICER_BG_BOTTOM, SLICER_BG_TOP } from "./background.ts";
import { type Mat4, type Vec3, invert, lookAt, multiply, orthoZO, perspectiveZO, perspectiveZOTile } from "./mat4.ts";

const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SCENE_FLOATS = 16; // bmin(4) bmax(4) scene(4) bg(4)
const CLIP_FLOATS = 36;  // clip_planes: array<vec4,8> (32) + clip_count: vec4 (4), appended as a tail

interface Placed { field: Field; slot: number; uoff: number; bbase: number }

/** Between the old double encoding (1.0) and the exact one (~2.2): Ron's choice from the patches, 2026-09-20. */
const SURFACE_COLOUR_GAMMA = 1.6;
const MESH_WGSL = /* wgsl */ `
struct MU { view_proj : mat4x4<f32>, eye : vec4<f32>, color : vec4<f32>, shade : vec4<f32>, look : vec4<f32> };
@group(0) @binding(0) var<uniform> mu : MU;
// THE COLOR IS sRGB AND THE TARGET IS sRGB. A segment's color is an sRGB triple (the palette,
// a SEG file's RecommendedDisplayCIELabValue converted, FreeSurfer's LUT); the render target is
// bgra8unorm-srgb, which encodes what the shader writes. Written raw, the color was encoded
// twice and came out lighter and paler than the swatch beside its name -- measured 2026-09-20:
// (140,220,220) drawn as (186,227,227). Ron: "the color disagrees with the color on the 3d
// structure." The exact conversion (the sRGB curve, as colorize-field.ts does it) made the
// surfaces read too dark to him beside what he was used to: "somewhere between what is now on
// the screen and the screenshot might be a good target" -- and from the patches
// (docs/mockups/surface-colour-patches-2026-09-20.html) he chose the half-way column: the
// color raised to SURFACE_COLOUR_GAMMA (1.6) instead of ~2.2. One number, every surface.
fn surface_colour(c : vec3<f32>) -> vec3<f32> { return pow(clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(${SURFACE_COLOUR_GAMMA.toFixed(2)})); }
struct VO { @builtin(position) pos : vec4<f32>, @location(0) wp : vec3<f32>, @location(1) nrm : vec3<f32> };
@vertex fn vs_mesh(@location(0) p : vec3<f32>, @location(1) n : vec3<f32>) -> VO {
  var o : VO; o.pos = mu.view_proj * vec4<f32>(p, 1.0); o.wp = p; o.nrm = n; return o;
}
struct FO { @location(0) col : vec4<f32>, @location(1) depth : vec4<f32>, @location(2) nrm : vec4<f32> };
@fragment fn fs_mesh(i : VO) -> FO {
  // PER-VERTEX NORMALS WHERE THERE ARE ANY, the flat face normal otherwise.
  //
  // The flat normal is one value per triangle, so a smooth surface still renders as facets -- which
  // is why an extracted segmentation surface looked no better than the volume it replaced until the
  // normals arrived. A loaded model that carries none keeps the old behavior: a zero-length
  // attribute means "not supplied", and dpdx/dpdy of the world position recovers the face normal.
  var n = normalize(cross(dpdx(i.wp), dpdy(i.wp)));
  if (dot(i.nrm, i.nrm) > 0.25) { n = normalize(i.nrm); }
  // LIGHTING FROM THE UNIFORM, not baked in. This was 0.25 + 0.75 * abs(dot(n, l)) -- ambient
  // 0.25, diffuse 0.75, and NO SPECULAR TERM AT ALL, which is exactly why Ron called the extracted
  // (NO BACKTICKS IN HERE. This is inside a JS template literal, and a backtick ends it -- which is
  // a trap already recorded in the working state and which I walked into writing this very comment.)
  // surfaces "a little washed out": a pure headlight with a high ambient floor and no highlight has
  // nothing to give the eye a sense of curvature.
  //
  // shade = (ambient, diffuse, specular, shininess). The light is still a headlight, so the halfway
  // vector equals the light direction and the specular term is dot(n, l) raised to the exponent --
  // no separate half-vector needed.
  let l = normalize(mu.eye.xyz - i.wp);                   // headlight
  let ndl = abs(dot(n, l));
  let a = mu.color.a;
  var o : FO;
  if (mu.look.x > 0.5) {
    // THE DRAWING LOOK (Mike Halle's non-photorealistic renderings; Ron, 2026-09-19: "let's do
    // the drawing look"): matte, no highlight, lit from above -- a sky/ground hemisphere on the
    // camera's up plus a key from the upper left -- so a tube reads as round by its darker
    // underside. The crevice shadow and the outlines are added in screen space afterwards
    // (NPR_WGSL). Mocked up first in Contents/tools/npr-mockup (the workspace), same terms.
    let up = mu.look.yzw;
    let right = normalize(cross(l, up));
    let key = normalize(l * 0.5 + up * 0.8 - right * 0.35);
    let hemi = 0.5 + 0.5 * dot(n, up);
    let ndk = abs(dot(n, key));
    // MATTE / STANDARD / GLOSSY WORK HERE TOO. The coefficients were written into the shader --
    // 0.22 ambient, 0.38 sky, 0.50 key, no highlight -- so the three buttons in the 3D view
    // settings did nothing at all while the drawing look was on. Ron, 2026-09-22: "The buttons are
    // already in the 3d view settings. Right now they only work for the regular surfaces ... When
    // drawing is selected, that would be the natural place."
    //
    // The preset's (ambient, diffuse, specular, shininess) drives them, and the drawing keeps its
    // character: the diffuse is split between the sky hemisphere and the key from the upper left,
    // so a tube still reads as round by its darker underside, and the highlight -- none on Matte,
    // soft on Standard, hard on Glossy -- sits on the key, where a draughtsman would put it.
    // The three have to be TELLABLE APART in a drawing, which a photographic highlight is not: at
    // shininess 64 the spot is a few pixels on a smooth bone and Glossy looked like Matte on screen
    // (measured against Matte, 2026-09-22). So the exponent is softened -- a broad sheen, the way an
    // illustrator lays one in -- and the gloss also decides how much of the light comes from the key
    // rather than the sky, which is what makes Matte read flat and Glossy read modeled.
    let gloss = clamp(mu.shade.z, 0.0, 1.0);
    let keyMix = 0.45 + 0.25 * gloss;
    let body = mu.shade.x + mu.shade.y * ((1.0 - keyMix) * hemi + keyMix * ndk);
    let hilite = select(0.0, 1.5 * gloss * pow(ndk, max(mu.shade.w * 0.35, 1.0)), gloss > 0.0);
    // The highlight is added after the color conversion, in linear light, for the same reason as
    // on the plain surfaces: through the sRGB curve first, Glossy reads as Matte.
    let lit = surface_colour(mu.color.rgb * body) + vec3<f32>(hilite);
    o.col = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)) * a, a);
    o.depth = vec4<f32>(distance(mu.eye.xyz, i.wp), 0.0, 0.0, 1.0);
    // The surface's own normal, facing the eye, for the drawing look's screen-space pass: rebuilt
    // from the depth image it straddles facet edges and tilts (see NPR_WGSL).
    o.nrm = vec4<f32>(select(n, -n, dot(n, l) < 0.0), 1.0);
    return o;
  }
  let lam = mu.shade.x + mu.shade.y * ndl;
  let spec = select(0.0, mu.shade.z * pow(ndl, max(mu.shade.w, 1.0)), mu.shade.z > 0.0);
  // THE HIGHLIGHT IS ADDED AFTER THE CONVERSION, in linear light: a white highlight of 0.34 put
  // through the sRGB curve first shrank to 0.09 and Glossy read as Matte (Ron, 2026-09-20: "we
  // lost glossy"). The color is converted, the highlight is light.
  let lit = surface_colour(mu.color.rgb * lam) + vec3<f32>(spec);
  o.col = vec4<f32>(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)) * a, a);   // premultiplied
  o.depth = vec4<f32>(distance(mu.eye.xyz, i.wp), 0.0, 0.0, 1.0);
  o.nrm = vec4<f32>(select(n, -n, dot(n, l) < 0.0), 1.0);
  return o;
}`;

/**
 * THE DRAWING LOOK'S SCREEN-SPACE HALF: from the mesh pass's color and depth alone, the shadow in
 * the crevices (ambient occlusion), a dark line where the depth jumps or the color changes (one
 * structure passing in front of another), and a soft darkening of the surface behind a nearer one.
 * Reads the mesh targets, writes a second color target the trace then composites instead of the
 * plain one. No new geometry, no new data: a display change. The normal is rebuilt from the depth
 * image (the smaller of the two neighbor differences on each axis, so an edge does not bend it).
 * Distances are in mm (RAS), so the look does not change with the trace resolution or the zoom.
 */
const NPR_WGSL = /* wgsl */ `
struct NU {
  inv_view_proj : mat4x4<f32>,
  view_proj : mat4x4<f32>,
  size : vec4<f32>,     // w, h, frame seed, _
  params : vec4<f32>,   // AO radius mm, AO strength, edge threshold mm, halo strength
};
@group(0) @binding(0) var<uniform> nu : NU;
@group(0) @binding(1) var t_col : texture_2d<f32>;
@group(0) @binding(2) var t_depth : texture_2d<f32>;
@group(0) @binding(3) var t_nrm : texture_2d<f32>;
struct V { @builtin(position) position : vec4<f32> };
@vertex fn vs_npr(@builtin(vertex_index) vi : u32) -> V {
  var o : V; o.position = vec4<f32>(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u), 0.0, 1.0); return o;
}
fn unproject(ndc : vec3<f32>) -> vec3<f32> { let w = nu.inv_view_proj * vec4<f32>(ndc, 1.0); return w.xyz / w.w; }
fn ray_at(pix : vec2<f32>) -> array<vec3<f32>, 2> {
  let ndc = vec2<f32>(pix.x / nu.size.x * 2.0 - 1.0, 1.0 - pix.y / nu.size.y * 2.0);
  let ro = unproject(vec3<f32>(ndc, 0.0));
  let rd = normalize(unproject(vec3<f32>(ndc, 1.0)) - ro);
  return array<vec3<f32>, 2>(ro, rd);
}
fn depth_at(p : vec2<i32>) -> f32 {
  let q = clamp(p, vec2<i32>(0), vec2<i32>(nu.size.xy) - vec2<i32>(1));
  return textureLoad(t_depth, q, 0).r;
}
/** The world point drawn at a pixel, or none (t >= 1e29). */
fn point_at(p : vec2<i32>, t : f32) -> vec3<f32> { let r = ray_at(vec2<f32>(p) + vec2<f32>(0.5)); return r[0] + r[1] * t; }
fn ign(p : vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
@fragment fn fs_npr(v : V) -> @location(0) vec4<f32> {
  let pix = vec2<i32>(v.position.xy);
  let c = textureLoad(t_col, pix, 0);
  let t = depth_at(pix);
  if (c.a <= 0.0 || t >= 1e29) { return c; }               // nothing drawn, or a see-through surface (no depth)
  let ray = ray_at(v.position.xy);
  let ro = ray[0]; let rd = ray[1];
  let p = ro + rd * t;
  // The view direction, the same for every pixel of a parallel projection and near enough for a
  // perspective one: depths are compared along it.
  let fwd = normalize(unproject(vec3<f32>(0.0, 0.0, 1.0)) - unproject(vec3<f32>(0.0, 0.0, 0.0)));
  let vd = dot(p, fwd);
  // Neighbors, and the normal from the depth image.
  let tl = depth_at(pix + vec2<i32>(-1, 0)); let tr = depth_at(pix + vec2<i32>(1, 0));
  let tu = depth_at(pix + vec2<i32>(0, -1)); let td = depth_at(pix + vec2<i32>(0, 1));
  let far = 1e29;
  let pl = point_at(pix + vec2<i32>(-1, 0), min(tl, t)); let pr = point_at(pix + vec2<i32>(1, 0), min(tr, t));
  let pu = point_at(pix + vec2<i32>(0, -1), min(tu, t)); let pd = point_at(pix + vec2<i32>(0, 1), min(td, t));
  var dx = pr - p; if (tl < far && (tr >= far || abs(tl - t) < abs(tr - t))) { dx = p - pl; }
  var dy = pd - p; if (tu < far && (td >= far || abs(tu - t) < abs(td - t))) { dy = p - pu; }
  var n = normalize(cross(dx, dy));
  if (dot(n, rd) > 0.0) { n = -n; }
  // THE SURFACE'S OWN NORMAL WHERE THE MESH PASS WROTE ONE. The normal above comes from the depth
  // image, and at a pixel on a facet edge its two differences lie on two facets: the cross tilts
  // into the surface, the hemisphere below dips under it, and every sample there is "occluded" --
  // a one-pixel dark line along every facet edge of the drawing copy, sharper the coarser the
  // facets (Ron, 2026-09-20, close up: "The triangles still show"). The mesh knows its smooth
  // normal; a slice quad writes none and keeps the depth one.
  let mn = textureLoad(t_nrm, pix, 0);
  if (mn.a > 0.5 && dot(mn.xyz, mn.xyz) > 0.25) { n = normalize(mn.xyz); if (dot(n, rd) > 0.0) { n = -n; } }
  // AMBIENT OCCLUSION: samples in a hemisphere over the surface point, denser near it; a sample that
  // lies behind what is drawn at its own pixel is occluded. The kernel turns with a per-pixel noise
  // that also turns with the frame seed, so the accumulation (a settled view averages frames)
  // smooths it.
  let radius = nu.params.x;
  let seed = ign(v.position.xy + vec2<f32>(nu.size.z * 7.31, nu.size.z * 3.17));
  let ang = seed * 6.2831853;
  var tang = vec3<f32>(cos(ang), sin(ang), 0.0);
  if (abs(n.z) > 0.9) { tang = vec3<f32>(cos(ang), 0.0, sin(ang)); }
  let tx = normalize(cross(n, tang)); let ty = cross(n, tx);
  var occ = 0.0;
  let N = 16;
  for (var i = 0; i < N; i++) {
    let fi = f32(i) + seed;
    let phi = fi * 2.399963;                                // golden angle: even coverage
    let s = (f32(i) + 0.5) / f32(N);
    let scale = 0.15 + 0.85 * s * s;                        // denser near the point
    let cz = 0.3 + 0.7 * fract(fi * 0.618034);              // above the surface, not grazing
    let rxy = sqrt(1.0 - cz * cz);
    let off = (tx * (cos(phi) * rxy) + ty * (sin(phi) * rxy) + n * cz) * (radius * scale);
    let sp = p + off;
    let clip = nu.view_proj * vec4<f32>(sp, 1.0);
    let sn = clip.xy / clip.w;
    let spix = vec2<i32>(vec2<f32>((sn.x + 1.0) * 0.5 * nu.size.x, (1.0 - sn.y) * 0.5 * nu.size.y));
    let st = depth_at(spix);
    if (st >= far) { continue; }
    let scene = point_at(spix, st);
    let dz = dot(sp, fwd) - dot(scene, fwd);                // > 0: the scene is nearer than the sample
    // The tolerance grows with the sample's distance: on the drawing copy a smooth surface is flat
    // facets a few mm across, and a sample just behind the neighboring facet's plane is not in a
    // crevice. Without this every seam between facets took a faint shadow, visible close up
    // (Ron, 2026-09-19: "the triangles seem to be visible").
    let tol = 0.3 + 0.12 * (radius * scale);
    if (dz > tol && dz < radius * 2.0) { occ += 1.0; }
  }
  let ao = 1.0 - occ / f32(N);
  var f = 1.0 - nu.params.y * (1.0 - ao * ao);
  // OUTLINES: a depth jump larger than the threshold to any of the four neighbors (a missing
  // neighbor counts as the largest jump: the silhouette), or a color change (another structure).
  var jump = 0.0;
  let ns = array<f32, 4>(tl, tr, tu, td);
  let np = array<vec3<f32>, 4>(pl, pr, pu, pd);
  for (var k = 0; k < 4; k++) {
    if (ns[k] >= far) { jump = 1e9; continue; }
    jump = max(jump, abs(dot(np[k], fwd) - vd));
  }
  let edge = clamp((jump - nu.params.z) / (nu.params.z * 3.0), 0.0, 1.0);
  // A COLOR CHANGE MEANS ANOTHER STRUCTURE, NOT ANOTHER FACET. The mesh color here is lit, and
  // the drawing copy is lit flat per facet (no vertex normals), so two facets at a small angle
  // differ in brightness -- compared as they were, every facet edge became a line (Ron,
  // 2026-09-20, a close picture of a rib cage: "The triangles still show"). Lighting scales a
  // color without turning its hue, so only the hue is compared: the direction of rgb, not its
  // length. A different structure has a different hue; a darker facet of the same one does not.
  var cchange = 0.0;
  // Clamped to the frame (nu.size), like depth_at. A moving frame is drawn into a corner of larger targets; the mesh
  // pass clears the whole texture every frame, so past the frame's edge reads empty, as the texture's edge did --
  // the clamp keeps that true if the clear ever stops covering it.
  let lim = vec2<i32>(nu.size.xy) - vec2<i32>(1);
  let cn = array<vec4<f32>, 4>(textureLoad(t_col, clamp(pix + vec2<i32>(-1, 0), vec2<i32>(0), lim), 0), textureLoad(t_col, clamp(pix + vec2<i32>(1, 0), vec2<i32>(0), lim), 0), textureLoad(t_col, clamp(pix + vec2<i32>(0, -1), vec2<i32>(0), lim), 0), textureLoad(t_col, clamp(pix + vec2<i32>(0, 1), vec2<i32>(0), lim), 0));
  let hue0 = c.rgb / max(length(c.rgb), 1e-4);
  for (var k = 0; k < 4; k++) {
    let hk = cn[k].rgb / max(length(cn[k].rgb), 1e-4);
    if (cn[k].a > 0.0 && length(cn[k].rgb) > 1e-4 && length(hk - hue0) > 0.25) { cchange = 0.6; }
  }
  let line = max(edge, cchange);
  f = f * (1.0 - 0.85 * line);
  // THE HALO: the surface behind a nearer one darkens for a few pixels next to it.
  var nearest = vd;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    let q = pix + vec2<i32>(vec2<f32>(cos(a), sin(a)) * 3.0);
    let qt = depth_at(q);
    if (qt < far) { nearest = min(nearest, dot(point_at(q, qt), fwd)); }
  }
  let halo = clamp((vd - nearest - nu.params.z) / 20.0, 0.0, 1.0);
  f = f * (1.0 - nu.params.w * halo);
  return vec4<f32>(c.rgb * f, c.a);
}`;

/**
 * A SLICE IN 3D: the 2D view's finished composite, on a quad.
 *
 * Ron: "Whatever is shown in the viewer maps into the slice in 3d. The user does the compositing
 * work in the 2d viewer and whatever is there, goes to the 3D viewer. This means that no matter how
 * complex the data only a single slice gets displayed in the 3D viewer." Which is what Slicer does
 * -- vtkMRMLSliceLogic builds a vtkPlaneSource model named "<Color> Volume Slice" and textures it
 * through the display node's texture image data connection.
 *
 * Three consequences, and they are the reason for this type:
 *   * the 3D slice CANNOT disagree with the 2D view, because it is the 2D view;
 *   * its cost does not grow with the number of datasets -- two volumes, a label layer and two
 *     segmentations composite once, in 2D, and 3D still sees one texture;
 *   * it is out of the ray-march, so it no longer drags the scene's global sample step. The march
 *     steps at min(sampleStep) over all fields, so one slice as a FIELD slowed the volume down
 *     everywhere (measured: one slice +15%, three +22%).
 */
export interface SliceQuad {
  id: string;
  /** The composite, rendered by SliceRenderer.renderPatientFrameInto (alpha 0 outside the volume). */
  tex: GPUTexture;
  /** The frame that render returned -- RAS center and the full-width/height spanning vectors. */
  origin: Vec3;
  uvec: Vec3;
  vvec: Vec3;
  opacity: number;
}
interface GpuSliceQuad { id: string; tex: GPUTexture; ubuf: GPUBuffer; origin: Vec3; uvec: Vec3; vvec: Vec3; opacity: number }

const SLICE_QUAD_WGSL = /* wgsl */ `
struct QU {
  view_proj : mat4x4<f32>,
  eye : vec4<f32>,
  origin : vec4<f32>,   // RAS center of the quad
  uvec : vec4<f32>,     // RAS vector spanning its full WIDTH
  vvec : vec4<f32>,     // RAS vector spanning its full HEIGHT
  params : vec4<f32>,   // opacity, _, _, _
};
@group(0) @binding(0) var<uniform> qu : QU;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var t_slice : texture_2d<f32>;
struct VO { @builtin(position) pos : vec4<f32>, @location(0) wp : vec3<f32> };
// Two triangles over the frame; no vertex buffer, the corners come from the uniform.
@vertex fn vs_quad(@builtin(vertex_index) vi : u32) -> VO {
  var xs = array<f32, 6>(-0.5, 0.5, -0.5, 0.5, 0.5, -0.5);
  var ys = array<f32, 6>(-0.5, -0.5, 0.5, -0.5, 0.5, 0.5);
  let wp = qu.origin.xyz + qu.uvec.xyz * xs[vi] + qu.vvec.xyz * ys[vi];
  var o : VO; o.pos = qu.view_proj * vec4<f32>(wp, 1.0); o.wp = wp; return o;
}
struct FO { @location(0) col : vec4<f32>, @location(1) depth : vec4<f32>, @location(2) nrm : vec4<f32> };
@fragment fn fs_quad(i : VO) -> FO {
  // UV by projecting the world position back onto the SAME frame the composite was rendered with,
  // rather than by interpolating a vertex attribute. Nothing to keep in step, and the mapping is
  // exact by construction. v is flipped because the slice shader's own v runs down the image.
  let d = i.wp - qu.origin.xyz;
  let uu = 0.5 + dot(d, qu.uvec.xyz) / dot(qu.uvec.xyz, qu.uvec.xyz);
  let vv = 0.5 - dot(d, qu.vvec.xyz) / dot(qu.vvec.xyz, qu.vvec.xyz);
  let s = textureSampleLevel(t_slice, s_lin, vec2<f32>(uu, vv), 0.0);
  // DISCARD, not alpha 0: writing depth here would put the quad's empty corners in front of the
  // volume as an invisible occluder -- a black frame around the anatomy.
  if (s.a < 0.5) { discard; }
  let a = clamp(qu.params.x, 0.0, 1.0);
  var o : FO;
  o.col = vec4<f32>(s.rgb * a, a);                        // premultiplied, as fs_mesh writes
  o.depth = vec4<f32>(distance(qu.eye.xyz, i.wp), 0.0, 0.0, 1.0);
  o.nrm = vec4<f32>(0.0);
  return o;
}`;

export interface SceneMesh {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-vertex normals (3 per vertex), or absent to keep the flat per-face shading. */
  normals?: Float32Array;
  color: [number, number, number];
  opacity: number;
  /** false: kept on the GPU but not drawn -- a frame of a sequence waiting for its turn. */
  visible?: boolean;
}
interface GpuMesh { id: string; positions: Float32Array; indices: Uint32Array; vbuf: GPUBuffer; ibuf: GPUBuffer; count: number; ubuf: GPUBuffer; color: [number, number, number]; opacity: number; visible: boolean; centre: [number, number, number] }
interface MeshTargets {
  /** w×h is what the textures hold; uw×uh is what THIS frame drew, in their top-left corner (a moving frame at a
   *  reduced resolution draws into a corner of the view-sized set instead of making its own; see meshTargets). */
  w: number; h: number; uw: number; uh: number; col: GPUTexture; depth: GPUTexture; nrm: GPUTexture; z: GPUTexture; bind?: GPUBindGroup; colNpr?: GPUTexture; bindNpr?: GPUBindGroup; nprIn?: GPUBindGroup;
  /** Copies of col/depth/nrm the solid pass reads while it writes the originals (made on first use). */
  colCopy?: GPUTexture; depthCopy?: GPUTexture; nrmCopy?: GPUTexture; solidIn?: GPUBindGroup;
}

export class SceneRenderer {
  // ── surface meshes (models): rasterised before each trace into colour+depth targets the march composites ──
  private meshPipeline!: GPURenderPipeline;
  private meshPipelineBlend!: GPURenderPipeline;   // see-through surfaces: blended, no depth write
  private gpuMeshes: GpuMesh[] = [];
  private meshTargetsBySize = new Map<string, MeshTargets>();
  /** For the test that compares a frame drawn in a corner with the same frame drawn into targets of its own size
   *  (render/test/moving-targets.gpu.test.ts): every size gets its own targets again, as before 2026-09-24. */
  private exactTargets = false;
  setExactTargets(on: boolean) { this.exactTargets = on; }
  private viewProj: Mat4 = new Float32Array(16) as unknown as Mat4;
  private eyePos: Vec3 = [0, 0, 0];

  /** Replace the surface meshes (world/RAS float32 xyz + uint32 triangles, colour, opacity). */
  /** (ambient, diffuse, specular, shininess) for every mesh in the view. Global on purpose: it is a
   *  property of the 3D view's lighting, not of one surface. Defaults to the old baked-in values so
   *  nothing changes until a preset is chosen. */
  private meshShade: [number, number, number, number] = [0.25, 0.75, 0, 1];
  setMeshShade(shade: [number, number, number, number]) { this.meshShade = shade; }
  meshShadeNow(): [number, number, number, number] { return [...this.meshShade]; }
  /** The drawing look (matte, outlines, crevice shadow) for every surface in the view. */
  private drawingLook = false;
  private camUp: Vec3 = [0, 0, 1];
  private nprPipeline?: GPURenderPipeline;
  private nprBuf?: GPUBuffer;
  private nprFrame = 0;
  setDrawingLook(on: boolean) { this.drawingLook = on; this.writeLook(); }
  /** The camera's up and whether the drawing look is on, for fields that light a surface the way
   *  the meshes are lit (the colored volume's solid look): the drawing look's key light sits
   *  up and to the left of the camera, so it needs the camera's up. */
  private writeLook() {
    this.dev.queue.writeBuffer(this.camBuf, 96, new Float32Array([this.camUp[0], this.camUp[1], this.camUp[2], this.drawingLook ? 1 : 0]));
    this.dev.queue.writeBuffer(this.camBuf, 112, this.viewProj as unknown as Float32Array);   // the solid pass's depth
  }
  drawingLookNow(): boolean { return this.drawingLook; }
  /** AO radius (mm), AO strength, outline threshold (mm), halo strength. */
  private nprParams: [number, number, number, number] = [14, 0.9, 2.5, 0.45];

  /**
   * GEOMETRY ALREADY ON THE GPU STAYS THERE. A mesh with the same id and the same position and
   * index arrays as last time keeps its buffers; only its color, opacity and visibility are taken
   * from the new entry. Before this, every call destroyed and re-uploaded everything -- a color
   * change re-sent twelve million triangles, and a sequence of segmentations stepping five times a
   * second would have re-sent its frame's surfaces on every step.
   */
  setMeshes(meshes: SceneMesh[]) {
    const keep = new Map(this.gpuMeshes.map((m) => [m.id, m]));
    const next: GpuMesh[] = [];
    for (const m of meshes) {
      if (m.indices.length < 3) continue;
      const prev = keep.get(m.id);
      if (prev && prev.positions === m.positions && prev.indices === m.indices) {
        keep.delete(m.id);
        prev.color = m.color; prev.opacity = m.opacity; prev.visible = m.visible !== false;
        next.push(prev);
        continue;
      }
      next.push(this.uploadMesh(m));
    }
    for (const m of keep.values()) { m.vbuf.destroy(); m.ibuf.destroy(); m.ubuf.destroy(); }
    this.gpuMeshes = next;
  }
  private uploadMesh(m: SceneMesh): GpuMesh {
    this.uploadCount++;
    const tUp = performance.now();
    try {
      // Interleaved [x,y,z, nx,ny,nz]: one buffer and one binding, and a mesh with no normals simply
      // leaves them zero, which the shader reads as "use the face normal".
      const nv = m.positions.length / 3;
      const inter = new Float32Array(nv * 6);
      let cx = 0, cy = 0, cz = 0;
      for (let v = 0; v < nv; v++) {
        inter[v * 6] = m.positions[v * 3]; inter[v * 6 + 1] = m.positions[v * 3 + 1]; inter[v * 6 + 2] = m.positions[v * 3 + 2];
        cx += m.positions[v * 3]; cy += m.positions[v * 3 + 1]; cz += m.positions[v * 3 + 2];
        if (m.normals) { inter[v * 6 + 3] = m.normals[v * 3]; inter[v * 6 + 4] = m.normals[v * 3 + 1]; inter[v * 6 + 5] = m.normals[v * 3 + 2]; }
      }
      // The vertex centroid, for ordering see-through surfaces back to front.
      const centre: [number, number, number] = nv ? [cx / nv, cy / nv, cz / nv] : [0, 0, 0];
      const vbuf = this.dev.createBuffer({ size: inter.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.dev.queue.writeBuffer(vbuf, 0, inter);
      const ibuf = this.dev.createBuffer({ size: Math.ceil(m.indices.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.dev.queue.writeBuffer(ibuf, 0, m.indices);
      const ubuf = this.dev.createBuffer({ size: 32 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { id: m.id, positions: m.positions, indices: m.indices, vbuf, ibuf, count: m.indices.length, ubuf, color: m.color, opacity: m.opacity, visible: m.visible !== false, centre };
    } finally {
      // The page's own time for this upload -- repacking the vertices and handing them over -- so the
      // 3D interaction line can say what "89 mesh uploads" cost the page (2026-09-23).
      this.uploadMs += performance.now() - tUp;
    }
  }
  /** The meshes that draw: the visible ones. */
  private get drawnMeshes(): GpuMesh[] { return this.gpuMeshes.filter((m) => m.visible); }
  hasMeshes(): boolean { return this.gpuMeshes.some((m) => m.visible) || this.sliceQuads.length > 0; }

  // ── slices in 3D: the 2D composite on a quad, rasterized in the same pass as the models ──
  private sliceQuadPipeline!: GPURenderPipeline;
  private quadSampler?: GPUSampler;
  private sliceQuads: GpuSliceQuad[] = [];

  /**
   * Replace the set of slices drawn in 3D.
   *
   * Textures are OWNED BY THE CALLER (they are its slice render targets, re-rendered in place when
   * the slice moves), so this only re-points at them -- and a texture whose CONTENT changes needs no
   * call here at all. That is the whole reason the old restage-on-volume-change path is gone: the
   * field baked the volume texture into a bind group, so a cell switching volumes forced a pipeline
   * rebuild.
   */
  setSliceQuads(quads: SliceQuad[]) {
    const keep = new Map(this.sliceQuads.map((q) => [q.id, q]));
    const next: GpuSliceQuad[] = [];
    for (const q of quads) {
      const prev = keep.get(q.id);
      keep.delete(q.id);
      // 36 floats: view_proj(16) eye(4) origin(4) uvec(4) vvec(4) params(4).
      const ubuf = prev?.ubuf ?? this.dev.createBuffer({ size: 36 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      next.push({ id: q.id, tex: q.tex, ubuf, origin: q.origin, uvec: q.uvec, vvec: q.vvec, opacity: q.opacity });
    }
    for (const gone of keep.values()) gone.ubuf.destroy();
    this.sliceQuads = next;
  }

  private ensureSliceQuadPipeline() {
    if (this.sliceQuadPipeline) return;
    const mod = this.dev.createShaderModule({ code: SLICE_QUAD_WGSL });
    this.sliceQuadPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs_quad" },
      fragment: { module: mod, entryPoint: "fs_quad", targets: [{ format: "rgba16float" }, { format: "r32float" }, { format: "rgba16float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    this.quadSampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
  }

  private ensureMeshPipeline() {
    if (this.meshPipeline) return;
    const mod = this.dev.createShaderModule({ code: MESH_WGSL });
    this.meshPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs_mesh", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] },
      fragment: { module: mod, entryPoint: "fs_mesh", targets: [{ format: "rgba16float" }, { format: "r32float" }, { format: "rgba16float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    // SEE-THROUGH SURFACES. Ron, on lung lobes over lung vessels: "it would be helpful to make the
    // lung lobes transparent." The opaque pipeline ignored opacity in every way that matters: the
    // shader wrote premultiplied alpha, the target did not blend, so a surface at 30% came out
    // darker, not see-through. This pipeline blends (premultiplied over), tests depth against the
    // opaque surfaces but does not write it, and leaves the mesh-depth target alone -- so the
    // volume ray-march, which composites at that depth, treats a see-through surface as behind
    // whatever it integrates. That is the known limit: a translucent lobe over a rendered volume
    // reads as behind the volume. Over surfaces, which is the case asked for, it is right.
    this.meshPipelineBlend = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs_mesh", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] },
      fragment: { module: mod, entryPoint: "fs_mesh", targets: [
        { format: "rgba16float", blend: { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } } },
        { format: "r32float", writeMask: 0 },
        { format: "rgba16float", writeMask: 0 },
      ] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });
  }
  /**
   * Color/depth targets (+ the group-1 bind group of the trace pipeline) for a frame drawn at w×h.
   *
   * ANY SET AT LEAST THAT BIG IS REUSED, the frame drawn into its top-left corner (every pass that writes them sets
   * its viewport to w×h; every read is by pixel, or clamped to w×h). Each size used to get its own set, and a drag
   * asked for a new size nearly every frame: ~80 MB of targets made and destroyed per frame on a Retina window.
   * Suspected -- NOT confirmed -- of Ron's out-of-memory reset on 2026-09-24 at 16:40: with this in place his page still
   * peaked at 3.5 GB during drags (WORKING-STATE, 17:04), so what drives those peaks is not yet known. Kept because a
   * drag now allocates nothing. A new set is made at capW×capH (the view's size, from renderUpscaled), so the moving
   * frames that follow fit in it.
   */
  private meshTargets(w: number, h: number, capW = w, capH = h): MeshTargets {
    let t: MeshTargets | undefined;
    if (this.exactTargets) { capW = w; capH = h; }
    for (const c of this.meshTargetsBySize.values()) {
      if (this.exactTargets ? (c.w === w && c.h === h) : (c.w >= w && c.h >= h && (!t || c.w * c.h < t.w * t.h))) t = c;
    }
    if (!t) {
      const tw = Math.max(w, capW), th = Math.max(h, capH), key = tw + "x" + th;
      if (this.meshTargetsBySize.size > 4) { for (const old of this.meshTargetsBySize.values()) { old.col.destroy(); old.depth.destroy(); old.nrm.destroy(); old.z.destroy(); old.colNpr?.destroy(); old.colCopy?.destroy(); old.depthCopy?.destroy(); old.nrmCopy?.destroy(); } this.meshTargetsBySize.clear(); }
      t = {
        w: tw, h: th, uw: w, uh: h,
        col: this.dev.createTexture({ size: [tw, th], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }),
        // COPY_SRC so the probe can read one texel back. This texture already holds exactly what the
        // 3D probe needs -- the distance from the eye to the mesh surface drawn at each pixel -- and
        // reading it is the only way to name WHAT IS ON SCREEN rather than what a ray happens to meet.
        depth: this.dev.createTexture({ size: [tw, th], format: "r32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }),
        // The surface normal per pixel, for the drawing look (rgba16float: xyz and a 1 where a mesh drew).
        nrm: this.dev.createTexture({ size: [tw, th], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC }),
        z: this.dev.createTexture({ size: [tw, th], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT }),
      };
      this.meshTargetsBySize.set(key, t);
    }
    t.uw = w; t.uh = h;
    if (!t.bind) {
      t.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: t.col.createView() }, { binding: 1, resource: t.depth.createView() }] });
      // bindNpr was made against the previous pipeline's layout whenever bind was: remake it too.
      if (t.colNpr) t.bindNpr = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: t.colNpr.createView() }, { binding: 1, resource: t.depth.createView() }] });
    }
    return t;
  }
  /** Rasterise the meshes for this frame's trace size; returns the bind group the trace pass needs. */
  private lastMeshTargets?: MeshTargets;
  private meshPass(enc: GPUCommandEncoder, w: number, h: number, capW = w, capH = h): GPUBindGroup {
    const t = this.meshTargets(w, h, capW, capH);
    this.lastMeshTargets = t;   // the probe reads this frame's depth, so it must be the size drawn
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: t.col.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        { view: t.depth.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 1e30, g: 0, b: 0, a: 1 } },
        { view: t.nrm.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: t.z.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    pass.setViewport(0, 0, w, h, 0, 1);   // the frame's corner of the targets (meshTargets)
    const drawn = this.drawnMeshes;
    // THE MODELS AND SLICE PLANES FIRST, THEN THE SOLID STRUCTURES OVER THEM, then the see-through models.
    // The solid pass reads copies of what the opaque models drew, stops each ray there and lays the
    // structures it met before over them (fs_solid). It used to run first: an opaque model behind a
    // see-through structure then painted over the structure's veil (critic, 2026-09-23, finding 1).
    const solid = this.solidWanted();
    const draw = (rp: GPURenderPassEncoder, m: GpuMesh, pipe: GPURenderPipeline) => {
      const u = new Float32Array(32); u.set(this.viewProj as unknown as Float32Array, 0);
      u[16] = this.eyePos[0]; u[17] = this.eyePos[1]; u[18] = this.eyePos[2]; u[19] = 1;
      u[20] = m.color[0]; u[21] = m.color[1]; u[22] = m.color[2]; u[23] = m.opacity;
      u[24] = this.meshShade[0]; u[25] = this.meshShade[1]; u[26] = this.meshShade[2]; u[27] = this.meshShade[3];
      u[28] = this.drawingLook ? 1 : 0; u[29] = this.camUp[0]; u[30] = this.camUp[1]; u[31] = this.camUp[2];
      this.dev.queue.writeBuffer(m.ubuf, 0, u);
      rp.setBindGroup(0, this.dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: m.ubuf } }] }));
      rp.setVertexBuffer(0, m.vbuf); rp.setIndexBuffer(m.ibuf, "uint32"); rp.drawIndexed(m.count);
    };
    // Opaque first, writing depth; then the see-through ones, farthest first, so a nearer
    // translucent surface is laid over a farther one and both over the opaque anatomy behind.
    const opaque = drawn.filter((m) => m.opacity >= 1);
    const clear = drawn.filter((m) => m.opacity < 1);
    if (clear.length) {
      const d2 = (m: GpuMesh) => { const dx = m.centre[0] - this.eyePos[0], dy = m.centre[1] - this.eyePos[1], dz = m.centre[2] - this.eyePos[2]; return dx * dx + dy * dy + dz * dz; };
      clear.sort((a, b) => d2(b) - d2(a));
    }
    if (drawn.length) this.ensureMeshPipeline();
    if (opaque.length) { pass.setPipeline(this.meshPipeline); for (const m of opaque) draw(pass, m, this.meshPipeline); }
    if (clear.length && !solid) { pass.setPipeline(this.meshPipelineBlend); for (const m of clear) draw(pass, m, this.meshPipelineBlend); }
    const nprWanted = this.drawingLook && (drawn.length > 0 || solid);
    // Slices share the pass and the depth buffer, so they interleave with the models correctly --
    // and, being opaque where they draw, several intersecting slices resolve by depth for free.
    if (this.sliceQuads.length) {
      this.ensureSliceQuadPipeline();
      pass.setPipeline(this.sliceQuadPipeline);
      for (const q of this.sliceQuads) {
        const u = new Float32Array(36); u.set(this.viewProj as unknown as Float32Array, 0);
        u[16] = this.eyePos[0]; u[17] = this.eyePos[1]; u[18] = this.eyePos[2]; u[19] = 1;
        u[20] = q.origin[0]; u[21] = q.origin[1]; u[22] = q.origin[2]; u[23] = 0;
        u[24] = q.uvec[0]; u[25] = q.uvec[1]; u[26] = q.uvec[2]; u[27] = 0;
        u[28] = q.vvec[0]; u[29] = q.vvec[1]; u[30] = q.vvec[2]; u[31] = 0;
        u[32] = q.opacity;
        this.dev.queue.writeBuffer(q.ubuf, 0, u);
        pass.setBindGroup(0, this.dev.createBindGroup({
          layout: this.sliceQuadPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: q.ubuf } },
            { binding: 1, resource: this.quadSampler! },
            { binding: 2, resource: q.tex.createView() },
          ],
        }));
        pass.draw(6);
      }
    }
    pass.end();
    if (solid) {
      if (!t.colCopy) {
        const mk = (format: GPUTextureFormat) => this.dev.createTexture({ size: [t.w, t.h], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        t.colCopy = mk("rgba16float"); t.depthCopy = mk("r32float"); t.nrmCopy = mk("rgba16float");
      }
      if (!t.solidIn) {
        t.solidIn = this.dev.createBindGroup({ layout: this.solidPipeline!.getBindGroupLayout(1), entries: [
          { binding: 0, resource: t.colCopy.createView() }, { binding: 1, resource: t.depthCopy!.createView() }, { binding: 2, resource: t.nrmCopy!.createView() },
        ] });
      }
      enc.copyTextureToTexture({ texture: t.col }, { texture: t.colCopy }, [w, h]);
      enc.copyTextureToTexture({ texture: t.depth }, { texture: t.depthCopy! }, [w, h]);
      enc.copyTextureToTexture({ texture: t.nrm }, { texture: t.nrmCopy! }, [w, h]);
      const load = (view: GPUTextureView): GPURenderPassColorAttachment => ({ view, loadOp: "load", storeOp: "store" });
      const sp = enc.beginRenderPass({
        colorAttachments: [load(t.col.createView()), load(t.depth.createView()), load(t.nrm.createView())],
        depthStencilAttachment: { view: t.z.createView(), depthLoadOp: "load", depthStoreOp: "store" },
      });
      sp.setViewport(0, 0, w, h, 0, 1);
      sp.setPipeline(this.solidPipeline!); sp.setBindGroup(0, this.solidBind!); sp.setBindGroup(1, t.solidIn); sp.draw(3);
      if (clear.length) { sp.setPipeline(this.meshPipelineBlend); for (const m of clear) draw(sp, m, this.meshPipelineBlend); }
      sp.end();
    }
    if (!nprWanted) return t.bind!;
    // THE DRAWING LOOK'S SCREEN-SPACE PASS: color + depth in, a second color target out, which
    // the trace composites in place of the plain one. The depth target is untouched (the probe
    // and the pick read it).
    this.ensureNprPipeline();
    if (!t.colNpr) {
      t.colNpr = this.dev.createTexture({ size: [t.w, t.h], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      t.nprIn = this.dev.createBindGroup({ layout: this.nprPipeline!.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.nprBuf! } }, { binding: 1, resource: t.col.createView() }, { binding: 2, resource: t.depth.createView() },
        { binding: 3, resource: t.nrm.createView() },
      ] });
      t.bindNpr = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: t.colNpr.createView() }, { binding: 1, resource: t.depth.createView() }] });
    }
    const nu = new Float32Array(40);
    nu.set(this.baseInvVP as unknown as Float32Array, 0);
    nu.set(this.viewProj as unknown as Float32Array, 16);
    nu[32] = w; nu[33] = h; nu[34] = (this.nprFrame++ % 64); nu[35] = 0;
    nu[36] = this.nprParams[0]; nu[37] = this.nprParams[1]; nu[38] = this.nprParams[2]; nu[39] = this.nprParams[3];
    this.dev.queue.writeBuffer(this.nprBuf!, 0, nu);
    const np = enc.beginRenderPass({ colorAttachments: [{ view: t.colNpr.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    np.setViewport(0, 0, w, h, 0, 1);
    np.setPipeline(this.nprPipeline!); np.setBindGroup(0, t.nprIn!); np.draw(3); np.end();
    return t.bindNpr!;
  }
  private ensureNprPipeline() {
    if (this.nprPipeline) return;
    const mod = this.dev.createShaderModule({ code: NPR_WGSL });
    this.nprBuf = this.dev.createBuffer({ size: 40 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.nprPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: mod, entryPoint: "vs_npr" },
      fragment: { module: mod, entryPoint: "fs_npr", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
  }

  private dev: GPUDevice;
  private format: GPUTextureFormat;
  private placed: Placed[] = [];
  private pipeline!: GPURenderPipeline;
  private sampler: GPUSampler;
  private camBuf: GPUBuffer;
  private matBuf!: GPUBuffer;
  private mat!: Float32Array;
  private bind!: GPUBindGroup;
  // PICK pass: a 1x1 ray-trace that reuses the field compositing to find the RAS point where
  // front-to-back opacity first crosses 50% (Slicer's 3D volume pick). Ghost handles excluded.
  private pickPipeline?: GPURenderPipeline;
  private pickBind?: GPUBindGroup;
  /** The solid pass: colored volumes in the solid look, drawn into the surfaces' targets. */
  private solidPipeline?: GPURenderPipeline;
  private solidBind?: GPUBindGroup;
  private solidWanted(): boolean {
    return !!this.solidPipeline && !!this.solidBind && this.placed.some((p) => (p.field as { isSolid?: () => boolean }).isSolid?.() === true);
  }
  private pickOff = 0;                 // mat[] offset of the pick_cursor uniform (NDC)
  private pickTarget?: GPUTexture;     // 1x1 rgba32float (wp.xyz, hit)
  private pickReadBuf?: GPUBuffer;
  // PRODUCER→RECONSTRUCTOR seam (docs/UNIFIED-RENDERING-PLAN.md M1). The ray-march writes the
  // premultiplied composited sample into `traceTex` (rgba32float, lossless); `resolvePipeline`
  // composites it over the background into the output view. 1:1 for now (byte-identical); the
  // resolve pass is where spatial upsample + temporal accumulation (time-averaged AA) will live.
  private resolvePipeline!: GPURenderPipeline;
  private resolveBind?: GPUBindGroup;
  private resolveBgBuf: GPUBuffer;
  private traceTex?: GPUTexture;
  private traceView?: GPUTextureView;
  private traceW = 0;
  private traceH = 0;
  // TEMPORAL ACCUMULATION (M2a, docs/UNIFIED-RENDERING-PLAN.md §3). When the view is still, each
  // frame jitters the CAMERA sub-pixel (Halton, via a clip-space translation of invVP — the shader
  // is untouched, so a non-jittered frame is byte-identical) and the Reconstructor folds it into a
  // running mean, converging to a supersampled, time-averaged-AA image. Ping-pong accum + running n.
  private baseInvVP: Mat4 = new Float32Array(16) as unknown as Mat4;   // last setCamera invVP (unjittered)
  private focalPx = 1;                  // last setCamera focal (view→pixels); used to keep screen-space handles view-sized under low-res trace
  private accumPipeline!: GPURenderPipeline;   // MRT: trace + prev-accum -> new-accum + presented view
  private accumBind: (GPUBindGroup | undefined)[] = [undefined, undefined];
  private accumUniformBuf: GPUBuffer;   // [0]=(bgTop.rgb, blend), [1]=(bgBottom.rgb, viewH)
  // The two background stops. mat[12..15] keeps the bottom stop as well, since mat is uploaded
  // wholesale to matBuf and those slots are part of that larger uniform.
  private bgTop: RGB = SLICER_BG_TOP;
  private bgBottom: RGB = SLICER_BG_BOTTOM;
  private accumTex: (GPUTexture | undefined)[] = [undefined, undefined];
  private accumView: (GPUTextureView | undefined)[] = [undefined, undefined];
  private accumPing = 0;
  private accumN = 0;
  private lastAccumCam = new Float32Array(16);   // camera (invVP) of the last accumulated frame
  private lastAccumValid = false;                // false forces a reset (after a rebuild / first frame)
  private streamPipeline!: GPURenderPipeline;    // trace -> rgba8unorm, for compact sample readback (remote)
  private streamBind?: GPUBindGroup;             // its OWN bind group (auto-layout differs from this.pipeline's)
  // RESOLUTION-SCALED reconstruction (M2b): while interacting, trace at a fraction of the view
  // (BudgetController) and Catmull-Rom UPSAMPLE the low-res trace to the view — the client-superres
  // ported from the Python spike. A settled view renders native + accumulates instead.
  private superresPipeline!: GPURenderPipeline;
  private superresBind?: GPUBindGroup;
  private superresBuf: GPUBuffer;       // (traceW, traceH, viewW, viewH)
  private superresCapBuf: GPUBuffer;    // (lowTex width, lowTex height, _, _): the frame is its top-left corner
  // The moving/upscale path traces into its OWN low-res target so it never resizes/destroys the
  // full-size traceTex the accumulation bind groups reference (that sharing caused destroyed-texture
  // submits + MRT attachment-size mismatches → 3D flicker/blank during interaction).
  private lowTex?: GPUTexture;
  private lowView?: GPUTextureView;
  private lowW = 0;
  private lowH = 0;
  private accumW = 0;
  private accumH = 0;

  /** Emit a default AABB-distance skip for fields that don't supply their own bound.
   *
   *  OFF because it MEASURED AS A NET LOSS (render/test/profile-boxskip.ts, 448², M-series):
   *      MultiVolume +8.7%   Volume+Fiducials +7.3%   Segmentation +96.5%   SingleVolume -15.5%
   *  The appealing theory — "Panoramix sits +200mm R of CTACardio, so rays spend much of the
   *  scene box outside one volume" — is true but worthless: ImageField's out-of-box sample was
   *  ALREADY nearly free (it early-returns on the texture-bounds test), so there was no per-step
   *  cost to remove. Meanwhile every field pays a box distance + horizon bookkeeping at every
   *  step it is INSIDE its box, which is most of the march since the scene box is the union of
   *  the field boxes. Fields with their own cheap early-out are hurt worst — SegmentField
   *  (`v<=0.02||v>=0.98`) nearly doubles. The lone SingleVolume win survives warm-up but has no
   *  algorithmic explanation (the box IS the scene box there, so the bound is 0 at every sample)
   *  and is almost certainly a shader-compiler/occupancy artifact — not something to bank on.
   *
   *  Kept behind a flag rather than deleted so the negative result stays reproducible, and
   *  because it may behave differently on other GPUs (NVIDIA/AMD) — re-measure before enabling.
   *  The real win for dense volumes is an occupancy grid over air INSIDE the box, not the box. */
  static boxSkip = false;

  private canTime: boolean;
  private clipOff = 0;
  private lastWgsl = "";
  /** Shader compilations so far -- a step of a sequence must not add one (see build). */
  buildCount = 0;
  /** Mesh buffers uploaded so far -- a step of a sequence must not add any (see nothingIn3D). */
  uploadCount = 0;
  /** Milliseconds the page spent in mesh uploads, all told. */
  uploadMs = 0;

  constructor(gpu: Gpu, format: GPUTextureFormat = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    this.canTime = gpu.features.has("timestamp-query");
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.camBuf = this.dev.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); // invVP(64)+size(16)+eye(16)+look(16)+viewProj(64)
    // The Reconstructor pipeline is field-independent, so build it ONCE here (unlike the trace
    // pipeline, which is rebuilt per field set). Its bind group (trace texture) is (re)made per size.
    this.resolveBgBuf = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const rmod = this.dev.createShaderModule({ code: this.resolveWgsl() });
    this.resolvePipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: rmod, entryPoint: "vs_resolve" },
      fragment: { module: rmod, entryPoint: "fs_resolve", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    // Accumulating reconstructor (MRT): writes the new running-mean sample AND the presented view.
    this.accumUniformBuf = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const amod = this.dev.createShaderModule({ code: this.accumWgsl() });
    this.accumPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: amod, entryPoint: "vs_resolve" },
      fragment: { module: amod, entryPoint: "fs_accum", targets: [{ format: "rgba32float" }, { format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
    // Catmull-Rom upsampling reconstructor (moving frames): low-res trace -> view.
    this.superresBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.superresCapBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const smod = this.dev.createShaderModule({ code: this.superresWgsl() });
    this.superresPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: smod, entryPoint: "vs_resolve" },
      fragment: { module: smod, entryPoint: "fs_superres", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    });
  }

  /** RECONSTRUCTOR (upsampling): Catmull-Rom (bicubic, 9 bilinear taps) reconstruction of the
   *  low-res premultiplied trace, composited over the background — the client-superres from the
   *  Python spike (435b28d), on WebGPU. Slight edge sharpening from the negative lobes; premultiplied
   *  so the alpha reconstructs correctly. Used only when the trace is smaller than the view. */
  private superresWgsl(): string {
    return /* wgsl */ `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var<uniform> u_sr : vec4<f32>;   // (traceW, traceH, viewW, viewH)
// Background gradient stops, sRGB: [0] = top, [1] = bottom (see render/background.ts).
@group(0) @binding(3) var<uniform> u_bg : array<vec4<f32>, 2>;
// The texture's own size: the frame (u_sr.xy) is drawn into its top-left corner (ensureLow).
@group(0) @binding(4) var<uniform> u_cap : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
${bgAtWgsl("u_sr.w")}
// Catmull-Rom via 9 bilinear taps (Sigg/Hadwiger form). Tap positions are clamped to the frame's edge texel
// centers, which is what the sampler's clamp-to-edge did when the frame filled the texture: the same image, and
// nothing read from beyond the frame.
fn cr(uv : vec2<f32>, texSize : vec2<f32>) -> vec4<f32> {
  let sp = uv * texSize;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let off12 = w2 / w12;
  let inv = 1.0 / u_cap.xy;
  let lo = vec2<f32>(0.5);
  let hi = texSize - 0.5;
  let p0 = clamp(tp1 - 1.0, lo, hi) * inv;
  let p3 = clamp(tp1 + 2.0, lo, hi) * inv;
  let p12 = clamp(tp1 + off12, lo, hi) * inv;
  var r = vec4<f32>(0.0);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p0.y),  0.0) * (w0.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p0.y),  0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p0.y),  0.0) * (w3.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p12.y), 0.0) * (w0.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p12.y), 0.0) * (w3.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p3.y),  0.0) * (w0.x  * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p3.y),  0.0) * (w12.x * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p3.y),  0.0) * (w3.x  * w3.y);
  return r;
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_superres(v : RV) -> @location(0) vec4<f32> {
  let uv = v.position.xy / u_sr.zw;
  let s = cr(uv, u_sr.xy);
  let a = clamp(s.a, 0.0, 1.0);
  let bg = srgb2physical(bg_at(v.position.y));
  return vec4<f32>(mix(bg, s.rgb, a), 1.0);
}`;
  }

  /** Accumulating RECONSTRUCTOR: fold this frame's traced sample into the running mean (blend =
   *  1/n; blend=1 on reset → mean=this frame) and present it over the background. MRT so one pass
   *  updates the accumulation texture AND the swap-chain view. Frame N jitters the ray sub-pixel,
   *  so the mean over N frames is a supersampled, time-averaged-AA image (still camera). */
  private accumWgsl(): string {
    return /* wgsl */ `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var t_accum : texture_2d<f32>;
// [0] = (bgTop.rgb, blend), [1] = (bgBottom.rgb, viewH). The blend factor keeps its place in
// [0].w, so the view height the gradient needs rides along in [1].w instead.
@group(0) @binding(2) var<uniform> u_ra : array<vec4<f32>, 2>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
${bgAtWgsl("u_ra[1].w", "u_ra")}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
struct FO { @location(0) accum : vec4<f32>, @location(1) present : vec4<f32> };
@fragment
fn fs_accum(v : RV) -> FO {
  let p = vec2<i32>(v.position.xy);
  let cur = textureLoad(t_trace, p, 0);
  let prev = textureLoad(t_accum, p, 0);
  let acc = mix(prev, cur, u_ra[0].w);     // blend=1 on reset -> acc = cur
  let bg = srgb2physical(bg_at(v.position.y));
  var o : FO;
  o.accum = acc;
  o.present = vec4<f32>(mix(bg, acc.rgb, acc.a), 1.0);
  return o;
}`;
  }

  /** RECONSTRUCTOR (M1: identity resolve). Composites the traced premultiplied sample over the
   *  background — the exact `mix(bg, rgb, a)` the fused fs_main used. `textureLoad` at integer
   *  coords is a 1:1 fetch (no filtering), so the output is byte-identical to the fused path.
   *  M2 replaces this with a spatial-upsample + temporal-accumulate resolve. */
  private resolveWgsl(): string {
    return /* wgsl */ `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
// [0] = (bgTop.rgb, _), [1] = (bgBottom.rgb, viewH). This pass has no view-size uniform of its
// own, so the height the gradient needs rides in [1].w.
@group(0) @binding(1) var<uniform> u_bg : array<vec4<f32>, 2>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
${bgAtWgsl("u_bg[1].w")}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_resolve(v : RV) -> @location(0) vec4<f32> {
  let s = textureLoad(t_trace, vec2<i32>(v.position.xy), 0);
  let bg = srgb2physical(bg_at(v.position.y));
  return vec4<f32>(mix(bg, s.rgb, s.a), 1.0);
}`;
  }

  /** (Re)allocate the trace target + resolve bind group when the view size changes. */
  private ensureTrace(width: number, height: number) {
    if (this.traceTex && this.traceW === width && this.traceH === height) return;
    this.traceTex?.destroy();
    this.traceTex = this.dev.createTexture({
      size: [width, height], format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.traceView = this.traceTex.createView();
    this.traceW = width; this.traceH = height;
    this.resolveBind = this.dev.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.traceView }, { binding: 1, resource: { buffer: this.resolveBgBuf } }],
    });
    // The accumulation bind groups read THIS trace. When the trace is replaced at a size the accum
    // targets already have -- a picture rendered off screen at another size (renderToRGBA), then the
    // view drawing again at its own -- ensureAccum's size check passes and its binds would still
    // point at the texture just destroyed: "Destroyed texture used in a submit", every view dead
    // (2026-09-20, the first __savePicture). So the binds follow the trace.
    if (this.accumTex[0]) this.bindAccum();
  }

  /** (Re)allocate the low-res trace target + superres bind group when the moving render size changes.
   *  Separate from traceTex so a moving frame never disturbs the accumulation textures. */
  /** The moving frame's target: KEPT while it is big enough, the frame drawn into its top-left corner, and made at
   *  the view's size when it is not -- so a drag, whose frame size changes with the budget, allocates nothing
   *  (meshTargets says why). lowW×lowH is the texture's size, not the frame's. */
  private ensureLow(width: number, height: number, capW = width, capH = height) {
    if (this.exactTargets) { capW = width; capH = height; }
    if (this.lowTex && (this.exactTargets ? this.lowW === width && this.lowH === height : this.lowW >= width && this.lowH >= height)) return;
    this.lowTex?.destroy();
    const tw = Math.max(width, capW), th = Math.max(height, capH);
    this.lowTex = this.dev.createTexture({ size: [tw, th], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.lowView = this.lowTex.createView();
    this.lowW = tw; this.lowH = th;
    this.dev.queue.writeBuffer(this.superresCapBuf, 0, new Float32Array([tw, th, 0, 0]));
    this.superresBind = this.dev.createBindGroup({
      layout: this.superresPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.lowView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.superresBuf } },
        { binding: 3, resource: { buffer: this.resolveBgBuf } },
        { binding: 4, resource: { buffer: this.superresCapBuf } },
      ],
    });
  }

  /** Adaptive (moving-frame) render: trace at `renderW×renderH` and Catmull-Rom upsample to the
   *  `viewW×viewH` output. The caller MUST have set the camera size to renderW×renderH (so the
   *  low-res rays fill the same frustum). Single frame, no accumulation — use while interacting;
   *  switch to renderAccum when the view settles. */
  renderUpscaled(view: GPUTextureView, renderW: number, renderH: number, viewW: number, viewH: number) {
    this.ensureLow(renderW, renderH, viewW, viewH);   // own low-res target (never touches traceTex / accum), view-sized
    this.flush();
    // Screen-space handles (FiducialField) size from u_cam.size.z (focal). setCamera(renderW,renderH)
    // set it from the LOW-res height, which would make handles grow ~1/scale after upsampling. Rewrite
    // it to the VIEW focal so they stay a constant on-screen size (rays/frustum are unchanged).
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([this.focalPx * (viewH / renderH)]));
    this.dev.queue.writeBuffer(this.superresBuf, 0, new Float32Array([renderW, renderH, viewW, viewH]));
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, bgUniform(this.bgTop, this.bgBottom));   // gradient for the superres composite (u_bg) — else moving frames composite over black
    let enc = this.dev.createCommandEncoder();
    const mb = this.meshPass(enc, renderW, renderH, viewW, viewH);   // view-sized targets, this frame in their corner
    enc = this.traceInStrips(enc, mb, this.lowView!, renderW, renderH);   // the frame Ron's crash was in (25%, moving)
    const sp = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    sp.setPipeline(this.superresPipeline); sp.setBindGroup(0, this.superresBind!); sp.draw(3); sp.end();
    this.dev.queue.submit([enc.finish()]);
  }

  /** Encode trace (producer) + resolve (reconstructor), output to `outView`. The ray march may be SUBMITTED in strips on the way (traceInStrips), so the
   *  encoder to finish is the one returned, not necessarily the one passed in. */
  private encodeFrame(enc: GPUCommandEncoder, outView: GPUTextureView): GPUCommandEncoder {
    const mb = this.meshPass(enc, this.traceW, this.traceH);
    enc = this.traceInStrips(enc, mb, this.traceView!, this.traceW, this.traceH);
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: outView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(this.resolvePipeline); rp.setBindGroup(0, this.resolveBind!); rp.draw(3); rp.end();
    return enc;
  }

  /**
   * THE RAY MARCH IN STRIPS, EACH ITS OWN SUBMISSION, SO NO SINGLE BATCH OF WORK CAN RUN LONG ENOUGH FOR
   * macOS TO KILL IT.
   *
   * Ron's full-case run, 2026-09-23 17:10: the colorized volume at full resolution, turned while an AI
   * network ran on the same graphics card, and the views died. macOS's log said why -- "Execution of the
   * command buffer was aborted ... Impacting Interactivity (kIOGPUCommandBufferCallbackErrorImpactingInteractivity)":
   * the system's watchdog ends a command buffer that keeps the card from drawing the screen, and WebKit
   * then reports the device lost. A frame was one command buffer; the march over the whole window was
   * most of it. Apple's answer to that watchdog is smaller command buffers, so the window server's own
   * work can run between them.
   *
   * So the march is drawn in horizontal strips (a scissor per strip, the first clearing the target),
   * each submitted before the next is encoded. The number of strips ADAPTS to what the card is doing:
   * every frame's work is timed to completion (onSubmittedWorkDone), and a strip that takes more than
   * STRIP_SLOW_MS doubles the count, one under STRIP_FAST_MS halves it. A light scene stays one strip
   * (one submission, as before); a heavy volume on a busy card is cut as fine as it needs. The pixels
   * are the same either way -- the scissor only decides which pass writes which rows.
   */
  private traceInStrips(enc: GPUCommandEncoder, mb: GPUBindGroup, target: GPUTextureView, W: number, H: number): GPUCommandEncoder {
    const n = Math.max(1, Math.min(this.traceStrips, H));
    const rows = Math.ceil(H / n);
    const t0 = performance.now();
    for (let b = 0; b * rows < H; b++) {
      const y = b * rows, h = Math.min(rows, H - y);
      const tp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: b === 0 ? "clear" : "load", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      tp.setViewport(0, 0, W, H, 0, 1);   // the target may be larger than the frame (ensureLow)
      tp.setPipeline(this.pipeline); tp.setBindGroup(0, this.bind); tp.setBindGroup(1, mb);
      if (n > 1) tp.setScissorRect(0, y, W, h);
      tp.draw(3); tp.end();
      if (n > 1) { this.dev.queue.submit([enc.finish()]); enc = this.dev.createCommandEncoder(); }
    }
    this.timeStrips(t0, n);
    return enc;
  }

  /** How many strips the next frame's march is cut into; see traceInStrips. It STARTS at 4, not 1:
   *  the adaptation learns from frames already drawn, and the first heavy frame after a change must not
   *  be one long batch. A light scene is halved back to one strip within a couple of frames. */
  private traceStrips = 4;
  private stripTiming = false;
  static readonly STRIP_SLOW_MS = 60;
  static readonly STRIP_FAST_MS = 15;
  static readonly STRIPS_MAX = 64;
  /** Time this frame's work to completion and adapt the strip count. One measurement at a time; the
   *  count is published as __traceStrips for the 3D interaction line and for whoever is looking. */
  private timeStrips(t0: number, n: number) {
    if (this.stripTiming || !this.dev.queue.onSubmittedWorkDone) return;
    this.stripTiming = true;
    this.dev.queue.onSubmittedWorkDone().then(() => {
      const perStrip = (performance.now() - t0) / n;
      if (perStrip > SceneRenderer.STRIP_SLOW_MS) this.traceStrips = Math.min(SceneRenderer.STRIPS_MAX, n * 2);
      else if (perStrip < SceneRenderer.STRIP_FAST_MS && n > 1) this.traceStrips = Math.max(1, n >> 1);
      (globalThis as unknown as { __traceStrips?: number }).__traceStrips = this.traceStrips;
    }).catch(() => { /* a lost device answers here too; nothing to adapt */ }).finally(() => { this.stripTiming = false; });
  }
  /** For tests: fix the strip count (the adaptation then moves it from there). */
  setTraceStrips(n: number) { this.traceStrips = Math.max(1, Math.floor(n)); }

  /** (Re)allocate the ping-pong accumulation targets + their bind groups on a size change. Tracks its
   *  OWN size and always rebuilds accumBind against the current traceView (which ensureTrace, called
   *  first in renderAccum, has just refreshed) — so the bind never dangles on a destroyed trace. */
  private ensureAccum(width: number, height: number) {
    if (this.accumTex[0] && this.accumW === width && this.accumH === height) return;
    this.accumW = width; this.accumH = height;
    for (let k = 0; k < 2; k++) {
      this.accumTex[k]?.destroy();
      this.accumTex[k] = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.accumView[k] = this.accumTex[k]!.createView();
    }
    this.bindAccum();
    this.accumN = 0; this.accumPing = 0;
  }

  /** accumBind[k] reads accum[k] as the previous mean (and the current trace); output goes to accum[1-k]. */
  private bindAccum() {
    for (let k = 0; k < 2; k++) {
      this.accumBind[k] = this.dev.createBindGroup({
        layout: this.accumPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.traceView! },
          { binding: 1, resource: this.accumView[k]! },
          { binding: 2, resource: { buffer: this.accumUniformBuf } },
        ],
      });
    }
  }

  /** Reset temporal accumulation — call when the view changes (camera move, scene edit, resize). */
  resetAccumulation() { this.accumN = 0; }
  /** ROLLING accumulation for scenes whose content keeps changing (an animation): each frame blends
   *  in with weight 1/min(n, accumWindow) — an exponential window of ~accumWindow frames instead of
   *  the running mean — so static content still converges toward jittered temporal AA while moving
   *  content keeps a short trail rather than smearing. Infinity (default) = the running mean. */
  accumWindow = Infinity;
  /** Frames accumulated since the last reset (0 before the first accumulated frame). */
  accumCount(): number { return this.accumN; }

  /** Accumulating render: trace this frame (sub-pixel jittered) and fold it into the running mean,
   *  presenting the mean over the background. `reset` (or a view change) restarts the mean at this
   *  frame (n=1, no jitter — byte-identical to renderToView). Call repeatedly while the view is
   *  still to converge to a supersampled, time-averaged-AA image. */
  renderAccum(view: GPUTextureView, width: number, height: number, reset: boolean) {
    this.ensureTrace(width, height);
    this.ensureAccum(width, height);
    // Only ever blend frames of the IDENTICAL view: if the camera changed since the last accumulated
    // frame (e.g. inertial spin, or a stray render during a fast drag), reset — otherwise the running
    // mean smears across angles into a ghost that the 1/n weight then can't clear ("never gets out").
    let camChanged = !this.lastAccumValid;
    const cam = this.baseInvVP as unknown as Float32Array;
    for (let i = 0; i < 16 && !camChanged; i++) if (cam[i] !== this.lastAccumCam[i]) camChanged = true;
    if (camChanged) reset = true;
    this.lastAccumCam.set(cam); this.lastAccumValid = true;
    if (reset) this.accumN = 0;
    this.accumN += 1;
    const n = this.accumN;
    // Sub-pixel camera jitter (Halton), applied as a clip-space translation of the stored invVP —
    // the SHADER is untouched, so frame 1 (no jitter) is byte-identical to renderToView. Δndc from a
    // ±0.5px offset: (2·jx/w, −2·jy/h) (y flips in ndc). world = invVP·(ndc+Δ) = (invVP·T)·ndc.
    if (n > 1) {
      const jx = SceneRenderer.halton(n, 2) - 0.5, jy = SceneRenderer.halton(n, 3) - 0.5;
      const T = new Float32Array(16); T[0] = T[5] = T[10] = T[15] = 1;
      T[12] = (2 * jx) / width; T[13] = (-2 * jy) / height;
      this.dev.queue.writeBuffer(this.camBuf, 0, multiply(this.baseInvVP, T as unknown as Mat4) as unknown as Float32Array);
    } else {
      this.dev.queue.writeBuffer(this.camBuf, 0, this.baseInvVP as unknown as Float32Array);   // exact base
    }
    // Ray-offset jitter varies with the accumulation index (see fs_trace). n=1 writes 0, so the
    // first accumulated frame is byte-identical to renderToView — the property the tests rely on.
    this.dev.queue.writeBuffer(this.camBuf, 76, new Float32Array([n - 1]));
    this.flush();
    this.dev.queue.writeBuffer(this.accumUniformBuf, 0, bgUniform(this.bgTop, this.bgBottom, 1 / Math.min(n, this.accumWindow), height));
    const prev = this.accumPing, next = 1 - this.accumPing;
    let enc = this.dev.createCommandEncoder();
    const mb = this.meshPass(enc, width, height);
    enc = this.traceInStrips(enc, mb, this.traceView!, width, height);
    const ap = enc.beginRenderPass({ colorAttachments: [
      { view: this.accumView[next]!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    ] });
    ap.setPipeline(this.accumPipeline); ap.setBindGroup(0, this.accumBind[prev]!); ap.draw(3); ap.end();
    this.dev.queue.submit([enc.finish()]);
    this.accumPing = next;
  }

  /** (Re)build the pipeline for a set of fields. */
  build(fields: Field[]) {
    const kindCount: Record<string, number> = {};
    let uoff = SCENE_FLOATS, bbase = 3; // bindings 0=cam,1=mat,2=sampler
    this.placed = fields.map((field) => {
      const slot = kindCount[field.kind] ?? 0;
      kindCount[field.kind] = slot + 1;
      const p: Placed = { field, slot, uoff, bbase };
      uoff += field.uniformFloats();
      bbase += field.bindingCount;
      return p;
    });
    this.clipOff = uoff;                 // clip tail lives after every field block
    this.pickOff = uoff + CLIP_FLOATS;   // pick_cursor tail after the clip tail (offsets stay stable)
    // +12 tail floats: pick_cursor(4) + probe_origin(4) + probe_dir(4). Kept after the clip
    // tail so every field's uniform offset is unaffected.
    const matFloats = uoff + CLIP_FLOATS + 12;
    this.mat = new Float32Array(matFloats);
    if (!this.matBuf || this.matBuf.size !== matFloats * 4) this.matBuf = this.dev.createBuffer({ size: matFloats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // SAY WHICH FIELDS, when the pipeline is refused. "Generated pipeline layout is not valid" is
    // all WebKit says when the generated bindings break a limit or collide; twice on a gated coronary
    // CTA (2026-09-13/14) it came with six segmentations in the scene and nothing said what was
    // bound. The error scope catches it here, where the field list is, and the report carries it.
    this.dev.pushErrorScope("validation");
    const fieldNote = this.placed.map((p) => `${p.field.kind}#${p.slot}@${p.bbase}x${p.field.bindingCount}`).join(" ");
    // THE SAME SHADER IS NOT COMPILED AGAIN. The WGSL depends only on the fields' kinds and slots,
    // and a sequence step swaps one frame's textures for another's under the same field kinds --
    // so a step recompiled the module and three pipelines for nothing, twice (critic, 2026-09-19,
    // finding 2: twenty compilations a second at 10 frames/s). Same code: keep the pipelines,
    // remake only the bind groups, which hold the textures.
    const code = this.wgsl();
    if (code !== this.lastWgsl || !this.pipeline) {
      if (this.lastWgsl && code !== this.lastWgsl) {
        let i = 0; while (i < code.length && code[i] === this.lastWgsl[i]) i++;
        void fetch("/_log", { method: "POST", body: `shader rebuilt: WGSL differs at ${i} of ${code.length}: …${code.slice(Math.max(0, i - 60), i + 80).replace(/\n/g, " ")}…`, keepalive: true }).catch(() => {});
      }
      this.lastWgsl = code;
      for (const t of this.meshTargetsBySize.values()) { t.bind = undefined; t.solidIn = undefined; }   // group-1 layouts belong to the new pipelines
      const module = this.dev.createShaderModule({ code });
      // The main pipeline is now the PRODUCER: it writes the traced sample to an rgba32float target
      // (not the swap-chain format); the resolve pipeline composites over the background.
      this.pipeline = this.dev.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba32float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      });
      // A second pipeline off the SAME module for the pick trace (outputs world position, not color).
      this.pickPipeline = this.dev.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_pick", targets: [{ format: "rgba32float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      });
      // STREAM pipeline (M3): the SAME fs_trace producer, but into rgba8unorm so the premultiplied
      // sample reads back as a compact 4-byte/px buffer to send over the wire (traceSamples). The
      // remote client reconstructs it exactly like the local resolve/superres pass.
      this.streamPipeline = this.dev.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba8unorm" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      });
      // The solid pass (see wgsl()): only when a colored volume is in the scene.
      this.solidPipeline = code.includes("fn fs_solid(") ? this.dev.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs_main" },
        fragment: { module, entryPoint: "fs_solid", targets: [{ format: "rgba16float" }, { format: "r32float" }, { format: "rgba16float" }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        // less-EQUAL: a pixel with only see-through structures writes the far depth (1), which must
        // still pass against the cleared buffer, or it is dropped.
        // ALWAYS: the pass runs after the models and composites with them itself (it reads their copies),
        // writing the depth of whatever is nearest -- its own opaque structure or the model.
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "always" },
      }) : undefined;
      this.buildCount++;
    }
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.solidBind = this.solidPipeline ? this.dev.createBindGroup({ layout: this.solidPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() }) : undefined;
    void this.dev.popErrorScope().then((err) => {
      if (!err) return;
      const g = globalThis as unknown as { __onGpuFailure?: (w: string, d: string) => void; __gpuMB?: number };
      const detail = `${err.message} — 3D fields: [${fieldNote}] (${this.placed.length} fields, ${3 + this.placed.reduce((n, p) => n + p.field.bindingCount, 0)} bindings, GPU ~${g.__gpuMB ?? "?"} MB)`;
      console.error("SceneRenderer.build:", detail);
      g.__onGpuFailure?.("3D pipeline refused", detail);
    });

    // scene defaults
    this.setBackgroundGradient(SLICER_BG_TOP, SLICER_BG_BOTTOM);   // match 3D Slicer's 3D view
    const step = this.placed.length ? Math.min(...this.placed.map((p) => p.field.sampleStep())) : 1.0;
    this.setSampleStep(step * 0.7); // sub-voxel for smoother integration (anti-banding)
    this.recomputeBounds();
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.accumN = 0; this.lastAccumValid = false;   // a rebuilt scene must NOT blend into the old accumulation (else a toggle "fades" over many frames)
  }

  private wgsl(): string {
    const members = this.placed.map((p) => p.field.structMembers(p.slot)).join("\n");
    const decls = this.placed.map((p) => p.field.declareBindings(p.slot, p.bbase)).join("\n");

    // Emission order matters (matches slicer_wgpu.scene_renderer):
    //   1. modifier fields' displacement_grid<M>()   — called by (2)
    //   2. per-receiver transform_point_<kind><slot>() — called by (3)
    //   3. receiver fields' sample_field_<kind><slot>()
    const modifiers = this.placed.filter((p) => p.field.modifier);
    const receivers = this.placed.filter((p) => !p.field.modifier);
    const modFns = modifiers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const slotOf = new Map(this.placed.map((p) => [p.field, p.slot]));
    const tpFns = receivers.map((p) => {
      const tf = p.field.transform;
      const tfSlot = tf && tf.modifier ? slotOf.get(tf) : undefined;
      const body = tfSlot === undefined ? "  return wp;" : `  return wp + displacement_grid${tfSlot}(wp);`;
      return `fn transform_point_${p.field.kind}${p.slot}(wp : vec3<f32>) -> vec3<f32> {\n${body}\n}`;
    }).join("\n");
    const fieldFns = receivers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");

    // EMPTY-SPACE SKIPPING. A field opts in via providesSkip/skipWGSL and hands back a
    // conservative distance it is guaranteed to be empty for. We CACHE that horizon per
    // field and coast: the bound (O(N) for spheres) is evaluated only when the ray reaches
    // the horizon, not at every step — that caching is the whole point, since computing the
    // bound costs the same as sampling. A field with an attached transform is excluded: a
    // nonlinear warp invalidates a distance measured in un-warped space.
    //
    // Fields that don't supply their own bound still get a DEFAULT one: the distance to
    // the field's own world AABB (0 inside it). A field's contribution is by definition
    // inside its AABB, so this is conservative, and it costs nothing to build. It is what
    // lets a ray skip the parts of the scene box that lie outside a given volume — e.g.
    // the gap in Multi-Volume, where Panoramix sits +200mm R of CTACardio and each ray
    // spends much of its span outside one volume or both.
    //
    // The AABB is baked into the shader at build() time, so a field whose geometry
    // changes must go through build() again (every demo already does — that is also what
    // re-runs fillUniforms).
    const wf = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(6);
    const boxSkipWGSL = (p: Placed) => {
      const [lo, hi] = p.field.aabb();
      return `
fn skip_${p.field.kind}${p.slot}(wp : vec3<f32>) -> f32 {
  let q = max(vec3<f32>(${wf(lo[0])}, ${wf(lo[1])}, ${wf(lo[2])}) - wp,
              wp - vec3<f32>(${wf(hi[0])}, ${wf(hi[1])}, ${wf(hi[2])}));
  return length(max(q, vec3<f32>(0.0)));   // 0 inside the box, exact distance outside
}`;
    };
    // GHOST fields (interaction handles) composite specially and PERSIST past early
    // termination: when a ray enters one it dims the already-accumulated colour so the
    // handle shines through occluders. To keep that cheap, the handle keeps its own skip
    // horizon, so after the ray saturates we LEAP between handles on the ghost skip alone
    // (the volume is done) instead of fine-marching to t_far.
    const ghostFields = receivers.filter((p) => p.field.ghost);
    const normalReceivers = receivers.filter((p) => !p.field.ghost);
    const clipGuard = (p: Placed, expr: string) => (p.field.clippable === false ? expr : `if (!clipped) { ${expr} }`);
    // Sample + accumulate. Normal fields SUM into `sum` (composited once per step). GHOST
    // fields (handles) are SURFACES, not media: integrating them as a volume compounds their
    // per-sample opacity toward 1 over the many samples through a handle. Instead we track the
    // single MAX-opacity sample (the solid core: 0.5 inactive / 1.0 active) and its colour —
    // no accumulation, no compounding — and blend it once at the end.
    // INTERVAL fields (Field.intervalSampling) also get the ray distance since THEIR previous sample,
    // tracked in last_<nm>. It advances even when the sample is clipped: a clipped interval is
    // consumed, not carried into the next sample.
    const args = (p: Placed) => (p.field.intervalSampling ? `wp, rd, s_here - last_${p.field.kind}${p.slot}` : "wp, rd");
    const advance = (p: Placed) => (p.field.intervalSampling ? ` last_${p.field.kind}${p.slot} = s_here;` : "");
    const sampleInto = (p: Placed, ghost: boolean) => {
      const call = `sample_field_${p.field.kind}${p.slot}(${args(p)})`;
      return ghost
        ? `let c = ${call}; if (c.a > g_op) { g_op = c.a; g_col = c.rgb / max(c.a, 1e-4); }`
        : `let c = ${call}; sum += c;`;
    };
    // A skip-branch: evaluate the (cached) skip horizon; sample only when reached.
    const skipBranch = (p: Placed, clip: boolean, ghost = false): string => {
      const nm = `${p.field.kind}${p.slot}`;
      const smp = sampleInto(p, ghost);
      // Subtract one step: wp is the JITTERED sample position (up to +/-0.5 step off t).
      return `    if (t >= resume_${nm}) {
      let d_${nm} = max(skip_${nm}(wp) - step, 0.0);
      if (d_${nm} > 0.0) { resume_${nm} = t + d_${nm}; }
      else { ${clip ? clipGuard(p, smp) : smp}${advance(p)} }
    }
    if (t < resume_${nm}) { jump_t = min(jump_t, resume_${nm}); } else { all_defer = false; }`;
    };
    const plainBranch = (p: Placed, clip: boolean, ghost = false): string => {
      const smp = sampleInto(p, ghost);
      return `    { ${clip ? clipGuard(p, smp) : smp}${advance(p)} all_defer = false; }`;
    };

    const normalSkippers = normalReceivers.filter((p) => !p.field.transform)
      .filter((p) => SceneRenderer.boxSkip || (p.field.providesSkip && p.field.skipWGSL));
    const ghostSkippers = ghostFields.filter((p) => p.field.providesSkip && p.field.skipWGSL);
    const canSkip = new Set(normalSkippers.map((p) => p.field));
    const ghostCanSkip = new Set(ghostSkippers.map((p) => p.field));
    const skipFns = [
      ...normalSkippers.map((p) => (p.field.providesSkip && p.field.skipWGSL ? p.field.skipWGSL(p.slot) : boxSkipWGSL(p))),
      ...ghostSkippers.map((p) => p.field.skipWGSL!(p.slot)),
    ].join("\n");
    const fns = [modFns, tpFns, fieldFns, skipFns].filter((s) => s.trim()).join("\n");
    const skipInit = [...normalSkippers, ...ghostSkippers]
      .map((p) => `  var resume_${p.field.kind}${p.slot} : f32 = -1.0e30;`).join("\n");
    // Each interval field's first interval starts at the slab entry (t_near was pushed one step in).
    const intervalInit = receivers.filter((p) => p.field.intervalSampling)
      .map((p) => `  var last_${p.field.kind}${p.slot} : f32 = max(t_near - step, 0.0);`).join("\n");

    // CLIPPING (port of slicer_wgpu's clip_planes/clip_count): a ROI box → up to 8 inward
    // planes; a sample on the negative side of ANY active plane is discarded. Applied PER
    // FIELD so `clippable` fields (volumes, segments) are cropped while widgets are not.
    const dispatch = normalReceivers.map((p) =>
      canSkip.has(p.field) ? skipBranch(p, true) : plainBranch(p, true)
    ).join("\n");
    const ghostDispatch = ghostFields.map((p) =>
      ghostCanSkip.has(p.field) ? skipBranch(p, false, true) : plainBranch(p, false, true)
    ).join("\n");
    const hasGhost = ghostFields.length > 0;
    // PICK dispatch: sample every NORMAL (non-ghost) receiver at wp and sum, clip-guarded — no
    // skip machinery (a single ray doesn't need it), no ghost handles (widgets aren't pickable).
    const pickDispatch = normalReceivers.map((p) =>
      `    ${clipGuard(p, `{ let c = sample_field_${p.field.kind}${p.slot}(wp, rd${p.field.intervalSampling ? ", step" : ""}); sum += c; }`)}`
    ).join("\n");
    // THE SOLID PASS (colorize-field.ts, the solid look): the colored volumes' structures as SURFACES,
    // written where the meshes write -- color, distance, facing normal and the depth buffer -- so
    // everything the meshes get afterwards (the drawing look's outlines and crevice shadow, depth
    // against the real meshes, the trace compositing them at their distance) the structures get too.
    // Ron, 2026-09-23: "The black lines in the surface model also help." Every receiver is named in
    // a branch that never runs, so this entry point's bindings are the same set the pick's are.
    const clz = receivers.filter((p) => p.field.kind === "clz");
    const solidFs = !clz.length ? "" : /* wgsl */ `
struct SolidOut { @location(0) col : vec4<f32>, @location(1) depth : vec4<f32>, @location(2) nrm : vec4<f32>, @builtin(frag_depth) fd : f32 };
@fragment
fn fs_solid(v : Varyings) -> SolidOut {
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);
  // WHAT THE SURFACE MODELS AND SLICE PLANES ALREADY DREW HERE (copies of their targets; this pass runs
  // after them). The ray stops where they are, and what it meets before is laid over them. Drawn the
  // other way round, an opaque model behind a see-through structure painted over its veil and the
  // structure was gone (critic, 2026-09-23, finding 1).
  let mpix = vec2<i32>(v.position.xy);
  let mesh_c = textureLoad(t_mesh_col, mpix, 0);
  let mesh_t = textureLoad(t_mesh_depth, mpix, 0).r;       // distance from the eye; 1e30 = none
  let mesh_n = textureLoad(t_mesh_nrm, mpix, 0);
  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (mesh_t < 1e29) { t_far = min(t_far, mesh_t - distance(u_cam.eye.xyz, ro)); }
  if (t_far <= t_near || t_far <= 0.0) { discard; }
  // ONE VOXEL PER STEP, not the trace's 0.7: every wall is placed by bisection between two steps, so
  // the step only has to be short enough not to jump over a structure, and a voxel-wide structure
  // is still caught (its smoothed copy or its labels hold the step that lands in it).
  let step = max(u_material.scene.x, 1e-3) / 0.7;
  t_near = max(t_near + step, 0.0);
  t_far = t_far - step;
  var t = t_near;
  var acc = vec4<f32>(0.0);
  var opaque = false;
  var hp = vec3<f32>(0.0);
  var hn = vec3<f32>(0.0);
  var safety : i32 = 0;
  var wasClipped = false;
  // The structure the ray is in, per colored volume: walls are where it changes. STARTED IN THE STATE
  // OF THE POINT THE RAY STARTS AT, so a camera inside a structure is not met by a wall behind the eye
  // filling the view with one flat color (critic, finding 13).
${clz.map((p) => `  var lab${p.slot} : i32 = 0;
  if (u_material.clz${p.slot}_params.w > 0.5) { lab${p.slot} = solid_class_clz${p.slot}(ro + rd * t_near, 0, rd); }`).join("\n")}
  loop {
    if (t >= t_far || safety >= 5000 || acc.a >= 0.99) { break; }
    let wp = ro + rd * t;
    var clipped = false;
    // THE CROP BOX DOES NOT CUT THE SOLID ANATOMY. Ron, 2026-09-24, asked whether the solid look should be
    // cut by the crop box as it now was (the surface models never were): "no". The crop is for the volume
    // rendering; the planes stay in the uniform for it, and none is tested here. (The capping code below,
    // "OUT OF THE CROP", is then never entered; kept for the day a cut is wanted as a choice.)
    let ccount = 0u;
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    // LEAP where no colored volume can have a wall: past the far side of the nearest block that is
    // empty (ray outside) or all one structure (ray inside it). The leap lands a hundredth of a step
    // past the block, so the next step's look-back is still inside it.
    var leap = 1e30;
${clz.map((p) => `    if (u_material.clz${p.slot}_params.w > 0.5) { leap = min(leap, solid_skip_clz${p.slot}(wp, rd, lab${p.slot})); }`).join("\n")}
    if (!clipped && !wasClipped && leap > step && leap < 1e29) {
      t = t + leap + 0.01 * step;
      safety = safety + 1;
      continue;
    }
    if (clipped) {
${clz.map((p) => `      lab${p.slot} = 0;`).join("\n")}
      wasClipped = true;
    } else if (wasClipped) {
      // OUT OF THE CROP: a structure cut here is closed ON THE PLANE, lit with the plane's normal, as
      // a capped surface. Placed by bisection on the smoothed copy it sat on the step grid instead,
      // and the drawing look outlined every step (critic, finding 4).
      var cutP = wp; var cutN = -rd; var best = -1e30;
      for (var ci = 0u; ci < ccount; ci = ci + 1u) {
        let cp = u_material.clip_planes[ci];
        let dCur = dot(wp, cp.xyz) + cp.w;
        let dPrev = dot(wp - rd * step, cp.xyz) + cp.w;
        let den = dot(rd, cp.xyz);
        if (dPrev < 0.0 && dCur >= 0.0 && abs(den) > 1e-6) {
          let sHit = -dCur / den;                                // <= 0: back along the ray
          if (sHit > best) { best = sHit; cutP = wp + rd * sHit; cutN = cp.xyz; }
        }
      }
${clz.map((p) => `      if (u_material.clz${p.slot}_params.w > 0.5) {
        let nl = solid_class_clz${p.slot}(wp, 0, rd);
        if (nl > 0) {
          let c = solid_shade_clz${p.slot}(nl, cutN, rd);
          if (c.a > 0.0) {
            if (!opaque && c.a >= 0.99) { opaque = true; hp = cutP; hn = cutN; }
            acc = acc + (1.0 - acc.a) * c;
          }
        }
        lab${p.slot} = nl;
      }`).join("\n")}
      wasClipped = false;
    } else {
${clz.map((p) => `      if (u_material.clz${p.slot}_params.w > 0.5) {
        let nl = solid_class_clz${p.slot}(wp, lab${p.slot}, rd);
        if (nl != lab${p.slot}) {
          let c = solid_wall_clz${p.slot}(wp - rd * step, wp, lab${p.slot}, nl, rd);
          if (c.a > 0.0) {
            if (!opaque && c.a >= 0.99) { opaque = true; hp = g_solid_p; hn = g_solid_n; }
            acc = acc + (1.0 - acc.a) * c;
          }
          lab${p.slot} = nl;
        }
      }`).join("\n")}
    }
    t = t + step;
    safety = safety + 1;
  }
  if (u_material.scene.w > 0.5) {          // never: names every binding (see above)
    let wp = ro; var sum = vec4<f32>(0.0); let clipped = false;
${pickDispatch}
    acc = acc + sum;
  }
  if (u_material.scene.z > 0.5) {         // the step-count picture (setSolidDebug): black 0, white 400 steps and more
    let h = clamp(f32(safety) / 400.0, 0.0, 1.0);
    var od : SolidOut;
    od.col = vec4<f32>(h, h * h, 1.0 - h, 1.0); od.depth = vec4<f32>(1e30, 0.0, 0.0, 1.0); od.nrm = vec4<f32>(0.0); od.fd = 0.0;
    return od;
  }
  if (acc.a <= 0.0) { discard; }             // nothing solid here: what the models drew stays as it is
  var o : SolidOut;
  o.col = acc + (1.0 - acc.a) * mesh_c;     // the structures met before the model, over the model
  if (opaque) {
    o.depth = vec4<f32>(distance(u_cam.eye.xyz, hp), 0.0, 0.0, 1.0);
    o.nrm = vec4<f32>(select(hn, -hn, dot(hn, -rd) < 0.0), 1.0);
    let clip = u_cam.view_proj * vec4<f32>(hp, 1.0);
    o.fd = clamp(clip.z / clip.w, 0.0, 1.0);
  } else if (mesh_t < 1e29) {
    // Only see-through structures in front of a model: the model stays the surface the outlines and
    // the depth test see.
    o.depth = vec4<f32>(mesh_t, 0.0, 0.0, 1.0);
    o.nrm = mesh_n;
    let clip = u_cam.view_proj * vec4<f32>(u_cam.eye.xyz + rd * mesh_t, 1.0);
    o.fd = clamp(clip.z / clip.w, 0.0, 1.0);
  } else {
    o.depth = vec4<f32>(1e30, 0.0, 0.0, 1.0);
    o.nrm = vec4<f32>(0.0);
    o.fd = 1.0;
  }
  return o;
}`;
    return /* wgsl */ `
struct Camera { inv_view_proj : mat4x4<f32>, size : vec4<f32>, eye : vec4<f32>, look : vec4<f32>, view_proj : mat4x4<f32> };   // look = (camera up, drawing look on)
struct Material {
  bmin : vec4<f32>,
  bmax : vec4<f32>,
  scene : vec4<f32>,   // sample_step, _, _, _
  bg : vec4<f32>,
${members}
  clip_planes : array<vec4<f32>, 8>,   // (nx, ny, nz, offset) inward; tail so field offsets are stable
  clip_count : vec4<f32>,              // (count, _, _, _)
  pick_cursor : vec4<f32>,             // (ndc_x, ndc_y, _, _) — the ray for fs_pick
  probe_origin : vec4<f32>,            // explicit-ray probe: world origin
  probe_dir : vec4<f32>,               // (dx, dy, dz, enabled) — w>0 uses this ray instead of the cursor
};
@group(0) @binding(0) var<uniform> u_cam : Camera;
@group(0) @binding(1) var<uniform> u_material : Material;
// Rasterised surface meshes (models): nearest-surface colour (premultiplied) + its distance along the
// ray, produced by the mesh pass before each trace. The march composites the surface at that depth,
// so volumes in front occlude it and it occludes what is behind — the depth-composite seam.
@group(1) @binding(0) var t_mesh_col : texture_2d<f32>;
@group(1) @binding(1) var t_mesh_depth : texture_2d<f32>;
// Read by the solid pass only (its copy of the models' facing normals); absent from the trace's layout.
@group(1) @binding(2) var t_mesh_nrm : texture_2d<f32>;
${this.usesSampler() ? "@group(0) @binding(2) var s_lin : sampler;" : ""}
${decls}

struct Varyings { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> Varyings {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : Varyings; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
fn ndc_to_world(ndc : vec4<f32>) -> vec3<f32> { let w = u_cam.inv_view_proj * ndc; return w.xyz / w.w; }
fn ign(p : vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
// THE SOLID PASS's hand-off: a colored volume in the solid look is drawn by fs_solid into the
// surfaces' own targets (so the drawing look outlines and shades it like a mesh), and the trace
// must then not draw it a second time. The pick still sees it (it does not set the flag).
var<private> g_solid_prepass : bool = false;
var<private> g_solid_p : vec3<f32>;
var<private> g_solid_n : vec3<f32>;
${fns}
${solidFs}

// PRODUCER (fs_trace): march the ray and return the composited PREMULTIPLIED sample
// (integrated.rgb, integrated.a) BEFORE the background composite — a "traced pixel". The
// Reconstructor (fs_resolve / reconstructor.ts) composites it over the background. Splitting
// trace from assemble is the seam the unified local/remote pipeline turns on (see
// docs/UNIFIED-RENDERING-PLAN.md); the background composite is identical to the fused path, so
// output is byte-identical at full density. An empty slab returns transparent (0) → resolve = bg.
@fragment
fn fs_trace(v : Varyings) -> @location(0) vec4<f32> {
  g_solid_prepass = true;
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);

  let mpix = vec2<i32>(v.position.xy);
  let mesh_c = textureLoad(t_mesh_col, mpix, 0);          // premultiplied surface colour (0 = no mesh)
  let mesh_t = textureLoad(t_mesh_depth, mpix, 0).r;      // distance along the ray (1e30 = none)
  var mesh_done = mesh_c.a <= 0.0;

  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return mesh_c; }

  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  if (t_far <= t_near) { return mesh_c; }
  let seed = ign(v.position.xy);
  var t = t_near;
  var integrated = vec4<f32>(0.0);
  var safety : i32 = 0;
  var saturated = false;   // LATCH: once opaque, normal fields stay off even after a ghost
                           // handle dims the accumulation (else the volume behind the handle
                           // would re-opaque over it and re-bury the shine-through).
  var g_op = 0.0;          // ghost (handle) surface: max opacity along the ray (0.5 inactive /
  var g_col = vec3<f32>(0.0);  // 1.0 active) and its colour — tracked, never accumulated.
${skipInit}
${intervalInit}
  loop {
    if (t >= t_far || safety >= 5000${hasGhost ? "" : " || integrated.a >= 0.99"}) { break; }
    // Per-(pixel, step, ACCUM FRAME) ray-offset jitter. The frame term (u_cam.size.w, the
    // accumulation index) is what makes temporal AA actually converge: with a frame-invariant
    // offset the jitter turns banding into FIXED-PATTERN noise that averaging can never remove
    // (measured: 32 samples was as grainy as 1). Varying it per frame decorrelates the samples
    // so the mean approaches the true integral — no banding AND no noise. size.w is 0 for every
    // non-accumulating path, so frame 1 stays byte-identical to a plain renderToView.
    // Base offset: decorrelated per (pixel, step) so a single frame shows noise, not banding.
    let jbase = fract(sin(dot(v.position.xy + vec2<f32>(f32(safety) * 0.7548, f32(safety) * 0.5698), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    // Advance it across accumulation frames by the golden-ratio additive recurrence
    // (Cranley-Patterson rotation). MEASURED: this converges at the same 1/sqrt(n) rate as an
    // independent random offset per frame (high-freq energy 1.36 vs 1.31 at n=64) — the low-
    // discrepancy walk is NOT faster here, because the variance is dominated by the step size
    // against a sharp transfer function, not by the sequence. Kept because it is deterministic
    // and costs nothing; reduce sampleStep if you need less residual speckle.
    // At size.w = 0 this is exactly jbase, so the first accumulated frame stays byte-identical
    // to a plain renderToView — the property render/test baselines depend on.
    let js = fract(jbase + u_cam.size.w * 0.6180339887) - 0.5;
    if (!mesh_done && t + 0.5 * step >= mesh_t) {         // the ray reaches the surface: composite it here
      integrated = integrated + (1.0 - integrated.a) * mesh_c;
      mesh_done = true;
    }
    let s_here = t + js * step;   // ray distance of this (jittered) sample
    let wp = ro + rd * s_here;
    var sum = vec4<f32>(0.0);
    var all_defer = true;        // every field guarantees emptiness here -> we may leap
    var jump_t = 1.0e30;         // nearest field horizon
    var clipped = false;         // ROI clip: sample on the negative side of any active plane
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    // Normal fields stop being sampled once the ray is opaque (latched); GHOST fields keep
    // their skip horizons and keep going, so a handle behind an opaque region still shines
    // through and the ray LEAPS between handles on the ghost skip (early-termination kept).
${hasGhost ? "    if (integrated.a >= 0.99) { saturated = true; }\n    if (!saturated) {" : ""}
${dispatch}
      if (sum.a > 0.0) { integrated = integrated + (1.0 - integrated.a) * vec4<f32>(sum.rgb, clamp(sum.a, 0.0, 1.0)); }
${hasGhost ? "    }" : ""}
${ghostDispatch}
    if (all_defer && jump_t > t + step) { t = jump_t; } else { t = t + step; }
    safety = safety + 1;
  }
  if (!mesh_done) { integrated = integrated + (1.0 - integrated.a) * mesh_c; }   // surface beyond the slab
  // GHOST x-ray, applied ONCE (never compounding): the volume IN FRONT of a handle is shown
  // at residual = 1 - handle_opacity (50% for an inactive handle at opacity 0.5, 0% for an
  // active/hovered handle at opacity 1.0), then the handle (colour g_col at opacity g_op)
  // draws over it.
  if (g_op > 0.001) {
    let ga = clamp(g_op, 0.0, 1.0);
    let residual = 1.0 - ga;
    let fA = integrated.a * residual;
    integrated = vec4<f32>(integrated.rgb * residual + (1.0 - fA) * g_col * ga, fA + (1.0 - fA) * ga);
  }
  return integrated;   // premultiplied (rgb, a); resolve composites over the background
}

// PICK: trace the cursor ray (pick_cursor NDC) through the SAME field compositing and return the
// world (RAS) position where front-to-back opacity first crosses 50% — Slicer's 3D volume pick.
// Output: (wp.x, wp.y, wp.z, hit). hit=0 means the ray never reached 50% (empty/miss).
@fragment
fn fs_pick() -> @location(0) vec4<f32> {
  // Two ray sources: the screen cursor (pick) or an explicit world ray (probe). The explicit
  // form exists because the cursor ray can only ever probe what is ON SCREEN — useless for
  // "how much room is BEHIND me?", which endovascular navigation needs for reverse and for
  // lateral clearance.
  var ro = ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 0.0, 1.0));
  var rd = normalize(ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 1.0, 1.0)) - ro);
  if (u_material.probe_dir.w > 0.5) {
    ro = u_material.probe_origin.xyz;
    rd = normalize(u_material.probe_dir.xyz);
  }
  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(0.0); }
  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  var t = t_near;
  var acc = 0.0;
  var safety : i32 = 0;
  loop {
    if (t >= t_far || safety >= 5000 || acc >= 0.5) { break; }
    let wp = ro + rd * t;
    var clipped = false;
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    var sum = vec4<f32>(0.0);
${pickDispatch}
    if (sum.a > 0.0) {
      let a_new = acc + (1.0 - acc) * clamp(sum.a, 0.0, 1.0);
      if (a_new >= 0.5) { return vec4<f32>(wp, 1.0); }   // 50% crossing -> the pick point
      acc = a_new;
    }
    t = t + step;
  }
  return vec4<f32>(0.0);
}`;
  }

  /** Flat background — both gradient stops set to the same color. */
  setBackground(r: number, g: number, b: number) { this.setBackgroundGradient([r, g, b], [r, g, b]); }

  /** Vertical background gradient, sRGB components in 0..1. */
  setBackgroundGradient(top: RGB, bottom: RGB) {
    this.bgTop = top; this.bgBottom = bottom;
    this.mat[12] = bottom[0]; this.mat[13] = bottom[1]; this.mat[14] = bottom[2]; this.mat[15] = 1;
  }
  setSampleStep(step: number) { this.mat[8] = step; }
  /** 1: the solid pass draws how many steps each ray took instead of the picture (for tuning its speed). */
  setSolidDebug(on: number) { this.mat[10] = on; }
  /** The march's current step (mm). Read by tests that assert a change did NOT move it. */
  sampleStep(): number { return this.mat[8]; }
  /** Van der Corput / Halton radical inverse in `base`. */
  private static halton(i: number, base: number): number {
    let f = 1, r = 0;
    while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
    return r;
  }

  /** Set up to 8 clip planes (nx,ny,nz,offset), inward-normal, keep-side `dot(wp,n)+offset>=0`.
   *  Written into the uniform tail — a Tier-A update the next flush() uploads; no rebuild. */
  setClipPlanes(planes: [number, number, number, number][]) {
    const n = Math.min(planes.length, 8);
    for (let i = 0; i < n; i++) this.mat.set(planes[i], this.clipOff + i * 4);
    this.mat[this.clipOff + 32] = n;
  }
  clearClip() { this.mat[this.clipOff + 32] = 0; }

  /** Axis-aligned RAS crop box [lo,hi] → 6 inward planes. offset = -dot(faceOrigin, n). */
  setClipBox(lo: Vec3, hi: Vec3) {
    this.setClipPlanes([
      [1, 0, 0, -lo[0]], [-1, 0, 0, hi[0]],   // keep lo.x <= x <= hi.x
      [0, 1, 0, -lo[1]], [0, -1, 0, hi[1]],
      [0, 0, 1, -lo[2]], [0, 0, -1, hi[2]],
    ]);
  }

  /** Scene AABB = union of field AABBs; also picks a default sample step from the smallest field extent. */
  recomputeBounds() {
    if (!this.placed.length) return;
    let mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.placed) {
      const [a, b] = p.field.aabb();
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], a[i]); mx[i] = Math.max(mx[i], b[i]); }
    }
    this.mat[0] = mn[0]; this.mat[1] = mn[1]; this.mat[2] = mn[2];
    this.mat[4] = mx[0]; this.mat[5] = mx[1]; this.mat[6] = mx[2];
  }

  /** Tier-A interactive update: re-pack every field's uniform block into the resident
   *  material buffer WITHOUT recompiling the pipeline or rebuilding the bind group. This is
   *  the render-side of the interaction architecture (ARCHITECTURE-2026-07-24 §7): a
   *  lightweight drag — clip planes, ROI box geometry, fiducial position, TPS displacement
   *  grid — mutates node state, the field re-derives its uniforms, and the SAME per-frame
   *  flush() the renderer already does uploads them. Cost is a CPU re-pack; no shader build.
   *
   *  Also refreshes the scene AABB (which is uniform-resident), so a moved field's ray-clip
   *  bounds stay correct. REQUIRES the field SET and each field's uniformFloats() to be
   *  unchanged since build() — geometry/appearance may change, STRUCTURE may not. A structural
   *  change (add/remove a field, a field that resizes its uniform block, or a texture swap
   *  needing refreshBindings) still goes through build()/refreshBindings(). This is exactly
   *  why moving geometry must be uniform-resident, never baked into generated WGSL — see the
   *  box-skip note above and RENDER-PERFORMANCE.md. */
  syncUniforms() {
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.recomputeBounds();
  }

  /** Rebuild the bind group from the fields' current resources (e.g. after a field
   *  swapped a texture) without recompiling the pipeline. Field set/structure must be unchanged. */
  refreshBindings() {
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.solidBind = this.solidPipeline ? this.dev.createBindGroup({ layout: this.solidPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() }) : undefined;
  }

  /** Only fields with texture bindings use the shared sampler. `layout: "auto"` derives the
   *  layout from what the shader ACTUALLY references, so in a scene of purely procedural
   *  fields (e.g. fiducials/markups only) binding 2 is absent from the layout — supplying it
   *  anyway fails validation and the whole view silently renders nothing. Emit the sampler
   *  declaration and its bind entry under the SAME condition so the two can't drift. */
  private usesSampler(): boolean { return this.placed.some((p) => p.field.usesSampler ?? p.field.bindingCount > 0); }

  private bindGroupEntries(): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.camBuf } },
      { binding: 1, resource: { buffer: this.matBuf } },
    ];
    if (this.usesSampler()) entries.push({ binding: 2, resource: this.sampler });
    for (const p of this.placed) entries.push(...p.field.bindEntries(p.slot, p.bbase));
    return entries;
  }

  /**
   * `parallelScale` set means ORTHOGRAPHIC, with that as the half-height of the view volume -- VTK's
   * own parameter, so a mirrored Slicer camera maps straight onto it.
   *
   * This used to build a perspective matrix unconditionally, and the projection toggle in the 3D bar
   * therefore did nothing visible. Worse, it broke zooming: under parallel projection VtkCamera.dolly
   * scales `parallelScale` and returns without moving the eye, so with the value unread the camera
   * had nothing left to change. Ron: "no visible effect, but when it is activated, zoom and pan
   * stopp working in the 3D window." One cause, all three symptoms.
   */
  setCamera(eye: Vec3, center: Vec3, up: Vec3, fovyDeg: number, width: number, height: number, parallelScale?: number) {
    const view = lookAt(eye, center, up);
    const proj = parallelScale && parallelScale > 0
      ? orthoZO(parallelScale, width / height, 1, 100000)
      : perspectiveZO((fovyDeg * Math.PI) / 180, width / height, 1, 100000);
    const invVP: Mat4 = invert(multiply(proj, view));
    this.baseInvVP = invVP;   // stored un-jittered, for the temporal-AA camera jitter in renderAccum
    this.viewProj = multiply(proj, view); this.eyePos = eye;
    { const l = Math.hypot(up[0], up[1], up[2]) || 1; this.camUp = [up[0] / l, up[1] / l, up[2] / l]; }
    const cam = new Float32Array(24);
    cam.set(invVP, 0);
    this.focalPx = (height / 2) / Math.tan((fovyDeg * Math.PI) / 360);   // for the renderUpscaled screen-space fix
    // size = (w, h, focal_px, _); focal_px = pixels per world unit at unit depth, so a sphere
    // at distance d has projected radius r*focal_px/d — used for screen-constant handle sizing.
    cam[16] = width; cam[17] = height; cam[18] = (height / 2) / Math.tan((fovyDeg * Math.PI) / 360);
    cam[19] = 0;   // accumulation index (renderAccum overwrites); 0 = un-jittered base frame
    cam[20] = eye[0]; cam[21] = eye[1]; cam[22] = eye[2];
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
    this.writeLook();
  }

  /**
   * The world (RAS) ray a cursor at (u,v) casts, u,v in [0,1] with v down.
   *
   * FROM THE SAME MATRIX THE SHADERS UNPROJECT WITH -- `baseInvVP`, set by setCamera -- so a caller
   * that marches this ray cannot disagree with what the renderer draws along it. Recomputing a
   * lookAt and a projection at the call site would be the second source of truth for where the
   * cursor points, and there is already a fs_pick that does it the other way.
   */
  worldRay(u: number, v: number): { origin: Vec3; dir: Vec3 } | null {
    const m = this.baseInvVP;
    if (!m) return null;
    const ndcX = u * 2 - 1, ndcY = 1 - v * 2;
    const un = (z: number): Vec3 => {
      const x = m[0] * ndcX + m[4] * ndcY + m[8] * z + m[12];
      const y = m[1] * ndcX + m[5] * ndcY + m[9] * z + m[13];
      const w2 = m[2] * ndcX + m[6] * ndcY + m[10] * z + m[14];
      const w = m[3] * ndcX + m[7] * ndcY + m[11] * z + m[15];
      return [x / w, y / w, w2 / w];
    };
    const o = un(0), f = un(1);
    const d: Vec3 = [f[0] - o[0], f[1] - o[1], f[2] - o[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    return { origin: o, dir: [d[0] / L, d[1] / L, d[2] / L] };
  }

  /** Camera for ONE TILE of the view: the same rays the full frame would cast for `rect`, into a
   *  rect.w×rect.h target. Screen-space glyph sizing stays keyed to the FULL view height, so a
   *  patch of the gizmo is drawn at exactly the size the full frame drew it. Pair with
   *  traceSamples(rect.w, rect.h) — its focal rewrite is then a no-op. */
  setCameraTile(eye: Vec3, center: Vec3, up: Vec3, fovyDeg: number, viewW: number, viewH: number, rect: { x: number; y: number; w: number; h: number }) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZOTile((fovyDeg * Math.PI) / 180, viewW, viewH, rect.x, rect.y, rect.w, rect.h, 1, 100000);
    const invVP: Mat4 = invert(multiply(proj, view));
    this.baseInvVP = invVP;
    this.viewProj = multiply(proj, view); this.eyePos = eye;
    const cam = new Float32Array(24);
    cam.set(invVP, 0);
    this.focalPx = (viewH / 2) / Math.tan((fovyDeg * Math.PI) / 360);
    cam[16] = rect.w; cam[17] = rect.h;   // ray generation divides by the TARGET size
    cam[18] = this.focalPx;               // screen-constant glyphs: the FULL view's focal
    cam[19] = 0;
    cam[20] = eye[0]; cam[21] = eye[1]; cam[22] = eye[2];
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
    this.writeLook();
  }

  private flush() { this.dev.queue.writeBuffer(this.matBuf, 0, this.mat); }

  /** Ray-trace the cursor (u,v in [0,1], y down) through the composited fields and return the
   *  RAS point where front-to-back opacity first reaches 50% — Slicer's 3D volume pick. Traces
   *  whatever renders (DVR volumes, SegmentField iso shells, RGBA), EXCLUDING ghost handles.
   *  Uses the camera set by the last setCamera(); returns null if the ray never reaches 50%. */
  /**
   * The world point on the nearest MESH surface under (u, v), or null if no mesh is drawn there.
   *
   * WHY THIS EXISTS. The 3D probe used to march the labelmap and stop at the first visible label
   * along the cursor ray. That answers "what does this ray pass through first", which is not the same
   * question as "what am I looking at": where structures interdigitate -- periventricular white
   * matter hypointensities wrapping a ventricle, say -- the ray can meet one while the surface drawn
   * at that pixel belongs to the other. Ron, reading three adjacent bands in a FastSurfer brain:
   * "the next with the frazzled border is called ventricle", while the same point probed in a slice
   * view named it correctly. The labelmap was right; the question was wrong.
   *
   * The mesh pass already writes distance(eye, surface) per pixel for its own compositing, so the
   * answer is a one-texel readback and a point along the ray at that distance. No extra pass.
   */
  async pickMeshSurface(u: number, v: number): Promise<Vec3 | null> {
    if (!this.lastMeshTargets || !this.gpuMeshes.some((m) => m.visible)) return null;
    return await this.serialise(async () => {
      // The frame drawn, in the targets' corner, read WHEN THE COPY IS QUEUED: moving and settled frames share one set
      // of targets, so a size read before the wait could belong to a frame drawn over since (critic, 2026-09-24
      // evening, finding 12).
      const t = this.lastMeshTargets;
      if (!t) return null;
      const x = Math.max(0, Math.min(t.uw - 1, Math.floor(u * t.uw)));
      const y = Math.max(0, Math.min(t.uh - 1, Math.floor(v * t.uh)));
      // 256-byte row alignment is required by copyTextureToBuffer even for a single texel.
      const buf = this.dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = this.dev.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: t.depth, origin: { x, y, z: 0 } },
        { buffer: buf, bytesPerRow: 256 },
        { width: 1, height: 1, depthOrArrayLayers: 1 },
      );
      this.dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const dist = new Float32Array(buf.getMappedRange().slice(0))[0];
      buf.unmap();
      buf.destroy();
      // THE CLEAR VALUE IS 1e30, NOT 0 -- the composite shader reads "no mesh" as a far distance
      // (line ~951), and the pass above clears to it. This test looked for 0, so a pixel with no
      // opaque mesh under it -- every pixel over a see-through structure, which writes no depth --
      // passed as a hit 1e30 mm away, the probe landed outside every dataset and reported nothing.
      // Ron: "below the diaphragm it displays nothing" -- his whole ts:total was see-through there,
      // and the opaque lung vessels above it were why the lungs still worked.
      if (!(dist > 0) || !Number.isFinite(dist) || dist >= 1e29) return null;
      const ray = this.worldRay(u, v);
      if (!ray) return null;
      return [
        ray.origin[0] + ray.dir[0] * dist,
        ray.origin[1] + ray.dir[1] * dist,
        ray.origin[2] + ray.dir[2] * dist,
      ] as Vec3;
    });
  }

  async pick(u: number, v: number): Promise<Vec3 | null> {
    if (!this.pickPipeline || !this.pickBind || !this.placed.length) return null;
    return this.serialise(async () => {
      this.mat[this.pickOff] = u * 2 - 1;
      this.mat[this.pickOff + 1] = 1 - v * 2;
      this.mat[this.pickOff + 11] = 0;          // probe_dir.w = 0 -> use the cursor ray
      this.flush();
      return await this.tracePick();
    });
  }

  /** Trace an EXPLICIT world ray and return the distance (mm) to the first point where
   *  front-to-back opacity reaches 50%, or Infinity if it never does. Unlike pick(), the ray
   *  is independent of the camera, so it can look backwards and sideways — which is what makes
   *  collision "rails" possible in a first-person flythrough. */
  async probe(origin: Vec3, dir: Vec3): Promise<number> {
    if (!this.pickPipeline || !this.pickBind || !this.placed.length) return Infinity;
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return this.serialise(async () => {
      this.mat[this.pickOff + 4] = origin[0];
      this.mat[this.pickOff + 5] = origin[1];
      this.mat[this.pickOff + 6] = origin[2];
      this.mat[this.pickOff + 8] = dir[0] / l;
      this.mat[this.pickOff + 9] = dir[1] / l;
      this.mat[this.pickOff + 10] = dir[2] / l;
      this.mat[this.pickOff + 11] = 1;          // enable the explicit ray
      this.flush();
      const hit = await this.tracePick();
      this.mat[this.pickOff + 11] = 0;          // leave the uniform in the cursor state
      this.flush();
      if (!hit) return Infinity;
      return Math.hypot(hit[0] - origin[0], hit[1] - origin[1], hit[2] - origin[2]);
    });
  }

  /** Serialises pick/probe. They share ONE uniform buffer and ONE readback buffer, so
   *  concurrent calls would overwrite each other's ray and double-map the buffer — a
   *  Promise.all of probes silently returns garbage. Callers may fire as many as they like;
   *  they queue here. */
  private pickChain: Promise<unknown> = Promise.resolve();
  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pickChain.then(fn, fn);
    this.pickChain = next.catch(() => {});
    return next;
  }

  /** The shared 1x1 render + readback behind pick() and probe(). */
  private async tracePick(): Promise<Vec3 | null> {
    if (!this.pickTarget) {
      this.pickTarget = this.dev.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.pickReadBuf = this.dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); // bytesPerRow min 256
    }
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.pickTarget.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(this.pickPipeline); pass.setBindGroup(0, this.pickBind); pass.draw(3); pass.end();
    enc.copyTextureToBuffer({ texture: this.pickTarget }, { buffer: this.pickReadBuf!, bytesPerRow: 256, rowsPerImage: 1 }, [1, 1]);
    this.dev.queue.submit([enc.finish()]);
    await this.pickReadBuf!.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(this.pickReadBuf!.getMappedRange().slice(0, 16));
    this.pickReadBuf!.unmap();
    return r[3] > 0.5 ? [r[0], r[1], r[2]] as Vec3 : null;
  }

  renderToView(view: GPUTextureView, width: number, height: number) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, bgUniform(this.bgTop, this.bgBottom, 1, height));   // gradient for the resolve composite
    const enc = this.encodeFrame(this.dev.createCommandEncoder(), view);
    this.dev.queue.submit([enc.finish()]);
  }

  /** Exact GPU time of the ray-march pass (median ms over `iters`), via timestamp-query.
   *  Times ONLY the render pass — no texture copy/readback — so it reflects shader cost.
   *  Returns NaN if the device lacks timestamp-query. Deno gives full-resolution timestamps;
   *  Chrome quantizes them unless cross-origin isolated, so profile headless for sharp numbers. */
  async timePass(width: number, height: number, iters = 40): Promise<number> {
    if (!this.canTime) return NaN;
    this.flush();
    // Time only the PRODUCER (ray-march) pass — the expensive part and the budget primitive; the
    // resolve pass is trivial. Target matches the trace pipeline's rgba32float output.
    const target = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = target.createView();
    const qs = this.dev.createQuerySet({ type: "timestamp", count: 2 });
    const resolve = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const enc = this.dev.createCommandEncoder();
      const mb = this.meshPass(enc, width, height);
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bind); pass.setBindGroup(1, mb); pass.draw(3); pass.end();
      enc.resolveQuerySet(qs, 0, 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
      this.dev.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(read.getMappedRange());
      const ms = Number(t[1] - t[0]) / 1e6;   // ns -> ms
      read.unmap();
      if (ms > 0 && Number.isFinite(ms)) samples.push(ms);   // drop bogus/negative timer reads
    }
    target.destroy(); qs.destroy(); resolve.destroy(); read.destroy();
    if (!samples.length) return NaN;
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];   // median
  }

  /**
   * A SAVED PICTURE, CONVERGED: `samples` accumulated frames (sub-pixel and ray-offset jitter averaged, as
   * the on-screen view does once it settles), read back as rgba8. renderToRGBA is one frame, and one
   * frame of a volume rendering carries the per-pixel jitter noise that the screen averages away -- so
   * the 3D view's gear panel's Save picture kept the grain the screen did not show (2026-09-23).
   */
  async renderToRGBAConverged(width: number, height: number, samples = 16): Promise<Uint8Array> {
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const view = target.createView();
    for (let i = 0; i < samples; i++) this.renderAccum(view, width, height, i === 0);
    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }

  async renderToRGBA(width: number, height: number): Promise<Uint8Array> {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, bgUniform(this.bgTop, this.bgBottom, 1, height));
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.encodeFrame(this.dev.createCommandEncoder(), target.createView());
    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }

  /** REMOTE PRODUCER (M3): trace at width×height and read back the PREMULTIPLIED sample (pre-
   *  background) as tightly-packed rgba8 — the bytes streamed to the remote client, which runs the
   *  same reconstruction (upsample + background composite) the local resolve does. The caller sets
   *  the camera to width×height first (like renderUpscaled). Returns width*height*4 bytes. */
  async traceSamples(width: number, height: number, viewH = height): Promise<Uint8Array> {
    this.flush();
    // The ray grid is generated from u_cam.size.xy — it MUST be the size of the target being
    // rendered, whatever setCamera/setCameraTile happened to write. When a tile is traced at
    // reduced density (target psw×psh for a larger view rect), leaving the rect size here makes
    // the shader cast rays for only the top-left corner of the frustum and the client upscales
    // that corner across the whole rect — giant zoomed fragments (the 2026-08-20 regression).
    this.dev.queue.writeBuffer(this.camBuf, 64, new Float32Array([width, height]));
    // Same focal rewrite renderUpscaled does: screen-space glyphs (gizmo, fiducial handles) size
    // from u_cam.size.z, and setCamera was given the SAMPLE size — so under a reduced trace they
    // would grow ~1/scale once the CLIENT upsamples the samples to the view. Rays are unchanged.
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([this.focalPx * (viewH / height)]));
    const target = this.dev.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    this.meshPass(enc, width, height);
    const smt = this.meshTargets(width, height);
    const streamMb = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: smt.col.createView() }, { binding: 1, resource: smt.depth.createView() }] });
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.streamPipeline); tp.setBindGroup(0, this.streamBind!); tp.setBindGroup(1, streamMb); tp.draw(3); tp.end();
    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap(); target.destroy(); buf.destroy();
    return out;
  }
}
