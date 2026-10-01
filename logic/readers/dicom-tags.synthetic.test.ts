// THE HEADER RECORD ON THE VALUES dcmjs GOT WRONG (critic, 2026-09-25, findings 3, 4, 5, 12), in one small file DCMTK
// writes for the test, in implicit VR: a "US or SS" attribute that is signed (SmallestImagePixelValue, PixelPaddingValue
// with PixelRepresentation 1), ST text with backslashes and a space before one, a decimal string with a comma, and a
// UID with letters in it. Our record must say what DCMTK's dcm2json says, value for value. Ignored without DCMTK.
//   deno test -A --no-check logic/readers/dicom-tags.synthetic.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import dcmjs from "../dcmjs.ts";
import { toDicomJson } from "./dicom-tags.ts";

const ok = (cmd: string) => { try { return new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; } };
const HAS = ok("dump2dcm") && ok("dcm2json");

const DUMP = String.raw`(0008,0016) UI =CTImageStorage
(0008,0018) UI [1.2.826.0.1.3680043.2.1143.dccc9599abc]
(0008,0060) CS [CT]
(0008,2111) ST [dir C:\temp \ second part]
(0018,0050) DS [1,5]
(0020,000d) UI [1.2.826.0.1.3680043.2.1143.1]
(0020,000e) UI [1.2.826.0.1.3680043.2.1143.2]
(0028,0002) US 1
(0028,0004) CS [MONOCHROME2]
(0028,0010) US 2
(0028,0011) US 2
(0028,0100) US 16
(0028,0101) US 16
(0028,0102) US 15
(0028,0103) US 1
(0028,0106) SS -1024
(0028,0120) SS -2000
(0028,3010) SQ (Sequence with explicit length #=1)
  (fffe,e000) na (Item with explicit length #=2)
    (0028,3002) SS 4\-1024\16
    (0028,3006) OW 0000\0001\0002\0003
  (fffe,e00d) na (ItemDelimitationItem for re-encoding)
(fffe,e0dd) na (SequenceDelimitationItem for re-encod.)
(0060,3004) SS -1024
(0060,3006) SS 3071
(7fe0,0010) OW 0000\0000\0000\0000
`;

Deno.test({
  name: "implicit VR, signed US-or-SS, ST with backslashes, DS with a comma, a UID with letters: the record says what dcm2json says",
  ignore: !HAS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "albula-tags-" });
    try {
      await Deno.writeTextFile(`${dir}/ct.dump`, DUMP);
      const w = await new Deno.Command("dump2dcm", { args: ["+ti", "+E", `${dir}/ct.dump`, `${dir}/ct.dcm`], stdout: "null", stderr: "piped" }).output();
      assertEquals(w.success, true, new TextDecoder().decode(w.stderr));
      const j = await new Deno.Command("dcm2json", { args: [`${dir}/ct.dcm`], stdout: "piped", stderr: "null" }).output();
      const dcmtk = JSON.parse(new TextDecoder().decode(j.stdout)) as Record<string, { vr: string; Value?: unknown[] }>;
      const u = await Deno.readFile(`${dir}/ct.dcm`);
      const p = (dcmjs.data as unknown as { DicomMessage: { readFile(b: ArrayBuffer): { dict: never; meta: never } } }).DicomMessage
        .readFile(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer);
      const ours = toDicomJson(p.dict, p.meta) as Record<string, { vr: string; Value?: unknown[] }>;
      for (const tag of ["00280106", "00280120", "00082111", "00180050", "00080018", "00603004", "00603006"]) {
        assertEquals({ vr: ours[tag]?.vr, Value: ours[tag]?.Value }, { vr: dcmtk[tag].vr, Value: dcmtk[tag].Value }, tag);
      }
      // inside a sequence: the LUT descriptor (US or SS) and LUT Data (US or OW), as DCMTK writes them (night finding 9)
      type It = Record<string, { vr: string; Value?: unknown[]; InlineBinary?: string }>;
      const oi = (ours["00283010"].Value as It[])[0], di = (dcmtk["00283010"].Value as unknown as It[])[0];
      assertEquals({ vr: oi["00283002"].vr, Value: oi["00283002"].Value }, { vr: di["00283002"].vr, Value: di["00283002"].Value }, "LUT descriptor");
      assertEquals({ vr: oi["00283006"].vr, bin: oi["00283006"].InlineBinary }, { vr: di["00283006"].vr, bin: di["00283006"].InlineBinary }, "LUT data");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// THE READER on the same file, given image geometry: a thickness written "1,5" is not read as 15 mm (finding 5) --
// it is left unknown -- and the SOPInstanceUID with letters is the file's (finding 12).
Deno.test({
  name: "the reader: a slice thickness of \"1,5\" is not 15 mm, and a UID with letters is kept as written",
  ignore: !HAS,
  fn: async () => {
    const { parseInstances, setDcmjs } = await import("./dicom-series.ts");
    setDcmjs(dcmjs);
    const dir = await Deno.makeTempDir({ prefix: "albula-tags-" });
    try {
      const geometry = String.raw`(0020,0032) DS [0\0\0]
(0020,0037) DS [1\0\0\0\1\0]
(0028,0030) DS [0.5\0.5]
`;
      await Deno.writeTextFile(`${dir}/ct.dump`, DUMP.replace("(0028,0002)", geometry + "(0028,0002)"));
      const w = await new Deno.Command("dump2dcm", { args: ["+ti", "+E", `${dir}/ct.dump`, `${dir}/ct.dcm`], stdout: "null", stderr: "piped" }).output();
      assertEquals(w.success, true, new TextDecoder().decode(w.stderr));
      const u = await Deno.readFile(`${dir}/ct.dcm`);
      const [inst] = await parseInstances([u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer]);
      assertEquals(inst.sliceThickness, undefined);
      assertEquals(inst.sopInstanceUID, "1.2.826.0.1.3680043.2.1143.dccc9599abc");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
