// WHAT THE 3D VIEW SHOWS AFTER A LOAD, versions 1-3 (render/after-load.ts; Ron, 2026-10-19; the critic, 2026-10-20).
//   deno test -A --no-check render/after-load.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { planAfterLoad } from "./after-load.ts";
import type { MrsonNode } from "./mrson.ts";

const img = (id: string, modality: string, extra: Record<string, unknown> = {}) => ({ type: "image", id, origin: { modality }, ...extra }) as unknown as MrsonNode;
const nodes = (...ns: MrsonNode[]) => new Map(ns.map((n) => [n.id as string, n]));

Deno.test("an MR alone: volume rendered, with the slice planes", () => {
  const n = nodes(img("t1", "MR"));
  assertEquals(planAfterLoad(n, ["t1"], false), { mr: ["t1"], planes: true, volumeRendering: true });
});

Deno.test("a module showed the load (the major tracts): the MR left plain", () => {
  const n = nodes(img("t1", "MR"));
  assertEquals(planAfterLoad(n, ["t1"], true), { mr: ["t1"], planes: false, volumeRendering: false });
});

Deno.test("CT, a computed map, a diffusion frame, a segmented MR: not this rule's", () => {
  const n = nodes(
    img("ct", "CT"),
    img("fa", "MR", { autoVolumeRendering: false }),
    { type: "sequence", id: "dwi", indexType: "text", items: [{ index: "b0" }, { index: "b1000" }] } as unknown as MrsonNode,
    img("frame", "MR", { sequence: "dwi", hidden: true }),
    img("t1", "MR"),
    { type: "segmentation", id: "tumor", refs: { source: ["t1"] } } as unknown as MrsonNode,
  );
  assertEquals(planAfterLoad(n, ["ct", "fa", "frame", "t1", "tumor"], false).mr, []);
});

Deno.test("only what this load added", () => {
  const n = nodes(img("old", "MR"), img("t1", "MR"));
  assertEquals(planAfterLoad(n, ["t1"], false).mr, ["t1"]);
  assertEquals(planAfterLoad(n, [], false).planes, false);
});

Deno.test("version 2: an MR with its brain's structures stored comes up with them, no planes", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const n = nodes(img("t1", "MR"));
  const live = { nodes: n } as unknown as Parameters<typeof applyAfterLoad>[0]["live"];
  const planes: string[] = [];
  const r = await applyAfterLoad({ live, added: ["t1"] }, {
    setSliceIn3D: (c, on) => { if (on) planes.push(c); }, setVolumeRendering: () => {},
    loadStored: (ids) => { for (const id of ids) n.set(`seg-${id}`, { type: "segmentation", id: `seg-${id}`, refs: { source: [id] } } as unknown as MrsonNode); return Promise.resolve(ids.length); },
  }, 2);
  assertEquals(planes, []);
  assertEquals(r.line.includes("brain's structures of 1 MR"), true);
  // Nothing stored: version 1 (the volume and the planes).
  const m = nodes(img("t1b", "MR"));
  const planes2: string[] = [];
  await applyAfterLoad({ live: { nodes: m } as never, added: ["t1b"] }, { setSliceIn3D: (c, on) => { if (on) planes2.push(c); }, setVolumeRendering: () => {}, loadStored: () => Promise.resolve(0) }, 2);
  assertEquals(planes2, ["Red", "Yellow", "Green"]);
});

// ── VERSION 3 (the critic's round, 2026-10-20: findings 7, 8, 15) ────────────────────────────────────────────────────
type Act = Parameters<typeof import("./after-load.ts").applyAfterLoad>[1];
/** A scene and the views, as the load panel hands them over: planes and volume renderings recorded, a brain stored for
 *  the scans in `stored`. */
