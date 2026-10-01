// WHAT THE DATA PROBE READS BACK, against real ImageFields.
//
// Ron: "The probe should show all gray scale values and all segmentations names at the probe
// location." Two things have to be right for a grayscale value to mean anything, and neither is
// obvious from reading the code:
//
//   1. THE DECODE. ImageField stores Float32 and promoted Uint16 as r32float (value as-is) but
//      Uint8 as r8unorm (the original byte, which the shader recovers by scaling the /255 sample by
//      normScale). A probe that assumed one format would report bytes as Hounsfield units.
//   2. THE INDEXING. The probe maps RAS through the field's own patientToTexture and takes
//      `floor(tex * dims)` -- the identical arithmetic the shaders use to pick a texel. Anything
//      else can disagree with the picture by a voxel at a boundary, which is exactly where you
//      point.
//
// Also asserted: the volume texture permits the copy at all. It did not until this change, and a
// copyTextureToBuffer on a texture without COPY_SRC throws inside the view update and takes every
// view down -- which is how that failure mode was found the first time.
//
//   deno test -A --no-check --unstable-webgpu render/test/probe-readback.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { ImageField } from "../fields.ts";
import { applyMat4 } from "../mat4.ts";
import type { Vec3 } from "../mat4.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "the data probe reads back the stored value at the voxel the shader would sample",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const dev = gpu.device;
    const dims: Vec3 = [8, 6, 4];
    // Anisotropic AND offset, so a wrong index or a dropped origin cannot pass by symmetry.
    const ijkToRAS = [2, 0, 0, -30, 0, 1, 0, 12, 0, 0, 3, -7, 0, 0, 0, 1];
    const n = dims[0] * dims[1] * dims[2];
    const at = (i: number, j: number, k: number) => (k * dims[1] + j) * dims[0] + i;
    const lut = new Uint8Array(256 * 4).fill(255);

    // Hounsfield-like values, including a negative one: air is -1000 and a probe that cannot show it
    // is not showing a CT.
    const f32 = new Float32Array(n);
    for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
      f32[at(i, j, k)] = i * 100 + j * 10 + k - 1000;
    }
    const u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = (i * 7) % 251;

    const fields = [
      { name: "r32float", f: new ImageField(dev, f32, dims, [1, 1, 1], lut, { clim: [-1000, 1000], ijkToRAS }), want: (i: number, j: number, k: number) => f32[at(i, j, k)] },
      { name: "r8unorm", f: new ImageField(dev, u8, dims, [1, 1, 1], lut, { clim: [0, 255], ijkToRAS }), want: (i: number, j: number, k: number) => u8[at(i, j, k)] },
    ];

    const buf = dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const checks: [string, boolean][] = [];

    for (const { name, f, want } of fields) {
      const tex = f.volumeTexture();
      checks.push([`${name}: the volume texture permits the copy (COPY_SRC)`, !!(tex.usage & GPUTextureUsage.COPY_SRC)]);
      if (!(tex.usage & GPUTextureUsage.COPY_SRC)) continue;
      const p2t = f.patientToTexture();
      let indexOk = true, valueOk = true;
      // Every voxel: at its own center in RAS, and nudged toward its far corner, so the floor()
      // convention is exercised rather than only its midpoint.
      for (const nudge of [0, 0.3]) {
        for (let k = 0; k < dims[2]; k++) for (let j = 0; j < dims[1]; j++) for (let i = 0; i < dims[0]; i++) {
          const c = [i + nudge, j + nudge, k + nudge];
          const ras: Vec3 = [
            ijkToRAS[0] * c[0] + ijkToRAS[1] * c[1] + ijkToRAS[2] * c[2] + ijkToRAS[3],
            ijkToRAS[4] * c[0] + ijkToRAS[5] * c[1] + ijkToRAS[6] * c[2] + ijkToRAS[7],
            ijkToRAS[8] * c[0] + ijkToRAS[9] * c[1] + ijkToRAS[10] * c[2] + ijkToRAS[11],
          ];
          const t = applyMat4(p2t, ras);
          const ijk = [Math.floor(t[0] * dims[0]), Math.floor(t[1] * dims[1]), Math.floor(t[2] * dims[2])];
          if (ijk[0] !== i || ijk[1] !== j || ijk[2] !== k) { indexOk = false; continue; }
          const enc = dev.createCommandEncoder();
          enc.copyTextureToBuffer(
            { texture: tex, origin: { x: ijk[0], y: ijk[1], z: ijk[2] } },
            { buffer: buf, bytesPerRow: 256, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          );
          dev.queue.submit([enc.finish()]);
          await buf.mapAsync(GPUMapMode.READ);
          const raw = buf.getMappedRange().slice(0);
          buf.unmap();
          const got = tex.format === "r32float" ? new Float32Array(raw)[0] : new Uint8Array(raw)[0];
          if (got !== want(i, j, k)) { valueOk = false; }
        }
      }
      checks.push([`${name}: RAS -> floor(tex * dims) lands on the right voxel, at centres and off-centre`, indexOk]);
      checks.push([`${name}: the decoded value equals what was stored, for all ${n} voxels`, valueOk]);
    }

    for (const [name, ok] of checks) console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
    const failures = checks.filter(([, ok]) => !ok).map(([x]) => x);
    assertEquals(failures, [], `probe readback broke:\n  ${failures.join("\n  ")}`);
    dev.destroy();
  },
});
