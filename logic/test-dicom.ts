// Synthesise a CT series in memory, so the DICOM writer can be tested without a browser or a
// database.
//
// The SEG writer needs REAL source instances -- it references them by SOP Instance UID and takes the
// frame geometry from them -- so testing it needs a series, and until now that meant loading one
// from Ron's database through the app by hand. That is why every test of the export was a toy, and
// why an overflow that corrupts any export past ~8,000 frames got as far as real data. A series built
// here is exact, instant, and can be any shape the test wants, including the shapes that break.
//
// Test-only, but it lives beside the code rather than in a test file because more than one test
// needs it.
import { dicomIO } from "./dicom-io.ts";

export interface SyntheticSeries {
  /** The instances, as a reader or the SEG writer would receive them. */
  instances: ArrayBuffer[];
  dims: [number, number, number];
  ijkToRAS: number[];
  studyInstanceUID: string;
  seriesInstanceUID: string;
}

const CT_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.2";
const EXPLICIT_VR_LE = "1.2.840.10008.1.2.1";

/** `2.25.<random>` — the UID form for locally generated objects, same as the exporter uses. */
const uid = () => `2.25.${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e15)}`;

/**
 * A CT series of `nz` axial slices on an `nx` x `ny` grid, 1 mm isotropic unless told otherwise.
 *
 * The pixels are a sphere in Hounsfield-like values, which gives a thresholding test something with
 * shape rather than a constant block -- a segment that is a solid rectangle would hide exactly the
 * placement errors these tests exist to catch.
 */
export async function makeCtSeries(
  nx: number,
  ny: number,
  nz: number,
  /** `extra` goes into every instance verbatim -- for a test that needs an attribute this fixture
   *  does not invent, such as the attribution a derived series has to carry forward. */
  opts: { spacing?: number; sliceThickness?: number; extra?: Record<string, unknown> } = {},
): Promise<SyntheticSeries> {
  const dcm = await dicomIO();
  const sp = opts.spacing ?? 1;
  const dz = opts.sliceThickness ?? 1;
  const studyInstanceUID = uid(), seriesInstanceUID = uid(), frameOfReferenceUID = uid();
  const instances: ArrayBuffer[] = [];
  const cx = nx / 2, cy = ny / 2, cz = nz / 2, r = Math.min(nx, ny, nz) / 3;

  for (let k = 0; k < nz; k++) {
    const px = new Int16Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = Math.hypot(i - cx, j - cy, k - cz);
        // three shells, so a threshold can pick out nested structures at known sizes
        px[j * nx + i] = d < r * 0.4 ? 900 : d < r * 0.7 ? 300 : d < r ? 60 : -900;
      }
    }
    const ds: Record<string, unknown> = {
      SOPClassUID: CT_SOP_CLASS,
      SOPInstanceUID: uid(),
      StudyInstanceUID: studyInstanceUID,
      SeriesInstanceUID: seriesInstanceUID,
      FrameOfReferenceUID: frameOfReferenceUID,
      Modality: "CT",
      PatientName: "TEST^SYNTHETIC",
      PatientID: "TEST-1",
      StudyDate: "20260905",
      SeriesNumber: 1,
      InstanceNumber: k + 1,
      Rows: ny,
      Columns: nx,
      BitsAllocated: 16,
      BitsStored: 16,
      HighBit: 15,
      PixelRepresentation: 1,
      SamplesPerPixel: 1,
      PhotometricInterpretation: "MONOCHROME2",
      RescaleIntercept: 0,
      RescaleSlope: 1,
      PixelSpacing: [sp, sp],
      SliceThickness: dz,
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      ImagePositionPatient: [0, 0, k * dz],
      PixelData: [px.buffer],
      ...(opts.extra ?? {}),
      _meta: {
        MediaStorageSOPClassUID: { Value: [CT_SOP_CLASS], vr: "UI" },
        MediaStorageSOPInstanceUID: { Value: [String(ds_sop())], vr: "UI" },
        TransferSyntaxUID: { Value: [EXPLICIT_VR_LE], vr: "UI" },
      },
    };
    // the file meta must name the same instance as the dataset
    (ds._meta as Record<string, { Value: string[] }>).MediaStorageSOPInstanceUID.Value = [ds.SOPInstanceUID as string];
    instances.push(dcm.toFile(ds).write());
  }

  // LPS -> RAS: x and y flip, which is what the image reader does with a [1,0,0,0,1,0] orientation.
  const ijkToRAS = [-sp, 0, 0, 0, 0, -sp, 0, 0, 0, 0, dz, 0, 0, 0, 0, 1];
  return { instances, dims: [nx, ny, nz], ijkToRAS, studyInstanceUID, seriesInstanceUID };
}

