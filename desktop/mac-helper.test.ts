// The Mac's own services for sharing (mac-helper.ts): what can be checked without a person at the Mac -- no Touch ID
// prompt is ever shown here. Skipped where the helper is not built (not a Mac, or no Apple compiler).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { advertise, browse, canConfirmOwner, helperPath, type SeenMac } from "./mac-helper.ts";

const HAVE = !!helperPath();

Deno.test({ name: "the Mac says what it can confirm its owner with, without asking anyone", ignore: !HAVE, fn: async () => {
  const c = await canConfirmOwner();
  assertEquals(typeof c.touchID, "boolean");
  assertEquals(typeof c.owner, "boolean");
} });

Deno.test({ name: "a Mac that announces itself on the network is found by its name, with what it said", ignore: !HAVE, sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const name = `Albula test ${crypto.randomUUID().slice(0, 8)}`;
  const iface = /interface: (\S+)/.exec(new TextDecoder().decode(new Deno.Command("/sbin/route", { args: ["-n", "get", "default"], stdout: "piped" }).outputSync().stdout))?.[1] ?? "en0";
  const ad = advertise(name, 47998, { dbs: "a,b" }, iface);
  const seen = await new Promise<SeenMac | undefined>((resolve) => {
    const t = setTimeout(() => { b.stop(); resolve(undefined); }, 8000);
    const b = browse((e) => { if (e.event === "up" && e.name === name) { clearTimeout(t); b.stop(); resolve(e); } });
  });
  ad.stop();
  assert(seen, "not found within 8 s");
  assertEquals(seen.port, 47998);
  assertEquals(seen.txt?.dbs, "a,b");
} });
