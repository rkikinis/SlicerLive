// OPENING A PACKAGED SCENE (`.albula`) OR TAKING IN A WHOLE DATABASE, IN ONE WINDOW (Ron, 2026-10-13, mockup
// Contents/docs/mockups/albula-import-2026-10-13.html, after the Mac mini test of 2026-10-13: make a database, add the
// dicom/ folder, drop the scene files -- three steps in three places, five confusing messages). What the folder is and
// what is already where comes from the server (desktop/package-open.ts); the adding is the routes that already exist,
// called here in order: make the database if asked, add the scans (moved by default), import the scene, open it.
//
// Ron's answers, 2026-10-13: databases go in "SlicerAlbulaDatabases" in the home folder, one folder each ("Test Data", "Tumor
// Data", …); "Public data" is ticked from the package's own record; a whole database is moved or copied into "Albula
// Databases", the person decides, move is the default.
import { openFloatingWindow } from "./floating-window.ts";
import { addFilesToDatabase, describeImport, followImport, type ImportResult } from "./add-to-database.ts";

type Notify = (o: { title: string; body?: string; ttl?: number; actions?: { label: string; primary?: boolean; onClick: () => void }[] }) => void;
interface InDb { id: string; name: string; public: boolean | null; current: boolean; series: number; sceneV: number | null; freeBytes?: number | null; sameDisk?: boolean | null }
interface Facts {
  kind: "package"; name: string; sceneUid: string; sceneV: number; sceneSeries: number; sceneSeriesUids: string[];
  public: boolean; collection: string; license: string; databases: InDb[]; freeBytes: number | null; defaultParent: string; sameDiskAsParent?: boolean | null;
  patientID?: string; studyDate?: string; studyDescription?: string; series?: { uid: string; modality: string; description: string; files: number }[];
  missingSeries?: string[]; files?: number; bytes?: number;
}
interface DbFacts { kind: "database"; name: string; path: string; bytes: number; inParent: boolean; registeredAs: string | null; defaultParent: string; freeBytes: number | null }

/** Where the package came from: a folder chosen in macOS's dialog (the server reads it; its scans can be moved), or a
 *  dropped folder (the page holds its files; they are uploaded, i.e. copied). */
export type PackageSource =
  | { token: string; name: string }
  | { dropped: { name: string; scene: Record<string, unknown>; provenance?: Record<string, unknown>; dicom: File[] } };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const mb = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) as Record<string, unknown> }));
const fmtDate = (d?: string) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : (d ?? "");

const STYLE = `
  .sl-pkw { padding:12px 16px; overflow:auto; flex:1; }
  .sl-pkw-facts { border:1px solid var(--sl-line); border-radius:var(--sl-radius); padding:8px 11px; margin:2px 0 12px; }
  .sl-pkw-facts div { margin:2px 0; }
  .sl-pkw-row { display:grid; grid-template-columns:92px 1fr; gap:8px; align-items:center; margin:8px 0; }
  .sl-pkw-row[hidden] { display:none; }   /* the grid above would otherwise show a hidden row */
  .sl-pkw-row > span:first-child { color:var(--sl-fg-dim); text-align:right; font-size:11px; }
  .sl-pkw-row select, .sl-pkw-row input[type=text] { width:100%; box-sizing:border-box; }
  .sl-pkw-btns { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  .sl-pkw-err { color:var(--sl-error); margin-top:8px; }
  .sl-pkw-prog { height:8px; border-radius:4px; background:var(--sl-bg); overflow:hidden; margin:8px 0 4px; }
  .sl-pkw-prog i { display:block; height:100%; width:0; background:var(--sl-accent); transition:width .3s; }`;

function frame(title: string) {
  const { box, close } = openFloatingWindow({ title, size: { w: 560, h: 470 }, zIndex: 9150 });
  const style = document.createElement("style"); style.textContent = STYLE; box.appendChild(style);
  const body = document.createElement("div"); body.className = "sl-pkw"; box.appendChild(body);
  return { body, close };
}

