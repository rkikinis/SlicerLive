// What the page asks instead of downloading the index (desktop/db-listing.ts, 2026-10-14): the same rows its own copy
// of SQLite gave, from the server.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dbWithSeries } from "./duckn-copy.fixture.ts";
import { createDatabase } from "./db-create.ts";
import { importFiles } from "./db-import.ts";
import { runScript } from "./sqlite.ts";
import { listSeries, seriesFileNames } from "./db-listing.ts";

Deno.test("the series list and one series' files, from the server", async () => {
  const src = await dbWithSeries(8, 8, 3);                       // DICOM files of one series
  const dir = `${await Deno.makeTempDir()}/db`;
  await createDatabase(dir, { name: "Listing test" });             // a real database, filled by the app's importer
  const imported = await importFiles(dir, src.files);
  const series = src.series, files = imported.series[0] ? src.files : [];
  try {
    assertEquals(imported.series.length, 1);
    const l = await listSeries(dir);
    assertEquals(l.patients, 1);
    assertEquals(l.studies, 1);
    assertEquals(l.series.length, 1);
    const row = l.series[0];
    assertEquals(row.uid, series.seriesInstanceUID);
    assertEquals(row.n, files.length);
    assertEquals(row.nExternal, 0);
    const names = await seriesFileNames(dir, series.seriesInstanceUID);
    assertEquals(names.length, files.length);
    assert(names.every((n) => n.startsWith("dicom/")), "every name is relative, in the database's dicom/ folder");
    assertEquals(await seriesFileNames(dir, "1.2.3.no.such.series"), []);
    assertEquals(await seriesFileNames(dir, "x' OR '1'='1"), [], "a quote in the UID cannot widen the query");
    // A binary value in a listed column (critic 2026-10-14, finding 3): the list still comes, the value as text.
    runScript(`${dir}/ctkDICOM.sql`, `UPDATE Series SET SeriesDescription = x'414243' WHERE SeriesInstanceUID = '${series.seriesInstanceUID}';`);
    assertEquals((await listSeries(dir)).series[0].description, "ABC");
  } finally { await Deno.remove(dir, { recursive: true }); await Deno.remove(src.dir, { recursive: true }); }
});
