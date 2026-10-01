// "AI segmentations" — run a trained network over a loaded volume and get the labels back.
//
// Ron's specification, and the reason it is this small: "I envision initially a stand alone module.
// Very simple: Input data, output data, network selection and pointer to the paper that describes
// the output and organization of the output. That paper can be viewed in the default browser."
//
// Four controls, in that order, and nothing else.
//
// THE NETWORKS ARE NOT OURS AND ARE NOT LISTED HERE. They come from haversack (Michael Halle,
// github.com/mhalle/haversack) at runtime -- Ron: "It sounds good that we onboard one or two trained
// networks, but in general lets assume that people will do it at runtime." So the catalog is
// whatever the server reports, 87 tasks across TotalSegmentator, MOOSE and MRSegmentator on the
// machine this was written on, and a network somebody adds tomorrow appears without a change here.
//
// NOT RUNNING IS A NORMAL STATE, not an error. The panel says so and shows the line to paste,
// because a segmentation server is a thing a person starts when they want it.
//
// WHY THE ROUND TRIP IS AN UPLOAD. haversack can fetch `idc:` and `tcia:` series itself, but the
// interesting input here was made locally -- Ron's cropped abdominal CT exists in his database and
// nowhere else -- so no hosted identifier names it. It goes up as one NRRD written from the volume
// already in the scene, which is a single file instead of 993 DICOM instances, and comes back as a
// .seg.nrrd on the same grid.
//
// WHAT THIS DOES NOT DO YET, deliberately and not by oversight: write the result into the DICOM
// database. That is the more valuable half and it is the next step, because the moment of creation
// is the only moment the provenance is free -- see docs/WORKING-STATE.md, "Provenance, decided
// 2026-09-04". The labels currently land in the scene, which is what makes the round trip visible.
import { holdsInstance } from "../../logic/instance-key.ts";
import { paletteVersion } from "../../logic/anatomy/palettes.ts";
import { escapeHtml } from "./html.ts";
import { currentFrames } from "../../logic/sequences.ts";
import type { AppShell } from "./app-shell.ts";
import { runAction } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";
import { exportVolume } from "../../logic/export.ts";
import { packLabelsToByte, parseNrrdSeg } from "../nrrd.ts";
import { licenseFor, outputRestriction } from "../../logic/model-license.ts";
import { ecosystemOf, resolveTask, unversioned } from "../../logic/task-name.ts";
import {
  type Checkpoint,
  discardCheckpoint,
  findSavedCheckpoint,
  humanBytes,
  listCheckpoints,
  readCheckpoint,
  saveCheckpoint,
  timeAgo,
} from "../../logic/checkpoint.ts";
import { createSegmentationFromLabelmap } from "../../logic/segmentation-editor.ts";
import { keepScroll } from "./panel-scroll.ts";
import { openNetworkBrowser } from "./network-browser.ts";
import { acceptedParameters, describeStatus, type HaversackTask, isFinished, job, keepAcceptedOptions, missingWeightIds, result, serverStatus, submitVolume, tasks, type WeightEntry, weightPresent } from "../../logic/haversack.ts";
import { formatCitation, paperFor } from "../../logic/anatomy/model-papers.ts";
import { type Attribution, attributionOf, formatCite, licenseLine, primaryCite } from "../../logic/attribution.ts";
import { freesurferStructureFor, lookupStructure, systemColour, usesFreesurferNumbering } from "../../logic/segment-naming.ts";
import { coloursFor, type LookedUp } from "../../logic/segment-colours.ts";
import { allPresets, PRESETS, presentationFor, presentationParams, presetIdFor } from "../../logic/presentation.ts";
import { colorizeParamOf, setColorizeParams, setLook3D, setVolumeRenderingOn, volumeRenderingOn, vrNodeFor } from "./tf-editor.ts";
import { storedLook3D } from "../look3d.ts";
import { isColorMap } from "../fields.ts";

/** How often to ask a running job how it is doing. The server's own stages are seconds long. */
const POLL_MS = 800;

/** Give up if the server's answer has not changed in this long. A `total` run is minutes, not this. */
const STALL_MS = 10 * 60 * 1000;

