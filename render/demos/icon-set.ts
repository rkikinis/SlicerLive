// THE ICONS, BY VERSION -- which picture stands for what on the bar, the views' bars, the menus and the panels. Ron,
// 2026-11-07/08, on mockups/albula-icons-whole-window-2026-11-07.html and in the chat: Wendy Plesniak's icons (her
// SimpleColorStyle sets for Slicer, render/vendor/plesniak-icons/, the 3D Slicer License: NOTICE.md there); the top bar
// icons only, as Slicer's; a picture beside the word in the modules; the picture is the PLACE and an arrow the DIRECTION
// ("arrows say save (towards the icon) and load (away from the icon)"): a folder for files, a cylinder for the database
// (icon-conventions-2026-11-08.md: the cylinder is the database for Windows, KDE and Slicer itself); her scene picture
// for scenes; a person for a patient. Like the colors and the shading (render/shading-versions.ts): each version is a
// number, the old ones stay, Settings chooses.
//
//   v1  words, as before 2026-11-08 (no pictures).
//   v2  Wendy Plesniak's icons and two of ours derived from her DataIO/DICOMIO.svg (the cylinder with one arrow).
//
// ON A YELLOW BUTTON a picture needs dark lines (Ron: "use the version with most contrast"): every picture carries her
// dark set's file and her light set's (black lines), and theme.css shows the light one inside a yellow button. A
// button turns yellow and back (Open's three, the Save buttons), so the choice is the stylesheet's, at the moment.
//
// Everything that shows a picture asks this module; nobody holds a file name of hers.

export interface IconSetVersion { version: number; name: string; date: string; what: string }
export const ICON_SETS: readonly IconSetVersion[] = [
  { version: 1, name: "Words", date: "2026-09-05", what: "Words on the buttons, as before." },
  { version: 2, name: "Wendy Plesniak's icons", date: "2026-11-08",
    what: "Pictures on the bar and beside the words: Wendy Plesniak's icons for Slicer." },
];
export const LATEST_ICON_SET = ICON_SETS[ICON_SETS.length - 1].version;

let current = LATEST_ICON_SET;
/** The version in use. Set once at start from Settings (General › Icons); a change applies when the window is opened again. */
export function iconSetVersion(): number { return current; }
export function setIconSetVersion(v: number): void { current = ICON_SETS.some((s) => s.version === v) ? v : LATEST_ICON_SET; }
export const iconsOn = (): boolean => current >= 2;

const BASE = "vendor/plesniak-icons/";
const M = "Modules/CoreToolbarModules/", S = "Modules/SegmentEditorModule/", V3 = "3DViewers/3DViewers", L = "ViewerConfigurationV2/";

