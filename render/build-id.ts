// WHICH BUILD IS ACTUALLY RUNNING, and how to make a worker come from it.
//
// Its own module, with no DOM in it, because the workers that need `workerUrl` are reached from
// modules that are typechecked without the DOM lib. Putting it in app-shell dragged HTMLElement and
// friends into livescene and ingest.

declare const __BUILD_ID__: string | undefined;

/** Compiled into the bundle by the rebuild script; "dev (unbundled)" when running from source. */
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev (unbundled)";

/**
 * A worker URL carrying the build id, so a rebuilt worker is actually fetched.
 *
 * The rebuild script already appends ?v=<build> to slicer-app.js in the HTML, and its own comment
 * says why: "a reload came up on the previous build and only the on-screen stamp caught it." But the
 * workers were loaded from JS with a bare relative URL and carried no version, so the page could be
 * new while a worker was served from cache -- and since the on-screen stamp comes from the page, it
 * reported the new build either way.
 *
 * That is what it looks like when a change to a worker appears to do nothing at all. Ron, on a
 * rebuild that doubled the geometry smoothing and quadrupled the normal smoothing: "19:23 version.
 * Nothing changes in a noticable way, once the algorithm runs" -- same look, same 118s, from a worker
 * file that had both changes sitting in it on disk.
 */
export function workerUrl(relative: string, base: string = location.href): URL {
  const u = new URL(relative, base);
  u.searchParams.set("v", BUILD_ID);
  return u;
}
