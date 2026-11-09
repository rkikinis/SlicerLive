// THE SCENES MODULE'S WORDS (scenes-face.ts): a scan and a result as a resident reads them, the date and time shown on this
// machine. Kept apart from the module so they can be tested on the values the databases actually hold (critic 2026-11-08,
// step 2, finding 11: "CHESTABDPELVIS" read "CT chest/pelvis").

export interface SeriesRow { uid: string; modality?: string; description?: string; bodyPart?: string; studyDescription?: string; studyDate?: string; patientID?: string; n?: string }

export const local = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
/** The scan as the scanner and the database name it, the empty parts left out. */
export const scanWords = (s: SeriesRow) => [s.description?.startsWith(s.patientID ?? "\u0000") ? "" : s.patientID, s.modality, s.description, s.n ? `${s.n} images` : "", s.studyDescription ? `study “${s.studyDescription}”` : ""].filter((x) => x && x !== "None").join(" · ");
export const studyDate = (d?: string) => d && /^\d{8}$/.test(d) ? new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6))).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

/** THE SCAN IN A RESIDENT'S WORDS: kind and body region from the study's and series' descriptions; the full ones on hover. */
export function plainScan(s: SeriesRow | undefined): string {
  if (!s) return "No scan";
  // The body region the scanner recorded counts too: IDC's CTs often carry no description at all, only BodyPartExamined (CHEST).
  const text = `${s.studyDescription ?? ""} ${s.description ?? ""} ${s.bodyPart && s.bodyPart !== "None" ? s.bodyPart : ""}`.toUpperCase(), mod = s.modality ?? "";
  if (/PULMONARY ANGIO|\bCTPA\b/.test(text)) return "CTPA";
  if (/CORONARY/.test(text)) return mod === "CT" ? "Coronary CTA" : `${mod} coronary`;
  const parts: string[] = [];
  if (/\bHEAD\b|BRAIN|NEURO/.test(text)) parts.push("head");
  if (/CHEST|THORAX|LUNG/.test(text)) parts.push("chest");
  if (/ABD/.test(text)) parts.push("abdomen");   // no \b: IDC writes "CHESTABDPELVIS" as one word
  if (/PELVIS/.test(text)) parts.push("pelvis");
  if (parts.length === 3) return `${mod} chest/abd/pelvis`;
  if (parts.length) return `${mod} ${parts.join("/")}`;
  // An organ or region the scanner recorded and none of the above ("PANCREAS", "HEART", "NECK"): said as it is.
  const bp = (s.bodyPart ?? "").trim();
  if (bp && bp !== "None" && /^[A-Z ]+$/i.test(bp)) return `${mod} ${bp.toLowerCase()}`;
  const d = (s.description ?? "").trim();
  return d && !/^=+\s*NONE\s*=+$/i.test(d) ? `${mod} · ${d}` : `${mod} · ${(s.studyDescription ?? "").trim() || "scan"}`;
}
/** A result in words: "Lung vessels · TotalSegmentator" from "ts.v2:lung_vessels of CT …"; any other name as it is. */
export function plainResult(name: string): string {
  const MAKER: Record<string, string> = { ts: "TotalSegmentator", "ts.v2": "TotalSegmentator", "ts.v3": "TotalSegmentator", fastsurfer: "FastSurfer", cads: "CADS", moose: "MOOSE", lnq: "LNQ" };
  const m = /^([\w.]+):(\w+)/.exec(name);
  if (!m || !MAKER[m[1]]) return name;
  const task = m[2] === "total" || m[2] === "total_fast" ? "All structures" : m[2] === "asegdkt" ? "Brain structures" : m[2].replace(/_LEGACY$/, "").replace(/^clin_ct_/, "").replace(/_/g, " ");
  return `${task.charAt(0).toUpperCase()}${task.slice(1)} · ${MAKER[m[1]]}`;
}

