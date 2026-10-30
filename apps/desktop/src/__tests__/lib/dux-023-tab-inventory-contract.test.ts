import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");
const PARTICIPANTS_OWNER = "components/sequence/SequenceParticipantsDrawer.tsx";

function productionTsxFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionTsxFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function displayPath(path: string): string {
  return relative(SOURCE_ROOT, path);
}

describe("DUX-023 production tab inventory", () => {
  it("keeps production free of bespoke literal tab roles", () => {
    const owners = productionTsxFiles()
      .filter((path) => {
        const openingTags = readFileSync(path, "utf8").match(
          /<[A-Za-z][A-Za-z0-9.]*\b[^>]*>/gsu,
        );
        return openingTags?.some((tag) =>
          /\brole=["']tab(?:list|panel)?["']/u.test(tag),
        );
      })
      .map(displayPath);
    expect(owners).toEqual([]);
  });

  it("requires every shared tab owner to expose panels and a named tablist", () => {
    const violations: string[] = [];
    for (const path of productionTsxFiles()) {
      const contents = readFileSync(path, "utf8");
      if (!contents.includes(".getTabProps(")) continue;
      if (!contents.includes(".getPanelProps(")) {
        violations.push(`${displayPath(path)}: missing panel relationship`);
      }
      const listTags = contents.match(
        /<[A-Za-z][A-Za-z0-9.]*\b[^>]*\{\.\.\.[A-Za-z0-9_.]+\.listProps\}[^>]*>/gsu,
      );
      if (!listTags || listTags.length === 0) {
        violations.push(`${displayPath(path)}: missing shared tablist owner`);
        continue;
      }
      for (const tag of listTags) {
        if (!/aria-(?:label|labelledby)=/u.test(tag)) {
          violations.push(`${displayPath(path)}: unnamed tablist`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("pins the participant drawer to the shared APG relationship", () => {
    const contents = readFileSync(
      resolve(SOURCE_ROOT, PARTICIPANTS_OWNER),
      "utf8",
    );
    expect(contents).toContain("useTabsInteraction<SequenceParticipantsView>");
    expect(contents).toContain("tabs.listProps");
    expect(contents).toContain("tabs.getTabProps(value)");
    expect(contents).toContain("tabs.getPanelProps(value)");
    expect(contents).not.toMatch(/role=["']tab(?:list|panel)?["']/u);
  });
});
