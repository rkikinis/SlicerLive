// A synthetic heart: a left ventricle as a capsule along an oblique axis, an atrium at its base, a
// right ventricle beside it. The axes recovered must agree with the ones it was built from, and the
// display conventions must hold (RV on the left, anterior up).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cardiacAxes, cardiacPlane, findCardiacLabels, planeToSliceToRAS } from "./cardiac-axes.ts";

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function synthetic() {
  const n = 64, dims: [number, number, number] = [n, n, n];
  const ijkToRAS = [1, 0, 0, -32, 0, 1, 0, -32, 0, 0, 1, -32, 0, 0, 0, 1];   // 1 mm, centered
  const lab = new Uint8Array(n * n * n);
  // long axis: from the mitral center at (10, 6, 10) toward the apex at (-14, -10, -14)
  const mitral = [10, 6, 10], apex = [-14, -10, -14];
  const L = [apex[0] - mitral[0], apex[1] - mitral[1], apex[2] - mitral[2]]; const Ll = Math.hypot(...L); const l = L.map((x) => x / Ll);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = [i - 32, j - 32, k - 32];
    const d = [p[0] - mitral[0], p[1] - mitral[1], p[2] - mitral[2]];
    const t = dot(d, l);                                // along the axis, mm from the valve
    const r = Math.hypot(...d.map((x, q) => x - t * l[q]));
    const v = 4 * n * n;
    if (t >= 0 && t <= Ll) {
      if (r < 6) lab[k * n * n + j * n + i] = 3;         // LV cavity
      else if (r < 9) lab[k * n * n + j * n + i] = 1;    // myocardium
    }
    if (t < 0 && t > -8 && r < 6) lab[k * n * n + j * n + i] = 2;   // left atrium, on the base side
    // right ventricle: a parallel tube offset toward -R (patient's right), anterior half only
    const off = [p[0] + 14, p[1], p[2]];
    const d2 = [off[0] - mitral[0], off[1] - mitral[1], off[2] - mitral[2]];
    const t2 = dot(d2, l); const r2 = Math.hypot(...d2.map((x, q) => x - t2 * l[q]));
    if (t2 >= 2 && t2 <= Ll - 4 && r2 < 5 && !lab[k * n * n + j * n + i]) lab[k * n * n + j * n + i] = 5;
    void v;
  }
  return { lab, dims, ijkToRAS, mitral, apex, l };
}

Deno.test("cardiacAxes: recovers the long axis, the valve and the apex of a synthetic ventricle", () => {
  const s = synthetic();
  const L = findCardiacLabels([{ labelValue: 1, name: "Myocardium" }, { labelValue: 2, name: "Left atrium" }, { labelValue: 3, name: "Left ventricle of heart" }, { labelValue: 5, name: "Right ventricle of heart" }])!;
  assertEquals(L, { lv: 3, la: 2, rv: 5, myocardium: 1 });
  const a = cardiacAxes(s.lab, s.dims, s.ijkToRAS, L)!;
  assert(a, "axes found");
  assert(dot(a.longAxis, s.l) > 0.98, `long axis ${a.longAxis} vs ${s.l}`);
  for (let q = 0; q < 3; q++) assert(Math.abs(a.mitral[q] - s.mitral[q]) < 2.5, `mitral ${a.mitral} vs ${s.mitral}`);
  for (let q = 0; q < 3; q++) assert(Math.abs(a.apex[q] - s.apex[q]) < 4, `apex ${a.apex} vs ${s.apex}`);
  // short axis: the normal is the long axis (either way), screen-right runs from RV to LV, anterior is up
  const sa = a.shortAxis;
  assert(Math.abs(dot(sa.n, s.l)) > 0.98);
  assert(dot(sa.u, [1, 0, 0]) > 0.5, "RV (at -R) on the left means screen-right points +R");
  assert(dot(sa.v, [0, 1, 0]) > 0, "anterior up");
  // the slice views' handedness: u x v = -n
  const cx = [sa.u[1] * sa.v[2] - sa.u[2] * sa.v[1], sa.u[2] * sa.v[0] - sa.u[0] * sa.v[2], sa.u[0] * sa.v[1] - sa.u[1] * sa.v[0]];
  assert(dot(cx, sa.n) < -0.99, "u x v = -n");
  // four-chamber contains the long axis and the RV center; two-chamber is perpendicular to it
  assert(Math.abs(dot(a.fourChamber.n, a.longAxis)) < 1e-6);
  const toRv = [a.rvCenter[0] - a.mitral[0], a.rvCenter[1] - a.mitral[1], a.rvCenter[2] - a.mitral[2]];
  assert(Math.abs(dot(a.fourChamber.n, toRv)) / Math.hypot(...toRv) < 0.05, "RV lies in the four-chamber plane");
  // perpendicular planes have perpendicular normals; the two-chamber normal is the RV-to-LV direction
  assert(Math.abs(dot(a.twoChamber.n, a.fourChamber.n)) < 1e-3, "two-chamber is perpendicular to four-chamber");
  assert(Math.abs(dot(a.twoChamber.n, a.fourChamber.v)) > 0.99, "the two-chamber's normal is the four-chamber's screen-up");
  assert(dot(a.twoChamber.v, [0, 1, 0]) > 0, "two-chamber: anterior up");
  assert(dot(a.twoChamber.u, a.longAxis) < -0.99, "two-chamber: apex on the left");
  assert(dot(a.fourChamber.u, a.longAxis) < -0.99, "four-chamber: apex on the left, like the two-chamber");
  assert(dot(a.fourChamber.v, toRv) > 0, "four-chamber: right ventricle at the top");
  assert(Math.abs(dot(a.twoChamber.n, a.longAxis)) < 1e-6);
  // levels sit at 1/6, 1/2, 5/6 of the way from valve to apex
  const t = (p: number[]) => dot([p[0] - a.mitral[0], p[1] - a.mitral[1], p[2] - a.mitral[2]], a.longAxis) / a.length;
  assert(Math.abs(t(a.levels.basal) - 1 / 6) < 1e-6 && Math.abs(t(a.levels.mid) - 0.5) < 1e-6 && Math.abs(t(a.levels.apical) - 5 / 6) < 1e-6);
  // reach: along the long axis the heart extends about half its length either side of the mid
  // plane (a little more toward the base, where the atrium sits); across it, the ventricle's radius.
  assert(a.reach.shortAxis > a.length * 0.45 && a.reach.shortAxis < a.length * 1.2, `short-axis reach ${a.reach.shortAxis} vs length ${a.length}`);
  assert(a.reach.fourChamber > 5 && a.reach.fourChamber < a.length, `four-chamber reach ${a.reach.fourChamber}`);
  assert(a.reach.twoChamber > 5 && a.reach.twoChamber < a.length, `two-chamber reach ${a.reach.twoChamber}`);
  const m = planeToSliceToRAS(cardiacPlane(a, "short-axis"));
  assertEquals(m.length, 16);
  assertEquals([m[2], m[6], m[10]], sa.n);
});

Deno.test("cardiacAxes: nothing without an atrium to place the valve", () => {
  const s = synthetic();
  assertEquals(cardiacAxes(s.lab, s.dims, s.ijkToRAS, { lv: 3, la: 9, rv: 5 }), null);
  assertEquals(findCardiacLabels([{ labelValue: 1, name: "liver" }]), null);
});
