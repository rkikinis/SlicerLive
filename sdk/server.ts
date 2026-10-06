// THE ALBULA SDK FOR PROGRAMS BESIDE THE SERVER (Contents/docs/DMRI-AT-IMPORT.md in the workspace, build plan steps 2-4):
// an extension's import-time job runs as its own program, started by Albula's server, with no page, no scene and no
// window. It imports `albula` for what the page's code shares (the DICOM reader, the brain mask, the DICOM library) and
// `albula/server` for what only a program on the server's side needs: the database's index read-only, the files of a
// series, the DICOM library to inject (the page's comes with the bundle), and the NRRD writer for sending a volume to
// haversack. It never writes the index itself: the index's lock lives inside the server process, so a job writes and
// indexes through the server's `POST /_db/<id>/_write/<name>` route.
//
// Version 8 of the SDK (sdk/albula.ts SDK_VERSION) added this file.
export { setDicomLibrary } from "../logic/dicom-io.ts";
export { default as dcmjs } from "../logic/dcmjs.ts";
export { indexSeries, seriesFilePaths, seriesFileStamp, type IndexSeries } from "../desktop/series-files.ts";
export { writeNrrd } from "../logic/writers/nrrd.ts";
export { SDK_VERSION } from "./albula.ts";
