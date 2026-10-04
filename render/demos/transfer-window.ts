// TRANSFER BETWEEN DATABASES: the window Load / Save's "Transfer between databases…" opens (desktop/db-transfer.ts does
// the work).
//
// Ron, 2026-10-02: "There should be a user accessible copy/move patient or study from one db to the other. locate this
// functionality In the load/save module." Then, on the mockup (Contents/docs/mockups/transfer-databases-2026-10-02.html):
// "Choose defaults for the two likely scenarios and stash everything else in advanced"; "We will need tooltips and
// explicit choices for the user plus feedback what they selected and what it does, like with segmentations"; the two
// scenarios AND the patient-data warning's two buttons shown "without a preselection".
//
//   Waiting moves      a move that has copied and waits for its second press, until finished or kept
//   1 · What to do      Bring patients into my work  |  Take my results back      (neither chosen when it opens)
//   2 · Which ...       From / To, a list to tick, a search
//       What will happen, in words, updated with every tick
//       [Copy 14 scans]  -- the one yellow button; its label is the progress while it runs
//   ▸ Advanced          Copy or move · What to include · Only what is new · Start fresh
//
// The critic's round on the first version: Contents/docs/qa/2026-10-02-database-transfer.md (SlicerAlbula workspace).
import { BUILD_ID } from "./app-shell.ts";
import { dbName, listDatabases, type RegisteredDb } from "./databases-window.ts";
import { openFloatingWindow } from "./floating-window.ts";
import { escapeHtml as esc } from "./html.ts";
import { httpSource, openDicomDatabase, type DbSeriesEntry } from "../../logic/readers/dicom-db.ts";

export interface TransferWindowOptions {
  /** A database's contents changed (the one named), or which one is current did. */
  onChanged?: (id?: string) => void;
  /** Open the DICOM database window (after a transfer into the current database). */
  onOpenBrowser?: () => void;
}

type Mode = "bring" | "back";
interface Listing { series: DbSeriesEntry[]; derived: Set<string>; kids: Map<string, string[]>; sizes: Record<string, number>; count: Map<string, number> }
interface RecordEntry { at: string; what: string; from: { id: string; name: string }; to: { id: string; name: string }; patients: { id: string; name: string }[]; studies: string[]; series: unknown[]; checked: string; waiting?: string }
interface Progress { phase: string; series: number; seriesDone: number; images?: number; imagesDone?: number }
interface JobResult {
  series: { uid: string; description: string }[]; withTheirScans: number; added: number; instances: number; already: number; identical: string[];
  differ: { uid: string; description: string; missing: number; different: number; same?: number }[]; failed: { uid: string; description: string; error: string }[];
  scenes: number; notes: string[]; ms: number;
  removed?: { series: number; files: number; scenes: number; outside: { description: string; files: number }[]; kept: { description: string; reason: string }[] };
}
interface TransferJob { progress?: Progress; error?: string; seconds?: number; move?: boolean; kept?: boolean; result?: JobResult }
interface Waiting { job: string; from: string; fromName: string; to: string; toName: string; scans: number; at: string }

/** Modalities that are results whatever the provenance store says: made from images, not images themselves. */
const RESULT_MODALITIES = new Set(["SEG", "RTSTRUCT", "SR", "PR", "REG", "RWV"]);

const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) as Record<string, unknown> }))
    .catch((e) => ({ ok: false, j: { error: (e as Error).message } as Record<string, unknown> }));

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
const day = (d?: string) => d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : (d ?? "");
const localDay = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** The button's words for where a running transfer is. */
function progressLabel(p: Progress | undefined, move: boolean): string {
  if (!p) return "Waiting for Albula…";
  const n = `${p.seriesDone} of ${p.series}`;
  switch (p.phase) {
    case "reading": return p.images ? `Reading… ${p.imagesDone ?? 0} of ${p.images} images` : "Reading…";
    case "copying": return `Copying… ${n} scans`;
    case "checking": return `Checking… ${n} scans`;
    case "carrying": return "Copying scenes and links…";
    case "removing": return `Checking again and removing… ${n}`;
    default: return move ? "Finishing the move…" : "Finishing…";
  }
}

