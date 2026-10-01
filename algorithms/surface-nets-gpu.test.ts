// THE GPU EXTRACTION MUST AGREE WITH THE ONE THAT SHIPS, on the same labelmap.
//
// Small synthetic volumes, because this runs in the ordinary test pass: two touching boxes (the
// case surface nets exists for -- parcels that share a wall must share vertices), a sphere, and a
// volume whose labels reach the edge of the grid, which is where the cell-out-of-range rule bites.
//
// SKIPPED WITHOUT A GRAPHICS CARD. `deno test` reaches this with no adapter on a machine that has
// none, and a skipped test says so rather than failing something unrelated.
import { assertEquals } from "jsr:@std/assert@1";
import { surfaceNets } from "./surface-nets.ts";
import { surfaceNetsGpu } from "./surface-nets-gpu.ts";

const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
const IJK = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function boxes(n: number): { lab: Uint8Array; dims: [number, number, number] } {
  const lab = new Uint8Array(n * n * n);
  const at = (i: number, j: number, k: number) => (k * n + j) * n + i;
  for (let k = 2; k < n - 2; k++) {
    for (let j = 2; j < n - 2; j++) {
      for (let i = 2; i < n - 2; i++) lab[at(i, j, k)] = i < n / 2 ? 1 : 2;   // two boxes sharing a wall
    }
  }
  return { lab, dims: [n, n, n] };
}

function sphereAndEdge(n: number): { lab: Uint8Array; dims: [number, number, number] } {
  const lab = new Uint8Array(n * n * n);
  const c = (n - 1) / 2, r = n / 3;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(i - c, j - c, k - c);
        // A sphere, and a slab of another label that runs into the wall of the grid.
        if (d < r) lab[(k * n + j) * n + i] = 3;
        else if (i < 2) lab[(k * n + j) * n + i] = 7;
      }
    }
  }
  return { lab, dims: [n, n, n] };
}

async function sameTriangles(lab: Uint8Array, dims: [number, number, number]) {
  const cpu = surfaceNets(lab, dims, IJK, { smoothIters: 0, normalSmooth: 0 });
  const g = await surfaceNetsGpu(lab, dims, {});
  const byLabel = new Map(cpu.map((m) => [m.label, m.indices.length / 3]));
  assertEquals([...g.trianglesByLabel.entries()].sort((a, b) => a[0] - b[0]),
    [...byLabel.entries()].sort((a, b) => a[0] - b[0]));
  return g;
}

Deno.test({
  name: "GPU surface nets: two labels sharing a wall give the same triangles as the CPU",
  ignore: !adapter,
  fn: async () => {
    const { lab, dims } = boxes(24);
    const g = await sameTriangles(lab, dims);
    // One vertex per active cell, shared: if the GPU had extracted per label there would be more.
    assertEquals(g.vertices > 0, true);
  },
});

Deno.test({
  name: "GPU surface nets: a sphere and a label against the grid wall",
  ignore: !adapter,
  fn: async () => {
    const { lab, dims } = sphereAndEdge(31);
    await sameTriangles(lab, dims);
  },
});

Deno.test({
  name: "GPU surface nets: Taubin smoothing matches the same maths in double precision",
  ignore: !adapter,
  fn: async () => {
    const { lab, dims } = boxes(20);
    const g = await surfaceNetsGpu(lab, dims, { smoothIters: 24, keepPositions: true, keepQuads: true });
    const nv = g.vertices, qd = g.quadsData!;
    const deg = new Uint32Array(nv);
    for (let t = 0; t < g.quads; t++) {
      const o = t * 6 + 2;
      for (let e = 0; e < 4; e++) { deg[qd[o + e]]++; deg[qd[o + ((e + 1) & 3)]]++; }
    }
    const off = new Uint32Array(nv + 1);
    for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i];
    const adj = new Uint32Array(off[nv]);
    const cur = off.slice(0, nv);
    for (let t = 0; t < g.quads; t++) {
      const o = t * 6 + 2;
      for (let e = 0; e < 4; e++) {
        const u = qd[o + e], v = qd[o + ((e + 1) & 3)];
        adj[cur[u]++] = v; adj[cur[v]++] = u;
      }
    }
    let px = Float64Array.from(g.positionsRaw!);
    let qx = new Float64Array(px.length);
    const step = (f: number) => {
      for (let i = 0; i < nv; i++) {
        const s = off[i], e = off[i + 1], d = e - s;
        if (!d) { for (let c = 0; c < 3; c++) qx[i * 3 + c] = px[i * 3 + c]; continue; }
        let ax = 0, ay = 0, az = 0;
        for (let t = s; t < e; t++) { const m = adj[t] * 3; ax += px[m]; ay += px[m + 1]; az += px[m + 2]; }
        qx[i * 3] = px[i * 3] + f * (ax / d - px[i * 3]);
        qx[i * 3 + 1] = px[i * 3 + 1] + f * (ay / d - px[i * 3 + 1]);
        qx[i * 3 + 2] = px[i * 3 + 2] + f * (az / d - px[i * 3 + 2]);
      }
      [px, qx] = [qx, px];
    };
    for (let t = 0; t < 24; t++) { step(0.6); step(-0.62); }
    let worst = 0;
    for (let i = 0; i < px.length; i++) worst = Math.max(worst, Math.abs(px[i] - g.positions![i]));
    // f32 on the card against f64 here: thousandths of a voxel is float noise, anything more is a bug.
    assertEquals(worst < 1e-3, true, `worst vertex differs by ${worst} voxels`);
  },
});

