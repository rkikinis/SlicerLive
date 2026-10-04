// TRANSFER BETWEEN DATABASES: copy or move series from one registered DICOM database to another.
//
// Ron, 2026-10-02: "There should be a user accessible copy/move patient or study from one db to the other. locate this
// functionality In the load/save module." The rules he set: an original scan is never held twice in one database; a move
// is careful -- nothing leaves the first database until every file has arrived and been read back identical, and then
// only on a second press; every transfer is written into BOTH databases' records (the future audit database, which users
// will read). Mockup: Contents/docs/mockups/transfer-databases-2026-10-02.html (SlicerAlbula workspace).
//
//   1. COPY through the importer (db-import.ts): the same layout, the same "already there" rule by SOPInstanceUID, one
//      lock, one backup and one audit of the index. Deno's copy clones on APFS, so a copy on one Mac disk takes no space.
//   2. CHECK every image of every series: the file the target's index names for it, byte for byte against the source's,
//      and never the same file under two names (a folder registered twice: critic, 2026-10-02, finding 1).
//   3. CARRY what DICOM does not hold -- derivation edges, series attributes, saved scenes -- when the target keeps its
//      own provenance store (two databases in one folder share one, and then there is nothing to carry but the scenes).
//   4. RECORD, in both databases (`albula-record.jsonl`, one JSON object a line): what happened, no more.
//   5. A move's REMOVAL is a separate call (`removeTransferred`), under the target's index lock, for the series step 2
//      found whole and identical -- checked again first. Then the scenes that went with them, and a second record line.
//
// The critic's round on the first version: Contents/docs/qa/2026-10-02-database-transfer.md (SlicerAlbula workspace).
import { deleteSeriesBatchLocked, provenanceEdges, provenancePathFor, seriesAttributes, seriesFilePaths, withIndexLock, type ProvenanceEdge } from "./db-index.ts";
import { importFiles, type ImportProgress } from "./db-import.ts";
import { deleteScene, importScene, listScenes, mergeProvenance, type SceneRow } from "./scenes.ts";
import { seriesNamed } from "../logic/scene/check.ts";

export const RECORD_FILE = "albula-record.jsonl";
const UID = /^[0-9][0-9.]{0,63}$/;

export interface TransferSide { id: string; path: string; name: string }

export interface TransferProgress {
  phase: "reading" | "copying" | "checking" | "carrying" | "ready" | "removing" | "done";
  /** Scans in this transfer, and how many the current phase has finished. */
  series: number;
  seriesDone: number;
  /** While reading: images in the scans, and read so far. */
  images?: number;
  imagesDone?: number;
}

export interface TransferredSeries { uid: string; study: string; patientID: string; patientName: string; modality: string; description: string; instances: number }

export interface TransferResult {
  /** Every series in the transfer, as the source describes it (those asked for, and for a move the results made from them). */
  series: TransferredSeries[];
  /** Results that go with a moved scan without being asked for (a result stays with what it was made from). */
  withTheirScans: number;
  /** Series new to the target, images copied, images the target already held. */
  added: number;
  instances: number;
  already: number;
  /** Series whose every image is in the target, whole and identical: the ones a move may remove. */
  identical: string[];
  /** Series where an image is missing from the target, differs, or is the very same file under a second name. */
  differ: { uid: string; description: string; missing: number; different: number; same?: number }[];
  failed: { uid: string; description: string; error: string }[];
  edges: number;
  attributes: number;
  /** Scenes copied, and every scene of the source the target now holds (copied now or before): a move takes them along. */
  scenes: number;
  scenesThere: string[];
  notes: string[];
  ms: number;
  removed?: RemoveResult;
}

export interface RemoveResult {
  series: number;
  files: number;
  scenes: number;
  /** Scans taken out of the first database whose files lay outside its folder: left where they are. */
  outside: { description: string; files: number }[];
  /** Scans not taken out, and why. */
  kept: { uid: string; description: string; reason: string }[];
}

