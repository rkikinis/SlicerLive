// THE DATA PROBE READOUT, at the bottom of the module space.
//
// Ron: "Probe location should be changed to a box at the bottom of the module space." And: "If there
// are multiple data sets in the scene, all of the values at that location get listed." And, on
// finding it reported one of two: "When you look at the gluteus medius right it has labels displayed
// from both segmentations but the probe only shows one."
//
// So: a row per dataset drawn at that point, each with the segment it found there, its own color,
// and ITS OWN image coordinates -- a specialized network has a different grid from a whole-body one,
// so one RAS point is two different voxels.
//
// It sits in the sidebar BELOW the module panels rather than inside one, so it does not disappear
// when you switch modules -- the same place Slicer's Data Probe occupies, and for the same reason:
// what is under the pointer is a question you ask while doing something else.
//
// Not a clone of Slicer's, though it converges on the same shape for the same reasons. Slicer lists
// its three composite layers (L/F/B) by name, IJK and value, then asks each displayable manager for
// a line. This lists whatever is drawn here, of either kind, with no privileged dataset -- Ron: "I
// just mention now to remind you that you should not design for single anything."
//
// Still deferred: probing the VOLUME RENDERING away from any slice. Ron: "I want to be able to probe
// volumes as well, but lets defer that for later." The grayscale values below are the ones on the
// slice, which is a texel lookup; the 3D question is which sample along a ray you mean, and that is
// a design decision rather than plumbing.
import type { ProbeReading } from "../moduleserver/live-views.ts";

const CSS = `
.sl-probe { border-top: 1px solid var(--sl-border); padding: 9px 12px 12px; flex: none;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--sl-fg-dim);
  /* ROOM FOR WHAT IT ACTUALLY SAYS. Ron: "the probe needs more space by default." Two segmentations
     and a background volume is three rows plus their source lines plus the position -- and the box
     was sized for none of them, so it grew and shrank under the pointer and clipped when full.
     min-height holds the space whether or not the pointer is over data, so nothing below it moves;
     resize gives the handle for a run with more datasets than this. */
  min-height: 132px; max-height: 40vh; overflow-y: auto; resize: vertical; }
/* Collapsed to its heading: one line, the space goes back to the module (the heading toggles it). */
.sl-probe.sl-probe-closed { min-height: 0; height: auto; resize: none; padding-bottom: 8px; }
.sl-probe.sl-probe-closed > :not(.sl-probe-h) { display: none; }
.sl-probe-h { font: 600 10px -apple-system, system-ui, sans-serif; letter-spacing: .06em;
  text-transform: uppercase; opacity: .6; margin-bottom: 6px; cursor: pointer; user-select: none; }
.sl-probe-h::before { content: "▾ "; }
.sl-probe-closed .sl-probe-h::before { content: "▸ "; }
.sl-probe-closed .sl-probe-h { margin-bottom: 0; }
.sl-probe-pos { color: var(--sl-fg); }
.sl-probe-hint { opacity: .5; font-style: italic; }
.sl-probe-row { display: flex; align-items: baseline; gap: 6px; margin-top: 4px; white-space: nowrap; }
.sl-probe-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; align-self: center;
  border: 1px solid var(--sl-scrim); }
.sl-probe-seg { color: var(--sl-fg); overflow: hidden; text-overflow: ellipsis; }
.sl-probe-none { opacity: .45; }
.sl-probe-ijk { margin-left: auto; opacity: .55; flex: none; }
.sl-probe-layer { width: 8px; flex: none; align-self: center; text-align: center; opacity: .55;
  font: 600 9px -apple-system, system-ui, sans-serif; }
.sl-probe-src { display: block; opacity: .5; font: 10px/1.4 -apple-system, system-ui, sans-serif;
  margin: 1px 0 5px; overflow: hidden; text-overflow: ellipsis; }
`;

/** R or L, A or P, S or I — the letter that matches the sign, as Slicer's view line does. */
function rasText(ras: [number, number, number]): string {
  const ax = (v: number, pos: string, neg: string) => `${v >= 0 ? pos : neg} ${Math.abs(v).toFixed(1)}`;
  return `${ax(ras[0], "R", "L")}  ${ax(ras[1], "A", "P")}  ${ax(ras[2], "S", "I")}`;
}

