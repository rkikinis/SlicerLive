# How Albula keeps its data

What is on disk, in what form, and which code owns it. Written 2026-10-13 from the code as it is, and checked by a
critic the same night; when the code changes, change this page with it.

**DICOM is the record of the images.** Every scan and every segmentation, surface and fiber-tract result Albula keeps is
a DICOM file listed in a DICOM index. Beside them are two other kinds of thing:

- **Kept outside DICOM, the only copy of what they hold** — deleting them loses work: saved scenes (the views, the
  camera, markups, name cards), and the record store (which series was made from which, facts a person typed, cohorts).
- **Derived, made again when missing** — deleting them loses nothing: the working copy for fast loading, caches, AI
  checkpoints.

## Where the databases are

A database is a folder. Albula makes new ones under one parent folder:

```
~/SlicerAlbulaDatabases/            the parent (desktop/db-create.ts, defaultDatabasesFolder)
  <database>/                       one folder per database, any number of them
  <database>/
  provenance.sqlite                 the record store, shared by every database in this parent
```

The record store is always the file `provenance.sqlite` in the folder that holds the database (`provenancePathFor`,
`desktop/db-index.ts`). So a database registered elsewhere — on a stick at `/Volumes/X/DB`, say — keeps its records in
`/Volumes/X/provenance.sqlite`, shared with any other database in that folder.

The list of databases Albula opens is in `settings.ini`, section `[Database]`: `<id> = <folder>`, plus `current = <id>`
for the one open by default (`desktop/settings-file.ts`). The file is `~/.config/slicerlive/settings.ini` on macOS and
Linux (where Albula keeps it on Windows is not decided yet: the workspace's cross-platform plan, step 2), unless a
`settings.ini` already exists in the application's gallery folder or one or two folders above it, which then wins
(`resolveSettingsPath`). A database anywhere else on disk can be registered; Load / Save › Load from the DICOM database ›
Databases… offers to move or copy it into the parent.

Paths inside a database are relative to its folder, so a database folder can be moved, renamed or copied to another
machine whole.

## Inside one database

```
<database>/
  ctkDICOM.sql              the DICOM index (SQLite; Slicer's ctkDICOMDatabase schema)
  ctkDICOM.sql.backup-<time> a copy of the index, kept when an audit after a write found rows without files
  albula-database.json      the description: name, what it holds, patient data or not, approval, source, contact
  albula-record.jsonl       what came in from and went out to other databases (transfers; desktop/db-transfer.ts)
  dicom/                    DICOM files added from outside, in Slicer's layout
  SlicerAlbula-SEG/         DICOM objects Albula makes: segmentations, tracts, surfaces (and a few non-DICOM files of the
                            diffusion extension: the tract review's verdicts, the import job's lock)
  SlicerAlbula-Volumes/     DICOM image series Albula makes: a volume from a file, a crop
  OpenNeuro/<dataset>/<subject>/  DICOM objects made from the brain tumor test cases (BIDS → DICOM, desktop/bids-import.ts)
  SlicerAlbula-Zarr/        the working copy: one Zarr folder per grayscale series (not DICOM; derived)
  SlicerAlbula-Scenes/      saved scenes, one mrson JSON file each (not DICOM; kept)
  SlicerAlbula-Scenes/MRCOM/ each saved scene again as one DICOM object, an MRCOM bundle (since 2026-10-29; indexed)
  SlicerAlbula-Cache/       caches (not DICOM; derived)
  SlicerAlbula-Checkpoints/ an AI run's raw result, a safety net (not DICOM, not indexed; derived)
  SlicerAlbula-Logs/        run logs: diffusion-runs.jsonl, what the diffusion extension's job tried on each scan, with
                            what, and how it ended, and every tract set deleted with its whole record (added to, never
                            edited; not DICOM, KEPT -- the history survives the results; albula-diffusion run-log.ts)
  SlicerAlbula-Import/      uploads waiting to be added (not indexed)
  SlicerAlbula-Download/    downloads waiting to be added (desktop/test-cases.ts)
```

Other folders may sit in a database that Slicer or an older import made (a collection's own folder names, for
example). They are fine: whatever DICOM file the index lists is part of the database, wherever it is inside the folder.

### The DICOM index: `ctkDICOM.sql`

Slicer's own index, kept compatible so that Slicer can open the same database: tables `Patients`, `Studies`, `Series`,
`Images`. An `Images` row is one DICOM file: its SOP Instance UID, its path relative to the database folder, and its
series. Albula opens it with the SQLite inside Deno (`desktop/sqlite.ts`), in this process; there is no separate
database program. Writes go one at a time per database (`withIndexLock`, `desktop/db-index.ts`), each series in one
transaction, and an audit after a batch checks that every row has its file and every file in Albula's folders has its
row (`auditDatabase`). The page never reads this file: it asks the server (`GET /_db/<id>/_series`, the series list
and counts; `GET /_db/<id>/_files?series=<uid>`, one series' files; `desktop/db-listing.ts`). A replacement with
Albula's own schema is planned (the workspace's `ALBULA-DATABASE.md`); until
then this is the index.

### DICOM files

- **Added from outside** (Load / Save › Also add to, a DICOM folder, a packaged scene) go to
  `dicom/<md5 of study, 8>/<md5 of series, 8>/<md5 of instance>.dcm`, Slicer's layout (`ctkInstancePath`,
  `desktop/md5.ts`). Files are copied; a move removes the originals only after the database has them
  (`desktop/db-import.ts`).