/** What the record holds, one line per event, in each of the two databases. */
export interface RecordEntry {
  at: string;
  what: "copied in" | "copied out" | "moved out" | "move finished" | "move not finished: kept in both";
  from: { id: string; name: string; path: string };
  to: { id: string; name: string; path: string };
  patients: { id: string; name: string }[];
  studies: string[];
  series: { uid: string; modality: string; description: string; instances: number }[];
  scenes?: number;
  checked: string;
  /** For the first step of a move: the removal from the first database waits for the person's second press. */
  waiting?: string;
  by: string;
}

async function sqlite(dbPath: string, sql: string): Promise<string> {
  const p = new Deno.Command("sqlite3", { args: ["-readonly", dbPath], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(".timeout 5000\n" + sql)); await w.close();
  const out = await p.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || "sqlite failed");
  return new TextDecoder().decode(out.stdout);
}
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const json = async <T>(db: string, sql: string): Promise<T[]> => { const raw = (await sqlite(db, ".mode json\n" + sql)).trim(); return raw ? JSON.parse(raw) as T[] : []; };

/** The series as an index describes them, with their patient. */
async function describe(dbDir: string, uids: string[]): Promise<TransferredSeries[]> {
  const out: TransferredSeries[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const part = uids.slice(i, i + 500);
    out.push(...await json<TransferredSeries>(`${dbDir}/ctkDICOM.sql`, `SELECT s.SeriesInstanceUID AS uid, s.StudyInstanceUID AS study, COALESCE(p.PatientID,'') AS patientID,
      COALESCE(p.PatientsName,'') AS patientName, COALESCE(s.Modality,'') AS modality, COALESCE(s.SeriesDescription,'') AS description,
      (SELECT COUNT(*) FROM Images i WHERE i.SeriesInstanceUID=s.SeriesInstanceUID) AS instances
      FROM Series s LEFT JOIN Studies st ON st.StudyInstanceUID=s.StudyInstanceUID LEFT JOIN Patients p ON p.UID=st.PatientsUID
      WHERE s.SeriesInstanceUID IN (${part.map(q).join(",")});`));
  }
  return out;
}

/** Image -> file, as an index names them, for these series. Relative names made absolute; `raw` as the row has it. */
async function filesBySop(dbDir: string, uids: string[]): Promise<Map<string, { series: string; file: string; raw: string }>> {
  const m = new Map<string, { series: string; file: string; raw: string }>();
  for (let i = 0; i < uids.length; i += 500) {
    const part = uids.slice(i, i + 500);
    for (const r of await json<{ sop: string; series: string; f: string | null }>(`${dbDir}/ctkDICOM.sql`,
      `SELECT SOPInstanceUID AS sop, SeriesInstanceUID AS series, Filename AS f FROM Images WHERE SeriesInstanceUID IN (${part.map(q).join(",")});`)) {
      if (r.f) m.set(r.sop, { series: r.series, file: r.f.startsWith("/") ? r.f : `${dbDir}/${r.f}`, raw: r.f });
    }
  }
  return m;
}
type Files = Awaited<ReturnType<typeof filesBySop>>;
function groupBySeries(m: Files): Map<string, [string, { series: string; file: string; raw: string }][]> {
  const g = new Map<string, [string, { series: string; file: string; raw: string }][]>();
  for (const e of m) { const l = g.get(e[1].series) ?? []; l.push(e); g.set(e[1].series, l); }
  return g;
}

/** The very same file under two names (a link, a folder registered twice): one device, one inode. */
export async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([Deno.stat(a), Deno.stat(b)]);
  return sa.dev === sb.dev && sa.ino !== null && sa.ino === sb.ino;
}

/** Byte for byte. */
export async function sameBytes(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([Deno.stat(a), Deno.stat(b)]);
  if (sa.size !== sb.size) return false;
  using fa = await Deno.open(a, { read: true });
  using fb = await Deno.open(b, { read: true });
  const ba = new Uint8Array(1 << 20), bb = new Uint8Array(1 << 20);
  for (;;) {
    const na = await readFull(fa, ba), nb = await readFull(fb, bb);
    if (na !== nb) return false;
    if (na === 0) return true;
    for (let i = 0; i < na; i++) if (ba[i] !== bb[i]) return false;
  }
}
async function readFull(f: Deno.FsFile, buf: Uint8Array): Promise<number> {
  let n = 0;
  while (n < buf.length) { const k = await f.read(buf.subarray(n)); if (!k) break; n += k; }
  return n;
}

