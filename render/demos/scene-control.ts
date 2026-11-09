// ONE SCENE CONTROL, placed wherever it saves travel: the top bar, the Scenes module, Load / Save.
//
// Ron, 2026-09-24/25 (Contents/docs/mockups/scene-control-2026-09-25.html): "Same button should do the same thing
// wherever they are located"; "the bar has very limited space. I would just have scene with the triangle there and
// everything else in the pop up"; the button turns into the colored button when there is something to save, never an
// orange marker ("unbalanced compared with the yellow and brown scheme"); the scene list gets a search and a scroll
// "from day one"; the first save "propose[s] a name and enable[s] direct editing of the name by just clicking on the
// name"; deleting is "only in the window" (All scenes…); keys "adhere to Slicer as much as possible … consider
// multiplatform": Save Ctrl+S, Close Scene Ctrl+W, Add Data Ctrl+O -- ⌘ on a Mac.
//
// Built once. Every placement is an instance of the same button and the same menu; they repaint together. The work
// is done by the application's own functions (slicer-app.ts: __saveScene, __openScene, __closeScene), which this does
// not duplicate.
import { runAction, type AppShell } from "./app-shell.ts";
import { writeScene } from "../../logic/scene/write.ts";
import { collectExtensionState } from "../../logic/scene/extensions.ts";
import { dbInUse } from "../../logic/db-in-use.ts";
import type { LiveScene } from "../livescene.ts";
import { openSaveSheet } from "./save-sheet.ts";

type Cur = { uid: string; v: number; name: string; shown?: number } | null;
type SaveResult = { uid?: string; v?: number; refused?: string[]; error?: string };
type G = {
  __saveScene?: (o?: { name?: string; asNew?: boolean; buttonSays?: boolean; description?: string; picture?: Blob | null; slices?: boolean }) => Promise<SaveResult>;
  /** The picture a save keeps (live-views.ts): the 3D view, or with `slices` the whole layout. */
  __scenePicture?: (o?: { slices?: boolean }) => Promise<Blob | null>;
  __currentScene?: () => Cur;
  /** The database the scans on screen came from, or "mixed" (slicer-app.ts). */
  __dataDb?: () => string | null;
  __setCurrentScene?: (c: Cur) => void;
  __openScene?: (uid: string, o?: { version?: number; draft?: boolean; newest?: number }) => Promise<{ ok: boolean; error?: string }>;
  __closeScene?: () => Promise<boolean>;
  __showScenesWindow?: () => Promise<void> | void;
  __proposedSceneName?: () => string;
  __layoutId?: number;
};
const g = globalThis as unknown as G;
type Row = { uid: string; name: string; v: number; series?: number; producedAt?: string; study?: string };

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** A key as this platform writes it: ⌘S on a Mac, Ctrl+S elsewhere (Slicer's own bindings, written as Ctrl). */
export const keyLabel = (k: string, shift = false) => IS_MAC ? `${shift ? "⇧" : ""}⌘${k}` : `Ctrl+${shift ? "Shift+" : ""}${k}`;

let live: LiveScene | null = null;
let shellRef: AppShell | null = null;
const repaints = new Set<() => void>();
const repaintAll = () => { for (const r of [...repaints]) r(); };

// ── "changed since the last save" ──
// The scene as it would be written, compared with the scene as it was when it was saved or opened. What a scene holds
// is exactly what writeScene writes, so a change that would not reach the file does not count, and one that would,
// does (a camera move included: the file keeps the camera).
let dirty = false;
let baseline: string | null = null;
let settleUntil = 0;
let timer: number | undefined;
const loaded = () => !!live && [...live.nodes.values()].some((n) => ["image", "segmentation", "sequence", "markup", "model", "transform"].includes(n.type as string));
async function signature(): Promise<string> {
  if (!live) return "";
  // The extensions' own state counts too: tracts ticked in Diffusion are a change the next save would write.
  const w = await writeScene(live.nodes.values(), { producer: "", origin: "", name: "", previousV: 0, now: () => "", layout: { arrangement: g.__layoutId ?? 0 }, extensions: collectExtensionState() });
  const { name: _n, v: _v, source: _s, ...rest } = w.doc as Record<string, unknown>;
  return JSON.stringify(rest);
}
// ── markups as saved ──
// Markups and name cards live only in a saved scene (nothing else keeps them), so each one is remembered as it was when
// the scene was saved or opened; one not in a saved scene, or changed since, is unsaved work and closing asks first
// (critic 2026-10-02, finding 4: four cards with typed titles went with Close scene without a question). The crop box is
// left out: it is a tool's setting, made again in a click.
// A card list is remembered card by card, so the question names what would be lost: "1 name card", not the whole list
// (critic round 2, finding 7).
let savedMarkups = new Map<string, string>();
const markupPrint = (n: Record<string, unknown>) => JSON.stringify([n.name ?? null, n.controlPoints ?? null]);
const holdsWork = (n: Record<string, unknown>) => n.type === "markup" && n.markupType !== "roi" && ((n.controlPoints as unknown[] | undefined) ?? []).length > 0;
const prints = (n: Record<string, unknown>): [string, string][] => n.drawAs === "cards"
  ? ((n.controlPoints as Record<string, unknown>[] | undefined) ?? []).map((c) => [`${n.id}#${c.id}`, JSON.stringify(c)])
  : [[n.id as string, markupPrint(n)]];
/** The markups (and name cards) not in a saved scene or changed since, named for the person to decide. */
export function unsavedMarkups(): string[] {
  if (!live) return [];
  const out: string[] = [];
  for (const n of live.nodes.values()) {
    if (!holdsWork(n)) continue;
    const changed = prints(n).filter(([k, v]) => savedMarkups.get(k) !== v).length;
    if (!changed) continue;
    const k = ((n.controlPoints as unknown[] | undefined) ?? []).length;
    out.push(n.drawAs === "cards" ? `${changed} name card${changed === 1 ? "" : "s"}` : `${String(n.name ?? "markup")} (${k} point${k === 1 ? "" : "s"})`);
  }
  return out;
}
const rememberMarkups = () => { savedMarkups = new Map([...(live?.nodes.values() ?? [])].filter(holdsWork).flatMap(prints)); };
async function check(): Promise<void> {
  const cur = g.__currentScene?.();
  if (!cur || !loaded()) { if (dirty) { dirty = false; repaintAll(); } baseline = null; if (!cur) savedMarkups.clear(); return; }
  const s = await signature();
  // A scene that has just been saved or opened keeps settling for a moment (its segmentations arrive, its views are
  // put back): whatever it looks like then is what "saved" means.
  if (baseline === null || performance.now() < settleUntil) { baseline = s; rememberMarkups(); if (dirty) { dirty = false; repaintAll(); } return; }
  const d = s !== baseline;
  if (d !== dirty) { dirty = d; repaintAll(); }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void check(), 700) as unknown as number; };
