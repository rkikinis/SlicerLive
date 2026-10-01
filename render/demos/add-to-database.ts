// ADDING SCANS FROM DISK TO A DATABASE, the page's half (the server's is desktop/db-import.ts).
//
// Ron, 2026-10-01: Load / Save › From disk gets "Also add to [database]", ticked by default, so a patient's scans
// from a disc or a stick stay in the database after the stick is gone. Two ways in: a folder the person chose in
// macOS's dialog (the server reads it from disk; nothing passes through the page), or files the page already holds
// (DICOM files…, a dropped folder), uploaded one by one into the database's staging folder and then added.

export interface ImportResult {
  series: { uid: string; modality: string; description: string; instances: number; patientName: string }[];
  patients: number; studies: number; instances: number; already: number;
  skipped: { file: string; reason: string }[]; skippedCount: number;
  failed: { uid: string; description: string; error: string }[];
  notes: string[];
  ms: number;
}
interface Progress { phase: string; files: number; read: number; dicom: number; series: number; seriesDone: number }

async function follow(job: string, onStatus: (s: string) => void, what: string): Promise<ImportResult> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const j = await fetch(`/_db/_import/${job}`, { cache: "no-store" }).then((r) => r.json()) as { progress: Progress; result?: ImportResult; error?: string };
    if (j.error) throw new Error(j.error);
    if (j.result) return j.result;
    const p = j.progress;
    onStatus(p.phase === "reading" ? `Adding to ${what}: reading ${p.read} of ${p.files || "…"} files`
      : `Adding to ${what}: scan ${Math.min(p.seriesDone + 1, p.series)} of ${p.series}`);
  }
}

/** A chosen folder (its token from /_db/_choose-folder), added by the server. */
export async function addFolderToDatabase(dbId: string, token: string, what: string, onStatus: (s: string) => void): Promise<ImportResult> {
  const r = await fetch(`/_db/${encodeURIComponent(dbId)}/_import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const j = await r.json() as { job?: string; error?: string };
  if (!j.job) throw new Error(j.error ?? "the server did not start the import");
  return follow(j.job, onStatus, what);
}

/** Files the page holds: uploaded (four at a time), then added; the server leaves out what is not DICOM. */
export async function addFilesToDatabase(dbId: string, files: File[], what: string, onStatus: (s: string) => void): Promise<ImportResult> {
  const job = crypto.randomUUID();
  let sent = 0, next = 0;
  const one = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const r = await fetch(`/_db/${encodeURIComponent(dbId)}/_upload/${job}/${i}`, { method: "POST", body: files[i] });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `upload failed (${r.status})`);
      if (++sent % 20 === 0) onStatus(`Adding to ${what}: copying ${sent} of ${files.length} files`);
    }
  };
  await Promise.all([one(), one(), one(), one()]);
  const r = await fetch(`/_db/${encodeURIComponent(dbId)}/_import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upload: job }) });
  const j = await r.json() as { job?: string; error?: string };
  if (!j.job) throw new Error(j.error ?? "the server did not start the import");
  return follow(j.job, onStatus, what);
}

/** The files of a chosen folder, for viewing without adding (the server serves them read only). */
export async function filesOfChosenFolder(token: string, onStatus: (s: string) => void): Promise<File[]> {
  const list = await fetch(`/_db/_folder/${token}/_list`, { cache: "no-store" }).then((r) => r.json()) as { files?: string[]; error?: string };
  if (!list.files) throw new Error(list.error ?? "the folder could not be read");
  const out: File[] = [];
  for (const [i, rel] of list.files.entries()) {
    const r = await fetch(`/_db/_folder/${token}/${rel.split("/").map(encodeURIComponent).join("/")}`);
    if (r.ok) out.push(new File([await r.arrayBuffer()], rel.slice(rel.lastIndexOf("/") + 1)));
    if (i % 50 === 0) onStatus(`reading ${i} of ${list.files.length} files`);
  }
  return out;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** What happened, in plain words: a title and a short body (HTML-escaped by the caller's notify). */
export function describeImport(r: ImportResult, dbName: string): { title: string; lines: string[] } {
  const lines: string[] = [];
  if (r.series.length) lines.push(`${plural(r.patients, "patient")}, ${plural(r.series.length, "scan")} (${plural(r.instances, "image")}) added to ${dbName}.`);
  if (r.already) lines.push(`${plural(r.already, "image")} ${r.already === 1 ? "was" : "were"} already there and left as they were.`);
  if (r.failed.length) lines.push(`Not added: ${r.failed.map((f) => `${f.description || "a scan"} (${f.error})`).join("; ")}.`);
  if (r.skippedCount) {
    // Said by kind, so a valid scan Albula cannot read yet is not called "not an image" (critic, 2026-10-01, finding 8).
    const kinds = new Map<string, number>();
    for (const s of r.skipped) kinds.set(s.reason, (kinds.get(s.reason) ?? 0) + 1);
    const top = [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => `${n} × ${why}`);
    lines.push(`Left out: ${plural(r.skippedCount, "file")}${top.length ? ` (${top.join("; ")})` : ""}.`);
  }
  lines.push(...(r.notes ?? []));
  const title = r.failed.length ? "Some scans were not added" : r.series.length ? `Added to ${dbName}` : r.already ? `Already in ${dbName}` : "No DICOM images found";
  return { title, lines };
}
