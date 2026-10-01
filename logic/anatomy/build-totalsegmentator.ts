// Generates `totalsegmentator.json` — the label names TotalSegmentator writes, each with a readable
// display name and the anatomical system it belongs to.
//
// WHY GENERATED AND VENDORED. The source is `totalsegmentator_snomed_mapping.csv`, shipped inside
// the TotalSegmentator Slicer extension: 413 label names with their SNOMED category/type/modifier
// and a recommended color. That file is authoritative and it is not ours to copy wholesale, but
// SlicerAlbula has to work with no Slicer installed and has to stay movable to another machine.
// So the mapping is derived here, once, into a small JSON that is committed.
//
// Re-run when a TotalSegmentator release adds structures:
//
//   deno run -A logic/anatomy/build-totalsegmentator.ts
//
// It finds the newest installed extension by itself and REPORTS anything it cannot classify rather
// than dropping it, because a silently unclassified structure would land in the wrong group with no
// sign that it had.
//
// The systems and the rules that file a label under one live in systems.ts, shared with
// build-harmonized.ts so both catalogs group the same way. On TA2: its identifiers are numeric,
// 6,158 of them are reachable through Wikidata property P7173 under CC0 (counted 2026-09-12), but
// only 4 of the 215 SNOMED concepts the harmonized mapping uses are linked from their SNOMED id
// there, so a mechanical SNOMED -> TA2 route does not exist; see concept-regions.csv for what was
// done instead.
import { displayName, SYSTEM_RULES as RULES, SYSTEMS, type System } from "./systems.ts";

function findCsv(): string {
  const apps = [...Deno.readDirSync("/Applications")]
    .filter((e) => e.name.startsWith("Slicer") && e.name.endsWith(".app"))
    .map((e) => `/Applications/${e.name}`)
    .sort()
    .reverse();
  for (const app of apps) {
    for (const ext of safeDirs(`${app}/Contents`)) {
      if (!ext.startsWith("Extensions-")) continue;
      const base = `${app}/Contents/${ext}/TotalSegmentator/lib`;
      for (const v of safeDirs(base)) {
        const p = `${base}/${v}/qt-scripted-modules/Resources/totalsegmentator_snomed_mapping.csv`;
        try {
          Deno.statSync(p);
          return p;
        } catch { /* keep looking */ }
      }
    }
  }
  throw new Error("no installed TotalSegmentator extension found; install it in Slicer and re-run");
}

