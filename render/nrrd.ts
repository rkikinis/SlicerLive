// NRRD reader (http://teem.sourceforge.net/nrrd/format.html): a text header, then one data block
// (raw or gzip). Two entry points, because they are two different things rather than two
// representations of one thing:
//
//   parseNrrd     a scalar volume, widened to Float32 for ImageField/SceneVolume
//   parseNrrdSeg  a segmentation (.seg.nrrd): integer labels kept as integers, Slicer's Segment*
//                 header keys read back, and the 4-D multi-layer form that overlapping segments need
//
// Runs in Deno (server) and the browser.
//
// NRRD is the one common format that DECLARES its coordinate space rather than assuming one — the
// `space` field takes `left-posterior-superior` and `right-anterior-superior` but also
// `3D-right-handed` and `scanner-xyz`, which have no anatomical meaning at all. This reader used to
// collapse that to `space.startsWith("right") ? no flip : flip X and Y`, which quietly MIRRORED
// every non-anatomical volume: "3d-right-handed" does not start with "right", so a microscopy stack
// or a phantom was read as though it were LPS. `space units` was ignored outright, so a NRRD in
// micrometers was read as millimeters. Both are fixed below, and an unrecognized space now throws
// rather than guessing.
import type { Vec3 } from "./mat4.ts";

export interface Nrrd {
  data: Float32Array;              // scalars, (z,y,x) C-order — matches ImageField/SceneVolume
  dims: [number, number, number];  // nx, ny, nz (fastest → slowest)
  ijkToRAS: number[];              // row-major 4×4
  range: [number, number];         // observed [min, max]
  /** The `space` the file declared, verbatim and lower-cased. Not all of them are anatomical. */
  space: string;
  /** Per-axis `space units` as declared, e.g. ["mm","mm","mm"] or ["um","um","um"]. Empty if absent. */
  spaceUnits: string[];
  /** True when `space` is anatomical, so `ijkToRAS` is meaningful as RAS rather than as bare world. */
  anatomical: boolean;
}

/** One segment of a .seg.nrrd, from Slicer's `Segment<N>_*` header keys. */
export interface NrrdSegment {
  /** `Segment<N>_LabelValue`: the voxel value that means this segment, within its layer. */
  labelValue: number;
  /** `Segment<N>_Layer`: which 4-D layer holds it. 0 when the file is 3-D. */
  layer: number;
  name: string;
  id: string;
  /** `Segment<N>_Color`, 0..1 per channel. */
  color: [number, number, number];
}

/** A segmentation NRRD: integer labels, one plane per layer, plus what each label means. */
export interface NrrdSeg {
  /** One labelmap per layer, each `nx*ny*nz`, integer — never widened. */
  layers: (Uint8Array | Uint16Array | Int16Array | Int32Array)[];
  dims: [number, number, number];
  ijkToRAS: number[];
  space: string;
  spaceUnits: string[];
  anatomical: boolean;
  segments: NrrdSegment[];
}

export const TYPE_BYTES: Record<string, number> = {
  "signed char": 1, "int8": 1, "int8_t": 1, "uchar": 1, "unsigned char": 1, "uint8": 1, "uint8_t": 1,
  "short": 2, "short int": 2, "signed short": 2, "signed short int": 2, "int16": 2, "int16_t": 2,
  "ushort": 2, "unsigned short": 2, "unsigned short int": 2, "uint16": 2, "uint16_t": 2,
  "int": 4, "signed int": 4, "int32": 4, "int32_t": 4, "uint": 4, "unsigned int": 4, "uint32": 4, "uint32_t": 4,
  "float": 4, "double": 8,
};

