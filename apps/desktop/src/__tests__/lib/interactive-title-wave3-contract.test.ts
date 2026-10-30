import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "pages/Suppressions.tsx",
  "components/forms/GrowthPanel.tsx",
  "components/subscribers/SubscriberNaturalLanguageSegmentPanel.tsx",
  "pages/audit/AuditPageHeader.tsx",
  "pages/InboundRoutes.tsx",
  "components/subscribers/SubscriberNotesPanel.tsx",
] as const;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "option",
  "select",
  "summary",
  "textarea",
]);

type Owner = (typeof OWNERS)[number];

function source(path: Owner): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function interactiveTitles(path: Owner): number[] {
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
      const attributes = node.attributes.properties;
      const interactive =
        INTERACTIVE_TAGS.has(node.tagName.getText(file)) ||
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

describe("interactive title remediation wave 3", () => {
  it("keeps all six owners free of native interactive title attributes", () => {
    for (const owner of OWNERS) expect(interactiveTitles(owner)).toEqual([]);
  });

  it("keeps unavailable actions focusable, described, and guarded", () => {
    for (const owner of OWNERS) {
      const contents = source(owner);
      if (owner === "pages/audit/AuditPageHeader.tsx") {
        expect(contents).not.toContain("openInvestigations");
        expect(contents).not.toContain("exportCsv");
        expect(contents).toContain("AuditReleaseHolds");
        continue;
      }
      expect(contents, owner).toContain("pw-discoverable-unavailable");
      expect(contents, owner).toContain("aria-disabled");
      expect(contents, owner).toContain("aria-describedby");
    }

    expect(source("pages/Suppressions.tsx")).toContain(
      "if (canMutate) mutations.openAdd()",
    );
    expect(source("components/forms/GrowthPanel.tsx")).toContain(
      "if (draft.variants.length >= MAX_EXPERIMENT_VARIANTS) return",
    );
    expect(
      source(
        "components/subscribers/SubscriberNaturalLanguageSegmentPanel.tsx",
      ),
    ).toContain("!canMutate ||");
    expect(source("pages/audit/AuditPageHeader.tsx")).not.toContain(
      "openInvestigations",
    );
    expect(source("pages/InboundRoutes.tsx")).toContain(
      "if (!cannotMoveUp) onMoveUp()",
    );
    expect(source("components/subscribers/SubscriberNotesPanel.tsx")).toContain(
      "if (canEditNotes) void onTogglePin(note)",
    );
  });

  it("owns same-tick async work and exposes retryable failure states", () => {
    const audit = source("pages/audit/AuditPageHeader.tsx");
    const inbound = source("pages/InboundRoutes.tsx");
    const naturalLanguage = source(
      "components/subscribers/SubscriberNaturalLanguageSegmentPanel.tsx",
    );
    const notes = source("components/subscribers/SubscriberNotesPanel.tsx");

    expect(audit).not.toContain("exportBusyRef.current");
    expect(audit).toContain("data.load()");
    expect(inbound).toContain("busyRef.current");
    expect(naturalLanguage).toContain("compileBusyRef.current");
    expect(naturalLanguage).toContain("saveBusyRef.current");
    expect(notes).toContain("inFlightRef.current");
    expect(notes).toContain("reloadNotes={loadNotes}");
    expect(notes).toContain("Check your connection and try again");
  });
});