/** What each picture means, and her file for it (the dark set's path; the light set has the same names). */
const FILES = {
  // the place, and the direction (Ron, 2026-11-08)
  loadSave: "DataIO/DICOMIO.svg",                       // the cylinder with an arrow in and one out: Load / Save itself
  openFiles: "DataIO/SlicerLoadData.svg",               // a folder, an arrow out: open files
  saveFile: "DataIO/SlicerSaveData.svg",                // a folder, an arrow in: save as a file
  database: "SlicerDataSymbols/SlicerDatabase.svg",     // the cylinder: a database (the chooser at the top)
  openDatabase: "derived:out",                          // the cylinder, an arrow out: open from the database
  saveDatabase: "derived:in",                           // the cylinder, an arrow in: save to the database
  scene: "Capture/SlicerSceneViewCapture.svg",          // a scene (Ron: "keep the scene picture")
  scenes: "derived:scenes",                             // the Scenes module: a folder with lines to what it holds (Ron's C)
  patient: "ApplicationBasics/SubjectAndStudyRepresentation/HumanSubject.svg",
  segmentation: "SlicerDataSymbols/SlicerSegmentation.svg",
  more: "ApplicationBasics/UIActions/SlicerMoreOptionsHoriz.svg",
  // the bar
  picture: "Capture/SlicerCapture.svg",
  findModule: "ModuleNavigation/ModuleSearch.svg",
  moduleBack: "ModuleNavigation/ModulePrevious.svg",
  moduleForward: "ModuleNavigation/ModuleNext.svg",
  // the 3D view's bar
  fit3d: `${V3}ViewRecentered.svg`,
  fromR: `${V3}ViewFromRight.svg`, fromA: `${V3}ViewFromAnterior.svg`, fromS: `${V3}ViewFromSuperior.svg`,
  fromL: `${V3}ViewFromLeft.svg`, fromP: `${V3}ViewFromPosterior.svg`, fromI: `${V3}ViewFromInferior.svg`,
  orthographic: `${V3}UseOrthographic.svg`,
  settings3d: `${V3}MoreOptions.svg`,
  // a slice view's bar
  sliceIn3d: "SlicerCommonSymbols/Slicer3DView.svg",
  sliceSettings: "SpatialProbes/SlicerSlicePlanesOptions.svg",
  // the Segment Editor's tools
  pointer: `${S}Select.svg`, paint: `${S}Paint.svg`, erase: `${S}Erase.svg`, draw: `${S}Draw.svg`, threshold: `${S}Threshold.svg`,
  scissors: `${S}ContentCut.svg`, grow: `${S}GrowFromSeed.svg`, undo: `${S}SlicerUndo.svg`, redo: `${S}SlicerRedo.svg`,
} as const;
export type IconName = keyof typeof FILES;

/** Each module's picture, by its panel id; a module not here has none in her set (Volume Rendering, Diffusion, Crop Volume). */
const MODULES: Record<string, string> = {
  welcome: `${M}WelcomeModule.svg`, "add-data": FILES.loadSave, data: FILES.scenes,
  segmentations: `${M}SegmentationsModule.svg`, sequences: "ApplicationBasics/SequencePlayer/SlicerPlay.svg",
  sampledata: "DataIO/SlicerDownload.svg", volumes: "MouseModes/SlicerWindowLevel.svg",
  "ai-segmentations": "SlicerDataSymbols/SlicerAIsparkles.svg", segment: `${M}SegmentEditorModule.svg`,
  markups: `${M}MarkupsModule.svg`, transforms: `${M}TransformsModule.svg`,
};
/** Each arrangement's picture, by the layout's name as the layout list shows it. */
const LAYOUTS: Record<string, string> = {
  "Conventional": "SlicerConventionalView", "Conventional Widescreen": "SlicerConventionalWidescreenView",
  "Four-Up": "SlicerFourUpView", "One-Up 3D": "Slicer3DOnlyView", "One-Up Red": "SlicerRedSliceOnlyView",
  "One-Up Yellow": "SlicerYellowSliceOnlyView", "One-Up Green": "SlicerGreenSliceOnlyView", "Dual 3D": "SlicerDual3DView",
  "Three-Over-Three": "SlicerThreeOverThreeSliceView", "Two-Over-Two": "SlicerTwoOverTwoSliceView",
};