// PHASE 4 TOO: the split into one mesh per label, the winding, RAS, and the normals.
//
// Vertex ORDER differs by construction -- the CPU numbers vertices on first use, the card by a
// prefix sum -- so comparing vertex n with vertex n proves nothing. What does: how many vertices and
// triangles each label has, how much surface, and whether the faces point the same way as their
// corners' normals. A flipped winding or a wrong normal moves that last number immediately.
Deno.test({
  name: "GPU surface nets: per-label meshes, winding and normals match the CPU",
  ignore: !adapter,
  fn: async () => {
    const { lab, dims } = boxes(24);
    const ras = [0.7, 0, 0, -10, 0, 0.7, 0, -12, 0, 0, 1.3, -5, 0, 0, 0, 1];
    const cpu = surfaceNets(lab, dims, ras, { smoothIters: 24, normalSmooth: 16 });
    const g = await surfaceNetsGpu(lab, dims, {
      smoothIters: 24, labelMeshes: true, keepMeshes: true, ijkToRAS: ras, normalSmooth: 16,
    });
    assertEquals(g.meshes!.length, cpu.length);
    const area = (m: { positions: Float32Array; indices: Uint32Array }) => {
      let a = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const i0 = m.indices[t] * 3, i1 = m.indices[t + 1] * 3, i2 = m.indices[t + 2] * 3;
        const ux = m.positions[i1] - m.positions[i0], uy = m.positions[i1 + 1] - m.positions[i0 + 1], uz = m.positions[i1 + 2] - m.positions[i0 + 2];
        const wx = m.positions[i2] - m.positions[i0], wy = m.positions[i2 + 1] - m.positions[i0 + 1], wz = m.positions[i2 + 2] - m.positions[i0 + 2];
        a += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      }
      return a;
    };
    const facing = (m: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) => {
      let acc = 0, cnt = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const i0 = m.indices[t] * 3, i1 = m.indices[t + 1] * 3, i2 = m.indices[t + 2] * 3;
        const ux = m.positions[i1] - m.positions[i0], uy = m.positions[i1 + 1] - m.positions[i0 + 1], uz = m.positions[i1 + 2] - m.positions[i0 + 2];
        const wx = m.positions[i2] - m.positions[i0], wy = m.positions[i2 + 1] - m.positions[i0 + 1], wz = m.positions[i2 + 2] - m.positions[i0 + 2];
        const px = uy * wz - uz * wy, py = uz * wx - ux * wz, pz = ux * wy - uy * wx;
        const L = Math.hypot(px, py, pz) || 1;
        acc += (px / L) * m.normals[i0] + (py / L) * m.normals[i0 + 1] + (pz / L) * m.normals[i0 + 2];
        cnt++;
      }
      return acc / cnt;
    };
    for (const c of cpu) {
      const gm = g.meshes!.find((x) => x.label === c.label)!;
      assertEquals(gm.indices.length, c.indices.length, `label ${c.label}: triangle count`);
      assertEquals(gm.positions.length, c.positions.length, `label ${c.label}: vertex count`);
      const da = Math.abs(area(gm) - area(c)) / area(c);
      assertEquals(da < 1e-4, true, `label ${c.label}: surface area differs by ${(da * 100).toFixed(4)}%`);
      const df = Math.abs(facing(gm) - facing(c));
      assertEquals(df < 1e-3, true, `label ${c.label}: the normals face differently by ${df}`);
      // And they must face OUT, not in: a flipped winding shows up as a negative mean.
      assertEquals(facing(gm) > 0.5, true, `label ${c.label}: the faces do not agree with their normals`);
    }
  },
});
