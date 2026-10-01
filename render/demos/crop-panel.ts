// Crop volume — take a smaller box out of a volume, on the voxel grid.
//
// Ron: "About half of the volume is neck. I could crop, if I had a crop tool."
//
// It is not only tidiness. FastSurfer's conformed grid is derived from the FIELD OF VIEW, so this
// study's 256 mm box conforms to 384^3, and the 79-class score field that comes out is 4.47 billion
// values -- past what Apple's GPU can address, which is why full-resolution FastSurfer fails on it.
// Measured against FastSurfer's own conform function: cutting the neck away takes the conformed grid
// to 306^3 and the field to 2.26 billion, 47% under the ceiling. Cropping is what makes the run
// possible at 0.67 mm instead of at 1 mm.
//
// NOTHING IS RESAMPLED. Ron's general rule -- "we leave the data as is, but modulate the appearance
// as needed" -- and his reason for wanting the resolution in the first place: "people want to use
// parcellations for quantifications, and for that purpose, precision beats everything else." A crop
// that resampled to an axis-aligned box would interpolate every voxel on the way to a measurement.
// This takes a sub-box of the existing grid: the voxels out are the voxels in, and only the origin
// of ijkToRAS moves. See logic/crop.ts.

import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import { keepScroll } from "./panel-scroll.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import { loadVolumeIntoScene, LocalBlobStore } from "../../logic/ingest.ts";
import { boxAroundData, type Box, cropVolume, cutBoxAtPlane, voxelRangeFor, volumeAlignedBox } from "../../logic/crop.ts";
import { fetchZarrVolumeNative, type ZarrDesc } from "../zarr.ts";
import { setVolumeRenderingOn, volumeRenderingOn } from "./tf-editor.ts";
import { COLOR_MAP_REFUSAL, isColorMap } from "../fields.ts";

export interface CropPanelOpts {
  live: LiveScene;
  store: LocalBlobStore;
  status?: (s: string) => void;
}

/** The box this panel makes when asked to fit one. Any other `roi` markup — one placed from the
 *  Markups panel — is offered in the list too, because the application already HAS a crop box and a
 *  second kind would be one too many. Ron: "Slicer live has a cropbox." */
const FITTED_ID = "local-markup-cropbox";

