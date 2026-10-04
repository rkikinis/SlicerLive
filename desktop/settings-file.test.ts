// The settings endpoint is the only writable route the app exposes, and it holds the user's single
// copy of their preferences, so its behavior is pinned here rather than checked by hand.
//
// SLICERLIVE_CONFIG_DIR points the per-user store at a temporary directory: a test that wrote the
// real ~/.config/slicerlive/settings.ini would destroy exactly what this feature exists to protect.
//
//   deno test -A --no-check desktop/settings-file.test.ts
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";

const userDir = await Deno.makeTempDir({ prefix: "slicerlive-user-" });
Deno.env.set("SLICERLIVE_CONFIG_DIR", userDir);

// Imported AFTER the env var is set: the module reads it once, at load.
const { handleSettingsRequest, readSettings, resolveSettingsPath, userSettingsPath } =
  await import("./settings-file.ts");

// A stand-in for the real layout: <folder>/src/live is the gallery, so the folder is two levels up.
const folder = await Deno.makeTempDir({ prefix: "slicerlive-folder-" });
const gallery = `${folder}/src/live`;
await Deno.mkdir(gallery, { recursive: true });

const get = (root?: string) => handleSettingsRequest(new Request("http://x/_settings"), root);
const put = (body: string, root?: string) =>
  handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body }), root);

Deno.test("with no folder settings.ini, the per-user path is used", () => {
  assertEquals(resolveSettingsPath(gallery), userSettingsPath());
  assertEquals(userSettingsPath(), `${userDir}/settings.ini`);
});

Deno.test("GET before anything is stored returns empty, not an error", async () => {
  const r = await get(gallery);
  assertEquals(r?.status, 200);
  assertEquals(await r?.text(), "");
});

Deno.test("PUT stores, GET reads back verbatim, and reports where", async () => {
  const ini = "[Window]\nx=1642\ny=143\nw=1219\nh=1350\n\n[Colorize]\npreset=CT-Bone\n";
  const w = await put(ini, gallery);
  assertEquals(w?.status, 204);
  const r = await get(gallery);
  assertEquals(await r?.text(), ini);
  assertEquals(r?.headers.get("x-settings-path"), userSettingsPath());
});

// The folder copy is what makes the SlicerLive folder self-contained and movable.
Deno.test("a folder settings.ini takes over, and the per-user file is left alone", async () => {
  const userBefore = await readSettings(userSettingsPath());
  const folderIni = `${folder}/settings.ini`;
  await Deno.writeTextFile(folderIni, "[Colorize]\npreset=CT-Lung\n");

  assertEquals(resolveSettingsPath(gallery), folderIni);
  assertEquals(await (await get(gallery))?.text(), "[Colorize]\npreset=CT-Lung\n");

  await put("[Window]\nw=900\n", gallery);
  assertEquals(await readSettings(folderIni), "[Window]\nw=900\n");
  assertEquals(await readSettings(userSettingsPath()), userBefore);   // untouched
  assertNotEquals(userBefore, "[Window]\nw=900\n");
});

// Resolution happens per request, so opting out takes effect without relaunching.
Deno.test("deleting the folder file falls back to per-user again", async () => {
  await Deno.remove(`${folder}/settings.ini`);
  assertEquals(resolveSettingsPath(gallery), userSettingsPath());
});

Deno.test("a folder file is never created on its own", async () => {
  await put("[A]\nk=1\n", gallery);
  assertEquals(await readSettings(`${folder}/settings.ini`), "");
});

Deno.test("PUT replaces rather than appends, leaving no temporary files", async () => {
  await put("[A]\nk=1\n", gallery);
  await put("[B]\nk=2\n", gallery);
  assertEquals(await readSettings(userSettingsPath()), "[B]\nk=2\n");
  assertEquals([...Deno.readDirSync(userDir)].map((e) => e.name).sort(), ["settings.ini"]);
});

Deno.test("an oversized body is refused, and does not overwrite", async () => {
  await put("[Keep]\nk=1\n", gallery);
  assertEquals((await put("x".repeat(1_000_001), gallery))?.status, 413);
  assertEquals(await readSettings(userSettingsPath()), "[Keep]\nk=1\n");
});

Deno.test("other methods are refused with Allow", async () => {
  const r = await handleSettingsRequest(new Request("http://x/_settings", { method: "DELETE" }), gallery);
  assertEquals(r?.status, 405);
  assertEquals(r?.headers.get("allow"), "GET, PUT");
});

Deno.test("any other path is not ours: null, so the static server handles it", async () => {
  assertEquals(await handleSettingsRequest(new Request("http://x/webgpu/slicer-app.html"), gallery), null);
  assertEquals(await handleSettingsRequest(new Request("http://x/_settings/other"), gallery), null);
});

Deno.test("the page's older copy never erases the database list the server wrote (Ron, 2026-10-02: a database vanished)", async () => {
  const gallery = await Deno.makeTempDir();
  const put = (body: string) => handleSettingsRequest(new Request("http://x/_settings", { method: "PUT", body }), gallery);
  // The page started and read a file with one database...
  const path = resolveSettingsPath(gallery);
  await Deno.writeTextFile(path, "[Database]\ncurrent=albula\nalbula=/data/work\n\n[Layout]\nview=four-up\n");
  // ...the server then registered a second one...
  await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace("albula=/data/work", "albula=/data/work\ntests=/data/tests"));
  // ...and the page writes its layout back from its old copy.
  await put("[Database]\ncurrent=albula\nalbula=/data/work\n\n[Layout]\nview=red\n");
  const now = await Deno.readTextFile(path);
  assert(now.includes("tests=/data/tests"), now);
  assert(now.includes("view=red"), now);
  // A page that never had the section does not remove it either.
  await put("[Layout]\nview=green\n");
  assert((await Deno.readTextFile(path)).includes("tests=/data/tests"));
});
