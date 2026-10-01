/**
 * The network browser: every segmentation network the server has, in a table you can narrow.
 *
 * Ron, 2026-09-11: "We have over 70 networks. I am sure we will get more. I know for most not
 * what they are doing. It would be nice to have a pop-up window that lists the network, modality,
 * body region, and number of structures. Faceted search would be good so I can select head, mr
 * or such."
 *
 * WHAT IS KNOWN AND FROM WHERE. haversack's catalog gives the name and the family; its per-task
 * description gives the modality, the structure list and its count, how many networks the task
 * runs and whether their weights are on this machine. The body region is NOT in any of that
 * (checked on all 75 tasks): it is derived here from the structure names, or from the task's
 * name when it lists no structures, and the cell's tooltip says which. The paper is Albula's
 * own table per family; "last run here" is Albula's own memory of what a task cost on this
 * machine -- a fact about the past, and only for tasks that have run.
 *
 * Facets are rows of chips: within a row any of the chosen values matches; across rows all must.
 * The text box matches the name, the family and every structure name, because the thing a
 * person knows is the organ, not which of six networks produces it.
 */
import { escapeHtml } from "./html.ts";
import type { HaversackTask } from "../../logic/haversack.ts";
import { parseTask } from "../../logic/task-name.ts";
import { paperFor } from "../../logic/anatomy/model-papers.ts";
import { type Region, REGIONS, regionsOfStructures, regionsOfTaskName } from "../../logic/anatomy/regions.ts";
import { openFloatingWindow } from "./floating-window.ts";

export interface NetworkRow {
  name: string;
  family: string;             // human name of the ecosystem, from the papers table, else the prefix
  modality: string;           // CT, MR, PT -- as the server says it, normalised for the facet
  regions: Region[];
  regionSource: "structures" | "name" | "";
  structures: string[];
  nStructures?: number;
  networks?: number;          // how many networks the task runs in sequence
  installed?: boolean;        // weights on this machine; undefined = the server did not say
  detailed: boolean;          // the per-task description has arrived
}

export interface NetworkBrowserOptions {
  catalog: HaversackTask[];
  selected: string;
  /** What a task cost the last time it actually ran on this machine, in ms; undefined if never. */
  lastRunMs?: (task: string) => number | undefined;
  onChoose: (task: string) => void;
  onOpenUrl?: (url: string) => void;
  /** Several at once: tick networks, press "Run the N ticked", and they run in a row as jobs. */
  onRunMany?: (tasks: string[]) => void;
}

/** Per-task descriptions, kept for the page's life: the catalog does not change under us. */
const details = new Map<string, Record<string, unknown> | null>();

