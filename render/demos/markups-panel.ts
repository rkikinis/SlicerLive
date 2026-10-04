// "Markups" panel (W4): place points/lines/angles/curves/ROIs (Slicer's place toolbar), a persistent-place
// toggle, and the markups list with per-node measurement, visibility and delete. Placement itself is the
// native placer wired in live-views (interaction node + placeClick); this panel only drives it through the
// exposed hooks, so it works standalone. Plain DOM, theme.css. RAS/geometry handled downstream.
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { MarkupType } from "../../logic/markups/measurements.ts";

interface MarkupInfo { id: string; markupType: MarkupType; name: string; points: number; measurements: { name: string; value: number; units: string }[]; visible: boolean; locked: boolean; cards?: boolean }
interface CardInfo { id: string; label: string; description: string; name: string; code: string; segmentation: string; gone?: boolean; visible: boolean; locked: boolean }
interface CardsInfo { id: string; showIn: { threeD: boolean; slices: boolean }; visible: boolean; locked: boolean; cards: CardInfo[] }
type PlaceType = MarkupType | "nameCard";
interface PlaceState { mode: string; markupType: string; persistent: boolean; placeNodeId: string; }
interface Hooks {
  __startPlace: (t: PlaceType, persistent?: boolean) => void;
  __nameCards: () => CardsInfo | null;
  __cardSet: (id: string, patch: { label?: string; description?: string; visibility?: boolean; locked?: boolean }) => boolean;
  __cardRemove: (id: string) => boolean;
  __cardEdit: (id: string) => void;
  __cardSelect: (id: string) => void;
  __cardShowIn: (patch: { threeD?: boolean; slices?: boolean }) => boolean;
  __endPlace: () => void;
  __placeState: () => PlaceState | null;
  __markups: () => MarkupInfo[];
  __deleteMarkup: (id: string) => boolean;
  __setMarkupProp: (id: string, prop: "visible" | "locked", value: boolean) => boolean;
  __renameMarkup: (id: string, name: string) => boolean;
  __setGlyphScale: (scale: number) => void;
  __glyphScale: () => number;
}
const g = () => globalThis as unknown as Hooks;

const TYPES: { t: PlaceType; label: string; tip?: string }[] = [
  { t: "fiducial", label: "Point" }, { t: "line", label: "Line" }, { t: "angle", label: "Angle" },
  { t: "curve", label: "Curve" }, { t: "closedCurve", label: "Closed Curve" }, { t: "roi", label: "ROI" },
  // NAME CARDS (logic/markups/name-cards.ts; Ron, 2026-09-25: "just another type of markup and that module is the full home").
  { t: "nameCard", label: "Name card", tip: "A card pinned where you click, in the 3D view or a slice: the structure's name from the file when you click one, and a title and description you type. A right-click in a view offers it too." },
];

