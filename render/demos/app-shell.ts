// The native SlicerLive application shell — the frame the workflow panels (W1..W7) mount into.
// "Feel like Slicer, modernized": a module sidebar with a panel registry, a toolbar row, the view area,
// a status line; dark theme tokens from theme.css (Slicer's Red/Yellow/Green view colours preserved,
// logo palette for accents). Plain DOM, no framework, no render/ dependency: anything that renders
// mounts into `main` (mountLiveViews) and anything with controls registers a panel.
//
// Usage:
//   const shell = mountAppShell(document.body, { title: "SlicerLive" });
//   shell.registerPanel({ id: "welcome", title: "Welcome", mount(el) { ... } });
//   const views = mountLiveViews(gpu, shell.main, {...});
//   shell.onMainResize(() => views.setCells(fourUp(shell.main)));

/**
 * The module headings, in the order they are shown. CLOSED ON PURPOSE.
 *
 * Each names a TASK, from the user's side: Data is getting data in and results out, Display is how
 * the image looks, Segmentation is dividing it into structures, Geometry is things placed in the
 * volume's space. Slicer's fifteen categories mix seven different axes -- task, data type, clinical
 * domain, maturity, audience, UI shape, leftovers -- because the list was open and every new kind of
 * thing got a slot. A fifth entry here should be a decision, not a commit.
 *
 * Work in progress: Ron, 2026-09-05, "think of it as a work in progress" -- to be revisited with
 * Steve and Andrey once more use cases have been worked through.
 */
// 2026-09-11, Ron: "Scene Data and Segmentations are listed twice" (the "" heading pins a module
// to the top AND lists it under its heading; nothing is pinned now but Welcome), "there is add data
// and save to dicom, but there is no save to disk" (there was; Save was mis-titled), "Scene data is
// listed under files. Why?" (it is the scene, so it is Display, and it is called Scene). Files is
// Data now, and the modules under it are separate on purpose -- "keeping them under one heading is
// one click less" than sections inside one module.
export const GROUP_ORDER = ["", "Data", "Display", "Segmentation", "Geometry"];

export interface PanelSpec {
  id: string;
  title: string;
  /** Called once, the first time the panel is shown; the element persists (hidden when another panel is active). */
  mount(el: HTMLElement, shell: AppShell): void | Promise<void>;
  /** Called every time the panel becomes active (refresh lists, etc.). */
  onShow?(el: HTMLElement): void;
  /**
   * Where this module is filed. `""` is the pinned top section; a name is a heading.
   *
   * A LIST, because a module can be both — Data is pinned and also belongs under Files, and saying
   * so twice would mean registering it twice. Slicer does exactly this (`Data` declares `""` and
   * `Informatics`), and it is the part of its design worth taking: the top section is a flag a
   * module raises about itself, not a second list somebody maintains.
   *
   * The heading list is closed on purpose (see docs/module-list-organization.md): a group names the
   * TASK a person is doing, and nothing else. Not who shipped the module, not how mature it is --
   * those are properties. Slicer expresses maturity as a category and therefore needs
   * `Legacy.Segmentation` alongside `Segmentation`, which is the failure this avoids.
   */
  groups?: string[];
  order?: number;           // order WITHIN the group (lower first); default = alphabetical
  /** One line on the module's row in the menu, for someone who does not know the name. */
  tip?: string;
  /**
   * What this module is, and what it is built on.
   *
   * Ron: "There should be a button for help and acknowledgments for the user to click on. Each
   * module should have this." It is Slicer's own convention -- every module there opens with a
   * collapsed "Help & Acknowledgment" -- and it is not decoration here: acknowledgment is, in
   * Ron's words, "the difference between stealing and leveraging". A module standing on someone
   * else's work says so where the person using it can see, not only in a commit message.
   *
   * `help` is what the module does. `acknowledgements` are the people and projects it rests on, one
   * entry each, with a DOI where a paper exists.
   */
  help?: string;
  acknowledgements?: string[];
}

export interface AppShell {
  root: HTMLElement;
  sidebar: HTMLElement;     // the panel column
  toolbar: HTMLElement;     // above the views: layout picker, view controllers' global toggles, etc.
  main: HTMLElement;        // the view area (position: relative; children absolutely placed)
  statusEl: HTMLElement;
  registerPanel(spec: PanelSpec): void;
  showPanel(id: string): Promise<void>;
  activePanel(): string | null;
  panels(): PanelSpec[];
  setStatus(text: string): void;
  /**
   * A modal question. Resolves true if the person accepted.
   *
   * Added for the license notice that has to appear BEFORE a segmentation runs (Ron: "The license
   * conditions should jump up when someone clicks the segment button"), and written to be reusable
   * because the other thing this application owes a confirmation is deletion.
   *
   * `body` is HTML because the license has structure — clauses and a link — and a link that cannot
   * be clicked is not the link Ron asked for. Nothing untrusted is passed to it: every caller in
   * this repo supplies its own literal text.
   */
  /**
   * A question with two answers. `destructive: true` says the OK answer loses or removes
   * something: then the CANCEL answer is the yellow one and answers Return, and OK is the red
   * outline (PALETTE.md: "the yellow is never destructive"; critic 2026-09-22, 2.4).
   */
  confirm(opts: { title: string; body: string; ok?: string; cancel?: string; destructive?: boolean }): Promise<boolean>;
  /** A question with a text answer, in the page: `prompt()` returns null in the app's webview (critic 2026-09-22, 2.8). */
  prompt(opts: { title: string; body?: string; value?: string; ok?: string; placeholder?: string }): Promise<string | null>;
  /**
   * A NOTICE THAT DOES NOT STOP YOU. The job paradigm (docs/CONSTRAINTS.md): a result lands in
   * the scene by itself, the user is told once, where they are, and the notice offers what to do
   * about it -- it steals no focus, changes no module, blocks nothing, and needs no
   * acknowledgment. It sits at the top right of the views until acted on or closed; several
   * stack. Returns a function that removes it.
   */
  notify(opts: { title: string; body?: string; actions?: { label: string; primary?: boolean; busyLabel?: string; doneLabel?: string; failedLabel?: string; onClick: () => void | Promise<unknown> }[]; /** Leaves on its own after this many ms -- for a card that only confirms (a save, a load); a card with a question stays. */ ttl?: number;
    /** Its buttons OFFER something and ask nothing: it leaves after `ttl` like a confirmation (the colors after a load). */ offerOnly?: boolean }): () => void;
  /** Register a callback for main-area size changes (also called once on registration). */
  onMainResize(fn: (rect: DOMRect) => void): () => void;
  /** Add a toolbar button (returns the element). */
  toolButton(label: string, onClick: () => void, opts?: { title?: string; icon?: string; group?: string }): HTMLButtonElement;
  setSidebarVisible(v: boolean): void;
  /**
   * A section: a header on chrome over a body in the well, with a colored band.
   *
   * The shell owns this so modules cannot each invent one and drift apart. Returns the BODY to fill;
   * the caller never touches the header. `band` takes one of Slicer's view colors by name, which is
   * the analogy Ron drew — a slice controller identifies its view with a colored title bar, and a
   * section identifies itself the same way.
   */
  section(parent: HTMLElement, title: string, opts?: {
    open?: boolean;
    note?: string;
    /** The three slice colors, the 3D view's blue, or the callout orange. */
    band?: "red" | "yellow" | "green" | "3d" | "orange" | "none";
  }): HTMLElement;
  /** A row in the one grammar: label, control, value. Returns the control cell to fill. */
  row(parent: HTMLElement, label: string, opts?: { value?: string; wide?: boolean }): HTMLElement;
  /** A right-justified action row, because a left-aligned one sits under the label column. */
  actions(parent: HTMLElement): HTMLElement;
  /**
   * A list of more than a few options, searchable -- Ron: "we might reuse whenever a list of more
   * than a few pops up," with the future Segmentations module's structure catalog in mind. Not a
   * native `<select>` with a filter beside it: "The search is not part of the popup" -- a native
   * popup is OS-drawn, so nothing of ours can live inside it. This is the shell's own popup instead:
   * a button showing the current value, and on click, a panel anchored under it with the filter as
   * its first line and the matching options below. The shell owns opening, closing (click-away,
   * Escape) and the list; a module gets this by calling one function every render rather than by
   * copying ai-seg-panel.ts's task picker.
   *
   * State is the caller's, passed in fresh each render -- the same contract as `section`'s `open`,
   * so a full re-render (this shell's own pattern everywhere) never has to guess what should persist.
   */
  searchablePicker(parent: HTMLElement, opts: {
    /**
     * `group` files an option under a heading; omitted means the ungrouped section, which is drawn
     * FIRST and without a heading. `search` is extra text the filter matches but never shows -- for
     * modules it is the Help & Acknowledgment prose, so "nnU-Net" finds AI segmentations without
     * anyone maintaining a keyword list (Slicer's `FullTextSearchRole`, same idea).
     */
    options: { value: string; label: string; group?: string; search?: string; tip?: string }[];
    /** Heading order. Anything not named here follows, alphabetically. */
    groupOrder?: string[];
    selected?: string;
    open: boolean;
    filter: string;
    placeholder?: string;
    emptyLabel?: string;
    onOpenChange(open: boolean): void;
    onFilterChange(filter: string): void;
    onSelect(value: string): void;
  }): void;
}

