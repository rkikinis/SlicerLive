// The DICOM header as the duckn copy holds it (dicom-tags.ts): the record in the DICOM JSON Model keeps every
// attribute -- private and binary ones included -- and comes back as a header dcmjs writes into a file again. Ron,
// 2026-09-25: "the ultimate arbiter is the DICOM standard. Private fields are very important as vendors often use them
// to store real information."
import { assert, assertEquals } from "jsr:@std/assert@1";
import dcmjs from "../dcmjs.ts";
import { fromDicomJson, mergeSlice, sameHeader, splitShared, toDicomJson, toDucknTags } from "./dicom-tags.ts";
import { ABSENT, testData } from "../../test/test-data.ts";

type Raw = Record<string, { vr: string; Value?: unknown[] }>;
const D = dcmjs.data as unknown as {
  DicomMessage: { readFile(b: ArrayBuffer): { dict: Raw; meta: Raw } };
  DicomDict: new (meta: Raw) => { dict: Raw; write(): ArrayBuffer };
  DicomMetaDictionary: { naturalizeDataset(d: Raw): Record<string, unknown> };
};
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Through the copy and back into a file: parse, the record, JSON text, back, write, parse again. */
function roundTrip(file: ArrayBuffer) {
  const p = D.DicomMessage.readFile(file);
  const rec = JSON.parse(JSON.stringify(toDicomJson(p.dict, p.meta)));
  const back = fromDicomJson(rec);
  const meta = Object.fromEntries(Object.entries(back).filter(([t]) => t.startsWith("0002")));
  const dict = Object.fromEntries(Object.entries(back).filter(([t]) => !t.startsWith("0002")));
  const out = new D.DicomDict(meta); out.dict = dict;
  const again = D.DicomMessage.readFile(out.write());
  return { before: toDicomJson(p.dict, p.meta), after: toDicomJson(again.dict, again.meta) };
}

Deno.test("a header with private and binary attributes goes into the record and back into a file unchanged", () => {
  const meta: Raw = {
    "00020001": { vr: "OB", Value: [new Uint8Array([0, 1]).buffer] },
    "00020002": { vr: "UI", Value: ["1.2.840.10008.5.1.4.1.1.4"] }, "00020003": { vr: "UI", Value: ["2.25.1"] },
    "00020010": { vr: "UI", Value: ["1.2.840.10008.1.2.1"] },
  };
  const dict: Raw = {
    "00080016": { vr: "UI", Value: ["1.2.840.10008.5.1.4.1.1.4"] }, "00080018": { vr: "UI", Value: ["2.25.1"] },
    "00100010": { vr: "PN", Value: [{ Alphabetic: "TEST^PRIVATE" }] },
    "00290010": { vr: "LO", Value: ["SIEMENS CSA HEADER"] },
    "00291010": { vr: "OB", Value: [new Uint8Array([83, 86, 49, 48, 4, 3, 2, 1, 0, 255]).buffer] },   // a vendor's binary header
    "20011003": { vr: "FL", Value: [1000] },                                                        // a Philips-style private b-value
    "00081115": { vr: "SQ", Value: [{ "0020000E": { vr: "UI", Value: ["2.25.9"] }, "00191099": { vr: "DS", Value: [1.5] } }] },
  };
  const rec = toDicomJson(dict, meta);
  assertEquals(rec["00291010"], { vr: "OB", InlineBinary: btoa(String.fromCharCode(83, 86, 49, 48, 4, 3, 2, 1, 0, 255)) });
  assertEquals(rec["20011003"], { vr: "FL", Value: [1000] });
  assertEquals((rec["00081115"].Value![0] as Record<string, unknown>)["00191099"], { vr: "DS", Value: [1.5] });
  const out = new D.DicomDict(meta); out.dict = dict;
  const { before, after } = roundTrip(out.write());
  assert(sameHeader(before, after), "the record written back into a file and read again is the record");
  // Mike's keyword view keeps the private text and number, leaves the binary out, as his converter does.
  const view = toDucknTags(D.DicomMetaDictionary.naturalizeDataset(dict));
  assertEquals(view.PatientName, "TEST^PRIVATE");
  assert(!("00291010" in view));
});

