// NAME CARDS ON SCREEN, in the 3D view (logic/markups/name-cards.ts is the model; Contents/docs/mockups/
// name-cards-2026-09-25.html, SlicerAlbula workspace, the design). Each card is a DOM element over the view, with a black
// leader to an amber pin drawn in an SVG beneath: the browser then does the text, its wrapping, the hover × and the
// pointer -- a card takes the click and the drag, the view underneath keeps everything else. Positions follow the camera
// every frame (the caller calls draw from the 3D view's frame).
//
// A FEW CARDS BY DESIGN (Ron, 2026-10-02: "I don't think that more than 10 cards will be managable. But speed is always my
// preference."), and fast with many all the same (critic 2026-10-02, finding 6: 300 cards took the 3D view from 60 to 17
// frames a second). A frame only WRITES: a card's size is measured once, when its text changes or it
// first shows, and a position or a visibility is written only when it changed. Reading a size after writing a position
// made the browser lay the page out once per card per frame.
//
// The card keeps its offset from its pin as the view turns (mockup: "Nothing moves it for you"); a drag changes the offset.
// A click opens the small editor beside it (title, description, Remove card, Done); × or the Delete key over a card
// removes it; right-click asks the caller for the card's menu. A locked card is neither dragged, edited nor removed here.
import type { MrsonNode } from "./mrson.ts";
import type { Vec3 } from "./mat4.ts";
import { cardLines, cardsOf, showInOf, type NameCard } from "../logic/markups/name-cards.ts";
import { escapeHtml } from "./demos/html.ts";

/** The structure a card names. `gone`: its segmentation was removed from the scene -- the card stays and says so. */
/** `visible`: shown in 3D; `visible2D`: shown in the slices (a segmentation can be off in 3D and on in the slices). */
export interface CardStructure { name: string; code?: string; segmentation?: string; visible: boolean; visible2D?: boolean; gone?: boolean }
export interface CardViewDeps {
  /** The 3D view's cell (positioned); the layer is added to it. */
  host: HTMLElement;
  /** A RAS point in host CSS pixels, or null when it is behind the camera. */
  project: (ras: Vec3) => { x: number; y: number } | null;
  /** Whether a card's pin is hidden behind something drawn in 3D (Ron, 2026-10-02: "when the anchor of a card is
   *  obstructed, it should not be seen"). */
  occluded?: (cardId: string) => boolean;
  /** The structure a card names, read from its segmentation each time; undefined when it names nothing. */
  structure: (segmentationId: string | undefined, segment: number | undefined) => CardStructure | undefined;
  onEdit: (listId: string, cardId: string) => void;
  onRemove: (listId: string, cardId: string) => void;
  onMove: (listId: string, cardId: string, offset: [number, number]) => void;
  onMenu: (listId: string, cardId: string, clientX: number, clientY: number) => void;
  /** A press on a card that is not the card's (the right or middle button): handed to the view underneath, so a
   *  right-drag that starts on a card still zooms (round 2, finding 9). */
  forward?: (e: PointerEvent) => void;
}

// WHERE THE LAST RIGHT-CLICK PRESS WAS (the right button, or control with the left): where a browser fires `contextmenu` at
// the release, this is what tells a click from a drag.
let lastPress: { x: number; y: number } | null = null;
addEventListener("pointerdown", (e) => { lastPress = e.button === 2 || (e.button === 0 && e.ctrlKey) ? { x: e.clientX, y: e.clientY } : null; }, true);
/** Whether the press now under way, or just ended, was a control-click (it is the right-click, not a left click). */
export const pressIsControlClick = () => !!lastPress;

/**
 * A RIGHT-CLICK, NOT A RIGHT-DRAG (critic 2026-10-02, findings 8-9 and round 2, finding 9): macOS fires `contextmenu` at the
 * PRESS, so the menu waits for the release and opens only if the pointer did not move; where the browser fires it at the
 * release, the press's own position decides.
 */
