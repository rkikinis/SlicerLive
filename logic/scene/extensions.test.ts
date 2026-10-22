// An extension's own state in a saved scene (logic/scene/extensions.ts): written, checked, restored, and carried by a
// window that does not have the extension.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectExtensionState, extensionBlocks, forgetCarriedExtensionState, registerSceneState, restoreExtensionState } from "./extensions.ts";
import { writeScene } from "./write.ts";
import { checkScene } from "./check.ts";
import { liveNodes } from "./fixture.ts";

const reset = () => { (globalThis as Record<string, unknown>).__albulaSceneStateHandlers = []; forgetCarriedExtensionState(); };

Deno.test("an extension's state goes into the scene under its name, versioned, and passes the check", async () => {
  reset();
  registerSceneState({ name: "test-tracts", version: 2, save: () => ({ shown: ["CST"] }), restore: () => ({}) });
  registerSceneState({ name: "test-quiet", version: 1, save: () => undefined, restore: () => ({}) });
  const w = await writeScene(liveNodes(), { producer: "t", origin: "o", name: "s", extensions: collectExtensionState() });
  assertEquals((w.doc.extensions as Record<string, unknown>)["test-tracts"], { v: 2, state: { shown: ["CST"] } });
  assert(!("test-quiet" in (w.doc.extensions as Record<string, unknown>)), "nothing to keep, no block");
  assert((w.doc.extensionsUsed as string[]).includes("test-tracts/2"));
  assertEquals(w.problems, []);
});

Deno.test("the check refuses a block extensionsUsed does not name, and one that is not { v, state }", async () => {
  reset();
  const w = await writeScene(liveNodes(), { producer: "t", origin: "o", name: "s" });
  const doc = { ...w.doc, extensions: { "x-a": { v: 1, state: {} }, "x-b": { state: 3 } } };
  const p = checkScene(doc).map((x) => `${x.where}: ${x.what}`);
  assert(p.some((s) => s.startsWith("extension x-a") && s.includes("x-a/1")), p.join("; "));
  assert(p.some((s) => s.startsWith("extension x-b") && s.includes("{ v, state }")), p.join("; "));
});

Deno.test("restore: each installed extension gets its block (or undefined for a scene without one), with the version", async () => {
  reset();
  const got: unknown[] = [];
  registerSceneState({ name: "test-tracts", version: 2, save: () => undefined, restore: (s, v) => { got.push([s, v]); return { applied: ["3 tracts"], missing: ["the box"] }; } });
  registerSceneState({ name: "test-other", version: 1, save: () => undefined, restore: (s, v) => { got.push([s, v]); return {}; } });
  const r = await restoreExtensionState({ extensions: { "test-tracts": { v: 1, state: { shown: ["AF"] } } } });
  assertEquals(got, [[{ shown: ["AF"] }, 1], [undefined, undefined]]);
  assertEquals(r.applied, ["3 tracts"]);
  assertEquals(r.missing, ["test-tracts: the box"]);
});

Deno.test("a block for an extension not installed here is carried and written back unchanged; closing forgets it", async () => {
  reset();
  registerSceneState({ name: "test-tracts", version: 1, save: () => ({ mine: true }), restore: () => ({}) });
  const r = await restoreExtensionState({ extensions: { "elsewhere": { v: 4, state: { theirs: [1, 2] } } } });
  assert(r.missing.some((m) => m.startsWith("elsewhere: not installed here")));
  const c = collectExtensionState();
  assertEquals(c.extensions.elsewhere, { v: 4, state: { theirs: [1, 2] } });
  assertEquals(c.used.sort(), ["elsewhere/4", "test-tracts/1"]);
  forgetCarriedExtensionState();
  assert(!("elsewhere" in collectExtensionState().extensions));
});

Deno.test("a handler that throws: no block on save, said; on restore the others still run", async () => {
  reset();
  let ran = false;
  registerSceneState({ name: "test-bad", version: 1, save: () => { throw new Error("boom"); }, restore: () => { throw new Error("no"); } });
  registerSceneState({ name: "test-good", version: 1, save: () => ({ a: 1 }), restore: () => { ran = true; return {}; } });
  const c = collectExtensionState();
  assertEquals(Object.keys(c.extensions), ["test-good"]);
  assertEquals(c.failed, ["test-bad: boom"]);
  const r = await restoreExtensionState({});
  assert(ran);
  assertEquals(r.missing, ["test-bad: no"]);
});

Deno.test("blocks are read with care; names are checked when registering", () => {
  assertEquals(extensionBlocks({ extensions: [] }).bad, ["extensions is not an object"]);
  assertEquals([...extensionBlocks({ extensions: { a: { v: 1, state: null }, b: { v: "1", state: 1 } } }).blocks.keys()], ["a"]);
  let threw = false; try { registerSceneState({ name: "Bad Name", version: 1, save: () => undefined, restore: () => ({}) }); } catch { threw = true; }
  assert(threw);
});