const safeDirs = (p: string): string[] => {
  try {
    return [...Deno.readDirSync(p)].filter((e) => e.isDirectory).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Minimal CSV split: this file has no quoted commas, and asserting that is cheaper than a parser. */
function splitRow(line: string): string[] {
  if (line.includes('"')) throw new Error(`quoted field in CSV, needs a real parser: ${line}`);
  return line.split(",");
}

if (import.meta.main) {
  const csv = findCsv();
  const lines = Deno.readTextFileSync(csv).split(/\r?\n/).filter((l) => l.trim());
  const header = splitRow(lines[0]);
  const col = (n: string) => header.indexOf(n);
  const iName = col("Name"), iType = col("Type_CodeMeaning"), iMod = col("TypeModifier_CodeMeaning");
  const iR = col("Color_R"), iG = col("Color_G"), iB = col("Color_B");
  const iScheme = col("Type_CodingScheme"), iValue = col("Type_CodeValue");
  // The two fields that make the anatomical TREE derivable rather than hand-typed (hierarchy.ts).
  //
  // `mod` is Left/Right, so two labels sharing a type code and differing only in side are a PAIR --
  // `kidney_left` and `kidney_right` become one Kidney row with two children. `region` is how the
  // CSV states a FINDING's location: kidney_cyst_left is Category "Morphologically Altered
  // Structure", Type "Cyst", Region "Kidney", RegionModifier "Left" -- so a cyst already names the
  // organ it sits in, and hangs under it without anyone deciding where to put it. Ron: "it should be
  // a second qualifier. Kidney left cyst 1, kidney left cyst 2."
  const iRegion = col("Region_CodeMeaning"), iRegionMod = col("RegionModifier_CodeMeaning");

  const out: Record<string, {
    name: string;
    system: System;
    code?: string;
    rgb?: [number, number, number];
    /** The coded type MEANING, the key a pair shares ("Kidney" for both kidneys). */
    type?: string;
    /** "Left" | "Right" — laterality, which TA2 treats as a modifier rather than a separate structure. */
    mod?: string;
    /** For a finding: the structure it is IN, and on which side. */
    region?: string;
    regionMod?: string;
  }> = {};
  const unclassified: string[] = [];

  for (const line of lines.slice(1)) {
    const f = splitRow(line);
    const label = f[iName]?.trim();
    if (!label) continue;
    const rule = RULES.find(([re]) => re.test(label));
    if (!rule) {
      unclassified.push(label);
      continue;
    }
    // A BLANK color field is not black. Some rows carry no recommended color at all --
    // lung_airways, lung_arteries and their siblings -- and `Number("")` is 0, which passes
    // Number.isFinite, so an absent color became [0,0,0] and those structures would have imported
    // invisible. Worse than an arbitrary hue, and it would have looked like a rendering fault.
    const rawRgb = [f[iR], f[iG], f[iB]].map((v) => (v ?? "").trim());
    const rgb = rawRgb.every((v) => v !== "") ? rawRgb.map(Number) : [NaN];
    out[label] = {
      name: displayName(label, f[iType]?.trim() ?? "", f[iMod]?.trim() ?? ""),
      system: rule[1],
      ...(f[iScheme] && f[iValue] ? { code: `${f[iScheme]}:${f[iValue]}` } : {}),
      ...(rgb.length === 3 && rgb.every((v) => Number.isFinite(v)) ? { rgb: rgb as [number, number, number] } : {}),
      ...(f[iType]?.trim() ? { type: f[iType].trim() } : {}),
      ...(f[iMod]?.trim() ? { mod: f[iMod].trim() } : {}),
      ...(f[iRegion]?.trim() ? { region: f[iRegion].trim() } : {}),
      ...(f[iRegionMod]?.trim() ? { regionMod: f[iRegionMod].trim() } : {}),
    };
  }

  // CROSS-CHECK the rules against the segmenter's own SNOMED type meaning, which is an INDEPENDENT
  // signal: the rules read the label name, this reads the coded concept beside it. Only unambiguous
  // words are used -- "muscle" is a muscle wherever it is -- and a disagreement is reported rather
  // than resolved, because the rule is sometimes right (a tooth is coded as a tooth and still
  // belongs with the alimentary system by convention).
  // Ordered, first match wins: "Anterior vertebral muscle of neck" is a MUSCLE, and a skeletal
  // expectation matching "vertebral" would report a disagreement that is the check's own fault.
  const EXPECT: [RegExp, System][] = [
    [/muscle/i, "Muscular system"],
    [/blood vessel|artery|arteries|vein\b/i, "Cardiovascular system"],
    [/\bbone\b|vertebra|rib\b|clavicle|scapula|femur|tibia|fibula|humerus|sternum/i, "Skeletal system"],
    [/nerve|brain|spinal cord|cerebell/i, "Nervous system"],
  ];
  const disagreements: string[] = [];
  for (const line of lines.slice(1)) {
    const f = splitRow(line);
    const label = f[iName]?.trim();
    const meaning = f[iType]?.trim() ?? "";
    const got = out[label]?.system;
    if (!label || !got) continue;
    for (const [re, want] of EXPECT) {
      if (!re.test(meaning)) continue;
      if (got !== want) disagreements.push(`${label}: coded "${meaning}" but filed under ${got}, not ${want}`);
      break;   // first match wins, so a muscle is judged as a muscle and not also as a bone
    }
  }

  const counts = new Map<string, number>();
  for (const v of Object.values(out)) counts.set(v.system, (counts.get(v.system) ?? 0) + 1);
  for (const s of SYSTEMS) console.log(`  ${String(counts.get(s) ?? 0).padStart(4)}  ${s}`);
  console.log(`\n  ${Object.keys(out).length} classified, ${unclassified.length} NOT classified`);
  if (unclassified.length) console.log("  unclassified:", unclassified.join(", "));
  if (disagreements.length) {
    console.log(`\n  ${disagreements.length} DISAGREEMENT(S) with the segmenter's own coded meaning:`);
    for (const d of disagreements) console.log("    " + d);
    console.log("  Each is a rule to check, or a convention to note where the rule is right.");
  } else {
    console.log("  no disagreement with the segmenter's coded meanings");
  }

  const path = new URL("./totalsegmentator.json", import.meta.url).pathname;
  Deno.writeTextFileSync(path, JSON.stringify({ source: csv.split("/Contents/")[1], structures: out }, null, 1) + "\n");
  console.log(`\n  wrote ${path}`);
}
