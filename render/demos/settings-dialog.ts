// SETTINGS. Ron, 2026-09-20: "In slicer it is not a module but a settings. These days the de facto
// standard is that settings are in a pull down or pop up triggered from a position under the
// about" -- so: the application menu's "Settings… ⌘," (desktop/macmenu.ts) opens this, a floating
// window in the shared chrome (floating-window.ts) with sections down the left, the way Slicer's
// Application Settings and the Mac's own System Settings are laid out. Mocked up first
// (Contents/docs/mockups/settings-2026-09-20.html) and approved: "Looks good."
//
// WHAT IS IN IT: only things that exist. General -- where the DICOM database is and where
// pictures go, and what happens at launch (the module I was in, the layout I had). Pictures --
// the defaults for "Picture · Save…" in the 3D view. 3D view -- the illustration switch and the shading
// a new window starts with. Sections appear when they have something to hold; an empty section
// would be a promise.
//
// CHANGES APPLY AT ONCE and go to settings.ini (logic/settings.ts, the one persistence store),
// the macOS way: no OK, no Cancel. "Reset this page" -- Ron chose the label -- sets the page's
// entries back to how the application shipped; the two locations (the database, the pictures
// folder) are not defaults a person would want back, so the reset leaves them alone and the
// tooltip says so. Every control has a one-sentence tooltip: the label is for the person who does
// not read, the tooltip for the one who hovers.
import { LATEST_PALETTE, PALETTES, setPaletteVersion } from "../../logic/anatomy/palettes.ts";
import { LATEST_SHADING, SHADINGS, setShadingVersion } from "../shading-versions.ts";
import type { SettingsStore } from "../../logic/settings.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { DEFAULT_LIGHT, LIGHT_PRESETS } from "../light-presets.ts";

export interface SettingsDeps {
  settings: SettingsStore;
  /** The registered DICOM databases and which is current. */
  databases: () => Promise<{ id: string; dir?: string; path?: string; current?: boolean; exists?: boolean }[]>;
  /** Make another registered database the current one. */
  switchDatabase: (id: string) => Promise<void>;
  /** The layouts a person can choose, for "Layout at launch". */
  layouts: () => { id: number; name: string }[];
  /** What the picture defaults are used by, so a change reaches the 3D panel at once. */
  onPictureDefaults?: (d: { only3d: boolean; panel: boolean; scale: number }) => void;
  notify?: (n: { title: string; body?: string }) => void;
}

/** The shipped defaults, in one place, so the dialog and the code that reads them cannot drift. */
export const SETTING_DEFAULTS = {
  Launch: { restoreModule: true, restoreLayout: true },
  Surfaces: { onGpu: false },
  Loading: { fromCopy: true },
  Pictures: { folder: "downloads", only3d: false, panel: false, scale: 1 },
  View3D: { drawing: true, lighting: LIGHT_PRESETS[DEFAULT_LIGHT].name, shading: LATEST_SHADING },
  Colors: { scheme: LATEST_PALETTE },
} as const;

export function pictureDefaults(s: SettingsStore): { only3d: boolean; panel: boolean; scale: number } {
  return {
    only3d: s.getBool("Pictures", "only3d", SETTING_DEFAULTS.Pictures.only3d),
    panel: s.getBool("Pictures", "panel", SETTING_DEFAULTS.Pictures.panel),
    scale: Math.max(1, Math.min(4, s.getNumber("Pictures", "scale", SETTING_DEFAULTS.Pictures.scale))),
  };
}

let openNow: (() => void) | null = null;

