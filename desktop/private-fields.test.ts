// The private-fields check on disk: made at import, made for series a database already held, read from deflated files,
// and removed with its series.
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "../logic/dcmjs.ts";
import { setDcmjs } from "../logic/readers/dicom-series.ts";
import { makeCtSeries } from "../logic/test-dicom.ts";
import { deflateDicomFile } from "../logic/dicom-deflate.ts";
import { createDatabase } from "./db-create.ts";
import { importFiles } from "./db-import.ts";
import { deleteSeriesFromDatabase } from "./db-index.ts";
import { fileBlocks, privateFieldsSummary, readSurvey, surveyPath, surveySeries } from "./private-fields.ts";

setDcmjs(dcmjs);
// Core's readers only, so the expectations below do not move with an extension: said per call (extensionList "none"),
// never by setting ALBULA_EXTENSIONS, which every other test file in the same process would then see (2026-10-29: the
// diffusion sample's route test found no extension).
const NONE = { extensionList: "none" } as const;

const made: string[] = [];
globalThis.addEventListener("unload", () => { for (const d of made) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });
const tmp = async (prefix: string) => { const d = await Deno.makeTempDir({ prefix }); made.push(d); return d; };

const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
/** Explicit VR private elements: Siemens' CSA creator and its (0029,1010), and a vendor block no reader reads. */
function privateElements(): Uint8Array {
  const lo = (g: number, e: number, s: string) => { const t = new TextEncoder().encode(s.length % 2 ? s + " " : s); return cat(new Uint8Array([g & 0xff, g >> 8, e & 0xff, e >> 8, 0x4c, 0x4f, t.length & 0xff, t.length >> 8]), t); };
  const ob = (g: number, e: number, n: number) => cat(new Uint8Array([g & 0xff, g >> 8, e & 0xff, e >> 8, 0x4f, 0x42, 0, 0, n & 0xff, n >> 8, 0, 0]), new Uint8Array(n));
  return cat(lo(0x0029, 0x0010, "SIEMENS CSA HEADER"), ob(0x0029, 0x1010, 16), lo(0x0051, 0x0010, "ACME RECON 3"), lo(0x0051, 0x1001, "kept"));
}
/** The file with private elements put just before its pixels (the walker and the header reader do not need them sorted). */
function withPrivate(file: ArrayBuffer): Uint8Array {
  const u = new Uint8Array(file);
  for (let p = 132; p + 4 < u.length; p += 2) if (u[p] === 0xe0 && u[p + 1] === 0x7f && u[p + 2] === 0x10 && u[p + 3] === 0x00) return cat(u.subarray(0, p), privateElements(), u.subarray(p));
  throw new Error("no pixels");
}

