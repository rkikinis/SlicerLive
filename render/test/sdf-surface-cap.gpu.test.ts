// THE SEGMENTS AS SURFACES, ON A CAPPED GRID — how SEGRoulette gets its look, and what it costs.
//
// Ron, on the blurred-presence rendering: "still looks like a quarry". Then, pointing at Steve's
// SEGRoulette, whose title bar reads "3D · SDF surface": "how did Steve achieve this?"
//
// The answer was the step I had missed. SEGRoulette does not build the SDF on the data -- it calls
// resampleIsotropic FIRST, so the field sits on a capped isotropic grid. The SDF costs 64 bytes a
// padded voxel (two rgba32float seeds + four rgba16float), so at native resolution a 0.67 mm brain
// wants 1.1 GB and a full-body CT 27 GB, which is why I had called it unaffordable and Ron said
// "no go". Capped, both land in a few hundred megabytes, because the cap does not care how big the
// input was.
//
// So the two things worth pinning are the BUDGET (the cap really bounds it, whatever comes in) and
// the SMOOTHNESS (a distance field has a real gradient, which is the whole reason to pay for it).
//
//   deno test -A --no-check --unstable-webgpu render/test/sdf-surface-cap.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { JfaSdfBaker } from "../sdf-bake.ts";
import { resampleIsotropic } from "../../algorithms/geom.ts";
import type { Vec3 } from "../mat4.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
const SDF_MAX_DIM = 256, SDF_MAX_VOXELS = 6e6, BYTES_PER_VOXEL = 64;

Deno.test({
  name: "the SDF grid is capped whatever comes in, and its distance field is smooth",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const errs: string[] = [];
    gpu.device.addEventListener("uncapturederror", (e) => errs.push(String((e as GPUUncapturedErrorEvent).error)));

    // ── the budget, on the two real shapes ──
    const budget = (dims: Vec3, spacing: Vec3) => {
      const ijk = [spacing[0], 0, 0, 0, 0, spacing[1], 0, 0, 0, 0, spacing[2], 0, 0, 0, 0, 1];
      const n = dims[0] * dims[1] * dims[2];
      const lab = new Uint8Array(1);                       // the resampler only reads where it samples
      const c = resampleIsotropic(lab.length === n ? lab : new Uint8Array(n), dims, ijk, SDF_MAX_DIM, SDF_MAX_VOXELS);
      const padded = (c.dims[0] + 4) * (c.dims[1] + 4) * (c.dims[2] + 4);
      return { native: n, capped: c.dims, voxels: padded, mb: padded * BYTES_PER_VOXEL / 1e6, vox: c.vox };
    };
    const brain = budget([213, 308, 253], [0.67, 0.67, 0.67]);
    const body = budget([512, 512, 993], [0.78, 0.78, 1.0]);
    console.log(`brain  native ${brain.native.toLocaleString()} -> ${brain.capped.join("x")}  ${brain.vox.toFixed(2)} mm  ${brain.mb.toFixed(0)} MB`);
    console.log(`body   native ${body.native.toLocaleString()} -> ${body.capped.join("x")}  ${body.vox.toFixed(2)} mm  ${body.mb.toFixed(0)} MB`);

    // ── the surface, on a sphere whose true distance field is known exactly ──
    const D = 48, R = 15;
    const dims: Vec3 = [D, D, D];
    const ijk = [1, 0, 0, -D / 2, 0, 1, 0, -D / 2, 0, 0, 1, -D / 2, 0, 0, 0, 1];
    const lab = new Uint8Array(D * D * D);
    for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
      const dx = x - D / 2, dy = y - D / 2, dz = z - D / 2;
      if (Math.hypot(dx, dy, dz) <= R) lab[(z * D + y) * D + x] = 1;
    }
    const tex = gpu.device.createTexture({
      size: dims as [number, number, number], dimension: "3d", format: "r8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    gpu.device.queue.writeTexture({ texture: tex }, lab, { bytesPerRow: D, rowsPerImage: D }, dims as [number, number, number]);
    const sdf = new JfaSdfBaker(gpu.device, tex, dims, ijk);
    const pal = new Float32Array(256 * 4); pal[4] = 1; pal[5] = 1; pal[6] = 1; pal[7] = 1;
    sdf.setPalette(pal);
    sdf.setModePalette(new Float32Array(256 * 4));
    sdf.bake();
    sdf.refine();
    const dist = await sdf.readDistance();

    // Along a diagonal ray from the center, the distance must fall then rise MONOTONICALLY through
    // the surface. A blurred binary presence does not: it steps, which is the terracing.
    const pd = sdf.sdfDims(), pad = 2;
    const at = (i: number, j: number, k: number) => dist[((k + pad) * pd[1] + (j + pad)) * pd[0] + (i + pad)];
    // WHERE THE SURFACE IS, not what the numbers are. `refine()` deliberately blurs the distance so
    // the normal is smooth, so the field is a SMOOTHED distance and comparing it to the exact one
    // punishes it for doing its job (measured: 2.4 mm bias on a curved surface). What a surface
    // renderer has to get right is the ZERO CROSSING -- that is the surface it draws -- and that the
    // field rises monotonically through it, which is exactly what the terraced blur does not do.
    let nonMono = 0, last = -Infinity, crossR = NaN;
    let prevD = NaN, prevR = NaN;
    for (let t = 0; t < 24; t++) {
      const i = Math.round(D / 2 + t), j = Math.round(D / 2 + t * 0.5), k = Math.round(D / 2);
      if (i >= D || j >= D) break;
      const d = at(i, j, k);
      const r = Math.hypot(i - D / 2, j - D / 2, k - D / 2);
      if (!Number.isNaN(prevD) && prevD < 0 && d >= 0) crossR = prevR + (0 - prevD) / (d - prevD) * (r - prevR);
      if (d < last - 1e-3) nonMono++;
      last = d; prevD = d; prevR = r;
    }
    const surfErr = Math.abs(crossR - R);
    console.log(`sphere r=${R}: zero crossing at r=${crossR.toFixed(2)} (off by ${surfErr.toFixed(2)} mm); non-monotonic steps = ${nonMono}`);
    console.log(`GPU errors=${errs.length}`);

    const checks: [string, boolean][] = [
      ["the brain fits the budget", brain.mb < 450],
      ["a full-body CT fits the SAME budget", body.mb < 450],
      ["the cap actually coarsens the body (it cannot stay native)", body.vox > 1.5],
      ["every capped axis is within the per-axis cap", [...brain.capped, ...body.capped].every((d) => d <= SDF_MAX_DIM)],
      ["the surface it draws is where the sphere actually is", surfErr < 1.0],
      ["and rises monotonically outward — no terraces", nonMono === 0],
      ["no GPU errors", errs.length === 0],
    ];
    for (const [nm, ok] of checks) console.log(`${ok ? "  ok  " : " FAIL "} ${nm}`);
    const bad = checks.filter(([, ok]) => !ok).map(([nm]) => nm);
    assertEquals(bad, [], `SDF surface broke:\n  ${bad.join("\n  ")}`);
    sdf.destroy();
    gpu.device.destroy();
  },
});
