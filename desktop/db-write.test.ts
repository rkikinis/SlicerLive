// The write route that puts an exported DICOM SEG on disk.
//
// This exists because the alternative failed SILENTLY. WKWebView has no File System Access API and
// no working `<a download>` for a blob, so in the native app a 950 MB segmentation was reported
// "saved" and written nowhere; Ron ran load → segment → save → import and found the database
// unchanged. A route that writes has to be pinned: it takes a path from a web page, which is exactly
// the kind of thing that is fine until it is not.
//
//   deno test -A --no-check desktop/db-write.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";

const userDir = await Deno.makeTempDir({ prefix: "slicerlive-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);

const { handleDbRequest } = await import("./db-serve.ts");
const { handleSettingsRequest } = await import("./settings-file.ts");

const folder = await Deno.makeTempDir({ prefix: "slicerlive-folder-" });
const gallery = `${folder}/src/live`;
await Deno.mkdir(gallery, { recursive: true });

// A stand-in database directory, registered the way the app registers one.
const dbDir = await Deno.makeTempDir({ prefix: "slicerlive-db-" });
await Deno.writeTextFile(`${dbDir}/ctkDICOM.sql`, "not a real database, but a real file");
await handleSettingsRequest(
  new Request("http://x/_settings", { method: "PUT", body: `[Database]\ntest=${dbDir}\ncurrent=test\n` }),
  gallery,
);

const post = (path: string, body: BodyInit) =>
  handleDbRequest(new Request(`http://x${path}`, { method: "POST", body }), gallery);

Deno.test("writes into a SlicerAlbula-SEG subfolder of the registered database", async () => {
  const bytes = new Uint8Array([68, 73, 67, 77, 1, 2, 3]);
  const r = await post("/_db/test/_write/seg-one.dcm", bytes);
  assertEquals(r?.status, 200);
  const j = await r?.json();
  assertEquals(j.dir, `${dbDir}/SlicerAlbula-SEG`);
  assertEquals(j.bytes, bytes.length);
  assertEquals(await Deno.readFile(j.path), bytes);
});

Deno.test("a name cannot climb out of the database directory", async () => {
  // Two guards stack, and the order matters. The separators are stripped first, so "../../x.dcm"
  // becomes ".._.._x.dcm" — already harmless, already inside the folder — and the leading-dot rule
  // then refuses it outright. Either alone would confine the write; together the attempt does not
  // even produce a file. What is pinned here is the OUTCOME: nothing lands above the directory.
  const r = await post("/_db/test/_write/" + encodeURIComponent("../../escaped.dcm"), new Uint8Array([1]));
  assertEquals(r?.status, 400, "a climbing name is refused outright");
  for (const outside of [`${dbDir}/../escaped.dcm`, `${dbDir}/../.._escaped.dcm`]) {
    let there = true;
    try { await Deno.stat(outside); } catch { there = false; }
    assertEquals(there, false, `nothing was written to ${outside}`);
  }
});

Deno.test("a separator inside an otherwise ordinary name is neutralised, not obeyed", async () => {
  const r = await post("/_db/test/_write/" + encodeURIComponent("sub/dir/seg.dcm"), new Uint8Array([9]));
  assertEquals(r?.status, 200);
  const j = await r?.json();
  assert(j.path.startsWith(`${dbDir}/SlicerAlbula-SEG/`), `escaped to ${j.path}`);
  assertEquals(j.path.endsWith("sub_dir_seg.dcm"), true, j.path);
  let nested = true;
  try { await Deno.stat(`${dbDir}/SlicerAlbula-SEG/sub/dir/seg.dcm`); } catch { nested = false; }
  assertEquals(nested, false, "no directory was created from the name");
});

Deno.test("an unregistered database id is refused", async () => {
  const r = await post("/_db/not-registered/_write/x.dcm", new Uint8Array([1]));
  assertEquals(r?.status, 404);
});

Deno.test("a dotfile name is refused", async () => {
  const r = await post("/_db/test/_write/" + encodeURIComponent(".hidden"), new Uint8Array([1]));
  assertEquals(r?.status, 400);
});

// A DERIVED IMAGE SERIES goes in its own folder, and the route hands back the relative path the
// index needs. A few hundred cropped MR instances in a folder called SlicerAlbula-SEG would be
// mislabelled the moment anyone looked, and the folder still cannot be named by the page.
Deno.test("an image series is written into the volumes folder, not the SEG one", async () => {
  const r = await post("/_db/test/_write/vol-one.dcm?kind=image", new Uint8Array([68, 73, 67, 77, 9]));
  assertEquals(r?.status, 200);
  const j = await r?.json();
  assertEquals(j.dir, `${dbDir}/SlicerAlbula-Volumes`);
  assertEquals(j.rel, "SlicerAlbula-Volumes/vol-one.dcm");
  assert(await Deno.stat(j.path));
  // and the default is unchanged, so nothing that already writes a SEG has to say so
  const s = await post("/_db/test/_write/seg-two.dcm", new Uint8Array([68, 73, 67, 77]));
  const sj = await s?.json();
  assertEquals(sj.dir, `${dbDir}/SlicerAlbula-SEG`);
  assertEquals(sj.rel, "SlicerAlbula-SEG/seg-two.dcm");
});

// A SAVE THAT CANNOT FINISH MUST NOT LEAVE FILES BEHIND, and a page must be able to ask whether the
// route it needs exists at all. Both come from one afternoon: "Put it in the DICOM database" wrote
// 258 instances to a server five days older than the page, was refused at the index step, and left
// every one of them on disk where nothing could see them. Ron: "so save to dicom failed silently!
// That is bad."
Deno.test("the write route takes a file back, and says a missing one is gone", async () => {
  const w = await post("/_db/test/_write/undo-me.dcm?kind=image", new Uint8Array([68, 73, 67, 77]));
  const j = await w?.json();
  assert(await Deno.stat(j.path));
  const del = await handleDbRequest(new Request(`http://x/_db/test/_write/undo-me.dcm?kind=image`, { method: "DELETE" }), gallery);
  assertEquals(del?.status, 200);
  assertEquals((await del?.json()).removed, "SlicerAlbula-Volumes/undo-me.dcm");
  await assertRejects(() => Deno.stat(j.path), Deno.errors.NotFound);
  // Again: the caller's goal is that it not be there, and it is not there.
  const again = await handleDbRequest(new Request(`http://x/_db/test/_write/undo-me.dcm?kind=image`, { method: "DELETE" }), gallery);
  assertEquals(again?.status, 200);
});

Deno.test("/_db says what this server can do", async () => {
  const r = await handleDbRequest(new Request("http://x/_db"), gallery);
  const j = await r?.json();
  for (const f of ["write", "write-kind", "write-delete", "index", "index-batch", "provenance", "audit"]) {
    assert((j.features ?? []).includes(f), `no "${f}" in ${JSON.stringify(j.features)}`);
  }
});

// THE WHOLE ROUND TRIP THROUGH THE ROUTES: register, write, index, delete. Ron: "One thing that I
// still don't know: how to delete a data set in the dicom data base." The audited delete had been
// written for two days with no route and no caller, so the honest answer was "you cannot" -- which
// is the same class of gap as the batch index route the crop save was refused by. A test that
// exercises the ROUTES and not the functions is the one that would have caught either.
Deno.test("a series can be written, indexed and then deleted through the routes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "slicerlive-real-db-" });
  const sql = (text: string) => {
    const p = new Deno.Command("/usr/bin/sqlite3", { args: [`${dir}/ctkDICOM.sql`], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    return (async () => {
      const w = p.stdin.getWriter();
      await w.write(new TextEncoder().encode(text));
      await w.close();
      const { code, stdout, stderr } = await p.output();
      if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
      return new TextDecoder().decode(stdout).trim();
    })();
  };
  await sql(`
    CREATE TABLE Patients (UID INTEGER PRIMARY KEY, PatientsName TEXT, PatientID TEXT);
    CREATE TABLE Studies (StudyInstanceUID TEXT PRIMARY KEY, PatientsUID INTEGER, StudyDate TEXT, StudyDescription TEXT);
    CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY, StudyInstanceUID TEXT, SeriesNumber TEXT, SeriesDate TEXT,
      SeriesTime TEXT, SeriesDescription TEXT, Modality TEXT, AcquisitionNumber TEXT, EchoNumber TEXT, TemporalPosition TEXT,
      FrameOfReferenceUID TEXT, InsertTimestamp TEXT, DisplayedCount TEXT, DisplayedSize TEXT, DisplayedNumberOfFrames TEXT);
    CREATE TABLE Images (SOPInstanceUID TEXT PRIMARY KEY, Filename TEXT, URL TEXT, SeriesInstanceUID TEXT, InsertTimestamp TEXT);
    INSERT INTO Patients VALUES (1, 'TEST^TWO', 'T2');
    INSERT INTO Studies VALUES ('1.2.3', 1, '20260907', 'a study');
  `);
  await handleSettingsRequest(
    new Request("http://x/_settings", { method: "PUT", body: `[Database]\nreal=${dir}\ncurrent=real\n` }),
    gallery,
  );

  // write two instances, as a derived series does
  const files = [];
  for (const n of ["1.2.3.4.1", "1.2.3.4.2"]) {
    const r = await post(`/_db/real/_write/${n}.dcm?kind=image`, new Uint8Array([68, 73, 67, 77, 1]));
    const j = await r?.json();
    files.push({
      file: j.rel,
      meta: { sopInstanceUID: n, seriesInstanceUID: "1.2.3.4", studyInstanceUID: "1.2.3", modality: "MR", displayedSize: "4x4", numberOfFrames: 1 },
    });
  }
  const ix = await post("/_db/real/_index", JSON.stringify({ files }));
  const ixj = await ix?.json();
  assertEquals(ixj.indexed, true, JSON.stringify(ixj));
  assertEquals(ixj.instances, 2);
  assertEquals(await sql("SELECT COUNT(*) FROM Images;"), "2");

  // and now take it out again, which is what had no route at all
  const del = await handleDbRequest(new Request("http://x/_db/real/_series/1.2.3.4", { method: "DELETE" }), gallery);
  assertEquals(del?.status, 200);
  const dj = await del?.json();
  assertEquals(dj.series, 1);
  assertEquals(dj.images, 2);
  assertEquals(dj.files.length, 2, "the files on disk go too");
  assertEquals(dj.audit.ok, true, JSON.stringify(dj.audit));
  assertEquals(await sql("SELECT COUNT(*) FROM Images;"), "0");
  assertEquals(await sql("SELECT COUNT(*) FROM Series;"), "0");
  await assertRejects(() => Deno.stat(`${dir}/SlicerAlbula-Volumes/1.2.3.4.1.dcm`), Deno.errors.NotFound);
  // the study and the patient stay: emptying them is not what was asked for
  assertEquals(await sql("SELECT COUNT(*) FROM Studies;"), "1");

  // A non-UID never reaches the delete: the route's own pattern only accepts digits and dots, so it
  // falls through to the read path and is answered as a missing file rather than as a deletion.
  const bad = await handleDbRequest(new Request("http://x/_db/real/_series/not-a-uid; DROP TABLE Images", { method: "DELETE" }), gallery);
  assert(!bad || bad.status !== 200, `a non-UID was accepted: ${bad?.status}`);
  assertEquals(await sql("SELECT COUNT(*) FROM sqlite_master WHERE name='Images';"), "1", "the tables are still there");
});

// WRITE AND INDEX IN ONE REQUEST. On 2026-09-18 the page died between the write and the index of a
// 291 MB surfaces object, leaving the file on disk as an orphan. With the record in the header the
// server finishes both; a record the index refuses takes the file back out.
Deno.test("a write with an x-albula-index header is indexed in the same request, or taken back", async () => {
  const sqlite = async (db: string, sql: string) => {
    const p = new Deno.Command("sqlite3", { args: [db], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(sql)); await w.close();
    const { code, stderr } = await p.output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  };
  const root = await Deno.makeTempDir({ prefix: "albula-wi-" });
  const dir = `${root}/SlicerDICOMDatabase`; await Deno.mkdir(dir);
  await sqlite(`${dir}/ctkDICOM.sql`, `
    CREATE TABLE Patients (UID INTEGER PRIMARY KEY, PatientsName TEXT, PatientID TEXT);
    CREATE TABLE Studies (StudyInstanceUID TEXT PRIMARY KEY, PatientsUID INTEGER, StudyDate TEXT, StudyDescription TEXT);
    CREATE TABLE Series (SeriesInstanceUID TEXT PRIMARY KEY, StudyInstanceUID TEXT, SeriesNumber TEXT,
      SeriesDate TEXT, SeriesTime TEXT, SeriesDescription TEXT, Modality TEXT, AcquisitionNumber TEXT,
      EchoNumber TEXT, TemporalPosition TEXT, FrameOfReferenceUID TEXT, InsertTimestamp TEXT,
      DisplayedCount TEXT, DisplayedSize TEXT, DisplayedNumberOfFrames TEXT);
    CREATE TABLE Images (SOPInstanceUID TEXT PRIMARY KEY, Filename TEXT, URL TEXT, SeriesInstanceUID TEXT, InsertTimestamp TEXT);
    INSERT INTO Patients VALUES (1, 'TEST^ONE', 'T1');
    INSERT INTO Studies VALUES ('1.2.3', 1, '20260918', 'a study');`);
  await handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body: `[Database]\ntest=${dbDir}\nwi=${dir}\ncurrent=wi\n` }), gallery);
  const meta = { sopInstanceUID: "1.2.3.4.5", seriesInstanceUID: "1.2.3.4", studyInstanceUID: "1.2.3", modality: "SEG", seriesDescription: "one" };
  const ok = await handleDbRequest(new Request("http://x/_db/wi/_write/one.dcm", { method: "POST", body: new Uint8Array([68, 73, 67, 77, 1]), headers: { "x-albula-index": encodeURIComponent(JSON.stringify({ ...meta, seriesDescription: "surfaces of Σ — merged" })) } }), gallery);
  const j = await ok!.json();
  assertEquals(ok!.status, 200, JSON.stringify(j));
  assertEquals(j.indexed, true); assertEquals(j.audit.ok, true, "written and indexed, nothing left over");
  assertEquals(j.rel, "SlicerAlbula-SEG/one.dcm");
  // A record the index refuses (its study is not in the database): the file is taken back.
  const bad = await handleDbRequest(new Request("http://x/_db/wi/_write/two.dcm", { method: "POST", body: new Uint8Array([68, 73, 67, 77, 2]), headers: { "x-albula-index": encodeURIComponent(JSON.stringify({ ...meta, sopInstanceUID: "1.2.3.4.6", studyInstanceUID: "9.9.9" })) } }), gallery);
  assertEquals(bad!.status, 409);
  assertEquals((await bad!.json()).indexed, false);
  assertEquals(await Deno.stat(`${dir}/SlicerAlbula-SEG/two.dcm`).catch(() => null), null, "the refused file is gone");
  await handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body: `[Database]\ntest=${dbDir}\ncurrent=test\n` }), gallery);
});