Deno.test("an import records each series' private blocks; the summary says which are read; removing the series removes it", async () => {
  const src = await tmp("albula-pf-src-");
  const a = await makeCtSeries(8, 8, 5, { extra: { SeriesDescription: "With private fields" } });
  const b = await makeCtSeries(8, 8, 3, { extra: { SeriesDescription: "Without" } });
  for (const [i, x] of a.instances.entries()) await Deno.writeFile(`${src}/a${i}.dcm`, withPrivate(x));
  for (const [i, x] of b.instances.entries()) await Deno.writeFile(`${src}/b${i}.dcm`, new Uint8Array(x));
  const dir = `${await tmp("albula-pf-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  const r = await importFiles(dir, [...a.instances.keys()].map((i) => `${src}/a${i}.dcm`).concat([...b.instances.keys()].map((i) => `${src}/b${i}.dcm`)));
  assertEquals(r.series.length, 2);

  const sa = await readSurvey(dir, a.seriesInstanceUID);
  assertEquals(sa?.files, { looked: 5, of: 5 });
  assertEquals(sa?.blocks, [{ group: "0029", creator: "SIEMENS CSA HEADER", elements: ["10"] }, { group: "0051", creator: "ACME RECON 3", elements: ["01"] }]);
  assertEquals((await readSurvey(dir, b.seriesInstanceUID))?.blocks, []);

  const s = await privateFieldsSummary(dir, NONE);
  assertEquals([s.series, s.checked, s.withUnread, s.notWhole, s.cannot, s.checking], [2, 2, 1, 0, 0, undefined]);
  assertEquals(s.blocks.map((x) => [x.creator, x.state, x.read.map((y) => y.reader)]), [
    ["ACME RECON 3", "not read", []],
    ["SIEMENS CSA HEADER", "partly read", ["Siemens mosaic"]],
  ]);
  assert(s.blocks[0].seriesNames[0].endsWith("With private fields"), s.blocks[0].seriesNames[0]);
  assertEquals(s.blocks[1].unread, [], "the CSA header's one element is read (in part)");

  await deleteSeriesFromDatabase(dir, a.seriesInstanceUID);
  assertEquals(await Deno.stat(surveyPath(dir, a.seriesInstanceUID)).then(() => true, () => false), false, "removed with its series");
});

Deno.test("series a database already held are checked when the summary is first asked", async () => {
  const src = await tmp("albula-pf-src-");
  const a = await makeCtSeries(8, 8, 4, { extra: { SeriesDescription: "Old" } });
  for (const [i, x] of a.instances.entries()) await Deno.writeFile(`${src}/a${i}.dcm`, withPrivate(x));
  const dir = `${await tmp("albula-pf-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  await importFiles(dir, [...a.instances.keys()].map((i) => `${src}/a${i}.dcm`));
  await Deno.remove(surveyPath(dir, a.seriesInstanceUID));   // as a database from before the check
  const first = await privateFieldsSummary(dir, { ...NONE, startCheck: true });
  assertEquals(first.checked, 0);
  assert(first.checking, "the check started");
  let s = first;
  for (let i = 0; i < 100 && (s.checking || s.checked < 1); i++) { await new Promise((r) => setTimeout(r, 20)); s = await privateFieldsSummary(dir, NONE); }
  assertEquals([s.checked, s.withUnread, s.checking], [1, 1, undefined]);
});

Deno.test("a deflated file is inflated and walked", async () => {
  const a = await makeCtSeries(8, 8, 1);
  // The deflated form, as Albula writes its segmentations (logic/dicom-deflate.ts), with a meta group of its own.
  const file = await deflateDicomFile(withPrivate(a.instances[0]), (ts) => {
    const ui = new TextEncoder().encode(ts.length % 2 ? ts + "\0" : ts);
    const el = cat(new Uint8Array([2, 0, 0x10, 0, 0x55, 0x49, ui.length, 0]), ui);
    return cat(new Uint8Array(128), new TextEncoder().encode("DICM"), new Uint8Array([2, 0, 0, 0, 0x55, 0x4c, 4, 0, el.length, 0, 0, 0]), el);
  });
  const dir = await tmp("albula-pf-deflated-");
  await Deno.writeFile(`${dir}/x.dcm`, file);
  const r = await fileBlocks(`${dir}/x.dcm`);
  assertEquals(r.ended, "pixels");
  assertEquals([...r.blocks.keys()], ["0029|SIEMENS CSA HEADER", "0051|ACME RECON 3"]);
});

Deno.test("an extension's private reads are read from the file its manifest names, under its name", async () => {
  const { registerExtensionPrivateReads } = await import("./private-fields.ts");
  const { privateReads } = await import("../logic/readers/private-survey.ts");
  const dir = await tmp("albula-pf-ext-");
  await Deno.mkdir(`${dir}/acme`);
  await Deno.writeTextFile(`${dir}/extensions.json`, JSON.stringify({ version: 1, extensions: [{ name: "acme", path: "acme", on: true }, { name: "off", path: "off", on: false }] }));
  await Deno.writeTextFile(`${dir}/acme/extension.json`, JSON.stringify({ name: "acme", privateReads: "reads.json" }));
  await Deno.writeTextFile(`${dir}/acme/reads.json`, JSON.stringify({ version: 1, reads: [{ group: "0051", creator: "ACME RECON 3", elements: ["01"], what: "the recon kernel" }] }));
  assertEquals(registerExtensionPrivateReads(`${dir}/extensions.json`), { found: true, readers: ["acme"] });
  assertEquals(privateReads().get("acme")?.[0].creator, "ACME RECON 3");
  // Turned off: its reads no longer count, at once (finding 12).
  await Deno.writeTextFile(`${dir}/extensions.json`, JSON.stringify({ version: 1, extensions: [{ name: "acme", path: "acme", on: false }] }));
  assertEquals(registerExtensionPrivateReads(`${dir}/extensions.json`), { found: true, readers: [] });
  assertEquals(privateReads().has("acme"), false);
  // No list at all (the app outside the workspace): said, not passed over (finding 2).
  assertEquals(registerExtensionPrivateReads(`${dir}/no-such-list.json`).found, false);
});

Deno.test("critic 2026-10-29, finding 1: a second import of more images of a series makes the record of the whole series", async () => {
  const src = await tmp("albula-pf-src-");
  const a = await makeCtSeries(8, 8, 20, { extra: { SeriesDescription: "Grows" } });
  for (const [i, x] of a.instances.entries()) await Deno.writeFile(`${src}/a${i}.dcm`, i < 12 ? withPrivate(x) : new Uint8Array(x));
  const dir = `${await tmp("albula-pf-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  await importFiles(dir, [...Array(12).keys()].map((i) => `${src}/a${i}.dcm`));
  await importFiles(dir, [...Array(20).keys()].map((i) => `${src}/a${i}.dcm`));
  const r = await readSurvey(dir, a.seriesInstanceUID);
  assertEquals(r?.files, { looked: 8, of: 20 });
  // The sample of 8 of 20 (by file name) may or may not hold one of the 12 with the block; the summary's own check of a
  // changed list is what matters: the stamp is of the 20 files.
  const s = await privateFieldsSummary(dir, NONE);
  assertEquals([s.checked, s.checking], [1, undefined], "the record is of the files the index lists now");
});

Deno.test("critic 2026-10-29, findings 3 and 5: missing files are said; a series that cannot be checked ends the check", async () => {
  const src = await tmp("albula-pf-src-");
  const a = await makeCtSeries(8, 8, 3, { extra: { SeriesDescription: "Gone" } });
  for (const [i, x] of a.instances.entries()) await Deno.writeFile(`${src}/a${i}.dcm`, withPrivate(x));
  const dir = `${await tmp("albula-pf-db-")}/db`;
  await createDatabase(dir, { name: "Test" });
  await importFiles(dir, [...a.instances.keys()].map((i) => `${src}/a${i}.dcm`));
  const { indexFiles } = await import("./private-fields.ts");
  for (const f of (await indexFiles(dir)).get(a.seriesInstanceUID)!) await Deno.remove(f);
  await Deno.remove(surveyPath(dir, a.seriesInstanceUID));
  // An index row whose identifier is not a DICOM UID.
  const { runScript } = await import("./sqlite.ts");
  await runScript(`${dir}/ctkDICOM.sql`, "INSERT INTO Series (SeriesInstanceUID, StudyInstanceUID, InsertTimestamp) VALUES ('1.2.840.99.7a', 'x', 0);");
  let s = await privateFieldsSummary(dir, { ...NONE, startCheck: true });
  for (let i = 0; i < 100 && s.checking; i++) { await new Promise((r) => setTimeout(r, 20)); s = await privateFieldsSummary(dir, { ...NONE, startCheck: true }); }
  assertEquals([s.checked, s.notWhole, s.cannot, s.checking], [1, 1, 1, undefined]);
  assertEquals((await readSurvey(dir, a.seriesInstanceUID))?.notWhole?.every((n) => n.why === "missing"), true);
});

Deno.test("critic 2026-10-29, finding 6: a record is not written into a database folder that is gone", async () => {
  const dir = `${await tmp("albula-pf-gone-")}/db`;
  const r = await surveySeries(dir, "1.2.3.4", [`${dir}/dicom/x.dcm`]);
  assertEquals(r, undefined);
  assertEquals(await Deno.stat(dir).then(() => true, () => false), false, "the folder is not made again");
});

Deno.test("critic 2026-10-29, finding 8: a deflated file is walked past its pixels", async () => {
  const a = await makeCtSeries(8, 8, 1);
  const after = cat(new Uint8Array([0xe1, 0x7f, 0x10, 0x00, 0x4c, 0x4f, 14, 0]), new TextEncoder().encode("SIEMENS MR IMA"), new Uint8Array([0xe1, 0x7f, 0x10, 0x10, 0x4f, 0x42, 0, 0, 2, 0, 0, 0, 0, 0]));
  const file = await deflateDicomFile(cat(withPrivate(a.instances[0]), after), (ts) => {
    const ui = new TextEncoder().encode(ts.length % 2 ? ts + "\0" : ts);
    const el = cat(new Uint8Array([2, 0, 0x10, 0, 0x55, 0x49, ui.length, 0]), ui);
    return cat(new Uint8Array(128), new TextEncoder().encode("DICM"), new Uint8Array([2, 0, 0, 0, 0x55, 0x4c, 4, 0, el.length, 0, 0, 0]), el);
  });
  const dir = await tmp("albula-pf-deflated-");
  await Deno.writeFile(`${dir}/x.dcm`, file);
  const r = await fileBlocks(`${dir}/x.dcm`);
  assertEquals([r.ended, r.why], ["pixels", undefined]);
  assertEquals([...r.blocks.keys()], ["0029|SIEMENS CSA HEADER", "0051|ACME RECON 3", "7FE1|SIEMENS MR IMA"]);
});
