// The checkpoint routes: a finished result put on disk before anything can lose it.
//
// Ron lost a completed TotalSegmentator run on 2026-09-05 — "I was about to go to save, when all the
// data disappeared" — because a result lived only in the renderer until Save was pressed. These pin
// the properties that make writing one safe to do unconditionally: it never touches the database, a
// listing never offers a half-written file, and the payload comes back byte for byte.
//
//   deno test -A --no-check desktop/db-checkpoint.test.ts
import { assert, assertEquals } from "jsr:@std/assert";

const userDir = await Deno.makeTempDir({ prefix: "slicerlive-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);

const { handleDbRequest } = await import("./db-serve.ts");
const { handleSettingsRequest } = await import("./settings-file.ts");

const folder = await Deno.makeTempDir({ prefix: "slicerlive-folder-" });
const gallery = `${folder}/src/live`;
await Deno.mkdir(gallery, { recursive: true });

const dbDir = await Deno.makeTempDir({ prefix: "slicerlive-db-" });
await Deno.writeTextFile(`${dbDir}/ctkDICOM.sql`, "not a real database, but a real file");
await handleSettingsRequest(
  new Request("http://x/_settings", { method: "PUT", body: `[Database]\ntest=${dbDir}\ncurrent=test\n` }),
  gallery,
);

const meta = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ task: "ts:total", volume: "NEPHROGENIC", at: "2026-09-05T13:12:00.000Z", ms: 28000, ...over });

const put = (name: string, body: BodyInit, m = meta()) =>
  handleDbRequest(
    new Request(`http://x/_db/test/_checkpoint/${encodeURIComponent(name)}`, {
      method: "POST",
      body,
      headers: { "x-checkpoint-meta": m },
    }),
    gallery,
  );

const list = async () =>
  ((await (await handleDbRequest(new Request("http://x/_db/test/_checkpoints"), gallery))!.json()).checkpoints) as
    Record<string, unknown>[];

Deno.test("a checkpoint lands beside the database, in its own folder", async () => {
  const bytes = new Uint8Array([78, 82, 82, 68, 1, 2, 3]);
  const r = await put("run-a.seg.nrrd", bytes);
  assertEquals(r!.status, 200);
  const j = await r!.json();
  assert(String(j.dir).endsWith("/SlicerAlbula-Checkpoints"), `own folder, got ${j.dir}`);
  assertEquals(j.bytes, 7);
  // NOT in SlicerAlbula-SEG, where the audit's orphan scan looks.
  assertEquals(await Deno.stat(`${dbDir}/SlicerAlbula-SEG`).catch(() => null), null);
  // ...and the database itself is untouched.
  assertEquals(await Deno.readTextFile(`${dbDir}/ctkDICOM.sql`), "not a real database, but a real file");
});

Deno.test("the listing carries the metadata and a URL the payload can be fetched from", async () => {
  const cps = await list();
  const one = cps.find((c) => c.file === "run-a.seg.nrrd");
  assert(one, `written checkpoint is listed (${JSON.stringify(cps)})`);
  assertEquals(one!.task, "ts:total");
  assertEquals(one!.volume, "NEPHROGENIC");
  assertEquals(one!.ms, 28000);
  assertEquals(one!.bytes, 7);
  assertEquals(one!.url, "/_db/test/SlicerAlbula-Checkpoints/run-a.seg.nrrd");
});

Deno.test("the payload comes back byte for byte", async () => {
  const res = await handleDbRequest(
    new Request("http://x/_db/test/SlicerAlbula-Checkpoints/run-a.seg.nrrd"),
    gallery,
  );
  assertEquals(new Uint8Array(await res!.arrayBuffer()), new Uint8Array([78, 82, 82, 68, 1, 2, 3]));
});

Deno.test("a payload with no sidecar is not offered", async () => {
  // What a crash mid-write leaves: bytes on disk, nothing describing them. The sidecar is written
  // second precisely so this case is invisible rather than half-restorable.
  await Deno.writeFile(`${dbDir}/SlicerAlbula-Checkpoints/orphan.seg.nrrd`, new Uint8Array([1]));
  const cps = await list();
  assert(!cps.some((c) => c.file === "orphan.seg.nrrd"), "a file with no sidecar stays hidden");
});

Deno.test("a sidecar whose payload is gone is not offered either", async () => {
  await Deno.writeTextFile(
    `${dbDir}/SlicerAlbula-Checkpoints/ghost.seg.nrrd.json`,
    JSON.stringify({ task: "x", volume: "y", at: "2026-09-05T00:00:00.000Z", file: "ghost.seg.nrrd" }),
  );
  const cps = await list();
  assert(!cps.some((c) => c.file === "ghost.seg.nrrd"), "a sidecar without bytes is not a checkpoint");
});

Deno.test("newest first, because that is the one someone is looking for", async () => {
  await put("run-b.seg.nrrd", new Uint8Array([9]), meta({ at: "2026-09-05T15:00:00.000Z", task: "ts:lung" }));
  const files = (await list()).map((c) => c.file);
  assertEquals(files[0], "run-b.seg.nrrd", `newest first, got ${files.join(", ")}`);
});

