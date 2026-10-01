// The shading versions (render/shading-versions.ts): the list, the current one, a structure's finish under each, the packing.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { encodeFinish, finishFor, finishWgsl, LATEST_SHADING, onShadingVersion, setShadingVersion, SHADINGS, shadingVersion } from "./shading-versions.ts";

Deno.test("shading versions: v1 lights every structure alike, v2 gives each its tissue's finish", () => {
  assertEquals(SHADINGS.map((s) => s.version), [1, 2]);
  assertEquals(LATEST_SHADING, 2);
  assertEquals(finishFor("liver", 1), undefined);
  const liver = finishFor("liver", 2)!;
  assertEquals([liver.name, liver.roughness, liver.coat], ["organ_capsule", 0.42, 0.8]);
  assertEquals(finishFor("vertebra_T7", 2)?.name, "dry_bone");          // the catalog's spelling, the table's vertebrae_T7
  assertEquals(finishFor("aorta", 2)?.name, "blood_pool");
  assertEquals(finishFor("no_such_structure", 2), undefined);
});

Deno.test("the current version: set, told to listeners once per change, unknown versions fall back to the latest", () => {
  let told = 0;
  const off = onShadingVersion(() => told++);
  setShadingVersion(1); assertEquals(shadingVersion(), 1);
  setShadingVersion(1); assertEquals(told, 1, "no change, no call");
  setShadingVersion(99); assertEquals(shadingVersion(), LATEST_SHADING);
  assertEquals(told, 2);
  off();
});

Deno.test("a finish packs into two texels; none is all zeros", () => {
  assertEquals([...encodeFinish(undefined)], [0, 0, 0, 0, 0, 0, 0, 0]);
  const e = encodeFinish({ name: "x", roughness: 0.5, ior: 1.4, coat: 1, coatRoughness: 0, sheen: 0.25, subsurface: 0.5, metallic: 0 });
  // Fresnel head-on for ior 1.4: ((0.4 / 2.4)^2) = 0.0278, stored x10
  assertEquals([...e], [128, 255, 0, 64, 128, Math.round(0.2778 * 255), 0, 255]);
  assert(finishWgsl("finish_x").startsWith("/** A FINISH'S HIGHLIGHT") && finishWgsl("finish_x").includes("fn finish_x("));
});
