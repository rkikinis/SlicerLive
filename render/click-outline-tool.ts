// CLICK TO OUTLINE, the Segment Editor's nnLive tool (Ron, 2026-10-03; mockup Contents/docs/mockups/
// click-to-outline-2026-10-03.html in the SlicerAlbula workspace). A click inside a structure outlines it in 3D; further
// clicks refine the same outline (a shift-click takes away); each outline goes into the structure the person chose
// (logic/click-outline.ts has the rule). The model is Steve Pieper's nnLive (render/faithful-segmenter.ts drives his
// vendored runtime, live/webgpu/nnlive/), run on this Mac's graphics card; its files come from the app's own server
// (desktop/model-store.ts), fetched once.
//
// The order of a first use, each step once a session at most: the license (logic/model-license.ts NNLIVE_LICENSE, the
// TotalSegmentator template: asked at the click that makes a result), the model files (fetched once ever, with
// progress), the model on the graphics card (compiled once a session), the scan (once per scan).
import type { LiveScene } from "./livescene.ts";
import type { Vec3 } from "./mat4.ts";
import { FaithfulSegmenter } from "./faithful-segmenter.ts";
import { workerUrl } from "./build-id.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "./zarr.ts";
import { volumeToZarr, type LocalBlobStore } from "../logic/ingest.ts";
import { invalidatePaintCache, markEdited } from "../logic/segmentation-editor.ts";
import { mergeOutline, rasToVoxel } from "../logic/click-outline.ts";
import { NNLIVE_LICENSE } from "../logic/model-license.ts";

type Obj = Record<string, unknown>;
export interface ClickOutlineDeps {
  live: LiveScene;
  store: LocalBlobStore;
  status: (s: string) => void;
  confirm: (o: { title: string; body: string; ok?: string; cancel?: string }) => Promise<boolean>;
  /** The +/− marks where the person clicked, for the views to draw (empty: none). */
  marks?: (points: { ras: Vec3; sign: 1 | -1 }[]) => void;
}

