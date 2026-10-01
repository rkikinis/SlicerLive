// The header walk that recovers a derived series' parent, and the sweep built on it.
//
// The fixtures are assembled BYTE BY BYTE rather than with dcmjs: the thing under test is a DICOM
// parser, so building its input with a DICOM library would hide exactly the encoding mistakes it
// exists to survive -- and it keeps this in the hermetic tier, with no npm fetch.
//
//   deno test -A --no-check desktop/db-backfill.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { backfillProvenance, referencedSeriesUidOf } from "./db-backfill.ts";
import { provenanceEdges, provenancePathFor, recordProvenanceEdge } from "./db-index.ts";

const CHILD_OWN = "1.2.840.99.1";                 // the file's own SeriesInstanceUID
const PARENT = "1.2.840.99.2";                    // the one it was derived from

// ---- a minimal explicit-VR little-endian writer -------------------------------------------------
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** DICOM values are even-length; text pads with NUL. */
const pad = (s: string) => (s.length % 2 ? s + "\0" : s);

/** A short-form explicit element: group, element, VR, string value. */
const el = (g: number, e: number, vr: string, value: string): number[] => {
  const v = chars(pad(value));
  return [...u16(g), ...u16(e), ...chars(vr), ...u16(v.length), ...v];
};
/** A sequence with UNDEFINED length — what dcmjs and most writers emit. */
const sqOpen = (g: number, e: number): number[] => [...u16(g), ...u16(e), ...chars("SQ"), 0, 0, ...u32(0xffffffff)];
const ITEM = [...u16(0xfffe), ...u16(0xe000), ...u32(0xffffffff)];
const ITEM_END = [...u16(0xfffe), ...u16(0xe00d), ...u32(0)];
const SQ_END = [...u16(0xfffe), ...u16(0xe0dd), ...u32(0)];

