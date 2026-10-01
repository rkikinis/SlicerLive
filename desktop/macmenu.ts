// Native macOS menu bar for the webview app, via Objective-C runtime FFI.
// webview_deno creates the NSApplication but no main menu (so no ⌘Q, no
// Edit-menu clipboard in text fields). Call installMacMenu() after the Webview
// is constructed (AppKit is loaded by then) and before webview.run().
//
// Menus: <App> (About / Hide / Quit ⌘Q) · Edit (clipboard, first-responder
// targeted — required for ⌘C/⌘V to work in WKWebView) · Window (Minimize ⌘M,
// Zoom, Close Window ⇧⌘W) · Help (<App> Help ⌘? → onHelp callback, fired on the main
// thread while webview.run() is blocked, same re-entry path as bind()).

// Loaded lazily so importing this module is harmless on Windows/Linux.
function loadObjc() {
  return Deno.dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: { parameters: ["buffer"], result: "pointer" },
  sel_registerName: { parameters: ["buffer"], result: "pointer" },
  objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
  objc_registerClassPair: { parameters: ["pointer"], result: "void" },
  class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
  // objc_msgSend under one alias per call shape we need.
  send: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
  send_p: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "pointer" },
  send_ppp: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer", "pointer", "pointer"], result: "pointer" },
  send_buf: { name: "objc_msgSend", parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
  send_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "u64"], result: "pointer" },
  send_bool: { name: "objc_msgSend", parameters: ["pointer", "pointer", "bool"], result: "void" },
  // BOOL-returning sends get their own alias: reading a BOOL through a pointer result would
  // trust bits the callee never set.
  ask_bool: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "bool" },
  ask_bool_p: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "bool" },
  ask_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "u64" },
  // NSRect / NSPoint by value, for the window's place (arm64: no _stret variant is needed).
  ask_rect: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: { struct: ["f64", "f64", "f64", "f64"] } },
  send_point: { name: "objc_msgSend", parameters: ["pointer", "pointer", { struct: ["f64", "f64"] }], result: "void" },
  } as const).symbols;
}
let objcSymbols: ReturnType<typeof loadObjc> | undefined;
const objc = () => (objcSymbols ??= loadObjc());

const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const cls = (name: string) => objc().objc_getClass(cstr(name));
const sel = (name: string) => objc().sel_registerName(cstr(name));
const nsstring = (s: string) => objc().send_buf(cls("NSString"), sel("stringWithUTF8String:"), cstr(s));

const CMD = 1n << 20n, SHIFT = 1n << 17n, OPTION = 1n << 19n;

function menuItem(
  title: string,
  action: Deno.PointerValue | null,
  key: string,
  opts: { target?: Deno.PointerValue; mask?: bigint } = {},
): Deno.PointerValue {
  const item = objc().send(cls("NSMenuItem"), sel("alloc"));
  const it = objc().send_ppp(item, sel("initWithTitle:action:keyEquivalent:"), nsstring(title), action, nsstring(key));
  if (opts.target) objc().send_p(it, sel("setTarget:"), opts.target);
  if (opts.mask !== undefined) objc().send_u64(it, sel("setKeyEquivalentModifierMask:"), opts.mask);
  return it;
}

function submenu(mainMenu: Deno.PointerValue, title: string): Deno.PointerValue {
  const holder = menuItem(title, null, "");
  objc().send_p(mainMenu, sel("addItem:"), holder);
  const menu = objc().send_p(objc().send(cls("NSMenu"), sel("alloc")), sel("initWithTitle:"), nsstring(title));
  objc().send_p(holder, sel("setSubmenu:"), menu);
  return menu;
}

function addItems(menu: Deno.PointerValue, items: (Deno.PointerValue | "sep")[]) {
  for (const i of items) {
    objc().send_p(menu, sel("addItem:"), i === "sep" ? objc().send(cls("NSMenuItem"), sel("separatorItem")) : i);
  }
}

/** Modal alert for fatal errors, which are otherwise invisible from Finder /
 *  a --no-terminal Windows exe. NSAlert on macOS, MessageBoxW on Windows. */
