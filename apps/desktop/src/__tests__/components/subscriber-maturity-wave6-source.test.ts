import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The production inventory is an ESM audit script rather than a typed module.
// @ts-expect-error -- exercised directly so this wave covers both inventories.
import { inventorySummary } from "../../../scripts/interactive-title-inventory.mjs";

const SCOPED_FILES = [
  "components/subscribers/ScoringRulesCard.tsx",
  "components/subscribers/SunsetPoliciesCard.tsx",
  "components/subscribers/SubscriberInsightsPanel.tsx",
  "components/subscribers/SubscriberProfilePanel.tsx",
  "components/subscribers/SubscriberListsPanel.tsx",
  "components/subscriber/SubscriberCustomObjectLinks.tsx",
] as const;

interface InventoryFinding {
  file: string;
}

describe("subscriber maturity wave 6 source contract", () => {
  it("keeps both interactive and passive native-title inventories at zero", () => {
    const summary = inventorySummary() as {
      findings: InventoryFinding[];
      nonInteractiveFindings: InventoryFinding[];
    };
    const scoped = (findings: InventoryFinding[]) =>
      findings.filter((finding) =>
        SCOPED_FILES.includes(finding.file as (typeof SCOPED_FILES)[number]),
      );

    expect(scoped(summary.findings)).toEqual([]);
    expect(scoped(summary.nonInteractiveFindings)).toEqual([]);
  });

  it("retains visible semantics, permission guidance, and race guards", () => {
    const contracts: Record<(typeof SCOPED_FILES)[number], string[]> = {
      "components/subscribers/ScoringRulesCard.tsx": [
        "version-bound",
        "aria-disabled",
        "savingRef",
        "useExistingSettingLifecycle",
      ],
      "components/subscribers/SunsetPoliciesCard.tsx": [
        "Execution history",
        "aria-controls",
        "formRequestRef",
      ],
      "components/subscribers/SubscriberInsightsPanel.tsx": [
        "Model confidence",
        "aria-describedby",
        "recomputeRequestInFlight",
      ],
      "components/subscribers/SubscriberProfilePanel.tsx": [
        "Resolution precedence",
        "Delete identity alias?",
        "operationRef",
      ],
      "components/subscribers/SubscriberListsPanel.tsx": [
        "Retry subscriber metadata",
        "Data classification",
        "inFlightRef",
      ],
      "components/subscriber/SubscriberCustomObjectLinks.tsx": [
        "External record ID",
        "Properties (",
        "requestGenerationRef",
      ],
    };

    for (const [file, tokens] of Object.entries(contracts)) {
      const source = readFileSync(`${process.cwd()}/src/${file}`, "utf8");
      tokens.forEach((token) => expect(source).toContain(token));
    }
  });
});
