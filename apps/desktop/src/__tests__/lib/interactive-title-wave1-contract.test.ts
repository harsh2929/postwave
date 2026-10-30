import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "components/AuditEventSlideover.tsx",
  "components/archive/ArchivePageContent.tsx",
  "pages/Archive.tsx",
  "pages/Discounts.tsx",
] as const;

const TAG_OWNERS = [
  "components/PageHeader.tsx",
  "pages/tags/TagCatalog.tsx",
  "pages/tags/TagFormModals.tsx",
  "pages/tags/TagOverlays.tsx",
  "pages/tags/TagPageChrome.tsx",
  "pages/tags/TagPaletteField.tsx",
  "pages/tags/TagsPageView.tsx",
] as const;

const INTERACTIVE_OWNERS = [...OWNERS, ...TAG_OWNERS] as const;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "option",
  "select",
  "summary",
  "textarea",
]);

function source(path: (typeof INTERACTIVE_OWNERS)[number]): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function interactiveTitles(
  path: (typeof INTERACTIVE_OWNERS)[number],
): number[] {
  const contents = source(path);
  const file = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      const attributes = node.attributes.properties;
      const interactive =
        INTERACTIVE_TAGS.has(tag) ||
        attributes.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            ["onClick", "onKeyDown", "onKeyUp", "tabIndex"].includes(
              attribute.name.getText(file),
            ),
        );
      const title = attributes.find(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(file) === "title",
      );
      if (interactive && title) {
        lines.push(
          file.getLineAndCharacterOfPosition(title.getStart()).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("interactive title remediation wave 1", () => {
  it("keeps every interaction owner free of native title attributes", () => {
    for (const owner of INTERACTIVE_OWNERS) {
      expect(interactiveTitles(owner)).toEqual([]);
    }
  });

  it("keeps unavailable reasons visible, referenced, and activation guarded", () => {
    const audit = source("components/AuditEventSlideover.tsx");
    const archive = [
      source("pages/Archive.tsx"),
      source("components/archive/ArchivePageContent.tsx"),
    ].join("\n");
    const tags = TAG_OWNERS.map((path) => source(path)).join("\n");

    for (const contents of [audit, archive, tags]) {
      expect(contents).toContain("pw-discoverable-unavailable");
      expect(contents).toContain("aria-disabled");
      expect(contents).toContain("aria-describedby");
    }
    expect(archive).toContain("if (publicUrl) onOpenUrl(publicUrl)");
    expect(tags).toContain("if (action.disabled)");
    expect(audit).toContain("if (navigationDraftReason) return");
  });

  it("owns same-tick work and uses native-radio colour choices", () => {
    const audit = source("components/AuditEventSlideover.tsx");
    const archive = source("pages/Archive.tsx");
    const tags = TAG_OWNERS.map((path) => source(path)).join("\n");

    expect(audit).toContain("audit-event-proof-${row.id}");
    expect(audit).toContain("audit-aivs-bundle-${sessionId}");
    expect(archive).toContain('ownerId: "archive-list-pin"');
    expect(tags.match(/<ChoiceGroup/gu)?.length).toBeGreaterThanOrEqual(2);
  });
});
