// "Sample Data" panel — Slicer's Sample Data module, split out of the Data panel. Downloads a catalog entry
// (SHA-256 verified) and loads it through the normal ingest path via __loadVolumeBytes. Plain DOM, theme.css.
import type { AppShell } from "./app-shell.ts";
import { downloadSample, SAMPLE_DATA } from "../../logic/sample-data.ts";
import { escapeHtml } from "./html.ts";

interface Hooks {
  __loadVolumeBytes: (bytes: Uint8Array, name: string) => Promise<void>;
  __openDatabaseInWindow?: (id: string) => Promise<void>;
  __unsavedWork?: () => string[];
  __loadDatabaseSeries?: (uids: string[], onProgress?: (line: string) => void) => Promise<{ loaded: number; failures: string[] }>;
}
const g = () => globalThis as unknown as Hooks;

export function registerSampleDataPanel(shell: AppShell, opts: { onStatus?: (s: string) => void }): void {
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  shell.registerPanel({ id: "sampledata", title: "Sample Data", groups: ["Data"], order: 5, tip: "Download a sample scan to try things on: 3D Slicer's samples, and a brain with diffusion from OpenNeuro",
    help: `<p>Scans to try Albula on: the first four are 3D Slicer's sample data; Brain with DTI comes from OpenNeuro. Click one: it downloads, is checked, and opens in the views.</p>
      <p><b>Brain with DTI</b> is a healthy volunteer's brain MRI with a diffusion scan (OpenNeuro ds001226, CON03; free to use). It is kept in a database of its own, <i>Sample data</i>, which this window then works in (the database Albula opens by default stays as it was); the brain is shown colored by fiber direction over the T1, in the Diffusion module.</p>`,
    mount(el) {
    el.innerHTML = `
      <h2>Sample Data</h2>
      <div class="sl-samples"></div>
      <div class="sl-progress" hidden><div class="sl-progress-bar"></div><span class="sl-progress-text"></span></div>`;
    const samples = el.querySelector(".sl-samples") as HTMLElement;
    const prog = el.querySelector(".sl-progress") as HTMLElement, bar = el.querySelector(".sl-progress-bar") as HTMLElement, ptxt = el.querySelector(".sl-progress-text") as HTMLElement;
    // ONE PROGRESS LINE, shown under the button that started it (critic 2026-10-14, 27: it sat above "With diffusion",
    // away from Brain with DTI). Its own place is under the four samples; the DTI button takes it into its section.
    const progHome = { parent: prog.parentElement!, next: prog.nextSibling };
    const progHomeAgain = () => { if (prog.parentElement !== progHome.parent) progHome.parent.insertBefore(prog, progHome.next); };
    for (const d of SAMPLE_DATA) {
      const row = document.createElement("div"); row.className = "sl-row";
      const b = document.createElement("button"); b.textContent = d.title; b.title = `Download and open it: ${d.modality ?? ""}, about ${d.mb ?? "?"} MB, one of Slicer's sample scans`;
      b.addEventListener("click", async () => {
        progHomeAgain();
        b.disabled = true; prog.hidden = false; bar.style.width = "0%"; ptxt.textContent = `downloading ${d.title}…`;
        let got = 0; const total = (d.mb ?? 20) * 1048576;
        try {
          const r = await downloadSample(d.name, undefined, (n) => { got += n; bar.style.width = Math.min(100, 100 * got / total).toFixed(0) + "%"; ptxt.textContent = `${d.title}: ${(got / 1048576).toFixed(1)} MB`; });
          ptxt.textContent = "verified ✓";
          await g().__loadVolumeBytes(r.bytes, d.fileName);
        } catch (e) { status(`${d.title}: ${(e as Error).message}`); }
        finally { b.disabled = false; setTimeout(() => { prog.hidden = true; }, 1500); }
      });
      row.appendChild(b);
      samples.appendChild(row);
    }

    // WITH DIFFUSION (Ron, 2026-10-14: "a data set with T1 and color by orientation as a sample"; CON03; "DB of its own";
    // the button "Brain with DTI"). Not a file like the four above: real scans, converted to DICOM into the database
    // "Sample data" by the server (desktop/test-cases.ts getDtiSample), then opened from it. Pressed again: no download.
    if (shell.section) {
      const sec = shell.section(el, "With diffusion", { open: true, band: "green" });
      const row = document.createElement("div"); row.className = "sl-row";
      const b = document.createElement("button");
      b.textContent = "Brain with DTI";
      b.title = "A healthy volunteer's brain MRI with a diffusion scan: the brain colored by fiber direction over the T1 (red left–right, green front–back, blue up–down). Downloaded from OpenNeuro, free to use (about 54 MB); kept in a database of its own, Sample data, which this window then works in.";
      row.appendChild(b); sec.appendChild(row);
      b.addEventListener("click", async () => {
        // THE DATABASE HOOKS live in Load / Save; mounted here, not shown, so the button works from a fresh window
        // (critic 2026-10-14, 1: Welcome → Sample Data → the button ended in "it could not be opened").
        await shell.mountPanel("add-data").catch(() => {});
        sec.appendChild(prog);
        const h = g();
        if (!h.__openDatabaseInWindow || !h.__loadDatabaseSeries) { status("Brain with DTI: this window cannot open databases (quit Albula and start it again)"); return; }
        // IT OPENS IN THIS WINDOW, from its own database, which this window then works in (critic 2026-10-14, 3). Work
        // saved nowhere would then not save to the database it came from: asked first, by name.
        const unsaved = h.__unsavedWork?.() ?? [];
        if (unsaved.length) {
          const ok = await shell.confirm({ title: "Open the diffusion sample now?", ok: "Open the sample", cancel: "Not now",
            body: `<p>The sample opens from its own database, <i>Sample data</i>, and this window then works in it. Not saved yet: <b>${unsaved.map(escapeHtml).join(", ")}</b> — save ${unsaved.length === 1 ? "it" : "them"} first, or ${unsaved.length === 1 ? "it" : "they"} cannot be saved to the database ${unsaved.length === 1 ? "it" : "they"} came from in this window.</p>` });
          if (!ok) return;
        }
        b.disabled = true; prog.hidden = false; bar.style.width = "0%"; ptxt.textContent = "getting the diffusion sample…";
        try {
          const start = await fetch("/_db/_dti-sample", { method: "POST" }).catch(() => null);
          const s0 = start ? await start.json().catch(() => ({})) : {};
          if (!start) throw new Error("Albula's server did not answer; press again");
          if (!start.ok || !s0.job) throw new Error(s0.error ?? (start.status === 404 ? "Albula's server is older than this window: quit Albula and start it again" : "the sample could not be started; press again"));
          let total = Number(s0.approxBytes) || 54.3e6;
          let j: { progress?: { phase: string; bytes: number }; result?: { series: { role: string; seriesInstanceUID: string }[] }; error?: string; done?: boolean } = {};
          let misses = 0;
          for (;;) {
            await new Promise((r) => setTimeout(r, 400));
            const r = await fetch(`/_db/_dti-sample/${s0.job}`, { cache: "no-store" }).catch(() => null);
            j = r ? await r.json().catch(() => ({})) : {};
            // A SERVER THAT FORGOT THE JOB OR WENT AWAY ends the wait with a sentence, never a silent hang (critic 2026-10-14, 5).
            if (!r || (!r.ok && !j.done)) { if (++misses >= 5) throw new Error("Albula's server stopped answering; press again"); continue; }
            misses = 0;
            const ph = j.progress?.phase ?? "";
            const got = j.progress?.bytes ?? 0;
            total = Math.max(total, got);
            bar.style.width = Math.min(100, 100 * got / total).toFixed(0) + "%";
            ptxt.textContent = ph === "converting" ? "converting to DICOM…" : ph === "downloading" ? `downloading the diffusion sample… ${(got / 1e6).toFixed(0)} of about ${(total / 1e6).toFixed(0)} MB` : ptxt.textContent;
            if (j.done) break;
          }
          if (j.error || !j.result) throw new Error(j.error ?? "the sample did not arrive; press again");
          ptxt.textContent = "opening it…";
          await h.__openDatabaseInWindow(s0.id);
          // THE T1, THEN THE REVERSED SCAN, THEN THE DIFFUSION SCAN: the Diffusion module makes its maps when the diffusion
          // scan arrives, and the reversed scan must be there by then or the maps are not corrected (critic 2026-10-14, 2).
          const order = ["T1w", "dwi-PA", "dwi-AP"];
          const uids = [...j.result.series].sort((x, y) => order.indexOf(x.role) - order.indexOf(y.role)).map((x) => x.seriesInstanceUID);
          const r = await h.__loadDatabaseSeries(uids, (line) => { ptxt.textContent = line; });
          if (r.loaded < uids.length) throw new Error(r.failures.join("; ") || "it could not be opened");
          await shell.showPanel("diffusion").catch(() => {});
          status("Brain with DTI: open, from the database Sample data");
          ptxt.textContent = "open ✓";
        } catch (e) { status(`Brain with DTI: ${(e as Error).message}`); ptxt.textContent = "not opened"; }
        finally { b.disabled = false; setTimeout(() => { prog.hidden = true; }, 1500); }
      });
    }
  } });
}
