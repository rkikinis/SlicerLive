// dcmjs IN ONE PLACE, checked by reading the source rather than by remembering (critic, qa/2026-09-28-dependencies.md,
// finding 6; Ron: "yes"). logic/dicom-io.ts is the only application file that may reach into the library; everything
// else asks it for a DicomIO. Tests may use the raw library to inspect what was written.
//
//   deno test -A --no-check logic/dicom-io.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import dcmjs from "./dcmjs.ts";
import { dicomIO, setDicomLibrary } from "./dicom-io.ts";

const ALLOWED = new Set(["logic/dicom-io.ts", "logic/dcmjs.ts", "logic/dcmjs-version.ts"]);
// The library's own names. A call to any of them outside the module is a second place.
const REACHES_IN = /\bloadDcmjs\s*\(|\.data\.(DicomMessage|DicomMetaDictionary|datasetToDict|DicomDict|Colors)\b|\.normalizers\.|\.derivations\.|\bDicomMetaDictionary\.|\bDicomMessage\./;

Deno.test("no application file reaches into dcmjs except logic/dicom-io.ts", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    let entries: Deno.DirEntry[];
    try { entries = [...Deno.readDirSync(dir)]; } catch { return; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) { if (!["node_modules", "vendor", "harness", "scratchpad"].includes(e.name)) walk(p); continue; }
      if (!e.name.endsWith(".ts") || /\.(test|bench|gpu-bench|engine-bench)\.ts$/.test(e.name)) continue;
      const rel = p.slice(root.length + 1);
      if (ALLOWED.has(rel)) continue;
      Deno.readTextFileSync(p).split("\n").forEach((line, i) => {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*")) return;
        if (REACHES_IN.test(line)) offenders.push(`${rel}:${i + 1}  ${t.slice(0, 100)}`);
      });
    }
  };
  for (const d of ["logic", "render", "desktop", "algorithms", "examples"]) walk(`${root}/${d}`);
  assertEquals(offenders, [], `dcmjs reached outside logic/dicom-io.ts:\n  ${offenders.join("\n  ")}`);
});

Deno.test("DicomIO: a dataset written and read back is the same", async () => {
  setDicomLibrary(dcmjs);
  const io = await dicomIO();
  const sop = io.newUid();
  const file = io.toFile({
    _meta: { TransferSyntaxUID: { vr: "UI", Value: ["1.2.840.10008.1.2.1"] }, MediaStorageSOPInstanceUID: { vr: "UI", Value: [sop] } },
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.7", SOPInstanceUID: sop, PatientName: "TEST^IO", Modality: "OT",
  });
  const back = io.naturalize(io.readFile(file.write()).dict);
  assertEquals(back.SOPInstanceUID, sop);
  assertEquals((back.PatientName as { Alphabetic?: string }[] | string | undefined) !== undefined, true);
  assertEquals(io.denaturalize({ Modality: "OT" })["00080060"].Value, ["OT"]);
  assertEquals(io.dicomLabToRgb([65535, 32896, 32896]).map((v) => Math.round(v * 100) / 100), [1, 1, 1]);
});

// DECIMALS KEEP THEIR EXPONENT. dcmjs 0.41 cut "3.5163338899999997e-10" to "3.51633388999999" -- an orientation
// component of 3.5 where the value is zero but for rounding -- found by dciodvfy on the first BIDS import, 2026-09-28.
// logic/dicom-io.ts formats every DS number itself (dsString) before dcmjs sees it.
Deno.test("DS numbers: at most 16 characters, exponent kept, value within the last digit", async () => {
  const { dsString } = await import("./dicom-io.ts");
  for (const x of [3.5163338899999997e-10, -1.4210854715202004e-14, 1.0000000088506624, -86.02871704101562, 0.30000000000000004, 1e21, -0.0000123456789, 0, -0]) {
    const s = dsString(x);
    assertEquals(s.length <= 16, true, `${x} -> "${s}" is ${s.length} characters`);
    assertEquals(/^[-+0-9.eE]+$/.test(s), true, `${s} holds a character DS does not allow`);
    const rel = x === 0 ? Math.abs(Number(s)) : Math.abs(Number(s) - x) / Math.abs(x);
    assertEquals(rel < 1e-9, true, `${x} -> ${s} (relative error ${rel})`);
  }
  // And through a whole write: the orientation read back is the one written.
  setDicomLibrary(dcmjs);
  const io = await dicomIO();
  const iop = [-0.9988157109931, 0.0454132697, -0.017458820386, -0.0454201933143, -0.9989679704772, 3.5163338899999997e-10];
  const bytes = io.toFile({
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.4", SOPInstanceUID: io.newUid(), ImageOrientationPatient: iop, PixelSpacing: [1.0000000077603204, 1],
    _meta: { TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" }, MediaStorageSOPClassUID: { Value: ["1.2.840.10008.5.1.4.1.1.4"], vr: "UI" }, MediaStorageSOPInstanceUID: { Value: ["1.2.3"], vr: "UI" } },
  }).write();
  const back = io.naturalize(io.readFile(bytes).dict) as { ImageOrientationPatient: number[] };
  back.ImageOrientationPatient.forEach((v, i) => assertEquals(Math.abs(Number(v) - iop[i]) < 1e-12, true, `IOP[${i}]: wrote ${iop[i]}, read ${v}`));
});

// ...and inside a one-item sequence given as a plain object, the form dcmjs's normalizer builds (critic 2026-09-28,
// finding 7: those were passed through untouched and dcmjs still cut them).
Deno.test("DS numbers inside an object-form sequence keep their exponent too", async () => {
  setDicomLibrary(dcmjs);
  const io = await dicomIO();
  const bytes = io.toFile({
    SOPClassUID: "1.2.840.10008.5.1.4.1.1.4.1", SOPInstanceUID: io.newUid(),
    SharedFunctionalGroupsSequence: { PixelMeasuresSequence: { SliceThickness: 3.5163338899999997e-10, PixelSpacing: [1, 1] } },
    _meta: { TransferSyntaxUID: { Value: ["1.2.840.10008.1.2.1"], vr: "UI" }, MediaStorageSOPClassUID: { Value: ["1.2.840.10008.5.1.4.1.1.4.1"], vr: "UI" }, MediaStorageSOPInstanceUID: { Value: ["1.2.3"], vr: "UI" } },
  }).write();
  const back = io.naturalize(io.readFile(bytes).dict) as { SharedFunctionalGroupsSequence: unknown };
  const sq = back.SharedFunctionalGroupsSequence as { PixelMeasuresSequence: { SliceThickness: number } | { SliceThickness: number }[] } | { PixelMeasuresSequence: { SliceThickness: number } }[];
  const item = Array.isArray(sq) ? sq[0] : sq;
  const pm = Array.isArray(item.PixelMeasuresSequence) ? item.PixelMeasuresSequence[0] : item.PixelMeasuresSequence;
  assertEquals(Math.abs(Number(pm.SliceThickness) - 3.5163338899999997e-10) < 1e-18, true, `read ${pm.SliceThickness}`);
});
