import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("DUX-023 semantic choice and tab source contract", () => {
  it("uses ChoiceGroup only for immediate form, filter, branch, and view choices", () => {
    const choiceOwners = [
      "components/DynamicContentPanel.tsx",
      "components/suppressions/BulkImportSuppressionsModal.tsx",
      "components/AudienceDestinationModal.tsx",
      "components/sequence/SequenceTriggerEditor.tsx",
      "pages/campaigns/CampaignsTopPanels.tsx",
    ];
    for (const path of choiceOwners) {
      const value = source(path);
      expect(value, path).toContain("ChoiceGroup");
      expect(value, path).not.toContain('role="tablist"');
      expect(value, path).not.toContain('role="tab"');
    }

    const dynamic = source("components/DynamicContentPanel.tsx");
    expect(dynamic).toContain("This region has no {{else}} branch.");
    expect(dynamic).toContain("unavailable: true");

    const trigger = source("components/sequence/SequenceTriggerEditor.tsx");
    expect(trigger).toContain('value={pickedKind ?? ""}');
    expect(trigger).toContain('legend="Schedule mode"');
    expect(trigger).not.toContain('title="Stops new entries');

    const campaigns = source("pages/campaigns/CampaignsTopPanels.tsx");
    expect(campaigns).toContain('legend="Campaign status"');
    expect(campaigns).toContain('legend="Campaign view"');
    expect(campaigns).not.toContain("useTabsInteraction");
    expect(campaigns).not.toMatch(/title=\{?[^\n]*Press Enter/u);
  });

  it("keeps real sequence and subscriber panels on manual APG tabs", () => {
    const sequences = source("pages/Sequences.tsx");
    expect(sequences).toContain("useTabsInteraction<CreateMode>");
    expect(sequences).toContain('activation: "manual"');
    for (const panel of ["templates", "ai", "blank"]) {
      expect(sequences).toContain(`tabs.getPanelProps("${panel}")`);
    }
    expect(sequences).toContain('legend="Sequence template"');
    expect(sequences).not.toContain(
      "Keyword-match against the curated template library",
    );

    const subscriber = source(
      "components/subscribers/SubscriberDetailPresentation.tsx",
    );
    expect(subscriber).toContain("useTabsInteraction<SubscriberDetailTabId>");
    expect(subscriber).toContain('activation: "manual"');
    expect(subscriber).toContain("tabs.getPanelProps(item.id)");
    expect(subscriber).toContain("<SubscriberTabContent");
    expect(subscriber).toContain('active={data.tab === "profile"}');
    expect(subscriber).toContain('active={data.tab === "lists"}');
    expect(subscriber).toContain('active={data.tab === "notes"}');
    expect(subscriber).toContain('legend="Timeline channels"');
    expect(subscriber).not.toMatch(
      /title=\{[\s\S]{0,120}Cross-channel timeline isn't available/u,
    );
  });

  it("keeps provider and source changes explicit and draft-safe", () => {
    const audience = source("components/AudienceDestinationModal.tsx");
    expect(audience).toContain('legend="Audience platform"');
    expect(audience).toContain('legend="Source audience type"');
    expect(audience).toMatch(
      /onChange=\{\(nextProvider\)[\s\S]*setProvider\(nextProvider\)[\s\S]*setConfig\(\{\}\)/u,
    );
  });
});
