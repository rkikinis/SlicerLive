// THE BRAIN ON AN MRI OF THE ANATOMY, from SynthStrip (Hoopes et al., NeuroImage 2022) run by the haversack server
// (Michael Halle's; its `synthstrip:mask` task). Added 2026-10-04 for the diffusion extension's tracking rule 3, which
// tracks inside this mask instead of one made from the diffusion scan's own b = 0 images: that one leaves out the lower
// temporal lobes and part of the cerebellum, where the skull base darkens it (Ron: "yes, SynthStrip through haversack").
//
// The volume goes to the server as NRRD, as the AI segmentation panel sends it, so the mask comes back on the volume's
// own grid (checked by the critic, 2026-10-04: Dice 1.0 against the command line's mask, the same affine).
//
// THE MASKS KEPT (critic, 2026-10-04, finding 5): keyed on the node's geometry and voxels, not its id alone -- Harden
// changes a node's geometry in place under the same id -- and at most two, so this is never the last owner of a mask for
// a volume that left the scene. A repeat after that asks the server, which answers from its own cache in about 0.1 s.
//
// WAITING (finding 3): a server that stops answering ends the wait in seconds; a job queued behind another is said as
// such; a job that makes no progress for two minutes is given up. The messages are for a person: the server's own
// error text goes to the console, not to the screen (finding 15).
import type { LiveScene } from "../render/livescene.ts";
import { exportVolume } from "./export.ts";
import { isFinished, job, result, serverStatus, submitVolume, type HaversackTransport } from "./haversack.ts";
import { parseNrrdSeg } from "../render/nrrd.ts";

export interface BrainMask { dims: [number, number, number]; ijkToRAS: number[]; data: Uint8Array }
/** Why there is no mask: the server is not running (a start button helps), or it runs without SynthStrip, or the job
 *  failed or stalled. `message` is a phrase that completes "…because ___". */
export type BrainMaskResult = { ok: true; mask: BrainMask; cached: boolean; seconds: number } | { ok: false; reason: "no-server" | "no-synthstrip" | "failed"; message: string };

const TASK = "synthstrip:mask", POLL_MS = 800, STALL_MS = 2 * 60 * 1000, GONE_MS = 10 * 1000, KEEP = 2;
const kept: { key: string; nodeId: string; mask: BrainMask }[] = [];

/** What identifies a volume's voxels and place: its geometry and its stored voxels (the zarr reference). */
function keyOf(live: LiveScene, nodeId: string): string | undefined {
  const n = live.nodes?.get?.(nodeId) as Record<string, unknown> | undefined;
  return n ? JSON.stringify([nodeId, n.dims, n.ijkToRAS, n.zarr]) : undefined;
}

/** SynthStrip's brain mask of volume node `nodeId` (1 inside), or why there is none. `onProgress` gets short phrases
 *  ("running 40%", "waiting for the segmentation server: it is busy with another job"). */
