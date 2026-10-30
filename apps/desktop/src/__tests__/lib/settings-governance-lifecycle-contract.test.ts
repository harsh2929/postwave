import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("settings and governance lifecycle source contract", () => {
  it("keeps reusable owners instance-safe, deterministic, and action-safe", () => {
    const lifecycle = source("hooks/useSettingsDraftLifecycle.ts");
    const discardOnly = lifecycle.slice(
      lifecycle.indexOf("export function useDiscardOnlyDraftLifecycle"),
    );

    expect(lifecycle).toContain("useId()");
    expect(lifecycle).toContain("setting-draft-${ownerId}-${instanceId}");
    expect(lifecycle).toContain("action-draft-${ownerId}-${instanceId}");
    expect(lifecycle).toContain(
      "active-setting-operation-${options.ownerId}-${instanceId}",
    );
    expect(lifecycle).toContain("retainedOperationRefs.has(operationRef)");
    expect(lifecycle).toContain(
      'if (intent.disposition === "hide") return null',
    );
    expect(lifecycle).toContain(
      "if (dirtyRef.current && (await saveRef.current()))",
    );
    expect(lifecycle).toContain("dirtyRef.current = false");
    expect(discardOnly).not.toContain("prepare:");
    expect(lifecycle).toMatch(
      /source\.finally[\s\S]*promiseRef\.current = null[\s\S]*promiseRef\.current = tracked/u,
    );
  });

  it("keeps unsafe escalation and delegation controls release-held", () => {
    const approval = source("components/ApprovalSettings.tsx");

    expect(approval).toContain('data-testid="approval-settings-release-hold"');
    expect(approval).toContain("performs no approval-settings reads or writes");
    expect(approval).toMatch(/exposes\s+no configuration controls/u);
    expect(approval).not.toContain("api.");
    expect(approval).not.toContain("useExistingSettingLifecycle");
    expect(approval).not.toContain("useDiscardOnlyDraftLifecycle");
    expect(approval).not.toMatch(/<(?:button|input|select|textarea|form)\b/u);
  });

  it("covers firewall, the approval-chain hold, archive-domain, and field limits", () => {
    const firewall = source("components/settings/useFirewallController.ts");
    const chain = source("components/settings/ApprovalChainSection.tsx");
    const archive = source("components/settings/ArchiveDomainSection.tsx");
    const fields = source("components/settings/CustomFieldGovernance.tsx");

    expect(firewall).toContain('ownerId: "firewall-settings"');
    expect(firewall).toContain("serverRef.current");
    expect(firewall).toContain("return editsAfterRequest === null");
    expect(chain).toContain('data-settings-anchor="approval-chain"');
    expect(chain).toContain("performs no approval-chain reads or writes");
    expect(chain).not.toContain("getApprovalChain");
    expect(chain).not.toContain("setApprovalChain");
    expect(chain).not.toContain("useExistingSettingLifecycle");
    expect(archive).toContain('ownerId: "archive-domain"');
    expect(archive).toContain("domainBaselineRef.current = next");
    expect(archive).toMatch(
      /onSaveDomain[\s\S]*operation\.run[\s\S]*catch \(saveError\)[\s\S]*finally/u,
    );
    expect(fields).toContain('ownerId: "custom-field-governance"');
    expect(fields).toContain("discard: cancelEdit");
    expect(fields).toMatch(
      /customFieldSettingsApi\.update[\s\S]*setLimits\(res\.data\)[\s\S]*return true/u,
    );
  });

  it("never queues exports or feature flags from lifecycle Save", () => {
    const exports = source("components/settings/DataExportsSection.tsx");
    const flags = source("components/settings/FeatureFlagsSection.tsx");

    expect(exports).toContain("useDiscardOnlyDraftLifecycle({");
    expect(exports).toContain('ownerId: "data-export-create"');
    expect(exports).toContain('title="Discard export selection?"');
    expect(exports).toMatch(
      /onCreate[\s\S]*operation\.run[\s\S]*exportsApi\.create\(\[\.\.\.include\]\)[\s\S]*catch/u,
    );
    expect(flags).toContain("useDiscardOnlyDraftLifecycle({");
    expect(flags).toContain('ownerId: "feature-flag-upsert"');
    expect(flags).toContain('title="Discard feature-flag draft?"');
    expect(flags).toMatch(
      /onUpsert[\s\S]*operation\.run[\s\S]*featureFlagsApi\.upsert[\s\S]*catch/u,
    );
    expect(`${exports}\n${flags}`).not.toMatch(
      /useExistingSettingLifecycle\(\{[\s\S]{0,120}ownerId: "(?:data-export-create|feature-flag-upsert)"/u,
    );
  });

  it("covers retention, identifier transforms, and preference theme baselines", () => {
    const retention = source("components/settings/ExportRetentionSection.tsx");
    const identifiers = source(
      "components/settings/IdentifierTransformsSection.tsx",
    );
    const preference = source(
      "components/privacy/PreferenceCenterCustomization.tsx",
    );

    expect(retention).toContain('ownerId: "export-retention"');
    expect(retention).toContain("setDays(policy.retention_days)");
    expect(retention).toMatch(
      /patchExportRetentionPolicy[\s\S]*setPolicy\(saved\)[\s\S]*return true/u,
    );
    expect(identifiers).toContain('ownerId: "identifier-transforms"');
    expect(identifiers).toContain("discard: reset");
    expect(identifiers).toMatch(
      /identifierTransformsApi\.update[\s\S]*setConfig\(parsed\)[\s\S]*return true/u,
    );
    expect(preference).toContain('ownerId: "preference-center-theme"');
    expect(preference).toContain("baselineRef.current = acknowledged");
    expect(preference).toContain("setTheme(baselineRef.current)");
    expect(preference).toMatch(
      /savePreferenceCustomization[\s\S]*setBaseline\(acknowledged\)[\s\S]*return true/u,
    );
  });

  it("splits goal create/edit semantics and protects privacy-region creation", () => {
    const goals = source("components/dashboard/GoalsCard.tsx");
    const regions = source("components/privacy/RegionsCard.tsx");

    expect(goals).toContain('ownerId: "goal-create"');
    expect(goals).toContain("ownerId: goal ? `goal-edit-${goal.id}`");
    expect(goals).toContain("enabled: isNew");
    expect(goals).toContain("enabled: !isNew");
    expect(goals).toContain('title={isNew ? "Discard goal draft?"');
    expect(goals).toMatch(
      /onSave[\s\S]*operation\.run[\s\S]*goalsApi\.create[\s\S]*goalsApi\.update[\s\S]*catch/u,
    );
    expect(regions).toContain('ownerId: "privacy-region-create"');
    expect(regions).toContain('title="Discard privacy-region draft?"');
    expect(regions).toMatch(
      /onCreate[\s\S]*operation\.run[\s\S]*regions\.create[\s\S]*catch \(createError\)[\s\S]*finally/u,
    );
  });
});