Deno.test("discarding removes the payload and its sidecar together", async () => {
  const r = await handleDbRequest(
    new Request("http://x/_db/test/_checkpoint/run-b.seg.nrrd", { method: "DELETE" }),
    gallery,
  );
  assertEquals(r!.status, 200);
  assertEquals(await Deno.stat(`${dbDir}/SlicerAlbula-Checkpoints/run-b.seg.nrrd`).catch(() => null), null);
  assertEquals(await Deno.stat(`${dbDir}/SlicerAlbula-Checkpoints/run-b.seg.nrrd.json`).catch(() => null), null);
  assert(!(await list()).some((c) => c.file === "run-b.seg.nrrd"));
});

Deno.test("a name cannot walk out of the checkpoint folder", async () => {
  // Two guards in series, and the second is why nothing is written at all: separators are replaced
  // with "_", so "../../escaped" becomes ".._.._escaped", which then trips the leading-dot rule.
  const r = await put("../../escaped.seg.nrrd", new Uint8Array([1, 2]));
  assertEquals(r!.status, 400);
  assertEquals(await Deno.stat(`${dbDir}/../escaped.seg.nrrd`).catch(() => null), null);
  assert(
    ![...Deno.readDirSync(`${dbDir}/SlicerAlbula-Checkpoints`)].some((e) => e.name.includes("escaped")),
    "and it is not written under a flattened name either",
  );
});

// ---- retention: a safety net with an expiry, not storage ----------------------------------------
//
// Ron: "Having a buffer of 1N sounds like a reasonable approach, perhaps with time based deletion
// after 24 hours." A ts:total is ~150 MB, so unbounded is a slow disk leak.

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

Deno.test("only the newest few survive", async () => {
  const dir = `${dbDir}/SlicerAlbula-Checkpoints`;
  for (const e of [...Deno.readDirSync(dir)]) await Deno.remove(`${dir}/${e.name}`);
  // Eight runs, an hour apart, newest last.
  for (let i = 8; i >= 1; i--) {
    await put(`run-${i}.seg.nrrd`, new Uint8Array([i]), meta({ at: hoursAgo(i), task: `t${i}` }));
  }
  const files = (await list()).map((c) => c.file);
  assertEquals(files.length, 5, `five kept, got ${files.join(", ")}`);
  assertEquals(files[0], "run-1.seg.nrrd", "newest survives");
  assert(!files.includes("run-8.seg.nrrd"), "oldest is gone");
  // and the payloads go with the sidecars, rather than leaving the bytes behind
  assertEquals(await Deno.stat(`${dir}/run-8.seg.nrrd`).catch(() => null), null);
});

Deno.test("nothing outlives a day, even inside the buffer", async () => {
  const dir = `${dbDir}/SlicerAlbula-Checkpoints`;
  for (const e of [...Deno.readDirSync(dir)]) await Deno.remove(`${dir}/${e.name}`);
  await put("old.seg.nrrd", new Uint8Array([1]), meta({ at: hoursAgo(30) }));
  await put("recent.seg.nrrd", new Uint8Array([2]), meta({ at: hoursAgo(2) }));
  const files = (await list()).map((c) => c.file);
  // Two files, well inside the buffer of five — age is what removes the first.
  assertEquals(files, ["recent.seg.nrrd"], `only the recent one, got ${files.join(", ")}`);
});

Deno.test("the run just written is never pruned, whatever its timestamp says", async () => {
  const dir = `${dbDir}/SlicerAlbula-Checkpoints`;
  for (const e of [...Deno.readDirSync(dir)]) await Deno.remove(`${dir}/${e.name}`);
  // A wrong clock, or a run longer than the window, must not delete the result being protected.
  await put("just-now.seg.nrrd", new Uint8Array([1]), meta({ at: hoursAgo(99) }));
  assertEquals((await list()).map((c) => c.file), ["just-now.seg.nrrd"]);
});

Deno.test("an unknown database is refused, not created", async () => {
  const r = await handleDbRequest(
    new Request("http://x/_db/nope/_checkpoint/x.seg.nrrd", { method: "POST", body: new Uint8Array([1]) }),
    gallery,
  );
  assertEquals(r!.status, 404);
});

Deno.test("listing a database with no checkpoints is empty, not an error", async () => {
  const other = await Deno.makeTempDir({ prefix: "slicerlive-db2-" });
  await Deno.writeTextFile(`${other}/ctkDICOM.sql`, "x");
  await handleSettingsRequest(
    new Request("http://x/_settings", { method: "PUT", body: `[Database]\ntest=${dbDir}\nblank=${other}\ncurrent=test\n` }),
    gallery,
  );
  const res = await handleDbRequest(new Request("http://x/_db/blank/_checkpoints"), gallery);
  assertEquals(res!.status, 200);
  assertEquals((await res!.json()).checkpoints, []);
});
