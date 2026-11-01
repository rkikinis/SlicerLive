// SHARE DATABASES WITH ANOTHER MAC -- the program the person starts on the Mac that holds them (desktop/db-share.ts says
// what it allows and why). A trial: started from Terminal, stopped with Ctrl-C; while it is not running nothing is
// reachable.
//
//   deno run -A --config Contents/src/SlicerLive/deno.jsonc Contents/src/SlicerLive/desktop/share-databases-main.ts \
//     --db "mediastinal-lymph-nodes" [--db martinos-prisma] [--pair] [--port 8443]
//   ... share-databases-main.ts --list            the Macs paired with this one
//   ... share-databases-main.ts --unpair <name>   one of them no longer comes in (its key stops working at once)
//
// --pair: another Mac may pair while this runs: both show the same six digits, and this Mac asks for Touch ID (db-share.ts).
// Without --pair only Macs paired before can come in. (The app's own switch replaces this program: DATABASE-SHARING.md.)
import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { setDicomLibrary } from "../logic/dicom-io.ts";
import dcmjs from "../logic/dcmjs.ts";
import { readClients, shareHandler, writeClients, type Pairing } from "./db-share.ts";
import { confirmOwner } from "./mac-helper.ts";
import { certFingerprint, ensureCertificate, localHostName, shareDir } from "./db-share-cert.ts";
import { registeredDatabases } from "./db-serve.ts";
setDicomLibrary(dcmjs);

const a = parseArgs(Deno.args, { string: ["db", "port", "unpair"], boolean: ["pair", "list"], collect: ["db"] });
if (a.list || a.unpair) {
  const list = await readClients(shareDir());
  if (a.unpair) {
    const keep = list.filter((c) => c.name !== a.unpair);
    if (keep.length === list.length) { console.error(`no paired Mac named “${a.unpair}” (paired: ${list.map((c) => c.name).join(", ") || "none"})`); Deno.exit(2); }
    await writeClients(shareDir(), keep);
    console.log(`“${a.unpair}” unpaired: its key no longer works.`);
  } else console.log(list.length ? list.map((c) => `${c.name}  (paired ${c.pairedAt})`).join("\n") : "no Mac is paired with this one");
  Deno.exit(0);
}
const ids = (a.db as string[] | undefined) ?? [];
const port = Number(a.port ?? 8443);
const say = (m: string) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
if (!ids.length) { console.error("name the databases to share: --db <id> (as Albula's settings file names them, [Database])"); Deno.exit(2); }
const list = await registeredDatabases();
for (const id of ids) if (!list.some((d) => d.id === id && d.exists)) { console.error(`no database “${id}” on this Mac (ids: ${list.map((d) => d.id).join(", ")})`); Deno.exit(2); }

const dir = shareDir(), host = localHostName();
const { cert, key } = await ensureCertificate(dir, host);
const fingerprint = await certFingerprint(cert);
const pairing: Pairing | undefined = a.pair ? { certFingerprint: fingerprint, confirm: async (reason) => (await confirmOwner(reason)).ok } : undefined;
const opts = { ids, dir, pairing, log: say };
const handler = shareHandler(opts);
Deno.serve({ port, hostname: "0.0.0.0", cert, key, onListen() {} }, handler);
// The certificate, unencrypted, while pairing is possible: its fingerprint goes into the six digits on the other Mac.
if (pairing) Deno.serve({ port: port + 1, hostname: "0.0.0.0", onListen() {} }, (req) =>
  new URL(req.url).pathname === "/_share/cert" ? new Response(cert, { headers: { "content-type": "application/x-pem-file" } }) : new Response("", { status: 404 }));
say(`sharing ${ids.map((i) => `“${list.find((d) => d.id === i)?.description?.name ?? i}”`).join(", ")} from ${host}, port ${port} -- Ctrl-C stops it`);
if (pairing) say(`pairing open: on the other Mac, connect to ${host}; this Mac asks for Touch ID and shows the six digits to compare`);
say("--list shows the paired Macs, --unpair <name> removes one");
