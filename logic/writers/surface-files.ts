// SURFACE MODELS AS FILES: binary STL and OBJ, the two formats every mesh tool reads (Slicer, MeshLab, Blender, a
// 3D printer's slicer).
//
// Ron, 2026-10-21 (option B): surface models are no longer drawn in Albula -- the anatomy is drawn solid from the
// labels -- and are kept ONLY AS AN EXPORT, made on demand when saving (render/surface-export.ts makes them, these
// functions write them). Save › Files had offered "STL (the surfaces)" before this, and it wrote a .seg.nrrd: there
// was no STL writer at all.
//
// COORDINATES: LPS MILLIMETERS, the DICOM patient system and Slicer's default for model files. `surfaceNets` gives
// the scene's RAS, so x and y are negated on the way out -- a rotation by 180 degrees about the S axis, not a
// mirror, so every triangle keeps its winding and its outward side. The file says so: "SPACE=LPS" in the STL's
// 80-byte header and in an OBJ comment, the token Slicer's model storage writes and looks for (the strings
// "SPACE=LPS" / "SPACE=RAS" are in its libMRMLCore, Slicer 5.12).
//
// CHECKED IN SLICER 5.12 (2026-10-21, without a window): both files load, as LPS, and the model's RAS bounds are the
// extraction's RAS bounds to the hundredth of a millimeter. Slicer reads the OBJ as ONE model, its structures as a
// "GroupIds" cell array, and does not read the vertex colors; the names and colors are for tools that keep them
// (the `v x y z r g b` extension is MeshLab's).
//
// The writers return the file as a LIST OF CHUNKS, one or a few per structure: a whole-body segmentation is about
// 12 million triangles, 600 MB of STL and more of OBJ text, and one contiguous buffer of that size is a second copy
// the page does not need -- `new Blob(chunks)` takes the list as it is. Pure functions, no DOM: tested in Deno
// (surface-files.test.ts) through the readers below, which exist for that and for anyone who wants a file back.

/** One structure's surface, as `surfaceNets` gives it: RAS millimeters, triangles as index triples (0-based). */
export interface SurfaceMesh {
  label: number;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
}
/** A structure to write: its mesh, its name, its color (0..1 RGB). */
export interface NamedSurface {
  name: string;
  color?: readonly number[];
  mesh: SurfaceMesh;
}

/** The token Slicer's model storage uses for a file's coordinate system. */
export const SPACE_TOKEN = "SPACE=LPS";

/** The 80-byte header of a binary STL: printable ASCII only, padded with spaces. Never starting with "solid",
 *  which is how an ASCII STL begins -- a reader that sniffs for it would take this file for text. */
export function stlHeader(text: string): Uint8Array {
  let t = text.replace(/[^\x20-\x7e]/g, "?");
  if (/^solid/i.test(t)) t = "Albula " + t;
  const out = new Uint8Array(80).fill(0x20);
  for (let i = 0; i < Math.min(80, t.length); i++) out[i] = t.charCodeAt(i);
  return out;
}

/** The 84 bytes before an STL's triangles: the header naming the surfaces, then how many triangles follow. */
export function stlHead(name: string, triangles: number): Uint8Array {
  const head = new Uint8Array(84);
  // THE TOKEN FIRST (critic 2026-10-21, finding 7): a name past ~52 characters cut it off the 80 bytes.
  head.set(stlHeader(`${SPACE_TOKEN} mm; Albula surfaces of ${name}`), 0);
  new DataView(head.buffer).setUint32(80, triangles, true);
  return head;
}

const triangleCount = (meshes: readonly SurfaceMesh[]) => meshes.reduce((n, m) => n + Math.floor(m.indices.length / 3), 0);

/**
 * A BINARY STL of these structures, in LPS millimeters. STL has no names, groups or colors, so it is one surface
 * set per file: the segmentation's (the caller chooses which structures; the header names the segmentation).
 * Facet normals are computed from each triangle's winding, which is what an STL reader expects of them.
 */
