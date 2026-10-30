import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DESKTOP_DRAG_ALTERNATIVES } from "../../lib/desktop-drag-alternatives";

const SRC_ROOT = resolve(import.meta.dirname, "../..");

function productionTsxFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...productionTsxFiles(path));
    else if (extname(entry.name) === ".tsx") files.push(path);
  }
  return files;
}

function source(owner: string): string {
  return readFileSync(resolve(SRC_ROOT, owner), "utf8");
}

describe("DUX-026 drag alternatives", () => {
  it("accounts for every production app-owned drag/drop event owner", () => {
    const discovered = productionTsxFiles(SRC_ROOT)
      .filter((path) =>
        /onDrag(?:Start|Enter)\s*=|onDrop\s*=/.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(SRC_ROOT, path))
      .sort();
    const accounted = [
      ...new Set(
        DESKTOP_DRAG_ALTERNATIVES.flatMap((contract) => contract.owners),
      ),
    ].sort();
    expect(accounted).toEqual(discovered);
  });

  it("keeps stable IDs, task copy, and source-pinned non-drag evidence", () => {
    expect(new Set(DESKTOP_DRAG_ALTERNATIVES.map(({ id }) => id)).size).toBe(
      DESKTOP_DRAG_ALTERNATIVES.length,
    );
    for (const contract of DESKTOP_DRAG_ALTERNATIVES) {
      expect(contract.pointerAction.length).toBeGreaterThan(12);
      expect(contract.nonDragAction.length).toBeGreaterThan(12);
      const ownerSource = [
        ...contract.owners,
        ...("evidenceOwners" in contract ? contract.evidenceOwners : []),
      ]
        .map(source)
        .join("\n");
      for (const token of contract.evidenceTokens) {
        expect(ownerSource, `${contract.id} is missing ${token}`).toContain(
          token,
        );
      }
    }
  });
});