/**
 * Run a button's action with feedback the user can actually see.
 *
 * THE PAINT IS THE POINT. Both of the buttons Ron reported as dead already changed state -- the AI
 * panel's Segment button becomes "Segmenting…" and disables itself, Save writes "exporting…" -- and
 * neither change ever reached the screen, because the very next thing each did was start a long
 * synchronous stretch (writing a 768 x 768 x 709 volume; packing a 900 MB SEG) that monopolised the
 * main thread before the browser could repaint. The state was right and invisible, which from the
 * outside is indistinguishable from a button that does nothing. Ron: "I click the blue Segment
 * button. Nothing happens."
 *
 * So this yields until the busy state has actually been painted before calling `run`. Everything
 * else here -- the disable, the label, the done/failed flash -- is the part that makes every
 * executing button in the app look and behave the same, which is the generalization Ron asked for:
 * "All buttons of this kind should look and behave the same."
 */
export async function runAction<T>(
  btn: HTMLButtonElement,
  run: () => Promise<T> | T,
  /**
   * `doneLabel` is what the button SAYS when it worked -- "Saved", not a green edge for a second and
   * a half. Ron: "How do I know things were saved successfully? When I save it changes to saving and
   * then changes back to save. Not Save successful or something similar." A color cue is a cue only
   * if you already know to look for it.
   */
  opts: { busyLabel?: string; doneLabel?: string; failedLabel?: string } = {},
): Promise<T | undefined> {
  if (btn.dataset.slBusy === "1") return undefined;       // a second click while it runs is not a queue
  // THE WORD THE BUTTON HAD BEFORE ANY OF THIS, kept on the element itself. Reading it from the
  // button at the start of each press was wrong the moment a press failed: the failure word stayed
  // (nothing restored it), so the next press read "Not saved" as the button's own label and a save
  // that WORKED went back to saying "Not saved" four seconds later. Found by the critic,
  // 2026-09-22 (1.2), measured with this function in a browser.
  const label = btn.dataset.slLabel ?? btn.textContent ?? "";
  btn.dataset.slLabel = label;
  const wasDisabled = btn.disabled;
  let done = false, failed = false;
  btn.dataset.slBusy = "1";
  btn.classList.remove("sl-action-done", "sl-action-failed");
  btn.classList.add("sl-action-busy");
  btn.disabled = true;
  btn.textContent = opts.busyLabel ?? `${label}…`;
  // Two frames: one to lay the change out, one to be sure it has been presented. A hidden tab never
  // animates, so the timeout is the escape hatch -- without it a background export would hang here.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 120);
  });
  try {
    const r = await run();
    btn.classList.add("sl-action-done");
    done = true;
    return r;
  } catch (e) {
    btn.classList.add("sl-action-failed");
    failed = true;
    throw e;
  } finally {
    btn.classList.remove("sl-action-busy");
    btn.disabled = wasDisabled;
    // The word stays a beat longer than the color, because the word is the message -- and a
    // failure says so in the same place ("Not saved"), for as long as a success would have said
    // "Saved" (critic 2026-09-22, 2.1: a swallowed error read "Saved ✓").
    btn.textContent = failed ? (opts.failedLabel ?? label) : done && opts.doneLabel ? opts.doneLabel : label;
    delete btn.dataset.slBusy;
    setTimeout(() => {
      btn.classList.remove("sl-action-done", "sl-action-failed");
      // Whatever it said -- the done word or the failure word -- the button goes back to being a
      // button that offers to do the thing. A failure word left standing is a lie about the NEXT
      // press as much as about this one.
      if (btn.textContent === opts.doneLabel || btn.textContent === opts.failedLabel) btn.textContent = label;
    }, done && opts.doneLabel ? 4000 : 2600);
  }
}

export interface ShellOptions {
  /** Whether to reopen the module that was open last time (Settings › General). Default: yes. */
  restoreModule?: () => boolean;
  title?: string;
  sidebarWidth?: number;    // px, default 400 -- Ron measured his own adjusted width with Cmd-Shift-4
  container?: HTMLElement;  // defaults to `root` itself being filled
}

/** A 2×2 FourUp arrangement over `rect` (viewport coords), the standalone default until the layout engine (W2). */
export function fourUpCells(rect: DOMRect): { id: string; kind: "slice" | "3d"; name: string; view: { x: number; y: number; w: number; h: number } }[] {
  const gap = 2, w = (rect.width - gap) / 2, h = (rect.height - gap) / 2;
  const cell = (name: string, kind: "slice" | "3d", col: number, row: number) => ({ id: name, kind, name, view: { x: rect.left + col * (w + gap), y: rect.top + row * (h + gap), w, h } });
  return [cell("Red", "slice", 0, 0), cell("1", "3d", 1, 0), cell("Yellow", "slice", 0, 1), cell("Green", "slice", 1, 1)];
}

