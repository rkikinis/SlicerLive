// WHERE AN EXTENSION'S MODULES JOIN THE APP (Ron, 2026-09-29: "keep things as modular as possible. We will do
// extensions down the road"). Core never imports an extension (sdk/boundary.test.ts); an extension reaches this queue
// through the SDK and hands its registration to it. The app drains the queue once its own modules are registered, with
// the same things every module is given; anything queued later is registered at once.
//
//   // in an extension (Contents/docs/EXTENSIONS.md in the workspace):
//   import { queueModule } from "albula";
//   queueModule((ctx) => registerDiffusionPanel(ctx));
//
// The rebuild generates the application's entry from the workspace's list of extensions: each extension's hooks and
// module, then core's app.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";
import type { LocalBlobStore } from "../../logic/ingest.ts";

export interface ModuleContext {
  shell: AppShell;
  live: LiveScene;
  store: LocalBlobStore;
  /** The one graphics device the views draw with; a module's own GPU work and 3D fields use it. */
  device: GPUDevice;
  /** The status bar at the bottom of the window (visible), and the session log. */
  status: (s: string) => void;
}
type Register = (ctx: ModuleContext) => void;
const KEY = "__albulaModules";
type Slot = { queued: Register[]; ctx?: ModuleContext };
const slot = (): Slot => ((globalThis as Record<string, unknown>)[KEY] ??= { queued: [] }) as Slot;

/** An extension hands over its module registration; it runs when the app is ready (or now, if it already is). */
export function queueModule(register: Register): void {
  const s = slot();
  if (s.ctx) run(register, s.ctx); else s.queued.push(register);
}

/** Called once by the app, after its own modules are registered. */
export function registerQueuedModules(ctx: ModuleContext): void {
  const s = slot();
  s.ctx = ctx;
  for (const r of s.queued.splice(0)) run(r, ctx);
}

function run(r: Register, ctx: ModuleContext) {
  try { r(ctx); } catch (e) { ctx.status(`A module could not be added: ${(e as Error).message ?? e}`); console.error(e); }
}
