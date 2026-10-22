// AN EXTENSION'S OWN STATE IN A SAVED SCENE (Ron, 2026-10-21: "yes, build the scene state for extensions", after a scene
// of Steve's Prisma scan came back with the FastSurfer brain and the diffusion scan but without the tracts it showed).
// The scene's nodes hold what core knows -- volumes, segmentations, views, displays -- and nothing of what an extension
// shows on its own (the Diffusion module's tracts, its Color FA over the T1). So an extension registers a handler here:
// `save` gives its state as plain JSON, keyed by durable identities (series UIDs, the tract atlas's abbreviations), never
// by this session's node ids; `restore` puts it back after the scene's series have arrived.
//
// THE FILE: glTF's pattern, which mrson's `extensionsUsed` follows (Steve's docs/MRSON-STRESS-TEST.md): a top-level
// `extensions` object, one block per extension under its name, `{ v, state }`, and `<name>/<v>` in `extensionsUsed`. An
// extension that is not installed in the window opening the scene IGNORES its block, and the block is CARRIED: kept as
// it was read and written back unchanged on the next save, so a window without the extension does not erase it.
// A scene with no block for an installed extension (one saved before this, or without it) gets `restore(undefined)`: the
// extension decides (the diffusion extension shows what a load of the scan shows).
//
// VERSIONED (CLAUDE.md, "modular and versioned"): each handler has its own `version`; the block records the version that
// wrote it, and `restore` is handed it, to read an older block or say it cannot.
//
// Registry on globalThis, as the volume interpreters' (readers/volume-interpreters.ts): the extension's bundle and core's
// must see one list.

/** What an extension keeps in a scene. */
export interface SceneStateHandler {
  /** The extension's name, the block's key: "albula-diffusion". */
  name: string;
  /** The version of the state this handler writes (an integer, raised when the state's form changes). */
  version: number;
  /** Its state now, as plain JSON; undefined when it shows nothing worth keeping (no block is written). */
  save(): unknown | undefined;
  /** Put back the state a scene holds (`state` undefined: the scene has no block for this extension). Called once, after
   *  the scene's series have arrived and core's saved state is back. Says what it put back and what it could not. */
  restore(state: unknown | undefined, version: number | undefined): Promise<RestoredExtension> | RestoredExtension;
}
export interface RestoredExtension { applied?: string[]; missing?: string[] }

/** A block as the file holds it. */
export interface ExtensionBlock { v: number; state: unknown }

const KEY = "__albulaSceneStateHandlers";
const CARRIED = "__albulaSceneStateCarried";
const list = (): SceneStateHandler[] => ((globalThis as Record<string, unknown>)[KEY] ??= []) as SceneStateHandler[];
const carried = (): Map<string, ExtensionBlock> => ((globalThis as Record<string, unknown>)[CARRIED] ??= new Map()) as Map<string, ExtensionBlock>;

/** SDK: an extension's state in saved scenes. Registering the same name again replaces it. */
export function registerSceneState(h: SceneStateHandler): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(h.name)) throw new Error(`a scene-state name is lowercase letters, digits and hyphens: "${h.name}"`);
  if (!Number.isInteger(h.version) || h.version < 1) throw new Error(`a scene-state version is a whole number from 1: ${h.version}`);
  const l = list(), at = l.findIndex((x) => x.name === h.name);
  if (at >= 0) l[at] = h; else l.push(h);
}

/** The blocks to write: every handler's state now, and the blocks carried from the scene that was opened for extensions
 *  this window does not have. A handler that throws writes no block (and the save goes on): its failure is said. */
export function collectExtensionState(): { extensions: Record<string, ExtensionBlock>; used: string[]; failed: string[] } {
  const extensions: Record<string, ExtensionBlock> = {}, failed: string[] = [];
  const mine = new Set(list().map((h) => h.name));
  for (const h of list()) {
    try {
      const state = h.save();
      if (state !== undefined) extensions[h.name] = { v: h.version, state: JSON.parse(JSON.stringify(state)) };
    } catch (e) { failed.push(`${h.name}: ${(e as Error).message}`); }
  }
  for (const [name, b] of carried()) if (!mine.has(name)) extensions[name] = b;
  const used = Object.entries(extensions).map(([name, b]) => `${name}/${b.v}`);
  return { extensions, used, failed };
}

/** The blocks of a scene file, read with care: a block that is not `{ v: integer, state }` is left out and named. */
export function extensionBlocks(doc: Record<string, unknown>): { blocks: Map<string, ExtensionBlock>; bad: string[] } {
  const blocks = new Map<string, ExtensionBlock>(), bad: string[] = [];
  const ex = doc.extensions;
  if (ex === undefined) return { blocks, bad };
  if (!ex || typeof ex !== "object" || Array.isArray(ex)) return { blocks, bad: ["extensions is not an object"] };
  for (const [name, b] of Object.entries(ex as Record<string, unknown>)) {
    const v = (b as { v?: unknown } | null)?.v;
    if (!b || typeof b !== "object" || !Number.isInteger(v) || !("state" in (b as object))) { bad.push(name); continue; }
    blocks.set(name, { v: v as number, state: (b as ExtensionBlock).state });
  }
  return { blocks, bad };
}

/**
 * Opening a scene: each installed extension's `restore` with its block (or undefined), in registration order; the blocks
 * of extensions not installed here are carried for the next save. Never throws: what could not be put back is in
 * `missing`, with the extension's name.
 */
export async function restoreExtensionState(doc: Record<string, unknown>): Promise<{ applied: string[]; missing: string[] }> {
  const { blocks, bad } = extensionBlocks(doc);
  const applied: string[] = [], missing: string[] = bad.map((n) => `${n}: its saved state could not be read`);
  const c = carried(); c.clear();
  const mine = new Set(list().map((h) => h.name));
  for (const [name, b] of blocks) if (!mine.has(name)) { c.set(name, b); missing.push(`${name}: not installed here (its state is kept for the next save)`); }
  for (const h of list()) {
    const b = blocks.get(h.name);
    try {
      const r = await h.restore(b?.state, b?.v);
      for (const a of r.applied ?? []) applied.push(a);
      for (const m of r.missing ?? []) missing.push(`${h.name}: ${m}`);
    } catch (e) { missing.push(`${h.name}: ${(e as Error).message}`); }
  }
  return { applied, missing };
}

/** Closing the scene: nothing carried any longer. */
export function forgetCarriedExtensionState(): void { carried().clear(); }
