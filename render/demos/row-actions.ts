// NAMES AND ROW ACTIONS -- the module template's rule (Ron, 2026-10-14: "an easy way (minimum number of clicks, no
// reading directions) to rename"; "This behavior should be part of the template for modules"; the workspace's
// Contents/docs/PALETTE.md, "Names and row actions"; mockup mockups/rename-2026-10-14.html).
//
//   - The name is its own edit field: a pencil on hover, one click turns it into a text box with the old name selected;
//     Enter keeps the new name, Esc or clicking away unchanged cancels.
//   - A ⋯ button at the end of a row holds every other action on it (Remove first).
//   - A right-click on the row opens the same menu.
// In a row that a click SELECTS (Segmentations chooses the tree it shows), the first click selects and a click on the
// name of the row already selected renames it -- as Finder does; the pencil shows only where a click would rename.

export interface RowAction { label: string; run: () => void; title?: string }

/** Make `nameEl` rename on a click. `selected`, when given, says whether a click should rename now (the row is chosen). */
export function makeNameEditable(nameEl: HTMLElement, opts: { get: () => string; commit: (name: string) => void; selected?: () => boolean }): void {
  const armed = () => !opts.selected || opts.selected();
  const paint = () => { nameEl.classList.toggle("sl-name-edit", armed()); };
  paint();
  nameEl.addEventListener("mouseenter", paint);
  nameEl.addEventListener("click", (e) => {
    if (!armed()) return;                                   // the row's own click (selection) goes on
    e.stopPropagation();
    startEditing(nameEl, opts.get(), opts.commit);
  });
}

/** Turn `nameEl` into a text box now (the ⋯ menu's Rename uses this too). */
export function startEditing(nameEl: HTMLElement, current: string, commit: (name: string) => void): void {
  if (nameEl.querySelector("input.sl-name-input")) return;
  const shown = [...nameEl.childNodes];
  const input = document.createElement("input");
  input.className = "sl-name-input";
  input.value = current;
  input.setAttribute("aria-label", "New name");
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    nameEl.replaceChildren(...shown);
    if (keep && v && v !== current) commit(v);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();                                    // the views' keyboard shortcuts must not see the typing
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
}

let openMenu: HTMLElement | null = null;
const closeMenu = () => { openMenu?.remove(); openMenu = null; };
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => { if (openMenu && !openMenu.contains(e.target as Node)) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  document.addEventListener("scroll", closeMenu, true);
}

function showMenu(x: number, y: number, actions: RowAction[]) {
  closeMenu();
  if (!actions.length) return;
  const m = document.createElement("div");
  m.className = "sl-row-menu";
  m.setAttribute("role", "menu");
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); a.run(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  // On screen, below and left of the pointer when there is room.
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  openMenu = m;
}

/** A ⋯ button at the end of `row` and the same menu on a right-click. Returns the button. */
export function addRowMenu(row: HTMLElement, actions: () => RowAction[], what = "this"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sl-more";
  b.textContent = "⋯";
  b.title = `More for ${what}: rename, remove`;
  b.setAttribute("aria-haspopup", "menu");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu) { closeMenu(); return; }
    const r = b.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, actions());
  });
  row.appendChild(b);
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, actions()); });
  return b;
}
