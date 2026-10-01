// THE MESSAGES THAT SCROLLED PAST, kept for one session.
//
// The application has a single status line and every message overwrites the last one, so a load
// that reports scanning, then reconstructing, then how long it took, then how many surfaces came
// back, leaves only the final sentence. Ron: "There were a bunch of messages during the loading,
// but they disappeared." The load timer was unreadable for exactly this reason -- it was overwritten
// by the surfaces message a moment later.
//
// This is a DIAGNOSTIC, not the answer to that. A person should never have to open a log file to
// find out what an application did; the notification design in docs/CONSTRAINTS.md is what owes them
// that, and this does not discharge it. What this gives is a way to ask "what did it say?" after the
// fact, for us.
//
// RESET EACH START, KEEPING ONE. An unbounded log becomes the thing you scroll past -- there is
// already a 788 KB watcher log in the workspace that nobody reads. But the moment you most want a
// log is after something went wrong, and the reflex when something goes wrong is to restart, which
// would erase it. So the previous session moves to .1 and exactly one is kept.
const CONFIG_DIR = Deno.env.get("SLICERLIVE_CONFIG_DIR") ?? `${Deno.env.get("HOME")}/.config/slicerlive`;
const LOG = `${CONFIG_DIR}/albula-session.log`;
const PREV = `${LOG}.1`;

let file: Deno.FsFile | null = null;
const enc = new TextEncoder();

/** Local time, seconds. A log stamped in UTC is one more thing to convert while reading it. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function write(line: string): void {
  if (!file) return;
  try {
    file.writeSync(enc.encode(`${stamp()}  ${line}\n`));
  } catch { /* a log that throws is worse than a log that stops */ }
}

/** Rotate, open, and write the header. Safe to call when the directory does not exist yet. */
export function startSessionLog(note: string): string | null {
  try {
    Deno.mkdirSync(CONFIG_DIR, { recursive: true });
    try { Deno.renameSync(LOG, PREV); } catch { /* first run, or nothing to keep */ }
    file = Deno.openSync(LOG, { write: true, create: true, truncate: true });
    write(`=== SlicerAlbula session start — ${note}`);
    // THE RUNTIME THIS APP RUNS ON: `deno compile` puts Deno inside the binary, from whatever was installed on build
    // day, and nothing else records it (critic, qa/2026-09-28-dependencies.md, finding 3). Read from the running
    // process, so it is the version that actually runs.
    write(`=== runtime: Deno ${Deno.version.deno} (V8 ${Deno.version.v8}, TypeScript ${Deno.version.typescript})`);
    write(`=== previous session, if any: ${PREV}`);
    return LOG;
  } catch {
    file = null;              // read-only home, sandbox, whatever: the app must still run
    return null;
  }
}

/**
 * POST /_log with the message as the body. Answers 204 and nothing else.
 *
 * The page is the only thing that knows what reached the status bar, so it has to send them. Kept
 * deliberately dumb -- no levels, no JSON, no structure -- because the value is "what did it say, in
 * order", and anything more becomes a format to maintain.
 */
export function handleLogRequest(req: Request): Promise<Response> | null {
  const url = new URL(req.url);
  if (url.pathname !== "/_log") return null;
  if (req.method !== "POST") return Promise.resolve(new Response("POST only", { status: 405 }));
  return req.text().then((t) => {
    for (const line of t.split("\n")) if (line.trim()) write(line.trim());
    return new Response(null, { status: 204 });
  });
}