// OURS, DERIVED FROM HERS (Ron, 2026-11-08: "use ours"): her DICOMIO cylinder (DataIO/DICOMIO.svg, its six strokes as
// she drew them) with one arrow, centered under it: out of the cylinder (open from the database) or into it (save to it).
// Drawn in her line color for each set (#e5e5f6 dark, #000000 light); to be sent back to her.
// THE SCENES PICTURE, ours (Ron, 2026-11-08, mockups/scenes-module-2026-11-08.html: "4 C", after a home-automation picture he
// sent: "replacing the house with a monochrome folder with lines signifying the different elements ... minimalist"): a folder
// at the left, three lines to the right ending in circles. In her line (2 on her 48 grid).
const SCENES_SVG = `<path d="M3 11h8.5l2.5 3H28v21H3z"/><path d="M28 16.5h9M28 24.5h9M28 32h9"/><circle cx="40.5" cy="16.5" r="2.5"/><circle cx="40.5" cy="24.5" r="2.5"/><circle cx="40.5" cy="32" r="2.5"/>`;
function derived(dir: "out" | "in" | "scenes", ink: string): string {
  if (dir === "scenes") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g style="fill:none;stroke:${ink};stroke-width:2;stroke-linecap:round;stroke-linejoin:round">${SCENES_SVG}</g></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  const cyl = `<path d="M 35.05,7.3 V 19.95"/><path d="M 13,6.95 V 20.17"/><path d="m 13,19.95 a 11,4 0 0 0 11,4 11,4 0 0 0 11,-4"/>` +
    `<path d="m 13,7.05 a 11,4 0 0 1 11,-4 11,4 0 0 1 11,4"/><path d="m 35,13.54 a 11,4 0 0 1 -11,4 11,4 0 0 1 -11,-4"/>` +
    `<path d="m 35,7.05 a 11,4 0 0 1 -11,4 11,4 0 0 1 -11,-4"/>`;
  const arrow = dir === "out" ? `<path d="M 24,28 V 44.5"/><path d="M 16.5,37.4 24,44.9 31.5,37.4"/>`
    : `<path d="M 24,30 V 45"/><path d="M 16.5,36.9 24,29.4 31.5,36.9"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g style="fill:none;stroke:${ink};stroke-width:2;` +
    `stroke-linecap:round;stroke-linejoin:round">${cyl}${arrow}</g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function srcs(file: string): [dark: string, light: string] {
  const d = /^derived:(out|in|scenes)$/.exec(file);
  if (d) return [derived(d[1] as "out" | "in" | "scenes", "#e5e5f6"), derived(d[1] as "out" | "in" | "scenes", "#000000")];
  return [`${BASE}DarkThemeIcons/${file}`, `${BASE}LightThemeIcons/${file}`];
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A picture as HTML, both sets in it (theme.css shows the right one); "" under v1 or when there is none. Decorative:
 *  the button's word or tooltip says what it is. */
function html(file: string | undefined, cls = ""): string {
  if (!iconsOn() || !file) return "";
  const [dark, light] = srcs(file);
  return `<span class="sl-pic${cls ? " " + cls : ""}" aria-hidden="true"><img class="sl-pic-d" src="${esc(dark)}" alt="">` +
    `<img class="sl-pic-l" src="${esc(light)}" alt=""></span>`;
}
export const iconHtml = (name: IconName, cls = ""): string => html(FILES[name], cls);
export const moduleIconHtml = (panelId: string, cls = ""): string => html(MODULES[panelId], cls);
export const layoutIconHtml = (layoutName: string, cls = ""): string => html(LAYOUTS[layoutName] && `${L}${LAYOUTS[layoutName]}.svg`, cls);
/** Whether a module or an arrangement has a picture (a menu row without one keeps an empty frame of the same size). */
export const hasModuleIcon = (panelId: string): boolean => iconsOn() && !!MODULES[panelId];

/** Put a picture in front of a button's word (or alone, `only`: the word becomes the tooltip). Does nothing under v1. */
export function decorate(btn: HTMLElement, name: IconName, o: { only?: boolean } = {}): void {
  if (!iconsOn()) return;
  btn.querySelector(":scope > .sl-pic")?.remove();
  if (o.only) {
    // The word stays in the button, hidden, so it is still read out and still found; it is the tooltip when there is none.
    const word = (btn.textContent ?? "").trim();
    for (const n of [...btn.childNodes]) if (n.nodeType === 3 && n.textContent?.trim()) {
      const s = document.createElement("span"); s.className = "sl-pic-word"; s.textContent = n.textContent; n.replaceWith(s);
    }
    if (!btn.title && word) btn.title = word;
    if (word) btn.setAttribute("aria-label", word);
  }
  btn.insertAdjacentHTML("afterbegin", iconHtml(name));
  btn.classList.add(o.only ? "sl-pic-only" : "sl-pic-btn");
}
