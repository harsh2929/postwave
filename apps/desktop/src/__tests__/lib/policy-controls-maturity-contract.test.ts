import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "src/pages/referrals/ProgramEditor.tsx",
  "src/components/composer/SendWindowPolicyModal.tsx",
  "src/components/composer/UTMTemplatesView.tsx",
  "src/components/experiments/ControlGroupsCard.tsx",
  "src/components/settings/ApprovalChainSection.tsx",
  "src/components/sms/SmsKeywordResponsesCard.tsx",
] as const;

function intrinsicTitles(path: string): string[] {
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
        /^[a-z]/u.test(tag) &&
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

function source(path: (typeof OWNERS)[number]): string {
  return readFileSync(path, "utf8");
}

describe("policy-control maturity source contract", () => {
  it("keeps every scoped native element free of intrinsic title attributes", () => {
    expect(OWNERS.flatMap(intrinsicTitles)).toEqual([]);
  });

  it("retains visible permission and boundary semantics", () => {
    for (const path of [
      OWNERS[0],
      OWNERS[1],
      OWNERS[2],
      OWNERS[3],
      OWNERS[5],
    ]) {
      expect(source(path), path).toContain("aria-disabled");
    }
    expect(source(OWNERS[0])).toContain(
      "Referral program administration is restricted to workspace admins",
    );
    expect(source(OWNERS[1])).toContain("Read-only send window");
    expect(source(OWNERS[2])).toContain("templatesGateTitle");
    expect(source(OWNERS[3])).toContain("Viewer access is read-only");
    expect(source(OWNERS[5])).toContain("Viewer access is read-only");
  });

  it("holds the approval-chain surface without editable controls", () => {
    expect(source(OWNERS[4])).toContain(
      "Multi-stage approvals are on release hold",
    );
    expect(source(OWNERS[4])).not.toMatch(
      /<(?:button|input|select|textarea)\b/u,
    );
  });

  it("retains IME guards and honest provider or destructive consequences", () => {
    for (const path of [OWNERS[0], OWNERS[1], OWNERS[3], OWNERS[5]]) {
      const contents = source(path);
      expect(contents, path).toContain("isComposing");
      expect(contents, path).toContain("keyCode === 229");
    }
    expect(source(OWNERS[1])).toContain(
      "Removing it makes campaigns sendable at any time of day",
    );
    expect(source(OWNERS[3])).toContain("typeToConfirm={deleteTarget?.name}");
    expect(source(OWNERS[5])).toContain(
      "Hosted callbacks and automatic confirmation dispatch remain release-held",
    );
    expect(source(OWNERS[5])).toContain(
      "typeToConfirm={deleteTarget?.keyword}",
    );
  });
});
