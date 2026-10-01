/**
 * TERMINOLOGIES LOADED AT RUNTIME, beside the vendored ones.
 *
 * The catalog (catalogue.ts) is built once from sources that do not change between releases:
 * the harmonized mapping, MOOSE's CSV, the TotalSegmentator extension's table. That is right for
 * basic anatomy -- Ron: "once you are done mapping, you are done." It is wrong for a lab that adds
 * a term on Tuesday: SlicerHeart names leaflets and coaptation surfaces in its own coding scheme
 * (`SlicerHeart`, codes like `sh-leaflet-mv-a`), and ships four terminologies for four anatomical
 * variants of the same vessels. Those arrive as FILES, and the application has to read them.
 *
 * Two file formats, both Slicer's, both carrying the same information:
 *   - `.term.json` -- a terminology context: categories, each with types, each with modifiers,
 *     each entry a coded concept with a color. What the Terminologies module and every
 *     extension use (dcmqi's segment-context schema).
 *   - a color-table CSV -- one row per label: name, category, type, type modifier, region,
 *     region modifier, color. What the Colors module writes since 2025 and what the
 *     TotalSegmentator extension ships (`totalsegmentator_snomed_mapping.csv`).
 *
 * A loaded terminology is a `TerminologySource`: entries keyed by a label name, in the same shape
 * the catalog uses, so `lookupStructure` can consult it first. The registry here is in-memory;
 * livescene's TerminologyDisplayableManager fills it from `terminology` nodes, so a terminology in
 * the scene is in the session, saved and versioned with everything else.
 *
 * PRIVATE CODING SCHEMES ARE FIRST-CLASS. `SlicerHeart:sh-leaflet-mv-a` is as good a code here as
 * `SCT:10200004`. The scheme is whatever the file says; nothing is validated against a list.
 */
import type { CatalogueStructure } from "./catalogue.ts";

export interface TerminologyEntry extends CatalogueStructure {
  /** The key this entry answers to: the label a segmenter writes, or the meaning slugged. */
  key: string;
  /** Category, as a code, when the file carries one: `SCT:123037004`. */
  categoryCode?: string;
  /** Region, as a code, when the file carries one. */
  regionCode?: string;
}

export interface TerminologySource {
  /** Stable id; the scene node's id when the source came from the scene. */
  id: string;
  /** What to call it: the context name from the file, or the file name. */
  name: string;
  /** `term.json` | `csv` -- which parser read it. */
  format: "term.json" | "csv";
  /** Coding schemes seen in the entries, e.g. ["SlicerHeart", "SCT"]. */
  schemes: string[];
  entries: Record<string, TerminologyEntry>;
  /** By display name, lower-cased, for a label that arrives as a readable name. */
  byName: Record<string, string>;
  /** Made in the application (New term…): terms can be added to it and it can be exported. A loaded file is not. */
  editable?: boolean;
}

const sources = new Map<string, TerminologySource>();

/** Register (or replace) a terminology; later registrations are consulted first. */
export function registerTerminology(src: TerminologySource): void {
  sources.delete(src.id);
  sources.set(src.id, src);
}
export function unregisterTerminology(id: string): boolean { return sources.delete(id); }
export function terminologies(): TerminologySource[] { return [...sources.values()].reverse(); }
export function terminology(id: string): TerminologySource | undefined { return sources.get(id); }

/**
 * The entry for a label, from the named context first, then every registered terminology, most
 * recently registered first. Null when none knows it; the caller falls through to the catalog.
 */
export function lookupTerm(label: string, context?: string): { entry: TerminologyEntry; source: TerminologySource } | null {
  const raw = label.trim();
  const key = slug(raw);
  const order = context && sources.has(context) ? [sources.get(context)!, ...terminologies().filter((s) => s.id !== context)] : terminologies();
  for (const s of order) {
    const e = s.entries[raw] ?? s.entries[key] ?? (s.byName[raw.toLowerCase()] ? s.entries[s.byName[raw.toLowerCase()]] : undefined);
    if (e) return { entry: e, source: s };
  }
  return null;
}

