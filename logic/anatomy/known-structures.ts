// Structures a person can NAME, beyond what the segmenters can produce.
//
// The vendored `totalsegmentator.json` is what one tool asserts, and it is bounded by what that
// tool was trained to output. A person naming a region by hand is not so bounded: nnInteractive
// will segment anything pointed at, so the catalog of things that can be named has to be wider
// than the catalog of things that can be produced.
//
// Ron's example is the one that prompted this. TotalSegmentator merges the iliacus and the psoas
// major into a single "iliopsoas" and ships no iliacus at all -- but his nnInteractive study
// already holds the two as separate regions: "in the nninteractive segmentation they are two
// muscles. So they are easily separateable." They are not missing, only unnamed. Without an entry
// here there would be no correct name to give one of them, and the module would force a choice
// between a wrong name and none.
//
// Entries carry whatever identity could be sourced WITHIN THE LICENSE, and no more. A SNOMED CT
// code belongs here only when it arrives with a DICOM context group -- that is the freely usable
// set, and pasting one in from a licensed release would put a paywalled identifier into a
// repository meant to be shareable. An absent `code` therefore means "not in the free set", never
// "does not exist". The reasoning, and what was checked, is in overrides.ts.
import type { NamedStructure } from "../segment-naming.ts";

/** Keyed the way a segmenter would key it, so it resolves through the same lookup. */
export const KNOWN_STRUCTURES: Record<string, NamedStructure> = {
  iliacus_left: {
    name: "Iliacus muscle, left",
    system: "Muscular system",
    otherIds: ["FMA:22310", "TA2:2594"],
    note: "no SNOMED CT code could be sourced on this machine; the identifiers are Wikipedia's infobox",
    origin: "asserted",
    by: "Ron Kikinis",
  },
  iliacus_right: {
    name: "Iliacus muscle, right",
    system: "Muscular system",
    otherIds: ["FMA:22310", "TA2:2594"],
    note: "no SNOMED CT code could be sourced on this machine; the identifiers are Wikipedia's infobox",
    origin: "asserted",
    by: "Ron Kikinis",
  },
  /**
   * The cerebral aqueduct, which FreeSurfer does not segment.
   *
   * Ron, defining the entity: "for the ventricles: the entity is ventricular system, its components
   * are left and right lateral ventricle, third ventricle, aqueduct and fourth ventricle." Four of
   * those five arrive in an aseg; the aqueduct does not. FreeSurferColorLUT.txt has only
   * PERIaqueductal gray -- the brainstem tissue around it -- so the segmentation hands us the cavity
   * with a gap in the middle of it.
   *
   * Named here for the same reason the iliacus is: this table is what a person can NAME, not what a
   * tool can produce. The name completes the entity, so the system can be described correctly even
   * though nothing segments it.
   *
   * AND IT SHOULD STAY THAT WAY -- this entry is not a request for someone to go and segment it.
   * Ron: "there is pulsatile flow in the aqueduct, its volume is negligible, and its appearance on
   * MRI varies, depending on the flow and the sequence. Small stuff, very difficult with little
   * benefit." Three separate reasons, and the last is the one that decides: a structure whose
   * appearance depends on the sequence cannot be measured consistently, and its volume would not be
   * worth the number if it could. If a future segmenter produces one it will land correctly; nobody
   * should spend effort making that happen.
   */
  cerebral_aqueduct: {
    name: "Cerebral aqueduct",
    system: "Ventricular system",
    otherIds: ["FMA:78467", "TA2:5806"],
    note: "not produced by FreeSurfer's aseg, which has only periaqueductal gray. Named to complete " +
      "the ventricular system, not to invite segmenting it: pulsatile flow, negligible volume, and " +
      "an MRI appearance that varies with flow and sequence",
    origin: "asserted",
    by: "Ron Kikinis",
  },
};
