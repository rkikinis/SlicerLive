// VITURE GLASSES AS A HEADSET (desktop/headset.ts's first driver; 2026-10-12, Ron: "Now that everything is working, is
// there a way to streamline the workflow?"). The code of Contents/tools/viture/viture-pose.ts, moved into Albula's own
// server so nobody starts a helper from a terminal.
//
// VITURE's libraries are proprietary and are NOT part of Albula: the person installs VITURE's Glasses SDK and Albula
// loads it from where it is (Contents/docs/viture-bridge-review-2026-09-23.md). Two kinds of glasses:
//  - the earlier ones (VITURE's "Gen1": One, Lite, Pro / Pro XR, Luma, Luma Pro, Luma Cyber; "Gen2": Beast, Pro 2):
//    through the SDK's libglasses directly -- ROTATION ONLY (their sensor has no position);
//  - the Luma Ultra ("Carina"): through Domenico Riggio's bridge when it lies beside the SDK -- position and rotation.
// VITURE's documentation: https://www.viture.com/developer/glasses-sdk/glasses (read 2026-10-12).

/** What the server needs from a headset, whatever its maker. */
export interface HeadsetDriver {
  name: string;
  /** True when it reports rotation only (no position). */
  rotationOnly: boolean;
  /** Start streaming; false when it did not start. */
  start(): Promise<boolean>;
  /** Still plugged in and streaming. */
  active(): boolean;
  /** The newest pose, [px, py, pz (meters), qw, qx, qy, qz], OpenGL axes (x right, y up, z backward), or null. */
  pose(): number[] | null;
  /** The headset's own 3D (one picture per eye, side by side) or 2D mode; 0 = done. */
  set3d(on: boolean): Promise<number>;
  stop(): Promise<void>;
}

export const VITURE_VENDOR = 0x35ca;

/** The product id of VITURE glasses on USB now (macOS's USB registry), if any. */
export function vitureOnUsb(): number | undefined {
  if (Deno.build.os !== "darwin") return undefined;
  try {
    const out = new TextDecoder().decode(new Deno.Command("/usr/sbin/ioreg", { args: ["-p", "IOUSB", "-l", "-w0"], stdout: "piped", stderr: "null" }).outputSync().stdout);
    for (const block of out.split(/\+-o /)) {
      const v = block.match(/"idVendor" = (\d+)/), p = block.match(/"idProduct" = (\d+)/);
      if (v && p && Number(v[1]) === VITURE_VENDOR) return Number(p[1]);
    }
  } catch { /* no registry */ }
  return undefined;
}

/** The glasses' own name on USB ("VITURE Pro XR Glasses" -> "VITURE Pro XR"). */
function usbName(pid: number): string | undefined {
  try {
    const out = new TextDecoder().decode(new Deno.Command("/usr/sbin/ioreg", { args: ["-p", "IOUSB", "-l", "-w0"], stdout: "piped", stderr: "null" }).outputSync().stdout);
    for (const block of out.split(/\+-o /)) {
      const v = block.match(/"idVendor" = (\d+)/), p = block.match(/"idProduct" = (\d+)/), n = block.match(/"USB Product Name" = "([^"]+)"/);
      if (v && p && n && Number(v[1]) === VITURE_VENDOR && Number(p[1]) === pid) return n[1].replace(/\s+Glasses$/i, "");
    }
  } catch { /* no registry */ }
  return undefined;
}

/** The folder holding VITURE's libglasses.dylib, among these (each searched two levels down); undefined if none. */
export function findVitureLibrary(folders: string[]): string | undefined {
  const has = (d: string) => { try { return Deno.statSync(`${d}/libglasses.dylib`).isFile; } catch { return false; } };
  for (const f of folders) {
    if (!f) continue;
    if (has(f)) return f;
    try {
      for (const e of Deno.readDirSync(f)) {
        if (!e.isDirectory) continue;
        const d1 = `${f}/${e.name}`; if (has(d1)) return d1;
        try { for (const e2 of Deno.readDirSync(d1)) if (e2.isDirectory && has(`${d1}/${e2.name}`)) return `${d1}/${e2.name}`; } catch { /* unreadable */ }
      }
    } catch { /* no such folder */ }
  }
  return undefined;
}

