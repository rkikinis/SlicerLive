// Removing a database (desktop/db-remove.ts, the route POST /_db/_remove in db-serve.ts; Ron, 2026-10-26: "remove from
// the app or remove and delete"). The Trash is replaced here, so no test fills the person's own.
//
//   deno test -A --no-check desktop/db-remove.test.ts
import { assert, assertEquals } from "jsr:@std/assert";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
// The process's own values, put back by the last test (db-create-routes.test.ts: one process runs every test file).
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const { handleDbRequest } = await import("./db-serve.ts");
const { resolveSettingsPath, writeSettings } = await import("./settings-file.ts");
const { setTrashForTests } = await import("./db-remove.ts");

const gallery = `${home}/app/src/live`;
await Deno.mkdir(gallery, { recursive: true });
await writeSettings(resolveSettingsPath(gallery), "[Database]\n");
const trashed: string[] = [];
setTrashForTests(async (p) => { trashed.push(p); await Deno.remove(p, { recursive: true }); });

const call = async (method: string, path: string, body?: unknown) => {
  const r = await handleDbRequest(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), gallery);
  return { status: r!.status, j: await r!.json().catch(() => ({})) as Record<string, unknown> };
};
const list = async () => (await call("GET", "/_db")).j.databases as { id: string; path: string; current: boolean; exists: boolean }[];
const make = async (name: string) => { const r = await call("POST", "/_db/_create", { name, patientData: false }); assertEquals(r.status, 200, JSON.stringify(r.j)); return r.j as { id: string; path: string }; };
const exists = (p: string) => Deno.stat(p).then(() => true, () => false);

Deno.test("from the list only: the entry goes, the folder stays with everything in it", async () => {
  const a = await make("Kept folder");
  const r = await call("POST", "/_db/_remove", { id: a.id });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(r.j.trashed, false);
  assert(!(await list()).some((d) => d.id === a.id));
  assert(await exists(`${a.path}/ctkDICOM.sql`), "the folder was touched");
  assertEquals(trashed.length, 0);
});

Deno.test("and to the Trash: the folder goes to the Trash, then the entry; the default moves to another database and the answer says which", async () => {
  const a = await make("Teaching set"), b = await make("Second set");
  assertEquals((await call("PUT", "/_db", { current: a.id })).status, 200);
  const real = await Deno.realPath(a.path);   // the folder itself, links resolved (critic, finding 7)
  const r = await call("POST", "/_db/_remove", { id: a.id, trash: true });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(r.j.trashed, true);
  assertEquals(trashed, [real]);
  assert(!(await exists(a.path)));
  const now = await list();
  assert(!now.some((d) => d.id === a.id));
  assertEquals((r.j.current as { id: string }).id, now.find((d) => d.current)?.id);
  assert(now.some((d) => d.id === b.id));
  trashed.length = 0;
});

Deno.test("refused to the Trash: a folder that cannot be reached, the folder that holds every database, one with another database inside; nothing removed", async () => {
  // Not reachable: listed, folder gone.
  assertEquals((await call("PUT", "/_db", { id: "gone", path: `${home}/not-there` })).status, 200);
  const g = await call("POST", "/_db/_remove", { id: "gone", trash: true });
  assertEquals(g.status, 400);
  assert(String(g.j.error).includes("only be removed from the list"), String(g.j.error));
  assert((await list()).some((d) => d.id === "gone"));
  assertEquals((await call("POST", "/_db/_remove", { id: "gone" })).status, 200);   // from the list: allowed
  // The folder that holds every database, registered by mistake.
  const all = `${home}/SlicerAlbulaDatabases`;
  await Deno.writeTextFile(`${all}/ctkDICOM.sql`, "");
  assertEquals((await call("PUT", "/_db", { id: "everything", path: all })).status, 200);
  const e = await call("POST", "/_db/_remove", { id: "everything", trash: true });
  assertEquals(e.status, 400, JSON.stringify(e.j));
  assert(await exists(all));
  await Deno.remove(`${all}/ctkDICOM.sql`);
  assertEquals((await call("POST", "/_db/_remove", { id: "everything" })).status, 200);
  // Another database inside the folder.
  const outer = await make("Outer");
  const inner = `${outer.path}/inner`;
  await Deno.mkdir(inner, { recursive: true });
  await Deno.writeTextFile(`${inner}/ctkDICOM.sql`, "");
  assertEquals((await call("PUT", "/_db", { id: "inner", path: inner })).status, 200);
  const i = await call("POST", "/_db/_remove", { id: outer.id, trash: true });
  assertEquals(i.status, 400);
  assert(String(i.j.error).includes("inside that folder"), String(i.j.error));
  assert(await exists(inner));
  assertEquals(trashed.length, 0);
});