export function registerAiSegPanel(
  shell: AppShell,
  opts: { live: LiveScene; store: LocalBlobStore; onStatus?: (s: string) => void },
): void {
  const { live, store } = opts;
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };

  /**
   * ONE PLACE THAT DECIDES WHETHER A SAVE COUNTS AS SAVED.
   *
   * "Saved" means findable in the DICOM database. The save routine has paths that write the file
   * and do NOT get it into the index, and a path that hands the bytes to the browser's downloads
   * (which does nothing at all in the app's webview) -- and all of them resolved, so the button
   * said "Saved ✓" over a file nobody can find (critic 2026-09-22, 1.6). A throw here is what makes
   * the button say "Not saved" and the status line say why.
   */
  async function saveAndSay(p: Promise<{ filename: string; note?: string; indexed?: boolean }> | undefined): Promise<void> {
    const r = await p;
    if (!r) throw new Error("no DICOM database is reachable from here");
    const note = r.note ?? r.filename;
    if (r.indexed === false || /NOT indexed|NOT saved|browser's downloads/i.test(note)) {
      status(`not in the database — ${note}`);
      throw new Error(note);
    }
    status(`saved — ${note}`);
  }

  let catalog: HaversackTask[] = [];
  let serverNote = "checking for a segmentation server…";
  let startCommand = "";
  let chosenTask = "";
  let taskFilter = "";
  /** Ron: "the search should only show up when the pull down is activated." Collapsed by default. */
  let taskPickerOpen = false;
  let showRecent = false;       // the temporary copies unfold only when asked (a button under Advanced)
  /** The last result that landed, shown in the module itself (Ron, 2026-09-22: "The naive user is
   *  focused on the upper part of the module on the left. You could actually integrate the
   *  functionality and information into the module."). The notice in the corner is for when the
   *  person is in another module. */
  let lastResult: { segId: string; task: string; volume: string; structures: number; ms: number; savable: boolean; kept: boolean; saved?: string; volumeTurnedOff?: string } | null = null;
  let chosenInput = "";
  /**
   * A RUN IS A JOB (docs/CONSTRAINTS.md, the job paradigm). Ron, 2026-09-14: "when a longish
   * task is running, it is likely that the users will do something else in the meantime", and
   * "yes to tick several networks and run them in a row". Pressing Segment adds a job; jobs run
   * one after another (one GPU, no fighting for it); each lands in the scene by itself when it is
   * done and says so once, where the user is, whatever module they are in. The list below is
   * what is running, and what ran, without going to look for it.
   */
  interface Job {
    id: number;
    task: string;
    inputId: string;
    inputName: string;
    state: "queued" | "running" | "done" | "failed" | "cancelled";
    progress: string;
    queuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    /** haversack's id for the job, once submitted: what a restarted page re-attaches to. */
    serverJobId?: string;
    cancel: boolean;
    restore?: Checkpoint;
    segId?: string;
  }
  const jobs: Job[] = [];
  let nextJobId = 1;
  const isBusy = () => jobs.some((j) => j.state === "running");
  /** The panel's own line under the buttons: the newest job's progress, so a watcher still sees it. */
  let progress = "";
  /** ms -> "42s" / "3m07s" / "1h02m". */
  const hms = (ms: number) => {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  };
  let taskDetail = "";
  /** Who made the chosen network, as the server says (haversack >= 0.7); null until it has answered. */
  let taskAttribution: Attribution | null = null;
  /** How many networks the chosen task runs — ts:total is five, ts:total_fast is one. */
  let taskNetworks = 0;
  /** Whether this task declares `envelope_mm` — the field-of-view control is only shown if it does. */
  let taskAcceptsEnvelope = false;
  let missingWeights: string[] = [];
  /** The volume the last result was presented on, and the task it came from -- so the unlabeled-body
   *  toggle knows which volume it acts on and which preset "on" restores to. */
  let presentedVolume = "";
  let presentedTask = "";
  /**
   * The appearance the next run will use.
   *
   * Empty means "whatever this network defaults to", which is the state it returns to when the
   * network changes: a preset chosen for a brain parcellation is not a choice about the next
   * whole-body CT. Once a person picks one explicitly it stays picked for that network.
   */
  let presetChoice = "";
  // WHAT THE RESULT ARRIVES AS. Surfaces by default (Ron, 2026-09-22: "our default is surface models
  // as colorize volume is slower"); the colorized volume is a choice, and then the volume is
  // rendered with the chosen preset the moment the result lands. Sequences stay colorized (the
  // surfaces are one still mesh; "It doesn't move in 3D.").
  const SURFACES = "surfaces";
  let arrival = SURFACES;
  /** The result in its volume's look from Scene: Surfaces if that was chosen there, else Colored (solid);
   *  a sequence's Colored is its colored volume, which steps with the frames. */
  const arriveInSceneLook = (imageId: string) => setLook3D(live, imageId, storedLook3D(live, imageId) === "surfaces" ? "surfaces" : "solid");
  /** The see-through colored volume (a colorized look chosen here): the volume rendered and tinted. */
  const seeThroughColored = (imageId: string) => {
    setVolumeRenderingOn(live, imageId, true);
    const vr = vrNodeFor(live, imageId);
    if (vr) live.write({ op: "patch", id: vr.id, path: "#/colorize", value: true });
  };
  /** The preset the result on screen was actually presented with, so the eye restores to that. */
  let presentedPreset = "";
  const presetInUse = () => presetChoice || presetIdFor(chosenTask);
  let restoreNote = "";
  let restoreMode = "";
  let fetching = false;
  let interp: "linear" | "nearest" = "linear";
  /**
   * haversack's `envelope_mm`: crop the network's field of view to this margin around the body.
   *
   * THE HONEST WAY TO MAKE A RUN FASTER. Ron: "Cached result is not useful for a honest demo. How do
   * I get as fast as possible for ts:total?" A CT's bounding box is mostly air and table, and every
   * one of those voxels is tiled over by five networks. Cropping to the body removes work rather
   * than accuracy: anatomy inside the envelope is segmented exactly as before.
   *
   * OFF BY DEFAULT, because it changes what is computed and not merely how it looks -- anything
   * outside the margin is not seen by the network at all. That is Ron's own line about the data
   * being left alone unless a change is asked for, so it is asked for.
   */
  let envelopeMm: number | null = null;
  /** Finished runs sitting on disk, newest first — see logic/checkpoint.ts. */
  let checkpoints: Checkpoint[] = [];

  async function refreshCheckpoints() {
    checkpoints = await listCheckpoints();
    render();
  }

  /** Projects whose terms have been accepted this session — asked once, not once per run. */
  const licenseAccepted = new Set<string>();

  /**
   * Put the terms in front of the person at the moment they matter: the click that makes a result.
   *
   * Ron: "The license conditions should jump up when someone clicks the segment button after
   * selecting one of the networks that has a non commercial license. There should be a link to the
   * page that you sent me to."
   *
   * Asked ONCE PER PROJECT PER SESSION, because a dialog on every run is a dialog nobody reads —
   * except for the four tasks whose RESULTS are restricted, which are re-stated every time. That
   * distinction is the whole reason this is not a one-line checkbox: a restriction on the software
   * ends when you close the application, and a restriction on the output does not.
   */
  async function acceptLicense(): Promise<boolean> {
    const lic = licenseFor(chosenTask);
    if (!lic) return true;
    const restriction = outputRestriction(chosenTask);
    if (licenseAccepted.has(lic.project) && !restriction) return true;

    const ok = await shell.confirm({
      title: `${lic.project} — academic, non-commercial use`,
      ok: "I agree — segment",
      cancel: "Cancel",
      body: `<p>This network is <b>${lic.project}</b>, and it is free for academic use only.</p>` +
        (restriction ? `<p style="color:var(--sl-callout)"><b>${restriction}</b></p>` : "") +
        `<dl>${lic.terms.map((t) => `<dt>${t.title}</dt><dd>${t.text}</dd>`).join("")}</dl>` +
        `<p>Full terms, and the free academic license: <a href="${lic.url}">${lic.url}</a></p>`,
    });
    if (ok) licenseAccepted.add(lic.project);
    else status("not run — the license was not accepted");   // the status line, not a line that stays under Segment for the next network (critic 2.6)
    render();
    return ok;
  }

  const transport = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

  /** Loaded grayscale volumes. A segmentation is not an input to a segmenter. A sequence offers
   *  the frame on screen, not all of its frames: the result covers every frame anyway (the
   *  volume-rendering manager's `covers`), and five rows for one heart is a list to get lost in. */
  const inputs = () => {
    const current = currentFrames(live);
    return [...live.nodes.values()]
      // Not a color map (Color FA): its samples are packed colors, not an image a network can read.
      .filter((n) => n.type === "image" && !n.labelmap && n.zarr && !isColorMap(n) && (!n.sequence || current.has(n.id as string)))
      .map((n) => ({ id: n.id as string, name: current.get(n.id as string) ?? (n.name as string) ?? (n.id as string) }));
  };

  /** Fill in `installed` per task, eight at a time. Silent on failure: unknown must say nothing. */
  async function annotateInstalled(list: HaversackTask[]) {
    const queue = [...list];
    const worker = async () => {
      for (;;) {
        const t = queue.shift();
        if (!t) return;
        try {
          const d = await fetch(`/_haversack/tasks/${encodeURIComponent(t.name)}`, { cache: "no-store" })
            .then((r) => r.ok ? r.json() : null);
          const w = (d?.weights_installed ?? []) as WeightEntry[];
          if (w.length) t.installed = w.every(weightPresent);
        } catch { /* leave it unannotated */ }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  let starting = false;
  let startingNote = "";
  /** Ask our own server to launch haversack, then wait for it to answer. */
  async function startServer() {
    if (starting) return;
    starting = true; startingNote = "starting the segmentation server…"; render();
    const t0 = Date.now();
    try {
      const r = await fetch("/_haversack/_start", { method: "POST" }).then((x) => x.json()).catch((e) => ({ started: false, error: String(e) }));
      if (!r.started) { startingNote = r.error ?? r.note ?? "it did not start"; if (r.note === "already running") await refreshServer(); return; }
      status(`starting the segmentation server (log: ${r.log})`);
      for (;;) {
        await new Promise((res) => setTimeout(res, 1500));
        const st = await serverStatus(transport);
        if (st.reachable) { await refreshServer(); status(`segmentation server started in ${Math.round((Date.now() - t0) / 1000)} s`); return; }
        const secs = Math.round((Date.now() - t0) / 1000);
        startingNote = secs < 90
          ? `starting… ${secs} s (the first start builds its Python environment and can take a minute or two)`
          : `still starting after ${secs} s — the log is at ${r.log}`;
        render();
        if (secs > 300) { startingNote = `not answering after ${secs} s; see ${r.log}, or start it by hand with the command below`; return; }
      }
    } finally { starting = false; render(); }
  }

  /** A refresh started by opening the module is in flight (onShow). */
  let refreshingOnShow = false;
  async function refreshServer() {
    // Server state and credential state in one answer. Asking /v1/health alone reports a healthy
    // server while its token is unusable, which is how "requires a bearer token" arrives with no
    // indication that anything is running.
    const st = await serverStatus(transport);
    serverNote = describeStatus(st);
    if (!st.reachable) {
      startCommand = st.start ?? "";
      catalog = [];
    } else {
      startCommand = "";
      catalog = await tasks(transport);
      // Then ask each task whether its weights are here. /v1/tasks gives bare names and no installed
      // flag, so without this the dropdown advertises 74 networks and says nothing about which can
      // run -- and on this machine SIX can. Ron picked one of the 68 and found out after the upload.
      //
      // 74 requests, but to a server on loopback through our own proxy, so it is a fraction of a
      // second; eight at a time so a slow one cannot stall the rest, and any failure just leaves
      // that task unannotated rather than blocking the panel.
      await annotateInstalled(catalog);
      // A task whose weights are on disk runs now; one whose are not pays a download first. But
      // `/v1/tasks` returns bare NAMES and says nothing about what is installed -- only the CLI's
      // --json form does -- so `installed` is usually undefined here. Hence `=== false` at the
      // render site: undefined must say nothing, because claiming every network needs a download
      // would be false for the two that do not, and claiming none does would be worse.
      catalog.sort((a, b) => Number(b.installed === true) - Number(a.installed === true) || a.name.localeCompare(b.name));
      const ready = catalog.filter((t) => t.installed === true).length;
      serverNote += ` · ${ready} ready to run here`;
      // THE NAMES CAN CHANGE UNDER A RUNNING PANEL. Mike, 2026-09-12: task prefixes carry a version
      // from now on, `ts:total` becomes `ts.v2:total`, and "things will break, and now is the time to
      // break them". A remembered choice is matched with the version taken off; one that is gone
      // altogether is said so, not silently swapped for the first in the list.
      const names = catalog.map((t) => t.name);
      const was = chosenTask;
      chosenTask = resolveTask(chosenTask, names) || resolveTask("ts:total_fast", names) || catalog[0]?.name || "";
      if (was && !resolveTask(was, names)) serverNote += ` · ${was} is no longer offered`;
    }
    render();
    void describeTask();
  }

  /** Rebuild the panel, keeping the scroll position (see panel-scroll.ts). */
  function render() { keepScroll(root, renderNow); }

  function renderNow() {
    if (!root) return;
    const vols = inputs();
    // THE NEWEST VOLUME, not the oldest. `live.nodes` is insertion-ordered, so vols[0] was the first
    // thing loaded -- which meant someone who had just cropped a volume in order to segment it found
    // this panel pointing at the uncropped original. Ron: "I went to ai segmentation module and it
    // defaulted to the original and not to the cropped. Its a heuristic, but what would a first time
    // user want?" They would want the one they just made: a volume is created because it is about to
    // be used. Same rule Slicer follows with its selection node's active volume.
    if (!chosenInput || !vols.some((v) => v.id === chosenInput)) chosenInput = vols[vols.length - 1]?.id ?? "";
    const paper = paperFor(chosenTask);

    // THREE SECTIONS, built from the shell's primitives rather than from a slab of markup.
    //
    // Ron: "there is no organization inside the module and optical separation of different
    // functional areas." A header on chrome over a body in the well is that separation, and the
    // colored band is his own analogy to the slice controllers' title bars. The row grammar is what
    // makes the label column a column: fixed 92px right-aligned, control, value.
    // THE FACE IS SHORT (Ron, 2026-09-22, "the general presentation"): Input, Network, the action
    // buttons. Boundaries, field of view, appearance, the unlabeled body, the model download and
    // the server line are under Advanced, collapsed; the queue shows only while something runs;
    // the network's paper and the temporary copies are sections folded by default. Explanations
    // that were paragraphs are tooltips ("This is tool tip material").
    root.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = "AI Segmentations";
    h.title = serverNote;
    root.append(h);
    if (startCommand) {
      // ONE CLICK, NOT A COMMAND TO COPY. Ron, 2026-09-15, after a reboot: "haversack seems to be
      // down." The application starts it here (desktop/haversack-proxy.ts _start) and waits for
      // the first health answer -- a minute the first time, while uvx builds the environment; a few
      // seconds after that. The command stays visible for anyone who would rather run it themselves.
      const p1 = document.createElement("p");
      p1.className = "sl-hint";
      p1.textContent = starting ? startingNote : "The application can start one for you; it runs while the application does.";
      const acts = shell.actions(root);
      acts.innerHTML = `<button class="sl-primary sl-ai-start"${starting ? " disabled" : ""}>${starting ? "Starting…" : "Start the segmentation server"}</button>`;
      const pre = document.createElement("pre");
      pre.className = "sl-ai-cmd";
      pre.title = "Or start it yourself, in a terminal, with this";
      pre.textContent = startCommand;
      root.append(p1, acts, pre);
      acts.querySelector<HTMLButtonElement>(".sl-ai-start")?.addEventListener("click", () => void startServer());
    }

    // ---- Segment: everything needed to start a run ----
    const seg = shell.section(root, "Segment", {
      open: true,
      band: "yellow",
      note: catalog.length ? `${catalog.filter((t) => t.installed === true).length} of ${catalog.length} ready` : "",
    });
    const inputCell = shell.row(seg, "Input", { value: vols.length ? String(vols.length) : "0" });
    inputCell.innerHTML = `<select class="sl-ai-input" title="The volume the network runs on">${
      vols.length
        ? vols.map((v) => `<option value="${v.id}"${v.id === chosenInput ? " selected" : ""}>${escapeHtml(v.name)}</option>`).join("")
        : `<option value="">load a volume first</option>`
    }</select>`;
    // CAN THE RESULT BE KEPT? Said before the run, not after it.
    //
    // A segmentation is saved as a DICOM SEG, and a SEG points at the series its source volume came
    // from. So a run on a scene-only volume -- a fresh crop, a dropped NIfTI -- produces something
    // that cannot be saved, and the way anyone finds that out is by waiting two and a half minutes
    // and then pressing Save. Ron: "Remember, your customer is a naive user."
    {
      const chosen = live.nodes.get(chosenInput);
      const org = chosen?.origin as { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
      if (chosen && !org?.seriesInstanceUID && !org?.savedSeriesInstanceUID) {
        // One line on the face; the rest is its tooltip (no fine print on the face, 2026-09-22).
        const p = document.createElement("p");
        p.className = "sl-hint";
        p.textContent = `Not in the DICOM database: the result can be made, not saved there.`;
        p.title = `"${chosen.name}" is in the scene only, so a result computed on it cannot be saved to the DICOM database — it would have nothing to point at. Put the volume there first: Crop volume → Put it in the DICOM database. The run itself works either way.`;
        seg.appendChild(p);
      }
    }
    // A network a person can browse; a name is faster to find by typing it. Ron, looking for
    // ts:liver_segments among 87: "so many nets that it would be good to have a search". Filtered
    // to a substring of the name, and the current selection is kept in the list even when it does
    // not match -- narrowing the choices must never silently swap out what is already chosen.
    const filteredTasks = taskFilter
      ? catalog.filter((t) => t.name.toLowerCase().includes(taskFilter.toLowerCase()) || t.name === chosenTask)
      : catalog;
    // Not a native <select>: "The search is not part of the popup" -- a native popup is OS-drawn
    // and cannot hold one. shell.searchablePicker is the shell's own, opened only on click (Ron:
    // "the search should only show up when the pull down is activated").
    const taskCell = shell.row(seg, "Network", {
      value: catalog.length ? (taskFilter ? `${filteredTasks.length}/${catalog.length}` : String(catalog.length)) : "0",
    });
    // THE TABLE VIEW OF THE SAME LIST. Ron: "We have over 70 networks ... I know for most not what
    // they are doing." The dropdown is for a name you know; the browser is for finding one by
    // modality, region, structure or family. Same catalog, same choice at the end.
    if (catalog.length) {
      const v = taskCell.parentElement?.querySelector(".sl-r-value") as HTMLElement | null;
      if (v) {
        (taskCell.parentElement as HTMLElement).style.gridTemplateColumns = "92px 1fr auto";   // the value column is sized for a number
        v.innerHTML = `<button class="sl-ai-browse" title="All ${catalog.length} networks in a table: modality, body region, structures, family, whether it runs here. Narrow by any of them.">Browse…</button>`;
        v.querySelector("button")!.addEventListener("click", () => openNetworkBrowser({
          catalog, selected: chosenTask,
          lastRunMs: (task) => lastComputedMs(task),
          onOpenUrl: (url) => void openExternal(url),
          onChoose: (name) => {
            if (name === chosenTask) return;
            chosenTask = name; presetChoice = ""; taskDetail = ""; taskAttribution = null; taskPickerOpen = false;
            render(); void describeTask();
            status(`network: ${name} — press Segment to run it`);
          },
          // SEVERAL IN A ROW: one job each on the chosen volume, run in turn. The license question
          // is asked once per project, as for a single run.
          onRunMany: (names) => {
            if (!chosenInput) { status("choose a volume first"); return; }
            void (async () => {
              for (const name of names) {
                const prior = chosenTask; chosenTask = name;
                const ok = await acceptLicense();
                chosenTask = prior;
                if (ok) enqueue(name, chosenInput);
              }
              status(`${names.length} networks queued on ${(live.nodes.get(chosenInput)?.name as string) ?? "the volume"}`);
            })();
          },
        }));
      }
    }
    shell.searchablePicker(taskCell, {
      options: catalog.map((t) => ({ value: t.name, label: `${t.name}${t.installed === false ? "  (downloads the model first)" : ""}` })),
      selected: chosenTask,
      open: taskPickerOpen,
      filter: taskFilter,
      placeholder: "",
      emptyLabel: catalog.length ? `no match for "${taskFilter}"` : "no server",
      onOpenChange: (open) => { taskPickerOpen = open; render(); },
      onFilterChange: (filter) => { taskFilter = filter; render(); },
      onSelect: (value) => {
        chosenTask = value;
        presetChoice = "";        // a preset chosen for a brain parcellation is not a choice about a CT
        taskDetail = "";
        taskPickerOpen = false;
        render();
        void describeTask();
      },
    });
    // ---- Result: the last run that landed, where the person is looking ----
    if (lastResult && live.nodes.get(lastResult.segId)) {
      const lr = lastResult;
      const res = shell.section(root, "Result", { open: true, band: "green", note: `${lr.structures} structures` });
      const line = document.createElement("p");
      line.className = "sl-hint";
      line.textContent = `${lr.task} on ${lr.volume}, in ${hms(lr.ms)}. In the scene now` +
        (lr.saved ? ` · saved to the DICOM database (${lr.saved})` : lr.kept ? " · not saved yet — a temporary copy is kept for a day" : " · not saved, and no temporary copy") + ".";
      res.appendChild(line);
      const ra = shell.actions(res);
      // WHERE ITS APPEARANCE IS CHANGED, said where the result is -- as a button, since the first-time
      // user does not read (Ron, 2026-09-20), with one plain line for the one who does. Ron,
      // 2026-09-23: "There should also be a message for the naive user where to modify the appearance
      // (Segmentations module)", after arteries and veins drew in one color and nothing here said why.
      const where = document.createElement("p");
      where.className = "sl-hint";
      where.textContent = `Colors, visibility and grouping of the ${lr.structures} structures: the Segmentations module. A folded group is drawn in one color.`;
      res.appendChild(where);
      if (lr.volumeTurnedOff && live.nodes.get(lr.volumeTurnedOff) && !volumeRenderingOn(live, lr.volumeTurnedOff)) {
        const off = document.createElement("p");
        off.className = "sl-hint";
        off.textContent = "The volume rendering you had on was switched off, so the new structures show. To change the look, go to Scene → In 3D.";
        res.appendChild(off);
        const back = shell.actions(res);
        back.innerHTML = `<button class="sl-ai-res-volume" title="Show ${lr.volume} as a volume rendering again (Scene → In 3D → Volume)">Back to the volume</button>`;
        back.querySelector(".sl-ai-res-volume")?.addEventListener("click", () => {
          setLook3D(live, lr.volumeTurnedOff!, "volume");
          lr.volumeTurnedOff = undefined;
          render();
        });
      }
      ra.innerHTML = `<button class="sl-ai-res-colors" title="Opens the Segmentations module: each structure's color and visibility, and whether groups are folded (one color) or open (each its own)">Colors and grouping…</button>` +
        `<button class="sl-ai-res-scene" title="Opens the Scene module, where you choose which views show it, its drawing order, 3D on or off, and can remove it">Adjust views…</button>` +
        (lr.savable && !lr.saved ? `<button class="sl-primary sl-ai-res-save" title="Write this segmentation into the DICOM database, under the series it was made on (with its surface models only if they were made in Generate Surface Models)">Save to DICOM</button>` : "");
      ra.querySelector(".sl-ai-res-scene")?.addEventListener("click", () => { void shell.showPanel("data"); });
      ra.querySelector(".sl-ai-res-colors")?.addEventListener("click", () => { void shell.showPanel("segmentations"); });
      // THE BUTTON SAYS WHAT IS HAPPENING TO IT, not only the status line. Ron pressed this one and
      // saw "no visible reaction on the button", with the outcome in "low contrast microprint at the
      // bottom" (2026-09-22). A save of a whole-body segmentation with its surfaces is tens of
      // seconds; it must read "Saving…", then "Saved", and "Not saved" when it fails.
      const saveBtn = ra.querySelector(".sl-ai-res-save") as HTMLButtonElement | null;
      saveBtn?.addEventListener("click", () => {
        const g = globalThis as unknown as { __exportSegAsDicom?: (id: string) => Promise<{ filename: string; note?: string }> };
        void runAction(saveBtn, async () => {
          status("saving to the DICOM database…");
          await saveAndSay(g.__exportSegAsDicom?.(lr.segId));
          lr.saved = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          setTimeout(render, 1800);            // after the button has said "Saved" where he is looking
        }, { busyLabel: "Saving…", doneLabel: "Saved ✓", failedLabel: "Not saved" })
          .catch((e) => status(`could not save it: ${(e as Error).message}`));
      });
    }
    const adv = shell.section(root, "Advanced", { open: false, band: "none" });
    const interpCell = shell.row(adv, "Boundaries", { wide: true });
    interpCell.innerHTML = `<select class="sl-ai-interp" title="How the result's edges are drawn: smoothed between voxels, or exactly the voxels the network labeled (for measuring volumes)">
        <option value="linear"${interp === "linear" ? " selected" : ""}>smooth (sub-voxel)</option>
        <option value="nearest"${interp === "nearest" ? " selected" : ""}>exact labels (for measuring volumes)</option>
      </select>`;
    // SPEED, WHERE THE WAIT IS DECIDED. Offered only when the task declares it: FastSurfer does not.
    if (taskAcceptsEnvelope) {
      const envCell = shell.row(adv, "Field of view", { wide: true });
      envCell.innerHTML = `<select class="sl-ai-envelope" title="A CT's bounding box is mostly air and table, and every voxel of it is tiled over by the networks. Cropping to the body removes work, not accuracy.">
          <option value=""${envelopeMm === null ? " selected" : ""}>the whole series</option>
          <option value="20"${envelopeMm === 20 ? " selected" : ""}>the body + 20 mm (faster)</option>
          <option value="5"${envelopeMm === 5 ? " selected" : ""}>the body + 5 mm (fastest)</option>
        </select>`;
    }
    // THE APPEARANCE, WHERE THE DECISION IS MADE. Ron: "interface wise it is a preset and pops up in
    // vicinity of the segment button populated with the appropriate default." So it sits directly
    // above Segment, already showing what this network starts in, rather than being something to go
    // and find afterwards. The list is logic/presentation.ts, which is also where a user-made preset
    // will appear when there are user-made presets.
    const presetCell = shell.row(adv, "Appearance", { wide: true });
    const chosenPreset = presetInUse();
    presetCell.innerHTML = `<select class="sl-ai-preset">` +
      `<option value="${SURFACES}"${arrival === SURFACES ? " selected" : ""}>The look chosen in Scene (default)</option>` +
      allPresets().map((p) =>
        `<option value="${p.id}"${arrival !== SURFACES && p.id === chosenPreset ? " selected" : ""}>${escapeHtml(p.name)}${
          p.id === presetIdFor(chosenTask) ? " (this network's colorized volume)" : ""
        }</option>`
      ).join("") + `</select>`;
    // The preset's own reason, because a person choosing an appearance should be told what it is for
    // rather than having to try it. Every entry in the table carries one.
    const why = PRESETS[chosenPreset];
    presetCell.querySelector("select")!.title = arrival === SURFACES
      ? "The result arrives in the 3D look chosen for this volume in Scene: Solid unless you chose Surfaces there. Choose a colorized volume here for the see-through look, the scan tinted with this network's colors, instead."
      : (why ? why.why + (why.by ? ` — ${why.by}` : "") : "");

    // Right-justified: a button row starting at the body's left edge sits under the label column.
    const acts = shell.actions(seg);
    // A run is a job: Segment adds it to the queue and comes back at once. While something runs,
    // the button says so -- the next one waits its turn, the person does not.
    // THE BUTTON SAYS WHAT IT DID. Ron, after the fix that painted the queue at once: "there was
    // no visual feedback afaik" -- the queue appeared below, the button itself did not change.
    // While this network runs on this volume the button reads "Running…" and is disabled; while
    // another job runs it offers the queue.
    const mine = jobs.find((j) => j.task === chosenTask && j.inputId === chosenInput && (j.state === "queued" || j.state === "running"));
    const needsFiles = missingWeights.length > 0 && !isBusy();
    // THE MODEL FILES FIRST, in the same row: with them missing, Segment is off and the download is
    // the one thing to press (critic 2026-09-22, 2.6: the run failed after an upload, with a
    // terminal command under the button).
    acts.innerHTML = (needsFiles ? `<button class="sl-ai-fetch"${fetching ? " disabled" : ""} title="Get this network's model files from the project's release. If it fails, the server says why in the status line.">${fetching ? "Downloading…" : "Download the model files"}</button>` : "") +
      `<button class="sl-primary sl-ai-run"${!vols.length || !chosenTask || mine || needsFiles ? " disabled" : ""} title="${needsFiles ? "Download the model files first" : mine ? "This network is running on this volume" : "Run the chosen network on the chosen volume. The result lands in the scene and is offered for saving."}">${
      mine ? (mine.state === "running" ? "Running…" : "Queued…") : isBusy() ? "Add to the queue" : "Segment"}</button>`;
    if (progress) {
      const pr = document.createElement("p");
      pr.className = "sl-hint sl-ai-progress";
      pr.textContent = progress;
      seg.appendChild(pr);
    }
    // THE UNLABELED BODY, ON OR OFF, WITHOUT LEAVING THIS PANEL.
    //
    // A result is presented the way its family expects (logic/presentation.ts), and for the
    // FreeSurfer family that means the surrounding tissue is off. But "off" is a starting point, not
    // a verdict, and the control that governs it lives in another module. Ron: "An on off toggle on
    // the AI segmentation page would make sense, so that a user does not have to navigate to another
    // panel. Just on/off with the visibility icon and if they want more, they can go to the volume
    // rendering module." So: one eye, the same one the Segmentations tree uses, and nothing else.
    // The value it restores to is the preset's own, so turning it back on gives this result's
    // considered level rather than a global constant.
    // ONLY WHILE THE VOLUME IS RENDERED: with surfaces on screen the eye changed a number nobody
    // could see and said "shown" (critic 2026-09-22, 2.7).
    if (presentedVolume && live.nodes.get(presentedVolume) && volumeRenderingOn(live, presentedVolume)) {
      const pres = PRESETS[presentedPreset] ?? presentationFor(presentedTask);
      // THE FALLBACK IS WHAT THE PRESET WOULD HAVE RENDERED, not the level it restores to. Those are
      // different numbers whenever the unlabeled body starts off: `pres.context` is 0.12 either way,
      // so reading it here would have shown the eye open over a field built at 0.
      const nowCtx = colorizeParamOf(
        live, presentedVolume, "contextOpacity", presentationParams(pres).contextOpacity as number,
      );
      const on = nowCtx > 0;
      const row = shell.row(adv, "Unlabeled body", { wide: true });
      row.innerHTML = `<button class="sl-anat-eye sl-ai-ctx${on ? "" : " sl-anat-off"}" type="button"
        title="${on ? "Hide the tissue no network claimed" : "Show the tissue no network claimed"}">${on ? "👁" : "🚫"}</button>
        <span class="sl-hint" title="The tissue around the result. For more, see Volume Rendering.">${on ? "shown" : "hidden"}</span>`;
      row.querySelector(".sl-ai-ctx")?.addEventListener("click", () => {
        setColorizeParams(live, presentedVolume, { contextOpacity: on ? 0 : pres.context });
        render();
      });
    }


    // The server, under Advanced: which one, how many networks, how many ready; ask it again.
    {
      const srv = shell.row(adv, "Server", { wide: true });
      srv.innerHTML = `<span class="sl-hint">${serverNote}</span>`;
    }

    // ---- This network: what it produces, and the paper that defines it ----
    if (chosenTask) {
      // WHAT IS RUNNING, AND WHAT RAN -- without going to look for it. Newest first; a job that is
      // done can be dismissed from the list (its result is in the scene and under Recent results).
      const live_ = jobs.filter((j) => j.state === "queued" || j.state === "running").length;
      // ONLY WHILE SOMETHING RUNS OR WAITS (Ron, 2026-09-22: agreed). A finished run is in the
      // scene and under Recent results; the queue is not a log.
      if (live_) {
        const js = shell.section(root, "Jobs", { open: true, band: "orange", note: `${live_} running or waiting` });
        // IN MOTION, WHERE THE EYE IS: above the folded Advanced, not under it (critic 2026-09-22, 2.6).
        if (adv.parentElement && js.parentElement) root.insertBefore(js.parentElement, adv.parentElement);
        for (const jb of [...jobs].reverse()) {
          const row = document.createElement("div");
          row.className = "sl-row sl-ai-job";
          row.dataset.job = String(jb.id);
          const t = jb.finishedAt && jb.startedAt ? hms(jb.finishedAt - jb.startedAt) : jb.startedAt ? hms(Date.now() - jb.startedAt) : "";
          const glyph = jb.state === "running" ? "⟳" : jb.state === "queued" ? "…" : jb.state === "done" ? "✓" : jb.state === "cancelled" ? "–" : "✘";
          row.innerHTML = `<span class="sl-ai-job-name" title="${jb.progress}"><b>${glyph} ${jb.task}</b> <span class="sl-hint">on ${jb.inputName}${t ? ` · ${t}` : ""}</span><br><span class="sl-hint sl-ai-job-line">${jb.progress}</span></span>` +
            (jb.state === "queued" || jb.state === "running"
              ? `<button class="sl-ai-job-cancel" title="Stop this job. The volume stays; nothing is written.">Cancel</button>`
              : `<button class="sl-ai-job-dismiss" title="Remove this line from the list. The result stays where it is.">×</button>`);
          js.appendChild(row);
        }
      }
      const about = shell.section(root, "This network", { open: false, band: "none", note: chosenTask });
      if (taskDetail) {
        const d = document.createElement("p");
        d.className = "sl-hint";
        d.innerHTML = taskDetail;
        about.appendChild(d);
      }
      // HOW LONG THIS WILL TAKE, before the button rather than after it. See rememberRun: the whole
      // 27-seconds-or-ten-minutes question is whether the server already has this result.
      {
        const prior = chosenInput ? priorRun(chosenTask, chosenInput) : undefined;
        const w = document.createElement("p");
        w.className = "sl-hint";
        // WHAT IT WILL DO, not what would make it look fast. Ron: "Cached result is not useful for a
        // honest demo." So this says which of the two is about to happen and stops there -- the way
        // to make a real run faster is the Field of view control above, not a warmed cache.
        w.innerHTML = prior
          ? `<b>Already computed on this volume</b>${prior.computedMs ? ` (${hms(prior.computedMs)} when it ran)` : ""}. The server keeps ` +
            `results, so this will come back from its cache without running the networks again — fine for ` +
            `getting on with the work, not a demonstration of how long it takes.`
          : taskNetworks > 1
          ? `<b>Not computed on this volume yet.</b> ${taskNetworks} networks run in sequence; on this ` +
            `machine that has been <b>1&ndash;10 minutes</b>, mostly according to how much of the body is in ` +
            `the series. Narrowing the field of view above is the way to shorten it.`
          : `<b>Not computed on this volume yet</b>, so the network will run.`;
        about.appendChild(w);
      }
      if (restoreNote) {
        const rn = document.createElement("p");
        rn.className = "sl-hint";
        rn.innerHTML = `${restoreMode === "graded" ? "" : `restore mode <b>${restoreMode}</b> — `}${restoreNote}`;
        about.appendChild(rn);
      }
      // THE SERVER'S ATTRIBUTION FIRST (logic/attribution.ts): title, group, licenses and the papers
      // to cite, read by haversack from the project's own files. The by-hand tables answer only when
      // the server has not.
      const att = taskAttribution;
      if (att && (att.title || att.cite.length)) {
        const who = document.createElement("p");
        who.className = "sl-hint";
        who.innerHTML = `<b>${att.title ?? ecosystemOf(chosenTask)}</b>${att.group ? ` — ${att.group}` : ""}` +
          (att.description ? `<br>${att.description}` : "") +
          (licenseLine(att) ? `<br>License: ${licenseLine(att)}${att.license?.note ? ` — ${att.license.note}` : ""}` : "") +
          (att.engine?.title ? `<br>Engine: ${att.engine.title}${att.engine.license?.code ? ` (${att.engine.license.code})` : ""}` : "");
        about.appendChild(who);
        const eco = att.cite.filter((c) => c.for !== "engine"), eng = att.cite.filter((c) => c.for === "engine");
        if (eco.length) {
          const cite = document.createElement("p");
          cite.className = "sl-hint";
          cite.innerHTML = `Cite:<br>${eco.map((c) => formatCite(c)).join("<br>")}`;
          about.appendChild(cite);
        }
        if (eng.length) {
          const also = document.createElement("p");
          also.className = "sl-hint";
          also.innerHTML = `And for the engine:<br>${eng.map((c) => formatCite(c)).join("<br>")}`;
          about.appendChild(also);
        }
        const first = primaryCite(att);
        const pa = shell.actions(about);
        pa.innerHTML = (first?.doi ? `<button class="sl-ai-paper" data-url="https://doi.org/${first.doi}" title="The paper that describes this network, in your browser">Open the paper</button>` : "") +
          (att.repository ? `<button class="sl-ai-repo" data-url="${att.repository}" title="The project's page, in your browser">Project page</button>` : "") +
          (att.license?.url ? `<button class="sl-ai-license" data-url="${att.license.url}" title="The license the model files come under, in your browser">License terms</button>` : "");
        about.prepend(pa);   // at the top of the section (Ron, 2026-09-22: "Move to the top of this section")
      } else {
        const cite = document.createElement("p");
        cite.className = "sl-hint";
        cite.textContent = paper
          ? formatCitation(paper)
          : `No paper on file for ${ecosystemOf(chosenTask)}. Its label set is described by whoever trained it.`;
        about.appendChild(cite);
        if (paper) {
          const pa = shell.actions(about);
          pa.innerHTML = `<button class="sl-ai-paper" data-url="${paper.url}" title="The paper that describes this network, in your browser">Open the paper</button>` +
            (paper.repo ? `<button class="sl-ai-repo" data-url="${paper.repo}" title="The project's page, in your browser">Project page</button>` : "");
          about.prepend(pa);
          if ((paper.alsoCite ?? []).length) {
            const also = document.createElement("p");
            also.className = "sl-hint";
            also.innerHTML = `This project also asks that you cite, according to what you ran:<br>${
              (paper.alsoCite ?? []).map((a) => formatCitation(a)).join("<br>")
            }`;
            about.appendChild(also);
          }
        }
      }
    }

    // RESULTS ON DISK. Shown only when there are some, so it costs nothing on a clean start, and
    // shown HERE because this is the panel a lost run was lost from -- it is the first place someone
    // will look for it. Each row says how old it is and how long the run that made it took, which is
    // what a person is actually deciding between: restore this, or spend that again.
    // A BUTTON, NOT A SECTION, until asked. Ron, 2026-09-22: "A button for the cache so it doesn't
    // take up screen real estate by default. It's important to have but not as default. It gets
    // accessed by the algorithm when available. Nothing the user needs to decide normally." The
    // button sits under Advanced; pressed, the list unfolds below it in this render.
    {
      // One row of buttons at the bottom of Advanced (critic 2026-09-22, 2.6).
      const ra = shell.actions(adv);
      ra.innerHTML = (checkpoints.length ? `<button class="sl-ai-recent" title="The temporary copies of finished runs, kept for a day: bring one back, or delete it">${showRecent ? "Hide recent results" : `Recent results (${checkpoints.length})`}</button>` : "") +
        `<button class="sl-ai-refresh" title="Ask the segmentation server again: is it running, which networks it has, which are ready to run here. Use it after starting the server or downloading model files.">Refresh</button>`;
      ra.querySelector(".sl-ai-recent")?.addEventListener("click", () => { showRecent = !showRecent; render(); });
    }
    if (checkpoints.length && showRecent) {
      const cps = shell.section(root, "Recent results", {
        open: true,
        band: "green",   // what exists on disk, not something in motion
        note: `${checkpoints.length}`,
      });
      const intro = document.createElement("p");
      intro.className = "sl-hint";
      // The retention rule is stated ONCE, quietly, where the files are — not as a warning, not as a
      // dialog. Ron asked for it "in a nonobtrusive way", and the thing a person needs to know is
      // simply that this is a safety net with an expiry, not storage.
      // PLAIN WORDS. This said "written the moment each run finished ... on disk", which is how the
      // feature works rather than what it is. Ron: "What is a checkpoint file? Most people would not
      // know." Autosave is the idea everyone already has -- the application saved it for you, it is
      // temporary, and it is there so a crash does not cost you the run.
      intro.textContent = "A temporary copy of each finished run, so nothing is lost if the " +
        "application closes. Bring one back with Restore. These are deleted after a day — to keep a " +
        "result, use Save.";
      cps.appendChild(intro);
      for (const c of checkpoints) {
        const row = document.createElement("div");
        row.className = "sl-row sl-ai-cp";
        row.dataset.file = c.file;
        row.innerHTML = `<span class="sl-ai-cp-name" title="${c.file}">${c.task} <span class="sl-hint">on ${c.volume}</span></span>` +
          `<span class="sl-hint">${timeAgo(c.at)} · ${humanBytes(c.bytes)}${c.ms ? ` · took ${hms(c.ms)}` : ""}</span>` +
          `<button class="sl-ai-cp-restore" title="Put this result back in the scene, on the volume it was made on">Restore</button>` +
          `<button class="sl-ai-cp-discard sl-danger" title="Delete this temporary copy. If you saved the result, that copy is unaffected.">Delete copy</button>`;
        cps.appendChild(row);
      }
    }

    const q = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T | null;
    root.querySelectorAll<HTMLElement>(".sl-ai-cp").forEach((row) => {
      const cp = checkpoints.find((c) => c.file === row.dataset.file);
      if (!cp) return;
      row.querySelector<HTMLButtonElement>(".sl-ai-cp-restore")?.addEventListener("click", () => {
        // On the volume it was made on when that is loaded, else the one chosen above.
        const input = cp.sourceId && live.nodes.get(cp.sourceId) ? cp.sourceId : chosenInput;
        if (!input) { progress = "load the volume this result belongs to first"; render(); return; }
        enqueue(cp.task, input, cp);
      });
      row.querySelector<HTMLButtonElement>(".sl-ai-cp-discard")?.addEventListener("click", async (e) => {
        void runAction(e.currentTarget as HTMLButtonElement, async () => {
          await discardCheckpoint(cp);
          await refreshCheckpoints();
        });
      });
    });
    q<HTMLSelectElement>(".sl-ai-input")?.addEventListener("change", (e) => chosenInput = (e.target as HTMLSelectElement).value);
    // The Network picker (open/filter/select) is wired inside shell.searchablePicker itself, via
    // the onOpenChange/onFilterChange/onSelect callbacks passed to it above.
    q<HTMLButtonElement>(".sl-ai-refresh")?.addEventListener("click", () => refreshServer());
    q<HTMLSelectElement>(".sl-ai-envelope")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      envelopeMm = v ? Number(v) : null;
    });
    q<HTMLSelectElement>(".sl-ai-interp")?.addEventListener("change", (e) => {
      interp = (e.target as HTMLSelectElement).value === "nearest" ? "nearest" : "linear";
    });
    q<HTMLSelectElement>(".sl-ai-preset")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      arrival = v === SURFACES ? SURFACES : "colorized";
      if (v !== SURFACES) presetChoice = v;
      // Applied at once when there is already a result on screen, so choosing an appearance shows
      // one rather than promising one for next time: the volume's rendering goes on or off with it.
      if (presentedVolume && live.nodes.get(presentedVolume)) {
        const p = PRESETS[presetChoice];
        if (p && v !== SURFACES) setColorizeParams(live, presentedVolume, presentationParams(p));
        if (v === SURFACES) arriveInSceneLook(presentedVolume);
        else seeThroughColored(presentedVolume);
      }
      render();
    });
    {
      const b = q<HTMLButtonElement>(".sl-ai-fetch");
      b?.addEventListener("click", () => void runAction(b, () => fetchWeights(), { busyLabel: "Fetching…" }));
    }
    root.querySelectorAll<HTMLElement>(".sl-ai-job").forEach((row) => {
      const jb = jobs.find((j) => String(j.id) === row.dataset.job); if (!jb) return;
      row.querySelector<HTMLButtonElement>(".sl-ai-job-cancel")?.addEventListener("click", () => { jb.cancel = true; jb.progress = "canceling…"; render(); });
      row.querySelector<HTMLButtonElement>(".sl-ai-job-dismiss")?.addEventListener("click", () => { const k = jobs.indexOf(jb); if (k >= 0) jobs.splice(k, 1); render(); });
    });
    {
      const b = q<HTMLButtonElement>(".sl-ai-run");
      b?.addEventListener("click", () => void acceptLicense().then((ok) => { if (ok) enqueue(chosenTask, chosenInput); }));
    }
    // The paper opens in the DEFAULT BROWSER, through the native side: the webview silently refuses
    // window.open, because its UI delegate implements no new-window method.
    for (const sel of [".sl-ai-paper", ".sl-ai-repo", ".sl-ai-license"]) {
      const b = q<HTMLButtonElement>(sel);
      b?.addEventListener("click", () => { const u = b.dataset.url; if (u) openExternal(u); });
    }
  }

  /**
   * What the selected network produces, before anything is uploaded.
   *
   * /v1/tasks/<task> answers this without the weights being present -- it returned all 24 structures
   * of a task whose checkpoint was missing -- which the catalog listing cannot: /v1/tasks is bare
   * names. Ron: "I am also trying to test different features and to provide feedback on the user
   * experience." Choosing a network to see what it does should not require running it to find out.
   */