/** Parse NRRD bytes (header already de-gzipped is NOT required — the data block is decoded here). */
export async function parseNrrd(buf: Uint8Array): Promise<Nrrd> {
  const { f, body } = splitHeader(buf);
  const type = (f["type"] ?? "").toLowerCase();
  const bpp = TYPE_BYTES[type];
  if (!bpp) throw new Error(`NRRD: unsupported type "${type}"`);
  const sizes = (f["sizes"] ?? "").split(/\s+/).filter(Boolean).map(Number);
  if (sizes.length !== 3) {
    throw new Error(
      `NRRD: parseNrrd needs dimension 3, got sizes [${sizes}]` +
      (sizes.length === 4 ? " — a 4-D segmentation goes through parseNrrdSeg" : ""),
    );
  }
  const [nx, ny, nz] = sizes as [number, number, number];
  const nvox = nx * ny * nz;
  const little = (f["endian"] ?? "little").toLowerCase() !== "big";

  const raw = await decode(f, body, nvox * bpp);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const read = sampleReader(type, raw, dv, little);

  const out = new Float32Array(nvox);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nvox; i++) {
    const v = read(i * bpp);
    out[i] = v;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }

  const geom = geometry(f);
  return { data: out, dims: [nx, ny, nz], range: [lo, hi], ...geom };
}

// NRRD's declared spaces, and what each means for the sign of the first two axes.
//
// The three anatomical ones convert to RAS by flipping X and Y iff they start from Left/Posterior.
// The rest are NOT anatomical: their axes are a right-handed world frame with no patient meaning, so
// flipping them is not a conversion, it is a mirror. `null` marks those — the matrix comes through
// unchanged and `anatomical` is false, which is the signal a caller needs before it draws an "R" on
// a screen or matches the volume to a DICOM SEG.
const SPACES: Record<string, { flip: [number, number, number] | null }> = {
  "left-posterior-superior": { flip: [-1, -1, 1] },
  "lps": { flip: [-1, -1, 1] },
  "right-anterior-superior": { flip: [1, 1, 1] },
  "ras": { flip: [1, 1, 1] },
  // Slicer reads LAS too (vtkMRMLNRRDStorageNode); only X is mirrored from RAS.
  "left-anterior-superior": { flip: [-1, 1, 1] },
  "las": { flip: [-1, 1, 1] },
  // Anatomical but time-varying variants NRRD allows; the spatial part is the same.
  "left-posterior-superior-time": { flip: [-1, -1, 1] },
  "right-anterior-superior-time": { flip: [1, 1, 1] },
  // Non-anatomical. Do not touch the signs.
  "3d-right-handed": { flip: null },
  "3d-left-handed": { flip: null },
  "3d-right-handed-time": { flip: null },
  "3d-left-handed-time": { flip: null },
  "scanner-xyz": { flip: null },
  "scanner-xyz-time": { flip: null },
};

/** How a NRRD `space` turns into patient RAS: the per-axis signs, or null for a space with no patient meaning (and
 *  undefined for one NRRD does not define). The one place this is decided; the diffusion reader asks it for its
 *  gradients (critic 2026-09-28, finding 15). */
export function spaceFlip(space: string): [number, number, number] | null | undefined {
  return SPACES[space.trim().toLowerCase()]?.flip;
}

/**
 * ijk→world from `space directions`, `space origin`, `space` and `space units`.
 *
 * An unrecognized `space` throws. Defaulting it — as this reader used to, to LPS — is how a volume
 * gets mirrored with no error anywhere, and NRRD went to the trouble of stating the answer.
 */
export function geometry(f: Record<string, string>): Pick<Nrrd, "ijkToRAS" | "space" | "spaceUnits" | "anatomical"> {
  const dir = parseVectors(f["space directions"]).filter((v) => v.length === 3);
  const org = parseVectors(f["space origin"] ?? "(0,0,0)")[0] ?? [0, 0, 0];

  // A file with no `space` at all is legal NRRD and says nothing about orientation. Treat it as a
  // bare right-handed world rather than inventing anatomy for it.
  const space = (f["space"] ?? "3d-right-handed").toLowerCase().trim();
  const known = SPACES[space];
  if (!known) {
    throw new Error(
      `NRRD: unrecognized space "${f["space"]}" — refusing to guess an orientation ` +
      `(known: ${Object.keys(SPACES).join(", ")})`,
    );
  }
  const flip = known.flip ?? [1, 1, 1];

  // `space units` is per axis and is routinely something other than millimeters. Carried, not applied:
  // rescaling here would hide the unit from the caller, which is the mistake this is fixing.
  const spaceUnits = (f["space units"] ?? "").match(/"([^"]*)"/g)?.map((q) => q.slice(1, -1)) ?? [];

  const c = dir.length === 3 ? dir : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ijkToRAS = [
    flip[0] * c[0][0], flip[0] * c[1][0], flip[0] * c[2][0], flip[0] * org[0],
    flip[1] * c[0][1], flip[1] * c[1][1], flip[1] * c[2][1], flip[1] * org[1],
    flip[2] * c[0][2], flip[2] * c[1][2], flip[2] * c[2][2], flip[2] * org[2],
    0, 0, 0, 1,
  ];
  return { ijkToRAS, space, spaceUnits, anatomical: known.flip !== null };
}

