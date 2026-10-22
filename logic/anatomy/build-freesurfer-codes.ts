// Builds logic/anatomy/freesurfer-codes.json from freesurfer-codes.csv: the codes FreeSurfer's structures are written
// with in a DICOM SEG (Ron, 2026-10-20, on the FastSurfer results saying only "Anatomical structure": "can you do it at
// import time? We could work out the mapping as it is a one time thing").
//
// THE CSV IS THE RECORD, ONE ROW PER KIND OF STRUCTURE (left and right share it; the side is written as DICOM's
// laterality modifier): the code, its meaning, how close it is (exact / nearest / parent / none), where it came from
// (DICOM CID 7140 "Brain Structures for Volumetric Measurement", CID 7153, or SNOMED CT looked up on HL7's terminology
// server), a note, and `status`. ONLY ROWS MARKED `reviewed` ARE BUILT: a proposed code is not written into anyone's
// files until Ron has looked at it. To change one: edit the row, then
//   deno run -A logic/anatomy/build-freesurfer-codes.ts
// and rebuild. THE MEANING IS ALBULA'S NAME WHERE SNOMED HAS IT AS ONE OF THE CODE'S OWN NAMES (Ron, 2026-10-20:
// "precentral gyrus is preferred by me" -- SNOMED's display for 465006 is "Structure of ascending frontal gyrus", and
// "Precentral gyrus" is one of its descriptions; DICOM's Code Meaning may be any of a concept's names); else SNOMED's
// display. Inside the semantics line (Mike Halle's, CLAUDE.md): he is told the result (Ron, 2026-10-20: "having a
// solution and giving him the information might be more pragmatic").
const here = new URL(".", import.meta.url).pathname;
const text = await Deno.readTextFile(`${here}freesurfer-codes.csv`);
/** One CSV line into fields (quotes as in RFC 4180). */
function fields(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const [head, ...lines] = text.trim().split(/\r?\n/);
const cols = fields(head);
const at = (r: string[], c: string) => r[cols.indexOf(c)] ?? "";
const codes: Record<string, { code: string; meaning: string; match: string }> = {};
let proposed = 0;
for (const l of lines) {
  const r = fields(l);
  if (at(r, "status") !== "reviewed") { proposed++; continue; }
  if (!at(r, "code")) continue;   // reviewed as "none": the writer's generic code
  if (!/^[A-Za-z0-9_.-]+$/.test(at(r, "scheme")) || !/^[0-9A-Za-z.-]+$/.test(at(r, "code"))) throw new Error(`${at(r, "type")}: "${at(r, "scheme")}:${at(r, "code")}" is not a code`);
  codes[at(r, "type")] = { code: `${at(r, "scheme")}:${at(r, "code")}`, meaning: at(r, "meaning"), match: at(r, "match") };
}
await Deno.writeTextFile(`${here}freesurfer-codes.json`, JSON.stringify({ generatedBy: "logic/anatomy/build-freesurfer-codes.ts from freesurfer-codes.csv (reviewed rows only)", codes }, null, 1) + "\n");
console.log(`${Object.keys(codes).length} reviewed codes written; ${proposed} rows still proposed`);
