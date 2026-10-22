// HOW FAST THE 3D VIEW FOLLOWS A TURN, AS A PERSON SEES IT (Ron, 2026-10-17: "I am not interested to compare windows but
// that the fps numbers are correct … I would like to replace perception with hard numbers based on the correct
// measurements"; the critic's count against an independent one, qa/2026-10-17-fps-measurement.md).
//
// Counted: NEW pictures -- each one shows a change (the camera or the content) the one before did not; the 3D view no
// longer draws an unchanged view again (accum-loop.ts), so every picture it finishes while the view moves is one.
// The clock starts at the first change of the turn, so the first picture, always the slowest, counts with its own time,
// and stops at the last picture finished. Besides the rate, what is felt: how long a movement waits before the
// picture shows it (the first movement not yet drawn, to the picture that draws it), and the longest wait between two
// pictures. A turn too short to say anything (under MIN_TURN_MS or MIN_PICTURES) gives no reading.
//
// "Finished" is the card's word (onSubmittedWorkDone), not the screen's: the screen shows the picture at its next
// refresh, up to one refresh (17 ms at 60 Hz) later.

export const MIN_TURN_MS = 500;
export const MIN_PICTURES = 5;

export interface TurnReading {
  /** New pictures in the turn. */
  pictures: number;
  /** From the first change to the last picture finished. */
  seconds: number;
  /** New pictures a second. */
  perSecond: number;
  /** From the first change to the first picture finished. */
  firstMs: number;
  /** How long a movement waited until a picture showed it: the median and the 90th percentile. */
  followMs: number;
  followWorstMs: number;
  /** The longest time between two pictures finished. */
  longestGapMs: number;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

export class TurnMeter {
  private start: number | null = null;
  private done: number[] = [];
  private waited: number[] = [];
  /** A picture: the oldest change it is the first to show (`changeAt`), and when the card finished it. */
  picture(changeAt: number, doneAt: number): void {
    this.start ??= changeAt;
    this.done.push(doneAt);
    this.waited.push(Math.max(0, doneAt - changeAt));
  }
  get count(): number { return this.done.length; }
  /** The reading so far, or null while the turn is too short to say. */
  reading(): TurnReading | null {
    const n = this.done.length;
    if (n < MIN_PICTURES) return null;
    const start = this.start!, last = Math.max(...this.done), ms = last - start;
    if (ms < MIN_TURN_MS) return null;
    const sorted = [...this.done].sort((a, b) => a - b);
    let gap = sorted[0] - start;
    for (let i = 1; i < n; i++) gap = Math.max(gap, sorted[i] - sorted[i - 1]);
    return {
      pictures: n, seconds: ms / 1000, perSecond: n / (ms / 1000), firstMs: sorted[0] - start,
      followMs: pct(this.waited, 0.5), followWorstMs: pct(this.waited, 0.9), longestGapMs: gap,
    };
  }
  reset(): void { this.start = null; this.done = []; this.waited = []; }
}