function views(n: Map<string, MrsonNode>, stored: string[] = [], facts: Record<string, { description: string; images: number }> = {}) {
  const planes = new Set<string>(), rulesPlanes = new Set<string>(), vr = new Map<string, boolean>(), brainsOf: string[] = [];
  const act: Act = {
    setSliceIn3D: (c, on) => { if (on) planes.add(c); else planes.delete(c); },
    sliceIn3D: () => [...planes],
    rulesPlanes,
    setVolumeRendering: (id, on) => {
      vr.set(id, on);
      n.set(`vr-${id}`, { type: "volumeRenderingDisplay", id: `vr-${id}`, visible: on, refs: { volume: [id] } } as unknown as MrsonNode);
    },
    loadStored: (ids) => {
      const have = ids.filter((id) => stored.includes(id));
      for (const id of have) { brainsOf.push(id); n.set(`seg-${id}`, { type: "segmentation", id: `seg-${id}`, name: "fastsurfer:asegdkt of T1", refs: { source: [id] } } as unknown as MrsonNode); }
      return Promise.resolve(have.length);
    },
    facts: (id) => facts[id],
  };
  return { act, planes, rulesPlanes, vr, brainsOf };
}
const live = (n: Map<string, MrsonNode>) => ({ nodes: n }) as unknown as Parameters<typeof import("./after-load.ts").applyAfterLoad>[0]["live"];
const inStudy = (id: string, study: string, name: string) => img(id, "MR", { name, origin: { modality: "MR", studyInstanceUID: study } });
/** tf-editor.ts's showOnLoad: the last scan to arrive volume rendered. */
const lastRendered = (n: Map<string, MrsonNode>, id: string) => n.set(`vr-${id}`, { type: "volumeRenderingDisplay", id: `vr-${id}`, visible: true, refs: { volume: [id] } } as unknown as MrsonNode);

Deno.test("v3: two T1s with their brains and two FLAIRs -- one brain, the preferred T1's; nothing volume rendered over it; no planes", async () => {
  const { applyAfterLoad, AFTER_LOAD_VERSION } = await import("./after-load.ts");
  assertEquals(AFTER_LOAD_VERSION, 3);
  const n = nodes(inStudy("t1post", "s", "t1 axial stealth-post"), inStudy("t1", "s", "t1 axial stealth"), inStudy("flair1", "s", "FLAIR"), inStudy("flair2", "s", "FLAIR ax"));
  lastRendered(n, "flair2");
  const facts = { t1post: { description: "t1 axial stealth-post", images: 180 }, t1: { description: "t1 axial stealth", images: 120 },
    flair1: { description: "FLAIR", images: 40 }, flair2: { description: "FLAIR ax", images: 40 } };
  const v = views(n, ["t1post", "t1"], facts);
  const r = await applyAfterLoad({ live: live(n), added: ["t1post", "t1", "flair1", "flair2"] }, v.act);
  assertEquals(v.brainsOf, ["t1"]);                                  // the job's order: not the one after contrast
  for (const id of ["t1post", "t1", "flair1", "flair2"]) assertEquals(v.vr.get(id), false, `${id} plain`);
  assertEquals([...v.planes], []);
  assertEquals(r.line, "after the load (rules v3): the brain's structures of one T1, solid, 3 other MR plain");
});

Deno.test("v3: one T1 with its brain and a FLAIR -- the brain solid, the FLAIR plain", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const n = nodes(inStudy("t1", "s", "MPRAGE"), inStudy("flair", "s", "T2 FLAIR"));
  lastRendered(n, "flair");
  const v = views(n, ["t1"], { t1: { description: "MPRAGE", images: 176 }, flair: { description: "T2 FLAIR", images: 30 } });
  await applyAfterLoad({ live: live(n), added: ["flair", "t1"] }, v.act);
  assertEquals(v.brainsOf, ["t1"]);
  assertEquals(v.vr.get("flair"), false);
  assertEquals([...v.planes], []);
  // Loaded again with another T1 of the same study: no second brain.
  n.set("t1b", inStudy("t1b", "s", "T1 3D"));
  const w = views(n, ["t1b"], { t1b: { description: "T1 3D", images: 200 } });
  await applyAfterLoad({ live: live(n), added: ["t1b"] }, w.act);
  assertEquals(w.brainsOf, []);
  assertEquals(w.vr.get("t1b"), false);
});

Deno.test("v3: a study without a stored brain gets version 1 beside one that has it", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const n = nodes(inStudy("t1", "a", "T1"), inStudy("other", "b", "T1 other study"));
  lastRendered(n, "t1");
  const v = views(n, ["t1"]);
  await applyAfterLoad({ live: live(n), added: ["t1", "other"] }, v.act);
  assertEquals(v.vr.get("t1"), false);
  assertEquals(v.vr.get("other"), true);                             // the one left to look at gets the rendering
  assertEquals([...v.planes].sort(), ["Green", "Red", "Yellow"]);
});

