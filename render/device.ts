// WebGPU device init — identical in the browser and in Deno (same navigator.gpu).
// Requests float32-filterable so scalar volumes can be r32float 3D textures
// sampled with a filtering (trilinear) sampler.

import { gpuLedgerLine, installGpuLedger } from "./gpu-ledger.ts";

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  features: Set<string>;
}

export async function initDevice(): Promise<Gpu> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) throw new Error("WebGPU not available (need Chrome/Edge/Safari or Deno --unstable-webgpu)");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  // timestamp-query is opt-in profiling infra (SceneRenderer.timePass); harmless when
  // absent. It gives exact GPU pass duration — the honest signal that the async
  // performance.now() around submit() cannot provide.
  // shader-f16 lets compute users (the livecodec WGSL decoder) share this device;
  // optional — consumers check gpu.features and fall back to f32 kernels without it.
  const want = ["float32-filterable", "timestamp-query", "shader-f16"]
    .filter((f) => adapter.features.has(f)) as GPUFeatureName[];

  // Real medical volumes are large: CTACardio is 512x512x321 -> a 336 MB r32float
  // texture, whose writeTexture staging buffer exceeds Chrome's DEFAULT maxBufferSize
  // (256 MB). Deno/wgpu defaults higher, which is why headless never hit this. Raise the
  // size-related limits to the adapter's maximum so large single volumes upload and bind.
  const lim = adapter.limits;
  const requiredLimits: Record<string, number> = {};
  const raise = (k: keyof GPUSupportedLimits) => {
    const v = lim[k] as number | undefined;
    if (typeof v === "number") requiredLimits[k] = v;
  };
  raise("maxBufferSize");
  raise("maxStorageBufferBindingSize");
  raise("maxTextureDimension3D");
  // AND HOW MANY BUFFERS A SHADER MAY BIND. The default is eight, which is enough for drawing and
  // not enough for a pipeline that carries its own working state: the GPU surface extraction
  // (algorithms/surface-nets-gpu.ts) binds fifteen. Metal allows 31 here; asking for the adapter's
  // maximum costs nothing and fails nothing, and a device that offers only eight would simply get
  // eight -- the extraction is the only thing that needs more, and it checks.
  raise("maxStorageBuffersPerShaderStage");

  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits });
  // Every texture and buffer recorded, so what holds the graphics memory can be named (gpu-ledger.ts).
  installGpuLedger(device);
  (globalThis as unknown as { __gpuLedgerLine?: typeof gpuLedgerLine }).__gpuLedgerLine = gpuLedgerLine;

  // A LOST DEVICE MUST NOT BE SILENT.
  //
  // Ron, three times over one evening: "the data disappeared", "everything disappeard", "no images"
  // -- each time with the window still open and the process alive. Nothing in this application
  // listened for either of the two ways WebGPU reports that it has stopped working, so a lost device
  // looked exactly like a bug in whatever he had just clicked, and we chased the wrong thing for
  // hours. The trigger he eventually isolated is loading a SECOND segmentation, and on a 768x768x709
  // volume each one is a 418 MB labelmap plus its 3D texture and slice overlay, on top of the CT and
  // the volume rendering.
  //
  // This does not stop the device being lost. It makes it SAY so, which is the difference between a
  // diagnosis and an evening.
  const report = (what: string, detail0: string) => {
    const g = globalThis as unknown as { __gpuFailure?: { what: string; detail: string; at: string }[]; __gpuMB?: number; __last3DFields?: { volume: string | null; keys: string[] } };
    // What the 3D view was compositing and how much the GPU held: the two facts a report of
    // "stopped drawing" needs and never had.
    const l = g.__last3DFields;
    const detail = `${detail0}${l ? ` — 3D: ${l.volume ?? "no volume"}; ${l.keys.join(", ") || "no fields"}` : ""}${typeof g.__gpuMB === "number" ? ` — GPU ~${g.__gpuMB} MB` : ""}`;
    (g.__gpuFailure ??= []).push({ what, detail, at: new Date().toISOString() });
    console.error(`WebGPU ${what}: ${detail}`);
    // The shell shows this if it is listening; the console and __gpuFailure remain either way, so a
    // failure before any UI exists is still recoverable after the fact.
    (globalThis as unknown as { __onGpuFailure?: (w: string, d: string) => void }).__onGpuFailure?.(what, detail);
  };
  device.lost.then((info) => {
    // "destroyed" is us calling device.destroy() on teardown; anything else is a real loss.
    if (info.reason !== "destroyed") report("device lost", `${info.reason}: ${info.message}`);
  });
  device.addEventListener?.("uncapturederror", (e) => {
    const err = (e as GPUUncapturedErrorEvent).error;
    report("error", String((err as { message?: string })?.message ?? err));
  });

  return { adapter, device, features: new Set(want) };
}
