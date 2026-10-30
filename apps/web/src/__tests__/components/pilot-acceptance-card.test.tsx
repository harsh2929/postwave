// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPilotChecklist,
  buildPilotSignoffMarkdown,
  PilotAcceptanceCard,
  redactMigrationSensitiveText,
} from "@/app/(dashboard)/app/migrations/[jobId]/pilot-acceptance-card";
import type {
  AutomationRebuildItem,
  MigrationJob,
  PilotAcceptanceReport,
  ShadowMonitorResponse,
  SourceEventMonitorResponse,
  VerificationReport,
} from "@/lib/types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function action(): ReturnType<typeof vi.fn<() => Promise<void>>> {
  return vi.fn(async () => undefined);
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function buttonsByText(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
}

const job: MigrationJob = {
  id: "mig_1",
  tenant_id: "tenant_1",
  source: "activecampaign",
  status: "completed",
  progress: {
    subscribers_total: 100,
    subscribers_done: 100,
    segments_total: 4,
    segments_done: 4,
    automations_total: 2,
    automations_done: 2,
    paid_subs_total: 0,
    paid_subs_done: 0,
    archive_total: 10,
    archive_done: 10,
  },
  cursor: {},
  started_at: "2026-06-28T00:00:00.000Z",
  completed_at: "2026-06-28T01:00:00.000Z",
  rollback_until: "2026-07-05T01:00:00.000Z",
  verification_report: null,
  error: null,
};

const report: VerificationReport = {
  subscribers_imported: 100,
  suppression_list_size: 3,
  custom_fields_mapped: [],
  custom_fields_unmapped: [],
  segments_translated: 4,
  segments_with_warnings: [],
  automations_translated: 2,
  automations_unsupported: [],
  paid_subs_imported: 0,
  archive_imported: 10,
  source_archive_imported: 10,
  resource_completeness: [],
  data_loss_estimate_pct: 0,
};

const rebuild: AutomationRebuildItem = {
  rank: 1,
  name: "Welcome nurture",
  status: "rebuilding",
  notes: "Waiting on owner review.",
};

const acceptance: PilotAcceptanceReport = {
  job_id: "mig_1",
  source: "activecampaign",
  generated_at: "2026-06-28T02:00:00.000Z",
  status: "warning",
  blockers: 0,
  warnings: 1,
  items: [
    {
      key: "sms_pilot",
      label: "SMS pilot readiness",
      status: "warning",
      detail: "SMS certification should be reviewed before cutover.",
    },
  ],
};

const shadow: ShadowMonitorResponse = {
  monitor: {
    job_id: "mig_1",
    tenant_id: "tenant_1",
    source: "activecampaign",
    enabled: true,
    interval_seconds: 3600,
    last_checked_at: "2026-06-28T02:00:00.000Z",
    next_check_at: "2026-06-28T03:00:00.000Z",
    last_recommended_action: "ready_for_cutover_review",
  },
  history: [
    {
      job_id: "mig_1",
      source: "activecampaign",
      generated_at: "2026-06-28T02:00:00.000Z",
      current_discovery: {},
      needs_delta_import: false,
      recommended_action: "ready_for_cutover_review",
      deltas: [],
    },
  ],
};

const sourceEvents: SourceEventMonitorResponse = {
  monitor: {
    job_id: "mig_1",
    tenant_id: "tenant_1",
    source: "activecampaign",
    enabled: true,
    interval_seconds: 300,
    last_synced_at: "2026-06-28T02:05:00.000Z",
    next_sync_at: "2026-06-28T02:10:00.000Z",
    events_seen: 2,
    events_applied: 2,
  },
  events: [
    {
      id: "evt_1",
      job_id: "mig_1",
      tenant_id: "tenant_1",
      source: "activecampaign",
      source_event_id: "activecampaign:contact:42",
      resource_type: "subscriber",
      action: "upsert",
      occurred_at: "2026-06-28T02:04:00.000Z",
      applied: true,
      created_at: "2026-06-28T02:05:00.000Z",
    },
  ],
};

const hubSpotJob: MigrationJob = {
  ...job,
  id: "mig_hubspot",
  source: "hubspot",
  progress: {
    ...job.progress,
    archive_total: 0,
    archive_done: 0,
    automations_total: 0,
    automations_done: 0,
  },
};

const hubSpotAcceptance: PilotAcceptanceReport = {
  ...acceptance,
  job_id: "mig_hubspot",
  source: "hubspot",
  status: "pass",
  blockers: 0,
  warnings: 0,
  items: [
    {
      key: "hubspot_shadow_check",
      label: "HubSpot shadow check",
      status: "pass",
      detail: "Latest shadow check found no unhandled HubSpot source deltas.",
    },
    {
      key: "hubspot_final_delta_import",
      label: "HubSpot final delta import",
      status: "pass",
      detail: "Final delta import completed after the committed migration.",
    },
    {
      key: "hubspot_source_event_replay",
      label: "HubSpot source-event replay",
      status: "pass",
      detail:
        "Source-event replay has synced cleanly for the HubSpot bridge overlap window.",
    },
    {
      key: "hubspot_crm_bridge_scope_review",
      label: "HubSpot CRM-bridge scope review",
      status: "pass",
      detail:
        "All fourteen post-final-snapshot HubSpot bridge scope rows were reviewed.",
    },
    {
      key: "hubspot_rollback_rehearsal",
      label: "HubSpot rollback rehearsal",
      status: "pass",
      detail: "Rollback was rehearsed after the final full snapshot.",
    },
  ],
};

const hubSpotSourceEvents: SourceEventMonitorResponse = {
  monitor: {
    ...sourceEvents.monitor,
    job_id: "mig_hubspot",
    source: "hubspot",
  },
  events: [
    {
      ...sourceEvents.events[0],
      job_id: "mig_hubspot",
      source: "hubspot",
      source_event_id: "hubspot:contact:42:2026-06-28T02:04:00Z:abc123",
    },
  ],
};

const beehiivJob: MigrationJob = {
  ...job,
  id: "mig_beehiiv",
  source: "beehiiv",
  progress: {
    ...job.progress,
    automations_total: 1,
    automations_done: 0,
  },
};

const beehiivReport: VerificationReport = {
  ...report,
  automations_translated: 0,
  automations_unsupported: [
    {
      name: "Welcome series",
      reason: "Preserved as a rebuild-only Beehiiv automation record.",
    },
  ],
  resource_completeness: [
    {
      resource: "automations",
      label: "Beehiiv automations",
      source_total: 1,
      imported: 1,
      supported: true,
      status: "preserved_for_rebuild",
    },
  ],
};

const beehiivPassedRebuild: AutomationRebuildItem = {
  ...rebuild,
  name: "Welcome series",
  status: "test_passed",
};

const beehiivPassingItems: PilotAcceptanceReport["items"] = [
  {
    key: "source_discovery_warnings",
    label: "Source discovery warnings",
    status: "pass",
    detail: "Discovery completed without warnings.",
  },
  {
    key: "source_archive_warnings",
    label: "Source archive warnings",
    status: "pass",
    detail: "Source archive completed without warnings.",
  },
  {
    key: "beehiiv_shadow_check",
    label: "Beehiiv shadow check",
    status: "pass",
    detail: "The post-delta shadow check is clean.",
  },
  {
    key: "beehiiv_final_delta_import",
    label: "Beehiiv final delta import",
    status: "pass",
    detail: "Final snapshot and source deletion reconciliation completed.",
  },
  {
    key: "beehiiv_consent_reconciliation",
    label: "Beehiiv consent and suppression reconciliation",
    status: "pass",
    detail: "Consent and suppressions were reviewed after final delta.",
  },
  {
    key: "beehiiv_segment_rules_review",
    label: "Beehiiv dynamic segment rules review",
    status: "pass",
    detail: "Dynamic segment rules were rebuilt or retired.",
  },
  {
    key: "beehiiv_campaign_archive_fidelity",
    label: "Beehiiv campaign archive content fidelity",
    status: "pass",
    detail: "Campaign HTML fidelity was reviewed after final delta.",
  },
  {
    key: "beehiiv_website_capture_rebuild_review",
    label: "Beehiiv website, theme, and capture-widget rebuild",
    status: "pass",
    detail: "Website and capture surfaces were rebuilt or retired.",
  },
  {
    key: "beehiiv_boosts_recommendations_rebuild_review",
    label: "Beehiiv Boosts and recommendation-network rebuild",
    status: "pass",
    detail: "Boosts and recommendations were rebuilt or retired.",
  },
  {
    key: "beehiiv_ad_network_review",
    label: "Beehiiv Ad Network review",
    status: "pass",
    detail: "Ad Network exports and ownership were recorded.",
  },
  {
    key: "top_automations",
    label: "Top automation rebuilds",
    status: "pass",
    detail: "The Beehiiv rebuild-only automation is test-passed.",
  },
  {
    key: "sms_readiness",
    label: "SMS readiness",
    status: "pass",
    detail: "No SMS inventory was detected.",
  },
  {
    key: "rollback_rehearsal",
    label: "Rollback rehearsal",
    status: "pass",
    detail: "Rollback was rehearsed from tracked resources.",
  },
];

