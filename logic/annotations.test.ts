// A note and a flag have to survive being written as DICOM and read back, because the whole point
// of using a Key Object Selection document rather than a private table is that the annotation is
// still there when something other than Albula opens it.
//
//   deno test -A --no-check logic/annotations.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import dcmjs from "./dcmjs.ts";
import { setDcmjs } from "./readers/dicom-series.ts";
setDcmjs(dcmjs);

import { buildAnnotationKos, FLAGS, flagOf, readAnnotation } from "./annotations.ts";

const target = {
  studyInstanceUID: "1.2.3",
  seriesInstanceUID: "1.2.3.4",
  sopInstanceUID: "1.2.3.4.5",
};
const roundTrip = async (opts: Parameters<typeof buildAnnotationKos>[1]) => {
  const k = await buildAnnotationKos(target, opts);
  const back = await readAnnotation(k.bytes.buffer.slice(k.bytes.byteOffset, k.bytes.byteOffset + k.bytes.byteLength) as ArrayBuffer);
  return { k, back };
};

Deno.test("a flag round-trips as a standard DICOM document title", async () => {
  const { k, back } = await roundTrip({ flag: "quality", author: "Ron Kikinis" });
  assertEquals(k.index.modality, "KO");
  assert(back, "the KOS did not read back");
  assertEquals(back.flag, "quality");
  assertEquals(back.author, "Ron Kikinis");
  assertEquals(back.seriesInstanceUID, target.seriesInstanceUID);
  assertEquals(back.studyInstanceUID, target.studyInstanceUID);
});

Deno.test("a note round-trips as the key object description", async () => {
  const note = "Solitary right kidney — compensatory hypertrophy. Nephrogenic phase.";
  const { back } = await roundTrip({ note, author: "Ron Kikinis" });
  assertEquals(back!.note, note);
  // With no flag chosen the document still needs a title; "Of Interest" is the honest default.
  assertEquals(back!.flag, "interest");
});

Deno.test("a flag and a note together", async () => {
  const { back } = await roundTrip({ flag: "research", note: "case for the ts:total comparison" });
  assertEquals(back!.flag, "research");
  assertEquals(back!.note, "case for the ts:total comparison");
});

Deno.test("every flag is a real DCM code and survives the trip", async () => {
  for (const f of FLAGS) {
    assertEquals(flagOf(f.id)?.code, f.code);
    assert(/^\d{6}$/.test(f.code), `${f.id} should carry a six-digit DCM code, got ${f.code}`);
    const { back } = await roundTrip({ flag: f.id });
    assertEquals(back!.flag, f.id, `${f.meaning} did not round-trip`);
  }
});

Deno.test("something that is not a KOS is refused rather than misread", async () => {
  assertEquals(await readAnnotation(new Uint8Array([1, 2, 3, 4]).buffer), null);
});

Deno.test("non-ASCII survives: accents, a name, and a dash", async () => {
  // DICOM's default repertoire is ASCII and dcmjs reads nested sequence text as cp1252, so this is
  // the case that decides whether a real clinical note is readable when it comes back.
  const note = "M\u00fcller \u2014 r\u00e9nal, \u00bd dose, 30\u00b0 oblique";
  const { back } = await roundTrip({ note });
  assertEquals(back!.note, note);
});

Deno.test("ordinary ASCII is left exactly alone", async () => {
  const note = "plain ascii note, nothing to repair";
  const { back } = await roundTrip({ note });
  assertEquals(back!.note, note);
});
