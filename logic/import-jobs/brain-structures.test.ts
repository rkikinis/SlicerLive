// THE BRAIN'S STRUCTURES WHEN A T1 IS ADDED: which scans the job looks at, which it leaves alone, which it cannot run on.
//   deno test -A --no-check logic/import-jobs/brain-structures.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { brainDescription, madeFor, t1Candidates, takes } from "./brain-structures.ts";
import type { IndexSeries } from "../../desktop/series-files.ts";
import type { Volume } from "../readers/nifti.ts";

const row = (seriesUID: string, modality: string, description: string): IndexSeries =>
  ({ seriesUID, studyUID: "s", patientUID: "p", modality, seriesNumber: "1", description, frameOfReferenceUID: "f" });

Deno.test("a scan named as a T1 is looked at; diffusion, a CT, and what Albula made are not", () => {
  const rows = [row("a", "MR", "T1_mprage"), row("b", "MR", "DTI_2.5_b2800_101dir (AP)"), row("c", "CT", "T1 head"), row("d", "MR", "MPRAGE sag"),
    row("e", "MR", "fastsurfer:asegdkt of MR T1_mprage"), row("f", "MR", "Fiber tracts (whole brain)"), row("g", "MR", "T2 FLAIR"), row("h", "MR", "T12 spine")];
  assertEquals(t1Candidates(rows).map((r) => r.seriesUID), ["a", "d"]);
});

Deno.test("a T1 with the brain's structures already (made here or saved from the panel) is kept", () => {
  const rows = [row("t1", "MR", "T1_mprage"), row("seg", "SEG", brainDescription("T1_mprage")), row("tumor", "SEG", "Tumor (tumor_masks)")];
  const edges = [{ child: "tumor", parent: "t1", kind: "algorithm" }, { child: "seg", parent: "t1", kind: "algorithm" }] as never[];
  assertEquals(madeFor("t1", rows, edges), "seg");
  assertEquals(madeFor("t1", rows, [edges[0]]), undefined);   // a tumor outline is not the brain's structures
});

const vol = (dims: [number, number, number], mm: number): Volume => ({ dims, ijkToRAS: [mm, 0, 0, 0, 0, mm, 0, 0, 0, 0, mm, 0, 0, 0, 0, 1] }) as unknown as Volume;
Deno.test("FastSurfer takes one 3D scan of the whole brain, not a series in time or a thick-slice scan", () => {
  assertEquals(takes([vol([160, 256, 256], 1)]).ok, true);
  assertEquals(takes([vol([160, 256, 256], 1), vol([160, 256, 256], 1)]).ok, false);
  assertEquals(takes([vol([256, 256, 24], 1)]).ok, false);
  assertEquals(takes([vol([256, 256, 120], 3)]).ok, false);
  assertEquals(takes([vol([512, 512, 400], 1)]).ok, true);   // a large field of view is conformed, not refused (below)
});

Deno.test("head scans only: the files' body part, else the study's description, else a diffusion, FLAIR, T2, SWI or TOF scan beside it -- not in a study of the body", async () => {
  const { isHeadScan } = await import("./brain-structures.ts");
  assertEquals(isHeadScan("ABDOMEN", "MRI ABDOMEN (LIVER) WITH AND WITHOUT CON", []), false);
  assertEquals(isHeadScan("HEAD", "BTC_preop preop", []), true);
  assertEquals(isHeadScan("", "BRAIN^ROUTINE", []), true);
  assertEquals(isHeadScan("", "Preop", []), false);
  assertEquals(isHeadScan("", "Preop", [row("d", "MR", "DTI_2.5_b2800_101dir (AP)")]), true);
  // The main database's "Preop" study (critic 2026-10-20, finding 5): a brain tumor case, no body part, no diffusion.
  const preop = [row("f", "MR", "2D_AX_T2_FLAIR"), row("t2", "MR", "2D_AX_T2"), row("t1", "MR", "3D_AX_T1_postcontrast")];
  assertEquals(isHeadScan("", "Preop", preop), true);
  for (const d of ["AX SWI", "3D TOF MRA", "T2W_TSE", "Ax T2 FLAIR"]) assertEquals(isHeadScan("", "", [row("x", "MR", d), row("t1", "MR", "T1 3D")]), true, d);
  // A liver study without a body part: its DWI does not make it a head.
  assertEquals(isHeadScan("", "MRI ABDOMEN (LIVER) WITH AND WITHOUT CON", [row("d", "MR", "Ax DWI b50-800"), row("t", "MR", "T1FS 3D BH")]), false);
  assertEquals(isHeadScan("", "MR PELVIS", [row("t2", "MR", "T2 AX"), row("t1", "MR", "T1 3D")]), false);
  // A T1 alone, nothing said: not known to be a head.
  assertEquals(isHeadScan("", "", [row("t1", "MR", "T1 3D")]), false);
});

Deno.test("named as a T1 but not a T1-weighted image: quantitative maps and T1 FLAIR are not looked at (critic 2026-10-20, finding 16)", () => {
  const rows = [row("a", "MR", "T1map"), row("b", "MR", "T1 map MOLLI"), row("c", "MR", "T1rho"), row("d", "MR", "AX T1 FLAIR"), row("e", "MR", "T1_FLAIR"),
    row("f", "MR", "sag T1 MPRAGE"), row("g", "MR", "T1w"), row("h", "MR", "MP2RAGE T1 3D")];
  assertEquals(t1Candidates(rows).map((r) => r.seriesUID), ["f", "g", "h"]);
});

