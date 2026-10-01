// The database routes the page calls (desktop/db-serve.ts): create, register, describe, view a chosen folder.
// Each test pins one of the critic's findings of 2026-10-01 (Contents/docs/qa/2026-10-01-database-import.md).
//
//   deno test -A --no-check desktop/db-create-routes.test.ts
import { assert, assertEquals } from "jsr:@std/assert";

const home = await Deno.makeTempDir({ prefix: "albula-home-" });
const userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);
Deno.env.set("HOME", home);
globalThis.addEventListener("unload", () => { for (const d of [home, userDir]) try { Deno.removeSync(d, { recursive: true }); } catch { /* gone */ } });

const { handleDbRequest } = await import("./db-serve.ts");
const { handleSettingsRequest } = await import("./settings-file.ts");
const { remember } = await import("./choose-folder.ts");
const { createDatabase, icloudWarning } = await import("./db-create.ts");

const gallery = `${home}/app/src/live`;
await Deno.mkdir(gallery, { recursive: true });
await handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body: "[Database]\n" }), gallery);

const call = async (method: string, path: string, body?: unknown) => {
  const r = await handleDbRequest(new Request(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }), gallery);
  return { status: r!.status, j: await r!.json().catch(() => ({})) as Record<string, unknown> };
};

Deno.test("a new database goes to Albula Databases in the home folder, registered and described", async () => {
  const r = await call("POST", "/_db/_create", { name: "Teaching cases", holds: "public", patientData: false });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(r.j.path, `${home}/Albula Databases/Teaching cases`);
  const list = (await call("GET", "/_db")).j.databases as { id: string; description?: { name: string } }[];
  assert(list.some((d) => d.id === "teaching-cases" && d.description?.name === "Teaching cases"));
});

Deno.test("finding 6: patient data that is not a clear yes or no is refused, not stored as no", async () => {
  for (const v of ["yes", 1, "on", "TRUE"]) {
    const r = await call("POST", "/_db/_create", { name: `PD ${String(v)}`, patientData: v });
    assertEquals(r.status, 400, String(v));
  }
});

Deno.test("finding 3: registering keeps an existing description file, even one the checker rejects", async () => {
  const dir = `${home}/elsewhere/Research`;
  await createDatabase(dir, { name: "Research" });
  const original = JSON.stringify({ name: "Research", approval: "IRB 2026-123", contact: "the office", holds: "x".repeat(1200) });
  await Deno.writeTextFile(`${dir}/albula-database.json`, original);
  const r = await call("POST", "/_db/_register", { token: remember(dir).token });
  assertEquals(r.status, 200, JSON.stringify(r.j));
  assertEquals(await Deno.readTextFile(`${dir}/albula-database.json`), original);
  assert(String(r.j.warning).includes("left as it is"));
  const again = await call("POST", "/_db/_register", { token: remember(dir).token });
  assertEquals(again.status, 409);
  assertEquals(await Deno.readTextFile(`${dir}/albula-database.json`), original);
});

Deno.test("finding 10: no new database inside a folder that holds one, or inside a registered one", async () => {
  const outer = `${home}/Albula Databases/Teaching cases`;   // made and registered above
  const r = await call("POST", "/_db/_create", { name: "Inner", token: remember(outer).token });
  assertEquals(r.status, 400);
  await Deno.mkdir(`${outer}/sub`, { recursive: true });
  const r2 = await call("POST", "/_db/_create", { name: "Inner", token: remember(`${outer}/sub`).token });
  assertEquals(r2.status, 400);
});

Deno.test("finding 13: the folder viewer does not follow a link out of the chosen folder", async () => {
  const chosen = `${home}/stick`, outside = `${home}/private`;
  await Deno.mkdir(chosen, { recursive: true }); await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(`${outside}/secret.txt`, "no");
  await Deno.writeTextFile(`${chosen}/a.txt`, "yes");
  await Deno.symlink(outside, `${chosen}/link`);
  const t = remember(chosen).token;
  assertEquals((await call("GET", `/_db/_folder/${t}/a.txt`)).status, 200);
  assertEquals((await call("GET", `/_db/_folder/${t}/link/secret.txt`)).status, 403);
  assertEquals((await call("GET", `/_db/_folder/${t}/%E0%A4%A`)).status, 400, "a malformed escape is a 400, not a crash");
  const list = (await call("GET", `/_db/_folder/${t}/_list`)).j as { files: string[]; left: { reason: string }[] };
  assertEquals(list.files, ["a.txt"]);
  assert(list.left.some((l) => /link/.test(l.reason)));
});

Deno.test("finding 14: a description is written only where a database is", async () => {
  await call("PUT", "/_db", { id: "nowhere", path: `${home}/empty` });
  await Deno.mkdir(`${home}/empty`, { recursive: true });
  const r = await call("PUT", "/_db/nowhere/_description", { name: "x" });
  assertEquals(r.status, 404);
  assert(!(await Deno.stat(`${home}/empty/albula-database.json`).then(() => true, () => false)));
});

Deno.test("finding 7: folders that cloud services copy off the Mac are warned about", () => {
  for (const p of [`${home}/Desktop/db`, `${home}/Documents/db`, `${home}/Library/Mobile Documents/com~apple~CloudDocs/db`,
    `${home}/Library/CloudStorage/Dropbox/db`, `${home}/Library/CloudStorage/OneDrive-Personal/db`, `/System/Volumes/Data${home}/Desktop/db`]) {
    assert(icloudWarning(p), p);
  }
  assertEquals(icloudWarning(`${home}/Albula Databases/db`), undefined);
});
