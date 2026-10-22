// ONE RUN OF A SEGMENTATION-SERVER TASK, start to result: ask for the task, send the volume, wait for the job, fetch the
// answer -- with the waiting rules that took several rounds to get right (logic/brain-mask.ts, where they were written
// first, 2026-10-04 to 10-15): a server that stops answering ends the wait in seconds; a job that makes no progress for
// two minutes, or stays queued for three, is a stuck server (the caller restarts it or offers to) -- BUT ONLY WHEN THE
// SERVER RUNS NOTHING ELSE. A job queued behind someone's long segmentation is waiting, not stuck: a restart then would
// stop that person's work (critic 2026-10-20, finding 1; CONSTRAINTS: a background job never blocks or steals). Used by
// SynthStrip's brain mask and by the import-time job that finds the brain's structures with FastSurfer (Ron, 2026-10-20).
//
// The messages are phrases for a person, built around `what` ("finding the brain on the MRI"); the server's own error
// text goes to the console, never to the screen.
import { type HaversackJob, isFinished, job, result, submitVolume, type HaversackTransport, type WeightEntry } from "./haversack.ts";

export type TaskRunResult =
  | { ok: true; bytes: Uint8Array; cached: boolean; seconds: number; job: HaversackJob; /** The task's weights as the
      server describes it (`weights_installed`: an engine's release, a model's version), for the result's provenance. */
      weights?: WeightEntry[] }
  | { ok: false; reason: "no-server" | "no-task" | "stuck" | "failed"; message: string; /** The server ran the job and it
      ended failed: a fault of this input, as far as anyone here can tell (not a lost answer or a refused upload). */ ranAndFailed?: true };

const POLL_MS = 800, STALL_MS = 2 * 60 * 1000, GONE_MS = 10 * 1000, QUEUED_STUCK_MS = 3 * 60 * 1000;

/** True only when the server's job list reads and shows no job running but `ownId` (haversack: GET jobs → { jobs: [{ id,
 *  state }] }). An unreadable list is not "nothing running": a restart is never made on a guess. */
async function nothingElseRunning(transport: HaversackTransport, ownId: string): Promise<boolean> {
  const r = await transport.fetch(`${transport.base ?? "/_haversack/"}jobs`, { cache: "no-store" }).catch(() => null);
  if (!r?.ok) return false;
  const j = await r.json().catch(() => null) as { jobs?: { id?: string; state?: string }[] } | null;
  return Array.isArray(j?.jobs) && !j!.jobs!.some((x) => x.state === "running" && x.id !== ownId);
}

export async function runHaversackTask(opts: {
  task: string;
  /** What the run does, in a person's words, for the messages: "finding the brain on the MRI". */
  what: string;
  upload: () => Promise<{ bytes: Uint8Array; filename: string }>;
  transport?: HaversackTransport;
  options?: Record<string, unknown>;
  onProgress?: (line: string) => void;
  pollMs?: number; goneMs?: number; queuedStuckMs?: number; stallMs?: number;
}): Promise<TaskRunResult> {
  const { task, what, onProgress } = opts;
  const pollMs = opts.pollMs ?? POLL_MS, goneMs = opts.goneMs ?? GONE_MS;
  const transport: HaversackTransport = opts.transport ?? { fetch: (...a) => fetch(...a) };
  const t0 = performance.now();
  // Is the task there? Asked before the upload, as the AI panel does. No answer at all: the server is not running.
  const res = await transport.fetch(`${transport.base ?? "/_haversack/"}tasks/${encodeURIComponent(task)}`, { cache: "no-store" }).catch(() => null);
  if (!res || res.status === 0 || res.status >= 500) return { ok: false, reason: "no-server", message: "the segmentation server is not running" };
  if (!res.ok) return { ok: false, reason: "no-task", message: `the segmentation server on this Mac cannot do this (${what})` };
  const detail = await res.json().catch(() => null) as { weights_installed?: unknown } | null;
  const weights = Array.isArray(detail?.weights_installed) ? (detail!.weights_installed as WeightEntry[]).filter((w) => w && typeof w.id === "string") : undefined;
  onProgress?.("sending the scan to the segmentation server");
  const up = await opts.upload();
  const sub = await submitVolume(transport, { task, bytes: up.bytes, filename: up.filename, ...(opts.options ? { options: opts.options } : {}) });
  if (!sub.ok) { console.warn(`${task} submit:`, sub.message); return { ok: false, reason: "failed", message: "the segmentation server refused the scan" }; }
  let last = "", lastMoved = "", lastChange = Date.now(), goneSince = 0;
  // WHEN ANOTHER JOB WAS LAST SEEN RUNNING: the three minutes count from then, so the moment between the job ahead
  // finishing and ours starting is not taken for a stuck server.
  let lastBusy = 0;
  let done: HaversackJob | undefined;
  for (;;) {
    const j = await job(transport, sub.jobId);
    if (j.state === "unknown") {
      goneSince ||= Date.now();
      if (Date.now() - goneSince > goneMs) { console.warn(`${task} job`, sub.jobId, j.error); return { ok: false, reason: "no-server", message: "the segmentation server stopped answering" }; }
    } else goneSince = 0;
    const line = j.state === "queued" ? (lastBusy ? "waiting behind another job on the segmentation server" : "waiting for the segmentation server: it is busy with another job")
      : j.state === "running" ? `running${j.progress !== undefined ? ` ${Math.round(j.progress * 100)}%` : ""}` : j.state === "unknown" ? "waiting for the segmentation server to answer" : j.state;
    if (line !== last) { onProgress?.(line); last = line; }
    const moved = `${j.state}:${j.progress ?? ""}:${j.stage ?? ""}`;
    if (moved !== lastMoved) { lastMoved = moved; lastChange = Date.now(); }
    if (isFinished(j.state)) {
      if (j.state !== "succeeded") { console.warn(`${task} job`, sub.jobId, j.state, j.error); return { ok: false, reason: "failed", message: `${what} failed on the segmentation server`, ...(j.state === "failed" ? { ranAndFailed: true as const } : {}) }; }
      done = j;
      break;
    }
    // A running job that has not moved for two minutes is stalled, and a stalled server is a stuck one (Ron, 2026-10-15:
    // "If the biggest danger is that you have to repeat an import, then being aggressive is not a problem").
    if (j.state === "running" && Date.now() - Math.max(lastChange, lastBusy) > (opts.stallMs ?? STALL_MS)) {
      if (await nothingElseRunning(transport, sub.jobId)) return { ok: false, reason: "stuck", message: `${what} made no progress for two minutes: the segmentation server seems stuck` };
      lastBusy = Date.now();
    }
    // STUCK = our job queued for three minutes WHILE THE SERVER RUNS NOTHING ELSE (critic 2026-10-06, finding 12; Ron,
    // 2026-10-15: "restart but notify"). Queued behind a job that runs, it waits, and says so (critic 2026-10-20, finding 1).
    if (j.state === "queued" && Date.now() - Math.max(lastChange, lastBusy) > (opts.queuedStuckMs ?? QUEUED_STUCK_MS)) {
      if (await nothingElseRunning(transport, sub.jobId)) return { ok: false, reason: "stuck", message: "the segmentation server has not started the job in three minutes although it runs nothing else: it seems stuck" };
      lastBusy = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const bytes = await result(transport, sub.jobId);
  if (!bytes) return { ok: false, reason: "failed", message: "the segmentation server's answer could not be fetched" };
  return { ok: true, bytes, cached: done.cached === true, seconds: (performance.now() - t0) / 1000, job: done, ...(weights ? { weights } : {}) };
}
