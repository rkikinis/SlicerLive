// THE SCENES MODULE'S FACE: ONE ROW PER SCENE (Ron, 2026-11-08, on mockups/scenes-module-2026-11-08.html: "1 yes 2 all 3 both
// double click or return 4 C"; "I meant to say row, not line"). Every scene in the database in use, a row each: the screenshot
// taken when it was saved (step 3; until then the scene's name stands under the scan), the scan it is built on (its parent,
// the provenance: "typically the child represent the results that the user is interested in. The parent equivalent is more
// like the provenance"), its date and the patient's id, R Y G and 3D (live on the open scene; 3D Solid when it has a
// segmentation, else Volume). A click or the arrows choose a row; return or a double-click opens the scene; the space bar
// opens the look beside the panel (as Finder's Quick Look): the results first (for the open scene the list of what is
// loaded, with its view buttons, moved in), then the versions (Contents/docs/SCENE-SAVING-2026-11-08.md: open one, delete
// one by hand, the unsaved work continued or discarded), then what it was made from.
import { escapeHtml } from "./html.ts";
import { dbInUse } from "../../logic/db-in-use.ts";
import { seriesNamed } from "../../logic/scene/check.ts";
import { iconHtml } from "./icon-set.ts";
import { dbName, type RegisteredDb } from "./databases-window.ts";
import { local, plainResult, plainScan, scanWords, type SeriesRow, studyDate } from "./scene-words.ts";
export { plainResult, plainScan } from "./scene-words.ts";
import { markSceneChanged, openSceneFrom, saveSceneFrom, sceneDirty, watchScenes } from "./scene-control.ts";
import type { AppShell } from "./app-shell.ts";

type Obj = Record<string, unknown>;
interface SceneRowModel {
  uid: string; name: string; v: number; producedAt: string;
  scan?: SeriesRow; scans: number; imageId?: string; look3D?: string; results: string[]; picture?: string;
  /** The slice views the scene shows its scan in (its sliceComposite nodes), for a scene not open. */
  views?: string[];
  /** What is on screen and not a scene of this database: no saved scene yet, or one saved in another database. */
  unsaved?: boolean;
}
export interface ScenesFaceDeps {
  shell: AppShell;
  /** The list of what is loaded (the hierarchy), with its own head (link slice views): shown in the look of the open scene. */
  results: HTMLElement;
  /** R Y G and 3D on the open scene's row act through the same functions as the list's buttons. */
  viewOn(imageId: string, view: string): boolean;
  toggleView(imageId: string, view: string): void;
  look3D(imageId: string): string[];
  setLook3D(imageId: string, look: "off" | "volume" | "solid"): void;
  hasSegmentations(imageId: string): boolean;
  /** The open scene's image node for a series identifier, if loaded. */
  imageFor(seriesUID: string): string | undefined;
  renameCurrent(name: string): Promise<void>;
  /** Switches the database in use through Load / Save's own path, so both modules name the same one; returns a line to show. */
  chooseDatabase(id: string): Promise<string | undefined>;
  /** The volumes loaded now (not label maps): for the row of work not saved as a scene. */
  loadedImages(): { id: string; name: string; seriesUID?: string }[];
}

