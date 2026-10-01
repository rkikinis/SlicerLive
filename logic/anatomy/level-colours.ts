// Collapsing a branch changes what the colors MEAN.
//
// Ron: "Mike used the plus sign to expand or collapse branches. That is a natural way to change
// color. eg from each gyrus colored, to each lobe colored to each hemisphere. Same works in the
// lungs, ribs, vertebrae etc."
//
// This replaces a color-mode picker, and is better than one for a reason worth stating: the control
// already exists and already means the right thing. Collapsing a branch says "stop showing me the
// parts of this" -- and a reader who has stopped looking at the parts has no use for a color per
// part. So the collapse does both jobs, there is nothing extra to discover, and the picture can
// never disagree with the list.
//
// WHERE A GROUP'S COLOR COMES FROM. Not from the segmenter: FreeSurfer publishes a color for every
// gyrus and none for a lobe, and the same is true of TotalSegmentator for a lung or the ribs as a
// whole. Nor from blending the children -- the Desikan-Killiany colors are not arranged by lobe, so
// averaging a lobe's parcels gives mud, and mud for every lobe gives six identical browns.
//
// So it is position among siblings, from a qualitative palette. That is the one thing a collapsed
// row actually needs: the six lobes must be distinguishable FROM EACH OTHER, and nothing about a
// lobe's identity is being asserted by giving it the third color rather than the fourth. It is
// stable while the tree is (a branch keeps its color across collapse and expand), and it
// generalizes exactly as Ron says -- left and right lung, the twelve ribs, the vertebral regions --
// because "tell these siblings apart" is the same problem everywhere.

/**
 * A qualitative palette for telling siblings apart, 0-255.
 *
 * THERE IS NO STANDARD TO FOLLOW. Ron went looking -- published lobe figures use blue/yellow/green/
 * red, purple/yellow/orange/blue, red/orange/green/purple, and every other combination -- and ruled:
 * "There does not seem to be a standard. We can pick any pleasing combination, as long as the colors
 * are different enough that nobody needs to squint." So distinctness is the whole specification, and
 * this palette is ours rather than anyone's convention.
 *
 * Chosen for separation in hue AND in lightness, so the rows remain distinguishable to a viewer with
 * anomalous color vision and against both the pale and the dark 3D backgrounds. Muted rather than
 * saturated, to sit with `systemColour`'s anatomical register instead of shouting over it.
 */
export const LEVEL_PALETTE: [number, number, number][] = [
  [ 94, 143, 186],   // slate blue
  [206, 133,  84],   // ochre
  [124, 168, 122],   // sage
  [176, 106, 148],   // mauve
  [ 92, 160, 164],   // teal
  [206, 176,  94],   // wheat
  [140, 122, 186],   // periwinkle
  [196, 112, 104],   // clay
  [110, 146, 106],   // olive
  [166, 148, 196],   // lilac
  [ 96, 130, 140],   // stone blue
  [188, 152, 128],   // sand
];

/** The color a collapsed branch shows, from its position among its siblings. */
export function levelColour(indexAmongSiblings: number): [number, number, number] {
  const p = LEVEL_PALETTE[((indexAmongSiblings % LEVEL_PALETTE.length) + LEVEL_PALETTE.length) % LEVEL_PALETTE.length];
  return [p[0], p[1], p[2]];
}

/** The shape this needs from a tree node: children, an id, and a label value if it is a leaf. */
export interface ColourNode {
  id: string;
  labelValue?: number;
  color?: [number, number, number];
  children: ColourNode[];
}

/**
 * What color each label value should be drawn in, given which branches are collapsed.
 *
 * A leaf under a collapsed ancestor takes that ancestor's color; everything else keeps its own. The
 * NEAREST collapsed ancestor wins, so collapsing the frontal lobe colors its gyri by lobe, and
 * collapsing the hemisphere above it recolours them again by hemisphere -- which is the movement Ron
 * described, in one rule.
 *
 * Returns only what differs from the segment's own color, so a fully expanded tree returns nothing
 * and costs nothing.
 */
export function colourOverrides(
  roots: readonly ColourNode[],
  collapsed: ReadonlySet<string>,
): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();

  const paint = (n: ColourNode, colour: [number, number, number]) => {
    if (n.labelValue !== undefined) out.set(n.labelValue, colour);
    for (const c of n.children) paint(c, colour);
  };

  const walk = (nodes: readonly ColourNode[]) => {
    nodes.forEach((n, i) => {
      // A collapsed node with children is a branch standing in for what it hides. A collapsed LEAF
      // hides nothing, so it keeps its own color -- otherwise a childless row would change color
      // for no reason a reader could see.
      if (collapsed.has(n.id) && n.children.length) paint(n, levelColour(i));
      else walk(n.children);
    });
  };
  walk(roots);
  return out;
}
