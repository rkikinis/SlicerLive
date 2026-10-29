// Sharing in the app (sharing.ts): the page's routes, without a person at the Mac -- nothing here switches sharing on
// (that asks for Touch ID). Its own settings and folders, so a test never touches the person's.
import { assert, assertEquals } from "jsr:@std/assert@1";

const home = await Deno.makeTempDir({ prefix: "albula-home-" }), userDir = await Deno.makeTempDir({ prefix: "albula-user-" });
const before = { HOME: Deno.env.get("HOME"), SLICERLIVE_CONFIG_DIR: Deno.env.get("SLICERLIVE_CONFIG_DIR") };
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir); Deno.env.set("HOME", home);
const { handleSharingRequest } = await import("./sharing.ts");
const { writeSettings } = await import("./settings-file.ts");
const g = `${home}/src/live`;
await Deno.mkdir(g, { recursive: true });
await writeSettings(`${g}/settings.ini`, "[Database]\n");
const call = async (method: string, path: string, body?: unknown) => {
  const r = await handleSharingRequest(new Request(`http://x${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), g);
  return { status: r!.status, j: await r!.json() as Record<string, unknown> };
};

Deno.test("the page learns what is shared, the network, the Macs allowed; other paths are not this module's", async () => {
  const s = await call("GET", "/_db/_sharing");
  assertEquals(s.status, 200);
  for (const k of ["available", "touchID", "owner", "databases", "network", "listening", "macs", "name", "host"]) assert(k in s.j, k);
  assertEquals(s.j.databases, []);
  assertEquals(s.j.listening, false);
  assertEquals(await handleSharingRequest(new Request("http://x/_db/other"), g), null);
});

Deno.test("the critic, finding 1: the page's older copy of the settings cannot switch sharing back on (or off)", async () => {
  const { handleSettingsRequest, readSettings } = await import("./settings-file.ts");
  const file = `${g}/settings.ini`;
  const pageCopy = "[Database]\n[Sharing]\ndatabases=shared-one\nnetworks=abc\n[View]\nzoom=1\n";   // what the page read at start
  await writeSettings(file, "[Database]\n[Sharing]\ndatabases=\nnetworks=abc\n");                   // then switched off
  const r = await handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body: pageCopy.replace("zoom=1", "zoom=2") }), g);
  assertEquals(r!.status, 204);
  const now = await readSettings(file);
  assert(/\[Sharing\][^[]*databases=\s*\n/.test(now), now);
  assert(now.includes("zoom=2"), now);
});

Deno.test("a database that is not on this Mac cannot be switched on; a Mac that is not allowed cannot be removed", async () => {
  assertEquals((await call("POST", "/_db/_sharing", { id: "nothing-here", on: true })).status, 404);
  assertEquals((await call("POST", "/_db/_sharing/forget", { id: "000000000000" })).status, 404);
  for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
});
