// VENDORS' PRIVATE ELEMENTS, read generically: where a private element sits (its creator's block), its numbers by the
// type the vendor's dictionary gives it, and the Siemens CSA header. Used by the Siemens mosaic reader here in core and
// by extensions that read a vendor's private fields (the diffusion extension's vendor rules). Moved out of
// diffusion-vendors.ts on 2026-09-30 (Contents/docs/EXTENSIONS.md in the workspace: core keeps what is generic).

// ── Siemens CSA header ────────────────────────────────────────────────────────────────────────────────────────────

/** The CSA header's tags as strings (both the "SV10" form and the older form without the signature). */
export function parseCsa(bytes: Uint8Array): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (bytes.length < 16) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sv10 = bytes[0] === 0x53 && bytes[1] === 0x56 && bytes[2] === 0x31 && bytes[3] === 0x30;   // "SV10"
  let p = sv10 ? 8 : 0;
  const nTags = dv.getUint32(p, true);
  p += 8;
  if (nTags < 1 || nTags > 1024) return out;
  const dec = new TextDecoder("latin1");
  for (let t = 0; t < nTags && p + 84 <= bytes.length; t++) {
    const nameBytes = bytes.subarray(p, p + 64);
    const nul = nameBytes.indexOf(0);
    const name = dec.decode(nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes);
    const nItems = dv.getInt32(p + 76, true);
    p += 84;
    const vals: string[] = [];
    for (let i = 0; i < nItems && p + 16 <= bytes.length; i++) {
      const len = dv.getInt32(p + 4, true);
      p += 16;
      if (len < 0 || p + len > bytes.length) return out;
      const s = dec.decode(bytes.subarray(p, p + len)).replace(/\0.*$/s, "").trim();
      if (s !== "") vals.push(s);
      p += Math.ceil(len / 4) * 4;
    }
    out.set(name, vals);
  }
  return out;
}

// ── The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────



export type Raw = Record<string, { vr?: string; Value?: unknown[]; InlineBinary?: string } | undefined>;

export const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
export const values = (raw: Raw, tag: string): unknown[] => raw[tag]?.Value ?? [];
export const bytesOf = (raw: Raw, tag: string): Uint8Array | undefined => {
  const v = values(raw, tag)[0];
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return undefined;
};
/**
 * A private element's numbers, read by the type the vendor's dictionary gives it. In an implicit VR file (the default
 * transfer syntax) the library does not know a private element's type and hands over its raw bytes (vr "UN"); some
 * explicit VR files store them as OB. Text types (IS, DS) are decoded as backslash-separated text, FL/FD as
 * little-endian floats. Critic, 2026-09-29, finding 1: without this, GE and Philips diffusion in implicit VR files was
 * never read and the series loaded as b = 0 images without a word.
 */
export function privateNumbers(raw: Raw, tag: string, vr: "IS" | "DS" | "FL" | "FD" | "US"): number[] {
  const vs = values(raw, tag);
  if (!vs.length) return [];
  const b = bytesOf(raw, tag);
  if (!b) return vs.map((v) => num(v) ?? NaN);
  if (vr === "IS" || vr === "DS") return new TextDecoder("latin1").decode(b).replace(/\0/g, "").split("\\").map((x) => num(x) ?? NaN);
  const size = { FL: 4, FD: 8, US: 2 }[vr], dv = new DataView(b.buffer, b.byteOffset, b.byteLength), out: number[] = [];
  for (let o = 0; o + size <= b.byteLength; o += size) out.push(vr === "FD" ? dv.getFloat64(o, true) : vr === "FL" ? dv.getFloat32(o, true) : dv.getUint16(o, true));
  return out;
}

/**
 * WHERE A PRIVATE ELEMENT IS: the block its creator reserved (PS3.5 §7.8.1). A vendor's creator string sits in
 * (gggg,0010-00FF); element xx of that vendor is at (gggg, block·0x100 + xx). Usually block 0x10, not always -- so it is
 * looked up, not assumed (critic, 2026-09-29, finding 12). A group with no creator entries at all (a malformed file)
 * falls back to block 0x10; a group whose creators are all someone else's gives nothing.
 * Creators, as found in the test data: GE "GEMS_ACQU_01" (0019), "GEMS_PARM_01" (0043); Siemens "SIEMENS MR HEADER"
 * (0019), "SIEMENS CSA HEADER" (0029); Philips "Philips Imaging DD 001" (2001), "Philips MR Imaging DD 001" (2005).
 */
export function privateTag(raw: Raw, group: string, creator: string, element: string): string | undefined {
  let any = false;
  for (let block = 0x10; block <= 0xff; block++) {
    const key = `${group}00${block.toString(16).toUpperCase().padStart(2, "0")}`;
    const v = values(raw, key)[0];
    if (v === undefined) continue;
    any = true;
    const text = typeof v === "string" ? v : bytesOf(raw, key) ? new TextDecoder("latin1").decode(bytesOf(raw, key)) : String(v);
    if (text.replace(/\0/g, "").trim() === creator) return `${group}${block.toString(16).toUpperCase().padStart(2, "0")}${element}`;
  }
  return any ? undefined : `${group}10${element}`;
}
/** privateTag, or a tag no element has, so a lookup of it finds nothing. */
export const at = (raw: Raw, group: string, creator: string, element: string) => privateTag(raw, group, creator, element) ?? "(none)";

