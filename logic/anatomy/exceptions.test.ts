// The catalog of exceptions, checked against what the tree actually does — so an entry cannot
// describe a departure the code stopped making, and a reason cannot go missing.
//
//   deno test -A --no-check logic/anatomy/exceptions.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { EXCEPTIONS } from "./exceptions.ts";
import { buildAnatomyTree, type AnatomyNode, leaves } from "./hierarchy.ts";

const find = (name: string, ns: AnatomyNode[]): AnatomyNode | undefined => {
  for (const n of ns) {
    if (n.name === name) return n;
    const hit = find(name, n.children ?? []);
    if (hit) return hit;
  }
};

Deno.test("every exception names a rule and a reason", () => {
  assert(EXCEPTIONS.length > 0);
  for (const e of EXCEPTIONS) {
    assert(e.rule.length > 8, `no rule named: ${JSON.stringify(e)}`);
    assert(e.applies.length > 3, `nothing to apply it to: ${e.rule}`);
    // "arbitrary but not random": an exception without a reason cannot be told from a bug
    assert(e.why.length > 40, `no reason given for ${e.rule} / ${e.applies}`);
  }
});

Deno.test("the ventricular system is not split by hemisphere", () => {
  const t = buildAnatomyTree([
    "Left-Lateral-Ventricle", "Right-Lateral-Ventricle", "3rd-Ventricle", "4th-Ventricle",
    "Left-Hippocampus", "Right-Hippocampus",
  ]);
  const sys = find("Ventricular system", t)!;
  assertEquals(leaves([sys]).length, 4, "all four cavities stay in one branch");
  // ...while the structure beside it obeys the rule the ventricles are excepted from
  assert(find("Left hemisphere", t), "the cerebrum is still sided");
  assertEquals(leaves([find("Left hemisphere", t)!]).map((n) => n.structure), ["Left-Hippocampus"]);
  // and the system is NOT inside a hemisphere
  assertEquals(find("Ventricular system", find("Left hemisphere", t)!.children), undefined);
});

Deno.test("a bilateral label stays at the region's level, saying so", () => {
  const t = buildAnatomyTree(["femur_left", "femur_right", "radius"]);
  const leg = find("Leg", t)!;
  assertEquals(leg.children.map((c) => c.name), ["Left leg", "Right leg"]);
  const arm = find("Arm", t)!;
  assertEquals(arm.children.map((c) => c.name), ["Radius, both sides"], "not filed under a side");
});

Deno.test("a node may be a structure and a parent at once", () => {
  const t = buildAnatomyTree(["sacrum", "vertebrae_S1"]);
  const sacrum = find("Sacrum", t)!;
  assertEquals(sacrum.structure, "sacrum", "it is the structure");
  assertEquals(sacrum.children.map((c) => c.structure), ["vertebrae_S1"], "and the parent");
});