export function showAlert(title: string, message: string) {
  if (Deno.build.os === "windows") {
    const utf16 = (s: string) => {
      const u = new Uint16Array(s.length + 1);
      for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
      return new Uint8Array(u.buffer);
    };
    const user32 = Deno.dlopen("user32.dll", {
      MessageBoxW: { parameters: ["pointer", "buffer", "buffer", "u32"], result: "i32" },
    });
    user32.symbols.MessageBoxW(null, utf16(message), utf16(title), 0x10 /* MB_ICONERROR */);
    return;
  }
  if (Deno.build.os !== "darwin") return;
  objc().send(cls("NSApplication"), sel("sharedApplication"));
  const alert = objc().send(objc().send(cls("NSAlert"), sel("alloc")), sel("init"));
  objc().send_p(alert, sel("setMessageText:"), nsstring(title));
  objc().send_p(alert, sel("setInformativeText:"), nsstring(message));
  objc().send(alert, sel("runModal"));
}

// Kept module-global so the FFI callback and its target object outlive install.
// Kept alive for the process's lifetime: an UnsafeCallback that is garbage-collected while AppKit
// still holds its pointer would crash the app the first time the menu item is used.
let helpCallback: unknown;
let reloadCallback: unknown;
let settingsCallback: unknown;

export function installMacMenu(appName: string, onHelp: () => void, onReload?: () => void, onSettings?: () => void) {
  if (Deno.build.os !== "darwin") return;
  const app = objc().send(cls("NSApplication"), sel("sharedApplication"));

  // A tiny NSObject subclass whose sllShowHelp: / sllReload: methods run the callbacks.
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => onHelp(),
  );
  helpCallback = cb;
  const rcb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => onReload?.(),
  );
  reloadCallback = rcb;
  // Settings… ⌘, under About, where the Mac puts it (Ron, 2026-09-20: "not a module but a
  // settings … a pull down or pop up triggered from a position under the about").
  const scb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => onSettings?.(),
  );
  settingsCallback = scb;
  const targetCls = objc().objc_allocateClassPair(cls("NSObject"), cstr("SLLMenuTarget"), 0n);
  objc().class_addMethod(targetCls, sel("sllShowHelp:"), cb.pointer, cstr("v@:@"));
  objc().class_addMethod(targetCls, sel("sllShowSettings:"), scb.pointer, cstr("v@:@"));
  objc().class_addMethod(targetCls, sel("sllReload:"), rcb.pointer, cstr("v@:@"));
  objc().objc_registerClassPair(targetCls);
  const helpTarget = objc().send(objc().send(targetCls, sel("alloc")), sel("init"));

  const mainMenu = objc().send(objc().send(cls("NSMenu"), sel("alloc")), sel("init"));

  addItems(submenu(mainMenu, appName), [
    menuItem(`About ${appName}`, sel("orderFrontStandardAboutPanel:"), "", { target: app }),
    "sep",
    menuItem("Settings…", sel("sllShowSettings:"), ",", { target: helpTarget }),
    "sep",
    menuItem(`Hide ${appName}`, sel("hide:"), "h", { target: app }),
    menuItem("Hide Others", sel("hideOtherApplications:"), "h", { target: app, mask: CMD | OPTION }),
    menuItem("Show All", sel("unhideAllApplications:"), "", { target: app }),
    "sep",
    menuItem(`Quit ${appName}`, sel("terminate:"), "q", { target: app }),
  ]);

  addItems(submenu(mainMenu, "Edit"), [
    menuItem("Undo", sel("undo:"), "z"),
    menuItem("Redo", sel("redo:"), "z", { mask: CMD | SHIFT }),
    "sep",
    menuItem("Cut", sel("cut:"), "x"),
    menuItem("Copy", sel("copy:"), "c"),
    menuItem("Paste", sel("paste:"), "v"),
    menuItem("Select All", sel("selectAll:"), "a"),
  ]);

  // View · Reload (Cmd-R). The webview has no reload of its own, so Cmd-R only beeped -- and
  // iterating on the page meant quitting and relaunching the app every time.
  addItems(submenu(mainMenu, "View"), [
    menuItem("Reload", sel("sllReload:"), "r", { target: helpTarget }),
  ]);

  const windowMenu = submenu(mainMenu, "Window");
  addItems(windowMenu, [
    menuItem("Minimize", sel("performMiniaturize:"), "m"),
    menuItem("Zoom", sel("performZoom:"), ""),
    "sep",
    // ⇧⌘W, not ⌘W: in Albula ⌘W closes the SCENE, as Ctrl+W does in 3D Slicer (Ron, 2026-09-25: shortcuts "adhere to
    // Slicer as much as possible"). The window keeps the convention of document apps, where ⌘W closes the document.
    menuItem("Close Window", sel("performClose:"), "w", { mask: CMD | SHIFT }),
  ]);
  objc().send_p(app, sel("setWindowsMenu:"), windowMenu);

  const helpMenu = submenu(mainMenu, "Help");
  addItems(helpMenu, [
    menuItem(`${appName} Help`, sel("sllShowHelp:"), "?", { target: helpTarget }),
  ]);
  objc().send_p(app, sel("setHelpMenu:"), helpMenu);

  objc().send_p(app, sel("setMainMenu:"), mainMenu);
}