/** A stored scalar as text: integers as integers, so Hounsfield units do not grow six decimals. */
function fmtValue(v?: number): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

const hex = (c?: [number, number, number]) =>
  c ? "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("") : "var(--sl-fg-dim)";

/**
 * Mount the readout into `sidebar` (appended last, so it stays at the bottom) and subscribe.
 * Returns an unsubscribe.
 */
export function mountProbeBox(sidebar: HTMLElement): () => void {
  if (!document.getElementById("sl-probe-css")) {
    const st = document.createElement("style");
    st.id = "sl-probe-css";
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const box = document.createElement("div");
  box.className = "sl-probe";
  sidebar.appendChild(box);
  // Collapsible by its heading, remembered per browser (a per-viewer convenience).
  const CLOSED_KEY = "albula.probe.closed";
  let closed = false;
  try { closed = localStorage.getItem(CLOSED_KEY) === "1"; } catch { /* private window */ }
  const applyClosed = () => box.classList.toggle("sl-probe-closed", closed);
  applyClosed();
  box.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".sl-probe-h")) return;
    closed = !closed; applyClosed();
    try { localStorage.setItem(CLOSED_KEY, closed ? "1" : "0"); } catch { /* private window */ }
  });

  const draw = (p: ProbeReading | null) => {
    const head = `<div class="sl-probe-h" title="${closed ? "Click to show what is under the pointer" : "Click to fold this away"}">Data probe</div>`;
    if (!p) {
      box.innerHTML = head + `<div class="sl-probe-hint">point at a slice</div>`;
      return;
    }
    // WHAT IS THERE, not what is not. With four segmentations loaded the box was four lines of
    // "none" under one value; the structures under the pointer are the answer, and one line says
    // how many segmentations were looked at and found nothing. Ron: "the probe is even worse."
    const segRows = p.rows.filter((r) => r.kind === "segmentation");
    const hits = segRows.filter((r) => r.segment);
    const misses = segRows.length - hits.length;
    const shown = p.rows.filter((r) => r.kind !== "segmentation" || r.segment);
    const noneLine = misses
      ? `<div class="sl-probe-row"><span class="sl-probe-none">${hits.length ? `no other structure here` : `no structure here`} <span class="sl-probe-ijk">(${misses} segmentation${misses === 1 ? "" : "s"} looked at)</span></span></div>`
      : "";
    const rows = shown.map((r) => {
      const main = r.kind === "image"
        // The value as it is stored: an integer prints as one (Hounsfield units are integers, and
        // "-27.000000" reads as a measurement it is not), a float keeps three places.
        ? `<span class="sl-probe-layer">${r.layer ?? ""}</span>` +
          // A color image says its color: a swatch and red, green, blue (0..255).
          (r.rgb
            ? `<span class="sl-probe-dot" style="background:rgb(${r.rgb.join(",")})"></span><span class="sl-probe-seg">red ${r.rgb[0]} · green ${r.rgb[1]} · blue ${r.rgb[2]}</span>`
            : `<span class="sl-probe-seg">${fmtValue(r.value)}</span>`)
        : (r.segment
          ? `<span class="sl-probe-dot" style="background:${hex(r.color)}"></span>` +
            `<span class="sl-probe-seg">${escapeHtml(r.segment)}</span>`
          : `<span class="sl-probe-none">none</span>`);
      const tail = r.kind === "segmentation" && r.label ? ` · label ${r.label}` : "";
      return `<div class="sl-probe-row">${main}` +
        `<span class="sl-probe-ijk">${r.ijk.join(", ")}</span></div>` +
        `<span class="sl-probe-src">${escapeHtml(r.source)}${tail}</span>`;
    }).join("");
    box.innerHTML = head +
      `<div class="sl-probe-pos">${p.cell} &nbsp; ${rasText(p.ras)}</div>` +
      (rows ? rows + noneLine : `<div class="sl-probe-hint">outside every dataset</div>`);
  };

  const hook = (globalThis as unknown as { __onProbe?: (fn: (p: ProbeReading | null) => void) => () => void }).__onProbe;
  const off = hook?.(draw);
  if (!off) draw(null);
  return () => { off?.(); box.remove() };
}

/** Segment names come from a SEG's own metadata, so they are data and never markup. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