export function writeStl(meshes: readonly SurfaceMesh[], opts: { name: string; /** false: the triangles only, for a file made of several parts (stlHead writes the header once) */ header?: boolean }): Uint8Array[] {
  const chunks: Uint8Array[] = opts.header === false ? [] : [stlHead(opts.name, triangleCount(meshes))];
  for (const m of meshes) {
    const p = m.positions, idx = m.indices;
    const n = Math.floor(idx.length / 3);
    if (!n) continue;
    const buf = new ArrayBuffer(n * 50);
    const dv = new DataView(buf);
    let o = 0;
    for (let t = 0; t < n; t++) {
      const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
      // RAS -> LPS: x and y negated, z kept.
      const ax = -p[a], ay = -p[a + 1], az = p[a + 2];
      const bx = -p[b], by = -p[b + 1], bz = p[b + 2];
      const cx = -p[c], cy = -p[c + 1], cz = p[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
      dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
      dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
      dv.setUint16(o + 48, 0, true);
      o += 50;
    }
    chunks.push(new Uint8Array(buf));
  }
  return chunks;
}

/** A binary STL read back: the header, and every triangle's three corners (9 floats each) and facet normal, as
 *  stored (LPS for a file written above). */
export function readStl(bytes: Uint8Array): { header: string; triangles: number; corners: Float32Array; normals: Float32Array } {
  if (bytes.length < 84) throw new Error("not a binary STL: shorter than its header");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = String.fromCharCode(...bytes.subarray(0, 80)).trimEnd();
  const n = dv.getUint32(80, true);
  if (bytes.length < 84 + n * 50) throw new Error(`not a binary STL: ${n} triangles announced, ${Math.floor((bytes.length - 84) / 50)} present`);
  const corners = new Float32Array(n * 9), normals = new Float32Array(n * 3);
  for (let t = 0, o = 84; t < n; t++, o += 50) {
    for (let k = 0; k < 3; k++) normals[3 * t + k] = dv.getFloat32(o + 4 * k, true);
    for (let k = 0; k < 9; k++) corners[9 * t + k] = dv.getFloat32(o + 12 + 4 * k, true);
  }
  return { header, triangles: n, corners, normals };
}

/** An OBJ name: one line, no leading or trailing space. */
const objName = (s: string) => s.replace(/[\r\n]+/g, " ").trim() || "structure";
/** Millimeters to a tenth of a micrometer; colors and normals to four places. Enough, and short. */
const f4 = (v: number) => (Math.abs(v) < 5e-5 ? "0" : v.toFixed(4));

/**
 * AN OBJ of these structures, in LPS millimeters: one named object per structure ("o <name>"), each vertex carrying
 * its structure's color (`v x y z r g b`, 0..1; Slicer 5.12 ignores it, see above), normals (`vn`), and faces
 * `f a//a b//b c//c`. Indices are 1-based and run on across the objects, as the format has them.
 */
export function writeObj(structures: readonly NamedSurface[], opts: {
  name: string;
  /** false: no comment lines at the top, for a part of a larger file (objHead writes them once). */ header?: boolean;
  /** The vertices already written before this part (OBJ numbers vertices across the whole file). */ vertexOffset?: number;
}): Uint8Array[] {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const LINES = 65536;                                   // lines per chunk: a few MB of text, never one giant string
  let lines: string[] = [];
  const flush = () => { if (lines.length) { chunks.push(enc.encode(lines.join("\n") + "\n")); lines = []; } };
  const line = (l: string) => { lines.push(l); if (lines.length >= LINES) flush(); };
  if (opts.header !== false) for (const l of objHeadLines(opts.name)) line(l);
  let base = opts.vertexOffset ?? 0;
  for (const s of structures) {
    const p = s.mesh.positions, nr = s.mesh.normals, idx = s.mesh.indices;
    const nv = Math.floor(p.length / 3);
    if (!nv || idx.length < 3) continue;
    const c = s.color ?? [0.8, 0.8, 0.8];
    const rgb = `${f4(c[0])} ${f4(c[1])} ${f4(c[2])}`;
    line(`o ${objName(s.name)}`);
    for (let v = 0; v < nv; v++) line(`v ${f4(-p[3 * v])} ${f4(-p[3 * v + 1])} ${f4(p[3 * v + 2])} ${rgb}`);
    const withNormals = !!nr && nr.length >= nv * 3;
    if (withNormals) for (let v = 0; v < nv; v++) line(`vn ${f4(-nr![3 * v])} ${f4(-nr![3 * v + 1])} ${f4(nr![3 * v + 2])}`);
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t] + base + 1, b = idx[t + 1] + base + 1, d = idx[t + 2] + base + 1;
      line(withNormals ? `f ${a}//${a} ${b}//${b} ${d}//${d}` : `f ${a} ${b} ${d}`);
    }
    base += nv;
  }
  flush();
  return chunks;
}

