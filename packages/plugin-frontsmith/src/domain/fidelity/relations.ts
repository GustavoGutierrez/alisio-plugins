import type { Box } from "./geometry.js";

const right = (box: Box): number => box.x + box.width;
const bottom = (box: Box): number => box.y + box.height;

export type RelationProperty =
  | "gapVertical"
  | "gapHorizontal"
  | "alignLeft"
  | "alignTop"
  | "alignRight"
  | "sameWidth";

/**
 * The measured value of a spatial relation between two boxes (FID 15.4): `gapVertical` is
 * `top(B) - bottom(A)`, `gapHorizontal` is `left(B) - right(A)`, an alignment is the signed distance
 * of the two edges and `sameWidth` the width difference. `columns` is measured by the probe.
 */
export function relationValue(property: RelationProperty, a: Box, b: Box): number {
  switch (property) {
    case "gapVertical":
      return b.y - bottom(a);
    case "gapHorizontal":
      return b.x - right(a);
    case "alignLeft":
      return a.x - b.x;
    case "alignTop":
      return a.y - b.y;
    case "alignRight":
      return right(a) - right(b);
    case "sameWidth":
      return a.width - b.width;
  }
}