// KEEP THE PAGE "VISIBLE" WHILE ITS WINDOW IS ON ANOTHER DESKTOP.
//
// Ron, 2026-09-16: "My environment is configured with multiple desktops. I am frequently
// switching. The slicer viewer resets and I lose all that I have loaded." Read from WebKit's
// source (main, 2026-09-16), the chain is:
//
//   1. a window on another Space (or behind another window) loses NSWindowOcclusionStateVisible;
//      PageClientImpl::isViewVisible() then reports the page not visible, IF window-occlusion
//      detection is on (UIProcess/mac/PageClientImplMac.mm);
//   2. eight minutes not visible and the web process goes "Inactive"
//      (WebCore/page/PerformanceMonitor.cpp, delayBeforeProcessMayBecomeInactive = 8_min);
//   3. every 30 s the process measures its footprint and kills itself past a threshold that is
//      15 GB + 1 GB per page while Active on a Mac with more than 16 GB, and 3 GB + 1 GB per
//      page while Inactive (WTF/wtf/MemoryPressureHandler.cpp, thresholdForMemoryKillOf*).
//
// A page holding a study sits at 4-12 GB, so it dies within nine minutes of being left on
// another desktop, with nothing in any log a user can find. The same non-visible state throttles
// timers, which is why a surface build crawled to 113 s on 09-14.
//
// The switch is WebKit's own: -[WKWebView _setWindowOcclusionDetectionEnabled:NO]
// (UIProcess/API/Cocoa/WKWebViewPrivate.h), which WebKit itself flips off where occlusion state
// is unreliable. Private API, so it is probed with respondsToSelector: and read back after
// setting; the app runs as before when a WebKit stops answering.
//
// NOT COVERED, measured 2026-09-17 by the critic: a MINIMIZED window (Cmd-M, the yellow button)
// and a hidden application (Cmd-H). isViewVisible() asks the window's own isVisible BEFORE the
// occlusion test, and a miniaturized or ordered-out NSWindow answers NO, so the switch never gets
// a say: the page goes hidden at once and the eight-minute clock runs. What this switch closes is
// the window on another Space or behind another window -- measured with a covering window
// (visibilityState stays "visible"); the desktop switch itself and the eight-minute kill were
// reasoned from WebKit's sources, not observed.
export function keepPageVisibleOffScreen(nsWindow: Deno.PointerValue): string {
  if (Deno.build.os !== "darwin") return "not macOS";
  if (!nsWindow) return "no window handle";
  const o = objc();
  const wk = cls("WKWebView");
  if (!wk) return "no WKWebView class";
  // In webview 0.9.0 the window's content view is a plain NSView and the WKWebView is its first
  // subview (looked at, 2026-09-17); the direct test is kept for a version that makes the
  // WKWebView the content view itself.
  let view = o.send(nsWindow, sel("contentView"));
  if (!view) return "no content view";
  if (!o.ask_bool_p(view, sel("isKindOfClass:"), wk)) {
    const subs = o.send(view, sel("subviews"));
    const n = Number(o.ask_u64(subs, sel("count")));
    let found: Deno.PointerValue = null;
    for (let i = 0; i < n && !found; i++) {
      const v = o.send_u64(subs, sel("objectAtIndex:"), BigInt(i));
      if (v && o.ask_bool_p(v, sel("isKindOfClass:"), wk)) found = v;
    }
    if (!found) return "no WKWebView in the window";
    view = found;
  }
  const setter = sel("_setWindowOcclusionDetectionEnabled:");
  const getter = sel("_windowOcclusionDetectionEnabled");
  if (!o.ask_bool_p(view, sel("respondsToSelector:"), setter)) return "WebKit has no _setWindowOcclusionDetectionEnabled:";
  o.send_bool(view, setter, false);
  const now = o.ask_bool(view, getter);
  return now ? "set, but WebKit still reports it on" : "off";
}

