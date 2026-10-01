import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { lineAxes, lineOrientation, linePlane, lineRange, parseLineOrientation } from "./line-axes.ts";

const close = (a: number[], b: number[], what: string) => a.forEach((x, i) => assertAlmostEquals(x, b[i], 1e-9, `${what}[${i}]`));

Deno.test("a head-to-foot line gives the body's own planes, with Slicer's matrices", () => {
  const ax = lineAxes([10, 20, -50], [10, 20, 50])!;
  // across = axial: u R, v A, n S
  close(ax.across.u, [1, 0, 0], "across.u"); close(ax.across.v, [0, 1, 0], "across.v"); close(ax.across.n, [0, 0, 1], "across.n");
  // along-1 = sagittal: u A, v S, n R
  close(ax.along1.u, [0, 1, 0], "along1.u"); close(ax.along1.v, [0, 0, 1], "along1.v"); close(ax.along1.n, [1, 0, 0], "along1.n");
  // along-2 = coronal: u R, v S, n A
  close(ax.along2.u, [1, 0, 0], "along2.u"); close(ax.along2.v, [0, 0, 1], "along2.v"); close(ax.along2.n, [0, 1, 0], "along2.n");
  close(ax.mid, [10, 20, 0], "mid");
  assertAlmostEquals(ax.length, 100, 1e-9);
});

Deno.test("the points' order does not matter: up is always the head end", () => {
  const a = lineAxes([0, 0, 0], [0, 10, 40])!, b = lineAxes([0, 10, 40], [0, 0, 0])!;
  close(a.dir, b.dir, "dir");
  assert(a.dir[2] > 0);
});

Deno.test("an oblique line: every plane is orthonormal, across is perpendicular to it, both along planes contain it", () => {
  const p0: [number, number, number] = [-12, 30, -80], p1: [number, number, number] = [5, 44, -20];
  const ax = lineAxes(p0, p1)!;
  const d = ax.dir;
  for (const v of ["across", "along-1", "along-2"] as const) {
    const p = linePlane(ax, v);
    for (const w of [p.u, p.v, p.n]) assertAlmostEquals(Math.hypot(...w), 1, 1e-9);
    assertAlmostEquals(p.u[0] * p.v[0] + p.u[1] * p.v[1] + p.u[2] * p.v[2], 0, 1e-9);
    assertAlmostEquals(p.u[0] * p.n[0] + p.u[1] * p.n[1] + p.u[2] * p.n[2], 0, 1e-9);
    const dn = Math.abs(d[0] * p.n[0] + d[1] * p.n[1] + d[2] * p.n[2]);
    if (v === "across") assertAlmostEquals(dn, 1, 1e-9); else assertAlmostEquals(dn, 0, 1e-9);
  }
  // the two along planes are at 90 degrees
  assertAlmostEquals(Math.abs(ax.along1.n[0] * ax.along2.n[0] + ax.along1.n[1] * ax.along2.n[1] + ax.along1.n[2] * ax.along2.n[2]), 0, 1e-9);
  // along-2 faces front-to-back as closely as the line allows
  assert(Math.abs(ax.along2.n[1]) > 0.9);
});

Deno.test("a line running front-to-back still gives three planes", () => {
  const ax = lineAxes([0, -30, 0], [0, 30, 0])!;
  for (const v of ["across", "along-1", "along-2"] as const) assert(Number.isFinite(linePlane(ax, v).n[0]));
  assertEquals(lineAxes([1, 2, 3], [1, 2, 3]), null);
});

Deno.test("the across slider runs the line, with room at both ends", () => {
  const ax = lineAxes([0, 0, 0], [0, 0, 100])!;
  const r = lineRange(ax, "across");
  assert(r.min < 0 && r.max > 100);
  assertEquals(parseLineOrientation(lineOrientation("local-markup-3", "along-2")), { markupId: "local-markup-3", view: "along-2" });
  assertEquals(parseLineOrientation("axial"), null);
});
