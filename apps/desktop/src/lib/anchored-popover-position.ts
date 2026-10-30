export interface AnchorEdges {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface AnchoredPopoverPosition {
  bottom?: number;
  left: number;
  maxHeight: number;
  position: "fixed";
  top?: number;
  width: number;
}

interface Options {
  align?: "start" | "end";
  gap?: number;
  gutter?: number;
  minimumHeight?: number;
  placement?: "top" | "bottom";
  preferredWidth: number;
}

/** Pure viewport collision model shared by compact fixed popovers. */
export function anchoredPopoverPosition(
  anchor: AnchorEdges,
  viewportWidth: number,
  viewportHeight: number,
  {
    align = "start",
    gap = 6,
    gutter = 8,
    minimumHeight = 160,
    placement = "bottom",
    preferredWidth,
  }: Options,
): AnchoredPopoverPosition {
  const safeWidth = Math.max(0, viewportWidth);
  const safeHeight = Math.max(0, viewportHeight);
  const horizontalGutter = Math.min(gutter, safeWidth / 2);
  const verticalGutter = Math.min(gutter, safeHeight / 2);
  const width = Math.max(
    0,
    Math.min(preferredWidth, safeWidth - horizontalGutter * 2),
  );
  const preferredLeft = align === "end" ? anchor.right - width : anchor.left;
  const left = Math.max(
    horizontalGutter,
    Math.min(preferredLeft, safeWidth - width - horizontalGutter),
  );
  const below = Math.max(
    0,
    safeHeight - anchor.bottom - gap - verticalGutter,
  );
  const above = Math.max(0, anchor.top - gap - verticalGutter);
  const minimum = Math.min(
    minimumHeight,
    Math.max(0, safeHeight - verticalGutter * 2),
  );
  const placeBelow =
    placement === "top"
      ? !(above >= minimum || above >= below)
      : below >= minimum || below >= above;
  if (placeBelow) {
    return {
      left,
      maxHeight: below,
      position: "fixed",
      top: Math.min(anchor.bottom + gap, safeHeight - verticalGutter),
      width,
    };
  }
  return {
    bottom: Math.min(
      safeHeight - anchor.top + gap,
      safeHeight - verticalGutter,
    ),
    left,
    maxHeight: above,
    position: "fixed",
    width,
  };
}
