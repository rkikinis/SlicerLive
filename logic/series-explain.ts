// WHAT A SERIES IS, IN PLAIN WORDS: the tooltip on a series row of the DICOM browser.
//
// Ron, 2026-09-24: "the chest CT has many acquisitions with cryptic shorthand descriptions. Having tooltips
// with more per row information would be helpful." Two halves:
//
//   1. WHAT THE NAME SAYS. The scanner's and the reading workstation's shorthand ("WO Insp 1x0.8 Lung
//      Chest"), token by token, from a glossary. ONLY WHAT IS KNOWN: a token not in the glossary is listed
//      as not explained rather than guessed at ("look, don't guess").
//   2. WHAT THE FILE SAYS. The first file's header (logic/readers/dicom-head.ts): what kind of images
//      (the scan itself, a reformat, a screenshot, a report, a scout), how many, slice and pixel size,
//      the reconstruction filter, kV and dose for CT, TR/TE and field strength for MR, how the patient
//      lay, when, and which machine or program made it.

import { type DicomHead, headValue } from "./readers/dicom-head.ts";

/** Whole-token glossary, lower case. Kept to what is certain; add as more shorthand is met. */
const WORDS: Record<string, string> = {
  wo: "without contrast", "w/o": "without contrast", woc: "without contrast", noncon: "without contrast",
  wc: "with contrast", "w/": "with contrast", with: "with contrast", without: "without contrast",
  insp: "breath held after breathing in (lungs full)", exp: "breath held after breathing out",
  prone: "lying face down", supine: "lying on the back",
  ax: "axial (cross-sections)", axial: "axial (cross-sections)", cor: "coronal (front view slices)", sag: "sagittal (side view slices)",
  mip: "maximum-intensity projection (the brightest point through a slab)", minip: "minimum-intensity projection (the darkest point through a slab)",
  mpr: "reformatted in another plane", vr: "volume rendering",
  lung: "sharp filter, for the lungs", soft: "smooth filter, for soft tissue", bone: "sharp filter, for bone", mediastinum: "soft-tissue filter",
  chest: "chest", abd: "abdomen", abdomen: "abdomen", pel: "pelvis", pelvis: "pelvis", abdpel: "abdomen and pelvis", head: "head", neck: "neck",
  topogram: "scout image, used to plan the scan", scout: "scout image, used to plan the scan", localizer: "scout image, used to plan the scan",
  cta: "CT angiography (contrast in the arteries)", angio: "angiography",
  ctpa: "CT pulmonary angiography (contrast in the lung arteries)",
  nephrogenic: "nephrographic phase: after contrast, when the kidneys are evenly enhanced (typically 80–120 s after injection)",
  nephrographic: "nephrographic phase: after contrast, when the kidneys are evenly enhanced (typically 80–120 s after injection)",
  asir: "ASIR, GE's iterative noise reduction", recon: "reconstruction (images recomputed from the same scan)", std: "standard filter",
  lad: "left anterior descending coronary artery", lcx: "left circumflex coronary artery", rca: "right coronary artery",
  smfov: "small field of view", fullfov: "full field of view",
  bestdiast: "the heart phase chosen automatically in diastole (heart relaxed)", bestdia: "the heart phase chosen automatically in diastole (heart relaxed)",
  ecg: "the ECG recorded during the scan", bestsyst: "the heart phase chosen automatically in systole (heart contracted)",
  multi: "several heart phases", monitoring: "bolus tracking: repeated low-dose images that time the scan to the contrast", premonitoring: "the image the bolus tracking is placed on",
  dose: "dose", report: "report", protocol: "protocol",
};
/** Multi-word phrases, matched first. */
const PHRASES: [RegExp, string][] = [
  [/\bdose report\b/i, "the radiation dose record of the examination (a structured report, no images)"],
  [/\bpatient protocol\b/i, "a screenshot of the scan protocol page"],
  [/\bexamination report\b/i, "the scanner's structured report of the examination (no images)"],
  [/\bvessel suppress\b/i, "processed so the vessels are suppressed and small nodules stand out"],
  [/\bsummary report\b/i, "a summary page (a picture of a report)"],
  [/\bcompare index\b/i, "comparison pictures"],
  [/\brib ranges\b/i, "rib labels, pictures made by the reading workstation"],
  [/\binjection images\b/i, "the contrast injector's record of the injection"],
  [/\btest bolus\b/i, "a small test injection of contrast, used to time the scan"],
  [/\bpulmonary artery locator\b/i, "the image the contrast timing is placed on (the pulmonary artery)"],
];

const tokenExplain = (t: string): string | undefined => {
  const k = t.toLowerCase();
  if (WORDS[k]) return WORDS[k];
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(t))) return `slices ${m[1]} mm thick, every ${m[2]} mm`;
  if ((m = /^(\d+(?:\.\d+)?)mm$/i.exec(t))) return `${m[1]} mm`;
  if ((m = /^(\d+)%$/.exec(t))) return `at ${m[1]}% of the heartbeat`;
  if ((m = /^(\d+)ms$/i.exec(t))) return `${m[1]} ms after the R-wave`;
  return undefined;
};

