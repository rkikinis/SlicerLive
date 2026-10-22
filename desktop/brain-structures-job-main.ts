// THE BRAIN'S STRUCTURES AT IMPORT, AS A PROGRAM (logic/import-jobs/brain-structures.ts is the library). The core's own
// import-time job: Albula's server starts it, as it starts the extensions' jobs (desktop/extension-jobs.ts), a little
// while after series were added to a database and once at startup; it can be run by hand against a running server:
//
//   deno run -A --config Contents/src/SlicerLive/deno.jsonc Contents/src/SlicerLive/desktop/brain-structures-job-main.ts \
//     --server http://127.0.0.1:<port> --db <database id> [--series <SeriesInstanceUID>] [--counts-only] [--only-missing] [--parent <pid>]
//
// The same contract as the diffusion extension's job (its import-job-main.ts): ONE JSON OBJECT A LINE on standard output
// ({"event": "plan" | "case" | "progress" | "done" | "error"}); `--counts-only` prints states and counts only, never an
// identifier, a name, a path or an error text; a made result is kept (`--only-missing` is how the server runs it; the
// only way it runs: nothing is ever made twice). Exit 0 when every case ended made, kept or not for this network; 1 when
// one failed; 2 for a wrong call; 3 when another run holds the database; 4 when the server went.
//
// A SCAN THAT FAILED is remembered in the database's marker file (desktop/job-marker.ts), with these rules' number, and
// not tried again at the next start -- only when the rules change, or when it is named with `--series` (critic
// 2026-10-20, finding 9). WHILE THE PAGE HOLDS THE GRAPHICS CARD (POST /_jobs/hold: the person's work on it), no next
// case starts; the one running is not stopped (finding 13).
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { setDicomLibrary } from "../logic/dicom-io.ts";
import dcmjs from "../logic/dcmjs.ts";
import { indexSeries } from "./series-files.ts";
import { provenanceEdges, provenancePathFor } from "./db-index.ts";
import { failedBefore, rememberFailure } from "./job-marker.ts";
import { BRAIN_JOB_KEY, BRAIN_JOB_VERSION, BRAIN_TASK, waitWhileHeld, headFacts, isHeadScan, madeFor, madeForStudy, makeBrainStructures, readT1, studyOrder, t1Candidates, takes } from "../logic/import-jobs/brain-structures.ts";

const args = parseArgs(Deno.args, { string: ["server", "db", "series", "parent", "core-version"], boolean: ["counts-only", "only-missing"] });
const quiet = args["counts-only"];
const QUIET_KEYS = new Set(["at", "event", "case", "of", "state", "cases", "studies", "seconds", "wall", "made", "kept", "waiting", "cannot", "failed", "stopped", "structures"]);
const say = (o: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), ...o };
  console.log(JSON.stringify(quiet ? Object.fromEntries(Object.entries(line).filter(([k]) => QUIET_KEYS.has(k))) : line));
};
if (!args.server || !args.db) { say({ event: "error", said: "needs --server and --db" }); Deno.exit(2); }
const server = args.server.replace(/\/+$/, "");

let lock: string | undefined;
// THE PARENT: when Albula's server goes, so does this run -- its result could not be stored anyway.
if (args.parent) {
  const parent = args.parent;
  setInterval(async () => {
    const o = await new Deno.Command("kill", { args: ["-0", parent], stdout: "null", stderr: "null" }).output().catch(() => null);
    if (o && !o.success) { if (lock) await Deno.remove(lock).catch(() => {}); Deno.exit(4); }
  }, 5000);
}