export function menuOnRelease(e: MouseEvent, open: (clientX: number, clientY: number) => void): void {
  e.preventDefault();
  if (e.buttons === 0) { if (!lastPress || Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) <= 2) open(e.clientX, e.clientY); return; }
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 2) moved = true; };
  const up = (ev: PointerEvent) => { removeEventListener("pointermove", move, true); removeEventListener("pointerup", up, true); if (!moved) open(ev.clientX, ev.clientY); };
  addEventListener("pointermove", move, true); addEventListener("pointerup", up, true);
}

const SVG = "http://www.w3.org/2000/svg";
const isLocked = (c: NameCard, list: MrsonNode | undefined) => !!(c.locked || list?.locked);

/** Whether a card is drawn in a kind of view: its list shown, the card shown, and the structure it names shown THERE (or
 *  gone) -- the slices by the segmentation's slice visibility, the 3D view by its 3D switch (critic round 2, finding 1). */
export function cardDrawn(list: MrsonNode, c: NameCard, s: CardStructure | undefined, where: "3d" | "slices" = "3d"): boolean {
  const shownThere = !s || s.gone === true || (where === "3d" ? s.visible : (s.visible2D ?? s.visible));
  return list.visible !== false && c.visibility !== false && (!c.associatedNodeID || shownThere);
}

interface El { card: HTMLDivElement; leader: SVGLineElement; pin: SVGCircleElement; glow: SVGCircleElement; key: string; w: number; h: number; on: boolean; pos: string }

