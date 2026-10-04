// The page's side of the duckn working copy, end to end: a throwaway database, copies written by the
// server's converter, served by the server's own route, read by the page's reader with its worker
// running from source. Every case the critic broke on 2026-09-23 (qa/2026-09-23-duckn-working-copy.md
// in the workspace) is here, and every one must end in the same volume or in a fallback to DICOM --
// never a wrong image and never a read that does not finish.
//
//   deno test -A --no-check render/zarr-copy.test.ts
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parseInstances, volumesOfSeries } from "../logic/readers/dicom-series.ts";
import { addSeries, emptyDb } from "../desktop/duckn-copy.fixture.ts";

const userDir = await Deno.makeTempDir({ prefix: "slicerlive-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
const { handleDbRequest } = await import("../desktop/db-serve.ts");
const { resolveSettingsPath, writeSettings } = await import("../desktop/settings-file.ts");
const { writeDucknCopy } = await import("../desktop/duckn-copy.ts");
const { auditDatabase, removeDucknCopy } = await import("../desktop/db-index.ts");
const { loadSequenceFromCopy, setCopyWorkerFactory, copyMadeByOtherCode } = await import("./zarr-copy.ts");

const folder = await Deno.makeTempDir({ prefix: "slicerlive-folder-" });
const gallery = `${folder}/src/live`;
await Deno.mkdir(gallery, { recursive: true });

// One database with three series: two to read at once, one to damage.
const dir = await emptyDb();
const A = await addSeries(dir, 24, 20, 70);      // two pieces deep
const B = await addSeries(dir, 30, 18, 12);
const C = await addSeries(dir, 16, 16, 8);
await writeSettings(resolveSettingsPath(gallery), `[Database]\nt=${dir}\ncurrent=t\n`);
for (const s of [A, B, C]) await writeDucknCopy(dir, s.series.seriesInstanceUID);

const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) =>
  (await handleDbRequest(req, gallery)) ?? new Response("not here", { status: 404 }));
const base = `http://127.0.0.1:${server.addr.port}/_db/t/`;
const sourceWorker = () => new Worker(new URL("./zarr-copy-worker.ts", import.meta.url).href, { type: "module" });
setCopyWorkerFactory(sourceWorker);

/** What the DICOM load makes of the same files. */
const fromDicom = async (s: typeof A) => volumesOfSeries(await parseInstances(s.series.instances)).frames[0];
const sameVolume = async (s: typeof A, got: Awaited<ReturnType<typeof loadSequenceFromCopy>>) => {
  assert(!("missing" in got), `fell back: ${"missing" in got ? got.missing : ""}`);
  const want = await fromDicom(s);
  const v = got.frames[0];
  assertEquals(v.dims, want.dims);
  assertEquals(v.ijkToRAS, want.ijkToRAS);
  assertEquals(v.meta, want.meta);
  assertEquals(v.data.length, want.data.length);
  for (let i = 0; i < v.data.length; i++) if (v.data[i] !== want.data[i]) throw new Error(`voxel ${i}: ${v.data[i]} from the copy, ${want.data[i]} from DICOM`);
};

Deno.test({ name: "a series read from its copy is the volume the DICOM load makes", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  await sameVolume(A, await loadSequenceFromCopy(base, A.series.seriesInstanceUID));
} });

Deno.test({ name: "two reads at once both finish, each with its own volume (finding 1)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const [a, b, a2] = await Promise.all([
    loadSequenceFromCopy(base, A.series.seriesInstanceUID),
    loadSequenceFromCopy(base, B.series.seriesInstanceUID),
    loadSequenceFromCopy(base, A.series.seriesInstanceUID),
  ]);
  await sameVolume(A, a);
  await sameVolume(B, b);
  await sameVolume(A, a2);
} });

