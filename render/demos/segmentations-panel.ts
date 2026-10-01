// "Segmentations" — what you have, as an anatomical tree rather than a flat list.
//
// Ron's design, 2026-09-05, after we read Slicer's Segmentations module and rejected its shape:
// "an example of how I would like it to look like is in the openantomybrowser of Mike halle ...
// The selection and visibility will be in the columns. If I toggle visibility of a parent, it
// affects all children. Branches are collapsible. The TA2 viewer has the lines that I like."
//
// WHY NOT SLICER'S TABLE. Slicer's segment list is a flat QStandardItemModel — visibility, color,
// opacity, name, layer, status, one row per segment, no nesting. At ts:total's 117 structures that
// is 117 rows, and Ron: grouping is "a great annoyance to me" because Slicer only lets you organize
// at the level of the segmentation NODE. Here the tree does it: 117 structures collapse to 10 rows,
// 63 of them under one Skeletal system.
//
// ROOTS, NOT ONE MERGED TREE. Ron: "Selecting from a list of roots is a scalable approach." A scene
// can hold several segmentations of one volume — ts:total and ts:lung_vessels — and merging them
// into a single tree would put two segmentations' claims about the same anatomy on one row. One root
// is selected; its tree is shown. He also asked for two things this build makes room for but does
// not finish: dragging segments between roots, and creating a named root. The second is here; the
// first is a voxel operation (each root has its OWN labelmap, so a move relabels voxels out of one
// volume and into another) and is stubbed with the menu path only — see moveToRoot().
//
// ACCESSIBILITY IS A CONSTRAINT, NOT A POLISH STEP. Ron: "the user interface be friendly for people
// with poor fine motor control." So every move has a NON-DRAG path first: select rows, then choose
// a destination from a menu. Drag, when it lands, is the fast path on top — never the only one.
import { escapeHtml } from "./html.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import { keepScroll } from "./panel-scroll.ts";
import type { LiveScene } from "../livescene.ts";
import type { MrsonNode } from "../mrson.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";
import { createSegmentation } from "../../logic/segmentation-editor.ts";
import { openMergeWindow } from "./merge-segmentations.ts";
import { segmentationsOffScheme, useCurrentColors } from "../../logic/scheme-colors.ts";
import { paletteVersion } from "../../logic/anatomy/palettes.ts";
import { type AnatomyNode, buildSegmentTree, leaves, type SceneSegment } from "../../logic/anatomy/hierarchy.ts";
import { definitionFor } from "../../logic/anatomy/definitions.ts";
import { addTerm, mintCode, newTerminology, proposeColour, terminologies, terminology, type TerminologySource, toColorTableCsv } from "../../logic/anatomy/terminology.ts";
import { describeCorrections } from "../../logic/anatomy/overrides.ts";

/**
 * What the show/hide-all button says, and what it will do.
 *
 * Ron: "can you add a turn off/on all button to the segmentations display?" With 111 structures,
 * "show me only the vessels" is otherwise a hundred and five clicks, and getting back is a hundred
 * and eleven.
 *
 * Separated from the panel because the DECISION is the part that can be wrong, and it needs no DOM:
 * which way the click goes, what it is scoped to, and what it therefore says.
 *
 * - ONE BUTTON, following the same rule the per-row eyes follow: anything still visible means the
 *   click hides; nothing visible means it shows. So it is never a no-op and the way back from a hide
 *   is the same button.
 * - SCOPED TO WHAT THE LIST SHOWS. With a filter typed it acts on the matches only, which is the
 *   useful half of it -- "rib" then Hide these 24 leaves everything else alone.
 * - THE LABEL SAYS WHICH, so there is nothing to discover: "Hide all" or "Show these 24".
 */
export function showHideAllState(
  shown: readonly { labelValue?: number; visible?: boolean }[],
  filtered: boolean,
): { label: string; title: string; show: boolean; labels: number[] } {
  const labels = shown.map((x) => x.labelValue).filter((v): v is number => typeof v === "number");
  const anyVisible = shown.some((x) => x.visible !== false);
  const show = !anyVisible;
  const n = shown.length;
  const label = show
    ? (filtered ? `Show these ${n}` : "Show all")
    : (filtered ? `Hide these ${n}` : "Hide all");
  return {
    label,
    title: show ? "Show every structure in the list below" : "Hide every structure in the list below",
    show,
    labels,
  };
}

interface Root {
  id: string;
  name: string;
  segments: SceneSegment[];
  /** The volume it was drawn on, so a new root can be attached to the same one. */
  sourceId?: string;
}