/** Compare one series' images in the two databases: missing, different, the same file. */
async function compare(images: [string, { file: string }][], dst: Files): Promise<{ missing: number; different: number; same: number }> {
  let missing = 0, different = 0, same = 0;
  for (const [sop, a] of images) {
    const b = dst.get(sop);
    if (!b) { missing++; continue; }
    if (await sameFile(a.file, b.file).catch(() => false)) { same++; continue; }
    if (!(await sameBytes(a.file, b.file).catch(() => false))) different++;
  }
  return { missing, different, same };
}

/** One database, not two names for one folder (finding 1): the real paths of the two folders. */
export async function sameDatabase(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([Deno.realPath(a).catch(() => a), Deno.realPath(b).catch(() => b)]);
  return ra.replace(/\/+$/, "") === rb.replace(/\/+$/, "");
}

/** The results made from these series in this database (children of children too), by the provenance store's edges. */
async function resultsMadeFrom(dbDir: string, uids: string[]): Promise<string[]> {
  const prov = provenancePathFor(dbDir);
  if (!(await Deno.stat(prov).then(() => true, () => false))) return [];
  const edges = await provenanceEdges(prov);
  const kids = new Map<string, string[]>();
  for (const e of edges) if (e.parent) { const l = kids.get(e.parent) ?? []; l.push(e.child); kids.set(e.parent, l); }
  const seen = new Set(uids), out: string[] = [];
  const stack = [...uids];
  while (stack.length) for (const c of kids.get(stack.pop()!) ?? []) if (!seen.has(c)) { seen.add(c); out.push(c); stack.push(c); }
  const here = new Set((await describe(dbDir, out)).map((s) => s.uid));
  return out.filter((u) => here.has(u));
}

/** A scene's identity across databases: its study, name, when it was produced and its save number. */
const sceneKey = (r: SceneRow) => `${r.study}\u0000${r.name}\u0000${r.producedAt}\u0000${r.v}`;

