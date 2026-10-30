// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  migrationWizardAutomationSummary,
  migrationWizardResourceStatusLabel,
} from "../../components/MigrationWizard";
import { DryRunPreview } from "../../components/migration/DryRunPreview";
import { MigrationWizardVerifyStep } from "../../components/migration/MigrationWizardVerifyStep";
import {
  automationProgressDone,
  automationProgressLabel,
  automationProgressValueLabel,
  computeMigrationPercent,
  deriveMigrationDoneResources,
  migrationProgressStep,
} from "../../components/migration/ProgressView";
import {
  VerificationDiff,
  verificationAutomationSummary,
} from "../../components/migration/VerificationDiff";
import type { MigrationPreview, MigrationProgress } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => {
      currentRoot.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  act(() => {
    nextRoot.render(node);
  });
}

function activeCampaignReport(): MigrationPreview {
  return {
    subscribers_imported: 1200,
    suppression_list_size: 18,
    custom_fields_mapped: [],
    custom_fields_unmapped: [],
    segments_translated: 12,
    segments_with_warnings: [],
    automations_translated: 0,
    automations_unsupported: [],
    paid_subs_imported: 0,
    archive_imported: 22,
    resource_completeness: [
      {
        resource: "templates",
        label: "Templates and messages",
        source_total: 6,
        imported: 6,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "Message/template inventory is preserved as source archive evidence for rebuild.",
        ],
      },
      {
        resource: "forms",
        label: "Forms",
        source_total: 3,
        imported: 3,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "Recreate hosted and embedded forms in Moosewave before switching capture points.",
        ],
      },
      {
        resource: "automations",
        label: "Automations",
        source_total: 4,
        imported: 0,
        supported: true,
        status: "manual_rebuild_required",
        notes: ["Automation records require rebuild review before activation."],
      },
      {
        resource: "crm",
        label: "CRM deals and pipelines",
        source_total: 4,
        imported: 4,
        supported: true,
        status: "preserved_for_rebuild",
        notes: [
          "ActiveCampaign CRM records are preserved as read-only context.",
        ],
      },
      {
        resource: "subscribers",
        label: "Contacts",
        source_total: 1200,
        imported: 1200,
        supported: true,
        status: "imported_runtime",
      },
    ],
    data_loss_estimate_pct: 1.2,
  };
}

function activeCampaignProgress(): MigrationProgress {
  return {
    subscribers_total: 100,
    subscribers_done: 100,
    segments_total: 5,
    segments_done: 5,
    automations_total: 4,
    automations_done: 0,
    paid_subs_total: 0,
    paid_subs_done: 0,
    archive_total: 10,
    archive_done: 10,
  };
}

