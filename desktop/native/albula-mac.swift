// THE MAC'S OWN SERVICES FOR SHARING A DATABASE (Ron, 2026-10-28: "Can we do better and more convenient without
// compromising security? E.g using the local authentication"; the workspace's DATABASE-SHARING.md). A small helper the
// server calls (desktop/mac-helper.ts); the page never talks to it. Built with the app (make-app.ts), ad-hoc signed.
//
//   albula-mac can-auth                          -> {"touchID": bool, "owner": bool}               (shows nothing)
//   albula-mac auth <reason> [seconds]           -> {"ok": bool, "why"?: string}; exit 0 when confirmed
//                                                   Touch ID, or the login password where there is none; the dialog
//                                                   goes away unanswered after <seconds> (default 60): a no
//   albula-mac advertise <name> <port> <txt> <interface>
//                                                announces _albula._tcp on that network interface only ("en0"), until
//                                                   standard input closes; <txt> is a JSON object of short strings
//   albula-mac browse                            one JSON line per Mac that appears or goes ({"event":"up"|"down", ...})
//                                                   until standard input closes
import Foundation
import LocalAuthentication
import dnssd

func out(_ o: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
  FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func fail(_ why: String, _ code: Int32 = 2) -> Never { out(["ok": false, "why": why]); exit(code) }

/// Ends the process when the parent closes our standard input (the server stopped, or stopped sharing).
func exitWhenParentGoes() {
  DispatchQueue.global().async { _ = FileHandle.standardInput.readDataToEndOfFile(); exit(0) }
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("no command") }

switch args[1] {
case "can-auth":
  let c = LAContext(); var e: NSError?
  let bio = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e)
  e = nil
  let owner = c.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e)
  out(["touchID": bio, "owner": owner])

case "auth":
  guard args.count >= 3 else { fail("auth needs a reason") }
  let c = LAContext(), done = DispatchSemaphore(value: 0)
  var ok = false, why = ""
  c.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: args[2]) { success, error in
    ok = success; why = error?.localizedDescription ?? ""; done.signal()
  }
  let limit = Double(args.count >= 4 ? args[3] : "60") ?? 60
  if done.wait(timeout: .now() + limit) == .timedOut { c.invalidate(); _ = done.wait(timeout: .now() + 2); ok = false; why = "no answer in time" }
  if ok { out(["ok": true]); exit(0) } else { out(["ok": false, "why": why]); exit(1) }

case "advertise":
  // ON ONE INTERFACE ONLY (the critic 2026-10-28, finding 6: NetService announced on every connection, a VPN's included).
  guard args.count >= 6, let port = UInt16(args[3]) else { fail("advertise needs a name, a port, a TXT object and an interface") }
  let ifIndex = if_nametoindex(args[5])
  guard ifIndex != 0 else { fail("no network interface \(args[5])") }
  var txt = TXTRecordRef()
  TXTRecordCreate(&txt, 0, nil)
  if let d = args[4].data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] {
    for (k, v) in o { let b = Array(v.utf8); _ = TXTRecordSetValue(&txt, k, UInt8(min(b.count, 255)), b) }
  }
  var ref: DNSServiceRef?
  let err = DNSServiceRegister(&ref, 0, ifIndex, args[2], "_albula._tcp", nil, nil, port.bigEndian, TXTRecordGetLength(&txt), TXTRecordGetBytesPtr(&txt), nil, nil)
  TXTRecordDeallocate(&txt)
  guard err == kDNSServiceErr_NoError, let r = ref else { fail("Bonjour refused (\(err))") }
  exitWhenParentGoes()
  let fd = DNSServiceRefSockFD(r)
  while true {
    var fds = fd_set(); __darwin_fd_set(fd, &fds)
    var tv = timeval(tv_sec: 1, tv_usec: 0)
    // Bonjour's own service gone (it restarted): stop, rather than spin; the server starts the announcement again (R2-12).
    if select(fd + 1, &fds, nil, nil, &tv) > 0, DNSServiceProcessResult(r) != kDNSServiceErr_NoError { exit(3) }
  }

case "browse":
  final class Browser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    var resolving: [NetService] = []
    func netServiceBrowser(_ b: NetServiceBrowser, didFind s: NetService, moreComing: Bool) {
      resolving.append(s); s.delegate = self; s.resolve(withTimeout: 5)
    }
    func netServiceBrowser(_ b: NetServiceBrowser, didRemove s: NetService, moreComing: Bool) {
      out(["event": "down", "name": s.name]); resolving.removeAll { $0 === s }
    }
    func netServiceDidResolveAddress(_ s: NetService) {
      var txt: [String: String] = [:]
      if let d = s.txtRecordData() { for (k, v) in NetService.dictionary(fromTXTRecord: d) { txt[k] = String(data: v, encoding: .utf8) ?? "" } }
      out(["event": "up", "name": s.name, "host": s.hostName ?? "", "port": s.port, "txt": txt])
    }
  }
  let b = NetServiceBrowser(), d = Browser()
  b.delegate = d
  b.searchForServices(ofType: "_albula._tcp.", inDomain: "local.")
  exitWhenParentGoes()
  RunLoop.main.run()

default:
  fail("unknown command \(args[1])")
}