/** Copy `uids` from one database to the other, check every image, carry provenance and scenes, write both records. */
export async function transferSeries(from: TransferSide, to: TransferSide, uids: string[], opts: { move?: boolean; scenes?: boolean; by?: string; onProgress?: (p: TransferProgress) => void } = {}): Promise<TransferResult> {
  const t0 = performance.now();
  if (await sameDatabase(from.path, to.path)) throw new Error("the two are the same database (one folder, perhaps under two names)");
  for (const d of [from, to]) if (!(await Deno.stat(`${d.path}/ctkDICOM.sql`).then((s) => s.isFile, () => false))) throw new Error(`${d.name}'s index cannot be read`);
  uids = [...new Set(uids)].filter((u) => UID.test(u));
  if (!uids.length) throw new Error("nothing chosen");
  const notes: string[] = [];
  // A RESULT STAYS WITH WHAT IT WAS MADE FROM: a move takes the results made from its scans along; leaving them behind
  // lost their "made from" link in both databases (critic, 2026-10-02, finding 3).
  let withTheirScans = 0;
  if (opts.move) {
    const extra = (await resultsMadeFrom(from.path, uids)).filter((u) => !uids.includes(u));
    withTheirScans = extra.length;
    uids = [...uids, ...extra];
    if (extra.length) notes.push(`${extra.length === 1 ? "One result" : `${extra.length} results`} made from these scans ${extra.length === 1 ? "goes" : "go"} with them.`);
  }
  const prog: TransferProgress = { phase: "reading", series: uids.length, seriesDone: 0 };
  opts.onProgress?.({ ...prog });
  const series = await describe(from.path, uids);
  const missingHere = uids.filter((u) => !series.some((s) => s.uid === u));
  if (missingHere.length) notes.push(`${missingHere.length} of the chosen scans ${missingHere.length === 1 ? "is" : "are"} not in ${from.name} any more.`);
  const failed: TransferResult["failed"] = [];

  // 1. COPY.
  const files: string[] = [];
  for (const s of series) files.push(...await seriesFilePaths(from.path, s.uid));
  const onImport = (p: ImportProgress) => {
    if (p.phase === "reading") { prog.phase = "reading"; prog.images = p.files; prog.imagesDone = p.read; }
    else { prog.phase = "copying"; prog.series = Math.max(p.series, 0); prog.seriesDone = p.seriesDone; }
    opts.onProgress?.({ ...prog });
  };
  const imp = await importFiles(to.path, files, { onProgress: onImport });
  for (const f of imp.failed) failed.push(f);
  if (imp.skippedCount) notes.push(`${imp.skippedCount} file${imp.skippedCount === 1 ? "" : "s"} of ${from.name} could not be read and ${imp.skippedCount === 1 ? "was" : "were"} not copied.`);
  notes.push(...imp.notes);

  // 2. CHECK every image: the target's file for it against the source's.
  prog.phase = "checking"; prog.series = series.length; prog.seriesDone = 0;
  opts.onProgress?.({ ...prog });
  const src = await filesBySop(from.path, series.map((s) => s.uid));
  const dst = await filesBySop(to.path, series.map((s) => s.uid));
  const identical: string[] = [], differ: TransferResult["differ"] = [];
  const bySeries = groupBySeries(src);
  for (const s of series) {
    const images = bySeries.get(s.uid) ?? [];
    if (!images.length) failed.push({ uid: s.uid, description: s.description, error: `its index in ${from.name} names no image files` });
    const c = await compare(images, dst);
    if (c.missing || c.different || c.same) differ.push({ uid: s.uid, description: s.description, missing: c.missing, different: c.different, ...(c.same ? { same: c.same } : {}) });
    else if (images.length && !failed.some((f) => f.uid === s.uid)) identical.push(s.uid);
    prog.seriesDone++;
    opts.onProgress?.({ ...prog });
  }

  // 3. CARRY derivation edges and attributes (both ends in the target), and the scenes of these studies. A store that
  // cannot be written is said, and the record is still written: the images are in (finding 6).
  prog.phase = "carrying";
  opts.onProgress?.({ ...prog });
  let edges = 0, attributes = 0, scenes = 0;
  const scenesThere: string[] = [];
  const provFrom = provenancePathFor(from.path), provTo = provenancePathFor(to.path);
  const shared = provFrom === provTo || await sameDatabase(provFrom, provTo);
  const hasProv = await Deno.stat(provFrom).then(() => true, () => false);
  try {
    if (hasProv && !shared) {
      const set = new Set(identical);
      const all = await provenanceEdges(provFrom);
      const touching = all.filter((e) => set.has(e.child) || (e.parent && set.has(e.parent)));
      const ends = [...new Set(touching.flatMap((e) => [e.child, e.parent]).filter(Boolean))];
      const inTarget = new Set((await describe(to.path, ends)).map((s) => s.uid));
      const carry: ProvenanceEdge[] = touching.filter((e) => inTarget.has(e.child) && (!e.parent || inTarget.has(e.parent)));
      const attrs = (await seriesAttributes(provFrom)).filter((a) => set.has(a.uid));
      ({ edges, attributes } = await mergeProvenance(provTo, { edges: carry, attributes: attrs }));
    }
  } catch (e) {
    notes.push(`Which scan was made from which could not be written into ${to.name}'s store (${(e as Error).message}); the images are there.`);
  }
  try {
    if (opts.scenes && hasProv) {
      const studies = new Set(series.map((s) => s.study));
      const there = new Set((await listScenes(to.path)).map(sceneKey));
      for (const row of await listScenes(from.path)) {
        if (!(row.studies ?? [row.study]).some((st) => studies.has(st))) continue;
        if (there.has(sceneKey(row))) { scenesThere.push(row.uid); continue; }   // copied before
        const doc = JSON.parse(await Deno.readTextFile(`${from.path}/${row.path}`)) as Record<string, unknown>;
        // ONE STORE, TWO DATABASES: the copy is a scene of its own, under its own uid, so neither database's list, save
        // or delete reaches the other's (finding 2).
        const r = await importScene(to.path, shared ? { ...doc, uid: newUid() } : doc);
        if ("error" in r) notes.push(`The scene “${row.name}” was not copied: ${r.error}.`);
        else { scenes++; scenesThere.push(row.uid); }
      }
    }
  } catch (e) {
    notes.push(`Saved scenes could not be copied (${(e as Error).message}).`);
  }

  // 4. RECORD, in both: what happened at this step.
  const all = series.length, whole = identical.length;
  const base = {
    at: new Date().toISOString(), from: { id: from.id, name: from.name, path: from.path }, to: { id: to.id, name: to.name, path: to.path },
    patients: patientsOf(series), studies: [...new Set(series.map((s) => s.study))],
    series: series.map((s) => ({ uid: s.uid, modality: s.modality, description: s.description, instances: s.instances })),
    ...(scenes ? { scenes } : {}),
    checked: whole === all ? `all ${all} scans arrived whole and identical` : `${whole} of ${all} scans arrived whole and identical; ${all - whole} did not`,
    ...(opts.move ? { waiting: `a move: removal from ${from.name} waits for the second press` } : {}),
    by: opts.by ?? "Albula",
  };
  await appendRecord(to.path, { ...base, what: "copied in" });
  await appendRecord(from.path, { ...base, what: "copied out" });

  prog.phase = opts.move ? "ready" : "done";
  opts.onProgress?.({ ...prog });
  return {
    series, withTheirScans, added: imp.series.length, instances: imp.instances, already: imp.already, identical, differ, failed, edges, attributes, scenes, scenesThere, notes,
    ms: Math.round(performance.now() - t0),
  };
}

