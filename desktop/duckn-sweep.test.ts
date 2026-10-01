// The sweep over a throwaway database: copies what needs copying, leaves valid copies alone, remakes
// a stale one, records what it will not copy and why, and never reads a segmentation.
//
//   deno test -A --no-check desktop/duckn-sweep.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { addSeries, emptyDb } from "./duckn-copy.fixture.ts";
import { outcomeOf, sweep } from "./duckn-sweep.ts";

Deno.test("the sweep copies, then leaves valid copies alone, remakes a stale one, and says what it refused", async () => {
  const dir = await emptyDb();
  const a = await addSeries(dir, 16, 16, 10);
  const b = await addSeries(dir, 12, 12, 6);
  // Copied since 2026-09-25 (exact floats); the refused example is a series whose images have no position.
  const frac = await addSeries(dir, 8, 8, 3, { extra: { RescaleSlope: 3.774114 } });
  const flat = await addSeries(dir, 8, 8, 3, { extra: { ImagePositionPatient: undefined, ImageOrientationPatient: undefined } });
  // A segmentation in the index: must never be read for a copy.
  const p = new Deno.Command("/usr/bin/sqlite3", { args: [`${dir}/ctkDICOM.sql`], stdin: "piped" }).spawn();
  const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode("INSERT INTO Series VALUES ('7.7.7', '1.2.3', 'SEG');")); await w.close(); await p.status;

  const dry = await sweep(dir, { dryRun: true });
  assertEquals(dry.entries.length, 4, "the SEG is not a candidate");
  assert(!(await Deno.stat(`${dir}/SlicerAlbula-Zarr`).then(() => true, () => false)), "a dry run wrote something");

  const first = await sweep(dir);
  const by = (r: typeof first, uid: string) => r.entries.find((e) => e.seriesInstanceUID === uid)!;
  assertEquals(by(first, a.series.seriesInstanceUID).outcome, "copied");
  assertEquals(by(first, b.series.seriesInstanceUID).outcome, "copied");
  assertEquals(by(first, frac.series.seriesInstanceUID).outcome, "copied");
  assertEquals(by(first, flat.series.seriesInstanceUID).outcome, "refused");
  assert(by(first, flat.series.seriesInstanceUID).why!.includes("no image plane attributes"));
  assert(await Deno.stat(`${dir}/SlicerAlbula-Zarr/sweep-report.json`).then(() => true, () => false));

  assert(first.finished && first.leftovers.length === 0);

  // What a killed run leaves: a half-written copy and a half-replaced one. The next run removes both
  // and says so (critic, 2026-09-23, finding 4).
  await Deno.mkdir(`${dir}/SlicerAlbula-Zarr/${a.series.seriesInstanceUID}.zarr.part-0badc0de`);
  await Deno.mkdir(`${dir}/SlicerAlbula-Zarr/${a.series.seriesInstanceUID}.zarr.old-0badc0de`);
  const second = await sweep(dir);
  assertEquals(second.leftovers.sort(), [`${a.series.seriesInstanceUID}.zarr.old-0badc0de`, `${a.series.seriesInstanceUID}.zarr.part-0badc0de`]);
  assertEquals(by(second, a.series.seriesInstanceUID).outcome, "valid");
  assertEquals(by(second, b.series.seriesInstanceUID).outcome, "valid");

  // One of b's files grows by a byte: b's copy is stale and is remade; a's is left alone.
  const f = b.files[2];
  await Deno.writeFile(f, new Uint8Array([...(await Deno.readFile(f)), 0]));
  const third = await sweep(dir);
  assertEquals(by(third, a.series.seriesInstanceUID).outcome, "valid");
  assertEquals(by(third, b.series.seriesInstanceUID).outcome, "copied");
  assert(by(third, b.series.seriesInstanceUID).why!.includes("changed"), "a remade copy says why");
  assertEquals([...Deno.readDirSync(`${dir}/SlicerAlbula-Zarr`)].map((e) => e.name).filter((n) => /\.part-|\.old-/.test(n)), []);
  await Deno.remove(dir, { recursive: true });                      // no throwaway databases left behind (finding 11)
});

Deno.test("a series nothing in which is a slice is refused; a series the reader fails on is unreadable (finding 10)", () => {
  assertEquals(outcomeOf("x: none of the 1 files could be read as images -- 1 x no image plane attributes (no position, orientation or spacing)"), "refused");
  assertEquals(outcomeOf("x: none of the 1 files could be read as images -- 1 x unreadable (Using multiple character sets is not supported: ISO 2022 IR )"), "unreadable");
  assertEquals(outcomeOf("x: none of the 1 files could be read as images -- 1 x compressed pixel data (RLE lossless) could not be decoded: 32-bit RLE"), "unreadable");
  assertEquals(outcomeOf("x: none of the 3 files could be read as images -- 2 x no image plane attributes (no position, orientation or spacing); 1 x unreadable (bad)"), "unreadable");
  assertEquals(outcomeOf("x: its rescale (slope 3.774114, intercept 0.000061) does not give whole numbers"), "refused");
  assertEquals(outcomeOf("x: ENOSPC"), "failed");
});
