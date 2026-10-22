// LENGTHS AS A PERSON READS THEM: a length or a position in the scene's mm as text, and a view's ruler, at any scale
// from an electron microscope's nm to an astronomer's kpc. DISPLAY ONLY, so its own module: render/scene-scale.ts (the
// voxel sizes the algorithms use) is imported by the DICOM reader, and a change there retires every duckn copy
// (desktop/make-copy-code.ts); a ruler's label must not (critic 2026-10-20, finding 4).
//   deno test -A --no-check render/scene-scale.test.ts

// ── LENGTHS AS A PERSON READS THEM. The scene is in mm; a readout says nm, µm, mm, m, km, au, pc or kpc, whichever
//    reads as a plain number. Clinical lengths (0.1 mm to 10 m) read in mm exactly as they did, with the digits the
//    caller asks for; outside that range three significant digits in the unit that fits ("0.0 mm" for a microscope's
//    250 nm was the fault, and again for its 1-10 µm: critic 2026-10-20, finding 4). ──
const PC = 3.0856775814913673e19, AU = 1.495978707e14;
const LENGTH_UNITS: [string, number][] = [["kpc", 1e3 * PC], ["pc", PC], ["au", AU], ["km", 1e6], ["m", 1e3], ["mm", 1], ["µm", 1e-3], ["nm", 1e-6]];
/** A whole number past four digits with its thousands marked ("100,000,000 km"), so it reads as a length. */
const grouped = (n: number): string => Math.abs(n) >= 1e4 && Number.isInteger(n) ? n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",") : String(n);

/**
 * A length or a position in the scene's mm, as text with its unit. THE UNIT COMES FROM THE DATA'S SCALE when `voxel` is
 * given (a position near zero on a CT is not a small length: "R: -53.5 µm" for a sagittal slice through the middle was
 * the fault), else from the number itself. With a voxel it is the largest unit in which ONE VOXEL reads at least 0.1:
 * mm with the caller's digits for every grid from 0.1 mm to 100 mm (the clinical ones read exactly as they did), µm
 * from 0.1 µm (a 1 µm grid: "≈ 14 µm on this 1 µm grid", where it said "≈ 0.0 mm on this 0.00 mm grid"), nm below.
 * A length a million times past that unit steps up ("1000000000 nm" for a meter in a 1 nm scene was a row of digits).
 */
export function lengthText(mm: number, digits = 1, voxel?: number): string {
  if (!Number.isFinite(mm)) return `${mm} mm`;
  const byVoxel = voxel !== undefined && voxel > 0 && Number.isFinite(voxel);
  const a = Math.abs(mm);
  if (byVoxel ? voxel >= 0.1 && voxel < 100 : a === 0 || (a >= 0.1 && a < 1e4)) return `${mm.toFixed(digits)} mm`;
  const fits = (i: number) => (i < 0 ? LENGTH_UNITS.length - 1 : i);
  const own = fits(LENGTH_UNITS.findIndex(([, size]) => a >= size));   // the unit the number itself reads in
  let u = byVoxel ? fits(LENGTH_UNITS.findIndex(([, size]) => voxel >= 0.1 * size)) : own;
  while (u > own && a / LENGTH_UNITS[u][1] >= 1e6) u--;
  const [name, size] = LENGTH_UNITS[u];
  if (mm === 0) return `0 ${name}`;
  const v = mm / size;
  return `${Math.abs(v) >= 100 ? grouped(Number(v.toFixed(0))) : v.toPrecision(3).replace(/\.?0+$/, "")} ${name}`;
}

/** The 1-2-5 length (any power of ten) closest to `want`. */
const oneTwoFive = (want: number): number => {
  const p = Math.pow(10, Math.floor(Math.log10(want)));
  let best = p;
  for (const m of [1, 2, 5, 10]) if (Math.abs(m * p - want) < Math.abs(best - want)) best = m * p;
  return best;
};

/**
 * A ruler for a view: the 1-2-5 length (any power of ten) whose bar comes closest to `targetPx` at `mmPerPx`, and its
 * label. On clinical views the same lengths as before (1 mm to 200 mm; 1 cm up to a meter in cm). A meter and more in
 * m, km, then au, pc and kpc, where the 1-2-5 is counted in THAT unit -- a parsec bar is 1, 2 or 5 pc, not the
 * "32.4 pc" a power of ten of millimeters gives, and 5 m reads "5 m", not "500 cm" (critic 2026-10-20, section 11).
 */
export function rulerLength(mmPerPx: number, targetPx: number): { mm: number; text: string } {
  const want = mmPerPx * targetPx;
  if (!(want > 0) || !Number.isFinite(want)) return { mm: 1, text: "1 mm" };
  const astro = LENGTH_UNITS.slice(0, 3).find(([, size]) => want >= size);   // kpc, pc, au
  if (astro) { const n = oneTwoFive(want / astro[1]); return { mm: n * astro[1], text: `${grouped(n)} ${astro[0]}` }; }
  const best = oneTwoFive(want);
  const text = best >= 1e6 ? `${grouped(best / 1e6)} km` : best >= 1e3 ? `${best / 1e3} m` : best >= 10 ? `${+(best / 10).toPrecision(3)} cm` : lengthText(best, best >= 1 ? 0 : 1);
  return { mm: best, text };
}