function objHeadLines(name: string): string[] {
  return [`# Albula surfaces of ${objName(name)}`, `# ${SPACE_TOKEN}: coordinates in millimeters, the DICOM patient system (L, P, S)`,
    `# one object per structure; each vertex carries its structure's color (r g b, 0 to 1)`];
}
/** The comment lines at the top of an OBJ made of several parts. */
export function objHead(name: string): Uint8Array { return new TextEncoder().encode(objHeadLines(name).join("\n") + "\n"); }
/** The vertices an OBJ part writes (for the next part's vertexOffset). */
export function objVertexCount(structures: readonly NamedSurface[]): number {
  return structures.reduce((n, s) => n + (s.mesh.positions.length >= 3 && s.mesh.indices.length >= 3 ? Math.floor(s.mesh.positions.length / 3) : 0), 0);
}

/** An OBJ read back, per object: its name, vertices, vertex colors (or null), normals (or null) and triangles
 *  (0-based, into this object's own vertices). Polygons with more corners are fanned into triangles. */
export function readObj(text: string): { comments: string[]; objects: { name: string; vertices: Float32Array; colors: Float32Array | null; normals: Float32Array | null; triangles: Uint32Array }[] } {
  const comments: string[] = [];
  const v: number[] = [], col: number[] = [], vn: number[] = [];
  let hasColor = true;
  type Obj = { name: string; faces: number[] };
  const objs: Obj[] = [];
  let cur: Obj | undefined;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#")) { comments.push(l.slice(1).trim()); continue; }
    const sp = l.indexOf(" ");
    const key = sp < 0 ? l : l.slice(0, sp), rest = sp < 0 ? "" : l.slice(sp + 1).trim();
    if (key === "o" || key === "g") { cur = { name: rest, faces: [] }; objs.push(cur); }
    else if (key === "v") {
      const a = rest.split(/\s+/).map(Number);
      v.push(a[0], a[1], a[2]);
      if (a.length >= 6) col.push(a[3], a[4], a[5]); else hasColor = false;
    } else if (key === "vn") { const a = rest.split(/\s+/).map(Number); vn.push(a[0], a[1], a[2]); }
    else if (key === "f") {
      if (!cur) { cur = { name: "", faces: [] }; objs.push(cur); }
      const corners = rest.split(/\s+/).map((tok) => parseInt(tok.split("/")[0], 10) - 1);
      for (let k = 1; k + 1 < corners.length; k++) cur.faces.push(corners[0], corners[k], corners[k + 1]);
    }
  }
  const objects = objs.map((o) => {
    // This object's vertices: the ones its faces use, renumbered from 0 in the order of the file.
    const used = [...new Set(o.faces)].sort((a, b) => a - b);
    const map = new Map(used.map((g, i) => [g, i]));
    const vertices = new Float32Array(used.length * 3), colors = hasColor ? new Float32Array(used.length * 3) : null;
    const normals = vn.length === v.length ? new Float32Array(used.length * 3) : null;
    used.forEach((g, i) => {
      for (let k = 0; k < 3; k++) {
        vertices[3 * i + k] = v[3 * g + k];
        if (colors) colors[3 * i + k] = col[3 * g + k];
        if (normals) normals[3 * i + k] = vn[3 * g + k];
      }
    });
    return { name: o.name, vertices, colors, normals, triangles: Uint32Array.from(o.faces, (g) => map.get(g)!) };
  });
  return { comments, objects };
}

/** A file name from a segmentation's name, as the other exports make theirs (logic/export.ts). */
export function surfaceFileName(segName: string, ext: "stl" | "obj"): string {
  return `${plainFileStem(segName)}.surfaces.${ext}`;
}
/**
 * A NAME A PERSON CAN FIND (critic 2026-10-21, finding 13): accents dropped rather than the letter ("Läsion" -> "Lasion",
 * not "L_sion"), anything else that is not a letter, digit, "-" or "." becomes "_", never starting with a dot (a hidden
 * file in Downloads), at most 120 characters. The server's rule for a file at the top of Downloads (desktop/pictures.ts)
 * accepts every name this makes.
 */
export function plainFileStem(name: string): string {
  const s = (name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9.-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "").replace(/_+$/, "").slice(0, 120);
  return s || "Segmentation";
}
