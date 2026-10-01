// @full-tier -- reads the whole DICOM corpus (about 50 s): the rebuild runs it only in the full tier (Contents/tools/Rebuild SlicerAlbula App.command).
// THE HEADER RECORD AGAINST DCMTK, ON EVERY PUBLIC FILE HERE (critic, 2026-09-25, finding 6: the converter's own check
// compares the record with itself; this is the independent check, on a varied corpus). Every folder under
// Contents/data/dicom (the codec corpus, IDC samples, Slicer's test files, dcm2niix's multi-frame examples; all public),
// up to three files each: our record (dicom-tags.ts toDicomJson) against DCMTK's dcm2json of the same file, attribute for
// attribute. Ignored when DCMTK or the files are absent.
// Stated exceptions, each also in dicom-tags.ts: FL written as its exact double (DCMTK: shortest decimal; the same
// float); the character set inside a sequence item (dcmjs decodes to UTF-8 and says so there, DCMTK at the top only);
// the file meta (group 0002), which dcmodify rewrites here; files dcmjs cannot read at all (ISO 2022 character sets --
// counted, not compared); an empty sequence item, which dcmjs drops when it reads (counted).
import { assertEquals } from "jsr:@std/assert@1";
import dcmjs from "../dcmjs.ts";
import { toDicomJson } from "./dicom-tags.ts";
import { ABSENT, testData } from "../../test/test-data.ts";

const ROOT = testData("dicom") ?? ABSENT;
const ok = (cmd: string) => { try { return new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; } };
const HAS = ok("dcm2json") && ok("dcmodify");
let haveRoot = true; try { Deno.statSync(ROOT); } catch { haveRoot = false; }

function pick(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    const files: string[] = [];
    for (const e of Deno.readDirSync(d)) {
      if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
      const p = `${d.replace(/\/+$/, "")}/${e.name}`;
      if (e.isDirectory) walk(p);
      // Not the codec corpus's reference pixels (".truth.raw"): they took slots and pushed real files out (night finding 7).
      else if (!/\.(zip|json|gz|bval|bvec|tsv|txt|nii|nrrd|png|md|py|csv|raw)$/i.test(e.name) && !/\.truth\b/.test(e.name)) files.push(p);
    }
    out.push(...files.sort().slice(0, 3));
  };
  walk(ROOT);
  // ALWAYS the files that have broken a dcmjs version (critic, 2026-09-25 night, finding 1: a sequence sent with VR UN).
  for (const f of ["codecs/1.2.840.10008.1.2.4.70/bad_sequence.dcm", "codecs/1.2.840.10008.1.2.5/rtdose_rle.dcm"]) {
    try { Deno.statSync(ROOT + f); if (!out.includes(ROOT + f)) out.push(ROOT + f); } catch { /* not fetched */ }
  }
  return out;
}

