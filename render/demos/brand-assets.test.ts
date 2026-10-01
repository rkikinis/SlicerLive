// The brand assets, and the two ways they go wrong silently.
//
// The logo exists in three cuts -- albula-logo.svg (the lockup, as Ron delivered it),
// albula-emblem.svg (the mountain alone, for 18px) and albula-app-icon.svg (the lockup on a
// square plate, rendered to albula-app-icon.png for the favicon and the .icns). Two of them are
// INLINED into theme.css as base64 data URIs, which is the right call -- a data URI cannot 404 and
// needs no entry in the rebuild script's copy list -- and it has one failure mode: edit the .svg,
// forget the .css, and the app keeps serving the old artwork with nothing on screen to say so. That
// is the same class of staleness that cost this project three debugging rounds on the bundle, so it
// is checked rather than remembered.
//
// The third is a real file the page fetches by name, so its failure mode is the other one: it has
// to be in the rebuild script's copy list or the served gallery keeps yesterday's icon.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const here = dirname(fromFileUrl(import.meta.url));
const read = (f: string) => Deno.readTextFileSync(join(here, f));

function inlined(css: string, cls: string): Uint8Array {
  const rule = css.slice(css.indexOf(`.${cls} {`));
  const m = rule.match(/url\("data:image\/svg\+xml;base64,([^"]+)"\)/);
  assert(m, `.${cls} has no base64 svg data URI`);
  return decodeBase64(m![1]);
}

Deno.test("every derived SVG says in itself that it is derived", () => {
  // Steve's convention, adopted: viewer/sllogo.js opens with "AUTO-GENERATED (do not hand-edit; see
  // tools/genlogo.py)". The warning belongs in the file, where the person about to edit it is
  // looking, not only in a README they have no reason to open.
  for (const f of ["albula-logo.svg", "albula-emblem.svg", "albula-app-icon.svg"]) {
    assert(
      read(f).startsWith("<!-- AUTO-GENERATED (do not hand-edit; see brand/regenerate.py)"),
      `${f} lost its generated-file banner`,
    );
  }
});

Deno.test("the inlined logos are the SVGs on disk, not an older cut of them", () => {
  const css = read("theme.css");
  for (const [cls, file] of [
    ["sl-brand-mark", "albula-emblem.svg"],     // title bar, 18px: mountain only
    ["sl-welcome-logo", "albula-logo.svg"],     // Welcome panel: the full lockup
  ]) {
    assertEquals(
      new TextDecoder().decode(inlined(css, cls)),
      read(file),
      `.${cls} in theme.css is stale — regenerate its data URI from ${file}`,
    );
  }
});

Deno.test("every asset the page fetches by name is in the rebuild script's copy list", () => {
  const html = read("slicer-app.html");
  const manifest = read("manifest.webmanifest");
  const copyList = Deno.readTextFileSync(
    join(here, "..", "..", "..", "..", "tools", "Rebuild SlicerAlbula App.command"),
  );

  const named = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="([\w.-]+\.(?:png|webmanifest|svg))"/g)) named.add(m[1]);
  for (const m of manifest.matchAll(/"src":\s*"([\w.-]+)"/g)) named.add(m[1]);
  assert(named.has("albula-app-icon.png"), "the favicon reference went missing");

  for (const f of named) {
    assert(Deno.statSync(join(here, f)).isFile, `${f} is referenced but not in render/demos/`);
    assert(copyList.includes(f), `${f} is served by name but the rebuild script never copies it`);
  }
});

Deno.test("the .app icon is built from the Albula logo, not SlicerLive's", () => {
  // Steve's mark is still in the repo and still correct for HIS packaging (make-win.ts builds
  // SlicerLive.ico from it). It is only wrong as the icon of an app called SlicerAlbula.
  const makeApp = Deno.readTextFileSync(join(here, "..", "..", "desktop", "make-app.ts"));
  assert(
    /const logo = join\(repo, "docs", "albula-logo\.png"\)/.test(makeApp),
    "make-app.ts no longer builds the .icns from docs/albula-logo.png",
  );
  assert(
    Deno.statSync(join(here, "..", "..", "docs", "albula-logo.png")).size > 10_000,
    "docs/albula-logo.png is missing or is not a real raster",
  );
});