export function mountNameCards(deps: CardViewDeps) {
  const layer = document.createElement("div");
  layer.className = "sl-cards";
  const svg = document.createElementNS(SVG, "svg");
  layer.appendChild(svg);
  deps.host.appendChild(layer);
  const els = new Map<string, El>();
  let dragging: { cardId: string; offset: [number, number] } | null = null;
  let selected = "";
  let hovered = "";
  let lastList: MrsonNode | undefined;
  let lastShown = true;

  const make = (listId: string, c: NameCard): El => {
    const card = document.createElement("div");
    card.className = "sl-card";
    card.style.display = "none";
    const leader = document.createElementNS(SVG, "line");
    leader.setAttribute("stroke", "var(--sl-card-ink)"); leader.setAttribute("stroke-width", "1.5");
    const glow = document.createElementNS(SVG, "circle");
    glow.setAttribute("r", "8"); glow.setAttribute("fill", "var(--sl-card-pin-glow)");
    const pin = document.createElementNS(SVG, "circle");
    pin.setAttribute("r", "4.5"); pin.setAttribute("fill", "var(--sl-card-pin)"); pin.setAttribute("stroke", "var(--sl-card-ink)"); pin.setAttribute("stroke-width", "1");
    for (const x of [leader, glow, pin]) x.style.display = "none";
    svg.append(leader, glow, pin);
    layer.appendChild(card);
    // DRAG MOVES THE CARD, a click without movement edits it; × removes; right-click is the card's menu.
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.ctrlKey) { if (e.button !== 0) deps.forward?.(e); return; }
      if ((e.target as HTMLElement).classList.contains("x")) return;
      e.preventDefault(); e.stopPropagation();
      const cur = cardsOf(lastList!).find((k) => k.id === c.id);
      if (!cur) return;
      const locked = isLocked(cur, lastList);
      const start = { x: e.clientX, y: e.clientY }, from = [...cur.cardOffset] as [number, number];
      let moved = false;
      card.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (locked) return;
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        dragging = { cardId: c.id, offset: [from[0] + dx, from[1] + dy] };
        draw(lastList, lastShown);
      };
      const up = () => {
        card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", up); card.removeEventListener("pointercancel", up);
        if (moved && dragging) { const off = dragging.offset; dragging = null; deps.onMove(listId, c.id, [Math.round(off[0]), Math.round(off[1])]); }
        else if (!moved) deps.onEdit(listId, c.id);   // a locked card: the caller says it is locked (round 2, finding 5)
        dragging = null;
      };
      card.addEventListener("pointermove", move); card.addEventListener("pointerup", up); card.addEventListener("pointercancel", up);
    });
    card.addEventListener("contextmenu", (e) => { e.stopPropagation(); menuOnRelease(e, (x, y) => deps.onMenu(listId, c.id, x, y)); });
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("x")) { e.stopPropagation(); deps.onRemove(listId, c.id); }
    });
    card.addEventListener("pointerenter", () => { hovered = c.id; });
    card.addEventListener("pointerleave", () => { if (hovered === c.id) hovered = ""; });
    return { card, leader, pin, glow, key: "", w: 0, h: 0, on: false, pos: "" };
  };

  // THE DELETE KEY over a card removes it (mockup: "Delete removes the card under the pointer"), as the hover × does.
  const onKey = (e: KeyboardEvent) => {
    if (!hovered || (e.key !== "Delete" && e.key !== "Backspace")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const c = lastList && cardsOf(lastList).find((k) => k.id === hovered);
    if (!c) return;
    e.preventDefault();   // a locked card: the caller refuses and says so (round 2, finding 5)
    deps.onRemove(lastList!.id as string, c.id);
  };
  addEventListener("keydown", onKey);

  const show = (e: El, on: boolean) => {
    if (e.on === on) return;
    e.on = on;
    const d = on ? "" : "none";
    e.card.style.display = d; e.leader.style.display = d; e.pin.style.display = d; e.glow.style.display = d;
    if (!on) e.pos = "";
  };

  /** Place every card for the current camera. `list` is the scene's card list (or undefined). */
  function draw(list: MrsonNode | undefined, shown = true) {
    lastList = list; lastShown = shown;
    const cards = list ? cardsOf(list) : [];
    const listId = (list?.id as string) ?? "";
    const showList = !!list && shown && showInOf(list).threeD;
    const seen = new Set<string>();
    const W = layer.clientWidth, H = layer.clientHeight;
    // Text first, for the cards whose text changed (a write, then ONE read of all the new sizes below).
    const fresh: El[] = [];
    const placed: { e: El; c: NameCard; p: { x: number; y: number } }[] = [];
    for (const c of cards) {
      seen.add(c.id);
      let e = els.get(c.id);
      if (!e) { e = make(listId, c); els.set(c.id, e); }
      const s = deps.structure(c.associatedNodeID, c.segment);
      const p = showList && cardDrawn(list!, c, s) && !deps.occluded?.(c.id) ? deps.project(c.position) : null;
      const on = !!p && p.x > -40 && p.y > -40 && p.x < W + 40 && p.y < H + 40;
      show(e, on);
      if (!on || !p) continue;
      const lines = cardLines(c, s?.gone ? { name: "its structure was removed from the scene" } : s);
      const locked = isLocked(c, list);
      const key = JSON.stringify([lines, locked, c.id === selected, !!s?.gone]);
      if (key !== e.key) {
        e.key = key;
        e.card.classList.toggle("sl-locked", locked);
        e.card.classList.toggle("sl-sel", c.id === selected);
        e.card.classList.toggle("sl-gone", !!s?.gone);
        e.card.title = s?.gone ? "The segmentation this card named is no longer in the scene" + (locked ? "" : " — click to edit, drag to move")
          : (s ? `${s.name}${s.segmentation ? ` · ${s.segmentation}` : ""}` : "Name card") + (locked ? " — locked" : " — click to edit, drag to move");
        e.card.innerHTML = (lines.title ? `<div class="t">${escapeHtml(lines.title)}</div>` : "") + (lines.name ? `<div class="n">${escapeHtml(lines.name)}</div>` : "") +
          (lines.code ? `<div class="c">${escapeHtml(lines.code)}</div>` : "") + (lines.description ? `<div class="d">${escapeHtml(lines.description)}</div>` : "") +
          `<button class="x" title="Remove this card">×</button>`;
        e.w = 0;
      }
      if (!e.w) fresh.push(e);
      placed.push({ e, c, p });
    }
    for (const e of fresh) { e.w = e.card.offsetWidth; e.h = e.card.offsetHeight; }   // one layout for all of them
    for (const { e, c, p } of placed) {
      const off = dragging?.cardId === c.id ? dragging.offset : c.cardOffset;
      // The card keeps its own width (the stylesheet's max-content) and stays inside the view: near an edge it is pushed
      // back in, its pin and leader where they were. 10: room for the hover ×.
      const left = Math.round(Math.max(10, Math.min(p.x + off[0], W - e.w - 10))), top = Math.round(Math.max(10, Math.min(p.y + off[1], H - e.h - 10)));
      const px = Math.round(p.x * 2) / 2, py = Math.round(p.y * 2) / 2;
      const pos = `${left},${top},${px},${py}`;
      if (pos === e.pos) continue;
      e.pos = pos;
      e.card.style.left = `${left}px`; e.card.style.top = `${top}px`;
      // The leader runs from the pin to the nearest point of the card's edge.
      const ex = Math.min(Math.max(px, left), left + e.w), ey = Math.min(Math.max(py, top), top + e.h);
      e.leader.setAttribute("x1", String(px)); e.leader.setAttribute("y1", String(py));
      e.leader.setAttribute("x2", String(ex)); e.leader.setAttribute("y2", String(ey));
      for (const c2 of [e.pin, e.glow]) { c2.setAttribute("cx", String(px)); c2.setAttribute("cy", String(py)); }
    }
    for (const [id, e] of els) if (!seen.has(id)) { e.card.remove(); e.leader.remove(); e.pin.remove(); e.glow.remove(); els.delete(id); if (hovered === id) hovered = ""; }
  }

  /** Where a card and its pin are now, in host pixels (for placing its editor beside it, away from the pin). */
  const cardRect = (cardId: string) => {
    const e = els.get(cardId);
    if (!e || !e.on) return undefined;
    return { left: e.card.offsetLeft, top: e.card.offsetTop, width: e.card.offsetWidth, height: e.card.offsetHeight, pin: { x: Number(e.pin.getAttribute("cx")), y: Number(e.pin.getAttribute("cy")) } };
  };

  /**
   * THE CARDS INTO A PICTURE (Save picture; critic 2026-10-02, finding 7: a picture left them out): leaders, pins and cards
   * painted onto `g` as they are on screen, `scale` device pixels to a CSS pixel, (ox, oy) the view's corner in `g`.
   */
  function paint(g: CanvasRenderingContext2D, scale: number, ox = 0, oy = 0) {
    const cs = getComputedStyle(layer);
    const ink = cs.getPropertyValue("--sl-card-ink").trim() || "#000", bg = cs.getPropertyValue("--sl-card-bg").trim() || "#fbf9f5";
    const pinCol = cs.getPropertyValue("--sl-card-pin").trim() || "#ffb300", glow = cs.getPropertyValue("--sl-card-pin-glow").trim() || "rgba(255,179,0,.45)";
    g.save();
    g.translate(ox, oy); g.scale(scale, scale);
    const shown = [...els.values()].filter((e) => e.on);
    // Every leader and pin beneath every card, as on screen.
    for (const e of shown) {
      const n = (el: Element, a: string) => Number(el.getAttribute(a));
      g.strokeStyle = ink; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(n(e.leader, "x1"), n(e.leader, "y1")); g.lineTo(n(e.leader, "x2"), n(e.leader, "y2")); g.stroke();
      const px = n(e.pin, "cx"), py = n(e.pin, "cy");
      g.fillStyle = glow; g.beginPath(); g.arc(px, py, 8, 0, Math.PI * 2); g.fill();
      g.fillStyle = pinCol; g.beginPath(); g.arc(px, py, 4.5, 0, Math.PI * 2); g.fill(); g.lineWidth = 1; g.stroke();
    }
    for (const e of shown) {
      g.strokeStyle = ink;
      const x = e.card.offsetLeft, y = e.card.offsetTop, w = e.card.offsetWidth, h = e.card.offsetHeight;
      g.fillStyle = bg; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(x, y, w, h, 4); g.fill(); g.stroke();
      // Each line of text where the browser laid it out: the line's box and its font, wrapped as on screen.
      for (const line of e.card.querySelectorAll<HTMLElement>(".t, .n, .c, .d")) {
        const ls = getComputedStyle(line);
        g.font = ls.font; g.fillStyle = ls.color; g.textBaseline = "top";
        // The line's own fractional width plus a pixel: clientWidth is rounded, and "Landmark 2" broke in two at 71 against
        // 71.07 (round 2, finding 6). A line that is one line on screen is one line here.
        const lh = parseFloat(ls.lineHeight) || parseFloat(ls.fontSize) * 1.3, maxW = line.getBoundingClientRect().width + 1;
        let ly = y + line.offsetTop;
        for (const para of (line.textContent ?? "").split("\n")) {
          let cur = "";
          for (const word of para.split(" ")) {
            const t = cur ? `${cur} ${word}` : word;
            if (cur && g.measureText(t).width > maxW) { g.fillText(cur, x + line.offsetLeft, ly); ly += lh; cur = word; } else cur = t;
          }
          g.fillText(cur, x + line.offsetLeft, ly); ly += lh;
        }
      }
    }
    g.restore();
  }

  return {
    draw,
    cardRect,
    paint,
    select(cardId: string) { selected = cardId; for (const e of els.values()) e.key = ""; draw(lastList, lastShown); },
    get selected() { return selected; },
    get layer() { return layer; },
    destroy() { removeEventListener("keydown", onKey); layer.remove(); },
  };
}

