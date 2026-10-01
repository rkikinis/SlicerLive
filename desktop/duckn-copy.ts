// THE DUCKN WORKING COPY OF A GRAYSCALE SERIES, written by the server beside the database.
//
// Ron, 2026-09-23: store volumes as zarr, "as long as it is able to output dicom when needed. Also,
// only reading one header instead of 700+"; the conversion belongs at import, the existing database
// as a background sweep; "so lets go with dukn"; and the copies are "permanent". The brief is the
// workspace's Contents/docs/DUCKN-WORKING-COPY.md.
//
// The store is Michael Halle's duckn convention (https://github.com/mhalle/duckn): a Zarr v3 group,
// one array per volume the page loads from the series (the phases of a gated CT are several), each
// carrying `attributes.duckn` as his spec defines it. Pieces are zstd, level 3, in the page's own
// chunk shape (64 x 128 x 128), so the page takes them as they are.
//
// THE SAME VOLUME AS THE PAGE'S LOAD, BY CONSTRUCTION: the volumes come from `volumesOfSeries`, the
// function dicom-db.ts `loadSequence` calls, and the pieces and their sha256 names from
// `volumeToZarr`, the function the page's ingest calls. Nothing here re-derives geometry or rescales.
//
// VALUES ARE STORED AS THE PAGE HOLDS THEM (the rescale applied: Hounsfield units for CT). duckn-spec
// §4.3 calls this "materialize" and allows it; it drops `value_transforms`. Chosen over "preserve"
// because the copy is then identical to the page's volume including how the reader rounds, its
// pieces hash to the page's names, and a series whose rescale differs from slice to slice -- which
// one transform per array cannot state -- is stored like any other. The DICOM files are the record;
// nothing needs the scanner's raw numbers back from the copy.
//
// WHAT IS ALBULA'S OWN goes under `extensions.albula` (duckn-spec §3.1, "unregistered extensions"):
// the per-slice instance identities Mike's converter leaves out (asked, mhalle/duckn#1), the fields
// today's load puts on the image, window/level and range, the pieces' sha256 names, and on the group
// the source stamp and this converter's code, which decide whether a copy is still valid.
//
//   deno run -A desktop/duckn-copy.ts <database folder> <SeriesInstanceUID> [output folder]
import * as zlib from "node:zlib";
import dcmjs from "../logic/dcmjs.ts";
import { lastHeaderMs, lastSkipped, lastSkipReasons, parseInstances, setDcmjs, volumesOfSeries } from "../logic/readers/dicom-series.ts";
import { DICOM_HEADER_LAYOUT, mergeSlice, sameHeader, splitShared } from "../logic/readers/dicom-tags.ts";
import { percentileWindowLevel, sha256, volumeToZarr } from "../logic/ingest.ts";
import { seriesFilePaths, seriesFileStamp } from "./series-files.ts";
import { COPY_CODE, COPY_FOLDER } from "./duckn-copy-code.ts";
import { loadExtensionHooks } from "./extension-hooks.ts";
import { interpreterCodes } from "../logic/readers/volume-interpreters.ts";

setDcmjs(dcmjs);
export { COPY_CODE, COPY_FOLDER };

const ZSTD_LEVEL = 3;
// 0.2 (2026-09-25): the whole DICOM header -- the record in the DICOM JSON Model beside the array (`header.file`), and
// Michael Halle's keyword view shared and per slice (logic/readers/dicom-tags.ts).
// 0.3 (2026-09-25): `notHeld` -- every image of the series the copy does not hold, by SOPInstanceUID and frame number,
// with the reason (critic, 2026-09-25, finding 7), so a writer reading the copy knows whether the series is complete.
const ALBULA_EXT_VERSION = "0.3";

const DATA_TYPE: Record<string, string> = { "<i2": "int16", "<u2": "uint16", "|u1": "uint8", "|i1": "int8", "<f4": "float32" };

export interface CopyReport {
  seriesInstanceUID: string;
  path: string;
  frames: number;
  instances: number;
  dicomBytes: number;
  copyBytes: number;
  pieces: number;
  /** `header`: converting, splitting, writing and checking the DICOM headers; `parse` is the rest of the reading. */
  ms: { read: number; parse: number; header: number; reconstruct: number; cut: number; compress: number; write: number; check: number; total: number };
}

/** LPS from the page's RAS: DICOM's and duckn's usual space, flipping x and y. */
const ras2lps = (v: number[]) => [-v[0], -v[1], v[2]];