/** `mitral anterior leaflet` -> `mitral_anterior_leaflet`; what a segmenter would write. */
export function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ---- .term.json --------------------------------------------------------------------------------

interface Coded { CodingSchemeDesignator?: string; CodeValue?: string; CodeMeaning?: string; recommendedDisplayRGBValue?: number[]; "3dSlicerLabel"?: string }
interface TermType extends Coded { Modifier?: Coded[] }
interface TermCategory extends Coded { Type?: TermType[] }

const codeOf = (c: Coded | undefined): string | undefined =>
  c?.CodingSchemeDesignator && c.CodeValue ? `${c.CodingSchemeDesignator}:${c.CodeValue}` : undefined;
const rgbOf = (c: Coded | undefined): [number, number, number] | undefined =>
  Array.isArray(c?.recommendedDisplayRGBValue) && c!.recommendedDisplayRGBValue!.length === 3 ? [c!.recommendedDisplayRGBValue![0], c!.recommendedDisplayRGBValue![1], c!.recommendedDisplayRGBValue![2]] : undefined;

/**
 * Read a Slicer terminology context. Every type becomes an entry; a type with modifiers becomes
 * one entry per modifier as well (`kidney_left`), the way a segmenter would write them. The
 * category's meaning is the entry's `system` unless a rule in systems.ts claims the name, so a
 * SlicerHeart leaflet files under "Mitral Valve" in the tree rather than under nothing.
 */
export function parseTermJson(text: string, id: string, fallbackName = "terminology"): TerminologySource {
  const doc = JSON.parse(text) as { SegmentationCategoryTypeContextName?: string; SegmentationCodes?: { Category?: TermCategory[] } };
  const name = doc.SegmentationCategoryTypeContextName ?? fallbackName;
  const src: TerminologySource = { id, name, format: "term.json", schemes: [], entries: {}, byName: {} };
  const schemes = new Set<string>();
  for (const cat of doc.SegmentationCodes?.Category ?? []) {
    const category = cat.CodeMeaning ?? "";
    for (const t of cat.Type ?? []) {
      const meaning = t.CodeMeaning ?? "";
      if (!meaning) continue;
      if (t.CodingSchemeDesignator) schemes.add(t.CodingSchemeDesignator);
      const base: Omit<TerminologyEntry, "key" | "name"> = {
        system: category || "Other",
        ...(codeOf(t) ? { code: codeOf(t) } : {}),
        type: meaning,
        ...(rgbOf(t) ? { rgb: rgbOf(t) } : {}),
        ...(category && !/^anatomical structure$/i.test(category) ? { category } : {}),
        ...(codeOf(cat) ? { categoryCode: codeOf(cat) } : {}),
      };
      const key = t["3dSlicerLabel"] || slug(meaning);
      add(src, { ...base, key, name: meaning });
      for (const m of t.Modifier ?? []) {
        const mod = m.CodeMeaning ?? "";
        if (!mod) continue;
        add(src, { ...base, key: `${key}_${slug(mod)}`, name: `${meaning}, ${mod.toLowerCase()}`, mod, ...(rgbOf(m) ? { rgb: rgbOf(m) } : {}) });
      }
    }
  }
  src.schemes = [...schemes];
  return src;
}

function add(src: TerminologySource, e: TerminologyEntry): void {
  src.entries[e.key] = e;
  src.byName[e.name.toLowerCase()] = e.key;
}

// ---- color-table CSV --------------------------------------------------------------------------

/** Minimal CSV: quoted fields with doubled quotes, no newlines inside fields. */
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { f.push(cur); cur = ""; }
      else cur += c;
    }
    f.push(cur);
    out.push(f);
  }
  return out;
}

/**
 * Read a Slicer color-table CSV: `Name, Category_*, Type_*, TypeModifier_*, Region_*,
 * RegionModifier_*, Color_R, Color_G, Color_B` (the `*` being CodingScheme, CodeValue,
 * CodeMeaning), an optional `LabelValue`. Column order is read from the header, not assumed.
 */
