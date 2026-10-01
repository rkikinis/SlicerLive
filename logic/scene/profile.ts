// THE ALBULA SCENE PROFILE, albula-scene/1 -- what a saved scene may contain, as data, so the
// checker (check.ts), the writer (write.ts) and the loader read one definition and cannot drift.
//
// Steve Pieper's mrson core (github.com/pieper/mrson, structure/mrson-core.struct.json, 2026-08-03)
// holds thirteen node types in a closed union. Albula's scene needs three more and a handful of
// fields on the core's types (SCENE-DESIGN-2026-09-20.md §4). Under his governance new data enters
// through a profile, named and versioned, that a scene declares in `extensionsUsed`; how a profile
// adds a TYPE his validator accepts is asked of him (2026-09-20) -- until then this is Albula's
// own checker, to be synced with his when he answers (Ron: "let's do our own checker and sync once
// we hear back from him"). The same content is written out as a structure file in his form by
// `deno run -A logic/scene/profile.ts > Contents/docs/profiles/albula-scene-1.struct.json` and
// described for people in Contents/docs/profiles/albula-scene-1.md.

export const PROFILE_ID = "albula-scene/1";
export const MRSON_VERSION = 0;

/** A field's kind, enough to check a value's shape. */
export type Kind =
  | "string" | "number" | "boolean" | "int"
  | "vec3" | "matrix16" | "rgba" | "numbers" | "strings"
  | "ref" | "refs"            // a node id, a list of node ids -- checked to resolve
  | "code"                    // {scheme, value, meaning?}
  | "object" | "array";

export interface FieldSpec { kind: Kind; required?: boolean; /** where the field comes from */ from: "core" | "profile"; note?: string }

/** The node types a scene may hold, with the fields the checker knows. Unknown fields pass (open
 *  objects, as in Steve's core); unknown TYPES do not. */
