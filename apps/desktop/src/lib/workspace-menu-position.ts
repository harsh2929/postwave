export interface WorkspaceMenuAnchorBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

export interface WorkspaceMenuPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

const VIEWPORT_GUTTER = 8;
const COMPACT_SIDEBAR_MAX = 159;
const COMPACT_MENU_WIDTH = 300;
const MIN_MENU_HEIGHT = 96;

export function workspaceMenuPosition(
  anchor: WorkspaceMenuAnchorBox,
  viewportWidth: number,
  viewportHeight: number,
): WorkspaceMenuPosition {
  const safeWidth = Math.max(VIEWPORT_GUTTER * 2, viewportWidth);
  const safeHeight = Math.max(
    MIN_MENU_HEIGHT + VIEWPORT_GUTTER * 2,
    viewportHeight,
  );
  const compact = anchor.width <= COMPACT_SIDEBAR_MAX || viewportWidth <= 1000;
  const preferredWidth = compact
    ? COMPACT_MENU_WIDTH
    : Math.max(200, anchor.width - VIEWPORT_GUTTER * 2);
  const width = Math.min(preferredWidth, safeWidth - VIEWPORT_GUTTER * 2);
  const preferredLeft = compact
    ? anchor.right + VIEWPORT_GUTTER
    : anchor.left + VIEWPORT_GUTTER;
  const left = Math.max(
    VIEWPORT_GUTTER,
    Math.min(preferredLeft, safeWidth - width - VIEWPORT_GUTTER),
  );
  const preferredTop = compact ? anchor.top : anchor.bottom + 4;
  const top = Math.max(
    VIEWPORT_GUTTER,
    Math.min(preferredTop, safeHeight - MIN_MENU_HEIGHT - VIEWPORT_GUTTER),
  );
  return {
    left,
    maxHeight: Math.max(MIN_MENU_HEIGHT, safeHeight - top - VIEWPORT_GUTTER),
    top,
    width,
  };
}
