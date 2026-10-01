// EVERY COLLAPSED GROUP MUST BE TELLABLE FROM EVERY OTHER.
//
// Ron asked for a collapsed branch to repaint its structures as one color. That is only useful if
// two collapsed branches on screen are different colors -- and the first attempt, lightening the
// system color by tree depth, put "Left ribs" and "Right ribs" 3.5 ΔE apart. Below ~9 a person
// cannot tell two colors apart, and left-versus-right is the distinction Ron is least willing to
// leave ambiguous.
//
// So the spread is measured here against the same ΔE the segment palette repair uses, rather than
// eyeballed once and assumed to hold as groups are added.
import { assert, assertEquals } from "jsr:@std/assert";
import { allGroupIds, arbitraryGroupColours, buildAnatomyTree, groupColour } from "./hierarchy.ts";
import { deltaE, SAME_COLOUR } from "../segment-colours.ts";

const c255 = (c: [number, number, number]): [number, number, number] => [c[0] * 255, c[1] * 255, c[2] * 255];

Deno.test("every group has a colour", () => {
  const missing = allGroupIds().filter((id) => !groupColour(id));
  assert(missing.length === 0, `groups with no colour: ${missing.join(", ")}`);
});

// PER CATALOG, not across all 81 groups. A pastel band (S <= .46, L .56-.90) simply does not hold
// 81 colors that are 9 ΔE apart, and it does not need to: what has to be tellable is the groups
// that appear TOGETHER in one segmentation. Asserting the global property failed with eight pairs,
// all of them meninges and ventricle walls -- groups no single run puts on screen beside each other.
async function groupsOf(file: string): Promise<string[]> {
  const cat = JSON.parse(await Deno.readTextFile(new URL(file, import.meta.url)));
  const keys: string[] = Array.isArray(cat) ? cat.map((x) => x.key ?? x.name) : Object.keys(cat.structures ?? cat);
  const ids = new Set<string>();
  const walk = (n: { id: string; children: unknown[] }) => {
    if (n.children.length && n.id.startsWith("g:")) ids.add(n.id);
    for (const c of n.children) walk(c as { id: string; children: unknown[] });
  };
  for (const n of buildAnatomyTree(keys)) walk(n as { id: string; children: unknown[] });
  return [...ids];
}

Deno.test("FreeSurfer's arbitrary palette tells apart every group one run shows", async () => {
  const ids = await groupsOf("./freesurfer.json");
  const pal = arbitraryGroupColours(ids);
  const key = (id: string) => (id.startsWith("g:") ? id.slice(2) : id).split("@")[0];
  const bad: string[] = [];
  let worst = Infinity, wp = "";
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (key(ids[i]) === key(ids[j])) continue;
      const d = deltaE(c255(pal.get(key(ids[i]))!), c255(pal.get(key(ids[j]))!));
      if (d < worst) { worst = d; wp = `${ids[i]} vs ${ids[j]}`; }
      if (d < SAME_COLOUR) bad.push(`${ids[i]} vs ${ids[j]} (ΔE ${d.toFixed(1)})`);
    }
  }
  console.log(`freesurfer: ${ids.length} groups · closest ${wp} = ΔE ${worst.toFixed(1)}`);
  assert(bad.length === 0, `indistinguishable:\n  ${bad.join("\n  ")}`);
});

// Ron: "it's ok to have ribs on both side the same color. It's actually better." A hue that differed
// by side would have had to stop being bone in order to say so.
Deno.test("both sides of a region are the SAME colour", () => {
  const sided = allGroupIds().filter((id) => /left/i.test(id));
  let checked = 0;
  for (const l of sided) {
    const r = l.replace(/left/i, (m) => (m === "Left" ? "Right" : "right"));
    const cr = groupColour(r);
    if (!cr) continue;
    checked++;
    assertEquals(groupColour(l), cr, `${l} and ${r} should be the same colour`);
  }
  // And a side qualifier on ONE group id resolves to the base group, not to nothing.
  assertEquals(groupColour("g:upper-limb@left"), groupColour("g:upper-limb"));
  console.log(`checked ${checked} left/right group pairs`);
});

// Ron: "colors never fully saturated. Pick a pleasant pastel."
Deno.test("every tissue colour is a pastel", () => {
  const bad: string[] = [];
  for (const id of allGroupIds()) {
    const c = groupColour(id)!;
    const mx = Math.max(...c), mn = Math.min(...c), l = (mx + mn) / 2, d = mx - mn;
    const sat = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (sat > 0.46 || l < 0.55 || l > 0.91) bad.push(`${id} S=${sat.toFixed(2)} L=${l.toFixed(2)}`);
  }
  assert(bad.length === 0, `not pastel:\n  ${bad.join("\n  ")}`);
});

// The point of the tissue policy: a bone group is bone, on both sides and at every depth.
Deno.test("bone is bone, muscle is muscle, and the lung vessels are the right way round", () => {
  const bone = groupColour("g:skeletal")!;
  for (const id of ["g:ribs", "g:ribs-left", "g:ribs-right", "g:thoracic-cage", "g:vertebral-column", "g:pelvis", "g:bones-of-hand"]) {
    assertEquals(groupColour(id), bone, `${id} should be bone ivory`);
  }
  const blueish = (c: [number, number, number]) => c[2] > c[0];
  const reddish = (c: [number, number, number]) => c[0] > c[2];
  assert(reddish(groupColour("g:systemic-arteries")!), "systemic arteries should be red");
  assert(blueish(groupColour("g:systemic-veins")!), "systemic veins should be blue");
  assert(blueish(groupColour("g:pulmonary-arteries")!), "pulmonary arteries should be BLUE (deoxygenated)");
  assert(reddish(groupColour("g:pulmonary-veins")!), "pulmonary veins should be RED (oxygenated)");
  assert(deltaE(c255(groupColour("g:small-intestine")!), c255(groupColour("g:large-intestine")!)) >= SAME_COLOUR,
    "small and large bowel must be tellable apart");
});