/**
 * PUT THE WINDOW BACK WHERE IT WAS: its top-left corner at (x, y), in the top-left, y-down screen
 * coordinates the page reports and the launcher used (relative to the primary display).
 *
 * webview_deno sizes the window but has no way to place it -- that is why the launcher did it from
 * outside, through System Events, and why a start from the Dock always came up centered (Ron,
 * 2026-09-23: "Improve the dock start experience and I will use it exclusively").
 *
 * Only if the corner lands on a screen that exists now: a frame saved on a display that has since
 * been unplugged would put the window where nobody can see it, and centered is better than lost.
 */
export function placeWindowTopLeft(nsWindow: Deno.PointerValue, x: number, y: number): string {
  if (Deno.build.os !== "darwin") return "not macOS";
  if (!nsWindow) return "no window handle";
  const o = objc();
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  if (!n) return "no screens";
  const rect = (obj: Deno.PointerValue) => new Float64Array((o.ask_rect(obj, sel("frame")) as Uint8Array).slice().buffer);
  // Cocoa's global coordinates are y-up from the bottom of the PRIMARY screen (the first one).
  const primary = rect(o.send_u64(screens, sel("objectAtIndex:"), 0n));
  const primaryH = primary[3];
  const cx = x, cy = primaryH - y;                      // the corner, in Cocoa's terms
  let onScreen = false;
  for (let i = 0; i < n && !onScreen; i++) {
    const f = rect(o.send_u64(screens, sel("objectAtIndex:"), BigInt(i)));
    // A little inside the corner, so a window flush against a screen edge still counts.
    const px = cx + 20, py = cy - 20;
    if (px >= f[0] && px <= f[0] + f[2] && py >= f[1] && py <= f[1] + f[3]) onScreen = true;
  }
  if (!onScreen) return `not placed: (${x}, ${y}) is on no screen now`;
  o.send_point(nsWindow, sel("setFrameTopLeftPoint:"), new Float64Array([cx, cy]));
  return `placed at (${x}, ${y})`;
}

/**
 * THE DISPLAYS ATTACHED NOW, for choosing where the window opens (desktop/window-frame.ts): each one's
 * size, and its usable area -- without the menu bar and the Dock -- in the top-left, y-down
 * coordinates the page and the saved file use. The first is the main display (the one with the menu
 * bar). Safe to call before the window exists: AppKit is loaded here if nothing has loaded it yet.
 */
export function attachedDisplays(): { w: number; h: number; usable: { x: number; y: number; w: number; h: number } }[] {
  if (Deno.build.os !== "darwin") return [];
  try { Deno.dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {}); } catch { /* loaded already, or not there */ }
  const o = objc();
  const screensCls = cls("NSScreen");
  if (!screensCls) return [];
  const screens = o.send(screensCls, sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  const rect = (obj: Deno.PointerValue, what: string) => new Float64Array((o.ask_rect(obj, sel(what)) as Uint8Array).slice().buffer);
  const out: { w: number; h: number; usable: { x: number; y: number; w: number; h: number } }[] = [];
  let primaryH = 0;
  for (let i = 0; i < n; i++) {
    const sc = o.send_u64(screens, sel("objectAtIndex:"), BigInt(i));
    const f = rect(sc, "frame"), v = rect(sc, "visibleFrame");
    if (i === 0) primaryH = f[3];
    // Cocoa is y-up from the bottom of the main display; the page and the file are y-down from its top.
    out.push({ w: f[2], h: f[3], usable: { x: v[0], y: primaryH - (v[1] + v[3]), w: v[2], h: v[3] } });
  }
  return out;
}