- **Made by Albula** go to `SlicerAlbula-SEG/` and `SlicerAlbula-Volumes/` (and, for the test cases, `OpenNeuro/…`), are
  written and indexed in one request, and are taken back out if the index refuses them. Each made object records what it
  was made from (the record store, below).

What Albula reads: CT and MR images (classic and enhanced multi-frame), segmentations, tractography (surfaces: the
reader stays in `logic/`, but since 2026-10-21 no app path loads them -- they are an export only), and the
pixel encodings DICOM allows (uncompressed, RLE, JPEG, JPEG-LS, JPEG 2000, HTJ2K; `logic/codecs/`). What Albula
writes:

| object | DICOM form | written by |
|---|---|---|
| a segmentation (what the app saves) | **Label Map Segmentation**, the dataset deflated: one label number per voxel | `logic/export-dicom-seg.ts` |
| a segmentation, Slicer's form (no app path writes it today; tests do) | **Segmentation (SEG)**, one bit per voxel per structure | `logic/export-dicom-seg.ts` |
| surface models: none since 2026-10-22 (Ron: "only segmentations go into the db; stl are exports only"). The writer and reader stay in `logic/` for DICOM parity; no app path calls them | **Surface Segmentation** | `logic/export-dicom-surface.ts` |
| an image volume (from a file, a crop) | **CT / MR / PET / NM Image**, one file per slice, the voxels unchanged | `logic/export-dicom-image.ts` |
| fiber tracts (the diffusion extension) | **Tractography Results** | `tracts-dicom.ts` in `rkikinis/albula-diffusion` |
| a diffusion scan converted from NIfTI or NRRD | **Enhanced MR Image** | `export-dicom-dwi.ts` in `rkikinis/albula-diffusion` |

Where dicom3tools' `dciodvfy` is installed, the tests check the label-map, surface, image and tractography writers, the
BIDS converter's output, the diffusion writer and the scene object with it (skipped without it), each allowing a named
list of errors it does not fix. A DICOM object Albula makes from another keeps the source's attributes, private ones
included, except private pixel data (groups 7F01–7FFF); a conversion from NIfTI or NRRD has no DICOM source to keep.

### The working copy: `SlicerAlbula-Zarr/` (not DICOM; derived)

