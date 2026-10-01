// WHICH IMAGE, BY THE FILE AND ITS FRAME. A volume is found again (scene restore, a SEG's placement, an AI result's
// return) by an instance it holds. For one-image-per-file series the SOPInstanceUID says it; for a multi-frame file every
// volume of it shares ONE SOPInstanceUID, and only the frame number tells them apart (critic, 2026-09-25, finding 8:
// restoring a scene put volume 1's window on volume 0 of a multi-frame fMRI). The volume keeps `frameNumbers` beside
// `sopInstanceUIDs` (logic/readers/dicom-series.ts); every matcher asks through here.
export interface InstanceRef { uid: string; frame?: number }
interface Origin { sopInstanceUIDs?: string[]; frameNumbers?: number[] }

/** The first image of a volume, as a reference (with its frame when the volume comes from a multi-frame file). */
export function firstInstance(o: Origin | undefined): InstanceRef | undefined {
  const uid = o?.sopInstanceUIDs?.[0];
  if (!uid) return undefined;
  const frame = o?.frameNumbers?.[0];
  return typeof frame === "number" ? { uid, frame } : { uid };
}

/** Does this volume hold that image? By the frame too when both sides know it; by the uid alone otherwise (a scene saved
 *  before frames were kept, a SEG that names no frame). */
export function holdsInstance(o: Origin | undefined, ref: InstanceRef | undefined): boolean {
  if (!o || !ref?.uid) return false;
  const uids = o.sopInstanceUIDs ?? [];
  const frames = o.frameNumbers;
  if (typeof ref.frame === "number" && frames?.length === uids.length) {
    for (let i = 0; i < uids.length; i++) if (uids[i] === ref.uid && frames[i] === ref.frame) return true;
    return false;
  }
  return uids.includes(ref.uid);
}

/** Every image of a volume as a key, "uid" or "uid#frame" -- for digests of the exact set. */
export function instanceKeys(o: Origin | undefined): string[] {
  const uids = o?.sopInstanceUIDs ?? [];
  const frames = o?.frameNumbers;
  return uids.map((u, i) => frames?.length === uids.length ? `${u}#${frames[i]}` : u);
}
