// THE SHARING MAC'S CERTIFICATE (desktop/db-share.ts). Made once, on first sharing, by the system's own openssl
// (/usr/bin/openssl, LibreSSL on every Mac: no other program needed); kept with its key in the sharing folder, readable by
// this user only. Its fingerprint goes into the six digits both Macs show when they pair (db-share.ts pairingDigits), so a
// Mac in between, with another certificate, shows different digits.
import { userSettingsPath } from "./settings-file.ts";

/** Where sharing keeps its certificate, key and paired clients: beside the settings file (SLICERLIVE_CONFIG_DIR in tests). */
export function shareDir(): string {
  const s = userSettingsPath();
  return `${s.slice(0, Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")))}/share`;
}

/** This Mac's name on the local network ("Rons-MBP.local"), as the other Mac addresses it. */
export function localHostName(): string {
  try {
    const r = new Deno.Command("/usr/sbin/scutil", { args: ["--get", "LocalHostName"], stdout: "piped", stderr: "null" }).outputSync();
    const n = new TextDecoder().decode(r.stdout).trim();
    if (r.success && n) return `${n}.local`;
  } catch { /* not macOS */ }
  return Deno.hostname();
}

/** This Mac's name as people know it (System Settings › General › Sharing: "kitchen mini"), for the other Mac's dialogs. */
export function computerName(): string {
  try {
    const r = new Deno.Command("/usr/sbin/scutil", { args: ["--get", "ComputerName"], stdout: "piped", stderr: "null" }).outputSync();
    const n = new TextDecoder().decode(r.stdout).trim();
    if (r.success && n) return n.normalize("NFC").replace(/[^\p{L}\p{N}_ .()'’-]/gu, "").trim().slice(0, 60) || localHostName().replace(/\.local$/, "");
  } catch { /* not macOS */ }
  return localHostName().replace(/\.local$/, "");
}

const OPENSSL = "/usr/bin/openssl";
async function run(args: string[]): Promise<void> {
  const r = await new Deno.Command(OPENSSL, { args, stdout: "null", stderr: "piped" }).output();
  if (!r.success) throw new Error(`openssl ${args[0]}: ${new TextDecoder().decode(r.stderr).trim()}`);
}

/** The certificate and key, made the first time. A P-256 key (generated apart from the request: LibreSSL's one-step
 *  "-newkey ec" wrote a key that did not match its certificate, measured 2026-10-26), valid 825 days, named for this Mac
 *  and localhost. THE KEY IS A FILE ONLY THIS USER CAN READ, like an SSH host key (the critic 2026-10-28, round 2, R2-2:
 *  kept in the Keychain it could be lost, overwritten by another settings folder, or held behind a password dialog after an
 *  update, and every pairing then broke). A certificate that is there is NEVER replaced: if its key is missing, sharing
 *  stops and says so, because every paired Mac has pinned this certificate. */
export async function ensureCertificate(dir = shareDir(), host = localHostName()): Promise<{ cert: string; key: string }> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const certPath = `${dir}/cert.pem`, keyPath = `${dir}/key.pem`;
  const cert = await Deno.readTextFile(certPath).catch(() => undefined);
  if (cert) {
    const key = await Deno.readTextFile(keyPath).catch(() => undefined);
    if (!key) throw new Error("this Mac's sharing key is missing (its certificate is there); the Macs paired with it would have to pair again");
    return { cert, key };
  }
  // ONE MAKER AT A TIME (R2-10: two starts at once broke each other's files): a lock beside them.
  const lock = `${dir}/.making`;
  try { await Deno.writeTextFile(lock, String(Deno.pid), { createNew: true }); }
  catch { await new Promise((r) => setTimeout(r, 1500)); return await ensureCertificate(dir, host); }
  const ec = `${dir}/ec.tmp.pem`;
  try {
    await run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ec]);
    await run(["pkcs8", "-topk8", "-nocrypt", "-in", ec, "-out", keyPath]);
    await Deno.chmod(keyPath, 0o600);
    await run(["req", "-new", "-x509", "-key", keyPath, "-days", "825", "-subj", `/CN=Albula database on ${host}`,
      "-addext", `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`, "-out", certPath]);
  } finally { await Deno.remove(ec).catch(() => {}); await Deno.remove(lock).catch(() => {}); }
  return { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath) };
}

/** SHA-256 of the certificate's DER bytes, hex. */
export async function certFingerprint(pem: string): Promise<string> {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", der))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