async function describe(name: string): Promise<Record<string, unknown> | null> {
  if (details.has(name)) return details.get(name)!;
  try {
    const d = await fetch(`/_haversack/tasks/${encodeURIComponent(name)}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null);
    details.set(name, d);
    return d;
  } catch { return null; }
}

const modalityFacet = (m: string | undefined) => {
  const u = (m ?? "").toUpperCase();
  return u.startsWith("MR") ? "MR" : u.startsWith("CT") ? "CT" : u.startsWith("PT") || u.startsWith("PET") ? "PT" : u ? u : "?";
};

/** How a family writes its own name, for the ones with no paper on file yet. */
const FAMILY_NAMES: Record<string, string> = { mrsegmentator: "MRSegmentator" };

function rowFromCatalog(t: HaversackTask): NetworkRow {
  const paper = paperFor(t.name);
  // The family facet carries the version when the name does: "TotalSegmentator v2" and
  // "TotalSegmentator v3" are two rows a person chooses between, not one.
  const parsed = parseTask(t.name);
  const eco = parsed.ecosystem || t.ecosystem || t.name;
  const family = (paper?.name ?? FAMILY_NAMES[eco] ?? eco) + (parsed.version ? ` ${parsed.version}` : "");
  return {
    name: t.name, family,
    modality: modalityFacet(t.modality), regions: [], regionSource: "", structures: [], installed: t.installed, detailed: false,
  };
}

function fillFromDetail(row: NetworkRow, d: Record<string, unknown> | null): void {
  row.detailed = true;
  if (!d) return;
  if (typeof d.modality === "string") row.modality = modalityFacet(d.modality);
  const s = Array.isArray(d.structures) ? (d.structures as string[]) : [];
  row.structures = s;
  row.nStructures = typeof d.n_structures === "number" ? d.n_structures : s.length || undefined;
  row.networks = Array.isArray(d.weights) ? (d.weights as unknown[]).length : undefined;
  const w = Array.isArray(d.weights_installed) ? (d.weights_installed as { installed?: boolean }[]) : [];
  if (w.length) row.installed = w.every((x) => x.installed === true);
  if (s.length) { row.regions = regionsOfStructures(s).regions; row.regionSource = "structures"; }
  else { row.regions = regionsOfTaskName(row.name); row.regionSource = row.regions.length ? "name" : ""; }
}

const fmtMs = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(0)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

/** Open the browser over the whole window. Returns a function that closes it. */
export function openNetworkBrowser(o: NetworkBrowserOptions): () => void {
  const rows = o.catalog.map(rowFromCatalog).sort((a, b) => a.name.localeCompare(b.name));
  let selected = o.selected;
  for (const r of rows) { const d = details.get(r.name); if (d !== undefined) fillFromDetail(r, d); }

  // ---- facets: chosen values per facet; empty = no restriction ----
  const chosen: Record<string, Set<string>> = { modality: new Set(), region: new Set(), family: new Set(), ready: new Set() };
  let text = "";

  // THE SAME WINDOW AS THE DICOM BROWSER: title bar with the traffic lights, drag, resize, Escape.
  // Ron: "quitting the window should be the same as the dicom window and future windows."
  const win = openFloatingWindow({ title: "Segmentation networks", size: { w: 1180, h: 860 }, zIndex: 2100 });
  const { box, head } = win;
  head.classList.add("sl-netb-head");
  head.insertAdjacentHTML("beforeend", `<span class="sl-netb-count"></span>
      <input class="sl-netb-search sl-search" type="search" placeholder="" title="Type a network, a family or a structure — liver, aorta, ts:" spellcheck="false">`);
  const back = document.createElement("div");
  back.className = "sl-netb-body";
  back.innerHTML = `<div class="sl-netb-facets"></div>
    <div class="sl-netb-scroll"><table class="sl-netb-table"><thead><tr>
      <th></th>${o.onRunMany ? '<th class="sl-netb-tick" title="Tick several networks to run them in a row"></th>' : ""}<th>Network</th><th>Family</th><th>Modality</th><th>Region</th><th class="sl-netb-num">Structures</th><th>Runs here</th><th>Last run here</th><th>Paper</th>
    </tr></thead><tbody></tbody></table></div>
    <div class="sl-netb-foot"><span class="sl-netb-note">Region is read off each network's structure names (hover a region to see which), not stated by the server; a whole-body network is listed under every region.</span>${
      o.onRunMany ? '<button class="sl-primary sl-netb-run-many" disabled title="Run every ticked network on the chosen volume, one after another; each lands in the scene as it finishes">Run the ticked</button>' : ""}</div>`;
  box.appendChild(back);
  const q = <T extends Element>(sel: string) => box.querySelector(sel) as T;
  const facetsEl = q<HTMLElement>(".sl-netb-facets"), tbody = q<HTMLTableSectionElement>("tbody"), countEl = q<HTMLElement>(".sl-netb-count");
  const search = q<HTMLInputElement>(".sl-netb-search");
  // TICKED, FOR RUNNING SEVERAL IN A ROW. Ron, 2026-09-14: "yes to tick several networks and run
  // them in a row" (CADS is nine models with no combined task, by design). Use is still the
  // single choice; the ticks survive a search or a facet change.
  const ticked = new Set<string>();
  const runMany = q<HTMLButtonElement>(".sl-netb-run-many");
  const paintRunMany = () => { if (!runMany) return; runMany.disabled = !ticked.size; runMany.textContent = ticked.size ? `Run the ${ticked.size} ticked` : "Run the ticked"; };
  runMany?.addEventListener("click", () => { const names = rows.map((r) => r.name).filter((n) => ticked.has(n)); win.close(); o.onRunMany?.(names); });

  const readyOf = (r: NetworkRow) => r.installed === true ? "ready here" : r.installed === false ? "needs a download" : "not known yet";

  function matches(r: NetworkRow): boolean {
    if (chosen.modality.size && !chosen.modality.has(r.modality)) return false;
    // A whole-body network covers every region: choosing Abdomen must list ts:total. Ron: "ts:total
    // will run on an abdominal only even though the network has wider coverage."
    if (chosen.region.size && !r.regions.includes("Whole body") && !r.regions.some((x) => chosen.region.has(x))) return false;
    if (chosen.family.size && !chosen.family.has(r.family)) return false;
    if (chosen.ready.size && !chosen.ready.has(readyOf(r))) return false;
    if (text) {
      const t = text.toLowerCase();
      if (!(r.name.toLowerCase().includes(t) || r.family.toLowerCase().includes(t) || r.structures.some((s) => s.toLowerCase().includes(t)))) return false;
    }
    return true;
  }

  function paintFacets() {
    const facet = (key: string, label: string, values: string[], count: (v: string) => number) => {
      if (!values.length) return "";
      return `<div class="sl-netb-facet"><span class="sl-netb-facet-label">${label}</span>` +
        values.map((v) => `<button class="sl-netb-chip${chosen[key].has(v) ? " sl-netb-chip-on" : ""}" data-facet="${key}" data-value="${v}">${v} <span class="sl-netb-chip-n">${count(v)}</span></button>`).join("") +
        `</div>`;
    };
    // Counts are of rows matching every OTHER restriction, so a chip says what choosing it yields.
    const countWith = (key: string, v: string) => rows.filter((r) => {
      const saved = chosen[key]; chosen[key] = new Set([v]);
      const ok = matches(r); chosen[key] = saved; return ok;
    }).length;
    const mods = [...new Set(rows.map((r) => r.modality))].sort();
    const fams = [...new Set(rows.map((r) => r.family))].sort();
    facetsEl.innerHTML =
      facet("modality", "Modality", mods, (v) => countWith("modality", v)) +
      facet("region", "Region", [...REGIONS], (v) => countWith("region", v)) +
      facet("family", "Family", fams, (v) => countWith("family", v)) +
      facet("ready", "Runs here", ["ready here", "needs a download", "not known yet"].filter((v) => rows.some((r) => readyOf(r) === v)), (v) => countWith("ready", v));
    facetsEl.querySelectorAll<HTMLButtonElement>(".sl-netb-chip").forEach((b) => b.addEventListener("click", () => {
      const set = chosen[b.dataset.facet!], v = b.dataset.value!;
      if (set.has(v)) set.delete(v); else set.add(v);
      paint();
    }));
  }

  function paintRows() {
    const shown = rows.filter(matches);
    countEl.textContent = `${shown.length} of ${rows.length}`;
    tbody.innerHTML = shown.map((r) => {
      const paper = paperFor(r.name);
      const last = o.lastRunMs?.(r.name);
      const regionTitle = r.regionSource === "structures" ? `from its structures: ${r.structures.slice(0, 12).join(", ")}${r.structures.length > 12 ? ", …" : ""}`
        : r.regionSource === "name" ? "from its name only — this network lists no structures" : r.detailed ? "no structures listed and the name says nothing" : "asking the server…";
      const ready = r.installed === true ? `<span class="sl-netb-ok">ready</span>` : r.installed === false ? `download first` : r.detailed ? `<span class="sl-netb-dim">not known</span>` : `<span class="sl-netb-dim">…</span>`;
      const structs = r.nStructures != null ? String(r.nStructures) : r.detailed ? `<span class="sl-netb-dim">—</span>` : `<span class="sl-netb-dim">…</span>`;
      // THE CHOICE IS A BUTTON ON THE ROW, not a hidden click on the row. Ron: "I would like to be
      // able to select a network from this panel. Otherwise I would find a network, then have to
      // memorize, close the window, bring up the pull down, find the correct network." A checkbox
      // was tried; Ron: "Use is better." Use chooses and closes; the row click does the same.
      return `<tr data-name="${escapeHtml(r.name)}"${r.name === selected ? ' class="sl-netb-sel"' : ""}>
        <td class="sl-netb-use">${r.name === selected ? `<span class="sl-netb-current" title="the network chosen now">chosen</span>` : `<button class="sl-netb-use-btn" title="Choose ${escapeHtml(r.name)} and close">Use</button>`}</td>${
        o.onRunMany ? `<td class="sl-netb-tick"><input type="checkbox" class="sl-netb-tick-box"${ticked.has(r.name) ? " checked" : ""} title="Tick to run ${escapeHtml(r.name)} with the others ticked"></td>` : ""}
        <td class="sl-netb-name">${escapeHtml(r.name)}${r.networks && r.networks > 1 ? `<span class="sl-netb-dim" title="runs ${r.networks} networks in sequence — ${r.networks}× the work of a single one"> ×${r.networks}</span>` : ""}</td>
        <td>${r.family}</td><td>${r.modality}</td>
        <td title="${regionTitle}">${r.regions.join(", ") || (r.detailed ? `<span class="sl-netb-dim">—</span>` : `<span class="sl-netb-dim">…</span>`)}</td>
        <td class="sl-netb-num" title="${r.structures.length ? r.structures.join(", ") : "the server lists no structures for this network"}">${structs}</td>
        <td>${ready}</td>
        <td title="${last != null ? "the last time it actually ran on this machine; a later run on the same volume is instant" : "has not run on this machine"}">${last != null ? fmtMs(last) : `<span class="sl-netb-dim">—</span>`}</td>
        <td>${paper ? `<a href="${paper.url}" class="sl-netb-paper" title="${paper.title}">${paper.year}</a>` : `<span class="sl-netb-dim">—</span>`}</td>
      </tr>`;
    }).join("");
    const choose = (name: string) => {
      if (name !== selected) { selected = name; o.onChoose(name); }
      win.close();
    };
    tbody.querySelectorAll<HTMLTableRowElement>("tr").forEach((tr) => tr.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a, .sl-netb-tick")) return;
      choose(tr.dataset.name!);
    }));
    tbody.querySelectorAll<HTMLInputElement>(".sl-netb-tick-box").forEach((cb) => cb.addEventListener("change", (e) => {
      e.stopPropagation();
      const name = cb.closest("tr")!.dataset.name!;
      if (cb.checked) ticked.add(name); else ticked.delete(name);
      paintRunMany();
    }));
    tbody.querySelectorAll<HTMLButtonElement>(".sl-netb-use-btn").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); choose(b.closest("tr")!.dataset.name!);
    }));
    tbody.querySelectorAll<HTMLAnchorElement>("a.sl-netb-paper").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); o.onOpenUrl?.(a.href);
    }));
  }
  function paint() { paintFacets(); paintRows(); }

  search.addEventListener("input", () => { text = search.value.trim(); paint(); });
  paint();
  search.focus();

  // The descriptions, eight at a time; each arrival repaints. Cached, so the second opening is instant.
  const queue = rows.filter((r) => !r.detailed);
  let pending = 0, dirty = false;
  const flush = () => { if (dirty && box.isConnected) { dirty = false; paint(); } };
  const worker = async () => {
    for (;;) {
      const r = queue.shift(); if (!r) return;
      fillFromDetail(r, await describe(r.name));
      dirty = true;
      if (++pending % 8 === 0) flush();
    }
  };
  Promise.all(Array.from({ length: 8 }, worker)).then(flush);
  return win.close;
}