export const NODE_TYPES: Record<string, Record<string, FieldSpec>> = {
  // ── Steve's core types, with the profile's fields marked ──
  image: {
    dims: { kind: "numbers", required: true, from: "core" },
    ijkToRAS: { kind: "matrix16", required: true, from: "core" },
    voxelType: { kind: "string", from: "core" },
    comps: { kind: "int", from: "core" },
    frame: { kind: "string", from: "core", note: "the Frame of Reference UID as a named frame; RAS when the series has none" },
    dicom: { kind: "object", required: true, from: "profile", note: "seriesInstanceUID, studyInstanceUID, sopInstanceUIDs, frameOfReferenceUID; the instance list names the frame of a sequence" },
    digest: { kind: "string", from: "profile", note: "sha-256 over the volume's chunk hashes: its content identity" },
    name: { kind: "string", from: "core" },
    refs: { kind: "refs", from: "core" },
  },
  segmentation: {
    referenceImage: { kind: "ref", required: true, from: "core" },
    segments: { kind: "array", required: true, from: "core" },
    dicom: { kind: "object", required: true, from: "profile", note: "the SEG's seriesInstanceUID (saved as, else loaded from), sopClassUID" },
    zOrder: { kind: "int", from: "profile" },
    hiddenViews: { kind: "strings", from: "profile" },
    fill2D: { kind: "object", from: "profile" },
    outline2D: { kind: "object", from: "profile" },
    visible: { kind: "boolean", from: "core" },
    visible3D: { kind: "boolean", from: "profile" },
    opacity: { kind: "number", from: "profile" },
    name: { kind: "string", from: "core" },
    refs: { kind: "refs", from: "core" },
  },
  transferFunction: {
    colorStops: { kind: "array", from: "core" },
    scalarOpacity: { kind: "array", from: "core" },
    gradientOpacity: { kind: "array", from: "core" },
    shading: { kind: "object", from: "profile", note: "{ambient, diffuse, specular, power}; richer than the core's boolean `shade`" },
    preset: { kind: "string", from: "profile" },
    segmentGroups: { kind: "array", from: "profile" },
    contextOpacity: { kind: "number", from: "profile" },
    ctModulation: { kind: "number", from: "profile" },
    segmentOpacity: { kind: "number", from: "profile" },
    name: { kind: "string", from: "core" },
  },
  scalarVolumeDisplay: {
    visible: { kind: "boolean", from: "core" },
    window: { kind: "number", from: "core" },
    level: { kind: "number", from: "core" },
    interpolate: { kind: "boolean", from: "core" },
    color: { kind: "rgba", from: "core" },
    applyThreshold: { kind: "boolean", from: "profile" },
    threshold: { kind: "numbers", from: "profile" },
    refs: { kind: "refs", from: "core" },
  },
  volumeRenderingDisplay: {
    visible: { kind: "boolean", from: "core" },
    refs: { kind: "refs", required: true, from: "core", note: "volume, transferFunction (Steve's name for the edge)" },
  },
  view: {
    kind: { kind: "string", required: true, from: "core", note: "slice | 3d" },
    layoutName: { kind: "string", from: "core" },
    orientation: { kind: "string", from: "core", note: "axial, sagittal, coronal, short-axis, two-chamber, four-chamber" },
    sliceToRAS: { kind: "matrix16", from: "core" },
    fieldOfView: { kind: "numbers", from: "core", note: "millimetres, never a function of the window" },
    offset: { kind: "number", from: "profile" },
    drawingLook: { kind: "boolean", from: "profile" },
    shadingVersion: { kind: "int", from: "profile", note: "render/shading-versions.ts: 1 every structure lit alike, 2 tissue finishes" },
    boxVisible: { kind: "boolean", from: "profile" },
    axisLabelsVisible: { kind: "boolean", from: "profile" },
    orientationMarkerType: { kind: "int", from: "profile" },
    lighting: { kind: "string", from: "profile" },
    refs: { kind: "refs", from: "core", note: "camera, for a 3d view" },
    name: { kind: "string", from: "core" },
  },
  camera: {
    position: { kind: "vec3", required: true, from: "core" },
    focalPoint: { kind: "vec3", required: true, from: "core" },
    viewUp: { kind: "vec3", required: true, from: "core" },
    viewAngle: { kind: "number", from: "core" },
    parallelScale: { kind: "number", from: "core" },
    parallelProjection: { kind: "boolean", from: "profile" },
  },
  layout: {
    arrangement: { kind: "int", from: "core" },
    arrangementName: { kind: "string", from: "core" },
    splits: { kind: "object", from: "profile", note: "the sidebar and view splits, as settings.ini keeps them" },
  },
  markup: {
    markupType: { kind: "string", required: true, from: "core" },
    controlPoints: { kind: "array", from: "core" },
    center: { kind: "vec3", from: "core" },
    size: { kind: "vec3", from: "core" },
    orientation: { kind: "matrix16", from: "profile", note: "the crop box's axes" },
    name: { kind: "string", from: "core" },
  },
  transform: {
    transformType: { kind: "string", required: true, from: "core" },
    toParent: { kind: "matrix16", from: "core" },
    name: { kind: "string", from: "core" },
  },
  // ── the profile's own types ──
  sequence: {
    indexName: { kind: "string", from: "profile" },
    indexUnit: { kind: "string", from: "profile" },
    indexType: { kind: "string", from: "profile" },
    numericIndexValueTolerance: { kind: "number", from: "profile" },
    items: { kind: "array", required: true, from: "profile", note: "[{index, node, time}] -- node is a ref" },
    companionOf: { kind: "ref", from: "profile" },
    heartRateBpm: { kind: "number", from: "profile" },
    documents: { kind: "array", from: "profile", note: "[{name, seriesInstanceUID}] -- references, never pictures" },
    name: { kind: "string", from: "core" },
  },
  sequenceBrowser: {
    sequences: { kind: "array", required: true, from: "profile", note: "[{sequence, proxy, playback}] -- sequence and proxy are refs" },
    selectedItemNumber: { kind: "int", from: "profile" },
    playbackRateFps: { kind: "number", from: "profile" },
    playbackLooped: { kind: "boolean", from: "profile" },
    name: { kind: "string", from: "core" },
  },
  sliceComposite: {
    layoutName: { kind: "string", required: true, from: "profile" },
    refs: { kind: "refs", from: "profile", note: "background, foreground, label" },
    foregroundOpacity: { kind: "number", from: "profile" },
    labelOpacity: { kind: "number", from: "profile" },
    compositing: { kind: "int", from: "profile" },
    linkedControl: { kind: "boolean", from: "profile" },
    name: { kind: "string", from: "core" },
  },
};

