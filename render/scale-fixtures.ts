// THE THREE SCALES every scale test runs at (render/scene-scale.ts; Ron, 2026-10-20: "from astrophysics to electron
// microscope"): an electron microscope's 1 nm voxels, a clinical 0.7 mm CT, an astronomer's 1 parsec. A file of its own,
// so a test that imports them does not run another file's tests again.
export const SCALES = [["1 nm", 1e-6], ["0.7 mm", 0.7], ["1 parsec", 3.086e19]] as const;
