// THE QUEUE CANNOT GO STALE, and nobody has to remember to look.
//
// Ron: "Please make sure that this is somewhere documented so I don't have to do it again." A
// document alone would have gone stale the first time a network was added -- so the queue is
// computed from the catalogs and this test fails when a collision has no recorded verdict. Adding
// a network with a name that clashes therefore stops the build until somebody has looked at it.
//
//   deno test -A --no-check logic/anatomy/relations.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { collisions } from "./collisions.ts";
import { RELATIONS, relationFor } from "./relations.ts";

Deno.test("every colliding display name has a recorded verdict", () => {
  const missing = collisions().filter((c) => !relationFor(c.name));
  assertEquals(
    missing.map((c) => `${c.name}  [${c.keys.join(" | ")}]`),
    [],
    "these labels draw the same row and nobody has said what is going on — add an entry to relations.ts",
  );
});

Deno.test("no verdict describes a collision that no longer exists", () => {
  const live = new Set(collisions().map((c) => c.name.toLowerCase()));
  const stale = RELATIONS.filter((r) => !live.has(r.name.toLowerCase()));
  assertEquals(stale.map((r) => r.name), [], "curated, then the collision went away — delete the entry");
});

Deno.test("a verdict names the same keys the catalogues do", () => {
  for (const c of collisions()) {
    const r = relationFor(c.name)!;
    assertEquals([...r.keys].sort(), [...c.keys].sort(), `${c.name}: the recorded keys have drifted`);
  }
});

// The cross-catalog ones are already handled -- a segment carries its catalog key, so
// TotalSegmentator's "Brainstem" and FreeSurfer's resolve apart. Pinned so the reason stays visible.
Deno.test("a name shared by the two catalogues is recorded as such", () => {
  for (const c of collisions().filter((x) => x.crossCatalogue)) {
    assertEquals(relationFor(c.name)!.kind, "catalogues", c.name);
  }
});

Deno.test("what is still undecided is small and visible", () => {
  const todo = RELATIONS.filter((r) => r.kind === "todo");
  assert(todo.length <= 5, `${todo.length} undecided: ${todo.map((r) => r.name).join(", ")}`);
});