export function registerSegmentationsPanel(
  shell: AppShell,
  opts: { live: LiveScene; store: LocalBlobStore; onStatus?: (s: string) => void },
): void {
  const { live, store } = opts;
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  let chosen = "";
  let filter = "";
  /**
   * Collapsed branches, PER SEGMENTATION, by node id. The set holds what is CLOSED.
   *
   * One set for the whole panel was wrong in three ways at once (critic 2026-09-22, 3.2): the
   * chosen segmentation's folding was the only folding the views were ever told about, so after a
   * merge the chosen one drew in group colors and the other two in leaf colors with nothing
   * saying why; a segmentation that arrived while another was chosen was never folded; and opening
   * a few branches in one and coming back from another threw the hand work away. Ron: "you should
   * not design for single anything."
   */
  const closedBy = new Map<string, Set<string>>();
  /** A segmentation with this many structures or fewer arrives with its tree open (see closedFor). */
  const OPEN_AT_ARRIVAL_MAX = 20;
  /**
   * WHAT A SEGMENTATION ARRIVED FOLDED AS, when the scene says so.
   *
   * A restored scene carries `mergedGroups` -- the branches whose structures the views paint as one
   * color -- and folding it to the overview on arrival threw that away: Ron, 2026-09-22, "The
   * scene does not fully recover the segmentations settings that I had at save time." So a
   * segmentation that arrives with groups is read back into the tree's own terms (a group's set of
   * label values identifies the branch it was), and only one that arrives with none is folded to
   * the systems.
   */
  const closedFromGroups = (tree: AnatomyNode[], groups: { labels: number[] }[]): Set<string> | null => {
    if (!groups.length) return null;
    const want = groups.map((g) => [...g.labels].sort((a, b) => a - b).join(","));
    const out = new Set<string>();
    const walk = (n: AnatomyNode) => {
      if (n.children.length) {
        const mine = leaves([n]).map((l) => l.labelValue).filter((v): v is number => typeof v === "number").sort((a, b) => a - b).join(",");
        if (want.includes(mine)) { out.add(n.id); return; }      // this branch is one of the saved groups
      }
      for (const c of n.children) walk(c);
    };
    for (const n of tree) walk(n);
    return out.size ? out : null;
  };
  /**
   * The folded state of one segmentation: the scene's; or, the first time, open when it is small and
   * folded to its systems when it is large.
   *
   * SMALL ARRIVES OPEN. The overview was made for the 199-row whole-body result; for a four-structure
   * lung-vessels run it folded the pulmonary artery and vein into "Cardiovascular system", which draws
   * in that group's deliberately neutral mauve -- and the one distinction the network exists to make
   * was gone from the picture. Ron, 2026-09-23: "yes, build it with 20" (up to 20 structures arrive
   * open, each in its own color; more arrive in the overview; the toggle is unchanged).
   */
  const closedFor = (rootId: string, tree: AnatomyNode[]): Set<string> => {
    let set = closedBy.get(rootId);
    if (!set) {
      const groups = (live.nodes.get(rootId) as unknown as { mergedGroups?: { labels: number[] }[] } | undefined)?.mergedGroups ?? [];
      set = closedFromGroups(tree, groups) ?? (leaves(tree).length <= OPEN_AT_ARRIVAL_MAX ? new Set<string>() : new Set(overviewOf(tree)));
      closedBy.set(rootId, set);
    }
    return set;
  };
  /** The chosen segmentation's set — what the rows and the buttons in this render act on. */
  let closed = new Set<string>();
  let lastTree: AnatomyNode[] = [];
  /**
   * OVERVIEW OR EVERY LEVEL, and the person decides at the time.
   *
   * A whole-body segmentation opens as 199 rows, which Ron called overwhelming, and the picture he
   * wanted instead was the systems with their groups folded. But a folded group draws as ONE color
   * in the views (his own earlier request about the ribs), so folding by default would also hand him
   * a coarse picture — and making a group folded-at-arrival mean something different from a group he
   * folded himself is the complication he rejected: "#2 is too complicated. How about a toggle
   * between collapsed my way (partially collapsed) and all open? ... the decision can be done by the
   * user at run time" (2026-09-22).
   *
   * So one rule holds everywhere — folded is one color, open is the leaf colors — and one button
   * moves the whole tree between the two. A segmentation ARRIVES in the overview; every structure,
   * in its own color, is one click away.
   */
  const overviewOf = (nodes: readonly AnatomyNode[]): Set<string> => {
    const out = new Set<string>();
    const walk = (n: AnatomyNode, depth: number) => {
      if (n.children.length && depth >= 1) out.add(n.id);
      for (const c of n.children) walk(c, depth + 1);
    };
    for (const n of nodes) walk(n, 0);
    return out;
  };

  /**
   * Push the collapsed branches to the scene, so the VIEWS paint each of them as one color.
   *
   * Ron: "when I collapse the left ribs in segmentations, they do not change to a single color" --
   * meaning the picture, not the row's swatch. A branch drawn as one row should look like one
   * structure, and 24 individually-colored ribs under a closed "Ribs" row did not.
   *
   * Display only: `mergedGroups` carries label values and a color, the segments keep their own, and
   * the labelmap is never touched. Expanding sends the shorter list and the palette goes back. Only
   * the OUTERMOST closed branch is sent -- a closed group inside a closed group is already covered by
   * its ancestor, and sending both would just paint the same labels twice.
   */
  const publishMerges = () => {
    for (const r of roots()) publishMergesFor(r.id);
  };
  const publishMergesFor = (rootId: string) => {
    const cur = roots().find((r) => r.id === rootId);
    if (!cur) return;
    // The chosen segmentation's tree is already built for the rows; another one's is built here.
    // 135 segments cost well under a millisecond, and the alternative is the views disagreeing
    // with the panel for every segmentation but one.
    const context = live.nodes.get(cur.id)?.terminology as string | undefined;
    const tree = rootId === chosen && lastTree.length ? lastTree : buildSegmentTree(cur.segments, context);
    const closed = closedFor(rootId, tree);
    const out: { labels: number[]; color: number[] }[] = [];
    // A SEARCH DRAWS EVERY BRANCH OPEN, so the views must be open too: with "rib" typed, the tree
    // listed 24 ribs each with its own color chip while the picture drew them all in one group
    // color (critic 2026-09-22, 3.1). What the rows say and what the picture shows is the same
    // question asked twice, and it must have one answer.
    const filtering = rootId === chosen && filter.trim().length > 0;
    const walk = (n: AnatomyNode, underClosed: boolean) => {
      const shut = !filtering && closed.has(n.id) && n.children.length > 0;
      if (shut && !underClosed && n.color) {
        const labels = leaves([n]).map((l) => l.labelValue).filter((v): v is number => typeof v === "number");
        if (labels.length > 1) out.push({ labels, color: [...n.color] });
      }
      for (const c of n.children) walk(c, underClosed || shut);
    };
    for (const n of tree) walk(n, false);
    const before = JSON.stringify((live.nodes.get(cur.id) as unknown as { mergedGroups?: unknown } | undefined)?.mergedGroups ?? []);
    if (JSON.stringify(out) === before) return;      // nothing to say: no re-colorize, no redraw
    live.write({ op: "patch", id: cur.id, path: "#/mergedGroups", value: out });
  };
  /** Selected rows, by node id — what a move or a bulk visibility change acts on. */
  const selected = new Set<string>();

  const roots = (): Root[] =>
    [...live.nodes.values()]
      .filter((n) => n.type === "segmentation")
      .map((n) => ({
        id: n.id as string,
        name: (n.name as string) ?? (n.id as string),
        segments: ((n.segments as SceneSegment[]) ?? []),
        sourceId: ((n.refs as Record<string, string[]> | undefined)?.source ?? [])[0],
      }));

  const setSegmentVisible = (segId: string, labelValues: number[], visible: boolean) => {
    const n = live.nodes.get(segId);
    if (!n) return;
    const want = new Set(labelValues);
    const segs = ((n.segments as SceneSegment[]) ?? []).map((s) =>
      want.has(s.labelValue) ? { ...s, visible } : s
    );
    live.write({ op: "patch", id: segId, path: "#/segments", value: segs });
  };

  /**
   * SEE-THROUGH, per structure, display only. Ron, with lung vessels inside lung lobes: "it would
   * be helpful to make the lung lobes transparent." The lobe is an envelope around the vessels;
   * see-through it reads as one and shows them (30% at first; 40% since 2026-09-24, for the solid look --
   * Ron: "The lungs and liver are too transparent. Can you increase opacity in the entire segmentations
   * module by 10%"). `opacity` on the segment is what the 3D reads; the labelmap is untouched.
   */
  const SEE_THROUGH = 0.4;
  const setSegmentOpacity = (segId: string, labelValues: number[], opacity: number) => {
    const n = live.nodes.get(segId);
    if (!n) return;
    const want = new Set(labelValues);
    const segs = ((n.segments as (SceneSegment & { opacity?: number })[]) ?? []).map((s) => {
      if (!want.has(s.labelValue)) return s;
      const { opacity: _drop, ...rest } = s;
      return opacity >= 1 ? rest : { ...rest, opacity };
    });
    live.write({ op: "patch", id: segId, path: "#/segments", value: segs });
  };
  /** Whether the structures under a node are see-through: all, none, or some. */
  const clearState = (n: AnatomyNode): "all" | "none" | "some" => {
    const node = live.nodes.get(chosen);
    const op = new Map<number, number>();
    for (const s of ((node?.segments as (SceneSegment & { opacity?: number })[]) ?? [])) op.set(s.labelValue, s.opacity ?? 1);
    const ls = labelsUnder(n);
    const k = ls.filter((l) => (op.get(l) ?? 1) < 1).length;
    return k === 0 ? "none" : k === ls.length ? "all" : "some";
  };

  /** Every label value at or under a node — what a parent's eye acts on. */
  const labelsUnder = (n: AnatomyNode): number[] =>
    leaves([n]).map((x) => x.labelValue).filter((v): v is number => v !== undefined);

  /** A container has no visibility of its own; it reads its children. */
  const shownState = (n: AnatomyNode): "all" | "none" | "some" => {
    const all = leaves([n]);
    if (!all.length) return "none";
    const on = all.filter((x) => x.visible !== false).length;
    return on === all.length ? "all" : on === 0 ? "none" : "some";
  };

  /**
   * Rows that survive the filter, with their ancestors kept so a match is never orphaned.
   *
   * A match deep in a collapsed branch has to be reachable, so filtering FORCES its ancestors open
   * rather than hiding it — the same rule the module picker follows, for the same reason: a search
   * that leaves you to guess which branch to expand is not a search.
   */
  //
  // EVERY WORD, ANYWHERE ON THE ROW'S PATH, IN ANY ORDER. Ron, 2026-09-21, typing into it: "It is
  // too inflexible. I would like it to be robust to large caps and small caps and find substrings
  // in the middle of the name." It was already case-blind and mid-name -- what failed was the
  // side: "Left" is the parent row, not part of "Pectoralis major muscle", so `left pec` found
  // nothing, and two words matched only in the order and adjacency they appear. Now the filter is
  // words; a row matches when each word is a substring of its own name or an ancestor's.
  const words = (f: string) => f.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesPath = (n: AnatomyNode, ws: string[], path: string): boolean => {
    if (!ws.length) return true;
    const own = `${path} ${n.name.toLowerCase()}`;
    if (ws.every((w) => own.includes(w))) return true;
    return n.children.some((c) => matchesPath(c, ws, own));
  };
  const matches = (n: AnatomyNode, f: string, path = ""): boolean => matchesPath(n, words(f), path);
  /** The leaves that survive the filter, with their ancestors' names counted (matchesPath). */
  const matchingLeaves = (nodes: readonly AnatomyNode[], f: string): AnatomyNode[] => {
    const ws = words(f), out: AnatomyNode[] = [];
    const walk = (n: AnatomyNode, path: string) => {
      const own = `${path} ${n.name.toLowerCase()}`;
      if (!n.children.length) { if (!ws.length || ws.every((w) => own.includes(w))) out.push(n); return; }
      if (ws.length && ws.every((w) => own.includes(w))) { for (const l of leaves([n])) out.push(l); return; }   // a matching group brings all its leaves
      for (const c of n.children) walk(c, own);
    };
    for (const n of nodes) walk(n, "");
    return out;
  };

  async function newRoot() {
    const vols = [...live.nodes.values()].filter((n) => n.type === "image" && !n.labelmap && n.zarr);
    if (!vols.length) { status("Segmentations: load a volume first"); return; }
    const ok = await shell.confirm({
      title: "New segmentation",
      ok: "Create",
      body: `<p>Creates an empty segmentation on <b>${escapeHtml((vols[0].name as string) ?? "the loaded volume")}</b>.</p>` +
        `<p>You can rename it afterwards by double-clicking its name.</p>`,
    });
    if (!ok) return;
    const made = await createSegmentation(live, store, vols[0].id as string, { name: "Segmentation" });
    chosen = made.segId;
    status(`Segmentations: created ${made.segId}`);
    render();
  }

  /** The New term form's state while it is open; null when closed. */
  let termForm: { name: string; category: string; target: string; rgb?: [number, number, number] } | null = null;

  const findNode = (nodes: readonly AnatomyNode[], id: string): AnatomyNode | undefined => {
    for (const n of nodes) { if (n.id === id) return n; const c = findNode(n.children, id); if (c) return c; }
    return undefined;
  };

  function buildTermForm(segId: string, contextOf: string | undefined, mine: TerminologySource[]): HTMLElement {
    const f = termForm!;
    const box = document.createElement("div");
    box.className = "sl-term-form";
    // Where it goes: an editable terminology in the scene, or a new one. Default: the segmentation's
    // own context when that is editable, else the most recent of the person's own, else new.
    if (!f.target) f.target = (contextOf && mine.some((t) => t.id === contextOf)) ? contextOf : (mine[0]?.id ?? "new");
    const targetSrc = f.target !== "new" ? terminology(f.target) : undefined;
    // Categories to offer: the target's own, then the context's, then the tree's groups.
    const cats = new Set<string>();
    for (const t of [targetSrc, contextOf ? terminology(contextOf) : undefined]) for (const e of Object.values(t?.entries ?? {})) if (e.category) cats.add(e.category);
    const existing = Object.values(targetSrc?.entries ?? {});
    const rgb = f.rgb ?? proposeColour(f.category, f.name || "term", existing);
    const hex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
    const preview = f.name.trim() ? mintCode(f.name).replace(/-[0-9a-z]{4}$/, "-····") : "";
    box.innerHTML = `<div class="sl-term-title">New term</div>
      <div class="sl-term-grid">
        <label>Name</label><input class="sl-term-name" type="text" value="${f.name.replace(/"/g, "&quot;")}" placeholder="" autocomplete="off">
        <label>Category</label><input class="sl-term-cat" type="text" list="sl-term-cats" value="${f.category.replace(/"/g, "&quot;")}" placeholder="" autocomplete="off">
        <datalist id="sl-term-cats">${[...cats].map((c) => `<option value="${c.replace(/"/g, "&quot;")}">`).join("")}</datalist>
        <label>Color</label><span class="sl-term-colour"><input class="sl-term-rgb" type="color" value="${hex(rgb)}"><span class="sl-hint">${f.rgb ? "" : "from the category — click to change"}</span></span>
        <label>Code</label><span class="sl-term-code">${preview || "<span class='sl-hint'>minted from the name</span>"}</span>
        <label>Saved to</label><select class="sl-term-target">${mine.map((t) => `<option value="${t.id}"${t.id === f.target ? " selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}<option value="new"${f.target === "new" ? " selected" : ""}>a new terminology of yours</option></select>
      </div>
      <div class="sl-term-actions"><button type="button" class="sl-tool sl-term-cancel">Cancel</button><button type="button" class="sl-primary sl-term-add">Add term</button></div>`;
    const q = <T extends HTMLElement>(sel: string) => box.querySelector(sel) as T;
    const nameIn = q<HTMLInputElement>(".sl-term-name"), catIn = q<HTMLInputElement>(".sl-term-cat"), rgbIn = q<HTMLInputElement>(".sl-term-rgb"), tgt = q<HTMLSelectElement>(".sl-term-target");
    // Re-render on every keystroke would drop the caret; the fields hold their own state and the
    // form is rebuilt only on category (color proposal) and target (category list) changes.
    nameIn.addEventListener("input", () => { f.name = nameIn.value; q(".sl-term-code").textContent = f.name.trim() ? mintCode(f.name).replace(/-[0-9a-z]{4}$/, "-····") : "minted from the name"; });
    catIn.addEventListener("change", () => { f.category = catIn.value; f.rgb = undefined; render(); });
    rgbIn.addEventListener("input", () => { const v = rgbIn.value; f.rgb = [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)]; });
    tgt.addEventListener("change", () => { f.target = tgt.value; render(); });
    q(".sl-term-cancel").addEventListener("click", () => { termForm = null; render(); });
    q(".sl-term-add").addEventListener("click", () => {
      const name = nameIn.value.trim();
      if (!name) { status("Segmentations: a term needs a name"); nameIn.focus(); return; }
      const colour = f.rgb ?? proposeColour(catIn.value.trim(), name, existing);
      let src: TerminologySource;
      if (f.target === "new") {
        src = newTerminology(`terminology-user-${Date.now().toString(36)}`, "Your terms");
      } else {
        const t = terminology(f.target);
        if (!t) { status("Segmentations: that terminology is gone"); return; }
        src = { ...t, entries: { ...t.entries }, byName: { ...t.byName }, schemes: [...t.schemes] };
      }
      let entry;
      try { entry = addTerm(src, { name, category: catIn.value.trim(), rgb: colour }); }
      catch (e) { status(`Segmentations: ${(e as Error).message}`); return; }
      // The terminology goes to the scene whole: a put re-delivers it to the registry.
      live.write({ op: "put", id: src.id, node: { type: "terminology", ...src } as unknown as MrsonNode });
      // The segmentation reads its names in this terminology from now on, unless it already had one.
      if (!contextOf) live.write({ op: "patch", id: segId, path: "#/terminology", value: src.id });
      // A selected segment takes the new term's name and color; otherwise the term waits to be used.
      const node = live.nodes.get(segId);
      // `selected` holds tree node ids; a selected group means every segment under it.
      const chosenLabels = new Set<number>();
      const all = leaves(lastTree);
      for (const id of selected) {
        const n = all.find((x) => x.id === id);
        if (n && n.labelValue !== undefined) chosenLabels.add(n.labelValue);
        else { const g = findNode(lastTree, id); if (g) for (const l of leaves([g])) if (l.labelValue !== undefined) chosenLabels.add(l.labelValue); }
      }
      if (node && chosenLabels.size) {
        const segs = ((node.segments as SceneSegment[]) ?? []).map((sg) => chosenLabels.has(sg.labelValue) ? { ...sg, name: entry.name, color: colour.map((v) => v / 255), structure: entry.key } : sg);
        live.write({ op: "patch", id: segId, path: "#/segments", value: segs });
      }
      status(`Segmentations: added "${entry.name}" (${entry.code}) to ${src.name}${chosenLabels.size ? ` and named ${chosenLabels.size} segment${chosenLabels.size === 1 ? "" : "s"}` : ""}`);
      termForm = null;
      render();
    });
    setTimeout(() => { if (document.activeElement !== catIn) nameIn.focus(); }, 0);
    return box;
  }

  function renameRoot(id: string, el: HTMLElement) {
    const n = live.nodes.get(id);
    if (!n) return;
    const input = document.createElement("input");
    input.className = "sl-seg-rename";
    input.value = (n.name as string) ?? "";
    el.replaceChildren(input);
    input.focus();
    input.select();
    const commit = (save: boolean) => {
      if (save && input.value.trim()) live.write({ op: "patch", id, path: "#/name", value: input.value.trim() });
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  /**
   * Move the selected segments into another root.
   *
   * NOT YET IMPLEMENTED, and deliberately not faked. Each root owns its own labelmap, so this is a
   * voxel operation: the selected labels have to be written into the destination's volume and
   * cleared from the source's, both re-chunked, with the segment metadata following. Doing the
   * metadata half alone would produce a segment that appears under the new root and draws under the
   * old one, which is worse than not offering it.
   */
  function moveToRoot(_destId: string) {
    status("Moving segments between segmentations is not built yet — it relabels voxels, not just rows");
  }

  function rowFor(n: AnatomyNode, depth: number, out: HTMLElement, path = "") {
    const f = filter.trim().toLowerCase();
    if (!matches(n, f, path)) return;
    const isClosed = closed.has(n.id) && !f;
    const state = shownState(n);

    const row = document.createElement("div");
    row.className = "sl-anat-row" + (selected.has(n.id) ? " sl-anat-sel" : "");
    row.style.setProperty("--depth", String(depth));
    row.dataset.id = n.id;

    // TWO FIXED COLUMNS ON THE LEFT, then the indented name. Ron: "I would prefer to have all the
    // eyes and color boxes in two colums on the left."
    //
    // The first version indented the whole row, so the eye and the color chip drifted right with
    // depth and no two of them lined up -- at five levels deep the eyes formed a staircase. Only the
    // NAME carries the indentation now; the two controls stay in their columns, which is what makes
    // them scannable down the list and what makes a click target predictable.
    const eye = document.createElement("button");
    const state2 = state;
    eye.className = "sl-anat-eye" + (state2 === "none" ? " sl-anat-off" : state2 === "some" ? " sl-anat-mixed" : "");
    eye.type = "button";
    eye.textContent = state2 === "none" ? "🚫" : "👁";
    eye.title = state2 === "all" ? "Hide" : state2 === "none" ? "Show" : "Some hidden — click to show all";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      const labels = labelsUnder(n);
      if (labels.length) setSegmentVisible(chosen, labels, state2 !== "all");
      render();
    });

    const chip = document.createElement("span");
    chip.className = "sl-anat-chip";
    if (n.color) {
      const c = n.color.map((v) => (v <= 1 ? Math.round(v * 255) : Math.round(v)));
      chip.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
      chip.title = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    } else chip.classList.add("sl-anat-chip-none");

    // The indented part: guides, disclosure, name.
    const label = document.createElement("div");
    label.className = "sl-anat-label";
    label.style.setProperty("--depth", String(depth));

    const tw = document.createElement("button");
    tw.className = "sl-anat-twisty";
    tw.type = "button";
    // U+25B6/U+25BC, the FULL-SIZE triangles. The glyphs here were U+25B8 and U+25BE, whose Unicode
    // names are literally BLACK RIGHT-POINTING SMALL TRIANGLE and BLACK DOWN-POINTING SMALL TRIANGLE
    // -- they are drawn small by design, so raising the font size twice moved them barely at all.
    // Ron, three times: "the triangles in segmentations are too small for me", "still too small",
    // "The triangles are unchanged."
    tw.textContent = n.children.length ? (isClosed ? "▶" : "▼") : "";
    tw.disabled = !n.children.length;
    if (n.children.length) {
      tw.title = isClosed ? "Expand" : "Collapse";
      // IT ACTS ON WHAT THE ROW SHOWS. While a search is typed every branch is DRAWN open, so a
      // row could say "Collapse" and, because the node was still in `closed`, un-collapse on the
      // click -- the row not changing and the picture quietly splitting into leaf colors (critic
      // 2026-09-22, 3.1). `isClosed` is the drawn state, and the drawn state is what the person is
      // answering.
      tw.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isClosed) closed.delete(n.id); else closed.add(n.id);
        publishMerges();
        render();
      });
    }

    const name = document.createElement("span");
    name.className = "sl-anat-name";
    name.textContent = n.name;
    // WHAT THE LABEL COVERS, where that is known to differ from what the name promises (a rib
    // without its head): the model's definition, observed and sourced (logic/anatomy/definitions.ts),
    // on the structure's own row, where a person wonders about it.
    if (n.structure) {
      const model = (live.nodes.get(chosen)?.origin as { task?: string } | undefined)?.task;
      const d = definitionFor(model, n.structure);
      if (d) { name.title = `${d.says}\n\n${d.source}`; name.classList.add("sl-anat-defined"); }
    }
    // THE NUMBER SAYS WHAT IT COUNTS. Ron: "What is the meaning of the numbers?" -- a bare figure
    // beside a name could be anything. It is how many structures are inside a group, and now it says
    // so on hover and is only drawn where it means something.
    const inside = leaves([n]).length;
    if (n.children.length && n.labelValue === undefined) {
      const count = document.createElement("span");
      count.className = "sl-anat-count";
      count.textContent = String(inside);
      count.title = `${inside} structure${inside === 1 ? "" : "s"} in this group`;
      name.appendChild(count);
    }
    label.append(tw, name);

    // THE THIRD FIXED COLUMN: see-through. Same rule as the eye -- on a group it acts on everything
    // under it, and a mixed group shows as mixed.
    const cs = clearState(n);
    const ghost = document.createElement("button");
    ghost.className = "sl-anat-ghost" + (cs === "all" ? " sl-anat-ghost-on" : cs === "some" ? " sl-anat-ghost-mixed" : "");
    ghost.type = "button";
    ghost.textContent = "◐";
    ghost.title = cs === "all" ? "Solid again" : cs === "none" ? "See-through in 3D (40%)" : "Some see-through — click to make all see-through";
    ghost.addEventListener("click", (e) => {
      e.stopPropagation();
      const labels = labelsUnder(n);
      if (labels.length) setSegmentOpacity(chosen, labels, cs === "all" ? 1 : SEE_THROUGH);
      render();
    });
    row.append(eye, ghost, chip, label);
    row.addEventListener("click", (e) => {
      // Plain click selects; cmd/ctrl adds. Selection is what a move will act on.
      if (!(e.metaKey || e.ctrlKey)) selected.clear();
      selected.has(n.id) ? selected.delete(n.id) : selected.add(n.id);
      render();
    });
    out.appendChild(row);

    if (!isClosed) for (const c of n.children) rowFor(c, depth + 1, out, `${path} ${n.name.toLowerCase()}`);
  }

  /** Rebuild the panel, keeping where the person was in the list. */
  function render() { keepScroll(root, renderNow); }
  globalThis.addEventListener("sl-palette-changed", () => render());

  function renderNow() {
    if (!root) return;
    const all = roots();
    if (!chosen || !all.some((r) => r.id === chosen)) chosen = all[0]?.id ?? "";
    const current = all.find((r) => r.id === chosen);
    root.innerHTML = "";

    const h = document.createElement("h2");
    h.textContent = "Segmentations";
    root.appendChild(h);

    if (!all.length) {
      const p = document.createElement("p");
      p.className = "sl-hint";
      p.textContent = "No segmentations yet. Run one in AI segmentations, or create an empty one here.";
      root.append(p, actionsRow());
      return;
    }

    // THE ROOTS. A list, not a tree: these are the things a person picks between, and Ron asked for
    // exactly that -- "Selecting from a list of roots is a scalable approach."
    const rootsSec = shell.section(root, "Segmentations", { open: true, band: "green", note: `${all.length}` });
    for (const r of all) {
      const item = document.createElement("div");
      item.className = "sl-seg-root" + (r.id === chosen ? " sl-seg-root-on" : "");
      const nm = document.createElement("span");
      nm.className = "sl-seg-root-name";
      nm.textContent = r.name;
      // THE FULL NAME ON HOVER. The row cuts a long name with an ellipsis, and two segmentations
      // that differ only past the cut read as one. Ron, 2026-09-22, having mixed up two lung-vessel
      // sets: "the full name of the segmentation was not readable in the listing. Perhaps showing
      // that on hover would have prevented me."
      nm.title = `${r.name} — double-click to rename`;
      nm.addEventListener("dblclick", (e) => { e.stopPropagation(); renameRoot(r.id, nm); });
      const cnt = document.createElement("span");
      cnt.className = "sl-hint";
      cnt.textContent = `${r.segments.length}`;
      // WHICH ONE IS ON SCREEN, and how to change it. Ron, with two segmentations loaded: "Having
      // the option to change is currently not obvious to me." It was not obvious because it was not
      // here -- the row selected which segmentation the TREE below showed and said nothing about
      // what the views were showing.
      //
      // The slices can carry one segmentation at a time (one overlay texture) while 3D composites
      // every visible one, so turning a second on is a real thing to be able to do, and the eye is
      // where you do it.
      const shown = live.nodes.get(r.id)?.visible !== false;
      const eye = document.createElement("button");
      eye.className = "sl-anat-eye" + (shown ? "" : " sl-anat-off");
      eye.type = "button";
      eye.textContent = shown ? "👁" : "🚫";
      eye.title = shown ? "Showing in the views — click to hide" : "Hidden — click to show";
      // THE EYE COVERS THE 3D VIEW TOO. `visible` is the slices; the 3D view reads `visible3D`,
      // which the Scene module's 3D button sets and this eye never touched -- so once 3D had been
      // switched on, hiding a segmentation here emptied the slices and left its surfaces standing.
      // Ron, 2026-09-21: "I had turned off the first segmentation in the list and it worked on the
      // slices but not in the 3d view." Hiding takes 3D down with it and remembers whether it was
      // on; showing puts 3D back as it was, so a segmentation that was slices-only stays slices-only.
      eye.addEventListener("click", (e) => {
        e.stopPropagation();
        const node = live.nodes.get(r.id);
        if (shown) {
          const was3D = (node?.visible3D as boolean | undefined) ?? true;
          live.write({ op: "patch", id: r.id, path: "#/visible3DBeforeHide", value: was3D });
          live.write({ op: "patch", id: r.id, path: "#/visible3D", value: false });
          live.write({ op: "patch", id: r.id, path: "#/visible", value: false });
        } else {
          const back = (node?.visible3DBeforeHide as boolean | undefined) ?? (node?.visible3D as boolean | undefined) ?? true;
          live.write({ op: "patch", id: r.id, path: "#/visible", value: true });
          live.write({ op: "patch", id: r.id, path: "#/visible3D", value: back });
        }
        render();
      });
      // SEE-THROUGH FOR THE WHOLE SEGMENTATION. Ron: "each segmentation can be made transparent."
      // The same control as on a structure row, over every structure of this root; the tree's
      // own column refines it structure by structure.
      const segsOf = (live.nodes.get(r.id)?.segments as (SceneSegment & { opacity?: number })[] | undefined) ?? [];
      const clearN = segsOf.filter((sg) => (sg.opacity ?? 1) < 1).length;
      const rcs = clearN === 0 ? "none" : clearN === segsOf.length ? "all" : "some";
      const ghost = document.createElement("button");
      ghost.className = "sl-anat-ghost" + (rcs === "all" ? " sl-anat-ghost-on" : rcs === "some" ? " sl-anat-ghost-mixed" : "");
      ghost.type = "button";
      ghost.textContent = "◐";
      ghost.title = rcs === "all" ? "Solid again" : rcs === "none" ? "See-through in 3D (40%), every structure" : "Some structures see-through — click to make all see-through";
      ghost.addEventListener("click", (e) => {
        e.stopPropagation();
        setSegmentOpacity(r.id, segsOf.map((sg) => sg.labelValue), rcs === "all" ? 1 : SEE_THROUGH);
        render();
      });
      // THE ONE WAY INTO THE SEGMENT EDITOR (Ron, 2026-09-25: "lets start with only one way in: segmentations"): Edit
      // opens the editor on THIS segmentation. While its edits wait, the row's button is the yellow Save… instead
      // (the colored button shows what waits; no orange), and the box's other yellow, Merge…, goes plain.
      const edited = live.nodes.get(r.id)?.edited === true;
      const act = document.createElement("button");
      act.type = "button";
      act.className = "sl-seg-edit" + (edited ? " sl-primary" : "");
      act.textContent = edited ? "Save…" : "✎ Edit";
      act.title = edited ? "Save the edits: a new series beside the original (the original stays unchanged); the Segment Editor says more" : "Change this segmentation by hand in the Segment Editor";
      act.addEventListener("click", (e) => {
        e.stopPropagation();
        const gg = globalThis as unknown as { __editSegmentation?: (id: string) => void; __saveEditedSegmentation?: (id: string) => Promise<{ ok: boolean; name?: string; error?: string; kept?: string }> };
        if (!edited) { gg.__editSegmentation?.(r.id); return; }
        void runAction(act, async () => {
          const res = await gg.__saveEditedSegmentation?.(r.id);
          if (!res?.ok) throw new Error(res?.error ?? "not saved");
          status(`Saved: “${res.name}”${res.kept ? ` — ${res.kept}` : ""}`);
          render();
        }, { busyLabel: "Saving…", doneLabel: "Saved", failedLabel: "Not saved" }).catch(() => {});
      });
      item.append(eye, ghost, nm, cnt, act);
      // A CLICK ON THE ROW THAT IS ALREADY CHOSEN CHANGES NOTHING, so it must not redraw: a
      // double-click is two clicks first, and a redraw after the second one detached the name the
      // dblclick was then delivered to -- the rename input went into an element no longer on the
      // page. Ron, 2026-09-22: "double click to rename does not work."
      item.addEventListener("click", () => { if (chosen === r.id) return; chosen = r.id; selected.clear(); render(); });
      rootsSec.appendChild(item);
    }

    // THE TREE.
    const treeSec = shell.section(root, "Structures", {
      open: true,
      band: "green",   // a list of what exists (PALETTE.md, section colors); the yellow button is in the row below the tree
      note: current ? `${current.segments.length}` : "",
    });
    const find = document.createElement("input");
    find.type = "search";
    find.className = "sl-anat-filter";
    find.placeholder = "";
    find.classList.add("sl-search");
    find.title = "Type a structure's name to find it in the tree";
    find.value = filter;
    // Ron: "search is extremely important, once you have more than 10 segmentations or so."
    // Typing is handled below, once the list exists: a keystroke redraws the list only.

    /**
     * SHOW OR HIDE THE WHOLE LIST IN ONE CLICK. Ron: "can you add a turn off/on all button to the
     * segmentations display?"
     *
     * With 111 structures, "show me only the vessels" is a hundred and five clicks the other way
     * round, and getting back from it is a hundred and eleven.
     *
     * IT ACTS ON WHAT THE LIST SHOWS, so with a filter typed it is scoped to the matches -- which is
     * the useful half of it: "rib" then Hide these 24 leaves everything else alone. The label says
     * which of the two it will do rather than leaving it to be discovered, so there is nothing to
     * learn: it reads "Hide all" or "Show these 24".
     *
     * ONE BUTTON, NOT TWO, and it follows the same rule the per-row eyes follow: anything still
     * visible means the click hides; nothing visible means it shows. So it is never a no-op, and the
     * way back from a hide is the same button.
     */
    // WHICH TERMINOLOGY THIS SEGMENTATION IS NAMED IN. SlicerHeart ships four terminologies for four
    // anatomical variants of the same vessels; the same name is a different concept in each. So the
    // context is a property of the segmentation, consulted before every other loaded terminology
    // and before the built-in tables. Only shown once a terminology has been loaded: for a scene
    // with none, the built-in tables are the only answer and a chooser would be noise.
    const contextOf = (current ? live.nodes.get(current.id)?.terminology : undefined) as string | undefined;
    const loaded = terminologies();
    // The terminology tools go under Advanced (built after the tree; PALETTE.md, module rules,
    // 2026-09-22): a row here was one more thing between the search and the tree.
    let advRow: HTMLElement | null = null, advForm: HTMLElement | null = null;
    if (current) {
      const row = document.createElement("div");
      row.className = "sl-anat-findrow sl-anat-termrow";
      advRow = row;
      const lab = document.createElement("label");
      lab.textContent = "Named in";
      lab.title = "The terminology this segmentation's names are read in. Its codes, colors and categories win over the built-in tables.";
      const sel = document.createElement("select");
      sel.className = "sl-anat-term";
      const opt = (value: string, text: string) => { const o = document.createElement("option"); o.value = value; o.textContent = text; if (value === (contextOf ?? "")) o.selected = true; sel.appendChild(o); };
      opt("", "built-in tables");
      for (const t of loaded) opt(t.id, `${t.name}${t.schemes.length ? ` (${t.schemes.join(", ")})` : ""}`);
      sel.addEventListener("change", () => {
        live.write({ op: "patch", id: current.id, path: "#/terminology", value: sel.value || null });
        render();
      });
      // NEW TERM. Ron, on the Colors module: "mostly feature complete but not user friendly" -- to
      // add a term there you must know the CSV's columns and what a coding scheme designator is.
      // Here it is a name, a category, a color; the code is minted (99ALBULA, DICOM's private
      // range) and the term lands in a terminology of the person's own, in the scene, so it is in
      // the session; Export writes it as the color-table CSV Slicer reads.
      const newBtn = document.createElement("button");
      newBtn.type = "button"; newBtn.className = "sl-tool"; newBtn.textContent = "New term…";
      newBtn.title = "Add a term the built-in tables do not have: a name, a category, a color. The code is minted for you.";
      newBtn.addEventListener("click", () => { termForm = termForm ? null : { name: "", category: "", target: "" }; render(); });
      row.append(lab, sel, newBtn);
      const mineList = loaded.filter((t) => (t as { editable?: boolean }).editable);
      if (contextOf && mineList.some((t) => t.id === contextOf)) {
        const exp = document.createElement("button");
        exp.type = "button"; exp.className = "sl-tool"; exp.textContent = "Export…";
        exp.title = "Write this terminology as a color-table CSV: what Slicer's Colors module reads, and a spreadsheet, and git.";
        exp.addEventListener("click", () => {
          const t = terminology(contextOf)!;
          const blob = new Blob([toColorTableCsv(t)], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href = url; a.download = `${t.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          status(`Segmentations: exported ${t.name} (${Object.keys(t.entries).length} terms)`);
        });
        row.append(exp);
      }
      if (termForm) advForm = buildTermForm(current.id, contextOf, mineList);
    }

    const tree = buildSegmentTree(current?.segments ?? [], contextOf);
    lastTree = tree;
    // A SEGMENTATION ARRIVES FOLDED TO ITS SYSTEMS -- and keeps whatever folding it was given, so
    // coming back to it finds it as it was left.
    // WHICH ONES ARE NEW IS ASKED BEFORE ANY OF THEM IS FOLDED: `closedFor` creates the entry, so
    // reading the map afterwards finds every segmentation "already known" and the views are never
    // told about the folding they arrived with -- measured in the pane, 14 groups folded on screen
    // and 0 published.
    const fresh = roots().filter((r) => !closedBy.has(r.id)).map((r) => r.id);
    closed = current ? closedFor(current.id, tree) : new Set<string>();
    // A segmentation the scene restored already tells the views what to paint; only one that
    // arrives with nothing is published over.
    for (const id of fresh) if (!((live.nodes.get(id) as unknown as { mergedGroups?: unknown[] } | undefined)?.mergedGroups ?? []).length) publishMergesFor(id);
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "sl-tool sl-anat-all";
    let act = showHideAllState([], false);
    const updateAll = () => {
      const f = filter.trim().toLowerCase();
      act = showHideAllState(matchingLeaves(tree, f), f.length > 0);
      allBtn.textContent = act.label;
      allBtn.title = act.title;
      allBtn.disabled = act.labels.length === 0;
    };
    updateAll();
    allBtn.addEventListener("click", () => {
      if (chosen && act.labels.length) setSegmentVisible(chosen, act.labels, act.show);
      render();
    });

    // THE TOGGLE, with the label saying which of the two the click will do — the same grammar as
    // the Show / Hide button beside it, so neither has to be learned.
    const foldBtn = document.createElement("button");
    foldBtn.type = "button";
    foldBtn.className = "sl-tool";
    const overview = overviewOf(tree);
    let allFolded = false;
    // Recomputed rather than captured, because the keystroke handler redraws the list under it.
    const updateFold = () => {
      const searching = filter.trim().length > 0;
      allFolded = overview.size > 0 && [...overview].every((id) => closed.has(id));
      foldBtn.textContent = allFolded ? "Open all" : "Fold groups";
      // WHILE A SEARCH IS TYPED THERE IS NOTHING TO FOLD: the search opens what it must to show a
      // match, so the button would have offered "Open all" over a tree that is already open
      // (critic 3.1). It says why instead of going quiet.
      foldBtn.disabled = overview.size === 0 || searching;
      foldBtn.title = searching
        ? "Clear the search to fold the tree again"
        : allFolded
        ? "Show every structure, each in its own color"
        : "Show the systems with their groups folded — a folded group draws as one color";
    };
    updateFold();
    foldBtn.addEventListener("click", () => {
      closed.clear();
      if (!allFolded) for (const id of overview) closed.add(id);
      publishMerges();
      render();
    });

    // On one line with the filter, because the filter is what scopes it.
    const findRow = document.createElement("div");
    findRow.className = "sl-anat-findrow";
    findRow.appendChild(find);
    findRow.appendChild(foldBtn);
    findRow.appendChild(allBtn);
    treeSec.appendChild(findRow);

    const list = document.createElement("div");
    list.className = "sl-anat-tree";
    const fillList = () => {
      list.replaceChildren();
      for (const n of tree) rowFor(n, 0, list);
      if (!list.children.length) {
        const none = document.createElement("p");
        none.className = "sl-hint";
        none.textContent = filter ? `no structure matching "${filter}"` : "this segmentation has no segments";
        list.appendChild(none);
      }
    };
    fillList();
    treeSec.appendChild(list);
    // COLORS OTHER THAN THE SCHEME'S, said once, with the one button (logic/scheme-colors.ts). Ron, 2026-09-25: what
    // arrives keeps its colors, nobody is asked; bringing it to the current scheme is a click.
    const off = segmentationsOffScheme(live);
    if (off.length) treeSec.appendChild(schemeRow(off));
    // The module's buttons at the bottom of its last list, as everywhere (critic 2026-09-22, 2.5).
    treeSec.appendChild(actionsRow());
    // A KEYSTROKE REDRAWS THE LIST, NOT THE PANEL. The first version re-rendered everything, this
    // input included, and the focus went with the old one -- so every character needed a click
    // to type the next. Re-focusing the new input after the render fixed it in Chrome and not in
    // the app's WebKit (Ron, 2026-09-21, after a demo: "The search in the segmentations module
    // requires a click after each letter. Not workable."). Now the input is never replaced: the
    // rows under it are, and the Show / Hide button's label follows.
    find.addEventListener("input", () => { filter = find.value; fillList(); updateAll(); updateFold(); publishMerges(); });
    if (advRow) {
      const adv = shell.section(root, "Advanced", { open: !!termForm, band: "none" });
      adv.appendChild(advRow);
      if (advForm) adv.appendChild(advForm);
    }

    if (selected.size) {
      const sel = document.createElement("div");
      sel.className = "sl-row sl-anat-selbar";
      const label = document.createElement("span");
      label.className = "sl-hint";
      label.textContent = `${selected.size} selected`;
      const move = document.createElement("button");
      move.textContent = "Move to…";
      move.title = "Move the selected structures into another segmentation";
      move.addEventListener("click", () => moveToRoot(""));
      sel.append(label, move);
      treeSec.appendChild(sel);
    }
  }

  function schemeRow(off: { id: string; name: string; differ: number }[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-row sl-scheme-row";
    const say = document.createElement("span");
    say.className = "sl-hint";
    const segs = off.reduce((n, o) => n + o.differ, 0);
    say.textContent = `${off.length === 1 ? "One segmentation keeps the colors it" : `${off.length} segmentations keep the colors they`} arrived with: ${segs} structure${segs === 1 ? " differs" : "s differ"} from colors v${paletteVersion()}.`;
    say.title = off.map((o) => `${o.name}: ${o.differ}`).join("\n");
    const use = document.createElement("button");
    use.textContent = "Use the current colors";
    use.title = `Color ${off.length === 1 ? "it" : "them"} with the current scheme, v${paletteVersion()} (Settings › General › Colors). Nothing else changes; saving keeps the new colors.`;
    use.addEventListener("click", () => {
      const n = off.reduce((k, o) => k + useCurrentColors(live, o.id), 0);
      status(`Colors: ${n} structure${n === 1 ? "" : "s"} now in the colors of v${paletteVersion()}`);
      render();
    });
    row.append(say, use);
    return row;
  }

  function actionsRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "sl-row sl-anat-actions";
    const add = document.createElement("button");
    add.textContent = "New segmentation";
    add.title = "An empty segmentation on the chosen volume, to draw in with the Segment Editor";
    add.addEventListener("click", () => void newRoot());
    // SEVERAL INTO ONE. Ron: "Moose does everything separate: abdominal organs, cardiac, digestive
    // system. How do I merge them once they are listed in segmentations?" A voxel operation with a
    // window of its own (merge-segmentations.ts); the result is a new root, the inputs stay.
    const merge = document.createElement("button");
    // The one thing here that makes something (PALETTE.md, 2026-09-22) -- plain while a row's Save… is the yellow one.
    const anyEdited = roots().some((r) => live.nodes.get(r.id)?.edited === true);
    merge.className = anyEdited ? "" : "sl-primary";
    merge.textContent = "Merge…";
    merge.title = "Combine two or more of these segmentations into a new one. Where two claim the same voxel, you decide which keeps it.";
    merge.disabled = roots().length < 2;
    merge.addEventListener("click", () => openMergeWindow({
      live, store, roots: roots(), status,
      onMerged: (segId) => { chosen = segId; selected.clear(); render(); },
    }));
    row.append(add, merge);   // yellow at the right end
    return row;
  }

  shell.registerPanel({
    id: "segmentations",
    title: "Segmentations",
    // DATA, not Segmentation: this module organizes what exists; AI Segmentations and the Segment
    // Editor make labels. Ron, 2026-09-22: "Segmentations is conceptually something different. Its
    // about organizing data" and, on the module list, "the segmentations belong elsewhere."
    groups: ["Data"],
    order: 3,
    tip: "Every segmented structure as an anatomy tree: show, hide, color, see-through; merge segmentations",
    help: `<p>Everything segmented on the loaded volumes, as an anatomical tree. Each segmentation is
      a <b>root</b>; pick one to see its structures.</p>
      <p>The eye on a group acts on everything under it. Branches collapse, and the search finds a
      structure wherever it is — a match in a closed branch opens it rather than hiding.</p>
      <p>ts:total returns 117 structures; the tree shows them as ten rows.</p>
      ${describeCorrections()}`,
    acknowledgements: [
      "Terminologia Anatomica (TA2), FIPAT — the containment hierarchy the tree follows",
      "SNOMED CT — the concept identifier each structure carries, as the segmenter asserted it",
      "Open Anatomy Browser (Michael Halle) — the tree-with-columns this is modeled on",
    ],
    mount(el) {
      root = el;
      render();
    },
  });

  // ONLY WHAT THIS PANEL SHOWS, AND AT MOST ONCE A FRAME.
  //
  // This re-rendered on EVERY scene change, unfiltered — and a scene change is not only a new
  // segmentation: slice offsets, camera, view state and every visibility patch are changes too. With
  // ts:total selected the panel rebuilds 164 rows, so a stream of changes meant rebuilding 164 rows
  // over and over on the main thread, which is the thread the views draw on. Ron: "when I selected
  // total in the segmentation window it lengthened the window and everything disappeard."
  //
  // Two guards, both of which load-panel.ts already had and I did not copy: filter to the node types
  // this panel actually draws, and coalesce a burst into one render on the next frame.
  let pending = false;
  const schedule = () => {
    if (pending || !root) return;
    pending = true;
    // A FRAME, OR A TIMER IF NO FRAME COMES. `requestAnimationFrame` does not fire while the window
    // is hidden or minimized, and the flag guarding against a burst then stayed set for ever: every
    // later change was dropped and the module still read "No segmentations yet" over a scene with
    // four of them. Found while testing in a hidden window, 2026-09-22 -- the same escape hatch the
    // AI panel's paint-first wait needed for the same reason, and the same lesson: a window nobody
    // is looking at is still a window that must be correct when it is looked at again.
    let done = false;
    const run = () => { if (done) return; done = true; pending = false; if (root) render(); };
    requestAnimationFrame(run);
    setTimeout(run, 250);
  };
  live.subscribe?.((c) => {
    if (c.type !== "segmentation" && c.type !== "terminology" && c.kind !== "remove" && c.kind !== "reset") return;
    // FOLDED ON ARRIVAL EVEN IF THIS MODULE HAS NEVER BEEN OPENED. The folding is what the VIEWS
    // draw, and the panel's render was the only thing that did it -- so the first segmentation of a
    // session appeared in leaf colors and changed the moment Segmentations was first opened, while
    // every later one arrived folded (critic 2026-09-22, 3.3).
    for (const r of roots()) {
      if (closedBy.has(r.id)) continue;
      if (((live.nodes.get(r.id) as unknown as { mergedGroups?: unknown[] } | undefined)?.mergedGroups ?? []).length) continue;   // the scene's own folding
      publishMergesFor(r.id);
    }
    for (const id of [...closedBy.keys()]) if (!roots().some((r) => r.id === id)) closedBy.delete(id);
    schedule();
  });
}
