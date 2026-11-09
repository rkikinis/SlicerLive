// THE SAVE SHEET (Ron, 2026-11-08, on mockups/scenes-module-2026-11-08.html, "At save: name, description and the screenshot";
// Contents/docs/SCENE-SAVING-2026-11-08.md in the workspace). It appears on a scene's first save and when asked ("Save with a
// description…"); a plain Save (⌘S, the button) saves at once with the name and description of the last version and a new
// picture. The picture shown is the one saved: the 3D view as it is now, or with "Add the slice views" the whole layout
// (Slicer's "Full layout", qMRMLScreenShotDialog).
import { escapeHtml } from "./html.ts";

export interface SaveSheetAnswer { name: string; description: string; slices: boolean; picture: Blob | null }

export interface SaveSheetOptions {
  /** The database the scene goes into, by its name. */
  dbName: string;
  name: string;
  description?: string;
  /** "Add the slice views" as last chosen. */
  slices?: boolean;
  /** Takes the picture (the 3D view, or the whole layout). */
  picture(slices: boolean): Promise<Blob | null>;
  /** Where the sheet goes (the shell's root); the page's body by default. */
  root?: HTMLElement;
}

export function openSaveSheet(o: SaveSheetOptions): Promise<SaveSheetAnswer | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "sl-modal-back";
    const box = document.createElement("div");
    box.className = "sl-modal sl-save-sheet";
    box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Save the scene");
    box.innerHTML = `<h3>Save the scene to ${escapeHtml(o.dbName)}</h3>
      <label class="sl-ss-l" for="sl-ss-name">Name</label>
      <input type="text" id="sl-ss-name" class="sl-modal-input sl-ss-name" value="${escapeHtml(o.name)}">
      <label class="sl-ss-l" for="sl-ss-desc">Description <span class="sl-hint">(a line or two: what this version shows)</span></label>
      <textarea id="sl-ss-desc" class="sl-ss-desc" rows="2">${escapeHtml(o.description ?? "")}</textarea>
      <label class="sl-ss-l">Picture</label>
      <div class="sl-ss-prev"><div class="sl-ss-pic"><span class="sl-hint">taking the picture…</span></div>
        <div><label class="sl-ss-check"><input type="checkbox" class="sl-ss-slices"${o.slices ? " checked" : ""}> Add the slice views</label>
        <div class="sl-hint">The 3D view as it is now; with the slice views, the whole layout.</div></div></div>
      <div class="sl-row sl-modal-actions"><button type="button" class="sl-ss-cancel">Cancel</button><button type="button" class="sl-primary sl-ss-save">Save</button></div>`;
    back.appendChild(box);
    (o.root ?? document.body).appendChild(back);
    const name = box.querySelector(".sl-ss-name") as HTMLInputElement, desc = box.querySelector(".sl-ss-desc") as HTMLTextAreaElement;
    const slices = box.querySelector(".sl-ss-slices") as HTMLInputElement, picEl = box.querySelector(".sl-ss-pic") as HTMLElement;
    const save = box.querySelector(".sl-ss-save") as HTMLButtonElement;
    let pic: Blob | null = null, url = "", taking = 0;
    const take = async () => {
      const n = ++taking;
      picEl.innerHTML = `<span class="sl-hint">taking the picture…</span>`;
      const b = await o.picture(slices.checked).catch(() => null);
      if (n !== taking || !back.isConnected) return;   // a newer one asked for meanwhile, or the sheet closed
      pic = b;
      if (url) URL.revokeObjectURL(url);
      url = b ? URL.createObjectURL(b) : "";
      picEl.innerHTML = b ? `<img src="${url}" alt="The picture saved with this version">` : `<span class="sl-hint">No picture: nothing is shown in the views.</span>`;
    };
    const done = (v: SaveSheetAnswer | null) => {
      back.remove(); document.removeEventListener("keydown", key, true);
      if (url && !v) URL.revokeObjectURL(url);
      resolve(v);
    };
    const answer = () => {
      const nm = name.value.trim();
      if (!nm) { name.focus(); name.classList.add("sl-ss-need"); return; }
      done({ name: nm, description: desc.value.trim(), slices: slices.checked, picture: pic });
    };
    // Escape cancels; Return in the name saves (in the description it is a new line; ⌘Return saves from anywhere).
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target === name)) { e.preventDefault(); e.stopPropagation(); answer(); }
    };
    document.addEventListener("keydown", key, true);
    slices.addEventListener("change", () => void take());
    name.addEventListener("input", () => name.classList.remove("sl-ss-need"));
    box.querySelector(".sl-ss-cancel")!.addEventListener("click", () => done(null));
    save.addEventListener("click", answer);
    back.addEventListener("mousedown", (e) => { if (e.target === back) done(null); });
    name.focus(); name.select();
    void take();
  });
}
