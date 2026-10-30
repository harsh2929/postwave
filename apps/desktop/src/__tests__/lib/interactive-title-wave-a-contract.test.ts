import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "components/automations/OmnichannelSection.tsx",
  "components/automations/TriggerDetailSlideover.tsx",
  "components/dataplatform/ReverseETLSection.tsx",
  "components/dataplatform/StreamingExportForm.tsx",
  "components/dataplatform/StreamingExportStatus.tsx",
  "components/deliverability/EqScoreLookupCard.tsx",
  "components/deliverability/FrequencyCapsCard.tsx",
  "components/deliverability/IntelligentRetryCard.tsx",
  "components/deliverability/ScoreCard.tsx",
  "components/deliverability/SoftBounceRecoveryCard.tsx",
  "components/deliverability/SpamTrapGuardCard.tsx",
  "components/forms/EmbedPreviewCard.tsx",
  "components/forms/FormFieldsEditor.tsx",
  "components/forms/SubmissionsAnalytics.tsx",
  "components/forms/VariantsPanel.tsx",
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

describe("interactive title remediation wave A", () => {
  it("keeps every owned surface free of native interactive title attributes", () => {
    for (const owner of OWNERS) {
      expect(interactiveTitles(owner), owner).toEqual([]);
    }
  });

  it("keeps unavailable actions focusable, described, and click-guarded", () => {
    for (const owner of OWNERS) {
      const contents = source(owner);
      expect(contents, owner).toContain("aria-disabled");
      expect(contents, owner).toContain("aria-describedby");
    }

    expect(source("components/automations/OmnichannelSection.tsx")).toContain(
      "if (!OMNICHANNEL_DRAFT_CREATION_AVAILABLE) return",
    );
    expect(source("components/forms/EmbedPreviewCard.tsx")).toContain(
      "if (archived) return",
    );
    expect(source("components/forms/FormFieldsEditor.tsx")).toContain(
      "if (moveUpUnavailable) return",
    );
    expect(source("components/deliverability/FrequencyCapsCard.tsx")).toContain(
      "if (!canMutate) return",
    );
  });

  it("owns same-tick async work instead of trusting delayed render state", () => {
    expect(source("components/dataplatform/ReverseETLSection.tsx")).toContain(
      "operation.promiseRef.current",
    );
    expect(
      source("components/dataplatform/StreamingExportStatus.tsx"),
    ).toContain("operation.promiseRef.current");
    expect(source("components/deliverability/EqScoreLookupCard.tsx")).toContain(
      "scoreInFlightRef.current",
    );
    expect(
      source("components/deliverability/IntelligentRetryCard.tsx"),
    ).toContain("actionInFlightRef.current");
    expect(source("components/forms/SubmissionsAnalytics.tsx")).toContain(
      "exportingRef.current",
    );
    expect(source("components/forms/VariantsPanel.tsx")).toContain(
      "mutation.promiseRef.current",
    );
  });

  it("keeps form preview rendering local, sandboxed, and referrer-free", () => {
    const preview = source("components/forms/EmbedPreviewCard.tsx");
    expect(preview).toContain('import QRCode from "qrcode"');
    expect(preview).toContain("QRCode.toDataURL(publicUrl");
    expect(preview).not.toContain("api.qrserver.com");
    expect(preview).toContain('sandbox="allow-forms allow-scripts"');
    expect(preview).not.toContain("allow-same-origin");
    expect(preview).toContain('referrerPolicy="no-referrer"');
  });
});
