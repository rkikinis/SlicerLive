// A SLICE IN 3D IS THE 2D COMPOSITE ON A QUAD, not a field in the ray-march.
//
// Ron: "The user does the compositing work in the 2d viewer and whatever is there, goes to the 3D
// viewer... no matter how complex the data only a single slice gets displayed in the 3D viewer."
// Slicer does the same thing -- vtkMRMLSliceLogic makes a vtkPlaneSource model and textures it.
//
// What this pins down:
//   1. the quad shows the composite -- a segment colored in 2D is that color in 3D;
//   2. alpha 0 outside the volume is DISCARDED, so the quad's empty corners do not stand in front
//      of the volume. This is the failure that looks fine head-on and wrong from any other angle,
//      which is why it is asserted rather than eyeballed;
//   3. adding the slice does not change the scene's sample step. That was the whole point: the
//      march runs at min(sampleStep) over all fields, so a slice as a FIELD slowed the volume down
//      everywhere (one slice +15%, three +22%). A quad is not a field.
//
//   deno test -A --no-check --unstable-webgpu render/test/slice-quad-3d.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { SliceRenderer } from "../slice-renderer.ts";
import { SceneRenderer } from "../scene-renderer.ts";
import { ColorizeBaker, makeLabelPaletteTexture, writeLabelPaletteTexture } from "../bake.ts";
import { patientToTextureFromIjkToRAS, volumeAABBFromIjkToRAS } from "../mat4.ts";
import type { Vec3 } from "../mat4.ts";
import { ImageField } from "../fields.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "a slice in 3D is the 2D composite on a quad (textured, discarded outside, no step change)",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    const errs: string[] = [];
    dev.addEventListener("uncapturederror", (e) => errs.push(String((e as GPUUncapturedErrorEvent).error)));

    // The volume FILLS its box and one segment covers all of it. So the composite is the segment's
    // color everywhere inside the volume and transparent everywhere outside -- which makes any
    // BLACK pixel on screen a failed discard, with nothing else it could be. Air inside the box
    // would also be black (correctly, as in Slicer), and that ambiguity is what this avoids.
    const dims: Vec3 = [48, 48, 24];
    const ijk = [1, 0, 0, -24, 0, 1, 0, -24, 0, 0, 1, -12, 0, 0, 0, 1];
    const n = dims[0] * dims[1] * dims[2];
    const scalar = new Float32Array(n).fill(0.5);
    const lab = new Uint8Array(n).fill(1);
    const scalarTex = dev.createTexture({
      size: dims as [number, number, number], dimension: "3d", format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture({ texture: scalarTex }, scalar, { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] }, dims as [number, number, number]);

    // A vivid segment color: what the quad shows must be THIS, not the gray underneath.
    const baker = new ColorizeBaker(dev, lab, dims);
    const pal = new Float32Array(256 * 4);
    pal[4] = 0; pal[5] = 1; pal[6] = 0; pal[7] = 1;      // label 1 = GREEN, fully opaque
    const palTex = makeLabelPaletteTexture(dev);
    writeLabelPaletteTexture(dev, palTex, pal);

    const [lo, hi] = volumeAABBFromIjkToRAS(ijk, dims);
    // bgra8unorm-srgb ON PURPOSE: it is what the app gets from getPreferredCanvasFormat on a Mac,
    // and it is NOT the format a caller would reach for by hand. The first version of this test
    // built the renderer and the texture with the same literal, so a mismatch between them was
    // unrepresentable here and shipped anyway -- it took every view down with "color and depth
    // targets from pass do not match pipeline". The texture format below now comes from the
    // renderer, which now allocates the target itself so the choice no longer exists.
    const sr = new SliceRenderer(gpu, "bgra8unorm-srgb");
    sr.setVolume(patientToTextureFromIjkToRAS(ijk, dims), lo, hi);
    sr.setTextures(scalarTex);
    sr.setWindowLevel(1, 0.5);
    sr.setPlane("axial", 0.5);
    sr.setLabelOverlay(baker.labelTexture(), palTex, patientToTextureFromIjkToRAS(ijk, dims));
    sr.setOverlayOpacity(1); sr.setOutlineOpacity(0);

    // The composite for the quad, at the volume's own in-plane resolution.
    const TW = 64, TH = 64;
    const sliceTex = sr.makeSliceTarget(TW, TH);
    const frame = sr.renderPatientFrameInto(sliceTex.createView(), TW, TH);

    // A 3D scene holding ONLY the volume, so any green on screen can only be the quad.
    // ── the quad on its own, over a BLUE background ──
    // An empty scene, so nothing can hide the quad and nothing else can put color on screen. Blue
    // is the control: a discarded pixel shows blue, a wrongly-drawn one shows black.
    const W = 96, H = 96;
    const scene = new SceneRenderer(gpu, "rgba8unorm-srgb");
    scene.build([]);
    scene.setBackground(0, 0, 0.6);
    const quad = { id: "Red", tex: sliceTex, origin: frame.origin, uvec: frame.uvec, vvec: frame.vvec, opacity: 1 };
    const tally = (px: Uint8Array) => {
      let green = 0, blue = 0, black = 0;
      for (let i = 0; i < W * H; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
        if (g > 110 && r < 90 && b < 90) green++;
        else if (b > 80 && r < 90 && g < 90) blue++;
        else if (r + g + b < 40) black++;
      }
      return { green, blue, black };
    };
    const look = async (eye: Vec3, up: Vec3) => {
      scene.setCamera(eye, [0, 0, 0], up, 30, W, H);
      return tally(await scene.renderToRGBA(W, H));
    };

    scene.setSliceQuads([]);
    const empty = await look([0, 0, 260], [0, 1, 0]);
    scene.setSliceQuads([quad]);
    const axial = await look([0, 0, 260], [0, 1, 0]);

    // ── OBLIQUE: the frame's corners now fall OUTSIDE the volume ──
    // An axial frame is exactly the box's cross-section, so nothing is ever outside it and the
    // discard is untested. An oblique plane cuts the box as a hexagon, so the frame's corners carry
    // no data -- and that is the case IGT needs, reformatting along a probe.
    const k = 1 / Math.sqrt(2);
    sr.setBasis("axial", { uDir: [-1, 0, 0], vDir: [0, k, k], nDir: [0, -k, k] });
    const oblFrame = sr.renderPatientFrameInto(sliceTex.createView(), TW, TH);
    scene.setSliceQuads([{ ...quad, origin: oblFrame.origin, uvec: oblFrame.uvec, vvec: oblFrame.vvec }]);
    const oblique = await look([0, -180, 180], [0, k, k]);   // looking down the oblique normal

    // ── the step: a volume in the scene, with and without a slice ──
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { lut[i * 4] = 180; lut[i * 4 + 1] = 40; lut[i * 4 + 2] = 40; lut[i * 4 + 3] = i < 64 ? 0 : 255; }
    const field = new ImageField(dev, scalar, dims, [1, 1, 1], lut, { clim: [0, 1], ijkToRAS: ijk });
    const withVol = new SceneRenderer(gpu, "rgba8unorm-srgb");
    withVol.build([field]);
    const stepWithout = withVol.sampleStep();
    withVol.setSliceQuads([quad]);
    const stepWith = withVol.sampleStep();

    console.log(`empty     green ${empty.green} blue ${empty.blue} black ${empty.black}`);
    console.log(`axial     green ${axial.green} blue ${axial.blue} black ${axial.black}`);
    console.log(`oblique   green ${oblique.green} blue ${oblique.blue} black ${oblique.black}`);
    console.log(`sampleStep ${stepWithout.toFixed(4)} -> ${stepWith.toFixed(4)} mm`);
    console.log(`GPU errors=${errs.length}`);

    const checks: [string, boolean][] = [
      ["nothing is drawn before a quad is added", empty.green === 0 && empty.black === 0],
      ["the quad shows the composite's segment colour", axial.green > 500],
      ["the axial quad leaves background around it", axial.blue > 0],
      ["nothing black anywhere: every pixel is the composite or the background", axial.black === 0 && oblique.black === 0],
      ["the oblique quad is drawn", oblique.green > 300],
      ["the oblique frame's corners are discarded, not painted", oblique.blue > empty.blue * 0.3],
      ["the sample step is unchanged by adding a slice", Math.abs(stepWith - stepWithout) < 1e-6],
      ["no GPU errors", errs.length === 0],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
    const failures = checks.filter(([, ok]) => !ok).map(([n]) => n);
    assertEquals(failures, [], `slice-in-3D quad broke:\n  ${failures.join("\n  ")}`);
    dev.destroy();
  },
});
