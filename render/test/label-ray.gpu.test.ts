// ASK THE SEGMENTATIONS, NOT THE TRANSFER FUNCTION.
//
// Ron pointed the 3D probe at the gluteus medius and got "Iliopsoas muscle, right". `pick` returns
// where accumulated opacity crosses 50%, so with a step transfer function the first soft tissue the
// ray meets passes 50% long before the muscle being looked at -- a true answer to a different
// question. Ron, on asking the labelmaps instead: "1: agree".
//
// The property that makes it worth having is STRUCTURAL and so cannot be tested by varying anything:
// this pass takes no palette, no opacity and no transfer function as input, so its answer cannot
// change when the appearance does. What CAN go wrong is the geometry, the priority between two
// overlapping labelmaps, and stepping over something thin -- so those are what is asserted.
//
//   deno test -A --no-check --unstable-webgpu render/test/label-ray.gpu.test.ts
import { assertEquals } from "jsr:@std/assert";
import { initDevice } from "../device.ts";
import { LabelRay } from "../label-ray.ts";
import { ColorizeBaker } from "../bake.ts";
import { patientToTextureFromIjkToRAS } from "../mat4.ts";
import type { Vec3 } from "../mat4.ts";

const hasGpu = !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

Deno.test({
  name: "a ray reports the first structure it meets, through each labelmap's own geometry",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const errs: string[] = [];
    gpu.device.addEventListener("uncapturederror", (e) => errs.push(String((e as GPUUncapturedErrorEvent).error)));

    // A: the whole study, 32mm cube centered on the origin, 1 mm voxels.
    const aDims: Vec3 = [32, 32, 32];
    const aIjk = [1, 0, 0, -16, 0, 1, 0, -16, 0, 0, 1, -16, 0, 0, 0, 1];
    const a = new Uint8Array(32 * 32 * 32);
    const setA = (i: number, j: number, k: number, v: number) => { a[(k * 32 + j) * 32 + i] = v; };
    // label 5 fills i in [16,24) -> RAS x in [-0.5, 7.5)
    for (let k = 0; k < 32; k++) for (let j = 0; j < 32; j++) for (let i = 16; i < 24; i++) setA(i, j, k, 5);
    // label 9 is ONE VOXEL THICK at i = 28 -> RAS x in [12,13). A rib is thin; a coarse step misses it.
    for (let k = 0; k < 32; k++) for (let j = 0; j < 32; j++) setA(28, j, k, 9);

    // B: a SUB-VOLUME, 16mm cube offset to the -x side, so it shares no geometry with A.
    const bDims: Vec3 = [16, 16, 16];
    const bIjk = [1, 0, 0, -12, 0, 1, 0, -8, 0, 0, 1, -8, 0, 0, 0, 1];
    const b = new Uint8Array(16 * 16 * 16);
    // label 7 fills i in [2,6) -> RAS x in [-10,-6)
    for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) for (let i = 2; i < 6; i++) b[(k * 16 + j) * 16 + i] = 7;
    // label 3 genuinely OVERLAPS A's label 5: i in [10,16) -> RAS x in [-2.5, 3.5), which meets A's
    // [-0.5, 7.5) over [-0.5, 3.5). The probe below sits at x = 1, mid-voxel in both -- the first
    // version put it at x = 3.5, exactly on a texture-coordinate boundary where a sample can fall
    // either side of tc == 1.0, so it was testing floating point rather than priority.
    for (let k = 0; k < 16; k++) for (let j = 0; j < 16; j++) for (let i = 10; i < 16; i++) b[(k * 16 + j) * 16 + i] = 3;

    const bakerA = new ColorizeBaker(gpu.device, a, aDims);
    const bakerB = new ColorizeBaker(gpu.device, b, bDims);
    const tA = { labels: bakerA.labelTexture(), p2t: patientToTextureFromIjkToRAS(aIjk, aDims) };
    const tB = { labels: bakerB.labelTexture(), p2t: patientToTextureFromIjkToRAS(bIjk, bDims) };

    const ray = new LabelRay(gpu);
    const along = async (o: Vec3, d: Vec3, targets = [tA, tB], step = 0.5) => await ray.first(targets, o, d, step);

    // Traveling +x from well outside: B's label 7 at x ~= -10 is the first thing there.
    const fwd = await along([-60, 0, 0], [1, 0, 0]);
    // Traveling -x: A's one-voxel label 9 at x ~= 13 comes first.
    const back = await along([60, 0, 0], [-1, 0, 0]);
    // A alone, traveling +x: label 5 at x ~= 4, because B is not being asked.
    const aOnly = await along([-60, 0, 0], [1, 0, 0], [tA]);
    // A ray outside both boxes entirely.
    const miss = await along([-60, 100, 0], [1, 0, 0]);
    // Overlap: at x = 1 both have a label. The LAST slot is drawn on top, so it must win.
    // The ray STARTS at the overlap, so the first sample is the contested one. Starting outside
    // tested something else entirely: A's label fills every j and k, so traveling +z the ray met A
    // at z = -16 before it had even entered B's box -- correct first-hit behavior, and no statement
    // about priority at all.
    const overlapAB = await ray.first([tA, tB], [1, 0, 0], [0, 0, 1], 0.5);
    const overlapBA = await ray.first([tB, tA], [1, 0, 0], [0, 0, 1], 0.5);

    console.log(`+x        ${fwd ? `slot ${fwd.slot} label ${fwd.label} at x=${(fwd.ras[0]).toFixed(1)}` : "null"}`);
    console.log(`-x        ${back ? `slot ${back.slot} label ${back.label} at x=${(back.ras[0]).toFixed(1)}` : "null"}`);
    console.log(`+x, A only ${aOnly ? `label ${aOnly.label} at x=${(aOnly.ras[0]).toFixed(1)}` : "null"}`);
    console.log(`miss      ${miss ? "HIT (should be null)" : "null"}`);
    console.log(`overlap [A,B] label ${overlapAB?.label}   [B,A] label ${overlapBA?.label}`);
    console.log(`GPU errors=${errs.length}`);

    const checks: [string, boolean][] = [
      ["+x finds B's label first, through B's own geometry", fwd?.label === 7 && fwd?.slot === 1],
      ["and reports it where B actually is", !!fwd && fwd.ras[0] >= -10.5 && fwd.ras[0] <= -5.5],
      ["-x finds the ONE-VOXEL structure, not the slab behind it", back?.label === 9],
      ["a labelmap that is not asked is not answered for", aOnly?.label === 5 && aOnly?.slot === 0],
      ["a ray through neither labelmap reports nothing", miss === null],
      ["where two overlap, the one drawn on top wins", overlapAB?.label === 3 && overlapBA?.label === 5],
      ["no GPU errors", errs.length === 0],
    ];
    for (const [n, ok] of checks) console.log(`${ok ? "  ok  " : " FAIL "} ${n}`);
    const failures = checks.filter(([, ok]) => !ok).map(([n]) => n);
    assertEquals(failures, [], `label ray broke:\n  ${failures.join("\n  ")}`);
    ray.destroy();
    gpu.device.destroy();
  },
});

