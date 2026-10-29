# `render/vendor/dcmjs/` — vendored dcmjs

| | |
|---|---|
| source | https://github.com/dcmjs-org/dcmjs |
| branch | `mrcom-integration` |
| commit | `b02ee51266cac9388ccd9384a3cde6987e893ce6` |
| package version | 0.49.2 |
| `master` it merges | `aee06e4` |
| built | 2026-10-28 with `rollup -c` on node v22.20.0 |

## Why vendored rather than loaded from a CDN

SlicerLive previously loaded dcmjs **0.41.0 from jsdelivr/unpkg**, reader only. MRCOM needs the
*write* path, and three reasons make a CDN wrong for it:

1. **A write path must not depend on the network.** A CDN flake while loading the library that is
   about to encode a file is a corrupted save.
2. **The changes are not released yet.** They are five open PRs — see `docs/MRCOM-PLAN.md` §4. This
   branch is `master` plus all five.
3. **One version everywhere.** The main thread, the classic decode worker
   (`render/vendor/idc_tools/idc-worker.js`, which `importScripts`), Deno, and SlicerAlbula all need
   to agree. A CDN pin plus a worker mirror list is two places to skew.

## The two builds

| file | format | for |
|---|---|---|
| `dcmjs.min.js` | UMD, global `dcmjs` | a script tag and the classic worker's `importScripts` |
| `dcmjs.es.js` | ESM | Deno, SlicerAlbula's server, and esbuild bundling |

Both are needed: Albula imports the ESM from a Deno process, while `idc-worker.js` is a classic
worker and can only `importScripts` the UMD.

Source maps are deliberately not vendored — they are ~4 MB and add nothing to a consumer.

## Do not edit these files

They are build output. To change dcmjs, change it in its own repository and rebuild:

```
cd <dcmjs checkout> && git checkout mrcom-integration && rollup -c
cp build/dcmjs.min.js build/dcmjs.es.js <SlicerLive>/render/vendor/dcmjs/
```

then update the commit in the table above. **The MRCOM PRs are under review and dcmjs is in
production use elsewhere, so treat that branch as read-only input** — raise a needed change rather
than committing one.

## What this build adds over 0.41.0

Beyond upstream `master`: Explicit VR Big Endian byte order for binary value fields,
`registerTag` reaching `nameMap` (so a registered private tag can be *written*, not only read),
`DicomDict#privateBlock()` and `findPrivateBlock()` for PS3.5 §7.8.1 reservation, and a
`SecondaryCapture` derivation. Verified on the global: `data.DicomMessage`, `data.registerTag`,
`data.findPrivateBlock`, `derivations.SecondaryCapture`.

## In SlicerAlbula (since 2026-10-28)

Albula uses this build and no other dcmjs: the page and the workers load `dcmjs.min.js` (`dcmjsUrl` in
`logic/dcmjs-version.ts`; the rebuild copies this folder's `dcmjs*.js` and `License.txt` to `webgpu/vendor/dcmjs/`),
and the Deno side (the server, the copy converter, the tests) imports `dcmjs.es.js` through `logic/dcmjs.ts`. The
sha256 of both files is pinned in `logic/dcmjs-version.ts`, and `desktop/duckn-copy-code.test.ts` fails if either file
changes without the pin, or if anything imports dcmjs from npm or a CDN. Albula never loads dcmjs from a CDN, so the
CDN entries above are not on its path (`logic/readers/dicom-series.ts` reaches dcmjs only through `logic/dicom-io.ts`).

Before this, Albula held dcmjs 0.41.0 (vendored 2026-09-28, the npm package's `build/dcmjs.js`, MIT, `License.txt`).
What moving to this build was checked against, 2026-10-28 (workspace `docs/WORKING-STATE.md`, that evening):

- every public file under the workspace's `Contents/data/dicom` (2,296 files, 2,263 DICOM) read with both: the same
  naturalized header for all but 71, no file readable by one and not the other;
- the 71: GE's private creator (7FD1,0010) "GEIIS" in the TCGA-UCEC CT files is named `RETIRED_VariablePixelData`, and
  written back by `denaturalizeDataset` as (7F00,0010), an attribute that was not in the file (0.41.0 names it
  `7FD10010` and leaves it out of a written object);
- the September problem with a sequence sent as UN (one public CT slice read with a value of 909 MB) is gone;
- the writer on a large header (the public Philips fMRI, 9.9 MB of header) 11.8 s against 1.25 s; Albula's own writers:
  the label-map segmentation (512 x 512 x 500, 104 segments) 1.0 s against 0.7 s, the diffusion Enhanced MR object
  (Stanford HARDI, 12,160 frames) 4.4 s against 1.1 s.