// THE CRITIC'S ROUND (Contents/docs/qa/2026-10-26-database-remove.md).
Deno.test("finding 1: two removes at the same moment both hold, and the default is a database still listed", async () => {
  const a = await make("Race A"), b = await make("Race B"), c = await make("Race C");
  assertEquals((await call("PUT", "/_db", { current: a.id })).status, 200);
  const [ra, rb] = await Promise.all([call("POST", "/_db/_remove", { id: a.id, trash: true }), call("POST", "/_db/_remove", { id: b.id, trash: true })]);
  assertEquals([ra.status, rb.status], [200, 200], JSON.stringify([ra.j, rb.j]));
  const now = await list();
  assert(!now.some((d) => d.id === a.id || d.id === b.id), JSON.stringify(now));
  const cur = now.find((d) => d.current);
  assert(cur && cur.exists && cur.id !== a.id && cur.id !== b.id, JSON.stringify(now));
  assert(now.some((d) => d.id === c.id));
  trashed.length = 0;
});

Deno.test("finding 2: a Trash that fails leaves the database listed, as the default if it was, and says so plainly", async () => {
  const a = await make("Trash fails");
  assertEquals((await call("PUT", "/_db", { current: a.id })).status, 200);
  setTrashForTests(() => Promise.reject(new Error("2026-10-26 trash[1] # Error Domain=NSCocoaErrorDomain Code=4")));
  const r = await call("POST", "/_db/_remove", { id: a.id, trash: true });
  setTrashForTests(async (p) => { trashed.push(p); await Deno.remove(p, { recursive: true }); });
  assertEquals(r.status, 500);
  assert(String(r.j.error).includes("is still in the list") && !String(r.j.error).includes("NSCocoa"), String(r.j.error));
  const now = await list();
  assertEquals(now.find((d) => d.id === a.id)?.current, true);
  assert(await exists(a.path));
});

Deno.test("findings 6, 7, 11, 13: what the question is told; a link hands over its folder; no Trash offered where there is none; not inside another database", async () => {
  const a = await make("With extras");
  await Deno.writeTextFile(`${a.path}/grant-proposal.docx`, "x");
  const dry = await call("POST", "/_db/_remove", { id: a.id, dry: true });
  assertEquals(dry.status, 200);
  assertEquals(dry.j.otherItems, 1);
  assertEquals((dry.j.trash as { ok: boolean }).ok, true);
  assertEquals(dry.j.busy, null);
  assert(await exists(a.path), "a dry run changed something");
  // A database listed through a link: the folder itself goes, not the link.
  const real = await make("Linked");
  const link = `${home}/link-to-linked`;
  await Deno.symlink(real.path, link);
  assertEquals((await call("POST", "/_db/_remove", { id: real.id })).status, 200);
  assertEquals((await call("PUT", "/_db", { id: "linked", path: link })).status, 200);
  assertEquals((await call("POST", "/_db/_remove", { id: "linked", trash: true })).status, 200);
  assertEquals(trashed, [await Deno.realPath(home) + "/SlicerAlbulaDatabases/Linked"]);
  trashed.length = 0;
  // A folder inside another listed database's folder: from the list only.
  const outer = await make("Outer two");
  const inner = `${outer.path}/inner`;
  await Deno.mkdir(inner);
  await Deno.writeTextFile(`${inner}/ctkDICOM.sql`, "");
  assertEquals((await call("PUT", "/_db", { id: "inner-two", path: inner })).status, 200);
  const i = await call("POST", "/_db/_remove", { id: "inner-two", trash: true });
  assertEquals(i.status, 400);
  assert(String(i.j.error).includes("inside the database"), String(i.j.error));
  // No Trash on this computer: not offered, and refused if asked.
  setTrashForTests(async (p) => { trashed.push(p); }, false);
  assertEquals(((await call("POST", "/_db/_remove", { id: a.id, dry: true })).j.trash as { ok: boolean }).ok, false);
  assertEquals((await call("POST", "/_db/_remove", { id: a.id, trash: true })).status, 400);
  setTrashForTests(async (p) => { trashed.push(p); await Deno.remove(p, { recursive: true }); });
  assertEquals(trashed.length, 0);
});

Deno.test("an unknown database: 404, the list unchanged", async () => {
  const n = (await list()).length;
  assertEquals((await call("POST", "/_db/_remove", { id: "no-such-database", trash: true })).status, 404);
  assertEquals((await list()).length, n);
  for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
});