/**
 * duckn's description of one volume, from the page's ijkToRAS (row-major 4x4, columns i, j, k,
 * origin) and from what the reader DECLARED about its geometry -- never from literals.
 *
 * Ron: "dimensions are extremely important. People use slicer from microscopy to astrophysics"
 * (data-model-design-2026-09-03.md, Addendum 5): each axis states its own kind and unit, and a
 * patient space is a declared value, not a default. So:
 *  - the unit is the one the source declared (`geometry.spaceUnit`: DICOM's is mm), and is left out
 *    when none was declared -- duckn's "absent means unknown" -- rather than assumed to be mm;
 *  - the centering likewise (`geometry.centering`: DICOM's is cell);
 *  - the patient space is written only for a volume declared anatomical (then ijkToRAS IS RAS, and
 *    LPS is its DICOM reading); anything else is a bare 3-D world frame, `space_dimension: 3`,
 *    written as it is (duckn-spec §5: `space` and `space_dimension` are mutually exclusive);
 *  - a single slice has no spacing between slices to state: its slice axis gets no
 *    `space_direction`, and its `thickness` only when the source gave one (SliceThickness). A 1 mm
 *    the reader ASSUMED is never written as if it were measured (critic, 2026-09-23, finding 8);
 *  - a stack whose slices are not evenly spaced says where each one is (`samples[i].position`: the
 *    slice's position projected onto the slice normal, as Michael Halle's converter writes it), so
 *    no reader is told a gap is not there (finding 5);
 *  - each slice's instance identity goes in `samples[i].metadata.dicom` (SOPInstanceUID,
 *    InstanceNumber). His DICOM spec (§6.3) names `samples[i].extensions.dicom`, but his reader's
 *    model accepts only `metadata` there and would refuse the file; written where his reader reads;
 *  - a volume with no declared geometry at all is refused, not described.
 */
export function ducknAttrs(vol: { dims: number[]; ijkToRAS: number[]; meta?: Record<string, unknown>; geometry?: { origin?: string; spaceUnit?: string; anatomical: boolean; centering?: string; slicePositions?: number[] } }, perSlice?: Record<string, unknown>[]): Record<string, unknown> {
  if (vol.dims.length !== 3) throw new Error(`a ${vol.dims.length}-dimensional volume: this converter describes three spatial axes, and will not guess the others`);
  if (!vol.geometry) throw new Error("the reader declared nothing about this volume's geometry; a copy would have to invent it");
  const g = vol.geometry;
  const m = vol.ijkToRAS;
  const nz = vol.dims[2];
  const col = (c: number) => [m[c], m[4 + c], m[8 + c]];
  const place = g.anatomical ? ras2lps : (v: number[]) => v;
  const unit = g.spaceUnit ? { unit: g.spaceUnit } : {};
  const centering = g.centering ? { centering: g.centering } : {};
  // Zarr's shape is [nz, ny, nx]: axis 0 is k, axis 1 is j, axis 2 is i.
  const axis = (c: number) => ({ kind: "space", ...centering, space_direction: place(col(c)), ...unit });

  let sliceAxis: Record<string, unknown>;
  if (nz === 1) {
    const len = Math.hypot(...col(2));
    sliceAxis = { kind: "space", ...centering, ...(g.origin === "acquired" && len > 0 ? { thickness: len, ...unit } : {}) };
  } else {
    sliceAxis = axis(2);
    const meta = vol.meta ?? {};
    const sops = meta.sopInstanceUIDs as string[] | undefined, nums = meta.instanceNumbers as number[] | undefined;
    const pos = g.slicePositions;
    // Uneven when any slice is more than 0.001 mm off the even grid from the first to the last --
    // the tolerance duckn's own converter uses. (Albula warns only past a quarter of a slice.)
    const uneven = !!pos && pos.length === nz && pos.some((p, k) => Math.abs(p - (pos[0] + k * (pos[nz - 1] - pos[0]) / (nz - 1))) > 1e-3);
    if (uneven || sops || nums || perSlice?.length) {
      sliceAxis.samples = Array.from({ length: nz }, (_, k) => {
        // Each slice's own header attributes (dicom-tags.ts splitShared), where Michael Halle's layout puts them.
        const dicom: Record<string, unknown> = { ...(perSlice?.[k] ?? {}) };
        if (sops?.[k]) dicom.SOPInstanceUID = sops[k];
        if (nums?.[k] != null) dicom.InstanceNumber = nums[k];
        return { ...(uneven ? { position: pos![k] } : {}), ...(Object.keys(dicom).length ? { metadata: { dicom } } : {}) };
      });
    }
  }
  return {
    version: "1.0",
    ...(g.anatomical ? { space: "left-posterior-superior" } : { space_dimension: 3 }),
    space_origin: place(col(3)),
    axes: [sliceAxis, axis(1), axis(0)],
  };
}

