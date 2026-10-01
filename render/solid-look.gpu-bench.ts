// THE SOLID LOOK'S SPEED, measured with the application's own renderer on a real whole-body labelmap,
// away from the page: no reloads, no other window on the card, a number per change in seconds.
// Ron, 2026-09-23: "fix the dotted pattern and the speed first."
//
//   deno run -A --no-check --unstable-webgpu render/solid-look.gpu-bench.ts [labelmap.nrrd] [--png=<dir>]
//
// Defaults to the ts.v2:total checkpoint of C3N-01524 (public, TCIA CPTAC-CCRCC), 111 structures.
// Liver and the five lung lobes are drawn see-through at 0.4, the app's see-through since 2026-09-24 (the
// numbers in SOLID-LOOK.md up to then were measured at 0.3, as in the scene Ron tried), because rays
// that pass through see-through structures are the expensive ones.
//
// WHAT IS TIMED: one accumulated frame at 800 x 800, 400 x 400 and 200 x 200 (the same view, a quarter
// and a sixteenth of the pixels), the mean of twelve frames submitted back to back after two warm-ups,
// waited for once (Deno's onSubmittedWorkDone alone costs ~14 ms). The see-through colored volume over
// the same labels is timed alongside as the yardstick. The field here is ONE segmentation, not merged:
// it reads visibility per voxel where the app's merged field skips that read. These are Deno's WebGPU
// numbers (Metal through wgpu), not WebKit's -- the relative ones carry over, the absolute ones must be
// checked in the app's window. Options: --plain (no drawing look), --opaque (nothing see-through), --finishes,
// --steps (report steps per ray), --png=<dir>.
import { parseNrrd } from "./nrrd.ts";
import { initDevice } from "./device.ts";
import { SceneRenderer } from "./scene-renderer.ts";
import { ColorizeField } from "./colorize-field.ts";
import { encodePNG } from "./png.ts";

const DEFAULT_CASE = new URL(
  "../../../Slicer/SlicerDICOMDatabase/SlicerAlbula-Checkpoints/2026-09-23T16-22-19-991Z-ts.v2_total.seg.nrrd",
  import.meta.url,
).pathname;
const args = Deno.args.filter((a) => !a.startsWith("--"));
const pngDir = Deno.args.find((a) => a.startsWith("--png="))?.slice(6);
const file = args[0] ?? DEFAULT_CASE;

const n = await parseNrrd(await Deno.readFile(file));
const dims = n.dims as [number, number, number];
const src = n.data as unknown as ArrayLike<number>;
const lab = src instanceof Uint8Array ? src : Uint8Array.from({ length: src.length }, (_, i) => src[i]);
const m = n.ijkToRAS as number[];
console.log(file.split("/").pop(), dims.join(" x "));

const gpu = await initDevice();
const dev = gpu.device;
const FMT: GPUTextureFormat = "rgba8unorm-srgb";
const field = new ColorizeField(dev, null, lab, dims, new Uint8Array(256 * 4), {
  clim: [-1000, 1600], ijkToRAS: m, contextOpacity: 0, shade: [0.30, 0.70, 0.15, 20],
});
const SEE_THROUGH = Deno.args.includes("--opaque") ? new Set<number>() : new Set([5, 10, 11, 12, 13, 14]);   // liver, the five lung lobes (TotalSegmentator v2 numbering)
for (let l = 1; l < 256; l++) {
  const h = (l * 0.61803) % 1;
  field.setSegmentColor(l, [0.55 + 0.4 * Math.sin(6.28 * h), 0.55 + 0.4 * Math.sin(6.28 * (h + 0.33)), 0.55 + 0.4 * Math.sin(6.28 * (h + 0.66))]);
  field.setSegmentOpacity(l, SEE_THROUGH.has(l) ? 0.4 : 1);
}
// --finishes: every structure given one of Michael Halle's finishes (logic/anatomy/palettes.ts), round the list, so the
// frame is timed with the per-structure highlight on (Ron, 2026-09-25: "if there is no significant slowdown").
if (Deno.args.includes("--finishes")) {
  const v2 = JSON.parse(await Deno.readTextFile(new URL("../logic/anatomy/palette-v2.json", import.meta.url))) as { finishes: Record<string, Record<string, number>> };
  const list = Object.values(v2.finishes);
  for (let l = 1; l < 256; l++) {
    const p = list[l % list.length];
    field.setSegmentMaterial(l, { roughness: p.roughness ?? 0.5, ior: p.ior ?? 1.4, coat: p.coat ?? 0, coatRoughness: p.coat_roughness ?? 0.1, sheen: p.sheen ?? 0, subsurface: p.subsurface ?? 0, metallic: p.metallic ?? 0 });
  }
}
field.flushPalette();