function ds_sop(): string {
  return "";   // replaced immediately after construction; kept so the literal stays readable
}


/**
 * DOES DCMTK READ IT? Andrey Fedorov asked for the community's toolkits, not only our own; Ron installed DCMTK on
 * 2026-09-25. The bytes Albula wrote, parsed by DCMTK's dcmdump: true when it reads them without an error, false when
 * it refuses, undefined when DCMTK is not installed (the caller's test is then ignored, not passed).
 */
export function dcmtkReads(bytes: Uint8Array | ArrayBuffer): boolean | undefined {
  let has = false;
  try { has = new Deno.Command("dcmdump", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { has = false; }
  if (!has) return undefined;
  const f = Deno.makeTempFileSync({ suffix: ".dcm" });
  try {
    Deno.writeFileSync(f, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return new Deno.Command("dcmdump", { args: ["-q", f], stdout: "null", stderr: "null" }).outputSync().success;
  } finally { Deno.removeSync(f); }
}
export const HAS_DCMTK = (() => { try { return new Deno.Command("dcmdump", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; } })();

/** `python3` with pydicom and numpy, for the checks by a reader that is not ours. Absent, those checks are skipped and
 *  say so, like DCMTK's and dciodvfy's; before 2026-09-28 a machine without them could not build at all (critic,
 *  qa/2026-09-28-dependencies.md, finding 5). */
export const HAS_PYDICOM = (() => { try { return new Deno.Command("python3", { args: ["-c", "import pydicom, numpy"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; } })();

/** DAVID CLUNIE'S dciodvfy (dicom3tools; IDC's build, `pip install dicom3tools`), the DICOM parity plan's first step
 *  (Contents/docs/DICOM-PARITY.md, principle 4): each object Albula writes is checked against the standard's module
 *  definitions. Returns the checker's "Error" lines (empty = conformant), or undefined when dciodvfy is not installed.
 *  Warnings are returned separately; a test decides what it accepts. */
export function dciodvfy(bytes: ArrayBuffer | Uint8Array): { errors: string[]; warnings: string[] } | undefined {
  if (!HAS_DCIODVFY) return undefined;
  const f = Deno.makeTempFileSync({ suffix: ".dcm" });
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    Deno.writeFileSync(f, u8);
    // dciodvfy does not read the Deflated transfer syntax (Albula's SEGs are deflated): DCMTK inflates it first.
    if (new TextDecoder("latin1").decode(u8.subarray(0, Math.min(u8.length, 1024))).includes("1.2.840.10008.1.2.1.99")) {
      const ok = new Deno.Command("dcmconv", { args: ["+te", f, f], stdout: "null", stderr: "null" }).outputSync().success;
      if (!ok) return { errors: ["Error - dcmconv could not inflate the deflated file"], warnings: [] };
    }
    const out = new Deno.Command("dciodvfy", { args: ["-new", f], stdout: "piped", stderr: "piped" }).outputSync();
    const lines = (new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)).split("\n");
    return { errors: lines.filter((l) => /^Error/.test(l)), warnings: lines.filter((l) => /^Warning/.test(l)) };
  } finally { Deno.removeSync(f); }
}
export const HAS_DCIODVFY = (() => { try { new Deno.Command("dciodvfy", { args: [], stdin: "null", stdout: "null", stderr: "null" }).outputSync(); return true; } catch { return false; } })();