const newUid = () => "2.25." + crypto.getRandomValues(new BigUint64Array(2)).reduce((a, b) => a * 18446744073709551616n + b, 0n).toString();
const patientsOf = (s: TransferredSeries[]) => [...new Map(s.map((x) => [`${x.patientID}\u0000${x.patientName}`, { id: x.patientID, name: x.patientName }])).values()];

/**
 * A move's second step: take out of the first database the series `transferSeries` found whole and identical in the
 * second -- checked again now, UNDER THE SECOND DATABASE'S INDEX LOCK so nothing takes them out of it meanwhile
 * (finding 15) -- in one delete (one backup, one audit: finding 11). Then the scenes that went with them.
 */
export async function removeTransferred(from: TransferSide, to: TransferSide, result: TransferResult, opts: { by?: string; onProgress?: (p: TransferProgress) => void } = {}): Promise<RemoveResult> {
  const prog: TransferProgress = { phase: "removing", series: result.identical.length, seriesDone: 0 };
  opts.onProgress?.({ ...prog });
  const kept: RemoveResult["kept"] = [];
  const out: RemoveResult = { series: 0, files: 0, scenes: 0, outside: [], kept };
  if (await sameDatabase(from.path, to.path)) {
    for (const uid of result.identical) kept.push({ uid, description: result.series.find((s) => s.uid === uid)?.description ?? "", reason: "the two are the same database" });
    return out;
  }
  const removed: TransferredSeries[] = [];
  await withIndexLock(to.path, async () => {
    const src = await filesBySop(from.path, result.identical);
    const dst = await filesBySop(to.path, result.identical);
    const bySeries = groupBySeries(src);
    const ok: string[] = [];
    for (const uid of result.identical) {
      const s = result.series.find((x) => x.uid === uid)!;
      const images = bySeries.get(uid) ?? [];
      const c = await compare(images, dst);
      if (!images.length) kept.push({ uid, description: s.description, reason: `no longer in ${from.name}` });
      else if (c.missing || c.different || c.same) kept.push({ uid, description: s.description, reason: `not whole and identical in ${to.name} any more` });
      else ok.push(uid);
      prog.seriesDone++;
      opts.onProgress?.({ ...prog });
    }
    if (!ok.length) return;
    const r = await withIndexLock(from.path, () => deleteSeriesBatchLocked(from.path, ok));
    out.series = r.series; out.files = r.files.length;
    for (const uid of ok) removed.push(result.series.find((x) => x.uid === uid)!);
    // Files outside the first database's folder were the person's own and stay where they are: said per scan.
    const outsideBy = new Map<string, number>();
    const rawToSeries = new Map([...src.values()].map((v) => [v.raw, v.series]));
    for (const raw of r.leftInPlace ?? []) { const u = rawToSeries.get(raw); if (u) outsideBy.set(u, (outsideBy.get(u) ?? 0) + 1); }
    for (const [u, n] of outsideBy) out.outside.push({ description: result.series.find((x) => x.uid === u)?.description ?? "", files: n });
  });
  // THE SCENES THAT WENT WITH THEM: a scene the second database holds whose scans have all left the first (finding 10).
  if (removed.length && result.scenesThere.length) {
    const rows = await listScenes(from.path);
    for (const uid of result.scenesThere) {
      const row = rows.find((r) => r.uid === uid);
      if (!row) continue;
      const named = [...new Set(seriesNamed(JSON.parse(await Deno.readTextFile(`${from.path}/${row.path}`)) as Record<string, unknown>).map((x) => x.uid))];
      if ((await describe(from.path, named)).length) continue;            // some of its scans are still here: it stays
      if (await deleteScene(from.path, uid)) out.scenes++;
    }
  }
  if (removed.length) {
    const entry = {
      at: new Date().toISOString(), from: { id: from.id, name: from.name, path: from.path }, to: { id: to.id, name: to.name, path: to.path },
      patients: patientsOf(removed), studies: [...new Set(removed.map((s) => s.study))],
      series: removed.map((s) => ({ uid: s.uid, modality: s.modality, description: s.description, instances: s.instances })),
      ...(out.scenes ? { scenes: out.scenes } : {}),
      checked: `each read back whole and identical in ${to.name} just before it was removed from ${from.name}`,
      by: opts.by ?? "Albula",
    };
    await appendRecord(from.path, { ...entry, what: "moved out" });
    await appendRecord(to.path, { ...entry, what: "move finished" });
  }
  prog.phase = "done";
  opts.onProgress?.({ ...prog });
  return out;
}

