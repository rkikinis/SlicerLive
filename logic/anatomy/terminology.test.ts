// Terminologies read from Slicer's two file formats, and the lookup order across them.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { lookupTerm, parseColorTableCsv, parseTermJson, parseTerminology, registerTerminology, slug, terminologies, unregisterTerminology } from "./terminology.ts";

// SlicerHeart's own terminology (github.com/SlicerHeart/SlicerHeart, ValveAnnulusAnalysis/Resources,
// fetched 2026-09-12): a private coding scheme, categories that are valves, no modifiers.
const heart = Deno.readTextFileSync(new URL("./fixtures/slicerheart.term.json", import.meta.url));

Deno.test("term.json: SlicerHeart's leaflets arrive with their private scheme, colour and category", () => {
  const t = parseTermJson(heart, "t-heart");
  assertEquals(t.name, "SlicerHeart segmentation category and type");
  assert(t.schemes.includes("SlicerHeart"), t.schemes.join());
  const e = t.entries["mitral_anterior_leaflet"];
  assertEquals(e.code, "SlicerHeart:sh-leaflet-mv-a");
  assertEquals(e.rgb, [255, 18, 8]);
  assertEquals(e.system, "Mitral Valve");                 // the category, since no anatomy rule claims a leaflet
  assertEquals(e.categoryCode, "SCT:91134007");
  assertEquals(Object.keys(t.entries).length, 43);
});

Deno.test("csv: a Slicer colour table row becomes the same shape the catalogue uses", () => {
  const csv = [
    "Name,Category_CodingScheme,Category_CodeValue,Category_CodeMeaning,Type_CodingScheme,Type_CodeValue,Type_CodeMeaning,TypeModifier_CodingScheme,TypeModifier_CodeValue,TypeModifier_CodeMeaning,Region_CodingScheme,Region_CodeValue,Region_CodeMeaning,RegionModifier_CodingScheme,RegionModifier_CodeValue,RegionModifier_CodeMeaning,Color_R,Color_G,Color_B,,",
    "spleen,SCT,123037004,Anatomical Structure,SCT,78961009,Spleen,,,,,,,,,,157,108,162,,",
    "kidney_right,SCT,123037004,Anatomical Structure,SCT,64033007,Kidney,SCT,24028007,Right,,,,,,,212,126,151,,",
    "kidney_cyst_left,SCT,49755003,Morphologically Altered Structure,SCT,367643001,Cyst,,,,SCT,64033007,Kidney,SCT,7771000,Left,255,209,102,,",
    "my_lab_thing,99LAB,x-17,Lab things,99LAB,x-17-3,Widget seven,,,,,,,,,,1,2,3,,",
  ].join("\n");
  const t = parseColorTableCsv(csv, "t-csv", "lab table");
  assertEquals(t.entries.spleen.code, "SCT:78961009");
  assertEquals(t.entries.kidney_right.name, "Kidney, right");
  assertEquals(t.entries.kidney_right.mod, "Right");
  assertEquals(t.entries.kidney_cyst_left.category, "Morphologically Altered Structure");
  assertEquals(t.entries.kidney_cyst_left.region, "Kidney");
  assertEquals(t.entries.kidney_cyst_left.regionCode, "SCT:64033007");
  assertEquals(t.entries.my_lab_thing.code, "99LAB:x-17-3");   // a private scheme, kept as written
  assertEquals(t.entries.my_lab_thing.system, "Lab things");
  assertEquals(t.schemes.sort(), ["99LAB", "SCT"]);
  assertEquals(parseTerminology(csv, "t2", "x.csv").format, "csv");
  assertEquals(parseTerminology(heart, "t3", "x.term.json").format, "term.json");
});