/** OPEN A PACKAGED SCENE: inspect, then the one window. */
export async function openPackageWindow(src: PackageSource, o: { notify: Notify; onChanged?: (id: string) => void }): Promise<void> {
  const dropped = "dropped" in src ? src.dropped : null;
  const folder = dropped?.name ?? (src as { name: string }).name;
  // READ FIRST, THEN THE WINDOW, so its title is the scene's own name (it showed the folder's).
  const r = dropped ? await post("/_db/_package/inspect", { scene: dropped.scene, provenance: dropped.provenance ?? {} })
    : await post("/_db/_package/inspect", { token: (src as { token: string }).token });
  const f = (r.ok ? r.j : { kind: "error" }) as unknown as Facts | DbFacts | { kind: "neither"; name: string } | { kind: "error" };
  const title = f.kind === "package" ? `Open the scene “${f.name || folder.replace(/\.albula$/, "")}”`
    : f.kind === "database" ? `Add the database “${f.name}”` : `“${folder}”`;
  const { body, close } = frame(title);
  if (f.kind === "error") { body.innerHTML = `<p class="sl-pkw-err">${esc(String(r.j.error ?? "The package could not be read."))}</p>`; return; }
  if (f.kind === "neither") { body.innerHTML = `<p>“${esc(f.name)}” is not a packaged scene (it has no <code>scene.mrson.json</code>) and holds no DICOM database.</p><p class="sl-hint">For a folder of scans use <b>DICOM folder…</b> instead.</p>`; return; }
  if (f.kind === "database") { databaseForm(body, close, f, (src as { token: string }).token, o); return; }
  if (dropped) { f.files = dropped.dicom.length; f.bytes = dropped.dicom.reduce((n, x) => n + x.size, 0); }
  packageForm(body, close, f, src, o);
}