export function openSettingsDialog(deps: SettingsDeps): void {
  if (openNow) { openNow(); return; }                       // one at a time: a second ⌘, closes it
  const { settings: st } = deps;
  const { box, close: closeWin } = openFloatingWindow({ title: "Settings", size: { w: 780, h: 540 }, onClose: () => { openNow = null; } });
  openNow = () => closeWin();
  box.classList.add("sl-settings");

  const body = document.createElement("div"); body.className = "sl-settings-body";
  const nav = document.createElement("div"); nav.className = "sl-settings-nav";
  const page = document.createElement("div"); page.className = "sl-settings-page";
  const foot = document.createElement("div"); foot.className = "sl-settings-foot";
  body.append(nav, page); box.append(body, foot);

  const resetBtn = document.createElement("button"); resetBtn.textContent = "Reset this page";
  resetBtn.title = "Sets everything on this page back to how SlicerAlbula was shipped. The database and the pictures folder stay where they are.";
  const where = document.createElement("span"); where.className = "sl-settings-where";
  where.textContent = `Changes apply at once. Stored in ${st.location() === "localStorage" ? "this browser" : "settings.ini"}.`;
  where.title = st.location();
  foot.append(resetBtn, where);

  // ── building blocks: a heading, a row with a label, a toggle, a select, a value box ──
  const h2 = (t: string) => { const e = document.createElement("h2"); e.textContent = t; return e; };
  const row = (label: string, tip: string, ...controls: HTMLElement[]) => {
    const r = document.createElement("div"); r.className = "sl-settings-row";
    const l = document.createElement("label"); l.textContent = label; l.title = tip; r.appendChild(l);
    for (const c of controls) { if (!c.title) c.title = tip; r.appendChild(c); }
    return r;
  };
  const hint = (t: string) => { const e = document.createElement("div"); e.className = "sl-settings-hint"; e.textContent = t; return e; };
  const toggle = (get: () => boolean, set: (v: boolean) => void) => {
    const b = document.createElement("button"); b.className = "sl-settings-toggle"; b.setAttribute("role", "switch");
    const paint = () => { const on = get(); b.textContent = on ? "on" : "off"; b.setAttribute("aria-checked", String(on)); b.classList.toggle("on", on); };
    b.addEventListener("click", () => { set(!get()); paint(); });
    paint(); (b as HTMLElement & { repaint?: () => void }).repaint = paint; return b;
  };
  const select = (options: [string, string][], get: () => string, set: (v: string) => void) => {
    const s = document.createElement("select");
    for (const [v, t] of options) { const o = document.createElement("option"); o.value = v; o.textContent = t; s.appendChild(o); }
    const paint = () => { s.value = get(); }; paint();
    s.addEventListener("change", () => set(s.value));
    (s as HTMLElement & { repaint?: () => void }).repaint = paint; return s;
  };
  const value = (t: string, tip?: string) => { const e = document.createElement("span"); e.className = "sl-settings-value"; e.textContent = t; if (tip) e.title = tip; return e; };
  const shortHome = (p: string) => p.replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, "iCloud Drive").replace(/^\/Users\/[^/]+/, "~");

  // ── the pages ──
  type Page = { id: string; title: string; build: (into: HTMLElement) => void; reset: () => void };
  const pages: Page[] = [];

  pages.push({
    id: "general", title: "General",
    build(into) {
      into.appendChild(h2("Where things are"));
      // The database: which registered one is current, switchable among the registered ones.
      // Adding one that is not registered needs a folder chooser, which the native window does
      // not have (load-panel.ts says the same in its Change…); the registered list is what there is.
      const dbVal = value("…", "The folder holding ctkDICOM.sql. Everything loaded, computed or saved goes through it.");
      const dbSel = document.createElement("select"); dbSel.title = "Make another registered database the current one";
      const dbRow = row("DICOM database", "Everything loaded, computed or saved goes through it.", dbVal, dbSel);
      into.appendChild(dbRow);
      const dbHint = hint("Where the studies are. To add a database that is not listed: one line in settings.ini under [Database], a name = its folder (the one holding ctkDICOM.sql).");
      into.appendChild(dbHint);
      deps.databases().then((list) => {
        dbSel.replaceChildren();
        for (const d of list) { const o = document.createElement("option"); o.value = d.id; o.textContent = d.id + (d.exists === false ? " (missing)" : ""); dbSel.appendChild(o); }
        const cur = list.find((d) => d.current) ?? list[0];
        if (cur) { dbSel.value = cur.id; dbVal.textContent = shortHome(cur.dir ?? cur.path ?? cur.id); dbVal.title = cur.dir ?? cur.path ?? ""; }
        dbSel.style.display = list.length > 1 ? "" : "none";
      }).catch(() => { dbVal.textContent = "not served here"; dbSel.style.display = "none"; });
      dbSel.addEventListener("change", async () => {
        await deps.switchDatabase(dbSel.value);
        const list = await deps.databases(); const cur = list.find((d) => d.current);
        if (cur) { dbVal.textContent = shortHome(cur.dir ?? cur.path ?? cur.id); dbVal.title = cur.dir ?? cur.path ?? ""; }
        deps.notify?.({ title: `DICOM database: ${dbSel.value}`, body: "The browser lists this one now." });
      });

      const picVal = value("…");
      const picSel = select([["downloads", "Downloads"], ["desktop", "Desktop"], ["pictures", "Pictures"]],
        () => st.get("Pictures", "folder") ?? SETTING_DEFAULTS.Pictures.folder,
        (v) => { st.set("Pictures", "folder", v); void st.flush().then(refreshPicFolder); });
      const refreshPicFolder = () => fetch("/_picture", { cache: "no-store" }).then((r) => r.json()).then((j: { folder?: string }) => { picVal.textContent = shortHome(j.folder ?? "?"); picVal.title = j.folder ?? ""; }).catch(() => { picVal.textContent = "not served here"; });
      into.appendChild(row("Pictures", "Where “Picture · Save…” in the 3D view writes. Downloads is iCloud Drive's Downloads when there is one.", picVal, picSel));
      into.appendChild(hint("Where “Picture · Save…” in the 3D view writes."));
      void refreshPicFolder();

      // THE EXPERIMENT, WHERE RON CAN REACH IT. Measured 2026-09-23 on the whole-body checkpoints:
      // the whole extraction is 0.91 s on the card against 10.02 s on the processor, and the meshes
      // are identical -- same triangles, same vertices, surface areas within 0.0002%. Off until he
      // has run it on real studies in his own window; the old path is one switch away.
      into.appendChild(h2("Surfaces"));
      into.appendChild(row("Build surfaces on the graphics card", "Faster, and the same surfaces — measured at 0.9 seconds against 10 on a whole-body segmentation. New; the older way runs if this fails.",
        toggle(() => st.getBool("Surfaces", "onGpu", SETTING_DEFAULTS.Surfaces.onGpu), (v) => {
          st.set("Surfaces", "onGpu", v);
          (globalThis as unknown as { __gpuSurfaces?: boolean }).__gpuSurfaces = v;
        })));
      into.appendChild(hint("Applies to the next segmentation whose surfaces are built."));

      // THE DUCKN WORKING COPY (the workspace brief, Contents/docs/DUCKN-WORKING-COPY.md). ON by
      // default since 2026-09-23 (Ron, after his own load from it and the sweep: "yes to both"); a
      // series without a valid copy is read from DICOM either way, and the status line says which.
      into.appendChild(h2("Loading"));
      into.appendChild(row("Load images from their fast copy", "A compressed copy of each series kept beside the DICOM files: one description and a few hundred pieces instead of hundreds of files. The same images, checked piece by piece. A series without a copy loads from DICOM as before.",
        toggle(() => st.getBool("Loading", "fromCopy", SETTING_DEFAULTS.Loading.fromCopy), (v) => {
          st.set("Loading", "fromCopy", v);
          (globalThis as unknown as { __zarrCopies?: boolean }).__zarrCopies = v;
        })));
      into.appendChild(hint("Applies to the next series loaded."));

      // THE COLOR SCHEME, BY VERSION (logic/anatomy/palettes.ts). Ron, 2026-09-25: "All of these settings should be
      // versioned. That makes it easier to get back to a particular state." What arrives with its own colors keeps them;
      // this is where new colors come from, and what "Use the current colors" brings a segmentation to.
      into.appendChild(h2("Colors"));
      into.appendChild(row("Color scheme", "Where new segmentations get their colors, and what “Use the current colors” applies. Earlier versions stay available.",
        select(PALETTES.map((p) => [String(p.version), `v${p.version} — ${p.name} (${p.date})`] as [string, string]).reverse(),
          () => String(st.getNumber("Colors", "scheme", SETTING_DEFAULTS.Colors.scheme)),
          (v) => { st.set("Colors", "scheme", Number(v)); setPaletteVersion(Number(v)); })));
      into.appendChild(hint("Saved segmentations and scenes keep the colors they were saved with."));

      into.appendChild(h2("At launch"));
      into.appendChild(row("Open the module I was in", "Start in the module that was open when the window closed, instead of Welcome.",
        toggle(() => st.getBool("Launch", "restoreModule", SETTING_DEFAULTS.Launch.restoreModule), (v) => st.set("Launch", "restoreModule", v))));
      into.appendChild(row("Reopen the layout I had", "Start with the view layout that was in use when the window closed, instead of the standard one.",
        toggle(() => st.getBool("Launch", "restoreLayout", SETTING_DEFAULTS.Launch.restoreLayout), (v) => st.set("Launch", "restoreLayout", v))));
    },
    reset() {
      st.set("Launch", "restoreModule", undefined); st.set("Launch", "restoreLayout", undefined);
      deps.notify?.({ title: "General: back to the shipped settings", body: "The module and the layout I had are reopened at launch. The database and the pictures folder are unchanged." });
    },
  });

  pages.push({
    id: "pictures", title: "Pictures",
    build(into) {
      into.appendChild(h2("The defaults for Picture · Save…"));
      const push = () => deps.onPictureDefaults?.(pictureDefaults(st));
      into.appendChild(row("What is in the picture", "The default. The 3D view's menu can change it for one picture under Advanced.",
        select([["all", "the 3D view and the slice views"], ["3d", "the 3D view only"]],
          () => (st.getBool("Pictures", "only3d", false) ? "3d" : "all"), (v) => { st.set("Pictures", "only3d", v === "3d"); push(); })));
      into.appendChild(row("With the module panel", "Add the module column on the left, as on screen.",
        toggle(() => st.getBool("Pictures", "panel", false), (v) => { st.set("Pictures", "panel", v); push(); })));
      into.appendChild(row("Size", "Every view rendered again at this multiple of its on-screen pixels; the framing stays the same.",
        select([["1", "as on screen"], ["2", "2× the pixels"], ["3", "3×"], ["4", "4×"]],
          () => String(Math.round(st.getNumber("Pictures", "scale", 1))), (v) => { st.set("Pictures", "scale", Number(v)); push(); })));
      into.appendChild(hint("Pictures are PNG files named by date and time, saved where General › Pictures says."));
    },
    reset() {
      st.set("Pictures", "only3d", undefined); st.set("Pictures", "panel", undefined); st.set("Pictures", "scale", undefined);
      deps.onPictureDefaults?.(pictureDefaults(st));
      deps.notify?.({ title: "Pictures: back to the shipped settings", body: "The 3D view and the slice views, without the panel, as on screen." });
    },
  });

  pages.push({
    id: "view3d", title: "3D view",
    build(into) {
      into.appendChild(h2("How a new window starts"));
      into.appendChild(row("Illustration", "On: the anatomy as in an atlas illustration: matte colors, a thin dark outline where one structure passes in front of another, crevices a little darker. Off: Realistic, shading and highlights. The Look button in the 3D view's menu changes it for this window.",
        toggle(() => st.getBool("View3D", "drawing", SETTING_DEFAULTS.View3D.drawing), (v) => st.set("View3D", "drawing", v))));
      // THE SHADING, BY VERSION (render/shading-versions.ts), as the colors are: applies at once, so two can be compared on the
      // same scene; remembered for the next window; a saved scene records its own.
      into.appendChild(row("Shading", "Whether each tissue takes the light its own way. Per tissue: a wet sheen on organs, satin on muscle, matte bone (Michael Halle's tissue palettes). Uniform: every structure alike. The 3D view's menu changes it for this window.",
        select(SHADINGS.map((v) => [String(v.version), `${v.label} (v${v.version}, ${v.date})`] as [string, string]),
          () => String(st.getNumber("View3D", "shading", SETTING_DEFAULTS.View3D.shading)),
          (v) => { st.set("View3D", "shading", Number(v)); setShadingVersion(Number(v)); })));
      into.appendChild(hint("These take effect the next time a window opens. The 3D view's ⋮ menu changes them for the window you are in."));
    },
    reset() {
      st.set("View3D", "drawing", undefined); st.set("View3D", "lighting", undefined); st.set("View3D", "shading", undefined); setShadingVersion(SETTING_DEFAULTS.View3D.shading);
      deps.notify?.({ title: "3D view: back to the shipped settings", body: `Illustration on, shading v${SETTING_DEFAULTS.View3D.shading}.` });
    },
  });

  // ── the navigation and the current page ──
  let current: Page = pages[0];
  const show = (p: Page) => {
    current = p;
    for (const b of Array.from(nav.children)) b.classList.toggle("on", (b as HTMLElement).dataset.id === p.id);
    page.replaceChildren(); p.build(page);
  };
  for (const p of pages) {
    const b = document.createElement("div"); b.className = "sl-settings-navitem"; b.dataset.id = p.id; b.textContent = p.title;
    b.addEventListener("click", () => show(p)); nav.appendChild(b);
  }
  resetBtn.addEventListener("click", () => { current.reset(); void st.flush(); show(current); });
  show(pages[0]);
}