/** A move the person chose not to finish: said in both records, so the first step's lines are not read as a move. */
export async function recordKept(from: TransferSide, to: TransferSide, result: TransferResult, by = "Albula"): Promise<void> {
  const entry: RecordEntry = {
    at: new Date().toISOString(), what: "move not finished: kept in both", from: { id: from.id, name: from.name, path: from.path }, to: { id: to.id, name: to.name, path: to.path },
    patients: patientsOf(result.series), studies: [...new Set(result.series.map((s) => s.study))],
    series: result.series.map((s) => ({ uid: s.uid, modality: s.modality, description: s.description, instances: s.instances })),
    checked: "nothing was removed", by,
  };
  await appendRecord(from.path, entry);
  await appendRecord(to.path, entry);
}

/** One line added to a database's record. Never rewrites what is there. */
export async function appendRecord(dbDir: string, entry: RecordEntry): Promise<void> {
  await Deno.writeTextFile(`${dbDir}/${RECORD_FILE}`, JSON.stringify(entry) + "\n", { append: true, create: true });
}

/** The newest `limit` entries of a database's record, newest first. A line that does not parse is skipped. */
export async function readRecord(dbDir: string, limit = 200): Promise<RecordEntry[]> {
  let text = "";
  try { text = await Deno.readTextFile(`${dbDir}/${RECORD_FILE}`); } catch { return []; }
  const out: RecordEntry[] = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as RecordEntry); } catch { /* a torn line */ }
    if (out.length >= limit) break;
  }
  return out;
}
