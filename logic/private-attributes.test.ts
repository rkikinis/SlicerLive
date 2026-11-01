// Rule 2 at every depth (logic/private-attributes.ts): a private element inside a standard sequence goes too, and is
// named; standard elements and the reader's own bookkeeping stay.
//
//   deno test -A --no-check logic/private-attributes.test.ts
import { assertEquals } from "jsr:@std/assert";
import { stripNestedPrivate } from "./private-attributes.ts";

Deno.test("private elements nested in standard sequences are removed and named; standard ones stay", () => {
  const ds: Record<string, unknown> = {
    PatientID: "PUB-1",
    ReferencedStudySequence: [{ ReferencedSOPInstanceUID: "1.2.3", "00291010": "vendor", "(0043,1001)": "ge" }],
    ProcedureCodeSequence: { CodeValue: "X", "00191001": { inner: [{ "00511010": 1 }] } },
    _vrMap: { "00291010": "LO" },
  };
  const removed = stripNestedPrivate(ds);
  assertEquals(removed.sort(), ["00191001", "00291010", "00431001"]);
  assertEquals(ds.ReferencedStudySequence, [{ ReferencedSOPInstanceUID: "1.2.3" }]);
  assertEquals(ds.ProcedureCodeSequence, { CodeValue: "X" });
  assertEquals(ds._vrMap, { "00291010": "LO" }, "the reader's bookkeeping is not touched");
  assertEquals(ds.PatientID, "PUB-1");
});
