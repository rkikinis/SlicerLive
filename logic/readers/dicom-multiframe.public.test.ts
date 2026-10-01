// The multi-frame reader on PUBLIC fMRI files (Philips, Siemens XA30), checked against dcm2niix's own outputs for the
// same series (volumes, repetition time). The files are
// fetched by Contents/data/multiframe/fetch-multiframe.py (BSD-2, pinned commits) into Contents/data/dicom/multiframe;
// without them these tests are ignored, not passed.
//
// Checked by hand on 2026-09-25, beyond what is asserted here: the Canon and both Siemens series equal pydicom's own
// reading voxel for voxel; the two Philips series differed by up to 1 in every slice because their rescale slope is
// not a whole number (0.70, 1.07) and the reader stored whole numbers -- float32 since 2026-09-25, exact.
import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import dcmjs from "../dcmjs.ts";
import { parseInstances, setDcmjs, volumesOfSeries } from "./dicom-series.ts";
import { ABSENT, testData } from "../../test/test-data.ts";
setDcmjs(dcmjs);

const BASE = testData("multiframe") ?? ABSENT;
const have = (p: string) => { try { Deno.statSync(p); return true; } catch { return false; } };

async function read(name: string) {
  const dir = BASE + name;
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => !n.endsWith(".gz")).sort();
  const bufs = files.map((f) => { const u = Deno.readFileSync(`${dir}/${f}`); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; });
  return volumesOfSeries(await parseInstances(bufs));
}
const ref = (name: string, ext: string) => {
  const dir = BASE + name + "_ref";
  const f = [...Deno.readDirSync(dir)].find((e) => e.name.endsWith(ext))!.name;
  return Deno.readTextFileSync(`${dir}/${f}`);
};
const tr = (name: string) => (JSON.parse(ref(name, ".json")) as { RepetitionTime: number }).RepetitionTime;
const steps = (t: { timeSec?: number }[]) => t.slice(1).map((x, i) => x.timeSec! - t[i].timeSec!);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

for (const c of [
  { name: "philips_fmri", volumes: 75, dims: [96, 96, 63], fmri: true },
  { name: "xa30_fmri", volumes: 20, dims: [64, 64, 33], fmri: true },
]) {
  Deno.test({
    name: `public multi-frame ${c.name}: ${c.volumes} volumes of ${c.dims.join("x")}, as dcm2niix finds them`,
    ignore: !have(BASE + c.name),
    fn: async () => {
      const r = await read(c.name);
      assertEquals(r.frames.length, c.volumes);
      for (const v of r.frames) assertEquals(v.dims, c.dims);
      assertEquals(r.leftOut, []);
      // one volume per repetition time
      assertAlmostEquals(median(steps(r.timing)), tr(c.name), 0.01);
    },
  });
}
// The diffusion files' checks (b-values and directions against dcm2niix, the XA30 series with a second b=0 file) are
// the diffusion extension's (albula-diffusion, multiframe.public.test.ts): core reads no diffusion values.
