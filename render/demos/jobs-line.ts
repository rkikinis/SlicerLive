// THE IMPORT-TIME WORK, SAID QUIETLY (the workspace's DMRI-AT-IMPORT.md, "How the user is told"; Ron, 2026-10-05: "the
// user needs to know, so they are not surprised. Needs to be non blocking without requiring an acknowledgement"): one line
// in the top bar beside the sequence transport while an extension's job runs (desktop/extension-jobs.ts, GET /_jobs), gone
// when it ends. Nothing to press, no focus taken, no module changed. Asked every few seconds while something runs, every
// half minute otherwise.
import type { AppShell } from "./app-shell.ts";

interface Running { label: string; cases: number; made: number; studies?: number }

export function mountJobsLine(shell: AppShell): void {
  const el = document.createElement("span");
  el.className = "sl-jobs-line";
  el.hidden = true;
  el.title = "Albula is preparing work for scans that were added to a database, once, in the background. Nothing to do: the line goes away when it is done. The 3D view may be slower meanwhile.";
  const zone = shell.toolbar.parentElement!.querySelector(".sl-scene-zone");
  if (zone) zone.appendChild(el); else shell.toolbar.parentElement!.insertBefore(el, shell.toolbar);
  let saidRestart = 0, restartText = "";
  const ask = async () => {
    let next = 30_000;
    try {
      const r = await fetch("/_jobs", { cache: "no-store" });
      if (r.ok) {
        const s = await r.json() as { running?: Running; queued?: string[]; serverRestart?: { at: number; stopped: string[] } };
        const run = s.running, rs = s.serverRestart;
        // A RESTART THAT STOPPED SOMEONE'S WORK (Ron, 2026-10-15: "restart but notify, if an ongoing segmentation gets
        // killed"): said once per restart, in the status line (and so the session log), and on this line until dismissed.
        if (rs && rs.at !== saidRestart) {
          saidRestart = rs.at;
          const at = new Date(rs.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          restartText = `The segmentation server had stopped working and was restarted at ${at}. This stopped: ${rs.stopped.join("; ")}. Start ${rs.stopped.length === 1 ? "it" : "them"} again in AI Segmentations.`;
          shell.setStatus(restartText);
        }
        el.hidden = !run && !restartText;
        if (!run && restartText) { el.textContent = `${restartText} (click to dismiss)`; el.style.cursor = "pointer"; el.onclick = () => { restartText = ""; el.hidden = true; }; }
        else { el.style.cursor = ""; el.onclick = null; }
        if (run) {
          el.textContent = `${run.label}: ${run.made} made${run.studies ? `, ${run.cases} of the scans looked at` : ""} — the 3D view may be slower meanwhile`;
          next = 3_000;
        } else if (s.queued?.length) next = 3_000;
      }
    } catch { /* no server: try again later */ }
    setTimeout(() => void ask(), next);
  };
  void ask();
}
