// The presentation library's PRECEDENCE, which is the part that has to keep working as entries are
// added. Ron: "do not think of this as a one-off but as the beginning of a library of special cases."
//
//   deno test -A --no-check logic/presentation.test.ts

import { assertEquals } from "jsr:@std/assert";
import {
  allPresets,
  DEFAULT_PRESET,
  DEFAULT_PRESENTATION,
  ecosystemOf,
  hasPresentation,
  PRESETS,
  presentationFor,
  presentationParams,
  presetIdFor,
} from "./presentation.ts";

Deno.test("ecosystem: the part before the colon, and a bare name is its own", () => {
  assertEquals(ecosystemOf("fastsurfer:brain"), "fastsurfer");
  assertEquals(ecosystemOf("ts:total"), "ts");
  assertEquals(ecosystemOf("synthstrip"), "synthstrip");
});

// The point of keying on the ecosystem: a task this table has never heard of still gets its
// package's house style. A FastSurfer task added tomorrow must not need an edit here.
Deno.test("a task not listed by name inherits its ecosystem's appearance", () => {
  assertEquals(presentationFor("fastsurfer:brain").contextOn, false);
  assertEquals(presentationFor("fastsurfer:something_added_later").contextOn, false);
});

Deno.test("an unrecognised package gets the default, not a neighbour's style", () => {
  assertEquals(presentationFor("ts:total"), DEFAULT_PRESENTATION);
  assertEquals(presentationFor("moose:clin_ct_body"), DEFAULT_PRESENTATION);
});

// A package can have a house style and one of its tasks still depart from it.
Deno.test("a whole-task entry beats its ecosystem's", () => {
  const saved = DEFAULT_PRESET["fastsurfer:brain"];
  try {
    DEFAULT_PRESET["fastsurfer:brain"] = DEFAULT_PRESENTATION.id;
    // WHICH PRESET WON, asserted by id. This read contextOn instead, which worked only while the two
    // presets happened to disagree about it -- once the default's unlabeled body went off to match
    // the parcellation preset's, the proxy stopped distinguishing anything and the test failed
    // without any dispatch having changed.
    assertEquals(presentationFor("fastsurfer:brain").id, DEFAULT_PRESENTATION.id);
    assertEquals(presentationFor("fastsurfer:other").id, DEFAULT_PRESET["fastsurfer"]);
  } finally {
    if (saved) DEFAULT_PRESET["fastsurfer:brain"] = saved;
    else delete DEFAULT_PRESET["fastsurfer:brain"];
  }
});

Deno.test("hasPresentation distinguishes a considered appearance from the default", () => {
  assertEquals(hasPresentation("fastsurfer:brain"), true);
  assertEquals(hasPresentation("ts:total"), false);
});

// contextOn and context are kept apart in the preset because the TOGGLE needs them apart; only the
// renderer's one number folds them together.
Deno.test("params: an unlabelled body that is off is one at opacity zero", () => {
  assertEquals(presentationParams(presentationFor("fastsurfer:brain")).contextOpacity, 0);
});

Deno.test("params: turning it back on restores the preset's own level, not a global constant", () => {
  const p = presentationFor("fastsurfer:brain");
  assertEquals(presentationParams({ ...p, contextOn: true }).contextOpacity, p.context);
});

Deno.test("params: the default preset starts with the unlabelled body off", () => {
  assertEquals(presentationParams(DEFAULT_PRESENTATION), {
    // Ron: "Please turn the nonlabeled voxel opacity off by default ... For this work it is in the
    // way." Zero is what the renderer is told; the 0.12 to come back to lives in the preset.
    contextOpacity: 0,
    ctModulation: 0.55,
    segmentOpacity: 1,
  });
  assertEquals(DEFAULT_PRESENTATION.context, 0.12, "the level to restore must survive being off");
});

// A preset with no stated reason should not be in the table -- that is the rule the overrides table
// follows, and it is what keeps this readable as it grows.
// A preset a person can pick has to be nameable, and a default has to point at one that exists --
// otherwise the picker shows a blank row, or a network starts in a preset that is not there.
Deno.test("every preset has an id, a name, and is reachable from the picker", () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    assertEquals(p.id, id, "the key and the id must agree");
    assertEquals(p.name.length > 0, true, `${id} needs a name`);
  }
  assertEquals(allPresets().map((p) => p.id).sort(), Object.keys(PRESETS).sort());
  assertEquals(allPresets()[0].id, DEFAULT_PRESENTATION.id, "the default leads the list");
});

Deno.test("every default points at a preset that exists", () => {
  for (const [task, id] of Object.entries(DEFAULT_PRESET)) {
    assertEquals(id in PRESETS, true, `${task} defaults to a missing preset ${id}`);
  }
  // FastSurfer starts LIT as of 2026-09-08. Ron liked the bone in Steve's roi.html and asked for
  // those parameters here; the only part of them that survives the move to a labelmap is the
  // lighting, so this is that preset. The flat one is deliberately still in the list -- its reason
  // stands ("Look at all the texture in the superior frontal gyrus") and whether shading reads as
  // form or as noise is a matter of looking, so it has to stay switchable.
  assertEquals(presetIdFor("fastsurfer:brain"), "parcellation-lit");
  assertEquals("parcellation" in PRESETS, true, "the flat parcellation must stay available");
  assertEquals(PRESETS["parcellation"].shade, undefined, "the flat one carries no lighting");
  assertEquals(PRESETS["parcellation-lit"].shade, [0.1, 0.9, 0.2, 10], "Slicer's own VR shade");
  assertEquals(presetIdFor("ts:total"), DEFAULT_PRESENTATION.id);
});

Deno.test("every entry says why", () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    assertEquals(typeof p.why === "string" && p.why.length > 20, true, `${key} needs a real why`);
  }
});

// Ron, on the first parcellation that rendered: "Look at all the texture in the superior frontal
// gyrus. It's everywhere but most prominent with lighter colors." That texture is the T1 underneath
// modulating each parcel's brightness. A parcellation is flat paint -- the color IS the label.
Deno.test("the parcellation preset is flat: nothing of the image shows through the colour", () => {
  assertEquals(presentationFor("fastsurfer:brain").modulation, 0);
  assertEquals(presentationParams(presentationFor("fastsurfer:brain")).ctModulation, 0);
});

// The default is not flat, and should not become flat: a whole-body CT reads as tissue because the
// intensity underneath still varies the color.
Deno.test("the default preset keeps the image showing through", () => {
  assertEquals(DEFAULT_PRESENTATION.modulation > 0, true);
});