const zstd = (b: Uint8Array) =>
  new Uint8Array((zlib as unknown as { zstdCompressSync(b: Uint8Array, o: unknown): Uint8Array }).zstdCompressSync(b, { params: { [(zlib.constants as Record<string, number>).ZSTD_c_compressionLevel]: ZSTD_LEVEL } }));
const unzstd = (b: Uint8Array) => new Uint8Array((zlib as unknown as { zstdDecompressSync(b: Uint8Array): Uint8Array }).zstdDecompressSync(b));

async function readAll(paths: string[], concurrency = 16): Promise<ArrayBuffer[]> {
  const out: ArrayBuffer[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      const b = await Deno.readFile(paths[i]);
      out[i] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    }
  }));
  return out;
}

/**
 * Write (or rewrite) the working copy of one series, check every piece against what the page would
 * hold, and only then put it in place. A copy that fails the check is not kept.
 */
export async function writeDucknCopy(dbDir: string, seriesUID: string, opts: { outDir?: string } = {}): Promise<CopyReport> {
  // What extensions add to reading DICOM (the diffusion b-values, ...) belongs in the copy as in the page's load.
  await loadExtensionHooks();
  const t0 = performance.now();
  const ms = { read: 0, parse: 0, header: 0, reconstruct: 0, cut: 0, compress: 0, write: 0, check: 0, total: 0 };
  const root = dbDir.replace(/\/+$/, "");
  const outDir = opts.outDir ?? `${root}/${COPY_FOLDER}`;
  const stamp = await seriesFileStamp(root, seriesUID);
  if (!stamp || !stamp.files) throw new Error(`${seriesUID}: not in the database's index, or none of its files are on disk`);
  const paths = await seriesFilePaths(root, seriesUID);

  let t = performance.now();
  let buffers: ArrayBuffer[] = await readAll(paths);
  const dicomBytes = buffers.reduce((n, b) => n + b.byteLength, 0);
  ms.read = performance.now() - t;

  t = performance.now();
  // Each file named relative to the database, so a file the reader could not use is named in the copy (night finding 6).
  const instances = await parseInstances(buffers, { headers: true, names: paths.map((p) => p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p) });
  buffers = [];                                                   // the parsed pixels are all that is needed now
  ms.header = lastHeaderMs;                                       // named apart from the rest of the parse (finding 13)
  ms.parse = performance.now() - t - lastHeaderMs;
  const notRead = [...lastSkipped];                               // which files and frames the reader could not use
  // WHY, not just THAT: the reader records the reason it skipped each file (dicom-db.ts does the same).
  if (!instances.length) throw new Error(`${seriesUID}: none of the ${paths.length} files could be read as images -- ${[...lastSkipReasons.entries()].map(([why, k]) => `${k} x ${why}`).join("; ")}`);

  // A RESCALE THAT DOES NOT GIVE WHOLE NUMBERS was refused here until 2026-09-25, because the reader truncated it into
  // 16-bit integers (critic, 2026-09-23, finding 9). The reader keeps such a volume in 32-bit floats now, exactly, so
  // the copy is the same exact values (float32).
  // Lossy anywhere in the source: said, as duckn's DICOM spec requires of a writer (§3.1).
  const lossy = instances.some((i) => i.lossy);

  const seq = volumesOfSeries(instances);
  ms.reconstruct = seq.reconMs;

  const final = `${outDir}/${seriesUID}.zarr`;
  const tmp = `${outDir}/${seriesUID}.zarr.part-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.mkdir(tmp, { recursive: true });
  let copyBytes = 0, pieces = 0;
  try {
    for (const [f, vol] of seq.frames.entries()) {
      t = performance.now();
      const { desc, blobs } = await volumeToZarr(vol.data, vol.dims as [number, number, number], vol.dtype, { compressor: "raw" });
      const wl = percentileWindowLevel(vol.data);
      ms.cut += performance.now() - t;
      const dataType = DATA_TYPE[vol.dtype];
      if (!dataType) throw new Error(`${seriesUID}: no Zarr data type for ${vol.dtype}`);
      const arr = `${tmp}/${f}`;
      for (const [key, hash] of Object.entries(desc.chunkHashes!)) {
        const raw = blobs.get(hash)!;
        t = performance.now();
        const enc = zstd(raw);
        ms.compress += performance.now() - t;
        t = performance.now();
        const [kk, jj, ii] = key.split(".");
        const file = `${arr}/c/${kk}/${jj}/${ii}`;
        await Deno.mkdir(`${arr}/c/${kk}/${jj}`, { recursive: true });
        await Deno.writeFile(file, enc);
        ms.write += performance.now() - t;
        // THE CHECK, as each piece is written: read back from disk and unpacked, it is the page's
        // piece byte for byte, under the name the page gives it. Checked here rather than at the end,
        // so the converter no longer holds every piece twice (3.46 GB on NEPHROGENIC before).
        t = performance.now();
        const back = unzstd(await Deno.readFile(file));
        if (back.byteLength !== raw.byteLength) throw new Error(`${file}: ${back.byteLength} bytes back, ${raw.byteLength} written`);
        for (let i = 0; i < back.length; i++) if (back[i] !== raw[i]) throw new Error(`${file}: differs at byte ${i}`);
        if (await sha256(back) !== hash) throw new Error(`${file}: does not hash to ${hash}`);
        ms.check += performance.now() - t;
        copyBytes += enc.byteLength;
        pieces++;
      }
      const meta = (vol.meta ?? {}) as Record<string, string | undefined>;
      // THE WHOLE HEADER (step 5 of the brief; logic/readers/dicom-tags.ts). The RECORD in the DICOM JSON Model -- every
      // attribute, private and binary ones included -- shared once and per slice, zstd-compressed beside the array
      // (`dicom-header.json.zst`: a vendor's binary header can be kilobytes a slice, and the page's load never reads
      // it). Michael Halle's keyword VIEW of the same header where his layout puts it: shared as the array's DICOM
      // tags, the rest per slice in the samples.
      const th = performance.now();
      const { shared, perSlice } = splitShared((vol.sliceHeaders ?? []).map((h) => h.tags));
      const record = splitShared((vol.sliceHeaders ?? []).map((h) => h.json));
      const headerFile = vol.sliceHeaders?.length ? "dicom-header.json.zst" : undefined;
      if (headerFile) {
        await Deno.mkdir(arr, { recursive: true });
        await Deno.writeFile(`${arr}/${headerFile}`, zstd(new TextEncoder().encode(JSON.stringify({ layout: DICOM_HEADER_LAYOUT, standard: "DICOM PS3.18 Annex F (DICOM JSON Model)", shared: record.shared, perSlice: record.perSlice }))));
      }
      const dicomTags: Record<string, unknown> = { ...shared };
      for (const [k, v] of [["SeriesInstanceUID", meta.seriesInstanceUID], ["StudyInstanceUID", meta.studyInstanceUID], ["Modality", meta.modality]] as const) if (v && !(k in dicomTags)) dicomTags[k] = v;
      const arrayJson = {
        zarr_format: 3,
        node_type: "array",
        shape: desc.shape,
        data_type: dataType,
        chunk_grid: { name: "regular", configuration: { chunk_shape: desc.chunks } },
        chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
        fill_value: 0,
        codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "zstd", configuration: { level: ZSTD_LEVEL, checksum: false } }],
        dimension_names: ["k", "j", "i"],
        attributes: {
          duckn: {
            ...ducknAttrs(vol as unknown as Parameters<typeof ducknAttrs>[0], perSlice.length ? perSlice : undefined),   // geometry, and each slice's own header
            extensions: {
              dicom: { version: "1.0", ...(lossy ? { lossy_compressed: true } : {}), tags: dicomTags },
              albula: {
                version: ALBULA_EXT_VERSION,
                ...(headerFile ? { header: { file: headerFile, layout: DICOM_HEADER_LAYOUT } } : {}),
                // Everything the page's Volume carries except its voxels, as the reader made it.
                volume: { name: vol.name, dims: vol.dims, ijkToRAS: vol.ijkToRAS, dtype: vol.dtype, meta: vol.meta, geometry: vol.geometry },
                frame: { index: f, label: seq.labels[f], timing: seq.timing[f] },
                display: { window: wl.window, level: wl.level, range: wl.range },
                // The pieces as the page names them (sha256 of the uncompressed piece), so a volume
                // read from the copy has the same descriptor, digest and cache keys as one read from DICOM.
                zarr: { shape: desc.shape, chunks: desc.chunks, chunkGrid: desc.chunkGrid, dtype: desc.dtype, bytes: desc.bytes, chunkHashes: desc.chunkHashes },
              },
            },
          },
        },
      };
      await Deno.writeTextFile(`${arr}/zarr.json`, JSON.stringify(arrayJson));
      // THE HEADER CHECK, as for the pieces: read back from disk, every slice's header rebuilt from the copy (shared +
      // its own) is the one the files gave, attribute for attribute, for everything the layout keeps.
      if (vol.sliceHeaders?.length && headerFile) {
        const back = JSON.parse(await Deno.readTextFile(`${arr}/zarr.json`));
        const d = back.attributes.duckn;
        const own = (k: number) => d.axes[0].samples?.[k]?.metadata?.dicom as Record<string, unknown> | undefined;
        const rec = JSON.parse(new TextDecoder().decode(unzstd(await Deno.readFile(`${arr}/${headerFile}`))));
        for (let k = 0; k < vol.sliceHeaders.length; k++) {
          // The record: every attribute of the file, private and binary included, byte for byte (base64).
          if (!sameHeader(vol.sliceHeaders[k].json, mergeSlice(rec.shared, rec.perSlice[k]))) throw new Error(`${seriesUID}: slice ${k}'s DICOM header does not come back from the copy as it was`);
          // Mike's view: the same, in his form.
          if (!sameHeader(vol.sliceHeaders[k].tags, mergeSlice(d.extensions.dicom.tags, own(k)))) throw new Error(`${seriesUID}: slice ${k}'s keyword view does not come back from the copy as it was written`);
        }
      }
      ms.header += performance.now() - th;
    }

    // The group, written LAST: a copy without it is not a copy (and the rename below makes it one).
    const groupJson = {
      zarr_format: 3,
      node_type: "group",
      attributes: {
        albula: {
          version: ALBULA_EXT_VERSION,
          code: COPY_CODE,
          interpreters: interpreterCodes(),
          seriesInstanceUID: seriesUID,
          source: stamp,
          frames: seq.frames.map((_, i) => String(i)),
          labels: seq.labels,
          leftOut: seq.leftOut,
          notHeld: [...notRead, ...seq.leftOutImages],
          instances: instances.length,
          writtenAt: new Date().toISOString(),
        },
      },
    };
    await Deno.writeTextFile(`${tmp}/zarr.json`, JSON.stringify(groupJson));

    // Into place. An older copy is moved aside first and removed after, so there is never a moment
    // with a half copy under the final name.
    const old = `${final}.old-${crypto.randomUUID().slice(0, 8)}`;
    const hadOld = await Deno.stat(final).then(() => true, () => false);
    if (hadOld) await Deno.rename(final, old);
    await Deno.rename(tmp, final);
    if (hadOld) await Deno.remove(old, { recursive: true });
  } catch (e) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw e;
  }
  ms.total = performance.now() - t0;
  return { seriesInstanceUID: seriesUID, path: final, frames: seq.frames.length, instances: instances.length, dicomBytes, copyBytes, pieces, ms };
}

if (import.meta.main) {
  const [db, uid, out] = Deno.args;
  if (!db || !uid) {
    console.error("usage: deno run -A desktop/duckn-copy.ts <database folder> <SeriesInstanceUID> [output folder]");
    Deno.exit(2);
  }
  const r = await writeDucknCopy(db, uid, { outDir: out });
  const s = (x: number) => (x / 1000).toFixed(2) + " s";
  console.log(`${r.path}\n  ${r.instances} instances, ${r.frames} volume${r.frames === 1 ? "" : "s"}, ${r.pieces} pieces`);
  console.log(`  DICOM ${(r.dicomBytes / 1e6).toFixed(1)} MB -> copy ${(r.copyBytes / 1e6).toFixed(1)} MB (${(r.copyBytes / r.dicomBytes).toFixed(3)})`);
  console.log(`  read ${s(r.ms.read)}, parse ${s(r.ms.parse)}, header ${s(r.ms.header)}, reconstruct ${s(r.ms.reconstruct)}, cut ${s(r.ms.cut)}, compress ${s(r.ms.compress)}, write ${s(r.ms.write)}, check ${s(r.ms.check)}; total ${s(r.ms.total)}`);
}
