import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}

describe("DUX-023 Library composite source contract", () => {
  it("uses native collections instead of contradictory listboxes", () => {
    const grid = source("components/library/LibraryGrid.tsx");
    const list = source("components/library/LibraryList.tsx");
    for (const owner of [grid, list]) {
      expect(owner).not.toContain('role="listbox"');
      expect(owner).not.toContain('role="option"');
      expect(owner).not.toMatch(/onContextMenu|preventDefault\(\).*context/iu);
      expect(owner).toContain("data-library-primary");
      expect(owner).toContain('event.key === " "');
      expect(owner).toContain('event.key === "Enter"');
      expect(owner).toContain('event.key === "Home" || event.key === "End"');
    }
    expect(grid).toContain("<ul");
    expect(list).toContain("<table");
    expect(list).toContain('<th scope="col">Actions</th>');
  });

  it("renders real sibling actions and no nested interactive tile", () => {
    const tile = source("components/library/LibraryTile.tsx");
    expect(tile).toContain('<li className={classes.join(" ")}');
    expect(tile).toContain('className="lib-tile-target"');
    expect(tile).toContain('className="lib-tile-actions"');
    expect(tile).not.toContain('role="button"');
    expect(tile).not.toContain("actionSpan");
    expect(tile.indexOf('className="lib-tile-actions"')).toBeGreaterThan(
      tile.indexOf("</button>"),
    );
  });

  it("wires lawful actions in both views and retains compact/forced-color CSS", () => {
    const assets = source("pages/Assets.tsx");
    expect(
      assets.match(/onCopyUrl=\{\(id\) => void onTileCopyUrl\(id\)\}/gu),
    ).toHaveLength(1);
    expect(assets.match(/onCopyUrl=\{onCopyUrl\}/gu)).toHaveLength(2);
    expect(
      assets.match(/onDelete=\{canMutate \? onTileDelete : undefined\}/gu),
    ).toHaveLength(1);
    expect(assets.match(/onDelete=\{onDelete\}/gu)).toHaveLength(2);
    expect(assets).not.toContain("TODO future: context menu");
    expect(assets).toContain("const closeQuickLook = useCallback");
    expect(assets).toContain("onClose={closeQuickLook}");
    expect(assets).toContain('`[data-library-primary="${escaped}"]`');
    const styles = source("styles-assets.css");
    expect(styles).toContain(".lib-tile:focus-within .lib-tile-actions");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
