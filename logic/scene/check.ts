// ALBULA'S OWN CHECKER for a saved scene (SCENE-DESIGN-2026-09-20.md §8). Steve's validate.sh
// proves type names and each type's own fields one inheritance level deep and nothing about ids,
// refs or references (the critic on the review, finding 11); this proves what a loader needs:
// the envelope, every node with an id that matches its key, every type in the profile, every
// required field present and of the right shape, every ref resolving to a node in the file, and
// -- when a database is at hand -- every series the file names present in it. Plain functions,
// so the rebuild's tests run them and the loader refuses a file that fails them with the list.
import { ENVELOPE, type FieldSpec, type Kind, MRSON_VERSION, NODE_TYPES, PROFILE_ID } from "./profile.ts";

export interface SceneProblem { where: string; what: string }

type Obj = Record<string, unknown>;

function shapeOk(kind: Kind, v: unknown): boolean {
  const nums = (n: number) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
  switch (kind) {
    case "string": case "ref": return typeof v === "string" && v.length > 0;
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "int": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "vec3": return nums(3);
    case "matrix16": return nums(16);
    case "rgba": return Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every((x) => typeof x === "number");
    case "numbers": return Array.isArray(v) && v.every((x) => typeof x === "number");
    case "strings": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "refs": return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v as Obj).every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"));
    case "code": return !!v && typeof v === "object" && typeof (v as Obj).scheme === "string" && typeof (v as Obj).value === "string";
    case "object": return !!v && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
  }
}

function checkFields(where: string, obj: Obj, spec: Record<string, FieldSpec>, out: SceneProblem[]) {
  for (const [f, s] of Object.entries(spec)) {
    const v = obj[f];
    if (v === undefined) { if (s.required) out.push({ where, what: `${f} is missing` }); continue; }
    // AN EMPTY OPTIONAL TEXT IS A VALUE (Ron, 2026-10-01: a scene with a diffusion scan would not save -- its sequence's
    // indexUnit is "", the volume number having no unit). A required one must still say something.
    if (s.kind === "string" && v === "" && !s.required) continue;
    if (!shapeOk(s.kind, v)) out.push({ where, what: `${f} is not a ${s.kind}` });
  }
}

/** Every problem in the document; an empty list is a valid scene. */
export function checkScene(doc: unknown): SceneProblem[] {
  const out: SceneProblem[] = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [{ where: "file", what: "not a JSON object" }];
  const d = doc as Obj;
  checkFields("file", d, ENVELOPE, out);
  if (typeof d.mrson === "number" && d.mrson !== MRSON_VERSION) out.push({ where: "file", what: `mrson ${d.mrson} is not the ${MRSON_VERSION} this application reads` });
  if (Array.isArray(d.extensionsUsed) && !d.extensionsUsed.includes(PROFILE_ID)) out.push({ where: "file", what: `extensionsUsed does not name ${PROFILE_ID}` });
  const src = d.source as Obj | undefined;
  if (src && typeof src === "object") {
    if (typeof src.producer !== "string") out.push({ where: "file", what: "source.producer (the build that wrote it) is missing" });
    if (typeof src.producedAt !== "string") out.push({ where: "file", what: "source.producedAt is missing" });
  }
  const study = d.study as Obj | undefined;
  if (study && (typeof study.studyInstanceUID !== "string" || !study.studyInstanceUID)) out.push({ where: "file", what: "study.studyInstanceUID is missing — a scene belongs to one study" });
  const nodes = d.nodes;
  if (!nodes || typeof nodes !== "object") return out;
  const ids = new Set(Object.keys(nodes as Obj));
  const refOk = (id: unknown) => typeof id === "string" && ids.has(id);
  for (const [key, n] of Object.entries(nodes as Record<string, Obj>)) {
    const where = `node ${key}`;
    if (!n || typeof n !== "object") { out.push({ where, what: "not an object" }); continue; }
    if (n.id !== key) out.push({ where, what: `id "${n.id}" differs from its key` });
    const type = n.type;
    if (typeof type !== "string" || !NODE_TYPES[type]) { out.push({ where, what: `type "${type}" is not in the profile` }); continue; }
    checkFields(where, n, NODE_TYPES[type], out);
    // refs resolve
    for (const [f, s] of Object.entries(NODE_TYPES[type])) {
      const v = n[f];
      if (v === undefined) continue;
      if (s.kind === "ref" && !refOk(v)) out.push({ where, what: `${f} points at "${v}", which is not in the file` });
      if (s.kind === "refs") for (const [role, list] of Object.entries(v as Record<string, string[]>)) for (const id of list) if (!refOk(id)) out.push({ where, what: `refs.${role} points at "${id}", which is not in the file` });
    }
    if (type === "sequence") for (const it of (n.items as Obj[] | undefined) ?? []) if (!refOk(it?.node)) out.push({ where, what: `items names "${it?.node}", which is not in the file` });
    if (type === "sequenceBrowser") for (const s of (n.sequences as Obj[] | undefined) ?? []) { if (!refOk(s?.sequence)) out.push({ where, what: `sequences names "${s?.sequence}", which is not in the file` }); if (s?.proxy !== undefined && !refOk(s.proxy)) out.push({ where, what: `proxy "${s.proxy}" is not in the file` }); }
    if (type === "image" || type === "segmentation") {
      const dcm = n.dicom as Obj | undefined;
      if (dcm && typeof dcm.seriesInstanceUID !== "string") out.push({ where, what: "dicom.seriesInstanceUID is missing: the node cannot be found again" });
      if (type === "image" && dcm && !(Array.isArray(dcm.sopInstanceUIDs) && dcm.sopInstanceUIDs.length)) out.push({ where, what: "dicom.sopInstanceUIDs is empty: a frame of a sequence cannot be told from the others" });
    }
    if (type === "segmentation") for (const [i, sg] of ((n.segments as Obj[] | undefined) ?? []).entries()) {
      if (typeof sg?.id !== "string") out.push({ where, what: `segments[${i}] has no id (the core requires one)` });
      if (typeof sg?.labelValue !== "number") out.push({ where, what: `segments[${i}] has no labelValue` });
    }
  }
  return out;
}

/** The series the file names, for a check against a database: [seriesInstanceUID, where]. */
export function seriesNamed(doc: Obj): { uid: string; where: string }[] {
  const out: { uid: string; where: string }[] = [];
  for (const [key, n] of Object.entries((doc.nodes as Record<string, Obj>) ?? {})) {
    const dcm = n?.dicom as Obj | undefined;
    if (typeof dcm?.seriesInstanceUID === "string") out.push({ uid: dcm.seriesInstanceUID, where: `node ${key}` });
    for (const doc2 of (n?.documents as Obj[] | undefined) ?? []) if (typeof doc2?.seriesInstanceUID === "string") out.push({ uid: doc2.seriesInstanceUID, where: `node ${key} documents` });
  }
  return out;
}