Deno.test({ name: "a damaged piece and a swapped piece each end the read; neither is shown (finding 2)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const uid = C.series.seriesInstanceUID;
  const piece = `${dir}/SlicerAlbula-Zarr/${uid}.zarr/0/c/0/0/0`;
  const original = await Deno.readFile(piece);
  try {
    const flipped = original.slice(); flipped[Math.floor(flipped.length / 2)] ^= 0x10;
    await Deno.writeFile(piece, flipped);
    const r = await loadSequenceFromCopy(base, uid);
    assert("missing" in r, "a damaged piece was used");
  } finally { await Deno.writeFile(piece, original); }
  // A swapped piece: A's first piece under C's name -- a real piece, the wrong one.
  const other = await Deno.readFile(`${dir}/SlicerAlbula-Zarr/${A.series.seriesInstanceUID}.zarr/0/c/0/0/0`);
  try {
    await Deno.writeFile(piece, other);
    const r = await loadSequenceFromCopy(base, uid);
    assert("missing" in r, "a swapped piece was used");
  } finally { await Deno.writeFile(piece, original); }
  await sameVolume(C, await loadSequenceFromCopy(base, uid));
} });

Deno.test({ name: "a file rewritten at the same size with an older time makes the copy stale (finding 3)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const uid = B.series.seriesInstanceUID;
  const file = B.files[3];
  const original = await Deno.readFile(file);
  const st = await Deno.stat(file);
  try {
    const changed = original.slice(); changed[changed.length - 3] ^= 0x01;
    await Deno.writeFile(file, changed);
    await Deno.utime(file, new Date("2020-01-01"), new Date("2020-01-01"));
    const r = await loadSequenceFromCopy(base, uid);
    assert("missing" in r, "a stale copy was used");
    assertStringIncludes(r.missing, "a file's size or time changed");
  } finally {
    await Deno.writeFile(file, original);
    await Deno.utime(file, st.atime ?? new Date(), st.mtime ?? new Date());
  }
  await sameVolume(B, await loadSequenceFromCopy(base, uid));
} });

Deno.test({ name: "a worker that cannot load ends the read instead of hanging it (finding 7)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  setCopyWorkerFactory(() => new Worker(new URL("./no-such-worker.ts", import.meta.url).href, { type: "module" }));
  try {
    const r = await loadSequenceFromCopy(base, C.series.seriesInstanceUID);
    assert("missing" in r, "a read without workers returned a volume");
    // Either way the read ENDS: the worker's load error, or -- on a loaded machine, where that error can come after
    // the piece timeout -- the timeout (seen 2026-09-25 in a full-suite run beside GPU tests).
    assert(/worker|did not arrive/.test(r.missing), `unexpected reason: ${r.missing}`);
  } finally { setCopyWorkerFactory(sourceWorker); }
  await sameVolume(C, await loadSequenceFromCopy(base, C.series.seriesInstanceUID));
} });

Deno.test({ name: "the route: another series' copy, other code, a malformed name (finding 13)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const uid = C.series.seriesInstanceUID;
  const groupFile = `${dir}/SlicerAlbula-Zarr/${uid}.zarr/zarr.json`;
  const original = await Deno.readTextFile(groupFile);
  try {
    const g = JSON.parse(original);
    g.attributes.albula.seriesInstanceUID = A.series.seriesInstanceUID;
    await Deno.writeTextFile(groupFile, JSON.stringify(g));
    const r = await loadSequenceFromCopy(base, uid);
    assert("missing" in r); assertStringIncludes(r.missing, "another series");
    g.attributes.albula.seriesInstanceUID = uid; g.attributes.albula.code = "albula-duckn-0-old";
    await Deno.writeTextFile(groupFile, JSON.stringify(g));
    const r2 = await loadSequenceFromCopy(base, uid);
    assert("missing" in r2); assertStringIncludes(r2.missing, "other code");
    g.attributes.albula.code = JSON.parse(original).attributes.albula.code; g.attributes.albula.frames = ["../../etc"];
    await Deno.writeTextFile(groupFile, JSON.stringify(g));
    const r3 = await loadSequenceFromCopy(base, uid);
    assert("missing" in r3); assertStringIncludes(r3.missing, "does not accept");
  } finally { await Deno.writeTextFile(groupFile, original); }
  const bad = await fetch(`http://127.0.0.1:${server.addr.port}/_db/%E0%A4%A/_zarr/1.2.3`);
  assertEquals(bad.status, 404);
  await bad.body?.cancel();
} });

