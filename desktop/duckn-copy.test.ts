// The duckn working copy: the same pieces, under the same names, as the page's own load makes, and
// geometry stated from what the reader declared -- never assumed.
//
// Every test builds its own throwaway database from a synthetic series; none can see a real one.
// The check against Michael Halle's own reader, on real data, is Contents/tools/check-duckn-copy.py
// in the workspace (it needs his Python package).
//
//   deno test -A --no-check desktop/duckn-copy.test.ts
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import * as zlib from "node:zlib";
import { parseInstances, volumesOfSeries } from "../logic/readers/dicom-series.ts";
import { volumeToZarr } from "../logic/ingest.ts";
import { dbWithSeries } from "./duckn-copy.fixture.ts";
import { COPY_CODE, ducknAttrs, writeDucknCopy } from "./duckn-copy.ts";

const unzstd = (b: Uint8Array) => new Uint8Array((zlib as unknown as { zstdDecompressSync(b: Uint8Array): Uint8Array }).zstdDecompressSync(b));

const leftovers = (dir: string) => [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => /\.part-|\.old-/.test(n));

Deno.test("the copy holds the page's own pieces, under the page's own names", async () => {
  // 70 slices: two pieces deep, so the grid and the zero-padded edge are both exercised.
  const { dir, series } = await dbWithSeries(40, 36, 70);
  const out = `${dir}/SlicerAlbula-Zarr`;
  const r = await writeDucknCopy(dir, series.seriesInstanceUID, { outDir: out });
  assertEquals(r.frames, 1);
  assertEquals(r.instances, 70);

  // What the page would make from the same files, through the same functions.
  const page = volumesOfSeries(await parseInstances(series.instances));
  const vol = page.frames[0];
  const { desc, blobs } = await volumeToZarr(vol.data, vol.dims as [number, number, number], vol.dtype, { compressor: "raw" });

  const group = JSON.parse(await Deno.readTextFile(`${r.path}/zarr.json`));
  assertEquals(group.node_type, "group");
  assertEquals(group.attributes.albula.code, COPY_CODE);
  assertEquals(group.attributes.albula.frames, ["0"]);
  assertEquals(group.attributes.albula.source.files, 70);

  const arr = JSON.parse(await Deno.readTextFile(`${r.path}/0/zarr.json`));
  assertEquals(arr.shape, desc.shape);
  assertEquals(arr.chunk_grid.configuration.chunk_shape, desc.chunks);
  assertEquals(arr.data_type, "int16");
  const ext = arr.attributes.duckn.extensions.albula;
  assertEquals(ext.zarr.chunkHashes, desc.chunkHashes, "the pieces are named as the page names them");
  assertEquals(ext.volume.meta.sopInstanceUIDs, (vol.meta as { sopInstanceUIDs: string[] }).sopInstanceUIDs, "the instances, in slice order");
  assertEquals(ext.volume.ijkToRAS, vol.ijkToRAS);

  let n = 0;
  for (const [key, hash] of Object.entries(desc.chunkHashes!)) {
    const [k, j, i] = key.split(".");
    const back = unzstd(await Deno.readFile(`${r.path}/0/c/${k}/${j}/${i}`));
    assertEquals(back, blobs.get(hash), `piece ${key}`);
    n++;
  }
  assertEquals(n, r.pieces);
  assertEquals(leftovers(out), []);

  // DICOM's geometry, stated as DICOM states it: LPS, millimeters, from the page's RAS.
  const d = arr.attributes.duckn;
  assertEquals(d.space, "left-posterior-superior");
  const m = vol.ijkToRAS;
  assertEquals(d.space_origin, [-m[3], -m[7], m[11]]);
  for (const a of d.axes) assertEquals(a.unit, "mm");
  assertEquals(d.axes[0].space_direction, [-m[2], -m[6], m[10]], "axis 0 is k");

  // Rewriting replaces the copy whole, and leaves nothing half-written beside it.
  const again = await writeDucknCopy(dir, series.seriesInstanceUID, { outDir: out });
  assertEquals(again.path, r.path);
  assertEquals(leftovers(out), []);
});

Deno.test("a series the index does not have leaves nothing behind", async () => {
  const { dir } = await dbWithSeries(8, 8, 3);
  const out = `${dir}/SlicerAlbula-Zarr`;
  await assertRejects(() => writeDucknCopy(dir, "9.9.9", { outDir: out }), Error, "not in the database's index");
  const there = await Deno.stat(out).then(() => [...Deno.readDirSync(out)].map((e) => e.name), () => []);
  assertEquals(there, []);
});

// Ron: "dimensions are extremely important. People use slicer from microscopy to astrophysics."
Deno.test("geometry is what the reader declared: units kept, never invented; a patient space only when anatomical", () => {
  const ijkToRAS = [0.00025, 0, 0, 1, 0, 0.00025, 0, 2, 0, 0, 0.001, 3, 0, 0, 0, 1];
  // A declared unit is carried as it is, whatever it is.
  const um = ducknAttrs({ dims: [4, 4, 4], ijkToRAS, geometry: { spaceUnit: "um", anatomical: false } }) as { axes: { unit?: string }[] };
  for (const a of um.axes) assertEquals(a.unit, "um");
  // Not anatomical: a bare 3-D world frame, written as it is -- no LPS, no flip.
  const bare = ducknAttrs({ dims: [4, 4, 4], ijkToRAS, geometry: { spaceUnit: "um", anatomical: false } }) as Record<string, unknown>;
  assertEquals(bare.space, undefined);
  assertEquals(bare.space_dimension, 3);
  assertEquals(bare.space_origin, [1, 2, 3]);
  // No unit declared: none written ("absent means unknown"), not millimeters by default.
  const none = ducknAttrs({ dims: [4, 4, 4], ijkToRAS, geometry: { anatomical: true } }) as { space: string; axes: Record<string, unknown>[] };
  for (const a of none.axes) assert(!("unit" in a), "a unit nobody declared");
  assertEquals(none.space, "left-posterior-superior");
  // Nothing declared, or axes it cannot name: refused rather than described.
  assertThrows(() => ducknAttrs({ dims: [4, 4, 4], ijkToRAS }), Error, "declared nothing");
  assertThrows(() => ducknAttrs({ dims: [4, 4, 4, 2], ijkToRAS, geometry: { spaceUnit: "mm", anatomical: true } }), Error, "will not guess");
});

