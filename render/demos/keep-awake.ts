// KEEP A HIDDEN PAGE OUT OF WEBKIT'S LOW MEMORY LIMIT.
//
// WebKit marks a web process Inactive after eight minutes with no visible page, and from then on
// kills it past 3 GB + 1 GB per page instead of 15 GB + 1 GB (WTF/wtf/MemoryPressureHandler.cpp,
// WebCore/page/PerformanceMonitor.cpp). A study is 4-12 GB. The desktop app turns window-occlusion
// detection off so a window on another Space or behind another stays "visible" (desktop/macmenu.ts),
// but a MINIMIZED window or a hidden application fails an earlier test -- the window's own
// isVisible -- and the page goes hidden regardless (critic, 2026-09-17).
//
// The rule has one exception written into PerformanceMonitor::updateProcessStateForMemoryPressure:
// a process with an AUDIBLE page never goes Inactive. So while the page is hidden it plays one
// second of digital silence on a loop -- an <audio> element with an audio track, unmuted, volume
// above zero, samples all zero. Nothing is heard; WebKit's "is playing audio" is true. (WebAudio
// would not do: its destination detects silence and reports itself not playing.) Stopped the
// moment the page is visible again.
//
// MEASURED 2026-09-17, two harness windows minimized holding 5 GB each: without the sound the
// page reported every 30 s until 4 min 04 s after minimizing and never again (killed -- sooner
// than the eight minutes in WebKit's main; what ships in macOS 27 waits less); with the sound
// the same page reported for eleven minutes and ended on its own timer. Then the real page in a
// WKWebView, minimized and restored: "keeping awake while hidden: silence playing" / "visible
// again: silence stopped" in the session log. WORKING-STATE.md, 2026-09-17.
//
// Playback needs no click here because the user has interacted with the page long before hiding
// it; if a WebKit ever refuses, the promise rejects and the status line says so once.

/** One second of 16-bit mono silence at 8 kHz, as a WAV blob. */
function silentWav(): Blob {
  const n = 16000, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, n, true);
  return new Blob([b], { type: "audio/wav" });
}

// Deno's DOM lib has no Audio/HTMLAudioElement; the four members used are named here.
interface SilentPlayer { src: string; loop: boolean; volume: number; play(): Promise<void>; pause(): void }

export function keepPageAwakeWhileHidden(onRefused?: (why: string) => void): void {
  if (typeof document === "undefined") return;
  let audio: SilentPlayer | null = null;
  let refusedOnce = false;
  const start = () => {
    if (!audio) {
      audio = document.createElement("audio") as unknown as SilentPlayer;
      audio.src = URL.createObjectURL(silentWav()); audio.loop = true; audio.volume = 0.01;
    }
    audio.play().then(() => note("keeping awake while hidden: silence playing")).catch((e: unknown) => {
      if (refusedOnce) return;
      refusedOnce = true;
      onRefused?.(`the page could not keep itself awake while hidden (${(e as Error).message ?? e}); a window left minimized for more than eight minutes with a large study may be reset`);
    });
  };
  const stop = () => { if (audio) { audio.pause(); note("visible again: silence stopped"); } };
  // One line each way in the session log, so "was it awake?" has an answer after a lost study.
  const note = (line: string) => { fetch("/_log", { method: "POST", body: line }).catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) start(); else stop(); });
  if (document.hidden) start();
}