Deno.test("a copy made by other code than the page's is refused, even when the server accepts it (critic, 2026-09-23, round 2, finding 2)", () => {
  assertEquals(copyMadeByOtherCode("albula-duckn-3-aaaaaaaaaaaa", "albula-duckn-3-aaaaaaaaaaaa", {}, {}), null);
  assertStringIncludes(copyMadeByOtherCode("albula-duckn-3-aaaaaaaaaaaa", "albula-duckn-3-bbbbbbbbbbbb")!, "other code than this page");
  assertStringIncludes(copyMadeByOtherCode(undefined, "albula-duckn-3-bbbbbbbbbbbb")!, "none named");
});

Deno.test("a copy read with other extensions' interpreters than the page's is refused", () => {
  const c = "albula-duckn-3-aaaaaaaaaaaa";
  assertEquals(copyMadeByOtherCode(c, c, { diffusion: "111" }, { diffusion: "111" }), null);
  assertEquals(copyMadeByOtherCode(c, c, undefined, {}), null);
  assertStringIncludes(copyMadeByOtherCode(c, c, { diffusion: "111" }, { diffusion: "222" })!, "other extensions");
  assertStringIncludes(copyMadeByOtherCode(c, c, undefined, { diffusion: "222" })!, "other extensions");
  assertStringIncludes(copyMadeByOtherCode(c, c, { diffusion: "111" }, {})!, "other extensions");
});

Deno.test({ name: "the Zarr description must match what Albula wrote (finding 6)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const uid = C.series.seriesInstanceUID;
  const arrFile = `${dir}/SlicerAlbula-Zarr/${uid}.zarr/0/zarr.json`;
  const original = await Deno.readTextFile(arrFile);
  try {
    const a = JSON.parse(original);
    const [cz, cy, cx] = a.chunk_grid.configuration.chunk_shape;
    a.chunk_grid.configuration.chunk_shape = [cy, cz, cx];     // the same bytes per piece, another shape
    await Deno.writeTextFile(arrFile, JSON.stringify(a));
    const r = await loadSequenceFromCopy(base, uid);
    assert("missing" in r, "a rechunked store was read by the old grid");
    assertStringIncludes(r.missing, "no longer matches");
  } finally { await Deno.writeTextFile(arrFile, original); }
} });

Deno.test({ name: "the audit names leftover and orphaned copies; removing a series' copy takes its leftovers too (finding 12)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const copies = `${dir}/SlicerAlbula-Zarr`;
  await Deno.mkdir(`${copies}/9.9.9.zarr`);                                     // a copy whose series is not in the index
  await Deno.mkdir(`${copies}/${C.series.seriesInstanceUID}.zarr.part-deadbeef`);  // a killed converter's leftover
  await Deno.writeTextFile(`${copies}/sweep-report.json`, "{}");                  // the sweep's report: not an orphan
  const audit = await auditDatabase(dir);
  const names = audit.orphans.map((p) => p.slice(copies.length + 1)).filter((p) => !p.includes("/"));
  assert(names.includes("9.9.9.zarr"), `orphans: ${names.join(", ")}`);
  assert(names.includes(`${C.series.seriesInstanceUID}.zarr.part-deadbeef`));
  assert(!names.includes(`${A.series.seriesInstanceUID}.zarr`), "a good copy called an orphan");
  assert(!names.includes("sweep-report.json"), "the sweep's report called an orphan");
  assert(!audit.orphans.some((p) => p.includes("/c/")), "the audit walked into a copy's pieces");
  await Deno.remove(`${copies}/9.9.9.zarr`);
  assert(await removeDucknCopy(dir, C.series.seriesInstanceUID));
  assertEquals([...Deno.readDirSync(copies)].map((e) => e.name).filter((n) => n.startsWith(C.series.seriesInstanceUID)), []);
  await writeDucknCopy(dir, C.series.seriesInstanceUID);                            // put back for anything after
} });

Deno.test({ name: "(stop the test server)", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  setCopyWorkerFactory(sourceWorker);
  await server.shutdown();
  for (const d of [dir, userDir, folder]) await Deno.remove(d, { recursive: true }).catch(() => {});   // nothing left in the temp folder (finding 11)
} });
