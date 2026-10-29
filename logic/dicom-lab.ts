// DICOM CIELab COLORS (RecommendedDisplayCIELabValue), READ: ONE NUMBERED VERSION PER CONVENTION (Ron, 2026-09-25: "as
// modular as possible and also versioned").
//
// Version 1, D65: CIELab relative to the sRGB white point, with no chromatic adaptation -- what dcmjs 0.41 did (a port of
// DCMTK's old IODCIELabUtil), and what Albula's writer has always written (logic/export-dicom-seg.ts rgbToDicomLab). This
// is a port of dcmjs 0.41.0's dicomlab2RGB, so colors read exactly as they did before 2026-10-28.
//
// WHY IT IS OURS: dcmjs moved to D50 (#598, Andrey Fedorov, merged 2026-10-13: DICOM's Lab is the ICC Profile Connection
// Space, PS3.3 C.10.7.1.1, whose white is D50; DCMTK, dcmqi, highdicom and PixelMed are moving the same way), and Steve
// Pieper's build, which Albula uses since 2026-10-28, has it. Reading with that while writing D65 made a tract color written
// as [0.9, 0.2, 0.1] read back as [0.883, 0.197, 0.108]. Moving Albula to D50 -- writer and reader together, as version 2
// -- is a decision for Ron and Michael Halle (the DICOM CIELab convention is inside the semantics line, CLAUDE.md); until
// then nothing changes.
export const DICOM_LAB_VERSION = 1;

const gamma = (n: number) => (n <= 0.0031306684425005883 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055);
const labfInv = (n: number) => (n >= 0.206896551724137931 ? n * n * n : (108.0 / 841.0) * (n - 4.0 / 29.0));
const D65 = [0.950456, 1.0, 1.088754];

/** DICOM's 16-bit Lab ([0, 65535] each) to sRGB in [0, 1]: version 1 (D65), dcmjs 0.41.0's arithmetic. */
export function dicomLabToRgb(dicomlab: readonly number[]): number[] {
  const L = (dicomlab[0] * 100.0) / 65535.0, a = (dicomlab[1] * 255.0) / 65535.0 - 128, b = (dicomlab[2] * 255.0) / 65535.0 - 128;
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = D65[0] * labfInv(fx), Y = D65[1] * labfInv(fy), Z = D65[2] * labfInv(fz);
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, bl = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  // Force nonnegative values so that gamma correction is well-defined (0.41 shifted all three channels).
  const m = Math.min(r, g, bl);
  if (m < 0) { r -= m; g -= m; bl -= m; }
  return [gamma(r), gamma(g), gamma(bl)];
}
