# Greased Lightning — making surface extraction fast enough to ship

> The project is named after a pass, and the pass earned it. The Albula summit is 2,106 m and was
> never what stopped anyone; what made the route impassable was one narrow stretch on the approach,
> the Schöllenen gorge, where the Reuss had to be forded through its own snowmelt. A bridge across it
> around 1220 opened the whole crossing and rearranged the map of Europe. Every generation since has
> tunneled through the hard part rather than moved the mountain.
>
> That is exactly the shape of what follows. **Find the gorge, not the mountain.**

> ## DONE 2026-09-09 — 118.2 s to 15.0 s in the app, and NOT by any of the routes below.
>
> **The 118 s was the JS ENGINE, in one phase, and the fix was ~30 lines in the inner loop.**
>
> Step 0 — the measurement this brief kept insisting on and that nobody had done — ran the identical
> extraction under **JavaScriptCore** (what the webview runs) and **V8** (`deno`, and the app's own
> server process). `algorithms/surface-nets.engine-bench.ts` is that harness, committed:
>
> | | phases 1-2 | phases 3-4 |
> |---|---|---|
> | JavaScriptCore | **3.09 s** | 0.83 s |
> | V8 | **0.45 s** | 0.93 s |
>
> **6.9x on phases 1-2, and JSC slightly FASTER on 3-4.** So 13.9 x 6.9 + 11.2 = 107 s, against the
> 118 s observed. The whole deficit was a tight scalar loop that V8 optimizes and JSC does not: an
> `at()` closure called eight times per cell (3.3 billion calls), `CORNER[c][0]` double indirection,
> `for (const [a, b] of CELL_EDGES)` allocating an iterator per edge per cell, and edge midpoints
> recomputed though they are constants.
>
> Flattening those into linear corner offsets and typed-array edge tables:
>
> | | before | after |
> |---|---|---|
> | JSC phases 1-2 | 3.09 s | **0.33 s** (9.4x) |
> | JSC total | 3.92 s | **1.04 s** |
> | V8, real labelmap, total | 25.0 s | **17.8 s** |
>
> Identical triangle count throughout (12,121,372), seven tests untouched, normals unchanged at mean
> 2.7 / p95 8.6 degrees.
>
> **CONFIRMED IN THE APPLICATION**, Ron's own status line on build `Sep 9 03:41`:
>
> ```
> surfaces for local-segmentation-1: 111 labels, 12,121,372 triangles in 15.0s [smooth 24, normals 16]
> ```
>
> **118.2 s -> 15.0 s, 7.9x**, same triangle count, ~21 s end to end with the 5.7 s load against a
> 33 s target. Note that 15.0 s beats the 17.8 s measured standalone under V8: **JavaScriptCore is
> now the faster engine on this workload**, exactly as the synthetic harness said (1.04 s vs 1.20 s).
> That is worth remembering, because it is the opposite of the assumption the whole investigation
> started from.
>
> ### What this means for everything below
>
> The GPU port, the torch/haversack route and the parallel workers were all aimed at the wrong thing.
> They are kept because the measurements are real and they say useful things — in particular the
> torch implementation in `surfaces/` reached EXACT parity and is still the second independent check
> on the algorithm — but **none of them is the fix, and the estimates in them are superseded.**
>
> The lesson, which is why the numbers below are preserved rather than deleted: **three rounds of
> increasingly expensive plans were built on an unmeasured premise.** I estimated a GPU speedup of
> 20-30x (wrong: measured 3.2x, and the GPU turned out slower than the CPU), costed a 2-3 week port,
> and prototyped a whole second implementation in torch — all before spending one hour on the
> measurement that identified the actual cause. Step 0 was in this document from the first draft and
> was the last thing done.
>
> ### The one thing to protect
>
> `algorithms/surface-nets.engine-bench.ts` must keep passing in BOTH engines. The optimization is
> **invisible in V8** — it optimizes the readable version just as well — so `deno test` and `deno
> bench` cannot tell you that a tidy-looking inner loop has just cost the shipping engine a factor of
> seven. Nothing else in the repo can catch that regression.

## The budget, which is the acceptance criterion

Ron, asked for the threshold: **"30 sec is ok, 1m is acceptable, everything else is problematic.
Each of these with a plus minus 10%."**

