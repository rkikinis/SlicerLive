// SHOWN AND HIDDEN, DRAWN AS AN OPEN AND A CLOSED EYE (Ron, 2026-10-31: "in many of the lists in segmentations and
// diffusion albula is using the general prohibition sign for invisible. In our domain the consensus is open eye and
// closed eye. dimming is not used normally"). One drawing for every list -- Segmentations, the Segment Editor, Crop, the
// scene list, the AI module, and the diffusion extension through the SDK -- so they cannot drift apart. Drawn in the
// text color (no emoji: an emoji's colors and size change with the system font), never faded: a hidden row is said by
// the closed eye, not by fading it. "some": the open eye with an empty pupil, for a group in which only some are shown.
export type EyeState = "shown" | "hidden" | "some";

const OPEN = `<path d="M1.5 8C3.4 4.6 5.6 3.2 8 3.2S12.6 4.6 14.5 8C12.6 11.4 10.4 12.8 8 12.8S3.4 11.4 1.5 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>`;
const SVG = (body: string) => `<svg class="sl-eye" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;

/** The eye as inline SVG markup, for a button's innerHTML. */
export function eyeSvg(state: EyeState): string {
  if (state === "hidden") {
    return SVG(`<path d="M1.5 7C3.4 10 5.6 11.3 8 11.3S12.6 10 14.5 7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>` +
      `<path d="M3.6 9.2L2.6 11M6.2 10.9L5.8 12.9M9.8 10.9L10.2 12.9M12.4 9.2L13.4 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`);
  }
  return SVG(OPEN + (state === "some"
    ? `<circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/>`
    : `<circle cx="8" cy="8" r="2.3" fill="currentColor"/>`));
}