/**
 * WHICH BUILD IS ACTUALLY RUNNING, compiled into the bundle by the rebuild script.
 *
 * The app is a "thin" one: it serves files from disk, so the files can be rebuilt while a window
 * stays open on the JS it loaded minutes or hours ago. Nothing on screen distinguished the two, and
 * it cost real time -- a fix was verified as landed, Ron ran a window that predated it, and the
 * next two rounds of debugging were about a bug that was already gone. He asked for this directly:
 * "would it make sense to add and display a version number so we don't repeat the stale version
 * problem?"
 *
 * Deliberately baked in with --define rather than fetched at runtime: the number has to describe
 * THIS JavaScript, and anything read from the server at runtime would describe the disk instead --
 * which is exactly the thing that was already misleading.
 */
// The build stamp and versioned worker URLs live in render/build-id.ts, which has no DOM in it.
export { BUILD_ID, workerUrl } from "../build-id.ts";
import { BUILD_ID } from "../build-id.ts";

/**
 * Make every link under `root` open OUTSIDE the application.
 *
 * In the native shell there is no browser chrome to come back from, so a bare `<a href>` navigates
 * the app away from itself and the only way back is relaunching. The `/_open` route hands the URL to
 * the system browser; `window.open` is the fallback when the page is being served without that route.
 *
 * Applied to the Help & Acknowledgment body as well as to modals, because that body has carried
 * external links since the first acknowledgments were written -- the haversack and paper links in
 * the AI segmentation module among them -- and none of them was wired.
 */
/**
 * Does this link leave the application?
 *
 * ORIGIN, not scheme. `a.href` is the RESOLVED absolute URL, so `<a href="?legacy">` reads back as
 * `http://localhost:PORT/slicer-app.html?legacy` and a `/^https?:/` test calls it external -- which
 * would hand the app's own legacy mode to the system browser. The test that was here did exactly
 * that; it never fired only because no link inside a modal or the help body happened to be
 * relative. Comparing origins gets `?legacy`, `#anchors` and absolute in-app URLs all right.
 */
export function isExternalHref(href: string, pageUrl: string): boolean {
  try {
    const page = new URL(pageUrl);
    const u = new URL(href, page);
    return /^https?:$/i.test(u.protocol) && u.origin !== page.origin;
  } catch {
    return false;
  }
}

const isExternal = (a: HTMLAnchorElement) => isExternalHref(a.getAttribute("href") ?? "", location.href);

function openExternally(root: HTMLElement) {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = (a as HTMLAnchorElement).href;
    if (!isExternal(a as HTMLAnchorElement)) return;
    a.setAttribute("rel", "noopener");
    a.addEventListener("click", (e) => {
      e.preventDefault();
      fetch(`/_open?url=${encodeURIComponent(href)}`).catch(() => globalThis.open?.(href, "_blank"));
    });
  });
}

