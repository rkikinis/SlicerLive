# Slicer Segment Editor Module Icons

Below is a current snapshot of icons for Slicer's Segment Editor Module. Please add comments.

To create NEW icons to add to this set, please follow [this simple workflow NOT YET LINKED]. The workflow will refer icon designers to Slicer's [Icon Design Guildelines] and Slicer's [Color Palette] to ensure new icons are visually compatible with Slicer's icons and that they work well in both Dark and Light Themes.

## Icon set colors and symbolics 

* **Segmentation primary colors:** "SegmentationPrimaryFillGreen" GLOBAL fill color, "SegmentationAndLabelGridGreen"  SWAP outline color (palette colors below) symbol for segmentation/label.
  
*  **Segmentation secondary colors:** "SegmentationSecondaryFillYellow" GLOBAL fill color, "SegmentationSecondaryOutlineYellow" GLOBAL outline color (palette colors below) to indicate additional labels/segmentations.

* **Segmentation:** an outlined 2D polygon with filled voxels and grid 
  
* **Segmentation vignette:** a part of segmentation shown as polygon filled with "SegmentationPrimaryFillGreen". Outline only along edge of segmentation, but not where it is cropped from view in the vignette.

* **Direct Action:** "SegmentationPrimaryDirectActionGreen" is used to indicate direct action like draw, paint, erase, seed, etc.

* **Seed created by Direct Action:** Clicking in a particular location to create a seed or select a (local) region within an image for processing is shown as a small "SegmentationAndLabelOutlineGreen" shape (rounded square or circle) that marks the location clicked, surrounded by an outer "shell" with "SegmentationEditorGreen" fill. This symbol is used in icons for "FastMarching", "GrowFromSeed" and "LocalThreshold".
 
* **Image|view|slice:** theme-stroke-outlined 2D plane with (if resolution permits) axis & 4 quadrants OR 4 voxels
  
* **Source Volume:** orthographic wireframe cube


## Full Icon set for SegmentEditor Module Dark and Light Themes:

Light & Dark Theme 

24x24 px res

<img src="https://github.com/user-attachments/assets/0d110a33-90bd-4d2e-baa8-4e30f807779d" width="400">

48x48 px res

<img src="https://github.com/user-attachments/assets/c672b4b1-5c5a-41bd-ae29-d4d2001a07bc" width="600">

## Icons, categories and names:

Top level icons for Display, Navigation, Basic UI ops

<img src="https://github.com/user-attachments/assets/98e29b69-9e28-431f-b226-59622f578413" width="600">

Icons for basic tools to create & edit segments

<img src="https://github.com/user-attachments/assets/be0e7e43-9435-4d42-9ceb-b29be1351435" width="600">

Icons for advanced tools for adjusting & processing segments:

<img src="https://github.com/user-attachments/assets/b9a4cd87-e3a7-438c-b9f3-5d328002ab80" width="600">

Icons for segment editor extra effects

<img src="https://github.com/user-attachments/assets/d8a2067d-49f6-4ca0-8a18-a24708e87b5d" width="600">

## Specific Colors included in SlicerSimplePalette

Slicer SegmentationandLabelGridGreen SWAP color (LightTheme):
* HEX ##738C79FF

Slicer SegmentationandLabelGridGreen SWAP color (DarkTheme):
* HEX #56695BFF

Slicer SegmentationPrimaryDirectActionGreen GLOBAL color (used to highlight segment editor direct action like seed/paint/draw/erase in tools):
* HEX #28B84DFF

Slicer SegmentationSecondaryFillYellow GLOBAL color (used to indicate an additional label or segmentation)
* HEX  #f9e883FF

Slicer SegmentationSecondaryOutlineYellow (used to indicate an additional label or segmentation)
* HEX #d1a718