const IMU_MODE_POSE = 1, IMU_FREQUENCY_LOW = 0, CARINA = 2;   // VITURE's constants (60 poses a second)

// THE POSE CALLBACK LIVES IN A WORKER OF ITS OWN (headset-pose-worker.ts says why: the critic's finding 1 of 2026-10-13,
// a server frozen for good). Every SDK call stays synchronous, in order, on the server's thread: VITURE's USB layer
// must be shut down on the thread that opened it -- an earlier fix that ran the calls on Deno's spare threads crashed
// Albula at the next Esc (2026-10-13 13:47, in hid_exit). Checked on a stand-in library: with the callback owned by the
// server, a stop after a busy moment hung 3 of 3; owned by the worker, it returned within 12 ms 5 of 5.
let poseWorker: { sab: SharedArrayBuffer; pointer: Promise<Deno.PointerValue> } | null = null;
function poseReceiver() {
  if (poseWorker) return poseWorker;
  const sab = new SharedArrayBuffer(8 + 7 * 4);
  const w = new Worker(new URL("./headset-pose-worker.ts", import.meta.url), { type: "module" });
  const pointer = new Promise<Deno.PointerValue>((resolve) => {
    w.onmessage = (e) => resolve(Deno.UnsafePointer.create(BigInt((e.data as { pointer: string }).pointer)));
  });
  w.postMessage({ sab });
  return (poseWorker = { sab, pointer });
}

/** The libraries, loaded once per folder. */
const libs = new Map<string, { g: ReturnType<typeof loadGlasses>; bridge?: ReturnType<typeof loadBridge> }>();
function loadGlasses(dir: string) {
  return Deno.dlopen(`${dir}/libglasses.dylib`, {
    xr_device_provider_is_product_id_valid: { parameters: ["i32"], result: "i32" },
    xr_device_provider_create: { parameters: ["i32"], result: "pointer" },
    xr_device_provider_get_device_type: { parameters: ["pointer"], result: "i32" },
    xr_device_provider_register_imu_pose_callback: { parameters: ["pointer", "function"], result: "i32" },
    xr_device_provider_initialize: { parameters: ["pointer", "pointer", "pointer"], result: "i32" },
    xr_device_provider_start: { parameters: ["pointer"], result: "i32" },
    xr_device_provider_open_imu: { parameters: ["pointer", "i32", "i32"], result: "i32" },
    xr_device_provider_close_imu: { parameters: ["pointer", "i32"], result: "i32" },
    xr_device_provider_switch_dimension: { parameters: ["pointer", "i32"], result: "i32" },
    xr_device_provider_stop: { parameters: ["pointer"], result: "i32" },
    xr_device_provider_shutdown: { parameters: ["pointer"], result: "i32" },
    xr_device_provider_destroy: { parameters: ["pointer"], result: "void" },
  });
}
function loadBridge(dir: string) {
  return Deno.dlopen(`${dir}/libviture_luma_bridge.dylib`, {
    start_streaming: { parameters: [], result: "i32" },
    stop_streaming: { parameters: [], result: "void" },
    get_current_pose: { parameters: [], result: "pointer" },
    is_streaming_active: { parameters: [], result: "i32" },
    is_device_ready: { parameters: [], result: "i32" },
    set_sbs_display_mode: { parameters: [], result: "i32" },
    set_2d_display_mode: { parameters: [], result: "i32" },
  });
}
function libraries(dir: string) {
  let l = libs.get(dir);
  if (!l) {
    const g = loadGlasses(dir);
    let bridge: ReturnType<typeof loadBridge> | undefined;
    try { if (Deno.statSync(`${dir}/libviture_luma_bridge.dylib`).isFile) bridge = loadBridge(dir); } catch { /* none */ }
    l = { g, bridge }; libs.set(dir, l);
  }
  return l;
}

/** One driver per product id and folder, kept: a callback and a handle are made once. */
const drivers = new Map<string, HeadsetDriver>();

/** The driver for VITURE glasses with this product id, using the SDK in `dir`; null if the SDK does not know them, or
 *  for a Luma Ultra without the bridge beside the SDK. */
