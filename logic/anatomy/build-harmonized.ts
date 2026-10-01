// Generates `harmonized.json` -- the label names five segmentation models write, each with the
// SNOMED CT concept the IDC harmonization work assigned to it, a readable display name, the
// segmenter's recommended color, and the anatomical system it files under.
//
// THE SOURCE. Giebeler, Krishnaswamy, Clunie et al., "Harmonizing segmentation outputs across AI
// models with standard terminologies", J. Med. Imaging 13(6), 062204 (2026), doi
// 10.1117/1.JMI.13.6.062204 -- Ron and Andrey Fedorov among the authors. Its mapping table is
// `Segmentation results harmonization/segment_snomed_mapping.xlsx` in
// github.com/ImagingDataCommons/segmentation-comparison (Apache-2.0), one sheet per model, reviewed
// by David Clunie. Ron, 2026-09-12: "ad fontes" -- this table is the source, and the one built from
// the Slicer extension (build-totalsegmentator.ts) is what one tool asserted before the review.
//
// PINNED. The workbook is read at the commit named below, never from `main`, so the catalog in
// the repository is reproducible: re-run with a newer commit on purpose, then read the diff.
//
//   deno run -A logic/anatomy/build-harmonized.ts                          # fetch at the pinned commits
//   deno run -A logic/anatomy/build-harmonized.ts <file.xlsx> [<moose.csv>] # or read local copies
//
// WHAT THE WORKBOOK DOES NOT HAVE. An AnatomicRegion for almost nothing (0 to 11 rows per sheet):
// the region a structure is IN is not something the harmonization set out to record. Albula's
// network browser filters by region, so a region per SNOMED concept is kept beside this table in
// `concept-regions.csv`, curated by Ron; this script seeds that file once from the name rules and
// afterwards only adds rows for concepts that are new, never touching a row a person has edited.
//
// FIVE OF THE SIX SHEETS. OMAS/CADS is not served by haversack, so it is not imported; the row
// below is the one place to add it when it is.
// SheetJS, version in deno.jsonc ("npm:xlsx"): 0.20.3 from SheetJS's own CDN since 2026-09-28 -- the npm package stopped at
// 0.18.5 (2022), which has public advisories (critic, 2026-09-28, finding 13). The output was checked unchanged.
import * as XLSX from "npm:xlsx";
import { displayName, systemOf, type System } from "./systems.ts";
import { REGIONS, regionsByNameRules, type Region } from "./regions.ts";

const SOURCE = {
  repo: "ImagingDataCommons/segmentation-comparison",
  path: "Segmentation results harmonization/segment_snomed_mapping.xlsx",
  commit: "d603de3dbbee1f4308b7386b64423020b7ec2205",
  committed: "2025-12-15",
  license: "Apache-2.0",
  paper: "10.1117/1.JMI.13.6.062204",
};

/**
 * MOOSE'S OWN MAPPING, which is newer than the workbook's moose sheet and wins over it.
 *
 * Andrey Fedorov, 2026-09-12, through Ron: "tell Claude to look at the mapping I contributed to
 * the Moose repo." It is `moosez/mappings/moose_snomed_mapping.csv` in ENHANCE-PET/MOOSE (his
 * commits of June-July 2026): 145 labels against the sheet's 128 -- the clin_ct_body parts, the
 * digestive organs, the fat classes, and the vertebrae under their singular names -- with codes
 * corrected since the sheet (gluteus maximus and minimus, carpus, metatarsal, the toes as Toe +
 * side) and the category as DICOM CID 7150 has it (91723000). Read at the commit below.
 */
const MOOSE_SOURCE = {
  repo: "ENHANCE-PET/MOOSE",
  path: "moosez/mappings/moose_snomed_mapping.csv",
  commit: "92c9f3d1",
  committed: "2026-07-07",
  license: "GPL-3.0",
};

/**
 * The sheets, in PRECEDENCE order: where two sheets name the same label, the first one's row is
 * kept and any disagreement about its code is reported under `conflicts`. TotalSegmentator 2.6 is
 * first because its label names are the ones every other model's were harmonized towards.
 */