export async function synthstripBrainMask(live: LiveScene, nodeId: string, onProgress?: (line: string) => void,
  /** The server and the upload, replaceable for tests (brain-mask.test.ts). */
  deps: { transport?: HaversackTransport; upload?: () => Promise<{ bytes: Uint8Array; filename: string }>; pollMs?: number; goneMs?: number } = {}): Promise<BrainMaskResult> {
  const pollMs = deps.pollMs ?? POLL_MS, goneMs = deps.goneMs ?? GONE_MS;
  const transport: HaversackTransport = deps.transport ?? { fetch: (...a) => fetch(...a) };
  const key = keyOf(live, nodeId) ?? nodeId;
  for (let i = kept.length - 1; i >= 0; i--) if (kept[i].nodeId === nodeId && kept[i].key !== key) kept.splice(i, 1);   // moved or replaced
  const have = kept.find((k) => k.key === key);
  if (have) return { ok: true, mask: have.mask, cached: true, seconds: 0 };
  const t0 = performance.now();
  // Is the task there? Asked before the upload, as the AI panel does. No answer at all: the server is not running.
  const res = await transport.fetch(`${transport.base ?? "/_haversack/"}tasks/${encodeURIComponent(TASK)}`, { cache: "no-store" }).catch(() => null);
  if (!res || res.status === 0 || res.status >= 500) return { ok: false, reason: "no-server", message: "the segmentation server is not running" };
  if (!res.ok) return { ok: false, reason: "no-synthstrip", message: "the segmentation server on this Mac cannot find the brain on an MRI (it runs without SynthStrip)" };
  onProgress?.("sending the MRI to the segmentation server");
  const nrrd = deps.upload ? await deps.upload() : await exportVolume(live, nodeId, "nrrd-gz");
  const sub = await submitVolume(transport, { task: TASK, bytes: nrrd.bytes, filename: nrrd.filename });
  if (!sub.ok) { console.warn("SynthStrip submit:", sub.message); return { ok: false, reason: "failed", message: "the segmentation server refused the MRI" }; }
  let last = "", lastMoved = "", lastChange = Date.now(), goneSince = 0, cached = false;
  for (;;) {
    const j = await job(transport, sub.jobId);
    if (j.state === "unknown") {
      goneSince ||= Date.now();
      if (Date.now() - goneSince > goneMs) { console.warn("SynthStrip job", sub.jobId, j.error); return { ok: false, reason: "no-server", message: "the segmentation server stopped answering" }; }
    } else goneSince = 0;
    const line = j.state === "queued" ? "waiting for the segmentation server: it is busy with another job"
      : j.state === "running" ? `running${j.progress !== undefined ? ` ${Math.round(j.progress * 100)}%` : ""}` : j.state === "unknown" ? "waiting for the segmentation server to answer" : j.state;
    if (line !== last) { onProgress?.(line); last = line; }
    const moved = `${j.state}:${j.progress ?? ""}:${j.stage ?? ""}`;
    if (moved !== lastMoved) { lastMoved = moved; lastChange = Date.now(); }
    if (isFinished(j.state)) {
      if (j.state !== "succeeded") { console.warn("SynthStrip job", sub.jobId, j.state, j.error); return { ok: false, reason: "failed", message: "finding the brain on the MRI failed on the segmentation server" }; }
      cached = j.cached === true;
      break;
    }
    // A queued job is not stalled (another job runs first); a running one that has not moved for two minutes is.
    if (j.state === "running" && Date.now() - lastChange > STALL_MS) return { ok: false, reason: "failed", message: "finding the brain on the MRI made no progress for two minutes" };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const bytes = await result(transport, sub.jobId);
  if (!bytes) return { ok: false, reason: "failed", message: "the segmentation server's answer could not be fetched" };
  const seg = await parseNrrdSeg(bytes), layer = seg.layers[0];
  if (!layer) return { ok: false, reason: "failed", message: "the segmentation server's answer held no brain" };
  const data = new Uint8Array(layer.length);
  for (let v = 0; v < layer.length; v++) data[v] = layer[v] > 0 ? 1 : 0;
  const mask: BrainMask = { dims: seg.dims, ijkToRAS: seg.ijkToRAS, data };
  kept.push({ key, nodeId, mask });
  while (kept.length > KEEP) kept.shift();
  return { ok: true, mask, cached, seconds: (performance.now() - t0) / 1000 };
}

/** Start the segmentation server, as the AI segmentation panel's button does, and wait until it answers (the first start
 *  builds its Python environment: a minute or two). `onProgress` gets the seconds waited. */
export async function startSegmentationServer(onProgress?: (line: string) => void, transport: HaversackTransport = { fetch: (...a) => fetch(...a) }): Promise<{ ok: boolean; message: string }> {
  const t0 = Date.now();
  const r = await transport.fetch("/_haversack/_start", { method: "POST" }).then((x) => x.json()).catch((e) => ({ started: false, error: String(e) })) as { started?: boolean; note?: string; error?: string; log?: string };
  if (!r.started && r.note !== "already running" && r.note !== "already starting") return { ok: false, message: r.error ?? "it did not start" };
  for (;;) {
    const st = await serverStatus(transport);
    if (st.reachable) return { ok: true, message: `the segmentation server answered after ${Math.round((Date.now() - t0) / 1000)} s` };
    const secs = Math.round((Date.now() - t0) / 1000);
    if (secs > 300) return { ok: false, message: `the segmentation server did not answer within ${secs} s${r.log ? ` (its log: ${r.log})` : ""}` };
    onProgress?.(`starting the segmentation server… ${secs} s`);
    await new Promise((res) => setTimeout(res, 1500));
  }
}
