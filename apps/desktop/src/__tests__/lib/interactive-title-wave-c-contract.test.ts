import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const OWNERS = [
  "components/composer/ContentOptimizerCard.tsx",
  "components/composer/ContentRemixCard.tsx",
  "components/composer/FromNameSuggestions.tsx",
  "components/composer/HoldoutCard.tsx",
  "components/hipaa/BYOKKeysPanel.tsx",
  "components/sequence/SequenceSettingsCard.tsx",
  "components/sequence/SequenceStatusControl.tsx",
  "components/sequence/SequenceTriggerCard.tsx",
  "components/sequence/StepPalette.tsx",
  "components/settings/ExportRetentionSection.tsx",
  "components/settings/FirewallSection.tsx",
  "components/sms/ReplyComposer.tsx",
  "components/sms/SmsA2PRegistrationCard.tsx",
  "components/sms/SmsQuietHoursCard.tsx",
  "pages/Sequences.tsx",
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

const ACTION_OWNERS = OWNERS.filter(
  (owner) => owner !== "components/sms/SmsA2PRegistrationCard.tsx",
);

function source(path: Owner): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function interactiveTitleLines(path: Owner): number[] {
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
      if (
        interactive &&
        attributes.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(file) === "title",
        )
      ) {
        lines.push(
          file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("interactive title remediation wave C", () => {
  it("keeps every scoped owner free of intrinsic interactive titles", () => {
    for (const owner of OWNERS) {
      expect(interactiveTitleLines(owner), owner).toEqual([]);
    }
  });

  it("keeps blocked actions focusable, explicitly described, and guarded", () => {
    for (const owner of ACTION_OWNERS) {
      const contents = source(owner);
      expect(contents, owner).toContain("aria-disabled");
      expect(contents, owner).toContain("aria-describedby");
    }
    expect(source("components/sequence/SequenceTriggerCard.tsx")).toContain(
      "if (canMutate && runtimeAvailable) onEdit();",
    );
    expect(source("components/sequence/StepPalette.tsx")).toContain(
      "if (!isDisabled) onAdd(tile.type);",
    );
    expect(source("pages/Sequences.tsx")).toContain(
      "if (!createUnavailableReason) create.openCreate();",
    );
  });

  it("keeps A2P registration structurally release-held", () => {
    const a2p = source("components/sms/SmsA2PRegistrationCard.tsx");
    expect(a2p).toContain("sms_a2p_registration_release_held");
    expect(a2p).toContain(
      "No sender read, brand submission, campaign submission, or provider",
    );
    expect(a2p).not.toMatch(/<(?:button|input|select|textarea|form)\b/u);
  });

  it("owns same-tick async work before React can commit busy state", () => {
    expect(source("components/composer/ContentOptimizerCard.tsx")).toContain(
      "startInFlightRef.current",
    );
    expect(source("components/composer/ContentRemixCard.tsx")).toContain(
      "remixInFlightRef.current",
    );
    expect(source("components/composer/HoldoutCard.tsx")).toContain(
      "mutationInFlightRef.current",
    );
    expect(source("components/sms/ReplyComposer.tsx")).toContain(
      "sendInFlightRef.current",
    );
    const a2p = source("components/sms/SmsA2PRegistrationCard.tsx");
    expect(a2p).not.toContain("registrationOperationRef.current");
    expect(a2p).not.toContain("submitA2PBrandRegistration");
    expect(a2p).not.toContain("submitA2PCampaignRegistration");
    expect(a2p).not.toContain("pollA2PRegistration");
    expect(source("components/sms/SmsQuietHoursCard.tsx")).toContain(
      "operationInFlightRef.current",
    );
    expect(source("components/hipaa/BYOKKeysPanel.tsx")).toContain(
      "operationRef.current",
    );
  });
});