// A HIDDEN STRUCTURE IS PASSED THROUGH, and what is exposed behind it is reported.
//
// Ron, with the neocortex switched off and a deeper structure exposed: "the probe shows the superior
// fronal gyrus" — a structure that was not on screen. And with two segmentations loaded: "I had
// nephrogenic up and switched from total to lungvessels. The probe still gave me sternum."
//
// The file's own header argues the answer should not follow an opacity slider, and that still stands:
// a structure at 30% is in the picture and is what the cursor is over. Being switched OFF is
// different — it is not drawn, so it cannot be pointed at. This pins that distinction.
Deno.test({
  name: "a hidden label is passed through, and what is behind it is reported",
  ignore: !hasGpu,
  sanitizeResources: false,
  async fn() {
    const gpu = await initDevice();
    const dims: Vec3 = [32, 1, 1];
    const ijk = [1, 0, 0, -16, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const lab = new Uint8Array(32);
    // Two slabs along x: label 4 in front (i 4..12), label 6 behind it (i 20..28).
    for (let i = 4; i < 12; i++) lab[i] = 4;
    for (let i = 20; i < 28; i++) lab[i] = 6;
    const baker = new ColorizeBaker(gpu.device, lab, dims);
    const p2t = patientToTextureFromIjkToRAS(ijk, dims);
    const ray = new LabelRay(gpu);
    const mask = (...on: number[]) => {
      const m = new Uint32Array(8);
      for (const l of on) m[l >> 5] |= 1 << (l & 31);
      return m;
    };
    const from: Vec3 = [-40, 0.5, 0.5], dir: Vec3 = [1, 0, 0];

    // No mask: the front slab, as before — the default must not change.
    const bare = await ray.first([{ labels: baker.labelTexture(), p2t }], from, dir, 0.25);
    assertEquals(bare?.label, 4, "with no mask supplied every non-zero label still counts");

    // Both visible: still the front one.
    const both = await ray.first([{ labels: baker.labelTexture(), p2t, visible: mask(4, 6) }], from, dir, 0.25);
    assertEquals(both?.label, 4);

    // THE FRONT ONE HIDDEN: the ray must not stop at it, and must report 6.
    const behind = await ray.first([{ labels: baker.labelTexture(), p2t, visible: mask(6) }], from, dir, 0.25);
    assertEquals(behind?.label, 6, "a hidden label must be passed through, not reported");

    // Everything hidden: no hit at all, rather than a wrong one.
    const none = await ray.first([{ labels: baker.labelTexture(), p2t, visible: mask() }], from, dir, 0.25);
    assertEquals(none, null, "with nothing visible the ray must report nothing");
  },
});
