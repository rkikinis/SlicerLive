// EVERY BUTTON ANSWERS THE CLICK, checked by reading the source rather than by remembering.
//
// Ron, 2026-09-22, after pressing Save to DICOM on a whole-body segmentation: "no visible reaction
// on the button. There was some text display in low contrast microprint at the bottom ... You
// should review all buttons. If I click them they should give me immediate visual feedback. This
// requirement is for every button that can be clicked."
//
// There are two halves to it and this file guards both.
//
// THE PRESS is answered for every button in the application by one listener in mountAppShell --
// there are about 170 click handlers, and a rule that has to be remembered at each of them is a
// rule that will be missed at the next one. So the test is that the listener is still there.
//
// THE OUTCOME belongs on the button too when the work takes time: runAction's busy word, then
// "Saved ✓" or "Not saved". This test names the handlers that start slow work and fails if one of
// them stops going through runAction -- a short, specific list, because "every async handler"
// includes a dozen that finish in a frame and would only flicker.
import { assert } from "jsr:@std/assert";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));

Deno.test("the press is acknowledged for every button, in one place", () => {
  const shell = read("./app-shell.ts");
  assert(/addEventListener\("pointerdown"[\s\S]{0,200}acknowledge/.test(shell), "app-shell no longer flashes the button it was pressed on");
  // Keyboard activation fires no pointer event, and the four Load / Save arrows are not <button>
  // (critic 2026-09-22, 2.2 and 2.6). Both were missed by the first version of this listener.
  assert(/addEventListener\("keydown"[\s\S]{0,300}acknowledge/.test(shell), "a button pressed with Space or Enter is acknowledged by nothing");
  assert(/closest\?\.\("button, \[role=button\]"\)/.test(shell), "the acknowledgement no longer reaches [role=button]");
  const css = read("./theme.css");
  // WRITTEN TWICE, and last in the file: at one class it loses to every :hover rule that paints a
  // background, which is the state a button is always in when it is pressed (critic 2.1).
  const rule = /button\.sl-hit\.sl-hit\s*\{/.exec(css);
  assert(rule, "theme.css has no doubled .sl-hit rule, so the press paints nothing under the cursor");
  const hoverAfter = css.slice(rule.index).match(/button:hover\s*\{[^}]*background/);
  assert(!hoverAfter, "a :hover rule that paints a background now comes AFTER the .sl-hit rules and wins again");
});

Deno.test("the buttons that start slow work report on themselves", () => {
  // marker -> the file it lives in. The marker is what the handler is wired to, so a rename that
  // moves the button also brings the test's attention to it.
  const slow: [string, string][] = [
    ["sl-ai-res-save", "./ai-seg-panel.ts"],        // save a finished AI result to the database
    ["loadBtn.addEventListener", "./load-panel.ts"], // load the ticked series
    ["packBtn.addEventListener", "./load-panel.ts"], // package a scene
    ["g.__saveScene?.(", "./scene-control.ts"],     // save the scene: the one Scene control, every placement
    ["g.__openScene?.(", "./scene-control.ts"],     // open a scene from its menu
    ["goBtn.addEventListener", "./merge-segmentations.ts"],
    ["findBtn.addEventListener", "./merge-segmentations.ts"],
    ["sl-crop-save", "./crop-panel.ts"],
    ["button.sl-auto", "./volumes-panel.ts"],        // auto window/level
  ];
  const missing: string[] = [];
  for (const [marker, file] of slow) {
    const src = read(file);
    // A marker appears twice: once in the button's markup, once where it is wired. Any occurrence
    // with runAction close after it is the wiring, and that is what this is asking about.
    const spots: number[] = [];
    for (let i = src.indexOf(marker); i >= 0; i = src.indexOf(marker, i + 1)) spots.push(i);
    if (!spots.length) { missing.push(`${marker} is gone from ${file}`); continue; }
    if (!spots.some((i) => src.slice(i, i + 900).includes("runAction"))) {
      missing.push(`${marker} in ${file} no longer goes through runAction`);
    }
  }
  assert(missing.length === 0, missing.join("\n"));
});
