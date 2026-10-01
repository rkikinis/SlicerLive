// GENERATE SURFACE MODELS -- the one place a segmentation gets triangle surfaces.
//
// Ron, 2026-09-24: "I think that I am ready to ask you to remove the surface models as a 'first class'
// citizen. We need a new module called generate surface models where someone could explicitly decide to
// generate them, at which time the proper controls would appear in the scene. But I would firewall it. We
// have had now several instances where you told me that its volume rendering only to find out on further
// investigation that it is not."
//
// Anatomy is drawn from the labels (Scene › In 3D › Colored, the solid look); surface models are for what
// needs triangles -- a 3D print, Slicer, the DICOM surfaces series, a headset, a robot. Here, per
// segmentation: Generate (stored ones from the database if there are any, else built) or Remove. The
// choice is `surfaceModels` on the segmentation node (so a saved scene keeps it), and the firewall in
// render/livescene.ts (SegmentationDisplayableManager.surfacesOn) refuses every other path. Once a
// volume's segmentation has them, Scene's In 3D offers "Surfaces"; Save to DICOM writes them with the SEG.

import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";

interface SurfaceState { on: boolean; building: boolean; structures: number; triangles: number; mb: number; failed?: string; held: boolean }
type G = {
  __generateSurfaces?: (id: string) => boolean;
  __removeSurfaces?: (id: string) => void;
  __surfaceState?: (id: string) => SurfaceState | null;
};
const g = () => globalThis as unknown as G;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** One row: a segmentation, or A SEQUENCE OF THEM as one (the beating heart: one per phase). Members of a
 *  sequence are hidden nodes, so a list of visible segmentations showed none of them and the heart could not
 *  be given surface models at all (critic, 2026-09-24, finding 7). "Never design for single anything." */
interface Unit { key: string; name: string; ids: string[]; phases: number }

