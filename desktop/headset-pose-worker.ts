// THE GLASSES' HEAD POSES, RECEIVED ON A THREAD OF THEIR OWN (desktop/headset-viture.ts). VITURE's sensor thread calls
// the pose callback and waits inside it until the JavaScript that owns the callback has run; if that JavaScript were the
// server's, a stop called by the server while a pose waited would wait for the sensor thread forever -- the whole server
// frozen (the critic, 2026-10-13, qa/2026-10-13-vr-ar-glasses.md, finding 1). Owned here, the callback is run by this
// worker's own loop, which does nothing else, so the sensor thread always gets on, and the server can call the SDK's
// stop as before, synchronously and on the thread that started it (VITURE's USB layer must be shut down on the thread
// that opened it: calling it from another thread crashed Albula, 2026-10-13 13:47).
//
// Shared memory (set up by headset-viture.ts): Int32 [0] = poses written so far; Float32 from byte 8 = the newest pose,
// [px, py, pz, qw, qx, qy, qz] in OpenGL axes (rotation only for these glasses: position 0).

const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };
const sab = await new Promise<SharedArrayBuffer>((resolve) => { scope.onmessage = (e) => resolve((e.data as { sab: SharedArrayBuffer }).sab); });
const count = new Int32Array(sab, 0, 1), pose = new Float32Array(sab, 8, 7);
// [roll, pitch, yaw, qw, qx, qy, qz], North-West-Up (x forward, y left, z up) -> OpenGL (x right, y up, z backward):
// right = -left, up = up, backward = -forward, a proper rotation, so (qx, qy, qz) -> (-qy, qz, -qx).
const cb = Deno.UnsafeCallback.threadSafe({ parameters: ["pointer", "u64"], result: "void" } as const, (data) => {
  if (!data) return;
  const v = new Float32Array(Deno.UnsafePointerView.getArrayBuffer(data, 7 * 4).slice(0));
  const [qw, qx, qy, qz] = [v[3], v[4], v[5], v[6]];
  if (![qw, qx, qy, qz].every(Number.isFinite) || (qw === 0 && qx === 0 && qy === 0 && qz === 0)) return;
  pose.set([0, 0, 0, qw, -qy, qz, -qx]);
  Atomics.add(count, 0, 1);
});
scope.postMessage({ pointer: String(Deno.UnsafePointer.value(cb.pointer)) });
