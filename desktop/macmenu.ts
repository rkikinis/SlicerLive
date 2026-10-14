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
  send_rect_bool: { name: "objc_msgSend", parameters: ["pointer", "pointer", { struct: ["f64", "f64", "f64", "f64"] }, "bool"], result: "void" },
  ask_cstr: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
  ask_rect_rect: { name: "objc_msgSend", parameters: ["pointer", "pointer", { struct: ["f64", "f64", "f64", "f64"] }], result: { struct: ["f64", "f64", "f64", "f64"] } },
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
 * WHERE THE WINDOW IS NOW, read from the window itself (2026-10-01: the page's own report never arrived -- the app's
 * window file had not been written since 2026-09-23, so a moved or resized window was never remembered). Top-left,
 * y-down, as the file keeps it, with the size of the display holding the window's center ("<W>x<H>"). Null when the
 * window is minimized or off every screen.
 */
export function windowFrameNow(nsWindow: Deno.PointerValue): { display: string; x: number; y: number; w: number; h: number } | null {
  if (Deno.build.os !== "darwin" || !nsWindow) return null;
  const o = objc();
  if (o.ask_bool(nsWindow, sel("isMiniaturized"))) return null;
  const rect = (obj: Deno.PointerValue) => new Float64Array((o.ask_rect(obj, sel("frame")) as Uint8Array).slice().buffer);
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  if (!n) return null;
  const primaryH = rect(o.send_u64(screens, sel("objectAtIndex:"), 0n))[3];
  const w = rect(nsWindow);                                // Cocoa: x, y (bottom-left, y-up), width, height
  const cx = w[0] + w[2] / 2, cy = w[1] + w[3] / 2;
  for (let i = 0; i < n; i++) {
    const f = rect(o.send_u64(screens, sel("objectAtIndex:"), BigInt(i)));
    if (cx >= f[0] && cx <= f[0] + f[2] && cy >= f[1] && cy <= f[1] + f[3]) {
      return { display: `${Math.round(f[2])}x${Math.round(f[3])}`, x: w[0], y: primaryH - (w[1] + w[3]), w: w[2], h: w[3] };
    }
  }
  return null;
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

// ── HEADSETS (VR / AR glasses; desktop/headset.ts): the window onto the glasses' screen, full screen, and back; the
// glasses as a screen of their own when the Mac was mirroring (Ron, 2026-10-12: "anything that simplifies things for the
// user"). Called from the page through webview bindings (desktop/main.ts). ──

/** The screens attached now: name (macOS's, e.g. "VITURE"), frame in top-left, y-down coordinates, and the main one. */
export function screensNow(): { name: string; x: number; y: number; w: number; h: number; main: boolean }[] {
  if (Deno.build.os !== "darwin") return [];
  const o = objc();
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  const rect = (obj: Deno.PointerValue) => new Float64Array((o.ask_rect(obj, sel("frame")) as Uint8Array).slice().buffer);
  const out: { name: string; x: number; y: number; w: number; h: number; main: boolean }[] = [];
  let primaryH = 0;
  for (let i = 0; i < n; i++) {
    const sc = o.send_u64(screens, sel("objectAtIndex:"), BigInt(i));
    const f = rect(sc);
    if (i === 0) primaryH = f[3];
    let name = "";
    try {
      const ns = o.ask_bool_p(sc, sel("respondsToSelector:"), sel("localizedName")) ? o.send(sc, sel("localizedName")) : null;
      const c = ns ? o.ask_cstr(ns, sel("UTF8String")) : null;
      if (c) name = new Deno.UnsafePointerView(c).getCString();
    } catch { /* unnamed */ }
    out.push({ name, x: f[0], y: primaryH - (f[1] + f[3]), w: f[2], h: f[3], main: i === 0 });
  }
  return out;
}

const FULL_SCREEN_MASK = 1n << 14n;   // NSWindowStyleMaskFullScreen
let headsetWindowWas: Float64Array | null = null;

const isFull = (nsWindow: Deno.PointerValue) => (BigInt(objc().ask_u64(nsWindow, sel("styleMask"))) & FULL_SCREEN_MASK) !== 0n;
/** This app in front and its window the one that gets the keys. */
function bringToFront(nsWindow: Deno.PointerValue): void {
  const o = objc();
  const app = o.send(cls("NSApplication"), sel("sharedApplication"));
  if (app) o.send_bool(app, sel("activateIgnoringOtherApps:"), true);
  o.send_p(nsWindow, sel("makeKeyAndOrderFront:"), null);
}
/** The pointer to a point in top-left, y-down screen coordinates (Ron, 2026-10-12: "by default, the pointer is not inside
 *  the stereo window ... Until the pointer was in the stereo window, the keyboard and trackpad shortcuts did not work";
 *  and after Esc "The pointer is confused where it is"). */
function pointerTo(x: number, y: number): void {
  const cg = (cgSymbols ??= loadCg());
  cg.CGWarpMouseCursorPosition(new Float64Array([x, y]));
  cg.CGAssociateMouseAndMouseCursorPosition(1);
}

/** Puts the window full screen on the screen whose name contains `name`, remembering where it was; the app in front and
 *  the pointer in the middle of that screen, so keys and the trackpad reach the two pictures at once. */
export function windowToScreen(nsWindow: Deno.PointerValue, name: string): string {
  if (Deno.build.os !== "darwin" || !nsWindow) return "not here";
  const o = objc();
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  const rect = (obj: Deno.PointerValue, what = "frame") => new Float64Array((o.ask_rect(obj, sel(what)) as Uint8Array).slice().buffer);
  const list = screensNow();
  const want = list.findIndex((s) => s.name.toLowerCase().includes(name.toLowerCase()));
  if (want < 0 || want >= n) return `no screen named ${name}`;
  const sc = o.send_u64(screens, sel("objectAtIndex:"), BigInt(want));
  // Where the window is now is where it goes back to (not full screen: a full-screen frame is the whole screen).
  if (isFull(nsWindow)) o.send_p(nsWindow, sel("toggleFullScreen:"), null);   // leave full screen on the old screen first
  else headsetWindowWas = rect(nsWindow);
  o.send_rect_bool(nsWindow, sel("setFrame:display:"), rect(sc, "visibleFrame"), true);
  bringToFront(nsWindow);
  o.send_p(nsWindow, sel("toggleFullScreen:"), null);
  const t = list[want];
  pointerTo(t.x + t.w / 2, t.y + t.h / 2);
  return "on the glasses";
}

/** Leaves full screen (the first half of coming back); true if it was full screen. */
export function windowLeaveFullScreen(nsWindow: Deno.PointerValue): boolean {
  if (Deno.build.os !== "darwin" || !nsWindow) return false;
  if (!isFull(nsWindow)) return false;
  objc().send_p(nsWindow, sel("toggleFullScreen:"), null);
  return true;
}
/** Still full screen (the page waits for the animation to end before moving the window). */
export function windowIsFullScreen(nsWindow: Deno.PointerValue): boolean {
  return Deno.build.os === "darwin" && !!nsWindow && isFull(nsWindow);
}

/** The window back where it was before windowToScreen -- or, when that place is on no screen now, in the middle of the
 *  main screen -- in front, with the pointer in its middle (Ron, 2026-10-12, after Esc: "it exits stereo and full screen
 *  but does not show the albula window"). */
export function windowRestore(nsWindow: Deno.PointerValue): string {
  if (Deno.build.os !== "darwin" || !nsWindow) return "not here";
  const o = objc();
  const was = headsetWindowWas;   // kept: a second call (after macOS rearranged its screens) goes to the same place
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  const rect = (obj: Deno.PointerValue, what = "frame") => new Float64Array((o.ask_rect(obj, sel(what)) as Uint8Array).slice().buffer);
  const onScreen = (r: Float64Array) => {
    const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
    for (let i = 0; i < n; i++) { const f = rect(o.send_u64(screens, sel("objectAtIndex:"), BigInt(i))); if (cx >= f[0] && cx <= f[0] + f[2] && cy >= f[1] && cy <= f[1] + f[3]) return true; }
    return false;
  };
  let target = was && onScreen(was) ? was : null;
  if (!target) {   // the main screen's middle, at most its usable size
    const v = rect(o.send_u64(screens, sel("objectAtIndex:"), 0n), "visibleFrame");
    const w = Math.min(was?.[2] ?? 1400, v[2]), h = Math.min(was?.[3] ?? 900, v[3]);
    target = new Float64Array([v[0] + (v[2] - w) / 2, v[1] + (v[3] - h) / 2, w, h]);
  }
  o.send_rect_bool(nsWindow, sel("setFrame:display:"), target, true);
  bringToFront(nsWindow);
  const primaryH = rect(o.send_u64(screens, sel("objectAtIndex:"), 0n))[3];
  pointerTo(target[0] + target[2] / 2, primaryH - (target[1] + target[3] / 2));
  return target === was ? "back where it was" : "back in the middle of the main screen";
}

let cgSymbols: ReturnType<typeof loadCg> | undefined;
function loadCg() {
  return Deno.dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGGetOnlineDisplayList: { parameters: ["u32", "buffer", "buffer"], result: "i32" },
    CGDisplayMirrorsDisplay: { parameters: ["u32"], result: "u32" },
    CGBeginDisplayConfiguration: { parameters: ["buffer"], result: "i32" },
    CGConfigureDisplayMirrorOfDisplay: { parameters: ["pointer", "u32", "u32"], result: "i32" },
    CGCompleteDisplayConfiguration: { parameters: ["pointer", "u32"], result: "i32" },
    CGWarpMouseCursorPosition: { parameters: [{ struct: ["f64", "f64"] }], result: "i32" },
    CGMainDisplayID: { parameters: [], result: "u32" },
    CGDisplayBounds: { parameters: ["u32"], result: { struct: ["f64", "f64", "f64", "f64"] } },
    CGConfigureDisplayOrigin: { parameters: ["pointer", "u32", "i32", "i32"], result: "i32" },
    CGAssociateMouseAndMouseCursorPosition: { parameters: ["u32"], result: "i32" },
  } as const).symbols;
}
// kCGConfigureForAppOnly: the change lasts while Albula runs, and macOS undoes it when Albula ends -- a quit or a crash
// included (the critic, 2026-10-13, finding 3: with kCGConfigureForSession a quit during the glasses view left the
// screens rearranged and un-mirrored until logout). Never written to the Mac's settings.
const CONFIGURE_FOR_APP = 0;

