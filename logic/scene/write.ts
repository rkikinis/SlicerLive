// THE SCENE WRITER: the saved scene from the live scene (SCENE-DESIGN-2026-09-20.md §2-4).
//
// What goes in is what a person did and what the database cannot recover: which series and
// which instances (identity), what is shown and how (display nodes), where the views and the
// camera are. What stays out is what the database and the loader recover on their own -- the
// chunk hashes and instance lists that are two thirds of the live scene's bytes (kept as ONE
// digest per volume), the ECG pictures (a series, referenced), the runtime flags -- and the
// patient's name, which the database has and a transport folder must not carry twice.
//
// Ids: a session-local id (`local-image-3-mu8mtudm`) means nothing tomorrow, but ids are only
// the file's internal wiring; the durable identity is in each node's `dicom` block. The writer
// renumbers nodes as `n1, n2, …` in a stable order so two saves of the same scene differ only
// where the scene does (the round-trip test in write.test.ts depends on it).
import { cardsOf, isCardList, mapCardRefs } from "../markups/name-cards.ts";
import { instanceKeys } from "../instance-key.ts";
import type { MrsonNode } from "../../render/mrson.ts";
import { MRSON_VERSION, NODE_TYPES, PROFILE_ID } from "./profile.ts";
import { checkScene, type SceneProblem } from "./check.ts";

type Obj = Record<string, unknown>;

export interface WriteOptions {
  /** The build that writes (`__BUILD_ID__`). */
  producer: string;
  /** This window's origin id (LiveScene.origin). */
  origin: string;
  /** The scene's name; the study's description by default. */
  name: string;
  /** How many saves this scene had before; the file gets `v + 1`. */
  previousV?: number;
  /** The layout as the application holds it (not a node in the live scene today). */
  layout?: { arrangement: number; arrangementName?: string; splits?: Record<string, number> };
  /** The window's current values for what the live scene does not carry. */
  now?: () => string;
}

export interface WrittenScene {
  doc: Obj; problems: SceneProblem[]; refused: string[];
  /** The refused nodes the application can put right by saving them to DICOM first, in the order to do it (volumes before the segmentations drawn on them). */
  fixable: { id: string; type: string; name: string; why: "file" | "unsaved" | "edited" }[];
  /** Set when nothing loaded names a study: there is no scene to save. */
  empty?: boolean;
}

/** sha-256 of a string, hex. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The volume's content identity: a digest over its chunk hashes in a fixed order. */
export async function volumeDigest(zarr: Obj | undefined): Promise<string | undefined> {
  const hashes = zarr?.chunkHashes as Record<string, string> | undefined;
  if (!hashes) return undefined;
  const keys = Object.keys(hashes).sort();
  if (!keys.length) return undefined;
  return await sha256Hex(`${(zarr!.shape as number[])?.join("x")}|${zarr!.dtype}|${keys.map((k) => `${k}=${hashes[k]}`).join(",")}`);
}

const TYPE_ORDER = ["layout", "camera", "view", "image", "scalarVolumeDisplay", "transferFunction", "volumeRenderingDisplay", "segmentation", "sequence", "sequenceBrowser", "sliceComposite", "markup", "transform"];

/** Runtime flags and bulk the file must not carry. */
const DROP = new Set(["hidden", "autoWindowLevel", "playbackActive", "labelmap", "zarr", "origin", "source", "edited", "shade"]);

/**
 * Write the scene. Refuses (in `refused`) nodes that cannot be named durably -- a volume with no
 * series, a segmentation edited since its save or never saved -- and says why; the caller decides
 * whether to save without them. `problems` is the checker's verdict on the result.
 */
