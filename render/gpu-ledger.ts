// THE GRAPHICS MEMORY LEDGER: every texture and buffer this page creates on the GPU, with its size and
// the functions that made it, until it is destroyed or collected.
//
// Why it exists. Ron's full-case run, 2026-09-23: WebKit's page process peaked at 12 GB, of which
// macOS's `footprint` put 10 GB under "Owned physical footprint (unmapped) (graphics)" -- GPU memory the
// page owns, charged to its process on unified memory. The page's own memory report counted 1.3 GB,
// because it only sees JavaScript memory. What we could account for by hand came to about 4.6 GB. The
// rest could only be named by recording every allocation, which is what this does.
//
// How. `installGpuLedger(device)` wraps createTexture and createBuffer. Each allocation is recorded with
// its bytes (from its size and format), its label, and the first application functions on the stack;
// wrapping `destroy` removes it. A FinalizationRegistry notes one that is garbage-collected without
// destroy() -- WebGPU frees those too, but late, and counting them says where destroy() is missing.
// The ledger holds WEAK references, so recording never keeps anything alive.
//
//   __gpuLedger()          totals by maker, largest first, plus the live total
//   __gpuLedger({ top })   how many makers to list (default 12)

export interface LedgerRow { maker: string; count: number; mb: number }
export interface LedgerReport { liveMB: number; allocations: number; byMaker: LedgerRow[]; destroyed: number; collectedWithoutDestroy: number }

interface Entry { kind: "texture" | "buffer"; bytes: number; maker: string; label: string }

const BYTES_PER_TEXEL: Record<string, number> = {
  r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1,
  r16uint: 2, r16sint: 2, r16float: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
  r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4,
  rgba8unorm: 4, "rgba8unorm-srgb": 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
  bgra8unorm: 4, "bgra8unorm-srgb": 4, rgb10a2unorm: 4, rg11b10ufloat: 4, rgb9e5ufloat: 4,
  rg32uint: 8, rg32sint: 8, rg32float: 8, rgba16uint: 8, rgba16sint: 8, rgba16float: 8,
  rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
  depth16unorm: 2, depth24plus: 4, "depth24plus-stencil8": 4, depth32float: 4, "depth32float-stencil8": 5, stencil8: 1,
};

/** Bytes a texture occupies: every mip level, every layer, times its sample count. */
export function textureBytes(d: GPUTextureDescriptor): number {
  const size = d.size as number[] | GPUExtent3DDict;
  const [w, h, z] = Array.isArray(size) ? [size[0] ?? 1, size[1] ?? 1, size[2] ?? 1] : [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
  const bpt = BYTES_PER_TEXEL[d.format as string] ?? 4;
  const is3d = d.dimension === "3d";
  let total = 0;
  for (let m = 0; m < (d.mipLevelCount ?? 1); m++) {
    const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m), mz = is3d ? Math.max(1, z >> m) : z;
    total += mw * mh * mz * bpt;
  }
  return total * (d.sampleCount ?? 1);
}

/** The first two application functions that asked for it, from a stack trace: "maker < caller". */
export function makerOf(stack: string | undefined): string {
  const names: string[] = [];
  for (const line of (stack ?? "").split("\n")) {
    // V8: "    at fn (url:line:col)"; JavaScriptCore: "fn@url:line:col".
    const m = /^\s*at (?:async )?([^\s(]+) \(/.exec(line) ?? /^([^@\s]+)@/.exec(line.trim());
    const name = m?.[1];
    if (!name || /ledger|record|createTexture|createBuffer|^Object\.|^new$|^<anonymous>$/i.test(name)) continue;
    names.push(name.replace(/^.*\./, ""));
    if (names.length === 2) break;
  }
  return names.join(" < ") || "(unknown)";
}

const live = new Map<number, Entry>();
let nextId = 1, destroyed = 0, collectedWithoutDestroy = 0;
const registry = new FinalizationRegistry<number>((id) => {
  if (live.delete(id)) collectedWithoutDestroy++;
});

function record(obj: GPUTexture | GPUBuffer, e: Entry) {
  const id = nextId++;
  live.set(id, e);
  registry.register(obj, id, obj);
  const destroy = obj.destroy.bind(obj);
  (obj as { destroy: () => void }).destroy = () => {
    if (live.delete(id)) destroyed++;
    registry.unregister(obj);
    destroy();
  };
}

/** Wrap a device so every texture and buffer it makes is in the ledger. Idempotent. */
export function installGpuLedger(device: GPUDevice): void {
  const d = device as GPUDevice & { __ledger?: boolean };
  if (d.__ledger) return;
  d.__ledger = true;
  const mkTex = device.createTexture.bind(device);
  const mkBuf = device.createBuffer.bind(device);
  device.createTexture = (desc: GPUTextureDescriptor) => {
    const t = mkTex(desc);
    record(t, { kind: "texture", bytes: textureBytes(desc), maker: makerOf(new Error().stack), label: desc.label ?? "" });
    return t;
  };
  device.createBuffer = (desc: GPUBufferDescriptor) => {
    const b = mkBuf(desc);
    record(b, { kind: "buffer", bytes: desc.size, maker: makerOf(new Error().stack), label: desc.label ?? "" });
    return b;
  };
  (globalThis as unknown as { __gpuLedger?: typeof gpuLedger }).__gpuLedger = gpuLedger;
}

/** What is on the GPU now, by the functions that made it, largest first. */
export function gpuLedger(o: { top?: number } = {}): LedgerReport {
  const by = new Map<string, { count: number; bytes: number }>();
  let bytes = 0;
  for (const e of live.values()) {
    const k = `${e.kind}: ${e.label ? `${e.label} · ` : ""}${e.maker}`;
    const r = by.get(k) ?? { count: 0, bytes: 0 };
    r.count++; r.bytes += e.bytes; by.set(k, r);
    bytes += e.bytes;
  }
  const byMaker = [...by.entries()].map(([maker, r]) => ({ maker, count: r.count, mb: Math.round(r.bytes / 1048576) }))
    .sort((a, b) => b.mb - a.mb).slice(0, o.top ?? 12);
  return { liveMB: Math.round(bytes / 1048576), allocations: live.size, byMaker, destroyed, collectedWithoutDestroy };
}

/** One line for the session log: the live total and the largest makers. */
export function gpuLedgerLine(top = 6): string {
  const r = gpuLedger({ top });
  return `graphics memory (ledger): ${r.liveMB} MB in ${r.allocations} allocations` +
    (r.byMaker.length ? ` — ${r.byMaker.filter((x) => x.mb > 0).map((x) => `${x.maker} ${x.mb} MB${x.count > 1 ? ` (${x.count}×)` : ""}`).join("; ")}` : "") +
    ` · ${r.destroyed} destroyed, ${r.collectedWithoutDestroy} collected without destroy()`;
}