/**
 * Parse a segmentation NRRD (`.seg.nrrd`).
 *
 * Three things this does that {@linkcode parseNrrd} deliberately does not:
 *
 * 1. **Labels stay integers.** A labelmap widened to Float32 costs four bytes a voxel to store label
 *    values that fit in one, and label values are identities rather than measurements — interpolating
 *    or averaging them is meaningless. A 452x332x993 labelmap is 149 MB as `Uint8Array` and 596 MB
 *    as `Float32Array`.
 * 2. **The 4-D multi-layer form is read.** Slicer writes `dimension: 4` with a `list` axis when
 *    segments OVERLAP, because a single labelmap cannot hold two labels in one voxel. Each layer is
 *    an independent labelmap and `Segment<N>_Layer` says which one a segment lives in. Refusing 4-D —
 *    as the scalar path does — refuses exactly the segmentations that needed the format.
 * 3. **Slicer's `Segment<N>_*` keys are read back**, so names, label values, layers and colors
 *    survive the trip. `logic/writers/nrrd.ts` already writes them; this is the other half.
 */
export async function parseNrrdSeg(buf: Uint8Array): Promise<NrrdSeg> {
  const { f, body } = splitHeader(buf);
  const type = (f["type"] ?? "").toLowerCase();
  const bpp = TYPE_BYTES[type];
  if (!bpp) throw new Error(`NRRD: unsupported type "${type}"`);
  const Make = INT_ARRAYS[type];
  if (!Make) {
    throw new Error(
      `NRRD: a segmentation must have an integer type, got "${type}" — label values are identities, ` +
      `not measurements`,
    );
  }

  const sizes = (f["sizes"] ?? "").split(/\s+/).filter(Boolean).map(Number);
  const kinds = (f["kinds"] ?? "").split(/\s+/).filter(Boolean).map((k) => k.toLowerCase());
  // Which axis is the layer axis? `kinds` names it when present; otherwise a 4-D file puts it first,
  // which is what Slicer writes. Guessing is confined to this one line and stated.
  let layerAxis = kinds.findIndex((k) => k === "list" || k === "vector" || k === "complex");
  if (sizes.length === 4 && layerAxis < 0) layerAxis = 0;
  if (sizes.length !== 3 && sizes.length !== 4) {
    throw new Error(`NRRD: a segmentation must be 3-D or 4-D, got sizes [${sizes}]`);
  }
  const nLayers = layerAxis >= 0 ? sizes[layerAxis] : 1;
  const spatial = sizes.filter((_, i) => i !== layerAxis);
  const [nx, ny, nz] = spatial as [number, number, number];
  const nvox = nx * ny * nz;

  const raw = await decode(f, body, nvox * nLayers * bpp);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const read = sampleReader(type, raw, dv, (f["endian"] ?? "little").toLowerCase() !== "big");

  // The layer axis is the slowest, so layer L occupies [L*nvox, (L+1)*nvox).
  const layers: NrrdSeg["layers"] = [];
  for (let L = 0; L < nLayers; L++) {
    const out = new Make(nvox) as Uint8Array;
    for (let i = 0; i < nvox; i++) out[i] = read((L * nvox + i) * bpp);
    layers.push(out);
  }

  return { layers, dims: [nx, ny, nz], segments: segmentsFrom(f), ...geometry(f) };
}

