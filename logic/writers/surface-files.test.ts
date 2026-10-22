// The surface export's file writers (logic/writers/surface-files.ts): binary STL and OBJ, LPS millimeters.
// Round trips through the readers beside them, on meshes made by the real extraction (surfaceNets), and the
// coordinates pinned against the RAS the extraction gives (CONSTRAINTS.md: "a round-trip test compares through the
// reader, and a separate test pins what the FILE holds").
//
//   deno test -A --no-check logic/writers/surface-files.test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { surfaceNets } from "../../algorithms/surface-nets.ts";
import { readObj, readStl, SPACE_TOKEN, stlHeader, surfaceFileName, writeObj, writeStl } from "./surface-files.ts";

const join = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

// Two boxes side by side (labels 1 and 2) on an oblique-free grid with an offset and 0.8 x 0.9 x 2 mm voxels, so a
// wrong axis or sign shows.
function twoBoxes() {
  const dims: [number, number, number] = [20, 16, 12];
  const lab = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let k = 3; k < 9; k++) for (let j = 4; j < 12; j++) for (let i = 2; i < 18; i++) lab[(k * dims[1] + j) * dims[0] + i] = i < 10 ? 1 : 2;
  const ijkToRAS = [0.8, 0, 0, -30, 0, 0.9, 0, 12, 0, 0, 2, -50, 0, 0, 0, 1];
  return surfaceNets(lab, dims, ijkToRAS);
}

Deno.test("STL: every triangle comes back, in LPS (x and y negated), with the header naming the segmentation", () => {
  const meshes = twoBoxes();
  assertEquals(meshes.length, 2);
  const bytes = join(writeStl(meshes, { name: "Two boxes" }));
  const tris = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  assertEquals(bytes.length, 84 + 50 * tris);
  const back = readStl(bytes);
  assertEquals(back.triangles, tris);
  assert(back.header.includes("Two boxes"), back.header);
  assert(back.header.includes(SPACE_TOKEN), back.header);
  assert(!/^solid/i.test(back.header), "a binary STL must not look like an ASCII one");
  // Corner by corner, in the order written: the meshes' own RAS positions with x and y negated.
  let t = 0;
  for (const m of meshes) {
    for (let f = 0; f < m.indices.length; f += 3, t++) {
      for (let c = 0; c < 3; c++) {
        const v = m.indices[f + c] * 3;
        assertAlmostEquals(back.corners[9 * t + 3 * c], -m.positions[v], 1e-4);
        assertAlmostEquals(back.corners[9 * t + 3 * c + 1], -m.positions[v + 1], 1e-4);
        assertAlmostEquals(back.corners[9 * t + 3 * c + 2], m.positions[v + 2], 1e-4);
      }
    }
  }
});

Deno.test("STL: the facet normals point outward (the winding survives RAS -> LPS)", () => {
  const meshes = twoBoxes();
  const back = readStl(join(writeStl(meshes.slice(0, 1), { name: "box" })));
  // Centroid of the closed surface; an outward normal points away from it, on average over every face.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < back.corners.length; i += 3) { cx += back.corners[i]; cy += back.corners[i + 1]; cz += back.corners[i + 2]; }
  const nV = back.corners.length / 3; cx /= nV; cy /= nV; cz /= nV;
  let out = 0;
  for (let t = 0; t < back.triangles; t++) {
    const mx = (back.corners[9 * t] + back.corners[9 * t + 3] + back.corners[9 * t + 6]) / 3 - cx;
    const my = (back.corners[9 * t + 1] + back.corners[9 * t + 4] + back.corners[9 * t + 7]) / 3 - cy;
    const mz = (back.corners[9 * t + 2] + back.corners[9 * t + 5] + back.corners[9 * t + 8]) / 3 - cz;
    if (mx * back.normals[3 * t] + my * back.normals[3 * t + 1] + mz * back.normals[3 * t + 2] > 0) out++;
  }
  // The extraction's own normals agree with the facets' (same winding rule), so this is a check of the writer's sign.
  assert(out / back.triangles > 0.95, `${out} of ${back.triangles} facets face outward`);
});

