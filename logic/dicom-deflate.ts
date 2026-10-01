// DEFLATED EXPLICIT VR LITTLE ENDIAN (1.2.840.10008.1.2.1.99): the whole dataset after the file
// meta group, deflated as one stream. The one compression DICOM allows for any object, read by
// dcmjs (pako), pydicom, DCMTK, dcmqi, highdicom. Used for the label map segmentation, whose
// dataset is mostly zeros (418 MB -> 3 MB on a whole-body result, measured 2026-09-18); NOT for
// surfaces, where it costs 12 s a save for 40% (measured the same day).
//
// The file is taken as dcmjs writes it (preamble, "DICM", the meta group, the dataset in Explicit
// VR LE), split after the meta group, and reassembled: a new meta group naming the deflated syntax,
// then the deflated dataset bytes. The platform's CompressionStream does the deflate.

export const DEFLATED_EXPLICIT_VR_LE = "1.2.840.10008.1.2.1.99";

/** Where the dataset begins in a Part 10 file: after the 128-byte preamble, "DICM", and the meta group,
 *  whose length is the value of (0002,0000) -- the first element, always UL with a 4-byte value. */
export function datasetOffset(file: Uint8Array): number {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (String.fromCharCode(...file.subarray(128, 132)) !== "DICM") throw new Error("not a DICOM Part 10 file");
  if (dv.getUint16(132, true) !== 0x0002 || dv.getUint16(134, true) !== 0x0000) throw new Error("the meta group does not begin with (0002,0000)");
  const metaLength = dv.getUint32(140, true);
  return 132 + 12 + metaLength;
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Turn an Explicit VR LE Part 10 file into its deflated form. `writeMeta` gives back the bytes of a
 * Part 10 header (preamble + "DICM" + meta group) for a given transfer syntax -- the caller has dcmjs
 * and its meta at hand; this module does not.
 */
export async function deflateDicomFile(file: Uint8Array, writeMeta: (transferSyntaxUID: string) => Uint8Array): Promise<Uint8Array> {
  const start = datasetOffset(file);
  const header = writeMeta(DEFLATED_EXPLICIT_VR_LE);
  const body = await deflateRaw(file.subarray(start));
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0); out.set(body, header.length);
  return out;
}