export function registerCropPanel(shell: AppShell, opts: CropPanelOpts): void {
  const { live, store } = opts;
  let root: HTMLElement | null = null;
  let chosen = "";
  let chosenBox = "";
  let busy = false;
  let note = "";
  let lastCrop = "";                       // the volume the last crop made, for the "where does it live" row
  let autoSlices = false;                  // the one-time "show the slices in 3D" on first arrival

  const volumes = () =>
    [...live.nodes.values()].filter((n) => n.type === "image" && !n.labelmap);
  /** Every ROI markup in the scene, whichever panel made it. */
  const boxes = () =>
    [...live.nodes.values()].filter((n) => n.type === "markup" && n.markupType === "roi" && n.center && n.size);
  const boxOf = (id: string): Box | null => {
    const n = live.nodes.get(id);
    const c = n?.center as number[] | undefined, s = n?.size as number[] | undefined;
    const ax = n?.orientation as number[] | undefined;
    return c && s
      ? { center: [c[0], c[1], c[2]], size: [s[0], s[1], s[2]], ...(ax && ax.length === 9 ? { axes: ax } : {}) }
      : null;
  };
  const roi = (): Box | null => (chosenBox ? boxOf(chosenBox) : null);

  const writeRoi = (box: Box) => {
    live.write({
      op: "put",
      id: FITTED_ID,
      node: {
        type: "markup", id: FITTED_ID, name: "Crop box", markupType: "roi", frame: "RAS",
        center: box.center, size: box.size,
        // The box's own axes, the way Slicer's ROI carries an ObjectToNodeMatrix. Without it a crop
        // of an oblique volume keeps essentially everything -- see logic/crop.ts.
        ...(box.axes ? { orientation: box.axes } : {}),
        visible: true, locked: false, points: [],
        source: { mrmlClass: "vtkMRMLMarkupsROINode" }, origin: { local: true },
      } as unknown as MrsonNode,
    });
  };

  /** What a crop of this volume is called. One definition, so the panel cannot promise one name and
   *  the scene get another. */
  const croppedName = (img: MrsonNode) => `${(img.name as string) ?? "Volume"} (cropped)`;

  /** The voxels of a scene volume, in the dtype they are stored in. */
  const voxelsOf = async (img: MrsonNode) => {
    if (isColorMap(img)) throw new Error(`"${String(img.name ?? "this volume")}" ${COLOR_MAP_REFUSAL}`);
    return await fetchZarrVolumeNative(live.blobBase(), img.zarr as ZarrDesc);
  };

  /**
   * The red (axial) slice, as a patient-space plane: which RAS axis it cuts and where.
   *
   * Read from the slice view's own `sliceToRAS`, the same matrix SliceDisplayableManager reads, so
   * the number here is exactly the one shown in the corner of that view. The axis comes from the
   * plane's normal rather than being assumed to be S, so a coronal or sagittal view cuts correctly
   * too if that is the one the user is looking at.
   */
  const slicePlane = (
    layoutName: string,
  ): { axis: 0 | 1 | 2; at: number; label: string; point: [number, number, number]; normal: [number, number, number] } | null => {
    const n = [...live.nodes.values()].find((x) =>
      x.type === "view" && x.kind === "slice" && x.layoutName === layoutName
    );
    const m = n?.sliceToRAS as number[] | undefined;
    if (!m || m.length < 16) return null;
    const nx = Math.abs(m[2]), ny = Math.abs(m[6]), nz = Math.abs(m[10]);
    const axis: 0 | 1 | 2 = nz >= nx && nz >= ny ? 2 : ny >= nx ? 1 : 0;
    return {
      axis, at: [m[3], m[7], m[11]][axis], label: ["R", "A", "S"][axis],
      point: [m[3], m[7], m[11]] as [number, number, number],
      normal: [m[2], m[6], m[10]] as [number, number, number],
    };
  };

  /** The slice views by layout name, in the scene's own order (Red, Yellow, Green). */
  const sliceCells = () =>
    [...live.nodes.values()].filter((n) => n.type === "view" && n.kind === "slice")
      .map((n) => n.layoutName as string).filter(Boolean);
  const hooks = () => globalThis as unknown as {
    __setSliceIn3D?: (cell: string, on: boolean) => void;
    __sliceIn3D?: () => string[];
    __exportVolumeAsDicom?: (id: string) => Promise<{ filename: string; size: number; note?: string }>;
    __dicomAncestorOf?: (id: string) => { id: string; name: string; seriesInstanceUID?: string } | null;
  };
  const slicesIn3D = () => hooks().__sliceIn3D?.() ?? [];
  const setSlicesIn3D = (on: boolean) => { for (const c of sliceCells()) hooks().__setSliceIn3D?.(c, on); };

  const cutAtRedSlice = () => {
    const img = live.nodes.get(chosen);
    const pl = slicePlane("Red");
    if (!img || !pl) { note = "no axial slice view to take a position from"; render(); return; }
    // TRIM THE BOX THAT IS THERE, if there is one. Starting from the whole volume every time threw
    // away a fitted box, so "Fit a box to the tissue" then "Cut at the red slice" kept only the cut
    // -- which shrinks ONE axis and leaves the other two at the volume's full extent. Ron's crop came
    // out 274x384x264 for exactly that reason: the neck was gone and the 256 mm axis was untouched.
    //
    // It matters beyond tidiness. A segmentation network sizes its working grid from the LARGEST
    // field of view in any direction, so a crop that shrinks one axis and not the others buys nothing
    // at all -- that crop still conformed to 384^3 and would still have failed. Composing the two
    // actions shrinks all three.
    //
    // The volume's OWN axes, not the patient axes. A RAS-aligned box on an oblique volume keeps
    // essentially the whole grid, which is what "the cropped volume is not cropped" was.
    const start = roi() ??
      volumeAlignedBox(img.dims as [number, number, number], img.ijkToRAS as number[]);
    // Keep what is ABOVE the line. On a head study that is the head; the neck is below.
    const cut = cutBoxAtPlane(start, pl.point, pl.normal, "above");
    if (!cut) { note = "the slice is outside the volume — nothing would be left"; render(); return; }
    writeRoi(cut.box);
    chosenBox = FITTED_ID;
    const tilt = cut.tiltDeg > 5
      ? ` The cut follows the volume's own axis, ${cut.tiltDeg.toFixed(0)}° off this slice, so it stays lossless.`
      : "";
    note = `box trimmed to everything above ${pl.label}: ${pl.at.toFixed(1)} mm — the red slice.${tilt} ` +
      `Move the slice and press again to adjust, then crop.`;
    render();
  };

  const fitBox = async () => {
    const img = live.nodes.get(chosen);
    if (!img) return;
    note = "reading the volume to find the tissue…";
    render();
    const zv = await voxelsOf(img);
    const box = boxAroundData(zv.data, zv.dims, img.ijkToRAS as number[]);
    if (!box) { note = "nothing above the background threshold — the volume looks empty"; render(); return; }
    writeRoi(box);
    chosenBox = FITTED_ID;
    const r = voxelRangeFor(img.dims as [number, number, number], img.ijkToRAS as number[], box);
    const kept = r
      ? `${[r.hi[0] - r.lo[0] + 1, r.hi[1] - r.lo[1] + 1, r.hi[2] - r.lo[2] + 1].join("×")} of ${(img.dims as number[]).join("×")}`
      : "";
    note = `box fitted to the tissue — ${kept}. It holds the head AND the neck, so cut at the red ` +
      `slice next, then crop.`;
    render();
  };

  const doCrop = async () => {
    const img = live.nodes.get(chosen);
    const box = roi();
    if (!img || !box) return;
    note = "reading the volume…";
    render();
    const zv = await voxelsOf(img);
    const Ctor = (zv.data as unknown as { constructor: new (n: number) => typeof zv.data }).constructor;
    const out = cropVolume(
      zv.data as unknown as { length: number; [i: number]: number },
      zv.dims,
      img.ijkToRAS as number[],
      box,
      (n) => new Ctor(n) as unknown as { length: number; [i: number]: number },
    );
    if (!out) { note = "the box does not overlap the volume"; render(); return; }
    const name = croppedName(img);
    const made = await loadVolumeIntoScene(live, store, {
      dims: out.dims,
      ijkToRAS: out.ijkToRAS,
      data: out.data as unknown as Uint8Array,
      dtype: zv.dtype,
      name,
    }, { name });
    // WHAT IT CAME FROM, recorded on the node. `refs.source` is the same link a segmentation uses to
    // name the volume it was drawn on, and it is what makes the crop saveable as DICOM at all: the
    // patient, the study, the frame of reference and the attribution all come from the series this
    // volume descends from, and without the link there is no way back to them.
    const cur = live.nodes.get(made.imageId);
    live.write({
      op: "patch", id: made.imageId, path: "#/refs",
      value: { ...((cur?.refs as Record<string, unknown>) ?? {}), source: [img.id] },
    });
    lastCrop = made.imageId;
    const before = zv.dims[0] * zv.dims[1] * zv.dims[2];
    const after = out.dims[0] * out.dims[1] * out.dims[2];
    // THE BOX'S JOB IS DONE, so it goes away. Ron: "How do I turn off the box when I am done
    // cropping?" -- and the answer should not have to be "find the Markups panel". Pressing either
    // button here brings it back, since both write a visible box, so nothing is lost by hiding it.
    if (chosenBox) live.write({ op: "patch", id: chosenBox, path: "#/visible", value: false });
    note = `${name}: ${out.dims.join("×")} voxels, ${Math.round(100 - (after / before) * 100)}% smaller. ` +
      `The original is untouched and still in the scene. The box is hidden now — fit or cut again to ` +
      `bring it back.`;
    opts.status?.(note);
    render();
  };

  /** Rebuild the panel, keeping the scroll position (see panel-scroll.ts). */
  const render = () => keepScroll(root, renderNow);

  const renderNow = () => {
    if (!root) return;
    root.innerHTML = "";
    const vols = volumes();
    if (!vols.some((v) => v.id === chosen)) chosen = (vols[0]?.id as string) ?? "";
    const sec = shell.section(root, "Crop", { open: true, band: "yellow" });   // the module's job is yellow (PALETTE.md, section colors, 2026-09-22)

    const vCell = shell.row(sec, "Volume", { wide: true });
    vCell.innerHTML = `<select class="sl-crop-vol">${
      vols.map((v) => `<option value="${v.id}"${v.id === chosen ? " selected" : ""}>${escapeHtml((v.name as string) ?? v.id)}</option>`).join("")
    }</select>`;

    const bs = boxes();
    if (!bs.some((b) => b.id === chosenBox)) chosenBox = (bs[0]?.id as string) ?? "";
    if (bs.length) {
      const bCell = shell.row(sec, "Box", { wide: true });
      bCell.innerHTML = `<select class="sl-crop-box">${
        bs.map((b) => `<option value="${b.id}"${b.id === chosenBox ? " selected" : ""}>${escapeHtml((b.name as string) ?? b.id)}</option>`).join("")
      }</select>`;
    }
    const box = roi();
    const img = live.nodes.get(chosen);
    if (box && img) {
      // What the crop WOULD do, before doing it -- the numbers are what make the box adjustable
      // with intent rather than by eye.
      const ijk = img.ijkToRAS as number[];
      const r = voxelRangeFor(img.dims as [number, number, number], ijk, box);
      const d = img.dims as number[];
      const shown = r
        ? `${d.join("×")} → ${[r.hi[0] - r.lo[0] + 1, r.hi[1] - r.lo[1] + 1, r.hi[2] - r.lo[2] + 1].join("×")}`
        : "the box does not overlap this volume";
      // WIDE, and the caller fills the cell. The narrow value column is sized for a word or a
      // number; "274x384x384 -> 274x336x378" and "191 x 223 x 251 mm" wrapped one word per line and
      // clipped. Ron: "the text formatting is weird." `wide` hands back an empty cell spanning the
      // row, which is what these need -- the earlier mistake was passing `value` AS WELL, which is
      // silently ignored.
      // WHAT IT WILL BE CALLED, beside how big it will be. Ron: "The module gives the size of the
      // crop, but not the name of the file." A panel that reports a size and no name leaves the
      // reader to find the result by elimination in the Scene list.
      const nameCell = shell.row(sec, "New volume", { wide: true });
      nameCell.textContent = croppedName(img);
      const resCell = shell.row(sec, "Result", { wide: true });
      resCell.textContent = shown;
      const extCell = shell.row(sec, "Extent", { wide: true });
      extCell.textContent = box.size.map((x) => `${Math.round(x)}`).join(" × ") + " mm";

      // A CROP THAT LEAVES THE LARGEST AXIS ALONE BUYS NOTHING from a segmentation network, which
      // sizes its working grid from the largest field of view in any direction. Ron's first crop
      // took the neck off and left the 256 mm axis untouched, so it was 31% smaller and still
      // conformed to 384^3. Said as a sentence, and only when it is true -- the "Not cropped: I —
      // still the full extent" row was cryptic, wrapped one word per line, and appeared even when it
      // did not matter. The before/after numbers above already show which axes moved.
      if (r) {
        const sp = (k: number) => Math.hypot(ijk[k], ijk[4 + k], ijk[8 + k]);
        const fov = [0, 1, 2].map((k) => d[k] * sp(k));
        const widest = fov.indexOf(Math.max(...fov));
        if ((r.hi[widest] - r.lo[widest] + 1) >= d[widest]) {
          const w = document.createElement("p");
          w.className = "sl-hint";
          w.textContent =
            `The widest axis (${Math.round(fov[widest])} mm) is not being cropped. A segmentation ` +
            `network sizes its grid from the widest direction, so this crop will not make one fit ` +
            `that did not fit before.`;
          sec.appendChild(w);
        }
      }
    }

    // ── WHERE THE NEW VOLUME LIVES, and how to make that permanent ────────────────────────────────
    //
    // Ron: "When cropping is done, how do I know as a naive user that the cropped volume lives in
    // the scene only and I have to save it to the dicom db if I want it to be more permanent? That
    // should be an option offered."
    //
    // Nothing said so. A crop appeared in the scene looking exactly like the volumes that came out
    // of the database, and the only difference -- that this one disappears on the next reload, and
    // takes any segmentation made on it with it -- was invisible until it happened. So the panel
    // says it in a sentence, and puts the button that fixes it right there. Not a hint at the
    // bottom: the state and the remedy in the same place, while the crop is the thing being
    // looked at.
    const fresh = lastCrop ? live.nodes.get(lastCrop) : undefined;
    if (fresh) {
      const savedUid = (fresh.origin as { savedSeriesInstanceUID?: string } | undefined)?.savedSeriesInstanceUID;
      const anc = hooks().__dicomAncestorOf?.(lastCrop) ?? null;
      const whereRow = shell.row(sec, "Where it lives", { wide: true });
      // PLAIN WORDS, both states. "A DICOM SEG has to reference a series that exists" is true and is
      // not something a first-time user can act on; what they need to know is that the work they are
      // about to do on this volume cannot be kept either.
      whereRow.textContent = savedUid
        ? `${fresh.name} is in the DICOM database now, under the volume it came from. It survives a ` +
          `restart, and anything you segment on it can be saved too.`
        : `${fresh.name} is in the scene only: it disappears when the application restarts, and so ` +
          `does anything you segment on it — a saved segmentation has to point at a volume that is ` +
          `in the database.`;
      if (!savedUid && anc) {
        const saveRow = shell.row(sec, "", { wide: true });
        saveRow.innerHTML = `<button class="sl-primary sl-crop-save"${busy ? " disabled" : ""}
          title="Writes it as a DICOM series in the current database, indexed under ${escapeHtml(anc.name)}">Put it in the DICOM database</button>`;
        const cropSave = saveRow.querySelector(".sl-crop-save") as HTMLButtonElement | null;
        cropSave?.addEventListener("click", () => void runAction(cropSave, async () => {
          note = "writing the DICOM series…";
          try {
            const r = await hooks().__exportVolumeAsDicom?.(lastCrop) as { note?: string; indexed?: boolean } | undefined;
            // "Saved" means findable in the database; a missing route or a write that never got
            // indexed is not a save (critic 2026-09-22, 1.5 and 1.6).
            if (!r) { note = "no DICOM route here"; throw new Error(note); }
            note = `${fresh.name} → the DICOM database. ${r.note ?? ""}`;
            if (r.indexed === false || /NOT indexed|NOT saved|browser's downloads/i.test(r.note ?? "")) throw new Error(r.note ?? "not indexed");
          } catch (e) {
            note = `could not save it: ${(e as Error).message}`;
            throw e;                         // the button says "Not saved" rather than falling silent
          } finally {
            setTimeout(render, 1200);        // after the button has said how it went
          }
        }, { busyLabel: "Saving…", doneLabel: "Saved ✓", failedLabel: "Not saved" }).catch(() => {}));
      } else if (!savedUid) {
        const p = document.createElement("p");
        p.className = "sl-hint";
        p.textContent =
          `This one cannot go into the DICOM database: it does not descend from a series that is ` +
          `already there, so there is no patient or study to attach it to. Save it as a NRRD from ` +
          `the Save panel instead.`;
        sec.appendChild(p);
      }
    }

    // ── WHAT YOU CAN SEE, from here ───────────────────────────────────────────────────────────────
    //
    // Ron: "How do I turn on/off the volume rendering, when I am in the slice view? Right now it is
    // three clicks spread across the entire window." Cropping is an ACT OF LOOKING: the box is
    // placed by eye against the slices and against the rendering, and the two controls that decide
    // what is on screen lived in two other modules and a per-view menu. They are the crop tool's
    // controls while the crop tool is open, so they are here -- the same nodes, written the same
    // way, so a switch here and the one in Volume rendering always agree.
    const eye = (label: string, on: boolean, title: string, cls: string, click: () => void) => {
      const row = shell.row(sec, label, { wide: true });
      row.innerHTML = `<button class="sl-anat-eye ${cls}${on ? "" : " sl-anat-off"}" type="button"
        title="${title}">${on ? "👁" : "🚫"}</button>`;
      row.querySelector(`.${cls}`)?.addEventListener("click", () => { click(); render(); });
    };
    // An explicit switch as well as the automatic hide: a first-time user asking "how do I turn this
    // off" should find the answer in the module that turned it on.
    if (chosenBox) {
      const shown = live.nodes.get(chosenBox)?.visible !== false;
      eye("Show the box", shown, shown ? "Hide the crop box" : "Show the crop box", "sl-crop-eye", () =>
        live.write({ op: "patch", id: chosenBox, path: "#/visible", value: !shown }));
    }
    if (hooks().__setSliceIn3D) {
      const cells = sliceCells(), on = slicesIn3D().length > 0;
      eye("Slices in the 3D view", on,
        on ? "Take the slice planes out of the 3D view" : "Show the slice planes in the 3D view",
        "sl-crop-3d", () => setSlicesIn3D(!on));
      if (on && slicesIn3D().length < cells.length) {
        const p = document.createElement("p");
        p.className = "sl-hint";
        p.textContent = `Showing ${slicesIn3D().join(", ")} in 3D. Press again to show all three, ` +
          `or again to take them out.`;
        sec.appendChild(p);
      }
    }
    if (img) {
      const vr = volumeRenderingOn(live, chosen);
      eye("Volume rendering", vr, vr ? "Turn the volume rendering off" : "Turn the volume rendering on",
        "sl-crop-vr", () => setVolumeRenderingOn(live, chosen, !vr));
    }

    const acts = shell.actions(sec);
    acts.innerHTML =
      `<button class="sl-crop-red"${busy || !chosen ? " disabled" : ""}>Cut at the red slice</button>` +
      `<button class="sl-crop-fit"${busy || !chosen ? " disabled" : ""}>Fit a box to the tissue</button>` +
      `<button class="sl-primary sl-crop-go"${busy || !chosen || !box ? " disabled" : ""}>Crop to the box</button>`;

    if (note) {
      const p = document.createElement("p");
      p.className = "sl-hint";
      p.textContent = note;
      sec.appendChild(p);
    }
    const g = document.createElement("p");
    g.className = "sl-hint";
    g.innerHTML = `The crop takes a sub-box of the existing voxel grid — nothing is resampled, so the
      voxels that come out are the voxels that went in and the result stays exactly aligned with the
      original. It therefore keeps a little more than the box asks for: an oblique volume's grid is
      tilted relative to a box in patient space, and the smallest whole-voxel region that holds the
      box is slightly larger than the box. It errs by keeping too much, never by cutting.`;
    sec.appendChild(g);

    const q = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T | null;
    q<HTMLSelectElement>(".sl-crop-vol")?.addEventListener("change", (e) => {
      chosen = (e.target as HTMLSelectElement).value;
      render();
    });
    q<HTMLSelectElement>(".sl-crop-box")?.addEventListener("change", (e) => {
      chosenBox = (e.target as HTMLSelectElement).value;
      render();
    });
    const run = (b: HTMLButtonElement | null, fn: () => Promise<void>) =>
      b?.addEventListener("click", () => void runAction(b, async () => {
        busy = true;
        try { await fn(); } catch (e) { note = `failed: ${(e as Error).message}`; throw e; }
        finally { busy = false; setTimeout(render, 900); }
      }, { busyLabel: "Working…", doneLabel: "Done ✓", failedLabel: "Failed" }).catch(() => {}));
    q<HTMLButtonElement>(".sl-crop-red")?.addEventListener("click", () => cutAtRedSlice());
    run(q<HTMLButtonElement>(".sl-crop-fit"), fitBox);
    run(q<HTMLButtonElement>(".sl-crop-go"), doCrop);
  };

  shell.registerPanel({
    id: "crop",
    title: "Crop Volume",
    tip: "Cut a volume down to a box, with handles in the views",
    groups: ["Geometry"],
    help: `<p>Takes a smaller box out of a volume. Drag its <b>handles</b> in any view — a face to move
      that face, a corner to resize the two sides you can see, the green one in the middle to move the
      whole box — or use the two buttons below. On a slice the box shows as an outline where the slice
      cuts it, with the handles that lie near that slice; a corner drag there leaves the
      through-plane side alone, since the cursor cannot aim it.</p>
      <p>The box hides itself once you crop, because its job is done. Fit or cut again to bring it
      back, or use the switch above.</p>
      <p>Usually both, in this order. <b>Fit a box to the tissue</b> puts a box around everything
      above the background, which on a head study means the head <i>and</i> the neck. Then
      <b>Cut at the red slice</b> trims that box to everything above the axial line: scroll the red
      view until the line sits where you want the cut, and press. The two compose, so all three axes
      come down — and that matters, because a crop that shrinks one axis and leaves the others at
      full extent buys nothing from anything that sizes itself from the field of view.</p>
      <p>Any ROI placed from the Markups panel appears in the list too, since it is the same box the
      volume rendering already crops with.</p>
      <p><b>Nothing is resampled.</b> The crop takes a sub-box of the existing voxel grid, so the
      voxels are unchanged and the result stays aligned with the original. That matters because a
      segmentation made on a cropped volume gets measured, and an interpolation on the way in would
      change those numbers quietly.</p>
      <p><b>Why it is worth doing.</b> A segmentation network sizes its working grid from the field of
      view, not from the anatomy. On a 0.67&nbsp;mm head study with the neck included, FastSurfer's
      grid comes to 384³ and its scores exceed what Apple's GPU can address, so the run fails. With
      the neck cut it is about 306³, which is roughly half, and the run fits.</p>
      <p>The original stays in the scene; the crop arrives beside it as a new volume.</p>
      <p><b>The crop lives in the scene only</b> until you say otherwise, and the scene is empty
      again after a restart — so <b>Put it in the DICOM database</b> is offered as soon as a crop
      exists. That writes it as a DICOM series of its own, indexed under the series it came from,
      carrying the same patient, study and acknowledgement: it is the original's data, cropped, and
      it should say so. It matters beyond convenience — a segmentation is saved as a DICOM SEG, and a
      SEG has to reference instances that exist, so a segmentation of a scene-only crop cannot be
      saved at all.</p>
      <p>A volume that does not descend from anything in the database cannot go in: there would be
      no patient or study to attach it to. Save that one as a NRRD from the Save panel.</p>`,
    mount(el) {
      root = el;
      render();
      live.subscribe?.((c) => {
        if (c.type === "image" || c.type === "markup" || c.kind === "remove" || c.kind === "reset") render();
      });
    },
    /**
     * ARRIVING HERE TURNS THE SLICES ON IN 3D, once.
     *
     * Ron: "When I go to the crop module, there should be an automatic way to turn on slice view in
     * the 3D viewer." A crop box is placed by looking at where it cuts, and in an empty 3D view
     * there is nothing to judge it against -- the planes are what make the box's position mean
     * something. So the module puts them there when it opens.
     *
     * ONCE, and only if none are on: a user who deliberately took them out should not have to do it
     * again every time they come back to the panel. Turning something on for someone is a courtesy
     * the first time and a fight the third.
     */
    onShow() {
      if (!autoSlices && slicesIn3D().length === 0 && sliceCells().length) { autoSlices = true; setSlicesIn3D(true); }
      render();
    },
  });
}
