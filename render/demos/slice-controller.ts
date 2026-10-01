// Slice-view controller bar (W2) — the thin coloured bar Slicer shows above each slice view: orientation,
// an offset slider (mm along the normal, from vtkMRMLSliceLogic::GetSliceOffsetRangeResolution), and a fit
// button. Plain DOM in the theme; a pure adapter supplies the data so it works over native sliceView nodes
// and over a Slicer peer's slice nodes alike. Reuses the app theme tokens (--sl-view-* per cell colour).
import { LINE_VIEWS, lineOrientation } from "../../logic/line-axes.ts";

export interface SliceControllerAdapter {
  /** An anatomical axis, or one of the heart's planes ("short-axis", "four-chamber", "two-chamber"). */
  orientation(): string | null;
  offset(): number | null;
  range(): { min: number; max: number; step: number } | null;
  setOffset(mm: number): void;
  fit(): void;
  /** optional reformat: when present the orientation shows as a combo (Slicer's orientation menu). */
  setOrientation?(o: string): void;
  /** Whether the heart's planes can be offered: a segmentation of the chambers is in the scene. */
  cardiacAvailable?(): boolean;
  /** The Line markups in the scene, each offering three planes (logic/line-axes.ts): across, along 1, along 2. */
  lines?(): { id: string; name: string }[];
  /** optional "show this slice in the 3D view" (Slice Model / Drop-Slice) toggle + current state. */
  toggle3D?(): void;
  in3D?(): boolean;
  /** subscribe to external offset/geometry changes (scroll, jump) so the bar re-reads; returns unsubscribe */
  onChange(cb: () => void): () => void;
}

const ORIENT_LABEL: Record<string, string> = { axial: "Axial", coronal: "Coronal", sagittal: "Sagittal", "short-axis": "Short axis", "four-chamber": "4-chamber", "two-chamber": "2-chamber" };
/** The heart's planes, after the body's: offered when a segmentation of the chambers is loaded. */
const CARDIAC_OPTIONS = `<optgroup label="Heart" data-heart="1"><option value="short-axis" title="Perpendicular to the left ventricle's long axis; viewed from the apex, right ventricle on the left">Short axis</option><option value="four-chamber" title="Through the long axis and the right ventricle; apex up">4-chamber</option><option value="two-chamber" title="Through the long axis, perpendicular to the 4-chamber plane; apex on the left">2-chamber</option></optgroup>`;

export interface SliceController { el: HTMLElement; refresh(): void; detach(): void }

/** Mount a controller bar as the first child of a slice cell element. `cellName` picks the accent colour. */
export function mountSliceController(host: HTMLElement, cellName: string, a: SliceControllerAdapter): SliceController {
  const bar = document.createElement("div");
  bar.className = "sl-slice-bar";
  bar.dataset.cell = cellName;
  const orientHtml = a.setOrientation
    ? `<select class="sl-slice-orient" aria-label="Slice orientation"><option value="axial">Axial</option><option value="sagittal">Sagittal</option><option value="coronal">Coronal</option>${CARDIAC_OPTIONS}</select>`
    : `<span class="sl-slice-orient"></span>`;
  bar.innerHTML = `
    ${orientHtml}
    <input class="sl-slice-offset" type="range" step="any" aria-label="Slice offset">
    <span class="sl-slice-value"></span>
    ${a.toggle3D ? `<button class="sl-slice-3d" title="Show this slice in 3D">3D</button>` : ""}
    <button class="sl-slice-fit" title="Fit to volume">⤢</button>`;
  host.appendChild(bar);
  const orient = bar.querySelector(".sl-slice-orient") as HTMLElement;
  if (a.setOrientation) (orient as HTMLSelectElement).addEventListener("change", (e) => { a.setOrientation!((e.target as HTMLSelectElement).value); });
  const slider = bar.querySelector(".sl-slice-offset") as HTMLInputElement;
  const value = bar.querySelector(".sl-slice-value") as HTMLElement;
  const fit = bar.querySelector(".sl-slice-fit") as HTMLButtonElement;
  const btn3d = bar.querySelector(".sl-slice-3d") as HTMLButtonElement | null;

  let editing = false;
  const refresh = () => {
    if (editing) return;
    const o = a.orientation(), r = a.range(), off = a.offset();
    if (a.setOrientation) {
      const sel = orient as HTMLSelectElement;
      // The heart's planes are on the menu only while a chamber segmentation can define them.
      const heart = sel.querySelector("optgroup[data-heart]") as HTMLOptGroupElement | null;
      if (heart) { const ok = !!a.cardiacAvailable?.(); heart.hidden = !ok; heart.disabled = !ok; }
      // A LINE'S THREE PLANES, one group per Line markup (Ron, 2026-09-25: "two markups … would define the axis").
      const lines = a.lines?.() ?? [];
      const sig = lines.map((l) => `${l.id}=${l.name}`).join("|");
      if (sel.dataset.lines !== sig) {
        sel.querySelectorAll("optgroup[data-line]").forEach((g) => g.remove());
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
        for (const l of lines) {
          sel.insertAdjacentHTML("beforeend", `<optgroup data-line="1" label="Line: ${esc(l.name)}">${LINE_VIEWS.map((v) =>
            `<option value="${esc(lineOrientation(l.id, v.id))}" title="${esc(v.tip)}">${esc(l.name)} · ${v.label}</option>`).join("")}</optgroup>`);
        }
        sel.dataset.lines = sig;
      }
      if (o) sel.value = o;
    } else orient.textContent = o ? ORIENT_LABEL[o] ?? o : "";
    const disabled = !r || off == null;
    slider.disabled = disabled; fit.disabled = disabled;
    if (r) { slider.min = String(r.min); slider.max = String(r.max); slider.step = String(r.step > 0 ? r.step : "any"); }
    if (btn3d && a.in3D) btn3d.classList.toggle("sl-active", a.in3D());
    if (off != null) { slider.value = String(off); value.textContent = off.toFixed(1); }
    else value.textContent = "";
  };
  slider.addEventListener("input", () => { editing = true; const mm = Number(slider.value); value.textContent = mm.toFixed(1); a.setOffset(mm); });
  slider.addEventListener("change", () => { editing = false; refresh(); });
  slider.addEventListener("pointerup", () => { editing = false; });
  fit.addEventListener("click", () => { a.fit(); refresh(); });
  btn3d?.addEventListener("click", () => { a.toggle3D?.(); refresh(); });
  const unsub = a.onChange(refresh);
  refresh();
  return { el: bar, refresh, detach() { unsub(); bar.remove(); } };
}