export function vitureDriver(dir: string, pid: number): HeadsetDriver | null {
  const key = `${dir}#${pid}`;
  if (drivers.has(key)) return drivers.get(key)!;
  const { g, bridge } = libraries(dir);
  const S = g.symbols;
  if (!S.xr_device_provider_is_product_id_valid(pid)) return null;
  const probe = S.xr_device_provider_create(pid);
  if (!probe) return null;
  const type = S.xr_device_provider_get_device_type(probe);
  S.xr_device_provider_destroy(probe);
  // The model's name from the USB registry (macOS reads it off the glasses: "VITURE Pro XR Glasses").
  const name = usbName(pid) ?? (type === CARINA ? "VITURE Luma Ultra" : "VITURE glasses");
  let d: HeadsetDriver | null;
  if (type === CARINA) d = bridge ? lumaDriver(bridge, name) : null;
  else d = earlierDriver(g, pid, name);
  if (d) drivers.set(key, d);
  return d;
}

/** THE EARLIER GLASSES: create -> register the pose callback -> initialize -> start -> open the IMU in pose mode
 *  (VITURE's documented order). The callback is the pose worker's (above); the newest pose is read from shared memory. */
function earlierDriver(g: ReturnType<typeof loadGlasses>, pid: number, name: string): HeadsetDriver {
  const S = g.symbols;
  const rx = poseReceiver(), count = new Int32Array(rx.sab, 0, 1), shared = new Float32Array(rx.sab, 8, 7);
  let h: Deno.PointerValue = null, streaming = false;
  const close = () => {
    if (!h) return;
    const was = h; h = null; streaming = false;
    try { S.xr_device_provider_close_imu(was, IMU_MODE_POSE); S.xr_device_provider_stop(was); S.xr_device_provider_shutdown(was); } catch { /* */ }
    S.xr_device_provider_destroy(was);
  };
  let lastSeen = Atomics.load(count, 0), quietSince = performance.now(), cbPointer: Deno.PointerValue = null;
  return {
    name, rotationOnly: true,
    start: async () => {
      cbPointer ??= await rx.pointer;
      close();
      const nh = S.xr_device_provider_create(pid);
      if (!nh) return (streaming = false);
      h = nh;
      const steps = [S.xr_device_provider_register_imu_pose_callback(nh, cbPointer), S.xr_device_provider_initialize(nh, null, null),
        S.xr_device_provider_start(nh), S.xr_device_provider_open_imu(nh, IMU_MODE_POSE, IMU_FREQUENCY_LOW)];
      streaming = steps.every((r) => r === 0);
      if (!streaming) close();
      lastSeen = Atomics.load(count, 0); quietSince = performance.now();
      return streaming;
    },
    // Streaming while poses keep arriving; two seconds without one counts as unplugged.
    active: () => { const c = Atomics.load(count, 0); if (c !== lastSeen) { lastSeen = c; quietSince = performance.now(); } return streaming && performance.now() - quietSince < 2000; },
    pose: () => (Atomics.load(count, 0) ? Array.from(shared) : null),
    set3d: (on) => Promise.resolve(h ? S.xr_device_provider_switch_dimension(h, on ? 1 : 0) : -1),
    stop: () => { close(); return Promise.resolve(); },
  };
}

/** THE LUMA ULTRA through Domenico's bridge. */
function lumaDriver(lib: ReturnType<typeof loadBridge>, name: string): HeadsetDriver {
  const L = lib.symbols;
  return {
    name, rotationOnly: false,
    start: () => { if (L.is_streaming_active()) L.stop_streaming(); return Promise.resolve(L.start_streaming() === 0); },
    active: () => !!L.is_streaming_active(),
    pose: () => {
      const p = L.get_current_pose(); if (!p) return null;
      const v = Array.from(new Float32Array(Deno.UnsafePointerView.getArrayBuffer(p, 7 * 4).slice(0)));
      return v.every(Number.isFinite) && !(v[3] === 0 && v[4] === 0 && v[5] === 0 && v[6] === 0) ? v : null;
    },
    set3d: (on) => Promise.resolve(on ? (L.is_device_ready() ? L.set_sbs_display_mode() : -1) : L.set_2d_display_mode()),
    stop: () => { L.stop_streaming(); return Promise.resolve(); },
  };
}