const SHEETS: { sheet: string; model: string; tasks?: (row: Row) => string[] }[] = [
  // MOOSE's repository CSV first: it is the newest reviewed source (July 2026), and where it and
  // the TotalSegmentator sheet share a label (gluteus maximus, carpal, metatarsal, toes) its codes
  // are the ones DICOM's own context groups use (checked against fedorov/dcmterms, edition 2026c).
  // Andrey will revisit the TotalSegmentator sheets; when he has, the order may go back.
  { sheet: "moose (repository)", model: "moose", tasks: (r) => [String(r["model"] ?? "").trim()].filter(Boolean) },
  { sheet: "totalsegmentator v2.6", model: "ts", tasks: (r) => String(r["class_map"] ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
  { sheet: "totalsegmentator v2.0", model: "ts2.0" },
  { sheet: "moose", model: "moose", tasks: (r) => [String(r["Model"] ?? "").trim()].filter(Boolean) },
  { sheet: "auto3dseg", model: "auto3dseg" },
  { sheet: "multitalent", model: "multitalent" },
];

type Row = Record<string, string | number>;

/**
 * ERRATA IN THE SOURCE, corrected here and reported upstream rather than silently patched in the
 * JSON, which is regenerated. Found by diffing the workbook against the Slicer extension's table
 * on 2026-09-12; each entry says what the workbook has and what is written instead.
 */
const ERRATA: Record<string, { fix: Partial<Pick<HarmonizedStructure, "code" | "type" | "mod">>; why: string }> = {
  // The TotalSegmentator v2.6 sheet gives every RIGHT lateral-ventricle part the modifier Left
  // (7771000): ventricle_body_right, ventricle_frontal_horn_right, ventricle_occipital_horn_right,
  // ventricle_temporal_horn_right, ventricle_trigone_right. A SEG written from it would say the
  // right frontal horn is the left one.
  ...Object.fromEntries(["ventricle_body_right", "ventricle_frontal_horn_right", "ventricle_occipital_horn_right", "ventricle_temporal_horn_right", "ventricle_trigone_right"]
    .map((l) => [l, { fix: { mod: "Right" }, why: "workbook has TypeModifier Left on a _right label" }])),
  // The workbook's MOOSE sheet coded gluteus_minimus as gluteus medius; MOOSE's own CSV (above)
  // has it right and is read first, so no erratum is needed for it any more.
};

export interface HarmonizedStructure {
  name: string;
  system: System;
  /** `SCT:78961009` -- the harmonized type concept. */
  code?: string;
  /** The type concept's meaning, the key a left/right pair shares. */
  type?: string;
  mod?: string;
  rgb?: [number, number, number];
  /** The category concept's meaning when it is not the plain "Anatomical Structure". */
  category?: string;
  region?: string;
  regionMod?: string;
  /** `ts:total`, `moose/organs`, `auto3dseg` -- which model, and which of its tasks, writes this label. */
  models: string[];
}

/** A column by any of its spellings; the sheets are not consistent. */
function pick(row: Row, ...names: string[]): string {
  for (const n of names) {
    const v = row[n];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
/** Codes arrive as floats from the spreadsheet: 78961009.0. */
const codeText = (v: string) => v.replace(/\.0+$/, "");

/** The sheet's rows as objects; a duplicated header (v2.0's three `TypeModifier.CodeValue`) is renamed by position. */
function rows(ws: XLSX.WorkSheet): Row[] {
  const raw = XLSX.utils.sheet_to_json<(string | number)[]>(ws, { header: 1, defval: "" });
  const header = (raw[0] ?? []).map((h) => String(h));
  for (let i = 1; i < header.length; i++) {
    if (header[i] === "TypeModifier.CodeValue" && header[i - 1] === "Type.CodeMeaning") header[i] = "TypeModifier.CodingSchemeDesignator";
    if (header[i] === "TypeModifier.CodeValue" && header[i - 1] === "TypeModifier.CodeValue") header[i] = "TypeModifier.CodeMeaning";
  }
  return raw.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function parseRgb(row: Row): [number, number, number] | undefined {
  const r = pick(row, "recommendedDisplayRGBValue.R"), g = pick(row, "recommendedDisplayRGBValue.G"), b = pick(row, "recommendedDisplayRGBValue.B");
  if (r && g && b) return [Number(r), Number(g), Number(b)];
  const m = /\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(pick(row, "recommendedDisplayRGBValue"));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** A structure the name rules cannot file is filed by what SNOMED says it IS. */
function systemFromCategory(category: string): System | null {
  if (/morpholog|abnormal/i.test(category)) return "Findings";
  if (/physical object|device/i.test(category)) return "Devices";
  return null;
}

async function workbook(arg: string | undefined): Promise<XLSX.WorkBook> {
  if (arg) return XLSX.read(Deno.readFileSync(arg), { type: "buffer" });
  const url = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.commit}/${encodeURI(SOURCE.path)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: "buffer" });
}

/** MOOSE's CSV, from a local copy (second argument) or the pinned commit, as a sheet in the workbook. */
async function addMooseSheet(wb: XLSX.WorkBook, arg: string | undefined): Promise<void> {
  let text: string;
  if (arg) text = Deno.readTextFileSync(arg);
  else {
    const url = `https://raw.githubusercontent.com/${MOOSE_SOURCE.repo}/${MOOSE_SOURCE.commit}/${MOOSE_SOURCE.path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    text = await res.text();
  }
  const ws = XLSX.read(text, { type: "string" }).Sheets["Sheet1"];
  wb.Sheets["moose (repository)"] = ws;
  wb.SheetNames.push("moose (repository)");
}

// ---- concept-regions.csv: the curated part -------------------------------------------------

interface ConceptRow { code: string; meaning: string; regions: string; status: string; labels: string; note: string }
const CSV_HEADER = ["code", "meaning", "regions", "status", "labels", "note"] as const;

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function parseCsv(text: string): ConceptRow[] {
  const out: ConceptRow[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const f: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { f.push(cur); cur = ""; }
      else cur += c;
    }
    f.push(cur);
    out.push({ code: f[0] ?? "", meaning: f[1] ?? "", regions: f[2] ?? "", status: f[3] ?? "", labels: f[4] ?? "", note: f[5] ?? "" });
  }
  return out;
}

/** What the name rules say about a concept, from every label that maps to it AND from its meaning. */
function seedRegions(meaning: string, labels: string[]): { regions: Region[]; status: string } {
  const fromLabels = new Set<Region>();
  for (const l of labels) for (const r of regionsByNameRules(l)) fromLabels.add(r);
  const fromMeaning = new Set(regionsByNameRules(meaning.toLowerCase().replace(/\s+/g, "_")));
  const all = new Set<Region>([...fromLabels, ...fromMeaning]);
  const regions = REGIONS.filter((r) => all.has(r));
  if (!regions.length) return { regions, status: "needs a region" };
  const agree = fromMeaning.size === 0 || [...fromMeaning].every((r) => fromLabels.has(r));
  return { regions, status: regions.length > 1 || !agree ? "check" : "draft" };
}

if (import.meta.main) {
  const here = new URL(".", import.meta.url).pathname;
  const wb = await workbook(Deno.args[0]);
  await addMooseSheet(wb, Deno.args[1]);

  const structures: Record<string, HarmonizedStructure> = {};
  const conflicts: { label: string; kept: string; also: string }[] = [];
  const unclassified: string[] = [];
  const perSheet: string[] = [];

  for (const spec of SHEETS) {
    const ws = wb.Sheets[spec.sheet];
    if (!ws) throw new Error(`sheet "${spec.sheet}" not in the workbook; sheets are ${wb.SheetNames.join(", ")}`);
    let n = 0;
    for (const row of rows(ws)) {
      const label = pick(row, "label_name", "Name");
      if (!label || label === "background") continue;
      n++;
      const scheme = pick(row, "Type.CodingSchemeDesignator", "SegmentedPropertyTypeCodeSequence.CodingSchemeDesignator");
      const value = codeText(pick(row, "Type.CodeValue", "SegmentedPropertyTypeCodeSequence.CodeValue"));
      const type = pick(row, "Type.CodeMeaning", "SegmentedPropertyTypeCodeSequence.CodeMeaning");
      const mod = pick(row, "TypeModifier.CodeMeaning", "SegmentedPropertyTypeModifierCodeSequence.CodeMeaning");
      const category = pick(row, "Category.CodeMeaning", "SegmentedPropertyCategoryCodeSequence.CodeMeaning");
      const region = pick(row, "AnatomicRegion.CodeMeaning", "AnatomicRegionSequence.CodeMeaning");
      const regionMod = pick(row, "AnatomicRegionModifier.CodeMeaning", "AnatomicRegionModifierSequence.CodeMeaning");
      const code = scheme && value ? `${scheme}:${value}` : undefined;
      const tasks = spec.tasks?.(row) ?? [];
      const models = tasks.length ? tasks.map((t) => `${spec.model}${spec.model === "moose" ? "/" : ":"}${t}`) : [spec.model];

      const have = structures[label];
      // The workbook's moose sheet is superseded by MOOSE's own CSV wherever the two share a label;
      // its older code is not a conflict worth reporting.
      if (have && spec.sheet === "moose" && have.models.some((m) => m.startsWith("moose/"))) continue;
      if (have) {
        have.models.push(...models.filter((m) => !have.models.includes(m)));
        if (code && have.code && code !== have.code && !ERRATA[label]) conflicts.push({ label, kept: `${have.code} (${have.type})`, also: `${code} (${type}) in ${spec.sheet}` });
        if (!have.rgb) have.rgb = parseRgb(row);
        continue;
      }
      const system = systemOf(label) ?? systemFromCategory(category);
      if (!system) { unclassified.push(`${label} (${spec.sheet}: ${category} / ${type})`); continue; }
      const e = ERRATA[label];
      const fixed = { code, type, mod, ...(e?.fix ?? {}) };
      structures[label] = {
        name: displayName(label, fixed.type ?? "", fixed.mod ?? ""),
        system,
        ...(fixed.code ? { code: fixed.code } : {}),
        ...(fixed.type ? { type: fixed.type } : {}),
        ...(fixed.mod ? { mod: fixed.mod } : {}),
        ...(parseRgb(row) ? { rgb: parseRgb(row) } : {}),
        ...(category && !/^anatomical structure$/i.test(category) ? { category } : {}),
        ...(region ? { region } : {}),
        ...(regionMod ? { regionMod } : {}),
        models,
      };
    }
    perSheet.push(`  ${String(n).padStart(4)}  ${spec.sheet}`);
  }

  // Every distinct type concept, with the labels that map to it -- what the region table is keyed by.
  const concepts: Record<string, { meaning: string; labels: string[] }> = {};
  for (const [label, s] of Object.entries(structures)) {
    if (!s.code) continue;
    (concepts[s.code] ??= { meaning: s.type ?? s.name, labels: [] }).labels.push(label);
  }

  const outPath = `${here}harmonized.json`;
  const errata = Object.entries(ERRATA).map(([label, e]) => ({ label, ...e.fix, why: e.why }));
  Deno.writeTextFileSync(outPath, JSON.stringify({ source: SOURCE, mooseSource: MOOSE_SOURCE, generated: new Date().toISOString().slice(0, 10), structures, conflicts, errata }, null, 1) + "\n");

  // ---- the curated region table: seed once, then only add ----
  const csvPath = `${here}concept-regions.csv`;
  let existing: ConceptRow[] = [];
  try { existing = parseCsv(Deno.readTextFileSync(csvPath)); } catch { /* first run */ }
  const byCode = new Map(existing.map((r) => [r.code, r]));
  let added = 0;
  for (const [code, c] of Object.entries(concepts)) {
    if (byCode.has(code)) continue;
    const seed = seedRegions(c.meaning, c.labels);
    byCode.set(code, { code, meaning: c.meaning, regions: seed.regions.join("; "), status: seed.status, labels: c.labels.slice(0, 6).join(" "), note: "" });
    added++;
  }
  const sorted = [...byCode.values()].sort((a, b) => a.meaning.localeCompare(b.meaning));
  Deno.writeTextFileSync(csvPath, [CSV_HEADER.join(","), ...sorted.map((r) => CSV_HEADER.map((k) => csvField(r[k])).join(","))].join("\n") + "\n");

  // The JSON the application reads: code -> regions, only rows that name at least one.
  const regionsOut: Record<string, Region[]> = {};
  let unresolved = 0, reviewed = 0;
  for (const r of sorted) {
    const rs = r.regions.split(";").map((s) => s.trim()).filter(Boolean);
    const bad = rs.filter((s) => !(REGIONS as readonly string[]).includes(s));
    if (bad.length) throw new Error(`concept-regions.csv ${r.code} "${r.meaning}": unknown region "${bad.join('", "')}" -- the words are ${REGIONS.join(", ")}`);
    if (rs.length) regionsOut[r.code] = rs as Region[]; else unresolved++;
    if (r.status === "reviewed") reviewed++;
  }
  Deno.writeTextFileSync(`${here}concept-regions.json`, JSON.stringify(regionsOut, null, 1) + "\n");

  console.log(perSheet.join("\n"));
  console.log(`\n  ${Object.keys(structures).length} labels, ${Object.keys(concepts).length} SNOMED concepts, ${conflicts.length} code conflicts, ${unclassified.length} NOT classified`);
  for (const c of conflicts) console.log(`  conflict ${c.label}: kept ${c.kept}, also ${c.also}`);
  if (unclassified.length) console.log("  unclassified:", unclassified.join("; "));
  console.log(`\n  concept-regions.csv: ${sorted.length} concepts (${added} added this run), ${reviewed} reviewed, ${unresolved} with no region`);
}
