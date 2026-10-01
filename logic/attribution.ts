/**
 * WHO MADE THE NETWORK, from the server. Since haversack 0.7.0 every task's record
 * (`GET /v1/tasks/{task}`, `haversack cite`) carries `attribution`: the ecosystem's title, group,
 * repository, licenses for code and weights, the engine's, and the papers to cite, read from the
 * projects' own READMEs. This application kept the same by hand (`anatomy/model-papers.ts`,
 * `model-license.ts`) until 2026-09-14; the server's answer is the one that stays correct without
 * anyone here maintaining it (Ron: "Attribution: yes, makes sense"). The by-hand tables remain
 * as the fallback for a server that does not answer.
 */
export interface Citation { title: string; authors?: string; journal?: string; year?: number; doi?: string; pmid?: string; note?: string; for?: string }
export interface Attribution {
  ecosystem?: string;
  title?: string;
  description?: string;
  group?: string;
  repository?: string;
  license?: { code?: string; weights?: string; url?: string; note?: string };
  engine?: { title?: string; group?: string; repository?: string; license?: { code?: string } };
  cite: Citation[];
}

/** The server's record, in one shape whatever version wrote it. `null` when there is none. */
export function attributionOf(rec: unknown): Attribution | null {
  const a = (rec as { attribution?: Record<string, unknown> } | null)?.attribution;
  if (!a || typeof a !== "object") return null;
  const eco = (a.ecosystem_info ?? {}) as Record<string, unknown>;
  const task = (a.task ?? {}) as Record<string, unknown>;
  const eng = (a.engine_info ?? {}) as Record<string, unknown>;
  const lic = { ...((eco.license as Record<string, unknown> | undefined) ?? {}), ...((task.license as Record<string, unknown> | undefined) ?? {}) };
  const cite = (Array.isArray(a.cite) ? a.cite : []).filter((c): c is Citation => !!c && typeof c === "object" && typeof (c as Citation).title === "string");
  return {
    ecosystem: typeof a.ecosystem === "string" ? a.ecosystem : undefined,
    title: typeof eco.title === "string" ? eco.title : undefined,
    description: typeof eco.description === "string" ? eco.description : undefined,
    group: typeof eco.group === "string" ? eco.group : undefined,
    repository: typeof eco.repository === "string" ? eco.repository : undefined,
    license: Object.keys(lic).length ? lic as Attribution["license"] : undefined,
    engine: eng.title ? { title: String(eng.title), group: eng.group ? String(eng.group) : undefined, repository: eng.repository ? String(eng.repository) : undefined, license: eng.license as { code?: string } | undefined } : undefined,
    cite,
  };
}

/** "Authors. Title. Journal Year. doi:…" -- the same shape model-papers.ts formats by hand. */
export function formatCite(c: Citation): string {
  const parts = [c.authors ? c.authors.replace(/\.?$/, ".") : "", c.title.replace(/\.?$/, "."), [c.journal, c.year].filter(Boolean).join(" ") + (c.journal || c.year ? "." : ""), c.doi ? `doi:${c.doi}` : ""];
  return parts.filter(Boolean).join(" ") + (c.note ? ` (${c.note})` : "");
}

/** The paper to open for a task: the ecosystem's first, else the first of any. */
export function primaryCite(a: Attribution): Citation | undefined {
  return a.cite.find((c) => c.for === "ecosystem") ?? a.cite[0];
}

/** One line for the license, in words: "code Apache-2.0 · weights CC-BY-4.0". */
export function licenseLine(a: Attribution): string {
  const l = a.license; if (!l) return "";
  const bits = [l.code ? `code ${l.code}` : "", l.weights ? `weights ${l.weights}` : ""].filter(Boolean);
  return bits.join(" · ");
}
