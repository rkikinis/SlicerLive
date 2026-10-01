// The DICOM browser's per-series tooltip (logic/series-explain.ts) and the header reader under it
// (logic/readers/dicom-head.ts). Ron, 2026-09-24: "the chest CT has many acquisitions with cryptic shorthand
// descriptions. Having tooltips with more per row information would be helpful."
//
//   deno test -A --no-check logic/series-explain.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { explainName, explainSeries } from "./series-explain.ts";
import { readDicomHead } from "./readers/dicom-head.ts";

/** A small DICOM file: preamble, meta group (explicit LE), then the data set in the given syntax. */
function dicom(ts: string, els: [number, number, string, string | number | number[]][], extra?: Uint8Array): ArrayBuffer {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
  const str = (s: string) => { const b = [...s].map((c) => c.charCodeAt(0)); if (b.length % 2) b.push(32); return b; };
  const el = (g: number, e: number, vr: string, v: string | number | number[], explicit: boolean) => {
    let body: number[];
    if (vr === "US") body = [(v as number) & 255, ((v as number) >> 8) & 255];
    else if (vr === "FD") { const f = new Float64Array([v as number]); body = [...new Uint8Array(f.buffer)]; }
    else body = str(String(v));
    u16(g); u16(e);
    if (explicit) { parts.push(vr.charCodeAt(0), vr.charCodeAt(1)); u16(body.length); } else u32(body.length);
    parts.push(...body);
  };
  for (let i = 0; i < 128; i++) parts.push(0);
  parts.push(..."DICM".split("").map((c) => c.charCodeAt(0)));
  el(0x0002, 0x0010, "UI", ts, true);
  const explicit = ts !== "1.2.840.10008.1.2";
  for (const [g, e, vr, v] of els) el(g, e, vr, v, explicit);
  const out = new Uint8Array(parts.length + (extra?.length ?? 0));
  out.set(parts); if (extra) out.set(extra, parts.length);
  return out.buffer;
}
const CT_ELEMENTS: [number, number, string, string | number | number[]][] = [
  [0x0008, 0x0008, "CS", "ORIGINAL\\PRIMARY\\AXIAL"], [0x0008, 0x0016, "UI", "1.2.840.10008.5.1.4.1.1.2"],
  [0x0008, 0x0031, "TM", "180134.154"], [0x0008, 0x0060, "CS", "CT"], [0x0008, 0x0070, "LO", "SIEMENS"],
  [0x0018, 0x0050, "DS", "1"], [0x0018, 0x0060, "DS", "120"], [0x0018, 0x1210, "SH", "I70f"],
  [0x0018, 0x5100, "CS", "FFS"], [0x0018, 0x9345, "FD", 12.5], [0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"],
  [0x0028, 0x0010, "US", 512], [0x0028, 0x0011, "US", 512], [0x0028, 0x0030, "DS", "0.83\\0.83"],
];

Deno.test("the header is read from explicit and implicit VR files, and from a file cut short", () => {
  for (const ts of ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2"]) {
    const h = readDicomHead(dicom(ts, CT_ELEMENTS));
    assertEquals(h.get("00080060"), "CT", ts);
    assertEquals(h.get("00280010"), "512", ts);
    assertEquals(h.get("00181210"), "I70f", ts);
    assertEquals(Number(h.get("00189345")), 12.5, ts);
    assertEquals(h.get("00185100"), "FFS", ts);
  }
  const whole = dicom("1.2.840.10008.1.2.1", CT_ELEMENTS);
  const cut = readDicomHead(whole.slice(0, whole.byteLength - 20));   // the last elements are gone
  assertEquals(cut.get("00080060"), "CT");
  assertEquals(cut.get("00280030"), undefined);
});

Deno.test("the name is decoded only where the shorthand is known; the rest is said to be unexplained", () => {
  const a = explainName("WO Insp 2x1.5 Lung Chest");
  assertEquals(a.said, ["without contrast", "breath held after breathing in (lungs full)", "slices 2 mm thick, every 1.5 mm", "sharp filter, for the lungs", "chest"]);
  assertEquals(a.unknown, []);
  assert(explainName("WO Ax MIP 12x6 Soft_RR [4]").said.includes("slabs 12 mm thick, every 6 mm"));
  assert(explainName("WO Ax MIP 12x6 Soft_RR [4]").said.includes("made on the reading workstation from series 4"));
  assert(explainName("WO Insp 4 Soft Chest").said.includes("slices 4 mm thick"));
  assertEquals(explainName("ZF BestDia Bv56/4 ME67").unknown, ["ZF", "Bv56/4", "ME67"]);
});

Deno.test("the tooltip says what the file is, its size, how it was made, and how the patient lay", () => {
  const t = explainSeries("WO Insp 2x1.5 Lung Chest", 408, readDicomHead(dicom("1.2.840.10008.1.2.1", CT_ELEMENTS)));
  assert(t.includes("the images as the scanner made them, axial · 408 files"), t);
  assert(t.includes("slices 2 mm thick"), t);
  assert(t.includes("filter I70f · 120 kV · dose (CTDIvol) 12.5 mGy"), t);
  assert(t.includes("lying on the back, feet first, at 18:01:34"), t);
  assert(explainSeries("Dose Report", 1, null).includes("structured report"));
});

Deno.test("a segmentation's own name and a plain name are not listed as unexplained shorthand", () => {
  assert(!explainSeries("ts.v2:total of CT NEPHROGENIC", 1, null, "SEG").includes("Not explained"));
  assert(!explainSeries("NEPHROGENIC", 709, null, "CT").includes("Not explained"));
  // IDC's "NEPHROGENIC" is the contrast phase, not a tumor (Ron, 2026-09-24, from Mike's GI-tract deck).
  assert(explainSeries("NEPHROGENIC", 709, null, "CT").includes("nephrographic phase"));
  const ctpa = explainSeries("CTPA (40% ASIR)", 418, null, "CT");
  assert(ctpa.includes("CT pulmonary angiography") && ctpa.includes("40% strength") && !ctpa.includes("heartbeat") && !ctpa.includes("Not explained"), ctpa);
  assert(explainSeries("Topogram 0.7 T30s", 1, null, "CT").includes("Not explained: 0.7, T30s"));
});
