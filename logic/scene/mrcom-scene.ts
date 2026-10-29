// A SAVED SCENE AS AN MRCOM OBJECT, AND BACK (Ron, 2026-10-29: the three scenes he keeps "must be converted to the new
// format"). Steve Pieper's MRCOM writer (logic/mrcom/write.ts) carries a scene's NODES in a DICOM Secondary Capture; the
// rest of an Albula scene file -- its name, studies, save count, producer, `extensionsUsed` and the extensions' own state
// (the Diffusion module's tract set and rows) -- is not a node, and his writer and reader would drop it. So it travels as
// ONE NODE of Albula's own type, `albulaScene`, which mrson's open model allows (his validator: "type is not in the
// schema; its fields are not checked") and his loader passes by. Reading puts the file back together exactly.
//
// Reference mode: the bundle names its scans and segmentations by their DICOM identifiers (profile albula-scene/2's
// `dicom` descriptors) and carries none of their voxels, so it is tens of kilobytes. Nothing here touches a database;
// desktop/scene-mrcom.ts writes and indexes the object.
import type { MrsonNode } from "../../render/mrson.ts";
import { readMrcomBundle } from "../mrcom/read.ts";
import { type ReferenceContext, writeMrcomBundle, type WrittenBundle } from "../mrcom/write.ts";

type Obj = Record<string, unknown>;

/** The node that carries the scene file's own fields. */
export const ENVELOPE_NODE_ID = "albula-scene";
export const ENVELOPE_NODE_TYPE = "albulaScene";
/** The scene file's fields that are not `nodes`; all of them travel in the envelope node. */
const NOT_ENVELOPE = new Set(["nodes"]);

/** The scene file's nodes plus the envelope node, ready for Steve's writer. */
export function sceneToNodes(doc: Obj): Record<string, MrsonNode> {
  const nodes = { ...((doc.nodes as Record<string, MrsonNode>) ?? {}) };
  if (nodes[ENVELOPE_NODE_ID]) throw new Error(`the scene already has a node "${ENVELOPE_NODE_ID}"`);
  const file: Obj = {};
  for (const [k, v] of Object.entries(doc)) if (!NOT_ENVELOPE.has(k)) file[k] = v;
  // `order`: the file's own key order, `nodes` included, so a scene read back is the same text as the one written.
  const envelope: Obj = { id: ENVELOPE_NODE_ID, type: ENVELOPE_NODE_TYPE, file, order: Object.keys(doc) };
  nodes[ENVELOPE_NODE_ID] = envelope as unknown as MrsonNode;
  return nodes;
}

/** The scene file back from a bundle's nodes; undefined when the bundle was not written from an Albula scene. */
export function nodesToScene(nodes: Record<string, MrsonNode>): Obj | undefined {
  const env = nodes[ENVELOPE_NODE_ID] as unknown as Obj | undefined;
  if (!env || env.type !== ENVELOPE_NODE_TYPE) return undefined;
  const rest = { ...nodes };
  delete rest[ENVELOPE_NODE_ID];
  const file = (env.file as Obj | undefined) ?? {};
  const order = Array.isArray(env.order) ? env.order as string[] : [...Object.keys(file), "nodes"];
  const out: Obj = {};
  for (const k of order) out[k] = k === "nodes" ? rest : file[k];
  for (const [k, v] of Object.entries(file)) if (!(k in out)) out[k] = v;
  if (!("nodes" in out)) out.nodes = rest;
  return out;
}

/** Every series a scene names, images first (the first image is the bundle's primary parent), with EVERY instance the
 *  scene's nodes name in it: a series holding several volumes (the heart's five phases, a diffusion scan's hundred) is
 *  several nodes, and each names its own (the critic, 2026-10-29, finding 1: only the first node's were kept). */
export function referencedSeries(doc: Obj, classes: Record<string, string> = {}, extra: NonNullable<ReferenceContext["referencedSeries"]> = []): NonNullable<ReferenceContext["referencedSeries"]> {
  const nodes = Object.values((doc.nodes as Record<string, Obj>) ?? {});
  const bySeries = new Map<string, { cls?: string; inst: Set<string> }>();
  for (const type of ["image", "segmentation"]) {
    for (const n of nodes) {
      if (n.type !== type) continue;
      const d = (n.dicom as Obj | undefined) ?? {};
      const uid = d.seriesInstanceUID as string | undefined;
      if (!uid) continue;
      // The SOP class: the descriptor's, else the caller's (read from the series' own files); dciodvfy requires it of
      // every referenced instance (ReferencedSOPClassUID, Type 1).
      const e = bySeries.get(uid) ?? { cls: (d.sopClassUID as string | undefined) ?? classes[uid], inst: new Set<string>() };
      for (const i of (d.instances as string[] | undefined) ?? []) e.inst.add(i);
      bySeries.set(uid, e);
    }
  }
  // THE SERIES AN EXTENSION'S STATE NAMES (the Diffusion module's tract set: not a node, so not above; the critic,
  // 2026-10-29, data architecture finding 5), after the nodes' -- the first image stays the primary parent.
  for (const x of extra) if (!bySeries.has(x.seriesInstanceUID)) bySeries.set(x.seriesInstanceUID, { cls: x.sopClassUID, inst: new Set(x.instances ?? []) });
  return [...bySeries].map(([uid, e]) => ({ seriesInstanceUID: uid, ...(e.cls ? { sopClassUID: e.cls } : {}), ...(e.inst.size ? { instances: [...e.inst] } : {}) }));
}

/** Every DICOM UID the scene's extension blocks name (strings of the UID form anywhere in `extensions`); which of them are
 *  series is for the caller, who has the database. */
export function uidsInExtensions(doc: Obj): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    // "2.25.<n>" has three parts; a string that is not a series here is dropped by the caller.
    if (typeof v === "string") { if (/^[0-9]+(\.[0-9]+){2,}$/.test(v) && v.length <= 64) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Obj).forEach(walk);
  };
  walk(doc.extensions);
  return [...out];
}

/** A text cut to fit a DICOM LO (64 bytes as written, UTF-8): a "·" is two bytes, so 64 characters can be 66 (dciodvfy,
 *  2026-10-29, on two scene names). Cut at a character, never inside one. */
export function fitLO(text: string): string {
  const enc = new TextEncoder();
  let out = "";
  for (const ch of text) { if (enc.encode(out + ch).byteLength > 64) break; out += ch; }
  return out;
}

/** The scene as an MRCOM bundle in reference mode. `reference`: one instance of the scene's first scan, as its file's
 *  bytes or as a naturalized dataset (its patient and study context); `classes`: each named series' SOP class UID, for the
 *  series whose descriptor has none. */
export function sceneToMrcom(doc: Obj, reference: Uint8Array | Obj, producerVersion: string, classes: Record<string, string> = {}, extra: NonNullable<ReferenceContext["referencedSeries"]> = []): Promise<WrittenBundle> {
  return writeMrcomBundle({
    nodes: sceneToNodes(doc),
    mode: "reference",
    reference: { ...(reference instanceof Uint8Array ? { bytes: reference } : { dataset: reference }), referencedSeries: referencedSeries(doc, classes, extra) },
    seriesDescription: fitLO(`Scene: ${String(doc.name ?? "")}`),
    producer: "SlicerAlbula",
    producerVersion: fitLO(producerVersion),
  });
}

/** The scene file from an MRCOM object's bytes; undefined when it does not hold an Albula scene. */
export async function mrcomToScene(bytes: Uint8Array): Promise<Obj | undefined> {
  const b = await readMrcomBundle(bytes, { screenshot: false });
  return nodesToScene(b.nodes);
}
