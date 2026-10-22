// "Save" panel (W7): export the loaded volumes and segmentations to NRRD / NIfTI (segmentations as .seg.nrrd, or as
// surface models: STL, OBJ -- one segmentation, or everything shown in 3D; closed for 3D printing by default), saved to
// the top of Downloads. Slicer reads these back with matching geometry
// + voxels (parity). Plain DOM.
import { sceneControl } from "./scene-control.ts";
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";

interface Hooks {
  __savableNodes: () => { id: string; name: string; type: string }[];
  __dicomAncestorOf?: (id: string) => { id: string; name: string; seriesInstanceUID?: string } | null;
  __exportNode: (id: string, format: string, opts?: { closed?: boolean }) => Promise<{ filename: string; size: number }>;
  /** The segmentations shown in 3D, in drawing order, with how many structures each shows (slicer-app.ts). */
  __segmentationsShownIn3D?: () => { id: string; structures: number }[];
}
/** The row that saves everything shown in 3D as one file (its id in `__exportNode`). */
export const EVERYTHING_3D = "__everything-shown-in-3d__";
/** "Closed, for 3D printing", per row, as last set (ticked by default; Ron, 2026-10-22). */
const closedChoice = new Map<string, boolean>();
const SURFACE_FORMATS = new Set(["stl", "obj"]);
const CLOSED_TIP = "A file a 3D printer accepts: each structure closed where the scan cuts it off, so it has no hole there. The segmentation itself is not changed.";
const g = () => globalThis as unknown as Hooks;

/**
 * THE SAVE PANES OF THE LOAD / SAVE MODULE (2026-09-22). Ron, on the I/O graph: "I love it …
 * reverse the two module decision." One module around the graph; this file renders what sits
 * under the two Save arrows -- `mode` "db": everything loaded, saved to the DICOM database, with
 * Save all; "files": a format per thing, downloaded. The standalone Save module is gone.
 */