/** Read Slicer's `Segment<N>_*` keys. The header parser lower-cases keys, hence the lower-case here. */
function segmentsFrom(f: Record<string, string>): NrrdSegment[] {
  const out: NrrdSegment[] = [];
  for (let n = 0; ; n++) {
    const p = `segment${n}_`;
    const label = f[`${p}labelvalue`];
    const name = f[`${p}name`];
    if (label === undefined && name === undefined) break;
    const rgb = (f[`${p}color`] ?? "0.5 0.5 0.5").split(/\s+/).map(Number);
    out.push({
      labelValue: Number(label ?? n + 1),
      layer: Number(f[`${p}layer`] ?? 0),
      name: name ?? `Segment ${n + 1}`,
      id: f[`${p}id`] ?? name ?? `Segment_${n + 1}`,
      color: [rgb[0] ?? 0.5, rgb[1] ?? 0.5, rgb[2] ?? 0.5],
    });
  }
  return out;
}

/** Integer typed-array constructors, by NRRD type name. Float types are absent on purpose. */
const INT_ARRAYS: Record<string, Uint8ArrayConstructor | Uint16ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor | Int8ArrayConstructor | Uint32ArrayConstructor> = {
  "uchar": Uint8Array, "unsigned char": Uint8Array, "uint8": Uint8Array, "uint8_t": Uint8Array,
  "signed char": Int8Array, "int8": Int8Array, "int8_t": Int8Array,
  "ushort": Uint16Array, "unsigned short": Uint16Array, "unsigned short int": Uint16Array,
  "uint16": Uint16Array, "uint16_t": Uint16Array,
  "short": Int16Array, "short int": Int16Array, "signed short": Int16Array,
  "signed short int": Int16Array, "int16": Int16Array, "int16_t": Int16Array,
  "uint": Uint32Array, "unsigned int": Uint32Array, "uint32": Uint32Array, "uint32_t": Uint32Array,
  "int": Int32Array, "signed int": Int32Array, "int32": Int32Array, "int32_t": Int32Array,
};

/** Fetch + parse an NRRD, reporting downloaded bytes. */
export async function loadNrrd(url: string, onBytes?: (n: number) => void): Promise<Nrrd> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`NRRD fetch ${res.status}`);
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes?.(value.length);
  }
  let total = 0; for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return parseNrrd(buf);
}