/** Every mirrored display made a screen of its own; returns the pairs to put back (display, the one it mirrored). */
export function stopMirroring(): { display: number; master: number }[] {
  if (Deno.build.os !== "darwin") return [];
  const cg = (cgSymbols ??= loadCg());
  const ids = new Uint32Array(16), count = new Uint32Array(1);
  if (cg.CGGetOnlineDisplayList(16, ids, count) !== 0) return [];
  const pairs: { display: number; master: number }[] = [];
  for (let i = 0; i < count[0]; i++) { const m = cg.CGDisplayMirrorsDisplay(ids[i]); if (m) pairs.push({ display: ids[i], master: m }); }
  if (pairs.length) reconfigure(pairs.map((p) => ({ display: p.display, master: 0 })));
  return pairs;
}
/** Puts back what stopMirroring undid. */
export function restoreMirroring(pairs: { display: number; master: number }[]): void {
  if (Deno.build.os === "darwin" && pairs.length) reconfigure(pairs);
}
function reconfigure(pairs: { display: number; master: number }[]): void {
  const cg = (cgSymbols ??= loadCg());
  const ref = new BigUint64Array(1);
  if (cg.CGBeginDisplayConfiguration(new Uint8Array(ref.buffer)) !== 0) return;
  const cfg = Deno.UnsafePointer.create(ref[0]);
  for (const p of pairs) cg.CGConfigureDisplayMirrorOfDisplay(cfg, p.display, p.master);
  cg.CGCompleteDisplayConfiguration(cfg, CONFIGURE_FOR_APP);
}