function packageForm(body: HTMLElement, close: () => void, f: Facts, src: PackageSource, o: { notify: Notify; onChanged?: (id: string) => void }) {
  const dropped = "dropped" in src ? src.dropped : null;
  const files = f.files ?? 0, bytes = f.bytes ?? 0;
  const holdsAll = (d: InDb) => d.series >= f.sceneSeries;
  // THE DEFAULT PLACE: a database that already holds everything; else the one Albula opens, unless it says the opposite of
  // the package about public data; else the first that agrees; else a new one.
  const agrees = (d: InDb) => d.public === null || d.public === f.public;
  const pick = f.databases.find(holdsAll) ?? f.databases.find((d) => d.current && agrees(d)) ?? f.databases.find(agrees);
  const newName = f.public ? "Test Data" : "Patient Data";
  const opts = f.databases.map((d) => {
    const have = d.series >= f.sceneSeries ? "has all its scans" : d.series ? `has ${d.series} of ${f.sceneSeries} scans` : "";
    return `<option value="${esc(d.id)}">${esc(d.name)}${d.public === true ? " (public data)" : d.public === false ? " (not public)" : ""}${have ? ` — ${have}` : ""}</option>`;
  }).join("");
  const damaged = (f.missingSeries ?? []).length > 0;
  const who = [f.patientID, f.studyDescription, fmtDate(f.studyDate)].filter(Boolean).join(" · ");
  body.innerHTML = `
    <div class="sl-pkw-facts">
      ${who ? `<div><b>${esc(who)}</b></div>` : ""}
      <div>${plural(f.sceneSeries, "series", "series")}${files ? ` · ${plural(files, "file")} · ${mb(bytes)}` : ""}</div>
      ${f.public ? `<div class="sl-hint">Public data: ${esc(f.collection)}, ${esc(f.license)}</div>` : `<div class="sl-hint">The package does not say the data are public.</div>`}
    </div>
    ${damaged ? `<p class="sl-pkw-err">${plural(f.missingSeries!.length, "series", "series")} the scene needs ${f.missingSeries!.length === 1 ? "is" : "are"} not in the package, so it cannot be opened from it. The package may have been copied incompletely: copy it again from where it was made.</p>` : `
    <div class="sl-pkw-row"><span>Keep it in</span><select class="pk-db">${opts}<option value="_new">A new database…</option></select></div>
    <div class="sl-pkw-row pk-new"><span>Name</span><input type="text" class="pk-name" maxlength="80" value="${esc(newName)}"></div>
    <div class="sl-pkw-row pk-new"><span></span><span class="sl-hint">in “SlicerAlbulaDatabases” in your home folder</span></div>
    <div class="sl-pkw-row pk-new"><span>Public data</span><label><input type="checkbox" class="pk-public" ${f.public ? "checked" : ""}> released for anyone to use${f.public ? " — from the package" : ""}</label></div>
    ${dropped ? `<div class="sl-pkw-row"><span></span><span class="sl-hint">The scans are copied in. (Choosing the package with <b>Packaged scene…</b> in Load / Save can move them instead.)</span></div>`
      : `<div class="sl-pkw-row pk-how"><span>The scans</span><span><label><input type="radio" name="pk-how" value="move" checked> move them in</label> &nbsp; <label><input type="radio" name="pk-how" value="copy"> copy them</label></span></div>`}
    <div class="sl-pkw-err pk-err"></div>
    <div class="pk-progress" hidden><div class="pk-ptext sl-hint"></div><div class="sl-pkw-prog"><i></i></div></div>`}
    <div class="sl-pkw-btns"><button class="pk-cancel">Cancel</button>${damaged ? "" : `<button class="sl-primary pk-go">Add and open</button>`}</div>`;
  const $ = <T extends HTMLElement>(s: string) => body.querySelector(s) as T;
  $("button.pk-cancel").addEventListener("click", close);
  if (damaged) return;
  const dbSel = $<HTMLSelectElement>(".pk-db"), go = $<HTMLButtonElement>(".pk-go"), err = $(".pk-err");
  dbSel.value = pick?.id ?? "_new";
  const chosen = () => f.databases.find((d) => d.id === dbSel.value);
  const update = () => {
    const isNew = dbSel.value === "_new", d = chosen();
    for (const el of Array.from(body.querySelectorAll<HTMLElement>(".pk-new"))) el.hidden = !isNew;
    const all = !!d && holdsAll(d);
    const sceneHere = d?.sceneV ?? null;
    go.textContent = all && sceneHere !== null && sceneHere >= f.sceneV ? "Open" : all && sceneHere !== null ? "Update and open" : "Add and open";
    const how = body.querySelector<HTMLElement>(".pk-how"); if (how) how.hidden = all;
    // ENOUGH ROOM ON THE TARGET'S DISK (the critic, A9): what is not there yet, in full -- a move copies first and
    // removes the originals after, so even on the same disk the space is needed while it runs.
    const need = all ? 0 : bytes * (d ? (f.sceneSeries - d.series) / Math.max(1, f.sceneSeries) : 1);
    const free = d ? (d.freeBytes ?? null) : f.freeBytes;
    const short = free !== null && free !== undefined && need > free;
    err.textContent = short ? `${mb(need)} are needed; that disk has ${mb(free!)} free.` : "";
    go.disabled = short;
  };
  dbSel.addEventListener("change", update); update();

  go.addEventListener("click", async () => {
    go.disabled = true; dbSel.disabled = true; err.textContent = "";
    const prog = $(".pk-progress"), ptext = $(".pk-ptext"), bar = $(".sl-pkw-prog i");
    prog.hidden = false;
    const say = (t: string, frac?: number) => { ptext.textContent = t; if (frac !== undefined) bar.style.width = `${Math.round(Math.min(1, frac) * 100)}%`; };
    try {
      // 0. THE SCENE AND ITS RECORD, READ AND CHECKED FIRST (the critic, A4): the scans were moved out of the package before
      // the scene was read, and a scene that could not be read then left an emptied package and nothing opened.
      let scene = dropped?.scene, provenance = dropped?.provenance;
      if (!dropped) {
        const t = (src as { token: string }).token;
        const sr = await fetch(`/_db/_folder/${t}/scene.mrson.json`, { cache: "no-store" });
        if (!sr.ok) throw new Error(`the package's scene could not be read (${(await sr.json().catch(() => ({})) as { error?: string }).error ?? sr.status}); nothing was changed`);
        scene = await sr.json();
        const pr = await fetch(`/_db/_folder/${t}/provenance.json`, { cache: "no-store" });
        provenance = pr.ok ? await pr.json().catch(() => undefined) : undefined;
      }
      // 1. THE DATABASE: the chosen one, or a new one in "SlicerAlbulaDatabases".
      let id = dbSel.value, dbLabel = chosen()?.name ?? "";
      if (id === "_new") {
        const name = ($<HTMLInputElement>(".pk-name").value.trim() || newName);
        const pub = $<HTMLInputElement>(".pk-public").checked;
        say(`Making the database “${name}”…`, 0.02);
        const c = await post("/_db/_create", { name, patientData: !pub, ...(f.public && pub ? { source: `${f.collection}, ${f.license}` } : {}) });
        if (!c.ok) throw new Error(String(c.j.error ?? "the database was not made"));
        id = String(c.j.id); dbLabel = name; o.onChanged?.(id);
      }
      // 2. THE SCANS, unless all are there already.
      let imported: ImportResult | null = null;
      const d = f.databases.find((x) => x.id === id);
      if (!d || !holdsAll(d)) {
        const status = (t: string) => { const m = /(\d+) of (\d+)/.exec(t); say(t, m ? Number(m[1]) / Math.max(1, Number(m[2])) : undefined); };
        if (dropped) imported = await addFilesToDatabase(id, dropped.dicom, `“${dbLabel}”`, status);
        else {
          const move = (body.querySelector<HTMLInputElement>('input[name="pk-how"]:checked')?.value ?? "move") === "move";
          const s = await post(`/_db/${encodeURIComponent(id)}/_import`, { token: (src as { token: string }).token, sub: "dicom", move });
          if (!s.j.job) throw new Error(String(s.j.error ?? "the scans were not added"));
          imported = await followImport(String(s.j.job), status, `“${dbLabel}”`);
        }
        if (imported.failed.length) throw new Error(describeImport(imported, dbLabel).lines.join(" "));
      }
      // 3. THE SCENE, with its record (collection, license, which series was made from which).
      say("Adding the scene…", 0.96);
      const si = await post(`/_db/${encodeURIComponent(id)}/_scene/_import`, { scene, provenance });
      if (si.j.error) throw new Error(String(si.j.error));
      // 4. OPEN IT, in that database.
      say("Opening…", 1);
      const g = globalThis as unknown as { __useDatabase?: (id: string) => Promise<void>; __openScene?: (uid: string) => Promise<{ ok: boolean; error?: string }> };
      await g.__useDatabase?.(id);
      close();
      const opened = await g.__openScene?.(String(si.j.uid ?? f.sceneUid));
      const added = imported?.series.length ? `${plural(imported.series.length, "scan")} added to “${dbLabel}”. ` : "";
      if (opened && !opened.ok) o.notify({ title: "The scene was added but did not open", body: esc(`${added}${opened.error ?? ""}`) });
      else o.notify({ title: `“${esc(f.name)}” is open`, body: esc(`${added}Next time: Scene › ${f.name}.`), ttl: 12000 });
    } catch (e) {
      err.textContent = (e as Error).message;
      prog.hidden = true; go.disabled = false; dbSel.disabled = false;
    }
  });
}