export function openTransferWindow(o: TransferWindowOptions = {}): void {
  const { box } = openFloatingWindow({ title: "Transfer between databases", size: { w: 760, h: 700 }, zIndex: 9100 });
  const body = document.createElement("div");
  body.className = "sl-tw";
  body.style.cssText = "flex:1;overflow:auto;padding:10px 14px;";
  box.appendChild(body);
  const style = document.createElement("style");
  style.textContent = `
    .sl-tw-sec { border-left:3px solid var(--sl-accent); padding:4px 10px; margin:8px 0; }
    .sl-tw-sec.sl-dim { border-left-color:var(--sl-line-strong); }
    .sl-tw-h { font-weight:700; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--sl-accent); margin:0 0 6px; }
    .sl-tw-cards { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .sl-tw .sl-tw-card { text-align:left; white-space:normal; min-width:0; height:auto; line-height:1.35; padding:8px 10px; border:1px solid var(--sl-line); border-radius:var(--sl-radius); background:transparent; color:inherit; cursor:pointer; }
    .sl-tw .sl-tw-card b { display:block; margin-bottom:2px; }
    .sl-tw .sl-tw-card:hover { border-color:var(--sl-line-strong); }
    .sl-tw .sl-tw-card.sl-on { border-color:var(--sl-accent); background:var(--sl-accent-wash); }
    .sl-tw-f { display:grid; grid-template-columns:60px 1fr; gap:8px; align-items:center; margin:4px 0; }
    .sl-tw-f > span:first-child { color:var(--sl-fg-dim); text-align:right; font-size:11px; }
    .sl-tw-list { border:1px solid var(--sl-line); border-radius:var(--sl-radius); max-height:260px; overflow:auto; padding:4px 6px; margin:6px 0; }
    .sl-tw-row { display:flex; gap:6px; align-items:baseline; padding:1px 0; }
    .sl-tw-row .sl-tw-k { margin-left:auto; color:var(--sl-fg-dim); font-size:11px; white-space:nowrap; }
    .sl-tw-in { padding-left:20px; }
    .sl-tw-in2 { padding-left:40px; }
    .sl-tw-off { color:var(--sl-fg-dim); }
    .sl-tw-will { border:1px solid var(--sl-ok); background:color-mix(in srgb, var(--sl-ok) 10%, transparent); border-radius:var(--sl-radius); padding:6px 8px; margin:8px 0; }
    .sl-tw-stop { border:1px solid var(--sl-error-edge); background:var(--sl-error-bg); color:var(--sl-error-fg); border-radius:var(--sl-radius); padding:6px 8px; margin:8px 0; }
    .sl-tw-wait { border:1px solid var(--sl-error-edge); border-radius:var(--sl-radius); padding:6px 8px; margin:0 0 8px; }
    .sl-tw-acts { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:6px 0; }
    .sl-tw-done { border:1px solid var(--sl-line-strong); border-radius:var(--sl-radius); padding:6px 8px; margin:8px 0; }
    .sl-tw-rec { font-size:11px; margin:2px 0; }
    .sl-tw details > summary { cursor:pointer; font-weight:700; font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--sl-fg-dim); }
    .sl-tw-adv h4 { margin:8px 0 2px; font-size:11px; }
    .sl-tw-adv label { display:block; margin:2px 0; }
    .sl-tw .sl-tw-red { border-color:var(--sl-error-edge); }`;
  box.appendChild(style);

  let dbs: RegisteredDb[] = [];
  let mode: Mode | null = null;
  let fromId = "", toId = "";
  let move = false, onlyNew = false;
  const include = { scans: true, results: true, scenes: true };
  let search = "";
  const ticked = new Set<string>();          // series uids
  const listings = new Map<string, Promise<Listing>>();
  /** A transfer running: what was started (so a click meanwhile cannot change what is reported: finding 9) and where it is. */
  let running: { move: boolean; from: string; to: string; progress?: Progress } | null = null;
  /** "Take my results back" ticks what was made here once, when the two databases are chosen; never again after that. */
  let autoTick = false;
  /** The last result, shown under the button until the next choice. */
  let doneBox: HTMLElement | null = null;
  let advOpen = false;
  const busy = () => running !== null;

  const listing = (id: string): Promise<Listing> => {
    let p = listings.get(id);
    if (!p) {
      p = (async () => {
        const db = await openDicomDatabase(httpSource(`/_db/${encodeURIComponent(id)}/`));
        const prov = await fetch(`/_db/${encodeURIComponent(id)}/_provenance`, { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { edges?: { child: string; parent: string }[] };
        const sizes = await fetch(`/_db/${encodeURIComponent(id)}/_sizes`, { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { sizes?: Record<string, number> };
        const kids = new Map<string, string[]>();
        for (const e of prov.edges ?? []) if (e.parent) { const l = kids.get(e.parent) ?? []; l.push(e.child); kids.set(e.parent, l); }
        return { series: db.series, derived: new Set((prov.edges ?? []).map((e) => e.child)), kids, sizes: sizes.sizes ?? {}, count: new Map(db.series.map((s) => [s.seriesInstanceUID, s.count])) };
      })();
      listings.set(id, p);
      p.catch(() => listings.delete(id));
    }
    return p;
  };
  const isResult = (l: Listing, s: DbSeriesEntry) => l.derived.has(s.seriesInstanceUID) || RESULT_MODALITIES.has((s.modality ?? "").toUpperCase());
  const included = (l: Listing, s: DbSeriesEntry) => isResult(l, s) ? include.results : include.scans;
  const db = (id: string) => dbs.find((d) => d.id === id);

  /** Where the scans of the current database came from: the newest transfer into it from elsewhere. */
  const origin = async (id: string): Promise<string> => {
    const j = await fetch(`/_db/${encodeURIComponent(id)}/_record?limit=50`, { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { entries?: RecordEntry[] };
    const e = (j.entries ?? []).find((x) => x.what === "copied in" && x.from.id !== id && dbs.some((d) => d.id === x.from.id && d.exists));
    return e?.from.id ?? "";
  };

  const choose = async (m: Mode) => {
    mode = m; ticked.clear(); doneBox = null; autoTick = true;
    listings.clear();                         // read afresh: something may have been saved since the window opened
    const cur = dbs.find((d) => d.current && d.exists);
    const others = dbs.filter((d) => d.exists && d.id !== cur?.id);
    if (m === "bring") { toId = cur?.id ?? ""; fromId = others.length === 1 ? others[0].id : ""; }
    // EMPTY WHEN NOTHING CAME BY A TRANSFER (Ron's answer 2), even with only two databases (finding 14).
    else { fromId = cur?.id ?? ""; toId = cur ? await origin(cur.id) : ""; }
    await render();
  };

  const select = (value: string, other: string, onPick: (v: string) => void, tip: string) => {
    const s = document.createElement("select");
    s.title = tip;
    s.disabled = busy();
    s.innerHTML = `<option value="">Choose a database</option>` + dbs.filter((d) => d.exists).map((d) =>
      `<option value="${esc(d.id)}"${d.id === value ? " selected" : ""}${d.id === other ? " disabled" : ""}>${esc(dbName(d))}${d.description?.patientData ? " (not public)" : d.description?.patientData === false ? " (public data)" : ""}${d.current ? " · opens by default" : ""}</option>`).join("");
    s.addEventListener("change", () => { onPick(s.value); ticked.clear(); doneBox = null; autoTick = true; listings.clear(); void render(); });
    return s;
  };

  /** THE MOVES WAITING FOR THEIR SECOND PRESS, at the top, whatever else is chosen (finding 8). */
  const waitingMoves = async (): Promise<HTMLElement | null> => {
    const j = await fetch("/_db/_transfer", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}).catch(() => ({})) as { waiting?: Waiting[] };
    if (!j.waiting?.length) return null;
    const w = document.createElement("div");
    w.className = "sl-tw-wait";
    w.innerHTML = `<div class="sl-tw-h">${j.waiting.length === 1 ? "A move waits for your second press" : `${j.waiting.length} moves wait for your second press`}</div>`;
    for (const m of j.waiting) {
      const line = document.createElement("div");
      line.innerHTML = `${plural(m.scans, "scan")} copied from ${esc(m.fromName)} to ${esc(m.toName)} and checked; still in ${esc(m.fromName)} too.`;
      const a = document.createElement("div"); a.className = "sl-tw-acts";
      a.append(removeButton(m.job, m.scans, m.fromName, m.toName, m.from), keepButton(m.job, m.fromName, m.toName));
      w.append(line, a);
    }
    return w;
  };

  const removeButton = (job: string, scans: number, fromName: string, toName: string, from: string) => {
    const rm = document.createElement("button");
    rm.className = "sl-tw-red";
    rm.textContent = `Remove ${plural(scans, "scan")} from ${fromName}`;
    rm.title = `Each of these is in ${toName}, whole and identical; they are checked once more, then taken out of ${fromName} with their files and the scenes that went with them.`;
    rm.disabled = busy();
    rm.addEventListener("click", async () => {
      running = { move: true, from, to: "" };
      await render();
      const r = await post(`/_db/_transfer/${job}/_remove`, {});
      if (!r.ok) { running = null; doneBox = message(`Nothing was removed: ${String(r.j.error ?? "Albula did not answer")}.`); await render(); return; }
      const k = await follow(job, (x) => x.progress?.phase === "done" || !!x.error);
      running = null;
      listings.delete(from);
      o.onChanged?.(from);
      const rr = k.result?.removed;
      const parts = [k.error ? `Removing stopped: ${k.error}.` : `Moved: ${plural(rr?.series ?? 0, "scan")} taken out of ${fromName} (${plural(rr?.files ?? 0, "file")}${rr?.scenes ? `, ${plural(rr.scenes, "saved scene")}` : ""}); they are in ${toName}.`];
      for (const x of rr?.outside ?? []) parts.push(`“${x.description || "a scan"}”: ${plural(x.files, "file")} outside ${fromName}'s folder ${x.files === 1 ? "was" : "were"} left where ${x.files === 1 ? "it is" : "they are"}; ${fromName} no longer lists ${x.files === 1 ? "it" : "them"}.`);
      if (rr?.kept.length) parts.push(`Still in ${fromName}: ${rr.kept.map((x) => `“${x.description || "a scan"}” (${x.reason})`).join("; ")}.`);
      doneBox = message(parts.join(" "));
      await render();
    });
    return rm;
  };
  const keepButton = (job: string, fromName: string, toName: string) => {
    const keep = document.createElement("button");
    keep.textContent = "Keep them there";
    keep.title = `Leaves ${fromName} as it is: the scans are then in both databases, and both records say the move was not finished.`;
    keep.disabled = busy();
    keep.addEventListener("click", async () => {
      const r = await post(`/_db/_transfer/${job}/_keep`, {});
      doneBox = message(r.ok ? `Kept: the scans are in both ${fromName} and ${toName}.` : `Could not be marked as kept: ${String(r.j.error ?? "")}.`);
      await render();
    });
    return keep;
  };

  const render = async () => {
    const top = body.scrollTop;
    const wait = await waitingMoves();
    body.innerHTML = "";
    if (wait) body.appendChild(wait);
    // 1 · WHAT TO DO
    const s1 = sec("1 · What to do");
    const cards = document.createElement("div");
    cards.className = "sl-tw-cards";
    const card = (m: Mode, title: string, text: string, tip: string) => {
      const b = document.createElement("button");
      b.className = "sl-tw-card" + (mode === m ? " sl-on" : "");
      b.innerHTML = `<b>${mode === m ? "◉" : "○"} ${esc(title)}</b>${esc(text)}`;
      b.title = tip;
      b.disabled = busy();
      b.addEventListener("click", () => void choose(m));
      cards.appendChild(b);
    };
    card("bring", "Bring patients into my work", move ? "Moves scans from a project's database into the one you work in: they leave the project after a second press." : "Copies scans from a project's database into the one you work in. The project keeps everything.",
      "Patients or studies from another database into the one Albula opens.");
    card("back", "Take my results back", `${move ? "Moves" : "Copies"} what you made (outlines, segmentations, scenes) to the database the scans came from.`,
      "What was made here and is not in the other database yet, beside the scans it was made from.");
    s1.appendChild(cards);
    body.appendChild(s1);
    if (!mode) { body.appendChild(advanced()); body.scrollTop = top; return; }

    // 2 · WHICH
    const s2 = sec(mode === "bring" ? "2 · Which patients" : "2 · Which results");
    s2.append(field("From", select(fromId, toId, (v) => { fromId = v; }, "The database the scans come from.")),
      field("To", select(toId, fromId, (v) => { toId = v; }, "The database the scans go into.")));
    body.appendChild(s2);
    if (!fromId || !toId) { s2.appendChild(hint(mode === "back" && !toId ? "Choose where the results go: these scans did not come from another database by a transfer." : "Choose both databases.")); body.appendChild(advanced()); return; }
    const reading = hint("Reading the two databases…");
    s2.appendChild(reading);
    let A: Listing, B: Listing;
    try { [A, B] = await Promise.all([listing(fromId), listing(toId)]); } catch (e) { reading.textContent = `A database could not be read: ${(e as Error).message}`; return; }
    reading.remove();
    // THERE = WHOLE: a scan the other database holds only in part is offered again, to complete it (finding 7).
    const whole = (s: DbSeriesEntry) => (B.count.get(s.seriesInstanceUID) ?? -1) >= s.count;
    const partial = (s: DbSeriesEntry) => B.count.has(s.seriesInstanceUID) && !whole(s);
    const studiesInB = new Set(B.series.map((s) => s.studyInstanceUID ?? ""));
    const srch = document.createElement("input");
    srch.type = "search"; srch.placeholder = "Search a name, ID, date or description"; srch.value = search;
    srch.title = "Shows only the patients and studies whose name, ID, date or description contains this.";
    srch.style.cssText = "width:100%;box-sizing:border-box;margin:4px 0;";
    srch.disabled = busy();
    srch.addEventListener("input", () => { search = srch.value; void render().then(() => { const x = body.querySelector<HTMLInputElement>('input[type="search"]'); x?.focus(); x?.setSelectionRange(search.length, search.length); }); });
    s2.appendChild(srch);
    const list = document.createElement("div");
    list.className = "sl-tw-list";
    s2.appendChild(list);

    // The candidates. Bring: every series of From. Back: what From has and To lacks, in studies To holds -- the results
    // ticked for you; another scan only listed, to tick by hand (finding 13: "Copies what you made").
    const cand = A.series.filter((s) => included(A, s) && (mode === "bring" ? !(onlyNew && whole(s)) : (!whole(s) && studiesInB.has(s.studyInstanceUID ?? ""))));
    const q = search.trim().toLowerCase();
    const shown = cand.filter((s) => !q || [s.patientName, s.patientID, s.studyDate, day(s.studyDate), s.studyDescription, s.description].some((x) => (x ?? "").toLowerCase().includes(q)));
    if (mode === "back" && autoTick) { for (const s of shown) if (isResult(A, s)) ticked.add(s.seriesInstanceUID); }
    autoTick = false;
    const byPatient = new Map<string, Map<string, DbSeriesEntry[]>>();
    for (const s of shown) {
      const p = `${s.patientID ?? ""}\u0000${s.patientName ?? ""}`;
      const st = byPatient.get(p) ?? new Map<string, DbSeriesEntry[]>(); byPatient.set(p, st);
      const l = st.get(s.studyInstanceUID ?? "") ?? []; l.push(s); st.set(s.studyInstanceUID ?? "", l);
    }
    const toName = dbName(db(toId)!), fromName = dbName(db(fromId)!);
    if (!byPatient.size) list.appendChild(hint(mode === "back" ? `Nothing here that ${toName} does not have, in the studies it holds.` : (q ? "Nothing matches the search." : `${fromName} holds nothing to copy.`)));
    for (const [p, studies] of byPatient) {
      const [pid, pname] = p.split("\u0000");
      const all = [...studies.values()].flat();
      const todo = all.filter((s) => !whole(s));
      list.appendChild(row(`<b>${esc(pname || pid || "Unnamed patient")}</b>`, `${plural(studies.size, "study", "studies")} · ${plural(all.length, "scan")}${todo.length < all.length ? ` · ${all.length - todo.length} already in ${esc(toName)}` : ""}`,
        all.map((s) => s.seriesInstanceUID), todo.length === 0, "", "Tick the patient to take every study; or tick single studies below."));
      for (const [, ss] of studies) {
        const f = ss[0], left = ss.filter((s) => !whole(s)), part = ss.filter(partial);
        list.appendChild(row(esc([f.studyDescription || "Study", day(f.studyDate)].filter(Boolean).join(", ")),
          left.length ? `${plural(ss.length, "scan")}${left.length < ss.length ? `, ${ss.length - left.length} already there` : ""}${part.length ? `, ${part.length} there only in part` : ""}` : `already in ${esc(toName)}`,
          ss.map((s) => s.seriesInstanceUID), left.length === 0, "sl-tw-in", ""));
        if (mode === "back") for (const s of ss) list.appendChild(row(esc(`${s.description || s.modality || "Series"}`), `${esc(isResult(A, s) ? "made here" : "a scan, not made here")}${partial(s) ? ` · ${B.count.get(s.seriesInstanceUID)} of ${s.count} images there` : ""} · ${esc(s.modality ?? "")}`, [s.seriesInstanceUID], false, "sl-tw-in2", ""));
      }
    }

    // WHAT WILL HAPPEN
    const chosenAsked = A.series.filter((s) => ticked.has(s.seriesInstanceUID));
    // A move takes the results made from its scans along (finding 3); said here, counted in the button.
    const along = move ? resultsOf(A, chosenAsked.map((s) => s.seriesInstanceUID)).filter((u) => !ticked.has(u)) : [];
    const chosen = [...chosenAsked, ...A.series.filter((s) => along.includes(s.seriesInstanceUID))];
    const fresh = chosen.filter((s) => !whole(s));
    const pts = new Set(chosen.map((s) => `${s.patientID}\u0000${s.patientName}`)).size, sts = new Set(chosen.map((s) => s.studyInstanceUID)).size;
    const bytes = fresh.reduce((n, s) => n + (A.sizes[s.seriesInstanceUID] ?? 0), 0);
    const from = db(fromId)!, to = db(toId)!;
    const will = document.createElement("div");
    will.className = "sl-tw-will";
    will.innerHTML = !chosen.length ? `<b>Nothing chosen yet.</b> Tick ${mode === "bring" ? "a patient or a study" : "what to take back"} above.`
      : `<b>What will happen:</b> ${plural(pts, "patient")}, ${plural(sts, "study", "studies")}, ${plural(fresh.length, "scan")}${bytes ? ` (${mb(bytes)})` : ""} ${fresh.length === 1 ? "is" : "are"} <b>${move ? "moved" : "copied"}</b> from ${esc(fromName)} to ${esc(toName)}` +
        (chosen.length > fresh.length ? `; ${plural(chosen.length - fresh.length, "scan")} ${chosen.length - fresh.length === 1 ? "is" : "are"} already there and ${chosen.length - fresh.length === 1 ? "is" : "are"} not copied again` : "") + ". " +
        (along.length ? `${along.length === 1 ? "One result" : `${along.length} results`} made from these scans ${along.length === 1 ? "goes" : "go"} with them. ` : "") +
        (move ? `Every image is read back from ${esc(toName)} first; only then, when you press a second time, ${chosen.length === 1 ? "is it" : "are they"} removed from ${esc(fromName)}.` : `${esc(fromName)} is not changed.`) +
        (include.scenes ? " Saved scenes of these studies come along when every scan they show is there." : "");
    body.appendChild(will);

    // THE ONE YELLOW BUTTON: its label is the progress while a transfer runs.
    const acts = document.createElement("div");
    acts.className = "sl-tw-acts";
    const go = document.createElement("button");
    go.className = "sl-primary sl-tw-go";
    go.textContent = running ? progressLabel(running.progress, running.move) : `${move ? "Move" : "Copy"} ${plural(chosen.length, "scan")}`;
    go.title = move ? "Copies, reads every image back, then asks before removing anything from the first database." : "Copies the chosen scans. Nothing in the first database changes.";
    go.disabled = busy() || !chosen.length;
    go.addEventListener("click", () => {
      const uids = chosenAsked.map((s) => s.seriesInstanceUID);
      if (from.description?.patientData === true && to.description?.patientData === false) return warn(from, to, () => void run(uids));
      void run(uids);
    });
    acts.appendChild(go);
    body.appendChild(acts);
    if (doneBox) body.appendChild(doneBox);
    body.appendChild(advanced());
    body.scrollTop = top;

    function row(label: string, right: string, uids: string[], off: boolean, cls: string, tip: string) {
      const r = document.createElement("label");
      r.className = `sl-tw-row ${cls}${off ? " sl-tw-off" : ""}`;
      if (tip) r.title = tip;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const live = uids.filter((u) => { const s = A.series.find((x) => x.seriesInstanceUID === u); return !s || !whole(s); });
      cb.disabled = busy() || off || !live.length;
      cb.checked = live.length > 0 && live.every((u) => ticked.has(u));
      cb.indeterminate = !cb.checked && live.some((u) => ticked.has(u));
      cb.addEventListener("change", () => { for (const u of live) cb.checked ? ticked.add(u) : ticked.delete(u); doneBox = null; void render(); });
      const t = document.createElement("span"); t.innerHTML = label;
      const k = document.createElement("span"); k.className = "sl-tw-k"; k.innerHTML = right;
      r.append(cb, t, k);
      return r;
    }
  };

  /** The results made from these series (children of children too). */
  const resultsOf = (l: Listing, uids: string[]): string[] => {
    const seen = new Set(uids), out: string[] = [], stack = [...uids];
    while (stack.length) for (const c of l.kids.get(stack.pop()!) ?? []) if (!seen.has(c) && l.count.has(c)) { seen.add(c); out.push(c); stack.push(c); }
    return out;
  };

  /** The one check, public or not (Ron, 2026-10-02: "Public data or not"): two buttons, neither preselected. */
  const warn = (from: RegisteredDb, to: RegisteredDb, onGo: () => void) => {
    body.querySelector(".sl-tw-stop")?.remove();
    const w = document.createElement("div");
    w.className = "sl-tw-stop";
    w.innerHTML = `<b>${esc(dbName(to))} is described as public data.</b> ${move ? "Moving" : "Copying"} scans into it from ${esc(dbName(from))}, which is not public, would change that.`;
    const a = document.createElement("div"); a.className = "sl-tw-acts";
    const other = document.createElement("button"); other.textContent = "Choose another database"; other.title = "Leaves everything as it is; choose where the scans go.";
    const anyway = document.createElement("button"); anyway.textContent = `${move ? "Move" : "Copy"} anyway`; anyway.title = `Goes ahead. Edit ${dbName(to)}'s description afterwards (Databases…) so it says what it holds.`;
    other.addEventListener("click", () => { w.remove(); body.querySelectorAll<HTMLSelectElement>(".sl-tw-f select")[1]?.focus(); });
    anyway.addEventListener("click", () => { w.remove(); onGo(); });
    a.append(other, anyway); w.appendChild(a);
    body.querySelector(".sl-tw-go")?.parentElement?.before(w);
  };

  /** Start the transfer, show its progress in the button, then what happened. What was started is what is reported. */
  const run = async (uids: string[]) => {
    const started = { move, from: fromId, to: toId };
    running = { ...started };
    doneBox = null;
    await render();
    const from = db(started.from)!, to = db(started.to)!;
    const { ok, j } = await post("/_db/_transfer", { from: started.from, to: started.to, series: uids, move: started.move, scenes: include.scenes, by: `Albula ${BUILD_ID}` });
    if (!ok) { running = null; doneBox = message(`Nothing was ${started.move ? "moved" : "copied"}: ${String(j.error ?? "Albula did not answer")}.`); await render(); return; }
    const job = String(j.job);
    const r = await follow(job, (x) => x.progress?.phase === "done" || x.progress?.phase === "ready" || !!x.error);
    running = null;
    listings.delete(started.to);
    o.onChanged?.(started.to);
    doneBox = r.result ? report(r, from, to, job, started.move) : message(`The transfer stopped: ${r.error ?? "no answer from Albula"}. What arrived before it stopped is listed in ${dbName(to)} and in its record.`);
    ticked.clear();
    await render();
  };

  /** Ask the server until `until` says so; the button shows where it is. A job Albula no longer knows ends the wait (finding 18). */
  const follow = async (job: string, until: (j: TransferJob) => boolean): Promise<TransferJob> => {
    let misses = 0;
    for (;;) {
      const r = await fetch(`/_db/_transfer/${job}`, { cache: "no-store" }).catch(() => null);
      const j = r ? await r.json().catch(() => null) as TransferJob | null : null;
      if (r?.status === 404) return { error: j?.error ?? "Albula no longer knows this transfer" };
      if (!j) { if (++misses > 20) return { error: "Albula stopped answering" }; await new Promise((res) => setTimeout(res, 1500)); continue; }
      misses = 0;
      if (running) { running.progress = j.progress; const b = body.querySelector<HTMLButtonElement>(".sl-tw-go"); if (b) b.textContent = progressLabel(j.progress, running.move); }
      if (until(j)) return j;
      await new Promise((res) => setTimeout(res, 400));
    }
  };

  /** What happened, said once, with the buttons for what comes next. */
  const report = (j: TransferJob, from: RegisteredDb, to: RegisteredDb, job: string, wasMove: boolean): HTMLElement => {
    const r = j.result!;
    const d = document.createElement("div");
    d.className = "sl-tw-done";
    const ok = r.identical.length, all = r.series.length;
    const lines = [`<b>Done:</b> ${plural(r.added, "scan")} copied to ${esc(dbName(to))} (${plural(r.instances, "image")}) in ${(r.ms / 1000).toFixed(1)} s` +
      (r.already ? `; ${plural(r.already, "image")} ${r.already === 1 ? "was" : "were"} there already` : "") + "." +
      (ok === all ? ` Every image was read back and is identical to ${esc(dbName(from))}'s.` : ` ${ok} of ${all} scans arrived whole and identical.`)];
    if (r.scenes) lines.push(`${plural(r.scenes, "saved scene")} came along.`);
    for (const x of r.differ) {
      const what = [x.missing ? `${plural(x.missing, "image")} missing` : "", x.different ? `${plural(x.different, "image")} differ` : "", x.same ? `${plural(x.same, "image")} ${x.same === 1 ? "is" : "are"} the very same file in both (one folder, two names?)` : ""].filter(Boolean).join(", ");
      lines.push(`“${esc(x.description || "a scan")}”: ${what} in ${esc(dbName(to))}${wasMove ? `; it stays in ${esc(dbName(from))}` : ""}.`);
    }
    for (const x of r.failed) lines.push(`“${esc(x.description || "a scan")}” was not copied: ${esc(x.error)}.`);
    for (const n of r.notes) lines.push(esc(n));
    d.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
    const a = document.createElement("div"); a.className = "sl-tw-acts";
    if (wasMove && j.progress?.phase === "ready" && r.identical.length) {
      const hintLine = document.createElement("div");
      hintLine.textContent = `Nothing has left ${dbName(from)} yet. The move waits at the top of this window until you remove them there or keep them.`;
      d.appendChild(hintLine);
    }
    if (to.current && o.onOpenBrowser) {
      const open = document.createElement("button");
      open.textContent = "Open the DICOM database…"; open.title = `${dbName(to)}'s patients, studies and scans, to load.`;
      open.addEventListener("click", () => o.onOpenBrowser?.());
      a.appendChild(open);
    }
    const rec = document.createElement("button");
    rec.textContent = "Show the record"; rec.title = `What came into and went out of ${dbName(to)}: when, from where, what, and with which Albula.`;
    rec.addEventListener("click", () => void showRecord(d, to));
    a.appendChild(rec);
    d.appendChild(a);
    void job;
    return d;
  };

  const showRecord = async (into: HTMLElement, d: RegisteredDb) => {
    into.querySelector(".sl-tw-recs")?.remove();
    const j = await fetch(`/_db/${encodeURIComponent(d.id)}/_record?limit=30`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({})) as { entries?: RecordEntry[] };
    const box = document.createElement("div");
    box.className = "sl-tw-recs";
    const where = (e: RecordEntry) => e.what === "copied in" || e.what === "move finished" ? `from ${e.from.name}` : e.what.startsWith("move not") ? `between ${e.from.name} and ${e.to.name}` : `to ${e.to.name}`;
    box.innerHTML = `<div class="sl-hint">${esc(dbName(d))}'s record, newest first:</div>` + ((j.entries ?? []).map((e) =>
      `<div class="sl-tw-rec">${esc(e.at.slice(0, 16).replace("T", " "))} UTC · ${esc(e.what)} · ${esc(where(e))} · ${plural(e.patients.length, "patient")}, ${plural(e.studies.length, "study", "studies")}, ${plural(e.series.length, "scan")} · ${esc(e.checked)}${e.waiting ? ` · ${esc(e.waiting)}` : ""}</div>`).join("") || `<div class="sl-tw-rec">Nothing yet.</div>`);
    into.appendChild(box);
  };

  /** Everything that is not one of the two defaults. Collapsed. */
  const advanced = (): HTMLElement => {
    const det = document.createElement("details");
    det.className = "sl-tw-sec sl-dim sl-tw-adv";
    det.open = advOpen;
    det.addEventListener("toggle", () => { advOpen = det.open; });
    det.innerHTML = `<summary title="Move instead of copy, what to include, only what is new, start fresh.">Advanced</summary>`;
    const h = (t: string) => { const x = document.createElement("h4"); x.textContent = t; det.appendChild(x); };
    const opt = (type: "radio" | "checkbox", label: string, tip: string, checked: boolean, on: (v: boolean) => void, name = "") => {
      const l = document.createElement("label"); l.title = tip;
      const i = document.createElement("input"); i.type = type; i.checked = checked; i.disabled = busy(); if (name) i.name = name;
      i.addEventListener("change", () => { on(i.checked); doneBox = null; void render(); });
      l.append(i, document.createTextNode(" " + label));
      det.appendChild(l);
    };
    h("Copy or move");
    opt("radio", "Copy — both databases have it", "The scans end up in both databases.", !move, (v) => { if (v) move = false; }, "sl-tw-move");
    opt("radio", "Move — it leaves the first database", "Copies, reads every image back to check it is identical, then asks before removing anything from the first database. The results made from a moved scan go with it.", move, (v) => { if (v) move = true; }, "sl-tw-move");
    h("What to include");
    opt("checkbox", "Scans — the original images", "The images from the scanner.", include.scans, (v) => { include.scans = v; });
    opt("checkbox", "Results — outlines, segmentations, surfaces", "What was made from the scans.", include.results, (v) => { include.results = v; });
    opt("checkbox", "Scenes — saved views of these studies", "A saved scene comes along when every scan it shows is in the other database.", include.scenes, (v) => { include.scenes = v; });
    h("What is new here");
    opt("checkbox", "Show only what the other database does not have", "Hides the scans the database you copy into already holds whole.", onlyNew, (v) => { onlyNew = v; });
    h("Start fresh");
    const cur = dbs.find((d) => d.current && d.exists);
    if (cur) {
      const archive = `${dbName(cur)}, archive ${localDay()}`;
      const b = document.createElement("button");
      b.textContent = `Keep ${dbName(cur)} as an archive and start a new one…`;
      b.title = `${dbName(cur)} is renamed “${archive}” and stays in the list, unchanged; a new, empty “${dbName(cur)}” opens by default. Nothing is deleted.`;
      b.disabled = busy();
      b.addEventListener("click", () => {
        const c = document.createElement("div");
        c.className = "sl-tw-done";
        c.innerHTML = `${esc(dbName(cur))} becomes <b>${esc(archive)}</b>: kept, unchanged, still in the list. A new, empty <b>${esc(dbName(cur))}</b> opens by default from now on. Nothing is deleted.`;
        const a = document.createElement("div"); a.className = "sl-tw-acts";
        const yes = document.createElement("button"); yes.textContent = "Start fresh"; yes.title = "Renames this one and makes the new one.";
        const no = document.createElement("button"); no.textContent = "Cancel"; no.title = "Changes nothing.";
        no.addEventListener("click", () => c.remove());
        yes.addEventListener("click", async () => {
          yes.disabled = no.disabled = true;
          const err = await startFresh(cur, archive);
          if (err) { c.textContent = err; return; }
          dbs = (await listDatabases()).databases;
          listings.clear(); mode = null; ticked.clear();
          doneBox = message(`${archive} is kept; the new ${dbName(cur)} opens by default.`);
          o.onChanged?.();
          await render();
        });
        a.append(yes, no); c.appendChild(a);
        b.after(c);
      });
      det.appendChild(b);
    }
    return det;
  };

  /** Make a new database under the current one's name, then rename the current one's description, then open the new one. */
  const startFresh = async (cur: RegisteredDb, archive: string): Promise<string | undefined> => {
    const desc = cur.description ?? { name: dbName(cur) };
    const made = await post("/_db/_create", { ...desc, name: dbName(cur) });
    if (!made.ok) return `The new database could not be made: ${String(made.j.error ?? "Albula refused")}.`;
    const renamed = await post(`/_db/${encodeURIComponent(cur.id)}/_description`, { ...desc, name: archive }, "PUT");
    if (!renamed.ok) return `The new database was made, but the old one could not be renamed: ${String(renamed.j.error ?? "")}.`;
    await post("/_db", { current: String(made.j.id) }, "PUT");
    return undefined;
  };

  const sec = (title: string) => { const s = document.createElement("div"); s.className = "sl-tw-sec"; s.innerHTML = `<div class="sl-tw-h">${esc(title)}</div>`; return s; };
  const field = (label: string, control: HTMLElement) => { const f = document.createElement("div"); f.className = "sl-tw-f"; const l = document.createElement("span"); l.textContent = label; f.append(l, control); return f; };
  const hint = (t: string) => { const p = document.createElement("p"); p.className = "sl-hint"; p.textContent = t; return p; };
  const message = (t: string) => { const d = document.createElement("div"); d.className = "sl-tw-done"; d.textContent = t; return d; };

  void (async () => {
    const r = await listDatabases();
    dbs = r.databases;
    if (!r.features.includes("transfer")) { body.appendChild(hint("This Albula's server is older than this window and cannot transfer between databases; rebuild the application.")); return; }
    if (dbs.filter((d) => d.exists).length < 2) { body.appendChild(hint("There is only one database. Make a second one in Databases… first.")); return; }
    await render();
  })();
}