/** macOS's display number of the screen whose name contains `name` (NSScreen's NSScreenNumber), or 0. */
function displayIdByName(name: string): number {
  const o = objc();
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const n = Number(o.ask_u64(screens, sel("count")));
  const names = screensNow().map((x) => x.name.toLowerCase());
  for (let i = 0; i < n; i++) {
    if (!names[i]?.includes(name.toLowerCase())) continue;
    const sc = o.send_u64(screens, sel("objectAtIndex:"), BigInt(i));
    const desc = o.send(sc, sel("deviceDescription"));
    const num = desc ? o.send_p(desc, sel("objectForKey:"), nsstring("NSScreenNumber")) : null;
    return num ? Number(o.ask_u64(num, sel("unsignedIntValue"))) : 0;
  }
  return 0;
}

/** THE GLASSES TO THE RIGHT OF THE MAIN SCREEN (Ron, 2026-10-13: "Having the dock appear in the glasses is
 *  inconvenient. I would prefer that it remains on the xdr" -- "yes, have Albula move the glasses to the right"): with
 *  the Dock on the left, macOS keeps it on the leftmost screen, so the glasses go beside the main screen's right edge,
 *  tops aligned, for this session only. Returns where they were, for placeBack. */
export function screenToTheRight(name: string): { display: number; x: number; y: number } | null {
  if (Deno.build.os !== "darwin") return null;
  const cg = (cgSymbols ??= loadCg());
  const id = displayIdByName(name), main = cg.CGMainDisplayID();
  if (!id || id === main) return null;
  const b = (d: number) => new Float64Array((cg.CGDisplayBounds(d) as Uint8Array).slice().buffer);
  const was = b(id), m = b(main);
  const x = Math.round(m[0] + m[2]), y = Math.round(m[1]);
  if (was[0] === x && was[1] === y) return null;   // already there
  moveOrigin(id, x, y);
  return { display: id, x: was[0], y: was[1] };
}
/** Puts a screen moved by screenToTheRight back where it was (if it is still there). */
export function placeBack(p: { display: number; x: number; y: number } | null): void {
  if (Deno.build.os === "darwin" && p) moveOrigin(p.display, p.x, p.y);
}
function moveOrigin(display: number, x: number, y: number): void {
  const cg = (cgSymbols ??= loadCg());
  const ref = new BigUint64Array(1);
  if (cg.CGBeginDisplayConfiguration(new Uint8Array(ref.buffer)) !== 0) return;
  const cfg = Deno.UnsafePointer.create(ref[0]);
  cg.CGConfigureDisplayOrigin(cfg, display, x, y);
  cg.CGCompleteDisplayConfiguration(cfg, CONFIGURE_FOR_APP);
}