/** A WHOLE DATABASE FOLDER: moved (the default) or copied into "SlicerAlbulaDatabases", then listed. */
function databaseForm(body: HTMLElement, close: () => void, f: DbFacts, token: string, o: { notify: Notify; onChanged?: (id: string) => void }) {
  if (f.registeredAs) { body.innerHTML = `<p>This database is already in Albula's list, as “${esc(f.registeredAs)}”.</p><div class="sl-pkw-btns"><button class="sl-primary pk-ok">OK</button></div>`; body.querySelector("button")!.addEventListener("click", close); return; }
  const short = f.freeBytes !== null && f.bytes > f.freeBytes;
  body.innerHTML = `
    <div class="sl-pkw-facts"><div><b>${esc(f.name)}</b></div><div>${mb(f.bytes)}</div><div class="sl-hint">${esc(f.path)}</div></div>
    ${f.inParent ? `<p>It is in “SlicerAlbulaDatabases” already; it is added to the list where it is.</p>` : `
    <div class="sl-pkw-row"><span>Into</span><span>“SlicerAlbulaDatabases” in your home folder</span></div>
    <div class="sl-pkw-row"><span>How</span><span><label><input type="radio" name="db-how" value="move" checked> move it there</label> &nbsp; <label><input type="radio" name="db-how" value="copy"> copy it there</label></span></div>
    <p class="sl-hint">Its scenes and records go with it.</p>`}
    <div class="sl-pkw-err pk-err">${short ? `${mb(f.bytes)} may be needed; the disk has ${mb(f.freeBytes!)} free.` : ""}</div>
    <div class="sl-pkw-btns"><button class="pk-cancel">Cancel</button><button class="sl-primary pk-go">${f.inParent ? "Add it" : "Move it and add it"}</button></div>`;
  const go = body.querySelector(".pk-go") as HTMLButtonElement, err = body.querySelector(".pk-err") as HTMLElement;
  body.querySelector(".pk-cancel")!.addEventListener("click", close);
  for (const r of Array.from(body.querySelectorAll<HTMLInputElement>('input[name="db-how"]'))) r.addEventListener("change", () => { go.textContent = r.value === "copy" && r.checked ? "Copy it and add it" : "Move it and add it"; });
  go.addEventListener("click", async () => {
    go.disabled = true; err.textContent = f.inParent ? "" : "Moving…";
    const move = (body.querySelector<HTMLInputElement>('input[name="db-how"]:checked')?.value ?? "move") === "move";
    const r = f.inParent ? await post("/_db/_register", { token }) : await post("/_db/_adopt", { token, move });
    if (!r.ok) { err.textContent = String(r.j.error ?? "not added"); go.disabled = false; return; }
    o.onChanged?.(String(r.j.id));
    close();
    const warn = r.j.warning ? ` Its scenes and records were not carried over: ${String(r.j.warning)}` : "";
    o.notify({ title: `“${esc(f.name)}” is in the list`, body: esc((f.inParent ? String(r.j.path ?? "") : `${move ? "Moved" : "Copied"} to ${String(r.j.path ?? "")}.`) + warn), ttl: 12000 });
  });
}