// Critic, 2026-09-23, findings 5, 8 and 9: what the copy tells a reader that is not Albula.
const G = { origin: "derived", spaceUnit: "mm", anatomical: true, centering: "cell" };
const M = [0.5, 0, 0, 10, 0, 0.5, 0, 20, 0, 0, 1, 30, 0, 0, 0, 1];

Deno.test("an uneven stack says where each slice is; an even one names its instances without positions", () => {
  const meta = { sopInstanceUIDs: ["1.1", "1.2", "1.3", "1.4"], instanceNumbers: [1, 2, 3, 4] };
  const even = ducknAttrs({ dims: [4, 4, 4], ijkToRAS: M, meta, geometry: { ...G, slicePositions: [30, 31, 32, 33] } }) as { axes: { samples?: Record<string, unknown>[]; centering?: string }[] };
  assertEquals(even.axes[0].samples?.map((x) => x.position), [undefined, undefined, undefined, undefined]);
  assertEquals(even.axes[0].samples?.[2], { metadata: { dicom: { SOPInstanceUID: "1.3", InstanceNumber: 3 } } });
  assertEquals(even.axes[0].centering, "cell", "the centring the reader declared");
  // A 1 mm gap after the second slice: first-to-last is 1.333 mm a slice, and no slice is on that grid.
  const gap = ducknAttrs({ dims: [4, 4, 4], ijkToRAS: M, meta, geometry: { ...G, slicePositions: [30, 31, 33, 34] } }) as { axes: { samples?: Record<string, unknown>[] }[] };
  assertEquals(gap.axes[0].samples?.map((x) => x.position), [30, 31, 33, 34]);
  // No centering declared: none written.
  const plain = ducknAttrs({ dims: [4, 4, 4], ijkToRAS: M, geometry: { origin: "derived", spaceUnit: "mm", anatomical: true } }) as { axes: Record<string, unknown>[] };
  for (const a of plain.axes) assert(!("centering" in a), "a centring nobody declared");
});

Deno.test("a single slice states no spacing between slices: none when assumed, its thickness when given", () => {
  const assumed = ducknAttrs({ dims: [4, 4, 1], ijkToRAS: M, geometry: { ...G, origin: "assumed" } }) as { axes: Record<string, unknown>[] };
  assert(!("space_direction" in assumed.axes[0]) && !("thickness" in assumed.axes[0]), "an assumed 1 mm written as a fact");
  assertEquals(assumed.axes[1].space_direction, [-0, -0.5, 0], "the in-plane axes are still stated");
  const given = ducknAttrs({ dims: [4, 4, 1], ijkToRAS: [...M.slice(0, 10), 2.5, ...M.slice(11)], geometry: { ...G, origin: "acquired" } }) as { axes: Record<string, unknown>[] };
  assertEquals(given.axes[0].thickness, 2.5);
  assert(!("space_direction" in given.axes[0]));
});

Deno.test("a rescale that does not give whole numbers is copied as exact floats; a lossy source is flagged", async () => {
  // Refused until 2026-09-25, when the reader truncated such values into integers; the reader keeps them in float32 now.
  const frac = await dbWithSeries(8, 8, 3, { extra: { RescaleSlope: 3.774114 } });
  const f = await writeDucknCopy(frac.dir, frac.series.seriesInstanceUID, { outDir: `${frac.dir}/SlicerAlbula-Zarr` });
  const farr = JSON.parse(await Deno.readTextFile(`${f.path}/0/zarr.json`));
  assertEquals(farr.data_type, "float32");
  const lossy = await dbWithSeries(8, 8, 3, { extra: { LossyImageCompression: "01" } });
  const r = await writeDucknCopy(lossy.dir, lossy.series.seriesInstanceUID, { outDir: `${lossy.dir}/SlicerAlbula-Zarr` });
  const arr = JSON.parse(await Deno.readTextFile(`${r.path}/0/zarr.json`));
  assertEquals(arr.attributes.duckn.extensions.dicom.lossy_compressed, true);
  const plain = await dbWithSeries(8, 8, 3);
  const p = await writeDucknCopy(plain.dir, plain.series.seriesInstanceUID, { outDir: `${plain.dir}/SlicerAlbula-Zarr` });
  const parr = JSON.parse(await Deno.readTextFile(`${p.path}/0/zarr.json`));
  assert(!("lossy_compressed" in parr.attributes.duckn.extensions.dicom), "lossy said of a source that is not");
  // And the instances in slice order, where Michael Halle's reader reads per-slice DICOM data.
  const sops = parr.attributes.duckn.axes[0].samples.map((x: { metadata: { dicom: { SOPInstanceUID: string } } }) => x.metadata.dicom.SOPInstanceUID);
  assertEquals(sops, parr.attributes.duckn.extensions.albula.volume.meta.sopInstanceUIDs);
});