/** The name, token by token: what is explained and what is not. */
export function explainName(desc: string): { said: string[]; unknown: string[] } {
  const said: string[] = [];
  let rest = ` ${desc.replace(/_/g, " ")} `;               // "Rib Ranges_RR": an underscore joins words
  for (const [re, what] of PHRASES) if (re.test(rest)) { said.push(what); rest = rest.replace(re, " "); }
  // "_RR [5]": made on the reading workstation (Siemens syngo.via) from series 5.
  const rr = /\bRR\s*\[(\d+)\]/i.exec(rest);
  if (rr) { said.push(`made on the reading workstation from series ${rr[1]}`); rest = rest.replace(rr[0], " "); }
  const src = /\[(\d+)\]/.exec(rest);
  if (src) { said.push(`from series ${src[1]}`); rest = rest.replace(src[0], " "); }
  // "40% ASIR": the percentage is the noise reduction's strength, not a phase of the heartbeat.
  const asir = /\b(\d+)\s*%\s*ASIR\b/i.exec(rest);
  if (asir) { said.push(`ASIR, GE's iterative noise reduction, at ${asir[1]}% strength`); rest = rest.replace(asir[0], " "); }
  const range = /(\d+)\s*ms\s*-\s*(\d+)\s*ms/i.exec(rest);
  if (range) { said.push(`phases from ${range[1]} to ${range[2]} ms after the R-wave`); rest = rest.replace(range[0], " "); }
  const unknown: string[] = [];
  const tokens = rest.split(/[\s_()]+/).filter(Boolean);    // "(40% ASIR)": brackets are not part of a word
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // A slab after MIP/MPR: "MIP 10x5" is slabs, not slices.
    const slab = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(t);
    if (slab && i > 0 && /^(mip|minip|mpr)$/i.test(tokens[i - 1])) { said.push(`slabs ${slab[1]} mm thick, every ${slab[2]} mm`); continue; }
    // A lone number before a filter word: slice thickness ("3 Soft").
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const next = (tokens[i + 1] ?? "").toLowerCase();
      if (WORDS[next] && /filter/.test(WORDS[next])) { said.push(`slices ${t} mm thick`); continue; }
      unknown.push(t); continue;
    }
    const e = tokenExplain(t);
    if (e) { if (!said.includes(e)) said.push(e); } else if (!/^[-·,.:;()]+$/.test(t)) unknown.push(t);
  }
  return { said, unknown };
}

const SOP: Record<string, string> = {
  "1.2.840.10008.5.1.4.1.1.7": "a screenshot or picture (secondary capture), not measurable images",
  "1.2.840.10008.5.1.4.1.1.88.67": "a dose record (structured report), no images",
  "1.2.840.10008.5.1.4.1.1.88.22": "a structured report, no images",
  "1.2.840.10008.5.1.4.1.1.88.33": "a structured report, no images",
  "1.2.840.10008.5.1.4.1.1.88.11": "a structured report, no images",
  "1.2.840.10008.5.1.4.1.1.66.4": "a segmentation",
  "1.2.840.10008.5.1.4.1.1.66.7": "a segmentation (label map)",
  "1.2.840.10008.5.1.4.1.1.66.5": "surface models",
  "1.2.840.10008.5.1.4.1.1.11.1": "a saved display state (presentation state), no images",
};
const POSITION: Record<string, string> = {
  HFS: "lying on the back, head first", FFS: "lying on the back, feet first", HFP: "lying face down, head first",
  FFP: "lying face down, feet first", HFDR: "lying on the right side, head first", HFDL: "lying on the left side, head first",
  FFDR: "lying on the right side, feet first", FFDL: "lying on the left side, feet first",
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v.split("\\")[0]));
const mm = (v: number) => `${+v.toFixed(2)} mm`;
const time = (tm: string | undefined) => (tm && /^\d{4}/.test(tm) ? `${tm.slice(0, 2)}:${tm.slice(2, 4)}${tm.length >= 6 ? ":" + tm.slice(4, 6) : ""}` : undefined);

/** The plane of the images from their orientation: axial, coronal, sagittal, or oblique. */
function plane(iop: string | undefined): string | undefined {
  const v = (iop ?? "").split("\\").map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) return undefined;
  const n = [v[1] * v[5] - v[2] * v[4], v[2] * v[3] - v[0] * v[5], v[0] * v[4] - v[1] * v[3]].map(Math.abs);
  const i = n.indexOf(Math.max(...n));
  if (n[i] < 0.9) return "oblique";
  return ["sagittal", "coronal", "axial"][i];
}