/** After a save or an open: what is on screen now is the saved scene. */
export function markSceneClean(settleMs = 2500): void { baseline = null; settleUntil = performance.now() + settleMs; dirty = false; forcedDirty = false; repaintAll(); schedule(); }
export const sceneDirty = () => dirty || forcedDirty;
/** A change no comparison can see yet (a draft continued inside the settle window): Save is offered until the next clean
 *  (critic 2026-11-08, step 1, nit 5). */
let forcedDirty = false;
export function markSceneChanged(): void { forcedDirty = true; repaintAll(); }

// ── the store ──
async function currentDbOf(): Promise<{ id: string; name: string; nameOf: (id: string) => string } | null> {
  const reg = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { databases?: { id: string; current?: boolean; exists?: boolean; description?: { name?: string } }[] } | null;
  const cur = dbInUse(reg?.databases);
  const nameOf = (id: string) => { const d = (reg?.databases ?? []).find((x) => x.id === id); return d?.description?.name ?? id; };
  return cur ? { id: cur.id, name: cur.description?.name ?? cur.id, nameOf } : null;
}
async function currentDb(): Promise<string | null> { return (await currentDbOf())?.id ?? null; }
async function listScenes(): Promise<Row[]> {
  const id = await currentDb(); if (!id) return [];
  const j = await fetch(`/_db/${encodeURIComponent(id)}/_scenes`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { scenes?: Row[] } | null;
  return (j?.scenes ?? []).slice().sort((a, b) => (b.producedAt ?? "").localeCompare(a.producedAt ?? ""));   // newest first
}
/** Rename the open scene in the store; the name is edited where it is shown. */
export async function renameCurrentScene(name: string): Promise<boolean> {
  const cur = g.__currentScene?.(); const id = await currentDb();
  const nm = name.trim();
  if (!cur || !id || !nm || nm === cur.name) return false;
  const r = await fetch(`/_db/${encodeURIComponent(id)}/_scene/${encodeURIComponent(cur.uid)}/_name`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nm }) })
    .then(async (x) => ({ ok: x.ok, j: await x.json().catch(() => ({})) as { error?: string } })).catch((e) => ({ ok: false, j: { error: (e as Error).message } }));
  if (!r.ok) { shellRef?.notify({ title: "The scene was not renamed", body: esc(r.j.error ?? "") }); return false; }
  g.__setCurrentScene?.({ ...cur, name: nm });
  shellRef?.setStatus(`Scene renamed: "${nm}"`);
  repaintAll();
  return true;
}

