// THE DATABASES WINDOW: which DICOM databases this Albula knows, what each one is, and a new one.
//
// Ron, 2026-10-01: "if we have several DICOM DB, it would be good to offer a default but on click an overview with the
// available options and their description"; the description "sounds good option to edit might be nice"; and Load / Save
// should offer "load to database with an option to create your own". Behind it, "Albula has to be selfcontained": a
// person without Claude makes, describes and adds databases here, not in settings.ini.
//
// Each database's description lives in its own folder (desktop/db-create.ts, albula-database.json): name, what it holds,
// whether it holds patient data and under which approval, whom to ask, where it came from. A database without one shows
// its settings name and an "Add a description" link.
import { openPackageWindow } from "./package-window.ts";
import { escapeHtml as esc } from "./html.ts";

/** The server's answer for one database (desktop/private-fields.ts, PrivateFieldsSummary). */
interface PrivateFieldsSummary {
  series: number; checked: number; withUnread: number; notWhole: number; cannot: number; sample: number; extensionsFound: boolean;
  checking?: { done: number; of: number };
  blocks: { group: string; creator: string; state: "not read" | "partly read" | "read" | "Albula's own"; series: string[]; seriesNames: string[]; elements: string[]; unread: string[]; read: { reader: string; what: string }[] }[];
}
/** Who wrote a private block, in words, from its creator string; the string itself stays beside it for whoever searches. */
function makerOf(creator: string): string {
  const c = creator.toUpperCase();
  if (c.startsWith("SIEMENS")) return "Siemens";
  if (c.startsWith("GEMS") || c.startsWith("GEHC") || c.startsWith("GE ")) return "GE";
  if (c.startsWith("PHILIPS")) return "Philips";
  if (c.startsWith("ELSCINT")) return "Elscint";
  if (c === "CTP") return "an anonymizer (CTP)";
  if (c.startsWith("MRCOM")) return "a saved scene";
  if (c.startsWith("SLICERALBULA")) return "Albula's own record";
  if (c.startsWith("(NO CREATOR")) return "no maker named";
  return "another program";
}
export interface DbDescription { name: string; holds?: string; patientData?: boolean; approval?: string; contact?: string; source?: string }
export interface RegisteredDb { id: string; path: string; exists: boolean; current: boolean; description?: DbDescription; /** On another Mac (desktop/db-remote.ts), and why it cannot be opened just now. */ remote?: { host: string; why?: string } }

/** Sharing on this Mac, as GET /_db/_sharing says (desktop/sharing.ts). */
interface SharingState { available: boolean; touchID: boolean; databases: string[]; network: { known: boolean; allowed: boolean; count: number; why?: string }; listening: boolean; error?: string;
  pairing: { open: boolean; until?: number; closed?: string; waiting?: string }; name: string; macs: { id: string; name: string; pairedAt: string; confirmedAt?: string }[] }

export async function listDatabases(): Promise<{ databases: RegisteredDb[]; features: string[] }> {
  const j = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { databases?: RegisteredDb[]; features?: string[] };
  return { databases: j.databases ?? [], features: j.features ?? [] };
}

/** The name a person reads: the description's, else the settings key. */
export const dbName = (d: RegisteredDb): string => d.description?.name ?? d.id;

const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) as Record<string, unknown> }));

/** macOS's folder dialog, through the server (desktop/choose-folder.ts). */
export async function chooseFolder(prompt: string): Promise<{ token: string; path: string; name: string; hasDatabase: boolean } | undefined> {
  const { ok, j } = await post("/_db/_choose-folder", { prompt });
  if (!ok) throw new Error(String(j.error ?? "the folder dialog failed"));
  return j.cancelled ? undefined : j as unknown as { token: string; path: string; name: string; hasDatabase: boolean };
}

const FIELDS = `
  <label class="sl-dbw-f"><span>Name</span><input name="name" maxlength="80" placeholder="e.g. Neurosurgery research"></label>
  <label class="sl-dbw-f"><span>What it holds</span><textarea name="holds" maxlength="1000" rows="2" placeholder="e.g. Pre-operative MRIs of brain tumor patients"></textarea></label>
  <label class="sl-dbw-f" title="Public data: de-identified and released for anyone to use, as the collections on IDC or OpenNeuro are, or given by the person it is about. Leave it unticked for anything else."><span>Public data</span><span><input type="checkbox" name="publicData"> released for anyone to use</span></label>
  <label class="sl-dbw-f" title="Optional. The rules differ between countries, and not every use needs an approval; leave it empty if there is none."><span>Approval</span><input name="approval" maxlength="120" placeholder="optional, e.g. an ethics committee or IRB number"></label>
  <label class="sl-dbw-f"><span>Whom to ask</span><input name="contact" maxlength="200"></label>
  <label class="sl-dbw-f"><span>Came from</span><input name="source" maxlength="300" placeholder="e.g. the hospital's PACS, a public collection"></label>`;

