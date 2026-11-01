// The private-fields check: what the walker finds in a file's bytes, and how it is compared with what readers declare.
import { assertEquals } from "jsr:@std/assert@1";
import { compareWithReaders, mergeBlocks, MOSAIC_PRIVATE_READS, NO_CREATOR, NO_CREATOR_FOR_BLOCK, privateBlocksOf, spreadSample, type PrivateRead } from "./private-survey.ts";

const LONG = new Set(["OB", "OW", "SQ", "UN", "UT"]);
const pad = (b: Uint8Array) => b.length % 2 ? new Uint8Array([...b, 0x20]) : b;
const txt = (s: string) => pad(new TextEncoder().encode(s));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const tagBytes = (g: number, e: number) => new Uint8Array([g & 0xff, g >> 8, e & 0xff, e >> 8]);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]);
const u16 = (n: number) => new Uint8Array([n & 0xff, n >> 8]);
/** One explicit VR element. `undefinedLength`: an SQ or UN written with 0xFFFFFFFF and its delimiter. */
function ex(g: number, e: number, vr: string, value: Uint8Array, undefinedLength = false): Uint8Array {
  const v = new TextEncoder().encode(vr);
  if (LONG.has(vr)) return cat(tagBytes(g, e), v, new Uint8Array(2), u32(undefinedLength ? 0xffffffff : value.length), value, undefinedLength ? cat(tagBytes(0xfffe, 0xe0dd), u32(0)) : new Uint8Array());
  return cat(tagBytes(g, e), v, u16(value.length), value);
}
const im = (g: number, e: number, value: Uint8Array) => cat(tagBytes(g, e), u32(value.length), value);
const item = (body: Uint8Array) => cat(tagBytes(0xfffe, 0xe000), u32(body.length), body);
const itemUndef = (body: Uint8Array) => cat(tagBytes(0xfffe, 0xe000), u32(0xffffffff), body, tagBytes(0xfffe, 0xe00d), u32(0));
function file(ts: string, body: Uint8Array): Uint8Array {
  const meta = ex(0x0002, 0x0010, "UI", pad(new TextEncoder().encode(ts + "\0").subarray(0, ts.length + (ts.length % 2))));
  const group = ex(0x0002, 0x0000, "UL", u32(meta.length));
  return cat(new Uint8Array(128), new TextEncoder().encode("DICM"), group, meta, body);
}
const PIXELS_EX = ex(0x7fe0, 0x0010, "OW", new Uint8Array(8));
const asObj = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, s]) => [k, [...s].sort()]));

Deno.test("explicit VR: blocks by creator, at the top, inside a sequence's item, and after the pixels", () => {
  const nested = cat(ex(0x0021, 0x0010, "LO", txt("SIEMENS MR SDI 02")), ex(0x0021, 0x101c, "IS", txt("1")));
  const body = cat(
    ex(0x0008, 0x0060, "CS", txt("MR")),
    ex(0x0019, 0x0010, "LO", txt("SIEMENS MR HEADER")), ex(0x0019, 0x100c, "IS", txt("1000")), ex(0x0019, 0x100e, "FD", new Uint8Array(24)),
    ex(0x0029, 0x0010, "LO", txt("SIEMENS CSA HEADER")), ex(0x0029, 0x0011, "LO", txt("SIEMENS MEDCOM HEADER2")),
    ex(0x0029, 0x1010, "OB", new Uint8Array(16)), ex(0x0029, 0x1160, "LO", txt("com")),
    ex(0x5200, 0x9230, "SQ", itemUndef(nested), true),
    PIXELS_EX,
    ex(0x7fe1, 0x0010, "LO", txt("SIEMENS MR IMA")), ex(0x7fe1, 0x1010, "OB", new Uint8Array(6)),
  );
  const r = privateBlocksOf(file("1.2.840.10008.1.2.1", body));
  assertEquals(r.ended, "pixels");
  assertEquals(asObj(r.blocks), {
    "0019|SIEMENS MR HEADER": ["0C", "0E"],
    "0029|SIEMENS CSA HEADER": ["10"],
    "0029|SIEMENS MEDCOM HEADER2": ["60"],
    "0021|SIEMENS MR SDI 02": ["1C"],
    "7FE1|SIEMENS MR IMA": ["10"],          // after the pixels, which are skipped
  });
});

