// Slice-view controller bar (W2) — the thin coloured bar Slicer shows above each slice view: orientation,
// an offset slider (mm along the normal, from vtkMRMLSliceLogic::GetSliceOffsetRangeResolution), and a fit
// button. Plain DOM in the theme; a pure adapter supplies the data so it works over native sliceView nodes
// and over a Slicer peer's slice nodes alike. Reuses the app theme tokens (--sl-view-* per cell colour).
import { LINE_VIEWS, lineOrientation } from "../../logic/line-axes.ts";
import { GEAR_SVG } from "./gear-icon.ts";

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
  /** THE VIEW'S LAYERS, for the gear's panel: the images that can be shown, what is underneath, what is over it, and
   *  how strongly the one over it is drawn (0..1). */
  layers?(): { images: { id: string; name: string }[]; background: string | null; foreground: string | null; opacity: number };
  /** Change this view's layers, or every slice view's when `all`. `foreground: null` takes the one over it away. */
  setLayers?(change: { background?: string; foreground?: string | null; opacity?: number }, all: boolean): void;
  /** subscribe to external offset/geometry changes (scroll, jump) so the bar re-reads; returns unsubscribe */
  onChange(cb: () => void): () => void;
}

const ORIENT_LABEL: Record<string, string> = { axial: "Axial", coronal: "Coronal", sagittal: "Sagittal", "short-axis": "Short axis", "four-chamber": "4-chamber", "two-chamber": "2-chamber" };
/** The heart's planes, after the body's: offered when a segmentation of the chambers is loaded. */
const CARDIAC_OPTIONS = `<optgroup label="Heart" data-heart="1"><option value="short-axis" title="Perpendicular to the left ventricle's long axis; viewed from the apex, right ventricle on the left">Short axis</option><option value="four-chamber" title="Through the long axis and the right ventricle; apex up">4-chamber</option><option value="two-chamber" title="Through the long axis, perpendicular to the 4-chamber plane; apex on the left">2-chamber</option></optgroup>`;

export interface SliceController { el: HTMLElement; refresh(): void; detach(): void }

