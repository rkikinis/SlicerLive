// The path rules every system shares (desktop/paths.ts).
//
//   deno test -A --no-check desktop/paths.test.ts
import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path@1";
import { fromStored, placeOf } from "./paths.ts";

Deno.test("same, inside, outside -- including a sibling whose name starts like the folder, and a folder named ..notes", async () => {
  const root = await Deno.makeTempDir();
  const db = join(root, "Test Data");
  for (const d of [db, join(db, "dicom"), join(db, "..notes"), join(root, "Test Data 2")]) await Deno.mkdir(d, { recursive: true });
  assertEquals(await placeOf(db, db), "same");
  assertEquals(await placeOf(join(db, "dicom"), db), "inside");
  assertEquals(await placeOf(join(db, "..notes"), db), "inside");
  assertEquals(await placeOf(join(root, "Test Data 2"), db), "outside", "a name that only begins the same is not inside");
  assertEquals(await placeOf(root, db), "outside");
  assertEquals(await placeOf(join(db, "not-made-yet", "x"), db), "inside", "a folder that does not exist yet is judged by its name");
  // A link to the folder is the folder.
  await Deno.symlink(db, join(root, "link"));
  assertEquals(await placeOf(join(root, "link"), db), "same");
  if (Deno.build.os === "darwin" || Deno.build.os === "windows") assertEquals(await placeOf(db.toUpperCase(), db), "same", "letter case does not matter on these disks");
  await Deno.remove(root, { recursive: true });
});

Deno.test("a stored path is relative and written with /, read as this system's path", () => {
  assertEquals(fromStored(join("base", "db"), "SlicerAlbula-Scenes/2.25.1.mrson.json"), join("base", "db", "SlicerAlbula-Scenes", "2.25.1.mrson.json"));
});
