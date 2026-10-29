// The scene's DICOM object written the way the app's SERVER writes it: in a worker that has not been handed the DICOM
// library by a test (desktop/scene-mrcom.test.ts hands it over through the CT maker; the app's server does not). The
// first conversion (2026-10-29) wrote 26 objects and indexed none because of that difference.
//
//   deno test -A --no-check desktop/scene-mrcom-server.test.ts
import { assertEquals } from "jsr:@std/assert";

Deno.test("in a fresh worker, importing the scene's DICOM module makes the DICOM library available", async () => {
  const src = `
    const { dicomIO } = await import(${JSON.stringify(new URL("../logic/dicom-io.ts", import.meta.url).href)});
    let before = "ok"; try { await dicomIO(); } catch (e) { before = String(e.message); }
    await import(${JSON.stringify(new URL("./scene-mrcom.ts", import.meta.url).href)});
    let after = "ok"; try { await dicomIO(); } catch (e) { after = String(e.message); }
    self.postMessage({ before, after });`;
  const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
  const w = new Worker(url, { type: "module" });
  const got = await new Promise<{ before: string; after: string }>((res, rej) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => { e.preventDefault(); rej(new Error(e.message)); }; });
  w.terminate();
  assertEquals(got.after, "ok", `after the import: ${got.after}`);
  assertEquals(got.before.includes("setDicomLibrary"), true, "the fresh worker really had no library before (the test tests something)");
});