Deno.test("implicit VR: a private sequence of defined length is walked (told by its first item), creators per item", () => {
  const inner = cat(im(0x0043, 0x0010, txt("GEMS_PARM_01")), im(0x0043, 0x1039, txt("1000\\0\\0\\0")));
  const body = cat(im(0x0008, 0x0060, txt("MR")), im(0x0019, 0x0010, txt("GEMS_ACQU_01")), im(0x0019, 0x10bb, txt("0.5")), im(0x0019, 0x10ff, item(inner)), im(0x7fe0, 0x0010, new Uint8Array(4)));
  const r = privateBlocksOf(file("1.2.840.10008.1.2", body));
  assertEquals(r.ended, "pixels");
  // GE's creator in the sequence's item scopes (0043,1039); the outer (0019,10FF) is in GEMS_ACQU_01's block.
  assertEquals(asObj(r.blocks), { "0019|GEMS_ACQU_01": ["BB", "FF"], "0043|GEMS_PARM_01": ["39"] });
});

Deno.test("an element with no creator is said to be that; a cut file says it was cut; big endian is not read", () => {
  const body = cat(ex(0x0009, 0x1001, "LO", txt("x")), ex(0x0011, 0x0010, "LO", txt("ACME 1")), ex(0x0011, 0x1001, "LT", txt("a long value")), PIXELS_EX);
  const whole = file("1.2.840.10008.1.2.1", body);
  // (0009,1001) in a group with no creator: kept with its block, "1001" (a reader falls back to block 0x10 there).
  assertEquals(asObj(privateBlocksOf(whole).blocks), { [`0009|${NO_CREATOR}`]: ["1001"], "0011|ACME 1": ["01"] });
  const cut = privateBlocksOf(whole.subarray(0, whole.length - 4));
  assertEquals(cut.ended, "cut");
  assertEquals(privateBlocksOf(file("1.2.840.10008.1.2.2", body)).ended, "form");
});

Deno.test("UN of undefined length: its items are implicit VR (PS3.5 6.2.2)", () => {
  const inner = cat(im(0x2005, 0x0010, txt("Philips MR Imaging DD 001")), im(0x2005, 0x10b0, new Uint8Array(4)));
  const body = cat(ex(0x2005, 0x0010, "LO", txt("Philips MR Imaging DD 001")), ex(0x2005, 0x10fe, "UN", itemUndef(inner), true), PIXELS_EX);
  const r = privateBlocksOf(file("1.2.840.10008.1.2.1", body));
  assertEquals(r.ended, "pixels");
  assertEquals(asObj(r.blocks), { "2005|Philips MR Imaging DD 001": ["B0", "FE"] });
});

Deno.test("compared with the readers: not read, read in part, Albula's own", () => {
  const surveys = [
    { survey: 1, series: "1.1", files: { looked: 1, of: 1 }, made: "", blocks: mergeBlocks([{ ended: "pixels", blocks: new Map([["0029|SIEMENS CSA HEADER", new Set(["10", "20"])], ["0051|SIEMENS MR HEADER", new Set(["0A"])]]) }]) },
    { survey: 1, series: "1.2", files: { looked: 1, of: 1 }, made: "", blocks: mergeBlocks([{ ended: "pixels", blocks: new Map([["0029|SIEMENS CSA HEADER", new Set(["10"])], ["0077|SlicerAlbula provenance 1", new Set(["01"])]]) }]) },
  ];
  const reads = new Map<string, PrivateRead[]>([["mosaic", MOSAIC_PRIVATE_READS]]);
  const rows = compareWithReaders(surveys, reads);
  assertEquals(rows.map((r) => [r.group, r.creator, r.state, r.series.length, r.read.map((x) => x.elements.join())]), [
    ["0051", "SIEMENS MR HEADER", "not read", 1, []],
    ["0029", "SIEMENS CSA HEADER", "partly read", 2, ["10"]],
    ["0077", "SlicerAlbula provenance 1", "Albula's own", 1, []],
  ]);
});

Deno.test("a defined-length sequence that is a file's last element is not taken for a cut file", () => {
  const body = cat(ex(0x0008, 0x0060, "CS", txt("SR")), ex(0x0040, 0xa730, "SQ", item(ex(0x0040, 0xa010, "CS", txt("CONTAINS")))));
  assertEquals(privateBlocksOf(file("1.2.840.10008.1.2.1", body)).ended, "end");
});