export function createClickOutline(deps: ClickOutlineDeps) {
  const { live } = deps;
  let accepted = false;
  let seg: FaithfulSegmenter | null = null;
  let ready: Promise<FaithfulSegmenter> | null = null;
  let volumeOf = "";                   // the scan the model holds now
  let session: { segId: string; target: number; prev: Uint8Array | null; clicks: { ras: Vec3; sign: 1 | -1 }[]; made: boolean } | null = null;
  let busy = false;
  let last: { seconds: number; modelSeconds: number; writeSeconds: number; decodeMs: number; zoom: number; mL: number } | null = null;

  /** The license, asked once a session (as for TotalSegmentator's networks). */
  async function license(): Promise<boolean> {
    if (accepted) return true;
    const L = NNLIVE_LICENSE;
    accepted = await deps.confirm({
      title: `${L.project} — academic, non-commercial use`,
      ok: "I agree — outline", cancel: "Cancel",
      body: `<p>This tool uses <b>nnLive</b>, a model made from <b>nnInteractive</b>, and it is free for academic use only.</p>` +
        `<dl>${L.terms.map((t) => `<dt>${t.title}</dt><dd>${t.text}</dd>`).join("")}</dl>` +
        `<p>The license: <a href="${L.url}">${L.url}</a> · the model: <a href="https://github.com/pieper/nnLive">github.com/pieper/nnLive</a> · <a href="https://github.com/MIC-DKFZ/nnInteractive">github.com/MIC-DKFZ/nnInteractive</a></p>`,
    });
    if (!accepted) deps.status("Click to outline: not started — the license was not accepted");
    return accepted;
  }

  /** The model files, fetched once ever by the app's server; progress in the status line. */
  async function files(): Promise<void> {
    const resp = await fetch("/_models/nnlive/_ensure", { cache: "no-store" });
    if (!resp.ok || !resp.body) throw new Error(`the model could not be fetched (${resp.status})`);
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", result: Obj | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = JSON.parse(buf.slice(0, nl)) as Obj; buf = buf.slice(nl + 1);
        if (line.ok || line.error) result = line;
        else if (typeof line.loaded === "number") deps.status(`Getting the outlining model, once — ${Math.round(Number(line.loaded) / 1e6)} of ${Math.round(Number(line.total) / 1e6)} MB`);
      }
    }
    if (!result || result.error) throw new Error(String(result?.error ?? "the model could not be fetched"));
  }

  /** The model on the graphics card, once a session. */
  function model(): Promise<FaithfulSegmenter> {
    ready ??= (async () => {
      await files();
      let said = false;
      const s = new FaithfulSegmenter({
        workerUrl: workerUrl("nnlive/pathA-faithful-worker.js").href,
        encUrl: workerUrl("nnlive/faithful-enc.js").href,
        base: "/_models/nnlive/",
        weights: "/_models/nnlive/perclick_192.parts.json",
        // ONCE: the worker reports every 64 KB it reads (about 2,900 messages for the weights), and each status line is
        // also written to the session log -- a flood of requests the first time this ran (2026-10-03).
        onStatus: (m) => { if (!said && /autotun|compil|loading|downloading/.test(m)) { said = true; deps.status("Click to outline: preparing the model on the graphics card (once a session)…"); } },
      });
      const t0 = performance.now();
      await s.init();
      deps.status(`Click to outline: ready in ${((performance.now() - t0) / 1000).toFixed(1)} s — click inside the structure`);
      seg = s;
      return s;
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  const sourceOf = (segId: string) => live.nodes.get((((live.nodes.get(segId)?.refs as Record<string, string[]> | undefined)?.source) ?? [])[0] ?? "");

  /** Start (or move) the tool to a segmentation's structure: license, model, scan. False when it cannot start. */
  /** `made`: the segmentation was made by this start (on a bare scan); it goes again if the tool ends with no click. */
  async function start(segId: string, target: number, made = false): Promise<boolean> {
    if (!(await license())) { if (made) live.write({ op: "del", id: segId }); return false; }
    const node = live.nodes.get(segId), src = sourceOf(segId);
    if (!node?.zarr || !src?.zarr) { deps.status("Click to outline needs a segmentation drawn on a scan in this scene"); return false; }
    // THE SCAN'S OWN GRID: the outline is written voxel for voxel into the segmentation, so both must share it.
    if (JSON.stringify(node.dims) !== JSON.stringify(src.dims) || (node.ijkToRAS as number[]).some((v, i) => Math.abs(v - (src.ijkToRAS as number[])[i]) > 1e-4)) {
      deps.status("Click to outline: this segmentation is not on its scan's grid — it cannot be outlined into"); return false;
    }
    const s = await model();
    if (volumeOf !== src.id) {
      deps.status("Click to outline: reading the scan…");
      const v = await fetchZarrVolumeNative(live.blobBase(), src.zarr as ZarrDesc);
      s.setVolume(v.data instanceof Float32Array ? v.data : Float32Array.from(v.data as ArrayLike<number>), src.dims as [number, number, number]);
      volumeOf = src.id as string;
    }
    if (!session || session.segId !== segId || session.target !== target) { s.reset(); session = { segId, target, prev: null, clicks: [], made: made || (session?.segId === segId && session.made) }; deps.marks?.([]); }
    deps.status("Click to outline: click inside the structure; shift-click where it spilled over. Esc or a right-click ends.");
    return true;
  }

  /** A click at `ras`: +1 adds, −1 takes away. The outline replaces the last one this tool drew in the structure. */
  async function click(ras: Vec3, sign: 1 | -1): Promise<void> {
    if (!session || !seg) return;
    if (busy) { deps.status("Click to outline: still working on the last click"); return; }
    const node = live.nodes.get(session.segId);
    if (!node?.zarr) { stop(); return; }
    const dims = node.dims as [number, number, number];
    const v = rasToVoxel(node.ijkToRAS as number[], dims, ras);
    if (!v) { deps.status("Click to outline: that point is outside the scan"); return; }
    busy = true;
    const t0 = performance.now();
    try {
      session.clicks.push({ ras, sign });
      deps.marks?.(session.clicks);
      deps.status(`Click to outline: outlining (click ${session.clicks.length})…`);
      const mask = await seg.clickPredict(v[2], v[1], v[0], sign);   // nnLive takes (z, y, x) = (k, j, i)
      const tModel = performance.now();
      const lab = await fetchZarrVolumeNative(live.blobBase(), node.zarr as ZarrDesc, undefined, 12, false);
      const labelmap = lab.data instanceof Uint8Array ? lab.data : Uint8Array.from(lab.data as ArrayLike<number>);
      const r = mergeOutline(labelmap, session.prev, mask, session.target);
      session.prev = r.drawn;
      const { desc, blobs } = await volumeToZarr(r.out, dims, "|u1");
      deps.store.add(blobs);
      live.write({ op: "patch", id: session.segId, path: "#/zarr", value: desc });
      markEdited(live, session.segId);
      invalidatePaintCache(session.segId);
      const m = node.ijkToRAS as number[];
      const voxMl = Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])) / 1000;
      const name = ((node.segments as { labelValue: number; name?: string }[] | undefined) ?? []).find((x) => x.labelValue === session!.target)?.name ?? "the structure";
      const tEnd = performance.now();
      // WHERE THE TIME GOES, each click (Ron: say the measured number): the model (encode, decode, and a zoomed-out
      // re-run when the outline touched its 192-voxel box), and writing the result into the segmentation.
      last = { seconds: (tEnd - t0) / 1000, modelSeconds: (tModel - t0) / 1000, writeSeconds: (tEnd - tModel) / 1000, decodeMs: seg.lastMs, zoom: seg.lastZoom, mL: r.voxels * voxMl };
      deps.status(`Outlined in ${last.seconds.toFixed(1)} s (click ${session.clicks.length}) — ${name} ${last.mL.toFixed(1)} mL; Undo takes the last click back`);
    } catch (e) {
      deps.status(`Click to outline failed: ${(e as Error).message ?? e}`);
    } finally { busy = false; }
  }

  /** End: the marks go; the outline stays as an ordinary edit. The model stays on the card for the next start. */
  function stop() {
    // A segmentation this tool made on a bare scan and never wrote into is not left behind, empty (it would then block
    // a scene save as "never saved").
    if (session?.made && !session.clicks.length && live.nodes.has(session.segId)) live.write({ op: "del", id: session.segId });
    session = null; deps.marks?.([]);
  }

  return { license, start, click, stop, get last() { return last; }, get active() { return !!session; }, get target() { return session?.target; } };
}