/** The envelope: what every scene file carries besides its nodes. */
export const ENVELOPE: Record<string, FieldSpec> = {
  mrson: { kind: "int", required: true, from: "core" },
  extensionsUsed: { kind: "strings", required: true, from: "core", note: "must contain albula-scene/1" },
  source: { kind: "object", required: true, from: "core", note: "producer (the build stamp), producedAt (ISO time), origin (the window)" },
  v: { kind: "int", required: true, from: "profile", note: "how many times this scene was saved" },
  name: { kind: "string", required: true, from: "profile" },
  study: { kind: "object", required: true, from: "profile", note: "{ studyInstanceUID } — the first study named; the browser lists the scene under every study in `studies`" },
  studies: { kind: "strings", from: "profile", note: "every StudyInstanceUID the scene names, one patient (a ReMIND case: pre-op MRI, intra-op MRI, intra-op US are three studies)" },
  nodes: { kind: "object", required: true, from: "core" },
};

/** Steve's structure-file form of the same content, for the sync when his validator composes profiles. */
export function toStructureFile(): unknown {
  const kindType = (k: Kind): unknown => ({
    string: { type: "string" }, number: { type: "double" }, boolean: { type: "boolean" }, int: { type: "int32" },
    vec3: { type: "array", items: { type: "double" } }, matrix16: { type: "array", items: { type: "double" } },
    rgba: { type: "array", items: { type: "double" } }, numbers: { type: "array", items: { type: "double" } },
    strings: { type: "array", items: { type: "string" } }, ref: { type: "string" }, refs: { type: "map", values: { type: "array", items: { type: "string" } } },
    code: { type: "object", properties: { scheme: { type: "string" }, value: { type: "string" }, meaning: { type: "string" } }, required: ["scheme", "value"] },
    object: { type: "object" }, array: { type: "array", items: { type: "object" } },
  } as Record<Kind, unknown>)[k];
  const definitions: Record<string, unknown> = {};
  for (const [type, fields] of Object.entries(NODE_TYPES)) {
    const name = type[0].toUpperCase() + type.slice(1) + "Node";
    definitions[name] = {
      type: "object",
      comment: `Fields marked profile are albula-scene/1's; the rest are the mrson core's (github.com/pieper/mrson).`,
      properties: Object.fromEntries(Object.entries(fields).map(([f, spec]) => [f, { ...(kindType(spec.kind) as object), ...(spec.note ? { comment: `${spec.from}: ${spec.note}` } : { comment: spec.from }) }])),
      required: ["id", ...Object.entries(fields).filter(([, s]) => s.required).map(([f]) => f)],
    };
  }
  definitions.AnyNode = { type: "choice", selector: "type", choices: Object.fromEntries(Object.keys(NODE_TYPES).map((t) => [t, { type: { $ref: `#/definitions/${t[0].toUpperCase() + t.slice(1)}Node` } }])) };
  definitions.Scene = {
    type: "object",
    properties: { ...Object.fromEntries(Object.entries(ENVELOPE).map(([f, spec]) => [f, f === "nodes" ? { type: "map", values: { type: { $ref: "#/definitions/AnyNode" } } } : { ...(kindType(spec.kind) as object), ...(spec.note ? { comment: spec.note } : {}) }])) },
    required: Object.entries(ENVELOPE).filter(([, s]) => s.required).map(([f]) => f),
  };
  return {
    $schema: "https://json-structure.org/meta/core/v0/#",
    $id: `https://github.com/rkikinis/SlicerAlbula/profiles/${PROFILE_ID}`,
    $root: "#/definitions/Scene",
    comment: "The Albula scene profile: Steve Pieper's mrson core plus what an Albula scene needs (SCENE-DESIGN-2026-09-20.md). Written by logic/scene/profile.ts; do not edit by hand.",
    definitions,
  };
}

if (import.meta.main) console.log(JSON.stringify(toStructureFile(), null, 2));