So: **<= 33 s is the target, <= 66 s passes, past that the feature is not usable.** Today it is 118 s
inside the application.

Note carefully what that implies, because it may change the whole plan: the SAME CODE already runs in
**25 s standalone under V8** on this machine -- inside the TARGET, not merely inside "acceptable".
The gap is not the algorithm; it is where the algorithm runs.

Re-run it yourself, it is committed: `deno run -A --v8-flags=--max-old-space-size=12000
algorithms/surface-nets.bench.ts`. (An earlier draft of this brief said 34.2 s. That was measured in
a process that had already completed one full extraction, so GC pressure inflated it -- a clean run
is 25.0-25.3 s across three runs. The benchmark exists precisely so the number is reproduced rather
than quoted.)

## An option that may be much cheaper than a GPU port

**Evaluate this before writing any WGSL.** SlicerAlbula.app is a `deno compile`d server plus a
webview: there is already a **V8 process** in the running system, and the 25 s figure above was
measured in exactly that engine. Moving the extraction to the server side -- an endpoint that takes
the labelmap and returns mesh buffers -- plausibly lands inside the budget with no shader work at
all.

Against it: the labelmap has to cross a process boundary (418 MB here, though it is already being
copied for the worker), the server and the page are separately built and versioned (see the trap
about that in the SlicerAlbula working state), and it puts a long-running job in a process that
also serves the UI.

For it: it is a fraction of the work, it reuses code that is already correct and tested, and it
targets the actual measured deficit. A GPU port should have to beat this on merit, not on appeal.

## The one-sentence version

`surfaceNets()` turns a labelmap into one triangle mesh per label; it is correct, it is measured, and
it takes 118 s on a whole-body CT inside the application, which is past the point where the feature
is usable. Move it to WebGPU compute.

## Why this is worth doing rather than optimizing the JS

The same code, on the same machine, over the same labelmap:

| | extraction | rest | total |
|---|---|---|---|
| standalone (`deno run`, V8) | 13.9 s | 11.2 s | **25.0 s** |
| inside SlicerAlbula.app | | | **118.2 s** |

Standalone figures from `algorithms/surface-nets.bench.ts`, three runs, 25.0-25.3 s.

Both produce 12,121,372 triangles, so it is provably the same work. The app is a webview, which on
macOS means **JavaScriptCore, not V8**, and this workload is tight typed-array loops over 418 million
voxels — where those engines diverge most.

**This is the leading suspect, not a confirmed finding, and confirming it is step 0.** If it is the
engine, JS tuning cannot reach the bar and only the GPU will. If it is something else (GC pressure
from an 11 GB web content process, the 418 MB `lab.slice()` transfer), that may be far cheaper to
fix, and this whole project may be unnecessary. **Do not skip step 0.**

Suggested step 0, an hour at most. Compare **per phase**, not in total: if extraction alone is far
slower that is an engine signature, and if everything is uniformly slow suspect memory.

1. **Standalone half — already committed.** `deno run -A --v8-flags=--max-old-space-size=12000
   algorithms/surface-nets.bench.ts`. Prints the phase split, the triangle count and the shading
   figures.
2. **In-app half.** `StartSlicerAlbula.command`, then Add Data -> DICOM database -> load the
   NEPHROGENIC series with its `ts:total` segmentation, and turn on 3D for the segmentation in the
   Segmentations module. The status bar reports `surfaces for <id>: N labels, T triangles in Xs
   [smooth 24, normals 16]`, and says outright if the worker's build does not match the page's.
   `surface-nets-worker.ts` already posts progress; add the same single `onProgress` timestamp there
   to split extraction from the rest.
3. **A FRESH PAGE LOAD PER MEASUREMENT.** Toggling 3D off and on will NOT re-measure -- the surfaces
   are cached in `slot.surfaces` on purpose, so the second reading is instantaneous and meaningless.
   Reload the window between runs.

## What the algorithm does

Surface nets, chosen for a reason beyond speed. It places **one vertex per cell, shared by every
label meeting in that cell**, so parcels that touch cannot crack apart. Slicer needs a separate
"joint smoothing" option to prevent exactly that, because it extracts each segment independently;
here the problem is designed out rather than corrected afterwards. Any GPU port MUST preserve this —
it is the reason for the algorithm choice, not an incidental property.