/**
 * WHAT THIS TASK COST LAST TIME, so a demo is not a coin toss.
 *
 * Ron: "total sometimes takes 27sec and sometime takes 10m. How do I know ahead of time which it is?
 * It's important for demos." His own job history answers it -- seven of eleven ts:total runs came
 * back `cached: true` in 0.0 s, and the four that actually ran took 79, 216, 271 and 601 seconds.
 * haversack keeps results, so the FIRST run on a series is minutes and every later one is instant.
 *
 * The server will not say so before the upload, and the app has no business guessing at inference
 * time from voxel counts. But it knows what IT has run: (task, volume) is the key haversack caches
 * on, near enough, so a pair this machine has already completed will hit the cache again. That is a
 * statement about the past, phrased as one -- "ran in 3m 21s, cached since" -- rather than a
 * prediction dressed up as a fact.
 *
 * localStorage rather than the settings file: it is per-machine, it is advisory, and losing it costs
 * one slow run rather than anything real.
 */
const RUNS_KEY = "sl.aiRuns";
type RunNote = { cached: boolean; ms: number; at: number; computedMs?: number };
function loadRuns(): Record<string, RunNote> {
  try { return JSON.parse(localStorage.getItem(RUNS_KEY) ?? "{}") as Record<string, RunNote>; } catch { return {}; }
}
// KEYED WITHOUT THE VERSION: `ts:total` and `ts.v2:total` are one history, so the day the server
// renamed every task did not also erase what each one had cost on this machine.
const runKey = (task: string, inputId: string) => `${unversioned(task)}\u0000${inputId}`;
function rememberRun(task: string, inputId: string, cached: boolean, ms: number): void {
  if (!task || !inputId) return;
  try {
    const all = loadRuns();
    const prev = all[runKey(task, inputId)];
    // The FIRST real duration is the one worth keeping. Overwriting it with a cache hit's 2 seconds
    // would erase the only number that says what this costs when it has to be computed.
    // `computedMs` is only ever written by a run that ACTUALLY RAN. A cache hit's wall clock is
    // about a second and says nothing about what the networks cost, and quoting it back as "1s the
    // first time" -- which the panel did -- is worse than saying nothing.
    all[runKey(task, inputId)] = {
      cached,
      ms,
      computedMs: cached ? prev?.computedMs : ms,
      at: Date.now(),
    };
    localStorage.setItem(RUNS_KEY, JSON.stringify(all));
  } catch { /* private mode, or full: the panel is no worse off than before */ }
}
function priorRun(task: string, inputId: string): RunNote | undefined {
  return loadRuns()[runKey(task, inputId)];
}
/** The longest a task actually took on this machine, over every volume it has run on; undefined if never. */
function lastComputedMs(task: string): number | undefined {
  let best: number | undefined;
  for (const [k, v] of Object.entries(loadRuns())) {
    if (!k.startsWith(`${unversioned(task)}\u0000`) || v.computedMs == null) continue;
    if (best == null || v.computedMs > best) best = v.computedMs;
  }
  return best;
}

  async function describeTask() {
    if (!chosenTask) return;
    try {
      const d = await fetch(`/_haversack/tasks/${encodeURIComponent(chosenTask)}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null);
      if (!d) return;
      const missing = missingWeightIds(d.weights_installed as WeightEntry[] | undefined);
      missingWeights = missing;
      // HOW LONG THIS WILL TAKE, before it is started rather than after.
      //
      // Ron: "total sometimes takes 27sec and sometime takes 10m. How do I know ahead of time which
      // it is? It's important for demos." It is knowable, and the server says so plainly: a task's
      // `weights` list is the networks it runs, and `shape: "label_union"` means it runs ALL of them
      // and unions the labels. ts:total is five 1.5 mm nnU-Net models (291-295); ts:total_fast is one
      // 3 mm model (297). Same 117 structures, same name to four characters, five times the work --
      // and nothing on screen distinguished them but the word "fast".
      //
      // The other half is the volume, which is why the estimate lives with the input further down
      // rather than here: a chest CT and a whole-body CT through the same five models are not the
      // same wait.
      const nets = ((d.weights ?? []) as string[]).length;
      taskNetworks = nets;
      taskAcceptsEnvelope = !!(d.parameters?.processing?.properties?.envelope_mm);
      // No "?" on the face: when the server gives no count, the count is left out; the catalog's
      // installed flag (what the browser shows) decides "here", so the two panels agree (critic
      // 2026-09-22, 2.14).
      const cat = catalog.find((t) => t.name === chosenTask);
      const here = cat?.installed !== undefined ? cat.installed : !missing.length;
      const bits = [
        typeof d.n_structures === "number" ? `${d.n_structures} structures` : "",
        d.modality ? String(d.modality) : "",
        nets > 1
          ? `<b>runs ${nets} networks</b> in sequence`
          : nets === 1
          ? "runs 1 network"
          : "",
        here ? "the model files are here" : "the model files are not on this machine yet",
      ].filter(Boolean);
      // haversack's own account of how boundaries are produced for THIS task, which is what the
      // Boundaries control actually selects between. Its words rather than mine: they are per-task
      // and authoritative, and a task whose restore mode is not "graded" may not offer a smooth
      // boundary at all -- something I would otherwise be asserting on its behalf.
      restoreMode = String(d.behavior?.restore?.mode ?? "");
      restoreNote = String(d.behavior?.restore?.note ?? "");
      taskAttribution = attributionOf(d);
      const names = (d.structures ?? []) as string[];
      taskDetail = bits.join(" · ") +
        (names.length ? `<br><span style="opacity:.75">${names.slice(0, 8).join(", ")}${names.length > 8 ? `, … (${names.length})` : ""}</span>` : "");
      render();
    } catch { /* the panel is still usable without this */ }
  }

  /**
   * Ask the server to provision this task's weights.
   *
   * `POST /v1/tasks/<task>/prepare` returns 202 and does the work behind it, so this then waits for
   * `weights_installed` to turn true rather than for the request. Ron: "There should be guidance how
   * to make them work" -- and a button that does it beats a command to paste, for the two thirds of
   * cases where it is simply a download.
   *
   * Where it cannot, the SERVER'S OWN MESSAGE is shown verbatim. Our UI does not carry a second copy
   * of haversack's policy about which weights are licensed or unpublished: that would be a copy to
   * keep in step, and haversack's own text is better than ours would be -- it names the dataset and
   * the command.
   */
  async function fetchWeights() {
    if (fetching || !chosenTask) return;
    fetching = true;
    const started = Date.now();
    const mins = () => `${Math.round((Date.now() - started) / 1000)}s`;
    progress = `asking the server for ${chosenTask}'s weights…`;
    render();
    try {
      const res = await fetch(`/_haversack/tasks/${encodeURIComponent(chosenTask)}/prepare`, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        progress = `the weights could not be provisioned: ${body.slice(0, 400)}`;
        return;
      }
      // 202 carries a JOB ID, and the failure happens inside that job -- an unobtainable task
      // returns 202 like any other and fails a millisecond later with the reason. Waiting on
      // `weights_installed` instead would have spun for ten minutes and then said something
      // generic, when the server had the real answer immediately.
      const prep = await res.json().catch(() => ({})) as { id?: string };
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = await fetch(`/_haversack/jobs/${encodeURIComponent(prep.id ?? "")}`, { cache: "no-store" })
          .then((r) => r.ok ? r.json() : null).catch(() => null);
        const state = String(j?.state ?? "");
        if (state === "failed") {
          // haversack's own words, which name the dataset and the command. Better than ours.
          const why = j?.error ?? j?.progress?.message ?? j?.progress?.detail ?? "no reason given";
          progress = `the weights could not be provisioned: ${String(why).slice(0, 400)}`;
          return;
        }
        // The job's own progress -- fraction/stage/detail -- names which checkpoint is moving and
        // how far, the same shape run()'s poll loop reads for a segmentation job. Previously only
        // read on the failure path above, so a download in progress showed nothing but the clock.
        const jp = j?.progress as { stage?: string; detail?: string; fraction?: number } | undefined;
        // A PERCENTAGE IS ONLY WORTH SHOWING WHEN IT MOVES. haversack sends fraction 0 for the whole
        // of a weights fetch -- it has no byte counter to report -- so rendering it produced a "0%"
        // that sat there for ten minutes and read as a hang. Ron: "It should say downloading xxx.
        // Instead this poor update information." Show the number once it is actually above zero;
        // until then the clock is the honest signal, and it does move.
        const pct = typeof jp?.fraction === "number" && jp.fraction > 0 ? ` ${Math.round(jp.fraction * 100)}%` : "";
        // The task's own name already says "fastsurfer"; so did the checkpoint id and the stage, so
        // the line read "downloading fastsurfer 0% · weights — fastsurfer:brain". Name the thing once.
        const what = jp?.detail && jp.detail !== chosenTask ? jp.detail : chosenTask;

        const d = await fetch(`/_haversack/tasks/${encodeURIComponent(chosenTask)}`, { cache: "no-store" })
          .then((r) => r.ok ? r.json() : null).catch(() => null);
        const still = missingWeightIds(d?.weights_installed as WeightEntry[] | undefined);
        progress = still.length
          ? `downloading the model files for ${what}${pct} · ${mins()}`
          : `the model files for ${chosenTask} are ready · ${mins()}`;
        render();
        if (!still.length) { missingWeights = []; await refreshServer(); return; }
        if (Date.now() - started > STALL_MS) {
          progress = `the model files for ${chosenTask} are still not here after ${mins()}. ` +
            `Check the server's log, or run:  haversack weights fetch ${chosenTask}`;
          return;
        }
      }
    } catch (e) {
      progress = `the weights could not be provisioned: ${(e as Error).message}`;
    } finally {
      fetching = false;
      render();
    }
  }

  async function openExternal(url: string) {
    try {
      const res = await fetch(`/_open?url=${encodeURIComponent(url)}`);
      if (!res.ok) status(`could not open ${url}: ${(await res.json()).error ?? res.status}`);
    } catch (e) {
      status(`could not open ${url}: ${(e as Error).message}`);
    }
  }

  /**
   * Run the segmenter, or -- given a checkpoint -- put a finished result back into the scene.
   *
   * ONE PATH, not two. A restore re-enters this function with the bytes already in hand and skips
   * only the network half; everything after (the narrowing, the anatomy lookup, the colors, the
   * scene insertion) is the code that produced the result in the first place. A separate restore
   * routine would be a second implementation of naming and coloring, free to drift from this one,
   * and its drift would only ever show up on the day someone was recovering lost work.
   */
  async function run(jobRec: Job) {
    const restore = jobRec.restore;
    const target = live.nodes.get(jobRec.inputId);
    if (!target) { jobRec.state = "failed"; jobRec.progress = "the volume is no longer loaded"; render(); return; }
    jobRec.state = "running";
    jobRec.startedAt = Date.now();
    // THE WHOLE WALL CLOCK, from this click to the labels being in the scene -- not just the job.
    // The existing timer starts when the server accepts the job, so it leaves out writing and
    // uploading the volume (a minute on a full-body CT) and fetching and decoding the result. Ron
    // asked for the number he actually experiences: "the time it takes from when I push the go
    // button to the time when it is done". It lands in `progress`, the panel's own line, which
    // holds until the next run -- the shared status bar is overwritten by whatever happens next.
    const runStarted = Date.now();
    jobRec.progress = progress = "writing the volume…";
    render();
    // INSTANT ACKNOWLEDGMENT. The click, the queue entry and this line were all rendered before
    // the volume was written for upload -- but rendered is not painted: the write (gzipping a
    // whole-body CT) ran in the same turn and held the screen, so for ten seconds the button
    // looked ignored. One frame first. Ron: "There must be an instant response acknowledging a
    // user action. This is again a generalized requirement."
    await paintFirst();
    try {
      let bytes: Uint8Array | null;
      // The run's provenance, from the finished job: kept on the segmentation node and written into
      // the DICOM SEG by the save. A restore has none (the checkpoint predates this).
      let runProv: Record<string, unknown> | undefined;
      if (restore) {
        jobRec.progress = progress = `restoring ${restore.task} from ${timeAgo(restore.at)}…`;
        render();
        bytes = await readCheckpoint(restore);
      } else {
      // NRRD rather than the original DICOM: one file, and the grid the labels come back on is the
      // grid we sent, so nothing has to be re-registered afterwards.
      const nrrd = await exportVolume(live, jobRec.inputId, "nrrd-gz");
      jobRec.progress = progress = `uploading ${(nrrd.bytes.byteLength / 1e6).toFixed(0)} MB…`;
      render();

      // Ask the server about THIS task before uploading to it. Ron picked ts:total_highres_test and
      // the job failed after the upload with "ModelNotFound: no manifest entry for Dataset957" --
      // a true answer, arriving after the work. /v1/tasks/<task> knows before we send anything, and
      // the catalog listing does not: /v1/tasks returns bare names with no installed flag.
      const detail = await fetch(`/_haversack/tasks/${encodeURIComponent(jobRec.task)}`, { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null);
      // `weights_installed` is a LIST because a task can need several checkpoints, and `total` runs
      // five. Any one missing means the job dies, so all must be there. What "missing" means is
      // haversack-version-dependent -- see missingWeightIds.
      const missing = missingWeightIds(detail?.weights_installed as WeightEntry[] | undefined);
      if (missing.length) {
        jobRec.progress = progress = `${jobRec.task} needs model files that are not on this machine yet. ` +
          `Download them first:  haversack weights fetch ${jobRec.task}`;
        return;
      }

      const sub = await submitVolume(transport, {
        task: jobRec.task,
        bytes: nrrd.bytes,
        filename: nrrd.filename,
        // The user's choice, because it is genuinely one and I had hard-coded the wrong default for
        // what Ron was doing. `nearest` is TotalSegmentator's own label semantics, which is what a
        // volume measurement expects. `linear` derives sub-voxel boundaries from the logits, and on
        // a coarse model over a fine grid -- total_fast is 3 mm, the cropped series is 0.5 mm -- the
        // difference is not cosmetic: nearest gives visible 3 mm steps. Ron: "Looks ok. But very
        // rough." Some of that was the model and some of it was this.
        // ONLY WHAT THIS TASK DECLARES. `interp` is TotalSegmentator's; FastSurfer publishes
        // NoParams and rejects the whole submit for carrying it. `detail` above is the task's own
        // record, already fetched to check its model files, so this costs no extra request.
        options: keepAcceptedOptions({ interp, ...(envelopeMm === null ? {} : { envelope_mm: envelopeMm }) }, acceptedParameters(detail)),
      });
      if (!sub.ok) {
        jobRec.progress = progress = sub.message + (sub.start ? ` — start it with: ${sub.start}` : "");
        return;
      }
      jobRec.serverJobId = sub.jobId;
      rememberJobs();

      // A POLL LOOP NEEDS A CLOCK AND A DOOR. Ron: "the page is sitting there nothing is
      // happening." It was: a job that stays queued, or reports a state this does not recognize,
      // produced an unchanging line, a disabled button and no way out. Three things missing --
      // elapsed time, so waiting looks like waiting rather than like nothing; a cancel, which also
      // tells the server (DELETE /v1/jobs/<id>) so a queue slot is not held by an abandoned job;
      // and a ceiling, because a job that has said nothing for this long is not going to.
      const started = Date.now();
      const elapsed = () => hms(Date.now() - started);
      let lastChange = Date.now();
      let last = "";
      for (;;) {
        if (jobRec.cancel) {
          jobRec.progress = progress = `canceled after ${elapsed()}`;
          await fetch(`/_haversack/jobs/${encodeURIComponent(sub.jobId)}`, { method: "DELETE" }).catch(() => {});
          return;
        }
        const j = await job(transport, sub.jobId);
        // haversack nests all of this under the job's `progress` -- fraction, stage, detail, and
        // (for a multi-checkpoint task like ts:total, which ensembles 5) which one is running now.
        // The client used to read `progress`/`stage` flat, which the server never sends, so this
        // line always read just the bare state -- true waiting looked identical to a stuck job.
        const pct = j.progress !== undefined ? ` ${Math.round(j.progress * 100)}%` : "";
        const part = j.nParts && j.nParts > 1 ? ` (${(j.part ?? 0) + 1}/${j.nParts})` : "";
        const stage = j.stage ? ` · ${j.stage}${j.detail ? ` — ${j.detail}` : ""}` : "";
        const line = `${j.state}${pct}${part}${stage}`;
        if (line !== last) { last = line; lastChange = Date.now(); }
        // Re-rendered every tick even when nothing changed, so the clock moves: an unchanging
        // number is what made a working wait indistinguishable from a dead one.
        jobRec.progress = progress = `${line} · ${elapsed()}`;
        render();
        if (isFinished(j.state)) {
          if (j.state !== "succeeded") { progress = `job ${j.state}${j.error ? ": " + j.error : ""}`; return; }
          // SAY WHEN NO WORK WAS DONE. A cache hit and a ten-minute inference reach this line
          // identically, and that is the whole of Ron's "sometimes 27sec and sometimes 10m": the
          // server keeps results, so the second run on a series is instant and the first is not.
          // Remembered as well as said, so the NEXT run can be predicted rather than discovered.
          if (j.cached) progress = `${jobRec.task} — already computed for this volume, returned from the server's cache`;
          rememberRun(jobRec.task, jobRec.inputId, j.cached === true, Date.now() - runStarted);
          if (j.provenance) {
            const pv = j.provenance as { models?: { version?: string; folder?: string; folds?: string[]; sha256?: string | null }[]; lineage?: string; device?: string; dtype?: string; haversack?: string };
            runProv = {
              server: "haversack", haversack: pv.haversack, task: jobRec.task, engine: pv.lineage,
              device: pv.device, dtype: pv.dtype, cached: j.cached === true,
              models: (pv.models ?? []).map((m) => ({ folder: m.folder, version: m.version, folds: m.folds, sha256: m.sha256 ?? undefined })),
              input: j.inputIdentity, timings: j.timings, job: sub.jobId, at: new Date().toISOString(),
              options: j.provenance,                    // the whole block, as the server wrote it
            };
          }
          break;
        }
        if (Date.now() - lastChange > STALL_MS) {
          jobRec.progress = progress = `no change for ${Math.round(STALL_MS / 60000)} minutes (last: ${line}). ` +
            `Giving up on this side; the job may still be on the server as ${sub.jobId}.`;
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      jobRec.progress = progress = "fetching the labels…";
      render();
      bytes = await result(transport, sub.jobId);
      }
      if (!bytes) { progress = "the job succeeded but its result could not be fetched"; return; }

      // ON DISK BEFORE IT IS PARSED. The renderer is a separate process the operating system can end
      // at any moment, and until this line the only copy of a finished run was inside it -- which is
      // how Ron lost a completed ts:total: "I was about to go to save, when all the data
      // disappeared." Checkpointed here rather than after the scene insertion so that a parsing
      // failure, too, leaves the result recoverable. It never throws; a failed checkpoint must not
      // take down the run it was protecting.
      // A restore is already on disk -- that is where it came from -- so it is not written again.
      const taskName = restore?.task ?? jobRec.task;
      const checkpointed = restore
        ? restore.file
        : await saveCheckpoint(bytes, {
          task: jobRec.task,
          volume: (target.name as string) ?? "volume",
          at: new Date().toISOString(),
          ms: Date.now() - runStarted,
          sourceId: jobRec.inputId,
        });

      // A .seg.nrrd carries its own segment table -- name, label value, color, layer -- which is
      // where the anatomical names arrive: TotalSegmentator's own keys, the same ones
      // logic/anatomy/totalsegmentator.json is keyed by, so the grouping recognizes them without a
      // translation step.
      const seg = await parseNrrdSeg(bytes);
      // Layer 0 only for now. A multi-layer .seg.nrrd holds overlapping segments, which the scene's
      // single labelmap cannot represent; taking the first is honest and the count below says how
      // many were left behind rather than hiding them.
      const layer0 = seg.layers[0];
      if (!layer0) { progress = "the result carried no labelmap"; return; }
      // The scene's labelmap is 8-bit; a .seg.nrrd layer may be 16- or 32-bit. This used to require
      // every VALUE to be under 256, which refused far more than it had to: FastSurfer numbers its
      // output the way FreeSurfer does, with the cortical parcellations at 1000-1035 and 2000-2035,
      // so a result with well under a hundred structures was turned away. Ron: "this result uses
      // label values up to 2035; the scene's labelmap holds 255". The values are sparse; the count
      // is not large. packLabelsToByte renumbers them densely instead of truncating -- see there for
      // why a label value is an identity rather than an index.
      const packed = packLabelsToByte(layer0);
      if (!packed.ok) {
        jobRec.progress = progress = packed.reason === "too-many"
          ? `this result puts ${packed.distinct} distinct structures in one layer, and the scene's ` +
            `labelmap holds 255`
          : `this result has negative label values (down to ${packed.min}); those are not labels, ` +
            `so nothing was loaded rather than guessing at what they meant`;
        return;
      }
      const labels = packed.labels;
      // The names and colors the FILE carries are not the best available.
      //
      // dcmjs/dcmqi writes each segment with `ColorAutoGenerated:=1` -- an arbitrary hue, which is
      // why a fresh import looks like a bag of highlighter pens rather than anatomy. But the label
      // names ARE TotalSegmentator's own keys, and logic/anatomy/totalsegmentator.json is keyed by
      // exactly those, carrying the recommended RGB the segmenter publishes for each structure
      // (liver 221,130,101; spleen 157,108,162) and the readable name.
      //
      // So a recognized structure gets the segmenter's color and its readable name, including Ron's
      // corrections -- autochthon arrives labeled "Erector spinae muscle". An unrecognized one
      // keeps whatever the file said, because a color we cannot justify is worse than an arbitrary
      // one we can at least attribute.
      // COLORS ARE 0..1 HERE, not 0..255. segPalette() writes them straight into a Float32Array the
      // GPU samples, and SEG_PALETTE -- the built-in default -- is [0.502, 0.6824, 0.502]. I had
      // this wrong in both directions at once: the anatomy table publishes 0..255 (liver is
      // 221,130,101) and went in undivided, while the NRRD's own colors are already 0..1 and were
      // being multiplied by 255. Every channel saturated, which is why the result was wrong in the
      // 3D view and in the slice overlay alike -- both read the same palette.
      let recognised = 0;
      // The labelmap was renumbered, so its table follows it. The value the FILE used is kept as
      // `sourceLabelValue`: FreeSurfer's 17 for the left hippocampus identifies the structure as
      // surely as a SNOMED code does, and it is only its use as a voxel address that had to go.
      // A segment whose value never occurs has no new number; it is empty, and is dropped here
      // rather than arriving as a structure made of nothing.
      const layer0Segments = seg.segments
        .filter((sg) => sg.layer === 0)
        .map((sg) => ({ ...sg, labelValue: packed.remap.get(sg.labelValue) ?? 0, sourceLabelValue: sg.labelValue }))
        .filter((sg) => sg.labelValue !== 0);
      // NAME AND COLOR FROM THE LABEL VALUE, for a family that numbers its labels meaningfully.
      //
      // FastSurfer names its output from its own ColorLUT.tsv, and that file is a subset: 17 of the
      // 95 segments in Ron's first result arrived as `label_2003` ... `label_2035`, all
      // right-hemisphere cortex, because they are simply absent from it. A name lookup cannot rescue
      // a segment with no name. The VALUE identifies it exactly -- FreeSurfer's 2035 is
      // ctx-rh-insula wherever it is written -- and it survived the renumbering as
      // `sourceLabelValue`. Ron: "Use the colors and organization as presented by the freesurfer
      // people. I assume that fastsurfer has just used that, but don't assume." It had not: its
      // table is incomplete and gives Left-VentralDC the right side's color.
      const byValue = usesFreesurferNumbering(taskName);
      const looked = layer0Segments.map((sg) => ({
        sg,
        known: (byValue ? freesurferStructureFor(sg.sourceLabelValue) : null) ?? lookupStructure(sg.name),
      }));
      // A system color tells systems apart -- useful across a mixed result like ts:total, where
      // bone, muscle and vessel each read as one hue. Ron, after running ts:liver_segments (eight
      // Couinaud segments, all "Alimentary system", none with a published RGB): "They are all the
      // same color." Correct, and the fix is not a bigger palette -- when EVERY uncolored segment
      // in this result shares one system, there is no diversity for the system color to expose, so
      // it just erases the one distinction the segmentation exists to draw. Falling back further, to
      // the file's own per-segment hue, keeps that distinction. A result that mixes systems keeps
      // the grouping as before.
      const noRgbSystems = new Set(
        looked.filter(({ known }) => known && !known.rgb).map(({ known }) => known!.system),
      );
      const singleSystem = noRgbSystems.size <= 1;
      // WHEN THE PUBLISHED COLORS CANNOT BE TOLD APART, the file's own are used instead. Ron, on
      // ts:abdominal_muscles: "I have no way to visually assess the muscles as abdominal muscle all
      // have the same color." TotalSegmentator's table colors by TISSUE, so its eleven abdominal
      // muscles land within a narrow brown -- while the file the segmenter wrote carries 22 well
      // spread ones we were discarding. See logic/segment-colours.ts: a published color is kept
      // wherever it distinguishes, because those colors are the convention (FreeSurfer's above all).
      const { resolved, moved } = coloursFor(looked.map(({ sg, known }) => ({
        known: known as LookedUp | undefined, name: sg.name,
        fallback: [
          Math.round(sg.color[0] * 255), Math.round(sg.color[1] * 255), Math.round(sg.color[2] * 255),
        ] as [number, number, number],
      })));
      const segments = looked.map(({ sg, known }, i) => {
          if (known) recognised++;
          const rgb = known?.rgb;
          return {
            labelValue: sg.labelValue,
            // WHICH structure, not just what to call it. Three display names live in both
            // catalogs, so a segment stored with only its name resolves to the wrong one later and
            // lands in the wrong branch — the third and fourth ventricles and the brainstem of a
            // FastSurfer result appeared at the top of the nervous system instead of inside the
            // brain. We know the key exactly here, from the FreeSurfer label value.
            ...(known?.key ? { structure: known.key } : {}),
            sourceLabelValue: sg.sourceLabelValue,
            name: known?.name ?? sg.name ?? `Segment ${sg.sourceLabelValue}`,
            color: (rgb
              ? [resolved[i][0] / 255, resolved[i][1] / 255, resolved[i][2] / 255]
              : known && !singleSystem
              ? systemColour(known.system).map((c) => c / 255)
              : [sg.color[0], sg.color[1], sg.color[2]]) as [number, number, number],
          };
        });
      const made = await createSegmentationFromLabelmap(live, store, jobRec.inputId, labels, segments, {
        // NAMED AFTER THE VOLUME, SHORTLY. `target.name` is the volume's full label -- patient,
        // series and date -- and putting all of it inside this name is what gave Ron
        // "ts:total of R_180 · CT series 2 · 1996-03-22", stored under that description and wrapped
        // again on the way back in. `origin.shortLabel` is the series without the patient and the
        // date, which the tree above this node already shows.
        // A SECOND RUN OF THE SAME NETWORK ON THE SAME VOLUME says it is the second (critic
        // 2026-09-22, 2.11: two rows of one name, indistinguishable).
        name: (() => {
          const base = `${taskName} of ${((target.origin as { shortLabel?: string } | undefined)?.shortLabel ?? (target.name as string)) ?? "volume"}`;
          const n = [...live.nodes.values()].filter((x) => x.type === "segmentation" && (x.name === base || (x.name as string).startsWith(base + " ("))).length;
          return n ? `${base} (${n + 1})` : base;
        })(),
        // Recorded on the node so the DICOM SEG carries it as SegmentAlgorithmName, and a reload
        // knows which family this came from. Ron: "The settings and organization should survive a
        // round trip to the dicom db."
        task: taskName,
        // ...and everything the server said about the run, for the SEG and the provenance store.
        ...(runProv ? { origin: { run: runProv } } : {}),
      });
      // HOW THIS RESULT IS MEANT TO LOOK. A network's output arrives with conventions attached, and
      // showing a FreeSurfer parcellation the way a whole-body CT wants to be shown -- through a haze
      // of unlabeled tissue -- hides the answer behind the thing it was computed from. Ron: "this is
      // the standard appearance of freesurfer like packages ... unlabeled body should be off." The
      // table in logic/presentation.ts holds the reason next to the values, and every one of these
      // parameters is a control the Volume Rendering module already exposes, so nothing here puts the
      // scene somewhere the user cannot reach by hand.
      // THE SURFACES ARE PART OF THE RESULT, so the run makes them. Ron: "Surfaces are an integral
      // part of a segmentation. Creation, saving and loading should be as transparent to the user as
      // possible."
      //
      // Started here rather than left to the save: a run that ends with "No thanks" should still have
      // a segmentation you can turn in 3D, and a save that has to build them first is a save that
      // waits. Extraction is a few seconds on a study this size and runs in a worker, so nothing
      // below is held up by it.
      // (No longer: surface models are made only in Generate Surface Models -- Ron, 2026-09-24, the
      // firewall. __ensureSurfaces refuses a segmentation without them; the result is drawn solid.)

      const preset = PRESETS[presetInUse()] ?? presentationFor(taskName);
      setColorizeParams(live, jobRec.inputId, presentationParams(preset));
      // AND THE 3D VIEW GOES TO THE SURFACES. Ron, looking at a finished run: "Why is the volume 3d
      // still the inital presentation?"
      //
      // Because the presentation just applied makes the volume COLORIZE the segmentation, and
      // `pushSurfaces` declines to draw meshes for labels a volume is already drawing -- otherwise
      // the same anatomy is rendered twice. So the surfaces were built (2.7 s, said so in the status
      // bar) and then not shown, which is the worst of both.
      //
      // The load path has handed 3D to the segmentation since he asked for it there -- "it should
      // turn surface on and 3D in volume off. That saves a few module hops" -- and a finished run is
      // the same moment: what you want to look at is the structures. The colorize parameters stay on
      // the volume, so its own 3D button brings that view back in one click.
      // The same correction as in the load path: a volume's 3D is volumeRenderingDisplay.visible,
      // not the image's `visible3D`, which is a segmentation's toggle and is read by nothing here.
      //
      // EXCEPT ON A SEQUENCE. Surfaces are one still mesh; what a person wants from a segmented
      // beating heart is the colorized volume rendering, which follows the frames and hides the
      // surfaces by itself. Ron, with the surfaces up: "It doesn't move in 3D."
      // SAID, WHEN IT UNDOES A CHOICE. Ron, 2026-09-23 19:11, with the colored volume on while a network
      // ran: "At the end, the appearance changed to a different render mode even though I didn't do
      // anything." The rule stays (surfaces on arrival, his decision of 09-22); when it turns off a
      // colored volume he had turned on, the Result section says so and offers it back in one click.
      // NOW: THE VOLUME'S LOOK FROM SCENE (Ron, 2026-09-23: the default is the solid colored look, the
      // surfaces kept). A colorized look chosen here is the see-through colored volume, on request.
      const volumeWasOn = volumeRenderingOn(live, jobRec.inputId);
      if (arrival === SURFACES) arriveInSceneLook(jobRec.inputId);
      else seeThroughColored(jobRec.inputId);
      const volumeTurnedOff = volumeWasOn && !volumeRenderingOn(live, jobRec.inputId) ? jobRec.inputId : undefined;
      if (volumeTurnedOff) status(`The volume rendering was switched off so the ${taskName} result shows — Scene → In 3D → Volume brings it back.`);

      presentedVolume = jobRec.inputId;
      presentedTask = taskName;
      presentedPreset = preset.id;
      const extra = seg.layers.length > 1 ? ` (${seg.layers.length - 1} further layer(s) not loaded)` : "";
      const named = `${recognised}/${segments.length} named and colored from the segmenter's own terminology` +
        (moved ? ` (${moved} recolored — their published colors were too alike to tell apart)` : "");
      // Says whether the run survives this window closing, because that is the question Ron had no
      // answer to when one did not.
      // WHAT THE PERSON HAS TO DO, AND WHETHER THEY ARE PROTECTED MEANWHILE -- not what the software
      // did. "on disk" and then "autosaved, survives a restart" both described the mechanism; Ron:
      // "more goobledigook ... what does it mean to a biologist?" The two facts that matter to
      // someone who has just made a segmentation are that it is NOT KEPT YET, and that they will not
      // lose it in the meantime.
      const kept = checkpointed
        ? " · not saved yet — a temporary copy is kept for a day"
        : " · not saved, and no temporary copy — save it now";
      // AND THE SURFACES, WHICH ARE PART OF THE RESULT. Ron: "the surface generation should happen
      // at the end of the segmentation run, with a proper message."
      //
      // It already does -- a new segmentation is visible in 3D, and being shown in 3D is what builds
      // the surfaces -- but the only thing that said so was the shared status bar, which the next
      // message overwrites. So this line, which is the panel's own and holds until the next run,
      // says the run is not finished with the machine yet. The triangle count arrives in the status
      // bar a few seconds later, from the extractor itself.
      jobRec.progress = progress = `${made.segments} structures on ${(target.name as string) ?? "the volume"} in ${hms(Date.now() - runStarted)} — ${named}${extra}${kept}`;
      void refreshCheckpoints();
      status(`AI segmentations: ${made.segments} structures from ${taskName}${restore ? " (restored)" : ""} (${made.segId})`);
      render();
      jobRec.segId = made.segId;
      // Colored by the scheme in use: say which version, so a later load can tell (logic/scheme-colors.ts).
      live.write({ op: "patch", id: made.segId, path: "#/colorScheme", value: paletteVersion() });
      jobRec.state = "done";
      // TOLD ONCE, WHERE THEY ARE. The job paradigm's notice: the result is in the scene already;
      // this offers to go and adjust it, or to carry on -- and, because Ron asked for the save
      // question to come to him rather than sit in small print ("I want a popup asking: do you
      // want to save to the dicom db?"), a Save when the result can be saved. Nothing here blocks:
      // a person mid-way through something else keeps doing it. Dismissing loses nothing -- the
      // result is in the scene and its temporary copy is under Recent results.
      const srcOrigin = live.nodes.get(jobRec.inputId)?.origin as
        { seriesInstanceUID?: string; savedSeriesInstanceUID?: string } | undefined;
      const savable = !!(srcOrigin?.seriesInstanceUID || srcOrigin?.savedSeriesInstanceUID);
      const segIdMade = made.segId;
      lastResult = { segId: segIdMade, task: taskName, volume: (target.name as string) ?? "the volume", structures: made.segments, ms: Date.now() - runStarted, savable, kept: checkpointed, volumeTurnedOff };
      progress = "";   // the Result section says it now; the paragraph under Segment was the same thing in fine print
      render();
      if (shell.activePanel() !== "ai-segmentations") shell.notify({
        title: `${taskName}: ${made.segments} structures`,
        body: `<p>On <b>${escapeHtml((target.name as string) ?? "the volume")}</b>, in ${hms(Date.now() - runStarted)}${restore ? " (restored)" : ""}. It is in the scene now${
          checkpointed ? "; not saved yet — a temporary copy is kept for a day" : "; not saved, and no temporary copy"}.</p>`,
        actions: [
          { label: "Show in AI Segmentations", onClick: () => { void shell.showPanel("ai-segmentations"); } },
          // RETURNS ITS PROMISE, so the card stays and the button carries the save (app-shell's
          // notify: an action that returns a promise is work, not a dismissal).
          ...(savable ? [{ label: "Save to DICOM", primary: true, busyLabel: "Saving…", doneLabel: "Saved ✓", failedLabel: "Not saved", onClick: () => {
            const g = globalThis as unknown as { __exportSegAsDicom?: (id: string) => Promise<{ filename: string; note?: string; indexed?: boolean }> };
            status("saving to the DICOM database…");
            return saveAndSay(g.__exportSegAsDicom?.(segIdMade));
          } }] : []),
          { label: "Later", onClick: () => {} },
        ],
      });
    } catch (e) {
      jobRec.progress = progress = `failed after ${hms(Date.now() - runStarted)}: ${(e as Error).message}`;
    } finally {
      if (jobRec.state === "running") jobRec.state = jobRec.cancel ? "cancelled" : jobRec.segId ? "done" : "failed";
      jobRec.finishedAt = Date.now();
      rememberJobs();
      render();
    }
  }

  /** Add a job and start the queue if it is idle. Restores are jobs too: they land the same way. */
  function enqueue(task: string, inputId: string, restore?: Checkpoint): Job {
    const inputName = (live.nodes.get(inputId)?.name as string | undefined) ?? inputId;
    // THE SAME RUN TWICE IS ONE RUN. Ron, 2026-09-22: "I click the segment button and nothing
    // happens. I click it again and 10 seconds later I get notified that two segmentations are
    // running in parallel." The second click, on a job already queued or running for this network
    // on this volume, is the same request; it is acknowledged and not added.
    const same = jobs.find((j) => j.task === task && j.inputId === inputId && !j.restore && (j.state === "queued" || j.state === "running"));
    if (same && !restore) { status(`${task} is already ${same.state} on ${inputName}`); return same; }
    const jobRec: Job = { id: nextJobId++, task, inputId, inputName, state: "queued", progress: "waiting for its turn", queuedAt: Date.now(), cancel: false, restore };
    jobs.push(jobRec);
    render();
    void pump();
    return jobRec;
  }
  /** Let the screen paint what was just rendered before heavy work blocks the thread. A hidden
   *  window never animates, so a timeout is the escape hatch -- without it a run started in a
   *  window on another desktop sat at "writing the volume…" for good (seen in the pane, 08:40). */
  const paintFirst = () => new Promise<void>((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 120);
  });
  let pumping = false;
  /** One at a time: the GPU is one, and two networks racing for it finish later than in turn. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const next = jobs.find((j) => j.state === "queued");
        if (!next) break;
        if (next.cancel) { next.state = "cancelled"; next.progress = "canceled before it started"; next.finishedAt = Date.now(); render(); continue; }
        await run(next);
      }
    } finally { pumping = false; }
  }
  /**
   * THE RUNNING JOBS SURVIVE THE PAGE. The work is on the haversack server; what a restart loses
   * is only this page's memory of the job's id. So the ids are kept in sessionStorage (which
   * survives a reload of the page and not a relaunch), and a restarted page re-attaches: it
   * polls the job, and when it is done, fetches the result, checkpoints it and lands it if the
   * volume is loaded -- Ron, 2026-09-14, on a different desktop while a 6-minute run finished and
   * the page was reclaimed: the run should not have been lost with the page.
   */
  // `sopInstanceUID`: ONE instance of the volume the job ran on. A series alone does not name a
  // volume -- the five phases of a gated CTA share one series, and by series alone a result for
  // phase 4 would land on phase 1, the trap the SEG reader was cured of on 2026-09-13
  // (logic/seg-placement.ts). The first instance is enough: no two frames share one.
  interface RememberedJob { task: string; inputName: string; seriesInstanceUID?: string; sopInstanceUID?: string; frameNumber?: number; serverJobId: string; startedAt: number }
  function rememberJobs() {
    try {
      const keep: RememberedJob[] = jobs.filter((j) => j.state === "running" && j.serverJobId && !j.restore).map((j) => ({
        task: j.task, inputName: j.inputName, serverJobId: j.serverJobId!, startedAt: j.startedAt ?? j.queuedAt,
        seriesInstanceUID: (live.nodes.get(j.inputId)?.origin as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID,
        sopInstanceUID: (live.nodes.get(j.inputId)?.origin as { sopInstanceUIDs?: string[] } | undefined)?.sopInstanceUIDs?.[0],
        frameNumber: (live.nodes.get(j.inputId)?.origin as { frameNumbers?: number[] } | undefined)?.frameNumbers?.[0],
      }));
      sessionStorage.setItem("albula-jobs", JSON.stringify(keep));
    } catch { /* no storage */ }
  }
  async function reattachJobs() {
    let remembered: RememberedJob[] = [];
    try { remembered = JSON.parse(sessionStorage.getItem("albula-jobs") ?? "[]"); sessionStorage.removeItem("albula-jobs"); } catch { return; }
    for (const r of remembered) {
      const jobRec: Job = { id: nextJobId++, task: r.task, inputId: "", inputName: r.inputName, state: "running", progress: "re-attached after the page restarted — waiting for the server", queuedAt: r.startedAt, startedAt: r.startedAt, serverJobId: r.serverJobId, cancel: false };
      jobs.push(jobRec);
      render();
      void (async () => {
        try {
          for (;;) {
            const j = await job(transport, r.serverJobId);
            jobRec.progress = `${j.state}${j.progress !== undefined ? ` ${Math.round(j.progress * 100)}%` : ""} · ${hms(Date.now() - r.startedAt)} (re-attached)`;
            render();
            if (isFinished(j.state)) {
              if (j.state !== "succeeded") { jobRec.state = "failed"; jobRec.progress = `job ${j.state}${j.error ? ": " + j.error : ""}`; break; }
              const bytes = await result(transport, r.serverJobId);
              if (!bytes) { jobRec.state = "failed"; jobRec.progress = "the job succeeded but its result could not be fetched"; break; }
              // The volume, if it is loaded again: land there. Else the checkpoint is the result.
              const ofSeries = [...live.nodes.values()].filter((n) => n.type === "image" && r.seriesInstanceUID && (n.origin as { seriesInstanceUID?: string } | undefined)?.seriesInstanceUID === r.seriesInstanceUID);
              // The frame the job ran on, by an instance it holds; the first of the series only when no instance was remembered.
              const vol = (r.sopInstanceUID && ofSeries.find((n) => holdsInstance(n.origin as { sopInstanceUIDs?: string[]; frameNumbers?: number[] } | undefined, { uid: r.sopInstanceUID!, ...(typeof r.frameNumber === "number" ? { frame: r.frameNumber } : {}) }))) ?? (r.sopInstanceUID ? undefined : ofSeries[0]);
              const file = await saveCheckpoint(bytes, { task: r.task, volume: r.inputName, at: new Date().toISOString(), ms: Date.now() - r.startedAt, sourceId: vol?.id ?? "" });
              void refreshCheckpoints();
              const cp = vol && file ? findSavedCheckpoint(await listCheckpoints(), file) : undefined;
              if (vol && cp) {
                jobRec.state = "done"; jobRec.progress = "finished on the server while the page was away — landing it";
                shell.setStatus(`AI segmentations: ${r.task} finished after the page was reloaded — landing it on ${r.inputName}`);
                enqueue(r.task, vol.id, cp);
              } else {
                shell.setStatus(`AI segmentations: ${r.task} finished after the page was reloaded — ${vol ? "its saved result could not be found in the list" : `${r.inputName} is not loaded`}; it is under Recent results`);
                jobRec.state = "done"; jobRec.progress = "finished on the server while the page was away — under Recent results; load the volume and Restore it";
                shell.notify({ title: `${r.task} finished`, body: `<p>It ran on <b>${r.inputName}</b> while this window was away. The result is under AI Segmentations → Recent results; load that volume and Restore it.</p>`, actions: [{ label: "OK", onClick: () => {} }] });
              }
              break;
            }
            await new Promise((res) => setTimeout(res, POLL_MS));
          }
        } catch (e) { jobRec.state = "failed"; jobRec.progress = `re-attach failed: ${(e as Error).message}`; }
        jobRec.finishedAt = Date.now();
        render();
      })();
    }
  }

  shell.registerPanel({
    id: "ai-segmentations",
    title: "AI Segmentations",
    tip: "Run a segmentation network on a loaded volume: TotalSegmentator, MOOSE, FastSurfer and others",
    groups: ["Segmentation"],
    order: 1,
    help: `<p>Runs a trained segmentation network over a loaded volume and brings the labels back.
      The networks are not ours and are not listed in this application: they are whatever the
      segmentation server reports, so one added tomorrow appears here without a change.</p>
      <p><b>Boundaries</b> is a real choice. <i>Smooth</i> derives sub-voxel boundaries from the
      network's logits and is what you want to look at; <i>exact labels</i> is the network's own
      label semantics and is what you want to measure. A coarse model over a fine grid — the 3&nbsp;mm
      <code>total_fast</code> over a 0.5&nbsp;mm series — shows the difference plainly.</p>
      <p>Names and colors come from the segmenter's own terminology where it is recognized, so a
      structure arrives as <i>Liver</i> rather than as <i>liver</i>, in the color that project
      publishes. Where no color is published, a color for the anatomical system is used instead.</p>
      <p>The result currently lands in the scene. Writing it back into the DICOM database with its
      provenance is the next step, and creation is the only moment that provenance is free.</p>`,
    acknowledgements: [
      `<b>haversack</b> — Michael Halle, <a href="https://github.com/mhalle/haversack">github.com/mhalle/haversack</a>.
       One command and one REST API in front of TotalSegmentator, MOOSE, MRSegmentator, stock nnU-Net,
       FastSurfer and SynthStrip, on Apple Silicon, CUDA or CPU. Every network offered here is reached
       through it.`,
      `<b>TotalSegmentator</b> — Wasserthal J., Breit H., Meyer M., Pradella M., Hinck D., Sauter A., et al.
       <i>TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in CT Images.</i>
       Radiology: Artificial Intelligence 5(5), 2023. doi:10.1148/ryai.230024. Its published
       terminology is also where the structure names and colors in this module come from.`,
      `<b>MOOSE</b> — Shiyam Sundar L. K., et al. <i>Fully Automated, Semantic Segmentation of
       Whole-Body 18F-FDG PET/CT Images Based on Data-Centric Artificial Intelligence.</i>
       Journal of Nuclear Medicine 63(12), 2022. doi:10.2967/jnumed.122.264063`,
      `<b>nnU-Net</b>, the method behind every task offered here — Isensee F., Jaeger P. F.,
       Kohl S. A. A., Petersen J., Maier-Hein K. H. <i>nnU-Net: a self-configuring method for deep
       learning-based biomedical image segmentation.</i> Nature Methods 18(2), 2020.
       doi:10.1038/s41592-020-01008-z`,
      `On comparing these models to each other — Giebeler L., Krishnaswamy D., Clunie D.,
       Wasserthal J., Shiyam Sundar L. K., Diaz-Pinto A., Maier-Hein K. H., Xu M., Menze B.,
       Pieper S., Kikinis R., Fedorov A. <i>In search of truth: evaluating concordance of AI-based
       anatomy segmentation models.</i> Journal of Medical Imaging 13(6), 2026.
       doi:10.1117/1.JMI.13.6.062204`,
    ],
    mount(el) {
      root = el;
      render();
      refreshServer();
      // Asked for on mount, not only after a run: the case this exists for is a session that has
      // just come back from losing one, where nothing has run yet and the result is only on disk.
      void refreshCheckpoints();
    },
    // And every time the module is opened: a result made outside the application (a script, or
    // another window) is on disk and the list read at mount does not know it. Mount runs once.
    // THE SERVER'S LIST TOO: model files downloaded outside this panel (another window, the command
    // line) left "downloads the model first" and the ready count stale until a reload (2026-09-28, the
    // TotalSegmentator v3 weights). One refresh at a time.
    onShow() {
      void refreshCheckpoints();
      if (!refreshingOnShow) { refreshingOnShow = true; void refreshServer().finally(() => { refreshingOnShow = false; }); }
    },
  });

  // At startup, not on the module's first opening: a job that survived the page restart is found
  // whatever module the restarted page lands in.
  void reattachJobs();

  // The input list changes when a volume is loaded, and the panel must not show a stale one.
  live.subscribe?.((c) => {
    if (!root || isBusy()) return;
    // A playing sequence steps at the playback rate; rebuilding the panel each step would replace
    // every control under the pointer. Only the Input list follows the frame, in place.
    if (c.type === "sequenceBrowser" || c.type === "volumeRenderingDisplay" || c.type === "sliceComposite" || c.type === "view") {
      const sel = root.querySelector(".sl-ai-input") as HTMLSelectElement | null;
      if (sel && c.type === "sequenceBrowser") {
        const vols = inputs();
        if (!vols.some((v) => v.id === chosenInput)) { const cur = live.nodes.get(chosenInput); const seqFrame = cur?.sequence ? vols.find((v) => live.nodes.get(v.id)?.sequence === cur.sequence) : undefined; if (seqFrame) chosenInput = seqFrame.id; }
        sel.innerHTML = vols.length ? vols.map((v) => `<option value="${v.id}"${v.id === chosenInput ? " selected" : ""}>${escapeHtml(v.name)}</option>`).join("") : `<option value="">load a volume first</option>`;
      }
      return;
    }
    render();
  });
}