/** The tooltip for one series: its name, what the name says, and what its first file says. */
export function explainSeries(desc: string, count: number, head: DicomHead | null, modality?: string): string {
  const lines: string[] = [desc || "(no description)"];
  // A segmentation's name is words we wrote ("ts.v2:total of CT …"), not scanner shorthand: not decoded.
  // And a name with nothing in it the glossary knows is a plain name: nothing to list as unexplained.
  if (modality !== "SEG") {
    const { said, unknown } = explainName(desc);
    if (said.length) lines.push(`The name says: ${said.join(" · ")}.`);
    if (said.length && unknown.length) lines.push(`Not explained: ${unknown.join(", ")}.`);
  } else if (!head || !head.size) lines.push("A segmentation.");
  if (!head || !head.size) { lines.push(`${count} file${count === 1 ? "" : "s"}.`); return lines.join("\n"); }

  const g = (k: Parameters<typeof headValue>[1]) => headValue(head, k);
  const type = (g("ImageType") ?? "").toUpperCase().split("\\");
  const sop = g("SOPClassUID") ?? "";
  modality = g("Modality") ?? modality ?? "";
  // WHAT KIND OF THING
  let kind: string;
  if (SOP[sop]) kind = SOP[sop];
  else if (type.includes("LOCALIZER")) kind = "a scout image (topogram), used to plan the scan";
  else if (type[0] === "ORIGINAL") kind = "the images as the scanner made them";
  else if (type[0] === "DERIVED") {
    const how = type.find((t) => /MIP|MPR|MINIP|VOLUME|PROJECTION/.test(t));
    kind = `made from other images${how ? ` (${how.toLowerCase().replace(/_/g, " ")})` : ""}`;
  } else kind = modality ? `${modality} images` : "images";
  const frames = num(g("NumberOfFrames"));
  const pl = plane(g("ImageOrientationPatient"));
  lines.push(`What it is: ${kind}${pl && !type.includes("LOCALIZER") && !SOP[sop] ? `, ${pl}` : ""} · ${count} file${count === 1 ? "" : "s"}${frames && frames > 1 ? `, ${frames} frames` : ""}.`);

  // THE GEOMETRY
  const geo: string[] = [];
  const th = num(g("SliceThickness"));
  if (th) geo.push(`slices ${mm(th)} thick`);
  const sp = num(g("SpacingBetweenSlices"));
  if (sp) geo.push(`every ${mm(Math.abs(sp))}`);            // Philips writes it negative
  const px = num(g("PixelSpacing")), rows = g("Rows"), cols = g("Columns");
  if (px) geo.push(`pixels ${mm(px)}${rows && cols ? ` (${cols} × ${rows})` : ""}`);
  else if (rows && cols) geo.push(`${cols} × ${rows} pixels`);
  if (geo.length) lines.push(`Size: ${geo.join(" · ")}.`);

  // HOW IT WAS MADE
  const how: string[] = [];
  const kernel = g("ConvolutionKernel");
  if (kernel) how.push(`filter ${kernel.split("\\")[0]}`);
  if (modality === "CT" || g("KVP")) {
    const kv = num(g("KVP")); if (kv) how.push(`${kv} kV`);
    const ctdi = num(g("CTDIvol")); if (ctdi) how.push(`dose (CTDIvol) ${+ctdi.toFixed(1)} mGy`);
  }
  if (modality === "MR") {
    const b0 = num(g("MagneticFieldStrength")); if (b0) how.push(`${b0} T`);
    const tr = num(g("RepetitionTime")); if (tr) how.push(`TR ${+tr.toFixed(1)} ms`);
    const te = num(g("EchoTime")); if (te) how.push(`TE ${+te.toFixed(1)} ms`);
    const seq = g("SequenceName"); if (seq) how.push(`sequence ${seq}`);
  }
  const contrast = g("ContrastBolusAgent");
  if (contrast && /^contrast$/i.test(contrast.trim())) how.push("with contrast");
  else if (contrast && !/^(undefined|none|unknown)$/i.test(contrast)) how.push(`contrast: ${contrast}`);
  if (how.length) lines.push(`How: ${how.join(" · ")}.`);

  const pos = g("PatientPosition");
  const when = time(g("SeriesTime"));
  const lay = [pos ? POSITION[pos] ?? pos : undefined, when ? `at ${when}` : undefined].filter(Boolean);
  if (lay.length) lines.push(`Patient: ${lay.join(", ")}.`);
  const made = [g("Manufacturer"), g("ManufacturerModelName")].filter(Boolean).join(" ");
  const deriv = g("DerivationDescription");
  const protocol = g("ProtocolName");
  const by = [made ? `by ${made}` : undefined, protocol ? `protocol ${protocol}` : undefined, deriv ? `"${deriv}"` : undefined].filter(Boolean);
  if (by.length) lines.push(`Made ${by.join(" · ")}.`);
  return lines.join("\n");
}
