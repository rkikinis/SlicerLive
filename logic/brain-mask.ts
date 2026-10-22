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
// such; a job that makes no progress for two minutes is a stuck server (a restart is offered, or made by the import job). The messages are for a person: the server's own
// error text goes to the console, not to the screen (finding 15).
import type { LiveScene } from "../render/livescene.ts";
import { exportVolume } from "./export.ts";
import { serverStatus, type HaversackTransport } from "./haversack.ts";
import { runHaversackTask } from "./haversack-run.ts";
import { parseNrrdSeg } from "../render/nrrd.ts";

export interface BrainMask { dims: [number, number, number]; ijkToRAS: number[]; data: Uint8Array }
/** Why there is no mask: the server is not running (a start button helps), or it runs without SynthStrip, or the job
 *  failed or stalled. `message` is a phrase that completes "…because ___". */
export type BrainMaskResult = { ok: true; mask: BrainMask; cached: boolean; seconds: number } | { ok: false; reason: "no-server" | "no-synthstrip" | "stuck" | "failed"; message: string };

const TASK = "synthstrip:mask", KEEP = 2;
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
  deps: { transport?: HaversackTransport; upload?: () => Promise<{ bytes: Uint8Array; filename: string }>; pollMs?: number; goneMs?: number; queuedStuckMs?: number; stallMs?: number } = {}): Promise<BrainMaskResult> {
  const transport: HaversackTransport = deps.transport ?? { fetch: (...a) => fetch(...a) };
  const key = keyOf(live, nodeId) ?? nodeId;
  for (let i = kept.length - 1; i >= 0; i--) if (kept[i].nodeId === nodeId && kept[i].key !== key) kept.splice(i, 1);   // moved or replaced
  const have = kept.find((k) => k.key === key);
  if (have) return { ok: true, mask: have.mask, cached: true, seconds: 0 };
  // THE RUN, by the one runner of a server task (logic/haversack-run.ts, where these waiting rules now live).
  const run = await runHaversackTask({
    task: TASK, what: "finding the brain on the MRI", transport, onProgress,
    upload: deps.upload ?? (() => exportVolume(live, nodeId, "nrrd-gz")),
    pollMs: deps.pollMs, goneMs: deps.goneMs, queuedStuckMs: deps.queuedStuckMs, stallMs: deps.stallMs,
  });
  if (!run.ok) {
    if (run.reason === "no-task") return { ok: false, reason: "no-synthstrip", message: "the segmentation server on this Mac cannot find the brain on an MRI (it runs without SynthStrip)" };
    return { ok: false, reason: run.reason, message: run.message };
  }
  const { bytes, cached } = run, t0 = performance.now() - run.seconds * 1000;
  const seg = await parseNrrdSeg(bytes), layer = seg.layers[0];
  if (!layer) return { ok: false, reason: "failed", message: "the segmentation server's answer held no brain" };
  const data = new Uint8Array(layer.length);
  for (let v = 0; v < layer.length; v++) data[v] = layer[v] > 0 ? 1 : 0;
  const mask: BrainMask = { dims: seg.dims, ijkToRAS: seg.ijkToRAS, data };
  kept.push({ key, nodeId, mask });
  while (kept.length > KEEP) kept.shift();
  return { ok: true, mask, cached, seconds: (performance.now() - t0) / 1000 };
}

/** RESTART the segmentation server (a stuck one: reason "stuck"): the server stops the haversack process on the port --
 *  only one whose command line says "haversack serve" -- starts it again, and this waits for its first answer. */
export async function restartSegmentationServer(onProgress?: (line: string) => void, transport: HaversackTransport = { fetch: (...a) => fetch(...a) }): Promise<{ ok: boolean; message: string }> {
  const t0 = Date.now();
  onProgress?.("restarting the segmentation server…");
  const r = await transport.fetch("/_haversack/_restart", { method: "POST" }).then((x) => x.json()).catch((e) => ({ restarted: false, error: String(e) })) as { restarted?: boolean; started?: boolean; note?: string; error?: string; log?: string };
  if (!r.restarted) return { ok: false, message: r.error ?? "it could not be restarted" };
  for (;;) {
    const st = await serverStatus(transport);
    if (st.reachable) return { ok: true, message: `the segmentation server was restarted and answered after ${Math.round((Date.now() - t0) / 1000)} s` };
    const secs = Math.round((Date.now() - t0) / 1000);
    if (secs > 300) return { ok: false, message: `the segmentation server did not answer within ${secs} s after the restart${r.log ? ` (its log: ${r.log})` : ""}` };
    onProgress?.(`restarting the segmentation server… ${secs} s`);
    await new Promise((res) => setTimeout(res, 1500));
  }
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
