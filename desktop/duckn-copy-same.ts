// COPIES MADE BY EARLIER CODE THAT WRITES THE SAME BYTES. A copy carries the fingerprint of the converter that wrote it
// (duckn-copy-code.ts), and any change to that converter's code -- dcmjs included -- retires every copy. Some changes
// cannot alter a byte a copy holds; for those, the earlier fingerprint is listed here with the later one it equals and
// how that was shown, as the diffusion extension does for tracts (code-equivalences.json). A copy is current when its
// fingerprint leads to this one's by these steps. The server (duckn-copy-check.ts) and the page (render/zarr-copy.ts) ask
// here, so they cannot disagree.
//
// THIS FILE IS OUTSIDE THE FINGERPRINT (the converter does not import it): adding an entry does not move the value it
// names. An entry goes in only when the change cannot alter a written byte, with the evidence.
export const COPY_CODE_SAME: Record<string, { same: string; why: string }> = {
  "albula-duckn-3-b399bda005d0": {
    same: "albula-duckn-3-d2110bc47208",
    why: "2026-10-30: only logic/dicom-io.ts changed -- dcmjs's lookup of a position's piece made a binary search, and NaN still refused. " +
      "The bytes written are the same: logic/dicom-io.test.ts compares the two lookups' output; the critic's fuzz, 1.2 million positions " +
      "on read and write streams, found no difference (qa/2026-10-30-dcmjs-issue.md); the import job's result fingerprint unchanged on a 370,790-streamline case.",
  },
};

/** Whether a copy written by `code` counts as written by `current`: the same, or reached by the steps above. */
export function sameCopyCode(code: string | undefined, current: string): boolean {
  let c = code, n = 0;
  while (c !== undefined && c !== current && COPY_CODE_SAME[c] && n++ < 32) c = COPY_CODE_SAME[c].same;
  return c === current;
}