/** An open editor: `keep` saves what was typed and closes (leaving it for another card keeps the typing -- critic
 *  2026-10-02, finding 3); `discard` closes without saving (✕, Esc, or its card removed). */
export interface CardEditor { keep: () => void; discard: () => void; cardId: string }

/**
 * THE CARD'S SMALL EDITOR, beside the card on the side away from its pin (mockup panel 3; critic 2026-10-02, finding 13):
 * the file's name (not editable), Title, Description, Remove card, Done. Enter in the title or Done keeps; Esc and ✕ leave
 * it as it was (Esc also tells the caller, which ends placing -- mockup: "Esc ends placing").
 */
export function openCardEditor(opts: {
  host: HTMLElement; cardId: string; near?: { left: number; top: number; width: number; height: number; pin?: { x: number; y: number } };
  structure?: CardStructure; title: string; description: string;
  onSave: (title: string, description: string) => void; onRemove: () => void; onEscape?: () => void;
}): CardEditor {
  const box = document.createElement("div");
  box.className = "sl-card-edit";
  const s = opts.structure;
  box.innerHTML = `<div class="hd"><span>Name card</span><button class="sl-ce-x" title="Close without changes">✕</button></div>
    ${s ? `<div class="auto">${s.gone ? "Its structure was removed from the scene" : `${escapeHtml(s.name)}${s.code ? ` · ${escapeHtml(s.code)}` : ""}`}<div class="sub">from the file, not editable${s.segmentation ? ` · ${escapeHtml(s.segmentation)}` : ""}</div></div>` : ""}
    <label>Title</label><input class="sl-ce-t" type="text" maxlength="80" placeholder="optional — shown above the name">
    <label>Description</label><textarea class="sl-ce-d" rows="3" maxlength="500" placeholder="optional"></textarea>
    <div class="acts"><button class="sl-ce-rm" title="Take this card away">Remove card</button><button class="sl-primary sl-ce-ok">Done</button></div>`;
  const t = box.querySelector(".sl-ce-t") as HTMLInputElement, d = box.querySelector(".sl-ce-d") as HTMLTextAreaElement;
  t.value = opts.title; d.value = opts.description;
  // ON THE PAGE, NOT IN THE VIEW (round 2, finding 8): a four-up 3D view is too small to hold the editor beside a card in
  // its middle, so the editor may sit over a neighboring view instead of over its own card and pins.
  box.style.position = "fixed";
  document.body.appendChild(box);
  const hr = opts.host.getBoundingClientRect();
  const W = innerWidth, H = innerHeight, bw = box.offsetWidth, bh = box.offsetHeight;
  const n0 = opts.near ?? { left: hr.width / 2 - bw / 2, top: hr.height / 2 - bh / 2, width: 0, height: 0 };
  const n = { left: n0.left + hr.left, top: n0.top + hr.top, width: n0.width, height: n0.height };
  // Beside the card, on the side away from its pin; where neither side has room, in the half of the window the pin is not in.
  const pin = opts.near?.pin ? { x: opts.near.pin.x + hr.left, y: opts.near.pin.y + hr.top } : { x: n.left - 1, y: n.top + n.height / 2 };
  const right = n.left + n.width + 10, leftSide = n.left - bw - 10;
  const pinLeft = pin.x < n.left + n.width / 2;
  let left: number, top = n.top;
  if (pinLeft && right + bw <= W - 8) left = right;
  else if (!pinLeft && leftSide >= 8) left = leftSide;
  else if (right + bw <= W - 8 && !(pin.x > right && pin.x < right + bw)) left = right;
  else if (leftSide >= 8 && !(pin.x > leftSide && pin.x < leftSide + bw)) left = leftSide;
  else { left = n.left; top = pin.y < H / 2 ? H - bh - 8 : 8; }
  box.style.left = `${Math.max(8, Math.min(left, W - bw - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(top, H - bh - 8))}px`;
  let closed = false;
  const close = () => { if (closed) return; closed = true; box.remove(); removeEventListener("keydown", key, true); };
  const keep = () => { if (closed) return; const a = t.value, b = d.value; close(); opts.onSave(a, b); };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); opts.onEscape?.(); }
    else if (e.key === "Enter" && e.target === t) { e.preventDefault(); keep(); }
  };
  addEventListener("keydown", key, true);
  box.querySelector(".sl-ce-x")!.addEventListener("click", close);
  box.querySelector(".sl-ce-ok")!.addEventListener("click", keep);
  box.querySelector(".sl-ce-rm")!.addEventListener("click", () => { close(); opts.onRemove(); });
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  setTimeout(() => t.focus(), 0);
  return { keep, discard: close, cardId: opts.cardId };
}