const VIEWS = [{ name: "Red", k: "R" }, { name: "Yellow", k: "Y" }, { name: "Green", k: "G" }];
const g = globalThis as unknown as {
  __currentScene?: () => { uid: string; v: number; name: string; shown?: number } | null;
  __setCurrentScene?: (s: { uid: string; v: number; name: string; shown?: number } | null) => void;
  __dataDb?: () => string | null;
  __loadSceneDoc?: (doc: Obj) => Promise<{ ok: boolean; error?: string }>;
};
export function mountScenesFace(el: HTMLElement, deps: ScenesFaceDeps): { refresh(): Promise<void> } {
  // THE DATABASE IS CHOSEN HERE TOO (Ron, 2026-11-08: "Where the name of the current data base is listed at the top of the
  // module, you could insert a pull down menu"): the same button and list as Load / Save's, the same switch behind it.
  el.innerHTML = `<div class="sl-scn-head"><button type="button" class="sl-dbpick sl-scn-dbpick" aria-haspopup="listbox" aria-expanded="false" title="The database these scenes are in: click to open another"><span class="sl-dbpick-name">…</span><span class="sl-dbpick-car">▾</span></button>
    <div class="sl-hint sl-scn-db"></div>
    <div class="sl-scn-save-row"><button type="button" class="sl-scn-save" title="Save what is on screen as a new version of the scene, with a picture of the 3D view">Save</button></div></div>
    <div class="sl-scn-rows" role="listbox" tabindex="0" aria-label="Scenes in this database"></div>
    <div class="sl-hint sl-scn-keys"><kbd>space</kbd> more · <kbd>↑</kbd> <kbd>↓</kbd> another scene · <kbd>return</kbd> open it</div>`;
  const rowsEl = el.querySelector(".sl-scn-rows") as HTMLElement, dbEl = el.querySelector(".sl-scn-db") as HTMLElement;
  const pickBtn = el.querySelector(".sl-scn-dbpick") as HTMLButtonElement, pickName = pickBtn.querySelector(".sl-dbpick-name") as HTMLElement;
  // The scene on screen saved in another database than the one listed (read on each refresh, so a switch anywhere and a close
  // keep it right; critic 2026-11-08, step 2, nit).
  const elsewhere = () => { const h = g.__dataDb?.(); return g.__currentScene?.() && h && h !== "mixed" && h !== dbId ? `the scene on screen is saved in ${databases.find((d) => d.id === h) ? dbName(databases.find((d) => d.id === h)!) : h}` : ""; };
  // SAVE, HERE TOO (Ron, 2026-11-08: "If I had a way to save, I could add a picture to the scene"): the same save as Scene ▾ and
  // Load / Save's, yellow while there are changes since the last version (the no-orange rule).
  const saveBtn = el.querySelector(".sl-scn-save") as HTMLButtonElement;
  saveBtn.addEventListener("click", () => void saveSceneFrom(saveBtn));
  const paintSave = () => { saveBtn.classList.toggle("sl-primary", sceneDirty()); };
  const look = document.createElement("div");
  // sl-panel: the list of what is loaded keeps its buttons' look when it moves in here (Ron, 2026-11-08: the 2D and 3D
  // buttons drawn as bare words, because their rules are written for a module panel and the look sits outside one).
  look.className = "sl-scn-look sl-panel"; look.hidden = true;
  document.body.appendChild(look);
  const resultsHome = deps.results.parentElement;   // where the list goes back when the look closes

  let dbId = "", rows: SceneRowModel[] = [], sel = 0, selUid: string | undefined;
  const seriesCache = new Map<string, Map<string, SeriesRow>>(), docCache = new Map<string, Obj>();
  let loadGen = 0;
  const pic = (id: string, uid: string, v: number, at?: string) => `/_db/${encodeURIComponent(id)}/_scene/${encodeURIComponent(uid)}/_picture/${v}?at=${encodeURIComponent(at ?? "")}`;
  const readSeries = async (id: string) => {
    const s = await fetch(`/_db/${encodeURIComponent(id)}/_series`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as unknown;
    if (!s) return;
    const arr = (Array.isArray(s) ? s : (s as { series?: unknown[] }).series ?? []) as Obj[];
    seriesCache.set(id, new Map(arr.map((x) => [String(x.uid), { uid: String(x.uid), modality: x.modality as string, description: (x.description ?? undefined) as string | undefined, bodyPart: (x.bodyPart ?? undefined) as string | undefined, studyDescription: x.studyDescription as string, studyDate: x.studyDate as string, patientID: x.patientID as string, n: x.n as string }])));
  };

  // ONE LOAD PUBLISHES: each keeps the database it started with, and only the newest one's rows are shown (critic 2026-11-08,
  // step 2, finding 5: a list still being read landed under the next database's name).
  async function load(): Promise<boolean> {
    const gen = ++loadGen;
    const reg = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { databases?: RegisteredDb[] } | null;
    if (gen !== loadGen) return false;
    const dbs = reg?.databases ?? [];
    const cur = dbInUse(dbs);
    const id = cur?.id ?? "";
    let out: SceneRowModel[] = [];
    if (cur) {
      const list = await fetch(`/_db/${encodeURIComponent(id)}/_scenes`, { cache: "no-store" }).then((r) => r.ok ? r.json() : { scenes: [] }).catch(() => ({ scenes: [] })) as { scenes: { uid: string; name: string; v: number; producedAt: string; picture?: boolean }[] };
      if (!seriesCache.has(id)) await readSeries(id);
      const docs = await Promise.all(list.scenes.map(async (sc) => {
        // Keyed by when the version was saved too: a version number reused after a delete is another version (finding 7).
        const key = `${id}|${sc.uid}|${sc.v}|${sc.producedAt}|${sc.name}`;
        let doc = docCache.get(key);
        if (!doc) {
          doc = await fetch(`/_db/${encodeURIComponent(id)}/_scene/${encodeURIComponent(sc.uid)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as Obj | undefined ?? undefined;
          if (doc) docCache.set(key, doc);   // a failed read is not kept (finding 10)
        }
        return { sc, doc: doc ?? {} };
      }));
      const firstScan = (doc: Obj) => {
        const nodes = (doc.nodes as Record<string, Obj> | undefined) ?? {};
        const images = Object.values(nodes).filter((n) => n.type === "image" && !n.labelmap && (n.dicom as Obj | undefined)?.seriesInstanceUID);
        return { nodes, images, first: images[0], uid: (images[0]?.dicom as Obj | undefined)?.seriesInstanceUID as string | undefined };
      };
      // A scan added since the series were read (imported, then saved as a scene): read them again once (finding 10).
      if (docs.some(({ doc }) => { const u = firstScan(doc).uid; return u && !seriesCache.get(id)?.has(u); })) await readSeries(id);
      const series = seriesCache.get(id) ?? new Map<string, SeriesRow>();
      out = docs.map(({ sc, doc }) => {
        const { nodes, images, first, uid } = firstScan(doc);
        const views = Object.values(nodes).filter((n) => n.type === "sliceComposite" && first && [...(((n.refs as Obj | undefined)?.background as string[] | undefined) ?? []), ...(((n.refs as Obj | undefined)?.foreground as string[] | undefined) ?? [])].includes(first.id as string)).map((n) => String(n.layoutName));
        return { uid: sc.uid, name: sc.name, v: sc.v, producedAt: sc.producedAt, scan: uid ? series.get(uid) ?? { uid } : undefined, scans: images.length, views,
          look3D: first?.look3D as string | undefined, picture: sc.picture ? pic(id, sc.uid, sc.v, sc.producedAt) : undefined,
          results: Object.values(nodes).filter((n) => n.type === "segmentation").map((n) => String(n.name ?? "")) };
      });
      out.sort((a, b) => (b.producedAt ?? "").localeCompare(a.producedAt ?? ""));
    }
    if (gen !== loadGen) return false;
    // WHAT IS ON SCREEN AND NOT A SCENE HERE (finding 2): a case not saved as a scene yet, or the open scene saved in another
    // database, gets the first row; its look holds the list of what is loaded, as the open scene's does.
    const open = g.__currentScene?.();
    const imgs = deps.loadedImages();
    if (imgs.length && !(open && out.some((r) => r.uid === open.uid))) {
      const series = seriesCache.get(id);
      const s0 = imgs[0].seriesUID ? series?.get(imgs[0].seriesUID) : undefined;
      out.unshift({ uid: "", name: open ? open.name : "Not saved yet", v: open?.v ?? 0, producedAt: "", unsaved: true, imageId: imgs[0].id,
        scan: s0 ?? { uid: imgs[0].seriesUID ?? "", modality: "", description: imgs[0].name }, scans: imgs.length, results: [] });
    }
    databases = dbs; dbId = id; rows = out;
    pickName.textContent = cur ? dbName(cur) : "No database yet";
    const away = elsewhere();
    dbEl.textContent = cur ? `${out.filter((r) => !r.unsaved).length} scene${out.filter((r) => !r.unsaved).length === 1 ? "" : "s"}${away ? ` · ${away}` : ""}` : "";
    // THE CHOSEN ROW STAYS CHOSEN (finding 3): by its scene, not its place; the open scene only when nothing was chosen yet.
    const at = rows.findIndex((r) => r.uid === selUid), atOpen = rows.findIndex((r) => (open ? r.uid === open.uid : false) || r.unsaved);
    sel = Math.max(0, Math.min(rows.length - 1, at >= 0 ? at : atOpen >= 0 ? atOpen : 0));
    selUid = rows[sel]?.uid;
    return true;
  }

  const isOpen = (r: SceneRowModel) => !!r.unsaved || (!!r.uid && g.__currentScene?.()?.uid === r.uid);
  const openImage = (r: SceneRowModel) => r.imageId ?? (r.scan ? deps.imageFor(r.scan.uid) : undefined);

  function drawRows(): void {
    rowsEl.innerHTML = rows.length ? rows.map((r, i) => {
      const open = isOpen(r), img = open ? openImage(r) : undefined;
      const date = studyDate(r.scan?.studyDate);
      const second = r.unsaved ? (g.__currentScene?.() ? "on screen, saved in another database" : "on screen, not saved as a scene yet")
        : [date, r.scans > 1 ? `${r.scans} series` : "", r.picture ? r.scan?.patientID ?? "" : `“${r.name}”`].filter(Boolean).join(" · ");
      const tip = r.unsaved ? `${r.name}\nWhat is loaded now. Save keeps it as a scene.` : `${r.name}\nSaved ${local(r.producedAt)} (version ${r.v})\n${r.scan ? scanWords(r.scan) : "no scan"}`;
      const views = VIEWS.map((v) => {
        // A scene not open: the views it shows its scan in, as the scene file records them (critic, nit: always drawn on).
        const on = img ? deps.viewOn(img, v.name) : (r.views ?? []).includes(v.name);
        return `<button class="sl-scn-tg${on ? " sl-on" : ""}" data-view="${v.name}"${img ? "" : " disabled"} title="${img ? (on ? `Showing in ${v.name}: click to clear` : `Show in ${v.name}`) : `When the scene is open: shown in ${v.name}`}">${v.k}</button>`;
      }).join("");
      const looks = img ? deps.look3D(img) : [r.look3D ?? (r.results.length ? "solid" : "volume")];
      const on3d = looks.some((l) => l !== "off");
      const want = img ? (deps.hasSegmentations(img) ? "Solid" : "Volume") : (r.results.length ? "Solid" : "Volume");
      return `<div class="sl-scn-row${i === sel ? " sl-sel" : ""}${open ? " sl-open" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}" title="${escapeHtml(tip)}">
        ${r.picture ? `<img class="sl-scn-pic" src="${escapeHtml(r.picture)}" alt="">` : `<span class="sl-scn-pic sl-scn-nopic">${r.unsaved ? "not saved" : "no picture yet"}</span>`}
        <span class="sl-scn-n"><b>${escapeHtml(plainScan(r.scan))}</b><small>${escapeHtml(second)}</small></span>
        ${views}<button class="sl-scn-tg${on3d ? " sl-on" : ""}" data-3d${img ? "" : " disabled"} title="${img ? `${on3d ? "Shown in 3D: click to take it out" : `Show in 3D as ${want}`}` : `When the scene is open: shown in 3D as ${want}`}">3D</button></div>`;
    }).join("") : `<p class="sl-hint">No scene saved in this database yet. Save, above, keeps what is on screen as a scene.</p>`;
    for (const row of rowsEl.querySelectorAll<HTMLElement>(".sl-scn-row")) {
      const i = Number(row.dataset.i);
      row.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest(".sl-scn-tg")) return; choose(i); rowsEl.focus(); });
      row.addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".sl-scn-tg")) return; void openRow(i); });
    }
    for (const b of rowsEl.querySelectorAll<HTMLButtonElement>(".sl-scn-tg:not([disabled])")) b.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = rows[Number((b.closest(".sl-scn-row") as HTMLElement).dataset.i)], img = openImage(r);
      if (!img) return;
      if (b.dataset.view) deps.toggleView(img, b.dataset.view);
      else {
        const on = deps.look3D(img).some((l) => l !== "off");
        deps.setLook3D(img, on ? "off" : deps.hasSegmentations(img) ? "solid" : "volume");
      }
      drawRows();
    });
    rowsEl.querySelector(".sl-scn-row.sl-sel")?.scrollIntoView({ block: "nearest" });
  }

  function choose(i: number): void {
    sel = i; selUid = rows[i]?.uid; drawRows();
    if (!look.hidden) void drawLook();
  }
  async function openRow(i: number): Promise<void> {
    const r = rows[i]; if (!r || r.unsaved) return;
    closeLook();
    if (!isOpen(r)) { selUid = r.uid; await openSceneFrom(null, r.uid); }
    await refresh();
  }

  function closeLook(): void {
    look.hidden = true;
    if (resultsHome && deps.results.parentElement !== resultsHome) resultsHome.appendChild(deps.results);
  }
  async function drawLook(): Promise<void> {
    const r = rows[sel]; if (!r || el.offsetParent === null) { closeLook(); return; }
    const open = isOpen(r);
    const [vs, dr] = r.unsaved ? [{ versions: [] }, { draft: null }] as [{ versions: { v: number; producedAt?: string; description?: string; name: string; picture?: boolean }[] }, { draft: { at: string; doc: Obj } | null }] : await Promise.all([
      fetch(`/_db/${encodeURIComponent(dbId)}/_scene/${encodeURIComponent(r.uid)}/_versions`, { cache: "no-store" }).then((x) => x.ok ? x.json() : { versions: [] }).catch(() => ({ versions: [] })) as Promise<{ versions: { v: number; producedAt?: string; description?: string; name: string; picture?: boolean }[] }>,
      fetch(`/_db/${encodeURIComponent(dbId)}/_scene/${encodeURIComponent(r.uid)}/_draft`, { cache: "no-store" }).then((x) => x.ok ? x.json() : { draft: null }).catch(() => ({ draft: null })) as Promise<{ draft: { at: string; doc: Obj } | null }>,
    ]);
    if (rows[sel] !== r) return;   // another row chosen, or the rows read again, meanwhile
    const cur = g.__currentScene?.();
    look.innerHTML = `<div class="sl-scn-look-top">${r.picture ? `<img class="sl-scn-look-pic" src="${escapeHtml(r.picture)}" alt="">` : `<span class="sl-scn-look-pic sl-scn-nopic">no picture yet: the next save takes one${open ? "" : " (open the scene, then Save)"}</span>`}
      <div><h3 class="sl-scn-look-name"${open && !r.unsaved ? ` title="Click to rename"` : ""}>${escapeHtml(r.name)}</h3><div class="sl-hint">${r.unsaved ? (cur ? `On screen; saved in another database (version ${r.v})` : "On screen, not saved as a scene yet: Save keeps it") : `Saved ${escapeHtml(local(r.producedAt))}, version ${r.v}${open ? " · open" : ""}`}</div></div></div>
      <div class="sl-scn-sub">Overview${open ? "" : ` (${r.results.length})`}</div><div class="sl-scn-results"></div>
      ${r.unsaved ? "" : `<div class="sl-scn-sub">Versions</div><div class="sl-scn-versions"></div>`}
      <div class="sl-scn-sub">Made from (the provenance)</div>
      <div class="sl-hint">${r.scan ? `<b>${escapeHtml(plainScan(r.scan))}${studyDate(r.scan.studyDate) ? ` · ${escapeHtml(studyDate(r.scan.studyDate))}` : ""}</b><br>${escapeHtml(scanWords(r.scan))}${r.scans > 1 ? `<br>${r.scans} series in all` : ""}` : "No scan"}</div>
      <div class="sl-hint sl-scn-look-keys"><kbd>space</kbd> or <kbd>esc</kbd> closes · <kbd>↑</kbd> <kbd>↓</kbd> another scene · <kbd>return</kbd> opens it</div>`;
    const res = look.querySelector(".sl-scn-results") as HTMLElement;
    if (open) res.appendChild(deps.results);
    else {
      if (resultsHome && deps.results.parentElement !== resultsHome) resultsHome.appendChild(deps.results);
      res.innerHTML = r.results.length ? r.results.map((n) => `<div class="sl-scn-res" title="${escapeHtml(n)}">${iconHtml("segmentation")}<span>${escapeHtml(plainResult(n))}</span></div>`).join("") : `<div class="sl-hint">Nothing made from the scan in this scene.</div>`;
    }
    if (open && !r.unsaved) {
      const h = look.querySelector(".sl-scn-look-name") as HTMLElement;
      h.addEventListener("click", () => {
        const input = document.createElement("input"); input.className = "sl-sh-rename"; input.value = r.name;
        let done = false;
        const finish = (keep: boolean) => { if (done) return; done = true; if (keep && input.value.trim() && input.value.trim() !== r.name) void deps.renameCurrent(input.value.trim()).then(refresh); else void drawLook(); };
        input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
        input.addEventListener("blur", () => finish(true));
        h.replaceWith(input); input.focus(); input.select();
      });
    }
    // THE VERSIONS, newest first; the unsaved work above them.
    const vEl = look.querySelector(".sl-scn-versions") as HTMLElement | null;
    const items: string[] = [];
    const onScreen = open ? (cur?.shown ?? cur?.v) : undefined;   // the version shown, not the save number (finding 4)
    if (dr.draft) items.push(`<div class="sl-scn-ver" data-draft><span class="sl-scn-ver-n"><b>Unsaved work</b> <small>${escapeHtml(local(dr.draft.at))}</small></span><button data-act="continue" title="Open the scene as it was when the work stopped">Open</button><button data-act="discard" title="Throw the unsaved work away (the saved versions stay)">Discard</button></div>`);
    for (const x of [...vs.versions].reverse()) items.push(`<div class="sl-scn-ver" data-v="${x.v}">${x.picture ? `<img class="sl-scn-ver-pic" src="${pic(dbId, r.uid, x.v, x.producedAt)}" alt="">` : `<span class="sl-scn-ver-pic"></span>`}<span class="sl-scn-ver-n" title="${escapeHtml(x.description ?? "")}"><b>Version ${x.v}</b> <small>${escapeHtml(local(x.producedAt))}${x.description ? ` · ${escapeHtml(x.description)}` : ""}${onScreen === x.v && !sceneDirty() ? " · on screen" : onScreen === x.v ? " · on screen, changed" : ""}</small></span><button data-act="open" title="Open this version; the newer ones stay, and a save after it adds a version on top">Open</button><button data-act="delete" class="sl-scn-del" title="Delete this version (asks first; to the Trash)"${vs.versions.length < 2 ? " disabled" : ""}>Delete…</button></div>`);
    if (vEl) {
      vEl.innerHTML = items.join("") || `<div class="sl-hint">No versions listed.</div>`;
      for (const b of vEl.querySelectorAll<HTMLButtonElement>("button")) b.addEventListener("click", () => void versionAction(r, b));
    }
    // Beside the panel, level with the chosen row, inside the window: measured once shown (hidden, it measures 0; finding 6).
    const row = rowsEl.querySelector<HTMLElement>(".sl-scn-row.sl-sel"), side = el.closest(".sl-sidebar") ?? el;
    look.style.visibility = "hidden"; look.hidden = false;
    const top = Math.max(8, Math.min((row?.getBoundingClientRect().top ?? 80) - 20, innerHeight - look.offsetHeight - 8));
    const left = Math.min(side.getBoundingClientRect().right + 8, innerWidth - look.offsetWidth - 8);
    look.style.left = `${Math.max(8, left)}px`; look.style.top = `${top}px`; look.style.visibility = "";
  }

  async function versionAction(r: SceneRowModel, b: HTMLButtonElement): Promise<void> {
    const act = b.dataset.act, v = Number((b.closest(".sl-scn-ver") as HTMLElement).dataset.v);
    const base = `/_db/${encodeURIComponent(dbId)}/_scene/${encodeURIComponent(r.uid)}`;
    if (act === "discard") {
      const ok = await deps.shell.confirm({ title: "Discard the unsaved work?", ok: "Discard", cancel: "Keep", destructive: true, body: `<p>The work on “${escapeHtml(r.name)}” after its last version goes. The saved versions stay.</p>` });
      if (!ok) return;
      await fetch(`${base}/_draft`, { method: "DELETE" }).catch(() => {});
      await drawLook(); return;
    }
    if (act === "delete") {
      const ok = await deps.shell.confirm({ title: `Delete version ${v} of “${escapeHtml(r.name)}”?`, ok: "Delete", cancel: "Keep", destructive: true, body: `<p>The version goes to the Trash. The other versions stay${v === r.v ? `, and the scene becomes the version before it` : ""}.</p>` });
      if (!ok) return;
      const res = await fetch(`${base}/_version/${v}`, { method: "DELETE" }).then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => ({})) as { error?: string; newest?: number } })).catch(() => ({ ok: false, j: { error: "the database could not be reached" } as { error?: string; newest?: number } }));
      if (!res.ok) { deps.shell.notify({ title: "The version was not deleted", body: escapeHtml(res.j.error ?? "") }); return; }
      // The open scene's next save follows the newest that is left; what is on screen is now a change against it.
      const cur = g.__currentScene?.();
      if (cur?.uid === r.uid && typeof res.j.newest === "number" && cur.v !== res.j.newest) { g.__setCurrentScene?.({ ...cur, v: res.j.newest, shown: cur.shown === v ? undefined : cur.shown }); if ((cur.shown ?? cur.v) === v) markSceneChanged(); }
      await refresh(); return;   // refresh draws the look again, on the same scene (finding 3)
    }
    // OPEN a version or the unsaved work, in one load (finding 13), with the button answering; the newest stays the save number
    // and the window remembers which version it shows (finding 4). If it did not open (the person said Stop, it failed), nothing
    // else happens (finding 1: the state went into the scene that was open).
    selUid = r.uid;
    await openSceneFrom(b, r.uid, act === "continue" ? { draft: true, newest: r.v } : v === r.v ? {} : { version: v, newest: r.v });
    await refresh();
  }

  rowsEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (rows.length) choose(Math.max(0, Math.min(rows.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)))); }
    else if (e.key === " ") { e.preventDefault(); if (look.hidden) void drawLook(); else closeLook(); }
    else if (e.key === "Enter") { e.preventDefault(); void openRow(sel); }
    else if (e.key === "Escape") closeLook();
  });
  look.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLook(); rowsEl.focus(); } });
  // The look closes when the panel does, or on a press elsewhere (not in the look, not on the rows).
  document.addEventListener("pointerdown", (e) => { if (!look.hidden && !look.contains(e.target as Node) && !rowsEl.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sl-notify, .sl-confirm, dialog")) closeLook(); }, true);

  // THE LOOK BELONGS TO THE MODULE: when the Scenes panel is not shown (another module chosen, a scene's own module put back
  // on opening), it closes.
  // Shown again, the rows are read again: a database switched elsewhere (Load / Save, Settings) is followed (Ron, 2026-11-08:
  // "just switching in the load save module does not switch the list in the scenes module").
  new IntersectionObserver((es) => { if (es.some((x) => !x.isIntersecting)) { closeLook(); closePop(); } else void refresh(); }).observe(el);

  // The list of databases, in the page's top layer under the button (as Load / Save's: a list inside the column is cut off).
  let databases: RegisteredDb[] = [], pop: HTMLElement | null = null;
  const closePop = () => {
    pop?.remove(); pop = null; pickBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey, true); removeEventListener("resize", closePop);
  };
  const outside = (e: Event) => { if (pop && !pop.contains(e.target as Node) && !pickBtn.contains(e.target as Node)) closePop(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pop) { e.stopPropagation(); closePop(); } };
  const openPop = () => {
    const p = pop = document.createElement("div");
    p.className = "sl-scene-pop sl-db-pop"; p.setAttribute("role", "listbox");
    const r = pickBtn.getBoundingClientRect();
    p.style.left = `${Math.max(4, r.left)}px`; p.style.width = `${Math.max(r.width, 300)}px`;
    p.style.top = `${r.bottom + 4}px`; p.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 12)}px`;
    const cur = dbInUse(databases);
    const row = (d: RegisteredDb) => {
      const why = !d.exists ? (d.remote?.why ?? "not reachable") : d.description?.patientData === false ? "public data" : d.description?.patientData ? "not public" : "";
      const on = d.id === cur?.id;
      return `<button type="button" role="option" aria-selected="${on}" class="sl-scene-row${on ? " sl-scene-cur" : ""}" data-id="${escapeHtml(d.id)}" ${d.exists ? "" : "disabled"} title="${escapeHtml(d.description?.holds ?? (d.remote ? `On ${d.remote.host}` : d.path ?? ""))}"><span>${escapeHtml(dbName(d))}</span><small>${escapeHtml(why)}</small></button>`;
    };
    const hosts = [...new Set(databases.filter((d) => d.remote).map((d) => d.remote!.host))];
    p.innerHTML = `<div class="sl-scene-sec">On this Mac</div>${databases.filter((d) => !d.remote).map(row).join("") || `<div class="sl-scene-empty">None yet</div>`}`
      + hosts.map((h) => `<div class="sl-scene-sep"></div><div class="sl-scene-sec">On ${escapeHtml(h)}</div>${databases.filter((d) => d.remote?.host === h).map(row).join("")}`).join("");
    document.body.appendChild(p);
    pickBtn.setAttribute("aria-expanded", "true");
    for (const b of p.querySelectorAll<HTMLButtonElement>(".sl-scene-row")) b.addEventListener("click", () => void (async () => {
      closePop();
      if (b.dataset.id === cur?.id) return;
      closeLook();
      await deps.chooseDatabase(b.dataset.id!);
      await refresh();
    })());
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", onKey, true); addEventListener("resize", closePop);
  };
  pickBtn.addEventListener("click", () => { if (pop) closePop(); else void loadDbs().then(openPop); });
  const loadDbs = async () => {
    const reg = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { databases?: RegisteredDb[] } | null;
    if (reg?.databases) databases = reg.databases;
  };
  async function refresh(): Promise<void> {
    if (!(await load())) return;   // a newer one is on its way
    drawRows();
    if (!look.hidden) await drawLook();
  }
  watchScenes(() => { paintSave(); void refresh(); });
  paintSave();
  return { refresh };
}