One `<series instance UID>.zarr/` folder per grayscale series ("duckn": Zarr v3, zstd-compressed chunks, a JSON header
holding the series' DICOM header in the standard's JSON form). Loads read the copy because it is faster than parsing
DICOM; the DICOM files stay the record. Each copy carries the fingerprint of the code that made it; a copy made by other
code is not used, and the series loads from DICOM. Each copy lists any image of the series it does not hold.
**Today copies are made only by the hand-run sweep** (`deno run -A desktop/duckn-sweep.ts <database>`; its report is
`SlicerAlbula-Zarr/sweep-report.json`); making them at indexing and in the background inside the app is planned (the
workspace's `DUCKN-WORKING-COPY.md`). Deleting this folder loses nothing.

### Scenes: `SlicerAlbula-Scenes/` (not DICOM; kept) and their DICOM objects

`<scene UID>.mrson.json`: a scene in Steve Pieper's mrson format (the modernized MRML): what is loaded, how it is shown,
the camera, the markups. A scene names its data by DICOM UID, never by file. The list of scenes is a table in the record
store. Code: `desktop/scenes.ts`. **Since 2026-10-29 the files are profile `albula-scene/2`** (`logic/scene/profile.ts`):
each image and segmentation named in Steve's descriptor form (`kind`, every instance in slice order), so they pass his
validator (`mrson/validate.ts`); version 1 files still open.

**Each scene is also a DICOM object** (`SlicerAlbula-Scenes/MRCOM/<SOP instance UID>.dcm`): a Secondary Capture carrying
the scene in Steve's MRCOM private block (`logic/mrcom/`, his spec `docs/MRCOM-SCENE-BUNDLE.md`), in reference mode -- it
names the scans and segmentations, carries none of their voxels -- indexed in the scene's study (modality OT, "Scene:
<name>"), made from its first scan (record-store kind `scene`) and tied to its scene by the series fact `sceneUID`. One
object per scene: every save and rename replaces it, a delete removes it (`desktop/scene-mrcom.ts`, called by
`desktop/scenes.ts`). The browser does not load it as an image; the copy sweep skips it. The scene file stays what Albula
opens; the object is the scene's record in DICOM, for other programs and for the archive.

### Caches: `SlicerAlbula-Cache/` (not DICOM; derived)

Made again when missing. Today: the diffusion extension's pictures (b = 0, Color FA, in gzipped NRRD), written by its
import-time job. A cache file is named with the UID of the series it belongs to and is removed with that series
(`desktop/db-index.ts`).

### Checkpoints: `SlicerAlbula-Checkpoints/` (derived)

An AI run's raw result, written before anyone presses Save, so a reload does not lose the run. The newest few are kept;
older ones, and ones older than a day, are removed when the next checkpoint is written (`desktop/db-serve.ts`).

## The record store: `provenance.sqlite` (kept)

Facts DICOM has no standard place for, in SQLite (`desktop/db-index.ts`, `desktop/scenes.ts`):

- `ProvenanceEdges`: "made from". Child series, parent series, kind (an AI algorithm, a crop, tracts, …), label, detail,
  when (and who, where it was given). This is the family tree: scan → segmentation → surfaces, diffusion scan → tracts.
- `SeriesAttributes`: facts about a series by key (collection, license, the run that made it). A person's own entries
  (source "user") are never overwritten by a lookup.
- `Scenes`: one row per saved scene: its UID, study, name, version and file path relative to its database.
- `Cohorts`, `CohortMembers`: named groups of patients or studies.

## A packaged scene: `<name>.albula` (a folder, for moving a case between machines)

```
<name>.albula/
  scene.mrson.json     the scene
  provenance.json      the record store's rows that concern its series
  dicom/<series UID>/  the DICOM files of every series the scene uses
  README.txt           what this is and how to open it, for a person
```

Opening one (drop it on Albula, or Load / Save › Load from files › Packaged scene…) puts its DICOM files into a database, its rows into
the record store and its scene into the scene list, in one step (`desktop/package-open.ts`, `render/demos/package-window.ts`).

## What may be deleted

Original acquisitions never. Scenes and the record store only on purpose (they are the only copy). Everything Albula
derived may be deleted when there is a reason: segmentations, tracts, surfaces and crops (through the app, which also
removes their index rows, cache files and record-store rows), and the working copy, caches and checkpoints (made again).

A whole database is removed only by the person, in the Databases window (2026-10-26, `desktop/db-remove.ts`): from the
list only (the folder untouched), or with its folder moved to the macOS Trash -- original acquisitions included, which is
the point of that choice; Finder's Put Back brings it back until the Trash is emptied. Its rows in the record store
beside the folder (`provenance.sqlite`: made-from edges, attributes, scenes, cohorts) are left as they are, as a moved
database leaves them; scenes are listed only while their file exists, the other rows stay as a record.

## Notes added 2026-10-26

- **The settings file is written under a lock** (`settings.ini.lock` beside it, `desktop/settings-file.ts`
  `withSettingsLock`): the database list ([Database]) and the page's settings are read, changed and written inside it, so
  two writers (two windows, the app and a headless server) never undo each other.
- **A scene keeps per-segment settings by segment number** (`labelValue`). Albula's SEG writer numbers a result's segments
  1..N over the structures present, so the same number is a different structure in another file: settings move between
  segmentations by the file's segment label, never by number (CONSTRAINTS.md).
- **`OpenNeuro/` holds every BIDS import by accession** (ds001226, ds005123, ...), each `<accession>/<subject>/<session>/<role>/`.
- **A database on another Mac** (built 2026-10-28 as sharing in the app, off until switched on; the workspace's
  `DATABASE-SHARING.md`): listed in its own settings section
  `[RemoteDatabase]` (`<id>=<host>:<port>|<id there>`), never in [Database]; its folder is on the other Mac, reached only
  through that Mac's sharing program, which stays the one writer of its index.