function readForm(form: HTMLElement): DbDescription {
  const v = (n: string) => (form.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value.trim() ?? "";
  return { name: v("name"), holds: v("holds"), approval: v("approval"), contact: v("contact"), source: v("source"),
    // ONE QUESTION, PUBLIC OR NOT (Ron, 2026-10-02: "keep it simple: Public data or not"). Stored as before, in
    // patientData, so no description written earlier changes meaning: public = patientData false.
    patientData: !(form.querySelector('[name="publicData"]') as HTMLInputElement).checked };
}
function fillForm(form: HTMLElement, d?: DbDescription) {
  for (const n of ["name", "holds", "approval", "contact", "source"] as const) (form.querySelector(`[name="${n}"]`) as HTMLInputElement).value = d?.[n] ?? "";
  (form.querySelector('[name="publicData"]') as HTMLInputElement).checked = d?.patientData === false;
}

/** A database in the databases folder that Albula does not use, or one switched off from elsewhere (GET /_db `found`). */
interface Found { path: string; name: string; holds?: string; elsewhere?: boolean; exists: boolean }

export interface DatabasesOptions {
  /** After the current database changed, or one was made or added. `id` is the one made or added. */
  onChanged?: (id?: string) => void;
  /** Where a notice goes (the shell's). */
  notify?: (o: { title: string; body?: string; ttl?: number }) => void;
}

/** The Databases section, drawn into `host` (Load / Save; Ron, 2026-10-29). `refresh` draws it again (a database made
 *  or chosen elsewhere); `startNew` opens the New database form in it. */
export interface DatabasesSection { refresh(): Promise<void>; startNew(): HTMLElement | undefined }

/**
 * THE DATABASES SECTION (Ron, 2026-10-26: "a database management section instead where we provide a root directory and
 * then allow to select, add, remove, remove and delete functionality. The functions should have proper feedback"; his
 * answers of 2026-10-29: "Q1: a section", "Q2: List all, provide sliders to add them to the listing. In a remote access
 * situation list the ones that are available", "q: c", "2 gone", "3 second switch"; mockups/databases-2026-10-29.html).
 * It replaces the Databases window. Every database in the databases folder is a row: a switch says whether Albula uses
 * it, a second switch whether it is shared with the other Macs; one click on a row makes it the one Albula opens; its ⋯
 * holds Describe…, Show in Finder and Move to the Trash…. Databases elsewhere and on other Macs are rows too.
 */
export function mountDatabases(host: HTMLElement, o: DatabasesOptions = {}): DatabasesSection {
  const body = document.createElement("div");
  body.className = "sl-dbw";
  host.appendChild(body);
  const style = document.createElement("style");
  style.textContent = `
    .sl-dbw-name { font-weight:600; }
    .sl-dbw-tag { display:inline-block; border-radius:9px; padding:0 7px; margin-left:6px; font-size:10px; background:var(--sl-pill-bg); color:var(--sl-pill-fg); border:1px solid var(--sl-pill-edge); font-weight:400; }
    .sl-dbw-tag.sl-pt { background:var(--sl-error-bg); color:var(--sl-error-fg); border-color:var(--sl-error-edge); }
    .sl-dbw-meta { color:var(--sl-fg-dim); font-size:11px; margin-top:2px; overflow-wrap:anywhere; }
    .sl-dbw-holds { margin:4px 0 0; }
    .sl-dbw-acts { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
    .sl-dbw-acts.sl-end { justify-content:flex-end; }
    .sl-dbw-f { display:grid; grid-template-columns:96px 1fr; gap:8px; align-items:center; margin:5px 0; }
    .sl-dbw-f > span:first-child { color:var(--sl-fg-dim); text-align:right; font-size:11px; }
    .sl-dbw-f textarea, .sl-dbw-f input:not([type=checkbox]) { width:100%; box-sizing:border-box; }
    .sl-dbw-form { border:1px solid var(--sl-line-strong); border-radius:var(--sl-radius); padding:8px 10px; margin:6px 0 10px; }
    .sl-dbw-err { color:var(--sl-error); font-size:11px; }
    .sl-dbw-said { margin:8px 0 0; padding:6px 8px; border-radius:var(--sl-radius); background:var(--sl-accent-wash); border:1px solid var(--sl-accent); color:var(--sl-fg); font-size:12px; }
    .sl-dbw-said:empty { display:none; }
    .sl-dbw-rm { border-top:1px solid var(--sl-line); margin-top:8px; padding-top:6px; }
    .sl-dbw-tag.sl-sh { background:var(--sl-ok-bg, rgba(143,199,154,.15)); color:var(--sl-ok, #8fc79a); border-color:var(--sl-ok-edge, rgba(143,199,154,.45)); }
    .sl-dbw-folder { display:flex; gap:6px; align-items:center; padding:2px 0 6px; border-bottom:1px solid var(--sl-line); }
    .sl-dbw-folder .sl-dbw-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sl-dbw-heads { display:grid; grid-template-columns:40px minmax(0,1fr) 40px 28px; gap:6px; font-size:11px; color:var(--sl-fg-dim); padding:4px 2px 0; }
    .sl-dbw-heads span:nth-child(3) { text-align:center; }
    .sl-dbw-row { display:grid; grid-template-columns:40px minmax(0,1fr) 40px 28px; gap:6px; align-items:start; padding:6px 2px; border-bottom:1px solid var(--sl-line); border-radius:4px; }
    .sl-dbw-row.sl-pick { cursor:pointer; }
    .sl-dbw-row.sl-pick:hover { background:rgba(255,255,255,.03); }
    .sl-dbw-row.sl-cur { background:var(--sl-accent-wash); outline:1px solid var(--sl-accent); }
    .sl-dbw-row.sl-off .sl-dbw-text { opacity:.55; }
    .sl-dbw.sl-noshare .sl-dbw-heads, .sl-dbw.sl-noshare .sl-dbw-row { grid-template-columns:40px minmax(0,1fr) 28px; }
    .sl-dbw-row:focus-visible { outline:2px solid var(--sl-accent); outline-offset:1px; }
    .sl-dbw-row > .sl-dbw-sub { grid-column:2 / -1; }
    .sl-dbw-row > .sl-dbw-form, .sl-dbw-row > .sl-dbw-rm { grid-column:1 / -1; cursor:default; }
    .sl-dbw-holds2 { margin:2px 0 0; font-size:12px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .sl-dbw-more { width:28px; min-width:0; height:24px; padding:0; font-size:16px; line-height:1; }
    .sl-dbw-menu { grid-column:2 / -1; display:flex; flex-direction:column; gap:2px; border:1px solid var(--sl-line-strong); border-radius:var(--sl-radius); padding:4px; }
    .sl-dbw-menu button { text-align:left; }
    .sl-dbw-subhead { font-size:11px; color:var(--sl-fg-dim); font-weight:600; margin:10px 0 0; }
    .sl-dbw-adv > summary { cursor:pointer; color:var(--sl-fg-dim); font-size:12px; margin-top:10px; }
    .sl-dbw-sw { position:relative; display:inline-flex; cursor:pointer; margin-top:1px; }
    .sl-dbw-sw input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
    .sl-dbw-sw i { position:relative; width:34px; height:19px; border-radius:10px; background:var(--sl-line-strong); transition:background .15s; flex:none; pointer-events:none; }
    .sl-dbw-sw i::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--sl-fg); transition:left .15s; }
    .sl-dbw-sw input:checked + i { background:var(--sl-ok, #8fc79a); }
    .sl-dbw-sw input:checked + i::after { left:17px; }
    .sl-dbw-sw input:focus-visible + i { outline:2px solid var(--sl-accent); outline-offset:2px; }
    .sl-dbw-sw input:disabled + i { opacity:.45; }
    .sl-dbw-share { display:inline-flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; user-select:none; }
    .sl-dbw-toggle { display:block; width:100%; margin:6px 0 2px; padding:7px 10px; text-align:left; font-size:13px; font-weight:600; }
    .sl-dbw-row > .sl-dbw-rowsaid { grid-column:2 / -1; color:var(--sl-fg); font-size:12px; padding:4px 6px; border-radius:4px; background:var(--sl-accent-wash); border:1px solid var(--sl-accent); }`;
  host.appendChild(style);
  // WHAT WAS JUST DONE, said in a line under the list, until the next action (Ron, 2026-10-26: "The functions should have
  // proper feedback").
  const saidLine = document.createElement("div");
  saidLine.className = "sl-dbw-said";
  saidLine.setAttribute("role", "status");
  const say = (m: string) => { saidLine.textContent = m; };

  let removable = false;
  /** The server says which vendor private fields a database holds (desktop/private-fields.ts). */
  let privateFieldsOn = false;
  /** Sharing on this Mac (desktop/sharing.ts), read with each render; undefined on a server without it. */
  let sharing: SharingState | undefined;
  let canCreate = false, canFound = false, canReveal = false;
  /** Each drawing's number: a poll started by an earlier drawing stops (critic 2026-10-29, Databases section, 14). */
  let drawing = 0;
  /** The order of the databases in the settings file: the server's choice of the next default (db-serve.ts updateDatabases). */
  let order: RegisteredDb[] = [];
  /**
   * THE LIST FOLDED BY DEFAULT (Ron, 2026-10-30: "the default presentation should be only the selected one with a
   * prominent list open/close button"): folded, the section shows the database Albula opens and the button; open, all of
   * it. Remembered in this browser only (a convenience; a private window starts folded).
   */
  let listOpen = (() => { try { return localStorage.getItem("albula.databases.listOpen") === "1"; } catch { return false; } })();
  const setListOpen = (v: boolean) => { listOpen = v; try { localStorage.setItem("albula.databases.listOpen", v ? "1" : "0"); } catch { /* not kept */ } };
  const render = async () => {
    const gen = ++drawing;
    const j = await fetch("/_db", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { databases?: RegisteredDb[]; features?: string[]; folder?: string; folderExists?: boolean; found?: Found[] };
    if (gen !== drawing) return;
    const databases = j.databases ?? [], features = j.features ?? [], found = j.found ?? [];
    privateFieldsOn = features.includes("private-fields");
    canFound = features.includes("found"); canReveal = features.includes("reveal");
    sharing = features.includes("sharing") ? await fetch("/_db/_sharing", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined) : undefined;
    if (gen !== drawing) return;
    canCreate = features.includes("create");
    removable = features.includes("remove");
    order = databases;
    // WHAT IS OPEN IS KEPT (finding 5): a New database form, a row's Describe form or question, typed text and all, go
    // back where they were after the redraw.
    const keptNew = body.querySelector<HTMLElement>(".sl-dbw-new");
    const keptRow = new Map<string, HTMLElement[]>();
    for (const r of body.querySelectorAll<HTMLElement>(".sl-dbw-row[data-key]")) {
      const open = [...r.querySelectorAll<HTMLElement>(":scope > .sl-dbw-form, :scope > .sl-dbw-rm")];
      if (open.length) keptRow.set(r.dataset.key!, open);
    }
    body.innerHTML = "";
    body.classList.toggle("sl-noshare", !sharing?.available);
    // THE FOLDER new databases go into; every database in it is listed. (Change… is not built: where new databases go
    // is fixed today, desktop/db-create.ts defaultDatabasesFolder.)
    const local = databases.filter((d) => !d.remote), remote = databases.filter((d) => d.remote);
    const opened = databases.find((d) => d.current);
    // Nothing opens by default, or a form is open under a row that the fold would hide: the whole list shows.
    const folded = !listOpen && !!opened && !keptNew && [...keptRow.keys()].every((k) => k === opened.id);
    if (j.folder && !folded) {
      const f = document.createElement("div");
      f.className = "sl-dbw-folder";
      f.title = "The folder new databases go into. Every database in it is listed below; the In use switch says whether Albula uses it.";
      f.innerHTML = `<span class="sl-hint">Folder</span><span class="sl-dbw-path">${esc(j.folder.replace(/^\/Users\/[^/]+/, "~"))}</span>`;
      // Show only once the folder is there (finding 12: a first-time user has none until the first database is made).
      if (canReveal && j.folderExists) {
        const show = button("Show", "Open this folder in Finder.");
        show.addEventListener("click", async () => { const { ok, j: r } = await post("/_db/_reveal", { path: j.folder }); if (!ok) say(String(r.error ?? "Finder could not show it.")); });
        f.appendChild(show);
      }
      body.appendChild(f);
    }
    // THE LIST'S ACTIONS AND ITS LINE ABOVE IT (MODULE-DESIGN-RULES, "Nothing important under a list"; finding 3).
    const acts = document.createElement("div");
    acts.className = "sl-dbw-acts sl-end";
    if (canCreate) {
      const ab = button("Add from elsewhere…", "A folder that already holds a DICOM database (made by Slicer or Albula, or copied from someone): it is moved into the databases folder (or copied there, if you choose) and listed.");
      ab.addEventListener("click", () => void addExisting(acts));
      const nb = button("New database…", "An empty database in the databases folder, named and described, ready for scans.", true);
      nb.addEventListener("click", () => newForm(acts));
      acts.append(ab, nb);
    } else {
      acts.innerHTML = `<span class="sl-hint">This Albula's server is older than this page and cannot make databases; rebuild the application.</span>`;
    }
    if (!folded) body.appendChild(acts);
    if (keptNew) acts.after(keptNew);
    // THE FOLD'S BUTTON, above the list (nothing important under a list), as wide as the section.
    const total = databases.length + found.length;
    if (opened && total > 1) {
      const tb = button(folded ? `▸  Show all ${total} databases` : "▾  Show only the database Albula opens",
        folded ? "The list of every database: switch them on or off, share them, choose the one Albula opens, make or add one." : "Fold the list back to the database Albula opens.");
      tb.className = "sl-dbw-toggle";
      tb.setAttribute("aria-expanded", String(!folded));
      tb.addEventListener("click", () => { setListOpen(folded); void render(); });
      body.appendChild(tb);
    }
    body.appendChild(saidLine);
    if (local.length || found.length) {
      const heads = document.createElement("div");
      heads.className = "sl-dbw-heads";
      heads.innerHTML = `<span title="On: Albula uses this database. Off: it stays on disk, unused.">In use</span><span>Click a database to open it by default</span>${sharing?.available ? `<span title="Your other Macs that you allow can open it, on the same network">Shared</span>` : ""}<span></span>`;
      body.appendChild(heads);
    }
    // ONE LIST, BY NAME (finding 14: a row switched off jumped to the bottom): those in use and those not, together.
    const items = [...local.map((d) => ({ name: localName(d), el: () => row(d, j.folder) })), ...found.map((f) => ({ name: f.name, el: () => foundRow(f) }))]
      .sort((a, b) => a.name.localeCompare(b.name));
    if (folded) body.appendChild(row(opened!, j.folder));
    else for (const it of items) body.appendChild(it.el());
    if (remote.length && !folded) {
      body.insertAdjacentHTML("beforeend", `<div class="sl-dbw-subhead">On your other Macs</div>`);
      for (const d of remote) body.appendChild(row(d, j.folder));
    }
    for (const r of body.querySelectorAll<HTMLElement>(".sl-dbw-row[data-key]")) for (const f of keptRow.get(r.dataset.key!) ?? []) r.appendChild(f);
    const none = !databases.length && !found.length;
    if (none) body.insertAdjacentHTML("beforeend", `<p class="sl-hint">No database yet. Make one, add one you have, or get the test cases below.</p>`);
    // THE TEST CASES: in the section while there is no database at all, under its More after that (Ron, "q: c").
    if (none && features.includes("test-cases")) await testCases(body, gen);
    const adv = document.createElement("details");
    adv.className = "sl-dbw-adv";
    adv.open = advOpen;
    adv.addEventListener("toggle", () => { advOpen = adv.open; });
    const summary = document.createElement("summary");
    adv.appendChild(summary);
    const advActs = document.createElement("div");
    advActs.className = "sl-dbw-acts";
    adv.appendChild(advActs);
    // A DATABASE ON ANOTHER MAC (desktop/db-remote.ts; Ron, 2026-10-26: "Databases can be either local or remote").
    if (canCreate && features.includes("remote")) {
      const rb = button("Open a database on another Mac…", "Your other Macs on this network that share databases: connect to one, compare the six digits, and allow it there with Touch ID.");
      rb.addEventListener("click", () => nearbyForm(advActs));
      advActs.appendChild(rb);
    }
    if (sharing?.available && (sharing.databases.length || sharing.macs.length)) {
      adv.appendChild(sharingBox());
      // THE BOX FOLLOWS PAIRING while it is open (the critic, round 2, R2-9): who asks, closed, the five minutes ending.
      if (sharing.pairing.open || sharing.pairing.waiting) {
        const was = JSON.stringify([sharing.pairing, sharing.macs.length]);
        const t = setInterval(async () => {
          if (gen !== drawing || !body.isConnected) { clearInterval(t); return; }
          const now = await fetch("/_db/_sharing", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined) as SharingState | undefined;
          if (now && JSON.stringify([now.pairing, now.macs.length]) !== was) { clearInterval(t); await render(); }
        }, 3000);
      }
    }
    const before = adv.childElementCount;
    if (!none && features.includes("test-cases")) await testCases(adv, gen);
    // NAMED BY WHAT IS IN IT, not "Advanced" a second time right above the module's own Advanced.
    const parts = [advActs.childElementCount ? "databases on other Macs" : "", adv.querySelector(".sl-dbw-name")?.textContent?.startsWith("Sharing") ? "sharing" : "", adv.childElementCount > before ? "the test cases" : ""].filter(Boolean);
    summary.textContent = parts.length ? `More: ${parts.join(", ")}` : "";
    if (parts.length && !folded) body.appendChild(adv);
  };
  let advOpen = false;
  /** A database's name in the list: its description's, else its folder's (not the settings id; finding 14). */
  const localName = (d: RegisteredDb) => d.description?.name ?? (d.remote ? dbName(d) : d.path.replace(/\/+$/, "").split("/").pop() || d.id);

  /**
   * THE PUBLIC TEST CASES (desktop/test-cases.ts; Ron, 2026-10-01: "a good feature to have, with a warning about the
   * size"). Offered while no database holds them; the size is said before anything is fetched; progress while it runs.
   */
  const testCases = async (into: HTMLElement, gen: number) => {
    const t = await fetch("/_db/_test-cases", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { name: string; holds: string; source: string; approxBytes: number; diskBytes?: number; minutes?: number; db: string | null; complete?: boolean; running: string | null } | null;
    // OFFERED UNTIL A RUN HAS FINISHED (critic, finding 3: a stopped download could not be continued from here).
    if (!t || (t.db && t.complete && !t.running)) return;
    const box = document.createElement("div");
    box.className = "sl-dbw-form";
    into.appendChild(box);
    const gb = (t.approxBytes / 1e9).toFixed(1);
    const follow = (job: string) => {
      box.innerHTML = `<div class="sl-dbw-name">${esc(t.name)}</div><div class="sl-dbw-meta sl-tc-p">Starting…</div>`;
      const line = box.querySelector(".sl-tc-p") as HTMLElement;
      const poll = async () => {
        if (gen !== drawing) return;   // a later drawing follows the download with a box of its own
        const j = await fetch(`/_db/_test-cases/${job}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { progress: { phase: string; subject: string; done: number; subjects: number; bytes: number; added: number; skipped: string[]; failed: string[]; earlier?: number }; error?: string; done: boolean; db?: string } | null;
        if (!j) { line.textContent = "The download's progress cannot be read just now; trying again…"; setTimeout(poll, 4000); return; }
        const p = j.progress;
        const mb = Math.round(p.bytes / 1e6);
        if (!j.done) {
          line.textContent = `${p.phase === "converting" ? "Converting" : "Downloading"} ${p.subject ? `${p.subject}, ` : ""}person ${Math.min(p.done + 1, p.subjects || 1)} of ${p.subjects || "…"} · ${mb.toLocaleString()} MB so far. You can keep working; this window can be closed.`;
          setTimeout(poll, 1500);
          return;
        }
        line.textContent = j.error ? `Stopped: ${j.error}. Start again to continue where it stopped.`
          : `Done: ${p.done - p.skipped.length - p.failed.length - (p.earlier ?? 0)} people added (${p.added} scans and outlines)${p.earlier ? `; ${p.earlier} were already there` : ""}${p.skipped.length ? `; ${p.skipped.length} not available` : ""}${p.failed.length ? `; ${p.failed.length} could not be converted: ${p.failed.join("; ")}` : ""}.`;
        o.onChanged?.();
        // THE WAY TO USE THEM (critic, finding 11): "Open a patient…" opens the default database, which was another.
        if (!j.error) {
          const use = button("Open these by default", "Makes the test cases the database Albula opens (Open a patient…, DICOM database…). Your other databases stay in this list.");
          use.addEventListener("click", async () => { await post("/_db", { current: j.db ?? t.db }, "PUT"); o.onChanged?.(); await render(); });
          box.appendChild(use);
        } else setTimeout(() => void render(), 4000);
      };
      void poll();
    };
    if (t.running) { follow(t.running); return; }
    const resuming = !!t.db;
    box.innerHTML = `<div class="sl-dbw-name">Brain tumor test cases${resuming ? " — not finished" : ""}</div>
      <p class="sl-dbw-holds">${esc(t.holds)}</p>
      <div class="sl-dbw-meta">From: ${esc(t.source)}</div>
      <p class="sl-dbw-holds"><b>About ${gb} GB to download${t.diskBytes ? `, and ${(t.diskBytes / 1e9).toFixed(1)} GB of disk` : ""}.</b> It becomes the database “${esc(t.name)}” in SlicerAlbulaDatabases${t.minutes ? `, in about ${t.minutes} minutes on a fast connection (longer on a slow one)` : ""}. You can keep working; if it stops, starting again continues where it was.</p>
      <div class="sl-dbw-acts"></div>`;
    // Not yellow: the section's one yellow is New database… (MODULE-DESIGN-RULES; finding 14).
    const go = button(resuming ? "Continue the download" : `Download (${gb} GB)`, `Downloads about ${gb} GB of public MRI from OpenNeuro and makes the database “${t.name}”.`);
    go.addEventListener("click", async () => {
      go.disabled = true;
      const { ok, j } = await post("/_db/_test-cases", {});
      if (!ok || !j.job) { go.disabled = false; box.appendChild(Object.assign(document.createElement("p"), { className: "sl-dbw-err", textContent: String(j.error ?? "the download did not start") })); return; }
      // NOT onChanged(id): that would make the test database the target of "Also add to" in Load / Save, and real scans
      // from disk would be copied into a database that says it holds public data (critic, finding 2).
      o.onChanged?.();
      follow(String(j.job));
    });
    (box.querySelector(".sl-dbw-acts") as HTMLElement).appendChild(go);
  };

  const button = (label: string, title: string, primary = false) => {
    const b = document.createElement("button");
    b.textContent = label; b.title = title;
    if (primary) b.className = "sl-primary";
    return b;
  };

  /** A slide switch (Ron, 2026-10-28: "use a slide button"); `label` is said to a screen reader and in the tooltip. */
  const slide = (on: boolean, label: string, title: string, change: (on: boolean, cb: HTMLInputElement) => Promise<void>, disabled = false): HTMLElement => {
    const lab = document.createElement("label");
    lab.className = "sl-dbw-sw";
    lab.title = title;
    lab.innerHTML = `<input type="checkbox" role="switch" aria-label="${esc(label)}" ${on ? "checked" : ""} ${disabled ? "disabled" : ""}><i aria-hidden="true"></i>`;
    const cb = lab.querySelector("input") as HTMLInputElement;
    cb.addEventListener("change", async () => { cb.disabled = true; await change(cb.checked, cb); });
    lab.addEventListener("click", (e) => e.stopPropagation());
    return lab;
  };

  /** The ⋯ of a row: its actions, opened under it. */
  const moreMenu = (r: HTMLElement, items: [string, string, () => void][]): HTMLElement => {
    const more = button("⋯", "More: " + items.map((x) => x[0].replace(/…$/, "")).join(", "));
    more.className = "sl-dbw-more";
    more.style.cssText = "width:28px;min-width:0;height:24px;padding:0;margin:0;font-size:16px;line-height:1;";   // over the panel's own button size
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = r.querySelector(".sl-dbw-menu");
      if (open) { open.remove(); return; }
      const m = document.createElement("div");
      m.className = "sl-dbw-menu";
      for (const [label, title, go] of items) {
        const b = button(label, title);
        b.addEventListener("click", (ev) => { ev.stopPropagation(); m.remove(); go(); });
        m.appendChild(b);
      }
      m.addEventListener("click", (ev) => ev.stopPropagation());
      r.appendChild(m);
    });
    return more;
  };

  /** Make a row choose the default by a click or by the keyboard (finding 9: a div no keyboard could reach). */
  const choosable = (r: HTMLElement, label: string, choose: () => Promise<void>) => {
    r.tabIndex = 0;
    r.setAttribute("role", "button");
    r.setAttribute("aria-label", label);
    r.addEventListener("click", (e) => {
      // The row's own controls, its private-fields line and its open forms are theirs (the row itself sits inside the
      // section's <details>); a drag that selected text is not a click.
      const hit = (e.target as HTMLElement).closest("button, input, label, details, summary, .sl-dbw-form, .sl-dbw-rm, .sl-dbw-menu, .sl-dbw-pf");
      if ((hit && r.contains(hit)) || String(globalThis.getSelection?.() ?? "")) return;
      void choose();
    });
    r.addEventListener("keydown", (e) => { if (e.target === r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); void choose(); } });
  };

  /** The database the server makes the default when `d` leaves the list: the first other one, in the settings' order,
   *  whose folder is there (db-serve.ts updateDatabases). Named in the question before it happens (finding 8). */
  const nextDefault = (d: RegisteredDb) => order.find((x) => x.id !== d.id && !x.remote && x.exists);

  /** One database in the list: here, elsewhere on this Mac, or on another Mac. */
  const row = (d: RegisteredDb, folder?: string): HTMLElement => {
    const r = document.createElement("div");
    r.dataset.key = d.id;
    const usable = d.exists;
    r.className = "sl-dbw-row" + (d.current ? " sl-cur" : "") + (usable && !d.current ? " sl-pick" : "");
    if (usable && !d.current) r.title = "Click to make this the database Albula opens";
    const ds = d.description;
    const name = localName(d);
    const shared = !d.remote && !!sharing?.databases.includes(d.id);
    const elsewhere = !d.remote && folder && !d.path.startsWith(folder.replace(/\/+$/, "") + "/");
    const tags = (d.remote ? `<span class="sl-dbw-tag" title="Kept on another Mac and opened from here">on ${esc(d.remote.host)}</span>` : "")
      + (shared ? (sharing!.listening ? `<span class="sl-dbw-tag sl-sh" title="The Macs you allowed can open it, on this network">shared</span>` : `<span class="sl-dbw-tag">shared — paused</span>`) : "")
      + (ds?.patientData === true ? `<span class="sl-dbw-tag sl-pt" title="Not released for public use: kept as patient data is kept">not public</span>`
        : ds?.patientData === false ? `<span class="sl-dbw-tag" title="De-identified and released for anyone to use">public data</span>` : "");
    // THE REASON ON THE FACE, not in a tooltip (the critic 2026-10-28, finding 10).
    const pausedWhy = shared && !sharing!.listening ? (sharing!.error ?? sharing!.network.why ?? "not on a network you allowed for sharing; it shares again there by itself") : "";
    const meta = [ds?.approval && `approval: ${ds.approval}`, ds?.source && `from: ${ds.source}`, ds?.contact && `ask: ${ds.contact}`].filter(Boolean) as string[];
    const text = document.createElement("div");
    text.className = "sl-dbw-text";
    text.innerHTML = `<div><span class="sl-dbw-name">${esc(name)}</span>${tags}${d.current ? ` <span class="sl-hint">· opens by default</span>` : ""}${usable ? "" : ` <span class="sl-dbw-err">· ${d.remote?.why ? esc(d.remote.why) : `not reachable ${d.remote ? `(${esc(d.remote.host)} asleep, not sharing, or on another network?)` : "(a disk not connected?)"}`}</span>`}</div>
      ${pausedWhy ? `<div class="sl-dbw-meta">Sharing paused: ${esc(pausedWhy)}</div>` : ""}
      ${ds?.holds ? `<p class="sl-dbw-holds2" title="${esc(ds.holds)}">${esc(ds.holds)}</p>` : ""}
      ${meta.length ? `<div class="sl-dbw-meta">${esc(meta.join(" · "))}</div>` : ""}
      ${elsewhere ? `<div class="sl-dbw-meta" title="Not in the databases folder">elsewhere: ${esc(d.path)}</div>` : ""}`;
    /** Off the list; the folder stays. A database switched off keeps its row: in the databases folder it is found there,
     *  and one elsewhere is remembered by the server (finding 4). */
    const switchOff = async () => {
      const { ok, j } = await post("/_db/_remove", { id: d.id, trash: false });
      if (!ok) { say(String(j.error ?? `Albula still uses “${name}”.`)); await render(); return; }
      const now = j.current as { name: string; exists: boolean } | null;
      say(`Albula no longer uses “${name}”; ${d.remote ? `to use it again, pair with ${d.remote.host} again` : "its folder stays where it is, and its switch puts it back in use"}.` +
        (j.wasCurrent ? (now ? ` Albula now opens “${now.name}”${now.exists ? "" : ", which cannot be reached just now"}.` : order.some((x) => x.id !== d.id && x.exists) ? " No database opens by default now: click one to open it by default." : " No database opens by default now: make or add one.") : ""));
      o.onChanged?.(); await render();
    };
    // IN USE. Switching off asks first when it is the default (finding 8) or a database on another Mac, whose pairing
    // goes with it (finding 2); otherwise it is done, and the switch is the way back.
    const inUse = slide(true, `Albula uses “${name}”`, d.remote ? `On: Albula uses this database on ${d.remote.host}. Off: Albula stops using it; using it again needs pairing again.` : "On: Albula uses this database. Off: it stays on disk, unused, and can be switched on again.",
      async (on, cb) => {
        if (on) return;
        const next = d.current && !d.remote ? nextDefault(d) : undefined;
        const question = d.remote
          ? `Stop using “${name}” from ${d.remote.host}? Nothing changes there; using it again here needs pairing again: the six digits, and Touch ID on ${d.remote.host}.${d.current ? " It is the database Albula opens; no database opens by default until you click one." : ""}`
          : d.current ? `“${name}” is the database Albula opens. Switched off, ${next ? `“${localName(next)}” opens instead` : "no database opens by default until you click one"}; its folder stays where it is.` : "";
        if (!question) { await switchOff(); return; }
        cb.checked = true; cb.disabled = false;
        askInPlace(r, question, d.remote ? "Stop using it" : "Switch it off", switchOff);
      }, !removable);
    // SHARED (Ron, 2026-10-29: "3 second switch"): the same switch the Databases window had, on the row.
    let shareCell: HTMLElement | undefined;
    if (sharing?.available) {
      shareCell = document.createElement("span");
      if (!d.remote && usable) {
        shareCell = slide(shared, `Share “${name}” with my other Macs`, "Your other Macs that you allow can open this database (and save into it) while they are on the same network as this Mac. The first time on a network, Touch ID allows that network.",
          async (on, cb) => {
            say(on ? `Sharing “${name}”… (Touch ID may be asked)` : `Stopping the sharing of “${name}”…`);
            const { ok, j } = await post("/_db/_sharing", { id: d.id, on });
            // THE REASON NEXT TO THE SWITCH THAT WENT BACK (Ron, 2026-10-30: "it immediately resets"; the line above the
            // list was not where he looked), and in the line above as before.
            if (!ok) {
              cb.checked = !on; cb.disabled = false;
              const why = `${on ? "Not shared" : "Still shared"}: ${String(j.error ?? "no reason given")}`;
              say(why);
              const r0 = shareCell!.closest(".sl-dbw-row");
              r0?.querySelector(".sl-dbw-rowsaid")?.remove();
              r0?.appendChild(Object.assign(document.createElement("div"), { className: "sl-dbw-rowsaid", textContent: why }));
              return;
            }
            say(on ? `“${name}” is shared with the Macs you allow, on this network.` : `“${name}” is no longer shared.`);
            await render();
          });
        shareCell.style.justifySelf = "center";
      }
    }
    const items: [string, string, () => void][] = [];
    if (canCreate && usable && !d.remote) items.push([ds ? "Describe…" : "Add a description…", "What this database is called, what it holds, whether it is public data, the approval it was collected under (if any), whom to ask.", () => editForm(r, d)]);
    if (canReveal && !d.remote && usable) items.push(["Show in Finder", "Open its folder in Finder.", async () => { const { ok, j } = await post("/_db/_reveal", { id: d.id }); if (!ok) say(String(j.error ?? "Finder could not show it.")); }]);
    if (removable && !d.remote && usable) items.push(["Move to the Trash…", "Its folder and everything in it go to the Trash, after you confirm. Finder's Put Back brings it back until the Trash is emptied.", () => void removeForm(r, d)]);
    r.append(inUse, text, ...(shareCell ? [shareCell] : []), items.length ? moreMenu(r, items) : document.createElement("span"));
    // BELOW THE ROW: its private-fields line, whose list can be long (finding 11 of the private-fields critic).
    if (privateFieldsOn && usable && !d.remote) { const pf = privateFieldsLine(d); pf.classList.add("sl-dbw-sub"); r.appendChild(pf); }
    else if (privateFieldsOn && d.remote) r.insertAdjacentHTML("beforeend", `<div class="sl-dbw-meta sl-dbw-sub">Private fields: shown on the Mac that keeps this database.</div>`);
    if (usable && !d.current) choosable(r, `Open “${name}” by default`, async () => {
      r.classList.remove("sl-pick");
      const { ok, j } = await post("/_db", { current: d.id }, "PUT");
      say(ok ? `Albula now opens “${name}”.` : `“${name}” was not made the default: ${String(j.error ?? "no reason given")}`);
      o.onChanged?.(); await render();
    });
    return r;
  };

  /** A database Albula does not use: in the databases folder, or switched off from elsewhere. Its switch off. */
  const foundRow = (f: Found): HTMLElement => {
    const r = document.createElement("div");
    r.dataset.key = `found:${f.path}`;
    r.className = "sl-dbw-row sl-off";
    const text = document.createElement("div");
    text.className = "sl-dbw-text";
    text.innerHTML = `<div><span class="sl-dbw-name">${esc(f.name)}</span> <span class="sl-hint">· not in use</span>${f.exists ? "" : ` <span class="sl-dbw-err">· not reachable (a disk not connected?)</span>`}</div>${f.holds ? `<p class="sl-dbw-holds2" title="${esc(f.holds)}">${esc(f.holds)}</p>` : ""}${f.elsewhere ? `<div class="sl-dbw-meta" title="Not in the databases folder">elsewhere: ${esc(f.path)}</div>` : ""}`;
    const inUse = slide(false, `Albula uses “${f.name}”`, f.elsewhere ? "Off: Albula does not use it; it stays where it is. On: Albula uses it there (the DICOM browser, Load / Save, Transfer)." : "Off: it is in the databases folder and Albula does not use it. On: Albula uses it (the DICOM browser, Load / Save, Transfer).",
      async (on, cb) => {
        if (!on) return;
        const { ok, j } = await post("/_db/_register", { path: f.path });
        if (!ok) { cb.checked = false; cb.disabled = false; say(String(j.error ?? `“${f.name}” was not put in use.`)); return; }
        say(`Albula uses “${f.name}” again.${j.warning ? ` ${String(j.warning)}` : ""}`);
        o.onChanged?.(String(j.id)); await render();
      }, !canFound || !f.exists);
    const items: [string, string, () => void][] = canReveal && f.exists ? [["Show in Finder", "Open its folder in Finder.", async () => { const { ok, j } = await post("/_db/_reveal", { path: f.path }); if (!ok) say(String(j.error ?? "Finder could not show it.")); }]] : [];
    r.append(inUse, text, ...(sharing?.available ? [document.createElement("span")] : []), items.length ? moreMenu(r, items) : document.createElement("span"));
    return r;
  };

  /**
   * WHICH VENDOR PRIVATE FIELDS ITS SCANS HOLD THAT ALBULA DOES NOT READ (Ron, 2026-10-29: "yes", to showing it here so
   * "a gap is visible rather than silent"; desktop/private-fields.ts). One line on the card; Show lists each vendor block
   * with the scans that hold it. Scans not yet looked at are checked by the server, and the line says how far it is.
   */
  const privateFieldsLine = (d: RegisteredDb): HTMLElement => {
    const box = document.createElement("div");
    box.className = "sl-dbw-meta sl-dbw-pf";
    box.textContent = "Private fields: looking…";
    let open = false, timer: ReturnType<typeof setTimeout> | undefined, last = "";
    // THE CHECK OF SERIES NOT YET LOOKED AT starts when asked, not whenever Load / Save is drawn (Databases section
    // critic, finding 7); imports check what they add by themselves (desktop/db-import.ts).
    let checkAsked = false;
    const opened = new Set<string>();                                      // the rows the person opened, kept across refreshes
    const series = (n: number) => `${n} series`;
    const fill = async () => {
      if (box.dataset.started && !box.isConnected) return;                // the window was redrawn or closed
      box.dataset.started = "1";
      clearTimeout(timer);
      const j = await fetch(`/_db/${encodeURIComponent(d.id)}/_private-fields${checkAsked ? "?check=1" : ""}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null) as PrivateFieldsSummary | null;
      if (!box.isConnected) return;
      if (!j) { box.textContent = "Private fields: could not be checked."; return; }
      box.title = `Scanner makers and other programs (an anonymizer, a viewer) keep some information in fields of their own, called private fields. Albula reads the ones it needs, such as diffusion directions; all of them stay unchanged in the original files. Up to ${j.sample} files of each series are looked at.`;
      const head = !j.series ? "Private fields: no series yet."
        : !j.checked ? "Private fields: not checked yet."
        : j.withUnread ? `Private fields Albula does not read: in ${series(j.withUnread)} of ${j.checked}.`
        : `Private fields: none that Albula does not read, in ${series(j.checked)}.`;
      const unchecked = j.series - j.checked - j.cannot;
      const more = !j.series ? "" : [
        j.checking ? `Checking the other series: ${j.checking.done} of ${j.checking.of}…` : unchecked > 0 ? `${series(unchecked)} not checked yet.` : "",
        j.notWhole ? `${series(j.notWhole)} could not be read in full.` : "",
        j.cannot ? `${series(j.cannot)} cannot be checked (no files, or not a DICOM identifier).` : "",
        j.extensionsFound ? "" : "What the extensions read was not found on this Mac: their fields show here as not read.",
      ].filter(Boolean).join(" ");
      // Redrawn only when the answer changed, so an opened row stays open while a check runs.
      const key = JSON.stringify([head, more, open, j.blocks.map((b) => [b.creator, b.group, b.state, b.series.length])]);
      if (key !== last) {
        last = key;
        box.innerHTML = `<span>${esc(head)}${more ? ` ${esc(more)}` : ""}</span>`;
        if (!j.checking && j.series - j.checked - j.cannot > 0) {
          const check = button("Check them", "Look at the series not checked yet (a few files of each; seconds for a few hundred series).");
          check.style.cssText = "margin-left:6px;padding:0 8px;font-size:12px;";
          check.addEventListener("click", () => { checkAsked = true; void fill(); });
          box.appendChild(check);
        }
        if (j.blocks.length) {
          const show = button(open ? "Hide" : "Show", "Each maker's or program's private fields found in this database's series, whether Albula reads them, and which series hold them.");
          show.style.cssText = "margin-left:6px;padding:0 8px;font-size:12px;";
          show.addEventListener("click", () => { open = !open; void fill(); });
          box.appendChild(show);
        }
        if (open) {
          const list = document.createElement("div");
          list.style.cssText = "margin:4px 0 0 10px;font-size:12px;";
          for (const b of j.blocks) {
            const id = `${b.group}|${b.creator}`;
            const row = document.createElement("details");
            row.open = opened.has(id);
            row.addEventListener("toggle", () => { if (row.open) opened.add(id); else opened.delete(id); });
            const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
            const how = b.state === "not read" ? `<b>not read</b> (${fields(b.elements.length)})`
              : b.state === "Albula's own" ? "written and read by Albula"
              : b.state === "read" ? `read: ${[...new Set(b.read.map((r) => r.what))].map(esc).join("; ")}`
              : `read in part: ${[...new Set(b.read.map((r) => r.what))].map(esc).join("; ")}${b.unread.length ? `; <b>${fields(b.unread.length)} of ${b.elements.length} not read</b>` : ""}`;
            row.innerHTML = `<summary title="Its creator, as the files name it: ${esc(b.creator)}, in group ${esc(b.group)}">${esc(makerOf(b.creator))} · ${esc(b.creator)}: ${how} · in ${series(b.series.length)}</summary>
              <div style="margin-left:14px;">${b.seriesNames.slice(0, 60).map(esc).join("<br>")}${b.seriesNames.length > 60 ? `<br>and ${b.seriesNames.length - 60} more` : ""}</div>`;
            list.appendChild(row);
          }
          box.appendChild(list);
        }
      }
      if (j.checking) timer = setTimeout(() => void fill(), 2000);         // one chain at a time
    };
    queueMicrotask(() => void fill());
    return box;
  };

  /**
   * REMOVE, IN TWO WAYS (Ron, 2026-10-26: "remove from the app or remove and delete"), asked in the card itself, naming
   * what goes; Keep is the way back (Contents/docs/MODULE-DESIGN-RULES.md, "A final delete asks first"). The server is
   * asked first what removing would mean (the Trash possible or why not, other things in the folder, work running on
   * it), so the question says what is true (critic 2026-10-26, Contents/docs/qa/2026-10-26-database-remove.md).
   */
  const removeForm = async (c: HTMLElement, d: RegisteredDb) => {
    c.querySelector(".sl-dbw-rm")?.remove();
    const f = document.createElement("div");
    f.className = "sl-dbw-rm";
    f.innerHTML = `<div class="sl-dbw-name">Move “${esc(dbName(d))}” to the Trash?</div><p class="sl-dbw-meta">Looking at it…</p>`;
    c.appendChild(f);
    const { ok: seen, j: facts } = await post("/_db/_remove", { id: d.id, dry: true });
    if (!seen) { f.innerHTML = `<p class="sl-dbw-err">${esc(String(facts.error ?? "It could not be looked at just now."))}</p>`; return; }
    const trashOk = (facts.trash as { ok: boolean; why?: string }).ok, others = Number(facts.otherItems ?? 0), busy = facts.busy as string | null;
    // THE TRASH ONLY: taking a database off the list without the Trash is its In use switch (Ron, 2026-10-29).
    f.innerHTML = `<div class="sl-dbw-name">Move “${esc(dbName(d))}” to the Trash?</div>
      ${busy ? `<p class="sl-dbw-err">Not now: ${esc(busy)}. Move it when that has finished.</p>` : ""}
      ${trashOk ? `<p class="sl-dbw-holds">Its folder, ${esc(d.path)}, goes to the Trash with every scan, segmentation and scene in it${others ? `, and so do the ${others} other file${others === 1 ? "" : "s"} and folder${others === 1 ? "" : "s"} in it that are not part of the database` : ""}. Until the Trash is emptied, Finder's Put Back brings it back.</p>`
        : `<p class="sl-dbw-meta">Its folder cannot go to the Trash from here: ${esc(String((facts.trash as { why?: string }).why ?? ""))}. Its In use switch takes it off the list; the folder stays.</p>`}
      ${d.current ? `<p class="sl-dbw-meta">It is the database Albula opens; another one takes its place.</p>` : ""}
      <div class="sl-dbw-acts"></div>`;
    const acts = f.querySelector(".sl-dbw-acts") as HTMLElement;
    const go = (trash: boolean, b: HTMLButtonElement, label: string) => async () => {
      for (const x of acts.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
      b.textContent = trash ? "Moving to the Trash…" : "Removing…";
      const { ok, j } = await post("/_db/_remove", { id: d.id, trash });
      if (!ok) {
        say(String(j.error ?? `“${dbName(d)}” was not removed.`));
        b.textContent = label;
        o.onChanged?.();
        await render();   // the list as it is now, whatever happened (finding 2)
        return;
      }
      const now = j.current as { name: string; exists: boolean } | null;
      say(`“${dbName(d)}” is off the list${trash ? " and its folder is in the Trash" : "; its folder stays where it was"}.` +
        (j.wasCurrent ? (now ? ` Albula now opens “${now.name}”${now.exists ? "" : ", which cannot be reached just now"}.` : " No database opens by default now: make or add one.") : ""));
      o.onChanged?.();
      await render();
    };
    if (trashOk) {
      const del = button("Move to the Trash", "The folder and everything in it go to the Trash.");
      del.addEventListener("click", go(true, del, "Move to the Trash"));
      acts.appendChild(del);
    }
    if (busy) for (const x of acts.querySelectorAll("button")) (x as HTMLButtonElement).disabled = true;
    const keep = button("Keep", "Leave this database as it is.", true);
    keep.addEventListener("click", () => f.remove());
    acts.appendChild(keep);
  };

  /** A question asked in place, with Keep as the way back (MODULE-DESIGN-RULES: "A final delete asks first"). */
  const askInPlace = (where: HTMLElement, question: string, yes: string, go: () => Promise<void>) => {
    where.querySelector(".sl-dbw-rm")?.remove();
    const f = document.createElement("div");
    f.className = "sl-dbw-rm";
    f.innerHTML = `<div class="sl-dbw-holds">${esc(question)}</div><div class="sl-dbw-acts"></div>`;
    const acts = f.querySelector(".sl-dbw-acts") as HTMLElement;
    const y = button(yes, question), keep = button("Keep", "Leave it as it is.", true);
    y.addEventListener("click", async () => { y.disabled = keep.disabled = true; await go(); });
    keep.addEventListener("click", () => f.remove());
    acts.append(y, keep);
    where.appendChild(f);
  };

  /**
   * SHARING ON THIS MAC: letting a new Mac connect (pairing opens only when asked here, for five minutes: the critic
   * 2026-10-28, finding 4), the Macs allowed, each with Remove, and the networks allowed (finding 10).
   */
  const sharingBox = (): HTMLElement => {
    const sh = sharing!;
    const box = document.createElement("div");
    box.className = "sl-dbw-form";
    box.innerHTML = `<div class="sl-dbw-name">Sharing with your other Macs</div>`;
    const pairRow = document.createElement("div");
    pairRow.className = "sl-dbw-acts";
    const p = sh.pairing;
    const line = document.createElement("span");
    line.style.cssText = "flex:1;align-self:center";
    line.className = "sl-dbw-meta";
    line.textContent = !sh.listening ? "A new Mac can connect while this Mac shares on a network you allowed."
      : p.closed ? `New Macs cannot connect just now: ${p.closed}.`
      : p.open ? `A new Mac may connect until ${new Date(p.until!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${p.waiting ? ` — ${p.waiting} is asking; compare the numbers, then Touch ID` : ": on it, Load / Save › Databases › More › Open a database on another Mac…, then Connect"}.`
      : "Only the Macs below can come in.";
    pairRow.appendChild(line);
    if (sh.listening && !p.open && !p.closed) {
      const open = button("Let another Mac connect", "For five minutes, one Mac on this network may connect: it shows six digits, this Mac shows the same in its Touch ID question.", true);
      open.addEventListener("click", async () => {
        open.disabled = true; open.textContent = "Opening…";
        const { ok, j } = await post("/_db/_sharing/open-pairing", {});
        say(ok ? "For five minutes, one Mac on this network may connect: on it, Load / Save › Databases › More › Open a database on another Mac…, then Connect." : String(j.error ?? "not opened"));
        await render();
      });
      pairRow.appendChild(open);
    }
    box.appendChild(pairRow);
    for (const m of sh.macs) {
      const r = document.createElement("div");
      const head = document.createElement("div");
      head.className = "sl-dbw-acts";
      const week = m.confirmedAt ? Math.max(0, 7 - Math.floor((Date.now() - Date.parse(m.confirmedAt)) / 86_400_000)) : 0;
      head.innerHTML = `<span style="flex:1"><b>${esc(m.name)}</b> <span class="sl-dbw-meta">· allowed ${esc(new Date(m.pairedAt).toLocaleDateString())} · Touch ID again ${week ? `in ${week} day${week === 1 ? "" : "s"}` : "at its next visit"}</span></span>`;
      const rm = button("Remove…", "This Mac can no longer open your shared databases, until it is allowed again.");
      rm.addEventListener("click", () => askInPlace(r, `Remove ${m.name}? It can no longer open your shared databases; it can connect again later.`, `Remove ${m.name}`, async () => {
        const { ok, j } = await post("/_db/_sharing/forget", { id: m.id });
        say(ok ? `${m.name} can no longer open your shared databases.` : String(j.error ?? "not removed"));
        await render();
      }));
      head.appendChild(rm);
      r.appendChild(head);
      box.appendChild(r);
    }
    if (sh.network.count) {
      const r = document.createElement("div");
      const head = document.createElement("div");
      head.className = "sl-dbw-acts";
      head.innerHTML = `<span style="flex:1" class="sl-dbw-meta">Shared on ${sh.network.count} network${sh.network.count === 1 ? "" : "s"} you allowed${sh.network.allowed ? ", this one among them" : ""}.</span>`;
      const fg = button("Forget them…", "Sharing pauses everywhere until you switch it on again on a network, which asks for Touch ID.");
      fg.addEventListener("click", () => askInPlace(r, "Forget every network allowed for sharing? Sharing pauses until you switch it on again on a network (Touch ID).", "Forget them", async () => {
        const { ok, j } = await post("/_db/_sharing/forget-networks", {});
        say(ok ? "No network is allowed for sharing now." : String(j.error ?? "not done"));
        await render();
      }));
      head.appendChild(fg);
      r.appendChild(head);
      box.appendChild(r);
    }
    return box;
  };

  /**
   * THE MACS NEARBY THAT SHARE, each with Connect (desktop/db-remote.ts pairRemote; mockups/database-sharing-2026-10-28.html):
   * the six digits shown here at once; the other Mac asks its person for Touch ID, showing the same digits. A name can
   * also be typed (when this Mac cannot see the others: the Local Network permission, a network that hides them).
   */
  const nearbyForm = (after: HTMLElement) => {
    body.querySelector(".sl-dbw-new")?.remove();
    const f = document.createElement("div");
    f.className = "sl-dbw-form sl-dbw-new";
    f.innerHTML = `<div class="sl-dbw-name">Macs nearby that share databases</div>
      <div class="sl-nb-list"><p class="sl-dbw-meta">Looking on this network…</p></div>
      <div class="sl-nb-pair"></div>
      <label class="sl-dbw-f"><span>Or its name</span><input name="host" placeholder="e.g. Rons-MBP.local"></label>
      <div class="sl-dbw-err"></div><div class="sl-dbw-acts"></div>`;
    const list = f.querySelector(".sl-nb-list") as HTMLElement, pairBox = f.querySelector(".sl-nb-pair") as HTMLElement;
    const err = f.querySelector(".sl-dbw-err") as HTMLElement, acts = f.querySelector(".sl-dbw-acts") as HTMLElement;
    let looking = true;
    const connect = async (host: string, port: number | undefined, label: string, b: HTMLButtonElement) => {
      err.textContent = "";
      b.disabled = true; b.textContent = "Connecting…";
      const { ok, j } = await post("/_db/_pair-remote", { host, ...(port ? { port } : {}) });
      if (!ok) { b.disabled = false; b.textContent = "Connect…"; err.textContent = String(j.error ?? "not connected"); return; }
      looking = false;
      b.textContent = "Waiting…";
      // BOTH MACS CONFIRM (the critic 2026-10-28, finding 5): the person here says the numbers are the same, too.
      pairBox.innerHTML = `<p class="sl-dbw-holds"><b>${esc(label)}</b> asks for Touch ID and shows a number. Is it this one?</p>
        <div style="font:600 24px var(--sl-mono, ui-monospace, monospace);letter-spacing:.15em;color:var(--sl-accent);margin:4px 0 8px">${esc(String(j.digits))}</div>
        <div class="sl-dbw-acts"></div>`;
      const ans = pairBox.querySelector(".sl-dbw-acts") as HTMLElement;
      const sameB = button("It shows the same number", "Then allow it there with Touch ID; this Mac keeps the connection only when both are done.", true);
      const diffB = button("It shows a different number", "Something else may be answering in that Mac's name: nothing is kept.");
      const answer = async (same: boolean) => {
        sameB.disabled = diffB.disabled = true;
        await post(`/_db/_pair-remote/${j.pairing}`, { same });
        if (same) sameB.textContent = "Waiting for Touch ID there…";
      };
      sameB.addEventListener("click", () => void answer(true));
      diffB.addEventListener("click", () => void answer(false));
      ans.append(sameB, diffB);
      const follow = async () => {
        const st = await fetch(`/_db/_pair-remote/${j.pairing}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { state: string; why?: string; databases?: { name: string }[] } | null;
        if (st?.state === "waiting") { setTimeout(follow, 1000); return; }
        if (st?.state === "paired") {
          const dbs = st.databases ?? [];
          say(`Connected to ${label}: ${dbs.length ? dbs.map((x) => `“${x.name}”`).join(", ") : "it shares no database yet"} listed here.`);
          o.onChanged?.(); await render(); return;
        }
        b.disabled = false; b.textContent = "Connect…";
        pairBox.innerHTML = "";
        err.textContent = st?.why ? `Not connected: ${st.why}` : "Not connected.";
      };
      void follow();
    };
    const look = async () => {
      if (!looking || !f.isConnected) return;
      const j = await fetch("/_db/_nearby", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ macs: [] })) as { macs: { name: string; host: string; port?: number }[] };
      if (!looking) return;
      list.innerHTML = j.macs.length ? "" : `<p class="sl-dbw-meta">No Mac on this network shares a database just now. On the Mac that holds it: Load / Save › Databases, its Shared switch.</p>`;
      for (const m of j.macs) {
        const r = document.createElement("div");
        r.className = "sl-dbw-acts";
        r.innerHTML = `<span style="flex:1"><b>${esc(m.name)}</b> <span class="sl-dbw-meta">· ${esc(m.host)}</span></span>`;
        const c = button("Connect…", "Shows six digits here; that Mac shows the same and asks for Touch ID to allow this Mac.", true);
        c.addEventListener("click", () => void connect(m.host, m.port, m.name, c));
        r.appendChild(c);
        list.appendChild(r);
      }
      setTimeout(look, 2000);
    };
    const typed = button("Connect to that name…", "For a Mac this one cannot see on the network.");
    typed.addEventListener("click", () => { const h = (f.querySelector('[name="host"]') as HTMLInputElement).value.trim(); if (h) void connect(h, undefined, h, typed); });
    const cancel = button("Close", "Connect to nothing.");
    cancel.addEventListener("click", () => { looking = false; f.remove(); });
    acts.append(typed, cancel);
    after.after(f);
    void look();
  };

  const formBox = (title: string) => {
    const f = document.createElement("div");
    f.className = "sl-dbw-form";
    f.innerHTML = `<div class="sl-dbw-name">${esc(title)}</div>${FIELDS}<div class="sl-dbw-err"></div><div class="sl-dbw-acts"></div>`;
    return { f, err: f.querySelector(".sl-dbw-err") as HTMLElement, acts: f.querySelector(".sl-dbw-acts") as HTMLElement };
  };

  const editForm = (where: HTMLElement, d: RegisteredDb) => {
    where.querySelector(".sl-dbw-form")?.remove();
    const { f, err, acts } = formBox("Description");
    fillForm(f, d.description ?? { name: d.id });
    const save = button("Save", "Keep this description with the database.", true);
    const cancel = button("Cancel", "Leave the description as it was.");
    save.addEventListener("click", async () => {
      const { ok, j } = await post(`/_db/${encodeURIComponent(d.id)}/_description`, readForm(f), "PUT");
      if (!ok) { err.textContent = String(j.error ?? "not saved"); return; }
      say(`The description of “${readForm(f).name || dbName(d)}” is saved.`);
      o.onChanged?.(); await render();
    });
    cancel.addEventListener("click", () => f.remove());
    acts.append(save, cancel);
    where.appendChild(f);
  };

  const newForm = (after: HTMLElement) => {
    body.querySelector(".sl-dbw-new")?.remove();
    const { f, err, acts } = formBox("New database");
    f.classList.add("sl-dbw-new");
    let folder: { token: string; path: string } | undefined;
    const where = document.createElement("div");
    where.className = "sl-dbw-meta";
    const showWhere = () => { where.textContent = folder ? `In: ${folder.path}` : "In: SlicerAlbulaDatabases, in your home folder"; };
    showWhere();
    const make = button("Make the database", "Makes the empty database and adds it to this list.", true);
    const other = button("Another folder…", "Choose where the database goes. Not Desktop or Documents if they are kept in iCloud: scans that are not public would be copied to Apple's servers.");
    const cancel = button("Cancel", "Make nothing.");
    other.addEventListener("click", async () => {
      try { const c = await chooseFolder("Where should the new database go?"); if (c) { folder = c; showWhere(); } } catch (e) { err.textContent = (e as Error).message; }
    });
    make.addEventListener("click", async () => {
      err.textContent = "";
      make.disabled = true;
      const { ok, j } = await post("/_db/_create", { ...readForm(f), ...(folder ? { token: folder.token } : {}) });
      make.disabled = false;
      if (!ok) { err.textContent = String(j.error ?? "the database was not made"); return; }
      say(`“${readForm(f).name}” is made. To add scans to it: Load / Save, Load from Files, “Also add to” it, then DICOM folder….`);
      o.onChanged?.(String(j.id));
      await render();
      if (j.warning) { const w = document.createElement("p"); w.className = "sl-dbw-err"; w.textContent = String(j.warning); body.prepend(w); }
    });
    cancel.addEventListener("click", () => f.remove());
    f.insertBefore(where, err);
    acts.append(make, other, cancel);
    after.after(f);
    (f.querySelector('[name="name"]') as HTMLInputElement).focus();
  };

  const addExisting = async (after: HTMLElement) => {
    const note = document.createElement("p");
    note.className = "sl-dbw-err";
    try {
      const c = await chooseFolder("Choose a folder that holds a DICOM database (its index is ctkDICOM.sql)");
      if (!c) return;
      if (!c.hasDatabase) { note.textContent = `“${c.name}” holds no DICOM database. To add scans from it, use Load / Save › From disk › DICOM folder… instead.`; after.after(note); return; }
      // MOVED (the default) OR COPIED INTO "SlicerAlbulaDatabases" first (Ron, 2026-10-13: "move or copy into the albula
      // databases folder. User decides, move is the default"); one already there is listed where it is.
      const { features } = await listDatabases();
      if (features.includes("package")) {
        await openPackageWindow({ token: c.token, name: c.name }, { notify: o.notify ?? (() => {}), onChanged: (id) => { o.onChanged?.(id); void render(); } });
        return;
      }
      const { ok, j } = await post("/_db/_register", { token: c.token });
      if (!ok) { note.textContent = String(j.error ?? "not added"); after.after(note); return; }
      o.onChanged?.(String(j.id));
      await render();
    } catch (e) { note.textContent = (e as Error).message; after.after(note); }
  };

  void render();
  return {
    refresh: render,
    startNew: () => { const acts = body.querySelector<HTMLElement>(".sl-dbw-acts.sl-end"); if (acts && canCreate) newForm(acts); return body.querySelector<HTMLElement>(".sl-dbw-new") ?? undefined; },
  };
}
