// THE TEST SCENE: a live scene the size of the cardiac one, in shape -- two frames, a sequence,
// a browser, a segmentation on frame 2, displays, a transfer function, views, a camera. Shared
// by the writer's, the checker's and the round trip's tests so they all speak of the same scene.
import type { MrsonNode } from "../../render/mrson.ts";

/** A live scene the size of the cardiac one, in shape: two frames, a sequence, a browser, a segmentation on frame 2, displays, views, camera. */
export function liveNodes(): MrsonNode[] {
  const zarr = (seed: string) => ({ shape: [4, 4, 2], chunks: [2, 2, 2], chunkGrid: [1, 2, 2], dtype: "<i2", bytes: 64, chunkHashes: { "0.0.0": `sha256-${seed}a`, "0.0.1": `sha256-${seed}b`, "0.1.0": `sha256-${seed}c`, "0.1.1": `sha256-${seed}d` }, compressor: "raw" });
  const img = (id: string, frame: number, seed: string): MrsonNode => ({
    type: "image", id, name: `CT · ${frame === 0 ? "213" : "250"} ms`, frame: "RAS", dims: [4, 4, 2], comps: 1, ijkToRAS: Array(16).fill(0), zarr: zarr(seed), labelmap: false, hidden: true,
    sequence: "local-sequence-1", refs: { display: [`${id}-display`] },
    origin: { local: true, seriesInstanceUID: "1.2.3.4", studyInstanceUID: "1.2.3", sopInstanceUIDs: [`1.2.3.4.${frame}.1`, `1.2.3.4.${frame}.2`], patientName: "Someone", frame, frameLabel: `${frame === 0 ? 213 : 250} ms`, modality: "CT" },
  } as unknown as MrsonNode);
  const disp = (id: string): MrsonNode => ({ type: "scalarVolumeDisplay", id: `${id}-display`, visible: true, window: 1400, level: 300, autoWindowLevel: true, interpolate: true, refs: {} } as unknown as MrsonNode);
  return [
    img("local-image-1", 0, "x"), disp("local-image-1"), img("local-image-3", 1, "y"), disp("local-image-3"),
    { type: "sequence", id: "local-sequence-1", name: "phases", indexName: "delay after R-wave", indexUnit: "ms", items: [{ index: "213", node: "local-image-1", time: 0.213 }, { index: "250", node: "local-image-3", time: 0.25 }], heartRateBpm: 86, documents: [{ name: "ECG", seriesInstanceUID: "1.2.3.5", images: [{ dataUrl: "data:image/png;base64,AAAA", width: 10, height: 10 }] }], origin: { local: true } } as unknown as MrsonNode,
    { type: "sequenceBrowser", id: "local-sequenceBrowser-1", sequences: [{ sequence: "local-sequence-1", proxy: "local-image-3", playback: true }], selectedItemNumber: 1, playbackActive: true, playbackRateFps: 10, playbackLooped: true } as unknown as MrsonNode,
    { type: "segmentation", id: "local-segmentation-1", name: "chambers", frame: "RAS", dims: [4, 4, 2], ijkToRAS: Array(16).fill(0), zarr: zarr("s"), refs: { source: ["local-image-3"] }, segments: [{ labelValue: 1, structure: "heart_myocardium", name: "Myocardium", color: [0.75, 0.41, 0.35], visible: true, opacity: 0.35, fileColor: [0.7, 0.4, 0.3] }], visible: true, visible3D: true, opacity: 1, zOrder: 0, origin: { local: true, task: "ts:heartchambers_highres", seriesInstanceUID: "2.25.7", studyInstanceUID: "1.2.3", sopClassUID: "1.2.840.10008.5.1.4.1.1.66.7" } } as unknown as MrsonNode,
    { type: "transferFunction", id: "local-transferFunction-1", name: "VR", colorStops: [{ value: 0, rgba: [0, 0, 0] }], scalarOpacity: [{ value: 0, opacity: 0 }], preset: "CT-Soft-Tissue", shade: [0.2, 1, 0.2, 20] } as unknown as MrsonNode,
    { type: "volumeRenderingDisplay", id: "local-vr-1", name: "VR", visible: true, refs: { volume: ["local-image-1"], property: ["local-transferFunction-1"] } } as unknown as MrsonNode,
    { type: "view", id: "nativeSlice-Red", kind: "slice", layoutName: "Red", orientation: "short-axis", sliceToRAS: Array(16).fill(0), fieldOfView: [139, 139, 1], offset: 288.7, source: { local: true } } as unknown as MrsonNode,
    { type: "sliceComposite", id: "local-sliceComposite-Red", layoutName: "Red", refs: { background: ["local-image-1"] }, foregroundOpacity: 0, labelOpacity: 1, compositing: 0, linkedControl: false } as unknown as MrsonNode,
    { type: "camera", id: "local-camera-3d", position: [0, -500, 0], focalPoint: [0, 0, 0], viewUp: [0, 0, 1], viewAngle: 30, parallelProjection: false, parallelScale: 100 } as unknown as MrsonNode,
    { type: "view", id: "nativeView-3D", kind: "3d", refs: { camera: ["local-camera-3d"] }, drawingLook: true, boxVisible: false, lighting: "Glossy" } as unknown as MrsonNode,
    { type: "interaction", id: "local-interaction" } as unknown as MrsonNode,      // runtime: dropped
  ];
}