Deno.test("a spread sample keeps the first and the last", () => {
  assertEquals(spreadSample([1, 2, 3], 8), [1, 2, 3]);
  const s = spreadSample(Array.from({ length: 300 }, (_, i) => i), 8);
  assertEquals([s.length, s[0], s[7]], [8, 0, 299]);
});

// Looks in siemens-mosaic.ts only, by the form of its calls (at(raw, "gggg", "creator", "ee")): a private-tag reader in
// another core file, or written another way, needs its own line here (critic 2026-10-29, finding 12).
Deno.test("the mosaic reader's declaration covers every private lookup in its code", async () => {
  const src = await Deno.readTextFile(new URL("./siemens-mosaic.ts", import.meta.url));
  const used = [...src.matchAll(/\bat\(raw, "([0-9A-F]{4})", "([^"]+)", "([0-9A-F]{2})"\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  const declared = new Set(MOSAIC_PRIVATE_READS.flatMap((r) => r.elements.map((e) => `${r.group}|${r.creator}|${e}`)));
  assertEquals(used.length > 0, true);
  assertEquals(used.filter((u) => !declared.has(u)), []);
});

Deno.test("critic 2026-10-29, finding 7: a value of known length that does not read as items is stepped over, and counted", () => {
  // An UN of defined length whose first bytes look like an item whose length runs past the value; a block after it.
  const bad = cat(tagBytes(0xfffe, 0xe000), u32(1000), new Uint8Array(8));
  const body = cat(ex(0x0011, 0x0010, "LO", txt("ACME 1")), ex(0x0011, 0x1001, "UN", bad), ex(0x0013, 0x0010, "LO", txt("AFTER GARBAGE")), ex(0x0013, 0x1001, "LO", txt("x")), PIXELS_EX);
  const r = privateBlocksOf(file("1.2.840.10008.1.2.1", body));
  assertEquals([r.ended, r.skipped], ["pixels", 1]);
  assertEquals(asObj(r.blocks), { "0011|ACME 1": ["01"], "0013|AFTER GARBAGE": ["01"] });
  // The preamble and "DICM" with no file meta group: the data set's own encoding, told by its first element.
  const noMeta = cat(new Uint8Array(128), new TextEncoder().encode("DICM"), ex(0x0008, 0x0060, "CS", txt("MR")), ex(0x0011, 0x0010, "LO", txt("ACME 1")), ex(0x0011, 0x1002, "LO", txt("y")), PIXELS_EX);
  assertEquals(asObj(privateBlocksOf(noMeta).blocks), { "0011|ACME 1": ["02"] });
});

Deno.test("critic 2026-10-29, finding 3: an image whose pixels never come is cut, not a whole file", () => {
  const body = cat(ex(0x0028, 0x0010, "US", u16(8)), ex(0x0029, 0x0010, "LO", txt("SIEMENS CSA HEADER")), ex(0x0029, 0x1010, "OB", new Uint8Array(4)));
  assertEquals(privateBlocksOf(file("1.2.840.10008.1.2.1", body)).ended, "cut");
});

Deno.test("critic 2026-10-29, finding 10: a group with no creator is read where a reader falls back to block 0x10", () => {
  const blocks = (k: string, e: string[]) => ({ ended: "pixels" as const, blocks: new Map([[k, new Set(e)]]) });
  const surveys = [
    { survey: 2, series: "1.1", files: { looked: 1, of: 1 }, made: "", blocks: mergeBlocks([blocks(`0019|${NO_CREATOR}`, ["100C", "1099"])]) },
    { survey: 2, series: "1.2", files: { looked: 1, of: 1 }, made: "", blocks: mergeBlocks([blocks(`0019|${NO_CREATOR_FOR_BLOCK}`, ["110C"])]) },
  ];
  const reads = new Map<string, PrivateRead[]>([["d", [{ group: "0019", creator: "SIEMENS MR HEADER", elements: ["0C"], what: "b-value" }]]]);
  const rows = compareWithReaders(surveys, reads);
  assertEquals(rows.map((r) => [r.creator, r.state, r.unread]), [[NO_CREATOR_FOR_BLOCK, "not read", ["110C"]], [NO_CREATOR, "partly read", ["1099"]]]);
});