Four phases, in `algorithms/surface-nets.ts`:

1. **Vertex per cell.** For each cell whose 8 corners are not all one label, place a vertex at the
   average of the midpoints of the edges that cross a label boundary. Embarrassingly parallel.
2. **Quads.** For each voxel, compare with its +x, +y, +z neighbor; where labels differ, emit a quad
   joining the four cells around that face, tagged with BOTH labels (a face is the outside of A and
   the outside of B, and is emitted into each one's mesh with opposite winding). Also embarrassingly
   parallel; needs an atomic append or a count-then-fill pass.
3. **Taubin smoothing** over shared vertices, via a CSR adjacency built from quad edges. 24
   iterations, each two passes (lambda = 0.6, then mu = -0.62 — the negative pass is what stops the
   surface deflating). Iterative and neighbor-gathering: the classic GPU shape, one dispatch per
   pass with ping-ponged buffers.
4. **Per-label meshes**, remapping global vertex indices to per-label local ones, then area-weighted
   normals and 16 passes of normal smoothing.

Phases 1–3 are natural compute. Phase 4 is the awkward one (per-label compaction) and is also the
cheapest — on a synthetic single label with 12.4 M vertices it costs 1.25 s against 1.37 s for the
extraction feeding it — so it may be right to leave it on the CPU at first and port 1–3. On the real
labelmap the split measured is **22.9 s extraction vs 11.3 s for everything after it** (phases 3 and
4 together, not separated), so phases 1–2 are the prize. **Port in that order and measure after
each.**

## It must run on more than this Mac

Ron: "Mike designed [haversack's algorithms] to run not only on mac but on cuda... Our GPU code
should also run on other platforms. Perhaps using Mike's architecture."

Mike's architecture is `haversack/backends/`: a registry where every backend exposes `available()`
and an identical `run(...)` writing into `out` in place, plus `select(name, device)` that resolves
"auto" to the best available -- Metal on `mps`, Triton on `cuda`, and `torch_gather` otherwise. The
sentence that matters is `torch_gather`'s own docstring: *"Runs on any device; this is the reference
the fused kernels are checked against."*

**What transfers, and what does not, honestly:**

- **Do NOT copy the per-vendor kernel split.** Mike is in PyTorch, so getting GPU speed forced him to
  hand-write Metal source and a Triton kernel; portability was a problem he had to solve. We are in
  WebGPU, where one WGSL shader is translated by the runtime to Metal, Vulkan or D3D12. **That
  portability is already given**, and reproducing `metal.py` / `triton_gpu.py` would be copying the
  shape of a solution to a problem we do not have.
- **DO copy the reference-and-check discipline.** The existing `surfaceNets()` in TypeScript IS our
  `torch_gather`: portable, correct, already covered by seven tests. **Keep it after the port** and
  check the GPU path against it, rather than replacing it. It is the answer to "how do you know the
  port is right", and it is a fallback on any machine where the device is refused.
- **DO copy `available()` / `select()`.** Not for vendor GPUs but for the portability problem we
  actually have: **WebGPU device LIMITS differ per platform.** `maxStorageBufferBindingSize`,
  `maxBufferSize` and workgroup limits are far more generous on Apple's unified memory than on a
  typical D3D12 or Vulkan machine, and a 418 M-voxel labelmap will not fit the same way everywhere.
  `render/device.ts` already raises limits to the adapter's maximum, so the query is in place; a port
  MUST read them and tile the dispatch rather than assume one buffer holds the volume. A backend that
  reports honestly why it is unavailable, and a CPU reference to fall back to, is exactly Mike's
  shape applied where it earns its place.

Test on something other than this Mac before calling it portable. Untested cross-platform support is
a claim, not a feature -- Mike is explicit that his own CUDA path is reasoned, not measured.

## How much speedup to expect — an estimate, with its reasoning exposed

**Ron asked for a guess. This is a guess, from bandwidth arithmetic and the published range for
similar kernels, NOT a measurement. Treat it as +/- 2x and replace it with numbers as soon as step 0
and a first kernel exist.**

Measured inputs: 418 M voxels / 417 M cells, **6,061,448 vertices**, 12,121,372 triangles, 291 MB of
vertex+index data. Machine: Apple M1 Max, 32 GPU cores, **~400 GB/s** unified memory.

| phase | CPU today | GPU estimate | reasoning |
|---|---|---|---|
| 1-2 extraction | **13.9 s** | **50-150 ms** | Bandwidth-bound. Even reading the labelmap several times is ~2-4 GB of traffic = ~10 ms at peak; add a prefix sum over 417 M cells. Published GPU marching-cubes on 512^3 runs 10-30 ms, and this grid is 3x that, so the order is consistent with the literature rather than only with my arithmetic. |
| 3 Taubin smoothing | **~5 s** | **~200 ms** | 48 passes x ~630 MB of gathers = ~30 GB, so ~76 ms at peak and ~190 ms at a realistic 40% for scattered neighbor gathers. |
| 4 per-label + normals | **~5 s** | **~300 ms** | 16 normal passes cost like phase 3; the per-label compaction is the awkward part and is the number most likely to be wrong. |
| **total compute** | **25 s** | **~0.5-2 s** | |

So roughly **20-30x against the 25 s standalone**, and 60-150x against the 118 s in the app.

**There is a structural win beyond the arithmetic, and it may matter more.** Today the meshes travel
extraction -> worker -> main thread -> interleave -> GPU buffers, which is a 418 MB labelmap copy out
and 291 MB of buffers back in. If extraction runs on the GPU, **the output already IS the vertex
buffer** and none of that happens. Readback is then needed only for the DICOM Surface Segmentation
save path.

### What this does to the end-to-end number, which is the one that counts

Ron: "is this 25s end to end?" No -- the 25 s and the 118 s are both extraction only. Neither
includes loading the study, and neither includes getting the result to the GPU. Measured separately:
the `lab.slice()` copy is 0.18 s and the `setMeshes` interleave 0.04 s, both negligible; the DICOM
load was 5.7 s in Ron's own status line.

| route | end-to-end estimate | inside the 33 s target? |
|---|---|---|
| today | 5.7 s load + 118 s | no, and past the 66 s ceiling too |
| **move to the V8 server process** | 5.7 s + ~25 s + transfers | **barely, with no margin** |
| **GPU** | 5.7 s + ~0.3 s upload + ~1-2 s | yes, with room |

That is a real argument for the GPU over the cheaper server move, and it was not obvious before the
estimate: **the server option lands on the edge of the target rather than inside it.** Step 0 still
comes first, because it is an hour and it tells you whether the premise is even right.

**And note the floor it exposes: at ~8 s end-to-end the 5.7 s DICOM load dominates.** Below about 1 s
of extraction there is nothing left to win here, and the next bottleneck is a different subsystem.

### A third option, cheaper than either

**Parallel CPU workers.** The extraction already streams by z-plane, so z-slabs are the natural split
and there are 8 performance cores. Phase 1-2 at 13.9 s becomes ~2-3 s; phases 3-4 are more global but
can be partitioned. End-to-end perhaps 6-9 s -- inside the target, reusing code that is already
correct and tested, portable by construction, and needing no WGSL at all.

The fiddly part is the seam: shared vertices must agree across a slab boundary, so slabs need one
overlapping cell plane and the boundary vertices have to be reconciled rather than duplicated. That
is exactly the invariant the whole algorithm was chosen for, so it has to be got right -- but it is a
day of careful work, not a new rendering path.

### What the hard parts are, if you do go to the GPU

The estimate above assumes these are done well; done naively, any one of them dominates and the
speedup collapses:

- **Append / compaction over 417 M cells.** Prefix sums, not per-thread atomics on a single counter.
- **Building the CSR adjacency for smoothing on the GPU**, rather than shipping it back and forth.
- **Per-label compaction** into 111 variable-sized meshes.
- **Device limits off this Mac.** WebGPU's default `maxStorageBufferBindingSize` is 128 MiB; a 418 MB
  labelmap does not fit one binding on conservative hardware, so tiling is required for portability
  and costs something. Apple's unified memory hides this problem here, which is exactly why it will
  be found late.

## How much work is it? Roughly 2-3 weeks, against 1-3 days for the alternatives

Ron asked. Estimated against what the repo already has rather than in the abstract.

**What is already in place, and it is a lot:**

- **Eight compute pipelines exist**, so the plumbing pattern is established. `algorithms/kernels/histogram.ts`
  is 117 lines and already does `atomic<u32>` bins -- the closest existing thing to a reduction.
- **Headless GPU tests run under Deno on this machine** (7 `*.gpu.test.ts`, verified: 111 ms). Kernels
  can be developed and checked with no browser and no app rebuild. This is the single biggest reason
  the job is tractable at all.
- **A correct, tested CPU reference to check against** -- `surface-nets.ts` and its 7 tests. Mike's
  discipline comes free here rather than having to be built.
- `render/device.ts` already raises limits to the adapter's maximum.
- The porting notes at the top of `surface-nets.ts` say which phases are parallel and which apparent
  dependencies are artifacts of a sequential loop.

**What is missing, and the estimate is mostly this:**

| piece | days | note |
|---|---|---|
| A scan / prefix-sum primitive, with tests | 1-2 | **Nothing like it exists** -- the only mention of "prefix sum" in the repo is a comment. Needed at least three times (cell compaction over 417 M cells, quad append, CSR build), so it is the foundation and worth doing properly, multi-level. |
| Phase 1 on GPU: mask -> scan -> write vertices | 1 | Straightforward once the scan exists. |
| Phase 2: count faces -> scan -> fill quads | 1 | Same shape. |
| Phase 3: CSR adjacency on GPU, then 48 ping-pong dispatches | 1-2 | The adjacency build is the same scan again. |
| Phase 4: per-label compaction into 111 variable-sized meshes, plus normals | 2-3 | **The awkward one, and the estimate most likely to be wrong.** Partition 12 M quads by label, then remap vertices per label. |
| Integration: keep meshes on the GPU as vertex buffers; readback only for the DICOM save | 2 | Touches `SceneRenderer.setMeshes`, whose contract today is CPU arrays. This is where the structural win is realized, so it is not optional. |
| Tiling for device limits, for portability | 1-2 | **Cannot be verified on this machine** -- Apple's unified memory hides exactly the problem it addresses. |

**Total: ~10-15 focused days, call it 2-3 weeks.**

### The comparison that should decide it

| route | work | end-to-end | inside the 33 s target? |
|---|---|---|---|
| move to the V8 server process | **1-2 days** | ~31-35 s | on the edge, no margin |
| **parallel CPU workers over z-slabs** | **1-3 days** | **~6-9 s** | **yes** |
| GPU | **2-3 weeks** | ~7-8 s | yes |

**The CPU-worker route is about a tenth of the work for an end-to-end result the GPU route barely
improves on** -- because the 5.7 s DICOM load dominates either way, and below ~1 s of extraction there
is nothing left to win. On these numbers the GPU port buys margin that is not needed.

**The recommendation is therefore the parallel-worker route, and the GPU port is not the first thing
to build.** Its risk is one thing and it is the shared-vertex invariant: slabs need an overlapping
cell plane and the boundary vertices must be reconciled rather than duplicated, or parcels crack at
every slab seam. That is the property the whole algorithm was chosen for, so it must be got right --
but the existing "two touching labels share their vertices" test extends to cover it.

### When the GPU port DOES become the right answer

Not on today's numbers, but on one of these:

- **Live re-extraction while editing.** If painting a stroke should update the surface immediately,
  the budget is a frame and not 30 s, and 2-3 s of CPU work is far too slow. `algorithms/effects/paint.ts`
  exists, so this is a direction the project already has.
- **Studies substantially larger than 418 M voxels**, where even 8 cores fall outside the ceiling.
- **A machine with far fewer or slower CPU cores than this M1 Max**, where the CPU route's margin
  disappears but the GPU's does not.

If any of those is on the roadmap, build the scan primitive first anyway: it is the foundation for
every phase here, it is independently testable headless, and it is useful well beyond this problem.

## MEASURED 2026-09-08: the GPU is the SLOWEST of the real options, and the estimate above is wrong

Ron: "can you do it using Mike's multi platform infrastructure that is doing the calculations inside
haversack?" The right question, and answering it with an experiment rather than reasoning overturned
the section above. **Read this before believing any number in it.**

`surfaces/` in the SlicerAlbula repo implements this in torch -- one implementation, device chosen
at runtime, which IS Mike's multi-platform property. The numbers below came first from a phases-1-2
probe of ~40 lines; `surfaces/` then did all four phases with byte-identical output and reached the
same conclusion, so the probe was deleted on 2026-09-10 and this is the surviving record. On
NEPHROGENIC ts:total, 418 M voxels:

| | phases 1-2 |
|---|---|
| TypeScript, single thread (what ships) | **13.9 s** |
| torch on **MPS** — the GPU | **4.3 s** |
| torch on **CPU** | **1.3 s** |

**The GPU is 3.4x SLOWER than the CPU here, and my estimate of 50-150 ms for these phases was wrong
by two orders of magnitude.**

Why, and it is worth understanding because it generalizes: this workload is dominated by irregular
**compaction**, not by streaming. The bandwidth arithmetic above assumed streaming and is therefore
inapplicable. Measured on the same 417 M-element mask:

| compaction of 417 M elements -> 5.7 M | MPS | CPU |
|---|---|---|
| `torch.nonzero` | 1.81 s | **0.15 s** |
| hand-rolled `cumsum` + `scatter` (what a WGSL port would do) | 3.45 s | 2.13 s |

So the prefix-sum-plus-scatter pattern the WGSL plan is built on is the SLOWEST approach measured, on
either device. The boundary mask itself is fast everywhere (0.19 s MPS, 0.41 s CPU) — it is getting
the survivors into a dense array that costs, and a vectorized multi-threaded CPU does that far better
than MPS's generic kernels.

**Caveats, stated because the numbers are load-bearing:** phase 2 in the probe COUNTS faces rather
than building quads, so 1.3 s understates it; and phases 3-4 — Taubin smoothing, per-label
compaction, normals, about 11 s of the 25 s total — are not prototyped at all, though `index_select`
and `scatter_add_` make them natural in torch. A full torch-CPU implementation is plausibly 3-5 s,
not 1.3 s.

### What this means for the decision

**The 11x that matters comes from vectorization and multi-threading, not from the GPU.** That is
available two ways:

1. **Parallel CPU workers in TypeScript** (1-3 days, recommended above, unchanged) — stays in
   process, no new dependency, no labelmap round-trip.
2. **Surface extraction as a haversack task in torch** — Ron's suggestion, and it is a genuinely good
   fit for reasons beyond speed:
   - **Albula already talks to haversack.** `logic/haversack.ts`, `desktop/haversack-proxy.ts` and
     `render/demos/ai-seg-panel.ts` exist and are used; haversack exposes `/v1/jobs`,
     `/v1/jobs/{jid}/events` (progress) and `/v1/jobs/{jid}/result`. The transport, job, progress and
     result plumbing is all there already — which is most of what an integration usually costs.
   - **Portable by construction**, on MPS, CUDA and CPU from one implementation, with `select()`
     already choosing. No WGSL, no per-vendor kernels, no device-limit tiling.
   - It puts heavy compute where the team's other heavy compute lives, which matches Ron's framing:
     "ultimately we are a team."

   Against it: a labelmap round-trip out of a process that already holds it, a Python dependency on
   the display path, and surface extraction leaving the renderer.

**Either way, do NOT build the WGSL port on these numbers.** The measurement says the GPU is the
wrong tool for this particular shape of work. The conditions listed above under "When the GPU port
DOES become the right answer" still hold — but each of them now needs its own measurement first,
because the one estimate that got tested failed badly.

## Constraints that are not negotiable

- **No resampling.** Extraction runs at the labelmap's native resolution. Everything blocky Ron
  rejected across three earlier attempts came from a coarse grid; the SDF path was capped to 256 per
  axis and looked, in his words, like "melted wax" with 2–3 mm staircase edges.
- **Shared vertices between labels.** See above. A per-label extraction that cracks at boundaries is
  a regression regardless of speed.
- **The result must stay transferable to the main thread** as plain `ArrayBuffer`s per label
  (`positions`, `normals`, `indices`), because that is what `pushSurfaces` and `setMeshGroup` consume
  — see `render/livescene.ts`.
- **Memory scales with the SURFACE, never the grid.** A previous version allocated a cell-indexed
  `Int32Array` (1.67 GB on this study) and was silently OOM-killed. `algorithms/surface-nets.test.ts`
  has a test that pins this: the same small sphere in a 64^3 and a 400^3 grid must cost about the
  same. Keep it passing.

## How to verify you have not broken it

`deno test -A --no-check algorithms/surface-nets.test.ts` — seven tests, all behavioral: a closed
outward sphere of the right volume, no deflation as smoothing grows, two touching labels sharing
vertices with no crack, outward normals, normal accuracy against an exact sphere (p95 1.44 degrees),
the memory-shape test above, and normal accuracy on ANISOTROPIC voxels (p95 6.8 degrees), which is
the case that matters clinically and was the one case with no test until 2026-09-08.

Then, on real data — this is the part that matters, and it is one file away:

```
<SlicerAlbula>/Slicer/SlicerDICOMDatabase/SlicerAlbula-Checkpoints/2026-09-08T21-46-02-107Z-ts_total.seg.nrrd
```

That path is in Ron's working folder, two levels above this repo. **The case itself is PUBLIC** —
`NEPHROGENIC` is a series of **C3N-01524**, a CPTAC case available through NCI Imaging Data Commons —
so the verification below is reproducible by anyone, not only on this machine. The checkpoint is a
plain NRRD produced by `haversack` (`ts:total`); regenerate it from the IDC series if you do not have
the file. Any equivalent whole-body multi-label segmentation exercises the code, but the triangle
count below is specific to this one.

NEPHROGENIC `ts:total`: 768 x 768 x 709, 0.65 x 0.65 x 1.00 mm, 111 labels. `parseNrrd` from
`render/nrrd.ts` reads it in one line. **A correct port produces 12,121,372 triangles** at the
current defaults (`DEFAULT_SMOOTH_ITERS = 24`, `DEFAULT_NORMAL_SMOOTH = 16`). That exact number is
the strongest single check available — it matched between the standalone harness and the running
application, which is how the data was confirmed identical.

Beyond the count, compare shading quality: mean angle between the normals at the two ends of every
mesh edge. Current values on that labelmap are mean 2.7 / p95 8.6 / p99 13.5 degrees.

## Where it plugs in

- `algorithms/surface-nets.ts` — the algorithm. Pure, no GPU, no DOM.
- `algorithms/surface-nets-worker.ts` — runs it off the drawing thread; transfers the labelmap in and
  the mesh buffers out; reports progress and its own build stamp.
- `render/livescene.ts`, `buildSurfaces()` / `pushSurfaces()` — starts the worker, caches
  `slot.surfaces`, pushes meshes, and **removes the SDF field** when they land.
- A GPU port has a device available: `render/device.ts`. Note the worker currently has no WebGPU
  device of its own — deciding whether the compute runs in the worker (needs its own device) or on
  the main thread (must not block it) is an early design decision, and the reason the CPU version
  went to a worker at all is that a 118 s synchronous freeze is unacceptable.

## History worth not repeating

Three earlier attempts at 3D segment surfaces were rejected by Ron on appearance, in order: a blurred
presence volume ("looks like a quarry"), an SDF shell at native resolution (1.1 GB, "no go"), and an
SDF on a capped grid ("still looks like a quarry", then "too coarse and the boundaries are too
jagged"). Surface nets at native resolution is the fourth and the one that worked. The lesson is that
**resolution was always the complaint** — do not trade it back for speed.

Also: the last three rounds of debugging were all one bug wearing different clothes, and the
symptom each time was Ron saying the picture looked wrong while the measurements said the change had
worked. Two of those rounds were spent tuning geometry that was being drawn underneath a coarse SDF
nothing ever removed. If a measured improvement produces no visible change, ask what is actually
being rasterized before tuning further.

## Does a fresh session make sense?

Yes, and the reasons are specific:

- The work is **self-contained**: one algorithm file, one worker, two call sites, a test file, and a
  real labelmap on disk to check against.
- Its **acceptance criterion is a number** — 12,121,372 triangles, seven passing tests, and a wall
  clock — so it does not need the design conversation that produced it.
- The conversation that produced it is long and mostly about things now settled (color policy, the
  anatomy tree, DICOM writers), none of which bears on the port.

What a fresh session must NOT have to rediscover is in this file: the constraints, the verification
data, the phase timings, and step 0. Start with step 0, because it may cancel the project.