// ── the actions, the same from every placement and from the keyboard ──
// THE SAVE SHEET (save-sheet.ts) on a scene's first save, on Save as…, and on Save with a description…; a plain Save keeps the
// last version's name and description and takes a new picture (Contents/docs/SCENE-SAVING-2026-11-08.md, "By hand: Save").
let lastSlices = false;
async function doSave(btn: HTMLButtonElement | null, o: { name?: string; asNew?: boolean; sheet?: boolean } = {}): Promise<void> {
  const cur = g.__currentScene?.();
  let extra: { description?: string; picture?: Blob | null; slices?: boolean } = {};
  if ((!cur || o.asNew || o.sheet) && loaded()) {
    const home = g.__dataDb?.();
    const db = await currentDbOf();
    const dbName = home && home !== "mixed" && db ? db.nameOf(home) : db?.name ?? "the database";
    let description = "";
    if (cur && !o.asNew && home && home !== "mixed") {
      const doc = await fetch(`/_db/${encodeURIComponent(home)}/_scene/${encodeURIComponent(cur.uid)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as { description?: string } | null;
      description = doc?.description ?? "";
    }
    const a = await openSaveSheet({
      dbName, description, slices: lastSlices,
      name: o.name ?? (o.asNew && cur ? `${cur.name} — copy` : cur?.name ?? g.__proposedSceneName?.() ?? "Scene"),
      picture: async (slices) => await g.__scenePicture?.({ slices }) ?? null,
      root: (document.querySelector(".sl-app") as HTMLElement | null) ?? undefined,
    });
    if (!a) return;
    lastSlices = a.slices;
    o = { ...o, name: a.name };
    extra = { description: a.description, picture: a.picture, slices: a.slices };
  } else extra = { slices: lastSlices };
  const run = async () => {
    const r = await g.__saveScene?.({ ...o, ...extra, buttonSays: !!btn });
    if (!r || r.error || !r.uid) throw new Error(r?.error ?? "not saved");
    markSceneClean(800);
  };
  if (btn) await runAction(btn, run, { busyLabel: "Saving…", doneLabel: "Saved", failedLabel: "Not saved" }).catch(() => {});
  else await run().catch(() => {});
  repaintAll();
}
/** Opens a scene (or one of its versions, or its unsaved work); says whether it opened (critic 2026-11-08, step 2, finding 1: a
 *  version's Open went on after the person said Stop). */
async function doOpen(btn: HTMLButtonElement | null, uid: string, o: { version?: number; draft?: boolean; newest?: number } = {}): Promise<boolean> {
  let opened = false;
  const run = async () => {
    const r = await g.__openScene?.(uid, o);
    if (!r?.ok) { if (r?.error && r.error !== "stopped") shellRef?.notify({ title: "The scene did not open", body: esc(r.error) }); throw new Error(r?.error ?? "not opened"); }
    if (!o.version && !o.draft) markSceneClean();   // an older version or the unsaved work is a change against the newest
    opened = true;
  };
  if (btn) await runAction(btn, run, { busyLabel: "Opening…", doneLabel: "Opened", failedLabel: "Not opened" }).catch(() => {});
  else await run().catch(() => {});
  repaintAll();
  return opened;
}
async function doClose(): Promise<void> {
  // ONE QUESTION (critic round 2, finding 7): __closeScene asks, naming what is not saved and whether the scene has changed.
  const closed = await g.__closeScene?.();
  if (closed) { dirty = false; baseline = null; }
  repaintAll();
}
async function showAll(): Promise<void> { await g.__showScenesWindow?.(); }
/** For Load / Save (2026-11-07): its own Save button and scene list do what this menu does, with the same feedback. */
export const saveSceneFrom = (btn: HTMLButtonElement) => doSave(btn);
export const openSceneFrom = (btn: HTMLButtonElement | null, uid: string, o: { version?: number; draft?: boolean; newest?: number } = {}) => doOpen(btn, uid, o);
/** Called whenever the scene controls repaint (a save, an open, a change); the caller drops itself when it is gone. */
export function watchScenes(fn: () => void): void { repaints.add(fn); }

// ── one instance: the button and its menu ──
export interface SceneControlOptions {
  /** Never the colored button here, because the box already has its one yellow (Load / Save's Save all). */
  neverColored?: boolean;
  /** Where the menu opens: below the button (default) or above it. */
  up?: boolean;
}

export function sceneControl(opts: SceneControlOptions = {}): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "sl-scene-ctl";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sl-tool sl-scene-btn";
  btn.innerHTML = `Scene <span class="sl-caret">▾</span>`;   // the triangle 15 px (theme.css, .sl-caret)
  wrap.appendChild(btn);
  let pop: HTMLElement | null = null;
  let filter = "";
  let rows: Row[] = [];
  let naming: "rename" | "saveas" | null = null;
  // WHICH DATABASE THE LIST IS OF, BY NAME (Ron, 2026-11-07: "the current short cut to scenes does not tell me which db has
  // been selected"; mockups/load-save-tasks-2026-11-07.html, answer 2: in the menu, not on the top bar).
  let dbLabel = "";
  // And where the open scene is saved, which can be another database than the one in use (critic 2026-11-07, finding 7).
  let nameOfDb: (id: string) => string = (id) => id;

  const paintButton = () => {
    if (btn.dataset.slBusy === "1") return;                 // runAction owns the word while it runs
    const cur = g.__currentScene?.();
    const colored = sceneDirty() && !opts.neverColored;
    btn.classList.toggle("sl-primary", colored);
    btn.title = cur
      ? `Scene: “${cur.name}”${sceneDirty() ? " — changed since the last save" : ` — saved (save ${cur.v})`}`
      : loaded() ? "Not saved as a scene yet — open the menu to save it" : "Open a saved scene";
  };
  const close = () => { pop?.remove(); pop = null; naming = null; filter = ""; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", onKey, true); removeEventListener("resize", close); };
  const outside = (e: Event) => { if (pop && !wrap.contains(e.target as Node) && !pop.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && pop) { e.stopPropagation(); if (naming) { naming = null; paintMenu(); } else close(); } };

  const paintMenu = () => {
    if (!pop) return;
    const cur = g.__currentScene?.();
    const any = loaded();
    const q = filter.trim().toLowerCase();
    const shown = q ? rows.filter((r) => `${r.name} ${r.producedAt ?? ""}`.toLowerCase().includes(q)) : rows;
    const when = (iso?: string) => {
      if (!iso) return ""; const d = new Date(iso); if (isNaN(d.getTime())) return "";
      const today = new Date(); const same = d.toDateString() === today.toDateString();
      return same ? `today ${d.toTimeString().slice(0, 5)}` : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    };
    let head: string;
    if (naming === "saveas" && cur) {
      head = `<div class="sl-scene-sub">Save as a new scene; “${esc(cur.name)}” stays as it is</div><input class="sl-scene-name-in" value="${esc(cur.name)} — copy">`;
    } else if (cur) {
      head = naming === "rename"
        ? `<input class="sl-scene-name-in" value="${esc(cur.name)}">`
        : `<div class="sl-scene-name" title="Click to rename">${esc(cur.name)} <span class="sl-scene-pen">✎</span></div>`;
      const home = g.__dataDb?.();
      const where = home && home !== "mixed" ? ` in ${esc(nameOfDb(home))}` : "";
      head += `<div class="sl-scene-sub">${sceneDirty() ? `Changed since the last save${where ? ` (saved${where})` : ""}` : `Saved${where} — save ${cur.v}`}</div>`;
    } else if (any) {
      // The name is asked in the save sheet, with the description and the picture (not here as well).
      head = `<div class="sl-scene-name">${esc(g.__proposedSceneName?.() ?? "Scene")}</div><div class="sl-scene-sub">Not saved yet: Save asks for its name and a description</div>`;
    } else {
      head = `<div class="sl-scene-name sl-scene-none">Nothing loaded</div><div class="sl-scene-sub">Open a scene, or load data</div>`;
    }
    const saveLabel = naming === "saveas" ? "Save the new scene" : "Save";
    pop.innerHTML = `
      <div class="sl-scene-head">${head}</div>
      <button class="sl-scene-mi sl-scene-save" ${any ? "" : "disabled"}><span>${saveLabel}</span><span class="sl-scene-k">${naming === "saveas" ? "↩" : keyLabel("S")}</span></button>
      ${cur ? `<button class="sl-scene-mi sl-scene-savedesc"><span>Save with a description…</span><span class="sl-scene-k">name, description, picture</span></button>` : ""}
      ${cur ? `<button class="sl-scene-mi sl-scene-saveas"><span>Save as…</span><span class="sl-scene-k">a new scene; this one stays</span></button>` : ""}
      <div class="sl-scene-sep"></div>
      <div class="sl-scene-sec" title="The database the scenes are saved in; Another database… below chooses another">Scenes in ${dbLabel ? esc(dbLabel) : "this database"} · ${q ? `${shown.length} of ${rows.length}` : rows.length}</div>
      <input class="sl-scene-search" placeholder="Search scenes" value="${esc(filter)}">
      <div class="sl-scene-list">${shown.map((r) => `<button class="sl-scene-row${cur?.uid === r.uid ? " sl-scene-cur" : ""}" data-uid="${esc(r.uid)}" title="${esc(r.name)} — save ${r.v}${r.series ? `, ${r.series} series` : ""}"><span>${esc(r.name)}</span><small>${when(r.producedAt)}</small></button>`).join("") || `<div class="sl-scene-empty">${rows.length ? "No scene matches" : `No saved scenes in ${dbLabel ? esc(dbLabel) : "this database"}`}</div>`}</div>
      <button class="sl-scene-mi sl-scene-all"><span>All scenes…</span><span class="sl-scene-k">delete, package</span></button>
      <button class="sl-scene-mi sl-scene-otherdb" title="Load / Save, with the list of databases open"><span>Another database…</span><span class="sl-scene-k">Load / Save</span></button>
      <div class="sl-scene-sep"></div>
      <button class="sl-scene-mi sl-scene-close" ${any ? "" : "disabled"}><span>Close scene</span><span class="sl-scene-k">${keyLabel("W")}</span></button>`;
    const nameIn = pop.querySelector<HTMLInputElement>(".sl-scene-name-in");
    pop.querySelector(".sl-scene-name")?.addEventListener("click", () => { if (cur) { naming = "rename"; paintMenu(); } });
    pop.querySelector(".sl-scene-save")?.addEventListener("click", () => {
      const nm = nameIn?.value.trim();
      const mode = naming;
      close();
      if (mode === "saveas") void doSave(btn, { name: nm || undefined, asNew: true });
      else if (mode === "rename" && nm) void renameCurrentScene(nm).then(() => doSave(btn));
      else void doSave(btn, cur ? {} : { name: nm || undefined });
    });
    // Save as… and Save with a description… open the save sheet (name, description, picture) rather than naming in the menu.
    pop.querySelector(".sl-scene-saveas")?.addEventListener("click", () => { close(); void doSave(btn, { asNew: true }); });
    pop.querySelector(".sl-scene-savedesc")?.addEventListener("click", () => { close(); void doSave(btn, { sheet: true }); });
    pop.querySelector(".sl-scene-all")?.addEventListener("click", () => { close(); void showAll(); });
    pop.querySelector(".sl-scene-otherdb")?.addEventListener("click", () => { close(); (globalThis as unknown as { __chooseDatabase?: () => void }).__chooseDatabase?.(); });
    pop.querySelector(".sl-scene-close")?.addEventListener("click", () => { close(); void doClose(); });
    for (const b of pop.querySelectorAll<HTMLButtonElement>(".sl-scene-row")) b.addEventListener("click", () => { const uid = b.dataset.uid!; close(); void doOpen(btn, uid); });
    const search = pop.querySelector<HTMLInputElement>(".sl-scene-search")!;
    search.addEventListener("input", () => { filter = search.value; const at = search.selectionStart; paintMenu(); const s2 = pop?.querySelector<HTMLInputElement>(".sl-scene-search"); s2?.focus(); if (at !== null) s2?.setSelectionRange(at, at); });
    if (nameIn) {
      nameIn.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const nm = nameIn.value.trim();
        const mode = naming;
        if (mode === "rename") { naming = null; void renameCurrentScene(nm).then(() => paintMenu()); return; }
        close();
        if (mode === "saveas") void doSave(btn, { name: nm || undefined, asNew: true });
        else void doSave(btn, { name: nm || undefined });
      });
      nameIn.addEventListener("blur", () => { if (naming === "rename") { const nm = nameIn.value.trim(); naming = null; void renameCurrentScene(nm).then(() => paintMenu()); } });
      if (naming) { nameIn.focus(); nameIn.select(); }
    } else if (!naming) search.focus();
  };

  btn.addEventListener("click", () => {
    if (pop) { close(); return; }
    // ABOVE EVERYTHING, anchored to the button: inside a module column the menu was cut off by the column's edge and
    // hidden under the 3D view (Ron's screenshot, 2026-09-25). It lives in the page's top layer, like a native menu.
    pop = document.createElement("div");
    pop.className = "sl-scene-pop";
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const W = 380;
    pop.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - W - 4))}px`;
    const below = window.innerHeight - r.bottom, above = r.top;
    if (opts.up || (below < 360 && above > below)) { pop.style.bottom = `${window.innerHeight - r.top + 4}px`; pop.style.maxHeight = `${above - 12}px`; }
    else { pop.style.top = `${r.bottom + 4}px`; pop.style.maxHeight = `${below - 12}px`; }
    addEventListener("resize", close);
    paintMenu();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    void Promise.all([listScenes(), currentDbOf()]).then(([l, db]) => { rows = l; dbLabel = db?.name ?? ""; if (db) nameOfDb = db.nameOf; paintMenu(); });   // read when it opens, so a scene saved a moment ago is in it
  });
  // An instance whose module panel was rebuilt is gone: it drops itself rather than keep painting a detached button.
  const repaint = () => {
    if (!wrap.isConnected) { if (wrap.dataset.mounted === "1") repaints.delete(repaint); return; }
    wrap.dataset.mounted = "1";
    paintButton(); if (pop && !naming) paintMenu();
  };
  repaints.add(repaint);
  paintButton();
  return wrap;
}

/** Once per window: watch the scene for changes, and the keys (Slicer's: Save, Close Scene, Add Data). */
export function initSceneControl(liveScene: LiveScene, shell: AppShell): void {
  if (live) return;
  live = liveScene; shellRef = shell;
  live.subscribe(() => schedule());
  document.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") { e.preventDefault(); void doSave(null); }
    else if (k === "w") { e.preventDefault(); void doClose(); }
    // ⌘O is Slicer's Add Data: files from disk. Load / Save with From disk… open (critic 2026-11-07, finding 13).
    else if (k === "o") { e.preventDefault(); const open = (globalThis as unknown as { __openLoadFromDisk?: () => void }).__openLoadFromDisk; if (open) open(); else void shell.showPanel("add-data"); }
  });
}
/** Called by the application when the current scene changes (slicer-app.ts sceneChanged). */
export function sceneIdentityChanged(): void { repaintAll(); schedule(); }

/** The shortcuts, in one small window (reached from Welcome; Ron: "space is at premium"). */
export const SHORTCUTS: { what: string; key: string; shift?: boolean; slicer: string }[] = [
  { what: "Save the scene", key: "S", slicer: "Save" },
  { what: "Close the scene", key: "W", slicer: "Close Scene" },
  { what: "Load data", key: "O", slicer: "Add Data" },
  // Albula's own: Slicer's Application Settings (Edit menu) has no key; ⌘, is the Mac's convention for settings.
  { what: "Settings", key: ",", slicer: "— (Edit › Application Settings, no key)" },
];
