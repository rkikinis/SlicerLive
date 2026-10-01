import { assert } from "jsr:@std/assert";
import { ImageField, RGBAVolumeField, SegmentField } from "../fields.ts";
import { ColorizeField } from "../colorize-field.ts";

// EVERY FIELD THE 3D VIEW CAN DRAW MUST BE ABLE TO BE RE-LIT.
//
// The lighting panel calls `field.setShade?.(...)` over everything in the view, and an optional call
// on a method that does not exist does nothing AND REPORTS NOTHING. SegmentField and RGBAVolumeField
// -- the two that actually draw a segmentation in 3D -- had no such method: they read ka/kd/ks/sh
// from their uniforms, so the shader was ready, but nothing could set them. ImageField and
// ColorizeField did have it, which is what made the wiring look correct while the presets did
// nothing to what Ron was looking at. Twice: "No impact."
//
// A missing method cannot be caught by the caller, because `?.` is exactly the syntax for "it might
// not be there". So it has to be caught here.
Deno.test("every field type can be re-lit after construction", () => {
  for (const [name, cls] of [
    ["ImageField", ImageField],
    ["SegmentField", SegmentField],
    ["RGBAVolumeField", RGBAVolumeField],
    ["ColorizeField", ColorizeField],
  ] as [string, { prototype: Record<string, unknown> }][]) {
    assert(
      typeof cls.prototype.setShade === "function",
      `${name} has no setShade, so the 3D view's lighting cannot reach it — and the optional call ` +
        `the panel makes will fail silently rather than throw`,
    );
  }
});