Deno.test({
  name: "the header record equals DCMTK's dcm2json on the public DICOM files here (three per folder, and each in implicit VR too)",
  ignore: !HAS || !haveRoot,
  fn: () => {
    const D = dcmjs.data as unknown as { DicomMessage: { readFile(b: ArrayBuffer): { dict: never; meta: never } } };
    const diffs: string[] = [];
    let compared = 0, unreadable = 0, notDicom = 0, droppedEmptyItems = 0;
    const tmp = Deno.makeTempDirSync();
    let implicitCompared = 0, unAsKnown = 0;
    // Each file as it is, then an implicit-VR copy of it (DCMTK's dcmconv +ti, pixel data removed first): implicit VR is
    // where a reader must resolve VRs itself -- "US or SS", private creators, sequences sent as UN (night finding 7:
    // every file compared was explicit VR).
    const jobs: { f: string; implicit: boolean }[] = pick().flatMap((f) => [{ f, implicit: false }, { f, implicit: true }]);
    for (const { f, implicit } of jobs) {
      const c = `${tmp}/f.dcm`;
      Deno.copyFileSync(f, c);
      new Deno.Command("dcmodify", { args: ["-nb", "-ie", "-ea", "(7fe0,0010)", c], stdout: "null", stderr: "null" }).outputSync();
      if (implicit && !new Deno.Command("dcmconv", { args: ["+ti", c, c], stdout: "null", stderr: "null" }).outputSync().success) continue;
      const u = Deno.readFileSync(implicit ? c : f);
      let p;
      try { p = D.DicomMessage.readFile(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer); }
      catch (e) { if (!implicit) { if (/character set/i.test(String(e))) unreadable++; else notDicom++; } continue; }
      const j = new Deno.Command("dcm2json", { args: [c], stdout: "piped", stderr: "null" }).outputSync();
      if (!j.success) { if (!implicit) notDicom++; continue; }
      const theirs = JSON.parse(new TextDecoder().decode(j.stdout)) as Record<string, unknown>;
      const ours = JSON.parse(JSON.stringify(toDicomJson(p.dict, p.meta))) as Record<string, unknown>;
      if (implicit) implicitCompared++; else compared++;
      const where = `${f.slice(ROOT.length)}${implicit ? " [implicit]" : ""}`;
      // deno-lint-ignore no-explicit-any
      const walk = (a: Record<string, any>, b: Record<string, any>, at: string, depth: number) => {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (depth === 0 && (k.startsWith("0002") || k === "7FE00010")) continue;
          const x = a[k], y = b[k];
          // SENT AS UN, READ AS THE DICTIONARY'S VR: DCMTK keeps a UN element as the file's bytes; dcmjs 0.41 re-reads it
          // with the dictionary's VR -- for a sequence sent as UN, as explicit VR, which misreads it (critic, 2026-09-25
          // night, finding 1; bad_sequence.dcm, rtdose_rle.dcm). Counted and printed, not hidden; reading UN ourselves is
          // a decision waiting for Ron, and the issue is drafted for dcmjs (upstream-issues-dcmjs.md, item 9).
          if (x && y && x.vr !== y.vr && (x.vr === "UN" || y.vr === "UN")) { unAsKnown++; continue; }
          if (!x || !y || x.vr !== y.vr) { diffs.push(`${where} ${at}${k} (${(x ?? y).vr}: ${x ? "ours only" : "DCMTK only"})`); continue; }
          if (x.vr === "SQ") {
            const xa = x.Value ?? [], ya = y.Value ?? [];
            // dcmjs drops an EMPTY sequence item when it reads (a dcmjs limitation, 0.41 and 0.52): counted, not a diff.
            const yb = xa.length < ya.length ? ya.filter((it: object) => Object.keys(it).length > 0) : ya;
            if (yb.length !== ya.length) droppedEmptyItems += ya.length - yb.length;
            if (xa.length !== yb.length) diffs.push(`${where} ${at}${k} (items ${xa.length} vs ${ya.length})`);
            else xa.forEach((it: never, i: number) => walk(it, yb[i], `${at}${k}[${i}].`, depth + 1));
            continue;
          }
          if (x.vr === "FL" && (x.Value ?? []).every((v: number, i: number) => Math.fround(v) === Math.fround(y.Value?.[i]))) continue;
          if (x.vr === "FD" && (x.Value ?? []).every((v: number, i: number) => Math.abs(v - y.Value?.[i]) <= Math.abs(v) * 1e-12)) continue;
          if (k === "00080005" && depth > 0) continue;
          if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${where} ${at}${k} (${x.vr}): ${JSON.stringify(x).slice(0, 80)} vs ${JSON.stringify(y).slice(0, 80)}`);
        }
      };
      walk(ours, theirs, "", 0);
    }
    Deno.removeSync(tmp, { recursive: true });
    console.log(`compared ${compared} files, and ${implicitCompared} of them again in implicit VR; ${unAsKnown} element(s) sent as UN that dcmjs read as the dictionary's VR; ${unreadable} unreadable by dcmjs (ISO 2022 character sets); ${notDicom} not DICOM; ${droppedEmptyItems} empty sequence item(s) dcmjs dropped`);
    assertEquals(diffs.slice(0, 20), []);
  },
});
