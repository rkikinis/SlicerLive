// The top of Downloads (desktop/pictures.ts): pictures, tables, and since 2026-10-21 surface models and volumes saved
// from Save › Files (critic 2026-10-21, surfaces export, finding 3), streamed to disk. Run against a temporary HOME.
//
//   deno test -A --no-check desktop/pictures.test.ts
import { assert, assertEquals } from "jsr:@std/assert";
import { handlePictureRequest } from "./pictures.ts";

Deno.test("a surface file is streamed to the top of Downloads; a hidden or path-like name is refused", async () => {
  const home = await Deno.makeTempDir(), was = Deno.env.get("HOME"), cfg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("HOME", home); Deno.env.set("XDG_CONFIG_HOME", `${home}/.config`);
  try {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.enqueue(new Uint8Array(1000)); c.close(); } });
    const r = await handlePictureRequest(new Request("http://x/_picture/Three_boxes.surfaces.stl", { method: "POST", body }))!;
    assertEquals(r.status, 200);
    const j = await r.json() as { path: string; bytes: number };
    assertEquals(j.bytes, 1003);
    assertEquals(j.path, `${home}/Downloads/Three_boxes.surfaces.stl`);
    assertEquals((await Deno.readFile(j.path)).length, 1003);
    for (const name of [".hidden.stl", "a/b.stl", "..%2Fx.stl", "x.exe"]) {
      const bad = await handlePictureRequest(new Request(`http://x/_picture/${name}`, { method: "POST", body: "x" }));
      assert(bad === null || bad.status === 400, `${name} should be refused`);
    }
    const nii = await handlePictureRequest(new Request("http://x/_picture/T1.nii.gz", { method: "POST", body: "x" }))!;
    assertEquals(nii.status, 200);
  } finally {
    if (was) Deno.env.set("HOME", was);
    if (cfg) Deno.env.set("XDG_CONFIG_HOME", cfg); else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a second file of the same name gets ' 2', not the first one's place", async () => {
  const home = await Deno.makeTempDir(), was = Deno.env.get("HOME"), cfg = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("HOME", home); Deno.env.set("XDG_CONFIG_HOME", `${home}/.config`);
  try {
    const put = async (body: string) => (await (await handlePictureRequest(new Request("http://x/_picture/Everything_shown_in_3D.surfaces.stl", { method: "POST", body }))!).json()) as { path: string };
    const a = await put("first"), b = await put("second"), c = await put("third");
    assertEquals([a.path, b.path, c.path].map((p) => p.split("/").pop()), ["Everything_shown_in_3D.surfaces.stl", "Everything_shown_in_3D 2.surfaces.stl", "Everything_shown_in_3D 3.surfaces.stl"]);
    assertEquals(await Deno.readTextFile(a.path), "first");
  } finally {
    if (was) Deno.env.set("HOME", was);
    if (cfg) Deno.env.set("XDG_CONFIG_HOME", cfg); else Deno.env.delete("XDG_CONFIG_HOME");
    await Deno.remove(home, { recursive: true });
  }
});