export function parseColorTableCsv(text: string, id: string, name: string): TerminologySource {
  const rows = csvRows(text);
  if (!rows.length) throw new Error("empty color table");
  const hdr = rows[0].map((h) => h.trim());
  const col = (n: string) => hdr.indexOf(n);
  const get = (r: string[], n: string) => { const i = col(n); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const iName = col("Name") >= 0 ? col("Name") : col("label_name");
  if (iName < 0) throw new Error(`not a color table: no Name column (columns: ${hdr.slice(0, 6).join(", ")}…)`);
  const src: TerminologySource = { id, name, format: "csv", schemes: [], entries: {}, byName: {} };
  const schemes = new Set<string>();
  for (const r of rows.slice(1)) {
    const key = (r[iName] ?? "").trim();
    if (!key || key.toLowerCase() === "background") continue;
    const scheme = get(r, "Type_CodingScheme"), value = get(r, "Type_CodeValue"), type = get(r, "Type_CodeMeaning");
    const mod = get(r, "TypeModifier_CodeMeaning"), category = get(r, "Category_CodeMeaning");
    const catScheme = get(r, "Category_CodingScheme"), catValue = get(r, "Category_CodeValue");
    const region = get(r, "Region_CodeMeaning"), regionMod = get(r, "RegionModifier_CodeMeaning");
    const regScheme = get(r, "Region_CodingScheme"), regValue = get(r, "Region_CodeValue");
    const rr = get(r, "Color_R"), gg = get(r, "Color_G"), bb = get(r, "Color_B");
    if (scheme) schemes.add(scheme);
    const display = type ? (mod ? `${type}, ${mod.toLowerCase()}` : type) : key.replace(/_/g, " ");
    add(src, {
      key, name: display.charAt(0).toUpperCase() + display.slice(1),
      system: category && !/^anatomical structure$/i.test(category) ? category : "Other",
      ...(scheme && value ? { code: `${scheme}:${value}` } : {}),
      ...(type ? { type } : {}),
      ...(mod ? { mod } : {}),
      ...(category && !/^anatomical structure$/i.test(category) ? { category } : {}),
      ...(catScheme && catValue ? { categoryCode: `${catScheme}:${catValue}` } : {}),
      ...(region ? { region } : {}),
      ...(regionMod ? { regionMod } : {}),
      ...(regScheme && regValue ? { regionCode: `${regScheme}:${regValue}` } : {}),
      ...(rr && gg && bb ? { rgb: [Number(rr), Number(gg), Number(bb)] as [number, number, number] } : {}),
    });
  }
  src.schemes = [...schemes];
  return src;
}

/** Read whichever of the two a file is, by its content. */
export function parseTerminology(text: string, id: string, fileName: string): TerminologySource {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return parseTermJson(text, id, fileName.replace(/\.term\.json$|\.json$/i, ""));
  return parseColorTableCsv(text, id, fileName.replace(/\.csv$/i, ""));
}

// ---- terms a person adds -----------------------------------------------------------------------

/**
 * THE APPLICATION'S OWN CODING SCHEME. DICOM reserves designators beginning with "99" for private
 * schemes (PS3.16 §8); this is Albula's. A term minted here is a stable identity -- the code never
 * changes once written, whatever the name becomes -- in a scheme that says plainly it is nobody's
 * standard. Ron, on the Colors module: it is unfriendly exactly here, where a person has to know
 * what a coding scheme designator is before they can add a term; this decides it for them.
 */
export const PRIVATE_SCHEME = "99ALBULA";

/** An empty terminology of the person's own, ready to take terms. */
export function newTerminology(id: string, name: string): TerminologySource & { editable: true } {
  return { id, name, format: "csv", schemes: [PRIVATE_SCHEME], entries: {}, byName: {}, editable: true };
}

/** `mitral cleft` -> `mitral-cleft-k7f3`: the slug plus four random base-36 characters, so two people adding "cleft" do not mint the same code. */
export function mintCode(name: string): string {
  const tail = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");
  return `${PRIVATE_SCHEME}:${slug(name).replace(/_/g, "-") || "term"}-${tail}`;
}

/**
 * Add a term. The key is the slug of the name, as a segmenter would write it; the code is minted
 * unless the caller brings one (a term copied from elsewhere keeps its identity). The category is
 * the group it files under in the tree.
 */
export function addTerm(src: TerminologySource, t: { name: string; category?: string; rgb?: [number, number, number]; code?: string }): TerminologyEntry {
  const name = t.name.trim();
  if (!name) throw new Error("a term needs a name");
  const key = slug(name);
  if (src.entries[key]) throw new Error(`"${name}" is already in ${src.name}`);
  const category = (t.category ?? "").trim();
  const e: TerminologyEntry = {
    key, name,
    system: category || "Other",
    code: t.code ?? mintCode(name),
    type: name,
    ...(category && !/^anatomical structure$/i.test(category) ? { category } : {}),
    ...(t.rgb ? { rgb: t.rgb } : {}),
  };
  add(src, e);
  const scheme = e.code!.slice(0, e.code!.indexOf(":"));
  if (!src.schemes.includes(scheme)) src.schemes.push(scheme);
  return e;
}

/** A color for a new term: the category's hue, varied by the name, so siblings read as a family. */
export function proposeColour(category: string, name: string, existing: readonly TerminologyEntry[]): [number, number, number] {
  const sib = existing.find((e) => e.category === category && e.rgb);
  const h = sib ? hueOf(sib.rgb!) : (hash(category || name) % 360);
  const k = hash(name);
  const s = 0.55 + (k % 30) / 100, l = 0.45 + ((k >> 5) % 20) / 100;
  return hsl(h + ((k >> 10) % 40) - 20, s, l);
}
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
function hueOf([r, g, b]: readonly [number, number, number]): number {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (!d) return 0;
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return ((h * 60) + 360) % 360;
}
function hsl(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * The terminology as a Slicer color-table CSV -- the file the Colors module reads and writes, so
 * a terminology made here goes into Slicer, into a spreadsheet, and into git as text.
 */
export function toColorTableCsv(src: TerminologySource): string {
  const cols = ["Name", "Category_CodingScheme", "Category_CodeValue", "Category_CodeMeaning", "Type_CodingScheme", "Type_CodeValue", "Type_CodeMeaning",
    "TypeModifier_CodingScheme", "TypeModifier_CodeValue", "TypeModifier_CodeMeaning", "Region_CodingScheme", "Region_CodeValue", "Region_CodeMeaning",
    "RegionModifier_CodingScheme", "RegionModifier_CodeValue", "RegionModifier_CodeMeaning", "Color_R", "Color_G", "Color_B"];
  const q = (v: string | number | undefined) => { const s = v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const split = (code?: string): [string, string] => { const i = code?.indexOf(":") ?? -1; return i < 0 ? ["", ""] : [code!.slice(0, i), code!.slice(i + 1)]; };
  const MOD: Record<string, string> = { Left: "7771000", Right: "24028007" };
  const rows = [cols.join(",")];
  for (const e of Object.values(src.entries)) {
    const [cs, cv] = split(e.categoryCode ?? (e.category ? undefined : "SCT:91723000"));
    const [ts, tv] = split(e.code);
    const [rs, rv] = split(e.regionCode);
    rows.push([e.key, cs, cv, e.category ?? (cv ? "Anatomical Structure" : ""), ts, tv, e.type ?? e.name,
      e.mod ? "SCT" : "", e.mod ? MOD[e.mod] ?? "" : "", e.mod ?? "", rs, rv, e.region ?? "", "", "", e.regionMod ?? "",
      e.rgb?.[0], e.rgb?.[1], e.rgb?.[2]].map(q).join(","));
  }
  return rows.join("\n") + "\n";
}