/** Split an NRRD into its parsed header fields (keys lower-cased) and the undecoded data block. */
/** The header's fields (keys lower-cased) and the bytes after it. Exported for readers outside core, through the SDK (sdk/albula.ts; the diffusion extension's NRRD DWI reader). */
export function splitHeader(buf: Uint8Array): { f: Record<string, string>; body: Uint8Array } {
  let end = -1;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a && buf[i + 1] === 0x0a) { end = i + 2; break; }
  }
  if (end < 0) throw new Error("NRRD: no header terminator");
  const lines = new TextDecoder("latin1").decode(buf.subarray(0, end)).split("\n");
  if (!lines[0].startsWith("NRRD")) throw new Error("NRRD: bad magic");
  const f: Record<string, string> = {};
  for (const ln of lines.slice(1)) {
    if (!ln || ln.startsWith("#")) continue;
    const m = ln.match(/^([^:]+):[=]?\s*(.*)$/);
    if (m) f[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { f, body: buf.subarray(end) };
}

/** Decode the data block per `encoding`, and refuse a short one rather than reading past the end. */
export async function decode(f: Record<string, string>, body: Uint8Array, need: number): Promise<Uint8Array> {
  const encoding = (f["encoding"] ?? "raw").toLowerCase();
  let raw = body;
  if (encoding === "gzip" || encoding === "gz") {
    raw = new Uint8Array(await new Response(new Response(raw).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } else if (encoding !== "raw") {
    throw new Error(`NRRD: unsupported encoding "${encoding}" (raw/gzip only)`);
  }
  if (raw.length < need) throw new Error(`NRRD: short data (${raw.length} < ${need})`);
  return raw;
}

/** One sample reader for both entry points, so the type dispatch cannot diverge between them. */
export function sampleReader(type: string, raw: Uint8Array, dv: DataView, little: boolean): (byteOffset: number) => number {
  return type.includes("uchar") || type.includes("uint8") || type === "unsigned char" ? (i) => raw[i]
    : type.includes("char") || type === "int8" ? (i) => (raw[i] << 24) >> 24
    : type.includes("ushort") || type.includes("uint16") || type === "unsigned short" || type === "unsigned short int" ? (i) => dv.getUint16(i, little)
    : type.includes("short") ? (i) => dv.getInt16(i, little)
    : type.includes("uint") ? (i) => dv.getUint32(i, little)
    : type === "float" ? (i) => dv.getFloat32(i, little)
    : type === "double" ? (i) => dv.getFloat64(i, little)
    : (i) => dv.getInt32(i, little);
}

export function parseVectors(s?: string): number[][] {
  if (!s) return [];
  const out: number[][] = [];
  const re = /\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1].split(",").map(Number));
  return out;
}

export const _vec3 = null as unknown as Vec3;   // keep the Vec3 import meaningful for tree-shakers

/**
 * Narrow a segmentation layer to the byte labelmap the scene stores, by RENUMBERING rather than by
 * truncating.
 *
 * A LABEL VALUE IS AN IDENTITY, NOT AN INDEX, and the two had been the same thing here. The scene's
 * labelmap is `r8uint`, so the panel required every value to be under 256 and refused otherwise --
 * correct, because truncating 300 to 44 merges two organs with nothing on screen to show it, but it
 * refuses far more than it has to. FastSurfer emits FreeSurfer's numbering, where the cortical
 * parcellations live at 1000-1035 and 2000-2035; Ron got "this result uses label values up to 2035;
 * the scene's labelmap holds 255" for a result with well under a hundred structures in it. The
 * values are sparse. The COUNT fits in a byte with room to spare.
 *
 * So the values present are collected and renumbered densely from 1, and `remap` is handed back so
 * the segment table can be rewritten to match. The original numbering is not lost -- it is an
 * identity worth keeping, the way a SNOMED code is -- it just stops being what addresses a voxel.
 *
 * Only the count can now be too large, and 255 distinct structures in one layer is a real ceiling
 * rather than an accident of numbering.
 */
export type PackedLabels =
  | { ok: true; labels: Uint8Array; remap: Map<number, number> }
  | { ok: false; reason: "too-many"; distinct: number }
  | { ok: false; reason: "negative"; min: number };

export function packLabelsToByte(
  layer: Uint8Array | Uint16Array | Int16Array | Int32Array,
): PackedLabels {
  const n = layer.length;
  let max = 0, min = 0;
  for (let i = 0; i < n; i++) { const v = layer[i]; if (v > max) max = v; else if (v < min) min = v; }
  // A negative label is not a label. Mapping it to background would delete voxels silently, which is
  // the failure this whole function exists to avoid, so it is reported instead.
  if (min < 0) return { ok: false, reason: "negative", min };

  // Which values occur. A flat presence array is one store per voxel; `new Set(layer)` hashes all
  // 418 million of them to learn ninety-odd answers. The Set is kept only for the case where the
  // flat array would be the bigger evil -- a stray 32-bit value would otherwise allocate gigabytes.
  const FLAT_LIMIT = 1 << 20;
  const present: number[] = [];
  if (max < FLAT_LIMIT) {
    const seen = new Uint8Array(max + 1);
    for (let i = 0; i < n; i++) seen[layer[i]] = 1;
    for (let v = 1; v <= max; v++) if (seen[v]) present.push(v);
  } else {
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) { const v = layer[i]; if (v !== 0) seen.add(v); }
    present.push(...[...seen].sort((a, b) => a - b));
  }

  // 0 is background and is not renumbered, so all 255 non-zero codes are available.
  if (present.length > 255) return { ok: false, reason: "too-many", distinct: present.length };

  const remap = new Map<number, number>();
  for (let i = 0; i < present.length; i++) remap.set(present[i], i + 1);

  // Already a byte array whose values are their own dense numbering: hand back the same buffer
  // rather than copying 418 MB to change nothing.
  const identity = layer instanceof Uint8Array && present.every((v, i) => v === i + 1);
  if (identity) return { ok: true, labels: layer, remap };

  const labels = new Uint8Array(n);
  if (max < FLAT_LIMIT) {
    const lut = new Uint8Array(max + 1);
    for (const [from, to] of remap) lut[from] = to;
    for (let i = 0; i < n; i++) labels[i] = lut[layer[i]];
  } else {
    for (let i = 0; i < n; i++) labels[i] = remap.get(layer[i]) ?? 0;
  }
  return { ok: true, labels, remap };
}