// ── ONE WINDOW ACROSS THE DESK'S SCREEN AND THE GLASSES (Ron, 2026-10-13: "Couldn't we just have a single layout with
// two additional 3d view which happen to be on the viture, instead of having two albulas who try to be synched?"; with
// macOS's "Displays have separate Spaces" turned off, a window may lie across two screens). The glasses are placed
// beside the main screen's right edge with their top at the window's content top; the window is widened over them; the
// page draws the two eye pictures in the part that lies on the glasses. Both put back by windowRestore and placeBack. ──

const cocoaRect = (obj: Deno.PointerValue, what = "frame") => new Float64Array((objc().ask_rect(obj, sel(what)) as Uint8Array).slice().buffer);
let spanGlasses: { display: number; x: number; y: number } | null = null;

/** Step 1: the glasses beside the main screen's right edge, top level with this window's content top (top-left,
 *  y-down display coordinates). The window grows downward first if it is shorter than the glasses. */
export function glassesBesideWindow(nsWindow: Deno.PointerValue, name: string): string {
  if (Deno.build.os !== "darwin" || !nsWindow) return "not here";
  const o = objc(), cg = (cgSymbols ??= loadCg());
  const gid = displayIdByName(name), main = cg.CGMainDisplayID();
  if (!gid || gid === main) return `no screen named ${name}`;
  const b = (d: number) => new Float64Array((cg.CGDisplayBounds(d) as Uint8Array).slice().buffer);
  const mb = b(main), gb = b(gid);
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const primaryH = cocoaRect(o.send_u64(screens, sel("objectAtIndex:"), 0n))[3];
  if (Number((BigInt(o.ask_u64(nsWindow, sel("styleMask"))) & FULL_SCREEN_MASK)) !== 0) o.send_p(nsWindow, sel("toggleFullScreen:"), null);
  headsetWindowWas = cocoaRect(nsWindow);
  let wf = cocoaRect(nsWindow);
  const title = wf[3] - contentHeight(nsWindow, wf);
  if (wf[3] - title < gb[3]) {   // taller, downward
    const h = gb[3] + title;
    wf = new Float64Array([wf[0], wf[1] - (h - wf[3]), wf[2], h]);
    o.send_rect_bool(nsWindow, sel("setFrame:display:"), wf, true);
  }
  const contentTop = primaryH - (wf[1] + wf[3]) + title;   // display coordinates, y down
  const was = gb;
  moveOrigin(gid, Math.round(mb[0] + mb[2]), Math.round(contentTop));
  spanGlasses = { display: gid, x: was[0], y: was[1] };
  return "beside";
}

/** Step 2 (after macOS has moved the screen): the window widened over the glasses; returns where the glasses lie in the
 *  page (CSS pixels = points, from the content's top left). */