export async function writeScene(nodes: Iterable<MrsonNode>, o: WriteOptions): Promise<WrittenScene> {
  const all = [...nodes].filter((n) => NODE_TYPES[n.type as string]);
  const refused: string[] = [];
  const fixable: WrittenScene["fixable"] = [];
  const keep: MrsonNode[] = [];
  // ONE SCENE, ONE PATIENT, ANY NUMBER OF STUDIES. Ron, 2026-09-20, on "a scene names one
  // study": "how about the remind study? it contains more than one study: preop, intra op mri
  // before dura is opened, intra op US" -- each a DICOM study of one patient, one scene. So the
  // file names every study (`studies`) and the browser lists it under each; a series of ANOTHER
  // PATIENT is what is refused by name (the critic's case, finding 7: a 43-slice CT of someone
  // else saved into a cardiac scene and listed nowhere).
  const byId = new Map(all.map((n) => [n.id, n]));
  const whose = (n: MrsonNode): string | undefined => {
    const o = (n.origin as Obj | undefined) ?? {};
    const own = (o.patientID as string | undefined) || (o.patientName as string | undefined) || undefined;
    if (own || n.type !== "segmentation") return own;
    // A segmentation's origin carries no patient; the volume it was drawn on does (critic, finding 2).
    const src = ((n.refs as Obj | undefined)?.source as string[] | undefined)?.[0];
    const vol = src ? byId.get(src) : undefined;
    return vol ? whose(vol) : undefined;
  };
  const thePatient = all.map(whose).find((w): w is string => typeof w === "string");
  // MADE AGAIN WHEN THE SCENE LOADS, so left out without a word: an image a module computes from what the scene holds
  // (`recomputable: true` -- the Diffusion module's FA and Color FA, made from the scan in about a second when it
  // loads), and its display. Ron, 2026-10-01: a scene with Color FA asked him to save the map to DICOM first.
  const onTheFly = new Set(all.filter((n) => n.type === "image" && (n as { recomputable?: boolean }).recomputable)
    .flatMap((n) => [n.id, ...(((n.refs as Obj | undefined)?.display as string[] | undefined) ?? [])]));
  for (const n of all) {
    if (onTheFly.has(n.id)) continue;
    const org = (n.origin as Obj | undefined) ?? {};
    if (n.type === "image") {
      if (typeof org.seriesInstanceUID !== "string" && typeof org.savedSeriesInstanceUID !== "string") { refused.push(`${n.name ?? n.id}: not in the DICOM database (it came from a file, a sample or a crop) — save it to DICOM first, then the scene can list it`); if (!n.labelmap) fixable.push({ id: n.id, type: "image", name: String(n.name ?? n.id), why: "file" }); continue; }
      if (thePatient && whose(n) && whose(n) !== thePatient) { refused.push(`${n.name ?? n.id}: another patient's — a scene is one patient's`); continue; }
    }
    if (n.type === "segmentation") {
      const uid = (org.savedSeriesInstanceUID ?? org.seriesInstanceUID) as string | undefined;
      if (!uid) { refused.push(`${n.name ?? n.id}: never saved to the database — save it first`); if (!(n as { hidden?: boolean }).hidden) fixable.push({ id: n.id, type: "segmentation", name: String(n.name ?? n.id), why: "unsaved" }); continue; }
      if (n.edited === true) { refused.push(`${n.name ?? n.id}: edited since it was saved — save it first, or the scene would reload the old file`); if (!(n as { hidden?: boolean }).hidden) fixable.push({ id: n.id, type: "segmentation", name: String(n.name ?? n.id), why: "edited" }); continue; }
      if (thePatient && whose(n) && whose(n) !== thePatient) { refused.push(`${n.name ?? n.id}: another patient's — a scene is one patient's`); continue; }
    }
    keep.push(n);
  }
  // A transfer function nobody points at (the per-frame ones a SEG load makes) says nothing a
  // reader can place; only the ones a kept rendering display names go in (critic, finding 10).
  const keptVr = keep.filter((n) => n.type === "volumeRenderingDisplay");
  const namedTf = new Set(keptVr.flatMap((n) => ((n.refs as Obj | undefined)?.property as string[] | undefined) ?? []));
  for (let i = keep.length - 1; i >= 0; i--) if (keep[i].type === "transferFunction" && !namedTf.has(keep[i].id)) keep.splice(i, 1);
  // Stable order and ids.
  const order = (n: MrsonNode) => `${String(TYPE_ORDER.indexOf(n.type as string)).padStart(2, "0")}|${n.name ?? ""}|${n.id}`;
  keep.sort((a, b) => order(a) < order(b) ? -1 : 1);
  const idOf = new Map<string, string>();
  keep.forEach((n, i) => idOf.set(n.id, `n${i + 1}`));
  const keptIds = new Set(keep.map((n) => n.id));
  const mapRef = (id: unknown) => typeof id === "string" ? (idOf.get(id) ?? id) : id;
  const mapRefs = (refs: unknown) => refs && typeof refs === "object"
    ? Object.fromEntries(Object.entries(refs as Record<string, string[]>).map(([k, v]) => [k, (v ?? []).filter((id) => keptIds.has(id)).map((id) => idOf.get(id)!)]).filter(([, v]) => (v as string[]).length))
    : undefined;

  const out: Record<string, Obj> = {};
  let studyUID: string | undefined;
  const studies: string[] = [];
  for (const n of keep) {
    const id = idOf.get(n.id)!;
    const org = (n.origin as Obj | undefined) ?? {};
    const node: Obj = { id, type: n.type };
    for (const [k, v] of Object.entries(n)) {
      if (k === "id" || k === "type" || DROP.has(k)) continue;
      if (k === "refs") { const r = mapRefs(v); if (r && Object.keys(r).length) node.refs = r; continue; }
      node[k] = v;
    }
    if (n.type === "image") {
      // THE INSTANCE LIST, COMPACT. One instance names the frame of a sequence as surely as all
      // 533 (the SEG reader finds its frame by one), and a digest of the sorted list names the
      // exact set; the full list was 160 KB of a 190 KB file on the first save (2026-09-20).
      const uids = ((org.sopInstanceUIDs ?? org.savedSopInstanceUIDs) as string[] | undefined) ?? [];
      // From a multi-frame file every volume shares the uid; its frame numbers tell them apart (logic/instance-key.ts).
      const frames = org.sopInstanceUIDs ? (org.frameNumbers as number[] | undefined) : undefined;
      const keys = instanceKeys({ sopInstanceUIDs: uids, frameNumbers: frames });
      node.dicom = {
        seriesInstanceUID: org.savedSeriesInstanceUID ?? org.seriesInstanceUID, studyInstanceUID: org.studyInstanceUID ?? org.savedStudyInstanceUID,
        sopInstanceUIDs: uids.slice(0, 1), instanceCount: uids.length,
        ...(frames?.length === uids.length && uids.length ? { frameNumbers: frames.slice(0, 1) } : {}),
        ...(uids.length ? { instancesDigest: await sha256Hex([...keys].sort().join("\n")) } : {}),
        ...(org.frameOfReferenceUID ? { frameOfReferenceUID: org.frameOfReferenceUID } : {}),
        ...(org.modality ? { modality: org.modality } : {}),
      };
      // The name is built from the database at load (it carries the patient's label); not stored.
      delete node.name;
      const d = await volumeDigest(n.zarr as Obj | undefined); if (d) node.digest = d;
      if (typeof org.frameLabel === "string") node.frameLabel = org.frameLabel;
      { const st = (org.studyInstanceUID ?? org.savedStudyInstanceUID) as string | undefined; if (typeof st === "string") { studyUID ??= st; if (!studies.includes(st)) studies.push(st); } }
      if (n.sequence) node.sequence = mapRef(n.sequence);
      // Steve's ZarrDesc without the hashes: the shape and dtype say what to expect.
      const z = n.zarr as Obj | undefined; if (z) node.zarr = { shape: z.shape, dtype: z.dtype };
    }
    if (n.type === "segmentation") {
      const segStudy = (org.studyInstanceUID ?? org.savedStudyInstanceUID) as string | undefined;
      node.dicom = { seriesInstanceUID: org.savedSeriesInstanceUID ?? org.seriesInstanceUID, ...(segStudy ? { studyInstanceUID: segStudy } : {}), ...(org.savedSopClassUID ?? org.sopClassUID ? { sopClassUID: org.savedSopClassUID ?? org.sopClassUID } : {}) };
      if (typeof segStudy === "string") { studyUID ??= segStudy; if (!studies.includes(segStudy)) studies.push(segStudy); }
      if (typeof org.task === "string") node.model = org.task;
      const src = ((n.refs as Obj | undefined)?.source as string[] | undefined)?.[0];
      if (src && keptIds.has(src)) node.referenceImage = idOf.get(src);
      delete node.refs; delete node.dims; delete node.ijkToRAS;
      delete node.visible3DBeforeHide;   // the Segmentations eye's memory of the 3D state; session-local, not scene state
      node.segments = ((n.segments as Obj[]) ?? []).map((sg) => {
        const { fileColor: _fc, ...rest } = sg;
        const c = sg.color as number[] | undefined;
        return { id: `s${sg.labelValue}`, ...rest, ...(c && c.length === 3 ? { color: [...c, 1] } : {}) };
      });
      if (n.sequence) node.sequence = mapRef(n.sequence);
    }
    // A display's, a composite's and a browser's names are built from their volume's at load
    // (they carry the patient's label the same way); a person never edits them.
    if (n.type === "scalarVolumeDisplay" || n.type === "volumeRenderingDisplay" || n.type === "sliceComposite" || n.type === "sequenceBrowser") delete node.name;
    if (n.type === "view" && n.kind === "3d" && Array.isArray(n.shade) && n.shade.length === 4) {
      const [ambient, diffuse, specular, power] = n.shade as number[]; node.shading = { ambient, diffuse, specular, power };
    }
    if (n.type === "transferFunction" && Array.isArray(n.shade) && n.shade.length === 4) {
      const [ambient, diffuse, specular, power] = n.shade as number[]; node.shading = { ambient, diffuse, specular, power };
    }
    if (n.type === "volumeRenderingDisplay") {
      const r = (n.refs as Obj | undefined) ?? {};
      node.refs = mapRefs({ volume: r.volume, transferFunction: r.property }) ?? {};
    }
    // NAME CARDS name a segmentation by its id (logic/markups/name-cards.ts): renamed with the rest, forgotten if not saved.
    if (isCardList(n)) node.controlPoints = mapCardRefs(cardsOf(n), (id) => keptIds.has(id) ? idOf.get(id) : undefined);
    if (n.type === "sequence") {
      delete node.name;                                       // built from the database at load
      node.items = ((n.items as Obj[]) ?? []).filter((it) => keptIds.has(it.node as string)).map((it) => ({ ...it, node: idOf.get(it.node as string) }));
      if (n.companionOf) node.companionOf = mapRef(n.companionOf);
      node.documents = ((n.documents as Obj[]) ?? []).map((d) => ({ name: d.name, seriesInstanceUID: d.seriesInstanceUID }));
    }
    if (n.type === "sequenceBrowser") {
      node.sequences = ((n.sequences as Obj[]) ?? []).filter((s) => keptIds.has(s.sequence as string)).map((s) => {
        const { proxy, ...rest } = s;                       // a proxy that did not make it into the file is not named (critic, finding 5)
        return { ...rest, sequence: idOf.get(s.sequence as string), ...(proxy && keptIds.has(proxy as string) ? { proxy: idOf.get(proxy as string) } : {}) };
      });
    }
    out[id] = node;
  }
  if (o.layout) {
    const id = `n${keep.length + 1}`;
    out[id] = { id, type: "layout", arrangement: o.layout.arrangement, ...(o.layout.arrangementName ? { arrangementName: o.layout.arrangementName } : {}), ...(o.layout.splits ? { splits: o.layout.splits } : {}) };
  }
  // NOTHING TO SAVE. Views and a camera alone name no study; a file like that lists under no
  // study in the browser and cannot be found or deleted there (critic, findings 2 and 8).
  const empty = !studyUID;
  const doc: Obj = {
    mrson: MRSON_VERSION,
    extensionsUsed: [PROFILE_ID],
    source: { producer: o.producer, producedAt: (o.now ?? (() => new Date().toISOString()))(), origin: o.origin },
    v: (o.previousV ?? 0) + 1,
    name: o.name,
    study: { studyInstanceUID: studyUID ?? "" },
    studies,
    nodes: out,
  };
  fixable.sort((a, b) => Number(a.type === "segmentation") - Number(b.type === "segmentation"));   // volumes first
  return { doc, problems: checkScene(doc), refused, fixable, ...(empty ? { empty: true } : {}) };
}