export function registerSurfaceModelsPanel(shell: AppShell, opts: { live: LiveScene; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  const units = (): Unit[] => {
    const out: Unit[] = [];
    const seen = new Set<string>();
    for (const n of live.nodes.values()) {
      if (n.type !== "segmentation") continue;
      const seq = n.sequence as string | undefined;
      if (seq) {
        if (seen.has(seq)) continue;
        seen.add(seq);
        const sq = live.nodes.get(seq);
        const ids = ((sq?.items as { node: string }[] | undefined) ?? []).map((it) => it.node).filter((id) => live.nodes.get(id)?.type === "segmentation");
        out.push({ key: seq, name: String(sq?.name ?? n.name ?? seq), ids, phases: ids.length });
      } else if (!(n as { hidden?: boolean }).hidden) out.push({ key: n.id as string, name: String(n.name ?? n.id), ids: [n.id as string], phases: 0 });
    }
    return out;
  };

  /** Give every member surface models. The display manager builds ONE AT A TIME, across every segmentation
   *  (livescene.ts, the lane), so asking for all of them queues them; the row counts the phases done. The
   *  loop that stood here ran beside the manager's own builds and did not make them sequential (critic,
   *  2026-09-24, round 2, findings 1 and 2). */
  const generate = (u: Unit) => { for (const id of u.ids) g().__generateSurfaces?.(id); };
  const remove = (u: Unit) => { for (const id of u.ids) g().__removeSurfaces?.(id); };

  const shown = () => !!root && root.offsetParent !== null;
  const render = () => {
    if (!root) return;
    const list = units();
    let waiting = false;
    const rows = list.map((u) => {
      const sts = u.ids.map((id) => g().__surfaceState?.(id) ?? null);
      const on = sts.some((st) => st?.on);
      const without = sts.filter((st) => !st?.on).length;   // phases not given them (one joined later)
      const building = sts.some((st) => st?.building);
      const failed = sts.find((st) => st?.failed)?.failed;
      const held = sts.filter((st) => st?.held).length;
      const structures = sts.reduce((n, st) => n + (st?.structures ?? 0), 0);
      const triangles = sts.reduce((n, st) => n + (st?.triangles ?? 0), 0);
      const mb = sts.reduce((n, st) => n + (st?.mb ?? 0), 0);
      const name = esc(u.name) + (u.phases ? ` <span class="sl-hint">(${u.phases} phases)</span>` : "");
      const gen = (label: string) => `<button class="sl-sm-gen" data-key="${esc(u.key)}" title="Make triangle surface models of every structure${u.phases ? ", on every phase" : ""}: loaded from the DICOM database if they were saved before, else built — about 15 to 20 s on the processor for a whole-body case, about 2 s with Settings › Surfaces › Build surfaces on the graphics card. They are then offered in Scene › In 3D › Surfaces, and Save to DICOM writes them with the segmentation.">${label}</button>`;
      const rm = `<button class="sl-sm-rm" data-key="${esc(u.key)}" title="Drop these surface models: no longer drawn or held; the segmentation is drawn solid again">Remove</button>`;
      let state: string, buttons: string;
      if (!on) {
        state = `<span class="sl-hint">none — drawn solid (Scene › In 3D › Solid)</span>`;
        buttons = gen("Generate");
      } else if (without && !building) {
        state = `<span class="sl-hint">${without} of ${u.ids.length} phases have none</span>`;
        buttons = gen("Generate the rest") + rm;
      } else if (building) {
        waiting = true;
        state = `<span class="sl-hint">building…${u.phases ? ` ${held} of ${u.phases} phases done` : ""}</span>`;
        buttons = rm;
      } else if (failed) {
        state = `<span class="sl-hint">could not be made — ${esc(failed)}</span>`;
        buttons = gen("Try again") + rm;
      } else if (held < u.ids.length) {
        // Flagged, nothing on its way: the segmentation is still loading (a scene brings it back with the flag).
        waiting = true;
        state = `<span class="sl-hint">waiting for the segmentation to load${u.phases ? ` (${held} of ${u.phases} phases done)` : ""}</span>`;
        buttons = rm;
      } else if (!structures) {
        state = `<span class="sl-hint">nothing to make surfaces of: the segmentation has no labeled structures</span>`;
        buttons = rm;
      } else {
        // A segmentation whose volume is not in the scene has no look to choose from: its surface models are
        // drawn as soon as they exist (look3d.ts segLookOf), and Remove is the way back to solid.
        const src = ((live.nodes.get(u.ids[0])?.refs as Record<string, string[]> | undefined)?.source ?? [])[0];
        const lone = !u.phases && (!src || live.nodes.get(src)?.type !== "image");
        state = `${u.phases ? `${u.phases} phases · ` : ""}${structures} structures · ${triangles.toLocaleString()} triangles · ${mb} MB` +
          (lone ? ` <span class="sl-hint">— drawn now (no volume in the scene to choose a look under); Remove to go back to solid</span>` : "");
        buttons = rm;
      }
      return `<div class="sl-row sl-sm-row"><label title="${esc(u.name)}">${name}</label><span class="sl-sm-state">${state}</span>${buttons}</div>`;
    }).join("");
    root.innerHTML = `
      <h2>Generate Surface Models</h2>
      <p class="sl-hint">Albula draws segmentations without surface models: Scene › In 3D › Solid shows each
        structure solid, straight from its labels. Make surface models here only when you need triangles — a
        3D print, Slicer, the DICOM surfaces series, a headset or a robot.</p>
      ${list.length ? rows : `<p class="sl-hint">No segmentation in the scene.</p>`}
      ${list.some((u) => u.ids.some((id) => g().__surfaceState?.(id)?.on)) ? `<p class="sl-hint">To see them: Scene › In 3D › Surfaces, under the volume.</p>` : ""}`;
    const unitOf = (b: HTMLButtonElement) => list.find((u) => u.key === b.dataset.key);
    root.querySelectorAll<HTMLButtonElement>(".sl-sm-gen").forEach((b) => b.addEventListener("click", () => {
      const u = unitOf(b); if (!u) return;
      opts.onStatus?.(`surface models of ${u.name}: loading or building${u.ids.length > 1 ? `, one phase after the other` : ""}`);
      generate(u);
      render();
    }));
    root.querySelectorAll<HTMLButtonElement>(".sl-sm-rm").forEach((b) => b.addEventListener("click", () => {
      const u = unitOf(b); if (!u) return;
      remove(u);
      opts.onStatus?.(`surface models of ${u.name} removed`);
      render();
    }));
    // While one is on its way, look again every second -- only while the module is on screen.
    if (waiting && shown() && !poll) poll = setInterval(() => { if (!shown()) { clearInterval(poll); poll = undefined; return; } render(); }, 1000);
    if ((!waiting || !shown()) && poll) { clearInterval(poll); poll = undefined; }
  };

  shell.registerPanel({
    id: "surface-models",
    title: "Generate Surface Models",
    tip: "Make triangle surface models of a segmentation — only when you need them (printing, Slicer, headsets, robots)",
    groups: ["Segmentation"],
    order: 4,
    help: `<p>Segmentations are drawn in 3D from their labels (Scene › In 3D › Solid); no surface models are
      made, loaded or kept unless you ask for them here. Generate loads a segmentation's stored surface
      models from the DICOM database when there are any, and builds them otherwise. Once made, Scene › In 3D
      offers Surfaces for the volume, and Save to DICOM writes them beside the segmentation. Remove drops them.</p>`,
    mount(el) { root = el; render(); },
    onShow() { render(); },
  });
  live.subscribe((c) => { if (c.type === "segmentation" || c.kind === "remove" || c.kind === "reset") render(); });
}
