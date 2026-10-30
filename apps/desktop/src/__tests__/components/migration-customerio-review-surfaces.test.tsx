// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DryRunPreview } from "../../components/migration/DryRunPreview";
import {
  customerIODiscoveryEvidenceText,
  hubSpotDiscoveryEvidenceText,
} from "../../components/MigrationWizard";
import { migrationDetailProgressRows } from "../../components/migration/MigrationDetailSurface";
import { sourceCapabilityTruth } from "../../components/migration/MigrationHistorySurface";
import { MigrationVerificationEvidence } from "../../components/migration/MigrationVerificationEvidence";
import { MigrationWizardVerifyStep } from "../../components/migration/MigrationWizardVerifyStep";
import {
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
import { migrationWizardAutomationSummary } from "../../components/migration/migration-wizard-summary";
import {
  migrationOverallProgress,
  migrationResourceLabel,
} from "../../components/migration/migrations-surface-helpers";
import type {
  MigrationJob,
  MigrationProgress,
  MigrationVerificationReport,
} from "../../lib/api-client";

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
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function customerIoProgress(
  overrides: Partial<MigrationProgress> = {},
): MigrationProgress {
  return {
    subscribers_total: 10,
    subscribers_done: 10,
    segments_total: 2,
    segments_done: 2,
    automations_total: 4,
    automations_done: 4,
    paid_subs_total: 50,
    paid_subs_done: 0,
    archive_total: 1,
    archive_done: 1,
    templates_total: 1,
    templates_done: 1,
    source_archive_total: 10,
    source_archive_done: 10,
    ...overrides,
  };
}

it("surfaces exact Customer.io channel-definition discovery evidence without overstating consent or object parity", () => {
  expect(
    customerIODiscoveryEvidenceText({
      job_id: "job-customerio",
      source: "customerio",
      subscribers_count: 12,
      segments_count: 2,
      automations_count: 3,
      archive_count: 4,
      paid_subs_count: 0,
      subscription_channels_count: 3,
      custom_objects_count: 2,
      profiles_without_email_count: 5,
    }),
  ).toBe(
    "Customer.io preflight found 3 subscription-channel definitions, 2 custom-object types, and 5 profiles without a usable email. These are exact source-inventory evidence; channel definitions are not consent, object types are not object-profile parity, and non-email identities are not fabricated into email subscribers.",
  );
});

it("surfaces HubSpot non-email and additional-email identity boundaries separately", () => {
  expect(
    hubSpotDiscoveryEvidenceText({
      job_id: "job-hubspot",
      source: "hubspot",
      subscribers_count: 12,
      segments_count: 4,
      automations_count: 0,
      archive_count: 0,
      paid_subs_count: 0,
      profiles_without_email_count: 3,
      additional_email_identities_count: 5,
    }),
  ).toBe(
    "HubSpot preflight found 3 contacts without a valid current primary email and 5 additional email identities. Neither category is fabricated into an independent sendable subscriber; additional addresses remain exact reconciliation evidence tied to the current primary-email boundary.",
  );
});

it("labels HubSpot segment progress as the combined list and subscription boundary count", () => {
  expect(migrationResourceLabel("segments", "hubspot")).toBe(
    "List/subscription targeting boundaries",
  );

  const rows = migrationDetailProgressRows({
    ...completedCustomerIoJob(),
    id: "job_hubspot_complete",
    source: "hubspot",
    progress: customerIoProgress({
      segments_total: 3,
      segments_done: 3,
    }),
  });
  const segmentRow = rows.find((row) => row.key === "segments");

  expect(segmentRow).toMatchObject({
    label: "Frozen list/subscription targeting boundaries",
    done: 3,
    total: 3,
    truth:
      "Combined list snapshots and active subscription-definition targeting boundaries",
  });
});

function customerIoReport(): MigrationVerificationReport {
  return {
    subscribers_imported: 10,
    suppression_list_size: 2,
    segments_translated: 2,
    automations_translated: 4,
    paid_subs_imported: 0,
    archive_imported: 1,
    templates_imported: 1,
    source_archive_imported: 10,
    source_archive_by_resource: {
      customerio_subscription_channel: 3,
    },
    consent_known: 8,
    consent_unknown: 2,
    data_loss_estimate_pct: 0,
    resource_completeness: [
      {
        resource: "subscribers",
        label: "Email-addressable Customer.io profiles",
        source_total: 10,
        imported: 10,
        supported: true,
        status: "preserved_for_rebuild",
      },
      {
        resource: "segments",
        label: "Segment and subscription-topic snapshots",
        source_total: 2,
        imported: 2,
        supported: true,
        status: "preserved_for_rebuild",
      },
      {
        resource: "workflow_definitions",
        label: "Campaign and API-broadcast workflow definitions",
        source_total: 4,
        imported: 4,
        supported: true,
        status: "preserved_for_rebuild",
        notes: ["Definitions require manual rebuild and testing."],
      },
      {
        resource: "campaigns",
        label: "Sent email newsletter archive",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "imported_runtime",
      },
      {
        resource: "source_archive",
        label: "Exact Customer.io source archive",
        source_total: 10,
        imported: 10,
        supported: true,
        status: "imported_runtime",
      },
      {
        resource: "transactional",
        label: "Transactional message definitions",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "preserved_for_rebuild",
      },
      {
        resource: "channel_dependencies",
        label: "SMS, push, in-app, and other channel dependencies",
        source_total: 2,
        imported: 1,
        supported: false,
        status: "manual_rebuild_required",
      },
      {
        resource: "deliverability",
        label: "Customer.io deliverability and domain dependencies",
        source_total: 1,
        imported: 1,
        supported: true,
        status: "preserved_for_rebuild",
      },
      {
        resource: "ecosystem",
        label: "Customer.io ecosystem and event dependencies",
        source_total: 7,
        imported: 7,
        supported: true,
        status: "preserved_for_rebuild",
      },
    ],
    automations_unsupported: [
      { name: "Welcome campaign", reason: "Rebuild and test manually." },
    ],
    source_archive_warnings: [
      {
        resource: "customerio_transactional_message",
        name: "Receipt",
        warning: "Trigger wiring requires rebuild.",
      },
    ],
  };
}

it("preserves the exact Customer.io subscription-channel archive count in verification evidence", () => {
  expect(
    customerIoReport().source_archive_by_resource
      ?.customerio_subscription_channel,
  ).toBe(3);
});

function completedCustomerIoJob(): MigrationJob {
  return {
    id: "job_customerio_complete",
    source: "customerio",
    status: "completed",
    rollback_until: new Date(Date.now() + 60_000).toISOString(),
    progress: customerIoProgress(),
    verification_report: customerIoReport(),
  };
}

describe("desktop Customer.io migration truth surfaces", () => {
  it("treats workflow traversal as rebuild progress, never runtime automation completion", () => {
    const progress = customerIoProgress();

    expect(automationProgressLabel("customerio")).toBe(
      "Customer.io workflow rebuild inventory",
    );
    expect(automationProgressValueLabel(progress, "customerio")).toBe(
      "4 to rebuild or retire",
    );
    expect(computeMigrationPercent(progress, "customerio")).toBe(99);
    expect(
      computeMigrationPercent(
        customerIoProgress({ source_archive_done: 5 }),
        "customerio",
      ),
    ).toBe(79);
    expect(migrationOverallProgress(progress, "customerio")).toBe(100);
    expect(
      migrationOverallProgress(
        customerIoProgress({ source_archive_done: 5 }),
        "customerio",
      ),
    ).toBe(94);

    expect(deriveMigrationDoneResources(progress, "customerio")).toMatchObject({
      automations: { imported: 0, skipped: 4, failed: 0, review: 4 },
      templates: { imported: 1, skipped: 0, failed: 0 },
      source_archive: { imported: 10, skipped: 0, failed: 0 },
    });
  });

  it("uses snapshot, newsletter-archive, and source-evidence progress steps", () => {
    expect(
      migrationProgressStep("customerio", {
        resource: "automations",
        completed: 1,
        total: 4,
      }),
    ).toBe("Preserving Customer.io workflow rebuild evidence");
    expect(
      migrationProgressStep("customerio", {
        resource: "segments",
        completed: 2,
        total: 2,
      }),
    ).toBe(
      "Preserving frozen segment and subscription-topic membership snapshots",
    );
    expect(
      migrationProgressStep("customerio", {
        resource: "archive",
        completed: 1,
        total: 1,
      }),
    ).toBe("Preserving sent email newsletter archive records");
    expect(
      migrationProgressStep("customerio", {
        resource: "source_archive",
        completed: 5,
        total: 10,
      }),
    ).toContain("transactional, channel, preference, object, and ecosystem");

    expect(migrationResourceLabel("automations", "customerio")).toBe(
      "Workflow rebuild evidence",
    );
    expect(migrationResourceLabel("archive", "customerio")).toBe(
      "Sent email newsletter archive",
    );
    expect(migrationResourceLabel("source_archive", "customerio")).toBe(
      "Customer.io source evidence",
    );
  });

  it("summarizes workflow definitions from the Customer.io rebuild row", () => {
    expect(
      migrationWizardAutomationSummary("customerio", customerIoReport()),
    ).toEqual({
      label: "Customer.io workflow rebuild records",
      value: "4 to rebuild or retire",
      riskTitle: "Customer.io workflows are never activated automatically",
      riskNotes: ["Definitions require manual rebuild and testing."],
    });
    expect(
      verificationAutomationSummary("customerio", customerIoReport()),
    ).toEqual({
      label: "Customer.io workflow rebuild records",
      value: 4,
      unsupportedTitle: "Customer.io workflows to rebuild or retire",
    });
  });

  it("shows the dry run as an initial snapshot plus rebuild and source evidence", () => {
    render(
      <DryRunPreview
        jobId="job_customerio_dry_run"
        source="customerio"
        sourceLabel="Customer.io"
        preview={{ ...customerIoReport(), paid_subs_imported: 7 }}
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("Frozen segment/topic membership snapshots");
    expect(text).toContain("Customer.io workflow rebuild records");
    expect(text).toContain("Sent email newsletters (archive only)");
    expect(text).toContain("preserved as read-only evidence");
    expect(text).toContain(
      "Customer.io initial import is not cutover certification",
    );
    expect(text).toContain(
      "global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default",
    );
    expect(text).toContain(
      "Sender-specific SMS/WhatsApp/v1/optouts are separate non-email evidence",
    );
    expect(text).toContain("not the email-channel preference");
    expect(text).toContain('language=""');
    expect(text).toContain("lowest stable content ID");
    expect(text).toContain("multi-default/A-B set");
    expect(text).toContain("all variants remain evidence");
    expect(text).toContain("exact non-empty source body");
    expect(text).toContain("{{content}}");
    expect(text).toContain("not provider-rendered output");
    expect(text).toContain("components, Liquid, styles/assets");
    expect(text).toContain("not source-event replay");
    expect(text).not.toContain("Sequences");
    expect(text).not.toContain("Paid Stripe subscriptions");
  });

  it("renders Customer.io reconciliation without translated or runtime-workflow claims", () => {
    render(
      <VerificationDiff source="customerio" report={customerIoReport()} />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("Customer.io workflow definitions (rebuild only)");
    expect(text).toContain("Sent email newsletter archive");
    expect(text).toContain("Transactional definitions (source evidence)");
    expect(text).toContain("Exact Customer.io source evidence");
    expect(text).toContain("Preserved for rebuild");
    expect(text).toContain("Customer.io source-evidence warnings");
    expect(text).toContain("Customer.io workflows to rebuild or retire");
    expect(text).not.toContain("Automations translated");
    expect(text).not.toContain("Automations not imported");
    expect(
      document.querySelector("th")?.closest("table")?.textContent,
    ).toContain("Represented");
  });

  it("renders final evidence with Customer.io-specific archive and limitation labels", () => {
    render(<MigrationVerificationEvidence job={completedCustomerIoJob()} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Frozen segment/topic membership snapshots");
    expect(text).toContain("Customer.io workflow rebuild records");
    expect(text).toContain("Sent email newsletters archived");
    expect(text).toContain("Source evidence preserved");
    expect(text).toContain("Deliverability obligations (source evidence)");
    expect(text).toContain("Ecosystem obligations (source evidence)");
    expect(text.toLowerCase()).toContain("profiles without email");
    expect(text).toContain('language=""');
    expect(text).toContain("lowest stable content ID");
    expect(text).toContain("all variants remain evidence");
    expect(text).toContain("not provider-rendered output");
    expect(text).toContain("source-event replay is unavailable");
    expect(text).not.toContain("Automations translated");
    expect(text).not.toContain("Paid-subscription records imported");
  });

  it("keeps the completion screen explicitly short of cutover certification", () => {
    render(
      <MigrationWizardVerifyStep
        job={completedCustomerIoJob()}
        preview={customerIoReport()}
        err={null}
        onClose={() => undefined}
        onRollback={() => undefined}
        onReenterKey={() => undefined}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Initial import finished; Customer.io cutover is not certified.",
    );
    expect(text).toContain(
      "Customer.io cutover requires separate final evidence.",
    );
    expect(text).toContain("final full profile snapshot");
    expect(text).toContain('language=""');
    expect(text).toContain("lowest stable content ID");
    expect(text).toContain("all variants remain evidence");
    expect(text).toContain("not provider-rendered output");
    expect(text).toContain("source-event replay is not cutover evidence");
  });

  it("labels detail rows as rebuild, newsletter archive, and source evidence", () => {
    const rows = migrationDetailProgressRows(completedCustomerIoJob());
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey["segments"]?.label).toBe(
      "Frozen segment/topic membership snapshots",
    );
    expect(byKey["automations"]?.truth).toContain("Rebuild-only evidence");
    expect(byKey["archive"]?.label).toBe("Sent email newsletter archive");
    expect(byKey["templates"]?.truth).toContain("Exact non-empty source HTML");
    expect(byKey["templates"]?.truth).toContain("provider rendering");
    expect(byKey["source_archive"]?.truth).toContain(
      "transactional, channel, preference, object, deliverability, and ecosystem",
    );
    expect(byKey).not.toHaveProperty("paid_subs");
  });

  it("does not collapse the source card to generic runtime capability labels", () => {
    const truth = sourceCapabilityTruth("customerio", {
      source: "customerio",
      auth_method: "api_key",
      supports: {
        subscribers: true,
        segments: true,
        automations: true,
        automation_mode: "rebuild_review",
        campaign_archive: true,
        templates: true,
      },
    });

    expect(truth).toContain("immutable cio_id ownership");
    expect(truth).toContain("one explicitly bound US/EU workspace");
    expect(truth).toContain("sent email newsletter archive history");
    expect(truth).toContain('at least one explicit language="" default');
    expect(truth).toContain("lowest stable content ID");
    expect(truth).toContain("all variants remain evidence");
    expect(truth).toContain(
      "neither newsletter nor Design Studio HTML is provider-rendered output",
    );
    expect(truth).toContain(
      "Campaign and API-broadcast workflows are rebuild-only",
    );
    expect(truth).toContain("no complete source-event replay feed");
    expect(truth).not.toContain("Runtime-supported");
  });
});