export function mountAppShell(root: HTMLElement, opts: ShellOptions = {}): AppShell {
  const sidebarWidth = opts.sidebarWidth ?? 400;
  root.classList.add("sl-app");
  root.innerHTML = `
    <div class="sl-top">
      <div class="sl-brand"><span class="sl-brand-mark"></span><span class="sl-brand-name">${opts.title ?? "SlicerLive"}</span></div>
      <div class="sl-modules"><label class="sl-modules-label">Modules:</label><div class="sl-module-picker"></div></div>
      <div class="sl-scene-zone" title=""></div>
      <div class="sl-toolbar" role="toolbar"></div>
    </div>
    <div class="sl-body">
      <aside class="sl-sidebar" style="width:${sidebarWidth}px"><div class="sl-panels"></div></aside>
      <div class="sl-splitter" role="separator" aria-orientation="vertical"></div>
      <div class="sl-main"></div>
    </div>
    <div class="sl-status-splitter" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
    <div class="sl-statusbar">
      <div class="sl-status" role="status"></div>
      <div class="sl-build" title="The build this window is running. If it does not match the last rebuild, reload.">${BUILD_ID}</div>
    </div>`;
  const $ = (sel: string) => root.querySelector(sel) as HTMLElement;
  const sidebar = $(".sl-sidebar"), panelsEl = $(".sl-panels"), toolbar = $(".sl-toolbar"), main = $(".sl-main"), statusEl = $(".sl-status");
  // THE VIEWS NEVER START A BROWSER DRAG. Nothing in them is meant to be dragged out as page
  // content, and a drag started there -- of a selection the press happened to land on -- takes the
  // mouse away from the view until it ends (Ron, 2026-09-23: the whole window ghosting along with
  // the pointer, and the 3D view left rotating). Dropping files onto the views is unaffected: that
  // is `dragover`/`drop` from outside, not `dragstart` from inside.
  main.addEventListener("dragstart", (e) => e.preventDefault());

  // EXTERNAL LINKS IN MODULE PANELS, handled once for the whole column.
  //
  // Same problem openExternally() solves below and the same fix, but a listener on the container
  // rather than a pass over the anchors, because MODULES REBUILD THEMSELVES: most of them assign
  // `root.innerHTML` on every render, so anchors wired at mount time are gone by the second render
  // and any wiring has to be redone by whoever remembers. Delegation cannot go stale -- a link
  // written into a panel five renders from now is covered by the listener that is already here.
  //
  // What it prevents: in the native shell there is no browser chrome, so a bare <a href> navigates
  // the app away from itself and the only way back is relaunching it.
  panelsEl.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !panelsEl.contains(a) || !isExternal(a)) return;
    e.preventDefault();
    fetch(`/_open?url=${encodeURIComponent(a.href)}`).catch(() => globalThis.open?.(a.href, "_blank"));
  });

  // EVERY BUTTON ACKNOWLEDGES THE CLICK, WHATEVER IT GOES ON TO DO.
  //
  // Ron, 2026-09-22, having pressed Save to DICOM and seen nothing move: "If I click them they
  // should give me immediate visual feedback. This requirement is for every button that can be
  // clicked." It is a requirement about ALL of them, so it is answered once, here, rather than by
  // remembering it at a hundred and seventy click handlers -- and a button written into a panel
  // five renders from now is covered by the listener that is already installed.
  //
  // POINTERDOWN, NOT CLICK: the acknowledgment has to be on the press, before the handler runs and
  // whatever it does. `:active` alone is not enough -- it lasts only while the button is held, and a
  // handler that then works for two seconds leaves the button looking untouched. This paints for a
  // fixed beat instead, so a quick tap is visible too.
  //
  // It says "heard", not "done": what the work came to is the busy/done label runAction writes, the
  // panel's own redraw, or the status line. This is the first of the three and the only one that is
  // free.
  const hitTimers = new WeakMap<Element, number>();
  const acknowledge = (el: Element | null | undefined) => {
    if (!el || (el as HTMLButtonElement).disabled) return;
    // A SECOND PRESS INSIDE THE BEAT GETS ITS OWN BEAT. The first version kept no handle, so the
    // timer from press 1 fired during press 2 and cut it to whatever was left -- on the ▲▼ ordering
    // buttons, the ◐ column and the transport, which are pressed in quick succession, that is most
    // of them (critic 2026-09-22, 2.4).
    clearTimeout(hitTimers.get(el));
    el.classList.remove("sl-hit");
    void (el as HTMLElement).offsetWidth;     // restart the paint, not continue the old one
    el.classList.add("sl-hit");
    hitTimers.set(el, setTimeout(() => el.classList.remove("sl-hit"), 220));
  };
  // `[role=button]` as well as `button`: the four arrows of the Load / Save graph are SVG groups,
  // and they are the front door of that module (critic 2.6).
  const pressed = (e: Event) => (e.target as HTMLElement | null)?.closest?.("button, [role=button]");

  // A CLICK THAT DOES NOTHING: WAS THE WINDOW EVEN IN FRONT?
  //
  // Ron, 2026-09-22, build 18:38: "I clicked once with the mouse. Nothing happened. I waited a
  // while and clicked once again, it started loading ... my mouse has tactile feedback, so I know
  // that each time I clicked precisely once." It could not be reproduced in a browser, and the
  // difference that matters is one this page cannot see afterwards: on macOS the first click into a
  // window that is not frontmost is spent activating it, and never reaches the page at all.
  //
  // So the page writes down what it CAN see: when it was activated, and the first button pressed
  // after that, with the gap. Two lines per application switch, and next time it happens the log
  // says whether the lost click was the activation or something the application did wrong.
  //
  // ONCE PER SESSION, NOT FOREVER. Two lines in the session log per application switch is noise
  // after the question is answered, and there was no way to turn it off (critic, 2026-09-22,
  // finding 11). The first activation and the first press after it are written; the rest are
  // counted and said at the end only if the question comes back.
  let activatedAt = 0, pressSinceActivation = false, activations = 0;
  const note = (m: string) => { try { void fetch("/_log", { method: "POST", body: m, keepalive: true }).catch(() => {}); } catch { /* no server */ } };
  globalThis.addEventListener("focus", () => {
    activatedAt = Date.now();
    pressSinceActivation = false;
    if (++activations <= 1) note("window activated (a click that activates a macOS window never reaches the page; said once per session)");
  });
  document.addEventListener("pointerdown", (e) => {
    const b = pressed(e);
    if (!b || pressSinceActivation || !activatedAt || activations > 1) return;
    pressSinceActivation = true;
    note(`first press after activation: "${(b.textContent ?? "").trim().slice(0, 40)}", ${((Date.now() - activatedAt) / 1000).toFixed(1)} s after the window came forward`);
  }, true);

  document.addEventListener("pointerdown", (e) => acknowledge(pressed(e)), true);

  // SELECT ALL SELECTS WHERE YOU ARE. Ron, 2026-09-23: "why does cmd A in the text on the bottom also
  // capture the text in the module?" Because a browser's Select All takes everything selectable on the
  // page, and both the status line and the module panels are selectable on purpose (so a message can
  // be copied). An application's Select All means "all of this": so it selects the text of the region
  // last clicked in -- the status line, or the module panel -- and nothing when that was a button or a
  // view. A text field keeps its own Select All.
  let selectRegion: Element | null = null;
  document.addEventListener("pointerdown", (e) => {
    selectRegion = (e.target as Element | null)?.closest?.(".sl-status, .sl-panel") ?? null;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "a") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (!selectRegion || !selectRegion.isConnected) return;
    const r = document.createRange();
    r.selectNodeContents(selectRegion);
    sel.addRange(r);
  }, true);
  // AND FROM THE KEYBOARD. Space and Enter never fire a pointer event in any engine, so a button
  // reached with Tab was acknowledged by nothing at all -- and "every button that can be clicked"
  // is every button in the shell (critic 2.2).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const el = (e.target as HTMLElement | null)?.closest?.("button, [role=button]");
    if (el) acknowledge(el);
  }, true);

  const modulePicker = $(".sl-module-picker");
  // THE MODULE LIST IS THE SAME SEARCHABLE PICKER as the AI panel's network list.
  //
  // It was a native <select>, whose popup macOS places OVER the current item -- so it opened
  // upwards or downwards depending on where the window sat, and upwards is unusable when the window
  // is near the top of the screen. Our own popup always opens downward (flipping only when there is
  // genuinely no room), and it comes with the filter this list will need as modules are added. Ron:
  // "The popup ... goes sometimes up and sometimes down ... Eventually we will have enough modules
  // that we need a search function. Use the element that you developed for the AI segmentation
  // model selection."
  let modulePickerOpen = false, moduleFilter = "";
  const splitter = $(".sl-splitter");
  const statusSplitter = $(".sl-status-splitter");

  const specs: PanelSpec[] = [];
  const els = new Map<string, HTMLElement>();
  const mounted = new Set<string>();
  let active: string | null = null;

  const rebuildSelect = () => {
    // One entry per (module, group) pair, so a module in two groups appears in both without being
    // registered twice. A module with no `groups` is pinned, which keeps every existing
    // registration working unchanged.
    const entries = specs.flatMap((s) => (s.groups?.length ? s.groups : [""]).map((g) => ({ s, g })));
    entries.sort((a, b) =>
      (GROUP_ORDER.indexOf(a.g) < 0 ? 1e9 : GROUP_ORDER.indexOf(a.g)) -
        (GROUP_ORDER.indexOf(b.g) < 0 ? 1e9 : GROUP_ORDER.indexOf(b.g)) ||
      a.g.localeCompare(b.g) ||
      (a.s.order ?? 1e9) - (b.s.order ?? 1e9) ||
      a.s.title.localeCompare(b.s.title)                    // alphabetical by default, as Slicer is
    );
    modulePicker.innerHTML = "";
    shell.searchablePicker(modulePicker, {
      groupOrder: GROUP_ORDER,
      options: entries.map(({ s, g }) => ({
        value: s.id,
        label: s.title,
        group: g || undefined,
        tip: s.tip,
        // What the filter can see but the row never shows. This is text we already write for every
        // module, so "dicom" or "nnU-Net" finds the right one with no keyword list to maintain.
        search: [s.id, s.help ?? "", ...(s.acknowledgements ?? [])].join(" "),
      })),
      selected: active ?? entries[0]?.s.id,
      open: modulePickerOpen,
      filter: moduleFilter,
      placeholder: "",                            // the magnifying glass says it; Ron: "replace the 'find a module' with the magnifying glass icon"
      onOpenChange: (open) => { modulePickerOpen = open; if (!open) moduleFilter = ""; rebuildSelect(); },
      onFilterChange: (f) => { moduleFilter = f; rebuildSelect(); },
      onSelect: (v) => { modulePickerOpen = false; moduleFilter = ""; rebuildSelect(); void showPanel(v); },
    });
  };

  /**
   * Append a collapsed "Help & Acknowledgment" to a panel.
   *
   * A <details> rather than our own disclosure widget: it is keyboard-accessible, it is what a
   * screen reader expects, and it needs no state of ours. Appended after the module's content
   * because it is reference rather than a control -- Slicer puts it first, but Slicer's panels are
   * not scrolled as far as these.
   */
  function addHelp(el: HTMLElement, spec: PanelSpec) {
    const d = document.createElement("details");
    d.className = "sl-help";
    const sum = document.createElement("summary");
    sum.textContent = "Help & Acknowledgment";
    d.appendChild(sum);

    const body = document.createElement("div");
    body.className = "sl-help-body";
    body.innerHTML = (spec.help ?? `<p>${spec.title}.</p>`) +
      (spec.acknowledgements?.length
        ? `<h4>Acknowledgments</h4><ul>${spec.acknowledgements.map((a) => `<li>${a}</li>`).join("")}</ul>`
        : "") +
      // Every module, whatever else it says: what this application is, whose work it stands on, and
       // who wrote it. Ron's wording, both lines. haversack joins the other two because every
       // segmentation the application offers is reached through it -- it is a foundation here, not a
       // feature of one module.
       //
       // NOT copied from Slicer's own acknowledgment(): that string continues with a funder list
       // which is stale. See docs/CONSTRAINTS.md.
       //
       // AND NO TRADEMARK NOTICE. There was one, and Ron cut it: "why referring to the trademark at
       // all if we are not using it?" Naming the projects this is built on is nominative use -- it
       // asks for attribution, which is what these three links are, not for a notice. The Slicer
       // logo was in the toolbar once and is not any more, so the last reason to mention a mark is
       // gone with it. Slicer's own docs ask for permission, not for a line in anyone's UI, and
       // SlicerLive's README carries none. The permission question, which is real and is Ron's to
       // answer, is recorded in the workspace README where the people who need it will look.
      `<h4>SlicerAlbula</h4><p>Built on
       <a href="https://github.com/pieper/SlicerLive"><b>SlicerLive</b></a>,
       <a href="https://github.com/Slicer/Slicer"><b>3D Slicer</b></a>, and
       <a href="https://github.com/mhalle/haversack"><b>haversack</b></a>.</p>
       <p>Ron Kikinis. Written with AI assistance (Claude, Anthropic) under human direction and
       review.</p>
       <p class="sl-hint">Build <b>${BUILD_ID}</b></p>`;
    openExternally(body);
    d.appendChild(body);
    el.appendChild(d);
  }

  /** id -> the shell's <section>; `els` holds the module's own container inside it. */
  const sections = new Map<string, HTMLElement>();

  async function showPanel(id: string) {
    const spec = specs.find((s) => s.id === id);
    if (!spec) return;
    let el = els.get(id);
    if (!el) {
      // TWO ELEMENTS, and the reason matters: the section is the shell's, the inner div is the
      // module's. Help & Acknowledgment was first appended to the section a module was handed
      // directly, and vanished on the next render -- a panel that rebuilds itself with
      // `root.innerHTML = ...` wipes anything the shell put beside its content, which is most of
      // them. So the module gets a container it owns and can clear freely, and the help lives
      // outside it as a sibling.
      const section = document.createElement("section");
      section.className = "sl-panel";
      section.dataset.panel = id;
      section.hidden = true;
      const content = document.createElement("div");
      content.className = "sl-panel-content";
      section.appendChild(content);
      addHelp(section, spec);
      panelsEl.appendChild(section);
      sections.set(id, section);
      el = content;
      els.set(id, el);
    }
    for (const [pid, sec] of sections) sec.hidden = pid !== id;
    active = id; rebuildSelect();
    if (!mounted.has(id)) { mounted.add(id); await spec.mount(el, shell); }
    spec.onShow?.(el);
    try { localStorage.setItem("sl.activePanel", id); } catch { /* private mode */ }
  }

  // Sidebar splitter drag.
  //
  // Ron: "The right border is grabbable but does not move." The cursor changed, so the hit test was
  // fine; the drag was not. Two causes, both fixed here.
  //
  // The move and up handlers were bound on the SPLITTER, which only works while pointer capture
  // holds. If setPointerCapture fails or the capture is lost -- and a webview will drop it -- the
  // pointer moves away from a 5 px element and no further events arrive, so `dragging` stays true
  // and nothing moves. Binding on the window instead is what the transfer-function editor already
  // does, and it does not depend on capture at all.
  //
  // And the ceiling was 640 px, which a segment table cannot live inside. It is now most of the
  // window, since the person dragging can see how much room they are leaving themselves.
  let dragging = false;
  const applyWidth = (clientX: number) => {
    const left = root.getBoundingClientRect().left;
    const max = Math.max(320, root.getBoundingClientRect().width - 320);   // always leave a view
    sidebar.style.width = Math.max(200, Math.min(max, clientX - left)) + "px";
    // No manual resize notification: a ResizeObserver on .sl-main below already watches this, and
    // calling resizeFns from here would also reach it before it is declared.
  };
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { splitter.setPointerCapture(e.pointerId); } catch { /* capture is a bonus, not the mechanism */ }
    // Any selection made before user-select took hold stays highlighted, which is the blue wash Ron
    // saw over the views. Clear it as the drag starts.
    try { globalThis.getSelection?.()?.removeAllRanges(); } catch { /* not fatal */ }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  globalThis.addEventListener("pointermove", (e) => { if (dragging) applyWidth((e as PointerEvent).clientX); });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  globalThis.addEventListener("pointerup", endDrag);
  globalThis.addEventListener("pointercancel", endDrag);

  // Status bar resize -- Ron: "the text at the bottom of the main window looks untidy. It should
  // have its own resizable, copyable space." Copyable was already true (user-select: text, further
  // down); untidy was a single fixed-height line with nowhere for a long timing readout to go but
  // overflow. Same drag pattern as the sidebar splitter above, vertical instead of horizontal.
  let statusDragging = false;
  const applyStatusHeight = (clientY: number) => {
    const bottom = root.getBoundingClientRect().bottom;
    const max = root.getBoundingClientRect().height * 0.6;   // leave most of the window to the views
    statusEl.style.height = Math.max(22, Math.min(max, bottom - clientY)) + "px";
  };
  statusSplitter.addEventListener("pointerdown", (e) => {
    statusDragging = true;
    try { statusSplitter.setPointerCapture(e.pointerId); } catch { /* capture is a bonus, not the mechanism */ }
    try { globalThis.getSelection?.()?.removeAllRanges(); } catch { /* not fatal */ }
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  globalThis.addEventListener("pointermove", (e) => { if (statusDragging) applyStatusHeight((e as PointerEvent).clientY); });
  const endStatusDrag = () => {
    if (!statusDragging) return;
    statusDragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // REMEMBERED, because it is a reading preference and not a per-session accident. Ron: "Does the
    // size of the text window at the bottom get preserved? It would be helpful." It did not -- every
    // launch reset it to one line, so anyone who wants to watch the log had to drag it open again on
    // every start, which is exactly the sort of thing that stops people watching the log.
    try { localStorage.setItem("sl.statusHeight", statusEl.style.height || ""); } catch { /* private mode */ }
  };
  globalThis.addEventListener("pointerup", endStatusDrag);
  globalThis.addEventListener("pointercancel", endStatusDrag);

  // Restore the remembered height before the first paint, clamped in case the window is now smaller
  // than it was when the height was saved.
  try {
    const saved = parseFloat(localStorage.getItem("sl.statusHeight") ?? "");
    if (Number.isFinite(saved) && saved > 22) {
      const cap = Math.max(22, (globalThis.innerHeight || 800) * 0.6);
      statusEl.style.height = Math.min(saved, cap) + "px";
    }
  } catch { /* private mode: the default one-line status is fine */ }

  const resizeFns = new Set<(r: DOMRect) => void>();
  const ro = new ResizeObserver(() => { const r = main.getBoundingClientRect(); for (const fn of resizeFns) fn(r); });
  ro.observe(main);

  let restoreTimer: number | null = null, restoredOnce = false;
  // Settings › General › "Open the module I was in": read at the moment of restoring, so the
  // setting written by the dialog counts at the next launch without a plumbing change here.
  const restoreModule = () => opts.restoreModule?.() ?? true;
  const shell: AppShell = {
    root, sidebar, toolbar, main, statusEl,
    registerPanel(spec) {
      if (specs.some((s) => s.id === spec.id)) throw new Error(`panel ${spec.id} already registered`);
      specs.push(spec); rebuildSelect();
      if (!active) { let last: string | null = null; try { last = localStorage.getItem("sl.activePanel"); } catch { /* */ } void showPanel(last && specs.some((s) => s.id === last) ? last : spec.id); }
      // THE REMEMBERED MODULE, ONCE THE PANELS ARE ALL THERE. The line above acts only on the FIRST
      // registration, when `specs` holds Welcome alone, so a remembered panel other than Welcome
      // failed its check and every launch landed on Welcome (recorded in CLAUDE.md for weeks). Now:
      // after the registrations settle (a microtask later than the last one), if the person asked
      // for it in Settings › General (on by default) and the module still exists, open it.
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        if (restoredOnce || !restoreModule()) return;
        restoredOnce = true;
        let last: string | null = null; try { last = localStorage.getItem("sl.activePanel"); } catch { /* */ }
        if (last && last !== active && specs.some((s) => s.id === last)) void showPanel(last);
      }, 0);
    },
    showPanel, activePanel: () => active, panels: () => [...specs],
    setStatus(text) {
      statusEl.textContent = text;
      // AND KEEP IT. The status bar holds one line and every message overwrites the last, so
      // anything said during a load is gone by the time the load finishes -- which is how the load
      // timer became unreadable the day it was added. Mirrored to the session log
      // (desktop/session-log.ts), which is reset at each start and keeps one previous session.
      // Fire-and-forget on purpose: a page that cannot log must still work, and there is nothing a
      // user could do about a failure here.
      try {
        void fetch("/_log", { method: "POST", body: text, keepalive: true }).catch(() => {});
      } catch { /* no fetch, file:// page, or a server that is not ours */ }
    },
    notify(opts) {
      let host = root.querySelector(".sl-notices") as HTMLElement | null;
      if (!host) { host = document.createElement("div"); host.className = "sl-notices"; root.appendChild(host); }
      const card = document.createElement("div");
      card.className = "sl-notice";
      const h = document.createElement("div");
      h.className = "sl-notice-title";
      h.textContent = opts.title;
      const x = document.createElement("button");
      x.className = "sl-notice-close";
      x.title = "Close this notice (the result stays where it is)";
      x.textContent = "×";
      const head = document.createElement("div");
      head.className = "sl-notice-head";
      head.append(h, x);
      card.appendChild(head);
      if (opts.body) { const b = document.createElement("div"); b.className = "sl-notice-body"; b.innerHTML = opts.body; card.appendChild(b); openExternally(b); }
      const remove = () => { card.remove(); if (host && !host.childElementCount) host.remove(); };
      if (opts.actions?.length) {
        const row = document.createElement("div");
        row.className = "sl-row sl-notice-actions";
        for (const a of opts.actions) {
          const b = document.createElement("button");
          if (a.primary) b.className = "sl-primary";
          // The dismissals are the text-only rank: they cost nothing to press (PALETTE.md, Buttons; critic 2.10).
          else if (/^(later|cancel|no thanks|not now|ok|close)$/i.test(a.label.trim())) b.className = "sl-quiet";
          b.textContent = a.label;
          // A NOTICE'S BUTTON THAT STARTS WORK KEEPS ITS CARD UNTIL THE WORK IS DONE.
          //
          // The card used to be removed BEFORE the action ran, so the job-done notice's "Save to
          // DICOM" -- a thirty-to-sixty-second save -- took the button away with it and reported
          // only into the status line. That is the complaint this whole rule came from, on the one
          // button Ron asked for by name (critic 2026-09-22, 1.1).
          //
          // Which behavior applies is decided by the action itself: one that RETURNS A PROMISE is
          // work, and its card stays, its button says "…" and then how it went, and the card leaves
          // once it has been read. Everything else (Later, OK, Show in …) dismisses at once, as
          // before.
          b.addEventListener("click", () => {
            const r = a.onClick() as unknown;
            if (!r || typeof (r as Promise<unknown>).then !== "function") { remove(); return; }
            void runAction(b, () => r as Promise<unknown>, {
              busyLabel: a.busyLabel ?? `${a.label}…`,
              doneLabel: a.doneLabel ?? "Done ✓",
              failedLabel: a.failedLabel ?? "Failed",
            }).then(() => setTimeout(remove, 2600)).catch(() => {});
          });
          row.appendChild(b);
        }
        card.appendChild(row);
      }
      x.addEventListener("click", remove);
      // A confirmation leaves by itself; ten of them once covered the 3D view (critic, 2026-09-20).
      if (opts.ttl && (!opts.actions?.length || opts.offerOnly)) setTimeout(remove, opts.ttl);
      host.appendChild(card);
      return remove;
    },
    confirm(opts) {
      return new Promise<boolean>((resolve) => {
        const back = document.createElement("div");
        back.className = "sl-modal-back";
        const box = document.createElement("div");
        box.className = "sl-modal";
        const h = document.createElement("h3");
        h.textContent = opts.title;
        const body = document.createElement("div");
        body.className = "sl-modal-body";
        body.innerHTML = opts.body;
        const row = document.createElement("div");
        row.className = "sl-row sl-modal-actions";
        const cancel = document.createElement("button");
        cancel.textContent = opts.cancel ?? "Cancel";
        const ok = document.createElement("button");
        ok.textContent = opts.ok ?? "Continue";
        // THE SAFE ANSWER IS THE YELLOW ONE. A destructive OK is the red outline; the yellow --
        // the one people press without reading, the one Return answers -- is Keep / Cancel.
        if (opts.destructive) { cancel.className = "sl-primary"; ok.className = "sl-danger"; }
        else { ok.className = "sl-primary"; cancel.className = "sl-quiet"; }
        row.append(cancel, ok);   // yellow at the right end when OK is the yellow; Keep at the right when it is
        if (opts.destructive) row.append(cancel);
        if (opts.cancel === "") cancel.remove();   // a notice with one answer: `cancel: ""` asks for no second button
        box.append(h, body, row);
        back.appendChild(box);
        root.appendChild(back);

        openExternally(body);

        const done = (v: boolean) => { back.remove(); document.removeEventListener("keydown", key); resolve(v); };
        const key = (e: KeyboardEvent) => {
          if (e.key === "Escape") done(false);
          if (e.key === "Enter") done(!opts.destructive);   // Return answers the safe one
        };
        document.addEventListener("keydown", key);
        cancel.addEventListener("click", () => done(false));
        ok.addEventListener("click", () => done(true));
        // Clicking the backdrop cancels; clicking INSIDE must not, or a stray click while reading
        // the terms dismisses them.
        back.addEventListener("mousedown", (e) => { if (e.target === back) done(false); });
        (opts.destructive ? cancel : ok).focus();
      });
    },
    prompt(opts) {
      return new Promise<string | null>((resolve) => {
        const back = document.createElement("div");
        back.className = "sl-modal-back";
        const box = document.createElement("div");
        box.className = "sl-modal";
        const h = document.createElement("h3");
        h.textContent = opts.title;
        const body = document.createElement("div");
        body.className = "sl-modal-body";
        if (opts.body) body.innerHTML = opts.body;
        const input = document.createElement("input");
        input.type = "text"; input.className = "sl-modal-input"; input.value = opts.value ?? ""; input.placeholder = opts.placeholder ?? "";
        body.appendChild(input);
        const row = document.createElement("div");
        row.className = "sl-row sl-modal-actions";
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        const ok = document.createElement("button");
        ok.className = "sl-primary";
        ok.textContent = opts.ok ?? "OK";
        row.append(cancel, ok);
        box.append(h, body, row);
        back.appendChild(box);
        root.appendChild(back);
        const done = (v: string | null) => { back.remove(); document.removeEventListener("keydown", key); resolve(v); };
        const key = (e: KeyboardEvent) => {
          if (e.key === "Escape") done(null);
          if (e.key === "Enter") done(input.value);
        };
        document.addEventListener("keydown", key);
        cancel.addEventListener("click", () => done(null));
        ok.addEventListener("click", () => done(input.value));
        back.addEventListener("mousedown", (e) => { if (e.target === back) done(null); });
        input.focus(); input.select();
      });
    },
    onMainResize(fn) { resizeFns.add(fn); fn(main.getBoundingClientRect()); return () => resizeFns.delete(fn); },
    toolButton(label, onClick, o = {}) {
      const b = document.createElement("button"); b.type = "button"; b.className = "sl-tool"; b.textContent = o.icon ? `${o.icon} ${label}` : label; b.title = o.title ?? label;
      if (o.group) b.dataset.group = o.group;
      b.addEventListener("click", onClick); toolbar.appendChild(b); return b;
    },
    setSidebarVisible(v) { sidebar.style.display = v ? "" : "none"; splitter.style.display = v ? "" : "none"; },
    section(parent, title, o = {}) {
      // <details> rather than a div and a click handler: it is keyboard-operable, a screen reader
      // announces it, and its open state needs no bookkeeping of ours.
      const d = document.createElement("details");
      d.className = "sl-section";
      if (o.open !== false) d.open = true;
      const band = o.band ?? "none";
      if (band !== "none") d.style.setProperty("--sl-band", band === "orange" ? "var(--sl-callout)" : `var(--sl-view-${band})`);
      const sum = document.createElement("summary");
      sum.append(document.createTextNode(title));
      if (o.note) {
        const n = document.createElement("span");
        n.className = "sl-section-note";
        n.textContent = o.note;
        sum.appendChild(n);
      }
      d.appendChild(sum);
      const body = document.createElement("div");
      body.className = "sl-section-body";
      d.appendChild(body);
      parent.appendChild(d);
      return body;
    },
    row(parent, label, o = {}) {
      const r = document.createElement("div");
      r.className = o.wide ? "sl-r sl-r-wide" : "sl-r";
      const l = document.createElement("span");
      l.className = "sl-r-label";
      l.textContent = label;
      const c = document.createElement("span");
      c.className = "sl-r-control";
      r.append(l, c);
      if (!o.wide) {
        const v = document.createElement("span");
        v.className = "sl-r-value";
        v.textContent = o.value ?? "";
        r.appendChild(v);
      }
      parent.appendChild(r);
      return c;
    },
    actions(parent) {
      const a = document.createElement("div");
      a.className = "sl-actions";
      parent.appendChild(a);
      return a;
    },
    searchablePicker(parent, o) {
      const wrap = document.createElement("div");
      wrap.className = "sl-picker";
      const current = o.options.find((x) => x.value === o.selected);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sl-picker-btn";
      btn.textContent = current?.label ?? o.selected ?? "—";
      wrap.appendChild(btn);
      parent.appendChild(wrap);

      if (!o.open) {
        btn.addEventListener("click", () => o.onOpenChange(true));
        return;
      }

      const pop = document.createElement("div");
      pop.className = "sl-picker-pop";
      const input = document.createElement("input");
      input.type = "search";
      input.className = "sl-picker-filter";
      input.placeholder = o.placeholder ?? "";
      input.classList.add("sl-search");
      input.title = "Type to narrow the list";
      input.value = o.filter;
      pop.appendChild(input);

      const list = document.createElement("div");
      list.className = "sl-picker-list";
      const f = o.filter.toLowerCase();
      // The label matches first and the hidden text second, so a title match outranks a mention
      // buried in someone's acknowledgments.
      // NOT `|| x.value === o.selected`: keeping the current item visible under a filter meant the
      // active module appeared in the results of every search, including searches it does not match
      // -- "nnU-Net" returned Welcome. A search should return matches and nothing else.
      const matched = f
        ? o.options.filter((x) => x.label.toLowerCase().includes(f) || (x.search ?? "").toLowerCase().includes(f))
        : o.options;
      // ONE ROW PER MODULE while filtering. A module may be filed in two places -- Data is pinned
      // and also under Files -- which is right in the grouped list and wrong in a flat one, where it
      // read as two identical results. The copy that carries a group wins, so the row can still say
      // where the module lives.
      const shown = !f ? matched : [...new Map(
        matched.map((x) => [x.value, x] as const),           // last wins, and grouped entries sort after pinned
      ).values()].sort((a, b) =>
        Number(b.label.toLowerCase().includes(f)) - Number(a.label.toLowerCase().includes(f))
      );

      const mkRow = (x: { value: string; label: string; group?: string; tip?: string }, hint: boolean) => {
        const selected = x.value === o.selected;
        const row = document.createElement("div");
        row.className = "sl-picker-row" + (selected ? " sl-picker-row-selected" : "");
        if (x.tip) row.title = x.tip;
        const check = document.createElement("span");
        check.className = "sl-picker-check";
        check.textContent = selected ? "✓" : "";
        const label = document.createElement("span");
        label.textContent = x.label;
        row.append(check, label);
        // While filtering the headings are gone, so the group travels with the row instead -- a
        // grouped list that stays grouped under a filter makes you read five headings to find two
        // matches.
        if (hint && x.group) {
          const g = document.createElement("span");
          g.className = "sl-picker-group-hint";
          g.textContent = x.group;
          row.appendChild(g);
        }
        // mousedown, and prevented: a click's default would blur the filter first, which fires
        // the close-on-blur handler below and dismisses the popup before "click" ever arrives.
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          // LEAVE NOTHING BEHIND. Choosing removes this list and its search field while the field
          // has the keyboard focus, and WebKit then parks a text caret in the page. A later press
          // in the 3D view extended that caret into a selection of half the window and dragged it
          // -- Ron, 2026-09-23: "When I click in the render window, it moves the entire view",
          // new because the Load scene list was the first picker used right before working in the
          // 3D view. Opening the same scene without the list left no selection at all.
          input.blur();
          window.getSelection()?.removeAllRanges();
          o.onSelect(x.value);
        });
        return row;
      };

      if (shown.length) {
        const grouped = !f && shown.some((x) => x.group);
        if (!grouped) {
          for (const x of shown) list.appendChild(mkRow(x, !!f));
        } else {
          // Ungrouped options lead, with no heading of their own: that IS the pinned section.
          for (const x of shown.filter((x) => !x.group)) list.appendChild(mkRow(x, false));
          const order = o.groupOrder ?? [];
          const names = [...new Set(shown.map((x) => x.group).filter(Boolean) as string[])]
            .sort((a, b) => {
              const ia = order.indexOf(a), ib = order.indexOf(b);
              return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
            });
          for (const name of names) {
            const head = document.createElement("div");
            head.className = "sl-picker-group";
            head.textContent = name;
            list.appendChild(head);
            for (const x of shown.filter((x) => x.group === name)) list.appendChild(mkRow(x, false));
          }
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "sl-picker-empty";
        empty.textContent = o.emptyLabel ?? `no match for "${o.filter}"`;
        list.appendChild(empty);
      }
      pop.appendChild(list);
      wrap.appendChild(pop);

      // DOWNWARD BY DEFAULT, up only when there is genuinely no room. The native <select> this
      // replaced chose by where the window sat, which meant it opened upwards near the top of the
      // screen -- off the display, and unreachable. Measured after insertion, since the popup's
      // height depends on how many options survived the filter.
      // MEASURED SYNCHRONOUSLY, then again on the next frame.
      //
      // This used to run only inside requestAnimationFrame, and rAF DOES NOT FIRE while the document
      // is hidden -- so a picker opened in a backgrounded window got neither its height nor its
      // direction, silently falling back to the 240px in the stylesheet. `getBoundingClientRect`
      // forces layout on demand, so the first pass needs no frame at all; the second is kept because
      // a late-loading font or a scrollbar can change the numbers, and running it twice is harmless.
      const place = () => {
        const vh = globalThis.innerHeight || 0;
        if (!vh) return;
        const btn = wrap.getBoundingClientRect();
        const GAP = 12;
        const below = vh - btn.bottom - GAP;
        const above = btn.top - GAP;

        // AS TALL AS THERE IS ROOM FOR, up to 80% of the window. Ron: "the modules popup is too
        // short. Can you make it 80% of the window size?" -- it was a flat 240px, which showed six
        // modules out of twelve and will show fewer as they are added.
        //
        // Measured rather than set to `80vh`, because the height and the DIRECTION are one decision.
        // A popup fixed at 80vh is taller than the room above it almost anywhere on screen, so the
        // "is there room above?" test below could never be true and it would simply overflow the
        // bottom of the window -- the same unreachable list the native <select> gave us, arrived at
        // from the other side.
        const openUp = below < Math.min(240, above) && above > below;
        pop.classList.toggle("sl-picker-pop-up", openUp);
        const room = (openUp ? above : below) - (input.offsetHeight || 28) - 8;
        list.style.maxHeight = `${Math.max(140, Math.min(vh * 0.8, room))}px`;
      };
      place();
      requestAnimationFrame(place);

      // RE-MEASURED WHILE OPEN. Ron resizes this window constantly -- it is how he found the panel
      // failing to reposition on startup -- and a picker opened before a resize kept the height it
      // was born with, which in a window made SMALLER means a list hanging off the bottom edge.
      //
      // Self-removing rather than tracked: this popup is rebuilt from scratch on every render (a
      // keystroke in the filter is a full re-render), so a listener held by the shell would have to
      // be unregistered on a teardown path that does not exist, and one that missed would accumulate
      // per keystroke. Asking the element whether it is still in the document is the same question
      // with no bookkeeping.
      const onResize = () => {
        if (!pop.isConnected) globalThis.removeEventListener("resize", onResize);
        else place();
      };
      globalThis.addEventListener("resize", onResize);

      input.addEventListener("input", () => o.onFilterChange(input.value));
      input.addEventListener("keydown", (e) => { if (e.key === "Escape") o.onOpenChange(false); });
      // Deferred, not read from this blur event itself: the caller's onFilterChange/onOpenChange
      // re-renders synchronously, which tears down and rebuilds this very popup on every keystroke
      // -- destroying the currently focused input fires blur SYNCHRONOUSLY, on the element already
      // being replaced, before the rebuild below has even run. Checked one tick later against
      // `document.activeElement` directly, not against `wrap` -- `wrap` is THIS closure's own,
      // about to be destroyed along with it, so by the time the deferred check ran it was asking
      // whether focus was inside a container already gone, which is trivially always false and
      // closed the picker on its own first keystroke. Whether focus is on *some* filter input,
      // freshly rebuilt or not, is the question that survives the rebuild.
      input.addEventListener("blur", () => {
        setTimeout(() => {
          const a = document.activeElement;
          if (!(a instanceof HTMLElement) || !a.classList.contains("sl-picker-filter")) o.onOpenChange(false);
        }, 0);
      });
      // Synchronous, not deferred: the caret must already be in place before that same later tick
      // reads document.activeElement, or a real keystroke's own rebuild would race its own re-focus.
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
  return shell;
}
