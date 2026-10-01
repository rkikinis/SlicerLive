// T3 (#3): the Data module shows a Subject Hierarchy of ALL data nodes (any type) with operations, and
// Sample Data is its own module (not mixed into Data). Standalone. Needs static server + Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CDP } from "./cdp.ts";
import { waitReady } from "./ready.ts";

const BASE = Deno.env.get("SL_PAGE_BASE") ?? "http://localhost:8130/";
let chrome = false;
try { await CDP.targets(); chrome = true; } catch { /* no browser */ }
const STANDALONE = `${BASE}slicer-app.html?ws=ws://127.0.0.1:1/&gui=ws://127.0.0.1:1/&http=http://127.0.0.1:1/mrson/`;

const shRows = `[...document.querySelectorAll('.sl-sh-row')].map(r => ({ id: r.dataset.id, name: r.querySelector('.sl-sh-name').textContent }))`;

Deno.test({ name: "data: Subject Hierarchy lists all node types + operations; Sample Data is separate", ignore: !chrome, sanitizeResources: false, sanitizeOps: false, async fn() {
  const cdp = await CDP.openTab(STANDALONE);
  try {
    await waitReady(cdp, 60000);
    // Asked of the shell rather than the DOM: this read `.sl-module-select option` and the native
    // <select> it named has been a searchable picker for some time, so it was quietly matching
    // nothing and asserting over an empty list.
    const modules = await cdp.evalJson<string[]>(`window.__shell.panels().map(p => p.id)`);
    assert(modules.includes("data") && modules.includes("sampledata"), `both modules present (${modules})`);

    // ADD DATA AND DATA ARE SEPARATE MODULES: how data gets in, versus what is here now.
    assert(modules.includes("add-data"), `Add Data registered (${modules})`);
    await cdp.eval<void>(`await window.__shell.showPanel("add-data");`);
    assert(
      await cdp.evalJson<number>(`document.querySelectorAll('[data-act="dicom-db"], [data-act="open"]').length`) > 0,
      "Add Data holds the load routes",
    );
    assert(
      await cdp.evalJson<number>(`document.querySelectorAll('.sl-dropzone').length`) > 0,
      "and the drop target is visible, not a footnote",
    );
    await cdp.eval<void>(`await window.__shell.showPanel("sampledata");`);
    assert(await cdp.evalJson<number>(`document.querySelectorAll('.sl-samples .sl-row button').length`) > 0, "Sample Data panel has sample buttons");

    // load a volume + create a segmentation + place a markup -> all appear in the hierarchy
    const img = await cdp.eval<string>(`await window.__loadSample("MRHead"); return window.__volumeList()[0].imageId;`);
    await cdp.eval<void>(`await window.__createSegmentation(${JSON.stringify(img)});`);
    const red = await cdp.evalJson<{ x: number; y: number; w: number; h: number }>(`(() => { const c = document.querySelector('.lv-cell[data-cell="Red"]'); const r = c.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
    await cdp.eval<void>(`window.__startPlace("fiducial", false);`);
    await cdp.mouse("mousePressed", red.x + red.w * 0.5, red.y + red.h * 0.5, { button: "left", buttons: 1 });
    await cdp.mouse("mouseReleased", red.x + red.w * 0.5, red.y + red.h * 0.5, { button: "left", buttons: 0 });
    await cdp.eval<void>(`await window.__slicerlive.idle(); await window.__shell.showPanel("data");`);

    // ...and Data holds none of them: it answers "what is here", nothing about how it arrived.
    assertEquals(
      await cdp.evalJson<number>(`document.querySelectorAll('[data-act="dicom-db"], [data-act="open"], .sl-dropzone').length`),
      0,
      "Data no longer carries the load routes",
    );

    const rows = await cdp.evalJson<{ id: string; name: string }[]>(shRows);
    const ids = rows.map((r) => r.id);
    assert(ids.some((i) => i.startsWith("local-image")), "image in hierarchy");
    assert(ids.some((i) => i.startsWith("local-segmentation")), "segmentation in hierarchy");
    assert(ids.some((i) => i.startsWith("local-markup")), "markup in hierarchy");

    // delete the markup via the hierarchy -> it disappears
    const mk = ids.find((i) => i.startsWith("local-markup"))!;
    await cdp.eval<void>(`document.querySelector('.sl-sh-row[data-id="${mk}"] [data-del]').click(); await window.__slicerlive.idle();`);
    assert(!(await cdp.evalJson<{ id: string }[]>(shRows)).some((r) => r.id === mk), "markup deleted from hierarchy");

    // toggle image visibility via the hierarchy -> node.visible flips AND the volume leaves the slice layers
    assert(await cdp.evalJson<boolean>(`window.__layers().Red.bg`), "volume shown as slice background");
    await cdp.eval<void>(`document.querySelector('.sl-sh-row[data-id="${img}"] [data-vis]').click(); await window.__slicerlive.idle();`);
    assertEquals(await cdp.evalJson<boolean>(`window.__live.nodes.get(${JSON.stringify(img)}).visible !== false`), false, "node.visible false");
    assertEquals(await cdp.evalJson<boolean>(`window.__layers().Red.bg`), false, "hidden volume removed from the slice (like Slicer)");
    // toggle back -> reappears
    await cdp.eval<void>(`document.querySelector('.sl-sh-row[data-id="${img}"] [data-vis]').click(); await window.__slicerlive.idle();`);
    assert(await cdp.evalJson<boolean>(`window.__layers().Red.bg`), "volume restored to the slice");
  } finally { await cdp.closeTab(); }
} });