const beehiivAcceptance: PilotAcceptanceReport = {
  ...acceptance,
  job_id: beehiivJob.id,
  source: "beehiiv",
  status: "pass",
  blockers: 0,
  warnings: 0,
  items: beehiivPassingItems,
};

function props(
  overrides: Partial<Parameters<typeof PilotAcceptanceCard>[0]> = {},
): Parameters<typeof PilotAcceptanceCard>[0] {
  const baseProps: Parameters<typeof PilotAcceptanceCard>[0] = {
    acceptance: null,
    job,
    onDeltaImport: action(),
    onMarkAutomation: vi.fn(async () => undefined),
    onMarkCutoverEvidence: vi.fn(async () => undefined),
    onRefresh: action(),
    onStartShadow: action(),
    onStartSourceEvents: action(),
    onStopShadow: action(),
    onStopSourceEvents: action(),
    onUpdateSourceEventReview: vi.fn(async () => undefined),
    pending: null,
    rebuilds: [],
    report,
    shadow: null,
    sourceEvents: null,
  };
  return Object.assign(baseProps, overrides);
}

describe("PilotAcceptanceCard", () => {
  it("renders the checklist fallback when acceptance has not been generated", () => {
    const root = render(createElement(PilotAcceptanceCard, props()));

    try {
      expect(document.body.textContent).toContain("Pilot acceptance");
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).toContain(
        "Refresh acceptance after verification is available.",
      );
      expect(document.body.textContent).toContain(
        "Run final delta import after freezing ActiveCampaign edits",
      );
      expect(buttonByText("Disable").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes pilot action buttons through props", () => {
    const callbacks = {
      onDeltaImport: action(),
      onMarkAutomation: vi.fn(async () => undefined),
      onMarkCutoverEvidence: vi.fn(async () => undefined),
      onRefresh: action(),
      onStartShadow: action(),
      onStartSourceEvents: action(),
      onStopShadow: action(),
      onStopSourceEvents: action(),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              ...acceptance.items,
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "warning",
                detail: "Deliverability review is pending.",
              },
            ],
          },
          rebuilds: [rebuild],
          shadow,
          sourceEvents,
        }),
      ),
    );

    try {
      act(() => {
        buttonByText("Refresh").click();
        buttonByText("Run delta import").click();
        buttonByText("Run now").click();
        buttonByText("Disable").click();
        buttonByText("Run sync").click();
        buttonByText("Disable replay").click();
        buttonByText("Mark test-passed").click();
        buttonByText("Not needed").click();
        buttonByText("Blocked").click();
        buttonByText("Mark reviewed").click();
      });

      expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
      expect(callbacks.onDeltaImport).toHaveBeenCalledTimes(1);
      expect(callbacks.onStartShadow).toHaveBeenCalledTimes(1);
      expect(callbacks.onStopShadow).toHaveBeenCalledTimes(1);
      expect(callbacks.onStartSourceEvents).toHaveBeenCalledTimes(1);
      expect(callbacks.onStopSourceEvents).toHaveBeenCalledTimes(1);
      expect(callbacks.onMarkAutomation).toHaveBeenCalledWith(
        rebuild,
        "test_passed",
      );
      expect(callbacks.onMarkAutomation).toHaveBeenCalledWith(
        rebuild,
        "approved_not_needed",
      );
      expect(callbacks.onMarkAutomation).toHaveBeenCalledWith(
        rebuild,
        "blocked",
      );
      expect(callbacks.onMarkCutoverEvidence).toHaveBeenCalledWith(
        "activecampaign_deliverability_review",
        "ActiveCampaign deliverability review",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers a live SMS readiness verification action for ActiveCampaign", () => {
    const onMarkCutoverEvidence = vi.fn(async () => undefined);
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          onMarkCutoverEvidence,
          acceptance: {
            ...acceptance,
            status: "blocker",
            blockers: 1,
            warnings: 0,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "sms_readiness",
                label: "SMS readiness",
                status: "blocker",
                detail: "Pass the live SMS pilot-readiness endpoint.",
              },
            ],
          },
        }),
      ),
    );

    try {
      act(() => buttonByText("Verify & record").click());
      expect(onMarkCutoverEvidence).toHaveBeenCalledWith(
        "sms_readiness",
        "SMS readiness",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("surfaces ActiveCampaign credential cleanup evidence requirements", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          shadow,
          sourceEvents,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "ActiveCampaign 100% readiness also requires credential cleanup evidence",
      );
      expect(document.body.textContent).toContain(
        "attach a non-secret evidence reference",
      );
    } finally {
      act(() => root.unmount());
    }

    const markdown = buildPilotSignoffMarkdown({
      acceptance,
      checklist: buildPilotChecklist({
        acceptance,
        job,
        rebuilds: [],
        report,
        shadow,
        sourceEvents,
      }),
      job,
      rebuilds: [],
      report,
      shadow,
      sourceEvents,
    });

    expect(markdown).toContain("## ActiveCampaign Credential Cleanup");
    expect(markdown).toContain(
      "ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_REVIEW=1",
    );
    expect(markdown).toContain(
      "ACTIVECAMPAIGN_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF=<non-secret reference>",
    );
    expect(markdown).toContain(
      "Verify follow-up source access fails safely or shows reconnect guidance",
    );
    expect(markdown).toContain(
      "## ActiveCampaign Consent, Exclusion, and Contact-Identity Reconciliation",
    );
    expect(markdown).toContain(
      "ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1",
    );
    expect(markdown).toContain(
      "ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF=<non-secret reference>",
    );
  });

  it("surfaces the fail-closed ActiveCampaign consent and exclusion gate", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_consent_exclusion_review",
            label: "ActiveCampaign consent and exclusion review",
            status: "blocker",
            detail:
              "List status and subscription dates are provenance only; reconcile channel consent and exclusions before activation.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
      sourceEvents,
    });

    expect(
      checklist.find(
        (item) => item.key === "activecampaign_consent_exclusion_review",
      ),
    ).toMatchObject({
      status: "blocker",
      detail:
        "List status and subscription dates are provenance only; reconcile channel consent and exclusions before activation.",
    });
  });

  it("disables ActiveCampaign review actions while final delta is pending", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Previous final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "warning",
                detail: "Deliverability review is pending.",
              },
              {
                key: "activecampaign_templates_review",
                label: "ActiveCampaign templates",
                status: "warning",
                detail: "Templates were preserved for rebuild/review.",
              },
            ],
          },
          pending: "delta",
          shadow,
        }),
      ),
    );

    try {
      const reviewButtons = buttonsByText("Mark reviewed");
      expect(reviewButtons).toHaveLength(2);
      for (const button of reviewButtons) {
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("Wait for final delta import to finish");
      }

      act(() => {
        for (const button of reviewButtons) button.click();
      });

      expect(callbacks.onMarkCutoverEvidence).not.toHaveBeenCalled();
      expect(buttonByText("Run delta import").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps stale ActiveCampaign review actions disabled while the job is importing", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Previous final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "warning",
                detail: "Deliverability review is pending.",
              },
              {
                key: "activecampaign_templates_review",
                label: "ActiveCampaign templates",
                status: "warning",
                detail: "Templates were preserved for rebuild/review.",
              },
            ],
          },
          job: {
            ...job,
            status: "importing",
            completed_at: null,
            rollback_until: null,
          },
          shadow,
        }),
      ),
    );

    try {
      const reviewButtons = buttonsByText("Mark reviewed");
      expect(reviewButtons).toHaveLength(2);
      for (const button of reviewButtons) {
        expect(button.disabled).toBe(true);
        expect(button.title).toBe("Wait for final delta import to finish");
      }

      act(() => {
        for (const button of reviewButtons) button.click();
      });

      expect(callbacks.onMarkCutoverEvidence).not.toHaveBeenCalled();
      expect(buttonByText("Run delta import").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks final delta and shadow start when the source session must be reconnected", () => {
    const callbacks = {
      onDeltaImport: action(),
      onStartShadow: action(),
      onStartSourceEvents: action(),
    };
    const status = {
      kind: "expired" as const,
      message:
        "The source session has expired. Reconnect before starting cutover checks.",
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          sourceSessionStatus: status,
          shadow: null,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(status.message);

      const delta = buttonByText("Run delta import");
      const shadowStart = buttonByText("Enable hourly");
      const sourceEventsStart = buttonByText("Enable replay");
      expect(delta.disabled).toBe(true);
      expect(delta.title).toBe(status.message);
      expect(shadowStart.disabled).toBe(true);
      expect(shadowStart.title).toBe(status.message);
      expect(sourceEventsStart.disabled).toBe(true);
      expect(sourceEventsStart.title).toBe(status.message);

      act(() => {
        delta.click();
        shadowStart.click();
        sourceEventsStart.click();
      });

      expect(callbacks.onDeltaImport).not.toHaveBeenCalled();
      expect(callbacks.onStartShadow).not.toHaveBeenCalled();
      expect(callbacks.onStartSourceEvents).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks shadow and source-event start until the migration job completes", () => {
    const callbacks = {
      onStartShadow: action(),
      onStartSourceEvents: action(),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          job: { ...job, status: "importing", completed_at: null },
          shadow: null,
          sourceEvents: null,
        }),
      ),
    );

    try {
      const shadowStart = buttonByText("Enable hourly");
      const sourceEventsStart = buttonByText("Enable replay");
      expect(shadowStart.disabled).toBe(true);
      expect(shadowStart.title).toBe("Wait for migration job to complete");
      expect(sourceEventsStart.disabled).toBe(true);
      expect(sourceEventsStart.title).toBe(
        "Wait for migration job to complete",
      );

      act(() => {
        shadowStart.click();
        sourceEventsStart.click();
      });

      expect(callbacks.onStartShadow).not.toHaveBeenCalled();
      expect(callbacks.onStartSourceEvents).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not show ActiveCampaign warning acceptance as review-ready", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...acceptance,
            status: "warning",
            blockers: 0,
            warnings: 1,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "sms_pilot",
                label: "SMS pilot readiness",
                status: "pass",
                detail: "SMS is out of pilot scope.",
              },
              {
                key: "rollback_rehearsal",
                label: "Rollback rehearsal",
                status: "pass",
                detail: "Rollback rehearsal passed.",
              },
              {
                key: "unexpected_warning",
                label: "Unexpected warning",
                status: "warning",
                detail: "This unresolved warning must not look cutover-ready.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).not.toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks source deltas as a cutover blocker", () => {
    const checklist = buildPilotChecklist({
      acceptance,
      job,
      rebuilds: [],
      report,
      shadow: {
        ...shadow,
        history: [{ ...shadow.history[0], needs_delta_import: true }],
      },
    });

    expect(
      checklist.find((item) => item.key === "shadow_monitor"),
    ).toMatchObject({
      status: "blocker",
    });
  });

  it("uses the backend ActiveCampaign shadow gate in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_shadow_check",
            label: "ActiveCampaign shadow check",
            status: "blocker",
            detail:
              "The latest shadow check predates the final import completion. Re-run shadow check after final delta import.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "shadow_monitor"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "The latest shadow check predates the final import completion. Re-run shadow check after final delta import.",
    });
  });

  it("uses the backend ActiveCampaign source-event replay gate in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_source_event_replay",
            label: "ActiveCampaign source-event replay",
            status: "blocker",
            detail:
              "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
      sourceEvents: {
        ...sourceEvents,
        monitor: {
          ...sourceEvents.monitor,
          last_error: "activecampaign sync failed",
        },
      },
    });

    expect(
      checklist.find(
        (item) => item.key === "activecampaign_source_event_replay",
      ),
    ).toMatchObject({
      status: "blocker",
      detail:
        "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance.",
    });
  });

  it("records evidence for intentionally unapplied ActiveCampaign source events", async () => {
    const onUpdateSourceEventReview = vi.fn(async () => undefined);
    const manualEvent: SourceEventMonitorResponse = {
      ...sourceEvents,
      events: [
        {
          id: "evt_manual_1",
          job_id: job.id,
          tenant_id: job.tenant_id,
          source: "activecampaign",
          source_event_id: "[redacted-activecampaign-source-event-id]",
          resource_type: "activecampaign_non_email_contact",
          action: "manual_review",
          occurred_at: "2026-06-28T02:04:00.000Z",
          applied: false,
          error:
            "captured for review; no automatic replay for this source-event type",
          review_status: "pending",
        },
      ],
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({ sourceEvents: manualEvent, onUpdateSourceEventReview }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "Manual source-event reconciliation",
      );
      const detail = document.querySelector<HTMLTextAreaElement>(
        "#source-event-review-detail-evt_manual_1",
      );
      const evidence = document.querySelector<HTMLInputElement>(
        "#source-event-review-evidence-evt_manual_1",
      );
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("Record reviewed event"),
      );
      expect(detail).not.toBeNull();
      expect(evidence).not.toBeNull();
      expect(button?.hasAttribute("disabled")).toBe(true);
      act(() => {
        if (detail) {
          Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set?.call(
            detail,
            "Phone-only contact excluded from email sending.",
          );
          detail.dispatchEvent(new Event("input", { bubbles: true }));
          detail.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      act(() => {
        if (evidence) {
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set?.call(evidence, "cutover-ticket-42");
          evidence.dispatchEvent(new Event("input", { bubbles: true }));
          evidence.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      expect(button?.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(onUpdateSourceEventReview).toHaveBeenCalledWith("evt_manual_1", {
        status: "reviewed",
        detail: "Phone-only contact excluded from email sending.",
        evidence: ["cutover-ticket-42"],
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not count a fully evidenced manual review as a replay failure", () => {
    const reviewedAt = "2026-06-28T02:06:00.000Z";
    const reviewedSourceEvents: SourceEventMonitorResponse = {
      ...sourceEvents,
      events: [
        {
          id: "evt_manual_reviewed",
          job_id: job.id,
          tenant_id: job.tenant_id,
          source: "activecampaign",
          source_event_id: "[redacted-activecampaign-source-event-id]",
          resource_type: "activecampaign_non_email_contact",
          action: "manual_review",
          occurred_at: "2026-06-28T02:04:00.000Z",
          applied: false,
          error:
            "captured for review; no automatic replay for this source-event type",
          review_status: "reviewed",
          review_detail: "Phone-only contact reconciled.",
          review_evidence: ["cutover-ticket-42"],
          reviewed_at: reviewedAt,
        },
      ],
    };
    const checklist = buildPilotChecklist({
      acceptance: null,
      job,
      rebuilds: [],
      report,
      shadow,
      sourceEvents: reviewedSourceEvents,
    });
    expect(
      checklist.find(
        (item) => item.key === "activecampaign_source_event_replay",
      ),
    ).toMatchObject({ status: "pass" });
    const markdown = buildPilotSignoffMarkdown({
      job,
      report,
      acceptance: null,
      rebuilds: [],
      shadow,
      sourceEvents: reviewedSourceEvents,
      checklist,
    });
    expect(markdown).toContain("Manual-review events reviewed: 1");
    expect(markdown).toContain("evt_manual_reviewed");
    expect(markdown).toContain("cutover-ticket-42");
  });

  it("shows sanitized reviewed evidence and can reopen a completed manual review", async () => {
    const onUpdateSourceEventReview = vi.fn(async () => undefined);
    const reviewedSourceEvents: SourceEventMonitorResponse = {
      ...sourceEvents,
      events: [
        {
          id: "evt_manual_reviewed_reopen",
          job_id: job.id,
          tenant_id: job.tenant_id,
          source: "activecampaign",
          source_event_id: "[redacted-activecampaign-source-event-id]",
          resource_type: "activecampaign_non_email_contact",
          action: "manual_review",
          occurred_at: "2026-06-28T02:04:00.000Z",
          applied: false,
          review_status: "reviewed",
          review_detail:
            "Handled ada@example.com using https://tenant.activehosted.com/api/3.",
          review_evidence: ["cutover-ticket-42 Api-Token: super-secret"],
          reviewed_at: "2026-06-28T02:06:00.000Z",
        },
      ],
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          sourceEvents: reviewedSourceEvents,
          onUpdateSourceEventReview,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "Reviewed source-event reconciliations",
      );
      expect(document.body.textContent).toContain("cutover-ticket-42");
      expect(document.body.textContent).toContain("[redacted-email]");
      expect(document.body.textContent).toContain(
        "[redacted-activecampaign-api-url]",
      );
      expect(document.body.textContent).toContain("Api-Token=[redacted]");
      expect(document.body.textContent).not.toContain("ada@example.com");
      expect(document.body.textContent).not.toContain("activehosted.com");
      expect(document.body.textContent).not.toContain("super-secret");

      await act(async () => {
        buttonByText("Reopen review").click();
        await Promise.resolve();
      });
      expect(onUpdateSourceEventReview).toHaveBeenCalledWith(
        "evt_manual_reviewed_reopen",
        { status: "pending" },
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("uses the backend HubSpot source-event replay gate in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...hubSpotAcceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...hubSpotAcceptance.items.filter(
            (item) => item.key !== "hubspot_source_event_replay",
          ),
          {
            key: "hubspot_source_event_replay",
            label: "HubSpot source-event replay",
            status: "blocker",
            detail:
              "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance.",
          },
        ],
      },
      job: hubSpotJob,
      rebuilds: [],
      report,
      shadow,
      sourceEvents: {
        ...hubSpotSourceEvents,
        monitor: {
          ...hubSpotSourceEvents.monitor,
          last_error: "hubspot sync failed",
        },
      },
    });

    expect(
      checklist.find((item) => item.key === "hubspot_source_event_replay"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "The latest source-event replay sync failed. Fix the replay error, rerun source-event sync, then refresh pilot acceptance.",
    });
  });

  it("renders HubSpot bridge source-event controls and bridge copy", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          job: hubSpotJob,
          acceptance: hubSpotAcceptance,
          shadow: {
            ...shadow,
            monitor: { ...shadow.monitor, source: "hubspot" },
            history: [{ ...shadow.history[0], source: "hubspot" }],
          },
          sourceEvents: hubSpotSourceEvents,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "HubSpot bridge acceptance gates",
      );
      expect(document.body.textContent).toContain(
        "Replay changed HubSpot contacts during the pilot overlap",
      );
      expect(document.body.textContent).toContain("Run sync");
      expect(document.body.textContent).toContain(
        "HubSpot source-event replay",
      );
      expect(document.body.textContent).not.toContain(
        "ActiveCampaign 100% readiness",
      );
      expect(document.body.textContent).toContain(
        "HubSpot 100% readiness also requires credential cleanup evidence",
      );
      expect(document.body.textContent).toContain(
        "revoke or rotate the dedicated HubSpot Service Key or private app token",
      );
      expect(document.body.textContent).toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }
  });

  it("records the HubSpot CRM-bridge scope review only after the final snapshot", () => {
    const onMarkCutoverEvidence = vi.fn(async () => undefined);
    const scopeReviewAcceptance: PilotAcceptanceReport = {
      ...hubSpotAcceptance,
      status: "blocker",
      blockers: 1,
      items: hubSpotAcceptance.items.map((item) =>
        item.key === "hubspot_crm_bridge_scope_review"
          ? {
              ...item,
              status: "blocker",
              detail:
                "Review all fourteen post-final-snapshot bridge scope rows.",
            }
          : item,
      ),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          job: hubSpotJob,
          acceptance: scopeReviewAcceptance,
          onMarkCutoverEvidence,
          shadow: {
            ...shadow,
            monitor: { ...shadow.monitor, source: "hubspot" },
            history: [{ ...shadow.history[0], source: "hubspot" }],
          },
          sourceEvents: hubSpotSourceEvents,
        }),
      ),
    );

    try {
      const reviewButton = buttonByText("Mark reviewed");
      expect(reviewButton.disabled).toBe(false);
      act(() => reviewButton.click());
      expect(onMarkCutoverEvidence).toHaveBeenCalledWith(
        "hubspot_crm_bridge_scope_review",
        "HubSpot CRM-bridge scope review",
      );
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).not.toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not treat warning-only HubSpot acceptance as review-ready", () => {
    const warningAcceptance: PilotAcceptanceReport = {
      ...hubSpotAcceptance,
      status: "warning",
      warnings: 1,
      items: [
        ...hubSpotAcceptance.items,
        {
          key: "source_discovery_warnings",
          label: "Source discovery warnings",
          status: "warning",
          detail: "One HubSpot inventory warning still needs resolution.",
        },
      ],
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          job: hubSpotJob,
          acceptance: warningAcceptance,
          shadow: {
            ...shadow,
            monitor: { ...shadow.monitor, source: "hubspot" },
            history: [{ ...shadow.history[0], source: "hubspot" }],
          },
          sourceEvents: hubSpotSourceEvents,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).not.toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }
  });

  it("includes HubSpot source-event replay in the sign-off packet", () => {
    const checklist = buildPilotChecklist({
      acceptance: hubSpotAcceptance,
      job: hubSpotJob,
      rebuilds: [],
      report,
      shadow,
      sourceEvents: hubSpotSourceEvents,
    });
    const markdown = buildPilotSignoffMarkdown({
      acceptance: hubSpotAcceptance,
      checklist,
      job: hubSpotJob,
      rebuilds: [],
      report,
      shadow,
      sourceEvents: hubSpotSourceEvents,
    });

    expect(markdown).toContain("Source: HubSpot");
    expect(markdown).toContain("## Source-Event Replay");
    expect(markdown).toContain("Events applied: 2");
    expect(markdown).not.toContain("## ActiveCampaign Credential Cleanup");
    expect(markdown).toContain("## HubSpot Credential Cleanup");
    expect(markdown).toContain("HUBSPOT_LIVE_CREDENTIAL_CLEANUP_REVIEW=1");
    expect(markdown).toContain(
      "HUBSPOT_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF=<non-secret reference>",
    );
  });

  it("renders backend acceptance evidence on the check cards", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...acceptance,
            status: "blocker",
            blockers: 1,
            items: [
              ...acceptance.items,
              {
                key: "activecampaign_source_event_replay",
                label: "ActiveCampaign source-event replay",
                status: "blocker",
                detail:
                  "Source-event replay evidence is stale for the final delta import.",
                evidence: [
                  "pre_delta_source_event_synced_at=2026-06-28T02:00:00Z",
                  "final_delta_started_at=2026-06-28T02:30:00Z",
                  "max_source_event_staleness=5m0s",
                ],
              },
            ],
          },
          sourceEvents,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "pre_delta_source_event_synced_at=2026-06-28T02:00:00Z",
      );
      expect(document.body.textContent).toContain(
        "final_delta_started_at=2026-06-28T02:30:00Z",
      );
      expect(document.body.textContent).toContain(
        "max_source_event_staleness=5m0s",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("uses backend ActiveCampaign discovery warnings in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "source_discovery_warnings",
            label: "Source discovery warnings",
            status: "blocker",
            detail:
              "ActiveCampaign discovery warnings mean optional source inventory may be unknown.",
            evidence: ["activecampaign forms count unavailable"],
          },
        ],
      },
      job,
      rebuilds: [],
      report: {
        ...report,
        discovery_warnings: ["activecampaign forms count unavailable"],
      },
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "source_discovery_warnings"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "ActiveCampaign discovery warnings mean optional source inventory may be unknown.",
    });
  });

  it("requires ActiveCampaign final delta evidence from pilot acceptance", () => {
    const missingDelta = buildPilotChecklist({
      acceptance,
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      missingDelta.find(
        (item) => item.key === "activecampaign_final_delta_import",
      ),
    ).toMatchObject({
      status: "blocker",
    });

    const withDelta = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_final_delta_import",
            label: "ActiveCampaign final delta import",
            status: "pass",
            detail:
              "Final delta import completed after the committed migration.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      withDelta.find(
        (item) => item.key === "activecampaign_final_delta_import",
      ),
    ).toMatchObject({
      status: "pass",
    });
  });

  it("requires HubSpot final delta evidence from pilot acceptance", () => {
    const missingDelta = buildPilotChecklist({
      acceptance: {
        ...hubSpotAcceptance,
        items: hubSpotAcceptance.items.filter(
          (item) => item.key !== "hubspot_final_delta_import",
        ),
      },
      job: hubSpotJob,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      missingDelta.find((item) => item.key === "hubspot_final_delta_import"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "Freeze HubSpot contact, primary-email, list/rule, and communication-preference edits, then run the authoritative full snapshot so current-email eligibility and every polling gap are reconciled before acceptance refresh.",
    });

    const withDelta = buildPilotChecklist({
      acceptance: hubSpotAcceptance,
      job: hubSpotJob,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      withDelta.find((item) => item.key === "hubspot_final_delta_import"),
    ).toMatchObject({
      status: "pass",
    });
  });

  it("uses the backend ActiveCampaign automation gate in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_automation_rebuild_review",
            label: "ActiveCampaign automation rebuild review",
            status: "blocker",
            detail:
              "ActiveCampaign automations were detected but no rebuild ledger exists.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(checklist.find((item) => item.key === "automations")).toMatchObject({
      status: "blocker",
      detail:
        "ActiveCampaign automations were detected but no rebuild ledger exists.",
    });
  });

  it("uses backend ActiveCampaign review blockers in the manual-review checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_crm_archive_review",
            label: "ActiveCampaign CRM archive",
            status: "blocker",
            expected: 2,
            actual: 1,
            detail:
              "Some ActiveCampaign CRM records were not preserved. Fix source archive access, export/sign off the missing CRM records, or document the external CRM system of record before email/SMS cutover.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "manual_review"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "1 ActiveCampaign rebuild/review surface(s) need fixes or explicit sign-off before cutover.",
    });
  });

  it("counts ActiveCampaign saved-segment blockers in the manual-review checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "blocker",
        blockers: 1,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_segments_review",
            label: "ActiveCampaign list and saved segment review",
            status: "blocker",
            expected: 3,
            actual: 2,
            detail:
              "Some ActiveCampaign saved segments could not be translated into executable Moosewave targeting.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "manual_review"),
    ).toMatchObject({
      status: "blocker",
      detail:
        "1 ActiveCampaign rebuild/review surface(s) need fixes or explicit sign-off before cutover.",
    });
  });

  it("surfaces the backend ActiveCampaign deliverability review", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        warnings: 2,
        items: [
          ...acceptance.items,
          {
            key: "activecampaign_deliverability_review",
            label: "ActiveCampaign deliverability review",
            status: "warning",
            detail:
              "Verify sending domains, tracking links, suppression policies, forms, webhooks, and final delta import evidence before moving ActiveCampaign traffic to Moosewave.",
          },
        ],
      },
      job,
      rebuilds: [],
      report,
      shadow,
    });

    expect(
      checklist.find(
        (item) => item.key === "activecampaign_deliverability_review",
      ),
    ).toMatchObject({
      status: "warning",
      detail:
        "Verify sending domains, tracking links, suppression policies, forms, webhooks, and final delta import evidence before moving ActiveCampaign traffic to Moosewave.",
    });
  });

  it("records ActiveCampaign manual-review warning evidence from acceptance checks", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              ...acceptance.items,
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "activecampaign_templates_review",
                label: "ActiveCampaign templates",
                status: "warning",
                detail: "Templates were preserved for rebuild/review.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      act(() => {
        buttonByText("Mark reviewed").click();
      });

      expect(callbacks.onMarkCutoverEvidence).toHaveBeenCalledWith(
        "activecampaign_templates_review",
        "ActiveCampaign templates",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("records ActiveCampaign manual-review blocker evidence from acceptance checks", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              ...acceptance.items,
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "activecampaign_templates_review",
                label: "ActiveCampaign templates",
                status: "blocker",
                detail:
                  "Only some source records were preserved for rebuild/review.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      act(() => {
        buttonByText("Mark reviewed").click();
      });

      expect(callbacks.onMarkCutoverEvidence).toHaveBeenCalledWith(
        "activecampaign_templates_review",
        "ActiveCampaign templates",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("records ActiveCampaign saved-segment blocker evidence from acceptance checks", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            items: [
              ...acceptance.items,
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "activecampaign_segments_review",
                label: "ActiveCampaign list and saved segment review",
                status: "blocker",
                detail:
                  "Saved segment source logic must be rebuilt or explicitly signed off.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      act(() => {
        buttonByText("Mark reviewed").click();
      });

      expect(callbacks.onMarkCutoverEvidence).toHaveBeenCalledWith(
        "activecampaign_segments_review",
        "ActiveCampaign list and saved segment review",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks source archive warnings as a cutover blocker", () => {
    const checklist = buildPilotChecklist({
      acceptance,
      job,
      rebuilds: [],
      report: {
        ...report,
        source_archive_warnings: [
          {
            resource: "activecampaign_form",
            source_id: "source_archive_warning:forms",
            name: "forms",
            warning:
              "forms source archive unavailable: activecampaign status 403",
          },
        ],
      },
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "source_archive_warnings"),
    ).toMatchObject({
      status: "blocker",
    });
  });

  it("uses backend ActiveCampaign source-archive warning sign-off in the top checklist", () => {
    const checklist = buildPilotChecklist({
      acceptance: {
        ...acceptance,
        status: "pass",
        blockers: 0,
        warnings: 0,
        items: [
          ...acceptance.items,
          {
            key: "source_archive_warnings",
            label: "Source archive warnings",
            status: "pass",
            detail:
              "Forms endpoint warning reviewed and explicitly out of cutover scope.",
          },
        ],
      },
      job,
      rebuilds: [],
      report: {
        ...report,
        source_archive_warnings: [
          {
            resource: "activecampaign_form",
            source_id: "source_archive_warning:forms",
            name: "forms",
            warning:
              "forms source archive unavailable: activecampaign status 403",
          },
        ],
      },
      shadow,
    });

    expect(
      checklist.find((item) => item.key === "source_archive_warnings"),
    ).toMatchObject({
      status: "pass",
      detail:
        "Forms endpoint warning reviewed and explicitly out of cutover scope.",
    });
  });

  it("records ActiveCampaign source-archive warning sign-off from acceptance checks", () => {
    const callbacks = {
      onMarkCutoverEvidence: vi.fn(async () => undefined),
    };
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          ...callbacks,
          acceptance: {
            ...acceptance,
            status: "blocker",
            blockers: 1,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "source_archive_warnings",
                label: "Source archive warnings",
                status: "blocker",
                detail:
                  "One or more source archive surfaces could not be fetched.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      act(() => {
        buttonByText("Mark reviewed").click();
      });

      expect(callbacks.onMarkCutoverEvidence).toHaveBeenCalledWith(
        "source_archive_warnings",
        "Source archive warnings",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not show review actions for already-passing ActiveCampaign sign-off rows", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...acceptance,
            status: "pass",
            blockers: 0,
            warnings: 0,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "source_discovery_warnings",
                label: "Source discovery warnings",
                status: "pass",
                detail: "Discovery completed without warnings.",
              },
              {
                key: "source_archive_warnings",
                label: "Source archive warnings",
                status: "pass",
                detail: "Source archive completed without warnings.",
              },
              {
                key: "sms_pilot",
                label: "SMS pilot readiness",
                status: "pass",
                detail: "SMS is out of pilot scope.",
              },
              {
                key: "rollback_rehearsal",
                label: "Rollback rehearsal",
                status: "pass",
                detail: "Rollback rehearsal passed.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      const reviewButtons = Array.from(
        document.querySelectorAll("button"),
      ).filter(
        (element) => element.textContent?.includes("Mark reviewed") === true,
      );
      expect(reviewButtons).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not show review actions for hard ActiveCampaign automation rebuild blockers", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...acceptance,
            status: "blocker",
            blockers: 1,
            warnings: 0,
            items: [
              {
                key: "activecampaign_final_delta_import",
                label: "ActiveCampaign final delta import",
                status: "pass",
                detail: "Final delta import completed.",
              },
              {
                key: "activecampaign_deliverability_review",
                label: "ActiveCampaign deliverability review",
                status: "pass",
                detail: "Deliverability reviewed.",
              },
              {
                key: "activecampaign_automation_rebuild_review",
                label: "ActiveCampaign automation rebuild review",
                status: "blocker",
                detail:
                  "ActiveCampaign automations must be rebuilt and test-passed before cutover.",
              },
            ],
          },
          shadow,
        }),
      ),
    );

    try {
      const reviewButtons = Array.from(
        document.querySelectorAll("button"),
      ).filter(
        (element) => element.textContent?.includes("Mark reviewed") === true,
      );
      expect(reviewButtons).toHaveLength(0);
    } finally {
      act(() => root.unmount());
    }
  });

  it("exports backend acceptance checks and evidence in the sign-off packet", () => {
    const packetAcceptance: PilotAcceptanceReport = {
      ...acceptance,
      status: "blocker",
      blockers: 1,
      items: [
        {
          key: "activecampaign_automation_rebuild_review",
          label: "ActiveCampaign automation rebuild review",
          status: "blocker",
          detail:
            "ActiveCampaign automations were detected but no rebuild ledger exists.",
          evidence: ["#1 Revenue | Journey (not_started)"],
        },
      ],
    };
    const checklist = buildPilotChecklist({
      acceptance: packetAcceptance,
      job,
      rebuilds: [],
      report: {
        ...report,
        automations_translated: 0,
        automations_unsupported: [
          {
            name: "Revenue | Journey",
            reason: "Preserved for rebuild review.",
          },
        ],
        resource_completeness: [
          {
            resource: "automations",
            label: "Automations",
            source_total: 1,
            imported: 0,
            supported: true,
            status: "manual_rebuild_required",
          },
        ],
      },
      shadow,
    });

    const rebuildReport: VerificationReport = {
      ...report,
      automations_translated: 0,
      automations_unsupported: [
        {
          name: "Revenue | Journey",
          reason: "Preserved for rebuild review.",
        },
      ],
      resource_completeness: [
        {
          resource: "automations",
          label: "Automations",
          source_total: 1,
          imported: 0,
          supported: true,
          status: "manual_rebuild_required",
        },
      ],
    };
    const markdown = buildPilotSignoffMarkdown({
      acceptance: packetAcceptance,
      checklist,
      job,
      rebuilds: [],
      report: rebuildReport,
      shadow,
      sourceEvents,
    });

    expect(markdown).toContain("| Check | Status | Detail | Evidence |");
    expect(markdown).toContain("ActiveCampaign automation rebuild review");
    expect(markdown).toContain(
      "ActiveCampaign automations were detected but no rebuild ledger exists.",
    );
    expect(markdown).toContain("#1 Revenue \\| Journey (not_started)");
    expect(markdown).toContain("## Source-Event Replay");
    expect(markdown).toContain("- Automation rebuilds detected: 1");
    expect(markdown).toContain("- Runtime automations activated: 0");
    expect(markdown).not.toContain("- Automations translated:");
    expect(markdown).toContain("- Events seen: 2");
    expect(markdown).toContain("- Events applied: 2");
    expect(markdown).toContain(
      "- Latest event: upsert subscriber; applied=yes; occurred=2026-06-28T02:04:00.000Z",
    );
  });

  it("records every Beehiiv post-delta manual-review and source-warning evidence row", () => {
    const onMarkCutoverEvidence = vi.fn(async () => undefined);
    const reviewItems: PilotAcceptanceReport["items"] = [
      {
        key: "beehiiv_final_delta_import",
        label: "Beehiiv final delta import",
        status: "pass",
        detail: "Final delta completed.",
      },
      {
        key: "beehiiv_consent_reconciliation",
        label: "Beehiiv consent and suppression reconciliation",
        status: "warning",
        detail: "Review consent provenance after final delta.",
      },
      {
        key: "beehiiv_segment_rules_review",
        label: "Beehiiv dynamic segment rules review",
        status: "warning",
        detail: "Rebuild or retire every dynamic predicate.",
      },
      {
        key: "beehiiv_campaign_archive_fidelity",
        label: "Beehiiv campaign archive content fidelity",
        status: "blocker",
        detail: "Review a campaign with missing expanded HTML.",
      },
      {
        key: "beehiiv_website_capture_rebuild_review",
        label: "Beehiiv website, theme, and capture-widget rebuild",
        status: "blocker",
        detail: "Review website and capture rebuild evidence.",
      },
      {
        key: "beehiiv_boosts_recommendations_rebuild_review",
        label: "Beehiiv Boosts and recommendation-network rebuild",
        status: "blocker",
        detail: "Review Boosts and recommendations rebuild evidence.",
      },
      {
        key: "beehiiv_ad_network_review",
        label: "Beehiiv Ad Network review",
        status: "blocker",
        detail: "Review Ad Network export and ownership evidence.",
      },
      {
        key: "source_discovery_warnings",
        label: "Source discovery warnings",
        status: "warning",
        detail: "Review the optional endpoint warning.",
      },
      {
        key: "source_archive_warnings",
        label: "Source archive warnings",
        status: "blocker",
        detail: "Review the inaccessible archive endpoint.",
      },
    ];
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...beehiivAcceptance,
            status: "blocker",
            blockers: 2,
            warnings: 3,
            items: reviewItems,
          },
          job: beehiivJob,
          onMarkCutoverEvidence,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
        }),
      ),
    );

    try {
      const buttons = buttonsByText("Mark reviewed");
      expect(buttons).toHaveLength(8);
      expect(buttons.every((button) => !button.disabled)).toBe(true);
      act(() => buttons.forEach((button) => button.click()));
      expect(onMarkCutoverEvidence.mock.calls).toEqual([
        [
          "beehiiv_consent_reconciliation",
          "Beehiiv consent and suppression reconciliation",
        ],
        [
          "beehiiv_segment_rules_review",
          "Beehiiv dynamic segment rules review",
        ],
        [
          "beehiiv_campaign_archive_fidelity",
          "Beehiiv campaign archive content fidelity",
        ],
        [
          "beehiiv_website_capture_rebuild_review",
          "Beehiiv website, theme, and capture-widget rebuild",
        ],
        [
          "beehiiv_boosts_recommendations_rebuild_review",
          "Beehiiv Boosts and recommendation-network rebuild",
        ],
        ["beehiiv_ad_network_review", "Beehiiv Ad Network review"],
        ["source_discovery_warnings", "Source discovery warnings"],
        ["source_archive_warnings", "Source archive warnings"],
      ]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps Beehiiv evidence controls gated on a successful final delta", () => {
    const onMarkCutoverEvidence = vi.fn(async () => undefined);
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: {
            ...beehiivAcceptance,
            status: "blocker",
            blockers: 2,
            items: [
              {
                key: "beehiiv_final_delta_import",
                label: "Beehiiv final delta import",
                status: "blocker",
                detail: "Run final delta import.",
              },
              {
                key: "beehiiv_consent_reconciliation",
                label: "Beehiiv consent and suppression reconciliation",
                status: "blocker",
                detail: "Review consent after final delta.",
              },
            ],
          },
          job: beehiivJob,
          onMarkCutoverEvidence,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
        }),
      ),
    );

    try {
      const reviewButton = buttonByText("Mark reviewed");
      expect(reviewButton.disabled).toBe(true);
      expect(reviewButton.title).toBe("Run final delta import first");
      act(() => reviewButton.click());
      expect(onMarkCutoverEvidence).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("uses Beehiiv final-delta and persisted shadow gates and requires every checklist row to pass", () => {
    const blockedAcceptance: PilotAcceptanceReport = {
      ...beehiivAcceptance,
      status: "warning",
      warnings: 1,
      items: beehiivPassingItems.map((item) =>
        item.key === "beehiiv_shadow_check"
          ? {
              ...item,
              status: "blocker" as const,
              detail: "The shadow check predates the final delta.",
            }
          : item.key === "beehiiv_consent_reconciliation"
            ? {
                ...item,
                status: "warning" as const,
                detail: "Consent provenance still needs owner review.",
              }
            : item,
      ),
    };
    const checklist = buildPilotChecklist({
      acceptance: blockedAcceptance,
      job: beehiivJob,
      rebuilds: [beehiivPassedRebuild],
      report: beehiivReport,
      shadow: {
        ...shadow,
        monitor: { ...shadow.monitor, source: "beehiiv" },
        history: [{ ...shadow.history[0], source: "beehiiv" }],
      },
    });
    expect(
      checklist.find((item) => item.key === "beehiiv_final_delta_import"),
    ).toMatchObject({ status: "pass" });
    expect(
      checklist.find((item) => item.key === "shadow_monitor"),
    ).toMatchObject({
      status: "blocker",
      detail: "The shadow check predates the final delta.",
    });

    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: blockedAcceptance,
          job: beehiivJob,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
          shadow: {
            ...shadow,
            monitor: { ...shadow.monitor, source: "beehiiv" },
            history: [{ ...shadow.history[0], source: "beehiiv" }],
          },
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).not.toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }

    const warningOnlyAcceptance: PilotAcceptanceReport = {
      ...beehiivAcceptance,
      status: "warning",
      warnings: 1,
      items: beehiivPassingItems.map((item) =>
        item.key === "beehiiv_consent_reconciliation"
          ? {
              ...item,
              status: "warning" as const,
              detail: "Consent provenance still needs owner review.",
            }
          : item,
      ),
    };
    const warningRoot = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: warningOnlyAcceptance,
          job: beehiivJob,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
          shadow: {
            ...shadow,
            monitor: { ...shadow.monitor, source: "beehiiv" },
            history: [{ ...shadow.history[0], source: "beehiiv" }],
          },
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain("blocked");
      expect(document.body.textContent).not.toContain("review-ready");
    } finally {
      act(() => warningRoot.unmount());
    }

    const passingRoot = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: beehiivAcceptance,
          job: beehiivJob,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain("review-ready");
    } finally {
      act(() => passingRoot.unmount());
    }
  });

  it("exports honest Beehiiv rebuild-only and live credential-cleanup instructions", () => {
    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: beehiivAcceptance,
          job: beehiivJob,
          rebuilds: [beehiivPassedRebuild],
          report: beehiivReport,
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain(
        "Beehiiv 100% readiness also requires credential cleanup evidence",
      );
      expect(document.body.textContent).toContain(
        "rotate or revoke the dedicated Beehiiv API key",
      );
      expect(document.body.textContent).toContain("rebuild-only automations");
    } finally {
      act(() => root.unmount());
    }

    const checklist = buildPilotChecklist({
      acceptance: beehiivAcceptance,
      job: beehiivJob,
      rebuilds: [beehiivPassedRebuild],
      report: beehiivReport,
      shadow: null,
    });
    const markdown = buildPilotSignoffMarkdown({
      acceptance: beehiivAcceptance,
      checklist,
      job: beehiivJob,
      rebuilds: [beehiivPassedRebuild],
      report: beehiivReport,
      shadow: null,
    });
    expect(markdown).toContain("## Beehiiv Credential Cleanup");
    expect(markdown).toContain(
      "Verify the retired key cannot access the bound Beehiiv workspace or publication",
    );
    expect(markdown).toContain("BEEHIIV_LIVE_CREDENTIAL_CLEANUP_REVIEW=1");
    expect(markdown).toContain(
      "BEEHIIV_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF=<non-secret reference>",
    );
    expect(markdown).toContain("## Beehiiv Manual Review");
    expect(markdown).toContain("BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF=1");
    expect(markdown).toContain(
      "BEEHIIV_LIVE_MANUAL_REVIEW_EVIDENCE_REF=<non-secret reference>",
    );
    expect(markdown).toContain("Automation migration mode: rebuild-only");
    expect(markdown).toContain("Runtime automations activated: 0");
    expect(markdown).not.toContain("Automations translated");
  });

  it("redacts sensitive ActiveCampaign provider details in shadow UI and sign-off packet", () => {
    const latestSourceEvent = sourceEvents.events[0];
    if (!latestSourceEvent)
      throw new Error("sourceEvents fixture missing event");
    const sensitiveShadow: ShadowMonitorResponse = {
      ...shadow,
      monitor: {
        ...shadow.monitor,
        last_error:
          "GET tenant.api-us1.com/api/3 failed with Api-Token: secret-token",
      },
    };
    const sensitiveSourceEvents: SourceEventMonitorResponse = {
      ...sourceEvents,
      monitor: {
        ...sourceEvents.monitor,
        last_error:
          "GET tenant.api-us1.com/api/3 failed with Api-Token: replay-secret",
      },
      events: [
        {
          ...latestSourceEvent,
          source_event_id: "activecampaign:contact:sensitive-42",
          error:
            "callback https://tenant.activehosted.com/api/3/forms Authorization: Bearer replay-super-secret",
        },
      ],
    };
    const packetAcceptance: PilotAcceptanceReport = {
      ...acceptance,
      items: [
        {
          key: "activecampaign_deliverability_review",
          label: "ActiveCampaign deliverability review",
          status: "warning",
          detail: "Review https://tenant.activehosted.com/api/3/settings",
          evidence: [
            "callback https://tenant.activehosted.com/api/3/forms Authorization: Bearer super-secret",
          ],
        },
      ],
    };

    expect(
      redactMigrationSensitiveText(
        "tenant.activehosted.com/api/3/forms Api-Key: secret",
      ),
    ).toBe("[redacted-activecampaign-api-url] Api-Key=[redacted]");
    expect(
      redactMigrationSensitiveText(
        "request https://tenant.eu.provider.example/api/3 failed; retry tenant.eu.provider.example/api/3 with status 503",
      ),
    ).toBe(
      "request [redacted-activecampaign-api-url] failed; retry [redacted-activecampaign-api-url] with status 503",
    );
    expect(redactMigrationSensitiveText("provider returned status 503")).toBe(
      "provider returned status 503",
    );
    expect(
      redactMigrationSensitiveText(
        "source-event replay failed for hubspot:contact:42 with access_token=secret",
      ),
    ).toBe(
      "source-event replay failed for [redacted-hubspot-source-event-id] with access_token=[redacted]",
    );

    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: packetAcceptance,
          shadow: sensitiveShadow,
          sourceEvents: sensitiveSourceEvents,
        }),
      ),
    );

    try {
      expect(document.body.textContent).toContain(
        "GET [redacted-activecampaign-api-url] failed with Api-Token=[redacted]",
      );
      expect(document.body.textContent).not.toContain("tenant.api-us1.com");
      expect(document.body.textContent).not.toContain("secret-token");
      expect(document.body.textContent).not.toContain("replay-secret");
      expect(document.body.textContent).not.toContain("replay-super-secret");
      expect(document.body.textContent).not.toContain(
        "activecampaign:contact:sensitive-42",
      );
    } finally {
      act(() => root.unmount());
    }

    const markdown = buildPilotSignoffMarkdown({
      acceptance: packetAcceptance,
      checklist: buildPilotChecklist({
        acceptance: packetAcceptance,
        job,
        rebuilds: [],
        report,
        shadow: sensitiveShadow,
        sourceEvents: sensitiveSourceEvents,
      }),
      job,
      rebuilds: [],
      report,
      shadow: sensitiveShadow,
      sourceEvents: sensitiveSourceEvents,
    });

    expect(markdown).toContain("## Source-Event Replay");
    expect(markdown).toContain("[redacted-activecampaign-api-url]");
    expect(markdown).toContain("Api-Token=[redacted]");
    expect(markdown).toContain("Authorization=[redacted]");
    expect(markdown).not.toContain("tenant.api-us1.com");
    expect(markdown).not.toContain("tenant.activehosted.com");
    expect(markdown).not.toContain("secret-token");
    expect(markdown).not.toContain("super-secret");
    expect(markdown).not.toContain("replay-secret");
    expect(markdown).not.toContain("replay-super-secret");
    expect(markdown).not.toContain("activecampaign:contact:sensitive-42");
  });

  it("wires Klaviyo final-delta, shadow, source-event, flow, and review gates", () => {
    const klaviyoJob: MigrationJob = {
      ...job,
      id: "mig_klaviyo",
      source: "klaviyo",
    };
    const klaviyoAcceptance: PilotAcceptanceReport = {
      ...acceptance,
      job_id: klaviyoJob.id,
      source: "klaviyo",
      status: "pass",
      blockers: 0,
      warnings: 0,
      items: [
        {
          key: "klaviyo_shadow_check",
          label: "Klaviyo shadow check",
          status: "pass",
          detail: "No source deltas remain.",
        },
        {
          key: "klaviyo_final_delta_import",
          label: "Klaviyo final delta import",
          status: "pass",
          detail: "Final profile and audience delta completed.",
        },
        {
          key: "klaviyo_source_event_replay",
          label: "Klaviyo source-event replay",
          status: "pass",
          detail: "Profile replay is clean.",
        },
        {
          key: "klaviyo_consent_suppression_review",
          label: "Klaviyo consent and suppression review",
          status: "pass",
          detail: "Consent and suppressions reconciled.",
        },
        {
          key: "klaviyo_audience_snapshot_review",
          label: "Klaviyo audience snapshot review",
          status: "pass",
          detail: "List and segment snapshots reconciled.",
        },
        {
          key: "klaviyo_flow_rebuild_review",
          label: "Klaviyo flow rebuild review",
          status: "pass",
          detail: "Flows were rebuilt or waived.",
        },
        {
          key: "klaviyo_channel_identity_review",
          label: "Klaviyo channel identity review",
          status: "pass",
          detail: "Channel identities and senders reviewed.",
        },
        {
          key: "klaviyo_deliverability_review",
          label: "Klaviyo deliverability review",
          status: "pass",
          detail: "Domains and warmup reviewed.",
        },
        {
          key: "klaviyo_ecosystem_dependencies_review",
          label: "Klaviyo ecosystem dependency review",
          status: "pass",
          detail: "Ecosystem dependencies were rebuilt, retained, or retired.",
        },
        {
          key: "sms_readiness",
          label: "SMS readiness",
          status: "pass",
          detail: "No destination SMS activation is in scope.",
        },
        {
          key: "rollback_rehearsal",
          label: "Rollback rehearsal",
          status: "pass",
          detail: "Rollback rehearsal passed.",
        },
      ],
    };
    const klaviyoShadow: ShadowMonitorResponse = {
      monitor: {
        ...shadow.monitor,
        job_id: klaviyoJob.id,
        source: "klaviyo",
      },
      history: [
        {
          ...shadow.history[0],
          job_id: klaviyoJob.id,
          source: "klaviyo",
        },
      ],
    };
    const klaviyoSourceEvents: SourceEventMonitorResponse = {
      monitor: {
        ...sourceEvents.monitor,
        job_id: klaviyoJob.id,
        source: "klaviyo",
      },
      events: [
        {
          ...sourceEvents.events[0],
          job_id: klaviyoJob.id,
          source: "klaviyo",
          source_event_id: "klaviyo:profile:sensitive-42",
        },
      ],
    };
    const klaviyoRebuild: AutomationRebuildItem = {
      ...rebuild,
      name: "Welcome flow",
      status: "test_passed",
    };
    const checklist = buildPilotChecklist({
      acceptance: klaviyoAcceptance,
      job: klaviyoJob,
      rebuilds: [klaviyoRebuild],
      report: { ...report, automations_translated: 0 },
      shadow: klaviyoShadow,
      sourceEvents: klaviyoSourceEvents,
    });

    for (const key of [
      "klaviyo_final_delta_import",
      "klaviyo_source_event_replay",
      "klaviyo_flow_rebuild_review",
      "klaviyo_consent_suppression_review",
      "klaviyo_audience_snapshot_review",
      "klaviyo_channel_identity_review",
      "klaviyo_deliverability_review",
      "klaviyo_ecosystem_dependencies_review",
    ]) {
      expect(checklist.find((item) => item.key === key)?.status).toBe("pass");
    }

    const fallbackChecklist = buildPilotChecklist({
      acceptance: null,
      job: klaviyoJob,
      rebuilds: [klaviyoRebuild],
      report: { ...report, automations_translated: 0 },
      shadow: klaviyoShadow,
      sourceEvents: klaviyoSourceEvents,
    });
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_consent_suppression_review",
      ),
    ).toMatchObject({
      label: "Klaviyo profile identity, consent, and suppression review",
      status: "blocker",
    });
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_consent_suppression_review",
      )?.detail,
    ).toContain("stable Get Profiles response does not expose secondary email");
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_ecosystem_dependencies_review",
      )?.detail,
    ).toContain("retained-source/provider-export path");
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_audience_snapshot_review",
      )?.detail,
    ).toContain("send-targetable list and segment projection");
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_audience_snapshot_review",
      )?.detail,
    ).toContain("not raw Klaviyo membership");
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_ecosystem_dependencies_review",
      )?.detail,
    ).toContain(
      "nullable draft message definitions and IDs-only campaign tags",
    );
    expect(
      fallbackChecklist.find(
        (item) => item.key === "klaviyo_ecosystem_dependencies_review",
      )?.detail,
    ).toContain("unconditional checklists, not detected inventory");

    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: klaviyoAcceptance,
          job: klaviyoJob,
          rebuilds: [klaviyoRebuild],
          report: { ...report, automations_translated: 0 },
          shadow: klaviyoShadow,
          sourceEvents: klaviyoSourceEvents,
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain(
        "Klaviyo acceptance gates: final primary-profile and audience snapshot reconciliation",
      );
      expect(document.body.textContent).toContain(
        "mandatory secondary-address and per-address-consent review",
      );
      expect(document.body.textContent).toContain("Source-event replay");
      expect(document.body.textContent).toContain("Klaviyo flow rebuilds");
      expect(document.body.textContent).toContain(
        "Klaviyo 100% readiness also requires credential cleanup evidence",
      );
      expect(document.body.textContent).toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }

    const markdown = buildPilotSignoffMarkdown({
      acceptance: klaviyoAcceptance,
      checklist,
      job: klaviyoJob,
      rebuilds: [klaviyoRebuild],
      report: { ...report, automations_translated: 0 },
      shadow: klaviyoShadow,
      sourceEvents: klaviyoSourceEvents,
    });
    expect(markdown).toContain("## Source-Event Replay");
    expect(markdown).toContain("## Flow Rebuilds");
    expect(markdown).toContain("Flow migration mode: rebuild-only");
    expect(markdown).toContain("## Klaviyo Credential Cleanup");
    expect(markdown).not.toContain("klaviyo:profile:sensitive-42");
    expect(
      redactMigrationSensitiveText(
        "replay failed for klaviyo:profile:sensitive-42",
      ),
    ).toBe("replay failed for [redacted-klaviyo-source-event-id]");
  });

  it("wires Customer.io full-snapshot gates without claiming source-event replay", () => {
    const customerIOJob: MigrationJob = {
      ...job,
      id: "mig_customerio",
      source: "customerio",
    };
    const reviewKeys = [
      "customerio_consent_subscription_review",
      "customerio_identity_audience_review",
      "customerio_automation_rebuild_review",
      "customerio_channel_dependency_review",
      "customerio_deliverability_review",
      "customerio_ecosystem_dependencies_review",
    ] as const;
    const customerIOAcceptance: PilotAcceptanceReport = {
      ...acceptance,
      job_id: customerIOJob.id,
      source: "customerio",
      status: "pass",
      blockers: 0,
      warnings: 0,
      items: [
        {
          key: "customerio_shadow_check",
          label: "Customer.io shadow check",
          status: "pass",
          detail: "The exact post-delta fingerprint is clean.",
        },
        {
          key: "customerio_final_delta_import",
          label: "Customer.io final delta import",
          status: "pass",
          detail: "The frozen full immutable-cio_id snapshot completed.",
        },
        ...reviewKeys.map((key) => ({
          key,
          label: key,
          status: "pass" as const,
          detail: `${key} completed after final delta.`,
        })),
        {
          key: "sms_readiness",
          label: "SMS readiness",
          status: "pass",
          detail: "Non-email runtime is outside migration scope.",
        },
        {
          key: "rollback_rehearsal",
          label: "Rollback rehearsal",
          status: "pass",
          detail: "Rollback rehearsal passed.",
        },
      ],
    };
    const customerIOShadow: ShadowMonitorResponse = {
      monitor: {
        ...shadow.monitor,
        job_id: customerIOJob.id,
        source: "customerio",
      },
      history: [
        {
          ...shadow.history[0],
          job_id: customerIOJob.id,
          source: "customerio",
        },
      ],
    };
    const customerIOReport: VerificationReport = {
      ...report,
      automations_translated: 0,
      automations_unsupported: [
        {
          name: "Lifecycle campaign",
          reason: "Customer.io workflow definition preserved for rebuild.",
        },
      ],
      resource_completeness: [
        {
          resource: "automations",
          label: "Customer.io campaign and API-broadcast workflows",
          source_total: 1,
          imported: 1,
          supported: true,
          status: "preserved_for_rebuild",
        },
      ],
    };
    const customerIORebuild: AutomationRebuildItem = {
      ...rebuild,
      name: "Lifecycle campaign",
      status: "test_passed",
    };
    const checklist = buildPilotChecklist({
      acceptance: customerIOAcceptance,
      job: customerIOJob,
      rebuilds: [customerIORebuild],
      report: customerIOReport,
      shadow: customerIOShadow,
      sourceEvents: null,
    });

    expect(new Set(checklist.map((item) => item.key)).size).toBe(
      checklist.length,
    );
    for (const key of ["customerio_final_delta_import", ...reviewKeys]) {
      expect(checklist.find((item) => item.key === key)?.status).toBe("pass");
    }
    expect(
      checklist.some((item) => item.key === "customerio_source_event_replay"),
    ).toBe(false);

    const root = render(
      createElement(
        PilotAcceptanceCard,
        props({
          acceptance: customerIOAcceptance,
          job: customerIOJob,
          rebuilds: [customerIORebuild],
          report: customerIOReport,
          shadow: customerIOShadow,
          sourceEvents: null,
        }),
      ),
    );
    try {
      expect(document.body.textContent).toContain(
        "Customer.io acceptance gates: a final complete immutable-cio_id snapshot",
      );
      expect(document.body.textContent).toContain(
        "Customer.io workflow rebuilds",
      );
      expect(document.body.textContent).toContain(
        "Customer.io 100% readiness also requires credential cleanup evidence",
      );
      expect(document.body.textContent).not.toContain("Source-event replay");
      expect(document.body.textContent).toContain("review-ready");
    } finally {
      act(() => root.unmount());
    }

    const markdown = buildPilotSignoffMarkdown({
      acceptance: customerIOAcceptance,
      checklist,
      job: customerIOJob,
      rebuilds: [customerIORebuild],
      report: customerIOReport,
      shadow: customerIOShadow,
      sourceEvents: null,
    });
    expect(markdown).toContain("## Workflow Rebuilds");
    expect(markdown).toContain("## Customer.io Manual Review");
    expect(markdown).toContain(
      "global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default",
    );
    expect(markdown).toContain(
      "sender-specific SMS/WhatsApp /v1/optouts separate from subscription-center channel-type preferences",
    );
    expect(markdown).toContain("must not determine email status");
    expect(markdown).toContain("## Customer.io Credential Cleanup");
    expect(markdown).not.toContain("## Source-Event Replay");
    expect(
      redactMigrationSensitiveText(
        "review customerio:profile:sensitive-42, customerio:subscription_channel:email, and customerio:checklist:sender_channel_settings before cutover",
      ),
    ).toBe(
      "review [redacted-customerio-source-id], [redacted-customerio-source-id], and [redacted-customerio-source-id] before cutover",
    );
  });
});