/** One item of a view menu: an action (`off` grays it out and says why in its tooltip), a heading, or a separator. */
export type ViewMenuItem = { label: string; run: () => void; title?: string; off?: string } | { heading: string } | "sep";

/** A small menu at the pointer (the view's right-click): items with a label and an action, separators, a heading line. */
export function openViewMenu(x: number, y: number, items: ViewMenuItem[]): void {
  document.querySelectorAll(".sl-view-menu").forEach((m) => m.remove());
  const m = document.createElement("div");
  m.className = "sl-view-menu";
  for (const it of items) {
    if (it === "sep") { const s = document.createElement("div"); s.className = "sep"; m.appendChild(s); continue; }
    const el = document.createElement("div");
    if ("heading" in it) { el.className = "hd2"; el.textContent = it.heading; m.appendChild(el); continue; }
    el.className = it.off ? "it off" : "it"; el.textContent = it.label;
    const tip = it.off ?? it.title; if (tip) el.title = tip;
    if (!it.off) el.addEventListener("click", () => { m.remove(); it.run(); });
    m.appendChild(el);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const away = (e: Event) => { if (!m.contains(e.target as Node)) { m.remove(); removeEventListener("pointerdown", away, true); removeEventListener("keydown", esc, true); } };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { m.remove(); removeEventListener("pointerdown", away, true); removeEventListener("keydown", esc, true); } };
  setTimeout(() => { addEventListener("pointerdown", away, true); addEventListener("keydown", esc, true); }, 0);
}
