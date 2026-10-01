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
import { openFloatingWindow } from "./floating-window.ts";
import { escapeHtml as esc } from "./html.ts";

export interface DbDescription { name: string; holds?: string; patientData?: boolean; approval?: string; contact?: string; source?: string }
export interface RegisteredDb { id: string; path: string; exists: boolean; current: boolean; description?: DbDescription }

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
  <label class="sl-dbw-f"><span>Patient data</span><span><input type="checkbox" name="patientData"> real patients' scans</span></label>
  <label class="sl-dbw-f"><span>Approval</span><input name="approval" maxlength="120" placeholder="e.g. IRB protocol number"></label>
  <label class="sl-dbw-f"><span>Whom to ask</span><input name="contact" maxlength="200"></label>
  <label class="sl-dbw-f"><span>Came from</span><input name="source" maxlength="300" placeholder="e.g. the hospital's PACS, a public collection"></label>`;

function readForm(form: HTMLElement): DbDescription {
  const v = (n: string) => (form.querySelector(`[name="${n}"]`) as HTMLInputElement | null)?.value.trim() ?? "";
  return { name: v("name"), holds: v("holds"), approval: v("approval"), contact: v("contact"), source: v("source"),
    patientData: (form.querySelector('[name="patientData"]') as HTMLInputElement).checked };
}
function fillForm(form: HTMLElement, d?: DbDescription) {
  for (const n of ["name", "holds", "approval", "contact", "source"] as const) (form.querySelector(`[name="${n}"]`) as HTMLInputElement).value = d?.[n] ?? "";
  (form.querySelector('[name="patientData"]') as HTMLInputElement).checked = !!d?.patientData;
}

export interface DatabasesWindowOptions {
  /** After the current database changed, or one was made or added. `id` is the one made or added. */
  onChanged?: (id?: string) => void;
  /** Open straight at the "New database" form. */
  startWithNew?: boolean;
}

/** The window. Returns when it is open; `onChanged` says what happened. */
export function openDatabasesWindow(o: DatabasesWindowOptions = {}): void {
  const { box, close } = openFloatingWindow({ title: "DICOM databases", size: { w: 720, h: 620 }, zIndex: 9100 });
  const body = document.createElement("div");
  body.className = "sl-dbw";
  body.style.cssText = "flex:1;overflow:auto;padding:10px 14px;";
  box.appendChild(body);
  const style = document.createElement("style");
  style.textContent = `
    .sl-dbw-card { border:1px solid var(--sl-line); border-radius:var(--sl-radius); padding:8px 10px; margin:0 0 8px; }
    .sl-dbw-card.sl-cur { border-color:var(--sl-accent); background:var(--sl-accent-wash); }
    .sl-dbw-name { font-weight:600; }
    .sl-dbw-tag { display:inline-block; border-radius:9px; padding:0 7px; margin-left:6px; font-size:10px; background:var(--sl-pill-bg); color:var(--sl-pill-fg); border:1px solid var(--sl-pill-edge); }
    .sl-dbw-tag.sl-pt { background:var(--sl-error-bg); color:var(--sl-error-fg); border-color:var(--sl-error-edge); }
    .sl-dbw-meta { color:var(--sl-fg-dim); font-size:11px; margin-top:2px; overflow-wrap:anywhere; }
    .sl-dbw-holds { margin:4px 0 0; }
    .sl-dbw-acts { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
    .sl-dbw-f { display:grid; grid-template-columns:110px 1fr; gap:8px; align-items:center; margin:5px 0; }
    .sl-dbw-f > span:first-child { color:var(--sl-fg-dim); text-align:right; font-size:11px; }
    .sl-dbw-f textarea, .sl-dbw-f input:not([type=checkbox]) { width:100%; box-sizing:border-box; }
    .sl-dbw-form { border:1px solid var(--sl-line-strong); border-radius:var(--sl-radius); padding:8px 10px; margin:6px 0 10px; }
    .sl-dbw-err { color:var(--sl-error); font-size:11px; }`;
  box.appendChild(style);

  const render = async () => {
    const { databases, features } = await listDatabases();
    const canCreate = features.includes("create");
    body.innerHTML = "";
    const intro = document.createElement("p");
    intro.className = "sl-hint";
    intro.textContent = "The highlighted database is the one Albula opens. Each says what it holds; Edit changes that.";
    body.appendChild(intro);
    for (const d of databases) body.appendChild(card(d, canCreate));
    const row = document.createElement("div");
    row.className = "sl-dbw-acts";
    if (canCreate) {
      const nb = button("New database…", "Make an empty database, named and described, ready to add scans to. It goes in “Albula Databases” in your home folder unless you choose another folder.");
      nb.addEventListener("click", () => newForm(row));
      const ab = button("Add an existing database folder…", "A folder that already holds a DICOM database (made by Slicer or Albula, or copied from someone): it is added to this list as it is.");
      ab.addEventListener("click", () => addExisting(row));
      row.append(nb, ab);
    } else {
      row.innerHTML = `<span class="sl-hint">This Albula's server is older than this window and cannot make databases; rebuild the application.</span>`;
    }
    body.appendChild(row);
    if (o.startWithNew && canCreate) { o.startWithNew = false; newForm(row); }
  };

  const button = (label: string, title: string, primary = false) => {
    const b = document.createElement("button");
    b.textContent = label; b.title = title;
    if (primary) b.className = "sl-primary";
    return b;
  };

  const card = (d: RegisteredDb, canEdit: boolean): HTMLElement => {
    const c = document.createElement("div");
    c.className = "sl-dbw-card" + (d.current ? " sl-cur" : "");
    const ds = d.description;
    const tag = ds?.patientData === true ? `<span class="sl-dbw-tag sl-pt" title="Holds real patients' scans">patient data</span>`
      : ds?.patientData === false ? `<span class="sl-dbw-tag" title="Holds no real patients' scans">no patient data</span>` : "";
    const meta = [ds?.approval && `approval: ${ds.approval}`, ds?.source && `from: ${ds.source}`, ds?.contact && `ask: ${ds.contact}`].filter(Boolean) as string[];
    c.innerHTML = `<div><span class="sl-dbw-name">${esc(dbName(d))}</span>${tag}${d.current ? ` <span class="sl-hint">· opens by default</span>` : ""}${d.exists ? "" : ` <span class="sl-dbw-err">· not reachable (a disk not connected?)</span>`}</div>
      ${ds?.holds ? `<p class="sl-dbw-holds">${esc(ds.holds)}</p>` : ""}
      ${meta.length ? `<div class="sl-dbw-meta">${esc(meta.join(" · "))}</div>` : ""}
      <div class="sl-dbw-meta" title="Where it is on this computer">${esc(d.path)}</div>`;
    const acts = document.createElement("div");
    acts.className = "sl-dbw-acts";
    if (!d.current && d.exists) {
      const use = button("Open this one by default", "Albula opens this database from now on (the DICOM database window, and where Load / Save adds scans).");
      use.addEventListener("click", async () => { await post("/_db", { current: d.id }, "PUT"); o.onChanged?.(); await render(); });
      acts.appendChild(use);
    }
    if (canEdit && d.exists) {
      const ed = button(ds ? "Edit" : "Add a description", "What this database is called, what it holds, whether it holds patient data and under which approval, whom to ask.");
      ed.addEventListener("click", () => editForm(c, d));
      acts.appendChild(ed);
    }
    c.appendChild(acts);
    return c;
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
    const showWhere = () => { where.textContent = folder ? `In: ${folder.path}` : "In: Albula Databases, in your home folder"; };
    showWhere();
    const make = button("Make the database", "Makes the empty database and adds it to this list.", true);
    const other = button("Another folder…", "Choose where the database goes. Not Desktop or Documents if they are kept in iCloud: patient data there would be copied to Apple's servers.");
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
      const { ok, j } = await post("/_db/_register", { token: c.token });
      if (!ok) { note.textContent = String(j.error ?? "not added"); after.after(note); return; }
      o.onChanged?.(String(j.id));
      await render();
    } catch (e) { note.textContent = (e as Error).message; after.after(note); }
  };

  void render();
  void close;
}