const RULES = `brain-structures v${BRAIN_JOB_VERSION}`;
let exitCode = 0;
try {
  setDicomLibrary(dcmjs);
  const list = await (await fetch(`${server}/_db`)).json() as { databases: { id: string; path: string }[] };
  const db = list.databases.find((d) => d.id === args.db);
  if (!db) { say({ event: "error", stopped: "no such database", said: `no database "${args.db}" is registered with the server` }); Deno.exit(2); }
  // ONE RUN AT A TIME per database, as the diffusion job's lock: atomic, holding this process's id; a dead holder's is taken over.
  lock = `${db.path}/SlicerAlbula-SEG/.brain-structures-job.lock`;
  await Deno.mkdir(`${db.path}/SlicerAlbula-SEG`, { recursive: true });
  const take = async () => { const f = await Deno.open(lock!, { write: true, createNew: true }); await f.write(new TextEncoder().encode(String(Deno.pid))); f.close(); };
  try { await take(); } catch {
    const held = (await Deno.readTextFile(lock).catch(() => "")).trim();
    const ps = held ? await new Deno.Command("ps", { args: ["-p", held, "-o", "command="], stdout: "piped", stderr: "null" }).output().catch(() => null) : null;
    if (ps?.success && /brain-structures-job-main/.test(new TextDecoder().decode(ps.stdout))) { lock = undefined; say({ event: "error", stopped: "another run holds this database", said: "another run is finding brain structures in this database" }); Deno.exit(3); }
    await Deno.remove(lock).catch(() => {});
    try { await take(); } catch { lock = undefined; say({ event: "error", stopped: "another run holds this database", said: "another run took the database at the same moment" }); Deno.exit(3); }
  }

  const rows = await indexSeries(db.path);
  const edges = await provenanceEdges(provenancePathFor(db.path)).catch(() => []);
  // A SERIES NAMED BY HAND IS TAKEN AS A T1 OF THE HEAD whatever its description, its body part or its study's
  // description say (Slicer's own "MR-head" is not named as one, and a crop is left out of the automatic run): the
  // person's word, not the guess -- neither t1Candidates nor isHeadScan decides it (critic 2026-10-20, section 11: the
  // head test still refused a named T1 in a study that says nothing about the head). It is made unless THAT series has
  // its brain -- not the study (Ron, 2026-10-20, remaking the brains two saved scenes show after every FastSurfer result
  // was deleted to be made again). FastSurfer itself still has the last word on a scan that is not a brain.
  const t1s = args.series ? rows.filter((r) => r.seriesUID === args.series && r.modality === "MR") : t1Candidates(rows);
  // A STUDY AT A TIME, one brain each (studyOrder): its T1 scans in order of preference, the first that is a head scan
  // FastSurfer takes is run; a study with one already made is kept whole.
  const studies = [...new Set(t1s.map((r) => r.studyUID))];
  say({ event: "plan", studies: studies.length, cases: t1s.length, said: `${t1s.length} scan${t1s.length === 1 ? "" : "s"} named as a T1, in ${studies.length} stud${studies.length === 1 ? "y" : "ies"} (${BRAIN_TASK}, rules v${BRAIN_JOB_VERSION})` });
  const n = { made: 0, kept: 0, waiting: 0, cannot: 0, failed: 0 };
  let k = 0;
  for (const study of studies) {
    k++;
    const t0 = performance.now();
    const inStudy = t1s.filter((r) => r.studyUID === study);
    const studyRows = rows.filter((r) => r.studyUID === study);
    if (args.series ? madeFor(args.series, rows, edges) : madeForStudy(study, rows, edges)) { n.kept++; say({ event: "case", case: k, of: studies.length, study, state: "kept", said: "the brain's structures are there; kept" }); continue; }
    try {
      const facts = new Map<string, Awaited<ReturnType<typeof headFacts>>>();
      for (const r of inStudy) facts.set(r.seriesUID, await headFacts(db.path, r));
      const heads = args.series ? inStudy : inStudy.filter((r) => { const f = facts.get(r.seriesUID)!; return isHeadScan(f.bodyPart, f.studyDescription, studyRows); });
      if (!heads.length) { n.cannot++; say({ event: "case", case: k, of: studies.length, study, state: "cannot", said: "not run: not known to be a scan of the head" }); continue; }
      let done = false, why = "";
      for (const row of studyOrder(heads, new Map([...facts].map(([u, f]) => [u, f.images])))) {
        // FAILED BEFORE under these rules: not tried again (by hand, with --series, it is), and not even read.
        const failedAt = args.series ? undefined : await failedBefore(db.path, BRAIN_JOB_KEY, row.seriesUID, RULES);
        if (failedAt) { why = `it failed on ${failedAt.slice(0, 10)} with these rules (${RULES}); it is tried again when they change`; continue; }
        const t1 = await readT1(db.path, row);
        const ok = takes(t1.frames);
        if (!ok.ok) { why = ok.why; continue; }
        // WHAT FASTSURFER WILL WORK ON, in voxels (haversack's conform, brain-structures.ts conformedGrid).
        const gr = ok.grid;
        say({ event: "progress", case: k, series: row.seriesUID, said: `FastSurfer works on a ${gr.side}-voxel cube at ${gr.voxelMm.toFixed(2)} mm${gr.floored ? " (the scan's finer voxel raised to haversack's 0.7 mm)" : ""}${gr.onHost ? "; its field is too large for one graphics-card buffer and is held in the Mac's memory, which is slower" : ""}` });
        await waitWhileHeld(server, (line) => say({ event: "progress", case: k, said: line }));
        const out = await makeBrainStructures(server, db.id, row, t1, (line) => say({ event: "progress", case: k, series: row.seriesUID, said: line }), args["core-version"]);
        n[out.state]++;
        if (out.state === "failed") exitCode = 1;
        if (out.state === "failed" && out.remember) await rememberFailure(db.path, BRAIN_JOB_KEY, row.seriesUID, RULES);
        const wall = +((performance.now() - t0) / 1000).toFixed(1);
        say(out.state === "made"
          ? { event: "case", case: k, of: studies.length, series: row.seriesUID, state: "made", structures: out.structures, seconds: +out.seconds.toFixed(1), wall, said: `${out.structures} structures${out.cached ? " (from the server's cache)" : ""}` }
          : { event: "case", case: k, of: studies.length, series: row.seriesUID, state: out.state, wall, said: out.why });
        done = true;
        break;
      }
      if (!done) { n.cannot++; say({ event: "case", case: k, of: studies.length, study, state: "cannot", said: `not run: ${why}` }); }
    } catch (e) {
      n.failed++; exitCode = 1;
      say({ event: "case", case: k, of: studies.length, study, state: "failed", said: `could not be made: ${(e as Error).message}` });
    }
  }
  say({ event: "done", ...n, said: `brain structures: ${n.made} made, ${n.kept} kept as made, ${n.waiting} waiting, ${n.cannot} not for this network, ${n.failed} failed` });
} catch (e) {
  say({ event: "error", stopped: "stopped by an error", said: (e as Error).message });
  exitCode = 1;
} finally {
  if (lock) await Deno.remove(lock).catch(() => {});
}
Deno.exit(exitCode);