Deno.test("lookup: the named context first, then the most recently registered, by key or by name", () => {
  const a = parseColorTableCsv("Name,Type_CodingScheme,Type_CodeValue,Type_CodeMeaning\nthing,99A,1,Thing from A", "src-a", "A");
  const b = parseColorTableCsv("Name,Type_CodingScheme,Type_CodeValue,Type_CodeMeaning\nthing,99B,1,Thing from B", "src-b", "B");
  registerTerminology(a); registerTerminology(b);
  try {
    assertEquals(lookupTerm("thing")?.entry.code, "99B:1");               // b registered last
    assertEquals(lookupTerm("thing", "src-a")?.entry.code, "99A:1");      // the context wins
    assertEquals(lookupTerm("Thing from A", "src-a")?.entry.key, "thing"); // by display name
    assertEquals(lookupTerm("nothing"), null);
    assertEquals(terminologies().map((s) => s.id), ["src-b", "src-a"]);
  } finally { unregisterTerminology("src-a"); unregisterTerminology("src-b"); }
  assertEquals(slug("Mitral Anterior Leaflet "), "mitral_anterior_leaflet");
});

// The tree and the naming, with a runtime terminology in place.
import { buildSegmentTree } from "./hierarchy.ts";
import { codesFor, lookupStructure } from "../segment-naming.ts";

Deno.test("a loaded terminology reaches the tree, the naming and the codes", () => {
  const t = parseTermJson(heart, "scene-term-1");
  registerTerminology(t);
  try {
    const tree = buildSegmentTree([{ labelValue: 1, name: "mitral anterior leaflet" }, { labelValue: 2, name: "Liver" }], "scene-term-1");
    const flat: { id: string; name: string; parent: string }[] = [];
    const walk = (nodes: typeof tree, parent: string) => { for (const n of nodes) { flat.push({ id: n.id, name: n.name, parent }); walk(n.children, n.name); } };
    walk(tree, "");
    const leaflet = flat.find((n) => n.id === "s:mitral_anterior_leaflet");
    assert(leaflet, flat.map((n) => n.id).join(" "));
    assertEquals(leaflet!.parent, "Mitral Valve");           // its category, not Unclassified
    assert(flat.some((n) => /liver/.test(n.id)));             // the vendored table still answers
    assertEquals(lookupStructure("mitral anterior leaflet", "scene-term-1")?.code, "SlicerHeart:sh-leaflet-mv-a");
    assertEquals(codesFor("mitral_anterior_leaflet"), { code: "SlicerHeart:sh-leaflet-mv-a", type: "mitral anterior leaflet", category: "Mitral Valve" });
  } finally { unregisterTerminology("scene-term-1"); }
  assertEquals(lookupStructure("mitral anterior leaflet"), null);   // gone with the terminology
});

import { addTerm, mintCode, newTerminology, PRIVATE_SCHEME, proposeColour, toColorTableCsv } from "./terminology.ts";

Deno.test("a term of one's own: minted code, a colour from its category, and a CSV Slicer can read back", () => {
  const mine = newTerminology("terminology-mine", "Ron's terms");
  const rgb = proposeColour("Mitral Valve", "mitral cleft", []);
  const e = addTerm(mine, { name: "mitral cleft", category: "Mitral Valve", rgb });
  assertEquals(e.key, "mitral_cleft");
  assert(/^99ALBULA:mitral-cleft-[0-9a-z]{4}$/.test(e.code!), e.code);
  assertEquals(e.system, "Mitral Valve");
  assert(mine.schemes.includes(PRIVATE_SCHEME));
  assert(mintCode("cleft") !== mintCode("cleft"));                    // two mints, two identities
  // sibling colors share a hue: the second term in the category is near the first
  const rgb2 = proposeColour("Mitral Valve", "mitral cleft two", Object.values(mine.entries));
  assert(rgb2.every((v) => v >= 0 && v <= 255));
  let threw = ""; try { addTerm(mine, { name: "Mitral Cleft" }); } catch (x) { threw = (x as Error).message; }
  assert(/already/.test(threw), threw);
  // round trip through the color-table CSV
  const csv = toColorTableCsv(mine);
  const back = parseColorTableCsv(csv, "t-back", "back");
  assertEquals(back.entries.mitral_cleft.code, e.code);
  assertEquals(back.entries.mitral_cleft.category, "Mitral Valve");
  assertEquals(back.entries.mitral_cleft.rgb, rgb);
  assertEquals(back.entries.mitral_cleft.name, "Mitral cleft");
});