describe("desktop ActiveCampaign migration review surfaces", () => {
  it("shows cutover review surfaces before commit", () => {
    render(
      <DryRunPreview
        jobId="job_activecampaign_123"
        source="activecampaign"
        sourceLabel="ActiveCampaign"
        preview={activeCampaignReport()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("Cutover review surfaces");
    expect(document.body.textContent).toContain("Templates and messages");
    expect(document.body.textContent).toContain("Forms");
    expect(document.body.textContent).toContain("Automations");
    expect(document.body.textContent).toContain("CRM deals and pipelines");
    expect(document.body.textContent).toContain("Automation rebuilds");
    expect(document.body.textContent).toContain("4 need rebuild review");
    expect(document.body.textContent).toContain(
      "Automation records require rebuild review before activation.",
    );
    expect(document.body.textContent).toContain(
      "18 suppressed or unsubscribed at the source (preserved)",
    );
    expect(document.body.textContent).not.toContain("18 already exist");
    expect(document.body.textContent).not.toContain("Sequences");
  });

  it("labels newer resource-completeness statuses honestly", () => {
    render(
      <VerificationDiff
        report={activeCampaignReport()}
        source="activecampaign"
      />,
    );

    expect(document.body.textContent).toContain("Preserved for rebuild");
    expect(document.body.textContent).toContain("Manual rebuild required");
    expect(document.body.textContent).not.toContain("preserved_for_rebuild");
    expect(document.body.textContent).not.toContain("manual_rebuild_required");
  });

  it("labels unsupported ActiveCampaign automations as rebuild review in verification", () => {
    render(
      <VerificationDiff
        source="activecampaign"
        report={{
          ...activeCampaignReport(),
          automations_unsupported: [
            {
              name: "Welcome nurture",
              reason:
                "Automation records require rebuild review before activation.",
            },
          ],
        }}
      />,
    );

    expect(document.body.textContent).toContain(
      "Automation rebuilds to review",
    );
    expect(document.body.textContent).toContain("Welcome nurture");
    expect(document.body.textContent).not.toContain("Automations not imported");

    expect(
      verificationAutomationSummary("activecampaign", {
        ...activeCampaignReport(),
        automations_unsupported: [
          {
            name: "Welcome nurture",
            reason:
              "Automation records require rebuild review before activation.",
          },
        ],
      }),
    ).toEqual({
      label: "Automation rebuilds",
      value: 4,
      unsupportedTitle: "Automation rebuilds to review",
    });
  });

  it("treats automation inventory as rebuild review in live progress math", () => {
    const progress = activeCampaignProgress();

    expect(automationProgressLabel("activecampaign")).toBe(
      "Automation rebuilds",
    );
    expect(automationProgressDone(progress, "activecampaign")).toBe(0);
    expect(automationProgressValueLabel(progress, "activecampaign")).toBe(
      "4 to review",
    );
    expect(computeMigrationPercent(progress, "activecampaign")).toBe(99);
    expect(computeMigrationPercent(undefined, "activecampaign")).toBeNull();
    expect(
      computeMigrationPercent(
        { subscribers_total: 0, subscribers_done: 1 },
        "activecampaign",
      ),
    ).toBeNull();
  });

  it("preserves review counts when deriving terminal resources from a snapshot", () => {
    const resources = deriveMigrationDoneResources(
      activeCampaignProgress(),
      "activecampaign",
    );

    expect(resources.automations).toEqual({
      imported: 0,
      skipped: 4,
      failed: 0,
      review: 4,
    });
  });

  it("treats Beehiiv automations and premium counts as review metadata, not unfinished runtime work", () => {
    const progress = {
      ...activeCampaignProgress(),
      paid_subs_total: 40,
      paid_subs_done: 0,
    };

    expect(automationProgressLabel("beehiiv")).toBe(
      "Beehiiv automation rebuild inventory",
    );
    expect(automationProgressDone(progress, "beehiiv")).toBe(0);
    expect(automationProgressValueLabel(progress, "beehiiv")).toBe(
      "4 to rebuild or retire",
    );
    expect(computeMigrationPercent(progress, "beehiiv")).toBe(99);
    expect(
      migrationProgressStep("beehiiv", {
        resource: "automations",
        completed: 0,
        total: 4,
        current_step: "Translating automations",
      }),
    ).toBe("Preserving Beehiiv automation rebuild evidence");
    expect(
      deriveMigrationDoneResources(progress, "beehiiv").automations,
    ).toEqual({ imported: 0, skipped: 4, failed: 0, review: 4 });
  });

  it("treats Klaviyo flows as rebuild work and labels archive progress as sent-email-only", () => {
    const progress = activeCampaignProgress();

    expect(automationProgressLabel("klaviyo")).toBe(
      "Klaviyo flow rebuild inventory",
    );
    expect(automationProgressValueLabel(progress, "klaviyo")).toBe(
      "4 to rebuild or retire",
    );
    expect(computeMigrationPercent(progress, "klaviyo")).toBe(99);
    expect(
      migrationProgressStep("klaviyo", {
        resource: "archive",
        completed: 5,
        total: 10,
      }),
    ).toBe("Preserving sent email campaign archive records");
    expect(
      migrationProgressStep("klaviyo", {
        resource: "source_archive",
        completed: 1,
        total: 4,
      }),
    ).toBe(
      "Preserving SMS/push, identity-consent, rebuild, and static checklist evidence",
    );
    expect(
      deriveMigrationDoneResources(progress, "klaviyo").automations,
    ).toEqual({ imported: 0, skipped: 4, failed: 0, review: 4 });
  });

  it("formats wizard fallback and completion summaries with rebuild language", () => {
    const activeCampaignSummary = migrationWizardAutomationSummary(
      "activecampaign",
      activeCampaignReport(),
    );

    expect(activeCampaignSummary).toEqual({
      label: "Automation rebuilds",
      value: "4 to review",
      riskTitle: "Automation rebuilds need review",
      riskNotes: [
        "Automation records require rebuild review before activation.",
      ],
    });
    expect(migrationWizardResourceStatusLabel("manual_rebuild_required")).toBe(
      "Manual rebuild required",
    );
    expect(migrationWizardResourceStatusLabel("preserved_for_rebuild")).toBe(
      "Preserved for rebuild",
    );

    const mailchimpSummary = migrationWizardAutomationSummary("mailchimp", {
      ...activeCampaignReport(),
      automations_translated: 2,
      automations_unsupported: [
        { name: "Branch", reason: "Unsupported split" },
      ],
    });

    expect(mailchimpSummary).toEqual({
      label: "Classic Automations",
      value: "2 imported paused (+1 manual review)",
      riskTitle: "Classic Automations requiring manual review",
      riskNotes: ["Branch - Unsupported split"],
    });

    const beehiivSummary = migrationWizardAutomationSummary("beehiiv", {
      ...activeCampaignReport(),
      automations_translated: 0,
      automations_unsupported: [
        { name: "Welcome", reason: "Rebuild from preserved metadata" },
      ],
    });
    expect(beehiivSummary).toEqual({
      label: "Beehiiv automation rebuild records",
      value: "4 to rebuild or retire",
      riskTitle: "Beehiiv automations are never activated automatically",
      riskNotes: [
        "Automation records require rebuild review before activation.",
      ],
    });

    expect(
      verificationAutomationSummary("beehiiv", activeCampaignReport()),
    ).toEqual({
      label: "Beehiiv automation rebuild records",
      value: 4,
      unsupportedTitle: "Beehiiv automations to rebuild or retire",
    });

    const klaviyoSummary = migrationWizardAutomationSummary(
      "klaviyo",
      activeCampaignReport(),
    );
    expect(klaviyoSummary).toEqual({
      label: "Klaviyo flow rebuild records",
      value: "4 to rebuild or retire",
      riskTitle: "Klaviyo flows are never activated automatically",
      riskNotes: [
        "Automation records require rebuild review before activation.",
      ],
    });
  });

  it("labels supported Mailchimp Classic Automations as paused and unsupported ones as manual review", () => {
    const report = activeCampaignReport();
    report.automations_translated = 1;
    report.automations_unsupported = [
      {
        name: "Unsupported Mailchimp workflow",
        reason: "This workflow requires manual rebuild review.",
      },
    ];
    render(
      <DryRunPreview
        jobId="job_mailchimp_123"
        source="mailchimp"
        sourceLabel="Mailchimp"
        preview={report}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain("Classic Automations");
    expect(document.body.textContent).toContain("1 will be imported paused");
    expect(document.body.textContent).toContain(
      "1 automation requires manual rebuild or review and will not be activated",
    );
    expect(document.body.textContent).not.toContain("Sequences");
    expect(document.body.textContent).not.toContain(
      "fall back to standard steps",
    );
  });

  it("shows Beehiiv snapshot, rebuild, and no-billing boundaries before commit", () => {
    const report = activeCampaignReport();
    report.resource_completeness = [
      ...(report.resource_completeness ?? []),
      {
        resource: "premium_memberships",
        label: "Premium membership metadata",
        source_total: 30,
        imported: 30,
        supported: true,
        status: "imported_runtime",
      },
    ];
    render(
      <DryRunPreview
        jobId="job_beehiiv_123"
        source="beehiiv"
        sourceLabel="Beehiiv"
        preview={report}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain(
      "Frozen segment/list snapshots",
    );
    expect(document.body.textContent).toContain(
      "Beehiiv automation rebuild records",
    );
    expect(document.body.textContent).toContain(
      "Premium memberships (metadata only)",
    );
    expect(document.body.textContent).toContain(
      "Stripe billing is not part of this import",
    );
    expect(document.body.textContent).not.toContain(
      "Paid Stripe subscriptions",
    );
  });

  it("shows Klaviyo snapshots, archive-only campaigns, and rebuild-only flows before commit", () => {
    render(
      <DryRunPreview
        jobId="job_klaviyo_123"
        source="klaviyo"
        sourceLabel="Klaviyo"
        preview={activeCampaignReport()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain(
      "Enumerated send-targetable list/segment snapshots",
    );
    expect(document.body.textContent).toContain("Klaviyo flow rebuild records");
    expect(document.body.textContent).toContain(
      "Sent email campaigns (archive only)",
    );
    expect(document.body.textContent).toContain(
      "Klaviyo runtime parity is not part of this import",
    );
    expect(document.body.textContent).toContain(
      "Stable Klaviyo profile retrieval exposes only the primary email",
    );
    expect(document.body.textContent).toContain(
      "Secondary addresses and independent per-address consent do not import",
    );
    expect(document.body.textContent).toContain(
      "reconcile the multi-email source-archive record during both consent and ecosystem review",
    );
    expect(document.body.textContent).toContain(
      "Unnamed audiences use deterministic Klaviyo list/segment ID labels",
    );
    expect(document.body.textContent).toContain(
      "predictive profile reads use the stricter 10/second, 150/minute tier",
    );
    expect(document.body.textContent).toContain(
      "If a stable profile ID changes email A→B while source-owned A remains active, incremental replay stops before writing",
    );
    expect(document.body.textContent).toContain(
      "full-snapshot delta must materialize B and disable A before replay resumes",
    );
    expect(document.body.textContent).toContain(
      "Membership counts/tags are the enumerated send-targetable projection after validated list-level suppressions, not a separately exposed raw count",
    );
    expect(document.body.textContent).toContain(
      "Draft campaign-message and flow definitions may be null",
    );
    expect(document.body.textContent).toContain(
      "Campaign tags retain provider IDs only, not names or groups",
    );
    expect(document.body.textContent).toContain(
      "Eight unconditional static checklist rows each report one checklist record but do not prove product inventory",
    );
    expect(document.body.textContent).toContain(
      "Reports, SMS identities and consent continuity, and ecommerce do not migrate",
    );
    expect(document.body.textContent).toContain(
      "SMS/push history is non-executable source-archive evidence",
    );
    expect(document.body.textContent).not.toContain("Sequences");
  });

  it("does not present a completed Klaviyo import as cutover certification", () => {
    render(
      <MigrationWizardVerifyStep
        job={{
          id: "job_klaviyo_complete",
          source: "klaviyo",
          status: "completed",
          rollback_until: new Date(Date.now() + 60_000).toISOString(),
          verification_report: activeCampaignReport(),
        }}
        preview={activeCampaignReport()}
        err={null}
        onClose={vi.fn()}
        onRollback={vi.fn()}
        onReenterKey={vi.fn()}
      />,
    );

    expect(document.body.textContent).toContain(
      "Initial import finished; Klaviyo cutover is not certified",
    );
    expect(document.body.textContent).toContain(
      "Klaviyo cutover requires separate final evidence",
    );
    expect(document.body.textContent).toContain("final full-snapshot delta");
    expect(document.body.textContent).toContain(
      "reconcile secondary addresses and independent per-address consent from the multi-email source-archive record",
    );
    expect(document.body.textContent).toContain(
      "evidence attached to consent and ecosystem review",
    );
    expect(document.body.textContent).toContain(
      "stable-ID email A→B change was resolved by materializing B and disabling prior source-owned A",
    );
    expect(document.body.textContent).toContain(
      "list/segment counts and tags as the enumerated send-targetable projection after validated list-level suppressions, not raw membership",
    );
    expect(document.body.textContent).toContain(
      "Recover or retire nullable flow/draft-message definitions and resolve campaign tag IDs",
    );
    expect(document.body.textContent).toContain(
      "eight static source-archive checklist rows are obligations, not source inventory",
    );
    expect(document.body.textContent).not.toContain(
      "The server reports that the migration completed",
    );
  });
});
