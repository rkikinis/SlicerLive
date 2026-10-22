// WHICH STEP FAILED, AND HOW LONG THE PICTURES TAKE (Ron, 2026-10-16, after the glasses stopped drawing with the beating
// heart: "can you add more instrumentation so you can get more information about the failure and performance.
// Remember, we want greased lightning").
//
// A graphics error reported through the device's "uncapturederror" event says what went wrong but not where: the views
// "stopped drawing" with "GPUCanvasContext is not configured correctly" and nothing to say whether the desk's 3D view,
// the glasses or a slice view asked for it. Each named step of drawing runs inside an error scope here; an error is
// written to the session log under the step's name, at most once every few seconds per step and kind, with a count of
// the ones held back -- and still raised as a failure of the views, as before, so the window says it stopped.
//
// And the time each picture takes on the card, per kind, for the session log's "play" line.

const QUIET_MS = 5000;
const said = new Map<string, { at: number; held: number }>();

function tell(name: string, kind: string, message: string): void {
  const k = `${name}|${kind}`, now = Date.now(), s = said.get(k);
  if (s && now - s.at < QUIET_MS) { s.held++; return; }
  const held = s?.held ?? 0;
  said.set(k, { at: now, held: 0 });
  const line = `graphics error in ${name} (${kind}): ${message}${held ? ` -- and ${held} more like it since the last line` : ""}`;
  try { void fetch("/_log", { method: "POST", body: line, keepalive: true }).catch(() => {}); } catch { /* no server */ }
  console.error(line);
  (globalThis as unknown as { __onGpuFailure?: (w: string, d: string) => void }).__onGpuFailure?.(`${kind} in ${name}`, message);
}

/** Run `fn` (synchronous GPU work: encoding and submitting) inside validation and out-of-memory error scopes named
 *  `name`. What it returns is returned; errors are reported, never thrown. */
export function gpuScoped<T>(dev: GPUDevice, name: string, fn: () => T): T {
  if (!dev.pushErrorScope) return fn();
  dev.pushErrorScope("out-of-memory");
  dev.pushErrorScope("validation");
  try { return fn(); }
  finally {
    void dev.popErrorScope().then((e) => { if (e) tell(name, "validation", e.message); }).catch(() => {});
    void dev.popErrorScope().then((e) => { if (e) tell(name, "out of memory", e.message); }).catch(() => {});
  }
}

/** Pictures drawn per kind since the last read, with their time on the card (submit to done), for the "play" line. */
const timing = new Map<string, { n: number; sum: number; max: number }>();
export function notePicture(kind: string, ms: number): void {
  const t = timing.get(kind) ?? { n: 0, sum: 0, max: 0 };
  t.n++; t.sum += ms; t.max = Math.max(t.max, ms);
  timing.set(kind, t);
}
/** What notePicture gathered, as words, and forgotten: "desk 3D 8 pictures, mean 31 ms, worst 74 ms; …". */
export function takePictureTimes(): string {
  const f = (ms: number) => ms < 10 ? ms.toFixed(2) : ms.toFixed(0);       // a slice picture on the card is under a millisecond
  const parts = [...timing].filter(([, t]) => t.n).map(([k, t]) => `${k} ${t.n} picture${t.n === 1 ? "" : "s"}, mean ${f(t.sum / t.n)} ms, worst ${f(t.max)} ms`);
  timing.clear();
  return parts.join("; ");
}
/** Counted events (a series step rebound, the 3D view composed again) since the last read. */
const counts = new Map<string, number>();
export function count(what: string): void { counts.set(what, (counts.get(what) ?? 0) + 1); }
export function takeCounts(): string {
  const s = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
  counts.clear();
  return s;
}
(globalThis as unknown as Record<string, unknown>).__gpuScope = { takePictureTimes, takeCounts };

/** THE CARD'S OWN TIME FOR A PICTURE MADE OF SEVERAL PASSES (Ron, 2026-10-16: the slice views' "submit to done" was
 *  140-170 ms while the heart played, which may be their own work or the wait behind the 3D picture in the same queue).
 *  Between begin() and end(), each pass that spreads writes() into its descriptor gets a pair of timestamps from the
 *  card's clock; end() reads them back and notes the SUM of the passes' own durations under `kind` -- the time the card
 *  spent on this picture, without the time it spent on anything else in between. One picture measured at a time; the
 *  pictures drawn while one is being read back are not measured. Nothing at all on a card without timestamp-query. */
export class PassClock {
  private static readonly PASSES = 16;
  private qs: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readBuf: GPUBuffer | null = null;
  private armed = false;
  private busy = false;
  private n = 0;
  constructor(private dev: GPUDevice) {}
  begin(): void {
    this.armed = !this.busy && this.dev.features.has("timestamp-query");
    this.n = 0;
    if (this.armed && !this.qs) {
      const k = PassClock.PASSES * 2;
      this.qs = this.dev.createQuerySet({ type: "timestamp", count: k });
      this.resolveBuf = this.dev.createBuffer({ size: k * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.readBuf = this.dev.createBuffer({ size: k * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
  }
  /** Spread into a render pass's descriptor: `{...clock.writes(), colorAttachments: …}`. */
  writes(): { timestampWrites?: GPURenderPassTimestampWrites } {
    if (!this.armed || this.n >= PassClock.PASSES) return {};
    const i = this.n++;
    return { timestampWrites: { querySet: this.qs!, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } };
  }
  end(kind: string): void {
    if (!this.armed) return;
    this.armed = false;
    const n = this.n;
    if (!n) return;
    this.busy = true;
    const enc = this.dev.createCommandEncoder();
    enc.resolveQuerySet(this.qs!, 0, 2 * n, this.resolveBuf!, 0);
    enc.copyBufferToBuffer(this.resolveBuf!, 0, this.readBuf!, 0, 2 * n * 8);
    this.dev.queue.submit([enc.finish()]);
    const read = this.readBuf!;
    read.mapAsync(GPUMapMode.READ, 0, 2 * n * 8).then(() => {
      const t = new BigUint64Array(read.getMappedRange(0, 2 * n * 8).slice(0));
      read.unmap();
      let sum = 0;
      for (let i = 0; i < n; i++) sum += Number(t[2 * i + 1] - t[2 * i]) / 1e6;
      if (Number.isFinite(sum) && sum >= 0 && sum < 10000) notePicture(kind, sum);
      else count(`${kind}: impossible clock readings`);
    }).catch(() => { /* a lost device: not measured */ }).finally(() => { this.busy = false; });
  }
}