// Anterior view of the whole volume, as the app frames it.
const corner = (i: number, j: number, k: number) => [0, 1, 2].map((r) => m[r * 4] * i + m[r * 4 + 1] * j + m[r * 4 + 2] * k + m[r * 4 + 3]);
const a = corner(0, 0, 0), b = corner(dims[0] - 1, dims[1] - 1, dims[2] - 1);
const center = [0, 1, 2].map((i) => (a[i] + b[i]) / 2) as [number, number, number];
const extent = Math.max(...[0, 1, 2].map((i) => Math.abs(b[i] - a[i])));

async function timeLook(solid: boolean, w: number, h: number, frames = 12): Promise<{ ms: number; img?: Uint8Array }> {
  const sr = new SceneRenderer(gpu, FMT);
  field.setSolid(solid);
  await new Promise((r) => setTimeout(r, 0));                  // the smoothed copy is built in a microtask
  await dev.queue.onSubmittedWorkDone();
  sr.build([field]);
  sr.setDrawingLook(!Deno.args.includes("--plain"));
  if (Deno.args.includes("--steps")) (sr as unknown as { setSolidDebug(v: number): void }).setSolidDebug(1);
  sr.setCamera([center[0], center[1] + extent * 1.6, center[2]], center, [0, 0, 1], 30, w, h);
  const target = dev.createTexture({ size: [w, h], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const view = target.createView();
  for (let i = 0; i < 2; i++) { sr.renderAccum(view, w, h, i === 0); await dev.queue.onSubmittedWorkDone(); }
  // Submitted back to back and waited for once: Deno's onSubmittedWorkDone alone costs ~14 ms, which
  // waiting per frame would add to every one (measured 13.6 ms for a bare submit).
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) sr.renderAccum(view, w, h, i === 0);
  await dev.queue.onSubmittedWorkDone();
  const ms = (performance.now() - t0) / frames;
  let img: Uint8Array | undefined;
  if (pngDir) {
    const bpr = Math.ceil(w * 4 / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(buf.getMappedRange());
    img = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) img.set(raw.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    if (Deno.args.includes("--steps") && solid) {
      // The step picture: red is steps / 400 (sRGB-encoded by the target). Mean and share of long rays.
      const lin = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      const steps: number[] = [];
      for (let i = 0; i < w * h; i++) steps.push(lin(img[i * 4]) * 400);
      steps.sort((p, q) => p - q);
      const mean = steps.reduce((p, q) => p + q, 0) / steps.length;
      console.log(`    steps per ray at ${w}x${h}: mean ${mean.toFixed(0)}, median ${steps[steps.length >> 1].toFixed(0)}, 95th ${steps[Math.floor(steps.length * 0.95)].toFixed(0)}, max ${steps[steps.length - 1].toFixed(0)} (400 = 400 or more)`);
    }
    buf.unmap(); buf.destroy();
  }
  target.destroy();
  return { ms, img };
}

for (const [w, h, what] of [[800, 800, "800x800"], [400, 400, "400x400 (a quarter)"], [200, 200, "200x200 (a sixteenth)"]] as const) {
  const soft = await timeLook(false, w, h);
  const solid = await timeLook(true, w, h);
  console.log(`  ${what}: solid ${solid.ms.toFixed(1)} ms, see-through ${soft.ms.toFixed(1)} ms`);
  if (pngDir && solid.img) {
    await Deno.mkdir(pngDir, { recursive: true });
    await Deno.writeFile(`${pngDir}/solid-${w}x${h}.png`, await encodePNG(solid.img, w, h));
  }
}
field.destroy();
dev.destroy();
