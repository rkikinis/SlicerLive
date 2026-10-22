// WHICH DATABASE A MODULE'S CALL GOES TO (render/database-routing.ts; critic 2026-10-20, finding 10).
//   deno test -A --no-check render/database-routing.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { databaseForPath, dbIdOf, mergeListings, scanDatabases, seriesNamedIn, windowDatabase } from "./database-routing.ts";
import type { MrsonNode } from "./mrson.ts";

const TRACTS = "2.25.111222333444555666777888999";
const node = (id: string, fromDatabase?: string) => ({ type: "image", id, origin: { modality: "MR", ...(fromDatabase ? { fromDatabase } : {}) } }) as unknown as MrsonNode;

Deno.test("a scan's own database, from its origin; a folder opened by hand is none", () => {
  assertEquals(dbIdOf("/_db/Brain%20tumor%20test%20cases/"), "Brain tumor test cases");
  assertEquals(dbIdOf("http://127.0.0.1:4180/_db/SlicerAlbulaMain/"), "SlicerAlbulaMain");
  assertEquals(dbIdOf("My DICOM folder"), null);
  assertEquals(scanDatabases([node("dwi", "/_db/tumors/"), node("b0", "/_db/tumors/"), node("ct", "/_db/main/"), node("x")]), ["tumors", "main"]);
});

Deno.test("Ron's sequence: PAT24 from the test cases on screen, then Change… to the main database", () => {
  const open = "main", scans = ["tumors"];
  // The tracts and maps of PAT24 are in the test cases' index, not the main one.
  const index: Record<string, Set<string>> = { main: new Set(["1.2.3.4.5"]), tumors: new Set([TRACTS, "1.2.3.4.6"]) };
  const lists = (db: string) => index[db] ? (u: string) => index[db].has(u) : undefined;
  assertEquals(databaseForPath(`SlicerAlbula-Cache/fa-${TRACTS}.nrrd`, open, scans, lists), "tumors");
  assertEquals(databaseForPath(`SlicerAlbula-Cache/colorfa-${TRACTS}.nrrd`, open, scans, lists), "tumors");
  // A module's own file with no series in its name stays with the open database; so does a series nobody lists.
  assertEquals(databaseForPath("SlicerAlbula-SEG/tract-review.json", open, scans, lists), "main");
  assertEquals(databaseForPath("SlicerAlbula-Cache/fa-9.9.9.9.nrrd", open, scans, lists), "main");
  // Nothing loaded from elsewhere: the open database, as before.
  assertEquals(databaseForPath(`SlicerAlbula-Cache/fa-${TRACTS}.nrrd`, "tumors", [], lists), "tumors");
  assertEquals(seriesNamedIn(`b0-${TRACTS}.nrrd`), [TRACTS]);
});

Deno.test("the listing a module gets: the open database's and the scans' own, each series and edge once", () => {
  const main = { series: [{ seriesInstanceUID: "heart" }], edges: [{ child: "seg", parent: "heart", kind: "algorithm" }] };
  const tumors = { series: [{ seriesInstanceUID: "dwi" }, { seriesInstanceUID: TRACTS }], edges: [{ child: TRACTS, parent: "dwi", kind: "tracts" }, { child: "seg", parent: "heart", kind: "algorithm" }] };
  const m = mergeListings([main, tumors]);
  assertEquals(m.series.map((s) => s.seriesInstanceUID), ["heart", "dwi", TRACTS]);
  assertEquals(m.edges.length, 2);
  // The Diffusion module's own search for the stored tracts (module.ts findStored), on the merged list: found.
  const num = new Set(m.series.map((s) => s.seriesInstanceUID));
  assertEquals(m.edges.filter((e) => e.kind === "tracts" && e.parent === "dwi" && num.has(e.child)).map((e) => e.child), [TRACTS]);
});

Deno.test("the window follows the person's switch, keeps a database opened in it only, and a folder opened by hand", () => {
  const main = "http://h/_db/main/", tumors = "http://h/_db/tumors/", sample = "http://h/_db/Sample%20data/";
  // cab94c6: the test cases open, Change… to the main database: followed.
  assertEquals(windowDatabase({ open: tumors, current: main, seen: tumors, own: null }), { use: main, own: null });
  assertEquals(windowDatabase({ open: undefined, current: main, seen: null, own: null }).use, main);
  // Brain with DTI: Sample data opened in this window only; the machine-wide one is still the main one: kept.
  assertEquals(windowDatabase({ open: sample, current: main, seen: null, own: sample }), { use: sample, own: sample });
  assertEquals(windowDatabase({ open: sample, current: main, seen: main, own: sample }), { use: sample, own: sample });
  // ...until the person switches the machine-wide one.
  assertEquals(windowDatabase({ open: sample, current: tumors, seen: main, own: sample }), { use: tumors, own: null });
  // A folder opened by hand (a browser build) stays.
  assertEquals(windowDatabase({ open: "My DICOM folder", current: main, seen: tumors, own: null }).use, "My DICOM folder");
  // No served database at all: what is open stays.
  assertEquals(windowDatabase({ open: tumors, current: null, seen: null, own: null }).use, tumors);
});
