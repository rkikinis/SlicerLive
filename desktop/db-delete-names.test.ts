// A series whose files have spaces in their names is deleted WHOLE (critic, 2026-09-23, O1): sqlite3
// 3.54 quotes such a value in `.mode tabs`, the delete looked for the quoted path, and the file stayed on
// disk while its row was gone and the series was reported deleted.
//
//   deno test -A --no-check desktop/db-delete-names.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { dbWithSeries } from "./duckn-copy.fixture.ts";
import { deleteSeriesFromDatabase } from "./db-index.ts";

Deno.test("deleting a series removes every one of its files, including one with spaces in its name", async () => {
  const { dir, series, files } = await dbWithSeries(8, 8, 3);
  try {
    assert(files.some((f) => f.includes(" ")), "the fixture no longer has a file with a space");
    const r = await deleteSeriesFromDatabase(dir, series.seriesInstanceUID);
    const left = files.filter((f) => { try { Deno.statSync(f); return true; } catch { return false; } });
    assertEquals(left, [], `left on disk: ${left.join(", ")}`);
    assertEquals(r.files.length, files.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a file a row names OUTSIDE the database folder is left in place and said (code review 2026-09-24, A9)", async () => {
  const { dir, series, files } = await dbWithSeries(8, 8, 3);
  const outside = await Deno.makeTempDir({ prefix: "albula-outside-" });
  try {
    // Point one row at a file outside the folder, as Slicer's "add link" import does.
    const theirs = `${outside}/their-own.dcm`;
    await Deno.copyFile(files[0], theirs);
    const rel = files[0].slice(dir.length + 1);
    const sql = new Deno.Command("sqlite3", { args: [`${dir}/ctkDICOM.sql`, `UPDATE Images SET Filename='${theirs}' WHERE Filename='${rel.replace(/'/g, "''")}';`] }).outputSync();
    assertEquals(sql.code, 0);
    const r = await deleteSeriesFromDatabase(dir, series.seriesInstanceUID);
    assert(Deno.statSync(theirs).isFile, "the file outside the database folder was deleted");
    assertEquals(r.leftInPlace, [theirs]);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("a link in one series to another series' file: the delete removes the link, not the other file (critic, review-bugfixes 2)", async () => {
  const { dir, series, files } = await dbWithSeries(8, 8, 3);
  try {
    // Make the series' first file a link to its second file's copy elsewhere in the folder.
    const other = `${dir}/other-series-file.dcm`;
    await Deno.copyFile(files[1], other);
    await Deno.remove(files[0]);
    await Deno.symlink(other, files[0]);
    await deleteSeriesFromDatabase(dir, series.seriesInstanceUID);
    assert(Deno.statSync(other).isFile, "the file the link pointed at was deleted");
    assertEquals(await Deno.lstat(files[0]).then(() => true).catch(() => false), false, "the link itself stayed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("paths inside the database are told by their text, on either separator", async () => {
  const { insideDatabase } = await import("./db-index.ts");
  assertEquals(insideDatabase("dicom/a/b.dcm"), true);
  assertEquals(insideDatabase("SlicerAlbula-SEG\\x.dcm"), true);
  assertEquals(insideDatabase("../outside.dcm"), false);
  assertEquals(insideDatabase("dicom/../../x"), false);
  assertEquals(insideDatabase("/Users/x/y.dcm"), false);
  assertEquals(insideDatabase("C:\\data\\y.dcm"), false);
});