export function renderSavePane(shell: AppShell, live: LiveScene, root: HTMLElement, mode: "db" | "files", onStatus?: (s: string) => void): void {
  const status = (s: string) => { onStatus?.(s); shell.setStatus(s); };
  const render = () => {
    const nodes = g().__savableNodes?.() ?? [];
    // A DERIVED VOLUME CAN GO INTO THE DATABASE, but only if it descends from a series that is
    // already there: that is where its patient, study, frame of reference and attribution come
    // from (logic/export-dicom-image.ts). Offered only when that is true, rather than offered
    // always and failing for the volumes it cannot serve.
    // ALREADY THERE: the volume IS a series of the database (loaded from it, or saved before) -- not merely made
    // from one. "Already in the database" was said of every crop, and Save all still wrote the originals again
    // (code review 2026-09-24, A4).
    // Read from the database (not DICOM files from disk) and not hardened since, or saved there by us; a
    // segmentation read from the database and not edited since (critic, review-bugfixes findings 4 and 5).
    const already = (id: string) => {
      const n = live.nodes.get(id);
      const o = n?.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string; inDatabase?: boolean; hardened?: boolean } | undefined;
      if (n?.type === "segmentation") return !!(o?.seriesInstanceUID || o?.savedSeriesInstanceUID) && n.edited !== true;
      return !!o?.savedSeriesInstanceUID || (!!o?.seriesInstanceUID && o.inDatabase === true && !o.hardened);
    };
    // ONE ROW PER THING: name, what will happen, the button. In the database pane a thing that
    // cannot go in yet says why on its row (critic 2026-09-22, 2.3), and Save all does the
    // volumes before the segmentations that need them. In the files pane a format per thing.
    const dbFor = (n: { id: string; type: string }) => n.type === "segmentation" ? "dicom-seg" : "dicom";
    // SURFACE MODELS FOR EVERY SEGMENTATION, made when Save is pressed (render/surface-export.ts; Ron, 2026-10-21,
    // option B: surface models are no longer drawn in Albula, only exported). STL and OBJ go to Downloads as the other
    // formats do. Not into the database (Ron, 2026-10-22: "For now only segmentations go into the db. stl are exports only").
    const fileFormats = (n: { id: string; type: string }) => n.type === "segmentation"
      ? [["nrrd", ".seg.nrrd"], ["nrrd-gz", ".seg.nrrd (gz)"], ["stl", "STL (surfaces)"], ["obj", "OBJ (surfaces, named and colored)"]]
      : [["nrrd", "NRRD"], ["nrrd-gz", "NRRD (gz)"], ["nifti", "NIfTI"]];
    const why = (n: { id: string; type: string; name: string }) => {
      if (already(n.id)) return n.type === "segmentation" ? "in the database, unchanged" : "already in the database";
      if (n.type !== "segmentation") return "";
      const anc = g().__dicomAncestorOf?.(n.id);
      return anc ? "" : "needs its volume in the database first";
    };
    // EVERYTHING SHOWN IN 3D, ONE FILE (Ron, 2026-10-22: "offer both"; "everything shown in 3d should have a tooltip.
    // It makes sense, but a firsttime user in a hurry might miss it"): on top of the files list, when anything is shown.
    const shown = mode === "files" ? g().__segmentationsShownIn3D?.() ?? [] : [];
    const closedRow = (id: string, show: boolean) => `<label class="sl-save-closed" title="${CLOSED_TIP}"${show ? "" : " hidden"}><input type="checkbox" class="sl-save-closed-box"${closedChoice.get(id) ?? true ? " checked" : ""}> Closed, for 3D printing</label>`;
    const all3d = shown.length ? `
        <div class="sl-save-item sl-save-all3d" data-id="${EVERYTHING_3D}">
          <span class="sl-save-name" title="One file of every structure you see in the 3D view, from all the segmentations shown: a model of the whole scene, or of everything for a 3D print">Everything shown in 3D <span class="sl-save-count">· ${shown.length} segmentation${shown.length === 1 ? "" : "s"}, ${shown.reduce((n, x) => n + x.structures, 0)} structures</span></span>
          <select class="sl-fmt" title="The file format. The file goes to your Downloads folder."><option value="stl">STL</option><option value="obj">OBJ (named, colored)</option></select><button class="sl-save-btn" title="Make the surfaces of everything shown in 3D and save them as one file">Save</button>
          ${closedRow(EVERYTHING_3D, true)}
        </div>` : "";
    root.innerHTML = nodes.length ? all3d + nodes.map((n) => `
        <div class="sl-save-item" data-id="${n.id}" data-type="${n.type}">
          <span class="sl-save-name" title="${n.type === "segmentation" ? "A segmentation" : "A volume"}">${escapeHtml(n.name)}</span>
          ${mode === "db"
            ? `<span class="sl-hint sl-save-why">${why(n)}</span>${n.type !== "segmentation" && already(n.id) ? "" : `<button class="sl-save-btn" data-fmt="${dbFor(n)}" title="Write it into the DICOM database, under its study, indexed there">Save</button>`}`
            : `<select class="sl-fmt" title="The file format. Files go to your Downloads folder. STL and OBJ hold the structures shown in Segmentations (all of them when none is shown) as surface models.">${fileFormats(n).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select><button class="sl-save-btn" title="Save it in the format chosen">Save</button>${n.type === "segmentation" ? closedRow(n.id, SURFACE_FORMATS.has(fileFormats(n)[0][0])) : ""}`}
        </div>`).join("") : `<p class="sl-hint">Nothing to save yet — load or create data.</p>`;
    if (mode === "db") {
      root.insertAdjacentHTML("beforeend", `<div class="sl-actions sl-save-foot">
        <span class="sl-scene-slot"></span>
        ${nodes.length ? `<button class="sl-primary sl-save-all" title="Save everything loaded into the DICOM database: the volumes first, then the segmentations that need them">Save all</button>` : ""}
      </div>`);
    }
    // THE SCENE CONTROL, the same as on the bar (render/demos/scene-control.ts). Never the colored button here: Save all
    // is this box's one yellow (PALETTE.md), and it saves the scene's series too.
    root.querySelector(".sl-scene-slot")?.replaceWith(sceneControl({ neverColored: true, up: true }));
    const saveOne = async (id: string, fmt: string, opts?: { closed?: boolean }) => {
      const r = await g().__exportNode(id, fmt, opts) as { filename: string; size: number; note?: string };
      status(`saved ${r.filename} (${(r.size / 1024).toFixed(0)} KB)${r.note ? ` · ${r.note}` : ""}`);
    };
    const saveAll = root.querySelector(".sl-save-all") as HTMLButtonElement | null;
    saveAll?.addEventListener("click", () => void runAction(saveAll, async () => {
      // Volumes first: a segmentation's DICOM needs its volume's series to point at.
      // Save all writes what is not there yet: an unchanged segmentation from the database is not written again.
      const order = [...nodes.filter((n) => n.type !== "segmentation" && !already(n.id)), ...nodes.filter((n) => n.type === "segmentation" && !already(n.id))];
      let done = 0, failed = 0;
      for (const n of order) {
        try { await saveOne(n.id, dbFor(n)); done++; } catch (e) { failed++; status(`could not save ${n.name}: ${(e as Error).message}`); }
      }
      status(`saved ${done} of ${order.length}${failed ? ` — ${failed} could not be saved (see above)` : ""}`);
      render();
      if (failed) throw new Error("some were not saved");
    }, { busyLabel: "Saving…", doneLabel: "Saved ✓", failedLabel: "Not all saved" }).catch(() => {}));
    root.querySelectorAll(".sl-save-item[data-id]").forEach((tr) => {
      const saveBtn = tr.querySelector(".sl-save-btn") as HTMLButtonElement | null;
      if (!saveBtn) return;                                // already in the database: no button
      // "Closed" shows only while a surface format is chosen, and keeps its tick across the list's re-renders.
      const rowId = (tr as HTMLElement).dataset.id!;
      const sel = tr.querySelector(".sl-fmt") as HTMLSelectElement | null, closedLabel = tr.querySelector(".sl-save-closed") as HTMLElement | null;
      const box = tr.querySelector(".sl-save-closed-box") as HTMLInputElement | null;
      if (sel && closedLabel && rowId !== EVERYTHING_3D) sel.addEventListener("change", () => { closedLabel.hidden = !SURFACE_FORMATS.has(sel.value); });
      box?.addEventListener("change", () => closedChoice.set(rowId, box.checked));
      saveBtn.addEventListener("click", () => void runAction(saveBtn, async () => {
        const id = (tr as HTMLElement).dataset.id!, fmt = saveBtn.dataset.fmt ?? (tr.querySelector(".sl-fmt") as HTMLSelectElement).value;
        const closed = SURFACE_FORMATS.has(fmt) ? (box?.checked ?? true) : undefined;
        status("exporting…");
        try { await saveOne(id, fmt, closed === undefined ? undefined : { closed }); render(); }
        catch (e) {
          status(`could not save: ${(e as Error).message}`);
          throw e;   // so the button says so too (runAction's failedLabel), not "Saved ✓"
        }
      }, { busyLabel: "Saving…", doneLabel: "Saved ✓", failedLabel: "Not saved" }).catch(() => {}));
    });
  };
  render();
  // Re-rendered on every scene change while this pane is up; the caller re-renders on show.
  // ONE SUBSCRIPTION PER PANE: Load / Save calls this each time its Save arrow opens, on the same element
  // (hidden, not removed), and each call added another that rebuilt the list on every change (code review
  // 2026-09-24, A16). The previous one for this element goes first.
  subscriptions.get(root)?.();
  const off = live.subscribe((c) => { if (!root.isConnected) { off(); subscriptions.delete(root); return; } if (c.type === "image" || c.type === "segmentation" || c.kind === "remove") render(); });
  subscriptions.set(root, off);
}
const subscriptions = new WeakMap<HTMLElement, () => void>();
