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
import { openFloatingWindow } from "./floating-window.ts";
import { escapeHtml as esc } from "./html.ts";

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

export interface DatabasesWindowOptions {
  /** After the current database changed, or one was made or added. `id` is the one made or added. */
  onChanged?: (id?: string) => void;
  /** Open straight at the "New database" form. */
  startWithNew?: boolean;
  /** Where a notice goes (the shell's). */
  notify?: (o: { title: string; body?: string; ttl?: number }) => void;
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
    .sl-dbw-err { color:var(--sl-error); font-size:11px; }
    .sl-dbw-said { flex:1; min-width:0; align-self:center; color:var(--sl-fg); font-size:12px; }
    .sl-dbw-rm { border-top:1px solid var(--sl-line); margin-top:8px; padding-top:6px; }
    .sl-dbw-tag.sl-sh { background:var(--sl-ok-bg, rgba(143,199,154,.15)); color:var(--sl-ok, #8fc79a); border-color:var(--sl-ok-edge, rgba(143,199,154,.45)); }
    .sl-dbw-share { display:inline-flex; align-items:center; gap:6px; font-size:12px; margin-left:auto; cursor:pointer; user-select:none; }
    .sl-dbw-share input { position:absolute; opacity:0; width:1px; height:1px; }
    .sl-dbw-share i { position:relative; width:34px; height:19px; border-radius:10px; background:var(--sl-line-strong); transition:background .15s; flex:none; }
    .sl-dbw-share i::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:var(--sl-fg); transition:left .15s; }
    .sl-dbw-share input:checked + i { background:var(--sl-ok, #8fc79a); }
    .sl-dbw-share input:checked + i::after { left:17px; }
    .sl-dbw-share input:focus-visible + i { outline:2px solid var(--sl-accent); outline-offset:2px; }
    .sl-dbw-share input:disabled + i { opacity:.5; }`;
  box.appendChild(style);
  // WHAT WAS JUST DONE, said in the footer beside Done, where it stays in sight however the list is scrolled (Ron,
  // 2026-10-26: "The functions should have proper feedback"; critic, finding 9): made, opened by default, described,
  // removed. "Added" is said by the package window that does it.
  const saidLine = document.createElement("div");
  saidLine.className = "sl-dbw-said";
  saidLine.setAttribute("role", "status");
  const say = (m: string) => { saidLine.textContent = m; };
  // DONE CLOSES THE WINDOW (Ron, 2026-10-26: choosing a database and then knowing to click the red button "is very
  // efficient, but not intuitive. Keeping it and adding a quit panel button might help").
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:10px;justify-content:flex-end;padding:8px 14px;border-top:1px solid var(--sl-line);";
  foot.appendChild(saidLine);
  const done = document.createElement("button");
  done.textContent = "Done";
  done.title = "Close this window. The database marked “opens by default” is the one Albula uses.";
  done.addEventListener("click", () => close());
  foot.appendChild(done);
  box.appendChild(foot);

  let removable = false;
  /** Sharing on this Mac (desktop/sharing.ts), read with each render; undefined on a server without it. */
  let sharing: SharingState | undefined;
  const render = async () => {
    const { databases, features } = await listDatabases();
    sharing = features.includes("sharing") ? await fetch("/_db/_sharing", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined) : undefined;
    const canCreate = features.includes("create");
    body.innerHTML = "";
    const intro = document.createElement("p");
    intro.className = "sl-hint";
    intro.textContent = "The highlighted database is the one Albula opens. Each says what it holds; Edit changes that.";
    body.appendChild(intro);
    removable = features.includes("remove");
    for (const d of databases) body.appendChild(card(d, canCreate));
    const row = document.createElement("div");
    row.className = "sl-dbw-acts";
    if (canCreate) {
      const nb = button("New database…", "Make an empty database, named and described, ready to add scans to. It goes in “SlicerAlbulaDatabases” in your home folder unless you choose another folder.");
      nb.addEventListener("click", () => newForm(row));
      const ab = button("Add an existing database folder…", "A folder that already holds a DICOM database (made by Slicer or Albula, or copied from someone): it is moved into “SlicerAlbulaDatabases” (or copied there, if you choose) and added to this list.");
      ab.addEventListener("click", () => addExisting(row));
      row.append(nb, ab);
      // A DATABASE ON ANOTHER MAC (desktop/db-remote.ts; Ron, 2026-10-26: "Databases can be either local or remote"):
      // the Macs on this network that share, each with Connect (Ron, 2026-10-28; mockups/database-sharing-2026-10-28.html).
      if (features.includes("remote")) {
        const rb = button("Macs nearby…", "Your other Macs on this network that share databases: connect to one, compare the six digits, and allow it there with Touch ID.");
        rb.addEventListener("click", () => nearbyForm(row));
        row.appendChild(rb);
      }
    } else {
      row.innerHTML = `<span class="sl-hint">This Albula's server is older than this window and cannot make databases; rebuild the application.</span>`;
    }
    body.appendChild(row);
    if (sharing?.available && (sharing.databases.length || sharing.macs.length)) {
      body.appendChild(sharingBox());
      // THE BOX FOLLOWS PAIRING while it is open (the critic, round 2, R2-9): who asks, closed, the five minutes ending.
      if (sharing.pairing.open || sharing.pairing.waiting) {
        const was = JSON.stringify([sharing.pairing, sharing.macs.length]);
        const t = setInterval(async () => {
          if (!body.isConnected) { clearInterval(t); return; }
          const now = await fetch("/_db/_sharing", { cache: "no-store" }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined) as SharingState | undefined;
          if (now && JSON.stringify([now.pairing, now.macs.length]) !== was) { clearInterval(t); await render(); }
        }, 3000);
      }
    }
    if (features.includes("test-cases")) await testCases(body);
    if (o.startWithNew && canCreate) { o.startWithNew = false; newForm(row); }
  };

  /**
   * THE PUBLIC TEST CASES (desktop/test-cases.ts; Ron, 2026-10-01: "a good feature to have, with a warning about the
   * size"). Offered while no database holds them; the size is said before anything is fetched; progress while it runs.
   */
  const testCases = async (into: HTMLElement) => {
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
          const use = button("Open these by default", "Makes the test cases the database Albula opens (Open a patient…, DICOM database…). Your other databases stay in this list.", true);
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
    const go = button(resuming ? "Continue the download" : `Download (${gb} GB)`, `Downloads about ${gb} GB of public MRI from OpenNeuro and makes the database “${t.name}”.`, true);
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

  const card = (d: RegisteredDb, canEdit: boolean): HTMLElement => {
    const c = document.createElement("div");
    c.className = "sl-dbw-card" + (d.current ? " sl-cur" : "");
    const ds = d.description;
    const shared = !d.remote && !!sharing?.databases.includes(d.id);
    const where = d.remote ? `<span class="sl-dbw-tag" title="Kept on another Mac and opened from here">on ${esc(d.remote.host)}</span>`
      : shared ? (sharing!.listening ? `<span class="sl-dbw-tag sl-sh" title="The Macs you allowed can open it, on this network">shared</span>`
        : `<span class="sl-dbw-tag">shared — paused</span>`) : "";
    // THE REASON ON THE FACE, not in a tooltip (the critic 2026-10-28, finding 10).
    const pausedWhy = shared && !sharing!.listening ? (sharing!.error ?? sharing!.network.why ?? "not on a network you allowed for sharing; it shares again there by itself") : "";
    const tag = where + (ds?.patientData === true ? `<span class="sl-dbw-tag sl-pt" title="Not released for public use: kept as patient data is kept">not public</span>`
      : ds?.patientData === false ? `<span class="sl-dbw-tag" title="De-identified and released for anyone to use">public data</span>` : "");
    const meta = [ds?.approval && `approval: ${ds.approval}`, ds?.source && `from: ${ds.source}`, ds?.contact && `ask: ${ds.contact}`].filter(Boolean) as string[];
    c.innerHTML = `<div><span class="sl-dbw-name">${esc(dbName(d))}</span>${tag}${d.current ? ` <span class="sl-hint">· opens by default</span>` : ""}${d.exists ? "" : ` <span class="sl-dbw-err">· ${d.remote?.why ? esc(d.remote.why) : `not reachable ${d.remote ? `(${esc(d.remote.host)} asleep, not sharing, or on another network?)` : "(a disk not connected?)"}`}</span>`}</div>
      ${pausedWhy ? `<div class="sl-dbw-meta">Sharing paused: ${esc(pausedWhy)}</div>` : ""}
      ${ds?.holds ? `<p class="sl-dbw-holds">${esc(ds.holds)}</p>` : ""}
      ${meta.length ? `<div class="sl-dbw-meta">${esc(meta.join(" · "))}</div>` : ""}
      <div class="sl-dbw-meta" title="${d.remote ? "Where it is kept" : "Where it is on this computer"}">${esc(d.path)}</div>`;
    const acts = document.createElement("div");
    acts.className = "sl-dbw-acts";
    if (!d.current && d.exists) {
      const use = button("Open this one by default", "Albula opens this database from now on (the DICOM database window, and where Load / Save adds scans).");
      use.addEventListener("click", async () => {
        use.disabled = true;
        const { ok, j } = await post("/_db", { current: d.id }, "PUT");
        say(ok ? `Albula now opens “${dbName(d)}”.` : `“${dbName(d)}” was not made the default: ${String(j.error ?? "no reason given")}`);
        o.onChanged?.(); await render();
      });
      acts.appendChild(use);
    }
    if (canEdit && d.exists && !d.remote) {
      const ed = button(ds ? "Edit" : "Add a description", "What this database is called, what it holds, whether it is public data, the approval it was collected under (if any), whom to ask.");
      ed.addEventListener("click", () => editForm(c, d));
      acts.appendChild(ed);
    }
    // SHARE WITH MY OTHER MACS (desktop/sharing.ts): on across restarts, on the networks allowed (Ron, 2026-10-28).
    if (sharing?.available && !d.remote && d.exists) {   // without the helper, no switch (finding 11)
      const lab = document.createElement("label");
      lab.className = "sl-dbw-share";
      lab.title = "Your other Macs that you allow can open this database (and save into it) while they are on the same network as this Mac. The first time on a network, Touch ID allows that network.";
      // A SLIDE SWITCH (Ron, 2026-10-28: "use a slide button for the share/remove"): on shares, off stops sharing.
      lab.innerHTML = `<input type="checkbox" role="switch" ${shared ? "checked" : ""}><i aria-hidden="true"></i><span>Share with my other Macs</span>`;
      const cb = lab.querySelector("input") as HTMLInputElement, txt = lab.querySelector("span") as HTMLElement;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        txt.textContent = cb.checked ? "Sharing… (Touch ID may be asked)" : "Stopping…";
        const { ok, j } = await post("/_db/_sharing", { id: d.id, on: cb.checked });
        say(ok ? (cb.checked ? `“${dbName(d)}” is shared with the Macs you allow, on this network.` : `“${dbName(d)}” is no longer shared.`) : `Not changed: ${String(j.error ?? "no reason given")}`);
        await render();
      });
      acts.appendChild(lab);
    }
    if (removable) {
      const rm = button("Remove…", "Take this database off the list, and choose whether its folder stays where it is or goes to the Trash.");
      rm.addEventListener("click", () => void removeForm(c, d));
      acts.appendChild(rm);
    }
    c.appendChild(acts);
    return c;
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
    f.innerHTML = `<div class="sl-dbw-name">Remove “${esc(dbName(d))}”?</div><p class="sl-dbw-meta">Looking at it…</p>`;
    c.appendChild(f);
    const { ok: seen, j: facts } = await post("/_db/_remove", { id: d.id, dry: true });
    if (!seen) { f.innerHTML = `<p class="sl-dbw-err">${esc(String(facts.error ?? "It could not be looked at just now."))}</p>`; return; }
    const trashOk = (facts.trash as { ok: boolean; why?: string }).ok, others = Number(facts.otherItems ?? 0), busy = facts.busy as string | null;
    f.innerHTML = `<div class="sl-dbw-name">Remove “${esc(dbName(d))}”?</div>
      ${busy ? `<p class="sl-dbw-err">Not now: ${esc(busy)}. Remove it when that has finished.</p>` : ""}
      ${facts.remote ? `<p class="sl-dbw-holds">Only its entry on this Mac goes. The database stays on ${esc(String((facts.remote as { host: string }).host))}, untouched; pairing again lists it here again.</p>`
        : `<p class="sl-dbw-holds"><b>From the list only:</b> the folder stays where it is, with everything in it. “Add an existing database folder…” lists it again.</p>`}
      ${trashOk ? `<p class="sl-dbw-holds"><b>And move its folder to the Trash:</b> every scan, segmentation and scene in it goes to the Trash${others ? `, and so do the ${others} other file${others === 1 ? "" : "s"} and folder${others === 1 ? "" : "s"} in it that are not part of the database` : ""}. Until the Trash is emptied, Finder's Put Back brings it back.</p>`
        : d.exists && !facts.remote ? `<p class="sl-dbw-meta">Its folder cannot go to the Trash from here: ${esc(String((facts.trash as { why?: string }).why ?? ""))}.</p>` : ""}
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
    const only = button(facts.remote ? "Remove from this Mac's list" : "Remove from the list", facts.remote ? "The database stays on the other Mac, untouched." : "The folder stays where it is, untouched.");
    only.addEventListener("click", go(false, only, "Remove from the list"));
    acts.appendChild(only);
    if (trashOk) {
      const del = button("Remove and move to the Trash", "The folder and everything in it go to the Trash.");
      del.addEventListener("click", go(true, del, "Remove and move to the Trash"));
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
      : p.open ? `A new Mac may connect until ${new Date(p.until!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${p.waiting ? ` — ${p.waiting} is asking; compare the numbers, then Touch ID` : ": on it, Databases › Macs nearby… › Connect"}.`
      : "Only the Macs below can come in.";
    pairRow.appendChild(line);
    if (sh.listening && !p.open && !p.closed) {
      const open = button("Let another Mac connect", "For five minutes, one Mac on this network may connect: it shows six digits, this Mac shows the same in its Touch ID question.", true);
      open.addEventListener("click", async () => {
        open.disabled = true; open.textContent = "Opening…";
        const { ok, j } = await post("/_db/_sharing/open-pairing", {});
        say(ok ? "For five minutes, one Mac on this network may connect: on it, Databases › Macs nearby… › Connect." : String(j.error ?? "not opened"));
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
      list.innerHTML = j.macs.length ? "" : `<p class="sl-dbw-meta">No Mac on this network shares a database just now. On the Mac that holds it: Databases, “Share with my other Macs”.</p>`;
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
  void close;
}