/** One for every slice view's gear: a layer change applies to all slice views (true) or to the view whose gear it is. */
let applyToAll = true;

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
    <button class="sl-slice-fit sl-slice-gear" title="View settings: fit to the image, the image shown, one over it and how much shows through" aria-haspopup="true" aria-expanded="false">${GEAR_SVG}</button>`;
  host.appendChild(bar);
  const orient = bar.querySelector(".sl-slice-orient") as HTMLElement;
  if (a.setOrientation) (orient as HTMLSelectElement).addEventListener("change", (e) => { a.setOrientation!((e.target as HTMLSelectElement).value); });
  const slider = bar.querySelector(".sl-slice-offset") as HTMLInputElement;
  const value = bar.querySelector(".sl-slice-value") as HTMLElement;
  const fit = bar.querySelector(".sl-slice-fit") as HTMLButtonElement;
  const btn3d = bar.querySelector(".sl-slice-3d") as HTMLButtonElement | null;

  let editing = false;
  const refresh = () => {
    // The panel shows what the views show now, when layers change while it is open (critic, 2026-10-01, finding 12).
    if (!panel.hidden && !panel.contains(document.activeElement)) drawPanel();
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
      // A plane a module set (the head's frames): its own name, as an option of its own while it is shown.
      const known = o ? [...sel.options].some((op) => op.value === o && !op.dataset.custom) : true;
      sel.querySelectorAll("option[data-custom]").forEach((op) => { if (op.value !== o) op.remove(); });
      if (o && !known && !sel.querySelector(`option[data-custom][value="${CSS.escape(o)}"]`)) {
        const op = document.createElement("option"); op.value = o; op.textContent = o; op.dataset.custom = "1"; op.title = "A plane set by the module you are in"; sel.prepend(op);
      }
      if (o) sel.value = o;
    } else orient.textContent = o ? ORIENT_LABEL[o] ?? o : "";
    const disabled = !r || off == null;
    slider.disabled = disabled;   // the gear stays: its panel holds more than Fit
    if (r) { slider.min = String(r.min); slider.max = String(r.max); slider.step = String(r.step > 0 ? r.step : "any"); }
    if (btn3d && a.in3D) btn3d.classList.toggle("sl-active", a.in3D());
    if (off != null) { slider.value = String(off); value.textContent = off.toFixed(1); }
    else value.textContent = "";
  };
  slider.addEventListener("input", () => { editing = true; const mm = Number(slider.value); value.textContent = mm.toFixed(1); a.setOffset(mm); });
  slider.addEventListener("change", () => { editing = false; refresh(); });
  slider.addEventListener("pointerup", () => { editing = false; });
  btn3d?.addEventListener("click", () => { a.toggle3D?.(); refresh(); });

  // THE GEAR'S PANEL (Ron, 2026-10-01, on a mockup: "replace the fit to volume with a settings button which then
  // includes the fit to volume and the ability to select the two channels and transparency ... the average user will
  // need an interface"): Fit, the image, one over it, how much shows through, and whether the change is this view's or
  // every slice view's. THE SLICE VIEWS ARE PEERS (Ron, the same day: "all 2d viewers should be peers ... either tweaking
  // one or tweaking all"): that choice is ONE setting shared by every view's gear (applyToAll, at the top of this file), not a box each
  // panel keeps for itself.
  const panel = document.createElement("div");
  panel.className = "sl-slice-panel"; panel.hidden = true;
  host.appendChild(panel);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const drawPanel = () => {
    const L = a.layers?.();
    const opts = (sel: string | null, none: boolean) => (none ? `<option value="">None</option>` : "") +
      (L?.images ?? []).map((im) => `<option value="${esc(im.id)}"${im.id === sel ? " selected" : ""}>${esc(im.name)}</option>`).join("");
    const seeThrough = L ? Math.round(100 * (1 - L.opacity)) : 50;
    panel.innerHTML = `
      <button class="sl-slice-panel-fit" title="Center the image and fit it to this view">Fit to the image</button>
      ${L ? `<div class="sl-slice-panel-grid">
        <label>Image</label><select class="sl-sp-bg" title="The picture underneath">${L.background ? "" : `<option value="" disabled selected>Choose an image</option>`}${opts(L.background, false)}</select>
        <label>Over it</label><select class="sl-sp-fg" title="A second picture drawn over the first (for example a color map over the anatomy)">${opts(L.foreground, true)}</select>
        <label>See-through</label><span class="sl-sp-op"><input type="range" min="0" max="100" step="5" value="${seeThrough}" title="How much of the image underneath shows through the one over it"${L.foreground ? "" : " disabled"}><span>${seeThrough}%</span></span>
      </div>
      <label class="sl-sp-all" title="On: a change here applies to every slice view. Off: to this view only. The same setting in every view's gear."><input type="checkbox"${applyToAll ? " checked" : ""}> All slice views</label>` : ""}`;
    (panel.querySelector(".sl-slice-panel-fit") as HTMLButtonElement).onclick = () => { a.fit(); refresh(); };
    if (!L) return;
    const bg = panel.querySelector(".sl-sp-bg") as HTMLSelectElement, fg = panel.querySelector(".sl-sp-fg") as HTMLSelectElement;
    const op = panel.querySelector(".sl-sp-op input") as HTMLInputElement, opv = panel.querySelector(".sl-sp-op span") as HTMLElement;
    const all = panel.querySelector(".sl-sp-all input") as HTMLInputElement;
    all.onchange = () => { applyToAll = all.checked; };
    bg.onchange = () => { a.setLayers?.({ background: bg.value }, applyToAll); drawPanel(); };
    fg.onchange = () => {
      // Something over the image with nothing showing would look like nothing happened: half, when it was off.
      const cur = a.layers?.()?.opacity ?? 0;
      a.setLayers?.({ foreground: fg.value || null, ...(fg.value && cur < 0.05 ? { opacity: 0.5 } : {}) }, applyToAll); drawPanel();
    };
    op.oninput = () => { opv.textContent = `${op.value}%`; a.setLayers?.({ opacity: 1 - Number(op.value) / 100 }, applyToAll); };
  };
  const setOpen = (open: boolean) => { panel.hidden = !open; fit.setAttribute("aria-expanded", String(open)); fit.classList.toggle("sl-active", open); if (open) drawPanel(); };
  fit.addEventListener("click", (e) => { e.stopPropagation(); setOpen(panel.hidden); });
  // Closed by a click anywhere else, or Escape: a popup only its opener can dismiss is a trap.
  const outside = (e: PointerEvent) => { if (!panel.hidden && !panel.contains(e.target as Node) && !fit.contains(e.target as Node)) setOpen(false); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !panel.hidden) setOpen(false); };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey);
  const unsub = a.onChange(refresh);
  refresh();
  return { el: bar, refresh, detach() { unsub(); bar.remove(); panel.remove(); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey); } };
}