Deno.test("one brain per study: a plain T1 before one after contrast or a subtraction, then the most images", async () => {
  const { studyOrder } = await import("./brain-structures.ts");
  const c = [row("post", "MR", "Post Ax T1 FS 3D"), row("sub", "MR", "Post Ax T1FS 3D SUB"), row("small", "MR", "T1W_SE"), row("big", "MR", "T1W_3D_GRE")];
  const images = new Map([["post", 200], ["sub", 200], ["small", 24], ["big", 180]]);
  assertEquals(studyOrder(c, images).map((r) => r.seriesUID), ["big", "small", "post", "sub"]);
  // "C+" and "Gd" are after contrast too (critic 2026-10-20, finding 16); a word that only holds the letters is not.
  const d = [row("cplus", "MR", "AX T1 C+"), row("gd", "MR", "T1_MPRAGE_GD"), row("gad", "MR", "T1 +Gad"), row("plain", "MR", "T1 MPRAGE sagittal")];
  const n = new Map([["cplus", 300], ["gd", 300], ["gad", 300], ["plain", 176]]);
  assertEquals(studyOrder(d, n)[0].seriesUID, "plain");
});

Deno.test("FastSurfer's grid, as haversack 0.16.0 conforms (voxel floor 0.7 mm, the cube from the field of view, a large field on the host); a cube past the largest known to work on the card is refused", async () => {
  const { conformedGrid, CONFORM_FOLLOWS } = await import("./brain-structures.ts");
  const { HAVERSACK_VERSION } = await import("../../desktop/haversack-proxy.ts");
  // The model follows one haversack version; when the pin moves, this fails until the conform is read again.
  assertEquals(CONFORM_FOLLOWS, HAVERSACK_VERSION);
  const v = (dims: [number, number, number], mm: number[]) => ({ dims, ijkToRAS: [mm[0], 0, 0, 0, 0, mm[1], 0, 0, 0, 0, mm[2], 0, 0, 0, 0, 1] }) as unknown as Volume;
  const g = (dims: [number, number, number], mm: number[]) => { const t = takes([v(dims, mm)]); return t.ok ? [t.grid.side, t.grid.voxelMm, t.grid.onHost] : t.why; };
  const side = (dims: [number, number, number], mm: number[]) => conformedGrid(v(dims, mm)).side;
  // The critic's table (2026-10-20, finding 4), in voxels: the cube's side, the voxel it is made of, the field's place.
  // The studyforrest T1: 366 a side at 0.7 mm, past the 306 known to work on the card -- refused, with the reason.
  assertEquals(side([274, 384, 384], [0.7, 0.667, 0.667]), 366);
  assert(String(g([274, 384, 384], [0.7, 0.667, 0.667])).includes("366-voxel cube"));
  assertEquals(side([448, 448, 448], [0.5, 0.5, 0.5]), 320);                   // 0.5 mm over 224 mm: raised to 0.7 mm (refused: past 306)
  assertEquals(side([384, 384, 384], [0.6, 0.6, 0.6]), 330);                   // 0.6 mm over 230 mm (refused)
  assertEquals(g([306, 306, 306], [0.7, 0.7, 0.7]), [306, 0.7, false]);       // the largest known to work: run
  assertEquals(g([384, 384, 200], [0.9, 0.9, 0.9]), [384, 0.9, true]);        // 0.9 mm over 346 mm: the field goes to the host, it runs
  assertEquals(g([160, 256, 256], [1, 1, 1]), [256, 1, false]);               // 1 mm: FastSurfer's 256 cube
  assertEquals(g([176, 300, 300], [1.2, 1.2, 1.2]), [256, 1, false]);         // coarser than 1 mm: conformed at 1 mm
  assertEquals(g([176, 256, 256], [0.96, 0.96, 0.96]), [256, 1, false]);      // above 0.95 mm: snapped to 1 mm
  assertEquals(conformedGrid(v([274, 384, 384], [0.7, 0.667, 0.667])).floored, true);
  assertEquals(conformedGrid(v([160, 256, 256], [1, 1, 1])).floored, false);
});

Deno.test("a study whose crop has the brain (made under the network's earlier name) is kept", async () => {
  const { madeForStudy } = await import("./brain-structures.ts");
  const rows = [row("t1", "MR", "T1w 3D TFE 0.67 mm"), row("crop", "MR", "T1w (cropped)"), row("seg", "SEG", "fastsurfer:brain of T1w (cropped)")];
  assertEquals(madeForStudy("s", rows, [{ child: "seg", parent: "crop", kind: "algorithm" }] as never[]), "seg");
});

Deno.test("between cases the job waits while the page holds the graphics card, and says so once (critic 2026-10-20, finding 13)", async () => {
  const { waitWhileHeld } = await import("./brain-structures.ts");
  let asks = 0;
  const jobs = (() => { asks++; return Promise.resolve(new Response(JSON.stringify({ held: asks < 4 }), { status: 200 })); }) as typeof fetch;
  const lines: string[] = [];
  await waitWhileHeld("http://127.0.0.1:1", (l) => lines.push(l), 1, jobs);
  assertEquals(asks, 4);
  assertEquals(lines.length, 1);
  // A server that does not answer does not hold the run.
  await waitWhileHeld("http://127.0.0.1:1", undefined, 1, (() => Promise.reject(new Error("gone"))) as typeof fetch);
});