export function registerMarkupsPanel(shell: AppShell, opts: { live: LiveScene; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  let dragging = false;   // suppress subscribe-driven re-render while the glyph slider is dragged
  let editing = false;    // … and while a name is being typed
  let selCard = "";       // the name card selected in the list (its fields are edited below the list)
  let cardsOpen = true;   // the Name cards row unfolded
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  const fmt = (m: { value: number; units: string }) => `${m.value.toFixed(m.units === "deg" ? 1 : 2)} ${m.units === "deg" ? "°" : m.units === "mm2" ? "mm²" : m.units === "mm3" ? "mm³" : m.units}`;

  // THE EYE AND THE LOCK AS ICONS FROM THE STYLESHEET, not emoji: with 300 name cards the emoji alone took 170 of a
  // render's 182 ms in Chrome (font fallback for each of 900 glyphs; critic 2026-10-02, round 2, finding 2).
  const eye = (on: boolean) => `<i class="sl-ico ${on ? "sl-ico-eye" : "sl-ico-eye-off"}" aria-label="${on ? "shown" : "hidden"}"></i>`;
  const lock = (on: boolean) => `<i class="sl-ico ${on ? "sl-ico-lock" : "sl-ico-unlock"}" aria-label="${on ? "locked" : "unlocked"}"></i>`;

  // ONE RENDER PER CHANGE, AND NONE WHEN NOTHING SHOWN CHANGED (finding 2): a point dragged in a slice changes the scene
  // on every move and the panel was rebuilt each time (5 frames a second with 300 cards). Changes are gathered to one
  // render a frame, and that render is skipped when what the panel shows is the same.
  let shownKey = "";
  let soon = 0;
  const renderSoon = () => { if (!soon) soon = setTimeout(() => { soon = 0; if (!dragging && !editing) render(); }, 0) as unknown as number; };
  const panelKey = () => JSON.stringify([g().__placeState?.() ?? null, g().__markups?.() ?? [], g().__nameCards?.() ?? null, selCard, cardsOpen, g().__glyphScale?.() ?? 3]);

  function render(force = false) {
    if (!root) return;
    const key = panelKey();
    if (!force && key === shownKey && root.childElementCount) return;
    shownKey = key;
    const ps = g().__placeState?.() ?? null;
    const persistent = !!ps?.persistent;
    const placing = ps?.mode === "place" ? (ps.markupType as string) : "";
    const list = g().__markups?.() ?? [];
    root.innerHTML = `
      <h2>Markups</h2>
      <div class="sl-row sl-markup-types">${TYPES.map((x) => `<button data-t="${x.t}" class="${placing === x.t ? "sl-primary" : ""}"${x.tip ? ` title="${escapeHtml(x.tip)}"` : ""}>${x.label}</button>`).join("")}</div>
      <div class="sl-row"><label><input type="checkbox" class="sl-mk-persist"${persistent ? " checked" : ""}> Place multiple</label>${placing ? `<button class="sl-mk-end">Stop placing</button>` : ""}</div>
      ${placing === "nameCard" ? `<p class="sl-hint">Placing a name card: click a structure in the 3D view (or a slice). A right-click, Esc or Stop ends.</p>` : placing ? `<p class="sl-hint">Click in a slice view, or on the anatomy in the 3D view, to place ${placing === "line" ? "a line: two clicks, one at each end" : placing}. Esc / Stop to finish.</p>` : ""}
      <div class="sl-row"><label>Glyph size</label><input class="sl-mk-glyph" type="range" min="1" max="10" step="0.5" value="${g().__glyphScale?.() ?? 3}"></div>
      <h3>List (${list.length})</h3>
      <div class="sl-markup-list">${list.length ? list.map(nodeRow).join("") : `<p class="sl-hint">No markups yet.</p>`}</div>`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    root.querySelectorAll(".sl-markup-types button").forEach((b) => b.addEventListener("click", () => {
      const t = (b as HTMLElement).dataset.t as PlaceType;
      if (placing === t) { g().__endPlace(); status("placement stopped"); }
      else { g().__startPlace(t, $("input.sl-mk-persist").checked); status(t === "nameCard" ? "place a name card — click on a structure in 3D or in a slice view" : `place ${t} — click in a slice view or on the anatomy in 3D`); }
      render();
    }));
    $("input.sl-mk-persist")?.addEventListener("change", () => { if (placing) g().__startPlace(placing as PlaceType, $("input.sl-mk-persist").checked); });
    wireCards();
    $(".sl-mk-end")?.addEventListener("click", () => { g().__endPlace(); status("placement stopped"); render(); });
    const glyph = $("input.sl-mk-glyph");
    glyph?.addEventListener("pointerdown", () => { dragging = true; });
    glyph?.addEventListener("input", (e) => g().__setGlyphScale(Number((e.target as HTMLInputElement).value)));
    glyph?.addEventListener("change", () => { dragging = false; render(); });
    root.querySelectorAll(".sl-markup-list [data-del]").forEach((b) => b.addEventListener("click", () => { g().__deleteMarkup((b as HTMLElement).dataset.del!); render(); }));
    root.querySelectorAll(".sl-markup-list [data-vis]").forEach((b) => b.addEventListener("click", () => { const el = b as HTMLElement; g().__setMarkupProp(el.dataset.vis!, "visible", el.dataset.on !== "1"); render(); }));
    // THREE SLICES FROM THIS LINE (logic/line-axes.ts; Ron, 2026-09-25: "two markups … would define the axis").
    root.querySelectorAll(".sl-markup-list [data-align]").forEach((b) => b.addEventListener("click", () => {
      const ok = (globalThis as unknown as { __alignSlicesToLine?: (id: string) => boolean }).__alignSlicesToLine?.((b as HTMLElement).dataset.align!);
      if (!ok) status("The slices could not be aligned: the line needs two points");
    }));
    root.querySelectorAll(".sl-markup-list [data-lock]").forEach((b) => b.addEventListener("click", () => { const el = b as HTMLElement; g().__setMarkupProp(el.dataset.lock!, "locked", el.dataset.on !== "1"); render(); }));
    // RENAME BY CLICKING THE NAME, as the Scene control renames a scene: Enter or leaving the field keeps it, Esc does not.
    root.querySelectorAll(".sl-markup-list [data-rename]").forEach((b) => b.addEventListener("click", () => {
      const el = b as HTMLElement;
      const input = document.createElement("input");
      input.type = "text"; input.className = "sl-mk-rename"; input.value = el.dataset.name ?? "";
      input.title = "The markup's name; Enter keeps it, Esc leaves it as it was";
      el.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = (keep: boolean) => {
        if (done) return; done = true;
        editing = false;
        if (keep && input.value.trim() && input.value.trim() !== el.dataset.name) { g().__renameMarkup(el.dataset.rename!, input.value); status(`renamed to “${input.value.trim()}”`); }
        render(true);   // the name field put back as a button, changed or not
      };
      editing = true;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") { e.stopPropagation(); finish(false); } });
      input.addEventListener("blur", () => finish(true));
    }));
  }

  /** THE NAME CARDS ROW: the list (eye, lock, ×), "Show in", one row a card, and the selected card's fields (mockup panel 4).
   *  Hundreds of cards (critic 2026-10-02, finding 6): one listener for the whole list, not four a row. */
  function cardsRow(n: MarkupInfo): string {
    const info = g().__nameCards?.();
    if (!info) return "";
    const sel = info.cards.find((c) => c.id === selCard);
    const where = (c: CardInfo) => c.gone ? "structure removed" : c.name;
    // A card shows the lock it is under: its own, or the whole list's (finding 11).
    const card = (c: CardInfo) => {
      const locked = c.locked || info.locked;
      return `<div class="sl-markup-row sl-mk-card${c.id === selCard ? " sl-sel" : ""}" data-card="${c.id}" title="Click to select; its card is outlined in the view"><span class="sl-mk-name">&nbsp;&nbsp;${c.label ? escapeHtml(c.label) : `<i class="sl-hint">no title</i>`} <span class="sl-hint">${escapeHtml(where(c))}</span></span><span class="sl-mk-actions"><button data-cvis="${c.id}" data-on="${c.visible ? "1" : "0"}" title="Show or hide this card">${eye(c.visible)}</button><button data-clock="${c.id}" data-on="${c.locked ? "1" : "0"}"${info.locked ? " disabled" : ""} title="${info.locked ? "All name cards are locked (the lock above)" : "Lock: the card can no longer be moved, edited or removed"}">${lock(locked)}</button><button data-cdel="${c.id}"${locked ? ` disabled title="Locked — unlock it to remove it"` : ` title="Remove this card"`}>✕</button></span></div>`;
    };
    return `<div class="sl-markup-row sl-mk-cardlist"><span class="sl-mk-name"><button class="sl-mk-fold" data-fold title="${cardsOpen ? "Fold" : "Unfold"} the cards">${cardsOpen ? "▾" : "▸"}</button> ${escapeHtml(n.name)} <span class="sl-hint">(point list · ${info.cards.length})</span></span><span class="sl-mk-actions"><button data-vis="${n.id}" data-on="${n.visible ? "1" : "0"}" title="Show or hide all name cards">${eye(n.visible)}</button><button data-lock="${n.id}" data-on="${n.locked ? "1" : "0"}" title="Lock or unlock all name cards">${lock(n.locked)}</button><button data-cdelall="${n.id}"${n.locked ? ` disabled title="Locked — unlock them to delete them"` : ` title="Delete all name cards (asks first)"`}>✕</button></span></div>` +
      (cardsOpen ? `<div class="sl-row sl-hint sl-mk-showin">Show in: <label title="The cards in the 3D view"><input type="checkbox" data-showin="threeD"${info.showIn.threeD ? " checked" : ""}> 3D</label> <label title="The pins and titles in the slice views, on the slice they are in (off by default: they crowd the image)"><input type="checkbox" data-showin="slices"${info.showIn.slices ? " checked" : ""}> Slices</label> <button class="sl-mk-cardadd" title="Then click where the card goes, in the 3D view or a slice. A right-click in a view offers it too.">+ Add a card</button></div>` +
        `<div class="sl-mk-cards">${info.cards.map(card).join("")}</div>` +
        (sel ? `<div class="sl-mk-cardsel"><div class="sl-hint">Selected card · ${escapeHtml(sel.gone ? "its structure was removed from the scene" : sel.name || "no structure")}${sel.code ? ` · ${escapeHtml(sel.code)}` : ""}${sel.segmentation ? ` · ${escapeHtml(sel.segmentation)}` : ""}</div>
          <label class="sl-hint">Title<input type="text" class="sl-mk-ctitle" maxlength="80" value="${escapeHtml(sel.label)}"${sel.locked || info.locked ? " disabled" : ""}></label>
          <label class="sl-hint">Description<textarea class="sl-mk-cdesc" rows="3" maxlength="500"${sel.locked || info.locked ? " disabled" : ""}>${escapeHtml(sel.description)}</textarea></label></div>` : "") : "");
  }

  function wireCards() {
    if (!root) return;
    root.querySelector("[data-fold]")?.addEventListener("click", () => { cardsOpen = !cardsOpen; render(); });
    // ADD WHERE THE CARDS ARE (Ron, 2026-10-02: "It was not intuitive to me how to add a new card"): the same as the Name card button.
    root.querySelector(".sl-mk-cardadd")?.addEventListener("click", () => { g().__startPlace("nameCard", false); status("place a name card — click where it goes, in 3D or in a slice view"); render(); });
    root.querySelectorAll("[data-showin]").forEach((b) => b.addEventListener("change", () => { const el = b as HTMLInputElement; g().__cardShowIn({ [el.dataset.showin!]: el.checked }); render(); }));
    // DELETING EVERY CARD ASKS FIRST (critic 2026-10-02, finding 4): typed titles and descriptions cannot be got back.
    root.querySelector("[data-cdelall]")?.addEventListener("click", async (e) => {
      const id = (e.currentTarget as HTMLElement).dataset.cdelall!;
      const count = g().__nameCards?.()?.cards.length ?? 0;
      const ok = await shell.confirm({ title: `Delete all ${count} name card${count === 1 ? "" : "s"}?`, body: "<p>Their titles and descriptions go with them. This cannot be undone.</p>", ok: "Delete them", cancel: "Keep them", destructive: true });
      if (!ok) return;
      selCard = ""; g().__deleteMarkup(id); render();
    });
    root.querySelector(".sl-mk-cards")?.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest("button") as HTMLButtonElement | null;
      if (b?.dataset.cvis) { g().__cardSet(b.dataset.cvis, { visibility: b.dataset.on !== "1" }); render(); return; }
      if (b?.dataset.clock) { g().__cardSet(b.dataset.clock, { locked: b.dataset.on !== "1" }); render(); return; }
      if (b?.dataset.cdel) { const id = b.dataset.cdel; if (g().__cardRemove(id) && id === selCard) selCard = ""; render(); return; }
      if (b) return;
      const row = t.closest("[data-card]") as HTMLElement | null;
      if (row) { selCard = row.dataset.card!; g().__cardSelect?.(selCard); render(); }
    });
    for (const [cls, field] of [[".sl-mk-ctitle", "label"], [".sl-mk-cdesc", "description"]] as const) {
      const el = root.querySelector(cls) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) continue;
      el.addEventListener("focus", () => { editing = true; });
      el.addEventListener("blur", () => { editing = false; g().__cardSet(selCard, { [field]: el.value.trim() }); render(); });
      el.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter" && field === "label") { (e.target as HTMLElement).blur(); } });
    }
  }

  function nodeRow(n: MarkupInfo): string {
    if (n.cards) return cardsRow(n);
    const meas = n.measurements.length ? ` — ${fmt(n.measurements[0])}` : "";
    return `<div class="sl-markup-row"><span class="sl-mk-name"><button class="sl-mk-rename-btn" data-rename="${n.id}" data-name="${escapeHtml(n.name)}" title="Click to rename">${escapeHtml(n.name)}</button> <span class="sl-hint">(${n.markupType}, ${n.points} pt${n.points === 1 ? "" : "s"})${meas}</span></span><span class="sl-mk-actions">${n.markupType === "line" && n.points >= 2 ? `<button data-align="${n.id}" title="Red across this line, yellow and green along it at 90 degrees — the slices follow its points (the heart's idea, with the axis given by hand)">Align slices</button>` : ""}<button data-vis="${n.id}" data-on="${n.visible ? "1" : "0"}" title="Show/hide">${eye(n.visible)}</button><button data-lock="${n.id}" data-on="${n.locked ? "1" : "0"}" title="Lock/unlock">${lock(n.locked)}</button><button data-del="${n.id}" title="Delete">✕</button></span></div>`;
  }

  Object.assign(globalThis, {
    __markupsSelectCard: (id: string) => { selCard = id; cardsOpen = true; render(); },
    __markupsShowCard: (id: string) => { selCard = id; cardsOpen = true; void shell.showPanel("markups").then(() => { render(); g().__cardSelect?.(id); }); },
  });
  shell.registerPanel({ id: "markups", title: "Markups", groups: ["Geometry"], tip: "Points, lines and curves placed in the views, with their measurements", mount(el) { root = el; render(true); } });
  live.subscribe((c) => { if (!dragging && !editing && (c.type === "markup" || c.type === "interaction" || c.type === "segmentation" || c.kind === "remove")) renderSoon(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { const ps = g().__placeState?.(); if (ps?.mode === "place") { g().__endPlace(); render(); } } });
}
