// "Volumes" panel (W3): active-volume selection, window/level (sliders + numeric + Auto + CT/PET presets),
// threshold (alpha-only), interpolation toggle, and the color-table picker. Every control patches the
// volume's `scalarVolumeDisplay` node through the LiveScene (local-authoritative), so the slice + VR views
// update immediately and undo/sessions see the edits. Plain DOM, theme.css tokens. RAS/geometry-free.
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import type { ZarrDesc } from "../zarr.ts";
import { fetchZarrVolumeNative } from "../zarr.ts";
import { autoWindowLevel, CT_WL_PRESETS } from "../../logic/window-level.ts";
import { COLOR_TABLES, tableNode } from "../../logic/color-tables.ts";
import { dtypeInWords, fmtCount, fmtDims, fmtMm, volumeInfo } from "../../logic/volume-info.ts";
import { isColorMap } from "../fields.ts";

export interface VolumesPanelOpts { live: LiveScene; onStatus?: (s: string) => void; }

interface VolInfo { imageId: string; displayId: string; name: string; range: [number, number]; d: MrsonNode; }

export function registerVolumesPanel(shell: AppShell, opts: VolumesPanelOpts): void {
  const { live } = opts;
  let activeId = "";
  let dragging = false;   // suppress subscribe-driven re-render while a W/L slider is dragged (avoids detaching it)

  const scalarVolumes = (): VolInfo[] => {
    const out: VolInfo[] = [];
    for (const n of live.nodes.values()) {
      if (n.type !== "image" || n.labelmap) continue;
      const did = ((n.refs as Record<string, string[]> | undefined)?.display ?? [])[0];
      const d = did ? live.nodes.get(did) : undefined;
      if (!d || d.type !== "scalarVolumeDisplay") continue;
      const th = (d.threshold as [number, number] | undefined) ?? [0, 1];
      out.push({ imageId: n.id, displayId: d.id, name: (n.name as string) ?? n.id, range: th, d });
    }
    return out;
  };
  const info = (id: string): VolInfo | undefined => scalarVolumes().find((v) => v.imageId === id);
  const patch = (displayId: string, prop: string, value: unknown) => live.write({ op: "patch", id: displayId, path: `#/${prop}`, value });

  // ── programmatic API (tests / desktop shell) ──────────────────────────────
  const setWindowLevel = (imageId: string, window: number, level: number) => {
    const v = info(imageId); if (!v) return;
    patch(v.displayId, "window", window); patch(v.displayId, "level", level); patch(v.displayId, "autoWindowLevel", false);
  };
  const autoWL = async (imageId: string) => {
    const v = info(imageId); const n = live.nodes.get(imageId); if (!v || !n?.zarr || isColorMap(n)) return;
    const zv = await fetchZarrVolumeNative(live.blobBase(), n.zarr as ZarrDesc);
    const wl = autoWindowLevel(zv.data as Parameters<typeof autoWindowLevel>[0]);
    patch(v.displayId, "window", wl.window); patch(v.displayId, "level", wl.level); patch(v.displayId, "autoWindowLevel", true);
    return wl;
  };
  const wlPreset = (imageId: string, name: string) => {
    const p = CT_WL_PRESETS.find((x) => x.name === name); const v = info(imageId); if (!p || !v) return;
    setWindowLevel(imageId, p.window, p.level);
  };
  const setThreshold = (imageId: string, on: boolean, lo?: number, hi?: number) => {
    const v = info(imageId); if (!v) return;
    patch(v.displayId, "applyThreshold", on);
    if (lo !== undefined && hi !== undefined) patch(v.displayId, "threshold", [lo, hi]);
  };
  const setInterpolate = (imageId: string, on: boolean) => { const v = info(imageId); if (v) patch(v.displayId, "interpolate", on); };
  const setColorTable = (imageId: string, tableId: string) => {
    const v = info(imageId); if (!v) return;
    if (!live.nodes.has(tableId)) { const tn = tableNode(tableId); live.write({ op: "put", id: tn.id, node: tn as unknown as MrsonNode }); }
    patch(v.displayId, "refs", { ...(v.d.refs as Record<string, unknown> ?? {}), color: [tableId] });
  };
  const displayState = (imageId: string) => {
    const v = info(imageId); if (!v) return null; const d = v.d;
    const cid = ((d.refs as Record<string, string[]> | undefined)?.color ?? [])[0] ?? "vtkMRMLColorTableNodeGrey";
    return { window: d.window as number, level: d.level as number, autoWindowLevel: !!d.autoWindowLevel,
      applyThreshold: !!d.applyThreshold, threshold: d.threshold as [number, number], interpolate: d.interpolate !== false, colorTableId: cid };
  };

  Object.assign(globalThis, {
    __volumeList: () => scalarVolumes().map((v) => ({ imageId: v.imageId, displayId: v.displayId, name: v.name, active: v.imageId === activeId })),
    __setActiveVolume: (id: string) => { activeId = id; render(); },
    __volumeDisplay: (id: string) => displayState(id),
    __setWindowLevel: setWindowLevel, __autoWL: autoWL, __wlPreset: wlPreset,
    __setThreshold: setThreshold, __setInterpolate: setInterpolate, __setColorTable: setColorTable,
  });

  // ── UI ────────────────────────────────────────────────────────────────────
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  function render() {
    if (!root) return;
    const vols = scalarVolumes();
    if (!activeId || !vols.some((v) => v.imageId === activeId)) activeId = vols[0]?.imageId ?? "";
    const v = info(activeId), st = displayState(activeId);
    if (!v || !st) { root.innerHTML = `<h2>Window / Level</h2><p class="sl-hint">No scalar volume loaded.</p>`; return; }
    const dataMin = Math.min(v.range[0], st.level - st.window), dataMax = Math.max(v.range[1], st.level + st.window);
    const presets = CT_WL_PRESETS.map((p) => `<option value="${p.name}">${p.name}</option>`).join("");
    const tables = COLOR_TABLES.map((t) => `<option value="${t.id}"${t.id === st.colorTableId ? " selected" : ""}>${t.name}</option>`).join("");
    const volOpts = vols.map((x) => `<option value="${x.imageId}"${x.imageId === activeId ? " selected" : ""}>${escapeHtml(x.name)}</option>`).join("");
    // UNDER THE TEMPLATE (PALETTE.md, module rules, 2026-09-22): the face is the volume, the
    // preset, window and level, and Auto; threshold, colors, interpolation and the volume's
    // numbers are under Advanced.
    root.innerHTML = `<h2>Window / Level</h2>`;
    const sec = shell.section(root, "Window / Level", { open: true, band: "yellow", note: vols.length > 1 ? `${vols.length} volumes` : "" });
    // The shell's row grammar (label / control / value), so nothing reaches past the column: the
    // 178 px number fields ran off a 400 px column and the threshold's Hi was off screen (critic
    // 2026-09-22, 2.2). The number sits in the value column; the slider is the control.
    const r = (parent: HTMLElement, label: string, control: string, value = "", title = "") => {
      const c = shell.row(parent, label, value ? { value } : { wide: true });
      c.innerHTML = control;
      if (title) c.title = title;
      return c;
    };
    r(sec, "Volume", `<select class="sl-vol-active">${volOpts}</select>`, "", "Which loaded volume these settings apply to");
    // A COLOR MAP (Color FA) is drawn as its colors: window and level do not apply to it (fields.ts isColorMap).
    if (isColorMap(live.nodes.get(v.imageId))) r(sec, "", `<span class="sl-hint">A color map: drawn as its colors. The window, level and color table below do not change it.</span>`);
    r(sec, "Preset", `<select class="sl-preset"><option value="">choose…</option>${presets}</select>`, "", "A window and level for a kind of tissue");
    r(sec, "Window", `<input class="sl-w" type="range" step="any" min="0" max="${(dataMax - dataMin) * 1.5 || 1}" value="${st.window}">`, "", "How wide a range of values is spread over black to white");
    r(sec, "", `<input class="sl-wn sl-num" type="number" step="any" value="${st.window.toFixed(1)}" title="The window, as a number">`);
    r(sec, "Level", `<input class="sl-l" type="range" step="any" min="${dataMin}" max="${dataMax}" value="${st.level}">`, "", "The value shown as mid-gray");
    r(sec, "", `<input class="sl-ln sl-num" type="number" step="any" value="${st.level.toFixed(1)}" title="The level, as a number">`);
    const acts = shell.actions(sec);
    acts.innerHTML = `<button class="sl-primary sl-auto" title="A window and level from the values in this volume">Auto</button>`;
    const adv = shell.section(root, "Advanced", { open: false, band: "none" });
    r(adv, "Colors", `<select class="sl-colors">${tables}</select>`, "", "The color table the gray values are shown through");
    r(adv, "Threshold", `<label title="Values outside the range are not drawn"><input type="checkbox" class="sl-th-on"${st.applyThreshold ? " checked" : ""}> only values between</label>`);
    r(adv, "Low", `<input class="sl-th-lo sl-num" type="number" step="any" value="${st.threshold[0]}" title="Below this, nothing is drawn">`);
    r(adv, "High", `<input class="sl-th-hi sl-num" type="number" step="any" value="${st.threshold[1]}" title="Above this, nothing is drawn">`);
    r(adv, "Interpolate", `<label title="Smooth between voxels when the slice is enlarged; off shows the voxels as squares"><input type="checkbox" class="sl-interp"${st.interpolate ? " checked" : ""}> on</label>`);
    adv.insertAdjacentHTML("beforeend", volumeInformation(activeId));
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    $("select.sl-vol-active").addEventListener("change", (e) => { activeId = (e.target as HTMLSelectElement).value; render(); });
    const w = $<HTMLInputElement>("input.sl-w"), wn = $<HTMLInputElement>("input.sl-wn"), l = $<HTMLInputElement>("input.sl-l"), ln = $<HTMLInputElement>("input.sl-ln");
    const pushWL = () => { setWindowLevel(activeId, +w.value, +l.value); status(`W/L ${(+w.value).toFixed(0)}/${(+l.value).toFixed(0)}`); };
    for (const el of [w, l]) { el.addEventListener("pointerdown", () => { dragging = true; }); el.addEventListener("change", () => { dragging = false; render(); }); }
    w.addEventListener("input", () => { wn.value = (+w.value).toFixed(1); pushWL(); });
    l.addEventListener("input", () => { ln.value = (+l.value).toFixed(1); pushWL(); });
    wn.addEventListener("change", () => { w.value = wn.value; pushWL(); });
    ln.addEventListener("change", () => { l.value = ln.value; pushWL(); });
    {
      // The picture changes, but on a big volume not for a second or two; the button says so meanwhile.
      const auto = $<HTMLButtonElement>("button.sl-auto");
      auto.addEventListener("click", () => void runAction(auto, async () => {
        status("auto window/level…");
        await autoWL(activeId);
        status("auto window/level applied");
        setTimeout(render, 1400);          // after the button has had its say
      }, { busyLabel: "Working…", doneLabel: "Done ✓" }).catch(() => {}));
    }
    $("select.sl-preset").addEventListener("change", (e) => { const nm = (e.target as HTMLSelectElement).value; if (nm) { wlPreset(activeId, nm); render(); } });
    $("input.sl-th-on").addEventListener("change", (e) => setThreshold(activeId, (e.target as HTMLInputElement).checked));
    const tlo = $<HTMLInputElement>("input.sl-th-lo"), thi = $<HTMLInputElement>("input.sl-th-hi");
    const pushTh = () => setThreshold(activeId, $<HTMLInputElement>("input.sl-th-on").checked, +tlo.value, +thi.value);
    tlo.addEventListener("change", pushTh); thi.addEventListener("change", pushTh);
    $("input.sl-interp").addEventListener("change", (e) => setInterpolate(activeId, (e.target as HTMLInputElement).checked));
    $("select.sl-colors").addEventListener("change", (e) => setColorTable(activeId, (e.target as HTMLSelectElement).value));
  }

  /**
   * VOLUME INFORMATION, as Slicer's Volumes module has it: what the grid is, read off the node.
   * Ron, 2026-09-15: "add information about voxel dimension and number of voxels in analogy to
   * what is available in slicer." Voxel size is the length of each ijkToRAS column; the voxel's
   * volume is the determinant, which differs from the product on an oblique grid, and the panel
   * says when the grid is oblique.
   */
  function volumeInformation(imageId: string): string {
    const n = live.nodes.get(imageId); if (!n?.dims || !n.ijkToRAS) return "";
    const v = volumeInfo(n.dims as number[], n.ijkToRAS as number[]);
    const o = (n.origin as { dtype?: string; seriesInstanceUID?: string; modality?: string } | undefined) ?? {};
    const row = (k: string, val: string, title = "") => `<div class="sl-row sl-vol-info-row"${title ? ` title="${title}"` : ""}><label>${k}</label><span class="sl-vol-info-val">${val}</span></div>`;
    return `<h3 class="sl-vol-info-h">Volume information</h3>
      ${row("Dimensions", `${fmtDims(v.dims)} voxels`, "voxels along the grid's i, j, k axes")}
      ${row("Voxel size", `${fmtMm(v.spacing[0])} × ${fmtMm(v.spacing[1])} × ${fmtMm(v.spacing[2])} mm`, "the size of one voxel along i, j, k")}
      ${row("Voxels", fmtCount(v.voxels), "dimensions multiplied")}
      ${row("Extent", `${fmtMm(v.extentMm[0], 1)} × ${fmtMm(v.extentMm[1], 1)} × ${fmtMm(v.extentMm[2], 1)} mm`, "the grid's size along i, j, k")}
      ${row("Voxel volume", `${fmtMm(v.voxelMm3, 4)} mm³ · ${fmtMm(v.totalMl, 1)} mL in all`, v.axisAligned ? "" : "an oblique grid: the voxel's volume is the parallelepiped its three steps span")}
      ${row("Origin", `R ${fmtMm(v.origin[0], 1)} · A ${fmtMm(v.origin[1], 1)} · S ${fmtMm(v.origin[2], 1)} mm`, "RAS position of voxel (0, 0, 0)")}
      ${v.axisAligned ? "" : row("Grid", "oblique — not aligned with the patient axes")}
      ${o.dtype ? row("Stored as", dtypeInWords(String(o.dtype)), `the data type of the stored values (${o.dtype})`) : ""}
      ${o.modality ? row("Modality", o.modality) : ""}`;
  }

  // "Window / Level", not Slicer's "Volumes": the name of what you do here, in the words a
  // clinician uses. Ron, 2026-09-11: "Agreed to both." The id stays "volumes".
  shell.registerPanel({ id: "volumes", title: "Window / Level", groups: ["Display"], order: 1, tip: "How a volume is shown in the slices: window and level, threshold, color table", mount(el) { root = el; render(); } });
  // re-render when volumes are added/removed or a display node changes elsewhere
  live.subscribe((c) => { if (!dragging && (c.type === "image" || c.type === "scalarVolumeDisplay" || c.kind === "remove")) render(); });
}
