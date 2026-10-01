// The client half of SlicerLive's single persistence store (desktop/settings-file.ts holds the
// server half and the reasoning for the format).
//
// One human-readable INI, sectioned per module, reached over /_settings when the native app serves
// it and falling back to localStorage when it does not — a browser build has no file to write, and
// remembering a panel width there is better than remembering nothing. The fallback is explicitly
// NOT equivalent: localStorage is per-origin, so a value stored in the browser build does not appear
// in the native app. `location()` says which is in use so the UI can be honest about it.
//
// INI rather than JSON because the same file is read by the launcher shell scripts and by the Slicer
// Python module via configparser. A format only one of the three can parse would defeat the point.

const ENDPOINT = "/_settings";
const LOCAL_KEY = "slicerlive-settings-ini";
const SAVE_DEBOUNCE_MS = 300;

export type Ini = Map<string, Map<string, string>>;

/**
 * Parse an INI into sections.
 *
 * Deliberately forgiving: this file is meant to be hand-edited, so a blank line, a comment (`#` or
 * `;`), stray whitespace or a key before any section header must not lose the rest of the file.
 * Keys outside a section land in "General", matching Slicer's own default section.
 */
export function parseIni(text: string): Ini {
  const out: Ini = new Map();
  let section = "General";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim() || "General";
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;                       // not a key/value: ignore rather than abort
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    const value = line.slice(eq + 1).trim();
    if (!out.has(section)) out.set(section, new Map());
    out.get(section)!.set(key, value);
  }
  return out;
}

/** Serialize sections back to INI, sections and keys sorted so diffs stay readable. */
export function formatIni(ini: Ini): string {
  const parts: string[] = [];
  for (const section of [...ini.keys()].sort()) {
    const kv = ini.get(section)!;
    if (!kv.size) continue;
    parts.push(`[${section}]`);
    for (const key of [...kv.keys()].sort()) parts.push(`${key}=${kv.get(key)}`);
    parts.push("");
  }
  return parts.join("\n");
}

export interface SettingsStore {
  /** Where values are kept: the served file's path, or "localStorage". */
  location(): string;
  get(section: string, key: string): string | undefined;
  getNumber(section: string, key: string, fallback: number): number;
  getBool(section: string, key: string, fallback: boolean): boolean;
  /** Set a value. Writes are debounced and coalesced; omit the value to remove the key. */
  set(section: string, key: string, value: string | number | boolean | undefined): void;
  /** Flush any pending write now (e.g. before the page goes away). */
  flush(): Promise<void>;
}

/**
 * Load the store once, at startup.
 *
 * A failed load is not fatal: an unreachable endpoint or unparseable file yields an EMPTY store that
 * still accepts writes, so a corrupt settings file costs the user their preferences but not the
 * application.
 */
export async function openSettings(): Promise<SettingsStore> {
  let ini: Ini = new Map();
  let served = false;
  let path = "localStorage";

  try {
    const r = await fetch(ENDPOINT, { headers: { "cache-control": "no-cache" } });
    if (r.ok) {
      ini = parseIni(await r.text());
      served = true;
      path = r.headers.get("x-settings-path") ?? ENDPOINT;
    }
  } catch { /* no endpoint here: a browser build */ }

  if (!served) {
    try {
      ini = parseIni(globalThis.localStorage?.getItem(LOCAL_KEY) ?? "");
    } catch { /* private mode, or no localStorage at all */ }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const write = async () => {
    const text = formatIni(ini);
    if (served) {
      try {
        await fetch(ENDPOINT, { method: "PUT", body: text });
        return;
      } catch { /* fall through: better in localStorage than nowhere */ }
    }
    try {
      globalThis.localStorage?.setItem(LOCAL_KEY, text);
    } catch { /* quota, private mode */ }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; inFlight = write(); }, SAVE_DEBOUNCE_MS);
  };

  return {
    location: () => path,
    get: (section, key) => ini.get(section)?.get(key),
    getNumber(section, key, fallback) {
      const v = Number(ini.get(section)?.get(key));
      return Number.isFinite(v) ? v : fallback;
    },
    getBool(section, key, fallback) {
      const v = ini.get(section)?.get(key);
      if (v === undefined) return fallback;
      return v === "1" || v.toLowerCase() === "true";
    },
    set(section, key, value) {
      if (value === undefined) {
        ini.get(section)?.delete(key);
      } else {
        if (!ini.has(section)) ini.set(section, new Map());
        ini.get(section)!.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
      }
      schedule();
    },
    async flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; await write(); }
      await inFlight;
    },
  };
}
