import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "src/components/segments/SavedSegmentsManagerView.tsx",
  "src/components/subscribers/SubscribersBrowsePanel.tsx",
  "src/pages/Forms.tsx",
  "src/components/analytics/ReportBuilderSection.tsx",
  "src/components/feedsources/FeedSourcesSection.tsx",
  "src/components/settings/ApiKeysSection.tsx",
] as const;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

function interactiveTitles(path: string): string[] {
  const sourceText = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (
        INTERACTIVE_TAGS.has(tag) &&
        node.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(sourceFile) === "title",
        )
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(),
        );
        findings.push(`${path}:${line + 1}:${tag}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

describe("interactive-title wave 4 source contract", () => {
  it("keeps all six scoped production owners free of intrinsic title-only interactions", () => {
    expect(OWNERS.flatMap(interactiveTitles)).toEqual([]);
  });

  it("removes the three scoped legacy function-quality exceptions", () => {
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    for (const path of [
      "src/components/feedsources/FeedSourcesSection.tsx",
      "src/components/settings/ApiKeysSection.tsx",
      "src/pages/Forms.tsx",
    ]) {
      expect(budgets).not.toContain(`\"${path}\"`);
    }
  });
});