Deno.test("STL: the header is printable ASCII, 80 bytes, never beginning with 'solid'", () => {
  const h = stlHeader("solid organ — Leber");
  assertEquals(h.length, 80);
  assert([...h].every((b) => b >= 0x20 && b <= 0x7e));
  assert(!/^solid/i.test(String.fromCharCode(...h)));
});

Deno.test("OBJ: one named object per structure, its vertices in LPS, colored, the triangles intact", () => {
  const meshes = twoBoxes();
  const structs = [
    { name: "Liver", color: [0.86, 0.55, 0.24], mesh: meshes[0] },
    { name: "Kidney, right", color: [0.72, 0.33, 0.25], mesh: meshes[1] },
  ];
  const text = new TextDecoder().decode(join(writeObj(structs, { name: "Two boxes" })));
  const back = readObj(text);
  assert(back.comments.some((c) => c.includes(SPACE_TOKEN)), "the coordinate system is stated");
  assert(back.comments.some((c) => c.includes("Two boxes")), "the segmentation is named");
  assertEquals(back.objects.map((o) => o.name), ["Liver", "Kidney, right"]);
  for (let s = 0; s < 2; s++) {
    const m = meshes[s], o = back.objects[s];
    assertEquals(o.vertices.length, m.positions.length);
    assertEquals(o.triangles.length, m.indices.length);
    assertEquals(o.triangles.findIndex((v, i) => v !== m.indices[i]), -1, "the same triangles, in the same order");
    for (let v = 0; v < m.positions.length; v += 3) {
      assertAlmostEquals(o.vertices[v], -m.positions[v], 1e-3);
      assertAlmostEquals(o.vertices[v + 1], -m.positions[v + 1], 1e-3);
      assertAlmostEquals(o.vertices[v + 2], m.positions[v + 2], 1e-3);
      assertAlmostEquals(o.normals![v], -m.normals[v], 1e-3);
    }
    assert(o.colors);
    for (let v = 0; v < o.colors!.length; v += 3) {
      assertAlmostEquals(o.colors![v], structs[s].color[0], 1e-4);
      assertAlmostEquals(o.colors![v + 2], structs[s].color[2], 1e-4);
    }
  }
});

Deno.test("OBJ: a name on two lines stays one object name; an empty mesh writes no object", () => {
  const meshes = twoBoxes();
  const empty = { label: 9, positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) };
  const text = new TextDecoder().decode(join(writeObj([{ name: "Left\nlung", mesh: meshes[0] }, { name: "nothing", mesh: empty }], { name: "s" })));
  assertEquals(readObj(text).objects.map((o) => o.name), ["Left lung"]);
});

Deno.test("file names come from the segmentation's name", () => {
  assertEquals(surfaceFileName("TotalSegmentator: total", "stl"), "TotalSegmentator_total.surfaces.stl");
  assertEquals(surfaceFileName("", "obj"), "Segmentation.surfaces.obj");
  // Accents dropped, not the letter; no hidden file; a length cap (critic 2026-10-21, finding 13).
  assertEquals(surfaceFileName("Läsion", "stl"), "Lasion.surfaces.stl");
  assertEquals(surfaceFileName(".hidden", "stl"), "hidden.surfaces.stl");
  assertEquals(surfaceFileName("..", "obj"), "Segmentation.surfaces.obj");
  assert(surfaceFileName("x".repeat(300), "stl").length <= 140);
  // The token survives a long name (finding 7).
  const long = "moose:clin_ct_ribs of CT CHEST 1.0  B45f (flipped-input test)";
  const chunks = writeStl([], { name: long }), bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  assert(readStl(bytes).header.startsWith(SPACE_TOKEN), readStl(bytes).header);
});