function file(dataset: number[]): Uint8Array {
  const meta = [
    ...el(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
    ...el(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.66.4"),
  ];
  const groupLen = [...u16(0x0002), ...u16(0x0000), ...chars("UL"), ...u16(4), ...u32(meta.length)];
  return new Uint8Array([...new Array(128).fill(0), ...chars("DICM"), ...groupLen, ...meta, ...dataset]);
}

Deno.test("finds the referenced series past a nested sequence that comes before it", () => {
  // THE REGRESSION. ReferencedInstanceSequence holds one item per referenced slice and sorts BEFORE
  // SeriesInstanceUID, so a walk that treats the inner sequence's delimiter as the outer one's ends
  // early and reports no parent — which is what a real 933 MB file did.
  const bytes = file([
    ...el(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.66.4"),
    ...sqOpen(0x0008, 0x1115),
    ...ITEM,
    ...sqOpen(0x0008, 0x1199),
    ...ITEM, ...el(0x0008, 0x1155, "UI", "1.2.840.99.9"), ...ITEM_END,
    ...ITEM, ...el(0x0008, 0x1155, "UI", "1.2.840.99.8"), ...ITEM_END,
    ...SQ_END,
    ...el(0x0020, 0x000e, "UI", PARENT),
    ...ITEM_END,
    ...SQ_END,
    ...el(0x0020, 0x000e, "UI", CHILD_OWN),
  ]);
  assertEquals(referencedSeriesUidOf(bytes), PARENT);
});

Deno.test("never returns the file's own series when there is no reference", () => {
  const bytes = file([
    ...el(0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.66.4"),
    ...el(0x0020, 0x000e, "UI", CHILD_OWN),
  ]);
  assertEquals(referencedSeriesUidOf(bytes), null);
});

Deno.test("a defined-length sequence is read as readily as an undefined one", () => {
  const inner = [...el(0x0020, 0x000e, "UI", PARENT)];
  const item = [...u16(0xfffe), ...u16(0xe000), ...u32(inner.length), ...inner];
  const seq = [...u16(0x0008), ...u16(0x1115), ...chars("SQ"), 0, 0, ...u32(item.length), ...item];
  assertEquals(referencedSeriesUidOf(file(seq)), PARENT);
});

Deno.test("stops at pixel data rather than reading through it", () => {
  const bytes = file([
    ...u16(0x7fe0), ...u16(0x0010), ...chars("OB"), 0, 0, ...u32(8), 1, 2, 3, 4, 5, 6, 7, 8,
    ...sqOpen(0x0008, 0x1115), ...ITEM, ...el(0x0020, 0x000e, "UI", PARENT), ...ITEM_END, ...SQ_END,
  ]);
  assertEquals(referencedSeriesUidOf(bytes), null);
});

Deno.test("a file that is not DICOM is not a crash", () => {
  assertEquals(referencedSeriesUidOf(new Uint8Array(400)), null);
  assertEquals(referencedSeriesUidOf(new Uint8Array(4)), null);
});

// ---- the sweep ----------------------------------------------------------------------------------

const SQLITE = "/usr/bin/sqlite3";
const run = async (db: string, sql: string) => {
  const p = new Deno.Command(SQLITE, { args: [db], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(sql));
  await w.close();
  const { code, stderr } = await p.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
};

/** A database holding one CT series and one SEG whose file names that CT as its parent. */
async function makeDb(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "albula-backfill-" });
  const dir = `${root}/SlicerDICOMDatabase`;
  await Deno.mkdir(`${dir}/SEG`, { recursive: true });
  await Deno.writeFile(
    `${dir}/SEG/seg.dcm`,
    file([
      ...sqOpen(0x0008, 0x1115),
      ...ITEM,
      ...el(0x0020, 0x000e, "UI", PARENT),
      ...ITEM_END,
      ...SQ_END,
    ]),
  );
  await run(`${dir}/ctkDICOM.sql`, `
    CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY, StudyInstanceUID TEXT, SeriesDescription TEXT, Modality TEXT);
    CREATE TABLE Images (SOPInstanceUID TEXT PRIMARY KEY, Filename TEXT, SeriesInstanceUID TEXT);
    INSERT INTO Series VALUES ('${PARENT}', '1.2.3', 'NEPHROGENIC', 'CT');
    INSERT INTO Series VALUES ('${CHILD_OWN}', '1.2.3', 'ts:total of NEPHROGENIC', 'SEG');
    INSERT INTO Images VALUES ('1.2.840.99.10', 'SEG/seg.dcm', '${CHILD_OWN}');
  `);
  return dir;
}

Deno.test("the sweep links a segmentation to the series its own file names", async () => {
  const dir = await makeDb();
  const r = await backfillProvenance(dir);
  assertEquals(r.scanned, 1);
  assertEquals(r.linked, 1);
  assertEquals(r.unstated, []);
  const edges = await provenanceEdges(provenancePathFor(dir));
  assertEquals(edges.length, 1);
  assertEquals(edges[0].child, CHILD_OWN);
  assertEquals(edges[0].parent, PARENT);
});

Deno.test("running the sweep twice changes nothing the second time", async () => {
  const dir = await makeDb();
  await backfillProvenance(dir);
  const again = await backfillProvenance(dir);
  assertEquals(again.scanned, 0, "an already-linked series is not rescanned");
  assertEquals(again.linked, 0);
  assertEquals((await provenanceEdges(provenancePathFor(dir))).length, 1);
});

Deno.test("a parent that is not in this database is reported, not invented", async () => {
  const dir = await makeDb();
  await run(`${dir}/ctkDICOM.sql`, `DELETE FROM Series WHERE SeriesInstanceUID='${PARENT}';`);
  const r = await backfillProvenance(dir);
  assertEquals(r.linked, 0);
  assertEquals(r.parentMissing.length, 1);
  assert(r.parentMissing[0].includes("ts:total"));
});

// NEWEST FIRST, WITH THE TIME ON EACH EDGE (critic, 2026-09-17, finding 4): two surface sets of one
// segmentation, saved one after the other, must come back newest first, so a loader whose series
// rows carry no date still picks the later save.
Deno.test("provenance edges come back newest first and carry their creation time", async () => {
  const dir = await makeDb();
  const parent = "1.2.826.0.1.3680043.8.498.1";
  const first = "1.2.826.0.1.3680043.8.498.2", second = "1.2.826.0.1.3680043.8.498.3";
  await recordProvenanceEdge(dir, first, { parentSeriesUID: parent, kind: "surface", label: "surfaces, first save" });
  await new Promise((r) => setTimeout(r, 5));
  await recordProvenanceEdge(dir, second, { parentSeriesUID: parent, kind: "surface", label: "surfaces, second save" });
  const edges = (await provenanceEdges(provenancePathFor(dir))).filter((e) => e.kind === "surface");
  assertEquals(edges.map((e) => e.child), [second, first]);
  assert(edges.every((e) => typeof e.createdAt === "string" && e.createdAt.length > 0));
  assert(edges[0].createdAt! > edges[1].createdAt!);
});