Deno.test("shared once, the rest per slice, and every slice back exactly", () => {
  const h = [0, 1, 2].map((k) => ({ a: { vr: "LO", Value: ["same"] }, b: { vr: "DS", Value: [k] }, c: { vr: "SQ", Value: [{ x: { vr: "IS", Value: [7] } }] } }));
  const { shared, perSlice } = splitShared(h);
  assertEquals(Object.keys(shared).sort(), ["a", "c"]);
  assertEquals(perSlice.map((p) => Object.keys(p)), [["b"], ["b"], ["b"]]);
  h.forEach((one, k) => assert(sameHeader(one, mergeSlice(shared, perSlice[k]))));
});

// PUBLIC FILES, when fetched (Contents/data/multiframe/fetch-multiframe.py): Philips' diffusion, whose private fields
// are the example Ron gave, and Siemens XA30's; every attribute, private included, through the record and back.
const BASE = testData("multiframe") ?? ABSENT;
for (const [name, file] of [["philips_dti", "2201_WIP_DTI_S2MB2.dcm"], ["xa30_dwi", "0002_1.3.12.2.1107.5.2.43.67093.2022071112112396234505519.dcm"]]) {
  const path = `${BASE}${name}/${file}`;
  let have = true; try { Deno.statSync(path); } catch { have = false; }
  Deno.test({
    name: `public ${name}: every attribute, private ones included, through the record and back into a file`,
    ignore: !have,
    fn: () => {
      const { before, after } = roundTrip(ab(Deno.readFileSync(path)));
      const priv = Object.keys(before).filter((t) => parseInt(t.slice(0, 4), 16) % 2 === 1);
      assert(priv.length > 0, "the file has private attributes");
      assert(sameHeader(before, after), `${Object.keys(before).length} attributes, ${priv.length} private`);
    },
  });
}

// AGAINST DCMTK (Andrey Fedorov: the community's toolkits, not only our own; Ron installed DCMTK 2026-09-25): our
// record of a public file equals DCMTK's dcm2json of the same file, attribute for attribute. Two known differences:
// a 4-byte float (FL) is written as the exact double of its value here and as its shortest decimal by DCMTK -- the same
// value, compared as such; and the character set inside a sequence item, which dcmjs sets to UTF-8 (ISO_IR 192) as it
// decodes, as DCMTK does at the top level only -- the record's strings ARE UTF-8, as the JSON Model requires.
const hasDcm2json = (() => { try { return new Deno.Command("dcm2json", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; } })();
for (const [name, file] of [["philips_dti", "2201_WIP_DTI_S2MB2.dcm"], ["xa30_dwi", "0002_1.3.12.2.1107.5.2.43.67093.2022071112112396234505519.dcm"], ["canon_dti", "1.2.392.200036.9116.4.2.9143.7334.20201002121034620.5.6"]]) {
  const path = `${BASE}${name}/${file}`;
  let have = true; try { Deno.statSync(path); } catch { have = false; }
  Deno.test({
    name: `public ${name}: the record equals DCMTK's dcm2json, attribute for attribute`,
    ignore: !have || !hasDcm2json,
    fn: () => {
      const out = new Deno.Command("dcm2json", { args: ["+m", path], stdout: "piped", stderr: "null" }).outputSync();
      assert(out.success, "dcm2json ran");
      const theirs = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<string, unknown>;
      delete theirs["7FE00010"];
      const p = D.DicomMessage.readFile(ab(Deno.readFileSync(path)));
      const ours = JSON.parse(JSON.stringify(toDicomJson(p.dict, p.meta)));
      const diffs: string[] = [];
      // deno-lint-ignore no-explicit-any
      const walk = (a: Record<string, any>, b: Record<string, any>, at: string, depth: number) => {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const x = a[k], y = b[k];
          if (!x || !y || x.vr !== y.vr) { diffs.push(`${at}${k}`); continue; }
          if (x.vr === "SQ") { const xa = x.Value ?? [], ya = y.Value ?? []; if (xa.length !== ya.length) diffs.push(`${at}${k}`); else xa.forEach((it: never, i: number) => walk(it, ya[i], `${at}${k}[${i}].`, depth + 1)); continue; }
          if (x.vr === "FL" && (x.Value ?? []).every((v: number, i: number) => Math.fround(v) === Math.fround(y.Value?.[i]))) continue;
          if (k === "00080005" && depth > 0) continue;
          if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${at}${k}`);
        }
      };
      walk(ours, theirs, "", 0);
      assertEquals(diffs.slice(0, 10), []);
    },
  });
}
