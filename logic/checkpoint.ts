// A result on disk the moment it arrives, so nothing is riding on the page staying alive.
//
// Ron lost a finished TotalSegmentator run on 2026-09-05 — "I was about to go to save, when all the
// data disappeared" — and there was nothing on disk to recover, because a result lived only in the
// renderer until Save was pressed. The renderer is a separate process that the operating system may
// end at any time; treating it as durable storage was the bug.
//
// WHAT IS WRITTEN IS WHAT ARRIVED. The bytes are checkpointed before they are parsed, so a
// checkpoint is the segmenter's own output rather than our reading of it. Three things follow:
// it costs nothing (no encoding, the bytes are already in hand), a parsing bug cannot destroy the
// result, and a multi-layer .seg.nrrd keeps the layers the scene has to drop — the checkpoint is
// strictly richer than what is on screen.
//
// This is not saving. A checkpoint is a scratch file beside the database, indexed nowhere and
// referenced by nothing; Save is still what puts a result into the archive as DICOM. The two are
// deliberately different, because a checkpoint has to be safe enough to write without being asked.

export interface CheckpointMeta {
  /** What produced it, e.g. "ts:total". */
  task: string;
  /** The volume it was computed on, as the user knows it. */
  volume: string;
  /** ISO 8601, when it arrived. */
  at: string;
  /** How long the run took, in ms — worth showing, because it is what a re-run would cost. */
  ms?: number;
  /** The scene node it was computed from, so a restore can attach it to the same volume. */
  sourceId?: string;
  /** Set once the result has been saved into the archive: a kept checkpoint that is no longer news. */
  saved?: boolean;
}

export interface Checkpoint extends CheckpointMeta {
  file: string;
  bytes: number;
  /** Where to GET the payload. */
  url: string;
}

/** The database the app is currently pointed at, or null when there is no native side. */
async function currentDb(): Promise<string | null> {
  try {
    const dbs = await fetch("/_db", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    const list = (dbs?.databases ?? []) as { id: string; current?: boolean; exists?: boolean }[];
    return (list.find((d) => d.current && d.exists) ?? list.find((d) => d.exists))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Put a result on disk. Returns where it went, or null if there is nowhere to put it.
 *
 * NEVER THROWS. A checkpoint that fails must not take the run down with it — the result is still in
 * the scene and still saveable, and an exception here would turn "we could not make a backup" into
 * "you lost the thing we were backing up". Callers check the return value if they care.
 */
export async function saveCheckpoint(bytes: Uint8Array, meta: CheckpointMeta): Promise<string | null> {
  try {
    const id = await currentDb();
    if (!id) return null;
    const stamp = meta.at.replace(/[:.]/g, "-");
    const name = `${stamp}-${meta.task}`.replace(/[^A-Za-z0-9._-]/g, "_") + ".seg.nrrd";
    const r = await fetch(`/_db/${encodeURIComponent(id)}/_checkpoint/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "x-checkpoint-meta": JSON.stringify(meta) },
      body: bytes as unknown as BodyInit,
    });
    if (!r.ok) return null;
    return String((await r.json()).path ?? "") || null;
  } catch {
    return null;
  }
}

/** What is on disk, newest first. Empty when there is no native side or nothing has been written. */
export async function listCheckpoints(): Promise<Checkpoint[]> {
  try {
    const id = await currentDb();
    if (!id) return [];
    const r = await fetch(`/_db/${encodeURIComponent(id)}/_checkpoints`, { cache: "no-store" });
    if (!r.ok) return [];
    return ((await r.json()).checkpoints ?? []) as Checkpoint[];
  } catch {
    return [];
  }
}

/** The payload of one checkpoint, ready to go back through the same reader that would have read it. */
export async function readCheckpoint(cp: Checkpoint): Promise<Uint8Array> {
  const r = await fetch(cp.url, { cache: "no-store" });
  if (!r.ok) throw new Error(`checkpoint ${cp.file}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Throw one away. Used when a result has been saved properly, or when the user says so. */
export async function discardCheckpoint(cp: Checkpoint): Promise<boolean> {
  try {
    const id = await currentDb();
    if (!id) return false;
    const r = await fetch(`/_db/${encodeURIComponent(id)}/_checkpoint/${encodeURIComponent(cp.file)}`, {
      method: "DELETE",
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The listed checkpoint that `saveCheckpoint` wrote. It answers with the file's PATH on disk; the list
 * names each by its bare FILE NAME. Compared as they were, the two never matched: a job that finished
 * after a reload saved its result, looked for it to land it, found nothing, and landed nothing, with
 * no word said -- Ron's `ts.v2:total`, 2026-09-23 17:19, which he had to Restore by hand.
 */
export function findSavedCheckpoint<T extends { file: string }>(list: T[], saved: string): T | undefined {
  const name = saved.slice(saved.lastIndexOf("/") + 1);
  return list.find((c) => c.file === name);
}

/** "2.1 GB" / "184 MB" / "12 KB" — sizes a person reads rather than counts digits in. */
export function humanBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1048576)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** "just now" / "14 minutes ago" / "2 days ago" — how stale a recoverable result is. */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