Deno.test("v3: a CT after an MR takes off the planes the rules put on, and only those", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const n = nodes(inStudy("t1", "s", "T1"));
  const v = views(n);
  await applyAfterLoad({ live: live(n), added: ["t1"] }, v.act);
  assertEquals([...v.planes].sort(), ["Green", "Red", "Yellow"]);
  assertEquals([...v.rulesPlanes].sort(), ["Green", "Red", "Yellow"]);
  // The person switches the red plane off, then on again by hand: theirs now.
  v.act.setSliceIn3D!("Red", false);
  await applyAfterLoad({ live: live(n), added: [] }, v.act);         // a load that added nothing changes nothing
  v.act.setSliceIn3D!("Red", true);
  n.set("ct", img("ct", "CT"));
  lastRendered(n, "ct");
  const r = await applyAfterLoad({ live: live(n), added: ["ct"] }, v.act);
  assertEquals([...v.planes], ["Red"]);
  assertEquals(v.rulesPlanes.size, 0);
  assertEquals(r.line.includes("taken off"), true);
  // A plane switched on before the rules ever ran (a scene put it back) is not theirs either.
  const m = nodes(img("ct2", "CT"));
  lastRendered(m, "ct2");
  const w = views(m);
  w.act.setSliceIn3D!("Yellow", true);
  await applyAfterLoad({ live: live(m), added: ["ct2"] }, w.act);
  assertEquals([...w.planes], ["Yellow"]);
});

Deno.test("v3: never empty -- a diffusion scan alone, no T1, no stored tracts: the slice planes", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const { registerVolumeInterpreter, unregisterVolumeInterpreter } = await import("../logic/readers/volume-interpreters.ts");
  registerVolumeInterpreter({ name: "diffusion" });
  try {
    const n = nodes(
      { type: "sequence", id: "dwi", indexType: "text", items: [{ index: "b0" }, { index: "b1000" }] } as unknown as MrsonNode,
      img("f0", "MR", { sequence: "dwi", origin: { modality: "MR", diffusion: { bValue: 0 } } }),
      img("f1", "MR", { sequence: "dwi", hidden: true, origin: { modality: "MR", diffusion: { bValue: 1000 } } }),
    );
    const v = views(n);
    const r = await applyAfterLoad({ live: live(n), added: ["dwi", "f0", "f1"] }, v.act);
    assertEquals([...v.planes].sort(), ["Green", "Red", "Yellow"]);
    assertEquals(v.vr.size, 0);                                      // not volume rendered
    assertEquals(r.line, "after the load (rules v3): nothing else to show: the slice planes in 3D");
    // With something drawn already (a CT's rendering from before): left as it is.
    const m = nodes(
      { type: "sequence", id: "dwi", indexType: "text", items: [{ index: "b0" }, { index: "b1000" }] } as unknown as MrsonNode,
      img("g0", "MR", { sequence: "dwi", origin: { modality: "MR", diffusion: { bValue: 0 } } }), img("ct", "CT"));
    lastRendered(m, "ct");
    const w = views(m);
    await applyAfterLoad({ live: live(m), added: ["dwi", "g0"] }, w.act);
    assertEquals([...w.planes], []);
  } finally { unregisterVolumeInterpreter("diffusion"); }
});

Deno.test("v3: a series in time that does not play but is not a measurement series (no interpreter's key) is still looked at", async () => {
  const { planV3 } = await import("./after-load.ts");
  const n = nodes(
    { type: "sequence", id: "echoes", indexType: "text", items: [{ index: "TE 10" }, { index: "TE 20" }] } as unknown as MrsonNode,
    img("e0", "MR", { sequence: "echoes" }),
  );
  assertEquals(planV3(n, ["e0"]).mr, ["e0"]);
});

Deno.test("v3: the old versions stay -- version 2 gives the brain of every MR, as it did", async () => {
  const { applyAfterLoad } = await import("./after-load.ts");
  const n = nodes(inStudy("t1", "s", "T1"), inStudy("t1b", "s", "T1 b"));
  const v = views(n, ["t1", "t1b"]);
  const r = await applyAfterLoad({ live: live(n), added: ["t1", "t1b"] }, v.act, 2);
  assertEquals(v.brainsOf.sort(), ["t1", "t1b"]);
  assertEquals(r.line.startsWith("after the load (rules v2)"), true);
});
