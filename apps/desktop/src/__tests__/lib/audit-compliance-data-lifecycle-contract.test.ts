import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("audit, compliance, and data-governance lifecycle contract", () => {
  it("keeps one retained operation behind every draft controller", () => {
    const controller = source("hooks/useDraftLifecycleController.ts");
    const primitives = source("hooks/useSettingsDraftLifecycle.ts");

    expect(controller).toContain("runOperation: operation.run");
    expect(controller).toContain('enabled: enabled && mode !== "edit"');
    expect(controller).toContain('enabled: enabled && mode === "edit"');
    expect(primitives).toContain(
      "markLifecycleOperationRefRetained(promiseRef)",
    );
    expect(primitives).toContain(
      "const source = (async (): Promise<T> => operation())()",
    );
    expect(primitives).toMatch(
      /useDiscardOnlyDraftLifecycle[\s\S]*inspect:[\s\S]*discard:[\s\S]*\}\),/u,
    );
    expect(primitives).not.toMatch(
      /function useDiscardOnlyDraftLifecycle[\s\S]*prepare:/u,
    );
  });

  it("owns every bounded audit editor, replacement, and mutation", () => {
    const alertForm = source("components/audit/AuditAlertRuleForm.tsx");
    const channel = source("components/audit/AuditAlertChannelConfig.tsx");
    const sinkPrimitives = source(
      "components/audit/AuditSinkEditorPrimitives.tsx",
    );
    const secureInput = source("components/SecureDraftInput.tsx");
    const alerts = source("pages/AuditAlerts.tsx");
    const exportProgress = source("components/audit/AuditExportProgress.tsx");
    const replay = source("components/audit/AuditSinkReplayTab.tsx");
    const sinks = source("pages/AuditSinks.tsx");
    const schedules = source("components/audit/EvidencePackSchedulesModal.tsx");
    const retention = source("components/audit/RetentionEditor.tsx");
    const views = source("components/audit/SavedViewsBar.tsx");
    const access = source("pages/audit/AuditAccessPanels.tsx");
    const event = source("components/AuditEventSlideover.tsx");
    const investigation = source("pages/AuditInvestigation.tsx");

    expect(alertForm).toContain('ownerId: initial ? "audit-alert-rule-edit"');
    expect(alertForm).toContain("lifecycle.runOperation(async () =>");
    expect(alertForm).toContain("Replace delivery-channel configuration?");
    expect(alertForm).toContain("Replace operator configuration?");
    expect(alertForm).toMatch(/pendingChannelKind[\s\S]*channelConfig: \{\}/u);
    expect(alertForm).toContain("ruleDraftIsDirty(draft, baseline)");
    expect(alertForm).not.toContain("JSON.stringify(draft)");
    expect(alertForm).toMatch(
      /if \(saved\)[\s\S]*clearSensitiveRuleDraft[\s\S]*onCancel\(\)/u,
    );
    expect(alertForm).toContain("channel_config: { ...draft.channelConfig }");
    expect(alertForm).toContain(
      "eraseSensitiveChannelValues(draft.channelKind, input.channel_config)",
    );
    expect(alertForm).toMatch(
      /function eraseSensitiveChannelValues[\s\S]*delete config\[key\]/u,
    );
    expect(alertForm).toMatch(
      /discard: \(\) => \{[\s\S]*clearSensitiveRuleDraft\(baseline\)/u,
    );
    expect(channel.match(/<SecureDraftInput/gu)).toHaveLength(8);
    expect(channel).toContain('accessibleName="Slack incoming webhook URL"');
    expect(channel).toContain('accessibleName="Routing key (integration key)"');
    expect(sinkPrimitives).toContain("<SecureDraftInput");
    expect(secureInput).toContain("export function SecureDraftInput(");
    expect(secureInput).toContain('autoComplete="new-password"');
    expect(secureInput).toContain(
      '`${show ? "Hide" : "Show"} ${accessibleName}`',
    );
    expect(alerts).toContain('ownerId: "audit-alert-rule-mutation"');
    expect(exportProgress).toContain('ownerId: "audit-export-queue-draft"');
    expect(exportProgress).toContain("this build has no export-history screen");
    expect(exportProgress).toContain("generationRef.current === generation");
    expect(exportProgress).toContain("window.setTimeout");
    expect(exportProgress).not.toContain("window.setInterval");
    expect(replay).toContain('ownerId: "audit-sink-replay-cancel"');
    expect(replay).toContain("pendingSinkId");
    expect(replay).toContain("Discard replay range and switch sink?");
    expect(sinks).toContain(
      'auditScopeState.hasScope("audit:configure_sinks")',
    );
    expect(sinks).toContain(
      'auditScopeState.hasScope("audit:execute_actions")',
    );
    expect(sinks).toContain("canAdmin={canExecuteActions}");
    expect(sinks).not.toContain("auditScopeState.isAdmin ||");
    expect(sinks).not.toContain("useCanAdmin");
    expect(schedules).toContain('ownerId: "evidence-schedule-create"');
    expect(schedules).toContain('ownerId: "evidence-schedule-delete"');
    expect(retention).toContain("useExistingSettingLifecycle({");
    expect(views).toContain('ownerId: "audit-saved-view-create"');
    expect(views).toContain('ownerId: "audit-saved-view-delete"');
    // The blocked-access surface is deliberately a static handoff. The access
    // request endpoint is admin-gated, so mounting a mutation for a denied
    // viewer would advertise an operation that cannot succeed.
    expect(access).not.toContain('ownerId: "audit-access-request"');
    expect(access).not.toContain("requestAuditAccess");
    expect(access).toContain("Settings → Team → Roles");
    expect(event).toContain("audit-event-action-${row.id}");
    expect(event).toContain("useExistingSettingLifecycle({");
    expect(event).toMatch(
      /const invId = await request;[\s\S]*navigateDesktopRoute/u,
    );
    expect(investigation).toContain(
      'audit-investigation-decision-${id ?? "none"}',
    );
    expect(investigation).toContain('mode: "action"');
    expect(`${alertForm}\n${exportProgress}\n${replay}`).not.toMatch(
      /console\.(?:log|info|warn|error)|localStorage|sessionStorage|indexedDB/u,
    );
  });

  it("keeps compliance and safe incident decisions discard-only and identity keyed", () => {
    const attest = source("components/compliance/AttestModal.tsx");
    const compliance = source("pages/Compliance.tsx");
    const incidents = source("pages/PrivacyIncidents.tsx");

    expect(attest).toContain("compliance-attestation-${meta.slug}");
    expect(attest).toContain('mode: "action"');
    expect(attest).toContain("Discard attestation draft?");
    expect(compliance).toContain("<GenericFrameworkDetail");
    expect(compliance).toContain("key={selected}");
    expect(compliance).toContain("compliance-revoke-${framework}");
    for (const owner of [
      "privacy-incident-create",
      "privacy-incident-transition-${detail.id}",
    ]) {
      expect(incidents).toContain(owner);
    }
    expect(incidents.match(/useDraftLifecycleController\(\{/gu)).toHaveLength(
      2,
    );
    for (const releaseHold of [
      "privacy-incident-close-release-hold",
      "privacy-incident-signoff-release-hold",
      "privacy-incident-notification-release-hold",
    ]) {
      expect(incidents).toContain(releaseHold);
    }
    expect(incidents).not.toMatch(
      /signoffPrivacyIncident|recordPrivacyIncidentNotification/u,
    );
    expect(`${attest}\n${incidents}`).not.toMatch(
      /console\.(?:log|info|warn|error)|localStorage|sessionStorage|indexedDB/u,
    );
  });

  it("distinguishes data-platform create, acknowledged edit, and action owners", () => {
    const objects = source("components/dataplatform/CustomObjectsSection.tsx");
    const streamingForm = source(
      "components/dataplatform/StreamingExportForm.tsx",
    );
    const streamingStatus = source(
      "components/dataplatform/StreamingExportStatus.tsx",
    );
    const warehouse = source("components/dataplatform/WarehouseSection.tsx");
    const reverse = source("components/dataplatform/ReverseETLSection.tsx");
    const reverseMapping = source(
      "components/warehouse/ReverseETLMappingModal.tsx",
    );

    expect(objects).toContain('key={formTarget?.id ?? "create"}');
    expect(objects).toContain('mode: existing ? "edit" : "create"');
    expect(objects).toContain("custom-object-record-create-${objType.id}");
    expect(objects).toContain("custom-object-record-edit-${existing.id}");
    expect(objects).toContain("custom-object-record-delete-${objType.id}");
    expect(streamingForm).toContain('ownerId: "streaming-export-create"');
    expect(streamingForm).toContain("lifecycle.runOperation(runValidate)");
    expect(streamingForm).toContain('label="Workspace-storage prefix"');
    expect(streamingForm).toContain("streamingDraftToConnectionInput(draft)");
    expect(streamingForm).not.toMatch(
      /Destination type|Bucket \/ destination|Credentials reference|pendingDestination/u,
    );
    expect(streamingStatus).toContain("streaming-export-ship-${id}");
    expect(streamingStatus).toContain("onBusyChange?.(operation.active)");
    expect(warehouse).toContain('"warehouse-catalog"');
    expect(warehouse).toContain('"warehouse-connections"');
    expect(warehouse).toContain('ownerId: "warehouse-run-action"');
    expect(warehouse).toContain('ownerId: "warehouse-connection-create"');
    expect(warehouse).toContain(
      "Replace provider-specific connection settings?",
    );
    expect(warehouse).toMatch(
      /provider: pendingProvider[\s\S]*configText: ""[\s\S]*credentialsRef: ""/u,
    );
    expect(warehouse).toContain('mode: existing ? "edit" : "create"');
    expect(warehouse).toContain("existing: Boolean(m)");
    expect(reverse).toContain('"reverse-etl"');
    expect(reverse).toContain('ownerId: "reverse-etl-action"');
    expect(reverseMapping).toContain(
      "reverse-etl-mapping-create-${connectionId}",
    );
  });

  it("keeps adjacent lower-loss owners visible as residual inventory", () => {
    const consent = source("pages/Consent.tsx");
    const transforms = source(
      "components/dataplatform/CdpTransformsSection.tsx",
    );
    const sinkTables = source("components/audit/AuditSinkTables.tsx");
    const optIn = source("components/privacy/DoubleOptinPendingTable.tsx");
    const nlq = source("components/audit/AuditNLQBar.tsx");

    expect(consent).not.toContain("useDraftLifecycleController");
    expect(transforms).toContain("propertiesText");
    expect(transforms).toContain("opsText");
    expect(transforms).not.toContain("useDraftLifecycleController");
    expect(sinkTables).toContain("useSingleFlightOperation");
    expect(sinkTables).toContain('ownerId: "audit-sink-dlq-replay"');
    expect(optIn).toContain("useSingleFlightOperation");
    expect(optIn).toContain('ownerId: "privacy-double-optin-mutation"');
    expect(nlq).not.toContain("useSingleFlightOperation");
  });
});
