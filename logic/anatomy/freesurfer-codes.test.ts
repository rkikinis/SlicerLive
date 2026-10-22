// THE CODES FREESURFER'S STRUCTURES ARE WRITTEN WITH (freesurfer-codes.csv; Ron, 2026-10-20). The table is complete --
// one row for every kind of structure FreeSurfer's table names -- and only reviewed rows reach the app.
//   deno test -A --no-check logic/anatomy/freesurfer-codes.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import freesurfer from "./freesurfer.json" with { type: "json" };
import built from "./freesurfer-codes.json" with { type: "json" };
import { codesFor, freesurferStructureFor, lookupStructure } from "../segment-naming.ts";

const csv = Deno.readTextFileSync(new URL("./freesurfer-codes.csv", import.meta.url));
const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(",")[0]);

Deno.test("every kind of FreeSurfer structure has exactly one row", () => {
  const kinds = new Set(Object.values(freesurfer.structures as Record<string, { type?: string }>).map((v) => v.type ?? ""));
  assertEquals([...kinds].filter((k) => !rows.includes(k)), []);
  assertEquals(rows.filter((r, i) => rows.indexOf(r) !== i), []);
});

Deno.test("a reviewed code reaches the SEG writer, with its own meaning and the side", () => {
  const codes = (built as { codes: Record<string, { code: string; meaning: string }> }).codes;
  const reviewed = Object.entries(codes)[0];
  if (!reviewed) return;   // nothing reviewed yet: nothing to reach the writer
  const [type, c] = reviewed;
  const st = Object.values(freesurfer.structures as Record<string, { type?: string; name: string; mod?: string }>).find((v) => v.type === type)!;
  const out = codesFor(st.name);
  assertEquals(out.code, c.code);
  assertEquals(out.type, c.meaning);
  assertEquals(out.mod, st.mod);
});

Deno.test("EVERY FreeSurfer label value is coded from FreeSurfer's own entry, by its key (critic 2026-10-20, finding 6)", () => {
  const codes = (built as { codes: Record<string, { code: string; meaning: string }> }).codes;
  const structures = freesurfer.structures as Record<string, { type?: string; mod?: string; freesurfer?: string }>;
  const wrong: string[] = [];
  for (const [value, key] of Object.entries(freesurfer.byLabel as Record<string, string>)) {
    const st = lookupStructure(key);
    // The entry found by the key is FreeSurfer's (it names its FreeSurfer label), and is the one the label value names.
    if (st?.key !== key || (st as { freesurfer?: string }).freesurfer !== structures[key].freesurfer) { wrong.push(`${value} ${key}: found ${st?.key ?? "nothing"}`); continue; }
    if (freesurferStructureFor(Number(value))?.key !== key) wrong.push(`${value} ${key}: the label value names another`);
    const reviewed = codes[structures[key].type ?? ""], out = codesFor(key);
    if (reviewed && out.code !== reviewed.code && !(st as { origin?: string }).origin?.startsWith("asserted")) wrong.push(`${value} ${key}: coded ${out.code}, reviewed ${reviewed.code}`);
    if ((out.mod ?? "") !== (structures[key].mod ?? "")) wrong.push(`${value} ${key}: side ${out.mod} not ${structures[key].mod}`);
  }
  assertEquals(wrong, []);
  // The four the critic found: by key they are FreeSurfer's, whatever the names say.
  for (const v of [14, 15, 16, 72]) assertEquals(!!(lookupStructure(freesurferStructureFor(v)!.key) as { freesurfer?: string }).freesurfer, true);
});