export function windowAcrossGlasses(nsWindow: Deno.PointerValue, name: string): string {
  if (Deno.build.os !== "darwin" || !nsWindow) return JSON.stringify(null);
  const o = objc(), cg = (cgSymbols ??= loadCg());
  const gid = displayIdByName(name);
  if (!gid) return JSON.stringify(null);
  const gb = new Float64Array((cg.CGDisplayBounds(gid) as Uint8Array).slice().buffer);
  const wf = cocoaRect(nsWindow);
  const right = gb[0] + gb[2];
  const nf = new Float64Array([wf[0], wf[1], right - wf[0], wf[3]]);
  o.send_rect_bool(nsWindow, sel("setFrame:display:"), nf, true);
  bringToFront(nsWindow);
  const screens = o.send(cls("NSScreen"), sel("screens"));
  const primaryH = cocoaRect(o.send_u64(screens, sel("objectAtIndex:"), 0n))[3];
  const title = nf[3] - contentHeight(nsWindow, nf);
  const contentTop = primaryH - (nf[1] + nf[3]) + title;
  return JSON.stringify({ x: gb[0] - nf[0], y: gb[1] - contentTop, w: gb[2], h: gb[3] });
}

/** The window held in place, or free again (Ron, 2026-10-13: "When I moved albula the stereo display moved as well":
 *  across the glasses, a moved window carries the two pictures off them). */
export function windowMovable(nsWindow: Deno.PointerValue, on: boolean): boolean {
  if (Deno.build.os !== "darwin" || !nsWindow) return false;
  objc().send_bool(nsWindow, sel("setMovable:"), on);
  return true;
}

/** THE PAGE'S OWN MEMORY, as macOS counts it (the "footprint" WebKit kills a page by: at 16 GB on this Mac). Ron,
 *  2026-10-13: the glasses view grew the page from 9.6 to 24 GB in 30 seconds and the page was killed; nothing in the
 *  page can read this number, so the page asks here. The web view's page process id comes from WebKit
 *  (_webProcessIdentifier, found on the window's view or a view inside it); its footprint from /usr/bin/footprint.
 *  Megabytes, or -1 when it cannot be read. */
let pagePid = 0;
export function pageFootprintMB(nsWindow: Deno.PointerValue): number {
  if (Deno.build.os !== "darwin" || !nsWindow) return -1;
  if (!pagePid) {
    const o = objc(), probe = sel("_webProcessIdentifier"), responds = sel("respondsToSelector:");
    const find = (v: Deno.PointerValue, depth: number): number => {
      if (!v || depth > 6) return 0;
      if (o.ask_bool_p(v, responds, probe)) return Number(BigInt(o.ask_u64(v, probe)) & 0xffffffffn);
      const subs = o.send(v, sel("subviews")), n = Number(o.ask_u64(subs, sel("count")));
      for (let i = 0; i < n; i++) { const p = find(o.send_u64(subs, sel("objectAtIndex:"), BigInt(i)), depth + 1); if (p) return p; }
      return 0;
    };
    pagePid = find(o.send(nsWindow, sel("contentView")), 0);
    if (!pagePid) return -1;
  }
  try {
    const out = new TextDecoder().decode(new Deno.Command("/usr/bin/footprint", { args: ["-p", String(pagePid)], stdout: "piped", stderr: "null" }).outputSync().stdout);
    const m = out.match(/Footprint: ([\d.]+) (KB|MB|GB)/);
    if (!m) { pagePid = 0; return -1; }   // the page process was replaced (a reload): found again next time
    return Math.round(Number(m[1]) * (m[2] === "GB" ? 1024 : m[2] === "KB" ? 1 / 1024 : 1));
  } catch { return -1; }
}

/** A glasses session left behind by a page that went away without ending it (a reload or a page crash; the critic,
 *  2026-10-13, finding 3): the window free to move again, the glasses back, the window at its own size. What was undone,
 *  or "" when nothing was left. */
export function glassesLeftover(nsWindow: Deno.PointerValue): string {
  if (!spanGlasses) return "";
  windowMovable(nsWindow, true);
  glassesBack();
  windowRestore(nsWindow);
  headsetWindowWas = null;
  return "the window and the glasses put back after a glasses view that was not ended";
}

/** The glasses back where they were before glassesBesideWindow. */
export function glassesBack(): void { if (spanGlasses) { placeBack(spanGlasses); spanGlasses = null; } }

/** The content area's height for a frame (the frame minus the title bar). */
function contentHeight(nsWindow: Deno.PointerValue, frame: Float64Array): number {
  const r = objc().ask_rect_rect(nsWindow, sel("contentRectForFrameRect:"), frame) as Uint8Array;
  return new Float64Array(r.slice().buffer)[3];
}
