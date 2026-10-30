import { describe, expect, it } from "vitest";

import { workspaceMenuPosition } from "../../lib/workspace-menu-position";

describe("workspaceMenuPosition", () => {
  it("opens beside a collapsed sidebar instead of shrinking to its width", () => {
    expect(
      workspaceMenuPosition(
        { left: 0, right: 64, top: 28, bottom: 76, width: 64 },
        880,
        560,
      ),
    ).toEqual({ left: 72, top: 28, width: 300, maxHeight: 524 });
  });

  it("clamps every edge inside the minimum high-zoom layout proxy", () => {
    const position = workspaceMenuPosition(
      { left: 0, right: 64, top: 250, bottom: 298, width: 64 },
      440,
      280,
    );
    expect(position).toEqual({ left: 72, top: 176, width: 300, maxHeight: 96 });
    expect(position.left + position.width).toBeLessThanOrEqual(432);
  });

  it("keeps the expanded menu aligned to the workspace tile", () => {
    expect(
      workspaceMenuPosition(
        { left: 0, right: 240, top: 28, bottom: 76, width: 240 },
        1280,
        720,
      ),
    ).toEqual({ left: 8, top: 80, width: 224, maxHeight: 632 });
  });
});
