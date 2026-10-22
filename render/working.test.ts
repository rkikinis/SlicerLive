// The "working" banner's rules (render/working.ts; Ron, 2026-10-17): nothing for quick work, never a flash, a count or a
// moving bar, Stop only when the work can stop, a time only when measured on this Mac, several at once stacked and folded,
// the same line once, a button's generic work only while nothing more specific shows.
//
//   deno test -A --no-check render/working.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { MAX_SHOWN, MIN_SHOWN_MS, SHOW_AFTER_MS, setWorkBannerHost, sizeClass, startWork, usualMs, usualText, type WorkBannerOpts } from "./working.ts";

const shown: { o: WorkBannerOpts; open: boolean; seq: number }[] = [];
let seq = 0;
setWorkBannerHost((o) => { const b = { o, open: true, seq: seq++ }; shown.push(b); return { update: (u) => { b.o = { ...b.o, ...u } as WorkBannerOpts; }, close: () => { b.open = false; } }; });
const open = () => shown.filter((b) => b.open).sort((a, b) => a.seq - b.seq).map((b) => b.o);   // in the order they were put up
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => wait(MIN_SHOWN_MS + 50);

Deno.test("quick work shows nothing; longer work a banner with its count; done takes it away, not before it could be read", async () => {
  shown.length = 0;
  const quick = startWork({ title: "Quick" });
  await wait(SHOW_AFTER_MS / 3); quick.done();
  await wait(SHOW_AFTER_MS);
  assertEquals(open().length, 0, "a quick piece of work never flashes");
  const w = startWork({ title: "Loading the scene", unit: "series", total: 11 });
  await wait(SHOW_AFTER_MS + 50);
  w.step(4);
  assertEquals(open().length, 1);
  assertEquals(open()[0].title, "Loading the scene");
  assertEquals(open()[0].hint, "4 of 11 series");
  assertEquals(open()[0].progress, 4 / 11);
  assertEquals(open()[0].actions, [], "no Stop when the work cannot stop");
  w.done();
  assertEquals(open().length, 1, "up at least MIN_SHOWN_MS");
  await settle();
  assertEquals(open().length, 0);
});

Deno.test("unknown length: a moving bar; Stop when the work can stop, gone when it no longer can", async () => {
  shown.length = 0;
  let stopped = false;
  const w = startWork({ title: "Finding the organs", stop: () => { stopped = true; } });
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open()[0].progress, null);
  open()[0].actions![0].onClick();
  assert(stopped);
  w.unstoppable();
  assertEquals(open()[0].actions, []);
  w.say("Finding the organs: the result", "parts"); w.step(1, 3);
  assertEquals(open()[0].hint, "1 of 3 parts");
  w.uncounted();
  assertEquals(open()[0].progress, null);
  w.done(false); await settle();
});

Deno.test("a time only after the same work has been measured here, the lower median; the caller's own measurement wins", async () => {
  shown.length = 0;
  const key = `test-${Math.random()}`;
  assertEquals(usualMs(key), undefined);
  const first = startWork({ title: "Saving", timeKey: key });
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open()[0].hint, undefined, "never measured: no time");
  first.done(); await settle();
  assert(usualMs(key)! >= SHOW_AFTER_MS);
  const second = startWork({ title: "Saving", timeKey: key });
  await wait(SHOW_AFTER_MS + 50);
  assert(/^usually \d+ s$/.test(open()[0].hint ?? ""), `measured: "${open()[0].hint}"`);
  second.done(false); await settle();                                // a failed run is not a measurement
  const third = startWork({ title: "AI", usualMs: 42_000 });
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open()[0].hint, "usually 42 s");
  third.done(); await settle();
  assertEquals(usualText(42_000), "usually 42 s");
  assertEquals(usualText(90_000), "usually 1 min 30 s");
  assertEquals(usualText(240_000), "usually 4 min");
  assert(sizeClass(512 * 512 * 533) !== sizeClass(768 * 768 * 709), "a scan of another size is another size class");
});

Deno.test(`more than ${MAX_SHOWN} at once: the first ${MAX_SHOWN} and "and N more", always last`, async () => {
  shown.length = 0;
  const ws = [0, 1, 2, 3].map((i) => startWork({ title: `Work ${i}` }));
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open().map((o) => o.title), ["Work 0", "Work 1", "and 2 more"]);
  ws[0].done(); await settle();
  assertEquals(open().map((o) => o.title), ["Work 1", "Work 2", "and 1 more"], "the next comes in before 'and N more'");
  for (const w of ws) w.done();
  await settle();
  assertEquals(open().length, 0);
});

Deno.test("the same line twice is shown once; a button's generic work only while nothing more specific shows", async () => {
  shown.length = 0;
  const a = startWork({ title: "Preparing the 3D picture" }), b = startWork({ title: "Preparing the 3D picture" });
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open().map((o) => o.title), ["Preparing the 3D picture"]);
  a.done();
  assertEquals(open().filter((o) => o.title === "Preparing the 3D picture").length, 1, "the second still runs");
  b.done(); await settle();
  assertEquals(open().length, 0);
  const g = startWork({ title: "Merging", generic: true, showAfterMs: 50 });
  await wait(100);
  assertEquals(open().map((o) => o.title), ["Merging"]);
  const s = startWork({ title: "Loading the scene" });
  await wait(SHOW_AFTER_MS + 50);
  assertEquals(open().map((o) => o.title), ["Loading the scene"], "the specific work says more");
  s.done(); await settle();
  assertEquals(open().map((o) => o.title), ["Merging"]);
  g.done(); await settle();
});
