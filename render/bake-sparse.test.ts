// A LABELMAP SENT AS ITS NON-EMPTY CHUNKS MUST LAND ON THE CARD EXACTLY AS THE WHOLE ONE DOES.
//
// The upload now skips all-zero chunks (70-97% of a segmentation's) and relies on a new texture
// being zeros. This reads the texture back from the card and compares it voxel for voxel with the
// labelmap, on a volume whose chunks are cut off at the edges in two axes, with some chunks empty.
// Skipped without a graphics card.
import { assertEquals } from "jsr:@std/assert@1";
import { ColorizeBaker } from "./bake.ts";

const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;

Deno.test({
  name: "a labelmap uploaded as its non-empty chunks reads back identical to the whole",
  ignore: !adapter,
  fn: async () => {
    const device = await adapter!.requestDevice();
    const [nx, ny, nz] = [256, 40, 30];                   // x a multiple of 256 so a row reads back as-is
    const [cz, cy, cx] = [16, 32, 128];                   // partial chunks in y and z
    const lab = new Uint8Array(nx * ny * nz);
    // Labels in some chunks only; the rest stay empty.
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (x < 100 && y < 20 && z < 10) lab[(z * ny + y) * nx + x] = 1 + ((x + y + z) % 5);
      if (x > 200 && y > 35 && z > 20) lab[(z * ny + y) * nx + x] = 9;
    }
    // Cut it into padded chunks the way the store does, and keep only those that hold anything.
    const nonEmpty: { at: [number, number, number]; bytes: ArrayBuffer }[] = [];
    let empty = 0;
    for (let kk = 0; kk * cz < nz; kk++) for (let jj = 0; jj * cy < ny; jj++) for (let ii = 0; ii * cx < nx; ii++) {
      const c = new Uint8Array(cz * cy * cx);
      const z0 = kk * cz, y0 = jj * cy, x0 = ii * cx;
      let any = false;
      for (let z = 0; z < Math.min(cz, nz - z0); z++) for (let y = 0; y < Math.min(cy, ny - y0); y++) for (let x = 0; x < Math.min(cx, nx - x0); x++) {
        const v = lab[((z0 + z) * ny + (y0 + y)) * nx + (x0 + x)];
        c[(z * cy + y) * cx + x] = v; if (v) any = true;
      }
      if (any) nonEmpty.push({ at: [kk, jj, ii], bytes: c.buffer }); else empty++;
    }
    assertEquals(empty > 0, true, "the test needs some empty chunks to skip");

    const baker = new ColorizeBaker(device, lab, [nx, ny, nz], { shape: [cz, cy, cx], nonEmpty });
    const tex = baker.labelTexture();
    const out = device.createBuffer({ size: nx * ny * nz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: out, bytesPerRow: nx, rowsPerImage: ny }, [nx, ny, nz]);
    device.queue.submit([enc.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const back = new Uint8Array(out.getMappedRange().slice(0));
    out.unmap();
    let diff = 0;
    for (let i = 0; i < lab.length; i++) if (back[i] !== lab[i]) diff++;
    assertEquals(diff, 0, `${diff} voxels differ on the card`);
    device.destroy();
  },
});
