import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");

const REVIEWED_MENU_OWNERS = [
  "components/AccountMenu.tsx",
  "components/WorkspaceMenu.tsx",
  "components/analytics/ChartActions.tsx",
  "components/analytics/ExportMenu.tsx",
  "components/analytics/GroupByMenu.tsx",
  "components/sequence/SequenceStatusControl.tsx",
  "components/sms/SnoozePicker.tsx",
  "components/subscribers/ColumnPicker.tsx",
  "components/subscribers/SubscribersSavedSegmentsMenu.tsx",
] as const;

const EXTERNAL_TRIGGER_OWNERS: Partial<
  Record<(typeof REVIEWED_MENU_OWNERS)[number], string>
> = {
  "components/AccountMenu.tsx": "components/TopBar.tsx",
  "components/WorkspaceMenu.tsx": "components/Sidebar.tsx",
};

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

function openingTagsWithRole(contents: string, role: string): string[] {
  const tags = contents.match(/<[A-Za-z][A-Za-z0-9.]*\b[^>]*>/gsu) ?? [];
  const rolePattern = new RegExp(`role=["']${role}["']`, "u");
  return tags.filter((tag) => rolePattern.test(tag));
}

describe("DUX-023 production menu inventory", () => {
  it("keeps the semantic-menu owner set explicit and reviewed", () => {
    const owners = productionTsxFiles()
      .filter(
        (path) =>
          openingTagsWithRole(readFileSync(path, "utf8"), "menu").length > 0,
      )
      .map(displayPath)
      .sort();

    expect(owners).toEqual([...REVIEWED_MENU_OWNERS].sort());
  });

  it("requires every semantic menu to use the shared interaction contract", () => {
    const violations: string[] = [];
    for (const relativePath of REVIEWED_MENU_OWNERS) {
      const contents = readFileSync(resolve(SOURCE_ROOT, relativePath), "utf8");
      const externalTriggerOwner = EXTERNAL_TRIGGER_OWNERS[relativePath];
      const triggerContents = externalTriggerOwner
        ? readFileSync(resolve(SOURCE_ROOT, externalTriggerOwner), "utf8")
        : contents;
      if (!contents.includes("useMenuInteraction")) {
        violations.push(`${relativePath}: missing shared menu behavior`);
      }
      for (const tag of openingTagsWithRole(contents, "menu")) {
        if (!/aria-(?:label|labelledby)=/u.test(tag)) {
          violations.push(`${relativePath}: unnamed menu popup`);
        }
      }
      if (!/aria-haspopup=["']menu["']/u.test(triggerContents)) {
        violations.push(`${relativePath}: trigger does not expose menu popup`);
      }
      if (!triggerContents.includes("aria-expanded")) {
        violations.push(
          `${relativePath}: trigger does not expose expanded state`,
        );
      }
      if (!triggerContents.includes("aria-controls")) {
        violations.push(`${relativePath}: trigger is not related to its popup`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("gives every menu item an explicit roving-focus position", () => {
    const violations: string[] = [];
    for (const relativePath of REVIEWED_MENU_OWNERS) {
      const contents = readFileSync(resolve(SOURCE_ROOT, relativePath), "utf8");
      for (const role of ["menuitem", "menuitemcheckbox", "menuitemradio"]) {
        for (const tag of openingTagsWithRole(contents, role)) {
          if (!tag.includes("tabIndex=")) {
            violations.push(
              `${relativePath}: ${role} has implicit Tab behavior`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
