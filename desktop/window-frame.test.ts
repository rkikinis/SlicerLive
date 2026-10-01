// The window's remembered place, one per display: what is saved, what is refused, what a start picks
// for the displays attached, and that only a server given a file writes one.
import { assertEquals } from "jsr:@std/assert@1";
import { chooseFrame, handleWindowRequest, parseLine, readWindowFrames, type Display } from "./window-frame.ts";

const office: Display = { w: 2560, h: 1440, usable: { x: 0, y: 25, w: 2560, h: 1340 } };
const laptop: Display = { w: 1512, h: 982, usable: { x: 0, y: 38, w: 1512, h: 870 } };

Deno.test("a line is a display and four numbers (or the launcher's four), nothing under 640 x 480", () => {
  assertEquals(parseLine("2560x1440 356 123 1600 1000"), { display: "2560x1440", x: 356, y: 123, w: 1600, h: 1000 });
  assertEquals(parseLine("356 123 1600 1000"), { display: "", x: 356, y: 123, w: 1600, h: 1000 });
  assertEquals(parseLine("2560x1440 356 123 53 48"), null, "the icon-sized frame of 2026-09-23");
  assertEquals(parseLine("a b c d"), null);
});

Deno.test("the office window comes back in the office, the laptop window on the laptop", () => {
  const saved = [
    { display: "1512x982", x: 0, y: 38, w: 1500, h: 860 },
    { display: "2560x1440", x: 523, y: 49, w: 1908, h: 1300 },
  ];
  assertEquals(chooseFrame(saved, [office])!.w, 1908);
  assertEquals(chooseFrame(saved, [office])!.x, 523);
  assertEquals(chooseFrame(saved, [laptop])!.w, 1500);
});

Deno.test("the first time on a display, the last window is shrunk to fit it and centred", () => {
  const saved = [{ display: "2560x1440", x: 523, y: 49, w: 1908, h: 1365 }];
  const f = chooseFrame(saved, [laptop])!;
  assertEquals(f.w <= laptop.usable.w && f.h <= laptop.usable.h, true, `${f.w}x${f.h} does not fit the laptop`);
  assertEquals(f.x >= laptop.usable.x && f.y >= laptop.usable.y, true);
  assertEquals(Math.abs(f.w / f.h - 1908 / 1365) < 0.01, true, "the shape is kept");
});

Deno.test("a saved window that no longer fits its display is fitted, not placed off the edge", () => {
  const saved = [{ display: "2560x1440", x: 2000, y: 49, w: 1908, h: 1300 }];   // hanging off the right
  const f = chooseFrame(saved, [office])!;
  assertEquals(f.x + f.w <= office.usable.x + office.usable.w, true);
});

Deno.test("the route files a frame under its display, keeps the others, and is off without a file", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/.slicer-app-window`;
  await Deno.writeTextFile(path, "523 49 1908 1365\n");                              // the launcher's old line
  const post = (body: string, file?: string) => handleWindowRequest(new Request("http://x/_window", { method: "POST", body }), file);
  assertEquals((await post("2560x1440 10 20 1500 900", path))!.status, 204);
  assertEquals((await post("1512x982 0 38 1400 850", path))!.status, 204);
  assertEquals(readWindowFrames(path).map((f) => f.display), ["1512x982", "2560x1440"], "most recent first; the unlabelled old line gone");
  assertEquals((await post("2560x1440 10 20 53 48", path))!.status, 400);
  assertEquals((await post("10 20 1500 900", path))!.status, 400, "a frame must say which display it is on");
  assertEquals((await post("2560x1440 10 20 1500 900", undefined))!.status, 404, "a server with no file (the headless one) writes nothing");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("the launcher's old unlabelled window is used as it is when it fits", () => {
  const f = chooseFrame([{ display: "", x: 523, y: 49, w: 1908, h: 1365 }], [office])!;
  // office's usable area is 2560 x 1340 from y 25 here, so this one does not fit and is fitted...
  assertEquals(f.h <= office.usable.h, true);
  const g = chooseFrame([{ display: "", x: 100, y: 60, w: 1200, h: 800 }], [office])!;
  assertEquals([g.x, g.y, g.w, g.h], [100, 60, 1200, 800], "a window that fits is not moved");
});
